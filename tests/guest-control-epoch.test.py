import importlib.util
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import types
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "guest"))


class GuestControlEpochTest(unittest.TestCase):
    def test_old_agent_cannot_input_after_human_handoff_and_new_agent_gate(self):
        old_module = sys.modules.get("pyautogui")
        sys.modules["pyautogui"] = types.SimpleNamespace()
        path = Path(__file__).resolve().parents[1] / "guest" / "action-worker.py"
        spec = importlib.util.spec_from_file_location("guest_epoch_test", path)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        worker.TOKEN = "test"
        worker.VM_ID = "vm"
        calls = []
        entered = threading.Event()
        release = threading.Event()

        def desktop_call(method, args):
            calls.append(method)
            if method == "init":
                return {"handle": 1, "title": "Target"}
            if method == "execute":
                if args["action"].get("ms") == 3:
                    return {"ok": False, "message": "not dispatched", "effect": "none"}
                if args["action"].get("ms") == 5000:
                    entered.set()
                    if not release.wait(3):
                        raise RuntimeError("test action timed out")
                return {"ok": True, "message": "executed"}
            if method == "observe":
                return {"pageText": "after"}
            return {}

        worker.desktop_call = desktop_call
        class DropOnceHandler(worker.Handler):
            drop_next_action_reply = False

            def reply(self, status, body, content_type="application/json"):
                if (self.drop_next_action_reply and isinstance(body, dict) and
                        isinstance(body.get("result"), dict) and
                        body["result"].get("message") == "executed"):
                    type(self).drop_next_action_reply = False
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    self.connection.close()
                    return
                return super().reply(status, body, content_type)

        server = worker.ThreadingHTTPServer(("127.0.0.1", 0), DropOnceHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def post(route, body):
            request = Request(f"http://127.0.0.1:{server.server_port}{route}",
                              data=json.dumps({"vmId": "vm", **body}).encode(),
                              headers={"Authorization": "Bearer test", "Content-Type": "application/json"})
            with urlopen(request, timeout=5) as response:
                return json.load(response)

        def rpc(client, epoch, method, args):
            return post("/rpc", {"clientId": client, "recoveryEpoch": worker.recovery_epoch,
                                 "controlEpoch": epoch, "method": method, "args": args})

        action = {"action": {"kind": "wait", "ms": 1},
                  "allowedProviders": ["windows.uia.act"], "actionId": "task:1:uia"}
        try:
            with tempfile.TemporaryDirectory() as artifacts:
                worker.ARTIFACTS = Path(artifacts)
                post("/control", {"mode": "agent", "revision": 100})
                rpc("old", 100, "init", {"windowTitle": "Target"})
                post("/control", {"mode": "human", "revision": 101})
                post("/control", {"mode": "paused", "revision": 102})
                post("/control", {"mode": "agent", "revision": 103})
                with self.assertRaises(HTTPError) as rejected:
                    rpc("old", 100, "execute", action)
                self.assertEqual(rejected.exception.code, 400)
                self.assertNotIn("execute", calls)
                with self.assertRaises(HTTPError):
                    rpc("old", None, "execute", action)
                self.assertNotIn("execute", calls)
                rpc("old", 103, "execute", action)
                self.assertEqual(calls.count("execute"), 1)
                duplicate = rpc("old", 103, "execute", action)
                self.assertTrue(duplicate["result"]["duplicate"])
                self.assertEqual(calls.count("execute"), 1)
                with self.assertRaises(HTTPError):
                    rpc("old", 103, "execute", {**action, "action": {"kind": "wait", "ms": 2}})
                self.assertEqual(calls.count("execute"), 1)

                lost_reply = {**action, "actionId": "task:lost:uia"}
                DropOnceHandler.drop_next_action_reply = True
                with self.assertRaises(Exception):
                    rpc("old", 103, "execute", lost_reply)
                self.assertFalse(DropOnceHandler.drop_next_action_reply)
                self.assertEqual(calls.count("execute"), 2)
                self.assertTrue(rpc("old", 103, "execute", lost_reply)["result"]["duplicate"])
                self.assertEqual(calls.count("execute"), 2)

                no_effect = {**action, "actionId": "task:none:uia",
                             "action": {"kind": "wait", "ms": 3}}
                self.assertFalse(rpc("old", 103, "execute", no_effect)["result"]["ok"])
                self.assertFalse(rpc("old", 103, "execute", no_effect)["result"]["ok"])
                self.assertEqual(calls.count("execute"), 4)

                long_action = {**action, "actionId": "task:2:uia",
                               "action": {"kind": "wait", "ms": 5000}}
                action_thread = threading.Thread(target=lambda: rpc("old", 103, "execute", long_action))
                action_thread.start()
                self.assertTrue(entered.wait(2))
                stop_thread = threading.Thread(target=lambda: post("/control", {"mode": "stopped",
                                                                            "revision": 104}))
                stop_thread.start()
                self.assertTrue(worker.input_control.revoked.wait(2))
                release.set()
                action_thread.join(3)
                stop_thread.join(3)
                self.assertFalse(action_thread.is_alive())
                self.assertFalse(stop_thread.is_alive())
                with self.assertRaises(HTTPError):
                    rpc("old", 103, "execute", {**action, "actionId": "task:3:uia"})
                self.assertEqual(calls.count("execute"), 5)
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join()
            if old_module is None:
                sys.modules.pop("pyautogui", None)
            else:
                sys.modules["pyautogui"] = old_module


if __name__ == "__main__":
    unittest.main()
