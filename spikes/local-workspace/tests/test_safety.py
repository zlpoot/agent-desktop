import ast
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from host import Controller, make_server
from policy import Blocked, png_rgb, validate_command, validate_target
from storage import write_json
from monitor import Monitor


class SafetyTests(unittest.TestCase):
    def monitor_api(self, desktop="Default", cursor_ok=True):
        api = Mock()
        api.assert_default = Mock()
        api.name.return_value = desktop
        api.u.SetWinEventHook.return_value = 1
        api.u.PeekMessageW.return_value = 0
        api.u.GetCursorPos.return_value = cursor_ok
        def checked(value, label):
            if not value:
                raise OSError(5, label)
            return value
        api.checked.side_effect = checked
        return api

    def test_monitor_rejects_inherited_nondefault_thread_before_hook_or_cursor(self):
        api = self.monitor_api(desktop="isolated-launcher-desktop")
        # The active input desktop check succeeds, but is insufficient.
        with patch("monitor.Api", return_value=api):
            observer = Monitor()
            try:
                with self.assertRaisesRegex(RuntimeError, "default_monitor_unavailable"):
                    observer.start()
            finally:
                result = observer.close()
        self.assertEqual(result["error"], "monitor_thread_not_default")
        self.assertEqual(result["samples"], 0)
        api.assert_default.assert_called_once()
        api.u.SetWinEventHook.assert_not_called()
        api.u.GetCursorPos.assert_not_called()
        api.u.SetThreadDesktop.assert_not_called()

    def test_monitor_default_thread_still_requires_cursor_access_and_unhooks(self):
        api = self.monitor_api(cursor_ok=False)
        with patch("monitor.Api", return_value=api):
            observer = Monitor()
            try:
                with self.assertRaisesRegex(RuntimeError, "default_monitor_unavailable"):
                    observer.start()
            finally:
                result = observer.close()
        self.assertEqual(result["error"], "[Errno 5] read_cursor")
        self.assertEqual(result["samples"], 0)
        api.u.UnhookWinEvent.assert_called_once_with(1)

    def test_monitor_default_thread_requires_successful_sample_before_ready(self):
        api = self.monitor_api()
        with patch("monitor.Api", return_value=api):
            observer = Monitor()
            try:
                observer.start()
                self.assertTrue(observer.ready.is_set())
            finally:
                result = observer.close()
        self.assertNotIn("error", result)
        self.assertGreaterEqual(result["samples"], 1)
        self.assertEqual(result["input_desktop"], "Default")
        api.u.UnhookWinEvent.assert_called_once_with(1)

    def test_target_rejects_wrong_pid_desktop_session_and_unowned_process(self):
        expected = {"pid": 7, "desktop": "AgentD0_test", "session": 1}
        good = {**expected, "alive": True, "in_job": True}
        validate_target(good, expected)
        for delta in ({"pid": 8}, {"desktop": "Default"}, {"session": 0}, {"in_job": False}, {"alive": False}):
            with self.subTest(delta=delta), self.assertRaises(Blocked):
                validate_target({**good, **delta}, expected)
        with self.assertRaises(Blocked):
            validate_target({**good, "desktop": "Default"}, {**expected, "desktop": "Default"})

    def test_command_rejects_stale_run_expired_lease_stop_and_arbitrary_input(self):
        good = {"run_id": "r", "action": "script", "expires": 12}
        validate_command(good, "r", 10, 11, False)
        for command, now, lease, stopped in (({**good, "run_id": "old"}, 10, 11, False),
                                            ({**good, "action": "keyboard"}, 10, 11, False),
                                            (good, 11, 11, False), (good, 12, 15, False), (good, 10, 11, True)):
            with self.subTest(command=command, stopped=stopped), self.assertRaises(Blocked):
                validate_command(command, "r", now, lease, stopped)

    def test_spike_has_no_system_input_or_activation_calls_and_no_guest_imports(self):
        forbidden = {"SwitchDesktop", "SendInput", "mouse_event", "keybd_event", "SetCursorPos",
                     "SetForegroundWindow", "AttachThreadInput", "SetActiveWindow", "SetFocus",
                     "pyautogui", "pywinauto", "human_input", "action_worker"}
        for path in HERE.glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Attribute):
                    self.assertNotIn(node.attr, forbidden, str(path))
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    self.assertNotIn(node.value, forbidden, str(path))
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    modules = [n.name for n in node.names] if isinstance(node, ast.Import) else [node.module or ""]
                    for module in modules:
                        self.assertFalse(module.startswith("guest") or module in forbidden)

    def test_png_encoder_rejects_unbounded_or_inconsistent_geometry(self):
        self.assertTrue(png_rgb(2, 1, b"\0\0\0\xff\xff\xff").startswith(b"\x89PNG"))
        for args in ((0, 1, b""), (4096, 1, b""), (2, 2, b"123")):
            with self.assertRaises(ValueError):
                png_rgb(*args)

    def test_fake_never_loads_win32_and_rejects_repeat_or_stale_actions(self):
        with tempfile.TemporaryDirectory() as directory, patch("ctypes.WinDLL", side_effect=AssertionError("Win32 loaded")):
            controller = Controller(directory)
            try:
                state = controller.start("fixture")
                old = state["run_id"]
                controller.act(old)
                with self.assertRaises(Blocked): controller.act(old)
                controller.stop()
                new = controller.start("fixture")
                self.assertNotEqual(old, new["run_id"])
                with self.assertRaises(Blocked): controller.act(old)
                self.assertEqual(controller.snapshot()["input"], "NOT_RUN")
                self.assertEqual(controller.snapshot()["human_parallel_input"], "NOT_RUN")
            finally: controller.close()

    def test_lease_and_budget_expiration_stop_without_a_client(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(directory)
            try:
                for expiry, reason in (("lease", "viewer_disconnected_or_lease_expired"),
                                       ("deadline", "duration_budget_exhausted")):
                    controller.start("fixture")
                    setattr(controller, expiry, time.monotonic() - 1)
                    deadline = time.monotonic() + 2
                    while controller.snapshot()["status"] != "stopped" and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertEqual(controller.snapshot()["stop_reason"], reason)
            finally: controller.close()

    def test_real_start_failure_always_invokes_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, patch("host.notepad_preflight", side_effect=Blocked("unsafe_notepad")):
            controller = Controller(directory, real=True)
            try:
                state = controller.start("notepad")
                self.assertEqual(state["status"], "stopped")
                self.assertEqual(state["reason"], "unsafe_notepad")
                self.assertEqual(state["cleanup"]["status"], "PASS")
                self.assertIsNone(controller.api)
            finally: controller.close()

    def test_partial_launch_failure_terminates_only_the_owned_job_and_closes_desktop(self):
        api = Mock()
        api.assert_default = Mock()
        api.name.return_value = "WinSta0"
        api.desktop.return_value = 10
        api.job.return_value = 20
        api.launch.side_effect = RuntimeError("launch_failed")
        api.job_active.return_value = 0
        api.u.CloseDesktop.return_value = True
        api.u.OpenDesktopW.return_value = None
        monitor = Mock()
        monitor.close.return_value = {"human_parallel_input": "NOT_RUN"}
        with tempfile.TemporaryDirectory() as directory, patch("win32.Api", return_value=api), patch("monitor.Monitor", return_value=monitor):
            controller = Controller(directory, real=True)
            try:
                state = controller.start("fixture")
                self.assertEqual(state["status"], "stopped")
                self.assertEqual(state["cleanup"]["status"], "PASS")
                api.k.TerminateJobObject.assert_called_once_with(20, 0)
                api.u.CloseDesktop.assert_called_once_with(10)
                self.assertIsNone(controller.api)
                self.assertIsNone(controller.job)
            finally: controller.close()

    def test_monitor_failure_prevents_desktop_creation(self):
        api, monitor = Mock(), Mock()
        api.assert_default = Mock()
        api.name.return_value = "WinSta0"
        monitor.start.side_effect = RuntimeError("cursor_read_denied")
        monitor.close.return_value = {"error": "cursor_read_denied"}
        with tempfile.TemporaryDirectory() as directory, patch("win32.Api", return_value=api), patch("monitor.Monitor", return_value=monitor):
            controller = Controller(directory, real=True)
            try:
                state = controller.start("fixture")
                self.assertEqual(state["status"], "stopped")
                api.desktop.assert_not_called()
                api.launch.assert_not_called()
            finally: controller.close()

    def test_frozen_capture_is_not_kept_alive_by_fresh_worker_or_viewer_heartbeat(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(directory)
            try:
                controller.start("fixture")
                with controller.lock:
                    controller.real = True
                    write_json(controller.run_directory / "worker.json", {"status": "ready", "heartbeat": time.monotonic()})
                    write_json(controller.run_directory / "frame.json", {"sequence": 9, "heartbeat": time.monotonic() - 4})
                deadline = time.monotonic() + 2
                while controller.snapshot()["status"] != "stopped" and time.monotonic() < deadline:
                    controller.ping()
                    time.sleep(0.02)
                self.assertEqual(controller.snapshot()["stop_reason"], "capture_timeout")
            finally: controller.close()

    def test_default_target_window_is_a_hard_stop_before_any_script(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(directory)
            api = Mock()
            api.default_target_count.return_value = 1
            try:
                controller.start("fixture")
                with controller.lock:
                    controller.real = True
                    controller.api = api
                    write_json(controller.run_directory / "worker.json", {"status": "ready", "owned_pid": 7, "heartbeat": time.monotonic()})
                deadline = time.monotonic() + 2
                while controller.snapshot()["status"] != "stopped" and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(controller.snapshot()["stop_reason"], "default_target_window_detected")
                self.assertFalse(controller.command_sent)
            finally: controller.close()

    def test_wall_clock_rollback_cannot_extend_duration_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(directory)
            try:
                controller.start("fixture")
                controller.deadline = time.monotonic() - 1
                with patch("host.time.time", return_value=0):
                    deadline = time.monotonic() + 2
                    while controller.snapshot()["status"] != "stopped" and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertEqual(controller.snapshot()["stop_reason"], "duration_budget_exhausted")
            finally: controller.close()

    def test_cleanup_can_close_owned_window_after_stop_but_cannot_close_foreign_window(self):
        from win32 import Api
        api = Api.__new__(Api)
        expected = {"pid": 7, "desktop": "AgentD0_test", "session": 1}
        api.assert_default = Mock()
        api.identity = Mock(return_value={**expected, "alive": True, "in_job": True})
        api.check_control = Mock(side_effect=Blocked("stopped"))
        api.u = Mock()
        api.checked = lambda value, label: value
        with self.assertRaises(Blocked): api.guard(1, expected)
        api.close_owned_window(1, expected)
        api.u.PostMessageW.assert_called_once_with(1, 0x10, 0, 0)
        api.identity.return_value = {**expected, "alive": True, "in_job": False}
        with self.assertRaises(Blocked): api.close_owned_window(2, expected)
        self.assertEqual(api.u.PostMessageW.call_count, 1)

    def test_existing_job_is_rejected_without_setting_limits_or_terminating_members(self):
        from win32 import Api
        api = Api.__new__(Api)
        api.k = Mock()
        api.k.CreateJobObjectW.return_value = 99
        api.checked = lambda value, label: value
        with patch("win32.C.get_last_error", return_value=183), self.assertRaises(Blocked):
            api.job("AgentD0_collision")
        api.k.CloseHandle.assert_called_once_with(99)
        api.k.SetInformationJobObject.assert_not_called()
        api.k.TerminateJobObject.assert_not_called()


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.controller = Controller(self.temp.name)
        self.server, self.token = make_server(self.controller)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.controller.close()
        self.thread.join(2)
        self.temp.cleanup()

    def request(self, path, body=None, **headers):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        auth = {"Authorization": "Bearer " + self.token, "Content-Type": "application/json", **headers}
        connection.request("POST" if body is not None else "GET", path, json.dumps(body) if body is not None else None, auth)
        response = connection.getresponse()
        result = (response.status, response.read())
        connection.close()
        return result

    def test_wrong_token_origin_host_and_arbitrary_fields_cannot_start_input(self):
        for headers in ({"Authorization": "Bearer wrong"}, {"Origin": "http://evil.invalid"}, {"Host": "evil.invalid"}):
            self.assertEqual(self.request("/run", {"app": "fixture"}, **headers)[0], 403)
        self.assertEqual(self.controller.snapshot()["status"], "idle")
        self.assertEqual(self.request("/run", {"app": "fixture", "text": "arbitrary"})[0], 409)
        self.assertEqual(self.request("/run", {"app": "other"})[0], 409)
        self.assertEqual(self.request("/frame", Authorization="wrong")[0], 403)

    def test_stale_stop_and_script_cannot_affect_a_new_run(self):
        old = json.loads(self.request("/run", {"app": "fixture"})[1])["run_id"]
        self.request("/stop", {"run_id": old})
        new = json.loads(self.request("/run", {"app": "fixture"})[1])["run_id"]
        self.assertEqual(self.request("/stop", {"run_id": old})[0], 409)
        self.assertEqual(self.request("/act", {"run_id": old})[0], 409)
        self.assertEqual(self.controller.snapshot()["run_id"], new)
        self.assertEqual(self.controller.snapshot()["status"], "ready")
        self.assertTrue(self.request("/frame")[1].startswith(b"\x89PNG"))

    def test_human_routes_require_nonce_origin_and_current_epoch(self):
        run = json.loads(self.request("/run", {"app": "fixture"})[1])["run_id"]
        body = {"run_id": run, "epoch": 1, "event": {"kind": "char", "value": "X"}}
        self.assertEqual(self.request("/human", body)[0], 409)
        self.assertEqual(self.request("/control", {"run_id": run, "epoch": 1, "owner": "human"})[0], 200)
        self.assertEqual(self.request("/human", body)[0], 409)
        body["epoch"] = 2
        self.assertEqual(self.request("/human", body, Authorization="wrong")[0], 403)
        self.assertEqual(self.request("/human", body, Origin="http://evil.invalid")[0], 403)
        self.assertEqual(self.request("/human", body)[0], 200)
        self.assertEqual(self.request("/act", {"run_id": run, "epoch": 1})[0], 409)


if __name__ == "__main__":
    unittest.main()
