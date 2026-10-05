"""Synthetic native Win32 controls; no desktop input or personal data."""
import ctypes as C
from ctypes import wintypes as W
from win32 import Api, WNDCLASS, WNDPROC


def main():
    api = Api()
    controls = {}
    counts = {"ticks": 0, "clicks": 0}
    instance = api.k.GetModuleHandleW(None)

    @WNDPROC
    def procedure(hwnd, message, wparam, lparam):
        if message == 0x0001:  # WM_CREATE
            for key, klass, text, style, y, identifier in (
                ("edit", "EDIT", "", 0x50800080, 35, 1001),
                ("button", "BUTTON", "Synthetic click", 0x50000000, 85, 1002),
                ("status", "STATIC", "Clicks: 0", 0x50000000, 135, 1003),
                ("tick", "STATIC", "Frame: 0", 0x50000000, 185, 1004),
            ):
                controls[key] = api.checked(api.u.CreateWindowExW(0, klass, text, style, 30, y, 450, 32,
                                                                  hwnd, identifier, instance, None), "fixture_control")
            api.checked(api.u.SetTimer(hwnd, 1, 200, None), "fixture_timer")
            return 0
        if message == 0x0111 and (wparam & 0xFFFF) == 1002 and (wparam >> 16) == 0:
            counts["clicks"] += 1
            api.u.SetWindowTextW(controls["status"], "Clicks: " + str(counts["clicks"]))
            return 0
        if message == 0x0113:
            counts["ticks"] += 1
            api.u.SetWindowTextW(controls["tick"], "Frame: " + str(counts["ticks"]))
            return 0
        if message == 0x0010:
            api.u.DestroyWindow(hwnd)
            return 0
        if message == 0x0002:
            api.u.PostQuitMessage(0)
            return 0
        return api.u.DefWindowProcW(hwnd, message, wparam, lparam)

    klass = WNDCLASS(proc=procedure, instance=instance, background=6, name="AgentD0Fixture")
    api.checked(api.u.RegisterClassW(C.byref(klass)), "fixture_class")
    hwnd = api.checked(api.u.CreateWindowExW(0, klass.name, "D0 synthetic Win32 fixture", 0x00CF0000,
                                            40, 40, 560, 310, None, None, instance, None), "fixture_window")
    api.u.ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE, on the hidden Desktop only.
    api.u.UpdateWindow(hwnd)
    message = W.MSG()
    while True:
        result = api.u.GetMessageW(C.byref(message), None, 0, 0)
        if result == -1:
            raise OSError(C.get_last_error(), "fixture_message_loop")
        if result == 0:
            break
        api.u.TranslateMessage(C.byref(message))
        api.u.DispatchMessageW(C.byref(message))


if __name__ == "__main__":
    main()
