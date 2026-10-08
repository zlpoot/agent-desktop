"""Synthetic handle/metadata ports only. No Win32 process or window is opened."""
import copy
import ctypes
from ctypes import wintypes
import ntpath
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'guest'))
from app_launch import AppLaunchManager, LaunchFailure, OriginalProcessRecords, WindowsNativeLauncher, WindowsProcessPin

SCOPE = {'providerId': 'physical', 'environmentId': 'current-interactive-desktop', 'installationScopeId': 'synthetic-os'}
SPEC = {'kind': 'exe', 'executable': r'C:\Synthetic\Music.exe', 'args': ['--synthetic']}
IDENTITY = {'productId': 'synthetic', 'version': '1.0', 'fingerprint': 'synthetic-binary'}
PROFILE = {'appBindingId': 'synthetic-profile', 'profileRevision': 1, 'profileDigest': 'a' * 64,
           'launchSpec': SPEC, 'identity': IDENTITY}


class FakePin:
    def __init__(self, state):
        self.state, self.closed, self.closes = state, False, 0
        self.original = {'pid': state['pid'], 'createdTicks': state['ticks'], 'image': ntpath.normcase(SPEC['executable'])}

    def snapshot(self):
        if self.closed or not self.state['alive'] or self.state['ticks'] != self.original['createdTicks']:
            raise LaunchFailure('unknown', 'synthetic-original-exited')
        return copy.deepcopy(self.original)

    def close(self):
        self.closes += 1
        self.closed = True
        if self.state.get('close_failure'):
            raise RuntimeError('synthetic-uncertain-close')


class Fixture:
    def __init__(self):
        self.state = {'pid': 10, 'ticks': 100, 'alive': True}
        self.pins, self.enumerations = [], 0
        self.context = {'scope': copy.deepcopy(SCOPE), 'sessionId': 'synthetic-reservation', 'instanceId': 'synthetic-helper',
                        'windowsSessionId': 7, 'desktop': r'WinSta0\Default'}
        self.installed = copy.deepcopy(IDENTITY)
        self.argv, self.cwd, self.window, self.owner = [SPEC['executable'], *SPEC['args']], r'C:\Synthetic', 20, (30, 10)
        self.desktop, self.user, self.session, self.integrity = self.context['desktop'], 'synthetic-user', 7, 'synthetic-medium'
        self.visible = True
        def factory(pid):
            if pid != self.state['pid']:
                raise AssertionError('must pin only the enumerated process')
            pin = FakePin(self.state); self.pins.append(pin); return pin
        self.native = WindowsNativeLauncher(lambda: copy.deepcopy(SCOPE), process_pin_factory=factory)
        self.native.context = lambda: copy.deepcopy(self.context)
        self.native.inspect = lambda spec: {'scope': copy.deepcopy(SCOPE), 'launchSpec': copy.deepcopy(spec), 'identity': copy.deepcopy(self.installed)}
        self.native.token = lambda pid: ('synthetic-user', 7, 'synthetic-medium') if pid != 10 else (self.user, self.session, self.integrity)
        self.native.desktop_name = lambda thread=None: self.desktop
        process = types.SimpleNamespace(pid=10, info={'exe': SPEC['executable']},
            cmdline=lambda: list(self.argv), cwd=lambda: self.cwd, create_time=lambda: self.state['ticks'], exe=lambda: SPEC['executable'])
        def enumerate_processes(columns):
            self.enumerations += 1; return [process]
        self.modules = {'psutil': types.SimpleNamespace(process_iter=enumerate_processes, Process=lambda pid: process, Error=RuntimeError),
            'win32gui': types.SimpleNamespace(IsWindow=lambda hwnd: self.window == hwnd, IsWindowVisible=lambda hwnd: self.visible,
                EnumWindows=lambda callback, value: callback(self.window, value)),
            'win32process': types.SimpleNamespace(GetWindowThreadProcessId=lambda hwnd: self.owner)}

    def patches(self):
        return patch.dict(sys.modules, self.modules), patch('app_launch.os.stat', return_value=types.SimpleNamespace(st_mtime=50))

    def issue(self):
        return self.native.instances(copy.deepcopy(PROFILE), copy.deepcopy(self.context))[0]['targetToken']


class OriginalProcessTests(unittest.TestCase):
    def test_original_pin_is_retained_after_successful_manager_release_but_is_not_a_window_or_task_grant(self):
        f = Fixture()
        with f.patches()[0], f.patches()[1]:
            manager = AppLaunchManager(lambda: SCOPE, f.native)
            call = lambda operation, **args: manager.handle({'scope': SCOPE, 'operation': operation, **args})
            reservation = call('reserve')['reservationId']
            stage = call('stage', reservationId=reservation, profile=copy.deepcopy(PROFILE))
            target = call('instances', reservationId=reservation, stageId=stage['stageId'])[0]
            original = copy.deepcopy(f.context)
            self.assertTrue(call('release', reservationId=reservation, keepTarget=True)['drained'])
            self.assertEqual(f.pins[0].closes, 0)
            facts = f.native.resolve_original_process(target['targetToken'], PROFILE, original)
            facts['process']['pid'] = 999  # returned facts cannot alter private authority
            self.assertEqual(f.native.resolve_original_process(target['targetToken'], PROFILE, original)['process']['pid'], 10)
            with self.assertRaisesRegex(LaunchFailure, 'window-lifetime-and-producer-unavailable'):
                f.native.resolve_original_target(target['targetToken'], PROFILE, original)
            # No targetToken/PID operations are added to the frozen management v1.
            for operation in ['resolve', 'resolve_process', 'resolve_original_target']:
                with self.assertRaisesRegex(LaunchFailure, 'operation-fields'):
                    call(operation)
            f.native.close(); self.assertEqual(f.pins[0].closes, 1)

    def test_resolution_reads_only_the_retained_original_without_enumerating_or_opening_a_replacement(self):
        f = Fixture()
        with f.patches()[0], f.patches()[1]:
            token = f.issue(); count = f.enumerations
            for _ in range(3):
                f.native.resolve_original_process(token, PROFILE, f.context)
            self.assertEqual(f.enumerations, count); self.assertEqual(len(f.pins), 1)
            f.state['alive'] = False
            with self.assertRaisesRegex(LaunchFailure, 'original-exited'):
                f.native.resolve_original_process(token, PROFILE, f.context)
            f.state.update(alive=True, ticks=200)  # same PID now belongs to another kernel object
            with self.assertRaisesRegex(LaunchFailure, 'retired'):
                f.native.resolve_original_process(token, PROFILE, f.context)
            self.assertEqual(f.enumerations, count); self.assertEqual(len(f.pins), 1); self.assertEqual(f.pins[0].closes, 1)

    def test_repeat_observation_uses_original_record_and_closes_the_duplicate_query_handle(self):
        f = Fixture()
        with f.patches()[0], f.patches()[1]:
            token = f.issue(); self.assertEqual(f.issue(), token)
            self.assertEqual([pin.closes for pin in f.pins], [0, 1])
            f.native.close(); self.assertEqual([pin.closes for pin in f.pins], [1, 1])

    def test_profile_scope_and_other_issuer_cannot_substitute_an_original(self):
        f, other = Fixture(), Fixture()
        with f.patches()[0], f.patches()[1]:
            token = f.issue()
            for mutation in [lambda p, c: p.update(profileRevision=2), lambda p, c: p['identity'].update(fingerprint='replaced'),
                             lambda p, c: c['scope'].update(installationScopeId='other'), lambda p, c: c.update(instanceId='new-helper')]:
                profile, context = copy.deepcopy(PROFILE), copy.deepcopy(f.context); mutation(profile, context)
                with self.assertRaisesRegex(LaunchFailure, 'request-mismatch'):
                    f.native.resolve_original_process(token, profile, context)
            with self.assertRaisesRegex(LaunchFailure, 'not-issued'):
                other.native.resolve_original_process(token, PROFILE, other.context)
            f.native.close()

    def test_observed_metadata_or_handle_failure_is_terminal_when_old_values_are_restored(self):
        changes = ['binary', 'version', 'argv', 'cwd', 'desktop', 'session', 'user', 'integrity', 'hwnd', 'owner', 'visible', 'context', 'pin-read']
        for change in changes:
            with self.subTest(change=change):
                f = Fixture()
                with f.patches()[0], f.patches()[1]:
                    token = f.issue()
                    original_context = copy.deepcopy(f.context)
                    if change == 'binary': f.installed['fingerprint'] = 'replaced'
                    if change == 'version': f.installed['version'] = '2'
                    if change == 'argv': f.argv.append('--other')
                    if change == 'cwd': f.cwd = r'C:\Other'  # frozen even when no cwd was requested
                    if change == 'desktop': f.desktop = r'WinSta0\Other'
                    if change == 'session': f.session = 8
                    if change == 'user': f.user = 'other'
                    if change == 'integrity': f.integrity = 'elevated'
                    if change == 'hwnd': f.window = 21
                    if change == 'owner': f.owner = (31, 11)
                    if change == 'visible': f.visible = False
                    if change == 'context': f.context['instanceId'] = 'restarted'
                    if change == 'pin-read': f.pins[0].snapshot = Mock(side_effect=OSError('synthetic-read-failure'))
                    with self.assertRaisesRegex(Exception, 'changed|failure'):
                        f.native.resolve_original_process(token, PROFILE, original_context)
                    self.assertEqual(f.pins[0].closes, 1)
                    self.assertTrue(f.native.original_processes.records[token]['retired'])
                    f.installed, f.argv, f.cwd = copy.deepcopy(IDENTITY), [SPEC['executable'], *SPEC['args']], r'C:\Synthetic'
                    f.context, f.window, f.owner, f.visible = original_context, 20, (30, 10), True
                    f.desktop, f.user, f.session, f.integrity = original_context['desktop'], 'synthetic-user', 7, 'synthetic-medium'
                    with self.assertRaisesRegex(LaunchFailure, 'retired'):
                        f.native.resolve_original_process(token, PROFILE, original_context)
                    f.native.close(); self.assertEqual(f.pins[0].closes, 1)

    def test_new_reservation_and_failed_reservation_do_not_rearm_old_originals(self):
        for fail in [False, True]:
            with self.subTest(fail=fail):
                f = Fixture()
                with f.patches()[0], f.patches()[1]:
                    token = f.issue(); original = copy.deepcopy(f.context)
                    if fail: f.native.context = Mock(side_effect=LaunchFailure('unknown', 'synthetic-ready-failed'))
                    if fail:
                        with self.assertRaisesRegex(LaunchFailure, 'ready-failed'): f.native.reserve_context()
                    else: f.native.reserve_context()
                    with self.assertRaisesRegex(LaunchFailure, 'retired'):
                        f.native.resolve_original_process(token, PROFILE, original)
                    self.assertEqual(f.pins[0].closes, 1)

    def test_release_false_or_changed_guard_retires_only_query_handles(self):
        for changed in [False, True]:
            f = Fixture(); revision = [0]
            with f.patches()[0], f.patches()[1]:
                manager = AppLaunchManager(lambda: SCOPE, f.native, lambda: revision[0])
                call = lambda operation, **args: manager.handle({'scope': SCOPE, 'operation': operation, **args})
                reservation = call('reserve')['reservationId']; stage = call('stage', reservationId=reservation, profile=copy.deepcopy(PROFILE))
                token = call('instances', reservationId=reservation, stageId=stage['stageId'])[0]['targetToken']
                if changed: revision[0] += 1
                call('release', reservationId=reservation, keepTarget=changed)
                self.assertEqual(f.pins[0].closes, 1)
                with self.assertRaisesRegex(LaunchFailure, 'retired'): f.native.resolve_original_process(token, PROFILE, f.context)

    def test_unknown_close_quarantines_issuer_without_retrying_an_uncertain_handle(self):
        f = Fixture()
        with f.patches()[0], f.patches()[1]:
            token = f.issue(); f.state['close_failure'] = True
            with self.assertRaisesRegex(LaunchFailure, 'close-unconfirmed'): f.native.finish_targets(False)
            with self.assertRaisesRegex(LaunchFailure, 'records-unavailable'): f.native.resolve_original_process(token, PROFILE, f.context)
            with self.assertRaisesRegex(LaunchFailure, 'records-unavailable'): f.issue()
            self.assertEqual(len(f.pins), 1)
            f.native.close(); self.assertEqual(f.pins[0].closes, 1)

    def test_exit_during_metadata_capture_cannot_issue_a_record_or_keep_its_candidate_pin(self):
        f = Fixture()
        def exit_during_query():
            f.state['alive'] = False; return list(f.argv)
        f.modules['psutil'].Process(10).cmdline = exit_during_query
        with f.patches()[0], f.patches()[1]:
            with self.assertRaisesRegex(LaunchFailure, 'original-exited'): f.issue()
            self.assertEqual(len(f.native.original_processes.records), 0)
            self.assertEqual(f.pins[0].closes, 1)

    def test_failed_later_enumeration_retires_an_original_even_if_argv_is_restored(self):
        f = Fixture()
        with f.patches()[0], f.patches()[1]:
            token = f.issue(); f.argv.append('--changed')
            with self.assertRaisesRegex(LaunchFailure, 'arguments-changed'): f.issue()
            f.argv = [SPEC['executable'], *SPEC['args']]
            with self.assertRaisesRegex(LaunchFailure, 'retired'):
                f.native.resolve_original_process(token, PROFILE, f.context)
            self.assertEqual([pin.closes for pin in f.pins], [1, 1])

    def test_context_changed_at_the_end_of_capture_cannot_issue_an_original(self):
        f = Fixture(); calls = [0]
        def context():
            calls[0] += 1
            return copy.deepcopy(f.context) if calls[0] == 1 else {**f.context, 'instanceId': 'changed-at-end'}
        f.native.context = context
        with f.patches()[0], f.patches()[1]:
            with self.assertRaisesRegex(LaunchFailure, 'target-changed'): f.issue()
            self.assertEqual(f.native.original_processes.records, {}); self.assertEqual(f.pins[0].closes, 1)

    def test_bounded_tombstones_are_not_evicted_or_rearmed(self):
        pool = OriginalProcessRecords()
        first = None
        for index in range(128):
            state = {'pid': index + 1, 'ticks': index + 100, 'alive': True}; pin = FakePin(state)
            value = {'process': pin.snapshot(), 'window': {'hwnd': index + 10, 'thread': index + 20},
                     'profile': copy.deepcopy(PROFILE), 'context': {'sessionId': 's', 'instanceId': 'i'}}
            token = pool.enroll(pin, lambda value=value: copy.deepcopy(value))
            first = first or token
        pool.retire_all()
        pin = FakePin({'pid': 999, 'ticks': 999, 'alive': True})
        value['process'] = pin.snapshot()
        with self.assertRaisesRegex(LaunchFailure, 'record-limit'): pool.enroll(pin, lambda: copy.deepcopy(value))
        self.assertEqual(pin.closes, 1)
        with self.assertRaisesRegex(LaunchFailure, 'retired'):
            pool.resolve_process(first, PROFILE, {'sessionId': 's', 'instanceId': 'i'})

    def test_retirement_cannot_close_a_query_handle_in_the_middle_of_a_private_read(self):
        pool = OriginalProcessRecords(); state = {'pid': 10, 'ticks': 100, 'alive': True}; pin = FakePin(state)
        context = {'sessionId': 's', 'instanceId': 'i'}
        original = {'process': pin.snapshot(), 'window': {'hwnd': 20, 'thread': 30}, 'profile': copy.deepcopy(PROFILE), 'context': context}
        entered, release, attempted, retired = threading.Event(), threading.Event(), threading.Event(), threading.Event()
        block, failures = [False], []
        def probe():
            if block[0]:
                entered.set()
                if not release.wait(2): raise AssertionError('synthetic-read-timeout')
            pin.snapshot(); return copy.deepcopy(original)
        token = pool.enroll(pin, probe); block[0] = True
        def read():
            try: pool.resolve_process(token, PROFILE, context)
            except Exception as error: failures.append(error)
        def retire():
            attempted.set()
            try: pool.retire_all()
            except Exception as error: failures.append(error)
            retired.set()
        reader, closer = threading.Thread(target=read), threading.Thread(target=retire)
        reader.start()
        try:
            self.assertTrue(entered.wait(1)); closer.start(); self.assertTrue(attempted.wait(1))
            self.assertFalse(retired.is_set()); self.assertEqual(pin.closes, 0)
        finally:
            release.set(); reader.join(2)
            if closer.ident is not None: closer.join(2)
        self.assertFalse(reader.is_alive()); self.assertFalse(closer.is_alive())
        self.assertEqual(failures, []); self.assertEqual(pin.closes, 1)

    def test_closed_native_issuer_cannot_open_handles_or_dispatch_new_processes(self):
        f = Fixture(); f.native.close()
        f.native._start_fenced = Mock(side_effect=AssertionError('must not dispatch'))
        for call in [lambda: f.native.reserve_context(), lambda: f.issue(), lambda: f.native.start(PROFILE, f.context)]:
            with self.assertRaisesRegex(LaunchFailure, 'records-unavailable'): call()
        f.native._start_fenced.assert_not_called(); self.assertEqual(f.pins, [])


class WindowsHandleTests(unittest.TestCase):
    def kernel(self):
        kernel = types.SimpleNamespace(**{name: Mock() for name in ['OpenProcess', 'WaitForSingleObject', 'GetProcessId',
            'GetProcessTimes', 'QueryFullProcessImageNameW', 'CloseHandle']})
        kernel.OpenProcess.return_value = 0x100000001
        kernel.WaitForSingleObject.return_value = 0x102
        kernel.GetProcessId.return_value = 10
        kernel.CloseHandle.return_value = 1
        def times(handle, created, *rest):
            value = ctypes.cast(created, ctypes.POINTER(wintypes.FILETIME)).contents
            value.dwHighDateTime, value.dwLowDateTime = 2, 3; return 1
        def image(handle, flags, buffer, size):
            buffer.value = SPEC['executable']; return 1
        kernel.GetProcessTimes.side_effect, kernel.QueryFullProcessImageNameW.side_effect = times, image
        return kernel

    def test_query_only_noninheritable_pointer_width_handle_and_exact_filetime(self):
        kernel = self.kernel()
        with patch.object(ctypes, 'WinDLL', return_value=kernel, create=True):
            pin = WindowsProcessPin(10)
            kernel.OpenProcess.assert_called_once_with(0x00101000, False, 10)
            self.assertIs(kernel.OpenProcess.restype, wintypes.HANDLE)
            self.assertEqual(pin.snapshot(), {'pid': 10, 'createdTicks': (2 << 32) | 3, 'image': ntpath.normcase(SPEC['executable'])})
            pin.close(); pin.close(); kernel.CloseHandle.assert_called_once_with(0x100000001)

    def test_exit_wait_failure_identity_read_failure_and_exit_during_query_all_refuse(self):
        for mode in ['exit', 'wait-failed', 'times', 'image', 'pid', 'wrong-pid', 'zero-created', 'late-exit']:
            with self.subTest(mode=mode):
                kernel = self.kernel()
                with patch.object(ctypes, 'WinDLL', return_value=kernel, create=True):
                    pin = WindowsProcessPin(10)
                    if mode == 'exit': kernel.WaitForSingleObject.return_value = 0
                    if mode == 'wait-failed': kernel.WaitForSingleObject.return_value = 0xffffffff
                    if mode == 'times': kernel.GetProcessTimes.side_effect = None; kernel.GetProcessTimes.return_value = 0
                    if mode == 'image': kernel.QueryFullProcessImageNameW.side_effect = None; kernel.QueryFullProcessImageNameW.return_value = 0
                    if mode == 'pid': kernel.GetProcessId.return_value = 0
                    if mode == 'wrong-pid': kernel.GetProcessId.return_value = 11
                    if mode == 'zero-created': kernel.GetProcessTimes.side_effect = lambda *args: 1
                    if mode == 'late-exit': kernel.WaitForSingleObject.side_effect = [0x102, 0]
                    with self.assertRaises(LaunchFailure): pin.snapshot()
                    pin.close(); kernel.OpenProcess.assert_called_once()

    def test_failed_open_or_uncertain_close_cannot_reopen_or_retry(self):
        kernel = self.kernel()
        with patch.object(ctypes, 'WinDLL', return_value=kernel, create=True):
            kernel.OpenProcess.return_value = None
            with self.assertRaisesRegex(LaunchFailure, 'open-unavailable'): WindowsProcessPin(10)
            kernel.OpenProcess.return_value = 0x100000001
            pin = WindowsProcessPin(10); kernel.CloseHandle.return_value = 0
            with self.assertRaisesRegex(LaunchFailure, 'close-unconfirmed'): pin.close()
            pin.close(); kernel.CloseHandle.assert_called_once()
            with self.assertRaisesRegex(LaunchFailure, 'exited-or-unreadable'): pin.snapshot()


if __name__ == '__main__':
    unittest.main()
