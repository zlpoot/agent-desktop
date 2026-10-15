"""离线合成测试：不创建任何真实桌面、不加载任何 Win32 DLL、不启动任何进程。

用一个可注入的 FakeApi 复现真实实现的方法面，验证抽取出来的安全不变量。
运行：python -m unittest discover -s tests -v   （在 labs/hidden-desktop 下）
"""
import ast
import inspect
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hidden_desktop as hd  # noqa: E402
from hidden_desktop import (  # noqa: E402
    Blocked, CleanupUnconfirmed, DEFAULT_DESKTOP, DESKTOP_ACCESS, NAME_PREFIX,
    ORDINARY_MEDIUM_INTEGRITY, validate_desktop_name,
)


class FakeClock:
    """可控单调时钟：sleep 会推进 now，避免测试真的等待。"""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeApi:
    """真实 Api 的最小等价替身。句柄用递增整数，桌面用名称字符串做键。"""

    def __init__(self, *, input_desktop=DEFAULT_DESKTOP, session=1, integrity=ORDINARY_MEDIUM_INTEGRITY,
                 session_active=True, existing_desktops=(), fail_create=None, keep_desktop=False,
                 keep_job=False, break_thread_restore=False, foreign_windows=0, own_window_visible=True,
                 break_job=False, capture_geometry=(8, 6), capture_uniform=False):
        self.thread = DEFAULT_DESKTOP
        self.input_desktop_name = input_desktop
        self.session_id = session
        self.integrity = integrity
        self.session_active = session_active
        self.desktops = {}
        self.handle_names = {}
        self.jobs = {}
        self.job_pids = {}
        self.processes = {}
        self.process_handles = {}
        self.windows = []
        self.children = {}          # 父 hwnd -> 子 hwnd，供 route_input 下钻
        self.launched = []
        self.calls = []
        self.next_handle = 1000
        self.next_pid = 4000
        self.fail_create = fail_create
        self.keep_desktop = keep_desktop
        self.keep_job = keep_job
        self.break_thread_restore = break_thread_restore
        self.foreign_windows = foreign_windows
        self.own_window_visible = own_window_visible
        self.break_job = break_job
        self.capture_geometry = capture_geometry
        self.capture_uniform = capture_uniform
        for name in existing_desktops:
            self._register_desktop(name)

    # -- 内部 -------------------------------------------------------------- #
    def _handle(self):
        self.next_handle += 1
        return self.next_handle

    def _register_desktop(self, name):
        handle = self._handle()
        self.desktops[name] = handle
        self.handle_names[handle] = name
        return handle

    def _pid(self):
        self.next_pid += 1
        return self.next_pid

    # -- 会话 / 桌面 -------------------------------------------------------- #
    def assert_default(self):
        self.calls.append(("assert_default",))
        if not self.session_active:
            raise Blocked("interactive_session_not_active")
        if self.input_desktop_name.lower() != DEFAULT_DESKTOP:
            raise Blocked("user_input_desktop_not_default")

    def input_desktop(self):
        return self.input_desktop_name

    def session(self, pid):
        return self.session_id

    def token_facts(self, pid):
        if pid == os.getpid():
            return ("S-1-5-21-parent", self.session_id, self.integrity)
        return ("S-1-5-21-parent", self.session_id, ORDINARY_MEDIUM_INTEGRITY)

    def station_name(self):
        return "WinSta0"

    def thread_desktop(self):
        return self.thread

    def thread_desktop_name(self):
        return self.handle_names.get(self.thread, self.thread)

    def set_thread_desktop(self, value):
        self.calls.append(("set_thread_desktop", value))
        if self.break_thread_restore and value == DEFAULT_DESKTOP:
            return False
        self.thread = value
        return True

    # -- 打开 / 启动 / 枚举 ------------------------------------------------- #
    def create_desktop(self, name):
        validate_desktop_name(name)
        self.calls.append(("create_desktop", name))
        if self.fail_create:
            raise Blocked(self.fail_create)
        if name in self.desktops:
            raise Blocked("desktop_already_exists")
        return self._register_desktop(name)

    def desktop_exists(self, name):
        return (name in self.desktops, 0 if name in self.desktops else 2)

    def create_job(self, name):
        self.calls.append(("create_job", name))
        if name in self.jobs:
            raise Blocked("job_already_exists")
        handle = self._handle()
        self.jobs[name] = handle
        self.job_pids[handle] = []
        return handle

    def launch(self, argv, desktop, job):
        pid = self._pid()
        self.launched.append({"argv": list(argv), "desktop": desktop, "job": job,
                              "startup_desktop": "WinSta0\\" + desktop})
        handle = self._handle()
        self.processes[pid] = {"desktop": desktop, "job": job, "image": argv[0], "alive": True}
        self.process_handles[handle] = pid
        self.windows.append({"hwnd": self._handle(), "pid": pid, "desktop": desktop,
                             "visible": self.own_window_visible, "title": "AgentD0 Lab Window",
                             "minimized": False, "client": [0, 0, 620, 380],
                             "rect": [120, 120, 740, 500],
                             "root": True, "ex_style": 0, "class": "AgentD0LabWindow"})
        for _ in range(self.foreign_windows):
            other = self._pid()
            self.processes[other] = {"desktop": desktop, "job": None, "image": "other.exe", "alive": True}
            self.windows.append({"hwnd": self._handle(), "pid": other, "desktop": desktop,
                                 "visible": True, "title": "Foreign", "minimized": False,
                                 "client": [0, 0, 100, 100], "rect": [0, 0, 100, 100],
                                 "root": True, "ex_style": 0, "class": "Foreign"})
        if job:
            self.job_pids[job].append(pid)
        return handle, pid

    def enum_windows(self, desktop):
        name = self.handle_names.get(desktop)
        return [w["hwnd"] for w in self.windows if w["desktop"] == name]

    def job_active(self, job):
        return len(self.job_pids.get(job, []))

    def terminate_job(self, job):
        if not self.keep_job:
            for pid in list(self.job_pids.get(job, [])):
                self.processes[pid]["alive"] = False
                self.windows = [w for w in self.windows if w["pid"] != pid]
            self.job_pids[job] = []
        return True

    def process_in_job(self, pid, job):
        if self.break_job:
            return False
        return pid in self.job_pids.get(job, [])

    def process_image(self, handle):
        return self.processes[self.process_handles[handle]]["image"]

    def process_image_of(self, pid):
        entry = self.processes.get(pid)
        return entry["image"] if entry else ""

    def show_no_activate(self, hwnd):
        self.calls.append(("show_no_activate", hwnd))
        window = self._window(hwnd)
        if window is not None:
            window["visible"] = True
        return True

    def place_no_activate(self, hwnd, x, y, width, height):
        self.calls.append(("place_no_activate", hwnd, x, y, width, height))
        window = self._window(hwnd)
        if window is not None:
            window["rect"] = [x, y, x + width, y + height]
        return True

    def window_title(self, hwnd):
        window = self._window(hwnd)
        return window["title"] if window else ""

    def is_minimized(self, hwnd):
        window = self._window(hwnd)
        return bool(window and window.get("minimized"))

    def send(self, hwnd, message, wparam=0, lparam=0):
        self.calls.append(("send", hwnd, message, wparam, lparam))
        return 1

    def deepest_child_at(self, hwnd, x, y, max_depth=16):
        """等价替身：真实实现按窗口树下钻，这里按注册的 children 表下钻。"""
        current, point = hwnd, (int(x), int(y))
        for _ in range(max_depth):
            child = self.children.get(current)
            if not child:
                break
            current, point = child, point
        return current, point

    def close_handle(self, handle):
        if handle in self.job_pids:
            del self.job_pids[handle]
        return True

    def close_desktop(self, handle):
        if self.keep_desktop:
            return False
        name = self.handle_names.pop(handle, None)
        if name is not None:
            self.desktops.pop(name, None)
        return True

    # -- 只读窗口属性 ------------------------------------------------------- #
    def _window(self, hwnd):
        for window in self.windows:
            if window["hwnd"] == hwnd:
                return window
        return None

    def window_pid(self, hwnd):
        window = self._window(hwnd)
        return window["pid"] if window else 0

    def is_window(self, hwnd):
        return self._window(hwnd) is not None

    def is_window_visible(self, hwnd):
        window = self._window(hwnd)
        return bool(window and window["visible"])

    def window_rect(self, hwnd):
        window = self._window(hwnd)
        return list(window["rect"]) if window else [0, 0, 0, 0]

    def client_rect(self, hwnd):
        window = self._window(hwnd)
        return list(window["client"]) if window else [0, 0, 0, 0]

    def is_root_window(self, hwnd):
        window = self._window(hwnd)
        return bool(window and window["root"])

    def window_class(self, hwnd):
        window = self._window(hwnd)
        if window is None:
            raise Blocked("window_class_unavailable")
        return window["class"]

    def window_ex_style(self, hwnd):
        window = self._window(hwnd)
        if window is None:
            raise Blocked("window_style_unavailable")
        return window["ex_style"]

    # -- 只读画面抓取 ------------------------------------------------------- #
    def capture_dpi(self):
        self.calls.append(("capture_dpi",))

    def capture_window(self, hwnd, flags=2):
        self.calls.append(("capture_window", hwnd, flags))
        if self._window(hwnd) is None:
            raise Blocked("invalid_capture_geometry")
        width, height = self.capture_geometry
        if self.capture_uniform:
            rgb = bytes([0x20, 0x40, 0x60] * (width * height))
        else:
            rgb = bytes((index * 7 + 3) % 256 for index in range(width * height * 3))
        return width, height, rgb, not self.capture_uniform


def make(api=None, **kwargs):
    clock = FakeClock()
    api = api if api is not None else FakeApi(**kwargs)
    return hd.HiddenDesktop(api=api, clock=clock, sleep=clock.sleep), api, clock


# --------------------------------------------------------------------------- #
class BoundaryTests(unittest.TestCase):
    """静态/纯函数层面就成立的安全边界。"""

    def test_access_mask_never_includes_switch_desktop(self):
        self.assertEqual(DESKTOP_ACCESS, 0xC3)
        self.assertFalse(DESKTOP_ACCESS & hd.DESKTOP_SWITCHDESKTOP)

    def test_name_guard_rejects_foreign_and_non_string(self):
        for bad in ("default", "Winlogon", "AgentD0", "", None, 7):
            with self.assertRaises(Blocked) as caught:
                validate_desktop_name(bad)
            self.assertEqual(str(caught.exception), "invalid_desktop_name")
        self.assertEqual(validate_desktop_name(NAME_PREFIX + "abc"), NAME_PREFIX + "abc")

    def test_source_exposes_no_desktop_switch_or_system_input_api(self):
        # 只看代码里的字符串常量（跳过注释与 docstring），确认没有绑定
        # 任何桌面切换或系统输入入口。
        tree = ast.parse(inspect.getsource(hd))
        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                first = node.body[0] if node.body else None
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                        and isinstance(first.value.value, str):
                    docstrings.add(id(first.value))
        constants = [node.value for node in ast.walk(tree)
                     if isinstance(node, ast.Constant) and isinstance(node.value, str)
                     and id(node) not in docstrings]
        for forbidden in ("SwitchDesktop", "SetInputDesktop", "SendInput", "SetCursorPos",
                          "mouse_event", "keybd_event", "BlockInput"):
            self.assertFalse([text for text in constants if forbidden in text],
                             forbidden + " 不应被绑定或调用")
        # 必要的入口仍然存在；OpenInputDesktop 只用于只读探针，不是切换入口。
        for required in ("CreateDesktopW", "CreateProcessW", "OpenInputDesktop", "EnumDesktopWindows"):
            self.assertIn(required, constants)

    def test_only_expected_win32_libraries_are_loaded(self):
        source = inspect.getsource(hd.NativeDesktopApi.__init__)
        for library in ("user32", "kernel32", "advapi32", "wtsapi32"):
            self.assertIn(library, source)
        self.assertNotIn("shell32", source)


class OpenTests(unittest.TestCase):
    def test_open_creates_prefixed_desktop_and_job_and_keeps_controller_on_default(self):
        desktop, api, _ = make()
        context = desktop.open()
        self.assertTrue(context["name"].startswith(NAME_PREFIX))
        self.assertEqual(context["desktop"], "WinSta0\\" + context["name"])
        self.assertIn(context["name"], api.desktops)
        self.assertIn(context["name"] + "_job", api.jobs)
        # 控制线程始终留在 default，绝不切换到新桌面。
        self.assertEqual(api.thread_desktop_name().lower(), DEFAULT_DESKTOP)

    def test_open_refuses_when_input_desktop_is_not_default(self):
        desktop, api, _ = make(input_desktop="Winlogon")
        with self.assertRaises(Blocked) as caught:
            desktop.open()
        self.assertEqual(str(caught.exception), "user_input_desktop_not_default")
        self.assertEqual(api.desktops, {})
        self.assertEqual(api.jobs, {})

    def test_open_refuses_when_session_inactive(self):
        desktop, _, _ = make(session_active=False)
        with self.assertRaises(Blocked) as caught:
            desktop.open()
        self.assertEqual(str(caught.exception), "interactive_session_not_active")

    def test_open_refuses_when_integrity_is_not_ordinary_medium(self):
        desktop, api, _ = make(integrity="S-1-16-12288")  # High
        with self.assertRaises(Blocked) as caught:
            desktop.open()
        self.assertEqual(str(caught.exception), "ordinary_medium_required")
        self.assertEqual([c for c in api.calls if c[0] == "create_desktop"], [])

    def test_open_on_existing_desktop_leaves_no_partial_state(self):
        desktop, api, _ = make(fail_create="desktop_already_exists")
        with self.assertRaises(Blocked) as caught:
            desktop.open()
        self.assertEqual(str(caught.exception), "desktop_already_exists")
        self.assertIsNone(desktop.desktop)
        self.assertIsNone(desktop.job)
        self.assertFalse(desktop.blocked)


class StartTests(unittest.TestCase):
    def _started(self, **kwargs):
        desktop, api, _ = make(**kwargs)
        desktop.open()
        pid = desktop.start(sys.executable)
        return desktop, api, pid

    def test_start_binds_process_to_hidden_desktop_and_job(self):
        desktop, api, pid = self._started()
        record = api.launched[0]
        self.assertEqual(record["startup_desktop"], "WinSta0\\" + desktop.name)
        self.assertEqual(record["desktop"], desktop.name)
        self.assertIsNotNone(record["job"])
        self.assertTrue(api.process_in_job(pid, desktop.job))

    def test_start_requires_open_first(self):
        desktop, _, _ = make()
        with self.assertRaises(Blocked) as caught:
            desktop.start(sys.executable)
        self.assertEqual(str(caught.exception), "hidden_desktop_not_open")

    def test_start_rejects_non_executable_paths(self):
        desktop, api, _ = make()
        desktop.open()
        with self.assertRaises(Blocked) as caught:
            desktop.start(os.path.join(os.path.dirname(sys.executable), "not-a-real.exe"))
        self.assertEqual(str(caught.exception), "invalid_executable")
        self.assertEqual(api.launched, [])

    def test_start_refuses_second_launch(self):
        desktop, api, _ = self._started()
        with self.assertRaises(Blocked):
            desktop.start(sys.executable)
        self.assertEqual(len(api.launched), 1)

    def test_lease_expiry_blocks_further_actions(self):
        desktop, api, clock = make()
        desktop.open()
        clock.now = hd.LIFETIME_SECONDS + 1
        with self.assertRaises(Blocked) as caught:
            desktop.start(sys.executable)
        self.assertEqual(str(caught.exception), "hidden_desktop_lease_expired")


class EnumerateAndVerifyTests(unittest.TestCase):
    def _started(self, **kwargs):
        desktop, api, _ = make(**kwargs)
        desktop.open()
        desktop.start(sys.executable)
        return desktop, api

    def test_only_own_window_is_reported(self):
        desktop, _ = self._started(foreign_windows=2)
        windows = desktop.main_windows()
        self.assertEqual(len(windows), 1)
        self.assertEqual(desktop.api.window_pid(windows[0]), desktop.pid)

    def test_windows_enumeration_restores_controller_thread(self):
        desktop, api = self._started()
        desktop.main_windows()
        self.assertEqual(api.thread_desktop_name().lower(), DEFAULT_DESKTOP)

    def test_unconfirmed_thread_restore_marks_blocked(self):
        desktop, api = self._started(break_thread_restore=True)
        with self.assertRaises(Blocked) as caught:
            desktop.windows()
        self.assertEqual(str(caught.exception), "default_restore_unconfirmed")
        self.assertTrue(desktop.blocked)

    def test_verify_confirms_ownership_facts(self):
        desktop, _ = self._started()
        verdict = desktop.verify()
        self.assertTrue(verdict["defaultUntouched"])
        self.assertTrue(verdict["confirmed"])
        self.assertEqual(verdict["desktop"], desktop.context["desktop"])
        self.assertTrue(verdict["inJob"])
        self.assertTrue(verdict["sameUser"])
        self.assertTrue(verdict["sameSession"])

    def test_verify_never_claims_confirmation_without_a_main_window(self):
        desktop, _ = self._started(own_window_visible=False)
        verdict = desktop.verify()
        self.assertTrue(verdict["defaultUntouched"])
        self.assertEqual(verdict["mainWindowCount"], 0)
        self.assertFalse(verdict["confirmed"])

    def test_identity_rejects_window_of_another_process_on_the_same_desktop(self):
        # 同一隐藏桌面上的外来窗口必须被拒；判据是「进程属于本次 Job」，
        # 而不是「pid 等于启动器」——多进程应用的界面窗口由子进程承载，后者会误拒。
        desktop, api = self._started(foreign_windows=1)
        foreign = next(w["hwnd"] for w in api.windows if w["class"] == "Foreign")
        with self.assertRaises(Blocked) as caught:
            desktop.identity(foreign)
        self.assertEqual(str(caught.exception), "target_outside_owned_job")

    def test_identity_accepts_child_process_window_in_the_same_job(self):
        """CEF/Electron 的界面窗口常由子进程承载：同 Job 就必须被接受。"""
        desktop, api = self._started()
        child = api._pid()
        api.processes[child] = {"desktop": desktop.name, "job": desktop.job,
                                "image": "child.exe", "alive": True}
        api.job_pids[desktop.job].append(child)
        api.windows.append({"hwnd": api._handle(), "pid": child, "desktop": desktop.name,
                            "visible": False, "title": "CEF", "minimized": False,
                            "client": [0, 0, 10, 10], "rect": [0, 0, 32, 32],
                            "root": True, "ex_style": 0, "class": "Chrome_WidgetWin_0"})
        try:
            facts = desktop.identity(api.windows[-1]["hwnd"])
            self.assertTrue(facts["inJob"])
            self.assertEqual(facts["pid"], child)
            self.assertEqual(facts["image"], "child.exe")
        finally:
            api.windows.pop()
            desktop.close()

    def test_identity_rejects_unknown_window_handle(self):
        desktop, _ = self._started()
        with self.assertRaises(Blocked) as caught:
            desktop.identity(987654321)
        self.assertEqual(str(caught.exception), "target_desktop_mismatch")


class TargetSelectionTests(unittest.TestCase):
    """目标窗口的候选集、显式选定与显示定尺。

    真实应用会建出十几个顶层窗口（IME 指示器、托盘、歌词窗、消息窗……），
    「自动唯一」只适用自建单窗口目标，所以必须有一步"按界面结构显式选定"。
    """

    def _started(self, **kwargs):
        desktop, api, _ = make(**kwargs)
        desktop.open()
        desktop.start(sys.executable)
        return desktop, api

    def _add_window(self, desktop, api, *, pid, class_name, rect, visible=True, title=""):
        hwnd = api._handle()
        api.windows.append({"hwnd": hwnd, "pid": pid, "desktop": desktop.name,
                            "visible": visible, "title": title, "minimized": False,
                            "client": [0, 0, rect[2] - rect[0], rect[3] - rect[1]],
                            "rect": list(rect), "root": True, "ex_style": 0,
                            "class": class_name})
        return hwnd

    def test_owned_windows_include_invisible_windows(self):
        """不可见的界面窗口（CEF 显示前的占位）必须仍在候选集里。"""
        desktop, api = self._started()
        hidden = self._add_window(desktop, api, pid=api.windows[0]["pid"],
                                  class_name="Chrome_WidgetWin_0", rect=[0, 0, 32, 32],
                                  visible=False)
        try:
            self.assertIn(hidden, desktop.owned_windows())
            self.assertNotIn(hidden, desktop.main_windows())
        finally:
            desktop.close()

    def test_owned_windows_include_child_process_windows_in_the_job(self):
        desktop, api = self._started()
        child = api._pid()
        api.processes[child] = {"desktop": desktop.name, "job": desktop.job,
                                "image": "child.exe", "alive": True}
        api.job_pids[desktop.job].append(child)
        spawned = self._add_window(desktop, api, pid=child, class_name="OrpheusBrowserHost",
                                   rect=[0, 0, 640, 480])
        try:
            self.assertIn(spawned, desktop.owned_windows())
        finally:
            desktop.close()

    def test_owned_windows_exclude_foreign_process(self):
        desktop, api = self._started(foreign_windows=1)
        foreign = next(w["hwnd"] for w in api.windows if w["class"] == "Foreign")
        try:
            self.assertNotIn(foreign, desktop.owned_windows())
        finally:
            desktop.close()

    def test_select_by_class_name_requires_uniqueness(self):
        desktop, api = self._started()
        pid = api.windows[0]["pid"]
        self._add_window(desktop, api, pid=pid, class_name="Chrome_WidgetWin_0", rect=[0, 0, 32, 32])
        try:
            outcome = desktop.select_target({"kind": "className", "value": "Chrome_WidgetWin_0"})
            self.assertEqual(outcome["window"]["className"], "Chrome_WidgetWin_0")
            with self.assertRaises(Blocked) as caught:
                desktop.select_target({"kind": "className", "value": "不存在"})
            self.assertEqual(str(caught.exception), "target_not_unique")
        finally:
            desktop.close()

    def test_select_largest_refuses_on_a_tie(self):
        """最大面积并列时选不准，必须停下而不是任取一个。"""
        desktop, api = self._started()
        pid = api.windows[0]["pid"]
        self._add_window(desktop, api, pid=pid, class_name="A", rect=[0, 0, 800, 600])
        self._add_window(desktop, api, pid=pid, class_name="B", rect=[0, 0, 800, 600])
        try:
            with self.assertRaises(Blocked) as caught:
                desktop.select_target({"kind": "largest"})
            self.assertEqual(str(caught.exception), "target_not_unique")
        finally:
            desktop.close()

    def test_select_refuses_without_an_unsupported_locator(self):
        desktop, api = self._started()
        try:
            with self.assertRaises(Blocked) as caught:
                desktop.select_target({"kind": "颜色", "value": "红"})
            self.assertEqual(str(caught.exception), "unsupported_locator")
        finally:
            desktop.close()

    def test_target_window_prefers_explicit_selection(self):
        desktop, api = self._started()
        pid = api.windows[0]["pid"]
        small = self._add_window(desktop, api, pid=pid, class_name="ImeOverlay",
                                 rect=[0, 0, 20, 20])
        big = self._add_window(desktop, api, pid=pid, class_name="MainWindow",
                               rect=[0, 0, 1200, 800])
        try:
            # 未显式选定时要求"自动唯一"：这里有 3 个窗口，必须拒绝。
            with self.assertRaises(Blocked) as caught:
                desktop.target_window()
            self.assertEqual(str(caught.exception), "target_not_unique")
            desktop.select_target({"kind": "className", "value": "MainWindow"})
            hwnd, source = desktop.target_window()
            self.assertEqual(hwnd, big)
            self.assertEqual(source, "explicit")
            self.assertNotEqual(hwnd, small)
        finally:
            desktop.close()

    def test_selected_target_is_dropped_when_it_disappears(self):
        desktop, api = self._started()
        pid = api.windows[0]["pid"]
        window = self._add_window(desktop, api, pid=pid, class_name="MainWindow",
                                  rect=[0, 0, 1200, 800])
        desktop.select_target({"kind": "className", "value": "MainWindow"})
        api.windows[:] = [w for w in api.windows if w["hwnd"] != window]
        with self.assertRaises(Blocked) as caught:
            desktop.target_window()
        self.assertEqual(str(caught.exception), "target_desktop_mismatch")
        desktop.close()

    def test_present_window_shows_and_resizes_within_budget(self):
        desktop, api = self._started()
        pid = api.windows[0]["pid"]
        # CEF 类应用显示前的实际形态：不可见的 32×32 占位。
        window = self._add_window(desktop, api, pid=pid, class_name="OrpheusBrowserHost",
                                  rect=[0, 0, 32, 32], visible=False)
        try:
            desktop.select_target({"kind": "className", "value": "OrpheusBrowserHost"})
            outcome = desktop.present_window(window, 1600, 1000)
            self.assertFalse(outcome["before"]["visible"])
            self.assertTrue(outcome["after"]["visible"])
            self.assertEqual(outcome["after"]["rect"], [50, 50, 1650, 1050])
            self.assertEqual(("show_no_activate", window) in api.calls, True)
            self.assertIn(("place_no_activate", window, 50, 50, 1600, 1000), api.calls)
            self.assertLess(api.calls.index(("capture_dpi",)),
                            api.calls.index(("place_no_activate", window, 50, 50, 1600, 1000)))
        finally:
            desktop.close()

    def test_present_window_refuses_outside_the_size_budget(self):
        desktop, api = self._started()
        pid = api.windows[0]["pid"]
        window = self._add_window(desktop, api, pid=pid, class_name="MainWindow",
                                  rect=[0, 0, 1200, 800])
        try:
            desktop.select_target({"kind": "className", "value": "MainWindow"})
            for width, height in ((399, 1000), (1600, 299), (2049, 1000), (1600, 2049)):
                with self.assertRaises(Blocked) as caught:
                    desktop.present_window(window, width, height)
                self.assertEqual(str(caught.exception), "owned_window_size_budget")
            # 被拒时不能留下任何实际改动
            self.assertNotIn(("show_no_activate", window), api.calls)
        finally:
            desktop.close()

    def test_present_window_refuses_foreign_target(self):
        desktop, api = self._started(foreign_windows=1)
        foreign = next(w["hwnd"] for w in api.windows if w["class"] == "Foreign")
        try:
            with self.assertRaises(Blocked) as caught:
                desktop.present_window(foreign, 1600, 1000)
            self.assertEqual(str(caught.exception), "target_outside_owned_job")
        finally:
            desktop.close()


class InputRoutingTests(unittest.TestCase):
    """输入要发给真正的接收窗口。

    CEF / Electron 类应用把消息发给外层窗口的结果是「成功发出、界面毫无变化」，
    实测某播放器把 WM_CHAR 发给外层窗口时输入框纹丝不动。真正的接收者是渲染子窗口，
    定位方式是窗口树 + 坐标，不依赖窗口类名。
    """

    def _started(self, **kwargs):
        desktop, api, _ = make(**kwargs)
        desktop.open()
        desktop.start(sys.executable)
        return desktop, api

    def _add_child(self, desktop, api, parent, class_name="Chrome_RenderWidgetHostHWND"):
        child = api._handle()
        api.windows.append({"hwnd": child, "pid": api.window_pid(parent), "desktop": desktop.name,
                            "visible": True, "title": "", "minimized": False,
                            "client": [0, 0, 1600, 1000], "rect": [50, 50, 1650, 1050],
                            "root": False, "ex_style": 0, "class": class_name})
        api.children[parent] = child
        return child

    def test_route_input_descends_to_the_receiving_child(self):
        desktop, api = self._started()
        parent = api.windows[0]["hwnd"]
        child = self._add_child(desktop, api, parent)
        try:
            leaf, x, y = desktop.route_input(parent, 647, 53)
            self.assertEqual(leaf, child)
            self.assertEqual((x, y), (647, 53))
        finally:
            desktop.close()

    def test_route_input_returns_the_window_when_there_is_no_child(self):
        desktop, api = self._started()
        parent = api.windows[0]["hwnd"]
        try:
            leaf, x, y = desktop.route_input(parent, 10, 20)
            self.assertEqual((leaf, x, y), (parent, 10, 20))
        finally:
            desktop.close()

    def test_route_input_refuses_a_foreign_leaf(self):
        """下钻到不属于本次 Job 的窗口时必须拒绝，不能把输入发出去。"""
        desktop, api = self._started(foreign_windows=1)
        parent = api.windows[0]["hwnd"]
        foreign = next(w["hwnd"] for w in api.windows if w["class"] == "Foreign")
        api.children[parent] = foreign
        try:
            with self.assertRaises(Blocked) as caught:
                desktop.route_input(parent, 10, 20)
            self.assertEqual(str(caught.exception), "target_outside_owned_job")
        finally:
            desktop.close()

    def test_click_reports_the_window_that_received_it(self):
        desktop, api = self._started()
        parent = api.windows[0]["hwnd"]
        child = self._add_child(desktop, api, parent)
        try:
            info = desktop.click(parent, 647, 53)
            self.assertEqual(info["target"], parent)
            self.assertEqual(info["inputWindow"], child)
        finally:
            desktop.close()

    def test_type_text_with_a_point_routes_to_the_leaf(self):
        desktop, api = self._started()
        parent = api.windows[0]["hwnd"]
        child = self._add_child(desktop, api, parent)
        try:
            info = desktop.type_text(parent, "ab", point=(647, 53))
            self.assertEqual(info["inputWindow"], child)
            messages = [call for call in api.calls if call[:1] == ("send",)]
            self.assertTrue(messages, "应当发过窗口消息")
            self.assertTrue(all(call[1] == child for call in messages), messages)
        finally:
            desktop.close()


class CleanupTests(unittest.TestCase):
    def test_close_terminates_job_removes_desktop_and_clears_state(self):
        desktop, api, _ = make()
        desktop.open()
        desktop.start(sys.executable)
        result = desktop.close()
        self.assertEqual(result, {"cleaned": True})
        self.assertEqual(api.desktops, {})
        self.assertEqual(api.windows, [])
        self.assertIsNone(desktop.name)
        self.assertIsNone(desktop.context)
        self.assertFalse(desktop.blocked)

    def test_close_is_idempotent(self):
        desktop, _, _ = make()
        desktop.open()
        self.assertEqual(desktop.close(), {"cleaned": True})
        self.assertEqual(desktop.close(), {"cleaned": True})

    def test_close_reports_unconfirmed_when_desktop_survives(self):
        desktop, _, _ = make(keep_desktop=True)
        desktop.open()
        with self.assertRaises(CleanupUnconfirmed) as caught:
            desktop.close()
        steps = [entry["step"] for entry in caught.exception.errors]
        self.assertIn("desktop-present", steps)
        self.assertTrue(desktop.blocked)

    def test_close_reports_unconfirmed_when_job_stays_active(self):
        desktop, _, _ = make(keep_job=True)
        desktop.open()
        desktop.start(sys.executable)
        with self.assertRaises(CleanupUnconfirmed) as caught:
            desktop.close()
        steps = [entry["step"] for entry in caught.exception.errors]
        self.assertIn("job-not-empty", steps)
        self.assertTrue(desktop.blocked)

    def test_blocked_desktop_refuses_reopen_and_start(self):
        desktop, _, _ = make(keep_desktop=True)
        desktop.open()
        with self.assertRaises(CleanupUnconfirmed):
            desktop.close()
        with self.assertRaises(Blocked) as caught:
            desktop.open()
        self.assertEqual(str(caught.exception), "cleanup_unconfirmed")

    def test_context_manager_closes_on_exit(self):
        api = FakeApi()
        with hd.HiddenDesktop(api=api, clock=lambda: 0.0, sleep=lambda _: None) as desktop:
            desktop.start(sys.executable)
            name = desktop.name
        self.assertNotIn(name, api.desktops)

    def test_context_manager_closes_even_after_failure(self):
        api = FakeApi(input_desktop="Winlogon")
        with self.assertRaises(Blocked):
            with hd.HiddenDesktop(api=api, clock=lambda: 0.0, sleep=lambda _: None) as desktop:
                desktop.start(sys.executable)
        self.assertEqual(api.desktops, {})


class CaptureTests(unittest.TestCase):
    """查看隐藏窗口画面：只读、私有落盘、token 化。"""

    def _started(self, **kwargs):
        desktop, api, _ = make(**kwargs)
        desktop.open()
        desktop.start(sys.executable)
        return desktop, api

    def test_capture_writes_private_png_and_returns_metadata_only(self):
        desktop, _ = self._started()
        try:
            info = desktop.capture()
            self.assertEqual((info["width"], info["height"]), (8, 6))
            self.assertFalse(info["unrendered"])
            self.assertEqual(len(info["token"]), 32)
            self.assertEqual(len(info["sha256"]), 64)
            # 返回值里绝不含文件路径或原始字节。
            self.assertNotIn("path", info)
            path = desktop.preview_path(info["token"])
            self.assertTrue(path.is_file())
            body = path.read_bytes()
            self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(len(body), info["bytes"])
            # PNG 落在私有临时目录内，文件名就是 token。
            self.assertEqual(path.name, info["token"] + ".png")
            self.assertEqual(path.parent, desktop.preview_dir)
        finally:
            desktop.close()

    def test_preview_token_is_validated(self):
        desktop, _ = self._started()
        try:
            info = desktop.capture()
            for bad in ("", "short", "../" + info["token"], info["token"].upper(),
                        "z" * 32, info["token"][:-1] + "Z", 12345, None):
                with self.assertRaises(Blocked) as caught:
                    desktop.preview_path(bad)
                self.assertEqual(str(caught.exception), "invalid_preview_token")
            with self.assertRaises(Blocked) as caught:
                desktop.preview_path("a" * 32)  # 合法格式但不存在
            self.assertEqual(str(caught.exception), "preview_not_found")
        finally:
            desktop.close()

    def test_capture_requires_open_desktop(self):
        desktop, _, _ = make()
        with self.assertRaises(Blocked) as caught:
            desktop.capture()
        self.assertEqual(str(caught.exception), "hidden_desktop_not_open")
        with self.assertRaises(Blocked) as caught:
            desktop.preview_path("a" * 32)
        self.assertEqual(str(caught.exception), "preview_unavailable")

    def test_foreign_window_is_ignored_when_capturing(self):
        desktop, api = self._started(foreign_windows=1)
        try:
            info = desktop.capture()
            self.assertEqual(info["pid"], desktop.pid)
            captures = [call for call in api.calls if call[0] == 'capture_window']
            self.assertEqual([call[1] for call in captures], [desktop.main_windows()[0]])
        finally:
            desktop.close()

    def test_capture_refuses_without_owned_process(self):
        desktop, _, _ = make()
        desktop.open()
        try:
            with self.assertRaises(Blocked) as caught:
                desktop.capture()
            self.assertEqual(str(caught.exception), "capture_requires_owned_process")
        finally:
            desktop.close()

    def test_capture_refuses_when_main_window_count_is_not_one(self):
        desktop, _ = self._started(own_window_visible=False)
        try:
            with self.assertRaises(Blocked) as caught:
                desktop.capture()
            self.assertEqual(str(caught.exception), "target_not_unique")
        finally:
            desktop.close()

    def test_capture_refuses_when_ownership_is_unconfirmed(self):
        # 归属判据是 Job 成员：不在 Job 里就是外来进程，一律拒绝。
        desktop, _ = self._started(break_job=True)
        try:
            with self.assertRaises(Blocked) as caught:
                desktop.capture()
            self.assertEqual(str(caught.exception), "target_outside_owned_job")
        finally:
            desktop.close()

    def test_capture_refuses_unrendered_by_default(self):
        desktop, _ = self._started(capture_uniform=True)
        try:
            with self.assertRaises(Blocked) as caught:
                desktop.capture()
            self.assertEqual(str(caught.exception), "preview_unrendered")
            # 测试页面选择允许展示，但要明确标注。
            info = desktop.capture(allow_unrendered=True)
            self.assertTrue(info["unrendered"])
        finally:
            desktop.close()

    def test_pending_preview_limit(self):
        desktop, _ = self._started()
        try:
            for _ in range(8):
                desktop.capture()
            with self.assertRaises(Blocked) as caught:
                desktop.capture()
            self.assertEqual(str(caught.exception), "preview_pending_limit")
        finally:
            desktop.close()

    def test_close_removes_preview_files_and_directory(self):
        desktop, _ = self._started()
        info = desktop.capture()
        directory = desktop.preview_dir
        path = desktop.preview_path(info["token"])
        desktop.close()
        self.assertFalse(path.exists())
        self.assertFalse(directory.exists())
        self.assertIsNone(desktop.preview_dir)

    def test_png_encoder_emits_valid_header(self):
        body = hd.png_rgb(3, 2, bytes(3 * 2 * 3))
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(body[12:16], b"IHDR")
        import struct as _struct
        width, height = _struct.unpack(">II", body[16:24])
        self.assertEqual((width, height), (3, 2))
        self.assertTrue(body.endswith(b"IEND\xae\x42\x60\x82"))
        for bad in ((0, 2, bytes(0)), (3, 2, bytes(3)), (2049, 2, bytes(2049 * 2 * 3))):
            with self.assertRaises(ValueError):
                hd.png_rgb(*bad)


class LeaseTests(unittest.TestCase):
    """租约：可见、可控，但绝不被静默续期。"""

    def _started(self, **kwargs):
        desktop, api, clock = make(**kwargs)
        desktop.open()
        return desktop, api, clock

    def test_remaining_counts_down_and_expires(self):
        desktop, _, clock = self._started()
        try:
            self.assertAlmostEqual(desktop.remaining(), hd.LIFETIME_SECONDS, places=3)
            clock.now = hd.LIFETIME_SECONDS / 2
            self.assertAlmostEqual(desktop.remaining(), hd.LIFETIME_SECONDS / 2, places=3)
            clock.now = hd.LIFETIME_SECONDS + 5
            self.assertEqual(desktop.remaining(), 0)      # 永不为负
        finally:
            desktop.close()

    def test_remaining_is_none_when_not_open(self):
        desktop, _, _ = make()
        self.assertIsNone(desktop.remaining())

    def test_renew_revives_an_expired_desktop(self):
        desktop, _, clock = self._started()
        try:
            clock.now = hd.LIFETIME_SECONDS + 10
            with self.assertRaises(Blocked) as caught:
                desktop.verify()
            self.assertEqual(str(caught.exception), "hidden_desktop_lease_expired")
            # 续租之后动作恢复，且资源从未被释放过。
            result = desktop.renew()
            self.assertEqual(result["leaseSeconds"], hd.LIFETIME_SECONDS)
            self.assertAlmostEqual(result["remaining"], hd.LIFETIME_SECONDS, places=3)
            self.assertEqual(desktop.verify()["mainWindowCount"], 0)   # 未启动进程
        finally:
            desktop.close()

    def test_renew_accepts_an_explicit_bounded_lease(self):
        desktop, _, _ = self._started()
        try:
            self.assertEqual(desktop.renew(600)["leaseSeconds"], 600)
            self.assertEqual(desktop.lifetime, 600)
            for bad in (0, -1, hd.MAX_LIFETIME_SECONDS + 1, "300", 1.5, True):
                with self.assertRaises(Blocked) as caught:
                    desktop.renew(bad)
                self.assertEqual(str(caught.exception), "invalid_lease_seconds")
            # 拒绝非法值不会改动已生效的租约
            self.assertEqual(desktop.lifetime, 600)
        finally:
            desktop.close()

    def test_renew_refuses_when_not_open_or_blocked(self):
        desktop, _, _ = make()
        with self.assertRaises(Blocked) as caught:
            desktop.renew()
        self.assertEqual(str(caught.exception), "hidden_desktop_not_open")

        blocked, _, _ = make(keep_desktop=True)
        blocked.open()
        with self.assertRaises(CleanupUnconfirmed):
            blocked.close()
        with self.assertRaises(Blocked) as caught:
            blocked.renew()
        self.assertEqual(str(caught.exception), "cleanup_unconfirmed")

    def test_expired_lease_still_allows_cleanup(self):
        desktop, api, clock = self._started()
        desktop.start(sys.executable)
        clock.now = hd.LIFETIME_SECONDS + 10
        with self.assertRaises(Blocked):
            desktop.capture()
        # 清理不受租约影响：过期也必须能正常收尾。
        self.assertEqual(desktop.close(), {"cleaned": True})
        self.assertEqual(api.desktops, {})
        self.assertFalse(desktop.blocked)

    def test_renew_does_not_happen_implicitly(self):
        desktop, _, clock = self._started()
        try:
            desktop.windows()
            desktop.main_windows()
            clock.now = hd.LIFETIME_SECONDS + 1
            # 读操作本身不会续期
            self.assertEqual(desktop.remaining(), 0)
        finally:
            desktop.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
