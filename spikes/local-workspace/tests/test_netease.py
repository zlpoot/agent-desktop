"""Synthetic D0-C boundary regressions; never instantiate COM or launch music."""
import sys
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host import Controller
from netease import exact_song_row, preflight
from netease_input import MusicInputs
from policy import Blocked, Revoked
from uia import Uia

SONG, ARTIST = "合成歌曲", "合成歌手"


class MusicTests(unittest.TestCase):
    def setUp(self):
        self.api, self.uia = Mock(), Mock()
        self.api.text.return_value = "synthetic"
        self.uia.observe.return_value = []
        self.control = {"owner": "agent", "epoch": 1}
        self.inputs = MusicInputs(self.api, self.uia, 1, {}, {"song": SONG, "artist": ARTIST, "query": ARTIST + " " + SONG},
                                  lambda: self.control, "r", Mock())
        self.inputs.acknowledge(self.control)

    def command(self, **changes):
        return {"id": "1", "run_id": "r", "owner": "agent", "epoch": 1,
                "action": "script", "expires": time.monotonic() + 2, **changes}

    def test_R2_viewer_context_uses_owned_uia_role_and_actual_mechanism_without_input(self):
        self.control = {"owner": "human", "epoch": 2}; self.inputs.acknowledge(self.control)
        def rect(_, pointer):
            pointer._obj.left = pointer._obj.top = 0
            pointer._obj.right = pointer._obj.bottom = 10
            return True
        self.api.u.GetWindowRect.side_effect = rect
        editor = {"index": 0, "role": 50004, "auto_id": "search", "name": "search", "enabled": True,
                  "offscreen": False, "rect": [0, 0, 5, 10]}
        player = {"index": 1, "role": 50000, "auto_id": "btn_pc_minibar_play", "name": "play", "enabled": True,
                  "offscreen": False, "rect": [5, 0, 10, 10]}
        self.uia.observe.return_value = [editor, player]
        event = {"kind": "click", "x": 1, "y": 1, "width": 10, "height": 10, "sequence": 1}
        context = self.inputs.viewer_context(event)
        self.assertEqual(context, {"capability": "input.semantic", "action": "viewer-click",
            "targetRole": "search-editor", "mechanism": "uia-control-selection"})
        self.assertFalse(self.inputs.selected)
        context = self.inputs.viewer_context({**event, "x": 6})
        self.assertEqual(context["targetRole"], "playback-button")
        self.assertEqual(context["mechanism"], "owned-hwnd-message")
        self.inputs.selected = True
        self.assertEqual(self.inputs.viewer_context({"kind": "char", "value": "X"})["mechanism"], "uia-valuepattern")
        self.api.send.assert_not_called(); self.uia.set_value.assert_not_called()
        self.uia.observe.return_value = [editor, {**editor, "index": 2, "rect": [7, 0, 10, 10]}]
        with self.assertRaises(Blocked): self.inputs.viewer_context(event)

    def test_R1_neutral_drain_preserves_resume_reobservation_without_replaying_input(self):
        self.inputs.started = self.inputs.done = True; self.inputs.progress = 4
        for owner, epoch in (("human", 2), ("none", 3), ("agent", 4)):
            self.control = {"owner": owner, "epoch": epoch}; self.inputs.acknowledge(self.control)
        self.inputs.step()
        self.assertEqual(self.inputs.resume_observation["epoch"], 4)
        self.api.send.assert_not_called(); self.uia.set_value.assert_not_called()

    def test_exact_original_result_rejects_restored_player_cover_live_and_wrong_artist(self):
        for prefix in ("01", "play"):
            self.assertTrue(exact_song_row(f"{prefix} {SONG} jymaster Tag: 原唱 {ARTIST} 专辑 04:00", SONG, ARTIST))
        for row in (f"{SONG} {ARTIST}", f"02 {SONG}(Live) jymaster Tag: 原唱 {ARTIST}",
                    f"02 {SONG} (Live) jymaster Tag: 原唱 {ARTIST}", f"03 {SONG} jymaster Tag: 原唱 别的歌手",
                    f"04 {SONG}{ARTIST} sky 翻唱 {ARTIST}", f"05 {SONG} sky 伴奏 {ARTIST}",
                    f"06 {SONG} jymaster Tag: 原唱 {ARTIST}另一个歌手"):
            self.assertFalse(exact_song_row(row, SONG, ARTIST), row)

    def test_missing_configuration_and_fake_cannot_claim_real_app_success(self):
        with self.assertRaises(Blocked): preflight({})
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(directory, netease={"path": "synthetic"})
            try:
                with self.assertRaises(Blocked): controller.start("netease")
                self.assertEqual(controller.snapshot()["status"], "idle")
            finally: controller.close()

    def test_control_characters_and_unbounded_query_are_rejected_before_executable_probe(self):
        for value in ("", "x" * 81, "a\n", "😀"):
            with self.assertRaises(Blocked): preflight({"path": "synthetic", "song": value, "artist": ARTIST})

    def test_signed_preflight_refuses_existing_singleton_or_wrong_product(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "cloudmusic.exe"
            executable.write_bytes(b"synthetic fixture")
            for changes in ({"existing": 1}, {"product": "Other"}, {"signature": "UnknownError"}):
                probe = {"existing": 0, "product": "NetEase Cloud Music", "signature": "Valid", "version": "synthetic", **changes}
                result = Mock(returncode=0, stdout=json.dumps(probe))
                with patch("netease.subprocess.run", return_value=result), self.assertRaises(Blocked):
                    preflight({"path": str(executable), "song": SONG, "artist": ARTIST})

    def test_unknown_effect_cannot_acknowledge_new_owner(self):
        self.inputs.pending_effect = True
        with self.assertRaises(Blocked): self.inputs.acknowledge({"owner": "human", "epoch": 2})
        self.assertEqual((self.inputs.owner, self.inputs.epoch), ("agent", 1))

    def test_old_run_expired_and_old_epoch_never_start_script(self):
        for changes in ({"run_id": "old"}, {"expires": 0}, {"epoch": 0}):
            with self.subTest(changes=changes):
                self.inputs.command(self.command(**changes))
                self.assertFalse(self.inputs.started)
                self.assertEqual(self.inputs.last["result"], "REJECTED")
                self.inputs.seen.clear()
        self.api.send.assert_not_called()

    def test_human_owner_pauses_agent_and_resume_does_not_reset_progress(self):
        self.inputs.started, self.inputs.progress = True, 2
        self.control = {"owner": "human", "epoch": 2}
        self.inputs.acknowledge(self.control)
        self.inputs.step()
        self.uia.observe.assert_not_called()
        self.control = {"owner": "agent", "epoch": 3}
        self.inputs.acknowledge(self.control)
        self.assertEqual(self.inputs.progress, 2)
        self.assertTrue(self.inputs.started)

    def test_completed_script_resume_reobserves_exact_track_without_replaying_input(self):
        self.inputs.started = self.inputs.done = True
        self.inputs.progress = 4
        self.control = {"owner": "human", "epoch": 2}
        self.inputs.acknowledge(self.control)
        self.api.text.return_value = SONG + " " + ARTIST
        self.uia.observe.return_value = [{"auto_id": "btn_pc_minibar_play", "name": "pause", "offscreen": False}]
        self.control = {"owner": "agent", "epoch": 3}
        self.inputs.acknowledge(self.control)
        self.inputs.step()
        proof = self.inputs.view()["resume_observation"]
        self.assertEqual(proof["epoch"], 3)
        self.assertTrue(proof["track_matches"] and proof["playing"] and proof["task_completed"])
        self.assertEqual([x["owner"] for x in self.inputs.control_history], ["agent", "human", "agent"])
        self.api.type_text.assert_not_called()
        self.api.send.assert_not_called()
        self.uia.set_value.assert_not_called()

    def test_resume_evidence_does_not_turn_a_changed_track_into_match_or_emit_input(self):
        self.control = {"owner": "human", "epoch": 2}
        self.inputs.acknowledge(self.control)
        self.api.text.return_value = "other synthetic song"
        self.control = {"owner": "agent", "epoch": 3}
        self.inputs.acknowledge(self.control)
        self.inputs.step()
        self.assertFalse(self.inputs.resume_observation["track_matches"])
        self.api.type_text.assert_not_called()
        self.api.send.assert_not_called()

    def test_nonempty_search_is_never_overwritten(self):
        self.uia.value.return_value = "existing"
        self.inputs.window_click = Mock()
        with self.assertRaises(Blocked): self.inputs.type_query({"index": 0})
        self.inputs.window_click.assert_not_called()
        self.api.type_text.assert_not_called()

    def test_query_requires_observed_exact_effect(self):
        self.uia.value.side_effect = ["", self.inputs.config["query"]]
        self.inputs.window_click = Mock(return_value=(5, {}))
        self.inputs.type_query({"index": 0})
        self.api.type_text.assert_called_once_with(5, {}, self.inputs.config["query"])

    def test_playing_uses_current_accessible_name_not_static_auto_id(self):
        self.api.text.return_value = SONG + " " + ARTIST
        for name, expected in (("play", False), ("pause", True)):
            self.uia.observe.return_value = [{"auto_id": "btn_pc_minibar_play", "name": name, "offscreen": False}]
            self.inputs.observe()
            self.assertEqual(self.inputs.playing, expected)

    def test_title_alone_cannot_prove_playback(self):
        self.inputs.started, self.inputs.progress = True, 4
        self.uia.observe.return_value = []
        self.api.text.return_value = SONG + " " + ARTIST
        with self.assertRaises(Blocked): self.inputs.step()
        self.assertFalse(self.inputs.done)

    def test_revocation_before_any_action_does_not_emit_input(self):
        self.inputs.started = True
        self.uia.observe.return_value = []
        self.control = {"owner": "human", "epoch": 2}
        with self.assertRaises(Revoked): self.inputs.step()
        self.api.type_text.assert_not_called()
        self.api.send.assert_not_called()

    def test_unknown_human_effect_is_a_hard_stop(self):
        self.control = {"owner": "human", "epoch": 2}
        self.inputs.acknowledge(self.control)
        self.inputs.selected = True
        self.inputs.observe = Mock()
        self.inputs.editor = Mock(return_value={"index": 0})
        self.uia.value.return_value = "synthetic"
        self.uia.set_value.side_effect = Blocked("uia_value_effect_mismatch")
        with self.assertRaisesRegex(Blocked, "effect_unknown"):
            self.inputs.command(self.command(action="human", owner="human", epoch=2, event={"kind": "char", "value": "x"}))
        self.assertEqual(self.inputs.human_actions, 0)

    def test_com_element_requires_owned_child_process_same_session_and_nonpassword(self):
        uia = Uia.__new__(Uia)
        uia.api, uia.target, uia.expected = self.api, 1, {"session": 2, "desktop": "AgentD0_test"}
        element = Mock()
        values = {20: 44, 35: 0, 36: 0}
        uia.integer = lambda _, slot: values[slot]
        self.api.owned_process.return_value = True
        self.api.session.return_value = 2
        uia.owned(element)
        self.api.owned_process.return_value = False
        with self.assertRaises(Blocked): uia.owned(element)
        self.api.owned_process.return_value = True
        values[35] = 1
        with self.assertRaises(Blocked): uia.owned(element)

    def test_default_or_foreign_native_window_is_rejected(self):
        uia = Uia.__new__(Uia)
        uia.api, uia.target, uia.expected = self.api, 1, {"session": 2, "desktop": "AgentD0_test"}
        uia.integer = lambda _, slot: {20: 44, 35: 0, 36: 7}[slot]
        self.api.owned_process.return_value, self.api.session.return_value = True, 2
        good = {"alive": True, "session": 2, "in_job": True, "desktop": "AgentD0_test"}
        self.api.identity.return_value = good
        uia.owned(Mock())
        for changes in ({"desktop": "Default"}, {"in_job": False}, {"session": 3}, {"alive": False}):
            self.api.identity.return_value = {**good, **changes}
            with self.assertRaises(Blocked): uia.owned(Mock())

    def test_unknown_invoke_effect_is_not_retried_as_legacy_action(self):
        uia = Uia.__new__(Uia)
        uia.api = self.api
        uia.target, uia.expected = 1, {}
        pattern = Mock()
        pattern.call.side_effect = Blocked("provider_unknown_effect")
        uia.pattern = Mock(return_value=pattern)
        with self.assertRaises(Blocked): uia.invoke(0)
        self.assertEqual(uia.pattern.call_count, 1)
        pattern.close.assert_called_once()


if __name__ == "__main__": unittest.main()
