"""Window selection and screenshot liveness without a physical desktop."""
import importlib.util
import json
from pathlib import Path
import sys
import threading
import types
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'guest'))


class StartupTest(unittest.TestCase):
    def setUp(self):
        self.modules = patch.dict(sys.modules, {'pyautogui': types.SimpleNamespace()})
        self.modules.start()
        spec = importlib.util.spec_from_file_location('startup_test', Path(__file__).resolve().parents[1] / 'guest/action-worker.py')
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)

    def tearDown(self):
        self.modules.stop()

    def test_unique_background_and_new_window_can_be_bound_but_ambiguous_cannot(self):
        w = {'handle': 1, 'visible': True, 'minimized': True, 'foreground': False, 'windowClass': 'Editor', 'title': 'Doc'}
        select = self.worker.select_app_window
        self.assertEqual(select([w], {1}, 'Editor', None), w)
        newer = {**w, 'handle': 2}
        self.assertEqual(select([w, newer], {1}, 'Editor', None), newer)
        self.assertIsNone(select([w, newer], {1, 2}, 'Editor', None))
        self.assertIsNone(select([w], set(), 'Other', None))

    def test_frame_is_responsive_while_action_lock_is_held_and_setup_error_is_typed(self):
        worker = self.worker
        worker.TOKEN = 'test'; worker.VM_ID = 'vm'
        worker.pyautogui.screenshot = lambda: types.SimpleNamespace(save=lambda out, **kw: out.write(b'\x89PNG\r\n\x1a\n'))
        worker.input_control.transition('agent')
        def fail(_):
            raise worker.AppSetupError('unique window missing')
        worker.ensure_app = fail
        server = worker.ThreadingHTTPServer(('127.0.0.1', 0), worker.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        headers = {'Authorization': 'Bearer test'}
        try:
            with worker.lock:
                with urlopen(Request(base + '/frame', headers=headers), timeout=1) as response:
                    self.assertEqual(response.read(), b'\x89PNG\r\n\x1a\n')
            body = {'vmId': 'vm', 'clientId': 'task', 'recoveryEpoch': worker.recovery_epoch,
                    'controlEpoch': worker.input_control.revision, 'method': 'ensure_app', 'args': {'appId': 'editor'}}
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(base + '/rpc', data=json.dumps(body).encode(), headers=headers), timeout=2)
            self.assertEqual(caught.exception.code, 422)
            self.assertEqual(json.load(caught.exception)['code'], 'APP_SETUP_FAILED')
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
