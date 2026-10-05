"""Finite NetEase search/play task using owned UIA patterns and HWND messages."""
import time
from policy import Blocked, Revoked, validate_epoch, validate_human_event
from netease import exact_song_row

ROLES = {50000, 50004, 50007, 50011, 50018, 50019, 50026, 50029}


class MusicInputs:
    def __init__(self, api, uia, target, expected, config, read_control, run_id, publish, observe_sink=None):
        self.api, self.uia, self.target, self.expected, self.config = api, uia, target, expected, config
        self.read_control, self.run_id, self.publish = read_control, run_id, publish
        self.observe_sink = observe_sink
        self.owner, self.epoch = None, 0
        self.progress = self.human_actions = 0
        self.started = self.done = self.selected = False
        self.last, self.seen, self.rows = {}, set(), []
        self.next_step = 0
        self.playing = self.track_matches = False
        self.pending_effect = False
        api.check_input = self.check_input

    def check_input(self): validate_epoch(self.owner, self.epoch, self.read_control())

    def acknowledge(self, control):
        if (self.owner, self.epoch) != (control["owner"], control["epoch"]):
            if self.pending_effect: raise Blocked("music_input_effect_unknown_fail_closed")
            # Commands are serialized; cancel held target-window state before ACK.
            self.api.cancel_owned_input(self.target, self.expected)
            self.owner, self.epoch = control["owner"], control["epoch"]
            self.selected = False

    def observe(self):
        self.rows = self.uia.observe(self.publish, ROLES)
        if self.observe_sink:
            self.observe_sink(self.rows)
        title = self.api.text(self.target)
        self.track_matches = self.config["song"] in title and self.config["artist"] in title
        self.playing = any(x["auto_id"] == "btn_pc_minibar_play" and x["name"] == "pause" and not x["offscreen"] for x in self.rows)
        return self.rows

    def one(self, predicate, reason):
        found = [x for x in self.rows if x["enabled"] and not x["offscreen"] and predicate(x)]
        if len(found) != 1: raise Blocked(reason)
        return found[0]

    def editor(self): return self.one(lambda x: x["role"] == 50004, "music_search_editor_unavailable")

    def song_rows(self):
        return [x for x in self.rows if x["role"] in (50026, 50007) and x["enabled"] and not x["offscreen"]
                and exact_song_row(x["name"], self.config["song"], self.config["artist"])]

    def wait_effect(self, predicate, reason):
        deadline = time.monotonic() + 6
        while True:
            self.observe(); self.check_input()
            if predicate():
                self.pending_effect = False
                return
            if time.monotonic() >= deadline: raise Blocked(reason)
            time.sleep(0.05)

    def window_click(self, row, double=False):
        # Coordinates come only from fresh allowed UIA controls; target
        # the owned CEF render child, never the system mouse or arbitrary pixels.
        children = [h for h in self.api.windows(self.target, children=True) if self.api.class_name(h) == "Chrome_RenderWidgetHostHWND"]
        if len(children) != 1: raise Blocked("music_renderer_unavailable")
        child = children[0]
        identity = self.api.identity(child)
        expected = {k: identity[k] for k in ("pid", "session", "desktop")}
        self.api.guard(child, expected)
        from win32 import C, W
        origin, bounds = W.POINT(), W.RECT()
        self.api.checked(self.api.u.ClientToScreen(child, C.byref(origin)), "music_renderer_origin")
        self.api.checked(self.api.u.GetClientRect(child, C.byref(bounds)), "music_renderer_bounds")
        left, top, right, bottom = row["rect"]
        x, y = (left + right) // 2 - origin.x, (top + bottom) // 2 - origin.y
        if not (0 <= x < bounds.right and 0 <= y < bounds.bottom): raise Blocked("music_row_outside_renderer")
        position = x | (y << 16)
        try:
            messages = [(0x200, 0), (0x201, 1), (0x202, 0)]
            if double: messages += [(0x203, 1), (0x202, 0)]
            for message, buttons in messages:
                self.api.input_guard(child, expected)
                self.api.send(child, message, buttons, position)
        finally:
            self.api.cancel_owned_input(child, expected)
        return child, expected

    def type_query(self, editor):
        if self.uia.value(editor["index"]):
            raise Blocked("nonempty_music_search_refuse_overwrite")
        child, expected = self.window_click(editor)
        self.api.type_text(child, expected, self.config["query"])
        deadline = time.monotonic() + 1.5
        while self.uia.value(editor["index"]) != self.config["query"]:
            self.api.guard(self.target,self.expected); self.publish()
            if time.monotonic() >= deadline: raise Blocked("targeted_music_query_not_verified")
            time.sleep(0.05)

    def command(self, command):
        self.last = {"id": command.get("id"), "result": "REJECTED"}
        try:
            identifier = command.get("id")
            if not isinstance(identifier, str) or identifier in self.seen or len(self.seen) >= 512:
                raise Blocked("duplicate_or_unbounded_commands")
            self.seen.add(identifier)
            if command.get("run_id") != self.run_id or time.monotonic() >= command.get("expires", 0):
                raise Blocked("stale_or_expired_command")
            validate_epoch(command.get("owner"), command.get("epoch"), self.read_control())
            self.check_input()
            if command.get("action") == "script" and self.owner == "agent":
                if self.started: raise Blocked("music_script_already_started")
                self.started = True
            elif command.get("action") == "human" and self.owner == "human":
                if self.human_actions >= 256: raise Blocked("human_input_budget")
                event = command["event"]; validate_human_event(event)
                self.observe(); self.check_input()
                if event["kind"] == "char":
                    if not self.selected: raise Blocked("click_editor_before_typing")
                    editor = self.editor(); value = self.uia.value(editor["index"])
                    value = value[:-1] if event["value"] == "\b" else value + event["value"]
                    if len(value) > 512: raise Blocked("text_limit_reached")
                    self.pending_effect = True
                    self.uia.set_value(editor["index"], value)
                    self.pending_effect = False
                else:
                    from win32 import C, W
                    rect = W.RECT(); self.api.checked(self.api.u.GetWindowRect(self.target, C.byref(rect)), "music_window_rect")
                    if (rect.right-rect.left, rect.bottom-rect.top) != (event["width"], event["height"]): raise Blocked("frame_geometry_changed")
                    sx, sy = rect.left + event["x"], rect.top + event["y"]
                    candidates = [x for x in self.rows if x["enabled"] and not x["offscreen"] and
                        x["rect"][0] <= sx < x["rect"][2] and x["rect"][1] <= sy < x["rect"][3] and
                        (x["role"] == 50004 or x["auto_id"] in ("btn_pc_minibar_play", "btn_pc_minibar_pause"))]
                    if len(candidates) != 1: raise Blocked("human_music_control_not_allowed")
                    node = candidates[0]; self.selected = node["role"] == 50004
                    if not self.selected:
                        previous = self.playing
                        self.pending_effect = True
                        self.window_click(node)
                        self.wait_effect(lambda: self.playing != previous, "human_play_effect_unverified")
                self.human_actions += 1
            else: raise Blocked("wrong_owner_or_action")
            self.last["result"] = "APPLIED"
        except (Blocked, Revoked) as error:
            self.last["reason"] = str(error)
            if self.pending_effect:
                raise Blocked("music_input_effect_unknown_fail_closed") from error

    def step(self):
        if not self.started or self.done or self.owner != "agent" or time.monotonic() < self.next_step: return
        self.observe(); self.check_input()
        if self.progress == 0:
            self.pending_effect = True
            editor = self.editor(); self.type_query(editor)
            self.check_input(); self.pending_effect = False
            self.progress = 1
        elif self.progress == 1:
            button = self.one(lambda x: x["role"] == 50000 and x["name"] == "search", "music_search_button_unavailable")
            self.pending_effect = True
            self.window_click(button)
            self.wait_effect(lambda: any(x["role"] == 50019 and x["name"] == "单曲" and not x["offscreen"] for x in self.rows), "music_search_navigation_unverified")
            self.progress = 2
        elif self.progress == 2:
            tab = self.one(lambda x: x["role"] == 50019 and x["name"] == "单曲", "music_singles_tab_unavailable")
            self.pending_effect = True
            self.window_click(tab)
            self.wait_effect(lambda: bool(self.song_rows()), "exact_music_result_unavailable")
            self.progress = 3
        elif self.progress == 3:
            rows = self.song_rows()
            if len(rows) != 1: raise Blocked("exact_music_result_missing_or_ambiguous")
            self.pending_effect = True
            self.window_click(rows[0],double=True)
            self.wait_effect(lambda: self.track_matches and self.playing, "music_playback_not_verified_or_login_vip_required")
            self.progress = 4
        elif self.track_matches and self.playing:
            self.done = True
        else:
            raise Blocked("music_playback_not_verified_or_login_vip_required")
        self.next_step = time.monotonic() + 1.2

    def view(self):
        return {"owner_ack":self.owner,"epoch_ack":self.epoch,"agent_started":self.started,
                "agent_progress":self.progress,"agent_total":4,"human_actions":self.human_actions,
                "last_command":self.last,"input":"PASS" if self.done else "RUNNING" if self.started else "NOT_RUN",
                "track_matches":self.track_matches,"playing":self.playing,"stage":"done" if self.done else "music_ready",
                "input_ready":True,"input_class":"SEMANTIC_INPUT_AND_TARGETED_WINDOW_INPUT",
                "agent_input_class":"TARGETED_WINDOW_INPUT"}
