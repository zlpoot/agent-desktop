"""Pure readiness policy cases; the Windows API probe is exercised on a real Guest."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "guest"))
from desktop_readiness import evaluate


class DesktopReadinessTests(unittest.TestCase):
    def test_active_default_desktop(self):
        self.assertEqual(evaluate(0, "Default"), {
            "ready_for_observation": True, "ready_for_input": True, "blocked_reason": None})

    def test_locked_desktop(self):
        state = evaluate(0, "Winlogon")
        self.assertFalse(state["ready_for_observation"])
        self.assertFalse(state["ready_for_input"])
        self.assertEqual(state["blocked_reason"], "desktop_locked")

    def test_disconnected_session(self):
        self.assertEqual(evaluate(4, "Default")["blocked_reason"], "user_not_logged_in")

    def test_probe_unavailable(self):
        self.assertEqual(evaluate(None, None)["blocked_reason"], "target_session_missing")
        self.assertEqual(evaluate(0, None)["blocked_reason"], "permission_mismatch")


if __name__ == "__main__":
    unittest.main()
