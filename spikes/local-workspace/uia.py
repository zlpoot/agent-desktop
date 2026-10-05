"""Small Windows UIA COM client for owned hidden windows; no focus/input APIs.

ABI declarations follow the installed Windows SDK UIAutomationClient.h. Native
calls run in the disposable job worker; the existing watchdog bounds a hang.
"""
import ctypes as C
from ctypes import wintypes as W
import uuid
import time
from policy import Blocked


class GUID(C.Structure):
    _fields_ = [("bytes", C.c_ubyte * 16)]

    @classmethod
    def parse(cls, value):
        return cls.from_buffer_copy(uuid.UUID(value).bytes_le)


class Com:
    def __init__(self, pointer):
        if not pointer:
            raise Blocked("uia_null_interface")
        self.pointer = C.c_void_p(pointer.value if isinstance(pointer, C.c_void_p) else pointer)

    def call(self, slot, args=(), values=()):
        table = C.cast(self.pointer, C.POINTER(C.POINTER(C.c_void_p))).contents
        method = C.WINFUNCTYPE(C.c_long, C.c_void_p, *args)(table[slot])
        result = method(self.pointer, *values)
        if result < 0:
            raise Blocked(f"uia_hresult_{result & 0xffffffff:08x}")

    def close(self):
        if self.pointer:
            table = C.cast(self.pointer, C.POINTER(C.POINTER(C.c_void_p))).contents
            C.WINFUNCTYPE(C.c_ulong, C.c_void_p)(table[2])(self.pointer)
            self.pointer = None


class Uia:
    def __init__(self, api, target, expected):
        self.api, self.target, self.expected = api, target, expected
        self.heartbeat = None
        self.ole = C.OleDLL("ole32")
        self.aut = C.OleDLL("oleaut32")
        self.ole.CoInitializeEx.argtypes = [C.c_void_p, W.DWORD]
        self.ole.CoInitializeEx.restype = C.c_long
        self.ole.CoCreateInstance.argtypes = [C.POINTER(GUID), C.c_void_p, W.DWORD, C.POINTER(GUID), C.POINTER(C.c_void_p)]
        self.ole.CoCreateInstance.restype = C.c_long
        self.aut.SysFreeString.argtypes = [C.c_void_p]
        self.aut.SysFreeString.restype = None
        result = self.ole.CoInitializeEx(None, 0)  # Dedicated MTA worker; never change input focus.
        if result < 0: raise Blocked("uia_com_initialization_failed")
        pointer = C.c_void_p()
        clsid = GUID.parse("ff48dba4-60ef-4201-aa87-54103eef594e")
        iid = GUID.parse("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee")
        result = self.ole.CoCreateInstance(C.byref(clsid), None, 1, C.byref(iid), C.byref(pointer))
        if result < 0:
            self.ole.CoUninitialize()
            raise Blocked("uia_client_creation_failed")
        self.client = Com(pointer)
        self.root = self.condition = None
        self.elements = []
        api.guard(target, expected)
        self.client.call(6, (W.HWND, C.POINTER(C.c_void_p)), (target, C.byref(pointer)))
        self.root = Com(pointer)
        pointer = C.c_void_p()
        self.client.call(21, (C.POINTER(C.c_void_p),), (C.byref(pointer),))
        self.condition = Com(pointer)

    def integer(self, element, slot):
        value = C.c_int()
        element.call(slot, (C.POINTER(C.c_int),), (C.byref(value),))
        return value.value

    def string(self, element, slot):
        value = C.c_void_p()
        element.call(slot, (C.POINTER(C.c_void_p),), (C.byref(value),))
        try:
            return C.wstring_at(value) if value else ""
        finally:
            if value: self.aut.SysFreeString(value)

    def owned(self, element):
        self.api.guard(self.target, self.expected)
        pid = self.integer(element, 20)
        if not pid or not self.api.owned_process(pid) or self.api.session(pid) != self.expected["session"]:
            raise Blocked("uia_element_process_mismatch")
        if self.integer(element, 35):
            raise Blocked("uia_password_element_forbidden")
        native = self.integer(element, 36)
        if native:
            identity = self.api.identity(native)
            if (not identity.get("in_job") or identity.get("desktop") != self.expected["desktop"]
                    or identity.get("session") != self.expected["session"] or not identity.get("alive")):
                raise Blocked("uia_native_window_outside_workspace")

    def observe(self, heartbeat=None, roles=None):
        self.api.guard(self.target, self.expected)
        for item in self.elements: item.close()
        self.elements = []
        pointer = C.c_void_p()
        self.root.call(6, (C.c_int, C.c_void_p, C.POINTER(C.c_void_p)),
                       (4, self.condition.pointer, C.byref(pointer)))  # Descendants only.
        array = Com(pointer)
        result = []
        try:
            count = self.integer(array, 3)
            if count > 1000:
                raise Blocked("uia_tree_budget_exhausted")
            for i in range(count):
                if heartbeat and i % 10 == 0:
                    heartbeat()  # Progress between calls; a hung provider still times out.
                item = C.c_void_p()
                array.call(4, (C.c_int, C.POINTER(C.c_void_p)), (i, C.byref(item)))
                element = Com(item)
                if roles is not None and self.integer(element, 21) not in roles:
                    element.close()
                    continue
                self.elements.append(element)
                self.owned(element)
                rect = W.RECT()
                element.call(43, (C.POINTER(W.RECT),), (C.byref(rect),))
                result.append({"index": len(self.elements) - 1, "role": self.integer(element, 21), "name": self.string(element, 23),
                               "auto_id": self.string(element, 29), "class": self.string(element, 30),
                               "enabled": bool(self.integer(element, 28)), "offscreen": bool(self.integer(element, 38)),
                               "rect": [rect.left, rect.top, rect.right, rect.bottom]})
            return result
        finally:
            array.close()

    def pattern(self, index, pattern, iid, input_action=True):
        element = self.elements[index]
        self.owned(element)
        (self.api.input_guard if input_action else self.api.guard)(self.target, self.expected)
        pointer, guid = C.c_void_p(), GUID.parse(iid)
        element.call(14, (C.c_int, C.POINTER(GUID), C.POINTER(C.c_void_p)), (pattern, C.byref(guid), C.byref(pointer)))
        return Com(pointer)

    def value(self, index):
        pattern = self.pattern(index, 10002, "a94cd8b1-0844-4cd6-9d2d-640537ab39e9", False)
        try:
            return self.string(pattern, 4)
        finally:
            pattern.close()

    def set_value(self, index, text):
        pattern = self.pattern(index, 10002, "a94cd8b1-0844-4cd6-9d2d-640537ab39e9")
        try:
            self.api.input_guard(self.target, self.expected)
            pattern.call(3, (W.LPCWSTR,), (text,))
            deadline = time.monotonic() + 1.5
            while self.string(pattern, 4) != text:
                self.api.guard(self.target, self.expected)
                if self.heartbeat: self.heartbeat()
                if time.monotonic() >= deadline: raise Blocked("uia_value_effect_mismatch")
                time.sleep(0.05)
        finally:
            pattern.close()

    def invoke(self, index):
        slot = 3
        try:
            pattern = self.pattern(index, 10000, "fb377fbe-8ea6-46d5-9c73-6499642d3059")
        except Blocked as error:
            if str(error) not in ("uia_hresult_80040204", "uia_hresult_80004002"):
                raise
            # Unsupported pattern only; never retry an input with unknown effect.
            pattern = self.pattern(index, 10018, "828055ad-355b-4435-86d5-3b51c14a9b1b")
            slot = 4  # LegacyIAccessible.DoDefaultAction; no focus or global keys.
        try:
            self.api.input_guard(self.target, self.expected)
            pattern.call(slot)
        finally:
            pattern.close()

    def close(self):
        for item in self.elements: item.close()
        for item in (self.condition, self.root, self.client):
            if item: item.close()
        self.ole.CoUninitialize()
