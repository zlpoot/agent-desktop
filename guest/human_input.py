"""Atomic human gestures. No held keys or mouse buttons survive a request."""
import ctypes
from ctypes import wintypes
import math
import pyautogui


def unicode_text(text):
    class Mouse(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("data", wintypes.DWORD),
                    ("flags", wintypes.DWORD), ("time", wintypes.DWORD), ("extra", wintypes.WPARAM)]
    class Key(ctypes.Structure):
        _fields_ = [("vk", wintypes.WORD), ("scan", wintypes.WORD), ("flags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("extra", wintypes.WPARAM)]
    class Data(ctypes.Union):
        _fields_ = [("mouse", Mouse), ("key", Key)]
    class Input(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("data", Data)]
    raw = text.encode("utf-16-le")
    events = []
    for offset in range(0, len(raw), 2):
        unit = int.from_bytes(raw[offset:offset + 2], "little")
        events.extend([Input(1, Data(key=Key(0, unit, flag, 0, 0))) for flag in (4, 6)])
    values = (Input * len(events))(*events)
    sent = ctypes.windll.user32.SendInput(len(events), values, ctypes.sizeof(Input))
    if sent != len(events):
        raise RuntimeError("Unicode input was not fully dispatched")


def _dispatch(event):
    if not isinstance(event, dict):
        raise ValueError("Invalid human event")
    kind = event.get("kind")
    def point(key):
        value = event.get(key)
        if not isinstance(value, dict):
            raise ValueError("Point required")
        x, y = value.get("x"), value.get("y")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or
               not math.isfinite(v) or not 0 <= v <= 1 for v in (x, y)):
            raise ValueError("Point must be normalized")
        width, height = pyautogui.size()
        return round(x * (width - 1)), round(y * (height - 1))
    if kind in {"click", "double_click", "drag", "scroll"}:
        xy = point("point")
        button = event.get("button", "left")
        if button not in {"left", "right"}:
            raise ValueError("Invalid mouse button")
        if kind == "drag":
            destination = point("destination")
            pyautogui.moveTo(*xy)
            try:
                pyautogui.dragTo(*destination, duration=0.35, button=button)
            finally:
                pyautogui.mouseUp(button=button)
        elif kind == "scroll":
            amount = event.get("amount")
            if not isinstance(amount, int) or isinstance(amount, bool) or not -10 <= amount <= 10:
                raise ValueError("Invalid scroll amount")
            pyautogui.moveTo(*xy)
            pyautogui.scroll(amount)
        else:
            pyautogui.click(*xy, clicks=2 if kind == "double_click" else 1,
                            interval=0.08, button=button)
    elif kind == "key":
        keys = event.get("keys")
        if (not isinstance(keys, list) or not 1 <= len(keys) <= 4 or
                any(not isinstance(k, str) or k not in pyautogui.KEYBOARD_KEYS for k in keys)):
            raise ValueError("Invalid key combination")
        try:
            pyautogui.hotkey(*keys)
        finally:
            for key in reversed(keys):
                pyautogui.keyUp(key)
    elif kind == "text":
        text = event.get("text")
        if not isinstance(text, str) or not 1 <= len(text) <= 1000:
            raise ValueError("Invalid text length")
        unicode_text(text)
    else:
        raise ValueError("Human event kind is not allowed")
    return {"ok": True, "source": "human", "kind": kind}


def dispatch(event):
    # Human users may intentionally click a screen corner. Ownership revocation is
    # enforced by the Worker; always finish releasing this atomic gesture.
    failsafe = pyautogui.FAILSAFE
    pyautogui.FAILSAFE = False
    try:
        return _dispatch(event)
    finally:
        pyautogui.FAILSAFE = failsafe
