"""Private, bounded application management. No import-time Windows calls or input APIs.

The authenticated Host/stdio channel stages a Registry profile; start only accepts
server-issued IDs. A staged profile is not a business action/input grant.
"""
import copy
import ctypes
from ctypes import wintypes
import json
import ntpath
import os
import secrets
import subprocess
import sys
import threading
import time
import uuid

from app_discovery import WindowsAppScanner, installation_scope_id, local_path, WRAPPERS


class LaunchFailure(Exception):
    def __init__(self, kind, reason):
        super().__init__(reason)
        self.kind = kind


class WindowsProcessPin:
    """Query-only handle to one kernel process object; never reopens it by PID."""
    def __init__(self, pid):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'OpenProcess': ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            'WaitForSingleObject': ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            'GetProcessId': ([wintypes.HANDLE], wintypes.DWORD),
            'GetProcessTimes': ([wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)], wintypes.BOOL),
            'QueryFullProcessImageNameW': ([wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            'CloseHandle': ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (args, result) in signatures.items():
            getattr(kernel, name).argtypes, getattr(kernel, name).restype = args, result
        self.pid = pid
        self.kernel, self.handle = kernel, kernel.OpenProcess(0x00100000 | 0x1000, False, pid)
        if not self.handle:
            raise LaunchFailure('unknown', 'app-original-process-open-unavailable')

    def snapshot(self):
        kernel, handle = self.kernel, self.handle
        # Only WAIT_TIMEOUT means the retained object is still unsignaled/alive.
        if not handle or kernel.WaitForSingleObject(handle, 0) != 0x102:
            raise LaunchFailure('unknown', 'app-original-process-exited-or-unreadable')
        times = [wintypes.FILETIME() for _ in range(4)]
        pid = kernel.GetProcessId(handle)
        image, size = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
        if pid != self.pid or not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)) or \
                not kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)):
            raise LaunchFailure('unknown', 'app-original-process-identity-unavailable')
        if kernel.WaitForSingleObject(handle, 0) != 0x102:
            raise LaunchFailure('unknown', 'app-original-process-exited-or-unreadable')
        created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        if not created:
            raise LaunchFailure('unknown', 'app-original-process-creation-unavailable')
        return {'pid': pid, 'createdTicks': created,
                'image': ntpath.normcase(image.value)}

    def close(self):
        handle, self.handle = self.handle, None
        if handle and not self.kernel.CloseHandle(handle):
            # Never retry closing an uncertain numeric handle that could be reused.
            raise LaunchFailure('unknown', 'app-original-process-close-unconfirmed')


class OriginalProcessRecords:
    """Issuer-private bounded originals. Window facts are consistency checks only.
    Reads/retirement share a lock; this lock does NOT serialize any native effect.
    """
    def __init__(self):
        self.records, self.keys = {}, {}
        self.lock = threading.RLock()
        self.blocked, self.closed = False, False

    def _available(self):
        if self.blocked or self.closed:
            raise LaunchFailure('unavailable', 'app-original-records-unavailable')

    def assert_available(self):
        with self.lock:
            self._available()

    def _close_pin(self, pin):
        try:
            pin.close()
        except Exception as error:
            self.blocked = True
            raise LaunchFailure('unknown', 'app-original-process-close-unconfirmed') from error

    def _retire(self, record):
        pin, record['pin'] = record['pin'], None
        record['retired'] = True
        if pin is not None:
            self._close_pin(pin)

    def enroll(self, pin, probe):
        # Takes ownership of the candidate pin, including all error paths.
        with self.lock:
            retained = False
            try:
                self._available()
                original = copy.deepcopy(probe())
                process, window, context = original['process'], original['window'], original['context']
                key = (process['pid'], process['createdTicks'], window['hwnd'], window['thread'],
                       context['sessionId'], context['instanceId'])
                previous = self.records.get(self.keys.get(key))
                if previous:
                    if previous['retired']:
                        raise LaunchFailure('unknown', 'app-original-target-retired')
                    self._read(previous)
                    if previous['original'] != original:
                        self._retire(previous)
                        raise LaunchFailure('unknown', 'app-original-target-changed')
                    return self.keys[key]
                if len(self.records) >= 128:
                    raise LaunchFailure('unavailable', 'app-original-record-limit')
                token = uuid.uuid4().hex
                self.records[token] = {'pin': pin, 'probe': probe, 'original': original, 'retired': False}
                self.keys[key] = token
                retained = True
                return token
            finally:
                if not retained:
                    self._close_pin(pin)

    def _read(self, record):
        if record['retired']:
            raise LaunchFailure('unknown', 'app-original-target-retired')
        try:
            if record['probe']() != record['original']:
                raise LaunchFailure('unknown', 'app-original-target-changed')
        except Exception:
            self._retire(record)
            raise
        return copy.deepcopy(record['original'])

    def resolve_process(self, token, profile, context):
        with self.lock:
            self._available()
            record = self.records.get(token)
            if record is None:
                raise LaunchFailure('unavailable', 'app-original-target-not-issued')
            if record['original']['profile'] != profile or record['original']['context'] != context:
                raise LaunchFailure('unknown', 'app-original-request-mismatch')
            return self._read(record)

    def retire_all(self, close=False):
        with self.lock:
            self.closed = self.closed or close
            failures = []
            for record in self.records.values():
                try:
                    self._retire(record)
                except Exception as error:
                    failures.append(error)
            if failures:
                raise LaunchFailure('unknown', 'app-original-process-close-unconfirmed') from failures[0]


def fields(value, allowed, required):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        raise LaunchFailure('stale', 'invalid-app-launch-fields')


def definition(spec):
    if isinstance(spec, dict) and spec.get('kind') == 'package':
        raise LaunchFailure('unavailable', 'package-launch-unsupported')
    fields(spec, ('kind', 'executable', 'args', 'workingDirectory', 'shortcutPath'), ('kind', 'executable', 'args'))
    if spec['kind'] not in ('exe', 'shortcut') or ('shortcutPath' in spec) != (spec['kind'] == 'shortcut'):
        raise LaunchFailure('stale', 'invalid-app-launch-kind')
    try:
        executable = local_path(spec['executable'])
        if not executable.lower().endswith('.exe') or ntpath.basename(executable).lower() in WRAPPERS:
            raise ValueError('unsupported-app-wrapper')
        shortcut = local_path(spec['shortcutPath']) if spec['kind'] == 'shortcut' else ''
        if shortcut and not shortcut.lower().endswith('.lnk'):
            raise ValueError('unsupported-shortcut')
        working = local_path(spec['workingDirectory']) if 'workingDirectory' in spec else ''
        args = spec['args']
        if (not isinstance(args, list) or len(args) > 32 or any(not isinstance(arg, str) or
                len(arg) > 4096 or any(c in arg for c in '\0\r\n') for arg in args)):
            raise ValueError('invalid-app-args')
        return (spec['kind'], ntpath.normcase(shortcut), ntpath.normcase(executable), tuple(args), ntpath.normcase(working))
    except (ValueError, TypeError) as error:
        raise LaunchFailure('stale', str(error)) from error


class AppLaunchManager:
    """One managed reservation per execution environment, with consumed permits and owned Jobs.
    The backend guard synchronizes existing resource/control policy at every effect.
    """
    def __init__(self, scope, native, guard=lambda: None, clock=time.monotonic):
        self.scope, self.native, self.guard, self.clock = scope, native, guard, clock
        self.reservation = None
        self.stages, self.owned = {}, {}
        self.blocked = False

    def inspect(self, spec):
        definition(spec)
        value = self.native.inspect(spec)
        if value['scope'] != self.scope() or definition(value['launchSpec']) != definition(spec):
            raise LaunchFailure('stale', 'app-installation-definition-mismatch')
        return value

    def current(self, identity):
        if self.blocked:
            raise LaunchFailure('unknown', 'app-launch-cleanup-unconfirmed')
        if not self.reservation or identity != self.reservation['id']:
            raise LaunchFailure('unavailable', 'app-launch-reservation-invalid')
        current_guard = self.guard()
        if current_guard != self.reservation['guard']:
            raise LaunchFailure('unknown', 'app-launch-control-revision-changed')
        if self.native.context() != self.reservation['context']:
            raise LaunchFailure('unknown', 'app-runtime-instance-changed')
        if self.clock() > self.reservation['deadline']:
            raise LaunchFailure('unknown', 'app-launch-reservation-expired')

    def handle(self, request):
        allowed = ('protocolVersion', 'scope', 'operation', 'reservationId', 'launchSpec', 'profile', 'stageId', 'permitId', 'ownedToken', 'keepTarget')
        fields(request, allowed, ('scope', 'operation'))
        if request.get('protocolVersion', 1) != 1 or request['scope'] != self.scope():
            raise LaunchFailure('unavailable', 'app-launch-scope-or-version-mismatch')
        operation = request['operation']
        extra = {'inspect': {'launchSpec', 'reservationId'}, 'reserve': set(), 'current': {'reservationId'},
                 'stage': {'reservationId', 'profile'}, 'instances': {'reservationId', 'stageId'},
                 'start': {'reservationId', 'stageId', 'permitId'}, 'observe': {'reservationId', 'stageId', 'ownedToken'},
                 'cleanup': {'reservationId', 'ownedToken'}, 'release': {'reservationId', 'keepTarget'}}
        if operation not in extra or set(request) - {'protocolVersion', 'scope', 'operation'} - extra[operation]:
            raise LaunchFailure('stale', 'invalid-app-launch-operation-fields')
        required = extra[operation] - ({'ownedToken'} if operation == 'observe' else {'reservationId'} if operation == 'inspect' else {'keepTarget'} if operation == 'release' else set())
        if not required <= set(request):
            raise LaunchFailure('stale', 'missing-app-launch-operation-fields')
        if operation == 'inspect':
            return self.inspect(request['launchSpec'])
        if operation == 'reserve':
            if self.blocked or self.reservation:
                raise LaunchFailure('unavailable', 'app-launch-resource-busy-or-blocked')
            guard_value = self.guard()
            context = self.native.reserve_context() if hasattr(self.native, 'reserve_context') else self.native.context()
            if context['scope'] != request['scope']:
                raise LaunchFailure('unavailable', 'app-launch-context-mismatch')
            self.reservation = {'id': uuid.uuid4().hex, 'context': context, 'deadline': self.clock() + 30, 'guard': guard_value}
            return {'reservationId': self.reservation['id'], 'context': copy.deepcopy(context)}
        # Drain is permitted after readiness/identity/timeout changes; ownership remains exact.
        if operation in ('cleanup', 'release'):
            if not self.reservation or request['reservationId'] != self.reservation['id']:
                raise LaunchFailure('unknown', 'app-launch-drain-identity-mismatch')
            if operation == 'cleanup' and request['ownedToken'] not in self.owned:
                raise LaunchFailure('unknown', 'app-cleanup-token-not-owned')
            try:
                if operation == 'cleanup':
                    token = request['ownedToken']
                    self.native.cleanup(self.owned[token])
                    del self.owned[token]
                else:
                    if type(request.get('keepTarget', False)) is not bool:
                        raise LaunchFailure('stale', 'invalid-app-launch-release')
                    keep = request.get('keepTarget', False) and not self.blocked and all(value.get('verified', False) for value in self.owned.values())
                    if keep:
                        try:
                            self.current(request['reservationId'])
                        except Exception:
                            keep = False
                    if hasattr(self.native, 'finish_targets'):
                        self.native.finish_targets(keep)
                    for value in self.owned.values():
                        value['verified'] = value.get('verified', False) and keep
                        self.native.release(value)
                    self.owned.clear()
                    self.reservation = None
                    self.stages.clear()
                    return {'targetKept': bool(keep), 'drained': True}
                return None
            except Exception as error:
                self.blocked = True
                if hasattr(self.native, 'finish_targets'):
                    try:
                        self.native.finish_targets(False)
                    except Exception:
                        pass
                raise LaunchFailure('unknown', 'app-launch-cleanup-unconfirmed') from error
        self.current(request['reservationId'])
        if operation == 'current':
            return None
        if operation == 'stage':
            profile = request['profile']
            fields(profile, ('appBindingId', 'profileRevision', 'profileDigest', 'launchSpec', 'identity'),
                   ('appBindingId', 'profileRevision', 'profileDigest', 'launchSpec', 'identity'))
            if (not isinstance(profile['appBindingId'], str) or not profile['appBindingId'] or
                    type(profile['profileRevision']) is not int or profile['profileRevision'] < 1 or
                    not isinstance(profile['profileDigest'], str) or len(profile['profileDigest']) != 64):
                raise LaunchFailure('stale', 'invalid-app-launch-profile')
            checked = self.inspect(profile['launchSpec'])
            if checked['identity'] != profile['identity']:
                raise LaunchFailure('stale', 'app-installation-identity-changed')
            if len(self.stages) >= 1:
                raise LaunchFailure('unavailable', 'app-launch-stage-limit')
            stage_id, permit = uuid.uuid4().hex, secrets.token_hex(32)
            self.stages[stage_id] = {'profile': copy.deepcopy(profile), 'permit': permit, 'result': None, 'consumed': False}
            return {'stageId': stage_id, 'permitId': permit}
        stage = self.stages.get(request['stageId'])
        if not stage:
            raise LaunchFailure('stale', 'app-launch-stage-unknown')
        profile = stage['profile']
        if operation == 'start':
            if request['permitId'] != stage['permit']:
                raise LaunchFailure('stale', 'app-launch-permit-mismatch')
            if stage['consumed']:
                if stage['result'] is None:
                    raise LaunchFailure('unknown', 'app-launch-result-unknown')
                return stage['result']
            stage['consumed'] = True  # no retry even when native dispatch/ACK is uncertain
            if self.inspect(profile['launchSpec'])['identity'] != profile['identity']:
                raise LaunchFailure('stale', 'app-installation-identity-changed')
            self.current(request['reservationId'])
            if self.native.instances(profile, self.reservation['context']):
                raise LaunchFailure('unavailable', 'app-instance-appeared-before-dispatch')
            value = self.native.start(profile, self.reservation['context'])
            token = uuid.uuid4().hex
            self.owned[token] = value
            stage['result'] = token
            return token
        if operation == 'instances':
            return self.native.instances(profile, self.reservation['context'])
        if operation == 'observe':
            token = request.get('ownedToken')
            if token is not None and (token not in self.owned or stage['result'] != token):
                raise LaunchFailure('unknown', 'app-observation-token-not-owned')
            value = self.native.observe(profile, self.reservation['context'], self.owned.get(token))
            self.current(request['reservationId'])
            return value
        raise LaunchFailure('stale', 'unsupported-app-launch-operation')


class WindowsNativeLauncher:
    """Conservative Win32 EXE adapter. No shell, elevation, focus or Default Desktop fallback.
    Only one exact executable/argv/window is accepted. Unproven launcher delegation is unknown.
    """
    def __init__(self, scope, instance_id=None, dispatch_fence=None, process_pin_factory=WindowsProcessPin):
        self.scope, self.instance = scope, instance_id or uuid.uuid4().hex
        self.session = uuid.uuid4().hex
        self.scanner = WindowsAppScanner()
        self.original_processes = OriginalProcessRecords()
        self.process_pin_factory = process_pin_factory
        # Trusted native-side fence: entering it must serialize against permission revoke,
        # and yield a current-reservation check. A check callback alone is not a fence.
        self.dispatch_fence = dispatch_fence

    @staticmethod
    def desktop_name(thread_id=None):
        user, kernel = ctypes.windll.user32, ctypes.windll.kernel32
        user.GetThreadDesktop.argtypes = [wintypes.DWORD]
        user.GetThreadDesktop.restype = wintypes.HANDLE
        user.GetProcessWindowStation.restype = wintypes.HANDLE
        user.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        def name(handle):
            buffer, required = ctypes.create_unicode_buffer(512), wintypes.DWORD()
            if not handle or not user.GetUserObjectInformationW(handle, 2, buffer, ctypes.sizeof(buffer), ctypes.byref(required)):
                raise LaunchFailure('unavailable', 'app-desktop-identity-unavailable')
            return buffer.value
        return name(user.GetProcessWindowStation()) + '\\' + name(user.GetThreadDesktop(thread_id or kernel.GetCurrentThreadId()))

    @staticmethod
    def token(pid):
        import win32api
        import win32security
        process = win32api.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        try:
            token = win32security.OpenProcessToken(process, win32security.TOKEN_QUERY)
            try:
                return (win32security.ConvertSidToStringSid(win32security.GetTokenInformation(token, win32security.TokenUser)[0]),
                        win32security.GetTokenInformation(token, win32security.TokenSessionId),
                        win32security.ConvertSidToStringSid(win32security.GetTokenInformation(token, win32security.TokenIntegrityLevel)[0]))
            finally:
                token.Close()
        finally:
            process.Close()

    def context(self):
        from desktop_readiness import probe
        if not probe()['ready_for_input']:
            raise LaunchFailure('unavailable', 'app-desktop-not-ready')
        _, session, _ = self.token(os.getpid())
        return {'scope': self.scope(), 'sessionId': self.session, 'instanceId': self.instance,
                'windowsSessionId': session, 'desktop': self.desktop_name()}

    def reserve_context(self):
        self.original_processes.retire_all()
        self.original_processes.assert_available()
        self.session = uuid.uuid4().hex
        return self.context()

    def finish_targets(self, keep):
        if not keep:
            self.original_processes.retire_all()

    def close(self):
        self.original_processes.retire_all(close=True)

    def resolve_original_process(self, token, profile, context):
        """Private read-only process resolution; no RPC or target/input grant."""
        return self.original_processes.resolve_process(token, profile, context)

    def resolve_original_target(self, token, profile, context):
        self.resolve_original_process(token, profile, context)
        # IsWindow/owner/desktop equality cannot prove destroy/recreate continuity.
        # No original-window observer or effect Producer exists in this helper.
        raise LaunchFailure('unavailable', 'app-original-window-lifetime-and-producer-unavailable')

    def inspect(self, spec):
        definition(spec)
        path = spec['shortcutPath'] if spec['kind'] == 'shortcut' else spec['executable']
        try:
            entry = self.scanner.inspect(path, 'launch-inspection', time.monotonic() + 5)
            if spec['kind'] == 'exe':
                # argv is operator-confirmed structure, not shell parsing. Validate cwd independently.
                if 'workingDirectory' in spec:
                    self.scanner._check_file(spec['workingDirectory'], True)
                entry['launchSpec'] = copy.deepcopy(spec)
            if definition(entry['launchSpec']) != definition(spec):
                raise LaunchFailure('stale', 'app-shortcut-definition-changed')
            fingerprint = entry['contentFingerprint']
            # Binary identity is explicitly content-derived, not an asserted product name/path.
            return {'scope': self.scope(), 'launchSpec': entry['launchSpec'], 'identity': {
                'productId': 'win32-binary:' + fingerprint, 'version': entry.get('version', 'unknown'), 'fingerprint': fingerprint}}
        except PermissionError as error:
            raise LaunchFailure('stale', 'app-installation-permission-changed') from error
        except OSError as error:
            raise LaunchFailure('stale', 'app-installation-path-unavailable') from error
        except ValueError as error:
            raise LaunchFailure('stale', str(error)) from error

    def instances(self, profile, context):
        self.original_processes.assert_available()
        try:
            return self._instances(profile, context)
        except Exception:
            # A failed observation is not a gap through which an older original
            # may be revived after metadata/window facts happen to match again.
            self.original_processes.retire_all()
            raise

    def _instances(self, profile, context):
        import psutil
        import win32gui
        import win32process
        spec = profile['launchSpec']
        expected = ntpath.normcase(spec['executable'])
        processes = []
        deadline = time.monotonic() + 2
        for index, process in enumerate(psutil.process_iter(['pid', 'exe'])):
            if index >= 4096 or time.monotonic() > deadline:
                raise LaunchFailure('unavailable', 'app-process-query-limit')
            if len(processes) > 64:
                raise LaunchFailure('unavailable', 'app-instance-limit')
            if process.info['exe'] and ntpath.normcase(process.info['exe']) == expected:
                processes.append(process)
        if not processes:
            return []
        windows = []
        def collect(hwnd, _):
            thread, pid = win32process.GetWindowThreadProcessId(hwnd)
            if win32gui.IsWindowVisible(hwnd) and any(process.pid == pid for process in processes):
                windows.append((hwnd, thread, pid))
        win32gui.EnumWindows(collect, None)
        if len(windows) != 1:
            # An instance on another Desktop (or no provable window) is never treated as absent.
            raise LaunchFailure('unknown', 'app-instance-window-unproven-or-other-desktop')
        hwnd, thread, pid = windows[0]
        pin = self.process_pin_factory(pid)
        frozen_profile, frozen_context = copy.deepcopy(profile), copy.deepcopy(context)
        probe = lambda: self._target_snapshot(pin, frozen_profile, frozen_context, hwnd, thread)
        token = self.original_processes.enroll(pin, probe)
        original = self.resolve_original_process(token, frozen_profile, frozen_context)
        return [{**original['evidence'], 'targetToken': token}]

    def _target_snapshot(self, pin, profile, context, hwnd, thread):
        import psutil
        import win32gui
        import win32process
        before = pin.snapshot()
        pid, spec = before['pid'], profile['launchSpec']
        expected = ntpath.normcase(spec['executable'])
        if before['image'] != expected or self.context() != context:
            raise LaunchFailure('unknown', 'app-original-process-or-context-changed')
        # Fresh metadata reads are bracketed by the ORIGINAL process handle, so a
        # PID reuse cannot substitute a different process after the original exits.
        process = psutil.Process(pid)
        user, session, integrity = self.token(pid)
        own_user, _, own_integrity = self.token(os.getpid())
        if integrity != own_integrity or user != own_user or session != context['windowsSessionId']:
            raise LaunchFailure('stale', 'app-process-permission-changed')
        try:
            argv, working, created = process.cmdline(), process.cwd(), process.create_time()
        except (psutil.Error, OSError) as error:
            raise LaunchFailure('unknown', 'app-process-identity-unavailable') from error
        if not argv or ntpath.normcase(argv[0]) != expected or argv[1:] != spec['args']:
            raise LaunchFailure('stale', 'app-process-arguments-changed')
        if 'workingDirectory' in spec and ntpath.normcase(working) != ntpath.normcase(spec['workingDirectory']):
            raise LaunchFailure('stale', 'app-process-working-directory-changed')
        if created < os.stat(spec['executable']).st_mtime:
            raise LaunchFailure('unknown', 'app-running-image-version-unproven')
        checked = self.inspect(spec)
        desktop = self.desktop_name(thread)
        if checked['identity'] != profile['identity'] or checked['scope'] != context['scope'] or \
                definition(checked['launchSpec']) != definition(spec) or desktop != context['desktop'] or \
                not win32gui.IsWindow(hwnd) or not win32gui.IsWindowVisible(hwnd) or \
                win32process.GetWindowThreadProcessId(hwnd) != (thread, pid) or pin.snapshot() != before or self.context() != context:
            raise LaunchFailure('unknown', 'app-original-target-changed')
        result = {**context, 'windowsSessionId': session, 'desktop': desktop,
                  'identity': checked['identity'], 'executable': before['image'], 'args': argv[1:],
                  'processOwnedByInstallation': checked['identity'] == profile['identity'],
                  'windowOwnedByProcess': win32process.GetWindowThreadProcessId(hwnd) == (thread, pid),
                  'sameUser': user == own_user, 'permissionsCompatible': True}
        if 'workingDirectory' in spec:
            result['workingDirectory'] = working
        return {'profile': copy.deepcopy(profile), 'context': copy.deepcopy(context), 'process': before,
                'window': {'hwnd': hwnd, 'thread': thread}, 'evidence': result,
                'workingDirectory': ntpath.normcase(working), 'arguments': list(argv),
                'user': user, 'integrity': integrity, 'observedCreated': created}

    def start(self, profile, context):
        self.original_processes.assert_available()
        if self.dispatch_fence is None:
            raise LaunchFailure('unavailable', 'app-native-dispatch-fence-unavailable')
        # Keep revoke serialized through both actual effects, including ResumeThread.
        with self.dispatch_fence() as check:
            if not callable(check):
                raise LaunchFailure('unavailable', 'app-native-dispatch-fence-invalid')
            check()
            return self._start_fenced(profile, context, check)

    def _start_fenced(self, profile, context, check):
        import win32api
        import win32file
        import win32job
        import win32process
        spec = profile['launchSpec']
        # Deny write/delete sharing during hash/dispatch to narrow replacement races.
        image = win32file.CreateFile(spec['executable'], 0x80000000, 1, None, 3, 0, None)
        job, process, thread = None, None, None
        try:
            if self.inspect(spec)['identity'] != profile['identity'] or self.context() != context:
                raise LaunchFailure('stale', 'app-dispatch-identity-changed')
            job = win32job.CreateJobObject(None, None)
            limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
            limits['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
            startup = win32process.STARTUPINFO()
            startup.lpDesktop = context['desktop']
            check()
            process, thread, pid, _ = win32process.CreateProcess(spec['executable'], subprocess.list2cmdline([spec['executable'], *spec['args']]),
                None, None, False, win32process.CREATE_SUSPENDED, None, spec.get('workingDirectory'), startup)
            win32job.AssignProcessToJobObject(job, process)
            check()
            win32process.ResumeThread(thread)
            return {'job': job, 'process': process, 'pid': pid, 'verified': False}
        except Exception:
            if process:
                win32api.TerminateProcess(process, 1)
                process.Close()
            if job:
                job.Close()
            raise
        finally:
            if thread:
                thread.Close()
            image.Close()

    def observe(self, profile, context, owned):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                value = self.instances(profile, context)
                if value:
                    # Existing user instance may be adopted by a single-instance app, but was not owned.
                    if owned:
                        owned['verified'] = True
                    return value
            except LaunchFailure as error:
                if error.kind != 'unknown':
                    raise
            time.sleep(0.1)
        raise LaunchFailure('unknown', 'app-launch-window-timeout')

    @staticmethod
    def cleanup(owned):
        import win32event
        import win32job
        win32job.TerminateJobObject(owned['job'], 1)
        if win32event.WaitForSingleObject(owned['process'], 3000) != win32event.WAIT_OBJECT_0:
            raise LaunchFailure('unknown', 'app-owned-process-drain-unconfirmed')
        stats = win32job.QueryInformationJobObject(owned['job'], win32job.JobObjectBasicAccountingInformation)
        if stats['ActiveProcesses'] != 0:
            raise LaunchFailure('unknown', 'app-owned-job-drain-unconfirmed')
        owned['process'].Close()
        owned['job'].Close()

    @staticmethod
    def release(owned):
        if not owned['verified']:
            return WindowsNativeLauncher.cleanup(owned)
        import win32job
        # A successful application survives the validation reservation; no input authority is retained.
        limits = win32job.QueryInformationJobObject(owned['job'], win32job.JobObjectExtendedLimitInformation)
        limits['BasicLimitInformation']['LimitFlags'] &= ~win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        win32job.SetInformationJobObject(owned['job'], win32job.JobObjectExtendedLimitInformation, limits)
        owned['process'].Close()
        owned['job'].Close()


def main():
    # Host installation scope is derived by this process, not accepted from stdin.
    manager = None
    for line in sys.stdin:
        identity = None
        try:
            if len(line.encode('utf-8')) > 131072:
                raise LaunchFailure('stale', 'app-launch-request-limit')
            value = json.loads(line)
            identity = value.pop('id')
            scope = value.get('scope')
            if manager is None:
                if (not isinstance(scope, dict) or set(scope) != {'providerId', 'environmentId', 'installationScopeId'} or
                        scope['providerId'] != 'physical' or scope['environmentId'] != 'current-interactive-desktop'):
                    raise LaunchFailure('unavailable', 'physical-launch-scope-required')
                def actual_scope():
                    return {'providerId': 'physical', 'environmentId': 'current-interactive-desktop', 'installationScopeId': installation_scope_id()}
                # This standalone Physical helper has no trusted native-side policy/revoke
                # bridge. Inspection remains available; start fails closed, never trusting
                # a Host precheck or a boolean/permit embedded in stdin as a dispatch fence.
                manager = AppLaunchManager(actual_scope, WindowsNativeLauncher(actual_scope))
            result = manager.handle(value)
            reply = {'id': identity, 'result': result}
        except Exception as error:
            reply = {'id': identity, 'error': str(error) if isinstance(error, LaunchFailure) else 'app-native-launch-unavailable',
                     'kind': error.kind if isinstance(error, LaunchFailure) else 'unknown'}
        print(json.dumps(reply, ensure_ascii=False), flush=True)
    # Unverified owned Jobs remain kill-on-close; never kill pre-existing user processes.
    if manager is not None:
        manager.native.close()


if __name__ == '__main__':
    main()
