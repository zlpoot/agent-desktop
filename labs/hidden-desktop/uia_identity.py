"""UIA 原环境身份：纯数据期望 + 每次独立读取，不缓存 COM Element。"""
import ctypes as C
from ctypes import wintypes as W

IDENTITY_KEYS = ('desktop', 'instanceId', 'session', 'hwnd', 'windowPid',
                 'rootRuntimeId', 'elementPid', 'runtimeId')


def read_runtime_id(tree, element):
    from hidden_desktop_lab.contracts.uia import UiaError
    aut = tree.aut
    for name, args, result in (
        ('SafeArrayGetDim', [C.c_void_p], W.UINT),
        ('SafeArrayGetLBound', [C.c_void_p, W.UINT, C.POINTER(C.c_long)], C.c_long),
        ('SafeArrayGetUBound', [C.c_void_p, W.UINT, C.POINTER(C.c_long)], C.c_long),
        ('SafeArrayAccessData', [C.c_void_p, C.POINTER(C.c_void_p)], C.c_long),
        ('SafeArrayUnaccessData', [C.c_void_p], C.c_long),
        ('SafeArrayDestroy', [C.c_void_p], C.c_long),
    ):
        function = getattr(aut, name)
        function.argtypes, function.restype = args, result
    array = C.c_void_p()
    element.call(4, (C.POINTER(C.c_void_p),), (C.byref(array),))
    if not array:
        raise UiaError('uia-runtime-id-unavailable')
    accessed = False
    try:
        lower, upper, data = C.c_long(), C.c_long(), C.c_void_p()
        if aut.SafeArrayGetDim(array) != 1 \
                or aut.SafeArrayGetLBound(array, 1, C.byref(lower)) < 0 \
                or aut.SafeArrayGetUBound(array, 1, C.byref(upper)) < 0:
            raise UiaError('uia-runtime-id-unavailable')
        count = upper.value - lower.value + 1
        if not 0 < count <= 64 or aut.SafeArrayAccessData(array, C.byref(data)) < 0:
            raise UiaError('uia-runtime-id-unavailable')
        accessed = True
        return list(C.cast(data, C.POINTER(C.c_int * count)).contents)
    finally:
        if accessed:
            aut.SafeArrayUnaccessData(array)
        aut.SafeArrayDestroy(array)


def same_identity(expected, actual):
    """期望只能增加约束，不能代替真实归属与全局唯一性判断。"""
    return isinstance(expected, dict) and isinstance(actual, dict) and all(
        key in expected and key in actual and expected[key] == actual[key]
                                             for key in IDENTITY_KEYS)
