"""仅操作启动时绑定的 Windows 窗口；通过标准输入输出交换 JSON 行。"""

import json
import ctypes
from ctypes import wintypes
import hashlib
import os
import sys
import time
import uuid
from pathlib import Path

ctypes.windll.user32.SetProcessDPIAware()
parents = Path(__file__).resolve().parents
if len(parents) > 3:
    deps_root = parents[3] / ".artifacts"
    deps = deps_root / f"python-deps-cp{sys.version_info.major}{sys.version_info.minor}"
    if not deps.exists():
        legacy = deps_root / "python-deps"
        tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
        if any(legacy.glob(f"PIL/_imaging.{tag}-*.pyd")):
            deps = legacy
    if deps.exists():
        sys.path.insert(0, str(deps))

import pyautogui
import psutil
import win32api
import win32clipboard
import win32con
import win32gui
import win32process
import win32security
import win32ui
from PIL import Image
from pywinauto import Desktop
from pywinauto import mouse as uia_mouse
from vision import match_visual_template
from physical_context import physical_context
from physical_gate import PhysicalGate

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05
WINDOW = None
WINDOW_HANDLE = None
WINDOW_PID = None
WINDOW_PROCESS_PATH = None
ARTIFACT_DIR = None
OBSERVATION_COUNT = 0
CAPTURE_EPOCH = str(uuid.uuid4())
LAST_ENUMERATION_COMPLETE = False
PHYSICAL_INSTANCE_ID = str(uuid.uuid4())
PHYSICAL_GATE = None


def reply(request_id, result=None, error=None):
    print(json.dumps({"id": request_id, "result": result, "error": error}, ensure_ascii=False), flush=True)


def process_path(pid):
    try:
        return psutil.Process(pid).exe()
    except (psutil.Error, OSError):
        return None


def process_elevated(pid):
    try:
        process = win32api.OpenProcess(win32con.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        token = win32security.OpenProcessToken(process, win32security.TOKEN_QUERY)
        return bool(win32security.GetTokenInformation(token, win32security.TokenElevation))
    except Exception:
        return None


def window_info(handle):
    _, pid = win32process.GetWindowThreadProcessId(handle)
    rect = win32gui.GetWindowRect(handle)
    return {"handle": handle, "title": win32gui.GetWindowText(handle),
            "windowClass": win32gui.GetClassName(handle), "processId": pid,
            "processPath": process_path(pid), "targetElevated": process_elevated(pid),
            "visible": bool(win32gui.IsWindowVisible(handle)),
            "minimized": bool(win32gui.IsIconic(handle)),
            "foreground": win32gui.GetForegroundWindow() == handle,
            "rect": {"left": rect[0], "top": rect[1],
                     "width": rect[2] - rect[0], "height": rect[3] - rect[1]}}


def list_windows(title=None, window_class=None, process_path_filter=None):
    found = []
    def collect(handle, _):
        try:
            if not win32gui.IsWindowVisible(handle):
                return
            if title is not None and win32gui.GetWindowText(handle) != title:
                return
            if window_class is not None and win32gui.GetClassName(handle) != window_class:
                return
            info = window_info(handle)
            if process_path_filter is not None and (not info["processPath"] or
                    os.path.normcase(info["processPath"]) != os.path.normcase(process_path_filter)):
                return
            found.append(info)
        except Exception:
            # 窗口可能在枚举期间关闭；跳过该项，不中断其他候选。
            return
    win32gui.EnumWindows(collect, None)
    return found


def bind(title=None, handle=None, window_class=None, process_path=None, process_id=None):
    global WINDOW, WINDOW_HANDLE, WINDOW_PID, WINDOW_PROCESS_PATH
    if handle is not None:
        if not win32gui.IsWindow(handle):
            raise ValueError("指定的窗口句柄不存在")
        identity = window_info(handle)
        if process_id is not None and identity["processId"] != process_id:
            raise ValueError("保存的窗口进程已变化")
        if title is not None and identity["title"] != title:
            raise ValueError("指定句柄的窗口标题不符")
        if window_class is not None and identity["windowClass"] != window_class:
            raise ValueError("指定句柄的窗口类名不符")
        if process_path is not None and (not identity["processPath"] or
                os.path.normcase(identity["processPath"]) != os.path.normcase(process_path)):
            raise ValueError("指定句柄的进程路径不符")
        window = Desktop(backend="uia").window(handle=handle)
        if not window.exists(timeout=1):
            raise ValueError("指定窗口无法通过 UI Automation 绑定")
        WINDOW = window
        WINDOW_HANDLE = handle
        WINDOW_PID = identity["processId"]
        WINDOW_PROCESS_PATH = identity["processPath"]
        if win32gui.IsIconic(handle):
            win32gui.ShowWindow(handle, 9)
        return {"title": window.window_text(), "handle": handle}
    windows = Desktop(backend="uia").windows()
    def matches_window(window):
        if title is not None:
            return window.window_text() == title and (not window_class or
                                                     window.element_info.class_name == window_class)
        if not window_class or not process_path:
            return False
        if window.element_info.class_name != window_class:
            return False
        try:
            return os.path.normcase(psutil.Process(window.process_id()).exe()) == os.path.normcase(process_path)
        except (psutil.Error, OSError):
            return False

    matches = [w for w in windows if matches_window(w)]
    if not matches and title is not None:
        # 部分游戏窗口存在于 Win32 顶层窗口列表，但 UIA 顶层枚举不会返回它。
        handles = []
        def collect(hwnd, _):
            if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd) == title and \
                    (not window_class or win32gui.GetClassName(hwnd) == window_class):
                handles.append(hwnd)
        win32gui.EnumWindows(collect, None)
        matches = [Desktop(backend="uia").window(handle=hwnd) for hwnd in handles]
    if len(matches) != 1:
        raise ValueError(f"窗口匹配数量为 {len(matches)}，必须指定唯一的窗口")
    WINDOW = matches[0]
    WINDOW_HANDLE = WINDOW.handle
    identity = window_info(WINDOW_HANDLE)
    if process_path is not None and (not identity["processPath"] or
            os.path.normcase(identity["processPath"]) != os.path.normcase(process_path)):
        raise ValueError("目标窗口的进程路径不符")
    WINDOW_PID = identity["processId"]
    WINDOW_PROCESS_PATH = identity["processPath"]
    if win32gui.IsIconic(WINDOW_HANDLE):
        win32gui.ShowWindow(WINDOW_HANDLE, 9)
    return {"title": WINDOW.window_text(), "handle": WINDOW_HANDLE}


def current_window():
    if WINDOW_HANDLE is None:
        raise RuntimeError("尚未绑定窗口")
    if not win32gui.IsWindow(WINDOW_HANDLE):
        raise RuntimeError("绑定的窗口已关闭")
    _, pid = win32process.GetWindowThreadProcessId(WINDOW_HANDLE)
    if pid != WINDOW_PID or process_path(pid) != WINDOW_PROCESS_PATH:
        raise RuntimeError("绑定的窗口身份已变化，拒绝继续操作")
    window = Desktop(backend="uia").window(handle=WINDOW_HANDLE)
    if not window.exists(timeout=1):
        raise RuntimeError("绑定的窗口无法重新获取")
    return window


def controlled_foreground():
    """Allow a modal dialog owned by the bound process without widening to other windows."""
    foreground = win32gui.GetForegroundWindow()
    if foreground == WINDOW_HANDLE:
        return True
    if not foreground or not win32gui.IsWindow(foreground):
        return False
    _, pid = win32process.GetWindowThreadProcessId(foreground)
    if pid != WINDOW_PID:
        return False
    owner = win32gui.GetWindow(foreground, win32con.GW_OWNER)
    seen = set()
    while owner and owner not in seen:
        if owner == WINDOW_HANDLE:
            return True
        seen.add(owner)
        owner = win32gui.GetWindow(owner, win32con.GW_OWNER)
    return False


def bounds(window):
    rect = window.rectangle()
    return {"left": rect.left, "top": rect.top, "width": rect.width(), "height": rect.height()}


def capture_window(handle, width, height, path):
    source_handle = win32gui.GetWindowDC(handle)
    source = win32ui.CreateDCFromHandle(source_handle)
    memory = source.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    try:
        bitmap.CreateCompatibleBitmap(source, width, height)
        memory.SelectObject(bitmap)
        if ctypes.windll.user32.PrintWindow(handle, memory.GetSafeHdc(), 3) != 1:
            if not win32gui.IsWindowVisible(handle) or win32gui.IsIconic(handle):
                raise RuntimeError("窗口截图失败：目标窗口不可见")
            try:
                win32gui.SetForegroundWindow(handle)
            except Exception:
                try:
                    Desktop(backend="uia").window(handle=handle).set_focus()
                except Exception as exc:
                    raise RuntimeError("窗口截图失败：无法将目标窗口置于前台") from exc
            time.sleep(0.2)
            if win32gui.GetForegroundWindow() != handle:
                raise RuntimeError("窗口截图失败：目标窗口未处于前台")
            left, top, right, bottom = win32gui.GetWindowRect(handle)
            pyautogui.screenshot(region=(left, top, right - left, bottom - top)).save(path)
            return
        image = Image.frombuffer("RGB", (width, height), bitmap.GetBitmapBits(True),
                                 "raw", "BGRX", 0, 1)
        content = image.getbbox()
        client = win32gui.GetClientRect(handle)
        client_width, client_height = client[2] - client[0], client[3] - client[1]
        if content and client_width > 0 and client_height > 0:
            window_left, window_top, _, _ = win32gui.GetWindowRect(handle)
            client_left, client_top = win32gui.ClientToScreen(handle, (0, 0))
            offset = (client_left - window_left, client_top - window_top)
            if (offset[0] > 0 or offset[1] > 0) and \
                    content[2] <= client_width + 1 and content[3] <= client_height + 1:
                # 有些游戏的 PrintWindow(PW_RENDERFULLCONTENT) 从位图左上角输出客户区，
                # 必须补回边框/标题栏偏移，才能将截图内坐标用于真实点击。
                canvas = Image.new("RGB", (width, height))
                canvas.paste(image.crop((0, 0, client_width, client_height)), offset)
                image = canvas
            elif content[2] < client_width * 0.85:
                scaled = image.crop((0, 0, content[2], content[3])).resize((client_width, client_height))
                canvas = Image.new("RGB", (width, height))
                canvas.paste(scaled, offset)
                image = canvas
        image.save(path)
    finally:
        win32gui.DeleteObject(bitmap.GetHandle())
        memory.DeleteDC()
        source.DeleteDC()
        win32gui.ReleaseDC(handle, source_handle)


def elements(window):
    global LAST_ENUMERATION_COMPLETE
    descendants = window.descendants()
    LAST_ENUMERATION_COMPLETE = len(descendants) <= 500
    result = []
    for control in [window] + descendants[:500]:
        try:
            info = control.element_info
            rect = control.rectangle()
            # UIA Name is the accessible identity. Edit.window_text() often
            # returns the current Value instead, erasing its stable label.
            name = info.name or control.window_text() or ""
            role = info.control_type or ""
            value = ""
            # Most UIA controls do not implement ValuePattern. Their name is the
            # complete text contribution; only value-bearing controls need it.
            value_complete = role not in {"Edit", "Document", "ComboBox", "Slider", "Spinner"}
            try:
                value = control.iface_value.CurrentValue or ""
                value_complete = len(value) <= 300
            except Exception:
                pass
            try:
                runtime_id = list(info.runtime_id)
            except Exception:
                runtime_id = None
            result.append({"name": name[:300], "value": value[:300],
                           "runtimeId": runtime_id,
                           "nameComplete": len(name) <= 300, "valueComplete": value_complete,
                           "role": role, "autoId": info.automation_id or "",
                           "className": info.class_name or "", "enabled": control.is_enabled(),
                           "visible": control.is_visible(),
                           "rect": {"x": rect.left, "y": rect.top,
                                    "width": rect.width(), "height": rect.height()}})
        except Exception:
            LAST_ENUMERATION_COMPLETE = False
            continue
    return result


def has_app_uia_controls(controls):
    client = win32gui.GetClientRect(WINDOW_HANDLE)
    left, top = win32gui.ClientToScreen(WINDOW_HANDLE, (0, 0))
    right, bottom = left + client[2] - client[0], top + client[3] - client[1]
    actionable = {"Button", "Edit", "Document", "ComboBox", "CheckBox", "RadioButton",
                  "ListItem", "TabItem", "Group", "Hyperlink", "Slider"}
    return any(control["visible"] and control["enabled"] and control["role"] in actionable and
               left <= control["rect"]["x"] + control["rect"]["width"] / 2 < right and
               top <= control["rect"]["y"] + control["rect"]["height"] / 2 < bottom
               for control in controls)


def observe(screen_capture=False):
    global OBSERVATION_COUNT
    capture_started = int(time.time() * 1000)
    window = current_window()
    if win32gui.IsIconic(WINDOW_HANDLE):
        win32gui.ShowWindow(WINDOW_HANDLE, 9)
        window = current_window()
    rect = bounds(window)
    if rect["width"] <= 0 or rect["height"] <= 0:
        raise RuntimeError("窗口不可见或大小无效")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    OBSERVATION_COUNT += 1
    screenshot = ARTIFACT_DIR / f"observation-{OBSERVATION_COUNT}.png"
    if screen_capture:
        if not controlled_foreground():
            raise RuntimeError("目标窗口未处于前台，不能将屏幕裁剪用于视觉定位")
        pyautogui.screenshot(region=(rect["left"], rect["top"],
                                     rect["width"], rect["height"])).save(screenshot)
    else:
        capture_window(WINDOW_HANDLE, rect["width"], rect["height"], screenshot)
    controls = elements(window)
    player_controls = [e for e in controls if e["autoId"] in
                       ("btn_pc_minibar_play", "btn_pc_minibar_pause") and e["visible"]]
    media = None
    if player_controls:
        title_parts = window.window_text().rsplit(" - ", 1)
        media = {"title": title_parts[0],
                 "artist": title_parts[1] if len(title_parts) > 1 else "",
                 "playing": any(e["name"] == "pause" or e["autoId"] == "btn_pc_minibar_pause"
                                for e in player_controls)}
    lines = [f'{e["role"]} | {e["name"]} | {e["value"]} | autoId={e["autoId"]}'
             for e in controls if e["visible"] and (e["name"] or e["value"] or e["autoId"])]
    uia_text = "\n".join(e["name"] + " " + e["value"] for e in controls if e["visible"])[:30000]
    raw_text = "\n".join(e["name"] + " " + e["value"] for e in controls if e["visible"])
    raw_lines = "\n".join(lines)
    raw_dom = json.dumps(controls, ensure_ascii=False)
    complete = LAST_ENUMERATION_COMPLETE and all(e["nameComplete"] and e["valueComplete"] for e in controls)
    return {"screenshot": str(screenshot),
            "capture": {"epoch": CAPTURE_EPOCH, "sequence": OBSERVATION_COUNT,
                        "object": f"window:{CAPTURE_EPOCH}:{WINDOW_HANDLE}",
                        "startedAt": capture_started, "finishedAt": int(time.time() * 1000),
                        "clock": "collector", "atomic": False,
                        "enumerationComplete": LAST_ENUMERATION_COMPLETE,
                        "fields": {"pageText": {"complete": complete and len(raw_text) <= 30000, "source": "uia"},
                                   "accessibility": {"complete": complete and len(raw_lines) <= 30000, "source": "uia"},
                                   "dom": {"complete": complete and len(raw_dom) <= 30000, "source": "uia"}}},
            "screenshotHash": hashlib.sha256(screenshot.read_bytes()).hexdigest(),
            "desktopPath": str(Path.home() / "Desktop"),
            "windowTitle": window.window_text(),
            "windowHandle": WINDOW_HANDLE, "windowRect": rect,
            "media": media,
            "pageText": uia_text,
            "textEvidence": [{"source": "uia", "text": uia_text}],
            "accessibility": raw_lines[:30000],
            "dom": raw_dom[:30000]}


def probe(focus=False, include_controls=True):
    window = current_window()
    if focus and not controlled_foreground():
        window.set_focus()
        time.sleep(0.1)
    controls = elements(window) if include_controls else []
    identity = window_info(WINDOW_HANDLE)
    self_elevated = bool(ctypes.windll.shell32.IsUserAnAdmin())
    target_elevated = identity["targetElevated"]
    return {"windowClass": identity["windowClass"],
            "foreground": controlled_foreground(),
            "elevated": self_elevated, "targetElevated": target_elevated,
            "permissionsCompatible": target_elevated is not None and (not target_elevated or self_elevated),
            "title": identity["title"], "processId": identity["processId"],
            "processPath": identity["processPath"], "visible": identity["visible"],
            "minimized": identity["minimized"], "rect": identity["rect"],
            "uiaControls": has_app_uia_controls(controls) if include_controls else None}


PRIORITY = {"role": 0, "label": 1, "text": 2, "selector": 3, "vision": 4, "coordinate": 5}


def candidates(spec):
    values = spec["options"] if spec["kind"] == "candidates" else [spec]
    if spec["kind"] == "role" and spec.get("name"):
        values = values + [{"kind": "label", "label": spec["name"]},
                           {"kind": "text", "text": spec["name"]}]
    unique = {json.dumps(v, sort_keys=True, ensure_ascii=False): v for v in values}
    return sorted(unique.values(), key=lambda v: PRIORITY[v["kind"]])


def find_control(window, target, for_type=False):
    controls = [c for c in [window] + window.descendants()[:500] if c.is_visible() and c.is_enabled()]
    # Match the same UIA identity exposed by elements(). Edit.window_text()
    # returns its value on some controls, so matching it against the field
    # label would make a successfully observed target impossible to act on.
    def accessible_name(control):
        return control.element_info.name or control.window_text() or ""
    kind = target["kind"]
    if kind == "role":
        matches = [c for c in controls if c.element_info.control_type.lower() == target["role"].lower()
                   and (not target.get("name") or accessible_name(c) == target["name"])]
    elif kind == "label":
        matches = [c for c in controls if accessible_name(c) == target["label"]]
    elif kind == "text":
        matches = [c for c in controls if c.window_text() == target["text"]]
    elif kind == "selector":
        selector = target["selector"]
        key, sep, value = selector.partition("=")
        if not sep or key not in ("autoId", "className"):
            raise ValueError("桌面 selector 仅支持 autoId=... 或 className=...")
        matches = [c for c in controls if getattr(c.element_info,
                   "automation_id" if key == "autoId" else "class_name") == value]
    else:
        return []
    if for_type:
        matches = [c for c in matches if c.element_info.control_type.lower() in
                   ("edit", "document", "combobox")]
    return matches


def ground(action):
    if action["kind"] not in ("click", "double_click", "type", "paste_text", "scroll") or \
            (action["kind"] == "scroll" and not action.get("target")):
        return {"attempts": []}
    window = current_window()
    attempts = []
    for target in candidates(action["target"]):
        attempt = {"strategy": target["kind"], "matched": False, "selected": False, "detail": ""}
        attempts.append(attempt)
        kind = target["kind"]
        if kind == "vision":
            if action["kind"] in ("type", "paste_text"):
                attempt["detail"] = "视觉目标不支持直接输入"
                continue
            try:
                snapshot = observe()
                x, y, confidence = match_visual_template(target["description"], snapshot["screenshot"], Path.cwd())
                attempt.update(matched=True, selected=True, detail=f"截图模板匹配度 {confidence:.3f}")
                return {"target": {"kind": "coordinate", "x": x, "y": y}, "attempts": attempts}
            except Exception as error:
                attempt["detail"] = str(error)
            continue
        if kind == "coordinate":
            rect = bounds(window)
            if action["kind"] in ("type", "paste_text") or not (0 <= target["x"] < rect["width"] and
                                                  0 <= target["y"] < rect["height"]):
                attempt["detail"] = "坐标不适用于输入动作或超出窗口"
                continue
            attempt.update(matched=True, selected=True, detail="窗口内坐标")
            return {"target": target, "attempts": attempts}
        try:
            matches = find_control(window, target, action["kind"] in ("type", "paste_text"))
            if len(matches) != 1:
                attempt["detail"] = f"匹配 {len(matches)} 个元素，需要唯一目标"
                continue
            attempt.update(matched=True, selected=True, detail="UI Automation 唯一匹配")
            return {"target": target, "attempts": attempts}
        except Exception as error:
            attempt["detail"] = str(error)
    return {"attempts": attempts}


def hotkey_with_release(*keys):
    try:
        pyautogui.hotkey(*keys)
    finally:
        for key in reversed(keys):
            try:
                pyautogui.keyUp(key)
            except Exception:
                pass


def keypress(keys):
    parts = [part.strip().lower() for part in keys.split("+")]
    aliases = {"control": "ctrl", "controlormeta": "ctrl", "return": "enter",
               "escape": "esc", "arrowdown": "down", "arrowup": "up"}
    parts = [aliases.get(part, part) for part in parts]
    forbidden = {"win", "windows", "meta", "command", "super"}
    if any(part in forbidden or part not in pyautogui.KEYBOARD_KEYS for part in parts):
        raise ValueError("不支持的按键组合")
    if not controlled_foreground():
        raise RuntimeError("目标窗口未处于前台，拒绝发送全局按键")
    if parts == ["esc"] and current_window().element_info.class_name == "UnrealWindow":
        class KeybdInput(ctypes.Structure):
            _fields_ = [("vk", wintypes.WORD), ("scan", wintypes.WORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("extra", wintypes.WPARAM)]

        class MouseInput(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                        ("mouseData", wintypes.DWORD), ("flags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("extra", wintypes.WPARAM)]

        class InputData(ctypes.Union):
            _fields_ = [("keyboard", KeybdInput), ("mouse", MouseInput)]

        class Input(ctypes.Structure):
            _fields_ = [("type", wintypes.DWORD), ("data", InputData)]

        send_input = ctypes.windll.user32.SendInput
        send_input.argtypes = (wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int)
        send_input.restype = wintypes.UINT
        pressed = False
        try:
            flags = 0x0008
            event = Input(1, InputData(keyboard=KeybdInput(0, 1, flags, 0, 0)))
            if send_input(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
                raise RuntimeError(f"Esc 扫描码发送失败（结构大小 {ctypes.sizeof(Input)}，系统错误 {ctypes.windll.kernel32.GetLastError()}）")
            pressed = True
            time.sleep(0.08)
        finally:
            if pressed:
                event = Input(1, InputData(keyboard=KeybdInput(0, 1, 0x0008 | 0x0002, 0, 0)))
                if send_input(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
                    raise RuntimeError("Esc 扫描码释放失败")
        return "windows.win32.act"
    hotkey_with_release(*parts)
    return ("windows.pyautogui.unity.escape"
            if parts == ["esc"] and current_window().element_info.class_name == "UnityWndClass"
            else "windows.pyautogui.act")


def send_game_mouse_click(x, y):
    if win32gui.GetForegroundWindow() != WINDOW_HANDLE:
        raise RuntimeError("目标窗口未处于前台，拒绝发送全局鼠标输入")

    class MouseInput(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                    ("mouseData", wintypes.DWORD), ("flags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("extra", wintypes.WPARAM)]

    class KeybdInput(ctypes.Structure):
        _fields_ = [("vk", wintypes.WORD), ("scan", wintypes.WORD),
                    ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                    ("extra", wintypes.WPARAM)]

    class InputData(ctypes.Union):
        _fields_ = [("mouse", MouseInput), ("keyboard", KeybdInput)]

    class Input(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("data", InputData)]

    user32 = ctypes.windll.user32
    left = user32.GetSystemMetrics(76)
    top = user32.GetSystemMetrics(77)
    width = user32.GetSystemMetrics(78)
    height = user32.GetSystemMetrics(79)
    if width < 2 or height < 2:
        raise RuntimeError("无法获取桌面尺寸")
    normalized_x = round((x - left) * 65535 / (width - 1))
    normalized_y = round((y - top) * 65535 / (height - 1))
    send_input = user32.SendInput
    send_input.argtypes = (wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int)
    send_input.restype = wintypes.UINT
    for flags in (0x0001 | 0x8000 | 0x4000,):
        event = Input(0, InputData(mouse=MouseInput(normalized_x, normalized_y, 0, flags, 0, 0)))
        if send_input(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
            raise RuntimeError(f"游戏鼠标输入失败（系统错误 {ctypes.windll.kernel32.GetLastError()}）")
        time.sleep(0.08)
    pressed = False
    try:
        event = Input(0, InputData(mouse=MouseInput(normalized_x, normalized_y, 0, 0x0002, 0, 0)))
        if send_input(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
            raise RuntimeError(f"游戏鼠标按下失败（系统错误 {ctypes.windll.kernel32.GetLastError()}）")
        pressed = True
        time.sleep(0.08)
    finally:
        if pressed:
            event = Input(0, InputData(mouse=MouseInput(normalized_x, normalized_y, 0, 0x0004, 0, 0)))
            if send_input(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
                raise RuntimeError("游戏鼠标释放失败")


class UnicodeKeybdInput(ctypes.Structure):
    _fields_ = [("vk", wintypes.WORD), ("scan", wintypes.WORD),
                ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("extra", wintypes.WPARAM)]


class UnicodeMouseInput(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("extra", wintypes.WPARAM)]


class UnicodeInputData(ctypes.Union):
    _fields_ = [("keyboard", UnicodeKeybdInput), ("mouse", UnicodeMouseInput)]


class UnicodeInput(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("data", UnicodeInputData)]


def _send_unicode_key(code, key_up):
    flags = 0x0004 | (0x0002 if key_up else 0)  # KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
    event = UnicodeInput(1, UnicodeInputData(keyboard=UnicodeKeybdInput(0, code, flags, 0, 0)))
    sent = ctypes.windll.user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(UnicodeInput))
    if sent != 1:
        raise RuntimeError(f"Unicode 字符输入失败（系统错误 {ctypes.windll.kernel32.GetLastError()}）")


def type_unicode(text, interval=0.01):
    """以 KEYEVENTF_UNICODE 逐字符注入真实键盘事件。

    不经过物理键盘布局映射，也不会被中文输入法（IME）组词或候选词拦截；与 UIA
    ValuePattern.SetValue 不同，它生成标准文件对话框会提交的 WM_CHAR 输入。
    """
    if not controlled_foreground():
        raise RuntimeError("目标窗口或其所属标准对话框未处于前台，拒绝输入")
    units = text.encode("utf-16-le")
    for index in range(0, len(units), 2):
        code = units[index] | (units[index + 1] << 8)
        _send_unicode_key(code, False)
        _send_unicode_key(code, True)
        time.sleep(interval)


def resolve_action(action):
    """只读解析本次动作的候选执行器；实际执行者另由 execute 返回。"""
    kind = action["kind"]
    direct = {"wait": "windows.runtime.wait", "screenshot": "windows.window.observe",
              "scroll": "windows.pyautogui.act", "drag": "windows.pyautogui.drag"}
    if kind in direct:
        provider = direct[kind]
        reason = f"{kind} 使用固定执行器"
        return {"selected": provider, "reason": reason,
                "candidates": [{"provider": provider, "available": True, "reason": reason}]}
    window = current_window()
    state = probe(include_controls=False)
    if not state["foreground"] or not state["permissionsCompatible"]:
        raise RuntimeError("目标窗口前台或权限条件不满足")
    if kind == "keypress":
        keys = action["keys"].lower()
        if keys in ("esc", "escape") and state["windowClass"] == "UnrealWindow":
            provider = "windows.win32.act"
        elif keys in ("esc", "escape") and state["windowClass"] == "UnityWndClass":
            provider = "windows.pyautogui.unity.escape"
        else:
            provider = "windows.pyautogui.act"
        reason = f"窗口类 {state['windowClass']} 的按键执行路径"
        return {"selected": provider, "reason": reason,
                "candidates": [{"provider": provider, "available": True, "reason": reason}]}
    if kind not in ("click", "double_click", "type", "paste_text"):
        raise ValueError(f"不支持的动作：{kind}")
    target = action["target"]
    if target["kind"] == "candidates":
        raise ValueError("目标尚未定位")
    if target["kind"] == "coordinate":
        rect = bounds(window)
        if not (0 <= target["x"] < rect["width"] and 0 <= target["y"] < rect["height"]):
            raise ValueError("目标坐标超出绑定窗口")
        x, y = rect["left"] + target["x"], rect["top"] + target["y"]
        can_invoke = False
        for control in ([] if kind == "double_click" else window.descendants()[:500]):
            try:
                box = control.rectangle()
                if control.is_visible() and control.is_enabled() and \
                        box.left <= x < box.right and box.top <= y < box.bottom:
                    can_invoke = control.iface_invoke is not None
                    if can_invoke:
                        break
            except Exception:
                continue
        if state["windowClass"] in ("UnrealWindow", "UnityWndClass") and kind == "click":
            physical = ("windows.win32.unity.click" if state["windowClass"] == "UnityWndClass"
                        else "windows.win32.act")
        else:
            physical = "windows.pywinauto_mouse.act"
        candidates = [{"provider": "windows.uia.act", "available": can_invoke,
                       "reason": "坐标下存在可调用 UIA 控件" if can_invoke else "坐标下没有可调用 UIA 控件"},
                      {"provider": physical, "available": True,
                       "reason": "窗口内坐标已验证，UIA 不适用时使用物理输入"}]
        if physical == "windows.pywinauto_mouse.act":
            candidates.append({"provider": "windows.pyautogui.act", "available": True,
                               "reason": "pywinauto 鼠标执行失败后的兜底"})
        selected = "windows.uia.act" if can_invoke else physical
        return {"selected": selected, "reason": "视觉/模板目标已落在绑定窗口内，按 UIA 可用性选择",
                "candidates": candidates}
    matches = find_control(window, target, kind in ("type", "paste_text"))
    if len(matches) != 1:
        raise ValueError(f"结构化目标匹配 {len(matches)} 个控件，需要唯一目标")
    if kind == "type" and native_file_name_edit(matches[0]):
        selected = "windows.win32.act"
        reason = "系统文件对话框的文件名以 Unicode 键盘事件输入，绕过 IME 组词并触发对话框提交"
        candidates = [{"provider": selected, "available": True,
                       "reason": reason + "；UIA ValuePattern 可能只更新显示值，虚拟键码会被输入法拦截"}]
    elif kind == "paste_text":
        selected = "windows.clipboard.paste_text"
        candidates = [{"provider": selected, "available": True,
                       "reason": "已定位唯一可编辑 UIA 控件；执行时再次检查剪贴板格式"}]
    else:
        selected = "windows.uia.act"
        fallback = ("windows.clipboard.paste_text" if kind == "type" and
                    not action["text"].isascii() else "windows.pyautogui.act")
        candidates = [{"provider": selected, "available": True,
                       "reason": "已定位唯一且可用的 UIA 控件"}]
        if kind != "double_click":
            candidates.append({"provider": fallback, "available": True,
                               "reason": "UIA 设置/调用失败后，在同一绑定窗口内兜底"})
    return {"selected": selected, "reason": reason if kind == "type" and native_file_name_edit(matches[0])
            else "结构化目标优先使用 UIA；记录受限兜底候选",
            "candidates": candidates}


def native_file_name_edit(control):
    """Recognize the standard Windows file dialog filename edit, not an application's form field."""
    info = control.element_info
    return (info.control_type.lower() == "edit" and info.automation_id == "1001"
            and info.class_name == "Edit")


def paste_text_safely(text):
    """只处理纯文本剪贴板，粘贴后恢复原文字；其他格式一律拒绝。"""
    if win32gui.GetForegroundWindow() != WINDOW_HANDLE:
        raise RuntimeError("目标窗口未处于前台，拒绝粘贴")
    allowed = {win32con.CF_TEXT, win32con.CF_UNICODETEXT, win32con.CF_OEMTEXT, win32con.CF_LOCALE}

    def open_clipboard():
        for attempt in range(5):
            try:
                win32clipboard.OpenClipboard()
                return
            except Exception:
                if attempt == 4:
                    raise RuntimeError("剪贴板被其他程序占用")
                time.sleep(0.05)

    original = None
    modified = False
    open_clipboard()
    try:
        formats = []
        current = 0
        while True:
            current = win32clipboard.EnumClipboardFormats(current)
            if not current:
                break
            formats.append(current)
        if any(item not in allowed for item in formats):
            raise RuntimeError("剪贴板包含非纯文本内容，拒绝覆盖")
        original = (win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
                    if win32con.CF_UNICODETEXT in formats else None)
        if formats and original is None:
            raise RuntimeError("无法完整读取原剪贴板文字，拒绝覆盖")
        win32clipboard.EmptyClipboard()
        modified = True
        try:
            win32clipboard.SetClipboardText(text, win32con.CF_UNICODETEXT)
        except Exception:
            if original is not None:
                win32clipboard.SetClipboardText(original, win32con.CF_UNICODETEXT)
            raise
    finally:
        win32clipboard.CloseClipboard()
    try:
        hotkey_with_release("ctrl", "v")
        time.sleep(0.2)
    finally:
        if modified:
            open_clipboard()
            try:
                if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT) and \
                        win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT) == text:
                    win32clipboard.EmptyClipboard()
                    if original is not None:
                        win32clipboard.SetClipboardText(original, win32con.CF_UNICODETEXT)
            finally:
                win32clipboard.CloseClipboard()


def clipboard_plain_text_available():
    try:
        win32clipboard.OpenClipboard()
        try:
            allowed = {win32con.CF_TEXT, win32con.CF_UNICODETEXT,
                       win32con.CF_OEMTEXT, win32con.CF_LOCALE}
            current = 0
            while True:
                current = win32clipboard.EnumClipboardFormats(current)
                if not current:
                    return True
                if current not in allowed:
                    return False
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        return False


def execute(action, allowed_providers=None):
    """把异常按是否已发出目标输入分类，供上层决定能否改选执行器。"""
    try:
        return _execute(action, allowed_providers)
    except Exception as error:
        return {"ok": False, "message": f"{type(error).__name__}: {error}",
                "effect": "uncertain" if ACTION_DISPATCHED else "none",
                "provider": CURRENT_PROVIDER}


ACTION_DISPATCHED = False
CURRENT_PROVIDER = None


def _execute(action, allowed_providers=None):
    global ACTION_DISPATCHED, CURRENT_PROVIDER
    ACTION_DISPATCHED = False
    CURRENT_PROVIDER = None
    kind = action["kind"]
    allowed = None if allowed_providers is None else set(allowed_providers)
    if allowed is not None and not allowed:
        raise RuntimeError("逐动作解析未提供可用执行器")

    def authorize(provider):
        if allowed is not None and provider not in allowed:
            raise RuntimeError(f"执行器 {provider} 未被本步 Action Resolver 授权")

    def dispatch(provider):
        global ACTION_DISPATCHED, CURRENT_PROVIDER
        authorize(provider)
        CURRENT_PROVIDER = provider
        ACTION_DISPATCHED = True

    if kind == "navigate":
        return {"ok": False, "message": "桌面运行时不支持网页导航"}
    if kind == "wait":
        dispatch("windows.runtime.wait")
        time.sleep(min(max(action["ms"], 0), 10000) / 1000)
        return {"ok": True, "message": "已等待", "provider": "windows.runtime.wait"}
    if kind == "screenshot":
        dispatch("windows.window.observe")
        return {"ok": True, "message": "已截图", "provider": "windows.window.observe",
                "observation": observe()}
    window = current_window()
    if not controlled_foreground():
        window.set_focus()
    state = probe(include_controls=False)
    if not state["foreground"]:
        raise RuntimeError("目标窗口未处于前台，拒绝执行动作")
    if not state["permissionsCompatible"]:
        raise RuntimeError("目标进程权限高于当前工程或权限状态无法确认，拒绝执行动作")
    provider = None
    if kind == "drag":
        points = []
        rect = bounds(window)
        for target in (action["source"], action["destination"]):
            if target["kind"] in ("coordinate", "vision", "candidates"):
                raise ValueError("桌面拖拽只接受明确的 UIA 控件")
            matches = find_control(window, target, False)
            if len(matches) != 1:
                raise ValueError(f"拖拽目标匹配 {len(matches)} 个控件，需要唯一目标")
            control = matches[0]
            if not control.is_visible() or not control.is_enabled():
                raise ValueError("拖拽控件不可用")
            box = control.rectangle()
            x, y = box.left + box.width() // 2, box.top + box.height() // 2
            if not (rect["left"] <= x < rect["left"] + rect["width"] and
                    rect["top"] <= y < rect["top"] + rect["height"]):
                raise ValueError("拖拽目标超出绑定窗口")
            hit = win32gui.WindowFromPoint((x, y))
            if ctypes.windll.user32.GetAncestor(hit, 2) != WINDOW_HANDLE:
                raise RuntimeError("拖拽目标被其他窗口遮挡")
            points.append((x, y))
        if points[0] == points[1]:
            raise ValueError("拖拽起点与终点相同")
        dispatch("windows.pyautogui.drag")
        pyautogui.moveTo(*points[0])
        try:
            pyautogui.dragTo(*points[1], duration=0.5, button="left")
        finally:
            pyautogui.mouseUp(button="left")
        provider = "windows.pyautogui.drag"
    elif kind in ("click", "double_click", "type", "paste_text"):
        target = action["target"]
        if target["kind"] == "candidates":
            raise ValueError("候选目标尚未定位")
        if target["kind"] == "coordinate":
            if kind in ("type", "paste_text"):
                raise ValueError("输入动作必须使用结构化目标")
            rect = bounds(window)
            if not (0 <= target["x"] < rect["width"] and 0 <= target["y"] < rect["height"]):
                raise ValueError("坐标超出窗口")
            x, y = rect["left"] + target["x"], rect["top"] + target["y"]
            under_point = []
            for control in window.descendants()[:500]:
                box = control.rectangle()
                if control.is_visible() and control.is_enabled() and box.left <= x < box.right and box.top <= y < box.bottom:
                    under_point.append((box.width() * box.height(), control))
            under_point.sort(key=lambda pair: pair[0])
            invoked = False
            for _, control in ([] if kind == "double_click" else under_point):
                try:
                    supported = control.iface_invoke is not None
                except Exception:
                    supported = False
                if not supported or (allowed is not None and "windows.uia.act" not in allowed):
                    continue
                dispatch("windows.uia.act")
                control.invoke()
                invoked = True
                provider = "windows.uia.act"
                break
            if not invoked:
                hit = win32gui.WindowFromPoint((x, y))
                if ctypes.windll.user32.GetAncestor(hit, 2) != WINDOW_HANDLE:
                    raise RuntimeError("目标坐标被其他窗口遮挡")
                if window.element_info.class_name in ("UnrealWindow", "UnityWndClass") and kind == "click":
                    dispatch("windows.win32.unity.click" if window.element_info.class_name == "UnityWndClass"
                             else "windows.win32.act")
                    send_game_mouse_click(x, y)
                    provider = ("windows.win32.unity.click" if window.element_info.class_name == "UnityWndClass"
                                else "windows.win32.act")
                else:
                    if allowed is None or "windows.pywinauto_mouse.act" in allowed:
                        dispatch("windows.pywinauto_mouse.act")
                        (uia_mouse.double_click if kind == "double_click" else uia_mouse.click)(coords=(x, y))
                        provider = "windows.pywinauto_mouse.act"
                    else:
                        dispatch("windows.pyautogui.act")
                        (pyautogui.doubleClick if kind == "double_click" else pyautogui.click)(x, y)
                        provider = "windows.pyautogui.act"
        else:
            matches = find_control(window, target, kind in ("type", "paste_text"))
            if len(matches) != 1:
                raise ValueError(f"目标现在匹配 {len(matches)} 个元素")
            control = matches[0]
            if kind == "double_click":
                dispatch("windows.uia.act")
                control.double_click_input()
                provider = "windows.uia.act"
            elif kind == "click":
                if allowed is None or "windows.uia.act" in allowed:
                    if control.element_info.automation_id == "btn_pc_minibar_play":
                        dispatch("windows.uia.act")
                        control.click_input()
                    else:
                        try:
                            has_invoke = control.iface_invoke is not None
                        except Exception:
                            has_invoke = False
                        dispatch("windows.uia.act")
                        if has_invoke:
                            control.invoke()
                        else:
                            control.click_input()
                    provider = "windows.uia.act"
                else:
                    box = control.rectangle()
                    x, y = box.left + box.width() // 2, box.top + box.height() // 2
                    hit = win32gui.WindowFromPoint((x, y))
                    if ctypes.windll.user32.GetAncestor(hit, 2) != WINDOW_HANDLE:
                        raise RuntimeError("目标控件被其他窗口遮挡")
                    dispatch("windows.pyautogui.act")
                    pyautogui.click(x, y)
                    provider = "windows.pyautogui.act"
            elif kind == "paste_text":
                if not clipboard_plain_text_available():
                    raise RuntimeError("剪贴板包含非纯文本内容或当前不可读取，拒绝覆盖")
                dispatch("windows.clipboard.paste_text")
                control.click_input()
                hotkey_with_release("ctrl", "a")
                paste_text_safely(action["text"])
                provider = "windows.clipboard.paste_text"
            else:
                if kind == "type" and native_file_name_edit(control):
                    dispatch("windows.win32.act")
                    control.click_input()
                    hotkey_with_release("ctrl", "a")
                    type_unicode(action["text"])
                    provider = "windows.win32.act"
                elif allowed is None or "windows.uia.act" in allowed:
                    try:
                        has_value = control.iface_value is not None
                    except Exception:
                        has_value = False
                    if not has_value:
                        raise RuntimeError("目标控件没有 UIA ValuePattern，未执行输入")
                    dispatch("windows.uia.act")
                    if hasattr(control, "set_edit_text"):
                        control.set_edit_text(action["text"])
                    else:
                        control.iface_value.SetValue(action["text"])
                    provider = "windows.uia.act"
                else:
                    fallback = ("windows.clipboard.paste_text" if not action["text"].isascii()
                                else "windows.pyautogui.act")
                    if fallback == "windows.clipboard.paste_text" and not clipboard_plain_text_available():
                        raise RuntimeError("剪贴板包含非纯文本内容或当前不可读取，拒绝覆盖")
                    dispatch(fallback)
                    control.click_input()
                    hotkey_with_release("ctrl", "a")
                    if fallback == "windows.clipboard.paste_text":
                        paste_text_safely(action["text"])
                    else:
                        pyautogui.write(action["text"], interval=0.01)
                    provider = fallback
    elif kind == "keypress":
        dispatch(resolve_action(action)["selected"])
        provider = keypress(action["keys"])
    elif kind == "scroll":
        rect = bounds(window)
        target = action.get("target")
        if target:
            if target["kind"] == "coordinate":
                x, y = rect["left"] + target["x"], rect["top"] + target["y"]
            elif target["kind"] in ("vision", "candidates"):
                raise ValueError("滚动区域尚未定位")
            else:
                matches = find_control(window, target)
                if len(matches) != 1:
                    raise ValueError("滚动区域需要唯一目标")
                box = matches[0].rectangle()
                x, y = box.left + box.width() // 2, box.top + box.height() // 2
        else:
            x, y = rect["left"] + rect["width"] // 2, rect["top"] + rect["height"] // 2
        if not (rect["left"] <= x < rect["left"] + rect["width"] and
                rect["top"] <= y < rect["top"] + rect["height"]):
            raise ValueError("滚动位置超出绑定窗口")
        hit = win32gui.WindowFromPoint((x, y))
        if ctypes.windll.user32.GetAncestor(hit, 2) != WINDOW_HANDLE:
            raise RuntimeError("滚动区域被其他窗口遮挡")
        dispatch("windows.pyautogui.act")
        pyautogui.moveTo(x, y)
        pyautogui.scroll(round(action["amount"] / 100) * (1 if action["direction"] == "up" else -1))
        provider = "windows.pyautogui.act"
    else:
        raise ValueError(f"不支持的动作：{kind}")
    return {"ok": True, "message": f"{kind} 已执行", "provider": provider,
            "effect": "dispatched"}


for line in sys.stdin:
    try:
        request = json.loads(line)
        method = request["method"]
        args = request.get("args", {})
        if method == "physical_hello":
            if PHYSICAL_GATE is None:
                PHYSICAL_GATE = PhysicalGate(lambda: physical_context(PHYSICAL_INSTANCE_ID), args["policy"])
            reply(request["id"], physical_context(PHYSICAL_INSTANCE_ID))
            continue
        if PHYSICAL_GATE is not None:
            if method == "physical_grant":
                PHYSICAL_GATE.install(args["authority"], args["expiresAt"])
                reply(request["id"], True)
                continue
            if method == "physical_revoke":
                PHYSICAL_GATE.revoke(args["authority"])
                WINDOW = WINDOW_HANDLE = WINDOW_PID = WINDOW_PROCESS_PATH = None
                reply(request["id"], True)
                continue
            if method != "close":
                PHYSICAL_GATE.check(request.get("physicalIdentity"), request.get("inputAuthority"), method, args)
        if method == "init":
            ARTIFACT_DIR = Path(args["artifactDir"]).resolve()
            result = bind(args.get("windowTitle"), args.get("windowHandle"),
                          args.get("windowClass"), args.get("processPath"), args.get("processId"))
        elif method == "list_windows":
            result = list_windows(args.get("windowTitle"), args.get("windowClass"),
                                  args.get("processPath"))
        elif method == "restore":
            result = bind(args.get("windowTitle"), args.get("windowHandle"))
        elif method == "observe":
            result = observe(bool(args.get("screenCapture")))
        elif method == "probe":
            result = probe(bool(args.get("focus")))
        elif method == "ground":
            result = ground(args["action"])
        elif method == "resolve_action":
            result = resolve_action(args["action"])
        elif method == "execute":
            result = execute(args["action"], args.get("allowedProviders"))
        elif method == "close":
            reply(request["id"], True)
            break
        else:
            raise ValueError("未知方法")
        reply(request["id"], result)
    except Exception as error:
        reply(request.get("id"), error=f"{type(error).__name__}: {error}")
