"""LIVE-01 owned Chrome capability bridge. No physical input or site HTTP API.

Only the separately launched hidden worker inspects native Chrome identity. The
bridge uses the existing D0 desktop, Job, duration and lease primitives unchanged.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from policy import Blocked, MAX_DURATION, LEASE_SECONDS
from storage import read_json, write_json


def worker(directory):
    from win32 import Api
    import psutil
    api = Api()
    config = read_json(directory / 'config.json')
    name = config['desktop']
    handle = None
    try:
        api.join_job_view(name)
        if api.name(api.u.GetThreadDesktop(api.k.GetCurrentThreadId())) != name:
            raise Blocked('worker_desktop_mismatch')
        handle, pid = api.launch([config['path'], '--user-data-dir=' + str(directory / 'profile'),
            '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', 'about:blank'], name)
        expected = {'pid': pid, 'desktop': name, 'session': api.session(pid)}
        deadline = time.monotonic() + MAX_DURATION
        target = None
        port = None
        last_request = None
        while time.monotonic() < deadline:
            control = read_json(directory / 'control.json', {})
            if control.get('stop', True) or time.monotonic() >= control.get('lease', 0):
                raise Blocked('control_lease_expired')
            if not target:
                for hwnd in api.windows(api.u.GetThreadDesktop(api.k.GetCurrentThreadId())):
                    if api.class_name(hwnd) == 'Chrome_WidgetWin_1' and api.identity(hwnd).get('pid') == pid:
                        api.guard(hwnd, expected)
                        target = hwnd
                        break
            portfile = directory / 'profile' / 'DevToolsActivePort'
            if target and portfile.exists():
                api.guard(target, expected)
                current_port = int(portfile.read_text().splitlines()[0])
                if port is not None and current_port != port:
                    raise Blocked('cdp_endpoint_replaced')
                port = current_port
                if not any(c.status == 'LISTEN' and c.laddr.ip == '127.0.0.1'
                           and c.laddr.port == port
                           for c in psutil.Process(pid).connections(kind='tcp')):
                    raise Blocked('cdp_listener_not_owned')
                write_json(directory / 'state.json', {'status': 'ready', 'port': port,
                    'heartbeat': time.monotonic(), 'hiddenWindowBound': True, 'cdpListenerOwned': True})
                request = read_json(directory / 'request.json', {})
                if request.get('id') and request['id'] != last_request:
                    last_request = request['id']
                    # Re-read at the ACK boundary: the first grant may have
                    # arrived while the native socket ownership probe ran.
                    current_control = read_json(directory / 'control.json', {})
                    granted = current_control.get('authority')
                    ok = bool(granted and request.get('authority') == granted and
                              not current_control.get('stop', True) and
                              time.monotonic() < current_control.get('lease', 0))
                    write_json(directory / 'ack.json', {'id': last_request, 'ok': ok})
            time.sleep(.05)
        raise Blocked('native_duration_budget_exhausted')
    except Exception as error:
        write_json(directory / 'state.json', {'status': 'blocked', 'reason': type(error).__name__})
    finally:
        if handle:
            api.k.CloseHandle(handle)


class Bridge:
    def __init__(self, directory, path):
        from win32 import Api
        self.api = Api()
        self.directory, self.path = directory.resolve(), path.resolve()
        self.lock = threading.RLock()
        self.job = self.desktop = self.process = None
        self.authority = None
        self.lease = 0
        self.stopped = False
        self.started = False
        self.stop_event = threading.Event()
        self.thread = None
        self.cleanup = None

    def start(self):
        if self.started or not self.path.is_file() or self.path.name.lower() != 'chrome.exe':
            raise Blocked('explicit_installed_chrome_required')
        self.started = True
        self.api.assert_default()
        self.directory.mkdir(parents=True, exist_ok=False)
        self.run_id = uuid.uuid4().hex
        self.name = 'AgentD0_' + self.run_id
        self.instance = secrets.token_hex(24)
        self.binding = {'providerId': 'windows-local-workspace', 'environmentId': 'local-workspace:chrome',
            'sessionId': self.run_id, 'instanceId': self.instance, 'inputResourceId': 'hidden-chrome:' + self.run_id}
        self.deadline = time.monotonic() + MAX_DURATION
        self.lease = time.monotonic() + LEASE_SECONDS
        self.desktop = self.api.desktop(self.name)
        self.job = self.api.job(self.name)
        write_json(self.directory / 'config.json', {'desktop': self.name, 'path': str(self.path)})
        self.control()
        self.process, _ = self.api.launch([sys.executable, __file__, '--worker', str(self.directory)], self.name, self.job)
        self.thread = threading.Thread(target=self.watch, daemon=True)
        self.thread.start()
        until = min(self.deadline, time.monotonic() + 15)
        while time.monotonic() < until:
            with self.lock:
                self.lease = min(self.deadline, time.monotonic() + LEASE_SECONDS)
                self.control()
            state = read_json(self.directory / 'state.json', {})
            if state.get('status') == 'blocked':
                raise Blocked('chrome_native_binding_failed')
            if state.get('status') == 'ready':
                self.port = state['port']
                return {'binding': self.binding, 'port': self.port, 'targetId': 'owned-chrome:' + self.run_id,
                    'hiddenWindowBound': True, 'cdpListenerOwned': True}
            time.sleep(.05)
        raise Blocked('chrome_start_timeout')

    def control(self):
        write_json(self.directory / 'control.json', {'stop': self.stopped, 'lease': self.lease,
            'authority': self.authority})

    def watch(self):
        while not self.stop_event.wait(.1):
            with self.lock:
                if time.monotonic() >= min(self.deadline, self.lease):
                    self.stop()
                    return

    def activate(self, authority):
        with self.lock:
            if self.authority or self.stopped or time.monotonic() >= self.lease:
                raise Blocked('native_grant_unavailable')
            if not isinstance(authority, dict) or any(authority.get(k) != v for k, v in self.binding.items()):
                raise Blocked('native_grant_binding_mismatch')
            if authority.get('owner', {}).get('kind') != 'agent' or not authority['owner'].get('clientId') or not authority.get('grantId') or type(authority.get('epoch')) is not int:
                raise Blocked('native_agent_grant_required')
            self.authority = authority
            self.control()
        return self.check(authority)

    def check(self, authority):
        with self.lock:
            if self.stopped or time.monotonic() >= min(self.deadline, self.lease) or not authority or authority != self.authority:
                raise Blocked('native_authority_revoked')
            identifier = secrets.token_hex(16)
            write_json(self.directory / 'request.json', {'id': identifier, 'authority': authority})
        until = min(self.deadline, self.lease, time.monotonic() + 1)
        while time.monotonic() < until:
            state = read_json(self.directory / 'state.json', {})
            if state.get('status') != 'ready' or state.get('port') != self.port or time.monotonic() - state.get('heartbeat', 0) > 2:
                raise Blocked('native_binding_stale')
            ack = read_json(self.directory / 'ack.json', {})
            if ack.get('id') == identifier:
                if not ack.get('ok'):
                    raise Blocked('native_authority_rejected')
                return {'ready': True}
            time.sleep(.01)
        raise Blocked('native_ack_timeout')

    def ping(self, authority):
        self.check(authority)
        with self.lock:
            self.lease = min(self.deadline, time.monotonic() + LEASE_SECONDS)
            self.control()
        return {'ready': True}

    def stop(self):
        with self.lock:
            if self.cleanup is not None:
                return self.cleanup
            self.stopped = True
            self.authority = None
            self.stop_event.set()
            if self.directory.exists():
                self.control()
            empty = closed = False
            if self.job:
                self.api.checked(self.api.k.TerminateJobObject(self.job, 0), 'terminate_owned_job')
                until = time.monotonic() + 5
                while self.api.job_active(self.job) and time.monotonic() < until:
                    time.sleep(.05)
                empty = self.api.job_active(self.job) == 0
            if self.process:
                self.api.k.CloseHandle(self.process)
            if self.job:
                self.api.k.CloseHandle(self.job)
            if self.desktop:
                closed = bool(self.api.u.CloseDesktop(self.desktop))
            self.cleanup = {'ownedJobEmpty': empty, 'desktopHandleClosed': closed}
            return self.cleanup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', type=Path)
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--chrome', type=Path)
    args = parser.parse_args()
    if os.name != 'nt':
        raise Blocked('windows_required')
    if args.worker:
        worker(args.worker)
        return
    if not args.directory or not args.chrome:
        parser.error('explicit directory and Chrome path required')
    bridge = Bridge(args.directory, args.chrome)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            try:
                method = request.get('method')
                authority = request.get('authority')
                if method == 'start': result = bridge.start()
                elif method == 'activate': result = bridge.activate(authority)
                elif method == 'check': result = bridge.check(authority)
                elif method == 'ping': result = bridge.ping(authority)
                elif method == 'stop': result = bridge.stop()
                else: raise Blocked('unsupported_bridge_method')
                response = {'id': request.get('id'), 'result': result}
            except Exception as error:
                response = {'id': request.get('id'), 'error': str(error) if isinstance(error, Blocked) else type(error).__name__}
            print(json.dumps(response), flush=True)
    finally:
        bridge.stop()

if __name__ == '__main__':
    main()
