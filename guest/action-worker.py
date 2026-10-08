"""Authenticated Agent Desktop HTTP worker. Only bounded desktop methods are exposed."""

import base64
import copy
import json
import uuid
import os
import socket
import subprocess
import sys
import threading
import secrets
from contextlib import contextmanager
import time
import ctypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
import pyautogui
from input_control import InputControl
from human_input import dispatch as dispatch_human
from subprocess_rpc import exchange
from file_evidence import inspect_desktop_file
from desktop_readiness import probe as probe_desktop_readiness
from app_discovery import GuestAppDiscovery
from app_launch import AppLaunchManager, WindowsNativeLauncher, LaunchFailure


ROOT = Path(__file__).resolve().parent
TOKEN = os.environ.get("AGENT_DESKTOP_TOKEN", "")
VM_ID = os.environ.get("AGENT_DESKTOP_VM_ID", "")
PORT = int(os.environ.get("AGENT_DESKTOP_WORKER_PORT", "8765"))
RPC_TIMEOUT = float(os.environ.get("AGENT_DESKTOP_RPC_TIMEOUT_SECONDS", "20"))
if not 0 < RPC_TIMEOUT <= 120:
    raise ValueError("AGENT_DESKTOP_RPC_TIMEOUT_SECONDS must be in (0, 120]")
STARTED = time.monotonic()
ARTIFACTS = ROOT / "artifacts"
ALLOWED = {"list_windows", "ensure_app", "init", "observe", "probe", "ground", "resolve_action",
           "execute", "restore", "release", "inspect_file"}
ACTIONS = {"click", "double_click", "type", "paste_text", "drag", "keypress",
           "scroll", "wait", "screenshot"}
lock = threading.RLock()
frame_lock = threading.Lock()
owner = None
sequence = 0
process = None
input_control = InputControl()
recovery_epoch = uuid.uuid4().hex
executions = {}
app_launch_manager = None


def application_discovery_port():
    # Lazily bind the actual Guest installation/user identity, independent of action ownership.
    return GuestAppDiscovery(VM_ID)


def application_discovery_state():
    try:
        port = application_discovery_port()
        return {'app_discovery': {'protocolVersion': port.protocol_version, 'scope': port.scope()}}
    except Exception:
        return {}  # Old action/control callers remain usable when discovery is unavailable.


def application_launch_port():
    global app_launch_manager
    if os.environ.get('AGENT_DESKTOP_ENABLE_APP_LAUNCH') != '1' or len(os.environ.get('AGENT_DESKTOP_APP_LAUNCH_KEY', '')) < 32:
        raise LaunchFailure('unavailable', 'guest-app-launch-disabled')
    def scope():
        return application_discovery_port().scope()
    def guard():
        # Separate window-management reservation, without granting Agent input.
        if input_control.mode != 'paused' or input_control.revoked.is_set() or owner is not None:
            raise LaunchFailure('unavailable', 'guest-app-launch-control-busy-or-stopped')
        require_desktop_ready(for_input=True)
        return (input_control.revision, recovery_epoch)
    if app_launch_manager is None:
        @contextmanager
        def dispatch_fence():
            # Same native lock as /control, recovery and the management reservation.
            # A revoke cannot be acknowledged between the check and CreateProcess/ResumeThread.
            with lock:
                port = app_launch_manager
                if port is None or port.reservation is None:
                    raise LaunchFailure('unavailable', 'app-launch-reservation-invalid')
                reservation_id = port.reservation['id']
                check = lambda: port.current(reservation_id)
                check()
                yield check
        native = WindowsNativeLauncher(scope, recovery_epoch, dispatch_fence)
        app_launch_manager = AppLaunchManager(scope, native, guard)
    return app_launch_manager


def application_launch_state():
    try:
        if os.environ.get('AGENT_DESKTOP_ENABLE_APP_LAUNCH') != '1' or len(os.environ.get('AGENT_DESKTOP_APP_LAUNCH_KEY', '')) < 32:
            return {}
        return {'app_launch': {'protocolVersion': 1, 'scope': application_discovery_port().scope()}}
    except Exception:
        return {}


def desktop_readiness():
    try:
        return probe_desktop_readiness()
    except Exception:
        # A probe failure must never become permission to input.
        return {"ready_for_observation": False, "ready_for_input": False,
                "blocked_reason": "readiness_probe_error"}


def require_desktop_ready(for_input=False):
    state = desktop_readiness()
    key = "ready_for_input" if for_input else "ready_for_observation"
    if not state[key]:
        raise ValueError("Guest desktop not ready: " + str(state["blocked_reason"]))


def release_aborted_input(method, args):
    """Best-effort cleanup when a timed-out desktop subprocess is killed mid-gesture."""
    if method != "execute" or not isinstance(args, dict):
        return
    action = args.get("action")
    if not isinstance(action, dict):
        return
    if action.get("kind") == "drag":
        try:
            pyautogui.mouseUp(button="left")
        except Exception:
            pass
    keys = []
    if action.get("kind") == "keypress":
        keys = [part.strip().lower() for part in str(action.get("keys", "")).split("+")]
    elif action.get("kind") in {"type", "paste_text"}:
        keys = ["ctrl", "a", "v"]
    for key in reversed(keys):
        try:
            pyautogui.keyUp(key)
        except Exception:
            pass


def desktop_call(method, args):
    global process, sequence, owner
    if process is None or process.poll() is not None:
        process = subprocess.Popen([sys.executable, str(ROOT / "desktop-worker.py")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                                   cwd=str(ROOT), bufsize=1,
                                   env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    sequence += 1
    try:
        line = exchange(process, json.dumps({"id": sequence, "method": method, "args": args},
                                           ensure_ascii=False), RPC_TIMEOUT)
    except Exception:
        input_control.emergency()
        try:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
        finally:
            release_aborted_input(method, args)
            for pipe in (process.stdin, process.stdout):
                pipe.close()
            process = None
            owner = None
        raise
    answer = json.loads(line)
    if answer.get("id") != sequence or answer.get("error"):
        raise RuntimeError(answer.get("error", "Guest desktop response mismatch"))
    return answer["result"]


def validate_action(action):
    if not isinstance(action, dict) or action.get("kind") not in ACTIONS:
        raise ValueError("Action kind is not allowed")
    if action["kind"] == "wait" and (not isinstance(action.get("ms"), int) or
                                     not 0 <= action["ms"] <= 10000):
        raise ValueError("Invalid wait duration")
    if action["kind"] in {"type", "paste_text"} and (not isinstance(action.get("text"), str) or
                                                      len(action["text"]) > 4096):
        raise ValueError("Text is too long")
    if action["kind"] == "keypress" and (not isinstance(action.get("keys"), str) or
                                         len(action["keys"]) > 80):
        raise ValueError("Invalid keys")


def attach_screenshot(result):
    observation = result.get("observation") if isinstance(result, dict) else None
    snapshot = observation if isinstance(observation, dict) else result
    if not isinstance(snapshot, dict) or not snapshot.get("screenshot"):
        return None
    path = Path(snapshot["screenshot"]).resolve()
    if not path.is_relative_to(ARTIFACTS.resolve()):
        raise RuntimeError("Screenshot escaped guest artifact directory")
    data = path.read_bytes()
    if len(data) > 8_000_000 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError("Invalid screenshot")
    snapshot["screenshot"] = None
    return base64.b64encode(data).decode("ascii")


class AppSetupError(RuntimeError):
    pass


def select_app_window(windows, previous, window_class, window_title):
    matches = [w for w in windows if w.get('visible') and
               (not window_class or w.get('windowClass') == window_class) and
               (not window_title or window_title in w.get('title', ''))]
    fresh = [w for w in matches if w['handle'] not in previous]
    if len(fresh) == 1:
        return fresh[0]
    foreground = [w for w in matches if w.get('foreground')]
    if len(foreground) == 1:
        return foreground[0]
    return matches[0] if len(matches) == 1 else None


def ensure_app(app_id):
    apps = json.loads((ROOT / "apps.json").read_text(encoding="utf-8"))
    if not isinstance(apps, list):
        raise ValueError("Guest app manifest is invalid")
    matches = [app for app in apps if isinstance(app, dict) and app.get("id") == app_id]
    if len(matches) != 1:
        raise ValueError("Guest app is not registered")
    app = matches[0]
    executable = Path(app.get("executable", ""))
    args = app.get("args", [])
    window_class = app.get("windowClass")
    window_title = app.get("windowTitle")
    if (not executable.is_absolute() or executable.suffix.lower() != ".exe" or
            not isinstance(args, list) or len(args) > 12 or
            any(not isinstance(arg, str) or len(arg) > 200 for arg in args) or
            not (isinstance(window_class, str) and window_class or
                 isinstance(window_title, str) and window_title)):
        raise ValueError("Guest app registration is invalid")
    if not executable.is_file():
        raise AppSetupError("Guest app executable was not found")
    previous = {w['handle'] for w in desktop_call('list_windows', {})}
    try:
        subprocess.Popen([str(executable), *args], cwd=str(ROOT), close_fds=True)
    except OSError as error:
        raise AppSetupError(f"Guest app could not be launched: {error}") from error
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        input_control.require_agent()
        window = select_app_window(desktop_call('list_windows', {}), previous, window_class, window_title)
        if window:
            # Host init/probe restores and focuses the selected identity before actions.
            return {"handle": window["handle"], "title": window["title"]}
        time.sleep(0.25)
    raise AppSetupError("应用已请求启动，但未找到唯一匹配窗口；请检查 Guest 桌面、应用注册与多个窗口后继续")


class Handler(BaseHTTPRequestHandler):
    def authenticated(self):
        if not TOKEN or self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.reply(401, {"error": "Unauthorized"})
            return False
        return True

    def reply(self, status, body, content_type="application/json"):
        data = (json.dumps(body, ensure_ascii=False).encode("utf-8")
                if content_type == "application/json" else body)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.authenticated():
            return
        if self.path == "/state":
            self.reply(200, {"vm_id": VM_ID, "host": socket.gethostname(),
                             "uptime_seconds": int(time.monotonic() - STARTED),
                             "desktop": os.environ.get("SESSIONNAME", ""), "action_rpc": True,
                             "file_rpc": True,
                             "control_rpc": True, "recovery_rpc": True,
                             "control_epoch_rpc": True, "action_id_rpc": True,
                             "recovery_epoch": recovery_epoch, "input_mode": input_control.mode,
                             **application_discovery_state(),
                             **application_launch_state(),
                             **desktop_readiness()})
        elif self.path == "/frame":
            try:
                require_desktop_ready()
                with frame_lock:
                    import io
                    output = io.BytesIO()
                    pyautogui.screenshot().save(output, format="PNG")
                    self.reply(200, output.getvalue(), "image/png")
            except Exception as error:
                self.reply(503, {"error": str(error)})
        else:
            self.reply(404, {"error": "Not found"})

    def do_POST(self):
        global owner, process, recovery_epoch
        if not self.authenticated():
            return
        if self.path not in {"/rpc", "/control", "/human-input", "/apps/query", "/apps/launch"}:
            self.reply(404, {"error": "Not found"})
            return
        if self.path == '/apps/launch':
            key = os.environ.get('AGENT_DESKTOP_APP_LAUNCH_KEY', '')
            if len(key) < 32 or not secrets.compare_digest(self.headers.get('X-Agent-Desktop-App-Launch-Key', ''), key):
                self.reply(403, {'error': 'Application management credential required'})
                return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 131072:
                raise ValueError("Request body size is invalid")
            request = json.loads(self.rfile.read(size))
            if self.path == '/apps/query':
                # No action lock, owner, lease, window, or desktop readiness/input transitions.
                self.reply(200, application_discovery_port().handle(request))
                return
            if self.path == '/apps/launch':
                # Bearer-authenticated trusted Host management only. No paths in start requests.
                with lock:
                    port = application_launch_port()
                    try:
                        result = port.handle(request)
                        self.reply(200, {'protocolVersion': 1, 'scope': port.scope(), 'result': result})
                    except LaunchFailure as error:
                        self.reply(200, {'protocolVersion': 1, 'scope': port.scope(), 'error': str(error), 'kind': error.kind})
                return
            if self.path in {"/control", "/human-input"}:
                if request.get("vmId") != VM_ID:
                    raise ValueError("VM identity is invalid")
                if self.path == "/control":
                    if request.get("mode") in {"agent", "human"}:
                        require_desktop_ready(for_input=True)
                    # Emergency revokes before waiting for an in-flight atomic gesture.
                    input_control.request(request.get("mode"), request.get("revision"))
                    if request.get("resetTask"):
                        if request.get("mode") not in {"paused", "stopped"}:
                            raise ValueError("Recovery must freeze input")
                        input_control.emergency()
                with lock:
                    if self.path == "/control":
                        result = input_control.transition(request.get("mode"), request.get("revision"))
                        if request.get("resetTask"):
                            if process:
                                if process.poll() is None:
                                    process.kill()
                                process.wait(timeout=3)
                                process.stdin.close()
                                process.stdout.close()
                            process = None
                            owner = None
                            recovery_epoch = uuid.uuid4().hex
                            executions.clear()
                        result["recovery_rpc"] = True
                    else:
                        require_desktop_ready(for_input=True)
                        input_control.require_human(request.get("lease"))
                        result = dispatch_human(request.get("event"))
                self.reply(200, {"result": result})
                return
            method = request.get("method")
            args = request.get("args", {})
            client = request.get("clientId")
            if request.get("vmId") != VM_ID or method not in ALLOWED or not isinstance(args, dict):
                raise ValueError("RPC method or VM identity is invalid")
            if not isinstance(client, str) or len(client) > 80 or not client:
                raise ValueError("RPC client identity is invalid")
            if method in {"ground", "resolve_action", "execute"}:
                validate_action(args.get("action"))
            if method == "execute" and (not isinstance(args.get("allowedProviders"), list) or
                                        len(args["allowedProviders"]) != 1 or
                                        not isinstance(args["allowedProviders"][0], str)):
                raise ValueError("One authorized action provider is required")
            if method == "execute" and (not isinstance(args.get("actionId"), str) or
                                        not 1 <= len(args["actionId"]) <= 128):
                raise ValueError("Action identity is required")
            with lock:
                if request.get("recoveryEpoch") != recovery_epoch:
                    raise ValueError("Worker session changed; reconnect and reobserve before RPC")
                if method not in {"release", "inspect_file"}:
                    require_desktop_ready(for_input=method in {"execute", "ensure_app", "init", "restore"} or
                                          (method == "probe" and args.get("focus")))
                if method in {"execute", "ensure_app", "init", "restore"} or (
                        method == "probe" and args.get("focus")):
                    epoch = request.get("controlEpoch")
                    if (not isinstance(epoch, int) or isinstance(epoch, bool) or
                            epoch != input_control.revision):
                        raise ValueError("Stale agent control epoch")
                    input_control.require_agent()
                if owner and owner != client:
                    self.reply(409, {"error": "Guest desktop is bound by another task"})
                    return
                if method == "release":
                    if process and process.poll() is None:
                        desktop_call("close", {})
                    process = None
                    owner = None
                    result = {"released": True}
                elif method == "list_windows":
                    result = desktop_call(method, args)
                elif method == "ensure_app":
                    result = ensure_app(args.get("appId"))
                elif method == "init":
                    if not (args.get("windowTitle") or args.get("windowHandle") or
                            (args.get("windowClass") and args.get("processPath"))):
                        raise ValueError("Window identity is required")
                    ARTIFACTS.mkdir(exist_ok=True)
                    result = desktop_call(method, {**args, "artifactDir": str(ARTIFACTS)})
                    executions.clear()
                    owner = client
                elif method == "inspect_file":
                    # A read-only file probe may run while no desktop task owns the worker.
                    # The owner check above still rejects probes from another active task.
                    result = inspect_desktop_file(args.get("path"))
                else:
                    if owner != client:
                        raise ValueError("Bind a guest window first")
                    if method == "execute":
                        action_id = args["actionId"]
                        fingerprint = json.dumps({"action": args["action"],
                                                  "allowedProviders": args["allowedProviders"]},
                                                 sort_keys=True, ensure_ascii=False)
                        previous = executions.get(action_id)
                        if previous:
                            if previous["fingerprint"] != fingerprint:
                                raise ValueError("Action identity reused with different input")
                            if previous["state"] != "complete":
                                raise ValueError("Action outcome uncertain; reobserve before retry")
                            result = copy.deepcopy(previous["result"])
                            result["duplicate"] = True
                        else:
                            if len(executions) >= 1024:
                                raise ValueError("Action journal full; reset task before more input")
                            executions[action_id] = {"state": "pending", "fingerprint": fingerprint}
                            result = desktop_call(method, args)
                        # Every dispatched action returns a fresh observation when possible.
                        if not previous:
                            try:
                                result["observation"] = desktop_call("observe", {"screenCapture": True})
                            except Exception as error:
                                result["observationError"] = str(error)
                            if result.get("effect") == "none":
                                executions.pop(action_id, None)
                            else:
                                executions[action_id] = {"state": "complete", "fingerprint": fingerprint,
                                                         "result": copy.deepcopy(result)}
                    else:
                        result = desktop_call(method, args)
                screenshot = attach_screenshot(result)
                self.reply(200, {"result": result,
                                 **({"screenshotBase64": screenshot} if screenshot else {})})
        except AppSetupError as error:
            self.reply(422, {"error": str(error), "code": "APP_SETUP_FAILED"})
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.reply(400, {"error": str(error)})
        except Exception as error:
            self.reply(503, {"error": str(error)})

    def log_message(self, format, *args):
        print(format % args, flush=True)


if __name__ == "__main__":
    if not TOKEN or not VM_ID:
        raise SystemExit("Set AGENT_DESKTOP_TOKEN and AGENT_DESKTOP_VM_ID")
    pyautogui.FAILSAFE = True
    print(f"Agent Desktop Worker {VM_ID} listening on 0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
