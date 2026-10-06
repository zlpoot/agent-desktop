"""One bounded script and target-local human input, with per-message epochs."""
import time
from policy import Blocked, Revoked, TEXT, HUMAN_LIMIT, expected_edit, validate_epoch, validate_human_event


class Inputs:
    def __init__(self, api, target, expected, controls, read_control, run_id, fixture):
        self.api, self.target, self.expected = api, target, expected
        self.read_control, self.run_id, self.fixture = read_control, run_id, fixture
        for hwnd in controls:
            api.guard(hwnd, expected)
        self.edit = [h for h in controls if api.class_name(h).lower() == "edit"]
        self.buttons = [h for h in controls if api.class_name(h).lower() == "button"]
        self.labels = [h for h in controls if api.class_name(h).lower() == "static"]
        if len(self.edit) != 1 or (fixture and len(self.buttons) != 1):
            raise Blocked("standard_controls_unavailable")
        self.edit = self.edit[0]
        self.owner, self.epoch = None, 0
        self.started = self.done = self.selected = False
        self.progress = self.human_actions = 0
        self.next_step = 0
        self.seen = set()
        self.last = {}
        self.api.check_input = self.check_input
        self.initial_empty = api.text(self.edit) == ""

    def check_input(self):
        validate_epoch(self.owner, self.epoch, self.read_control())

    def acknowledge(self, control):
        if (self.owner, self.epoch) != (control["owner"], control["epoch"]):
            # Complete target-local cancellation before acknowledging a new owner.
            for hwnd in [self.edit, *self.buttons]:
                self.api.cancel_owned_input(hwnd, self.expected)
            self.owner, self.epoch = control["owner"], control["epoch"]
            self.selected = False

    def count_clicks(self):
        for hwnd in self.labels:
            self.api.guard(hwnd, self.expected)
            value = self.api.text(hwnd)
            if value.startswith("Clicks: "):
                return int(value[8:])
        return None

    def char(self, value):
        self.api.input_guard(self.edit, self.expected)
        before = self.api.text(self.edit)
        selection = self.api.send(self.edit, 0x00B0)
        predicted = expected_edit(before, selection & 0xFFFF, (selection >> 16) & 0xFFFF, value)
        self.api.type_text(self.edit, self.expected, value)
        self.api.guard(self.edit, self.expected)
        if self.api.text(self.edit) != predicted:
            raise Blocked("text_effect_mismatch")

    def command(self, command):
        identifier = command.get("id")
        self.last = {"id": identifier, "result": "REJECTED"}
        try:
            if not isinstance(identifier, str) or identifier in self.seen or len(self.seen) >= 512:
                raise Blocked("duplicate_or_unbounded_commands")
            self.seen.add(identifier)
            if command.get("run_id") != self.run_id or time.monotonic() >= command.get("expires", 0):
                raise Blocked("stale_or_expired_command")
            validate_epoch(command.get("owner"), command.get("epoch"), self.read_control())
            if (command.get("owner"), command.get("epoch")) != (self.owner, self.epoch):
                raise Revoked("handoff_not_acknowledged")
            if command.get("action") == "script" and self.owner == "agent":
                if self.started or not self.initial_empty:
                    raise Blocked("script_started_or_nonempty_initial_target")
                self.started = True
            elif command.get("action") == "human" and self.owner == "human" and self.fixture:
                if self.human_actions >= HUMAN_LIMIT:
                    raise Blocked("human_input_budget")
                event = command.get("event")
                validate_human_event(event)
                if event["kind"] == "char":
                    if not self.selected:
                        raise Blocked("click_editor_before_typing")
                    self.char(event["value"])
                else:
                    hwnd, x, y = self.api.control_at(self.target, self.expected, event, [self.edit, *self.buttons])
                    before = self.count_clicks()
                    self.api.click_at(hwnd, self.expected, x, y)
                    self.selected = hwnd == self.edit
                    if hwnd in self.buttons and self.count_clicks() != before + 1:
                        raise Blocked("human_click_effect_mismatch")
                self.human_actions += 1
            else:
                raise Blocked("wrong_owner_or_action")
            self.last["result"] = "APPLIED"
        except (Blocked, Revoked) as error:
            if str(error) in ("text_effect_mismatch", "human_click_effect_mismatch"):
                raise
            self.last["reason"] = str(error)  # No typed text in state or audit.

    def step(self):
        if not self.started or self.done or self.owner != "agent" or time.monotonic() < self.next_step:
            return
        try:
            self.check_input()
            if self.progress < len(TEXT):
                self.char(TEXT[self.progress])
                self.progress += 1
                self.next_step = time.monotonic() + 0.12
            else:
                if self.fixture:
                    before = self.count_clicks()
                    self.api.click(self.buttons[0], self.expected)
                    if self.count_clicks() != before + 1:
                        raise Blocked("agent_click_effect_mismatch")
                self.done = True
        except Revoked:
            # The old action is finished/cancelled before the next loop ACK.
            pass

    def view(self):
        self.api.guard(self.edit, self.expected)
        return {"owner_ack": self.owner, "epoch_ack": self.epoch, "agent_started": self.started,
                "agent_progress": self.progress, "agent_total": len(TEXT),
                "agent_status": "DONE" if self.done else "PAUSED" if self.owner == "human" and self.started else "RUNNING" if self.started else "NOT_RUN",
                "human_actions": self.human_actions, "last_command": self.last,
                "text_length": len(self.api.text(self.edit)), "clicks": self.count_clicks(),
                "input": "PASS" if self.done else "RUNNING" if self.started else "NOT_RUN",
                "text_verified": self.done, "click_verified": self.done if self.fixture else "NOT_RUN"}
