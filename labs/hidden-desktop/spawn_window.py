"""能力测试目标窗口：一个把自身状态回显在界面上的经典 Win32 表单。

为什么不用现成应用：本子工程的目的是**逐条验证基础能力**，需要"点一下就能看见效果"，
而且要有稳定的 automation_id 供结构化定位。所以这里自建一个目标：

    EDIT       id=queryEdit    —— 验证 act.type / act.set_value / observe.state.read
    BUTTON     id=clickButton  —— 验证 act.click / act.invoke / verify.target.identity
    CHECKBOX   id=flagCheck    —— 验证点击的布尔语义与 set_checked 类语义
    LISTBOX    id=itemList     —— 验证"列表里选第 N 项"这种带索引的定位与点击
    STATIC     id=stateReadout —— **状态回显行**：每次动作后更新

状态回显行是关键：抓一次图就能直接看到动作生效了没有，不需要额外的日志判断。

它继承父进程的窗口站/桌面（父进程用 STARTUPINFO.lpDesktop 指定隐藏桌面），
不主动切换或读取任何桌面，不接受任何输入指令。

两点实测经验（见 README）：
  * STATIC 必须带 WS_BORDER：无边框 STATIC 是透明背景控件，PrintWindow 抓取时长文本只画一小截。
  * 进程要先声明 DPI 感知：抓取方按物理像素取几何，否则图会带一圈空白边。
"""
import ctypes as C
from ctypes import wintypes as W
import sys

user32 = C.WinDLL("user32", use_last_error=True)
kernel32 = C.WinDLL("kernel32", use_last_error=True)

WNDPROC = getattr(C, "WINFUNCTYPE", C.CFUNCTYPE)(C.c_ssize_t, W.HWND, W.UINT, C.c_size_t, C.c_ssize_t)

WS_CHILD = 0x40000000
WS_VISIBLE = 0x10000000
WS_BORDER = 0x00800000
WS_TABSTOP = 0x00010000
WS_OVERLAPPEDWINDOW = 0x00CF0000
WS_VSCROLL = 0x00200000
ES_AUTOHSCROLL = 0x0080
SS_LEFT = 0x00000000
BS_PUSHBUTTON = 0x00000000
BS_AUTOCHECKBOX = 0x00000003
LBS_NOTIFY = 0x0001
LBS_STANDARD = 0x00A00003   # LBS_NOTIFY | WS_VSCROLL | WS_BORDER

COLOR_BTNFACE = 15
PROCESS_PER_MONITOR_DPI_AWARE = 2

WM_DESTROY = 0x0002
WM_COMMAND = 0x0111
EN_CHANGE = 0x0300
BN_CLICKED = 0
LBN_SELCHANGE = 1

LB_ADDSTRING = 0x0180
LB_GETCURSEL = 0x0188
BM_GETCHECK = 0x00F0

STATE_READOUT = 1005
ITEMS = ["单曲A - 测试歌手", "单曲B - 测试歌手", "单曲C - 测试歌手"]

_controls = {}
# LB_ADDSTRING 只接受指针，缓冲区必须活到消息处理完，所以统一保活。
_buffers = []


class WNDCLASS(C.Structure):
    _fields_ = [("style", W.UINT), ("proc", WNDPROC), ("cls_extra", C.c_int), ("wnd_extra", C.c_int),
                ("instance", W.HANDLE), ("icon", W.HANDLE), ("cursor", W.HANDLE),
                ("background", W.HANDLE), ("menu", W.LPCWSTR), ("name", W.LPCWSTR)]


def _name(handle):
    buffer, required = C.create_unicode_buffer(512), W.DWORD()
    if not handle or not user32.GetUserObjectInformationW(
            handle, 2, buffer, C.sizeof(buffer), C.byref(required)):
        return "<unavailable>"
    return buffer.value


def _desktop_name():
    return (_name(user32.GetProcessWindowStation()) + "\\" +
            _name(user32.GetThreadDesktop(kernel32.GetCurrentThreadId())))


def _text(hwnd):
    buffer = C.create_unicode_buffer(1024)
    user32.GetWindowTextW(hwnd, buffer, 1024)
    return buffer.value


def _refresh_readout():
    """把当前控件状态写进回显行 —— 这就是"看得见的效果"。"""
    clicks = _controls.get("clicks", 0)
    text = _text(_controls["queryEdit"]) if "queryEdit" in _controls else ""
    checked = bool(user32.SendMessageW(_controls["flagCheck"], BM_GETCHECK, 0, 0)) \
        if "flagCheck" in _controls else False
    index = user32.SendMessageW(_controls["itemList"], LB_GETCURSEL, 0, 0) \
        if "itemList" in _controls else -1
    shown = text if len(text) <= 40 else text[:37] + "..."
    user32.SetWindowTextW(_controls[STATE_READOUT],
                          "clicks=%d  文本=\"%s\"  勾选=%s  列表选中=%s"
                          % (clicks, shown, "true" if checked else "false",
                             index if index >= 0 else "none"))


def _procedure(hwnd, message, wparam, lparam):
    if message == WM_COMMAND:
        identifier = wparam & 0xFFFF
        notification = (wparam >> 16) & 0xFFFF
        if identifier == 1002 and notification == BN_CLICKED:
            _controls["clicks"] = _controls.get("clicks", 0) + 1
        _refresh_readout()
        return 0
    if message == WM_DESTROY:
        user32.PostQuitMessage(0)
        return 0
    return user32.DefWindowProcW(hwnd, message, wparam, lparam)


# 回调必须保持强引用，否则会被 GC 回收导致窗口过程失效。
_procedure_ref = WNDPROC(_procedure)


def _create(parent, class_name, text, style, x, y, width, height, identifier=None, instance=None):
    control = user32.CreateWindowExW(0, class_name, text, WS_CHILD | WS_VISIBLE | style,
                                     x, y, width, height, parent,
                                     identifier or None, instance, None)
    if not control:
        raise OSError(C.get_last_error(), "create_" + class_name.lower())
    return control


def _wide(text):
    """把字符串转成指针并保活（LB_ADDSTRING 的 lParam 是裸指针）。"""
    buffer = C.create_unicode_buffer(text)
    _buffers.append(buffer)
    return C.cast(buffer, C.c_void_p).value


def _bind_signatures():
    user32.GetProcessWindowStation.restype = W.HANDLE
    user32.GetThreadDesktop.argtypes, user32.GetThreadDesktop.restype = [W.DWORD], W.HANDLE
    user32.GetUserObjectInformationW.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD,
                                                 C.POINTER(W.DWORD)]
    user32.GetUserObjectInformationW.restype = W.BOOL
    user32.DefWindowProcW.argtypes, user32.DefWindowProcW.restype = \
        [W.HWND, W.UINT, C.c_size_t, C.c_ssize_t], C.c_ssize_t
    user32.RegisterClassW.argtypes, user32.RegisterClassW.restype = [C.POINTER(WNDCLASS)], W.WORD
    user32.CreateWindowExW.argtypes = [W.DWORD, W.LPCWSTR, W.LPCWSTR, W.DWORD, C.c_int, C.c_int,
                                       C.c_int, C.c_int, W.HWND, W.HMENU, W.HINSTANCE, C.c_void_p]
    user32.CreateWindowExW.restype = W.HWND
    user32.ShowWindow.argtypes = [W.HWND, C.c_int]
    user32.UpdateWindow.argtypes = [W.HWND]
    user32.GetMessageW.argtypes = [C.POINTER(W.MSG), W.HWND, W.UINT, W.UINT]
    user32.GetMessageW.restype = C.c_int
    user32.TranslateMessage.argtypes = [C.POINTER(W.MSG)]
    user32.DispatchMessageW.argtypes = [C.POINTER(W.MSG)]
    user32.SendMessageW.argtypes = [W.HWND, W.UINT, C.c_size_t, C.c_ssize_t]
    user32.SendMessageW.restype = C.c_ssize_t
    user32.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
    user32.GetWindowTextW.restype = C.c_int
    user32.SetWindowTextW.argtypes = [W.HWND, W.LPCWSTR]
    user32.SetWindowTextW.restype = W.BOOL
    kernel32.GetModuleHandleW.restype = W.HANDLE


def main():
    desktop = _desktop_name()
    title = sys.argv[1] if len(sys.argv) > 1 else ("Capability Test Target — " + desktop)
    pid = kernel32.GetCurrentProcessId()
    class_name = "AgentD0LabTarget%d" % pid

    try:
        shcore = C.WinDLL("shcore", use_last_error=True)
        shcore.SetProcessDpiAwareness.argtypes = [C.c_int]
        shcore.SetProcessDpiAwareness.restype = C.c_long
        shcore.SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE)
    except OSError:
        pass

    _bind_signatures()
    instance = kernel32.GetModuleHandleW(None)

    definition = WNDCLASS(proc=_procedure_ref, name=class_name, instance=instance,
                          background=W.HBRUSH(COLOR_BTNFACE + 1))
    if not user32.RegisterClassW(C.byref(definition)):
        raise OSError(C.get_last_error(), "register_class")

    hwnd = user32.CreateWindowExW(0, class_name, title, WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                                  120, 120, 660, 480, None, None, instance, None)
    if not hwnd:
        raise OSError(C.get_last_error(), "create_window")

    _controls[STATE_READOUT] = _create(hwnd, "STATIC", "clicks=0", WS_BORDER | SS_LEFT,
                                       16, 12, 610, 30, STATE_READOUT, instance)
    _create(hwnd, "STATIC", "desktop : " + desktop, WS_BORDER | SS_LEFT, 16, 50, 610, 26,
            None, instance)
    _create(hwnd, "STATIC", "pid     : %d" % pid, WS_BORDER | SS_LEFT, 16, 82, 610, 26,
            None, instance)
    _create(hwnd, "STATIC", "查询框（act.type / act.set_value 目标）：", WS_BORDER | SS_LEFT,
            16, 122, 610, 26, None, instance)

    _controls["queryEdit"] = _create(hwnd, "EDIT", "", WS_BORDER | ES_AUTOHSCROLL | WS_TABSTOP,
                                     16, 154, 400, 26, 1001, instance)
    _controls["clickButton"] = _create(hwnd, "BUTTON", "点我 (+1)",
                                       BS_PUSHBUTTON | WS_TABSTOP, 430, 154, 190, 26,
                                       1002, instance)
    _controls["flagCheck"] = _create(hwnd, "BUTTON", "启用",
                                     BS_AUTOCHECKBOX | WS_TABSTOP, 16, 190, 190, 26,
                                     1003, instance)
    _create(hwnd, "STATIC", "列表（按索引定位与点击的目标）：", WS_BORDER | SS_LEFT,
            16, 226, 610, 26, None, instance)
    _controls["itemList"] = _create(hwnd, "LISTBOX", "",
                                    LBS_STANDARD | WS_VSCROLL, 16, 258, 610, 120,
                                    1004, instance)
    for item in ITEMS:
        user32.SendMessageW(_controls["itemList"], LB_ADDSTRING, 0, _wide(item))

    _controls["clicks"] = 0
    _refresh_readout()

    user32.ShowWindow(hwnd, 4)   # SW_SHOWNOACTIVATE
    user32.UpdateWindow(hwnd)

    message = W.MSG()
    while user32.GetMessageW(C.byref(message), None, 0, 0) > 0:
        user32.TranslateMessage(C.byref(message))
        user32.DispatchMessageW(C.byref(message))
    return 0


def _wide(text):
    """把字符串转成指针并保活（LB_ADDSTRING 的 lParam 是裸指针）。"""
    buffer = C.create_unicode_buffer(text)
    _buffers.append(buffer)
    return C.cast(buffer, C.c_void_p).value


if __name__ == "__main__":
    sys.exit(main())
