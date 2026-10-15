"""Hidden Desktop 打开逻辑的最小、自包含抽取（实验子工程）。

本文件不 import 原工程（src/ / guest/ / spikes/）的任何模块；只读参考了：

  * spikes/local-workspace/win32.py                    —— Api.desktop / job / launch / windows / close
  * src/desktop-provider/workbench_app_worker.py       —— reserve / start / instances / close 生命周期

被保留下来的安全边界（与本抽取一一对应，未做放宽）：

  1. 只创建名为 ``AgentD0_*`` 的自有桌面；创建权限掩码固定 ``0xC3``
     （READOBJECTS | CREATEWINDOW | ENUMERATE | WRITEOBJECTS），**明确不含**
     ``DESKTOP_SWITCHDESKTOP(0x100)``，因此本模块无法切换用户输入桌面。
  2. 启动进程时始终设置 ``STARTUPINFO.lpDesktop = "WinSta0\\<name>"``，并先挂到
     ``KILL_ON_JOB_CLOSE`` 的 Job 再恢复线程，保证句柄关闭即回收整棵进程树。
  3. 每个"打开"动作前都先确认交互会话活跃且输入桌面仍为 ``default``；
     不是 ``default`` 就拒绝，绝不回退到默认桌面或物理桌面。
  4. 清理必须确认桌面对象真的消失（``OpenDesktopW`` 返回 ``ERROR_FILE_NOT_FOUND``），
     否则标记 ``blocked`` 并抛出，不谎报清理成功。

与原工程相比**刻意简化的部分**（已在 README 记录）：

  * 没有后台过期线程，只在每次操作时检查单调时钟 deadline；
    过期**不会**自动释放资源（清理仍然随时可用），需要操作者显式 ``renew()`` 或 ``close()``；
  * 没有 GUI/文件预览捕获以外的上层语义、没有按键注入、没有模型或 Task 概念。

仅纯标准库（ctypes）。``NativeDesktopApi`` 是 Windows-only，显式构造才加载 DLL。
"""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
import hashlib
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import threading
import time
import uuid
import zlib

__all__ = [
    "Blocked",
    "CleanupUnconfirmed",
    "NativeDesktopApi",
    "HiddenDesktop",
    "DESKTOP_ACCESS",
    "NAME_PREFIX",
    "png_rgb",
]

# DESKTOP_READOBJECTS(0x0001) | DESKTOP_CREATEWINDOW(0x0002)
# | DESKTOP_ENUMERATE(0x0040) | DESKTOP_WRITEOBJECTS(0x0080)
# 明确不含 DESKTOP_SWITCHDESKTOP(0x0100)。
DESKTOP_ACCESS = 0xC3
DESKTOP_SWITCHDESKTOP = 0x0100

NAME_PREFIX = "AgentD0_"
DEFAULT_DESKTOP = "default"

# CREATE_SUSPENDED(0x4) | CREATE_NO_WINDOW(0x08000000)
CREATE_FLAGS = 0x08000004
KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_BASIC_ACCOUNTING = 1
JOB_OBJECT_EXTENDED_LIMIT = 9

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TOKEN_USER = 1
TOKEN_SESSION_ID = 12
TOKEN_INTEGRITY_LEVEL = 25
ORDINARY_MEDIUM_INTEGRITY = "S-1-16-8192"

ERROR_FILE_NOT_FOUND = 2
ERROR_ALREADY_EXISTS = 183

LIFETIME_SECONDS = 60
MAX_LIFETIME_SECONDS = 3600
INFINITE = 0xFFFFFFFF


class Blocked(RuntimeError):
    """动作被安全边界拒绝（对应原工程的 policy.Blocked）。"""


class CleanupUnconfirmed(Blocked):
    """清理未确认：句柄/桌面残留在位，后续操作必须停止。"""

    def __init__(self, errors):
        super().__init__("cleanup_unconfirmed")
        self.errors = list(errors)


def validate_desktop_name(name):
    """边界 1 的名称守卫：只允许自有前缀，纯函数，可离线测试。"""
    if not isinstance(name, str) or not name.startswith(NAME_PREFIX):
        raise Blocked("invalid_desktop_name")
    return name


def enable_process_dpi_awareness():
    """把整个进程设为 per-monitor DPI 感知，且**只能成功一次**。

    为什么必须做：本机是 150% 缩放。DPI-unaware 的进程会拿到**虚拟化**坐标
    （UIA 报的控件宽 267，物理其实是 400，正好 1.5 倍），于是"定位到的坐标"和
    "点击用的坐标"分属两个空间，点在非 100% 缩放下必然错位。
    UIA 坐标、GetWindowRect/GetClientRect、点击坐标必须同源，所以统一在进程级解决。
    """
    try:
        shcore = C.WinDLL("shcore", use_last_error=True)
        shcore.SetProcessDpiAwareness.argtypes = [C.c_int]
        shcore.SetProcessDpiAwareness.restype = C.c_long
        result = shcore.SetProcessDpiAwareness(2)      # PROCESS_PER_MONITOR_DPI_AWARE
        return result == 0                              # 已设置过会返回 E_ACCESSDENIED
    except OSError:
        return False                                    # 老系统没有 shcore


# --------------------------------------------------------------------------- #
# Win32 结构与常量
# --------------------------------------------------------------------------- #
UPTR = C.c_size_t
SPTR = C.c_ssize_t
HANDLE = W.HANDLE
TH32CS_SNAPPROCESS = 0x00000002
ENUMPROC = getattr(C, "WINFUNCTYPE", C.CFUNCTYPE)(W.BOOL, W.HWND, SPTR)


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


class BITMAPINFO(C.Structure):
    _fields_ = [("size", W.DWORD), ("width", W.LONG), ("height", W.LONG), ("planes", W.WORD),
                ("bits", W.WORD), ("compression", W.DWORD), ("image_size", W.DWORD),
                ("xppm", W.LONG), ("yppm", W.LONG), ("used", W.DWORD), ("important", W.DWORD)]


class PROCESSENTRY32W(C.Structure):
    """Toolhelp32 进程快照条目（只用到 pid 与映像名）。

    仅用于**只读**判断"目标程序是否已在运行"：单实例应用（CEF 类普遍如此）在已有实例时
    会把启动请求重定向到那个实例，于是我们在自有隐藏桌面上永远拿不到自有窗口。
    """

    _fields_ = [("size", W.DWORD), ("usage", W.DWORD), ("pid", W.DWORD), ("default_heap", UPTR),
                ("module_id", W.DWORD), ("threads", W.DWORD), ("parent_pid", W.DWORD),
                ("priority", W.LONG), ("flags", W.DWORD), ("exe", W.WCHAR * 260)]


def png_rgb(width, height, rgb):
    """纯标准库的最小 PNG 编码器（对应原工程 policy.png_rgb）。"""
    if not (0 < width <= 2048 and 0 < height <= 2048) or len(rgb) != width * height * 3:
        raise ValueError("invalid frame geometry")

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\0" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 1)) + chunk(b"IEND", b""))


# --------------------------------------------------------------------------- #
# Win32 面：只有打开 Hidden Desktop 所需的调用
# --------------------------------------------------------------------------- #
class NativeDesktopApi:
    """user32 / kernel32 / wtsapi32 / advapi32 的最小绑定集合。

    不绑定 ``SetInputDesktop`` / ``SwitchDesktop`` / ``SendInput`` / ``SetCursorPos``
    等任何系统输入或桌面切换入口，从 API 层面排除误用可能。
    """

    def __init__(self):
        # 先统一 DPI 空间，再绑定任何 API：见 enable_process_dpi_awareness 的说明。
        enable_process_dpi_awareness()
        self.u = C.WinDLL("user32", use_last_error=True)
        self.k = C.WinDLL("kernel32", use_last_error=True)
        self.a = C.WinDLL("advapi32", use_last_error=True)
        self.g = C.WinDLL("gdi32", use_last_error=True)
        self.wts = C.WinDLL("wtsapi32", use_last_error=True)

        V, D, I, S, H = C.c_void_p, W.DWORD, C.c_int, W.LPCWSTR, HANDLE

        def bind(dll, name, args, result):
            fn = getattr(dll, name)
            fn.argtypes, fn.restype = args, result

        bind(self.wts, "WTSQuerySessionInformationW", [H, D, I, C.POINTER(V), C.POINTER(D)], W.BOOL)
        bind(self.wts, "WTSFreeMemory", [V], None)

        for name, args, result in [
            ("GetCurrentThreadId", [], D), ("GetCurrentProcessId", [], D),
            ("GetCurrentProcess", [], H), ("GetModuleHandleW", [S], H),
            ("ProcessIdToSessionId", [D, C.POINTER(D)], W.BOOL),
            ("CreateProcessW", [S, W.LPWSTR, V, V, W.BOOL, D, V, S,
                                C.POINTER(STARTUPINFO), C.POINTER(PROCESSINFO)], W.BOOL),
            ("CloseHandle", [H], W.BOOL), ("ResumeThread", [H], D), ("TerminateProcess", [H, I], W.BOOL),
            ("WaitForSingleObject", [H, D], D), ("OpenProcess", [D, W.BOOL, D], H),
            ("IsProcessInJob", [H, H, C.POINTER(W.BOOL)], W.BOOL),
            ("QueryFullProcessImageNameW", [H, D, W.LPWSTR, C.POINTER(D)], W.BOOL),
            ("CreateJobObjectW", [V, S], H), ("SetInformationJobObject", [H, I, V, D], W.BOOL),
            ("AssignProcessToJobObject", [H, H], W.BOOL), ("TerminateJobObject", [H, I], W.BOOL),
            ("QueryInformationJobObject", [H, I, V, D, V], W.BOOL),
            ("CreateToolhelp32Snapshot", [D, D], H),
            ("Process32FirstW", [H, C.POINTER(PROCESSENTRY32W)], W.BOOL),
            ("Process32NextW", [H, C.POINTER(PROCESSENTRY32W)], W.BOOL),
            ("LocalFree", [H], H),
        ]:
            bind(self.k, name, args, result)

        for name, args, result in [
            ("CreateDesktopW", [S, V, V, D, D, V], H), ("OpenDesktopW", [S, D, W.BOOL, D], H),
            ("CloseDesktop", [H], W.BOOL), ("GetThreadDesktop", [D], H), ("SetThreadDesktop", [H], W.BOOL),
            ("GetProcessWindowStation", [], H), ("OpenInputDesktop", [D, W.BOOL, D], H),
            ("GetUserObjectInformationW", [H, I, V, D, C.POINTER(D)], W.BOOL),
            ("EnumDesktopWindows", [H, ENUMPROC, SPTR], W.BOOL),
            ("GetWindowThreadProcessId", [H, C.POINTER(D)], D), ("IsWindow", [H], W.BOOL),
            ("IsWindowVisible", [H], W.BOOL), ("GetAncestor", [H, W.UINT], H),
            ("GetWindowLongW", [H, I], W.LONG), ("GetClassNameW", [H, W.LPWSTR, I], I),
            ("GetWindowRect", [H, C.POINTER(W.RECT)], W.BOOL),
            ("GetClientRect", [H, C.POINTER(W.RECT)], W.BOOL),
            ("ScreenToClient", [H, C.POINTER(W.POINT)], W.BOOL),
            ("SetThreadDpiAwarenessContext", [H], H),
            ("PrintWindow", [H, H, W.UINT], W.BOOL),
            ("ShowWindow", [H, I], W.BOOL), ("IsIconic", [H], W.BOOL),
            ("SetWindowPos", [H, H, I, I, I, I, W.UINT], W.BOOL),
            ("GetWindowTextW", [H, W.LPWSTR, I], I), ("GetWindowTextLengthW", [H], I),
            ("ChildWindowFromPointEx", [H, W.POINT, W.UINT], H),
            ("MapWindowPoints", [H, H, C.POINTER(W.POINT), W.UINT], I),
            ("SendMessageTimeoutW", [H, W.UINT, UPTR, SPTR, W.UINT, W.UINT, C.POINTER(UPTR)], SPTR),
        ]:
            bind(self.u, name, args, result)

        for name, args, result in [
            ("CreateCompatibleDC", [H], H),
            ("CreateDIBSection", [H, C.POINTER(BITMAPINFO), W.UINT, C.POINTER(V), H, D], H),
            ("SelectObject", [H, H], H), ("DeleteObject", [H], W.BOOL), ("DeleteDC", [H], W.BOOL),
        ]:
            bind(self.g, name, args, result)

        bind(self.a, "OpenProcessToken", [H, D, C.POINTER(H)], W.BOOL)
        bind(self.a, "GetTokenInformation", [H, I, V, D, C.POINTER(D)], W.BOOL)
        bind(self.a, "ConvertSidToStringSidW", [V, C.POINTER(W.LPWSTR)], W.BOOL)

    # -- 通用 -------------------------------------------------------------- #
    def checked(self, value, label):
        if not value:
            raise OSError(C.get_last_error(), label)
        return value

    def close_handle(self, handle):
        return bool(self.k.CloseHandle(handle))

    def close_desktop(self, handle):
        return bool(self.u.CloseDesktop(handle))

    def wait(self, handle, milliseconds):
        return self.k.WaitForSingleObject(handle, milliseconds)

    # -- 窗口站 / 桌面名 ---------------------------------------------------- #
    def name(self, handle):
        size = W.DWORD()
        self.u.GetUserObjectInformationW(handle, 2, None, 0, C.byref(size))
        if not 0 < size.value <= 1024:
            raise Blocked("desktop_name_unavailable")
        buf = C.create_unicode_buffer(512)
        self.checked(self.u.GetUserObjectInformationW(handle, 2, buf, C.sizeof(buf), C.byref(size)),
                     "object_name")
        return buf.value

    def station_name(self):
        return self.name(self.u.GetProcessWindowStation())

    def thread_desktop(self):
        return self.u.GetThreadDesktop(self.k.GetCurrentThreadId())

    def thread_desktop_name(self):
        return self.name(self.thread_desktop())

    def set_thread_desktop(self, handle):
        return bool(self.u.SetThreadDesktop(handle))

    def input_desktop(self):
        handle = self.checked(self.u.OpenInputDesktop(0, False, 1), "input_desktop")
        try:
            return self.name(handle)
        finally:
            self.u.CloseDesktop(handle)

    # -- 会话 / 令牌 -------------------------------------------------------- #
    def assert_default(self):
        """拒绝在非活跃交互会话或非 default 输入桌面上执行任何动作。"""
        data, size = C.c_void_p(), W.DWORD()
        # WTS_CURRENT_SESSION = 0xFFFFFFFF, WTSConnectState = 8, WTSActive = 0
        self.checked(self.wts.WTSQuerySessionInformationW(None, 0xFFFFFFFF, 8,
                                                          C.byref(data), C.byref(size)),
                     "active_session_probe")
        try:
            if not data or size.value != C.sizeof(C.c_int) or \
                    C.cast(data, C.POINTER(C.c_int)).contents.value != 0:
                raise Blocked("interactive_session_not_active")
        finally:
            self.wts.WTSFreeMemory(data)
        if self.input_desktop().lower() != DEFAULT_DESKTOP:
            raise Blocked("user_input_desktop_not_default")

    def session(self, pid):
        value = W.DWORD()
        self.checked(self.k.ProcessIdToSessionId(pid, C.byref(value)), "session")
        return value.value

    def token_facts(self, pid):
        """返回 (用户 SID, 会话号, 完整性级别 SID)。"""
        process = self.k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not process:
            raise OSError(C.get_last_error(), "open_process")
        token = HANDLE()
        try:
            self.checked(self.a.OpenProcessToken(process, TOKEN_QUERY, C.byref(token)),
                         "open_process_token")
            session, returned = W.DWORD(), W.DWORD()
            self.checked(self.a.GetTokenInformation(token, TOKEN_SESSION_ID, C.byref(session),
                                                    C.sizeof(session), C.byref(returned)), "token_session")
            return self._sid(token, TOKEN_USER), session.value, self._sid(token, TOKEN_INTEGRITY_LEVEL)
        finally:
            if token:
                self.k.CloseHandle(token)
            self.k.CloseHandle(process)

    def _sid(self, token, info_class):
        need = W.DWORD()
        self.a.GetTokenInformation(token, info_class, None, 0, C.byref(need))
        if not 0 < need.value <= 4096:
            raise Blocked("token_information_unavailable")
        buf = C.create_string_buffer(need.value)
        self.checked(self.a.GetTokenInformation(token, info_class, buf, need.value, C.byref(need)),
                     "token_information")
        # TOKEN_USER / TOKEN_MANDATORY_LABEL 的首字段都是 SID_AND_ATTRIBUTES.Sid。
        sid = C.cast(buf, C.POINTER(C.c_void_p)).contents.value
        text = W.LPWSTR()
        self.checked(self.a.ConvertSidToStringSidW(C.c_void_p(sid), C.byref(text)), "sid_string")
        try:
            return text.value
        finally:
            self.k.LocalFree(text)

    # -- 打开 / 启动 / 枚举 ------------------------------------------------- #
    def create_desktop(self, name):
        validate_desktop_name(name)
        existing = self.u.OpenDesktopW(name, 0, False, 1)
        if existing:
            self.u.CloseDesktop(existing)
            raise Blocked("desktop_already_exists")
        previous = self.u.GetThreadDesktop(self.k.GetCurrentThreadId())
        handle = self.checked(self.u.CreateDesktopW(name, None, None, 0, DESKTOP_ACCESS, None),
                             "create_desktop")
        try:
            # CreateDesktopW 本身不切换调用线程的桌面；这里仍显式恢复，
            # 任何情况下都不让控制线程停留在新桌面上。
            self.checked(self.u.SetThreadDesktop(previous), "restore_controller_thread")
        except BaseException:
            self.u.CloseDesktop(handle)
            raise
        return handle

    def desktop_exists(self, name):
        handle = self.u.OpenDesktopW(name, 0, False, 1)
        if handle:
            self.u.CloseDesktop(handle)
            return True, 0
        return False, C.get_last_error()

    def create_job(self, name):
        C.set_last_error(0)
        handle = self.checked(self.k.CreateJobObjectW(None, name), "create_job")
        if C.get_last_error() == ERROR_ALREADY_EXISTS:
            self.k.CloseHandle(handle)
            raise Blocked("job_already_exists")
        limits = EXTENDED_LIMITS()
        limits.basic.flags = KILL_ON_JOB_CLOSE
        try:
            self.checked(self.k.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT,
                                                        C.byref(limits), C.sizeof(limits)),
                         "job_limits")
        except BaseException:
            self.k.CloseHandle(handle)
            raise
        return handle

    def launch(self, argv, desktop, job):
        startup, process = STARTUPINFO(), PROCESSINFO()
        startup.cb = C.sizeof(startup)
        startup.desktop = "WinSta0\\" + desktop
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(x) for x in argv]))
        self.checked(self.k.CreateProcessW(str(argv[0]), command, None, None, False, CREATE_FLAGS,
                                           None, None, C.byref(startup), C.byref(process)),
                     "create_process")
        try:
            if job:
                self.checked(self.k.AssignProcessToJobObject(job, process.process), "assign_job")
            if self.k.ResumeThread(process.thread) == INFINITE:
                raise OSError(C.get_last_error(), "resume_thread")
        except BaseException:
            self.k.TerminateProcess(process.process, 1)
            self.k.WaitForSingleObject(process.process, 2000)
            self.k.CloseHandle(process.process)
            raise
        finally:
            self.k.CloseHandle(process.thread)
        return process.process, process.pid

    def enum_windows(self, desktop):
        result = []

        @ENUMPROC
        def collect(hwnd, _):
            result.append(int(hwnd))
            return len(result) <= 1024

        C.set_last_error(0)
        ok = self.u.EnumDesktopWindows(desktop, collect, 0)
        error = C.get_last_error()
        # 刚创建、子进程尚未建窗的桌面会返回 FALSE + ERROR_SUCCESS：这是 pending，不是错误。
        if not ok and error == 0 and not result:
            return []
        if not ok or len(result) > 1024:
            raise OSError(error, "enum_desktop")
        return result

    def job_active(self, job):
        accounting = C.create_string_buffer(48)
        self.checked(self.k.QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING,
                                                      accounting, 48, None), "job_accounting")
        return W.DWORD.from_buffer(accounting, 40).value

    def terminate_job(self, job):
        return bool(self.k.TerminateJobObject(job, 1))

    def process_in_job(self, pid, job):
        process = self.k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        in_job = W.BOOL()
        try:
            return bool(process and job and
                        self.k.IsProcessInJob(process, job, C.byref(in_job)) and in_job.value)
        finally:
            if process:
                self.k.CloseHandle(process)

    def process_image(self, handle):
        buf, size = C.create_unicode_buffer(32768), W.DWORD(32768)
        self.checked(self.k.QueryFullProcessImageNameW(handle, 0, buf, C.byref(size)), "process_image")
        return buf.value

    def process_image_of(self, pid):
        """按 pid 取进程镜像路径；取不到返回空串（不抛异常，调用方按只读信息处理）。"""
        handle = self.k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return ""
        try:
            return self.process_image(handle)
        except OSError:
            return ""
        finally:
            self.close_handle(handle)

    def running_image_pids(self, image_name):
        """只读：返回本机（跨会话，按映像名）正在运行的同名进程 pid 列表。

        存在的理由是单实例应用：CEF 类程序检测到已有实例时会把启动请求转交过去，
        新进程立刻退出，于是自有隐藏桌面上永远不会有自有窗口 —— 必须先拒绝，而不是
        启动一个马上消失的进程再报 "找不到窗口"。
        """
        wanted = os.path.basename(image_name).lower()
        snapshot = self.k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snapshot == C.c_void_p(-1).value or not snapshot:
            raise Blocked("process_snapshot_unavailable")
        entry = PROCESSENTRY32W()
        entry.size = C.sizeof(PROCESSENTRY32W)
        pids = []
        try:
            present = self.k.Process32FirstW(snapshot, C.byref(entry))
            while present:
                if entry.exe.lower() == wanted:
                    pids.append(entry.pid)
                present = self.k.Process32NextW(snapshot, C.byref(entry))
        finally:
            self.close_handle(snapshot)
        return pids

    # -- 只读画面抓取 ------------------------------------------------------- #
    def capture_dpi(self):
        """PrintWindow 画的是物理像素；把本线程 DPI 感知设成 per-monitor v2，
        以免高 DPI 窗口被裁进虚拟化边界。"""
        self.checked(self.u.SetThreadDpiAwarenessContext(-4), "capture_thread_dpi")

    def capture_window(self, hwnd, flags=2):
        """用 PrintWindow 抓窗口自身像素（PW_RENDERFULLCONTENT）。

        只产生像素，不发送任何输入：没有 SetCursorPos / SendInput / 消息注入。
        返回 (width, height, rgb_bytes, nonuniform)。
        """
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
            info = BITMAPINFO(size=C.sizeof(BITMAPINFO), width=width, height=-height,
                              planes=1, bits=32)
            bits = C.c_void_p()
            bitmap = self.checked(self.g.CreateDIBSection(dc, C.byref(info), 0, C.byref(bits), None, 0),
                                  "capture_bitmap")
            previous = self.checked(self.g.SelectObject(dc, bitmap), "select_bitmap")
            self.checked(self.u.PrintWindow(hwnd, dc, flags), "print_window")
            bgra = C.string_at(bits, width * height * 4)
            rgb = bytearray(width * height * 3)
            rgb[0::3], rgb[1::3], rgb[2::3] = bgra[2::4], bgra[1::4], bgra[0::4]
            return width, height, bytes(rgb), len(set(rgb)) > 1
        finally:
            if previous:
                self.g.SelectObject(dc, previous)
            if bitmap:
                self.g.DeleteObject(bitmap)
            self.g.DeleteDC(dc)


# --------------------------------------------------------------------------- #
# 生命周期：打开 -> 启动 -> 枚举 -> 清理
# --------------------------------------------------------------------------- #
    # -- 只读窗口属性 ------------------------------------------------------- #
    def window_pid(self, hwnd):
        pid = W.DWORD()
        tid = self.u.GetWindowThreadProcessId(hwnd, C.byref(pid))
        if not tid or not self.u.IsWindow(hwnd):
            return 0
        return pid.value

    def is_window(self, hwnd):
        return bool(self.u.IsWindow(hwnd))

    def is_window_visible(self, hwnd):
        return bool(self.u.IsWindowVisible(hwnd))

    def is_root_window(self, hwnd):
        return self.u.GetAncestor(hwnd, 2) == hwnd  # GA_ROOT

    def window_class(self, hwnd):
        buf = C.create_unicode_buffer(256)
        if not self.u.GetClassNameW(hwnd, buf, 256):
            raise Blocked("window_class_unavailable")
        return buf.value

    def window_ex_style(self, hwnd):
        C.set_last_error(0)
        value = self.u.GetWindowLongW(hwnd, -20)  # GWL_EXSTYLE
        error = C.get_last_error()
        if not value and error:
            raise Blocked("window_style_unavailable")
        return value

    def send(self, hwnd, message, wparam=0, lparam=0):
        """向指定窗口发一条消息（SMTO_ABORTIFHUNG | SMTO_NOTIMEOUTIFNOTHUNG，500ms）。

        这是"定向窗口消息"的底层原语：目标只有一个 HWND，不使用系统键鼠、不改前台。
        """
        result = UPTR()
        self.checked(self.u.SendMessageTimeoutW(hwnd, message, wparam, lparam, 0x22, 500,
                                                C.byref(result)), "message_timeout")
        return result.value

    def window_rect(self, hwnd):
        rect = W.RECT()
        self.checked(self.u.GetWindowRect(hwnd, C.byref(rect)), "window_rect")
        return [rect.left, rect.top, rect.right, rect.bottom]

    def window_title(self, hwnd):
        length = self.u.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return ""
        buf = C.create_unicode_buffer(length + 1)
        self.u.GetWindowTextW(hwnd, buf, length + 1)
        return buf.value

    def is_minimized(self, hwnd):
        return bool(self.u.IsIconic(hwnd))

    # -- 自有窗口的显示与定尺（只动自有窗口，不激活、不改 Z 序） ------------ #
    def show_no_activate(self, hwnd):
        """SW_SHOWNOACTIVATE：把窗口显示出来，但不抢前台、不激活它。"""
        return bool(self.u.ShowWindow(hwnd, 4))

    def place_no_activate(self, hwnd, x, y, width, height):
        """SWP_NOZORDER | SWP_NOACTIVATE：只改自有窗口的几何，不动 Z 序与前台。"""
        return bool(self.u.SetWindowPos(hwnd, None, x, y, width, height, 0x14))

    def deepest_child_at(self, hwnd, x, y, max_depth=16):
        """沿窗口树按坐标下钻到最深的子窗口，返回 (叶子窗口, 叶子客户区坐标)。

        **纯结构判定，不依赖任何窗口类名**：连续用 ChildWindowFromPointEx 取包含该点的
        子窗口，并用 MapWindowPoints 逐层换算坐标。CEF / Electron 这类应用的真实输入
        接收者是渲染子窗口（实测某播放器为 目标窗口 → CefBrowserWindow →
        Chrome_WidgetWin_0 → Chrome_RenderWidgetHostHWND），把消息发给外层窗口不会生效。

        注意不要把 MapWindowPoints 的返回值当成功判据：父子窗口屏幕位置相同时偏移为 (0,0)，
        它合法地返回 0。安全性改由调用方对叶子窗口做归属校验（assert_target）保证。
        """
        current, point = hwnd, (int(x), int(y))
        for _ in range(max_depth):
            legacy = W.POINT(point[0], point[1])
            child = self.u.ChildWindowFromPointEx(current, legacy, 0)
            if not child or child == current:
                break
            local = W.POINT(point[0], point[1])
            self.u.MapWindowPoints(current, child, C.byref(local), 1)
            # 坐标没变不能当成"到底了"：CEF 的父子窗口屏幕位置完全重合，坐标自然不变，
            # 而真正的输入接收者还在更深处。终止条件只能是 ChildWindowFromPointEx 返回自己。
            current, point = child, (local.x, local.y)
        return current, point

    def client_rect(self, hwnd):
        rect = W.RECT()
        self.checked(self.u.GetClientRect(hwnd, C.byref(rect)), "client_rect")
        return [rect.left, rect.top, rect.right, rect.bottom]

    def screen_to_client(self, hwnd, x, y):
        point = W.POINT(x, y)
        self.checked(self.u.ScreenToClient(hwnd, C.byref(point)), "screen_to_client")
        return point.x, point.y



class HiddenDesktop:
    """一次"打开 Hidden Desktop 并启动自有进程"的完整生命周期。

    ``api`` 可注入，便于离线合成测试；默认使用真实 ``NativeDesktopApi``。
    """

    def __init__(self, api=None, clock=time.monotonic, sleep=time.sleep, lifetime=LIFETIME_SECONDS):
        self.api = api if api is not None else NativeDesktopApi()
        self.clock = clock
        self.sleep = sleep
        self.lifetime = lifetime
        self.name = None
        self.desktop = None
        self.job = None
        self.process = None
        self.pid = None
        self.context = None
        self.deadline = None
        self.blocked = False
        # 已选定的目标窗口：真实应用（CEF 类）会建出十几个顶层窗口，靠"自动唯一"选不准，
        # 必须由调用方按界面结构显式选定一次，之后所有动作都作用在这个窗口上。
        self.target = None
        # 画面抓取：每个实例一个私有临时目录，只写随机 token 命名的 PNG，
        # 绝不接受调用方给的路径或 URL。
        self.preview_dir = None
        self.preview_files = set()
        self._preview_lock = threading.RLock()
        self._capture_stamp = 0

    # -- 上下文管理 -------------------------------------------------------- #
    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *_):
        self.close()
        return False

    # -- 打开 -------------------------------------------------------------- #
    def open(self):
        if self.blocked:
            raise Blocked("cleanup_unconfirmed")
        if self.context:
            return self.context
        # 边界 3：先确认交互会话活跃、输入桌面仍是 default，再动任何资源。
        self.api.assert_default()
        integrity = self.api.token_facts(os.getpid())[2]
        if integrity != ORDINARY_MEDIUM_INTEGRITY:
            raise Blocked("ordinary_medium_required")
        # 边界 1：名称前缀受限，权限掩码不含 SWITCHDESKTOP。
        self.name = NAME_PREFIX + uuid.uuid4().hex
        try:
            self.desktop = self.api.create_desktop(self.name)
            self.job = self.api.create_job(self.name + "_job")
        except BaseException:
            self.close()
            raise
        self.deadline = self.clock() + self.lifetime
        self.context = {
            "scope": "hidden-desktop-lab",
            "desktop": self.api.station_name() + "\\" + self.name,
            "name": self.name,
            "session": self.api.session(os.getpid()),
            "instanceId": uuid.uuid4().hex,
        }
        return self.context

    # -- 启动 -------------------------------------------------------------- #
    def start(self, executable, args=()):
        self._assert_open()
        if self.process:
            raise Blocked("already_started")
        path = os.path.abspath(executable)
        # 边界 2：只接受直接 exe，不接受 shell / 参数透传的包装器。
        if not path.lower().endswith(".exe") or not os.path.isfile(path):
            raise Blocked("invalid_executable")
        self.process, self.pid = self.api.launch([path, *(str(a) for a in args)], self.name, self.job)
        return self.pid

    # -- 枚举 -------------------------------------------------------------- #
    def windows(self):
        """在自有隐藏桌面上枚举窗口；调用线程在使用期间绑定到该桌面。"""
        self._assert_open()
        previous = self.api.thread_desktop()
        try:
            if not self.api.set_thread_desktop(self.desktop):
                raise Blocked("hidden_desktop_bind_failed")
            if self.api.thread_desktop_name() != self.name:
                raise Blocked("hidden_desktop_bind_unconfirmed")
            return self.api.enum_windows(self.desktop)
        finally:
            self.api.set_thread_desktop(previous)
            if self.api.thread_desktop_name().lower() != DEFAULT_DESKTOP:
                self.blocked = True
                raise Blocked("default_restore_unconfirmed")

    def main_windows(self):
        """自有进程在自有隐藏桌面上的唯一主窗口（只读判定，不产生任何输入）。"""
        self._assert_open()
        if not self.process:
            return []
        result = []
        for hwnd in self.windows():
            if self.api.window_pid(hwnd) != self.pid:
                continue
            if not self.api.is_window_visible(hwnd) or not self.api.is_root_window(hwnd):
                continue
            if self.api.window_ex_style(hwnd) & (0x80 | 0x08000000):  # TOOLWINDOW | NOACTIVATE
                continue
            if not self.api.window_class(hwnd):
                continue
            result.append(hwnd)
        return result

    # -- 自有窗口的候选集、目标选定、显示与定尺 ---------------------------- #
    def owned_windows(self):
        """自有进程树在自有隐藏桌面上的**全部**顶层窗口（候选集）。

        与 ``main_windows`` 的区别：这里**不做可见性/样式过滤**，也**不要求 pid 等于启动器**——
        真实应用普遍是多进程（CEF / Electron / Chromium），界面窗口常由子进程承载，
        唯一可靠的归属判据是"进程属于本次 Job"。过滤交给调用方按界面结构显式选择。
        """
        self._assert_open()
        if not self.process:
            return []
        result = []
        for hwnd in self.windows():
            pid = self.api.window_pid(hwnd)
            if not pid or not self.api.process_in_job(pid, self.job):
                continue
            if not self.api.is_root_window(hwnd) or not self.api.window_class(hwnd):
                continue
            result.append(hwnd)
        return result

    def describe_window(self, hwnd):
        """只读：一个自有窗口的结构描述，供调用方按界面结构选择。"""
        return {
            "hwnd": hwnd,
            "pid": self.api.window_pid(hwnd),
            "className": self.api.window_class(hwnd),
            "title": self.api.window_title(hwnd),
            "visible": self.api.is_window_visible(hwnd),
            "minimized": self.api.is_minimized(hwnd),
            "exStyle": hex(self.api.window_ex_style(hwnd)),
            "rect": self.api.window_rect(hwnd),
            "client": self.api.client_rect(hwnd),
            "inJob": self.api.process_in_job(self.api.window_pid(hwnd), self.job),
        }

    def select_target(self, spec):
        """按界面结构选定目标窗口；**唯一匹配是硬门槛**，含糊一律拒绝。

        spec: {"kind": "className"|"title"|"largest"|"hwnd", "value": str}
        """
        self._assert_open()
        candidates = [self.describe_window(hwnd) for hwnd in self.owned_windows()]
        if not candidates:
            raise Blocked("target_windows_absent")
        kind = (spec or {}).get("kind") or "largest"
        value = (spec or {}).get("value") or ""
        if kind == "className":
            found = [w for w in candidates if w["className"] == value]
        elif kind == "title":
            found = [w for w in candidates if value and value in w["title"]]
        elif kind == "hwnd":
            try:
                wanted = int(str(value), 0)
            except ValueError:
                raise Blocked("unsupported_locator")
            found = [w for w in candidates if w["hwnd"] == wanted]
        elif kind == "largest":
            areas = sorted(((w["rect"][2] - w["rect"][0]) * (w["rect"][3] - w["rect"][1]), w["hwnd"])
                           for w in candidates)
            if not areas or areas[-1][0] <= 0:
                raise Blocked("target_windows_absent")
            # 最大面积必须严格唯一：并列说明选不准，停下来而不是任取一个。
            if len(areas) > 1 and areas[-1][0] == areas[-2][0]:
                raise Blocked("target_not_unique")
            found = [w for w in candidates if w["hwnd"] == areas[-1][1]]
        else:
            raise Blocked("unsupported_locator")
        if len(found) != 1:
            raise Blocked("target_not_unique")
        self.target = found[0]["hwnd"]
        return {"target": self.target, "window": found[0], "considered": len(candidates)}

    def target_window(self):
        """解析当前目标窗口：优先已显式选定的，否则要求"自动唯一"。"""
        self._assert_open()
        if self.target:
            if self.target not in self.owned_windows():
                self.target = None
                raise Blocked("target_desktop_mismatch")
            return self.target, "explicit"
        windows = self.main_windows()
        if len(windows) != 1:
            raise Blocked("target_not_unique")
        return windows[0], "auto"

    OWNED_WINDOW_MIN = (400, 300)
    OWNED_WINDOW_MAX = (2048, 2048)

    def present_window(self, hwnd, width=1600, height=1000, origin=(50, 50)):
        """把自有窗口显示出来并定尺到可用几何。

        ``ShowWindow(SW_SHOWNOACTIVATE)`` + ``SetWindowPos(SWP_NOZORDER | SWP_NOACTIVATE)``：
        只改自有隐藏窗口自己的显示状态与几何，不抢前台、不动 Z 序、不碰用户桌面。

        为什么需要它：真实应用界面窗口的尺寸与位置由应用自己决定，且初始形态不一定可用
        （实测某 CEF 音乐播放器启动瞬间的界面窗口是 32×32 且不可见，约 2.8 秒后才自己变为
        可见的 1601×1128）。抓图与点击坐标都依赖几何，所以"几何由调用方给定"比"碰运气等它
        自己长成合适大小"可靠。
        """
        # 与 UIA、PrintWindow 统一物理像素坐标，不能由此前在哪条线程抓图决定。
        self.api.capture_dpi()
        self.assert_target(hwnd)
        minimum = self.OWNED_WINDOW_MIN
        maximum = self.OWNED_WINDOW_MAX
        if not (minimum[0] <= width <= maximum[0] and minimum[1] <= height <= maximum[1]):
            raise Blocked("owned_window_size_budget")
        before = self.describe_window(hwnd)
        self.api.show_no_activate(hwnd)
        self.api.place_no_activate(hwnd, origin[0], origin[1], width, height)
        after = self.describe_window(hwnd)
        left, top, right, bottom = after['rect']
        if (right-left, bottom-top) != (width, height):
            raise Blocked('owned_window_geometry_not_applied')
        return {"before": before, "after": after,
                "sizeBudget": {"min": list(minimum), "max": list(maximum)}}

    def identity(self, hwnd):
        """只读身份核对：桌面成员、归属本次 Job、同用户同会话、镜像路径。"""
        if hwnd not in self.windows():
            raise Blocked("target_desktop_mismatch")
        pid = self.api.window_pid(hwnd)
        if not pid:
            raise Blocked("target_exited")
        # 归属判据是 Job 成员，不是 pid 等于启动器：多进程应用（CEF/Electron）的界面窗口
        # 常由子进程承载，用 pid 相等会把合法目标误判成外来窗口。
        if not self.api.process_in_job(pid, self.job):
            raise Blocked("target_outside_owned_job")
        parent = self.api.token_facts(os.getpid())
        child = self.api.token_facts(pid)
        # 子进程的镜像路径要按它自己的 pid 取：多进程应用里界面窗口的持有者未必是启动器。
        read_image = getattr(self.api, "process_image_of", None)
        image = read_image(pid) if read_image else ""
        return {
            "alive": True,
            "pid": pid,
            "desktop": self.context["desktop"],
            "session": self.api.session(pid),
            "inJob": True,
            "sameUser": parent[0] == child[0],
            "sameSession": parent[1] == child[1],
            "image": image,
            "launcherPid": self.pid,
        }

    def verify(self):
        """只读验收：默认桌面未被切换，且自有进程确实在自有隐藏桌面上。"""
        self._assert_open()
        self.api.assert_default()
        windows = self.main_windows()
        verdict = {
            "defaultUntouched": True,
            "desktop": self.context["desktop"] if self.context else None,
            "mainWindowCount": len(windows),
            "confirmed": False,
        }
        if len(windows) != 1:
            return verdict
        facts = self.identity(windows[0])
        verdict.update(facts)
        verdict["confirmed"] = bool(
            facts["inJob"] and facts["sameUser"] and facts["sameSession"]
            and facts["session"] == self.context["session"]
        )
        return verdict

    # -- 目标守卫与定向动作 ------------------------------------------------ #
    def assert_target(self, hwnd):
        """轻量目标守卫：目标必须是自有隐藏桌面上的自有进程窗口。

        同时接受**顶层窗口**和**子控件**：`EnumDesktopWindows` 只枚举顶层窗口，
        子控件的判据是"根祖先在自有桌面的窗口集合里"。两者都必须同进程同 Job。
        高频只读读取和每次输入前都会调用它；失败一律 fail-closed，不回退其它窗口或桌面。
        """
        self._assert_open()
        pid = self.api.window_pid(hwnd)
        if not pid:
            raise Blocked("target_exited")
        # 归属判据是"进程属于本次 Job"，不是"pid 等于启动器"：真实多进程应用
        # （CEF / Electron）的界面窗口由子进程承载，用 pid 相等会误拒合法目标。
        if not self.api.process_in_job(pid, self.job):
            raise Blocked("target_outside_owned_job")
        known = self.windows()
        if hwnd in known:
            return hwnd
        root = self.api.u.GetAncestor(hwnd, 2)          # GA_ROOT
        if not root or root not in known:
            raise Blocked("target_desktop_mismatch")
        return hwnd

    def route_input(self, hwnd, x, y):
        """把"目标窗口客户区坐标"换算到真正接收输入的叶子窗口上。

        真实应用（CEF / Electron / Chromium）的输入接收者往往不是外层窗口，而是渲染子窗口
        （实测：目标窗口 → CefBrowserWindow → Chrome_WidgetWin_0 → Chrome_RenderWidgetHostHWND）。
        发给外层窗口的结果是"消息发出去了但界面毫无变化"——比报错更糟，因为看起来像成功。
        用窗口树 + 坐标下钻，不依赖任何窗口类名。
        """
        self.assert_target(hwnd)
        leaf, local = self.api.deepest_child_at(hwnd, x, y)
        if leaf == hwnd:
            return hwnd, x, y
        # 叶子必须是本次 Job 的窗口、且根祖先仍在自有桌面上，否则拒绝下钻。
        self.assert_target(leaf)
        return leaf, local[0], local[1]

    def click(self, hwnd, x, y, double=False):
        """向目标窗口发一次左键点击（坐标为**该窗口客户区**坐标）。

        机制是定向窗口消息，不是系统鼠标：没有 SetCursorPos、没有 SendInput、不激活窗口。
        经典 Win32 控件的点击必须发给控件自己的 HWND；CEF 类应用必须发给渲染子窗口。
        两者都由 route_input 按窗口树结构决定，不做窗口类名特判。
        """
        self.assert_target(hwnd)
        target, x, y = self.route_input(hwnd, x, y)
        left, top, right, bottom = self.api.client_rect(target)
        if not (0 <= x < right and 0 <= y < bottom):
            raise Blocked("click_outside_target")
        position = (x & 0xFFFF) | ((y & 0xFFFF) << 16)
        messages = [(0x0200, 0), (0x0201, 1), (0x0202, 0)]        # MOVE / LBUTTONDOWN / LBUTTONUP
        if double:
            messages += [(0x0203, 1), (0x0202, 0)]                # LBUTTONDBLCLK / LBUTTONUP
        try:
            for message, buttons in messages:
                self.assert_target(target)
                self.api.send(target, message, buttons, position)
        finally:
            self.cancel_owned_input(target)
        return {"dispatched": True, "target": hwnd, "inputWindow": target,
                "x": x, "y": y, "double": bool(double)}

    def type_text(self, hwnd, text, point=None):
        """用 WM_CHAR 逐字把文本送进目标窗口（定向输入，不经过键盘与 IME）。

        给了 point（目标窗口客户区坐标）时会先下钻到该点下真正的输入接收窗口再逐字发送；
        不给则直接发给 hwnd。CEF 类应用必须走前者，否则消息被外层窗口吞掉。
        """
        self.assert_target(hwnd)
        target, _x, _y = self.route_input(hwnd, *point) if point else (hwnd, None, None)
        for character in text:
            self.assert_target(target)
            self.api.send(target, 0x0102, ord(character), 1)      # WM_CHAR
        return {"dispatched": True, "length": len(text), "inputWindow": target}

    def cancel_owned_input(self, hwnd):
        """WM_CANCELMODE：清掉目标窗口内可能持有的鼠标捕获等状态，属于目标局部清理。"""
        if not hwnd or not self.api.is_window(hwnd):
            return {"cancelled": False}
        self.api.send(hwnd, 0x001F)
        return {"cancelled": True}

    # -- 查看隐藏窗口画面 --------------------------------------------------- #
    def capture(self, hwnd=None, allow_unrendered=False):
        with self._preview_lock:
            return self._capture_file(hwnd, allow_unrendered)

    def capture_frame(self, hwnd=None, allow_unrendered=False):
        """同一隔离/尺寸边界的内存帧；不创建证据传输文件。"""
        with self._preview_lock:
            return self._capture_frame(hwnd, allow_unrendered)

    def _capture_frame(self, hwnd=None, allow_unrendered=False):
        """抓取自有隐藏窗口的画面，返回元数据；PNG 落在私有目录里，只暴露 token。

        边界：抓取前必须确认默认桌面未被切换、目标在自有隐藏桌面上且属于自有进程、
        窗口几何在 2048 上限内。默认拒绝"未渲染"（PrintWindow 返回单色）的画面。
        """
        self._assert_open()
        instance = self.context['instanceId']
        if not self.process:
            raise Blocked("capture_requires_owned_process")
        # 显式选定的目标优先：真实应用常常同时有多个合格顶层窗口，
        # 只按"自动唯一"重算会忽略调用方的选择，甚至在窗口变多时直接失败。
        target = hwnd if hwnd is not None else self.target_window()[0]
        facts = self.identity(target)
        if not (facts["inJob"] and facts["sameUser"] and facts["sameSession"]):
            raise Blocked("capture_ownership_unconfirmed")
        self.api.assert_default()
        self.api.capture_dpi()
        width, height, rgb, nonuniform = self.api.capture_window(target)
        if not nonuniform and not allow_unrendered:
            raise Blocked("preview_unrendered")
        image = png_rgb(width, height, rgb)
        if len(image) > 4194304:
            raise Blocked("preview_size_limit")
        # 抓取期间也不能换成另一实例或窗口；清理通过同一把锁与抓图互斥。
        after = self.identity(target)
        if self.context['instanceId'] != instance or any(after[k] != facts[k] for k in
                ('pid', 'session', 'desktop', 'inJob', 'sameUser', 'sameSession')):
            raise Blocked('preview_identity_changed')
        if hwnd is None and self.target_window()[0] != target:
            raise Blocked('preview_identity_changed')
        self._assert_open()
        self.api.assert_default()
        self._capture_stamp = max(time.time_ns(), self._capture_stamp + 1)
        return {"token": uuid.uuid4().hex, "sha256": hashlib.sha256(image).hexdigest(),
                "width": width, "height": height, "bytes": len(image),
                "unrendered": not nonuniform, 'instanceId': instance,
                'capturedAtNs': self._capture_stamp,
                "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "hwnd": target, "pid": facts["pid"]}, image

    def _capture_file(self, hwnd, allow_unrendered):
        info, image = self._capture_frame(hwnd, allow_unrendered)
        self.preview_files = {path for path in self.preview_files if path.exists()}
        if len(self.preview_files) >= 8:
            raise Blocked("preview_pending_limit")
        if self.preview_dir is None:
            self.preview_dir = Path(tempfile.mkdtemp(prefix="hidden-desktop-preview-"))
        token = info['token']
        path = self.preview_dir / (token + ".png")
        with path.open("xb") as stream:      # 独占创建，绝不覆盖
            stream.write(image)
        self.preview_files.add(path)
        return info

    def consume_preview(self, info):
        """像 Host 读取 worker 截图一样校验并消费传输文件，配额保持 8。"""
        with self._preview_lock:
            path = self.preview_path(info['token'])
            if path.is_symlink() or not path.is_file():
                raise Blocked('preview_path_escape')
            with path.open('rb') as stream:
                image = stream.read(4194305)
            if not 0 < len(image) <= 4194304 or len(image) != info['bytes'] \
                    or hashlib.sha256(image).hexdigest() != info['sha256']:
                raise Blocked('preview_integrity_failed')
            path.unlink()
            self.preview_files.discard(path)
            return image

    def preview_path(self, token):
        """把 token 解析为私有目录内的 PNG 路径；拒绝一切越界或非法 token。"""
        if not isinstance(token, str) or len(token) != 32 or \
                any(character not in "0123456789abcdef" for character in token):
            raise Blocked("invalid_preview_token")
        if self.preview_dir is None:
            raise Blocked("preview_unavailable")
        candidates = [path for path in self.preview_files if path.name == token + ".png"]
        if not candidates:
            raise Blocked("preview_not_found")
        path = candidates[0]
        # token 是我们自己生成的，仍显式断言它没跑出私有目录。
        if path.parent.resolve() != Path(self.preview_dir).resolve() or path.suffix != ".png":
            raise Blocked("preview_path_escape")
        return path

    # -- 清理 -------------------------------------------------------------- #
    def close(self):
        with self._preview_lock:
            return self._close()

    def _close(self):
        errors = []
        if self.job:
            try:
                self.api.terminate_job(self.job)
                until = self.clock() + 3
                while self.api.job_active(self.job) and self.clock() < until:
                    self.sleep(0.02)
                active = self.api.job_active(self.job)
                if active:
                    errors.append({"step": "job-not-empty", "activeProcesses": active})
            except Exception:
                errors.append({"step": "terminate"})
        for key in ("process", "job"):
            handle = getattr(self, key)
            if handle:
                try:
                    if self.api.close_handle(handle):
                        setattr(self, key, None)
                    else:
                        errors.append({"step": key + "-close"})
                except Exception:
                    errors.append({"step": key + "-close"})
        if self.desktop:
            desktop, self.desktop = self.desktop, None
            try:
                if not self.api.close_desktop(desktop):
                    errors.append({"step": "desktop-close"})
            except Exception:
                errors.append({"step": "desktop-close"})
            # 边界 4：必须确认桌面对象消失，否则不算清理成功。
            until = self.clock() + 1
            while True:
                exists, error = self.api.desktop_exists(self.name)
                if exists:
                    if self.clock() >= until:
                        errors.append({"step": "desktop-present"})
                        break
                    self.sleep(0.02)
                    continue
                if error != ERROR_FILE_NOT_FOUND:
                    errors.append({"step": "desktop-absence-unconfirmed", "winerror": error})
                break
        self.context = None
        self.pid = None
        self.process = None
        self.name = None
        for path in tuple(self.preview_files):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        self.preview_files.clear()
        if self.preview_dir is not None:
            try:
                Path(self.preview_dir).rmdir()
            except OSError:
                pass
            self.preview_dir = None
        try:
            self.api.assert_default()
        except Exception:
            errors.append({"step": "default-desktop-unconfirmed"})
        if errors:
            self.blocked = True
            raise CleanupUnconfirmed(errors)
        return {"cleaned": True}

    # -- 租约 -------------------------------------------------------------- #
    def remaining(self):
        """距租约到期还有多少秒；未打开返回 None，已过期返回 0。"""
        if not self.context or self.deadline is None:
            return None
        return max(0.0, self.deadline - self.clock())

    def renew(self, seconds=None):
        """显式续租：把 deadline 推到 now + lifetime。

        过期之后**仍然可以续租**（这正是它的用途），但已封锁或未打开时拒绝。
        续租是操作者的显式动作，不做任何静默自动续期。
        """
        if self.blocked:
            raise Blocked("cleanup_unconfirmed")
        if not self.desktop or not self.job or not self.context:
            raise Blocked("hidden_desktop_not_open")
        if seconds is not None:
            if type(seconds) is not int or not 0 < seconds <= MAX_LIFETIME_SECONDS:
                raise Blocked("invalid_lease_seconds")
            self.lifetime = seconds
        self.deadline = self.clock() + self.lifetime
        return {"leaseSeconds": self.lifetime, "remaining": self.remaining()}

    # -- 内部 -------------------------------------------------------------- #
    def _assert_open(self):
        if self.blocked:
            raise Blocked("cleanup_unconfirmed")
        if not self.desktop or not self.job or not self.context:
            raise Blocked("hidden_desktop_not_open")
        if self.deadline is not None and self.clock() >= self.deadline:
            raise Blocked("hidden_desktop_lease_expired")
