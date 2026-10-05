import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "guest"))
from input_control import InputControl


class InputControlTest(unittest.TestCase):
    def test_mutual_exclusion_and_expired_human_lease(self):
        gate = InputControl()
        with self.assertRaises(ValueError): gate.require_agent()
        gate.transition("agent")
        gate.require_agent()
        with self.assertRaises(ValueError): gate.require_human("old")
        old = gate.transition("human")["lease"]
        gate.require_human(old)
        with self.assertRaises(ValueError): gate.require_agent()
        gate.transition("paused")
        new = gate.transition("human")["lease"]
        with self.assertRaises(ValueError): gate.require_human(old)
        gate.require_human(new)

    def test_emergency_revokes_before_atomic_operation_finishes(self):
        gate = InputControl()
        gate.request("agent", 1)
        gate.request("stopped", 2)
        with self.assertRaises(ValueError): gate.transition("agent", 1)
        with self.assertRaises(ValueError): gate.require_agent()
        gate.transition("stopped", 2)
        with self.assertRaises(ValueError): gate.request("agent", 1)
        gate.request("paused", 3)
        gate.transition("paused", 3)
        with self.assertRaises(ValueError): gate.require_agent()


if __name__ == "__main__": unittest.main()
