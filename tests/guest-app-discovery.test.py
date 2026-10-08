"""Synthetic shortcut/registry fixtures and Fake Guest HTTP; no actual installation scans."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import types
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'guest'))
from app_discovery import GuestAppDiscovery, WindowsAppScanner, local_path, parse_shortcut, split_arguments, windows_cli_json

LIMITS = {'maxEntries': 20, 'maxDepth': 2, 'timeoutMs': 1000}


def shortcut(target, args='', working=''):
    header = bytearray(76)
    header[:20] = bytes.fromhex('4c0000000114020000000000c000000000000046')
    struct.pack_into('<I', header, 20, 2 | 128 | 16 | 32)
    base, suffix = (target + '\0').encode('utf-16le'), b'\0\0'
    info = struct.pack('<9I', 52 + len(base) + len(suffix), 36, 1, 36, 52, 0, 52 + len(base), 52, 52 + len(base))
    info += struct.pack('<4I', 16, 3, 0, 0) + base + suffix
    strings = b''
    for text in [working, args]:
        encoded = text.encode('utf-16le')
        strings += struct.pack('<H', len(encoded) // 2) + encoded
    return bytes(header) + info + strings + b'\0' * 4


class ShortcutTests(unittest.TestCase):
    def test_local_shortcut_preserves_argv_and_directory_without_resolving_or_executing(self):
        parsed = parse_shortcut(shortcut(r'C:\Synthetic\Music.exe', '--name "QQ music" --flag', r'C:\Synthetic'))
        self.assertEqual(parsed, (r'C:\Synthetic\Music.exe', ['--name', 'QQ music', '--flag'], r'C:\Synthetic'))
        self.assertEqual(split_arguments('"" "a\\\\b"'), ['', 'a\\\\b'])

    def test_malformed_advanced_network_and_script_links_are_not_safe_candidates(self):
        good = bytearray(shortcut(r'C:\Synthetic\Music.exe'))
        with self.assertRaises(ValueError):
            parse_shortcut(good[:80])
        struct.pack_into('<I', good, 20, 0x202)
        with self.assertRaisesRegex(ValueError, 'resolution'):
            parse_shortcut(good)
        good = bytearray(shortcut(r'C:\Synthetic\Music.exe'))
        struct.pack_into('<I', good, 84, 3)
        with self.assertRaisesRegex(ValueError, 'network'):
            parse_shortcut(good)
        for path in [r'\\server\app.exe', 'C:relative.exe', r'C:\app.exe:stream', r'C:\bad".exe']:
            with self.assertRaises(ValueError):
                local_path(path)
        with self.assertRaises(ValueError):
            split_arguments('"unclosed')
        with self.assertRaisesRegex(ValueError, 'extra-data'):
            parse_shortcut(shortcut(r'C:\Synthetic\Music.exe')[:-4] + b'evil')


@unittest.skipUnless(os.name == 'nt', 'Windows filesystem collector; parser and Guest contracts run everywhere')
class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.user, self.public = self.root / 'user-menu', self.root / 'public-menu'
        self.user.mkdir(); self.public.mkdir()
        self.exe = self.root / 'Music.exe'
        self.exe.write_bytes(b'MZsynthetic-file; not a runnable executable')
        self.scanner = WindowsAppScanner({'start-menu-user': self.user, 'start-menu-public': self.public},
                                         lambda source: [("QQ音乐", str(self.exe))] if source == 'app-paths-hkcu' else [])

    def tearDown(self):
        self.temp.cleanup()

    def test_synthetic_shortcuts_and_registry_use_only_scoped_roots_and_return_coverage(self):
        (self.user / 'QQ音乐.lnk').write_bytes(shortcut(str(self.exe), '--name "synthetic data"', str(self.root)))
        (self.public / 'QQ音乐.lnk').write_bytes(shortcut(str(self.exe)))
        result = self.scanner.collect(LIMITS)
        self.assertEqual(len(result['entries']), 3)
        self.assertTrue(all(item['status'] == 'complete' for item in result['coverage']))
        self.assertEqual(result['entries'][0]['launchSpec']['args'], ['--name', 'synthetic data'])
        self.assertNotIn('identity', result['entries'][0])

    def test_permission_depth_count_and_timeout_do_not_become_a_complete_negative(self):
        def denied(source):
            raise PermissionError('synthetic permission failure')
        self.scanner.registry_reader = denied
        result = self.scanner.collect(LIMITS)
        self.assertEqual(result['coverage'][2]['status'], 'unavailable')
        self.assertEqual(result['coverage'][2]['reason'], 'PermissionError')
        (self.user / 'child').mkdir()
        result = self.scanner.collect({**LIMITS, 'maxDepth': 0})
        self.assertEqual(result['coverage'][0]['status'], 'truncated')
        for i in range(4):
            (self.public / ('fake' + str(i) + '.lnk')).write_bytes(shortcut(str(self.exe)))
        result = self.scanner.collect({**LIMITS, 'maxEntries': 1})
        self.assertTrue(any(item['status'] == 'truncated' for item in result['coverage']))
        ticks = iter([0, 2, 2, 2, 2, 2])
        self.scanner.clock = lambda: next(ticks)
        self.assertTrue(all(item['status'] == 'timeout' for item in self.scanner.collect(LIMITS)['coverage']))

    def test_manual_nonexistent_directory_wrapper_and_invalid_exe_return_exact_reasons(self):
        for path, reason in [(str(self.root / 'missing.exe'), 'FileNotFoundError'),
                             (str(self.root), 'app-path-is-directory')]:
            result = self.scanner.collect(LIMITS, path)
            self.assertEqual(result['entries'], [])
            self.assertIn(reason, result['coverage'][0]['reason'])
        wrapper = self.root / 'cmd.exe'; wrapper.write_bytes(b'MZsynthetic')
        link = self.user / 'evil.lnk'; link.write_bytes(shortcut(str(wrapper), '/c calc.exe'))
        self.assertIn('unsupported-app-wrapper', self.scanner.collect(LIMITS, str(link))['coverage'][0]['reason'])
        bad = self.root / 'bad.exe'; bad.write_bytes(b'plain text')
        self.assertIn('invalid-executable-header', self.scanner.collect(LIMITS, str(bad))['coverage'][0]['reason'])


class GuestServiceTests(unittest.TestCase):
    def test_windows_child_stdout_escapes_unicode_for_code_page_independent_json(self):
        payload = {'entries': [{'displayName': '网易云音乐', 'aliases': ['中文别名'],
                                'publisher': '腾讯科技'}],
                   'coverage': [{'source': '当前用户开始菜单', 'status': 'complete'}]}
        encoded = windows_cli_json(payload)
        self.assertTrue(encoded.isascii())
        self.assertEqual(json.loads(encoded), payload)

    def test_request_whitelist_environment_version_and_identity_drift(self):
        calls = []
        class FakeScanner:
            def collect(self, limits, path):
                calls.append(path)
                return {'entries': [], 'coverage': [{'source': 'fake-guest', 'status': 'complete', 'inspected': 0, 'rejected': 0}]}
        port = GuestAppDiscovery('A', FakeScanner(), lambda: 'synthetic-installation')
        request = {'protocolVersion': 1, 'scope': port.scope(), 'operation': 'scan', 'limits': LIMITS}
        self.assertEqual(port.handle(request)['scope'], port.scope())
        for change in [{'protocolVersion': 2}, {'scope': {**port.scope(), 'environmentId': 'vm:b'}},
                       {'method': 'execute'}, {'operation': 'shell'}, {'path': r'C:\ignored.exe'}]:
            with self.assertRaises(ValueError):
                port.handle({**request, **change})
        self.assertEqual(calls, [None])
        identities = iter(['old', 'new'])
        port.identity = lambda: next(identities)
        request['scope']['installationScopeId'] = 'old'
        with self.assertRaisesRegex(ValueError, 'identity-changed'):
            port.handle(request)

    @unittest.skipUnless(os.name == 'nt', 'Existing action Worker imports Windows DPI setup')
    def test_http_query_auth_and_old_protocol_state_survive_without_input_owner_or_desktop_calls(self):
        old_gui = sys.modules.get('pyautogui')
        sys.modules['pyautogui'] = types.SimpleNamespace()
        path = Path(__file__).resolve().parents[1] / 'guest/action-worker.py'
        spec = importlib.util.spec_from_file_location('guest_discovery_test', path)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        worker.TOKEN, worker.VM_ID = 'synthetic-token', 'a'
        scans = []
        class FakeScanner:
            def collect(self, limits, path):
                scans.append(path)
                return {'entries': [], 'coverage': [{'source': 'fake', 'status': 'complete', 'inspected': 0, 'rejected': 0}]}
        port = GuestAppDiscovery('a', FakeScanner(), lambda: 'synthetic-installation')
        worker.application_discovery_port = lambda: port
        worker.desktop_call = lambda *args: self.fail('query must not call desktop RPC')
        worker.require_desktop_ready = lambda *args, **kwargs: self.fail('query must not require desktop/input readiness')
        before_mode, before_epoch = worker.input_control.mode, worker.recovery_epoch
        server = worker.ThreadingHTTPServer(('127.0.0.1', 0), worker.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        request = {'protocolVersion': 1, 'scope': port.scope(), 'operation': 'scan', 'limits': LIMITS}
        try:
            with urlopen(Request(base + '/state', headers={'Authorization': 'Bearer synthetic-token'})) as response:
                state = json.load(response)
                self.assertTrue(state['action_rpc']); self.assertTrue(state['control_rpc'])
                self.assertEqual(state['app_discovery']['scope'], port.scope())
            for token, data, status in [('wrong', request, 401), ('synthetic-token', {**request, 'method': 'execute'}, 400)]:
                with self.assertRaises(HTTPError) as raised:
                    urlopen(Request(base + '/apps/query', data=json.dumps(data).encode(), headers={'Authorization': 'Bearer ' + token}))
                self.assertEqual(raised.exception.code, status)
            with urlopen(Request(base + '/apps/query', data=json.dumps(request).encode(), headers={'Authorization': 'Bearer synthetic-token'})) as response:
                self.assertEqual(json.load(response)['protocolVersion'], 1)
            self.assertEqual(scans, [None]); self.assertIsNone(worker.owner); self.assertIsNone(worker.process)
            self.assertEqual(worker.input_control.mode, before_mode); self.assertEqual(worker.recovery_epoch, before_epoch)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=3)
            if old_gui is None:
                sys.modules.pop('pyautogui', None)
            else:
                sys.modules['pyautogui'] = old_gui


if __name__ == '__main__':
    unittest.main()
