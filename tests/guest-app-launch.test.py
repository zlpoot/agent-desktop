"""Fake native process/Job/window contracts; never opens a Windows process or desktop."""
import copy
from contextlib import contextmanager
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'guest'))
from app_launch import AppLaunchManager, LaunchFailure, WindowsNativeLauncher, definition

SCOPE = {'providerId': 'hyper-v', 'environmentId': 'vm:a', 'installationScopeId': 'synthetic-a'}
SPEC = {'kind': 'exe', 'executable': r'C:\Synthetic\Music.exe', 'args': ['--literal=a b']}
IDENTITY = {'productId': 'synthetic-music', 'version': '1.0', 'fingerprint': 'synthetic-fingerprint'}
PROFILE = {'appBindingId': 'synthetic-binding', 'profileRevision': 1, 'profileDigest': 'a' * 64, 'launchSpec': SPEC, 'identity': IDENTITY}


class FakeNative:
    def __init__(self):
        self.started, self.cleaned, self.released = [], [], []
        self.installed = copy.deepcopy(IDENTITY)
        self.context_value = {**{'scope': SCOPE, 'sessionId': 's', 'instanceId': 'i'},
                              'windowsSessionId': 1, 'desktop': r'WinSta0\Default'}
        self.existing = []
        self.cleanup_fail = False
        self.dispatch_failure = False

    def context(self):
        return copy.deepcopy(self.context_value)

    def inspect(self, spec):
        return {'scope': SCOPE, 'launchSpec': copy.deepcopy(spec), 'identity': copy.deepcopy(self.installed)}

    def instances(self, profile, context):
        return self.existing

    def start(self, profile, context):
        self.started.append(copy.deepcopy(profile))
        if self.dispatch_failure:
            raise LaunchFailure('unknown', 'synthetic-lost-ack')
        return {'job': 'owned-job', 'verified': False}

    def observe(self, profile, context, owned):
        if owned:
            owned['verified'] = True
        return ['synthetic-runtime-target']

    def cleanup(self, owned):
        self.cleaned.append(owned['job'])
        if self.cleanup_fail:
            raise LaunchFailure('unknown', 'synthetic-cleanup-unconfirmed')

    def release(self, owned):
        self.released.append(owned['verified'])
        if not owned['verified']:
            self.cleanup(owned)


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.native = FakeNative()
        self.revision = 0
        self.now = 0
        self.manager = AppLaunchManager(lambda: SCOPE, self.native, lambda: self.revision, lambda: self.now)

    def call(self, operation, **values):
        return self.manager.handle({'protocolVersion': 1, 'scope': SCOPE, 'operation': operation, **values})

    def stage(self):
        self.reservation = self.call('reserve')['reservationId']
        return self.call('stage', reservationId=self.reservation, profile=copy.deepcopy(PROFILE))

    def test_readonly_inspect_has_no_reservation_launch_or_input_and_rejects_arbitrary_start_fields(self):
        self.call('inspect', launchSpec=SPEC)
        self.assertIsNone(self.manager.reservation)
        self.assertEqual(self.native.started, [])
        for extra in [{'confirmed': True}, {'executable': r'C:\evil.exe'}, {'launchSpec': SPEC}, {'pid': 123}]:
            with self.assertRaisesRegex(LaunchFailure, 'fields'):
                self.call('start', **extra)

    def test_only_current_scope_profile_stage_and_consumed_permit_can_start_once(self):
        stage = self.stage()
        with self.assertRaisesRegex(LaunchFailure, 'permit-mismatch'):
            self.call('start', reservationId=self.reservation, stageId=stage['stageId'], permitId='forged')
        args = {'reservationId': self.reservation, **stage}
        token = self.call('start', **args)
        self.assertEqual(self.call('start', **args), token)
        self.assertEqual(len(self.native.started), 1)
        with self.assertRaisesRegex(LaunchFailure, 'scope'):
            self.manager.handle({'scope': {**SCOPE, 'environmentId': 'vm:b'}, 'operation': 'start', **args})
        self.assertEqual(len(self.native.started), 1)

    def test_identity_and_control_revision_drift_refuse_dispatch_without_clearing_confirmation(self):
        stage = self.stage()
        self.native.installed['version'] = '2.0'
        with self.assertRaisesRegex(LaunchFailure, 'identity-changed'):
            self.call('start', reservationId=self.reservation, **stage)
        self.assertEqual(self.native.started, [])
        self.native.installed = copy.deepcopy(IDENTITY)
        self.revision += 1
        with self.assertRaisesRegex(LaunchFailure, 'control-revision-changed'):
            self.call('instances', reservationId=self.reservation, stageId=stage['stageId'])
        self.call('release', reservationId=self.reservation)
        self.assertIsNone(self.manager.reservation)

    def test_existing_instance_appears_at_dispatch_does_not_start_a_second(self):
        stage = self.stage()
        self.native.existing = ['user-owned']
        with self.assertRaisesRegex(LaunchFailure, 'appeared-before-dispatch'):
            self.call('start', reservationId=self.reservation, **stage)
        self.assertEqual(self.native.started, [])
        self.call('release', reservationId=self.reservation)
        self.assertEqual(self.native.cleaned, [])

    def test_unknown_dispatch_result_cannot_be_retried_with_same_permit(self):
        stage = self.stage()
        self.native.dispatch_failure = True
        with self.assertRaisesRegex(LaunchFailure, 'lost-ack'):
            self.call('start', reservationId=self.reservation, **stage)
        with self.assertRaisesRegex(LaunchFailure, 'result-unknown'):
            self.call('start', reservationId=self.reservation, **stage)
        self.assertEqual(len(self.native.started), 1)

    def test_cleanup_requires_owned_opaque_token_and_always_preserves_user_processes(self):
        stage = self.stage()
        token = self.call('start', reservationId=self.reservation, **stage)
        with self.assertRaisesRegex(LaunchFailure, 'token-not-owned'):
            self.call('cleanup', reservationId=self.reservation, ownedToken='user-pid-or-forged-token')
        self.assertFalse(self.manager.blocked)
        self.call('cleanup', reservationId=self.reservation, ownedToken=token)
        self.call('release', reservationId=self.reservation)
        self.assertEqual(self.native.cleaned, ['owned-job'])
        self.assertEqual(self.native.released, [])

    def test_cleanup_failure_keeps_resource_blocked_even_after_release_attempt(self):
        stage = self.stage()
        token = self.call('start', reservationId=self.reservation, **stage)
        self.native.cleanup_fail = True
        with self.assertRaisesRegex(LaunchFailure, 'cleanup-unconfirmed'):
            self.call('cleanup', reservationId=self.reservation, ownedToken=token)
        with self.assertRaisesRegex(LaunchFailure, 'cleanup-unconfirmed'):
            self.call('release', reservationId=self.reservation, keepTarget=True)
        self.assertTrue(self.manager.blocked)
        with self.assertRaisesRegex(LaunchFailure, 'busy-or-blocked'):
            self.call('reserve')
        self.assertEqual(self.native.released, [False])

    def test_cancelled_or_changed_reservation_drains_only_owned_job_instead_of_transferring_it(self):
        stage = self.stage()
        token = self.call('start', reservationId=self.reservation, **stage)
        self.call('observe', reservationId=self.reservation, stageId=stage['stageId'], ownedToken=token)
        self.revision += 1
        self.call('release', reservationId=self.reservation, keepTarget=True)
        self.assertEqual(self.native.cleaned, ['owned-job'])
        self.assertEqual(self.native.released, [False])

    def test_successful_verified_process_can_survive_reservation_without_retaining_input_ownership(self):
        stage = self.stage()
        token = self.call('start', reservationId=self.reservation, **stage)
        self.call('observe', reservationId=self.reservation, stageId=stage['stageId'], ownedToken=token)
        self.call('release', reservationId=self.reservation, keepTarget=True)
        self.assertEqual(self.native.cleaned, [])
        self.assertEqual(self.native.released, [True])
        self.assertIsNone(self.manager.reservation)
        self.assertEqual(self.manager.stages, {})

    def test_deadline_rejects_more_launch_but_allows_drain_and_invalidates_old_permit(self):
        stage = self.stage()
        self.now = 31
        with self.assertRaisesRegex(LaunchFailure, 'expired'):
            self.call('start', reservationId=self.reservation, **stage)
        self.call('release', reservationId=self.reservation)
        reservation = self.call('reserve')['reservationId']
        with self.assertRaisesRegex(LaunchFailure, 'stage-unknown'):
            self.call('start', reservationId=reservation, **stage)

    def test_package_shell_network_shortcut_and_invalid_argv_never_dispatch(self):
        for spec in [dict(SPEC, executable=r'C:\Windows\cmd.exe'), dict(SPEC, executable=r'\\remote\app.exe'),
                     dict(SPEC, args='shell command'), dict(SPEC, args=['line\nbreak']),
                     {'kind': 'shortcut', 'shortcutPath': r'C:\Synthetic\Music.cmd', 'executable': SPEC['executable'], 'args': []},
                     {'kind': 'package', 'packageFamilyName': 'family', 'applicationUserModelId': 'family!app'}]:
            with self.assertRaises((LaunchFailure, ValueError)):
                definition(spec)
        self.assertEqual(self.native.started, [])


class NativeWindowTests(unittest.TestCase):
    def test_native_window_verification_uses_process_creation_path_argv_user_session_and_desktop(self):
        native = WindowsNativeLauncher(lambda: SCOPE)
        native.desktop_name = lambda thread=None: r'WinSta0\Default'
        native.token = lambda pid: ('same-user', 1, 'same-integrity')
        native.inspect = lambda spec: {'scope': SCOPE, 'launchSpec': spec, 'identity': IDENTITY}
        process = types.SimpleNamespace(pid=10, info={'exe': SPEC['executable']}, cmdline=lambda: [SPEC['executable'], *SPEC['args']],
                                        cwd=lambda: r'C:\Synthetic', create_time=lambda: 100, exe=lambda: SPEC['executable'])
        def pin_factory(pid):
            created = process.create_time()
            return types.SimpleNamespace(snapshot=lambda: {'pid': pid, 'createdTicks': created, 'image': SPEC['executable'].lower()}, close=lambda: None)
        native.process_pin_factory = pin_factory
        gui = types.SimpleNamespace(IsWindow=lambda hwnd: True, IsWindowVisible=lambda hwnd: True, EnumWindows=lambda callback, value: callback(20, value))
        modules = {'psutil': types.SimpleNamespace(process_iter=lambda columns: [process], Error=RuntimeError),
                   'win32gui': gui, 'win32process': types.SimpleNamespace(GetWindowThreadProcessId=lambda hwnd: (30, 10))}
        context = {'scope': SCOPE, 'sessionId': 's', 'instanceId': 'i', 'windowsSessionId': 1, 'desktop': r'WinSta0\Default'}
        native.context = lambda: copy.deepcopy(context)
        modules['psutil'].Process = lambda pid: process
        with patch.dict(sys.modules, modules), patch('app_launch.os.stat', return_value=types.SimpleNamespace(st_mtime=50)):
            result = native.instances(PROFILE, context)[0]
            self.assertTrue(result['processOwnedByInstallation']); self.assertTrue(result['windowOwnedByProcess'])
            token = result['targetToken']
            process.create_time = lambda: 200
            self.assertNotEqual(native.instances(PROFILE, context)[0]['targetToken'], token)
            process.cmdline = lambda: [SPEC['executable'], '--other']
            with self.assertRaisesRegex(LaunchFailure, 'arguments-changed'):
                native.instances(PROFILE, context)
            gui.EnumWindows = lambda callback, value: None
            with self.assertRaisesRegex(LaunchFailure, 'other-desktop'):
                native.instances(PROFILE, context)


class NativeDispatchFenceTests(unittest.TestCase):
    def test_standalone_physical_helper_without_native_fence_cannot_dispatch_even_a_staged_permit(self):
        scope = {**SCOPE, 'providerId': 'physical', 'environmentId': 'current-interactive-desktop'}
        context = {**FakeNative().context(), 'scope': scope}
        native = WindowsNativeLauncher(lambda: scope)
        native.context = lambda: copy.deepcopy(context)
        native.inspect = lambda spec: {'scope': scope, 'launchSpec': spec, 'identity': IDENTITY}
        native.instances = lambda profile, context: []
        native._start_fenced = Mock(side_effect=AssertionError('unfenced native dispatch'))
        manager = AppLaunchManager(lambda: scope, native)
        def call(operation, **values):
            return manager.handle({'scope': scope, 'operation': operation, **values})
        reservation = call('reserve')['reservationId']
        stage = call('stage', reservationId=reservation, profile=copy.deepcopy(PROFILE))
        with self.assertRaisesRegex(LaunchFailure, 'dispatch-fence-unavailable'):
            call('start', reservationId=reservation, **stage)
        native._start_fenced.assert_not_called()
        call('release', reservationId=reservation)
        self.assertIsNone(manager.reservation)

    def test_revocation_winning_before_native_fence_entry_causes_zero_process_effects(self):
        lock = threading.RLock()
        @contextmanager
        def fence():
            with lock:
                raise LaunchFailure('unavailable', 'synthetic-policy-revoked')
                yield lambda: None
        native = WindowsNativeLauncher(lambda: SCOPE, dispatch_fence=fence)
        native._start_fenced = Mock(side_effect=AssertionError('process must not be created'))
        with self.assertRaisesRegex(LaunchFailure, 'policy-revoked'):
            native.start(PROFILE, FakeNative().context())
        native._start_fenced.assert_not_called()

    def test_native_fence_stays_held_through_create_and_resume_before_revoke_ack(self):
        lock = threading.RLock()
        attempted, revoked = threading.Event(), threading.Event()
        calls, revokers = [], []
        def check():
            self.assertTrue(lock._is_owned())
            if revoked.is_set():
                raise LaunchFailure('unavailable', 'synthetic-policy-revoked')
        @contextmanager
        def fence():
            with lock:
                check()
                yield check
        def revoke():
            attempted.set()
            with lock:
                calls.append('revoke-ack')
                revoked.set()
        handle = lambda: types.SimpleNamespace(Close=lambda: None)
        def create(*args):
            check(); calls.append('create')
            thread = threading.Thread(target=revoke); revokers.append(thread); thread.start()
            self.assertTrue(attempted.wait(1)); self.assertFalse(revoked.is_set())
            return handle(), handle(), 10, 20
        def resume(thread):
            check(); self.assertFalse(revoked.is_set()); calls.append('resume')
        modules = {
            'win32api': types.SimpleNamespace(TerminateProcess=lambda *args: calls.append('terminate')),
            'win32file': types.SimpleNamespace(CreateFile=lambda *args: handle()),
            'win32job': types.SimpleNamespace(CreateJobObject=lambda *args: handle(),
                QueryInformationJobObject=lambda *args: {'BasicLimitInformation': {'LimitFlags': 0}},
                SetInformationJobObject=lambda *args: None, AssignProcessToJobObject=lambda *args: calls.append('assign'),
                JobObjectExtendedLimitInformation=1, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=8192),
            'win32process': types.SimpleNamespace(STARTUPINFO=lambda: types.SimpleNamespace(),
                CreateProcess=create, ResumeThread=resume, CREATE_SUSPENDED=4),
        }
        native = WindowsNativeLauncher(lambda: SCOPE, dispatch_fence=fence)
        context = FakeNative().context()
        native.context = lambda: context
        native.inspect = lambda spec: {'identity': IDENTITY}
        try:
            with patch.dict(sys.modules, modules):
                native.start(PROFILE, context)
            self.assertTrue(revoked.wait(1))
            self.assertEqual(calls, ['create', 'assign', 'resume', 'revoke-ack'])
            with self.assertRaisesRegex(LaunchFailure, 'policy-revoked'):
                native.start(PROFILE, context)
        finally:
            for thread in revokers:
                thread.join(timeout=1)


class GuestHttpTests(unittest.TestCase):
    def test_management_http_is_opt_in_authenticated_scoped_and_preserves_action_control_state(self):
        path = Path(__file__).resolve().parents[1] / 'guest/action-worker.py'
        native = FakeNative()
        manager = AppLaunchManager(lambda: SCOPE, native)
        spec = importlib.util.spec_from_file_location('synthetic_launch_worker', path)
        worker = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'pyautogui': types.ModuleType('pyautogui')}), \
                patch.object(ctypes, 'windll', types.SimpleNamespace(user32=types.SimpleNamespace(SetProcessDpiAwarenessContext=lambda value: None)), create=True), \
                patch.dict(os.environ, {'AGENT_DESKTOP_TOKEN': 'synthetic-token', 'AGENT_DESKTOP_VM_ID': 'a'}, clear=False):
            spec.loader.exec_module(worker)
        worker.application_discovery_port = lambda: types.SimpleNamespace(scope=lambda: SCOPE)
        worker.desktop_readiness = lambda: {'ready_for_input': True, 'ready_for_observation': True}
        original_port = worker.application_launch_port
        def locked_port():
            self.assertTrue(worker.lock._is_owned())
            return manager
        worker.application_launch_port = locked_port
        worker.desktop_call = lambda *args: self.fail('management must not call action RPC')
        server = worker.ThreadingHTTPServer(('127.0.0.1', 0), worker.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        def call(operation, token='synthetic-token', management_key='synthetic-management-key-32-characters', **extra):
            body = {'protocolVersion': 1, 'scope': SCOPE, 'operation': operation, **extra}
            with urlopen(Request(base + '/apps/launch', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + token,
                    'X-Agent-Desktop-App-Launch-Key': management_key})) as response:
                return json.load(response)
        env = patch.dict(os.environ, {'AGENT_DESKTOP_APP_LAUNCH_KEY': 'synthetic-management-key-32-characters'})
        env.start()
        try:
            before = (worker.owner, worker.process, worker.input_control.mode, worker.input_control.revision, worker.recovery_epoch)
            with self.assertRaises(HTTPError) as raised:
                call('reserve', token='wrong')
            self.assertEqual(raised.exception.code, 401)
            with self.assertRaises(HTTPError) as raised:
                call('reserve', management_key='')
            self.assertEqual(raised.exception.code, 403)
            for payload in [{'confirmed': True}, {'executable': r'C:\evil.exe'}]:
                self.assertIn('error', call('start', **payload))
            self.assertEqual(call('inspect', launchSpec=SPEC)['result']['scope'], SCOPE)
            with patch.dict(os.environ, {'AGENT_DESKTOP_ENABLE_APP_LAUNCH': '0'}):
                self.assertEqual(worker.application_launch_state(), {})
            with patch.dict(os.environ, {'AGENT_DESKTOP_ENABLE_APP_LAUNCH': '1'}):
                self.assertEqual(worker.application_launch_state()['app_launch']['scope'], SCOPE)
            self.assertEqual(before, (worker.owner, worker.process, worker.input_control.mode, worker.input_control.revision, worker.recovery_epoch))
            self.assertEqual(native.started, [])
            with patch.dict(os.environ, {'AGENT_DESKTOP_ENABLE_APP_LAUNCH': '0'}):
                with self.assertRaisesRegex(LaunchFailure, 'disabled'):
                    original_port()
            def fenced_fake(scope, instance, fence):
                native = FakeNative()
                native.dispatch_fence = fence
                return native
            with patch.dict(os.environ, {'AGENT_DESKTOP_ENABLE_APP_LAUNCH': '1'}), \
                    patch.object(worker, 'WindowsNativeLauncher', fenced_fake):
                guarded = original_port()
                worker.owner = 'retained-task'
                with self.assertRaisesRegex(LaunchFailure, 'busy-or-stopped'):
                    guarded.handle({'scope': SCOPE, 'operation': 'reserve'})
                worker.owner = None
                worker.input_control.mode = 'human'
                with self.assertRaisesRegex(LaunchFailure, 'busy-or-stopped'):
                    guarded.handle({'scope': SCOPE, 'operation': 'reserve'})
                worker.input_control.mode = 'paused'
                reservation = guarded.handle({'scope': SCOPE, 'operation': 'reserve'})['reservationId']
                with guarded.native.dispatch_fence() as check:
                    self.assertTrue(worker.lock._is_owned())
                    check()
                    worker.input_control.revision += 1
                    with self.assertRaisesRegex(LaunchFailure, 'control-revision-changed'):
                        check()
                guarded.handle({'scope': SCOPE, 'operation': 'release', 'reservationId': reservation})
        finally:
            env.stop()
            server.shutdown(); server.server_close(); thread.join(timeout=3)


if __name__ == '__main__':
    unittest.main()
