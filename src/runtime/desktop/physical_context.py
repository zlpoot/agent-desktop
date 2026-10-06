"""Read-only Windows input-desktop identity for the managed local Worker."""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import socket


def physical_context(instance_id):
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.GetProcessWindowStation.restype = wintypes.HANDLE
    user32.GetThreadDesktop.argtypes = [wintypes.DWORD]
    user32.GetThreadDesktop.restype = wintypes.HANDLE
    user32.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user32.OpenInputDesktop.restype = wintypes.HANDLE
    user32.CloseDesktop.argtypes = [wintypes.HANDLE]
    user32.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                               ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]

    def name(handle):
        buffer = ctypes.create_unicode_buffer(512)
        required = wintypes.DWORD()
        if not handle or not user32.GetUserObjectInformationW(handle, 2, buffer, ctypes.sizeof(buffer), ctypes.byref(required)):
            raise RuntimeError("Physical desktop identity unavailable")
        return buffer.value

    session = wintypes.DWORD()
    if not kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
        raise RuntimeError("Windows session identity unavailable")
    station = name(user32.GetProcessWindowStation())
    desktop = name(user32.GetThreadDesktop(kernel32.GetCurrentThreadId()))
    resource = hashlib.sha256(json.dumps([socket.gethostname().casefold(), session.value,
                                         station, desktop]).encode()).hexdigest()
    current = user32.OpenInputDesktop(0, False, 1)
    try:
        ready = station.casefold() == "winsta0" and bool(current) and name(current) == desktop
    finally:
        if current:
            user32.CloseDesktop(current)
    return {"instanceId": instance_id, "inputResourceId": "physical-input:" + resource, "ready": ready}
