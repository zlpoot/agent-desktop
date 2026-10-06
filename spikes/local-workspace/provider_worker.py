"""LocalWorkspace Provider bridge for the existing D0 controller; stdio stays local."""
import base64
import hashlib
import json
from pathlib import Path
import queue
import sys
import threading
import time
import uuid

from host import Controller, make_server
from policy import Blocked
from storage import read_json


class ProviderWorker:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.messages = queue.Queue()
        self.output = threading.Lock()
        self.pending = {}
        self.pending_lock = threading.Lock()
        self.controller = None
        self.server = self.server_thread = None
        self.token = None
        self.run_id = None
        self.target_id = None
        self.windows_session_id = None
        self.backend_nonce = uuid.uuid4().hex
        self.backend_facts = None
        self.backend_instance_id = None
        self.stale = False

    def identity_facts(self):
        controller = self.controller
        api = controller.api
        if (not api or not controller.process or not controller.job or not controller.desktop or
                api.k.WaitForSingleObject(controller.process, 0) != 258 or api.job_active(controller.job) <= 0):
            raise Blocked("workspace_backend_instance_unavailable")
        return {"bridge": self.backend_nonce, "run": controller.record.get("run_id"),
                "worker": api.k.GetProcessId(controller.process), "job": controller.job,
                "desktopHandle": controller.desktop, "desktop": api.name(controller.desktop),
                "session": api.session(api.k.GetCurrentProcessId()), "target": self.current_target_id()}

    def check_identity(self, identity):
        try:
            if self.stale or self.identity_facts() != self.backend_facts:
                self.stale = True
                raise Blocked("workspace_backend_instance_changed")
        except Exception:
            self.stale = True
            if self.controller:
                self.controller.stop("provider_backend_instance_changed")
            raise Blocked("workspace_backend_instance_changed")
        if identity != self.backend_instance_id:
            raise Blocked("stale_workspace_instance")

    def current_target_id(self):
        if not self.controller or not self.controller.run_directory:
            return None
        target = read_json(self.controller.run_directory / "target.json", {})
        identity = {key: target.get(key) for key in ("pid", "desktop", "session", "hwnd")}
        if (not isinstance(identity["pid"], int) or not isinstance(identity["hwnd"], int) or
                not isinstance(identity["session"], int) or not isinstance(identity["desktop"], str)):
            return None
        encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()

    def emit(self, value):
        with self.output:
            print(json.dumps(value, separators=(",", ":"), ensure_ascii=False), flush=True)

    def request_host(self, event, **fields):
        identity = uuid.uuid4().hex
        done, result = threading.Event(), {}
        with self.pending_lock:
            self.pending[identity] = done, result
        self.emit({"eventId": identity, "event": event, **fields})
        if not done.wait(7):
            with self.pending_lock:
                self.pending.pop(identity, None)
            raise Blocked("provider_input_authority_unconfirmed")
        if result.get("error"):
            raise Blocked("provider_input_authority_unconfirmed")
        return result.get("result")

    def viewer_transfer(self, run_id, epoch, owner):
        self.check_identity(self.backend_instance_id)
        result = self.request_host("viewer_transfer", run_id=run_id, epoch=epoch, owner=owner)
        if not isinstance(result, dict) or result.get("owner") != owner or not result.get("control_ready"):
            raise Blocked("provider_transfer_ack_unconfirmed")
        return result

    def viewer_heartbeat(self, run_id, owner, epoch):
        self.check_identity(self.backend_instance_id)
        result = self.request_host("viewer_heartbeat", run_id=run_id, owner=owner, epoch=epoch)
        return result is True

    def viewer_input(self, run_id, epoch):
        self.check_identity(self.backend_instance_id)
        return self.request_host("viewer_input_authority", run_id=run_id, epoch=epoch, owner="human") is True

    def start(self, args):
        if self.controller:
            raise Blocked("workspace_already_started")
        app, netease = args.get("app"), args.get("netease")
        if app not in ("fixture", "netease") or (app == "netease") != isinstance(netease, dict):
            raise Blocked("unsupported_workspace_configuration")
        if app == "netease" and (netease.get("song") != "我怀念的" or netease.get("artist") != "孙燕姿"):
            raise Blocked("workspace_validated_song_artist_required")
        self.controller = Controller(self.directory, real=True, netease=netease,
                                     expected_netease_version="3.1.40.205461" if app == "netease" else None)
        self.server, self.token = make_server(self.controller, transfer_handler=self.viewer_transfer,
                                              heartbeat_handler=self.viewer_heartbeat,
                                              human_handler=self.viewer_input, managed=True)
        self.server_thread = threading.Thread(target=self.server.serve_forever,
            kwargs={"poll_interval": 0.1}, daemon=True)
        self.server_thread.start()
        state = self.controller.start(app)
        self.run_id = state.get("run_id")
        if state.get("status") == "blocked":
            raise Blocked("workspace_start_blocked")
        deadline, next_ping = time.monotonic() + 40, 0.0
        while time.monotonic() < deadline:
            now = time.monotonic()
            state = self.controller.ping() if now >= next_ping else self.controller.snapshot()
            if now >= next_ping:
                next_ping = now + 0.5
            frame_state = state.get("frame", {})
            has_frame = isinstance(frame_state, dict) and frame_state.get("sequence", 0) >= 1
            uia_path = self.controller.run_directory / "uia.json"
            has_uia = True
            if app == "netease":
                has_uia = (uia_path.is_file() and uia_path.stat().st_size <= 1024 * 1024 and
                           isinstance(read_json(uia_path, None), list) and state.get("uia_elements", 0) > 0)
            if state.get("status") == "ready" and state.get("control_ready") and has_frame and has_uia:
                self.target_id = self.current_target_id()
                self.windows_session_id = self.controller.api.session(self.controller.api.k.GetCurrentProcessId())
                self.backend_facts = self.identity_facts()
                self.backend_instance_id = hashlib.sha256(json.dumps(self.backend_facts, sort_keys=True).encode()).hexdigest()
                return {"state": self.public_state(state), "viewerPort": self.server.server_port,
                        "viewerToken": self.token, "targetId": self.target_id,
                        "windowsSessionId": self.windows_session_id, "backendInstanceId": self.backend_instance_id}
            if state.get("status") in ("blocked", "stopped"):
                raise Blocked("workspace_start_blocked")
            time.sleep(0.1)
        raise Blocked("workspace_start_timeout")

    def public_state(self, state=None):
        value = state or (self.controller.snapshot() if self.controller else {})
        allowed = ("status", "app", "run_id", "mode", "owner", "epoch", "control_ready", "agent_progress",
                   "agent_total", "input", "stage", "app_version", "desktop", "stop_reason", "reason",
                   "cleanup", "track_matches", "playing", "text_length", "clicks", "human_actions",
                   "input_class", "uia_elements")
        return {key: value[key] for key in allowed if key in value}

    def state(self, _args):
        if not self.controller:
            raise Blocked("workspace_not_started")
        return {"state": self.public_state(), "targetId": self.current_target_id(),
                "windowsSessionId": self.windows_session_id, "backendInstanceId": self.backend_instance_id}

    def set_owner(self, args):
        if not self.controller or args.get("run_id") != self.run_id or args.get("owner") not in ("agent", "human"):
            raise Blocked("stale_or_unsupported_workspace_owner")
        before = self.controller.snapshot()
        owner, epoch = args["owner"], before.get("epoch")
        if before.get("status") != "ready":
            raise Blocked("workspace_not_ready")
        if before.get("owner") != owner:
            self.controller.transfer(self.run_id, epoch, owner)
            epoch += 1
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            state = self.controller.snapshot()
            if state.get("status") != "ready":
                break
            if state.get("owner") == owner and state.get("epoch") == epoch and state.get("control_ready"):
                return self.public_state(state)
            time.sleep(0.05)
        raise Blocked("workspace_transfer_ack_timeout")

    def frame(self, _args):
        if not self.controller or self.controller.record.get("status") != "ready":
            raise Blocked("workspace_not_ready")
        image, metadata = self.controller.frame_packet()
        if not image or len(image) > 16 * 1024 * 1024:
            raise Blocked("workspace_frame_unavailable")
        if time.monotonic() - metadata.get("heartbeat", 0) > 2:
            raise Blocked("workspace_frame_stale")
        uia = []
        if self.controller.record.get("app") == "netease":
            path = self.controller.run_directory / "uia.json"
            if path.stat().st_size > 1024 * 1024:
                raise Blocked("workspace_uia_budget_exhausted")
            uia = read_json(path, [])
            if not isinstance(uia, list) or not uia or len(uia) > 1000:
                raise Blocked("workspace_uia_invalid")
        return {"png": base64.b64encode(image).decode("ascii"), "metadata": metadata, "uia": uia}

    def act(self, args):
        if not self.controller or args.get("run_id") != self.run_id:
            raise Blocked("stale_workspace")
        state = self.controller.snapshot()
        if args.get("epoch") != state.get("epoch") or state.get("owner") != "agent":
            raise Blocked("input_epoch_revoked")
        return self.public_state(self.controller.act(self.run_id, state["epoch"]))

    def ping(self, _args):
        if not self.controller:
            raise Blocked("workspace_not_started")
        state = self.controller.snapshot()
        if state.get("owner") != "agent" or state.get("status") != "ready":
            raise Blocked("agent_does_not_own_workspace")
        return self.public_state(self.controller.ping())

    def stop(self, _args):
        if not self.controller:
            return {"status": "stopped", "cleanup": {"status": "PASS", "job_active": 0, "desktop_absent": True}}
        return self.public_state(self.controller.stop("provider_session_closed"))

    def close(self):
        result = self.stop({})
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.server_thread:
            self.server_thread.join(2)
        if self.controller:
            self.controller.close()
        return result

    def dispatch(self, message):
        if "eventResult" in message:
            with self.pending_lock:
                pending = self.pending.pop(message["eventResult"], None)
            if pending:
                done, result = pending
                result.update(message)
                done.set()
            return
        identity = message.get("id")
        try:
            method, args = message.get("method"), message.get("args", {})
            if method in ("state", "set_owner", "frame", "act", "ping"):
                self.check_identity(message.get("identity"))
            if method == "start": result = self.start(args)
            elif method == "state": result = self.state(args)
            elif method == "set_owner": result = self.set_owner(args)
            elif method == "frame": result = self.frame(args)
            elif method == "act": result = self.act(args)
            elif method == "ping": result = self.ping(args)
            elif method == "stop": result = self.stop(args)
            elif method == "close": result = self.close()
            else: raise Blocked("unsupported_workspace_operation")
            self.emit({"id": identity, "result": result})
        except Exception as error:
            self.emit({"id": identity, "error": str(error) if isinstance(error, Blocked) else "workspace_backend_error"})

    def run(self):
        def read_requests():
            for line in sys.stdin:
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    self.messages.put({"id": None, "method": "invalid"})
            self.messages.put(None)

        threading.Thread(target=read_requests, daemon=True).start()
        while True:
            message = self.messages.get()
            if message is None:
                self.close()
                return
            self.dispatch(message)
            if message.get("method") == "close":
                return


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    ProviderWorker(Path(parser.parse_args().directory)).run()
