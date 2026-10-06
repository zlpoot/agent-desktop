"""P4 bridge backend gates with synthetic state only; no native Desktop is started."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spikes/local-workspace"))
from host import Controller, make_server
from provider_worker import ProviderWorker
from policy import Blocked


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

    def dispatch_act(self, identity="fixed-instance", epoch=1):
        self.worker.dispatch({"id": 1, "method": "act", "identity": identity,
                              "args": {"run_id": "run", "epoch": epoch}})
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
        for callback, args in ((self.worker.viewer_input, ("run", 1)),
                               (self.worker.viewer_heartbeat, ("run", "human", 1)),
                               (self.worker.viewer_transfer, ("run", 1, "human"))):
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
            self.worker.frame({})

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
                result = post("/human", {"run_id": run, "epoch": 2, "event": {"kind": "char", "value": "X"}})
                self.assertEqual(result[0], 409)
                self.assertEqual(controller.human_count, 0)
            finally:
                server.shutdown(); server.server_close(); thread.join(2); controller.close()


if __name__ == "__main__":
    unittest.main()
