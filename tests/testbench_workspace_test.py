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


if __name__ == "__main__":
    unittest.main()
