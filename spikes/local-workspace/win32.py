"""Small Win32 surface. No system input, desktop switching or activation APIs.

Importing this module does not load DLLs; Api() is Windows-only and explicit.
"""
import ctypes as C
from ctypes import wintypes as W
import subprocess
from policy import Blocked, png_rgb, validate_target

UPTR = C.c_size_t
SPTR = C.c_ssize_t
HANDLE = W.HANDLE
WNDPROC = getattr(C, "WINFUNCTYPE", C.CFUNCTYPE)(SPTR, W.HWND, W.UINT, UPTR, SPTR)
ENUMPROC = getattr(C, "WINFUNCTYPE", C.CFUNCTYPE)(W.BOOL, W.HWND, SPTR)
EVENTPROC = getattr(C, "WINFUNCTYPE", C.CFUNCTYPE)(None, HANDLE, W.DWORD, W.HWND, W.LONG, W.LONG, W.DWORD, W.DWORD)


class STARTUPINFO(C.Structure):
    _fields_ = [("cb", W.DWORD), ("reserved", W.LPWSTR), ("desktop", W.LPWSTR), ("title", W.LPWSTR),
                *[(n, W.DWORD) for n in ("x", "y", "width", "height", "chars_x", "chars_y", "fill", "flags")],
                ("show", W.WORD), ("reserved_size", W.WORD), ("reserved_bytes", C.c_void_p),
                ("stdin", HANDLE), ("stdout", HANDLE), ("stderr", HANDLE)]


class PROCESSINFO(C.Structure):
    _fields_ = [("process", HANDLE), ("thread", HANDLE), ("pid", W.DWORD), ("tid", W.DWORD)]


class LIMITS(C.Structure):
    _fields_ = [("process_time", C.c_int64), ("job_time", C.c_int64), ("flags", W.DWORD),
                ("min_working", UPTR), ("max_working", UPTR), ("active", W.DWORD),
                ("affinity", UPTR), ("priority", W.DWORD), ("scheduling", W.DWORD)]


class EXTENDED_LIMITS(C.Structure):
    _fields_ = [("basic", LIMITS), ("io", C.c_uint64 * 6), ("process_memory", UPTR),
                ("job_memory", UPTR), ("peak_process", UPTR), ("peak_job", UPTR)]


class WNDCLASS(C.Structure):
    _fields_ = [("style", W.UINT), ("proc", WNDPROC), ("cls_extra", C.c_int), ("wnd_extra", C.c_int),
                ("instance", HANDLE), ("icon", HANDLE), ("cursor", HANDLE), ("background", HANDLE),
                ("menu", W.LPCWSTR), ("name", W.LPCWSTR)]


class BITMAPINFO(C.Structure):
    _fields_ = [("size", W.DWORD), ("width", W.LONG), ("height", W.LONG), ("planes", W.WORD),
                ("bits", W.WORD), ("compression", W.DWORD), ("image_size", W.DWORD),
                ("xppm", W.LONG), ("yppm", W.LONG), ("used", W.DWORD), ("important", W.DWORD)]


class Api:
    def __init__(self):
        self.u = C.WinDLL("user32", use_last_error=True)
        self.k = C.WinDLL("kernel32", use_last_error=True)
        self.g = C.WinDLL("gdi32", use_last_error=True)
        self.wts = C.WinDLL("wtsapi32", use_last_error=True)
        def bind(dll, name, args, result):
            fn = getattr(dll, name)
            fn.argtypes, fn.restype = args, result
        V, D, I, S, H = C.c_void_p, W.DWORD, C.c_int, W.LPCWSTR, HANDLE
        bind(self.wts, "WTSQuerySessionInformationW", [H, D, I, C.POINTER(V), C.POINTER(D)], W.BOOL)
        bind(self.wts, "WTSFreeMemory", [V], None)
        for name, args, result in [
            ("GetCurrentThreadId", [], D), ("GetCurrentProcessId", [], D),
            ("GetCurrentProcess", [], H), ("GetModuleHandleW", [S], H),
            ("GetProcessId", [H], D),
            ("ProcessIdToSessionId", [D, C.POINTER(D)], W.BOOL),
            ("CreateProcessW", [S, W.LPWSTR, V, V, W.BOOL, D, V, S, C.POINTER(STARTUPINFO), C.POINTER(PROCESSINFO)], W.BOOL),
            ("CloseHandle", [H], W.BOOL), ("ResumeThread", [H], D),
            ("TerminateProcess", [H, I], W.BOOL), ("WaitForSingleObject", [H, D], D),
            ("OpenProcess", [D, W.BOOL, D], H), ("IsProcessInJob", [H, H, C.POINTER(W.BOOL)], W.BOOL),
            ("CreateJobObjectW", [V, S], H), ("SetInformationJobObject", [H, I, V, D], W.BOOL),
            ("OpenJobObjectW", [D, W.BOOL, S], H),
            ("AssignProcessToJobObject", [H, H], W.BOOL), ("TerminateJobObject", [H, I], W.BOOL),
            ("QueryInformationJobObject", [H, I, V, D, V], W.BOOL),
        ]: bind(self.k, name, args, result)
        for name, args, result in [
            ("CreateDesktopW", [S, V, V, D, D, V], H), ("OpenDesktopW", [S, D, W.BOOL, D], H),
            ("CloseDesktop", [H], W.BOOL), ("GetThreadDesktop", [D], H), ("SetThreadDesktop", [H], W.BOOL),
            ("GetProcessWindowStation", [], H), ("OpenInputDesktop", [D, W.BOOL, D], H),
            ("GetUserObjectInformationW", [H, I, V, D, C.POINTER(D)], W.BOOL),
            ("EnumDesktopWindows", [H, ENUMPROC, SPTR], W.BOOL), ("EnumChildWindows", [H, ENUMPROC, SPTR], W.BOOL),
            ("GetWindowThreadProcessId", [H, C.POINTER(D)], D), ("IsWindow", [H], W.BOOL),
            ("IsWindowVisible", [H], W.BOOL),
            ("SetThreadDpiAwarenessContext", [H], H),
            ("SetWindowPos", [H, H, I, I, I, I, W.UINT], W.BOOL),
            ("GetClassNameW", [H, W.LPWSTR, I], I), ("GetWindowRect", [H, C.POINTER(W.RECT)], W.BOOL),
            ("GetClientRect", [H, C.POINTER(W.RECT)], W.BOOL),
            ("ClientToScreen", [H, C.POINTER(W.POINT)], W.BOOL),
            ("PostMessageW", [H, W.UINT, UPTR, SPTR], W.BOOL),
            ("SendMessageTimeoutW", [H, W.UINT, UPTR, SPTR, W.UINT, W.UINT, C.POINTER(UPTR)], SPTR),
            ("PrintWindow", [H, H, W.UINT], W.BOOL),
            ("GetForegroundWindow", [], H), ("GetCursorPos", [C.POINTER(W.POINT)], W.BOOL),
            ("RegisterClassW", [C.POINTER(WNDCLASS)], W.WORD),
            ("CreateWindowExW", [D, S, S, D, I, I, I, I, H, H, H, V], H),
            ("DefWindowProcW", [H, W.UINT, UPTR, SPTR], SPTR),
            ("ShowWindow", [H, I], W.BOOL), ("UpdateWindow", [H], W.BOOL),
            ("SetWindowTextW", [H, S], W.BOOL), ("DestroyWindow", [H], W.BOOL),
            ("PostQuitMessage", [I], None), ("GetMessageW", [C.POINTER(W.MSG), H, W.UINT, W.UINT], I),
            ("TranslateMessage", [C.POINTER(W.MSG)], W.BOOL), ("DispatchMessageW", [C.POINTER(W.MSG)], SPTR),
            ("SetTimer", [H, UPTR, W.UINT, V], UPTR),
            ("SetWinEventHook", [D, D, H, EVENTPROC, D, D, D], H), ("UnhookWinEvent", [H], W.BOOL),
            ("PeekMessageW", [C.POINTER(W.MSG), H, W.UINT, W.UINT, W.UINT], W.BOOL),
        ]: bind(self.u, name, args, result)
        for name, args, result in [
            ("CreateCompatibleDC", [H], H), ("CreateDIBSection", [H, C.POINTER(BITMAPINFO), W.UINT, C.POINTER(V), H, D], H),
            ("SelectObject", [H, H], H), ("DeleteObject", [H], W.BOOL), ("DeleteDC", [H], W.BOOL),
        ]: bind(self.g, name, args, result)

    def checked(self, value, label):
        if not value:
            raise OSError(C.get_last_error(), label)
        return value

    def name(self, handle):
        size = W.DWORD()
        self.u.GetUserObjectInformationW(handle, 2, None, 0, C.byref(size))
        if not 0 < size.value <= 1024:
            raise Blocked("desktop_name_unavailable")
        buf = C.create_unicode_buffer(512)
        self.checked(self.u.GetUserObjectInformationW(handle, 2, buf, C.sizeof(buf), C.byref(size)), "object_name")
        return buf.value

    def input_desktop(self):
        handle = self.checked(self.u.OpenInputDesktop(0, False, 1), "input_desktop")
        try: return self.name(handle)
        finally: self.u.CloseDesktop(handle)

    def capture_dpi(self):
        self.checked(self.u.SetThreadDpiAwarenessContext(-4), "capture_thread_dpi")

    def size_owned_window(self, hwnd, expected, width, height):
        self.guard(hwnd, expected)
        if not (400 <= width <= 2048 and 300 <= height <= 2048):
            raise Blocked("owned_window_size_budget")
        self.u.ShowWindow(hwnd, 4)  # Restore/show without activation (SW_SHOWNOACTIVATE).
        # NOZORDER | NOACTIVATE: only the owned hidden app's geometry changes.
        self.checked(self.u.SetWindowPos(hwnd, None, 50, 50, width, height, 0x14), "size_owned_window")

    def assert_default(self):
        data, size = C.c_void_p(), W.DWORD()
        self.checked(self.wts.WTSQuerySessionInformationW(None, 0xFFFFFFFF, 8, C.byref(data), C.byref(size)), "active_session_probe")
        try:
            if not data or size.value != C.sizeof(C.c_int) or C.cast(data, C.POINTER(C.c_int)).contents.value != 0:
                raise Blocked("interactive_session_not_active")
        finally:
            self.wts.WTSFreeMemory(data)
        if self.input_desktop().lower() != "default":
            raise Blocked("user_input_desktop_not_default")

    def default_target_count(self, pid):
        self.assert_default()
        desktop = self.u.GetThreadDesktop(self.k.GetCurrentThreadId())
        if self.name(desktop).lower() != "default":
            raise Blocked("controller_thread_not_default")
        count = 0
        for hwnd in self.windows(desktop):
            owner = W.DWORD()
            self.u.GetWindowThreadProcessId(hwnd, C.byref(owner))
            count += owner.value == pid
        return count

    def session(self, pid):
        value = W.DWORD()
        self.checked(self.k.ProcessIdToSessionId(pid, C.byref(value)), "session")
        return value.value

    def desktop(self, name):
        if not name.startswith("AgentD0_"):
            raise Blocked("invalid_desktop_name")
        existing = self.u.OpenDesktopW(name, 0, False, 1)
        if existing:
            self.u.CloseDesktop(existing)
            raise Blocked("desktop_already_exists")
        previous = self.u.GetThreadDesktop(self.k.GetCurrentThreadId())
        # READOBJECTS | CREATEWINDOW | ENUMERATE | WRITEOBJECTS. No SWITCHDESKTOP.
        handle = self.checked(self.u.CreateDesktopW(name, None, None, 0, 0xC3, None), "create_desktop")
        try:
            self.checked(self.u.SetThreadDesktop(previous), "restore_controller_thread")
        except BaseException:
            self.u.CloseDesktop(handle)
            raise
        return handle

    def job(self, name):
        C.set_last_error(0)
        handle = self.checked(self.k.CreateJobObjectW(None, name), "create_job")
        if C.get_last_error() == 183:  # ERROR_ALREADY_EXISTS: never own somebody else's job.
            self.k.CloseHandle(handle)
            raise Blocked("job_already_exists")
        limits = EXTENDED_LIMITS()
        limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE
        try:
            self.checked(self.k.SetInformationJobObject(handle, 9, C.byref(limits), C.sizeof(limits)), "job_limits")
        except BaseException:
            self.k.CloseHandle(handle)
            raise
        return handle

    def join_job_view(self, name):
        self.owned_job_name = name

    def job_active(self, job):
        accounting = C.create_string_buffer(48)
        self.checked(self.k.QueryInformationJobObject(job, 1, accounting, 48, None), "job_accounting")
        return W.DWORD.from_buffer(accounting, 40).value

    def job_pids(self, job):
        data = C.create_string_buffer(8 + 128 * C.sizeof(UPTR))
        self.checked(self.k.QueryInformationJobObject(job, 3, data, len(data), None), "job_process_list")
        count = W.DWORD.from_buffer(data, 4).value
        if count > 128:
            raise Blocked("job_process_budget")
        return list((UPTR * count).from_buffer(data, 8))

    def launch(self, argv, desktop, job=None):
        startup, process = STARTUPINFO(), PROCESSINFO()
        startup.cb = C.sizeof(startup)
        startup.desktop = "WinSta0\\" + desktop
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(x) for x in argv]))
        self.checked(self.k.CreateProcessW(str(argv[0]), command, None, None, False,
                                          0x08000004, None, None, C.byref(startup), C.byref(process)), "create_process")
        try:
            if job:
                self.checked(self.k.AssignProcessToJobObject(job, process.process), "assign_job")
            if self.k.ResumeThread(process.thread) == 0xFFFFFFFF:
                raise OSError(C.get_last_error(), "resume_thread")
        except BaseException:
            self.k.TerminateProcess(process.process, 1)
            self.k.WaitForSingleObject(process.process, 2000)
            self.k.CloseHandle(process.process)
            raise
        finally:
            self.k.CloseHandle(process.thread)
        return process.process, process.pid

    def windows(self, desktop, children=False):
        result = []
        @ENUMPROC
        def collect(hwnd, _):
            result.append(int(hwnd))
            return True
        if children:
            self.u.EnumChildWindows(desktop, collect, 0)
        else:
            # A newly created desktop can be empty while the child initializes.
            # Clear stale errors from the preceding object-name size query.
            C.set_last_error(0)
            ok = self.u.EnumDesktopWindows(desktop, collect, 0)
            if not ok and C.get_last_error():
                raise OSError(C.get_last_error(), "enum_desktop")
        return result

    def identity(self, hwnd):
        pid = W.DWORD()
        tid = self.u.GetWindowThreadProcessId(hwnd, C.byref(pid))
        if not tid or not self.u.IsWindow(hwnd):
            return {"alive": False}
        process = self.k.OpenProcess(0x1000, False, pid.value)
        in_job = W.BOOL()
        job = None
        try:
            name = getattr(self, "owned_job_name", None)
            job = self.k.OpenJobObjectW(4, False, name) if name else None
            owned = bool(process and job and self.k.IsProcessInJob(process, job, C.byref(in_job)) and in_job.value)
        finally:
            if process: self.k.CloseHandle(process)
            if job: self.k.CloseHandle(job)
        return {"alive": True, "pid": pid.value, "desktop": self.name(self.u.GetThreadDesktop(tid)),
                "session": self.session(pid.value), "in_job": owned}

    def owned_process(self, pid):
        process = self.k.OpenProcess(0x1000, False, pid)
        job = self.k.OpenJobObjectW(4, False, getattr(self, "owned_job_name", None))
        owned = W.BOOL()
        try:
            return bool(process and job and self.k.IsProcessInJob(process, job, C.byref(owned)) and owned.value)
        finally:
            if process: self.k.CloseHandle(process)
            if job: self.k.CloseHandle(job)

    def guard(self, hwnd, expected):
        check_control = getattr(self, "check_control", None)
        if check_control:
            check_control()
        self.assert_default()
        validate_target(self.identity(hwnd), expected)

    def close_owned_window(self, hwnd, expected):
        # Cleanup is allowed after the input lease is revoked. It still requires
        # exact target ownership and never authorizes another input action.
        self.assert_default()
        validate_target(self.identity(hwnd), expected)
        self.checked(self.u.PostMessageW(hwnd, 0x10, 0, 0), "close_owned_window")

    def class_name(self, hwnd):
        buf = C.create_unicode_buffer(256)
        self.checked(self.u.GetClassNameW(hwnd, buf, 256), "class_name")
        return buf.value

    def send(self, hwnd, message, wparam=0, lparam=0):
        result = UPTR()
        self.checked(self.u.SendMessageTimeoutW(hwnd, message, wparam, lparam, 0x22, 500, C.byref(result)), "message_timeout")
        return result.value

    def text(self, hwnd):
        buf = C.create_unicode_buffer(2048)
        self.send(hwnd, 0x000D, 2048, C.cast(buf, C.c_void_p).value)
        return buf.value

    def type_text(self, hwnd, expected, text):
        for char in text:
            self.input_guard(hwnd, expected)
            self.send(hwnd, 0x0102, ord(char), 1)

    def input_guard(self, hwnd, expected):
        self.guard(hwnd, expected)
        check_input = getattr(self, "check_input", None)
        if check_input:
            check_input()

    def cancel_owned_input(self, hwnd, expected):
        self.assert_default()
        validate_target(self.identity(hwnd), expected)
        self.send(hwnd, 0x001F)  # WM_CANCELMODE; target-local cleanup, no system input.

    def click(self, hwnd, expected):
        self.input_guard(hwnd, expected)
        rect = W.RECT()
        self.checked(self.u.GetClientRect(hwnd, C.byref(rect)), "client_rect")
        x, y = (rect.right - rect.left) // 2, (rect.bottom - rect.top) // 2
        if not (0 < x < 32768 and 0 < y < 32768):
            raise Blocked("invalid_click_geometry")
        self.click_at(hwnd, expected, x, y)

    def click_at(self, hwnd, expected, x, y):
        position = x | (y << 16)
        try:
            for message, buttons in ((0x200, 0), (0x201, 1), (0x202, 0)):
                self.input_guard(hwnd, expected)
                self.send(hwnd, message, buttons, position)
        finally:
            self.cancel_owned_input(hwnd, expected)

    def control_at(self, target, expected, event, controls):
        self.guard(target, expected)
        root = W.RECT()
        self.checked(self.u.GetWindowRect(target, C.byref(root)), "target_rect")
        if (root.right - root.left, root.bottom - root.top) != (event["width"], event["height"]):
            raise Blocked("frame_geometry_changed")
        sx, sy = root.left + event["x"], root.top + event["y"]
        for hwnd in controls:
            self.guard(hwnd, expected)
            origin, rect = W.POINT(), W.RECT()
            self.checked(self.u.ClientToScreen(hwnd, C.byref(origin)), "control_origin")
            self.checked(self.u.GetClientRect(hwnd, C.byref(rect)), "control_bounds")
            x, y = sx - origin.x, sy - origin.y
            if 0 <= x < rect.right and 0 <= y < rect.bottom:
                return hwnd, x, y
        raise Blocked("click_outside_supported_controls")

    def capture(self, hwnd, expected, flags=0):
        self.guard(hwnd, expected)
        rect = W.RECT()
        self.checked(self.u.GetWindowRect(hwnd, C.byref(rect)), "window_rect")
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if not (0 < width <= 2048 and 0 < height <= 2048):
            error = Blocked("invalid_capture_geometry")
            error.geometry = {"width": width, "height": height}
            raise error
        dc = self.checked(self.g.CreateCompatibleDC(None), "capture_dc")
        bitmap = previous = None
        try:
            info = BITMAPINFO(size=C.sizeof(BITMAPINFO), width=width, height=-height, planes=1, bits=32)
            bits = C.c_void_p()
            bitmap = self.checked(self.g.CreateDIBSection(dc, C.byref(info), 0, C.byref(bits), None, 0), "capture_bitmap")
            previous = self.checked(self.g.SelectObject(dc, bitmap), "select_bitmap")
            self.checked(self.u.PrintWindow(hwnd, dc, flags), "print_window")
            bgra = C.string_at(bits, width * height * 4)
            rgb = bytearray(width * height * 3)
            rgb[0::3], rgb[1::3], rgb[2::3] = bgra[2::4], bgra[1::4], bgra[0::4]
            return png_rgb(width, height, rgb), {"width": width, "height": height,
                                               "nonuniform": len(set(rgb)) > 1}
        finally:
            if previous: self.g.SelectObject(dc, previous)
            if bitmap: self.g.DeleteObject(bitmap)
            self.g.DeleteDC(dc)
