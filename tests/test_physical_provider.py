"""Physical Worker identity/authority/policy contracts without loading Windows or input APIs."""
import ast
import copy
import importlib.util
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("physical_gate", ROOT / "src/runtime/desktop/physical_gate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PhysicalGate = module.PhysicalGate
context_spec = importlib.util.spec_from_file_location("physical_context", ROOT / "src/runtime/desktop/physical_context.py")
context_module = importlib.util.module_from_spec(context_spec)
context_spec.loader.exec_module(context_module)


class PhysicalGateTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.wall = 100.0
        self.context = {"instanceId": "worker-1", "inputResourceId": "physical-input:fixture", "ready": True}
        self.policy = {"windowManagement": True, "executors": ["windows.pyautogui.act"]}
        self.authority = {**self.context, "providerId": "physical", "environmentId": "desktop",
                          "sessionId": "s", "epoch": 1, "grantId": "grant-1",
                          "owner": {"kind": "agent", "clientId": "agent"}}
        self.gate = PhysicalGate(lambda: self.context, self.policy, lambda: self.now, lambda: self.wall)
        self.args = {"action": {"kind": "keypress", "keys": "escape"},
                     "allowedProviders": ["windows.pyautogui.act"]}

    def install(self):
        self.gate.install(self.authority, 103000)

    def test_native_gate_rechecks_full_grant_not_just_epoch(self):
        self.install()
        self.gate.check(self.context, self.authority, "execute", self.args)
        for key in ("instanceId", "inputResourceId", "providerId", "environmentId", "sessionId", "grantId", "epoch", "owner"):
            forged = copy.deepcopy(self.authority)
            forged[key] = {"kind": "agent", "clientId": "another"} if key == "owner" else "forged"
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.gate.check(self.context, forged, "execute", self.args)

    def test_backend_instance_resource_readiness_are_independent_checks(self):
        self.install()
        identity = copy.deepcopy(self.context)
        for key in ("instanceId", "inputResourceId"):
            original = self.context[key]
            self.context[key] = "replacement"
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "instance/resource changed"):
                self.gate.check(identity, self.authority, "execute", self.args)
            self.context[key] = original
            with self.assertRaisesRegex(ValueError, "instance/resource changed"):
                self.gate.check(identity, self.authority, "execute", self.args)
            self.gate = PhysicalGate(lambda: self.context, self.policy, lambda: self.now, lambda: self.wall)
            self.install()
        self.context["ready"] = False
        with self.assertRaisesRegex(ValueError, "not ready"):
            self.gate.check(identity, self.authority, "execute", self.args)

    def test_unscoped_or_multiple_executors_are_rejected(self):
        self.install()
        for providers in (None, [], ["unapproved"], ["windows.pyautogui.act", "unapproved"]):
            args = {**self.args, "allowedProviders": providers}
            with self.subTest(providers=providers), self.assertRaisesRegex(ValueError, "forbidden by policy"):
                self.gate.check(self.context, self.authority, "execute", args)

    def test_default_policy_and_focus_management_fail_closed(self):
        gate = PhysicalGate(lambda: self.context, {"windowManagement": False, "executors": []}, lambda: self.now, lambda: self.wall)
        gate.install(self.authority, 103000)
        for method, args in (("init", {}), ("restore", {}), ("probe", {"focus": True}), ("execute", self.args)):
            with self.subTest(method=method), self.assertRaisesRegex(ValueError, "forbidden by policy"):
                gate.check(self.context, self.authority, method, args)
        gate.check(self.context, None, "probe", {"focus": False})

    def test_caller_cannot_change_installed_policy_or_grant_metadata(self):
        self.install()
        self.policy["executors"].append("unapproved")
        self.authority["owner"]["clientId"] = "changed"
        with self.assertRaises(ValueError):
            self.gate.check(self.context, self.authority, "execute", self.args)
        original = copy.deepcopy(self.gate.grant)
        with self.assertRaisesRegex(ValueError, "forbidden by policy"):
            self.gate.check(self.context, original, "execute", {**self.args, "allowedProviders": ["unapproved"]})

    def test_expiry_uses_monotonic_clock_and_expired_grant_can_be_system_revoked(self):
        self.install()
        self.wall = -1000  # Clock rollback cannot extend an already-installed backend lease.
        self.now = 3.1
        with self.assertRaisesRegex(ValueError, "expired"):
            self.gate.check(self.context, self.authority, "execute", self.args)

    def test_wrong_request_identity_cannot_poison_current_backend(self):
        self.install()
        with self.assertRaisesRegex(ValueError, "instance/resource changed"):
            self.gate.check({**self.context, "instanceId": "forged"}, self.authority, "execute", self.args)
        self.gate.check(self.context, self.authority, "execute", self.args)
        self.gate.revoke(self.authority)
        self.assertIsNone(self.gate.grant)

    def test_revoke_fences_old_epoch_and_refuses_foreign_grant(self):
        self.install()
        foreign = {**self.authority, "grantId": "foreign"}
        with self.assertRaisesRegex(ValueError, "Foreign"):
            self.gate.revoke(foreign)
        self.gate.revoke(self.authority)
        with self.assertRaises(ValueError):
            self.gate.install(self.authority, 103000)
        with self.assertRaises(ValueError):
            self.gate.check(self.context, self.authority, "execute", self.args)
        new = {**self.authority, "epoch": 2, "grantId": "new"}
        self.gate.install(new, 103000)
        self.gate.check(self.context, new, "execute", self.args)

    def test_unbounded_or_expired_management_deadline_does_not_extend_three_second_lease(self):
        with self.assertRaisesRegex(ValueError, "Expired"):
            self.gate.install(self.authority, 99000)
        self.gate.install(self.authority, 1e12)
        self.now = 3.1
        with self.assertRaisesRegex(ValueError, "expired"):
            self.gate.check(self.context, self.authority, "execute", self.args)


class WorkerDispatchTests(unittest.TestCase):
    def run_requests(self, requests):
        source = ast.parse((ROOT / "src/runtime/desktop/worker.py").read_text(encoding="utf-8"))
        loop = next(node for node in source.body if isinstance(node, ast.For))
        replies, effects = [], []
        context = {"instanceId": "worker-1", "inputResourceId": "physical-input:fixture", "ready": True}
        namespace = {"sys": types.SimpleNamespace(stdin=io.StringIO("\n".join(json.dumps(value) for value in requests))),
                     "json": json, "Path": Path, "PHYSICAL_GATE": None, "PHYSICAL_INSTANCE_ID": "worker-1",
                     "PhysicalGate": PhysicalGate, "physical_context": lambda _: context,
                     "reply": lambda identity, result=None, error=None: replies.append((identity, result, error)),
                     "bind": lambda *args: {"handle": 7, "title": "synthetic"},
                     "execute": lambda *args: effects.append(args) or {"ok": True},
                     "observe": lambda *args: {"pageText": "synthetic"},
                     "list_windows": lambda *args: []}
        exec(compile(ast.Module(body=[loop], type_ignores=[]), "worker-dispatch", "exec"), namespace)
        return replies, effects

    def test_legacy_dispatch_is_preserved_without_managed_hello(self):
        replies, effects = self.run_requests([{"id": 1, "method": "execute", "args": {"action": {"kind": "wait", "ms": 0}}},
                                             {"id": 2, "method": "close"}])
        self.assertEqual(len(effects), 1)
        self.assertIsNone(replies[0][2])

    def test_managed_worker_cannot_bypass_gate_or_replace_policy_with_second_hello(self):
        requests = [{"id": 1, "method": "physical_hello", "args": {"policy": {"windowManagement": False, "executors": []}}},
                    {"id": 2, "method": "physical_hello", "args": {"policy": {"windowManagement": True, "executors": ["unsafe"]}}},
                    {"id": 3, "method": "execute", "args": {"action": {"kind": "keypress", "keys": "escape"}}},
                    {"id": 4, "method": "close"}]
        replies, effects = self.run_requests(requests)
        self.assertEqual(effects, [])
        self.assertIn("instance/resource changed", replies[2][2])

    def test_managed_dispatch_requires_grant_and_revoke_fences_old_authority(self):
        identity = {"instanceId": "worker-1", "inputResourceId": "physical-input:fixture"}
        authority = {**identity, "providerId": "physical", "environmentId": "desktop", "sessionId": "s",
                     "grantId": "g", "epoch": 1, "owner": {"kind": "agent", "clientId": "agent"}}
        execute = {"method": "execute", "physicalIdentity": identity, "inputAuthority": authority,
                   "args": {"action": {"kind": "keypress", "keys": "escape"}, "allowedProviders": ["allowed"]}}
        requests = [{"id": 1, "method": "physical_hello", "args": {"policy": {"windowManagement": True, "executors": ["allowed"]}}},
                    {"id": 2, **execute},
                    {"id": 3, "method": "physical_grant", "args": {"authority": authority, "expiresAt": 1e15}},
                    {"id": 4, "method": "init", "physicalIdentity": identity, "inputAuthority": authority,
                     "args": {"windowHandle": 7, "artifactDir": "."}},
                    {"id": 5, **execute},
                    {"id": 6, "method": "physical_revoke", "args": {"authority": authority}},
                    {"id": 7, **execute}, {"id": 8, "method": "close"}]
        replies, effects = self.run_requests(requests)
        self.assertEqual(len(effects), 1)
        self.assertIn("authority", replies[1][2])
        self.assertIsNone(replies[3][2])
        self.assertIsNone(replies[4][2])
        self.assertIsNone(replies[5][2])
        self.assertIn("authority", replies[6][2])


class PhysicalContextTests(unittest.TestCase):
    def test_resource_is_os_scope_not_worker_nonce_and_input_desktop_is_only_read(self):
        class Function:
            def __init__(self, fn):
                self.fn = fn

            def __call__(self, *args):
                return self.fn(*args)

        state = {"station": "WinSta0", "desktop": "Default", "input": "Default", "session": 1,
                 "current": 33, "closed": []}

        def session_id(_, pointer):
            pointer._obj.value = state["session"]
            return 1

        def object_name(handle, _, buffer, __, ___):
            buffer.value = {11: state["station"], 22: state["desktop"], 33: state["input"]}[handle]
            return 1

        def input_desktop(flags, inherit, access):
            self.assertEqual((flags, inherit, access), (0, False, 1))  # DESKTOP_READOBJECTS only.
            return state["current"]

        user32 = types.SimpleNamespace(GetProcessWindowStation=Function(lambda: 11),
            GetThreadDesktop=Function(lambda _: 22), OpenInputDesktop=Function(input_desktop),
            CloseDesktop=Function(lambda handle: state["closed"].append(handle)),
            GetUserObjectInformationW=Function(object_name))
        kernel32 = types.SimpleNamespace(ProcessIdToSessionId=Function(session_id), GetCurrentThreadId=Function(lambda: 99))
        with patch.object(context_module.ctypes, "windll", types.SimpleNamespace(user32=user32, kernel32=kernel32), create=True), \
                patch.object(context_module.socket, "gethostname", return_value="SYNTHETIC"):
            a = context_module.physical_context("a")
            b = context_module.physical_context("b")
            self.assertEqual(a["inputResourceId"], b["inputResourceId"])
            self.assertNotEqual(a["instanceId"], b["instanceId"])
            self.assertTrue(a["ready"])
            state["input"] = "Winlogon"
            self.assertFalse(context_module.physical_context("a")["ready"])
            state["current"] = 0
            self.assertFalse(context_module.physical_context("a")["ready"])
            self.assertEqual(state["closed"], [33, 33, 33])
            state["session"] = 2
            self.assertNotEqual(context_module.physical_context("a")["inputResourceId"], a["inputResourceId"])


if __name__ == "__main__":
    unittest.main()
