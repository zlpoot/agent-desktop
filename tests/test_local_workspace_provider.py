"""P4 bridge backend gates with synthetic state only; no native Desktop is started."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import hashlib
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spikes/local-workspace"))
from host import Controller, make_server
from provider_worker import ProviderWorker
from policy import Blocked
from storage import read_json, write_json
from host import png_rgb
from input_engine import Inputs
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spikes/local-workspace/tests"))
from test_takeover import SyntheticApi


class BridgeIdentityTests(unittest.TestCase):
    def setUp(self):
        self.worker = ProviderWorker("synthetic-directory")
        self.worker.controller = Mock()
        self.worker.controller.snapshot.return_value = {"status": "ready", "run_id": "run", "owner": "agent", "epoch": 1}
        self.worker.controller.act.return_value = self.worker.controller.snapshot.return_value
        self.worker.run_id = "run"
        self.worker.backend_facts = {"worker": 1, "job": 2, "desktop": "AgentD0_test", "bridge": "nonce"}
        self.worker.identity_facts = Mock(return_value=dict(self.worker.backend_facts))
        self.worker.backend_instance_id = "fixed-instance"
        self.worker.emit = Mock()
        self.worker.d0_epoch = 1
        self.worker.grant = {"owner": {"kind": "agent"}, "grantId": "A"}
        self.worker.current_target_id = Mock(return_value="target")
        self.worker.observation = {"token": "observed", "instance": "fixed-instance", "target": "target",
            "run": "run", "grant": self.worker.grant, "epoch": 1, "sequence": 1, "expires": time.monotonic() + 2}
        self.worker.controller.frame_packet.return_value = (b"frame", {"sequence": 1, "heartbeat": time.monotonic()})
        def ready(run, epoch, owner):
            current = self.worker.controller.snapshot.return_value
            if run != current["run_id"] or epoch != current["epoch"] or owner != current["owner"]:
                raise Blocked("input_epoch_revoked")
        self.worker.controller.ready_epoch.side_effect = ready

    def dispatch_act(self, identity="fixed-instance", epoch=1):
        self.worker.dispatch({"id": 1, "method": "act", "identity": identity,
                              "args": {"run_id": "run", "epoch": epoch, "authority": self.worker.grant, "observationToken": "observed"}})
        return self.worker.emit.call_args.args[0]

    def test_request_cannot_bypass_backend_instance_gate(self):
        self.assertEqual(self.dispatch_act("old-instance")["error"], "stale_workspace_instance")
        self.worker.controller.act.assert_not_called()
        self.assertNotIn("error", self.dispatch_act())

    def test_worker_job_desktop_or_bridge_replacement_is_terminal_even_after_restore(self):
        for key in self.worker.backend_facts:
            with self.subTest(key=key):
                self.worker.stale = False
                changed = {**self.worker.backend_facts, key: "replacement"}
                self.worker.identity_facts.return_value = changed
                self.assertEqual(self.dispatch_act()["error"], "workspace_backend_instance_changed")
                self.worker.identity_facts.return_value = dict(self.worker.backend_facts)
                self.assertEqual(self.dispatch_act()["error"], "workspace_backend_instance_changed")
        self.worker.controller.act.assert_not_called()
        self.worker.controller.stop.assert_called()

    def test_backend_rejects_old_d0_epoch_even_if_instance_is_current(self):
        self.assertEqual(self.dispatch_act(epoch=0)["error"], "input_epoch_revoked")
        self.worker.controller.act.assert_not_called()

    def test_viewer_cannot_bypass_replaced_backend_identity(self):
        self.worker.request_host = Mock(return_value=True)
        self.worker.identity_facts.return_value = {**self.worker.backend_facts, "worker": "replacement"}
        for callback, args in ((self.worker.viewer_input, ("run", 1, {"kind": "char", "value": "X"}, "control")),
                               (self.worker.viewer_heartbeat, ("run", 1, "control")),
                               (self.worker.viewer_transfer, ("run", 1, "human", "control"))):
            with self.assertRaisesRegex(Blocked, "instance_changed"):
                callback(*args)
        self.worker.request_host.assert_not_called()

    def test_observation_only_identity_check_cannot_authorize_input(self):
        self.worker.controller.snapshot.return_value["owner"] = "human"
        self.assertEqual(self.dispatch_act()["error"], "input_epoch_revoked")
        self.worker.controller.act.assert_not_called()

    def test_frame_freshness_is_checked_at_backend_clock(self):
        self.worker.controller.record = {"status": "ready", "app": "fixture"}
        self.worker.controller.frame_packet.return_value = (b"synthetic", {"heartbeat": 10})
        with patch("provider_worker.time.monotonic", return_value=13), self.assertRaisesRegex(Blocked, "frame_stale"):
            self.worker.frame({"authority": self.worker.grant})

    def test_actual_identity_checks_worker_handle_liveness_and_owned_job(self):
        worker = ProviderWorker("synthetic-directory")
        controller = worker.controller = Mock()
        controller.process, controller.job, controller.desktop = 11, 22, 33
        controller.record = {"run_id": "run"}
        controller.api.k.WaitForSingleObject.return_value = 258
        controller.api.job_active.return_value = 1
        controller.api.k.GetProcessId.return_value = 44
        controller.api.k.GetCurrentProcessId.return_value = 55
        controller.api.name.return_value = "AgentD0_test"
        controller.api.session.return_value = 7
        worker.current_target_id = Mock(return_value="target")
        facts = worker.identity_facts()
        self.assertEqual(facts["worker"], 44)
        self.assertEqual(facts["job"], 22)
        controller.api.k.WaitForSingleObject.return_value = 0
        with self.assertRaises(Blocked): worker.identity_facts()
        controller.api.k.WaitForSingleObject.return_value = 258
        controller.api.job_active.return_value = 0
        with self.assertRaises(Blocked): worker.identity_facts()

    def test_unaccepted_song_does_not_create_controller(self):
        worker = ProviderWorker("synthetic-directory")
        with patch("provider_worker.Controller") as controller, self.assertRaisesRegex(Blocked, "validated_song"):
            worker.start({"app": "netease", "netease": {"path": "synthetic", "song": "other", "artist": "孙燕姿"}})
        controller.assert_not_called()


class ManagedViewerTests(unittest.TestCase):
    def test_viewer_cannot_restart_run_or_bypass_agent_runtime_and_human_arbiter(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(directory)
            server, token = make_server(controller, managed=True, human_handler=lambda *_: False)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def post(path, body):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                connection.request("POST", path, json.dumps(body), {"Authorization": "Bearer " + token,
                                   "Content-Type": "application/json"})
                response = connection.getresponse()
                result = response.status, json.loads(response.read())
                connection.close()
                return result
            try:
                state = controller.start("fixture")
                run = state["run_id"]
                self.assertEqual(post("/run", {"app": "fixture"})[0], 409)
                self.assertEqual(post("/act", {"run_id": run, "epoch": 1})[0], 409)
                self.assertFalse(controller.command_sent)
                controller.transfer(run, 1, "human")
                result = post("/human", {"run_id": run, "epoch": 2, "event": {"kind": "char", "value": "X"}, "control_token": "synthetic"})
                self.assertEqual(result[0], 409)
                self.assertEqual(controller.human_count, 0)
            finally:
                server.shutdown(); server.server_close(); thread.join(2); controller.close()


class ProtocolRig:
    """Real bridge/controller/queue/HTTP, synthetic HWND API; never creates a Desktop."""
    def __init__(self, directory):
        self.controller = Controller(directory)
        self.controller.start("fixture")
        self.controller.closed.set(); self.controller.watchdog.join(2)
        self.controller.real = True
        self.controller.lease = self.controller.deadline = time.monotonic() + 60
        self.controller.write_control(False)
        self.api = SyntheticApi()
        self.engine = Inputs(self.api, 10, {}, [1, 2, 3], self.control, self.controller.record["run_id"], True)
        self.engine.acknowledge(self.control())
        self.directory = self.controller.run_directory
        write_json(self.directory / "target.json", {"pid": 10, "hwnd": 20, "session": 7, "desktop": "AgentD0_synthetic"})
        self.sequence = 1
        self.image = png_rgb(10, 10, b"\x25\x50\x80" * 100)
        (self.directory / "frame.png").write_bytes(self.image)
        self.lock = threading.RLock()
        self.publish()
        self.done = threading.Event(); self.errors = []
        self.thread = threading.Thread(target=self.pump, daemon=True); self.thread.start()
        self.worker = ProviderWorker(directory)
        self.worker.controller = self.controller
        self.worker.run_id = self.controller.record["run_id"]
        self.worker.backend_instance_id = "synthetic-instance"
        self.worker.windows_session_id = 7
        self.worker.backend_facts = {"synthetic": True}
        self.worker.identity_facts = lambda: {"synthetic": True}  # The only native process probe substitute.
        self.worker.emit = Mock()
        self.contexts = []; self.allow = True
        self.worker.request_host = self.host_event

    def control(self): return read_json(self.controller.run_directory / "control.json", {})
    def publish(self):
        write_json(self.directory / "worker.json", {"status": "ready", "heartbeat": time.monotonic(),
                   "input_ready": True, **self.engine.view()})
        write_json(self.directory / "frame.json", {"sequence": self.sequence, "width": 10, "height": 10,
                   "heartbeat": time.monotonic(), "sha256": hashlib.sha256(self.image).hexdigest()})
    def pump(self):
        try:
            while not self.done.wait(.005):
                with self.lock:
                    self.engine.acknowledge(self.control())
                    for path in sorted((self.directory / "commands").glob("*.json")):
                        command = read_json(path, None)
                        if command is not None: self.engine.command(command)
                        path.unlink(missing_ok=True)
                    self.publish()
        except Exception as error: self.errors.append(error)
    def wait(self, predicate):
        deadline = time.monotonic() + 2
        while not predicate():
            if self.errors: raise self.errors[0]
            if time.monotonic() >= deadline: raise AssertionError("synthetic worker timeout")
            time.sleep(.01)
    def step(self):
        with self.lock:
            self.engine.next_step = 0; self.engine.step(); self.publish()
    def authority(self, kind="agent", client="A"):
        return {"providerId": "windows-local-workspace", "environmentId": "local-workspace:fixture",
            "sessionId": "session", "instanceId": "synthetic-instance", "inputResourceId": "resource",
            "epoch": self.worker.grant_epoch + 1, "grantId": "grant-" + str(self.worker.grant_epoch + 1),
            "owner": {"kind": kind, "clientId": client}}
    def rpc(self, method, **args):
        self.worker.dispatch({"id": 1, "method": method, "identity": self.worker.backend_instance_id, "args": args})
        return self.worker.emit.call_args.args[0]
    def activate(self, authority):
        result = self.rpc("activate_grant", run_id=self.worker.run_id, authority=authority)
        if "error" in result: raise AssertionError(result)
        return result["result"]
    def transfer(self, kind="agent", client="B"):
        old = self.worker.grant
        result = self.rpc("revoke_grant", run_id=self.worker.run_id, authority=old)
        if "error" in result: raise AssertionError(result)
        assert self.controller.owner == self.engine.owner == "none"
        assert not list((self.directory / "commands").glob("*.json"))
        new = self.authority(kind, client); self.activate(new); return new
    def host_event(self, event, **fields):
        if event == "viewer_transfer":
            self.transfer(fields["owner"], "viewer-successor")
            return self.worker.public_state()
        if event == "viewer_input_authority": self.contexts.append(fields["context"])
        return self.allow
    def observe(self):
        result = self.rpc("frame", authority=self.worker.grant)
        if "error" in result: raise AssertionError(result)
        return result["result"]["observationToken"]
    def act(self, authority, epoch, token):
        return self.rpc("act", run_id=self.worker.run_id, authority=authority, epoch=epoch, observationToken=token)
    def viewer_body(self):
        state = self.worker.viewer_status()
        return {"run_id": state["run_id"], "epoch": state["epoch"], "control_token": state["control_token"]}
    def close(self):
        self.done.set(); self.thread.join(2)
        self.worker.close()
        if self.errors: raise self.errors[0]


class ProtocolRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.rig = ProtocolRig(self.temp.name)
    def tearDown(self):
        try: self.rig.close()
        finally: self.temp.cleanup()

    def test_R1_revoke_fences_input_before_waiting_for_missing_previous_worker_ack(self):
        r = self.rig; a = r.authority(); r.activate(a)
        result = []
        with r.lock:
            write_json(r.directory / "worker.json", {"status": "ready", "owner_ack": "human", "epoch_ack": 0})
            self.assertFalse(r.controller.snapshot()["control_ready"])
            thread = threading.Thread(target=lambda: result.append(r.rpc("revoke_grant", run_id=r.worker.run_id, authority=a)))
            thread.start()
            r.wait(lambda: r.control().get("owner") == "none")
            self.assertIsNone(r.worker.grant)
            self.assertEqual(r.control()["owner"], "none")
            self.assertEqual(result, [])  # Successor still awaits the neutral worker ACK.
        thread.join(3)
        self.assertNotIn("error", result[0])
        r.activate(r.authority("agent", "B"))

    def test_R1_same_agent_revoke_ack_fences_old_rpc_and_new_agent_can_continue_bounded_intent(self):
        r = self.rig; a = r.authority(); r.activate(a); old_epoch = r.controller.epoch
        token = r.observe(); self.assertNotIn("error", r.act(a, old_epoch, token))
        r.wait(lambda: r.engine.started); r.step(); self.assertEqual(len(r.api.sent), 1)
        b = r.transfer("agent", "B"); self.assertGreater(r.controller.epoch, old_epoch)
        self.assertIn("error", r.act(a, old_epoch, token))
        # Even forging the new D0 epoch with the old Host grant is denied by backend.
        self.assertIn("error", r.act(a, r.controller.epoch, r.observe()))
        self.assertIn("error", r.rpc("activate_grant", run_id=r.worker.run_id, authority=a))
        r.worker.assert_grant(b, r.controller.epoch, "agent")
        r.step(); self.assertEqual(len(r.api.sent), 2)
        self.assertEqual(r.engine.epoch, r.controller.epoch)

    def test_R1_same_human_old_token_and_old_grant_are_denied_new_human_applies_input(self):
        r = self.rig; a = r.authority("human"); r.activate(a); old = r.viewer_body()
        event = {"kind": "click", "x": 1, "y": 1, "width": 10, "height": 10, "sequence": 1}
        r.worker.viewer_input(**old, event=event); r.wait(lambda: r.engine.human_actions == 1)
        b = r.transfer("human", "B")
        with self.assertRaises(Blocked): r.worker.viewer_input(**old, event=event)
        with self.assertRaises(Blocked): r.worker.viewer_input(**{**r.viewer_body(), "epoch": None}, event=event)
        with self.assertRaises(Blocked): r.worker.assert_grant(a, r.controller.epoch, "human")
        r.worker.viewer_input(**r.viewer_body(), event=event); r.wait(lambda: r.engine.human_actions == 2)
        self.assertEqual(r.worker.grant, b)

    def test_R2_native_context_is_readonly_and_host_denial_never_enqueues_human_input(self):
        r = self.rig; r.activate(r.authority("human")); r.allow = False
        event = {"kind": "click", "x": 1, "y": 1, "width": 10, "height": 10, "sequence": 1}
        with self.assertRaises(Blocked): r.worker.viewer_input(**r.viewer_body(), event=event)
        self.assertEqual(r.engine.human_actions, 0); self.assertFalse(r.engine.selected)
        self.assertEqual(r.contexts[-1], {"capability": "input.targetedWindow", "action": "viewer-click",
            "targetRole": "fixture-editor", "mechanism": "owned-hwnd-message"})
        with self.assertRaises(Blocked): r.worker.viewer_input(**r.viewer_body(), event={**event, "action": "viewer-click"})
        r.allow = True; r.worker.viewer_input(**r.viewer_body(), event=event)
        r.wait(lambda: r.engine.selected)
        r.worker.viewer_input(**r.viewer_body(), event={"kind": "char", "value": "X"})
        r.wait(lambda: r.api.value == "X")
        self.assertEqual(r.contexts[-1]["mechanism"], "owned-hwnd-char")

    def test_R3_backend_denies_expired_replaced_instance_stale_target_and_replayed_tokens(self):
        for mutation in ("expiry", "instance", "target", "sequence", "missing"):
            with self.subTest(mutation=mutation):
                r = self.rig
                if not r.worker.grant: r.activate(r.authority())
                token = r.observe()
                if mutation == "expiry": r.worker.observation["expires"] = time.monotonic() - 1
                if mutation == "instance": r.worker.observation["instance"] = "replaced-instance"
                if mutation == "target":
                    original = read_json(r.directory / "target.json", {})
                    write_json(r.directory / "target.json", {**original, "hwnd": 21})
                if mutation == "sequence": r.worker.observation["sequence"] = 999
                result = r.act(r.worker.grant, r.controller.epoch, "missing" if mutation == "missing" else token)
                self.assertIn("error", result); self.assertFalse(r.controller.command_sent)
                if mutation == "target": write_json(r.directory / "target.json", original)
        token = r.observe(); self.assertNotIn("error", r.act(r.worker.grant, r.controller.epoch, token))
        self.assertIn("error", r.act(r.worker.grant, r.controller.epoch, token))

    def test_R3_backend_uses_capture_deadline_and_passes_it_to_native_queue(self):
        r = self.rig; r.activate(r.authority())
        with r.lock:
            metadata = read_json(r.directory / "frame.json", {})
            metadata["heartbeat"] = time.monotonic() - 1.5
            write_json(r.directory / "frame.json", metadata)
            token = r.observe(); self.assertLess(r.worker.observation["expires"] - time.monotonic(), .6)
            self.assertNotIn("error", r.act(r.worker.grant, r.controller.epoch, token))
            command = read_json(next((r.directory / "commands").glob("*.json")), {})
            self.assertAlmostEqual(command["expires"], metadata["heartbeat"] + 2)

    def test_R4_http_status_is_readonly_and_survives_resume_with_current_heartbeat_only(self):
        r = self.rig; r.activate(r.authority())
        server, token = make_server(r.controller, managed=True, transfer_handler=r.worker.viewer_transfer,
            heartbeat_handler=r.worker.viewer_heartbeat, human_handler=r.worker.viewer_input,
            status_handler=r.worker.viewer_status, frame_handler=r.worker.viewer_frame)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def request(path, body=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.request("GET" if body is None else "POST", path, None if body is None else json.dumps(body),
                {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            response = connection.getresponse(); raw = response.read()
            result = response.status, json.loads(raw) if response.getheader("Content-Type") == "application/json" else raw
            connection.close(); return result
        try:
            deadline = r.controller.lease
            self.assertEqual(request("/status")[0], 200); self.assertEqual(r.controller.lease, deadline)
            self.assertEqual(request("/heartbeat", r.viewer_body())[0], 409)
            status, human = request("/control", {**r.viewer_body(), "owner": "human"}); self.assertEqual(status, 200)
            old = r.viewer_body(); self.assertEqual(request("/status")[0], 200)
            self.assertEqual(request("/heartbeat", old)[0], 200)
            status, resumed = request("/control", {**old, "owner": "agent"}); self.assertEqual(status, 200)
            for key in ("input_ready", "owner", "epoch", "control_ready", "status", "agent_progress", "agent_total"):
                self.assertIn(key, resumed)
            self.assertTrue(resumed["input_ready"])
            self.assertEqual(request("/status")[0], 200); self.assertEqual(request("/frame")[0], 200)
            self.assertEqual(request("/heartbeat", old)[0], 409)
            self.assertEqual(request("/control", {**r.viewer_body(), "owner": "human"})[0], 200)
            r.worker.identity_facts = lambda: {"synthetic": "replacement"}
            self.assertEqual(request("/status")[0], 409)
        finally:
            server.shutdown(); server.server_close(); thread.join(2)


class CleanupRegressionTests(unittest.TestCase):
    def test_R5_all_python_close_stages_attempted_despite_stop_and_server_failures(self):
        for mode in ("stop-throws", "stop-fails", "close-fails"):
            with self.subTest(mode=mode):
                worker = ProviderWorker("synthetic")
                worker.stop = Mock(return_value={"cleanup": {"status": "FAIL" if mode == "stop-fails" else "PASS",
                    "job_active": 0, "desktop_absent": True}})
                worker.server = Mock(); worker.server_thread = Mock(); worker.controller = Mock()
                worker.server_thread.is_alive.return_value = False
                if mode == "stop-throws": worker.stop.side_effect = RuntimeError("stop failure")
                if mode == "close-fails": worker.server.shutdown.side_effect = RuntimeError("shutdown failure")
                with self.assertRaisesRegex(Blocked, "close_unconfirmed"): worker.close()
                worker.stop.assert_called_once(); worker.server.shutdown.assert_called_once()
                worker.server.server_close.assert_called_once(); worker.server_thread.join.assert_called_once()
                worker.controller.close.assert_called_once()

    def test_R5_controller_watchdog_join_runs_when_stop_throws(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(directory)
            try:
                with patch.object(controller, "stop", side_effect=RuntimeError("stop failure")), patch.object(controller.watchdog, "join") as join:
                    with self.assertRaises(RuntimeError): controller.close()
                    join.assert_called_once()
            finally: controller.watchdog.join(2)

    def test_R4_http_callback_exceptions_have_deterministic_responses(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(directory)
            def fail(*_): raise RuntimeError("private callback detail")
            server, token = make_server(controller, managed=True, status_handler=fail, frame_handler=fail, heartbeat_handler=fail)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                for path, body in (("/status", None), ("/frame", None), ("/heartbeat", {"run_id": "run", "epoch": 1, "control_token": "token"})):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                    connection.request("GET" if body is None else "POST", path, None if body is None else json.dumps(body),
                        {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 500); self.assertEqual(json.loads(response.read()), {"error": "viewer_callback_failed"})
                    connection.close()
            finally: server.shutdown(); server.server_close(); thread.join(2); controller.close()


if __name__ == "__main__":
    unittest.main()
