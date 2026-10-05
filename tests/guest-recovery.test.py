import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import threading
import types
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "guest"))


class GuestRecoveryTest(unittest.TestCase):
    def test_reconnect_releases_old_owner_and_rejects_old_rpc_epoch(self):
        old_module = sys.modules.get("pyautogui")
        sys.modules["pyautogui"] = types.SimpleNamespace()
        path = Path(__file__).resolve().parents[1] / "guest" / "action-worker.py"
        spec = importlib.util.spec_from_file_location("guest_recovery_test", path)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        worker.TOKEN = "test"
        worker.VM_ID = "vm"
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        worker.process = child
        worker.owner = "old-task"
        old_epoch = worker.recovery_epoch
        lease = worker.input_control.transition("human")["lease"]
        server = worker.ThreadingHTTPServer(("127.0.0.1", 0), worker.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def post(path, body):
            request = Request(f"http://127.0.0.1:{server.server_port}" + path,
                              data=json.dumps({"vmId": "vm", **body}).encode(),
                              headers={"Authorization": "Bearer test", "Content-Type": "application/json"})
            with urlopen(request, timeout=5) as response:
                return json.load(response)

        try:
            result = post("/control", {"mode": "paused", "revision": 100, "resetTask": True})
            self.assertTrue(result["result"]["recovery_rpc"])
            self.assertIsNotNone(child.poll())
            self.assertIsNone(worker.owner)
            self.assertNotEqual(old_epoch, worker.recovery_epoch)
            with self.assertRaises(HTTPError):
                post("/human-input", {"lease": lease, "event": {"kind": "text", "text": "never"}})
            with self.assertRaises(HTTPError):
                post("/rpc", {"method": "release", "clientId": "old-task", "recoveryEpoch": old_epoch})
            self.assertTrue(post("/rpc", {"method": "release", "clientId": "fresh",
                                          "recoveryEpoch": worker.recovery_epoch})["result"]["released"])
        finally:
            server.shutdown(); server.server_close(); thread.join()
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
            if old_module is None:
                sys.modules.pop("pyautogui", None)
            else:
                sys.modules["pyautogui"] = old_module


if __name__ == "__main__":
    unittest.main()
