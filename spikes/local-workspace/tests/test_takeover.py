import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host import Controller
from input_engine import Inputs
from policy import Blocked, Revoked, HUMAN_LIMIT, TEXT, TEXT_LIMIT, expected_edit, validate_epoch, validate_human_event
from storage import read_json, write_json
from win32 import Api


class SyntheticApi:
    def __init__(self):
        self.value, self.caret, self.clicks, self.sent = "", 0, 0, []
    def class_name(self, hwnd): return {1: "EDIT", 2: "BUTTON", 3: "STATIC"}[hwnd]
    def text(self, hwnd): return self.value if hwnd == 1 else "Clicks: " + str(self.clicks)
    def guard(self, *_): pass
    def input_guard(self, *_): self.check_input()
    def cancel_owned_input(self, *_): pass
    def send(self, *_): return self.caret | (self.caret << 16)
    def type_text(self, hwnd, expected, char):
        self.input_guard(hwnd, expected)
        self.value = expected_edit(self.value, self.caret, self.caret, char)
        self.caret = max(0, self.caret - 1) if char == "\b" else self.caret + 1
        self.sent.append(char)
    def click(self, hwnd, expected): self.click_at(hwnd, expected, 0, 0)
    def click_at(self, hwnd, expected, x, y):
        self.input_guard(hwnd, expected)
        if hwnd == 2: self.clicks += 1
        else: self.caret = len(self.value)
    def control_at(self, target, expected, event, controls):
        if event["x"] == 0: raise Blocked("click_outside_supported_controls")
        return (1 if event["x"] == 1 else 2), 0, 0


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.control = {"owner": "agent", "epoch": 1}
        self.api = SyntheticApi()
        self.engine = Inputs(self.api, 10, {}, [1, 2, 3], lambda: self.control, "r", True)
        self.engine.acknowledge(self.control)
        self.identifier = 0
    def command(self, action, **kwargs):
        self.identifier += 1
        return {"id": str(self.identifier), "run_id": "r", "expires": time.monotonic() + 2,
                **self.control, "action": action, **kwargs}
    def switch(self, owner):
        self.control = {"owner": owner, "epoch": self.control["epoch"] + 1}
        self.engine.acknowledge(self.control)
    def click(self, x):
        self.engine.command(self.command("human", event={"kind": "click", "x": x, "y": 1, "width": 10, "height": 10, "sequence": 1}))
    def step(self):
        self.engine.next_step = 0
        self.engine.step()

    def test_pause_mid_script_preserves_human_edit_and_resumes_without_replay(self):
        self.engine.command(self.command("script"))
        for _ in range(4): self.step()
        old = self.command("script")
        self.switch("human")
        for _ in range(5): self.step()
        self.assertEqual(self.engine.progress, 4)
        self.engine.command(old)
        self.assertEqual(self.engine.last["result"], "REJECTED")
        self.click(1)
        self.engine.command(self.command("human", event={"kind": "char", "value": "X"}))
        self.click(2)
        self.switch("agent")
        self.engine.command(self.command("script"))  # Resume duplicate cannot reset it.
        while not self.engine.done: self.step()
        self.assertEqual(self.api.value, TEXT[:4] + "X" + TEXT[4:])
        self.assertEqual(self.api.clicks, 2)
        self.assertEqual(len(self.api.sent), len(TEXT) + 1)

    def test_old_human_input_expiry_and_duplicate_do_not_apply(self):
        self.switch("human"); self.click(1)
        command = self.command("human", event={"kind": "char", "value": "X"})
        self.engine.command(command); self.engine.command(command)
        self.assertEqual(self.api.value, "X")
        stale = self.command("human", event={"kind": "char", "value": "Y"})
        self.switch("agent"); self.engine.command(stale)
        self.switch("human"); self.click(1)
        expired = self.command("human", event={"kind": "char", "value": "Z"})
        expired["expires"] = 0; self.engine.command(expired)
        self.assertEqual(self.api.value, "X")

    def test_keyboard_requires_editor_click_and_non_control_click_is_rejected(self):
        self.switch("human")
        self.engine.command(self.command("human", event={"kind": "char", "value": "X"}))
        self.assertEqual(self.api.value, "")
        self.click(0); self.assertEqual(self.engine.last["result"], "REJECTED")
        self.assertEqual(self.api.clicks, 0)
        self.click(1)
        self.engine.command(self.command("human", event={"kind": "char", "value": "X"}))
        self.engine.command(self.command("human", event={"kind": "char", "value": "\b"}))
        self.assertEqual(self.api.value, "")

    def test_worker_enforces_event_budget_independently(self):
        self.switch("human"); self.click(1)
        self.engine.human_actions = HUMAN_LIMIT
        self.engine.command(self.command("human", event={"kind": "char", "value": "X"}))
        self.assertEqual(self.engine.last["result"], "REJECTED")
        self.assertEqual(self.api.value, "")

    def test_takeover_before_script_acceptance_preserves_edit_on_explicit_resume(self):
        queued = self.command("script")
        self.switch("human"); self.engine.command(queued)
        self.assertFalse(self.engine.started)
        self.click(1)
        self.engine.command(self.command("human", event={"kind": "char", "value": "X"}))
        self.switch("agent"); self.engine.command(self.command("script"))
        while not self.engine.done: self.step()
        self.assertEqual(self.api.value, "X" + TEXT)

    def test_each_character_checks_epoch_and_stops_remaining_characters(self):
        api = Api.__new__(Api)
        sent = []
        def guard(*_):
            if sent: raise Revoked("changed")
        api.input_guard = guard
        api.send = lambda *args: sent.append(args)
        with self.assertRaises(Revoked): api.type_text(1, {}, "AB")
        self.assertEqual(len(sent), 1)

    def test_revocation_between_mouse_down_and_up_cancels_without_up_or_fallback(self):
        api = Api.__new__(Api)
        checks, sent = [], []
        def guard(*_):
            checks.append(1)
            if len(checks) == 3: raise Revoked("changed")
        api.input_guard = guard
        api.send = lambda hwnd, message, *_: sent.append(message)
        api.cancel_owned_input = Mock()
        with self.assertRaises(Revoked): api.click_at(2, {}, 10, 10)
        self.assertEqual(sent, [0x200, 0x201])
        api.cancel_owned_input.assert_called_once_with(2, {})


class TakeoverPolicyTests(unittest.TestCase):
    def test_transient_control_read_retries_without_reusing_stale_permissions(self):
        with patch("pathlib.Path.read_text", side_effect=[PermissionError(), '{"stop":true}']) as reader:
            self.assertEqual(read_json("control.json", {}), {"stop": True})
            self.assertEqual(reader.call_count, 2)
        with patch("pathlib.Path.read_text", side_effect=PermissionError()) as reader:
            self.assertEqual(read_json("control.json", {"stop": True}), {"stop": True})
            self.assertEqual(reader.call_count, 5)
    def test_ascii_backspace_selection_and_length_limits(self):
        self.assertEqual(expected_edit("abc", 1, 3, "X"), "aX")
        self.assertEqual(expected_edit("abc", 2, 2, "\b"), "ac")
        self.assertEqual(expected_edit("abc", 0, 0, "\b"), "abc")
        with self.assertRaises(Blocked): expected_edit("x" * TEXT_LIMIT, TEXT_LIMIT, TEXT_LIMIT, "X")
        for value in ("中文", "\n", "xx", "\x1b", 1):
            with self.assertRaises(Blocked): validate_human_event({"kind": "char", "value": value})
        with self.assertRaises(Revoked): validate_epoch("agent", True, {"owner": "agent", "epoch": 1})

    def test_coordinate_bounds_and_unrequested_fields(self):
        event = {"kind": "click", "x": 0, "y": 0, "width": 10, "height": 10, "sequence": 1}
        validate_human_event(event)
        for extra in ({"x": -1}, {"x": 10}, {"width": 4096}, {"x": 1.5}, {"x": True}, {"key": "Escape"}):
            with self.assertRaises(Blocked): validate_human_event({**event, **extra})

    def test_transfer_revokes_old_epoch_preserves_deadline_and_rejects_stale_stop_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            c = Controller(directory)
            try:
                state = c.start("fixture"); run = state["run_id"]; deadline = c.deadline
                state = c.transfer(run, 1, "human")
                self.assertTrue(state["control_ready"])
                with self.assertRaises(Blocked): c.act(run, 1)
                with self.assertRaises(Blocked): c.receive_input(run, 1, {"kind": "char", "value": "X"})
                c.receive_input(run, 2, {"kind": "char", "value": "X"})
                c.transfer(run, 2, "agent")
                with self.assertRaises(Blocked): c.receive_input(run, 2, {"kind": "char", "value": "X"})
                self.assertEqual(c.deadline, deadline)
                c.stop()
                with self.assertRaises(Blocked): c.act(run, 3)
            finally: c.close()

    def test_both_channels_block_until_worker_acknowledges_new_epoch(self):
        with tempfile.TemporaryDirectory() as directory:
            c = Controller(directory)
            try:
                run = c.start("fixture")["run_id"]
                c.real = True
                write_json(c.run_directory / "worker.json", {"status": "ready", "owner_ack": "agent", "epoch_ack": 1, "heartbeat": time.monotonic()})
                state = c.transfer(run, 1, "human")
                self.assertFalse(state["control_ready"])
                with self.assertRaises(Blocked): c.receive_input(run, 2, {"kind": "char", "value": "X"})
                with self.assertRaises(Blocked): c.act(run, 2)
            finally: c.real = False; c.close()

    def test_input_queue_budget_and_geometry_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            c = Controller(directory)
            try:
                run = c.start("fixture")["run_id"]; c.transfer(run, 1, "human")
                with self.assertRaises(Blocked): c.receive_input(run, 2, {"kind": "click", "x": 1, "y": 1, "width": 1, "height": 1, "sequence": 0})
                c.human_count = HUMAN_LIMIT
                with self.assertRaises(Blocked): c.receive_input(run, 2, {"kind": "char", "value": "X"})
                c.real = True
                for i in range(16): write_json(c.run_directory / "commands" / f"{i}.json", {})
                with self.assertRaises(Blocked): c.enqueue("human", event={"kind": "char", "value": "X"})
            finally: c.real = False; c.close()

    def test_frame_png_and_metadata_must_match(self):
        with tempfile.TemporaryDirectory() as directory:
            c = Controller(directory)
            try:
                c.start("fixture"); c.real = True
                (c.run_directory / "frame.png").write_bytes(b"wrong")
                write_json(c.run_directory / "frame.json", {"sha256": "stale"})
                self.assertIsNone(c.frame_packet()[0])
            finally: c.real = False; c.close()

    def test_transfer_and_stop_remove_incomplete_input_files(self):
        with tempfile.TemporaryDirectory() as directory:
            c = Controller(directory)
            try:
                run = c.start("fixture")["run_id"]
                queue = c.run_directory / "commands"
                (queue / "00000001.json.tmp").write_text("synthetic transient input")
                c.transfer(run, 1, "human")
                self.assertEqual(list(queue.iterdir()), [])
                (queue / "00000002.json.tmp").write_text("synthetic transient input")
                c.stop()
                self.assertEqual(list(queue.iterdir()), [])
            finally: c.close()

    def test_resume_reauthorizes_queued_unstarted_intent_with_new_epoch(self):
        with tempfile.TemporaryDirectory() as directory:
            c = Controller(directory)
            try:
                run = c.start("fixture")["run_id"]; c.real = True
                write_json(c.run_directory / "worker.json", {"status": "ready", "owner_ack": "agent", "epoch_ack": 1, "heartbeat": time.monotonic()})
                c.act(run, 1)
                c.transfer(run, 1, "human")
                self.assertEqual(list((c.run_directory / "commands").glob("*.json")), [])
                write_json(c.run_directory / "worker.json", {"status": "ready", "owner_ack": "human", "epoch_ack": 2, "heartbeat": time.monotonic()})
                c.transfer(run, 2, "agent")
                commands = list((c.run_directory / "commands").glob("*.json"))
                self.assertEqual(len(commands), 1)
                self.assertEqual(json.loads(commands[0].read_text())["epoch"], 3)
            finally: c.real = False; c.close()


if __name__ == "__main__": unittest.main()
