import tempfile
import unittest
from pathlib import Path
import sys
import importlib.util
import json
import threading
import types
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'guest'))
from file_evidence import inspect_desktop_file


class FileEvidenceTest(unittest.TestCase):
    def test_missing_created_changed_and_bounded(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertFalse(inspect_desktop_file('answer.txt', root)['exists'])
            target = root / 'answer.txt'
            target.write_text('hello', encoding='utf-8')
            result = inspect_desktop_file('answer.txt', root)
            self.assertEqual(result['text'], 'hello')
            self.assertEqual(len(result['sha256']), 64)
            target.write_bytes(b'x' * 1_048_577)
            self.assertFalse(inspect_desktop_file('answer.txt', root)['complete'])

    def test_outside_desktop_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'Desktop'
            root.mkdir()
            with self.assertRaises(ValueError):
                inspect_desktop_file('../secret.txt', root)
            with self.assertRaises(ValueError):
                inspect_desktop_file(str(root), root)

    def test_authenticated_rpc_requires_bound_owner(self):
        old_module = sys.modules.get('pyautogui')
        sys.modules['pyautogui'] = types.SimpleNamespace()
        source = Path(__file__).resolve().parents[1] / 'guest' / 'action-worker.py'
        spec = importlib.util.spec_from_file_location('file_evidence_rpc_test', source)
        worker = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(worker)
            worker.TOKEN = 'test'
            worker.VM_ID = 'vm'
            worker.owner = 'owner'
            worker.inspect_desktop_file = lambda path: {'path': path, 'exists': True}
            server = worker.ThreadingHTTPServer(('127.0.0.1', 0), worker.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f'http://127.0.0.1:{server.server_port}'
                request = Request(url + '/rpc', data=json.dumps({
                    'vmId': 'vm', 'clientId': 'owner', 'recoveryEpoch': worker.recovery_epoch,
                    'method': 'inspect_file', 'args': {'path': 'answer.txt'}}).encode(),
                    headers={'Authorization': 'Bearer test', 'Content-Type': 'application/json'})
                with urlopen(request, timeout=5) as response:
                    self.assertEqual(json.load(response)['result']['path'], 'answer.txt')
                worker.owner = None
                with urlopen(request, timeout=5) as response:
                    self.assertEqual(json.load(response)['result']['path'], 'answer.txt')
                escaped = Request(url + '/rpc', data=json.dumps({
                    'vmId': 'vm', 'clientId': 'owner', 'recoveryEpoch': worker.recovery_epoch,
                    'method': 'inspect_file', 'args': {'path': '../secret.txt'}}).encode(),
                    headers={'Authorization': 'Bearer test', 'Content-Type': 'application/json'})
                worker.inspect_desktop_file = lambda path: inspect_desktop_file(path, Path(tempfile.gettempdir()))
                with self.assertRaises(HTTPError) as error:
                    urlopen(escaped, timeout=5)
                self.assertEqual(error.exception.code, 400)
                worker.owner = 'owner'
                other = Request(url + '/rpc', data=json.dumps({
                    'vmId': 'vm', 'clientId': 'other', 'recoveryEpoch': worker.recovery_epoch,
                    'method': 'inspect_file', 'args': {'path': 'answer.txt'}}).encode(),
                    headers={'Authorization': 'Bearer test', 'Content-Type': 'application/json'})
                with self.assertRaises(HTTPError) as error:
                    urlopen(other, timeout=5)
                self.assertEqual(error.exception.code, 409)
                request.headers['Authorization'] = 'Bearer wrong'
                with self.assertRaises(HTTPError) as error:
                    urlopen(request, timeout=5)
                self.assertEqual(error.exception.code, 401)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
        finally:
            if old_module is None:
                sys.modules.pop('pyautogui', None)
            else:
                sys.modules['pyautogui'] = old_module


if __name__ == '__main__':
    unittest.main()
