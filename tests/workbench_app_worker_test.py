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
    def preview(self, profile): raise w.NativeDiagnostic('workbench-preview-invalid-capture-geometry', width=4096, height=2160)
w.OwnedApp = FakeOwner
w.main()
''' % str(spec.origin)
        import os
        environment = {**os.environ, 'PYTHONIOENCODING': 'gbk'}
        requests = [dict(id=1, method='init', fields=dict(config={}, scope={}, registry='synthetic')),
                    dict(id=2, method='instances', fields=dict(profile=dict(displayName='网易云音乐'))),
                    dict(id=3, method='close'), dict(id=4, method='inspect', fields=dict(spec={})),
                    dict(id=5, method='preview', fields=dict(profile={}))]
        result = subprocess.run([sys.executable, '-c', script], input=('\n'.join(json.dumps(item, ensure_ascii=False) for item in requests) + '\n').encode('utf-8'),
                                capture_output=True, timeout=5, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
        replies = [json.loads(line) for line in result.stdout.decode('utf-8').splitlines()]
        self.assertEqual(replies[1]['result'], ['网易云音乐'])
        self.assertEqual(replies[2]['result'], {'cleaned': True})
        self.assertEqual(replies[3]['error'], 'app-installation-path-unavailable')
        self.assertEqual(replies[3]['failureKind'], 'stale')
        self.assertEqual(replies[4]['error'], 'workbench-preview-invalid-capture-geometry')
        self.assertEqual(replies[4]['diagnostic']['width'], 4096)
        self.assertEqual(replies[4]['diagnostic']['height'], 2160)


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
        owner.api.u.GetWindowLongW.return_value = 0; owner.api.u.GetWindow.return_value = None
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
        owner.reservation_id = '00000000-0000-0000-0000-000000000001'
        profile = dict(launchSpec=dict(kind='exe', executable=r'D:\Synthetic\Viewer.exe', args=[]))
        for info in (dict(exe=r'd:\synthetic\viewer.exe', name='Viewer.exe'), dict(exe=None, name='VIEWER.EXE')):
            with patch.object(psutil, 'process_iter', return_value=[SimpleNamespace(info=info)]):
                with self.assertRaisesRegex(ValueError, 'workbench-existing-'): owner.start(profile, owner.reservation_id)
        owner.api.launch.assert_not_called(); owner.api.k.CreateFileW.assert_not_called(); owner.fence.run.assert_not_called()

    def test_auxiliary_roots_are_pending_and_do_not_ambiguate_a_real_owned_main_window(self):
        owner, profile, state = self.owner(); state['windows'] = [10, 11]
        classes = {10: 'UAC_InputIndicatorOverlayWnd', 11: 'UAC Input Indicator', 12: 'SyntheticViewerClass'}
        owner.api.class_name.side_effect = classes.get
        self.assertEqual(owner.instances(profile), []); self.assertIsNone(owner.hwnd)
        state['windows'].append(12)
        self.assertEqual(len(owner.instances(profile)), 1); self.assertEqual(owner.hwnd, 12)
        state['windows'].append(13); classes[13] = 'SyntheticSecondMain'
        with self.assertRaisesRegex(ValueError, 'ambiguous-or-unsupported'): owner.instances(profile)
        self.assertEqual(state['desktop'], 0)

    def test_tool_noactivate_and_owned_windows_are_excluded_but_query_errors_fail_closed(self):
        for extended, parent in ((0x80, None), (0x08000000, None), (0, 99)):
            owner, profile, state = self.owner()
            owner.api.u.GetWindowLongW.return_value = extended; owner.api.u.GetWindow.return_value = parent
            self.assertEqual(owner.instances(profile), []); self.assertEqual(state['desktop'], 0)
        for method, code in (('GetWindowLongW', 'style'), ('GetWindow', 'owner')):
            owner, profile, state = self.owner()
            def denied(*args): worker.C.set_last_error(5); return 0
            getattr(owner.api.u, method).side_effect = denied
            with self.assertRaisesRegex(ValueError, 'window-' + code + '-unavailable'): owner.instances(profile)
            self.assertEqual(state['desktop'], 0)

    def test_empty_initializing_desktop_is_pending_but_api_error_or_partial_enumeration_fails(self):
        owner, profile, state = self.owner()
        def empty(*args): worker.C.set_last_error(0); return False
        owner.api.u.EnumDesktopWindows.side_effect = empty
        self.assertEqual(owner.instances(profile), [])
        self.assertEqual(state['desktop'], 0); self.assertIsNone(owner.hwnd)
        def denied(*args): worker.C.set_last_error(5); return False
        owner.api.u.EnumDesktopWindows.side_effect = denied
        with self.assertRaises(worker.NativeDiagnostic) as caught: owner.instances(profile)
        self.assertEqual(caught.exception.details, {'winerror': 5, 'windowCount': 0, 'returned': False})
        self.assertEqual(state['desktop'], 0)
        def partial(desktop, callback, unused): callback(10, 0); worker.C.set_last_error(0); return False
        owner.api.u.EnumDesktopWindows.side_effect = partial
        with self.assertRaises(worker.NativeDiagnostic): owner.instances(profile)
        self.assertEqual(state['desktop'], 0)



class PreviewTests(unittest.TestCase):
    def owner(self, directory):
        from policy import png_rgb
        owner=worker.OwnedApp.__new__(worker.OwnedApp)
        owner.preview_files=set();owner.preview_dir=Path(directory)/'frames';owner.preview_id='a'*32
        owner.pid=42;owner.hwnd=10;owner.name='synthetic-owned';owner.context={'windowsSessionId':1};owner.expires_at='2099-01-01T00:00:00Z'
        owner.api=Mock();owner.api.assert_default=Mock();owner.instances=Mock(return_value=[{'owned':True}]);owner.current=Mock()
        image=png_rgb(2,1,bytearray([255,0,0,0,255,0]))
        owner.api.capture.return_value=(image,{'width':2,'height':1,'nonuniform':True})
        owner.profile={};owner.process=owner.job=owner.file=None;owner.desktop=9;owner.blocked=False
        return owner,image

    def test_readonly_owned_window_capture_uses_opaque_private_file_and_revalidates(self):
        with tempfile.TemporaryDirectory() as directory:
            owner,image=self.owner(directory);frame=owner.preview({'synthetic-profile':True})
            path=owner.preview_dir/(frame['token']+'.png')
            self.assertEqual(path.read_bytes(),image);self.assertEqual(frame['sha256'],worker.hashlib.sha256(image).hexdigest())
            self.assertEqual((frame['width'],frame['height']),(2,1));self.assertEqual(owner.instances.call_count,2)
            owner.api.capture.assert_called_once_with(10,{'pid':42,'desktop':'synthetic-owned','session':1},flags=2,desktop=9)
            owner.api.launch.assert_not_called();owner.current.assert_called_once()
            owner.desktop = None; owner.close();self.assertFalse(path.exists())

    def test_unavailable_changed_blank_oversize_or_too_many_pending_frames_never_return_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            owner,image=self.owner(directory);owner.instances.return_value=[]
            with self.assertRaisesRegex(ValueError,'original-window-unavailable'):owner.preview({})
            owner.api.capture.assert_not_called()
            owner,image=self.owner(directory);owner.instances.side_effect=[[{}],[]]
            with self.assertRaisesRegex(ValueError,'original-window-changed'):owner.preview({})
            self.assertFalse(owner.preview_dir.exists())
            owner,image=self.owner(directory);owner.api.capture.return_value=(image,{'nonuniform':False})
            with self.assertRaisesRegex(ValueError,'unrendered'):owner.preview({})
            owner,image=self.owner(directory);owner.api.capture.return_value=(b'x'*4194305,{'nonuniform':True})
            with self.assertRaisesRegex(ValueError,'size-limit'):owner.preview({})
            owner,image=self.owner(directory);owner.preview_dir.mkdir()
            for i in range(8):
                path=owner.preview_dir/str(i);path.write_bytes(b'synthetic');owner.preview_files.add(path)
            with self.assertRaisesRegex(ValueError,'pending-limit'):owner.preview({})
            owner.api.capture.assert_not_called()

    def test_actual_capture_guard_reports_geometry_or_ownership_without_gdi_or_pixels(self):
        import ctypes as C
        from win32 import Api
        with tempfile.TemporaryDirectory() as directory:
            for mutation, geometry, code in (
                    ({'pid': 99}, (640, 480), 'target-pid-mismatch'),
                    ({'desktop': 'Default'}, (640, 480), 'target-desktop-mismatch'),
                    ({'session': 9}, (640, 480), 'target-session-mismatch'),
                    ({'in_job': False}, (640, 480), 'target-outside-owned-job'),
                    ({}, (4096, 2160), 'invalid-capture-geometry')):
                owner, _ = self.owner(directory)
                api = Api.__new__(Api); api.u = Mock(); api.g = Mock(); api.assert_default = Mock()
                api.identity = Mock(return_value={'pid': 42, 'desktop': owner.name, 'session': 1,
                                                 'alive': True, 'in_job': True, **mutation})
                def rectangle(hwnd, pointer):
                    rect = C.cast(pointer, C.POINTER(worker.W.RECT)).contents
                    rect.left = rect.top = 0; rect.right, rect.bottom = geometry
                    return True
                api.u.GetWindowRect.side_effect = rectangle
                owner.api = api
                with self.assertRaises(worker.NativeDiagnostic) as caught: owner.preview({})
                self.assertEqual(str(caught.exception), 'workbench-preview-' + code)
                if code == 'invalid-capture-geometry':
                    self.assertEqual(caught.exception.details, {'width': 4096, 'height': 2160})
                api.g.CreateCompatibleDC.assert_not_called(); api.u.PrintWindow.assert_not_called()
                self.assertFalse(owner.preview_dir.exists())
            owner, _ = self.owner(directory)
            owner.api.capture.side_effect = worker.Blocked('private exception text must not leak')
            with self.assertRaisesRegex(worker.NativeDiagnostic, '^workbench-preview-capture-blocked$'): owner.preview({})

    def test_actual_printwindow_capture_with_synthetic_gdi_reaches_private_png_transport(self):
        import ctypes as C
        from win32 import Api
        with tempfile.TemporaryDirectory() as directory:
            owner, _ = self.owner(directory)
            api = Api.__new__(Api); api.u = Mock(); api.g = Mock(); api.assert_default = Mock()
            api.identity = Mock(return_value={'pid': 42, 'desktop': owner.name, 'session': 1,
                                             'alive': True, 'in_job': True})
            def rectangle(hwnd, pointer):
                rect = C.cast(pointer, C.POINTER(worker.W.RECT)).contents
                rect.left = rect.top = 0; rect.right = 2; rect.bottom = 1
                return True
            pixels = C.create_string_buffer(bytes([0, 0, 255, 0, 0, 255, 0, 0]))
            def dib(dc, info, colors, bits, section, offset):
                C.cast(bits, C.POINTER(C.c_void_p))[0] = C.addressof(pixels)
                return 101
            api.u.GetWindowRect.side_effect = rectangle; api.u.PrintWindow.return_value = True
            api.g.CreateCompatibleDC.return_value = 100; api.g.CreateDIBSection.side_effect = dib
            api.g.SelectObject.return_value = 102; owner.api = api
            frame = owner.preview({})
            self.assertEqual((frame['width'], frame['height']), (2, 1))
            self.assertTrue((owner.preview_dir / (frame['token'] + '.png')).read_bytes().startswith(b'\x89PNG'))
            api.u.PrintWindow.assert_called_once_with(10, 100, 2)
            api.g.DeleteObject.assert_called_once_with(101); api.g.DeleteDC.assert_called_once_with(100)
            self.assertEqual(owner.instances.call_count, 2); self.assertEqual(api.owned_job_name, owner.name + '_job')



class CaptureDesktopIdentityTests(unittest.TestCase):
    def api(self):
        import ctypes as C
        from win32 import Api
        api = Api.__new__(Api); api.u = Mock(); api.k = Mock(); api.assert_default = Mock()
        api.owned_job_name = 'synthetic-owned-job'; api.session = Mock(return_value=1)
        state = {'windows': [10], 'complete': True, 'in_job': True, 'pid': 42, 'after_pid': 42, 'calls': 0}
        def identity(hwnd, pointer):
            state['calls'] += 1
            C.cast(pointer, C.POINTER(worker.W.DWORD))[0] = state['pid'] if state['calls'] == 1 else state['after_pid']
            return 7
        def enum(desktop, callback, unused):
            self.assertEqual(desktop, 9)
            for hwnd in state['windows']:
                if not callback(hwnd, 0): return False
            return state['complete']
        def in_job(process, job, pointer):
            C.cast(pointer, C.POINTER(worker.W.BOOL))[0] = state['in_job']; return True
        def name(handle):
            if handle != 9: raise worker.Blocked('desktop_name_unavailable')
            return 'synthetic-owned'
        api.u.GetWindowThreadProcessId.side_effect = identity; api.u.IsWindow.return_value = True
        api.u.GetThreadDesktop.return_value = None; api.u.EnumDesktopWindows.side_effect = enum
        api.k.OpenProcess.return_value = 100; api.k.OpenJobObjectW.return_value = 200
        api.k.IsProcessInJob.side_effect = in_job; api.name = name
        return api, state

    def test_owned_desktop_membership_handles_foreign_tid_denial_and_still_needs_job_pid_session(self):
        api, state = self.api()
        expected = {'pid': 42, 'desktop': 'synthetic-owned', 'session': 1}
        api.guard(10, expected, desktop=9)
        api.u.GetThreadDesktop.assert_not_called()
        api.k.OpenJobObjectW.assert_called_once_with(4, False, 'synthetic-owned-job')
        self.assertEqual(api.k.CloseHandle.call_count, 2)
        api, state = self.api()
        with self.assertRaisesRegex(worker.Blocked, 'desktop_name_unavailable'): api.guard(10, expected)
        for mutation, reason in (({'windows': []}, 'target_desktop_mismatch'),
                                 ({'complete': False}, 'target_desktop_membership_unavailable'),
                                 ({'windows': [10] * 1025}, 'target_desktop_membership_unavailable'),
                                 ({'after_pid': 99}, 'target_exited'),
                                 ({'in_job': False}, 'target_outside_owned_job')):
            api, state = self.api(); state.update(mutation)
            with self.assertRaisesRegex(worker.Blocked, reason): api.guard(10, expected, desktop=9)
            api.u.GetThreadDesktop.assert_not_called()
        api, state = self.api()
        with self.assertRaisesRegex(worker.Blocked, 'membership_unavailable'): api.guard(10, expected, desktop=0)
        api.u.EnumDesktopWindows.assert_not_called()
        for changed, reason in (({'pid': 99}, 'target_pid_mismatch'), ({'session': 9}, 'target_session_mismatch'),
                                ({'desktop': 'Default'}, 'target_desktop_mismatch')):
            api, state = self.api()
            with self.assertRaisesRegex(worker.Blocked, reason): api.guard(10, {**expected, **changed}, desktop=9)


class ReservationOwnershipTests(unittest.TestCase):
    A = '00000000-0000-0000-0000-000000000001'
    B = '00000000-0000-0000-0000-000000000002'

    def test_borrowed_reserve_and_release_cannot_change_owner_resources_or_deadline(self):
        owner = worker.OwnedApp.__new__(worker.OwnedApp)
        owner.context = {'original': True}; owner.reservation_id = self.A
        owner.deadline = 123; owner.current = Mock(return_value=owner.context); owner.close = Mock()
        owner.api = Mock(); owner.inspect = Mock()
        self.assertEqual(owner.reserve(self.B), owner.context)
        self.assertEqual(owner.reservation_id, self.A); self.assertEqual(owner.deadline, 123)
        self.assertEqual(owner.release(self.B), {'cleaned': True}); owner.close.assert_not_called()
        owner.release(self.B, 'token-of-A'); owner.close.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'app-in-use'): owner.start({}, self.B)
        owner.inspect.assert_not_called(); owner.api.launch.assert_not_called()
        owner.token = 'token-of-A'
        with self.assertRaisesRegex(ValueError, 'owned-token-required'): owner.release(self.A, 'wrong-token')
        owner.close.assert_not_called()
        owner.release(self.A, owner.token); owner.close.assert_called_once_with()

    def test_scoped_release_still_cleans_pre_start_resources_and_keeps_failed_owner_key(self):
        owner = CleanupAckTests().owner(); owner.reservation_id = self.A; owner.profile = None
        owner.process = owner.file = None
        def absent(*args): worker.C.set_last_error(2); return None
        owner.api.u.OpenDesktopW.side_effect = absent
        self.assertEqual(owner.release(self.A), {'cleaned': True})
        owner.api.k.TerminateJobObject.assert_called_once_with(2, 1)
        self.assertIsNone(owner.reservation_id); self.assertIsNone(owner.desktop); self.assertIsNone(owner.job)
        owner.reservation_id = self.B; owner.close = Mock()
        owner.release(self.A); owner.close.assert_not_called()
        owner = CleanupAckTests().owner(); owner.reservation_id = self.A
        owner.api.u.CloseDesktop.return_value = False; owner.api.u.OpenDesktopW.side_effect = absent
        with self.assertRaisesRegex(ValueError, 'cleanup-unconfirmed'): owner.release(self.A)
        self.assertEqual(owner.reservation_id, self.A); self.assertTrue(owner.blocked)


class StopAndFitTests(unittest.TestCase):
    def test_stop_only_closes_original_profile_and_never_finds_or_kills_user_processes(self):
        owner = ManualWorkerTests().owner(); profile = dict(owner.profile)
        for changed in ({'appBindingId': 'other'}, {'profileDigest': 'other'}):
            with self.assertRaisesRegex(ValueError, 'stop-original-profile-required'): owner.stop({**profile, **changed})
        owner.close.assert_not_called()
        self.assertEqual(owner.stop(profile), {'cleaned': True})
        owner.close.assert_called_once_with(reason='workbench-operator-closed')
        self.assertEqual(owner.status(profile)['reason'], 'workbench-operator-closed')
        self.assertEqual(owner.stop(profile), {'cleaned': True}); self.assertEqual(owner.close.call_count, 1)
        owner.blocked = True
        with self.assertRaisesRegex(ValueError, 'cleanup-unconfirmed'): owner.stop(profile)

    def test_stop_cleanup_failure_cannot_report_closed(self):
        owner = ManualWorkerTests().owner()
        owner.close.side_effect = worker.NativeDiagnostic('workbench-cleanup-unconfirmed')
        with self.assertRaisesRegex(ValueError, 'cleanup-unconfirmed'): owner.stop(owner.profile)
        owner.api.launch.assert_not_called()

    def fit_owner(self, width=2575, height=1407):
        import ctypes as C
        owner = worker.OwnedApp.__new__(worker.OwnedApp)
        owner.token = 'original-token'; owner.hwnd = 10; owner.pid = 42; owner.name = 'original-desktop'
        owner.desktop = 9; owner.context = {'windowsSessionId': 1}; owner.current = Mock()
        owner.instances = Mock(return_value=[{'original': True}]); owner.api = Mock()
        owner.api.checked.side_effect = lambda value, label: value
        size = [width, height]
        def bounds(hwnd, pointer):
            rect = C.cast(pointer, C.POINTER(worker.W.RECT)).contents
            rect.left = rect.top = 0; rect.right, rect.bottom = size
            return True
        def fit(hwnd, expected, width, height, desktop=None): size[:] = [width, height]
        owner.api.u.GetWindowRect.side_effect = bounds; owner.api.size_owned_window.side_effect = fit
        return owner, size

    def test_oversize_fits_only_original_window_at_explicit_start_and_rechecks(self):
        owner, size = self.fit_owner()
        self.assertEqual(owner.fit({}, 'original-token'), {'fitted': True})
        owner.api.size_owned_window.assert_called_once_with(10, {'pid': 42, 'desktop': 'original-desktop', 'session': 1}, 1600, 1000, desktop=9)
        self.assertEqual(size, [1600, 1000]); self.assertEqual(owner.instances.call_count, 2)
        owner, size = self.fit_owner(1067, 752); owner.fit({}, 'original-token')
        owner.api.size_owned_window.assert_not_called()
        owner, size = self.fit_owner()
        with self.assertRaisesRegex(ValueError, 'owned-token-required'): owner.fit({}, 'wrong-token')
        owner.instances.assert_not_called(); owner.api.size_owned_window.assert_not_called()
        owner, size = self.fit_owner(); owner.instances.side_effect = [[{}], []]
        with self.assertRaisesRegex(ValueError, 'window-changed'): owner.fit({}, 'original-token')
        owner, size = self.fit_owner(); owner.api.size_owned_window.side_effect = None
        with self.assertRaisesRegex(ValueError, 'fit-unconfirmed'): owner.fit({}, 'original-token')


class CleanupAckTests(unittest.TestCase):
    def owner(self):
        owner=worker.OwnedApp.__new__(worker.OwnedApp)
        owner.api=Mock();owner.api.assert_default=Mock();owner.api.u.CloseDesktop.return_value=True
        owner.api.k.CloseHandle.return_value=True;owner.api.k.TerminateJobObject.return_value=True
        owner.api.job_active.return_value=0
        owner.profile=dict(appBindingId='a');owner.desktop=1;owner.job=2;owner.process=3;owner.file=4
        owner.context={};owner.pid=42;owner.hwnd=10;owner.token='owned';owner.name='synthetic-owned';owner.blocked=False
        return owner

    def test_transient_desktop_presence_waits_for_absence_ack_without_new_effect(self):
        owner=self.owner();reads=[]
        def probe(*args):
            reads.append(True)
            if len(reads)==1: return 8
            worker.C.set_last_error(2);return None
        owner.api.u.OpenDesktopW.side_effect=probe
        with patch.object(worker.time,'sleep'):
            self.assertEqual(owner.close(),{'cleaned':True})
        self.assertEqual(len(reads),2);owner.api.k.TerminateJobObject.assert_called_once_with(2,1)
        owner.api.u.CloseDesktop.assert_any_call(8);self.assertFalse(owner.blocked)
        self.assertIsNone(owner.desktop);self.assertIsNone(owner.job)
        owner.api.launch.assert_not_called()

    def test_persistent_desktop_and_absence_error_still_block_with_diagnostics(self):
        owner=self.owner();owner.api.u.OpenDesktopW.return_value=8
        with patch.object(worker.time,'monotonic',side_effect=[0,0,2]), patch.object(worker.time,'sleep'):
            with self.assertRaises(worker.NativeDiagnostic) as caught: owner.close()
        self.assertTrue(owner.blocked);self.assertIn({'step':'desktop-present'},caught.exception.details['cleanup'])
        owner=self.owner()
        def denied(*args):worker.C.set_last_error(5);return None
        owner.api.u.OpenDesktopW.side_effect=denied
        with self.assertRaises(worker.NativeDiagnostic) as caught:owner.close()
        self.assertIn({'step':'desktop-absence-unconfirmed','winerror':5},caught.exception.details['cleanup']);self.assertTrue(owner.blocked)

    def test_failed_owned_handle_close_retains_reference_and_cannot_ack_success(self):
        owner=self.owner();owner.api.u.CloseDesktop.return_value=False
        def missing(*args):worker.C.set_last_error(2);return None
        owner.api.u.OpenDesktopW.side_effect=missing;owner.api.k.CloseHandle.return_value=False
        with self.assertRaises(worker.NativeDiagnostic):owner.close()
        self.assertTrue(owner.blocked);self.assertEqual((owner.desktop,owner.job,owner.process,owner.file),(1,2,3,4))



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
