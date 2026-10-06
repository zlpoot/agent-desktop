"""Standalone D0 controller. --fake never loads Win32 or starts an app."""
import argparse
import hashlib
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
from policy import Blocked, HUMAN_LIMIT, LEASE_SECONDS, MAX_DURATION, TEXT, png_rgb, validate_human_event
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
    def __init__(self, directory, real=False, netease=None, expected_netease_version=None):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.real = real
        self.netease = netease
        self.expected_netease_version = expected_netease_version
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
            if app not in ("fixture", "notepad", "netease"):
                raise Blocked("unsupported_app")
            if app == "netease" and not self.netease:
                raise Blocked("netease_explicit_path_required")
            if app == "netease" and not self.real:
                raise Blocked("netease_real_opt_in_required")
            if self.record["status"] in ("starting", "ready"):
                raise Blocked("run_already_active")
            run_id = uuid.uuid4().hex
            self.run_directory = self.directory / run_id
            self.run_directory.mkdir()
            self.started = time.time()
            self.deadline = time.monotonic() + MAX_DURATION
            self.lease = time.monotonic() + LEASE_SECONDS
            self.command_sent = False
            self.owner, self.epoch, self.sequence, self.human_count = "agent", 1, 0, 0
            self.record = {"status": "starting", "app": app, "run_id": run_id,
                           "mode": "real" if self.real else "fake", "input": "NOT_RUN",
                           "started": self.started, "human_parallel_input": "NOT_RUN"}
            self.record.update(owner=self.owner, epoch=self.epoch, agent_progress=0, agent_total=len(TEXT), human_actions=0)
            (self.run_directory / "commands").mkdir()
            if not self.real:
                self.record.update(status="ready", isolation="SIMULATED")
                return self.snapshot()
            try:
                if os.name != "nt":
                    raise Blocked("windows_required")
                from win32 import Api
                from monitor import Monitor
                notepad = notepad_preflight() if app == "notepad" else None
                music = None
                if app == "netease":
                    from netease import preflight
                    music = preflight(self.netease)
                    if self.expected_netease_version and music["version"] != self.expected_netease_version:
                        raise Blocked("netease_validated_version_required")
                    self.record.update(app_version=music["version"], input_class="SEMANTIC_INPUT", stage="launch")
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
                    "netease": music,
                })
                self.write_control(False)
                worker = "netease_worker.py" if app == "netease" else "worker.py"
                self.process, _ = self.api.launch([sys.executable, HERE / worker, self.run_directory], name, self.job)
            except Exception as error:
                self.record.update(status="blocked", reason=str(error), error=type(error).__name__)
                self.stop("start_failed")
            return self.snapshot()

    def write_control(self, stop):
        if self.run_directory:
            write_json(self.run_directory / "control.json", {"stop": stop, "lease": self.lease,
                                                           "owner": self.owner, "epoch": self.epoch})

    def ready_epoch(self, run_id, epoch, owner):
        state = self.snapshot()
        if self.record["status"] != "ready" or run_id != self.record.get("run_id"):
            raise Blocked("stale_or_inactive_run")
        if type(epoch) is not int or epoch != self.epoch or owner != self.owner:
            raise Blocked("input_epoch_revoked")
        if not state.get("control_ready") or time.monotonic() >= self.lease:
            raise Blocked("handoff_not_acknowledged_or_lease_expired")

    def enqueue(self, action, **data):
        self.sequence += 1
        command = {"id": str(self.sequence), "run_id": self.record["run_id"], "owner": self.owner,
                   "epoch": self.epoch, "action": action, "expires": time.monotonic() + 2, **data}
        if self.real:
            queue = self.run_directory / "commands"
            if len(list(queue.glob("*.json"))) >= 16:
                raise Blocked("input_queue_full")
            write_json(queue / f"{self.sequence:08d}.json", command)
        return command["id"]

    def transfer(self, run_id, epoch, owner):
        with self.lock:
            if owner not in ("agent", "human"):
                raise Blocked("unsupported_owner")
            self.ready_epoch(run_id, epoch, self.owner)
            already_started = self.snapshot().get("agent_started", False)
            if self.record["app"] not in ("fixture", "netease"):
                raise Blocked("takeover_app_unsupported")
            if owner == self.owner:
                raise Blocked("owner_already_active")
            self.owner, self.epoch = owner, self.epoch + 1
            self.record.update(owner=owner, epoch=self.epoch)
            for path in (self.run_directory / "commands").glob("*.json*"):
                path.unlink(missing_ok=True)
            if self.real:
                self.write_control(False)
                # Resume also re-authorizes the single intent if takeover removed
                # its queue entry before the worker had started it. The worker
                # rejects duplicates; it never restarts an accepted script.
                if owner == "agent" and self.command_sent and not already_started:
                    self.enqueue("script")
            return self.snapshot()

    def managed_generation(self, run_id, epoch, owner):
        """Trusted Provider handoff: neutral drain and activation each fence an epoch."""
        with self.lock:
            if owner not in ("none", "agent", "human"):
                raise Blocked("unsupported_owner")
            if owner == "none":
                # Fence input even if the previous ACK or lease is unavailable.
                if (run_id != self.record.get("run_id") or type(epoch) is not int or
                        epoch != self.epoch or self.record["status"] != "ready"):
                    raise Blocked("stale_or_inactive_run")
            else:
                self.ready_epoch(run_id, epoch, self.owner)
            self.owner, self.epoch = owner, self.epoch + 1
            self.record.update(owner=owner, epoch=self.epoch)
            if self.real:
                self.write_control(False)  # Fence per-message execution before removing queued files.
            for path in (self.run_directory / "commands").glob("*.json*"):
                path.unlink(missing_ok=True)
            # A revoked, unaccepted command never gains a renewed observation
            # deadline. Only an already accepted bounded intent may resume.
            return self.snapshot()

    def viewer_context(self, run_id, epoch, event):
        """Ask the owned input worker to classify a control without emitting input."""
        with self.lock:
            self.ready_epoch(run_id, epoch, "human")
            validate_human_event(event)
            if not self.real:
                raise Blocked("native_viewer_context_required")
            identifier = self.enqueue("viewer-context", event=event)
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            with self.lock:
                self.ready_epoch(run_id, epoch, "human")
                last = self.snapshot().get("last_command", {})
                if last.get("id") == identifier:
                    if last.get("result") != "APPLIED" or not isinstance(last.get("context"), dict):
                        raise Blocked("viewer_control_not_proven")
                    return last["context"]
            time.sleep(0.01)
        raise Blocked("viewer_context_timeout")

    def receive_input(self, run_id, epoch, event, context=None):
        with self.lock:
            self.ready_epoch(run_id, epoch, "human")
            validate_human_event(event)
            if self.record["app"] not in ("fixture", "netease") or self.human_count >= HUMAN_LIMIT:
                raise Blocked("human_input_budget_or_app")
            frame = self.snapshot().get("frame", {})
            if self.real and (frame.get("error") or time.monotonic() - frame.get("heartbeat", 0) > 2):
                raise Blocked("stale_frame")
            if event["kind"] == "click":
                if (event["width"], event["height"]) != (frame.get("width"), frame.get("height")):
                    raise Blocked("stale_frame_geometry")
                if not max(0, frame.get("sequence", 0) - 10) <= event["sequence"] <= frame.get("sequence", 0):
                    raise Blocked("stale_frame_sequence")
            command_id = self.enqueue("human", event=event, **({"context": context} if context is not None else {}))
            self.human_count += 1
            if not self.real:
                self.record.update(human_actions=self.human_count, last_command={"id": command_id, "result": "SIMULATED"})
            return {**self.snapshot(), "accepted_command": command_id}

    def ping(self):
        with self.lock:
            if self.record["status"] in ("starting", "ready"):
                self.lease = min(time.monotonic() + LEASE_SECONDS, self.deadline)
                if self.real:
                    self.write_control(False)
            return self.snapshot()

    def act(self, run_id, epoch=None, observation_deadline=None):
        with self.lock:
            self.ready_epoch(run_id, self.epoch if epoch is None else epoch, "agent")
            if self.record["app"] == "netease" and not self.snapshot().get("input_ready"):
                raise Blocked("music_input_not_ready")
            if time.monotonic() >= self.lease or self.command_sent:
                raise Blocked("expired_lease_or_script_already_sent")
            if observation_deadline is not None and time.monotonic() >= observation_deadline:
                raise Blocked("workspace_observation_expired")
            self.command_sent = True
            if self.real:
                self.enqueue("script", **({"expires": observation_deadline} if observation_deadline is not None else {}))
            else:
                self.record.update(input="SIMULATED", text_verified=True, click_verified=True)
            return self.snapshot()

    def snapshot(self):
        with self.lock:
            result = dict(self.record)
            result["netease_available"] = bool(self.netease)
            if self.real and self.run_directory:
                worker = read_json(self.run_directory / "worker.json", {})
                # A late final worker write must not resurrect a stopped run.
                if self.record["status"] in ("starting", "ready"):
                    result.update(worker)
                frame = read_json(self.run_directory / "frame.json", {})
                result["frame"] = frame
            elif not self.real and self.record["status"] == "ready":
                result["frame"] = {"sequence": int((time.time() - self.started) * 5), "width": 320, "height": 160,
                                   "nonuniform": True, "simulated": True}
            if self.record["status"] in ("starting", "ready"):
                result.update(owner=self.owner, epoch=self.epoch, script_started=self.command_sent,
                              human_remaining=HUMAN_LIMIT - self.human_count)
                result["control_ready"] = (result.get("status") == "ready" and (not self.real or
                    (result.get("owner_ack") == self.owner and result.get("epoch_ack") == self.epoch)))
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

    def frame_packet(self):
        with self.lock:
            image = self.frame()
            if not image:
                return None, {}
            if not self.real:
                return image, self.snapshot()["frame"]
            metadata = read_json(self.run_directory / "frame.json", {})
            if hashlib.sha256(image).hexdigest() != metadata.get("sha256"):
                return None, {}  # Image and metadata must describe the same frame.
            return image, metadata

    def stop(self, reason="user_stop"):
        with self.lock:
            if self.record["status"] == "idle" or (self.record["status"] == "stopped" and not self.api):
                return self.snapshot()
            before = self.snapshot()
            self.record.update(before)
            self.record.update(status="stopped", stop_reason=reason, ended=time.time())
            self.owner, self.epoch = "none", self.epoch + 1
            self.record.update(owner=self.owner, epoch=self.epoch, control_ready=False)
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
                for path in (self.run_directory / "commands").glob("*.json*"):
                    path.unlink(missing_ok=True)
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
                            pids = self.api.job_pids(self.job) if self.record["app"] == "netease" else [worker["owned_pid"]]
                            count = sum(self.api.default_target_count(pid) for pid in pids)
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
        try:
            self.stop("controller_close")
        finally:
            self.watchdog.join(4)


def make_server(controller, port=0, transfer_handler=None, heartbeat_handler=None, human_handler=None,
                managed=False, status_handler=None, frame_handler=None):
    token = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(2)

        def log_message(self, *_):
            pass  # Never log URL, token or remote input.

        def response(self, status, body, kind="application/json", extra=None):
            if isinstance(body, dict):
                body = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'none'")
            for key, value in (extra or {}).items():
                self.send_header(key, str(value))
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
            else:
                try:
                    if self.path == "/status":
                        self.response(200, (status_handler or controller.snapshot)())
                    elif self.path == "/frame":
                        frame, metadata = (frame_handler or controller.frame_packet)()
                        self.response(200 if frame else 204, frame or b"", "image/png", {
                            "X-Frame-Sequence": metadata.get("sequence", 0), "X-Frame-Width": metadata.get("width", 0),
                            "X-Frame-Height": metadata.get("height", 0)})
                    else:
                        self.response(404, {"error": "unknown_route"})
                except Blocked:
                    self.response(409, {"error": "viewer_request_blocked"})
                except Exception:
                    self.response(500, {"error": "viewer_callback_failed"})

        def do_POST(self):
            if not self.authorized():
                # Drain a bounded request before closing: unread bytes can reset
                # the socket on Windows before the client receives its 403.
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if 0 < length <= 1024: self.rfile.read(length)
                except (ValueError, OSError):
                    pass
                self.response(403, {"error": "unauthorized"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024:
                    raise ValueError("bounded_json_required")
                body = json.loads(self.rfile.read(length))
                if managed and self.path in ("/run", "/act"):
                    raise Blocked("provider_runtime_required")
                if self.path == "/run" and set(body) == {"app"}:
                    result = controller.start(body["app"])
                elif self.path == "/act" and set(body) == {"run_id", "epoch"}:
                    result = controller.act(body["run_id"], body["epoch"])
                elif self.path == "/control" and set(body) == ({"run_id", "epoch", "owner", "control_token"} if managed else {"run_id", "epoch", "owner"}):
                    if managed:
                        if not transfer_handler: raise Blocked("provider_handler_required")
                        result = transfer_handler(body["run_id"], body["epoch"], body["owner"], body["control_token"])
                    else:
                        result = controller.transfer(body["run_id"], body["epoch"], body["owner"])
                elif self.path == "/heartbeat" and set(body) == ({"run_id", "epoch", "control_token"} if managed else {"run_id", "epoch"}):
                    if managed:
                        if not heartbeat_handler or not heartbeat_handler(body["run_id"], body["epoch"], body["control_token"]):
                            raise Blocked("input_authority_unconfirmed")
                        result = (status_handler or controller.snapshot)()
                    else:
                        self.controller_heartbeat(body)
                        result = controller.ping()
                elif self.path == "/human" and set(body) == ({"run_id", "epoch", "event", "control_token"} if managed else {"run_id", "epoch", "event"}):
                    if managed:
                        if not human_handler: raise Blocked("provider_handler_required")
                        result = human_handler(body["run_id"], body["epoch"], body["event"], body["control_token"])
                        if not isinstance(result, dict): raise Blocked("provider_input_authority_unconfirmed")
                    else:
                        result = controller.receive_input(body["run_id"], body["epoch"], body["event"])
                elif self.path == "/stop" and set(body) == {"run_id"}:
                    if body["run_id"] != controller.record.get("run_id"):
                        raise Blocked("stale_run")
                    result = controller.stop()
                else:
                    raise ValueError("unsupported_route_or_fields")
                self.response(200, result)
            except (Blocked, ValueError, TypeError) as error:
                self.response(409, {"error": "viewer_request_blocked" if managed else str(error)})
            except Exception:
                self.response(500, {"error": "viewer_callback_failed"})

        def controller_heartbeat(self, body):
            # Standalone D0 clients explicitly renew their current generation too.
            controller.ready_epoch(body["run_id"], body["epoch"], controller.owner)
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
    parser.add_argument("--netease-path", type=Path, default=os.environ.get("NETEASE_APP_PATH"))
    parser.add_argument("--song", default="我怀念的")
    parser.add_argument("--artist", default="孙燕姿")
    args = parser.parse_args()
    music = {"path": str(args.netease_path), "song": args.song, "artist": args.artist} if args.netease_path else None
    controller = Controller(args.artifacts, real=args.real, netease=music)
    server, token = make_server(controller, args.port)
    print(f"D0 {'REAL WINDOWS' if args.real else 'FAKE'} Viewer: http://127.0.0.1:{server.server_port}/#{token}", flush=True)
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
