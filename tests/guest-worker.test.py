"""Transport checks for the D1 Guest Worker without a physical desktop."""

import importlib.util
import os
from pathlib import Path
import sys
import struct
import threading
import types
import unittest
import zlib
from urllib.error import HTTPError
from urllib.request import Request, urlopen

def synthetic_png():
    def chunk(kind, data):
        return (struct.pack('>I', len(data)) + kind + data +
                struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress((b'\0' + b'\xff\0\0' * 2) * 2)) +
            chunk(b'IEND', b''))


class GuestWorkerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["AGENT_DESKTOP_TOKEN"] = "test-secret"
        os.environ["AGENT_DESKTOP_VM_ID"] = "vm-test"
        sys.modules["pyautogui"] = types.SimpleNamespace(
            screenshot=lambda: types.SimpleNamespace(
                save=lambda output, **kwargs: output.write(synthetic_png())))
        source = Path(__file__).resolve().parents[1] / "guest" / "worker.py"
        spec = importlib.util.spec_from_file_location("guest_worker", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls.server = module.ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_requires_token(self):
        with self.assertRaises(HTTPError) as context:
            urlopen(self.base + "/state")
        self.assertEqual(context.exception.code, 401)

    def test_state_and_png(self):
        headers = {"Authorization": "Bearer test-secret"}
        with urlopen(Request(self.base + "/state", headers=headers)) as response:
            self.assertIn(b'"vm_id": "vm-test"', response.read())
        with urlopen(Request(self.base + "/frame", headers=headers)) as response:
            self.assertEqual(response.headers["Content-Type"], "image/png")
            self.assertEqual(response.read(8), b"\x89PNG\r\n\x1a\n")

    def test_actions_are_disabled_in_d1(self):
        request = Request(self.base + "/act", data=b"{}", method="POST",
                          headers={"Authorization": "Bearer test-secret"})
        with self.assertRaises(HTTPError) as context:
            urlopen(request)
        self.assertEqual(context.exception.code, 405)


if __name__ == "__main__":
    unittest.main()
