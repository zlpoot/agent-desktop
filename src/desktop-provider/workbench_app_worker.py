"""Private App-only Hidden Desktop worker. No Task, model, pipe or input commands."""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import ntpath
import os
import re
from pathlib import Path
import sqlite3
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
NATIVE_ROOT = ROOT / 'src/native'
for relative in ('agent_desktop_native/__init__.py', 'agent_desktop_native/windows/__init__.py',
                 'agent_desktop_native/windows/win32.py', 'agent_desktop_native/windows/policy.py'):
    if not (NATIVE_ROOT / relative).is_file():
        raise ImportError('workbench-native-package-unavailable: ' + relative)
sys.path.insert(0, str(ROOT / 'guest'))
sys.path.insert(0, str(NATIVE_ROOT))
from app_launch import WindowsNativeLauncher, definition, LaunchFailure
from app_discovery import installation_scope_id
from agent_desktop_native.windows.win32 import Api, ENUMPROC
from agent_desktop_native.windows.policy import Blocked


class NativeDiagnostic(ValueError):
    def __init__(self, code, **details):
        super().__init__(code)
        self.details = details


def check_spec(config, spec):
    parsed = definition(spec)
    if parsed[0] != 'exe' or parsed[3] or parsed[4]:
        raise ValueError('workbench-no-argument-exe-only')
    # Optional legacy seed remains pinned, while imported profiles carry probed identity.
    if config and ntpath.normcase(config['path']) == parsed[2]:
        if hashlib.sha256(Path(config['path']).read_bytes()).hexdigest() != config['sha256']:
            raise ValueError('workbench-installation-changed')


class RegistryFence:
    def __init__(self, path, scope):
        self.db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=rw', uri=True, timeout=1, check_same_thread=False)
        self.scope = scope

    def run(self, expected, effect):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            scope = self.scope
            if expected['scope'] != scope or self.db.execute('SELECT version FROM private_app_denial_store').fetchall() != [(1,)]:
                raise ValueError('workbench-app-admission-unavailable')
            denied = self.db.execute('''SELECT 1 FROM private_app_denials WHERE provider_id=? AND environment_id=?
                AND (app_binding_id=? OR installation_id=? OR application_id=?) LIMIT 1''',
                (scope['providerId'], scope['environmentId'], expected['appBindingId'], expected['installationId'], expected['applicationId'].lower())).fetchone()
            environment = self.db.execute('SELECT installation_scope_id, scope_revision FROM app_environments WHERE provider_id=? AND environment_id=?',
                                          (scope['providerId'], scope['environmentId'])).fetchone()
            row = self.db.execute('SELECT installation_scope_id, scope_revision, data_json FROM environment_apps WHERE provider_id=? AND environment_id=? AND app_binding_id=?',
                                  (scope['providerId'], scope['environmentId'], expected['appBindingId'])).fetchone()
            if denied or not environment or not row or row[:2] != environment or environment[0] != scope['installationScopeId']:
                raise ValueError('workbench-app-admission-changed')
            current = json.loads(row[2])
            fields = ('scope', 'appBindingId', 'installationId', 'applicationId', 'profileRevision', 'profileDigest', 'identity', 'launchSpec')
            if any(current.get(key) != expected.get(key) for key in fields) or current['validity'] != 'current' or current['availability'] != 'available' or current['trust'] not in ('confirmed', 'verified'):
                raise ValueError('workbench-app-trust-changed')
            if not any(item['profileRevision'] == current['profileRevision'] and item['profileDigest'] == current['profileDigest'] for item in current['confirmations']):
                raise ValueError('workbench-app-confirmation-required')
            return effect()
        finally:
            self.db.rollback()


class OwnedApp:
    def __init__(self, config, scope, registry):
        if scope != {'providerId': 'workbench-apps', 'environmentId': 'local-workspace:apps', 'installationScopeId': installation_scope_id()}:
            raise ValueError('workbench-installation-scope-mismatch')
        self.config, self.scope = config, scope
        self.api = Api()
        # PrintWindow draws physical pixels. Query/fit geometry on the same DPI
        # basis so high-DPI windows are not cropped into virtualized bounds.
        self.api.capture_dpi()
        self.api.u.GetAncestor.argtypes, self.api.u.GetAncestor.restype = [W.HWND, W.UINT], W.HWND
        self.api.u.GetWindow.argtypes, self.api.u.GetWindow.restype = [W.HWND, W.UINT], W.HWND
        self.api.u.GetWindowLongW.argtypes, self.api.u.GetWindowLongW.restype = [W.HWND, C.c_int], W.LONG
        self.api.u.GetProcessWindowStation.argtypes, self.api.u.GetProcessWindowStation.restype = [], W.HANDLE
        self.api.k.GetProcessId.argtypes, self.api.k.GetProcessId.restype = [W.HANDLE], W.DWORD
        self.api.k.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)]
        self.api.k.QueryFullProcessImageNameW.restype = W.BOOL
        self.api.k.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, C.c_void_p, W.DWORD, W.DWORD, W.HANDLE]
        self.api.k.CreateFileW.restype = W.HANDLE
        self.native = WindowsNativeLauncher(lambda: self.scope)
        self.fence = RegistryFence(registry, scope)
        self.lock = threading.RLock()
        self.desktop = self.job = self.process = self.file = self.context = None
        self.pid = self.hwnd = self.token = self.profile = None
        self.blocked = False
        self.ended = None
        self.reservation_id = None
        self.preview_id = uuid.uuid4().hex
        self.preview_dir = ROOT / '.artifacts/workbench-app-preview' / self.preview_id
        self.preview_files = set()
        self.watch_stop, self.watch_ready = threading.Event(), threading.Event()
        # Bind and verify the expiry thread on Default before creating owned resources.
        def supervise():
            try:
                if self.api.name(self.thread_desktop()).lower() != 'default':
                    self.blocked = True
            except Exception:
                self.blocked = True
            finally:
                self.watch_ready.set()
            while not self.watch_stop.wait(.1):
                with self.lock:
                    if self.context and time.monotonic() >= self.deadline:
                        try:
                            self.close(reason='workbench-resource-expired')
                        except Exception:
                            self.blocked = True
        self.watcher = threading.Thread(target=supervise, daemon=True)
        self.watcher.start()
        if not self.watch_ready.wait(2) or self.blocked:
            self.watch_stop.set()
            self.watcher.join(2)
            self.fence.db.close()
            raise ValueError('workbench-expiry-thread-default-unconfirmed')

    def inspect(self, spec):
        check_spec(self.config, spec)
        checked = self.native.inspect(spec)
        if self.config and ntpath.normcase(spec['executable']) == ntpath.normcase(self.config['path']) and (checked['identity']['fingerprint'] != self.config['sha256'] or checked['identity']['version'] != self.config['version']):
            raise ValueError('workbench-installation-changed')
        return checked

    def catalog(self, path=None):
        path = path or (self.config or {}).get('path')
        spec = {'kind': 'exe', 'executable': path, 'args': []}
        checked = self.inspect(spec)
        entry = self.native.scanner.inspect(path, 'explicit-operator-path', time.monotonic() + 5)
        if entry['contentFingerprint'] != checked['identity']['fingerprint']:
            raise ValueError('workbench-installation-changed')
        return entry

    def status(self, profile):
        result = {'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        if self.blocked:
            return {**result, 'state': 'unknown', 'reason': 'workbench-cleanup-unconfirmed'}
        if self.context and time.monotonic() >= self.deadline:
            self.close(reason='workbench-resource-expired')
        if self.profile and self.profile['appBindingId'] == profile['appBindingId']:
            if self.profile['profileDigest'] != profile['profileDigest']:
                return {**result, 'state': 'unknown', 'reason': 'workbench-original-profile-mismatch'}
            process_state = self.api.k.WaitForSingleObject(self.process, 0)
            if process_state == 0:
                self.close(reason='workbench-original-process-ended')
            elif process_state != 258:
                return {**result, 'state': 'unknown', 'reason': 'workbench-original-process-state-unavailable'}
            else:
                values = self.instances(profile)
                return {**result, 'state': 'window-confirmed' if len(values) == 1 else 'unknown',
                        'expiresAt': self.expires_at, **({} if values else {'reason': 'workbench-original-window-unavailable'})}
        if self.ended and self.ended[0] == profile['appBindingId']:
            return {**result, 'state': 'exited', 'reason': self.ended[1]}
        return {**result, 'state': 'saved'}

    def current(self):
        self.api.assert_default()
        if self.blocked or not self.context or time.monotonic() >= self.deadline:
            raise ValueError('workbench-reservation-unavailable')
        if self.api.name(self.desktop) != self.name:
            raise ValueError('workbench-original-desktop-required')
        if self.process:
            process_state = self.api.k.WaitForSingleObject(self.process, 0)
            if process_state != 258:
                raise ValueError('workbench-original-process-ended' if process_state == 0 else 'workbench-original-process-state-unavailable')
        if self.process and self.api.k.GetProcessId(self.process) != self.pid:
            raise ValueError('workbench-original-process-changed')
        return self.context

    def stop(self, profile):
        if self.profile:
            if self.profile['appBindingId'] != profile['appBindingId'] or self.profile['profileDigest'] != profile['profileDigest']:
                raise ValueError('workbench-stop-original-profile-required')
            self.close(reason='workbench-operator-closed')
        elif self.blocked:
            raise ValueError('workbench-cleanup-unconfirmed')
        # No original owned execution is a no-op, never a path/PID-based kill.
        return {'cleaned': True}

    def fit(self, profile, token):
        if not self.token or token != self.token:
            raise ValueError('workbench-owned-token-required')
        if len(self.instances(profile)) != 1 or not self.hwnd:
            raise ValueError('workbench-original-window-unavailable')
        hwnd = self.hwnd
        rect = W.RECT()
        self.api.checked(self.api.u.GetWindowRect(hwnd, C.byref(rect)), 'workbench-window-bounds')
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if width <= 0 or height <= 0:
            raise ValueError('workbench-original-window-geometry-unavailable')
        if width > 2048 or height > 2048:
            self.api.join_job_view(self.name + '_job')
            self.api.size_owned_window(hwnd, {'pid': self.pid, 'desktop': self.name,
                                            'session': self.context['windowsSessionId']},
                                       min(width, 1600), min(height, 1000), desktop=self.desktop)
            if len(self.instances(profile)) != 1 or self.hwnd != hwnd:
                raise ValueError('workbench-original-window-changed')
            self.api.checked(self.api.u.GetWindowRect(hwnd, C.byref(rect)), 'workbench-window-bounds')
            if not (0 < rect.right - rect.left <= 2048 and 0 < rect.bottom - rect.top <= 2048):
                raise ValueError('workbench-window-fit-unconfirmed')
        self.current()
        return {'fitted': True}

    def preview(self, profile):
        # instances rechecks the original profile, binary, PID, Job, user, session,
        # desktop and HWND. Capture supplies no input/control authority.
        self.preview_files = {path for path in self.preview_files if path.exists()}
        if len(self.preview_files) >= 8:
            raise ValueError('workbench-preview-pending-limit')
        if len(self.instances(profile)) != 1 or not self.hwnd:
            raise ValueError('workbench-preview-original-window-unavailable')
        hwnd = self.hwnd
        self.api.join_job_view(self.name + '_job')
        captured_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        try:
            image, metadata = self.api.capture(hwnd, {'pid': self.pid, 'desktop': self.name,
                                                    'session': self.context['windowsSessionId']}, flags=2, desktop=self.desktop)
        except Blocked as error:
            # Preserve the exact read-only capture refusal. Do not expose arbitrary
            # exception text, and never substitute another window or desktop.
            allowed = ('target_exited', 'target_pid_mismatch', 'target_desktop_mismatch',
                       'target_session_mismatch', 'target_outside_owned_job', 'default_target_forbidden',
                       'target_desktop_membership_unavailable',
                       'invalid_capture_geometry', 'desktop_name_unavailable',
                       'interactive_session_not_active', 'user_input_desktop_not_default')
            reason = str(error)
            code = 'workbench-preview-' + (reason.replace('_', '-') if reason in allowed else 'capture-blocked')
            details = {}
            geometry = getattr(error, 'geometry', None)
            if reason == 'invalid_capture_geometry' and isinstance(geometry, dict):
                details = {key: geometry[key] for key in ('width', 'height')
                           if type(geometry.get(key)) is int and -(2**31) <= geometry[key] < 2**31}
            raise NativeDiagnostic(code, **details) from error
        if len(self.instances(profile)) != 1 or self.hwnd != hwnd:
            raise ValueError('workbench-preview-original-window-changed')
        if not metadata['nonuniform']:
            raise ValueError('workbench-preview-unrendered')
        if len(image) > 4194304:
            raise ValueError('workbench-preview-size-limit')
        # Keep the original 128 KiB stdio envelope: PNG pixels use a private,
        # per-worker opaque file, never a caller-supplied path or screenshot URL.
        self.preview_dir.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        path = self.preview_dir / (token + '.png')
        with path.open('xb') as stream:
            stream.write(image)
        self.preview_files.add(path)
        self.current()
        return {'token': token, 'sha256': hashlib.sha256(image).hexdigest(),
                'width': metadata['width'], 'height': metadata['height'],
                'capturedAt': captured_at, 'expiresAt': self.expires_at}

    def thread_desktop(self):
        C.set_last_error(0)
        return self.api.checked(self.api.u.GetThreadDesktop(self.api.k.GetCurrentThreadId()), 'workbench-current-thread-desktop')

    def reservation_key(self, value):
        if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value):
            raise ValueError('workbench-reservation-id-required')
        return value

    def release(self, reservation_id, token=None):
        self.reservation_key(reservation_id)
        if reservation_id != self.reservation_id:
            # Borrowed or already released execution: never touch a newer/other
            # request's resources. A failed cleanup retains its original key.
            return {'cleaned': True}
        if token is not None and token != self.token:
            raise ValueError('workbench-owned-token-required')
        return self.close()

    def reserve(self, reservation_id):
        self.reservation_key(reservation_id)
        if self.context:
            return self.current()
        if self.blocked:
            raise ValueError('workbench-cleanup-unconfirmed')
        self.api.assert_default()
        station = self.api.name(self.api.u.GetProcessWindowStation())
        if station.lower() != 'winsta0' or self.api.name(self.thread_desktop()).lower() != 'default':
            raise ValueError('workbench-default-session-required')
        _, _, integrity = self.native.token(os.getpid())
        if integrity != 'S-1-16-8192':
            raise ValueError('workbench-ordinary-medium-required')
        self.name = 'AgentD0_App_' + uuid.uuid4().hex
        self.reservation_id = reservation_id
        try:
            self.desktop = self.api.desktop(self.name)
            self.job = self.api.job(self.name + '_job')
            self.context = {'scope': self.scope, 'sessionId': uuid.uuid4().hex, 'instanceId': uuid.uuid4().hex,
                            'windowsSessionId': self.api.session(os.getpid()), 'desktop': station + '\\' + self.api.name(self.desktop)}
            self.deadline = time.monotonic() + 60
            self.expires_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 60))
            return self.context
        except BaseException:
            self.close()
            raise

    def start(self, profile, reservation_id):
        self.reservation_key(reservation_id)
        if reservation_id != self.reservation_id:
            raise ValueError('workbench-app-in-use')
        self.current()
        if self.process:
            raise ValueError('workbench-original-already-started')
        self.inspect(profile['launchSpec'])
        path = profile['launchSpec']['executable']
        # Do not let a single-instance app escape into an unrelated user process.
        import psutil
        for index, process in enumerate(psutil.process_iter(['name', 'exe'])):
            if index >= 4096:
                raise ValueError('workbench-process-query-limit')
            if process.info['exe'] and ntpath.normcase(process.info['exe']) == ntpath.normcase(path):
                raise ValueError('workbench-existing-user-instance')
            if not process.info['exe'] and (process.info['name'] or '').lower() == ntpath.basename(path).lower():
                raise ValueError('workbench-existing-instance-unreadable')
        def effect():
            self.file = self.api.k.CreateFileW(path, 0x80000000, 1, None, 3, 0x80, None)
            if not self.file or self.file == C.c_void_p(-1).value:
                self.file = None
                raise ValueError('workbench-installation-pin-unavailable')
            checked = self.inspect(profile['launchSpec'])
            if checked['identity'] != profile['identity']:
                raise ValueError('workbench-installation-changed')
            self.process, self.pid = self.api.launch([path], self.name, self.job)
            self.profile, self.token = profile, uuid.uuid4().hex
            self.ended = None
            return self.token
        return self.fence.run(profile, effect)

    def main_window(self, hwnd):
        # These input-indicator helpers can be visible roots in the APP process
        # before its UI exists. Their presence is not a main-window confirmation.
        if self.api.class_name(hwnd) in ('UAC_InputIndicatorOverlayWnd', 'UAC Input Indicator'):
            return False
        C.set_last_error(0)
        extended = self.api.u.GetWindowLongW(hwnd, -20)  # GWL_EXSTYLE (32-bit styles)
        error = C.get_last_error()
        if not extended and error:
            raise NativeDiagnostic('workbench-window-style-unavailable', winerror=error)
        if extended & (0x80 | 0x08000000):  # WS_EX_TOOLWINDOW / WS_EX_NOACTIVATE
            return False
        C.set_last_error(0)
        owner = self.api.u.GetWindow(hwnd, 4)  # GW_OWNER
        error = C.get_last_error()
        if not owner and error:
            raise NativeDiagnostic('workbench-window-owner-unavailable', winerror=error)
        return not owner

    def instances(self, profile):
        self.current()
        if not self.process:
            return []
        if self.profile['appBindingId'] != profile['appBindingId']:
            raise ValueError('workbench-app-in-use')
        if self.profile['profileDigest'] != profile['profileDigest']:
            raise ValueError('workbench-original-profile-mismatch')
        checked = self.inspect(profile['launchSpec'])
        if checked['identity'] != profile['identity']:
            raise ValueError('workbench-installation-changed')
        previous = self.thread_desktop()
        try:
            self.api.checked(self.api.u.SetThreadDesktop(self.desktop), 'workbench-query-bind')
            if self.api.name(self.thread_desktop()) != self.name:
                raise ValueError('workbench-helper-desktop-unconfirmed')
            windows = []
            @ENUMPROC
            def collect(hwnd, _):
                windows.append(int(hwnd))
                return len(windows) <= 1024
            C.set_last_error(0)
            enumerated = self.api.u.EnumDesktopWindows(self.desktop, collect, 0)
            enum_error = C.get_last_error()
            # Match the existing Workspace observer: an empty, initializing desktop
            # can return FALSE with ERROR_SUCCESS. This is pending, never verified.
            if not enumerated and enum_error == 0 and not windows:
                return []
            if not enumerated or len(windows) > 1024:
                raise NativeDiagnostic('workbench-window-enumeration-incomplete', winerror=enum_error,
                                       windowCount=len(windows), returned=bool(enumerated))
            matches = []
            for hwnd in windows:
                pid = W.DWORD(); tid = self.api.u.GetWindowThreadProcessId(hwnd, C.byref(pid))
                if tid and pid.value == self.pid and self.api.u.IsWindowVisible(hwnd) and self.api.u.GetAncestor(hwnd, 2) == hwnd and self.api.class_name(hwnd) and self.main_window(hwnd):
                    matches.append((hwnd, tid))
            if not matches:
                return []
            if len(matches) != 1:
                raise NativeDiagnostic('workbench-main-window-ambiguous-or-unsupported', windowCount=len(matches),
                                       windows=[{'hwnd': hwnd, 'threadId': tid, 'class': self.api.class_name(hwnd)} for hwnd, tid in matches[:16]])
            if self.hwnd and self.hwnd != matches[0][0]:
                raise ValueError('workbench-original-window-changed')
            hwnd, tid = matches[0]
            in_job = W.BOOL()
            self.api.checked(self.api.k.IsProcessInJob(self.process, self.job, C.byref(in_job)), 'workbench-original-job')
            parent = self.native.token(os.getpid()); child = self.native.token(self.pid)
            image, image_size = C.create_unicode_buffer(32768), W.DWORD(32768)
            self.api.checked(self.api.k.QueryFullProcessImageNameW(self.process, 0, image, C.byref(image_size)), 'workbench-original-image')
            after_pid = W.DWORD(); after_tid = self.api.u.GetWindowThreadProcessId(hwnd, C.byref(after_pid))
            if not in_job.value or parent != child or child[1] != self.context['windowsSessionId'] or ntpath.normcase(image.value) != ntpath.normcase(profile['launchSpec']['executable']) or not self.api.u.IsWindow(hwnd) or not self.api.u.IsWindowVisible(hwnd) or self.api.u.GetAncestor(hwnd, 2) != hwnd or not self.main_window(hwnd) or after_tid != tid or after_pid.value != self.pid:
                raise ValueError('workbench-original-owner-unconfirmed')
            self.current()
            self.hwnd = hwnd
            return [{**self.context, 'targetToken': self.token, 'identity': checked['identity'],
                     'executable': profile['launchSpec']['executable'], 'args': [], 'processOwnedByInstallation': True,
                     'windowOwnedByProcess': True, 'sameUser': True, 'permissionsCompatible': True}]
        finally:
            self.api.checked(self.api.u.SetThreadDesktop(previous), 'workbench-query-restore')
            if self.api.name(self.thread_desktop()).lower() != 'default':
                self.blocked = True
                raise ValueError('workbench-default-restore-unconfirmed')
            self.api.assert_default()

    def close(self, reason='workbench-owned-resources-cleaned'):
        if self.profile:
            self.ended = (self.profile['appBindingId'], reason)
        errors = []
        def failed(step):
            errors.append({'step': step, 'winerror': C.get_last_error()})
        if self.job:
            C.set_last_error(0)
            if not self.api.k.TerminateJobObject(self.job, 1): failed('terminate')
            until = time.monotonic() + 3
            while self.api.job_active(self.job) and time.monotonic() < until: time.sleep(.02)
            active = self.api.job_active(self.job)
            if active: errors.append({'step': 'job-not-empty', 'activeProcesses': active})
        for key in ('process', 'job', 'file'):
            handle = getattr(self, key)
            if handle:
                C.set_last_error(0)
                if not self.api.k.CloseHandle(handle): failed(key)
                else: setattr(self, key, None)
        if self.desktop:
            desktop = self.desktop
            C.set_last_error(0)
            if not self.api.u.CloseDesktop(desktop): failed('desktop-close')
            else: self.desktop = None
            # Job/handles can be drained before the desktop object disappears.
            # Bounded read-only ACK wait; never starts an App or extends its lease.
            until = time.monotonic() + 1
            while True:
                C.set_last_error(0); residual = self.api.u.OpenDesktopW(self.name, 0, False, 1); error = C.get_last_error()
                if residual:
                    if not self.api.u.CloseDesktop(residual): failed('desktop-probe-close'); break
                    if self.desktop or time.monotonic() >= until:
                        errors.append({'step': 'desktop-present'}); break
                    time.sleep(.02)
                else:
                    if error != 2: errors.append({'step': 'desktop-absence-unconfirmed', 'winerror': error})
                    break
        self.context = self.pid = self.hwnd = self.token = self.profile = None
        self.api.assert_default()
        for path in tuple(getattr(self, 'preview_files', ())):
            try:
                path.unlink(missing_ok=True)
                self.preview_files.discard(path)
            except OSError:
                pass
        directory = getattr(self, 'preview_dir', None)
        if directory and not getattr(self, 'preview_files', ()):
            try: directory.rmdir()
            except OSError: pass
        if errors:
            self.blocked = True
            raise NativeDiagnostic('workbench-cleanup-unconfirmed', cleanup=errors)
        self.reservation_id = None
        return {'cleaned': True}


def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    worker = None
    try:
        for line in sys.stdin:
            value = None
            try:
                if len(line.encode('utf-8')) > 131072: raise ValueError('workbench-request-limit')
                value = json.loads(line); method, fields = value['method'], value.get('fields', {})
                if method == 'init' and worker is None:
                    worker = OwnedApp(fields.get('config'), fields['scope'], fields['registry']); result = {'initialized': True, 'previewDirectory': getattr(worker, 'preview_id', None)}
                elif worker and method in ('inspect', 'catalog', 'reserve', 'current', 'start', 'instances', 'status', 'preview', 'fit', 'stop', 'cleanup', 'release', 'close'):
                    with worker.lock:
                        if method == 'inspect': result = worker.inspect(fields['spec'])
                        elif method == 'catalog': result = worker.catalog(fields.get('path'))
                        elif method == 'current': result = worker.current()
                        elif method == 'reserve': result = worker.reserve(fields['reservationId'])
                        elif method == 'start': result = worker.start(fields['profile'], fields['reservationId'])
                        elif method in ('instances', 'status', 'preview'): result = getattr(worker, method)(fields['profile'])
                        elif method == 'fit': result = worker.fit(fields['profile'], fields['token'])
                        elif method == 'stop': result = worker.stop(fields['profile'])
                        elif method == 'cleanup':
                            result = worker.release(fields['reservationId'], fields['token'])
                        elif method == 'release': result = worker.release(fields['reservationId'])
                        else: result = worker.close()
                else: raise ValueError('workbench-command-unavailable')
                reply = {'id': value['id'], 'result': result}
            except Exception as error:
                code = str(error) if isinstance(error, (ValueError, LaunchFailure)) and re.fullmatch(r'(workbench|app|unsupported|invalid)-[a-z0-9-]{1,100}', str(error)) else 'workbench-native-operation-failed'
                kind = error.kind if isinstance(error, LaunchFailure) else 'stale' if code == 'workbench-installation-changed' else 'unknown' if code == 'workbench-native-operation-failed' else 'unavailable'
                reply = {'id': value.get('id') if isinstance(value, dict) else None, 'error': code,
                         'failureKind': kind,
                         'diagnostic': {'operation': value.get('method') if isinstance(value, dict) else None,
                                        'exception': type(error).__name__, 'winerror': getattr(error, 'winerror', None),
                                        'errno': getattr(error, 'errno', None), 'code': code,
                                        **(error.details if isinstance(error, NativeDiagnostic) else {})}}
            print(json.dumps(reply, ensure_ascii=True), flush=True)
    finally:
        if worker:
            worker.watch_stop.set(); worker.watcher.join(2)
            with worker.lock:
                try: worker.close()
                finally: worker.fence.db.close()


if __name__ == '__main__': main()
