import subprocess
import importlib.util
import types
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "guest"))
from subprocess_rpc import exchange


class SubprocessRpcTest(unittest.TestCase):
    def worker(self, code):
        child = subprocess.Popen([sys.executable, "-u", "-c", code], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, text=True, encoding="utf-8")
        self.addCleanup(self.close_worker, child)
        return child

    @staticmethod
    def close_worker(child):
        if child.poll() is None:
            child.kill()
        child.wait(timeout=3)
        child.stdin.close()
        child.stdout.close()

    def test_timeout_kills_hung_child_and_fresh_child_works(self):
        child = self.worker("import time; input(); time.sleep(60)")
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            exchange(child, "request", 0.2)
        self.assertIsNotNone(child.poll())
        self.assertLess(time.monotonic() - start, 4)
        fresh = self.worker("print(input(), flush=True)")
        self.assertEqual(exchange(fresh, "fresh", 3).strip(), "fresh")

    def test_blocked_pipe_write_is_bounded(self):
        child = self.worker("import time; time.sleep(60)")
        with self.assertRaises(TimeoutError):
            exchange(child, "x" * 1_000_000, 0.2)
        self.assertIsNotNone(child.poll())

    def test_child_exit_reports_failure(self):
        child = self.worker("input()")
        with self.assertRaises(RuntimeError):
            exchange(child, "request", 3)

    def test_action_worker_freezes_and_releases_owner_on_timeout(self):
        # Import the HTTP worker with no desktop dependency; exercise its real RPC cleanup.
        old = sys.modules.get("pyautogui")
        sys.modules["pyautogui"] = types.SimpleNamespace()
        try:
            path = Path(__file__).resolve().parents[1] / "guest" / "action-worker.py"
            spec = importlib.util.spec_from_file_location("action_worker_timeout_test", path)
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
            child = self.worker("import time; input(); time.sleep(60)")
            worker.process = child
            worker.owner = "old-task"
            worker.RPC_TIMEOUT = 0.2
            worker.input_control.transition("agent")
            with worker.lock:
                with self.assertRaises(TimeoutError):
                    worker.desktop_call("observe", {})
            self.assertIsNone(worker.process)
            self.assertIsNone(worker.owner)
            with self.assertRaises(ValueError):
                worker.input_control.require_agent()
            self.assertTrue(worker.lock.acquire(blocking=False))
            worker.lock.release()
        finally:
            if old is None:
                sys.modules.pop("pyautogui", None)
            else:
                sys.modules["pyautogui"] = old


if __name__ == "__main__":
    unittest.main()
