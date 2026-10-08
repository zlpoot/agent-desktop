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
from policy import Blocked, validate_human_event
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
        self.control_lock = threading.RLock()
        self.grant = None
        self.grant_epoch = 0
        self.d0_epoch = None
        self.retired_grants = set()
        self.control_token = None
        self.observation = None
        self.bound_session = None
        self._prebinding_controller = None
        self._prebinding_observed = self._prebinding_changed = False

    def original_issuer_prebinding_facts(self):
        """Private read-only topology report; never runs start/attach/identity_facts.

        This bridge owns an independently launched D0 controller/OS worker. Its
        metadata cannot certify the P7 issuer's process, Job or HWND continuity.
        No stdio method exposes this report or accepts a prebinding handle.
        """
        with self.control_lock:
            if self._prebinding_observed and self.controller is not self._prebinding_controller:
                self._prebinding_changed = True
            if self._prebinding_changed:
                raise Blocked('workspace_prebinding_controller_changed')
            self._prebinding_controller, self._prebinding_observed = self.controller, True
            return {'version': 'p8-b-d0-topology-v1', 'incarnation': self.backend_nonce,
                    'topology': 'independent-d0-launch', 'sameIssuer': False,
                    'run': self.run_id, 'backendInstance': self.backend_instance_id,
                    'windowsSession': self.windows_session_id, 'target': self.target_id,
                    'stale': self.stale}

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

    def assert_grant(self, authority, epoch=None, owner=None):
        if not self.grant or authority != self.grant:
            raise Blocked("workspace_grant_revoked")
        state = self.controller.snapshot()
        if state.get("epoch") != self.d0_epoch or epoch is not None and (type(epoch) is not int or epoch != self.d0_epoch):
            raise Blocked("input_epoch_revoked")
        self.controller.ready_epoch(self.run_id, self.d0_epoch, self.grant["owner"]["kind"])
        if owner is not None and self.grant["owner"]["kind"] != owner:
            raise Blocked("workspace_grant_owner_mismatch")
        return state

    def viewer_grant(self, run_id, epoch, control_token, owner=None):
        self.check_identity(self.backend_instance_id)
        if run_id != self.run_id or type(epoch) is not int or not self.control_token or control_token != self.control_token:
            raise Blocked("stale_viewer_grant")
        self.assert_grant(self.grant, epoch, owner)
        return dict(self.grant)

    def viewer_status(self):
        self.check_identity(self.backend_instance_id)
        with self.control_lock:
            return {**self.public_state(), "provider_managed": True, "control_token": self.control_token}

    def viewer_frame(self):
        self.check_identity(self.backend_instance_id)
        return self.controller.frame_packet()

    def viewer_transfer(self, run_id, epoch, owner, control_token):
        self.check_identity(self.backend_instance_id)
        with self.control_lock:
            authority = self.viewer_grant(run_id, epoch, control_token)
        result = self.request_host("viewer_transfer", run_id=run_id, epoch=epoch, owner=owner, authority=authority)
        if not isinstance(result, dict) or result.get("owner") != owner or not result.get("control_ready"):
            raise Blocked("provider_transfer_ack_unconfirmed")
        return self.viewer_status()

    def viewer_heartbeat(self, run_id, epoch, control_token):
        with self.control_lock:
            authority = self.viewer_grant(run_id, epoch, control_token, "human")
        result = self.request_host("viewer_heartbeat", run_id=run_id, owner="human", epoch=epoch, authority=authority)
        with self.control_lock:
            self.viewer_grant(run_id, epoch, control_token, "human")
            if result is not True: raise Blocked("provider_input_authority_unconfirmed")
            self.controller.ping()
        return True

    def viewer_input(self, run_id, epoch, event, control_token):
        validate_human_event(event)  # No browser-supplied role/mechanism is accepted.
        with self.control_lock:
            authority = self.viewer_grant(run_id, epoch, control_token, "human")
        context = self.controller.viewer_context(run_id, epoch, event)
        result = self.request_host("viewer_input_authority", run_id=run_id, epoch=epoch, owner="human",
                                   authority=authority, context=context, targetId=self.current_target_id())
        with self.control_lock:
            self.viewer_grant(run_id, epoch, control_token, "human")
            if result is not True: raise Blocked("provider_input_authority_unconfirmed")
            self.controller.receive_input(run_id, epoch, event, context=context)
            return self.viewer_status()

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
                                              human_handler=self.viewer_input, managed=True,
                                              status_handler=self.viewer_status, frame_handler=self.viewer_frame)
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
                   "input_class", "uia_elements", "input_ready", "script_started", "human_remaining",
                   "netease_available", "resume_observation", "resume_observation_pending")
        return {key: value[key] for key in allowed if key in value}

    def state(self, _args):
        if not self.controller:
            raise Blocked("workspace_not_started")
        return {"state": self.public_state(), "targetId": self.current_target_id(),
                "windowsSessionId": self.windows_session_id, "backendInstanceId": self.backend_instance_id}

    def wait_epoch(self, owner, epoch):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            state = self.controller.snapshot()
            if state.get("status") != "ready":
                break
            if state.get("owner") == owner and state.get("epoch") == epoch and state.get("control_ready"):
                return self.public_state(state)
            time.sleep(0.05)
        raise Blocked("workspace_transfer_ack_timeout")

    def activate_grant(self, args):
        authority = args.get("authority")
        if args.get("run_id") != self.run_id or not isinstance(authority, dict):
            raise Blocked("invalid_workspace_grant")
        required = ("providerId", "environmentId", "sessionId", "instanceId", "inputResourceId", "grantId")
        owner = authority.get("owner", {})
        if (any(not isinstance(authority.get(key), str) or not authority[key] for key in required) or
                authority["instanceId"] != self.backend_instance_id or authority["providerId"] != "windows-local-workspace" or
                authority["environmentId"] != "local-workspace:" + self.controller.record["app"] or
                type(authority.get("epoch")) is not int or authority["epoch"] <= self.grant_epoch or
                not isinstance(owner, dict) or owner.get("kind") not in ("agent", "human") or
                not isinstance(owner.get("clientId"), str) or not owner["clientId"].strip()):
            raise Blocked("invalid_workspace_grant")
        session = tuple(authority[key] for key in required[:5])
        with self.control_lock:
            if self.grant or authority["grantId"] in self.retired_grants or len(self.retired_grants) >= 128:
                raise Blocked("workspace_grant_not_drained")
            if self.bound_session is not None and session != self.bound_session:
                raise Blocked("workspace_session_mismatch")
            self.bound_session = session
            self.grant_epoch = authority["epoch"]
            self.retired_grants.add(authority["grantId"])  # Failed activation cannot be retried.
            self.observation = None
            state = self.controller.managed_generation(self.run_id, self.controller.epoch, owner["kind"])
            result = self.wait_epoch(owner["kind"], state["epoch"])
            self.grant = json.loads(json.dumps(authority))
            self.d0_epoch = state["epoch"]
            self.control_token = uuid.uuid4().hex
            return result

    def revoke_grant(self, args):
        with self.control_lock:
            if args.get("run_id") != self.run_id:
                raise Blocked("stale_workspace")
            if not self.grant or args.get("authority") != self.grant:
                raise Blocked("workspace_grant_revoked")
            self.grant = self.control_token = self.observation = None
            state = self.controller.managed_generation(self.run_id, self.controller.epoch, "none")
            return self.wait_epoch("none", state["epoch"])

    def frame(self, args):
        with self.control_lock:
            return self.granted_frame(args)

    def granted_frame(self, args):
        self.assert_grant(args.get("authority"), owner="agent")
        if not self.controller or self.controller.record.get("status") != "ready":
            raise Blocked("workspace_not_ready")
        image, metadata = self.controller.frame_packet()
        if not image or len(image) > 16 * 1024 * 1024:
            raise Blocked("workspace_frame_unavailable")
        expires = metadata.get("heartbeat", 0) + 2
        if not 0 < expires - time.monotonic() <= 2:
            raise Blocked("workspace_frame_stale")
        if type(metadata.get("sequence")) is not int or metadata["sequence"] < 1 or metadata.get("error"):
            raise Blocked("workspace_frame_invalid")
        uia = []
        if self.controller.record.get("app") == "netease":
            path = self.controller.run_directory / "uia.json"
            if path.stat().st_size > 1024 * 1024:
                raise Blocked("workspace_uia_budget_exhausted")
            uia = read_json(path, [])
            if not isinstance(uia, list) or not uia or len(uia) > 1000:
                raise Blocked("workspace_uia_invalid")
        token = uuid.uuid4().hex
        self.observation = {"token": token, "instance": self.backend_instance_id, "target": self.current_target_id(),
                            "run": self.run_id, "grant": self.grant, "epoch": self.controller.epoch,
                            "sequence": metadata.get("sequence"), "expires": expires}
        return {"png": base64.b64encode(image).decode("ascii"), "metadata": metadata, "uia": uia,
                "observationToken": token, "validForMs": max(0, (expires - time.monotonic()) * 1000)}

    def act(self, args):
        if not self.controller or args.get("run_id") != self.run_id or type(args.get("epoch")) is not int:
            raise Blocked("stale_workspace")
        with self.control_lock:
            state = self.assert_grant(args.get("authority"), args.get("epoch"), "agent")
            observed = self.observation
            image, metadata = self.controller.frame_packet()
            if (not observed or args.get("observationToken") != observed["token"] or
                    observed["instance"] != self.backend_instance_id or observed["target"] != self.current_target_id() or
                    observed["run"] != self.run_id or observed["grant"] != self.grant or observed["epoch"] != state["epoch"] or
                    time.monotonic() >= observed["expires"] or not image or metadata.get("error") or
                    type(metadata.get("sequence")) is not int or metadata["sequence"] < observed["sequence"] or
                    not 0 <= time.monotonic() - metadata.get("heartbeat", 0) < 2):
                raise Blocked("workspace_observation_revoked_or_expired")
            self.observation = None
            return self.public_state(self.controller.act(self.run_id, state["epoch"], observation_deadline=observed["expires"]))

    def ping(self, args):
        if not self.controller:
            raise Blocked("workspace_not_started")
        with self.control_lock:
            self.assert_grant(args.get("authority"), owner="agent")
            return self.public_state(self.controller.ping())

    def stop(self, _args):
        with self.control_lock:
            self.grant = self.control_token = self.observation = None
        if not self.controller:
            return {"status": "stopped", "cleanup": {"status": "PASS", "job_active": 0, "desktop_absent": True}}
        return self.public_state(self.controller.stop("provider_session_closed"))

    def close(self):
        failures = []
        result = None
        try:
            result = self.stop({})
            cleanup = (result or {}).get("cleanup", {})
            if cleanup.get("status") != "PASS" or cleanup.get("job_active") != 0 or cleanup.get("desktop_absent") is not True:
                failures.append("native_cleanup_unconfirmed")
        except Exception:
            failures.append("stop_failed")
        if self.server:
            for stage in (self.server.shutdown, self.server.server_close):
                try: stage()
                except Exception: failures.append("viewer_close_failed")
        if self.server_thread:
            try:
                self.server_thread.join(2)
                if self.server_thread.is_alive(): failures.append("viewer_thread_remains")
            except Exception: failures.append("viewer_join_failed")
        if self.controller:
            try: self.controller.close()
            except Exception: failures.append("controller_close_failed")
        if failures: raise Blocked("workspace_close_unconfirmed:" + ",".join(failures))
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
            if method in ("state", "activate_grant", "revoke_grant", "frame", "act", "ping"):
                self.check_identity(message.get("identity"))
            if method == "start": result = self.start(args)
            elif method == "state": result = self.state(args)
            elif method == "activate_grant": result = self.activate_grant(args)
            elif method == "revoke_grant": result = self.revoke_grant(args)
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
