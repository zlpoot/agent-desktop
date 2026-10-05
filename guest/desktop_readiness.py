"""Read-only Windows session and input-desktop readiness probe.

The Worker may be online while the user's desktop is locked or disconnected.
This probe never unlocks a session or switches desktops.
"""

import ctypes
import os
from ctypes import wintypes


def evaluate(session_state, desktop_name):
    if session_state is None:
        reason = "target_session_missing"
    elif session_state != 0:  # WTSActive
        reason = "user_not_logged_in"
    elif desktop_name is None:
        reason = "permission_mismatch"
    elif desktop_name.lower() != "default":
        reason = "desktop_locked"
    else:
        reason = None
    ready = reason is None
    return {
        "ready_for_observation": ready,
        "ready_for_input": ready,
        "blocked_reason": reason,
    }


def probe():
    if os.name != "nt":
        return evaluate(None, None)
    wts = ctypes.WinDLL("wtsapi32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    wts.WTSQuerySessionInformationW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                  wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p),
                                                  ctypes.POINTER(wintypes.DWORD)]
    wts.WTSQuerySessionInformationW.restype = wintypes.BOOL
    wts.WTSFreeMemory.argtypes = [ctypes.c_void_p]
    user32.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user32.OpenInputDesktop.restype = wintypes.HANDLE
    user32.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                  ctypes.c_void_p, wintypes.DWORD,
                                                  ctypes.POINTER(wintypes.DWORD)]
    user32.GetUserObjectInformationW.restype = wintypes.BOOL
    user32.CloseDesktop.argtypes = [wintypes.HANDLE]

    buffer = ctypes.c_void_p()
    size = wintypes.DWORD()
    # WTS_CURRENT_SERVER_HANDLE=0, WTS_CURRENT_SESSION=-1, WTSConnectState=8.
    if not wts.WTSQuerySessionInformationW(None, 0xFFFFFFFF, 8,
                                           ctypes.byref(buffer), ctypes.byref(size)):
        return evaluate(None, None)
    try:
        session_state = (ctypes.cast(buffer, ctypes.POINTER(ctypes.c_int)).contents.value
                         if size.value >= ctypes.sizeof(ctypes.c_int) else None)
    finally:
        wts.WTSFreeMemory(buffer)
    if session_state != 0:
        return evaluate(session_state, None)
    desktop = user32.OpenInputDesktop(0, False, 0x0001)  # DESKTOP_READOBJECTS
    if not desktop:
        if ctypes.get_last_error() == 5:  # secure/lock desktop denied to this process
            return evaluate(session_state, "Winlogon")
        return evaluate(session_state, None)
    try:
        needed = wintypes.DWORD()
        user32.GetUserObjectInformationW(desktop, 2, None, 0, ctypes.byref(needed))  # UOI_NAME
        if not needed.value or needed.value > 1024:
            return evaluate(session_state, None)
        name = ctypes.create_unicode_buffer((needed.value // ctypes.sizeof(ctypes.c_wchar)) + 1)
        if not user32.GetUserObjectInformationW(desktop, 2, name, needed.value,
                                                 ctypes.byref(needed)):
            return evaluate(session_state, None)
        return evaluate(session_state, name.value)
    finally:
        user32.CloseDesktop(desktop)
