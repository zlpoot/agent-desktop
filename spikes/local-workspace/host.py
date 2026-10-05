"""Standalone D0-A controller. --fake never loads Win32 or starts an app."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import uuid
from policy import Blocked, LEASE_SECONDS, MAX_DURATION, png_rgb
from storage import read_json, write_json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def notepad_preflight():
    # Packaged Notepad can restore personal tabs or redirect through a broker.
    # This first spike only launches the classic installed executable; fail closed
    # if package discovery is unavailable. No user documents or registry changes.
    command = ("$ErrorActionPreference='Stop'; @(Get-AppxPackage -Name Microsoft.WindowsNotepad).Count")
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                            capture_output=True, text=True, timeout=10,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode or not result.stdout.strip().isdigit():
        raise Blocked("notepad_package_probe_unavailable")
    if int(result.stdout.strip()) != 0:
        raise Blocked("packaged_notepad_unsupported")
    path = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "notepad.exe"
    if not path.is_file():
        raise Blocked("classic_notepad_not_installed")
    return str(path)


class Controller:
    def __init__(self, directory, real=False):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.real = real
        self.lock = threading.RLock()
        self.record = {"status": "idle", "mode": "real" if real else "fake"}
        self.api = self.job = self.desktop = self.process = self.monitor = None
        self.run_directory = None
        self.command_sent = False
        self.closed = threading.Event()
        self.watchdog = threading.Thread(target=self.watch, daemon=True)
        self.watchdog.start()

    def start(self, app):
        with self.lock:
            if app not in ("fixture", "notepad"):
                raise Blocked("unsupported_app")
            if self.record["status"] in ("starting", "ready"):
                raise Blocked("run_already_active")
            run_id = uuid.uuid4().hex
            self.run_directory = self.directory / run_id
            self.run_directory.mkdir()
            self.started = time.time()
            self.deadline = time.monotonic() + MAX_DURATION
            self.lease = time.monotonic() + LEASE_SECONDS
            self.command_sent = False
            self.record = {"status": "starting", "app": app, "run_id": run_id,
                           "mode": "real" if self.real else "fake", "input": "NOT_RUN",
                           "started": self.started, "human_parallel_input": "NOT_RUN"}
            if not self.real:
                self.record.update(status="ready", isolation="SIMULATED")
                return self.snapshot()
            try:
                if os.name != "nt":
                    raise Blocked("windows_required")
                from win32 import Api
                from monitor import Monitor
                notepad = notepad_preflight() if app == "notepad" else None
                # Package probing can take seconds. The lease starts after preflight.
                self.started = time.time()
                self.deadline = time.monotonic() + MAX_DURATION
                self.lease = time.monotonic() + LEASE_SECONDS
                self.record["started"] = self.started
                self.api = Api()
                self.api.assert_default()
                if self.api.name(self.api.u.GetProcessWindowStation()).lower() != "winsta0":
                    raise Blocked("interactive_window_station_required")
                self.monitor = Monitor()
                self.monitor.start()
                name = "AgentD0_" + run_id
                self.desktop = self.api.desktop(name)
                self.record["desktop"] = name
                self.job = self.api.job(name)
                write_json(self.run_directory / "config.json", {
                    "run_id": run_id, "app": app, "desktop": name, "notepad": notepad,
                })
                self.write_control(False)
                self.process, _ = self.api.launch([sys.executable, HERE / "worker.py", self.run_directory], name, self.job)
            except Exception as error:
                self.record.update(status="blocked", reason=str(error), error=type(error).__name__)
                self.stop("start_failed")
            return self.snapshot()

    def write_control(self, stop):
        if self.run_directory:
            write_json(self.run_directory / "control.json", {"stop": stop, "lease": self.lease})

    def ping(self):
        with self.lock:
            if self.record["status"] in ("starting", "ready"):
                self.lease = min(time.monotonic() + LEASE_SECONDS, self.deadline)
                if self.real:
                    self.write_control(False)
            return self.snapshot()

    def act(self, run_id):
        with self.lock:
            if self.record["status"] != "ready" or run_id != self.record.get("run_id"):
                raise Blocked("stale_or_inactive_run")
            if time.monotonic() >= self.lease or self.command_sent:
                raise Blocked("expired_lease_or_script_already_sent")
            self.command_sent = True
            if self.real:
                write_json(self.run_directory / "command.json", {
                    "id": uuid.uuid4().hex, "run_id": run_id, "action": "script", "expires": time.monotonic() + 2,
                })
            else:
                self.record.update(input="SIMULATED", text_verified=True, click_verified=True)
            return self.snapshot()

    def snapshot(self):
        with self.lock:
            result = dict(self.record)
            if self.real and self.run_directory:
                worker = read_json(self.run_directory / "worker.json", {})
                # A late final worker write must not resurrect a stopped run.
                if self.record["status"] in ("starting", "ready"):
                    result.update(worker)
                frame = read_json(self.run_directory / "frame.json", {})
                result["frame"] = frame
            elif not self.real and self.record["status"] == "ready":
                result["frame"] = {"sequence": int((time.time() - self.started) * 5), "nonuniform": True, "simulated": True}
            return result

    def frame(self):
        with self.lock:
            if self.record["status"] not in ("starting", "ready"):
                return None
            if not self.real:
                rgb = bytearray(b"\x25\x50\x80" * (320 * 160))
                x = int((time.time() - self.started) * 10) % 300
                for y in range(40, 120):
                    rgb[(y * 320 + x) * 3:(y * 320 + x + 20) * 3] = b"\x70\xc0\xe0" * 20
                return png_rgb(320, 160, rgb)
            try:
                return (self.run_directory / "frame.png").read_bytes()
            except (FileNotFoundError, PermissionError):
                return None

    def stop(self, reason="user_stop"):
        with self.lock:
            if self.record["status"] == "idle" or (self.record["status"] == "stopped" and not self.api):
                return self.snapshot()
            before = self.snapshot()
            self.record.update(before)
            self.record.update(status="stopped", stop_reason=reason, ended=time.time())
            cleanup = {"status": "PASS", "job_active": 0, "desktop_absent": True}
            errors = []
            if self.real:
                try:
                    self.write_control(True)
                except Exception as error:
                    errors.append("write_stop: " + str(error))
                if self.api:
                    if self.process:
                        # Allow the worker to send WM_CLOSE; unsaved synthetic text may
                        # leave an app dialog. No process outside the job is terminated.
                        self.api.k.WaitForSingleObject(self.process, 500)
                    if self.job:
                        if not self.api.k.TerminateJobObject(self.job, 0):
                            errors.append("terminate_job")
                        try:
                            deadline = time.monotonic() + 3
                            while self.api.job_active(self.job) and time.monotonic() < deadline:
                                time.sleep(0.02)
                            cleanup["job_active"] = self.api.job_active(self.job)
                            if cleanup["job_active"]:
                                errors.append("owned_processes_remain")
                        except Exception as error:
                            errors.append(str(error))
                        self.api.k.CloseHandle(self.job)
                    if self.process:
                        self.api.k.CloseHandle(self.process)
                    if self.monitor:
                        self.record["monitor"] = self.monitor.close()
                        self.monitor = None
                    if self.desktop:
                        if not self.api.u.CloseDesktop(self.desktop):
                            errors.append("close_desktop")
                        deadline = time.monotonic() + 2
                        while True:
                            existing = self.api.u.OpenDesktopW(self.record["desktop"], 0, False, 1)
                            cleanup["desktop_absent"] = not bool(existing)
                            if existing:
                                self.api.u.CloseDesktop(existing)
                            if not existing or time.monotonic() >= deadline:
                                break
                            time.sleep(0.02)
                        if existing:
                            errors.append("desktop_remains")
            else:
                cleanup["status"] = "SIMULATED"
            if self.monitor:
                self.record["monitor"] = self.monitor.close()
            if errors:
                cleanup.update(status="FAIL", errors=errors)
            self.record["cleanup"] = cleanup
            self.api = self.job = self.desktop = self.process = self.monitor = None
            if self.run_directory:
                write_json(self.run_directory / "result.json", self.record)
            return self.snapshot()

    def watch(self):
        while not self.closed.wait(0.05):
            with self.lock:
                if self.record["status"] not in ("starting", "ready"):
                    continue
                now = time.monotonic()
                state = self.snapshot()
                reason = None
                if now >= self.deadline:
                    reason = "duration_budget_exhausted"
                elif now >= self.lease:
                    reason = "viewer_disconnected_or_lease_expired"
                elif self.real:
                    worker = read_json(self.run_directory / "worker.json", {})
                    frame = state.get("frame", {})
                    if worker.get("owned_pid") and self.api:
                        try:
                            count = self.api.default_target_count(worker["owned_pid"])
                            self.record["default_target_windows"] = count
                            if count:
                                self.stop("default_target_window_detected")
                                continue
                        except Exception as error:
                            self.record["reason"] = str(error)
                            self.stop("default_window_probe_failed")
                            continue
                    if worker.get("status") in ("blocked", "stopped"):
                        reason = "worker_" + worker["status"]
                    elif now - worker.get("heartbeat", self.deadline - MAX_DURATION) > 3:
                        reason = "worker_timeout"
                    elif worker.get("status") == "ready":
                        self.record["status"] = "ready"
                        if frame.get("error"):
                            reason = "capture_error"
                        elif now - frame.get("heartbeat", worker["heartbeat"]) > 2:
                            reason = "capture_timeout"
                        elif not frame and now - (self.deadline - MAX_DURATION) > 10:
                            reason = "capture_never_ready"
                    if self.monitor and self.monitor.result.get("error"):
                        reason = "default_desktop_monitor_error"
                if reason:
                    self.stop(reason)

    def close(self):
        self.closed.set()
        self.stop("controller_close")
        self.watchdog.join(4)


def make_server(controller, port=0):
    token = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(2)

        def log_message(self, *_):
            pass  # Never log URL, token or remote input.

        def response(self, status, body, kind="application/json"):
            if isinstance(body, dict):
                body = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            host = "127.0.0.1:" + str(self.server.server_port)
            if self.headers.get("Host") != host:
                return False
            origin = self.headers.get("Origin")
            if origin is not None and origin != "http://" + host:
                return False
            supplied = self.headers.get("Authorization", "")
            return secrets.compare_digest(supplied, "Bearer " + token)

        def do_GET(self):
            assets = {"/": ("viewer.html", "text/html; charset=utf-8"),
                      "/viewer.js": ("viewer.js", "text/javascript; charset=utf-8"),
                      "/viewer.css": ("viewer.css", "text/css")}
            if self.path in assets:
                name, kind = assets[self.path]
                self.response(200, (HERE / name).read_bytes(), kind)
            elif not self.authorized():
                self.response(403, {"error": "unauthorized"})
            elif self.path == "/status":
                self.response(200, controller.ping())
            elif self.path == "/frame":
                frame = controller.frame()
                self.response(200 if frame else 204, frame or b"", "image/png")
            else:
                self.response(404, {"error": "unknown_route"})

        def do_POST(self):
            if not self.authorized():
                self.response(403, {"error": "unauthorized"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024:
                    raise ValueError("bounded_json_required")
                body = json.loads(self.rfile.read(length))
                if self.path == "/run" and set(body) == {"app"}:
                    result = controller.start(body["app"])
                elif self.path == "/act" and set(body) == {"run_id"}:
                    result = controller.act(body["run_id"])
                elif self.path == "/stop" and set(body) == {"run_id"}:
                    if body["run_id"] != controller.record.get("run_id"):
                        raise Blocked("stale_run")
                    result = controller.stop()
                else:
                    raise ValueError("unsupported_route_or_fields")
                self.response(200, result)
            except (Blocked, ValueError, TypeError) as error:
                self.response(409, {"error": str(error)})
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server, token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--fake", action="store_true")
    mode.add_argument("--real", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".artifacts" / "local-workspace")
    args = parser.parse_args()
    controller = Controller(args.artifacts, real=args.real)
    server, token = make_server(controller, args.port)
    print(f"D0-A {'REAL WINDOWS' if args.real else 'FAKE'} Viewer: http://127.0.0.1:{server.server_port}/#{token}", flush=True)
    print("No application starts until Run. Each run: 60 seconds maximum, 3 second viewer lease.", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        controller.close()


if __name__ == "__main__":
    main()
