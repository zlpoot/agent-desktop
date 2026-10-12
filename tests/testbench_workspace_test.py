"""Synthetic contracts only: no Win32 initialization, Desktop creation, app launch or input."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bench_worker", ROOT / "src/desktop-provider/testbench_worker.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SCOPE = {"providerId": "windows-local-workspace", "environmentId": "local-workspace:testbench", "installationScopeId": "synthetic"}
PROFILE = {"scope": SCOPE, "appBindingId": "synthetic-app", "installationId": "synthetic-install", "applicationId": "windowsagenttestbench",
           "profileRevision": 1, "profileDigest": "synthetic-digest", "identity": {"fingerprint": "synthetic"},
           "launchSpec": {"kind": "exe", "executable": "C:\\Synthetic\\WindowsAgentTestBench.exe", "args": []},
           "trust": "verified", "validity": "current", "availability": "available",
           "confirmations": [{"profileRevision": 1, "profileDigest": "synthetic-digest"}]}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="r0-bench-contract-")
        self.directory = Path(self.temp.name)
        self.path = self.directory / "synthetic.sqlite"
        self.db = sqlite3.connect(self.path)
        self.db.executescript("""
            CREATE TABLE private_app_denial_store(version INTEGER);
            INSERT INTO private_app_denial_store VALUES(1);
            CREATE TABLE private_app_denials(provider_id,environment_id,app_binding_id,installation_id,application_id);
            CREATE TABLE app_environments(provider_id,environment_id,installation_scope_id,scope_revision);
            CREATE TABLE environment_apps(provider_id,environment_id,installation_scope_id,scope_revision,app_binding_id,data_json);
        """)
        self.db.execute("INSERT INTO app_environments VALUES(?,?,?,1)", tuple(SCOPE.values()))
        self.db.execute("INSERT INTO environment_apps VALUES(?,?,?,1,?,?)", (*SCOPE.values(), PROFILE["appBindingId"], json.dumps(PROFILE)))
        self.db.commit()
        self.fence = module.RegistryFence(self.path, SCOPE)
    def tearDown(self):
        self.fence.close()
        self.db.close()
        self.temp.cleanup()
    def update(self, **changes):
        profile = dict(PROFILE, **changes)
        self.db.execute("UPDATE environment_apps SET data_json=?", (json.dumps(profile),))
        self.db.commit()


class PythonFenceContracts(Fixture):
    def test_revoke_and_denial_do_not_authorize_launch_or_input(self):
        effects = []
        self.assertEqual(self.fence.run(PROFILE, lambda: effects.append("synthetic")), None)
        self.update(validity="revoked")
        for launch in (False, True):
            with self.assertRaises(ValueError): self.fence.run(PROFILE, lambda: effects.append("forbidden"), launch)
        self.update()
        self.db.execute("INSERT INTO private_app_denials VALUES(?,?,?,?,?)", (*list(SCOPE.values())[:2], PROFILE["appBindingId"], PROFILE["installationId"], PROFILE["applicationId"]))
        self.db.commit()
        with self.assertRaises(ValueError): self.fence.run(PROFILE, lambda: effects.append("forbidden"))
        self.assertEqual(effects, ["synthetic"])
    def test_exact_scope_generation_content_confirmation_and_schema(self):
        for changes in ({"profileDigest": "changed"}, {"trust": "confirmed"}, {"availability": "unavailable"},
                        {"identity": {"fingerprint": "changed"}}, {"launchSpec": {"kind": "package"}}, {"confirmations": []}):
            self.update(**changes)
            with self.assertRaises(ValueError): self.fence.run(PROFILE, lambda: self.fail("effect forbidden"))
        self.update()
        self.db.execute("UPDATE app_environments SET scope_revision=2")
        self.db.commit()
        with self.assertRaises(ValueError): self.fence.run(PROFILE, lambda: self.fail("scope substitution"))
        self.db.execute("DELETE FROM private_app_denial_store")
        self.db.commit()
        with self.assertRaises(ValueError): self.fence.run(PROFILE, lambda: self.fail("missing denial schema"))
    def test_launch_requires_confirmation_but_not_agent_input_grant(self):
        self.update(trust="confirmed")
        self.assertEqual(self.fence.run(PROFILE, lambda: "synthetic-launch", True), "synthetic-launch")
        with self.assertRaises(ValueError): self.fence.run(PROFILE, lambda: self.fail("not verified for action"))
    def test_native_action_policy_never_admits_script_raw_or_other_app_input(self):
        click = {"kind": "click", "target": {"kind": "role", "role": "button", "name": "客户管理"}}
        self.assertEqual(module.checked_action(click), click)
        order_query = {"kind": "type", "target": {"kind": "role", "role": "edit", "name": "订单客户姓名"}, "text": "张三"}
        self.assertEqual(module.checked_action(order_query), order_query)
        module.checked_action({"kind": "click", "target": {"kind": "role", "role": "button", "name": "查询订单"}})
        for action in ({"kind": "script"}, {"kind": "keypress", "keys": "ENTER"},
                       {"kind": "click", "target": {"kind": "coordinate", "x": 1, "y": 1}},
                       {"kind": "click", "target": {"kind": "role", "role": "button", "name": "保存客户资料"}},
                       {"kind": "type", "target": {"kind": "role", "role": "edit", "name": "客户姓名"}, "text": "\n"},
                       {**click, "executor": "raw"}):
            with self.assertRaises(ValueError): module.checked_action(action)
    def test_native_fresh_observation_lease_and_action_id_are_single_use(self):
        bench = module.NativeBench.__new__(module.NativeBench)
        bench.profile = PROFILE
        bench.current = lambda: None
        bench.clock = lambda: 100
        bench.check_profile = lambda profile: None
        bench.grant = {"synthetic": True}
        bench.lease = 200
        bench.observation, bench.observed_at = "fresh", 90
        bench.consumed = set()
        effects = []
        bench.pipe = lambda *args, **kwargs: (effects.append(kwargs), {"committed": True})[1]
        click = {"kind": "click", "target": {"kind": "role", "role": "button", "name": "客户管理"}}
        bench.incarnation = "original"
        self.assertTrue(bench.execute(bench.grant, click, "fresh", "one")["ok"])
        with self.assertRaises(ValueError): bench.execute(bench.grant, click, "fresh", "one")
        with self.assertRaises(ValueError): bench.execute(bench.grant, click, "fresh", "two")
        bench.observation = "new"
        bench.lease = 99
        with self.assertRaises(ValueError): bench.execute(bench.grant, click, "new", "three")
        self.assertEqual(len(effects), 1)


@unittest.skipUnless(os.name == "nt", "in-box native SQLite fence is Windows-only; other tests remain offline")
class NativeProducerFence(Fixture):
    @classmethod
    def setUpClass(cls):
        cls.compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
        if not cls.compiler.exists(): raise unittest.SkipTest("C# compiler unavailable")
        cls.build = tempfile.TemporaryDirectory(prefix="r0-fence-build-")
        cls.exe = Path(cls.build.name) / "SyntheticFence.exe"
        source = Path(cls.build.name) / "Harness.cs"
        source.write_text("""
using System; using System.IO; using System.Threading; using System.Web.Script.Serialization;
namespace WindowsAgentTestBench { class Harness {
static int Main(string[] args) {
try {
var profile = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(args[1]));
var fence = new BenchRegistryFence(args[0], profile);
fence.Run(() => { File.WriteAllText(args[2], "entered"); if(args.Length>3) Thread.Sleep(400); File.WriteAllText(args[2]+".committed", "synthetic"); return null; });
return 0;
} catch { return 7; }
}}}
""", encoding="utf-8")
        subprocess.run([str(cls.compiler), "/nologo", "/target:exe", "/reference:System.Web.Extensions.dll",
                        "/out:" + str(cls.exe), str(ROOT / "testbench/RegistryFence.cs"), str(source)], check=True, capture_output=True)
    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()
    def run_producer(self, *extra):
        profile = self.directory / "profile.json"; profile.write_text(json.dumps(PROFILE), encoding="utf-8")
        marker = self.directory / ("effect-" + str(time.monotonic_ns()))
        result = subprocess.run([str(self.exe), str(self.path), str(profile), str(marker), *extra], timeout=5)
        return result.returncode, marker
    def test_actual_native_producer_accepts_only_current_verified_profile(self):
        code, marker = self.run_producer()
        self.assertEqual(code, 0); self.assertTrue(Path(str(marker) + ".committed").exists())
        for changes in ({"validity": "revoked"}, {"profileDigest": "changed"}, {"trust": "confirmed"}, {"confirmations": []},
                        {"identity": {"fingerprint": "changed"}}, {"availability": "unavailable"}):
            self.update(**changes)
            code, marker = self.run_producer()
            self.assertEqual(code, 7); self.assertFalse(marker.exists())
    def test_actual_native_fence_serializes_revoke_with_commit_and_rejects_after_ack(self):
        profile = self.directory / "profile.json"; profile.write_text(json.dumps(PROFILE), encoding="utf-8")
        marker = self.directory / "serialized"
        process = subprocess.Popen([str(self.exe), str(self.path), str(profile), str(marker), "hold"])
        try:
            deadline = time.monotonic() + 3
            while not marker.exists() and time.monotonic() < deadline: time.sleep(.005)
            self.assertTrue(marker.exists(), "native producer must acquire authoritative lock")
            self.update(validity="revoked") # Same synchronous BEGIN IMMEDIATE/commit boundary used by Node Registry.
            self.assertTrue(Path(str(marker) + ".committed").exists(), "revoke ACK cannot overtake prior native commit")
            self.assertEqual(process.wait(timeout=3), 0)
            code, after = self.run_producer()
            self.assertEqual(code, 7); self.assertFalse(after.exists())
        finally:
            if process.poll() is None: process.kill(); process.wait()
    def test_actual_native_fence_rejects_denial_scope_change_and_missing_schema(self):
        self.db.execute("INSERT INTO private_app_denials VALUES(?,?,?,?,?)", (*list(SCOPE.values())[:2], PROFILE["appBindingId"], PROFILE["installationId"], PROFILE["applicationId"]))
        self.db.commit()
        code, marker = self.run_producer(); self.assertEqual(code, 7); self.assertFalse(marker.exists())
        self.db.execute("DELETE FROM private_app_denials")
        self.db.execute("UPDATE app_environments SET scope_revision=2")
        self.db.commit()
        code, marker = self.run_producer(); self.assertEqual(code, 7); self.assertFalse(marker.exists())
        self.db.execute("DROP TABLE private_app_denial_store"); self.db.commit()
        code, marker = self.run_producer(); self.assertEqual(code, 7); self.assertFalse(marker.exists())


class CleanupAndDiagnosticContracts(unittest.TestCase):
    def setUp(self):
        get_error = patch.object(module.ctypes, "get_last_error", return_value=2, create=True)
        set_error = patch.object(module.ctypes, "set_last_error", create=True)
        self.last_error = get_error.start()
        set_error.start()
        self.addCleanup(get_error.stop)
        self.addCleanup(set_error.stop)
    def bench(self, desktops=(0,), fail_desktop=False, fail_drain=False):
        bench = module.NativeBench.__new__(module.NativeBench)
        closed, probes, registry = [], [], []
        values = iter(desktops)
        def probe(*args):
            value = next(values)
            probes.append(value)
            return value
        def checked(value, label):
            if not value:
                raise OSError(5, label)
            return value
        bench.api = SimpleNamespace(
            k=SimpleNamespace(CloseHandle=lambda handle: closed.append(handle) or 1,
                              WaitForSingleObject=lambda handle, timeout: 0),
            u=SimpleNamespace(CloseDesktop=lambda handle: closed.append(handle) or (0 if fail_desktop else 1),
                              OpenDesktopW=probe), checked=checked)
        def drain():
            if fail_drain:
                raise RuntimeError("synthetic drain failure")
        bench.drain = drain
        bench.process, bench.job, bench.desktop, bench.binary = 11, 22, 33, 44
        bench.name = "AgentD0_Bench_synthetic"
        bench.fence = SimpleNamespace(close=lambda: registry.append(True))
        return bench, closed, probes, registry
    def test_delayed_desktop_rundown_requires_absence_and_closes_each_probe(self):
        bench, closed, probes, registry = self.bench((55, 66, 0))
        with patch.object(module.time, "sleep"):
            bench.close()
        self.assertEqual(probes, [55, 66, 0])
        self.assertEqual(closed, [11, 22, 33, 55, 66, 44])
        self.assertEqual(registry, [True])
        self.assertIsNone(bench.binary)
    def test_persistent_desktop_remains_nack_but_releases_binary_and_registry(self):
        bench, closed, probes, registry = self.bench((55,))
        with patch.object(module.time, "monotonic", side_effect=[0, 3]):
            with self.assertRaisesRegex(RuntimeError, "owned-cleanup-unconfirmed"):
                bench.close()
        self.assertEqual(closed, [11, 22, 33, 55, 44])
        self.assertEqual(registry, [True])
    def test_drain_and_close_failures_do_not_skip_other_owned_resources(self):
        for failures in ({"fail_drain": True}, {"fail_desktop": True}):
            with self.subTest(failures=failures):
                bench, closed, probes, registry = self.bench(**failures)
                with self.assertRaisesRegex(RuntimeError, "owned-cleanup-unconfirmed"):
                    bench.close()
                self.assertIn(11, closed)
                self.assertIn(22, closed)
                self.assertIn(44, closed)
                self.assertEqual(registry, [True])
    def test_desktop_access_or_probe_failure_cannot_be_misreported_as_absent(self):
        for error in (0, 5, 6):
            with self.subTest(error=error):
                self.last_error.return_value = error
                bench, closed, probes, registry = self.bench()
                with self.assertRaisesRegex(RuntimeError, "owned-cleanup-unconfirmed"):
                    bench.close()
                self.assertEqual(closed, [11, 22, 33, 44])
                self.assertEqual(registry, [True])
    def test_unconfirmed_process_exit_still_closes_handles_and_rejects_ack(self):
        bench, closed, probes, registry = self.bench()
        bench.api.k.WaitForSingleObject = lambda handle, timeout: 258
        with self.assertRaisesRegex(RuntimeError, "owned-cleanup-unconfirmed"):
            bench.close()
        self.assertEqual(closed, [11, 22, 33, 44])
        self.assertEqual(registry, [True])
    def test_private_diagnostic_excludes_exception_messages_paths_and_request_data(self):
        try:
            try:
                raise OSError(5, "synthetic-key-do-not-print C:/private/person/file")
            except OSError as cause:
                raise RuntimeError("synthetic-secret-request-body") from cause
        except RuntimeError as error:
            diagnostic = module.failure_diagnostic("start", error)
        encoded = json.dumps(diagnostic)
        self.assertNotIn("synthetic-key", encoded)
        self.assertNotIn("private/person", encoded)
        self.assertNotIn("request-body", encoded)
        self.assertEqual(diagnostic["method"], "start")
        self.assertEqual(diagnostic["chain"][1]["errno"], 5)
        self.assertEqual(module.failure_diagnostic("secret-method", Exception("secret"))["method"], "unknown")


class WindowDesktopContracts(unittest.TestCase):
    def bench(self):
        bench = module.NativeBench.__new__(module.NativeBench)
        state = {"thread": 1, "input": "Default", "binds": [], "queries": []}
        names = {1: "Default", 2: "AgentD0_Bench_synthetic", 9: "foreign"}
        def checked(value, label):
            if not value: raise OSError(5, label)
            return value
        def default():
            if state["input"] != "Default": raise ValueError("input-desktop-not-default")
        def bind(handle):
            state["binds"].append(handle)
            state["thread"] = handle
            return 1
        def guard(hwnd, expected):
            default()
            if state["thread"] != 2: raise ValueError("target-not-on-controller-desktop")
            if hwnd != 5 or expected != {"pid": 6, "desktop": names[2], "session": 7}:
                raise ValueError("original-window-mismatch")
            state["queries"].append(("guard", state["thread"]))
        def rect(hwnd, pointer):
            guard(hwnd, {"pid": 6, "desktop": names[2], "session": 7})
            state["queries"].append(("rect", state["thread"]))
            pointer._obj.left, pointer._obj.top, pointer._obj.right, pointer._obj.bottom = 10, 20, 110, 220
            return 1
        def class_name(hwnd):
            guard(hwnd, {"pid": 6, "desktop": names[2], "session": 7})
            return "synthetic-original-class"
        bench.api = SimpleNamespace(checked=checked, assert_default=default, name=lambda handle, source="unspecified": names[handle],
            thread_desktop=lambda tid, source="unspecified": state["thread"],
            guard=guard, class_name=class_name,
            k=SimpleNamespace(GetCurrentThreadId=lambda: 100, WaitForSingleObject=lambda handle, timeout: 258),
            u=SimpleNamespace(GetThreadDesktop=lambda tid: state["thread"], SetThreadDesktop=bind, GetWindowRect=rect))
        bench.desktop, bench.job, bench.process, bench.hwnd, bench.pid, bench.name = 2, 3, 4, 5, 6, names[2]
        bench.inspect = lambda: None
        bench.token_facts = lambda: {"sameUser": True, "permissionsCompatible": True}
        bench.context = lambda: {"windowsSessionId": 7}
        bench.clock = lambda: 100
        bench.pipe = lambda method: {"observation": "synthetic", "hwnd": 5, "pid": 6, "incarnation": "original"}
        bench.incarnation = "original"
        return bench, state
    def test_current_queries_original_window_on_owned_desktop_then_restores(self):
        bench, state = self.bench()
        self.assertEqual(bench.current(), {"windowsSessionId": 7})
        self.assertEqual(state["binds"], [2, 1])
        self.assertEqual(state["queries"], [("guard", 2)])
        self.assertEqual(state["thread"], 1)
        self.assertEqual(state["input"], "Default")
    def test_observe_rect_and_class_use_same_original_desktop(self):
        bench, state = self.bench()
        capture = bench.observe()
        self.assertEqual(capture["rect"], {"left": 10, "top": 20, "width": 100, "height": 200})
        self.assertEqual(capture["windowClass"], "synthetic-original-class")
        self.assertTrue(all(desktop == 2 for _, desktop in state["queries"]))
        self.assertEqual(state["thread"], 1)
    def test_window_mismatch_still_rejects_and_restores_without_fallback(self):
        bench, state = self.bench()
        bench.hwnd = 999
        with self.assertRaisesRegex(ValueError, "original-window-mismatch"): bench.current()
        self.assertEqual(state["binds"], [2, 1])
        self.assertEqual(state["thread"], 1)
    def test_foreign_desktop_controller_or_locked_input_never_enters_probe(self):
        for change in ("foreign", "controller", "locked"):
            bench, state = self.bench()
            if change == "foreign": bench.desktop = 9
            elif change == "controller": state["thread"] = 2
            else: state["input"] = "Winlogon"
            with self.subTest(change=change):
                with self.assertRaises(ValueError): bench.current()
                self.assertEqual(state["binds"], [])
                self.assertEqual(state["queries"], [])
    def test_binding_failure_never_runs_window_query(self):
        bench, state = self.bench()
        bench.api.u.SetThreadDesktop = lambda handle: 0
        with self.assertRaises(OSError): bench.current()
        self.assertEqual(state["queries"], [])
    def test_restore_failure_preserves_first_error_in_diagnostic(self):
        bench, state = self.bench()
        bench.hwnd = 999
        bind = bench.api.u.SetThreadDesktop
        bench.api.u.SetThreadDesktop = lambda handle: 0 if handle == 1 else bind(handle)
        try: bench.current()
        except OSError as error: diagnostic = module.failure_diagnostic("current", error)
        else: self.fail("restore failure must reject")
        self.assertEqual([item["type"] for item in diagnostic["chain"]], ["OSError", "ValueError"])
    def test_process_or_user_mismatch_rejects_before_desktop_binding(self):
        for change in ("process", "user"):
            bench, state = self.bench()
            if change == "process": bench.api.k.WaitForSingleObject = lambda handle, timeout: 0
            else: bench.token_facts = lambda: {"sameUser": False, "permissionsCompatible": False}
            with self.subTest(change=change):
                with self.assertRaises(ValueError): bench.current()
                self.assertEqual(state["binds"], [])
    def test_implicit_diagnostic_context_excludes_messages_and_honors_suppression(self):
        for suppress, expected in ((False, ["RuntimeError", "ValueError"]), (True, ["RuntimeError"])):
            try:
                try: raise ValueError("synthetic-secret-first-error")
                except ValueError:
                    if suppress: raise RuntimeError("synthetic-secret-cleanup") from None
                    raise RuntimeError("synthetic-secret-cleanup")
            except RuntimeError as error: diagnostic = module.failure_diagnostic("close", error)
            self.assertEqual([item["type"] for item in diagnostic["chain"]], expected)
            self.assertNotIn("synthetic-secret", json.dumps(diagnostic))


class DesktopNameDiagnosticContracts(unittest.TestCase):
    def setUp(self):
        from win32 import Api, Blocked
        self.Api, self.Blocked = Api, Blocked
        self.api = Api.__new__(Api)  # No DLL load or real Desktop/Task.
        self.error_code = 0
        def get_error(): return self.error_code
        def set_error(value): self.error_code = value
        for name, function in (("get_last_error", get_error), ("set_last_error", set_error)):
            mock = patch.object(module.ctypes, name, side_effect=function, create=True)
            mock.start(); self.addCleanup(mock.stop)

    def diagnostic(self, effect):
        try: effect()
        except (self.Blocked, OSError) as error:
            return module.failure_diagnostic("start", error)["chain"][0]["desktop"]
        self.fail("query must fail closed")

    def test_null_thread_handle_retains_acquisition_error_before_name_query(self):
        calls = []
        def thread(tid):
            calls.append(tid); self.error_code = 87; return None
        self.api.u = SimpleNamespace(GetThreadDesktop=thread,
            GetUserObjectInformationW=lambda *args: self.fail("must not overwrite acquisition error"))
        diagnostic = self.diagnostic(lambda: self.api.name(
            self.api.thread_desktop(12345, "window-owner-thread"), "window-owner-thread"))
        self.assertEqual(diagnostic, {"source": "window-owner-thread", "operation": "GetThreadDesktop",
            "phase": "handle-lookup", "winerror": 87, "handlePresent": False})
        self.assertEqual(calls, [12345])
        self.assertNotIn("12345", json.dumps(diagnostic))

    def test_size_failure_distinguishes_invalid_handle_access_and_unreported_error(self):
        for code in (6, 5, 0):
            def query(handle, index, buffer, length, size):
                self.error_code = code
                size._obj.value = 0
                return 0
            self.api.u = SimpleNamespace(GetUserObjectInformationW=query)
            diagnostic = self.diagnostic(lambda: self.api.name(987654321, "original-retained"))
            self.assertEqual(diagnostic, {"source": "original-retained", "operation": "GetUserObjectInformationW",
                "phase": "size-probe", "winerror": code, "handlePresent": True, "requiredBytes": 0})
            self.assertNotIn("987654321", json.dumps(diagnostic))

    def test_expected_insufficient_buffer_sizing_continues_to_actual_name_read(self):
        calls = []
        def query(handle, index, buffer, length, size):
            calls.append(length); size._obj.value = 16
            if buffer is None:
                self.error_code = 122; return 0
            self.assertEqual(self.error_code, 0, "reset stale error before read")
            buffer.value = "Default"; return 1
        self.api.u = SimpleNamespace(GetUserObjectInformationW=query)
        self.assertEqual(self.api.name(4, "controller-before-bind"), "Default")
        self.assertEqual(len(calls), 2)

    def test_name_read_failure_captures_its_error_not_the_sizing_error(self):
        def query(handle, index, buffer, length, size):
            size._obj.value = 16
            self.error_code = 122 if buffer is None else 5
            return 0
        self.api.u = SimpleNamespace(GetUserObjectInformationW=query)
        diagnostic = self.diagnostic(lambda: self.api.name(4, "controller-restored"))
        self.assertEqual(diagnostic["phase"], "name-read")
        self.assertEqual(diagnostic["winerror"], 5)
        self.assertEqual(diagnostic["source"], "controller-restored")

    def test_oversized_name_still_rejects_without_buffer_read(self):
        calls = []
        def query(handle, index, buffer, length, size):
            calls.append(length); self.error_code = 122; size._obj.value = 2048; return 0
        self.api.u = SimpleNamespace(GetUserObjectInformationW=query)
        diagnostic = self.diagnostic(lambda: self.api.name(4, "controller-bound"))
        self.assertEqual(calls, [0])
        self.assertEqual(diagnostic["requiredBytes"], 2048)
        self.assertEqual(diagnostic["winerror"], 122)

    def test_input_desktop_provenance_keeps_owned_handle_close_on_failure(self):
        closed = []
        def query(handle, index, buffer, length, size):
            self.error_code = 6; return 0
        self.api.u = SimpleNamespace(OpenInputDesktop=lambda *args: 44,
            GetUserObjectInformationW=query, CloseDesktop=lambda handle: closed.append(handle))
        diagnostic = self.diagnostic(self.api.input_desktop)
        self.assertEqual(diagnostic["source"], "input-desktop")
        self.assertEqual(closed, [44])

    def test_real_identity_keeps_current_thread_lookup_failure_provenance(self):
        def owner(hwnd, pid): pid._obj.value = 77; return 88
        def thread(tid):
            self.assertEqual(tid, 44); self.error_code = 6; return None
        def member(process, job, value): value._obj.value = True; return True
        self.api.u = SimpleNamespace(GetWindowThreadProcessId=owner, IsWindow=lambda hwnd: 1,
            GetThreadDesktop=thread)
        self.api.owned_job_name = "synthetic-job"
        self.api.k = SimpleNamespace(OpenProcess=lambda *args: 11, OpenJobObjectW=lambda *args: 22,
            IsProcessInJob=member, GetCurrentThreadId=lambda: 44, CloseHandle=lambda *args: True)
        diagnostic = self.diagnostic(lambda: self.api.identity(33))
        self.assertEqual(diagnostic["source"], "window-query-thread")
        self.assertEqual(diagnostic["operation"], "GetThreadDesktop")
        self.assertEqual(diagnostic["winerror"], 6)

    def test_diagnostic_metadata_is_allowlisted_and_excludes_extra_private_data(self):
        error = self.api.desktop_failure(self.Blocked("synthetic-private-message"),
            "original-retained", "GetUserObjectInformationW", "size-probe", 6, 987654321, 0)
        error.desktop_diagnostic.update({"handle": 987654321, "path": "C:/synthetic/private/key", "name": "private-desktop"})
        encoded = json.dumps(module.failure_diagnostic("start", error))
        for secret in ("987654321", "private-message", "private/key", "private-desktop"):
            self.assertNotIn(secret, encoded)
        for field, value in (("source", []), ("source", "private-secret"), ("operation", "secret-api"),
                             ("phase", "secret-phase"), ("winerror", "private-key"), ("winerror", -1),
                             ("winerror", True), ("handlePresent", 1)):
            prior = error.desktop_diagnostic[field]
            error.desktop_diagnostic[field] = value
            self.assertNotIn("desktop", module.failure_diagnostic("start", error)["chain"][0])
            error.desktop_diagnostic[field] = prior

    def test_all_helper_name_queries_label_retained_controller_and_restore_sources(self):
        for ordinal, source in enumerate(("original-retained", "controller-before-bind",
                                           "controller-bound", "controller-restored"), 1):
            bench, state = WindowDesktopContracts().bench()
            read_name, sources = bench.api.name, []
            def name(handle, provenance="unspecified"):
                sources.append(provenance)
                if len(sources) == ordinal:
                    raise self.api.desktop_failure(self.Blocked("synthetic secret"), provenance,
                        "GetUserObjectInformationW", "size-probe", 6, handle, 0)
                return read_name(handle, provenance)
            bench.api.name = name
            with self.subTest(source=source):
                diagnostic = self.diagnostic(bench.current)
                self.assertEqual(diagnostic["source"], source)
                self.assertEqual(state["thread"], 1)
                self.assertEqual(state["input"], "Default")
                if ordinal < 4:
                    self.assertEqual(state["queries"], [])


if __name__ == "__main__":
    unittest.main()
