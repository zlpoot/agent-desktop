"""Read-only Default-desktop evidence. Never records window titles or text."""
import ctypes as C
from ctypes import wintypes as W
import threading
import time
from win32 import Api, EVENTPROC


class Monitor:
    def __init__(self):
        self.stop_event = threading.Event()
        self.ready = threading.Event()
        self.result = {"foreground_events": 0, "cursor_changes": 0, "samples": 0,
                       "human_parallel_input": "NOT_RUN", "sampling_limit": "cursor samples cannot attribute movement"}
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()
        if not self.ready.wait(2) or self.result.get("error"):
            raise RuntimeError("default_monitor_unavailable")

    def run(self):
        api = Api()
        @EVENTPROC
        def event(*_):
            self.result["foreground_events"] += 1
        hook = None
        try:
            api.assert_default()
            # OpenInputDesktop reports the user's desktop, not this thread's.
            # A restricted launcher can leave us on a separate inherited desktop.
            # Reject that context; never move the monitor thread or widen access.
            if api.name(api.u.GetThreadDesktop(api.k.GetCurrentThreadId())).lower() != "default":
                raise RuntimeError("monitor_thread_not_default")
            hook = api.checked(api.u.SetWinEventHook(3, 3, None, event, 0, 0, 0), "foreground_hook")
            first_foreground = api.u.GetForegroundWindow()
            first_cursor = previous_cursor = None
            while not self.stop_event.is_set():
                message = W.MSG()
                while api.u.PeekMessageW(C.byref(message), None, 0, 0, 1):
                    api.u.TranslateMessage(C.byref(message))
                    api.u.DispatchMessageW(C.byref(message))
                api.assert_default()
                cursor = W.POINT()
                api.checked(api.u.GetCursorPos(C.byref(cursor)), "read_cursor")
                position = (cursor.x, cursor.y)
                if first_cursor is None:
                    first_cursor = position
                if previous_cursor is not None and position != previous_cursor:
                    self.result["cursor_changes"] += 1
                previous_cursor = position
                self.result["samples"] += 1
                self.result["foreground_final_equals_initial"] = api.u.GetForegroundWindow() == first_foreground
                self.result["cursor_final_equals_initial"] = position == first_cursor
                self.result["input_desktop"] = "Default"
                self.ready.set()  # All read-only evidence probes must succeed before launch.
                time.sleep(0.01)
        except Exception as error:
            self.result["error"] = str(error)
            self.ready.set()
        finally:
            if hook: api.u.UnhookWinEvent(hook)

    def close(self):
        self.stop_event.set()
        self.thread.join(2)
        if self.thread.is_alive():
            self.result["error"] = "monitor_stop_timeout"
        return dict(self.result)
