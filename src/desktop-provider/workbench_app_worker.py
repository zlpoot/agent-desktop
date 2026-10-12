"""Private App-only Hidden Desktop worker. No Task, model, pipe or input commands."""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import ntpath
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'guest'))
sys.path.insert(0, str(ROOT / 'spikes/local-workspace'))
from app_launch import WindowsNativeLauncher, definition
from app_discovery import installation_scope_id
from win32 import Api, ENUMPROC


def check_spec(config, spec):
    if definition(spec) != ('exe', '', ntpath.normcase(config['path']), (), ''):
        raise ValueError('workbench-configured-app-only')
    if ntpath.basename(config['path']).lower() != 'cloudmusic.exe' or config['version'] != '3.1.40.205461':
        raise ValueError('workbench-app-version-unsupported')
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
        self.api.u.GetAncestor.argtypes, self.api.u.GetAncestor.restype = [W.HWND, W.UINT], W.HWND
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
                            self.close()
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
        if checked['identity']['fingerprint'] != self.config['sha256'] or checked['identity']['version'] != self.config['version']:
            raise ValueError('workbench-installation-changed')
        return checked

    def catalog(self):
        spec = {'kind': 'exe', 'executable': self.config['path'], 'args': []}
        checked = self.inspect(spec)
        entry = self.native.scanner.inspect(self.config['path'], 'explicit-operator-config', time.monotonic() + 5)
        if entry['contentFingerprint'] != checked['identity']['fingerprint']:
            raise ValueError('workbench-installation-changed')
        return {**entry, 'displayName': '网易云音乐', 'aliases': ['NetEase Cloud Music']}

    def current(self):
        self.api.assert_default()
        if self.blocked or not self.context or time.monotonic() >= self.deadline:
            raise ValueError('workbench-reservation-unavailable')
        if self.api.name(self.desktop) != self.name:
            raise ValueError('workbench-original-desktop-required')
        if self.process and self.api.k.WaitForSingleObject(self.process, 0) != 258:
            raise ValueError('workbench-original-process-ended')
        if self.process and self.api.k.GetProcessId(self.process) != self.pid:
            raise ValueError('workbench-original-process-changed')
        return self.context

    def thread_desktop(self):
        C.set_last_error(0)
        return self.api.checked(self.api.u.GetThreadDesktop(self.api.k.GetCurrentThreadId()), 'workbench-current-thread-desktop')

    def reserve(self):
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
        try:
            self.desktop = self.api.desktop(self.name)
            self.job = self.api.job(self.name + '_job')
            self.context = {'scope': self.scope, 'sessionId': uuid.uuid4().hex, 'instanceId': uuid.uuid4().hex,
                            'windowsSessionId': self.api.session(os.getpid()), 'desktop': station + '\\' + self.api.name(self.desktop)}
            self.deadline = time.monotonic() + 60
            return self.context
        except BaseException:
            self.close()
            raise

    def start(self, profile):
        self.current()
        if self.process:
            raise ValueError('workbench-original-already-started')
        self.inspect(profile['launchSpec'])
        # Do not let a single-instance app escape into an unrelated user process.
        import psutil
        for index, process in enumerate(psutil.process_iter(['name', 'exe'])):
            if index >= 4096:
                raise ValueError('workbench-process-query-limit')
            if process.info['exe'] and os.path.normcase(process.info['exe']) == os.path.normcase(self.config['path']):
                raise ValueError('workbench-existing-user-instance')
            if not process.info['exe'] and (process.info['name'] or '').lower() == 'cloudmusic.exe':
                raise ValueError('workbench-existing-instance-unreadable')
        def effect():
            self.file = self.api.k.CreateFileW(self.config['path'], 0x80000000, 1, None, 3, 0x80, None)
            if not self.file or self.file == C.c_void_p(-1).value:
                self.file = None
                raise ValueError('workbench-installation-pin-unavailable')
            checked = self.inspect(profile['launchSpec'])
            if checked['identity'] != profile['identity']:
                raise ValueError('workbench-installation-changed')
            self.process, self.pid = self.api.launch([self.config['path']], self.name, self.job)
            self.profile, self.token = profile, uuid.uuid4().hex
            return self.token
        return self.fence.run(profile, effect)

    def instances(self, profile):
        self.current()
        if not self.process:
            return []
        if self.profile['appBindingId'] != profile['appBindingId'] or self.profile['profileDigest'] != profile['profileDigest']:
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
            if not self.api.u.EnumDesktopWindows(self.desktop, collect, 0) or len(windows) > 1024:
                raise ValueError('workbench-window-enumeration-incomplete')
            matches = []
            for hwnd in windows:
                pid = W.DWORD(); tid = self.api.u.GetWindowThreadProcessId(hwnd, C.byref(pid))
                if tid and pid.value == self.pid and self.api.u.IsWindowVisible(hwnd) and self.api.class_name(hwnd) == 'OrpheusBrowserHost':
                    if self.api.u.GetAncestor(hwnd, 2) != hwnd:
                        raise ValueError('workbench-original-root-required')
                    matches.append((hwnd, tid))
            if not matches:
                return []
            if len(matches) != 1 or self.hwnd and self.hwnd != matches[0][0]:
                raise ValueError('workbench-original-window-changed')
            hwnd, tid = matches[0]
            in_job = W.BOOL()
            self.api.checked(self.api.k.IsProcessInJob(self.process, self.job, C.byref(in_job)), 'workbench-original-job')
            parent = self.native.token(os.getpid()); child = self.native.token(self.pid)
            image, image_size = C.create_unicode_buffer(32768), W.DWORD(32768)
            self.api.checked(self.api.k.QueryFullProcessImageNameW(self.process, 0, image, C.byref(image_size)), 'workbench-original-image')
            after_pid = W.DWORD(); after_tid = self.api.u.GetWindowThreadProcessId(hwnd, C.byref(after_pid))
            if not in_job.value or parent != child or child[1] != self.context['windowsSessionId'] or ntpath.normcase(image.value) != ntpath.normcase(self.config['path']) or not self.api.u.IsWindow(hwnd) or self.api.u.GetAncestor(hwnd, 2) != hwnd or after_tid != tid or after_pid.value != self.pid:
                raise ValueError('workbench-original-owner-unconfirmed')
            self.current()
            self.hwnd = hwnd
            return [{**self.context, 'targetToken': self.token, 'identity': checked['identity'],
                     'executable': self.config['path'], 'args': [], 'processOwnedByInstallation': True,
                     'windowOwnedByProcess': True, 'sameUser': True, 'permissionsCompatible': True}]
        finally:
            self.api.checked(self.api.u.SetThreadDesktop(previous), 'workbench-query-restore')
            if self.api.name(self.thread_desktop()).lower() != 'default':
                self.blocked = True
                raise ValueError('workbench-default-restore-unconfirmed')
            self.api.assert_default()

    def close(self):
        errors = []
        if self.job:
            if not self.api.k.TerminateJobObject(self.job, 1): errors.append('terminate')
            until = time.monotonic() + 3
            while self.api.job_active(self.job) and time.monotonic() < until: time.sleep(.02)
            if self.api.job_active(self.job): errors.append('job-not-empty')
        for key in ('process', 'job', 'file'):
            handle = getattr(self, key); setattr(self, key, None)
            if handle and not self.api.k.CloseHandle(handle): errors.append(key)
        if self.desktop:
            desktop, self.desktop = self.desktop, None
            if not self.api.u.CloseDesktop(desktop): errors.append('desktop-close')
            C.set_last_error(0); residual = self.api.u.OpenDesktopW(self.name, 0, False, 1); error = C.get_last_error()
            if residual:
                self.api.u.CloseDesktop(residual); errors.append('desktop-present')
            elif error != 2: errors.append('desktop-absence-unconfirmed')
        self.context = self.pid = self.hwnd = self.token = self.profile = None
        self.api.assert_default()
        if errors:
            self.blocked = True
            raise ValueError('workbench-cleanup-unconfirmed')
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
                    worker = OwnedApp(fields['config'], fields['scope'], fields['registry']); result = {'initialized': True}
                elif worker and method in ('inspect', 'catalog', 'reserve', 'current', 'start', 'instances', 'cleanup', 'close'):
                    with worker.lock:
                        if method == 'inspect': result = worker.inspect(fields['spec'])
                        elif method == 'catalog': result = worker.catalog()
                        elif method in ('reserve', 'current'): result = getattr(worker, method)()
                        elif method in ('start', 'instances'): result = getattr(worker, method)(fields['profile'])
                        elif method == 'cleanup':
                            if fields['token'] != worker.token: raise ValueError('workbench-owned-token-required')
                            result = worker.close()
                        else: result = worker.close()
                else: raise ValueError('workbench-command-unavailable')
                reply = {'id': value['id'], 'result': result}
            except Exception as error:
                code = str(error) if isinstance(error, ValueError) and str(error).startswith('workbench-') else 'workbench-native-operation-failed'
                reply = {'id': value.get('id') if isinstance(value, dict) else None, 'error': code,
                         'diagnostic': {'operation': value.get('method') if isinstance(value, dict) else None,
                                        'exception': type(error).__name__, 'winerror': getattr(error, 'winerror', None),
                                        'errno': getattr(error, 'errno', None)}}
            print(json.dumps(reply, ensure_ascii=True), flush=True)
    finally:
        if worker:
            worker.watch_stop.set(); worker.watcher.join(2)
            with worker.lock:
                try: worker.close()
                finally: worker.fence.db.close()


if __name__ == '__main__': main()
