import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('workbench_app_worker', Path(__file__).resolve().parents[1] / 'src/desktop-provider/workbench_app_worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)


class StdioTests(unittest.TestCase):
    def test_chinese_profile_uses_utf8_even_with_windows_gbk_default(self):
        # Exercise the actual dispatcher with a fake owner; never loads Win32 APIs.
        script = '''import importlib.util, threading
spec = importlib.util.spec_from_file_location('worker', %r)
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
class FakeOwner:
    def __init__(self, *args):
        self.lock = threading.RLock(); self.watch_stop = threading.Event()
        self.watcher = threading.Thread(target=lambda: None); self.watcher.start()
        self.fence = type('Fence', (), {'db': type('Database', (), {'close': lambda self: None})()})()
    def instances(self, profile): return [profile['displayName']]
    def inspect(self, spec): raise w.LaunchFailure('stale', 'app-installation-path-unavailable')
    def close(self): return {'cleaned': True}
w.OwnedApp = FakeOwner
w.main()
''' % str(spec.origin)
        import os
        environment = {**os.environ, 'PYTHONIOENCODING': 'gbk'}
        requests = [dict(id=1, method='init', fields=dict(config={}, scope={}, registry='synthetic')),
                    dict(id=2, method='instances', fields=dict(profile=dict(displayName='网易云音乐'))),
                    dict(id=3, method='close'), dict(id=4, method='inspect', fields=dict(spec={}))]
        result = subprocess.run([sys.executable, '-c', script], input=('\n'.join(json.dumps(item, ensure_ascii=False) for item in requests) + '\n').encode('utf-8'),
                                capture_output=True, timeout=5, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
        replies = [json.loads(line) for line in result.stdout.decode('utf-8').splitlines()]
        self.assertEqual(replies[1]['result'], ['网易云音乐'])
        self.assertEqual(replies[2]['result'], {'cleaned': True})
        self.assertEqual(replies[3]['error'], 'app-installation-path-unavailable')
        self.assertEqual(replies[3]['failureKind'], 'stale')


class ManualWorkerTests(unittest.TestCase):
    def test_generic_exe_definition_still_rejects_shell_args_cwd_and_shortcuts(self):
        for path in (r'C:\Synthetic\Editor.exe', r'D:\Synthetic\Viewer.exe'):
            worker.check_spec(None, dict(kind='exe', executable=path, args=[]))
        for spec in (dict(kind='exe', executable=r'C:\Windows\cmd.exe', args=[]),
                     dict(kind='exe', executable=r'C:\Synthetic\Editor.exe', args=['unsafe']),
                     dict(kind='exe', executable=r'C:\Synthetic\Editor.exe', args=[], workingDirectory=r'C:\Synthetic'),
                     dict(kind='shortcut', executable=r'C:\Synthetic\Editor.exe', args=[], shortcutPath=r'C:\Synthetic\Editor.lnk')):
            with self.assertRaises(Exception): worker.check_spec(None, spec)

    def owner(self):
        owner = worker.OwnedApp.__new__(worker.OwnedApp)
        owner.blocked = False; owner.context = {'synthetic': True}; owner.deadline = 200
        owner.expires_at = '2099-01-01T00:00:00Z'; owner.profile = dict(appBindingId='a', profileDigest='digest')
        owner.process = 'synthetic-owned-process'; owner.ended = None
        owner.api = Mock(); owner.api.k.WaitForSingleObject.return_value = 258
        owner.instances = Mock(return_value=[{'synthetic-owned-window': True}])
        def close(reason='cleaned'):
            owner.ended = (owner.profile['appBindingId'], reason)
            owner.context = owner.profile = owner.process = None
        owner.close = Mock(side_effect=close)
        return owner

    def test_live_window_expiry_exit_and_unknown_are_distinct_and_never_reserve_start(self):
        with patch.object(worker.time, 'monotonic', return_value=100):
            owner = self.owner(); profile = dict(appBindingId='a', profileDigest='digest')
            self.assertEqual(owner.status(profile)['state'], 'window-confirmed')
            self.assertEqual(owner.status(dict(appBindingId='b', profileDigest='digest'))['state'], 'saved')
            self.assertEqual(owner.status(dict(appBindingId='a', profileDigest='changed'))['state'], 'unknown')
            owner.instances.return_value = []
            self.assertEqual(owner.status(profile)['state'], 'unknown')
            owner.api.k.WaitForSingleObject.return_value = 0
            self.assertEqual(owner.status(profile)['state'], 'exited')
            owner.close.assert_called_once_with(reason='workbench-original-process-ended')
            owner = self.owner(); owner.deadline = 99
            result = owner.status(profile)
            self.assertEqual(result['state'], 'exited'); self.assertEqual(result['reason'], 'workbench-resource-expired')
            owner.blocked = True
            self.assertEqual(owner.status(profile)['state'], 'unknown')



class GenericWindowTests(unittest.TestCase):
    def owner(self):
        from types import SimpleNamespace
        import ctypes as C
        owner = worker.OwnedApp.__new__(worker.OwnedApp)
        profile = dict(appBindingId='app', profileDigest='digest', identity={'fingerprint': 'synthetic'},
                       launchSpec=dict(kind='exe', executable=r'D:\Synthetic\Viewer.exe', args=[]))
        owner.profile = profile; owner.process = 1; owner.pid = 42; owner.hwnd = None; owner.token = 'owned'
        owner.context = {'windowsSessionId': 1}; owner.desktop = 1; owner.name = 'owned-desktop'; owner.job = 2
        owner.inspect = Mock(return_value={'identity': profile['identity']}); owner.current = Mock()
        owner.native = SimpleNamespace(token=Mock(return_value=('user', 1, 'medium')))
        state = dict(desktop=0, windows=[10], window_pid=42, image=profile['launchSpec']['executable'], in_job=True, visible=True)
        def bind(desktop): state['desktop'] = desktop; return True
        def enum(desktop, callback, unused):
            for hwnd in state['windows']: callback(hwnd, 0)
            return True
        def window_pid(hwnd, pointer): C.cast(pointer, C.POINTER(worker.W.DWORD))[0] = state['window_pid']; return 7
        def in_job(process, job, pointer): C.cast(pointer, C.POINTER(worker.W.BOOL))[0] = state['in_job']; return True
        def image(process, unused, buffer, size): buffer.value = state['image']; return True
        owner.api = Mock()
        owner.api.assert_default = Mock()
        owner.api.u.SetThreadDesktop.side_effect = bind; owner.api.u.EnumDesktopWindows.side_effect = enum
        owner.api.u.GetWindowThreadProcessId.side_effect = window_pid; owner.api.u.GetAncestor.side_effect = lambda hwnd, _: hwnd
        owner.api.u.IsWindowVisible.side_effect = lambda _: state['visible']; owner.api.u.IsWindow.return_value = True
        owner.api.k.IsProcessInJob.side_effect = in_job; owner.api.k.QueryFullProcessImageNameW.side_effect = image
        owner.api.checked.side_effect = lambda value, _: value
        owner.api.name.side_effect = lambda handle: 'owned-desktop' if handle == 1 else 'Default'
        owner.api.class_name.return_value = 'SyntheticViewerClass'
        owner.thread_desktop = lambda: state['desktop']
        return owner, profile, state

    def test_generic_class_needs_original_pid_image_job_user_root_and_restores_default(self):
        owner, profile, state = self.owner()
        self.assertEqual(len(owner.instances(profile)), 1)
        owner.api.class_name.return_value = 'SyntheticEditorClass'
        self.assertEqual(len(owner.instances(profile)), 1)
        for mutation in ({'window_pid': 99}, {'visible': False}, {'windows': []}):
            with self.subTest(mutation=mutation):
                current, profile, state = self.owner(); state.update(mutation)
                self.assertEqual(current.instances(profile), []); self.assertEqual(state['desktop'], 0)
        for mutation in ({'image': r'C:\Wrong\Viewer.exe'}, {'in_job': False}, {'windows': [10, 11]}):
            with self.subTest(mutation=mutation):
                current, profile, state = self.owner(); state.update(mutation)
                with self.assertRaises(ValueError): current.instances(profile)
                self.assertEqual(state['desktop'], 0)
        current, profile, state = self.owner(); current.hwnd = 9
        with self.assertRaisesRegex(ValueError, 'original-window-changed'): current.instances(profile)
        self.assertEqual(state['desktop'], 0)

    def test_imported_path_existing_user_instance_blocks_before_file_pin_or_dispatch(self):
        from types import SimpleNamespace
        import psutil
        owner = worker.OwnedApp.__new__(worker.OwnedApp); owner.current = Mock(); owner.inspect = Mock()
        owner.process = None; owner.api = Mock(); owner.fence = Mock()
        profile = dict(launchSpec=dict(kind='exe', executable=r'D:\Synthetic\Viewer.exe', args=[]))
        for info in (dict(exe=r'd:\synthetic\viewer.exe', name='Viewer.exe'), dict(exe=None, name='VIEWER.EXE')):
            with patch.object(psutil, 'process_iter', return_value=[SimpleNamespace(info=info)]):
                with self.assertRaisesRegex(ValueError, 'workbench-existing-'): owner.start(profile)
        owner.api.launch.assert_not_called(); owner.api.k.CreateFileW.assert_not_called(); owner.fence.run.assert_not_called()



class RegistryFenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.path = Path(self.temp.name) / 'synthetic.sqlite'
        self.scope = {'providerId': 'workbench-apps', 'environmentId': 'local-workspace:apps', 'installationScopeId': 'synthetic'}
        self.profile = dict(scope=self.scope, appBindingId='app', installationId='install', applicationId='synthetic', profileRevision=1,
                            profileDigest='digest', identity={'fingerprint': 'synthetic'}, launchSpec={'kind': 'exe'},
                            validity='current', availability='available', trust='confirmed', confirmations=[{'profileRevision': 1, 'profileDigest': 'digest'}])
        self.db = sqlite3.connect(self.path)
        self.db.executescript('''CREATE TABLE private_app_denial_store(version INTEGER); INSERT INTO private_app_denial_store VALUES(1);
            CREATE TABLE private_app_denials(provider_id TEXT,environment_id TEXT,app_binding_id TEXT,installation_id TEXT,application_id TEXT);
            CREATE TABLE app_environments(provider_id TEXT,environment_id TEXT,installation_scope_id TEXT,scope_revision INTEGER);
            CREATE TABLE environment_apps(provider_id TEXT,environment_id TEXT,app_binding_id TEXT,installation_scope_id TEXT,scope_revision INTEGER,data_json TEXT);''')
        self.db.execute('INSERT INTO app_environments VALUES(?,?,?,1)', ('workbench-apps', 'local-workspace:apps', 'synthetic'))
        self.db.execute('INSERT INTO environment_apps VALUES(?,?,?,?,1,?)', ('workbench-apps', 'local-workspace:apps', 'app', 'synthetic', json.dumps(self.profile)))
        self.db.commit(); self.fence = worker.RegistryFence(self.path, self.scope)

    def tearDown(self):
        self.fence.db.close(); self.db.close(); self.temp.cleanup()

    def test_only_current_confirmed_profile_enters_effect_and_always_releases_lock(self):
        self.assertEqual(self.fence.run(self.profile, lambda: 'effect'), 'effect')
        self.assertFalse(self.fence.db.in_transaction)
        with self.assertRaises(RuntimeError): self.fence.run(self.profile, lambda: (_ for _ in ()).throw(RuntimeError('synthetic')))
        self.assertFalse(self.fence.db.in_transaction)

    def test_denial_scope_generation_identity_and_confirmation_changes_block_before_effect(self):
        mutations = [dict(trust='discovered'), dict(validity='stale'), dict(availability='unavailable'), dict(confirmations=[]),
                     dict(profileDigest='changed'), dict(identity={'fingerprint': 'changed'}), dict(launchSpec={'kind': 'package'})]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                current = {**copy.deepcopy(self.profile), **mutation}
                self.db.execute('UPDATE environment_apps SET data_json=?', (json.dumps(current),)); self.db.commit()
                with self.assertRaises(ValueError): self.fence.run(self.profile, lambda: self.fail('effect must not run'))
        self.db.execute('UPDATE environment_apps SET data_json=?', (json.dumps(self.profile),))
        self.db.execute('INSERT INTO private_app_denials VALUES(?,?,?,?,?)', ('workbench-apps', 'local-workspace:apps', 'app', 'install', 'synthetic')); self.db.commit()
        with self.assertRaises(ValueError): self.fence.run(self.profile, lambda: self.fail('denied effect'))
        self.db.execute('DELETE FROM private_app_denials'); self.db.execute('UPDATE app_environments SET scope_revision=2'); self.db.commit()
        with self.assertRaises(ValueError): self.fence.run(self.profile, lambda: self.fail('old generation effect'))


if __name__ == '__main__': unittest.main()
