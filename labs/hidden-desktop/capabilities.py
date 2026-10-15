"""基础能力：**声明 + 实现**。

声明是唯一事实来源 —— 页面目录、表单、调度、可用性判定全部由它派生。
格式对齐 `docs/base-capabilities.md` 的 9 段式，字段名保持一致。

设计纪律（刻意不妥协的地方）：
  * 副作用是第一等字段：本家族全部能力 `touchesUserDesktop=false`、`sendsSystemInput=false`。
  * `requires` 由运行时探测，调用方不能申报；探测为「未知」也算不满足。
  * `refuses` 每条都有稳定错误码，且必须出现在 `errors` 里。
  * 没实现的能力一律 `planned`，绝不给 `verified`。
  * 声明里不出现任何具体应用名：选择靠"界面结构 + 事实"。
"""
from __future__ import annotations

import os
import sys
import time

from hidden_desktop import Blocked, HiddenDesktop, CleanupUnconfirmed, MAX_LIFETIME_SECONDS
from uia_client import UiaTree, ROLE_NAMES, UiaError, MAX_ELEMENTS
from uia_identity import IDENTITY_KEYS, same_identity

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET_APP = os.path.join(LAB_DIR, "spawn_window.py")

# 本家族全部能力共用的副作用声明：这是"不影响本机"这条区分的落点。
NO_USER_IMPACT = {
    "touchesUserDesktop": False,
    "sendsSystemInput": False,
    "changesForeground": False,
    "touchesClipboard": False,
}

HIDDEN_ONLY = [
    {"kind": "hidden-desktop", "status": "verified",
     "evidence": "本子工程真机验证", "limitation": "单隐藏桌面、单自有进程、单窗口"},
    {"kind": "vm", "status": "planned", "evidence": "未实现"},
    {"kind": "browser", "status": "forbidden", "evidence": "浏览器走 Playwright，不使用本家族"},
    {"kind": "user-desktop", "status": "forbidden", "evidence": "本家族定义不允许"},
]


def _target_field(help_text="定位目标控件；不填偏移时点其客户区中心"):
    return {"type": "target", "label": "目标控件", "required": True, "help": help_text,
            "optionalConstraints": {'expectedIdentity': {'type': 'object',
                'requiredKeys': list(IDENTITY_KEYS),
                'help': '传入上一定位的 identity；仍重新全局查询，并拒绝身份变化'}}}


# --------------------------------------------------------------------------- #
# 声明
# --------------------------------------------------------------------------- #
CAPABILITIES: list[dict] = [
    # ---- environment ----
    {
        "id": "env.hidden.open", "version": "1.0.0", "layer": "environment", "operation": "attach",
        "summary": "创建自有隐藏桌面与 KILL_ON_JOB_CLOSE 的 Job。权限掩码固定 0xC3，不含 SWITCHDESKTOP。",
        "effects": dict(NO_USER_IMPACT), "idempotent": False, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": [],
        "guarantees": [
            {"statement": "创建后控制线程仍停留在 default 桌面", "check": "env.identity.probe"},
            {"statement": "桌面名带 AgentD0_ 前缀且 Job 已挂 KILL_ON_JOB_CLOSE", "check": "env.identity.probe"},
        ],
        "refuses": [
            {"condition": "交互会话非活跃或输入桌面不是 default", "code": "session-not-default"},
            {"condition": "本进程完整性不是 ordinary medium", "code": "integrity-not-medium"},
            {"condition": "同名桌面已存在", "code": "desktop-already-exists"},
        ],
        "errors": [
            {"code": "session-not-default", "kind": "blocked", "retryable": False},
            {"code": "integrity-not-medium", "kind": "blocked", "retryable": False},
            {"code": "desktop-already-exists", "kind": "unavailable", "retryable": True},
        ],
        "input": {"type": "object", "properties": {}},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "identity"}]},
        "budget": {"timeoutMs": 5000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 4},
        "knownUnsupported": [],
    },
    {
        "id": "env.app.launch", "version": "1.0.0", "layer": "environment", "operation": "attach",
        "summary": "在自有隐藏桌面上启动自有进程：STARTUPINFO.lpDesktop 指向该桌面，先挂 Job 再恢复线程。",
        "effects": dict(NO_USER_IMPACT), "idempotent": False, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen"],
        "guarantees": [
            {"statement": "进程落在自有隐藏桌面上且属于本次 Job", "check": "verify.target.identity"},
        ],
        "refuses": [
            {"condition": "隐藏桌面未打开或租约已过期", "code": "hidden-desktop-not-open"},
            {"condition": "可执行文件不存在或不是 .exe", "code": "invalid-executable"},
            {"condition": "同名进程已在本机运行（单实例应用会把请求重定向到它，拿不到自有窗口）",
             "code": "existing-instance"},
            {"condition": "已经启动过一次（本会话不再重复启动）", "code": "already-started"},
        ],
        "errors": [
            {"code": "hidden-desktop-not-open", "kind": "stale", "retryable": True},
            {"code": "invalid-executable", "kind": "blocked", "retryable": False},
            {"code": "existing-instance", "kind": "blocked", "retryable": False},
            {"code": "already-started", "kind": "blocked", "retryable": False},
            {"code": "probe-unavailable", "kind": "unavailable", "retryable": True},
        ],
        "input": {"type": "object", "properties": {
            "app": {"type": "choice", "label": "目标程序", "required": True,
                    "choices": [{"value": "builtin", "label": "自带能力测试目标窗口"},
                                {"value": "custom", "label": "自定义 .exe 路径"}],
                    "default": "builtin"},
            "path": {"type": "string", "label": ".exe 绝对路径（选自定义时必填）"},
            "args": {"type": "string", "label": "附加命令行参数（空格分隔）",
                     "help": "例如 CEF 应用需要 --force-renderer-accessibility 才会暴露 UIA 控件树"},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "identity"}]},
        "budget": {"timeoutMs": 20000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 5},
        "knownUnsupported": [
            "不猜应用需要的启动参数：需要特殊参数（如 CEF 的无障碍开关）才能暴露控件树的应用，"
            "由调用方通过 args 传入，能力本身不做应用特判",
        ],
    },
    {
        "id": "env.app.close", "version": "1.0.0", "layer": "environment", "operation": "release",
        "summary": "终止 Job、关闭桌面，并**确认桌面对象消失**；未确认则标记封锁并如实报错。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": [],
        "guarantees": [
            {"statement": "OpenDesktopW 返回 ERROR_FILE_NOT_FOUND，桌面确实不存在", "check": "env.identity.probe"},
            {"statement": "Job 内进程数为 0", "check": "env.identity.probe"},
        ],
        "refuses": [
            {"condition": "桌面或 Job 无法确认已清空", "code": "cleanup-unconfirmed"},
        ],
        "errors": [{"code": "cleanup-unconfirmed", "kind": "unknown", "retryable": False}],
        "input": {"type": "object", "properties": {}},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "identity"}]},
        "budget": {"timeoutMs": 10000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 4},
        "knownUnsupported": [],
    },
    {
        "id": "env.identity.probe", "version": "1.0.0", "layer": "environment", "operation": "verify",
        "summary": "只读环境自检：会话是否活跃、输入桌面是否仍为 default、自身完整性、桌面与 Job 状态。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": [],
        "guarantees": [{"statement": "只读；不创建、不修改、不释放任何资源", "check": "env.identity.probe"}],
        "refuses": [],
        "errors": [{"code": "probe-unavailable", "kind": "unavailable", "retryable": True}],
        "input": {"type": "object", "properties": {}},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "identity"}]},
        "budget": {"timeoutMs": 3000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 2},
        "knownUnsupported": [],
    },

    # ---- observe ----
    {
        "id": "observe.window.enumerate", "version": "1.0.0", "layer": "observe", "operation": "observe",
        "summary": "枚举自有隐藏桌面上的顶层窗口，并给出进程归属。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen"],
        "guarantees": [{"statement": "返回的窗口都在自有桌面上", "check": "verify.target.identity"}],
        "refuses": [{"condition": "桌面未打开或租约过期", "code": "hidden-desktop-not-open"}],
        "errors": [{"code": "hidden-desktop-not-open", "kind": "stale", "retryable": True}],
        "input": {"type": "object", "properties": {}},
        "output": {"result": {"type": "array"}, "evidence": [{"kind": "identity"}]},
        "budget": {"timeoutMs": 3000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 2},
        "knownUnsupported": ["子控件不在枚举结果里（EnumDesktopWindows 只给顶层窗口）"],
    },
    {
        "id": "observe.uia.tree", "version": "1.0.0", "layer": "observe", "operation": "observe",
        "summary": "通过 UIA 枚举自有窗口的控件树：role / name / autoId / class / enabled / offscreen / rect / native。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [
            {"statement": "每个元素都校验过：进程属于本次 Job、会话一致、原生窗口归属自有窗口树", "check": "verify.target.identity"},
            {"statement": "密码控件一律不出现", "check": "observe.uia.tree"},
        ],
        "refuses": [
            {"condition": "没有唯一自有窗口", "code": "requires-unique-window"},
            {"condition": "元素不属于本次 Job 或会话", "code": "element-process-mismatch"},
            {"condition": "元素的原生窗口不在自有窗口树里", "code": "native-window-outside-workspace"},
        ],
        "errors": [
            {"code": "requires-unique-window", "kind": "stale", "retryable": True},
            {"code": "element-process-mismatch", "kind": "blocked", "retryable": False},
            {"code": "native-window-outside-workspace", "kind": "blocked", "retryable": False},
            {"code": "tree-budget-exhausted", "kind": "blocked", "retryable": False},
        ],
        "input": {"type": "object", "properties": {
            "role": {"type": "choice", "label": "只保留某个 role（空=全部）", "default": "",
                     "choices": [{"value": "", "label": "全部"}]
                     + [{"value": str(k), "label": v} for k, v in sorted(ROLE_NAMES.items())]},
        }},
        "output": {"result": {"type": "array"}, "evidence": [{"kind": "structured"}]},
        "budget": {"timeoutMs": 45000, "maxElements": 2000},
        "conformance": {"suite": "tests/test_capabilities.py", "cases": 3},
        "knownUnsupported": [
            "自绘界面（Canvas/DirectX）内部无 UIA 控件",
            "每个元素要读 6 个 COM 属性，真实 CEF 应用 627 个元素约 11 秒；"
            "本次枚举被预算截断时结果里 enumerationComplete=false，此时不得据此判定控件不存在",
        ],
    },
    {
        "id": "observe.capture", "version": "1.0.0", "layer": "observe", "operation": "observe",
        "summary": "PrintWindow(PW_RENDERFULLCONTENT) 抓取窗口像素，返回可复核的 PNG 引用。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [
            {"statement": "抓取前确认默认桌面未被切换", "check": "env.identity.probe"},
            {"statement": "PNG 落在私有随机目录，只暴露 32 位 hex token", "check": "verify.target.identity"},
        ],
        "refuses": [
            {"condition": "没有唯一自有窗口", "code": "requires-unique-window"},
            {"condition": "窗口几何超出 2048 上限", "code": "invalid-capture-geometry"},
            {"condition": "PNG 超过 4 MiB", "code": "preview-size-limit"},
            {"condition": "待处理画面已达 8 张", "code": "preview-pending-limit"},
        ],
        "errors": [
            {"code": "requires-unique-window", "kind": "stale", "retryable": True},
            {"code": "invalid-capture-geometry", "kind": "blocked", "retryable": False},
            {"code": "preview-size-limit", "kind": "blocked", "retryable": False},
            {"code": "preview-pending-limit", "kind": "blocked", "retryable": True},
        ],
        "input": {"type": "object", "properties": {
            "allowUnrendered": {"type": "boolean", "label": "允许显示未渲染（单色）画面", "default": True},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "screenshot"}]},
        "budget": {"timeoutMs": 6000, "maxPayloadBytes": 4194304},
        "conformance": {"suite": "tests/test_capabilities.py", "cases": 5},
        "knownUnsupported": [],
    },
    {
        "id": "observe.state.read", "version": "1.0.0", "layer": "observe", "operation": "observe",
        "summary": "读单个控件的一个字段：name / value / enabled / offscreen / rect / autoId / role / className。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [{"statement": "只读 pattern，不写入、不调用", "check": "observe.uia.tree"}],
        "refuses": [
            {"condition": "目标不唯一", "code": "target-not-unique"},
            {"condition": "该控件不支持 ValuePattern（读 value 时）", "code": "value-pattern-unavailable"},
        ],
        "errors": [
            {"code": "target-not-unique", "kind": "blocked", "retryable": True},
            {"code": "value-pattern-unavailable", "kind": "unavailable", "retryable": False},
        ],
        "input": {"type": "object", "properties": {
            "target": _target_field(),
            "field": {"type": "choice", "label": "字段", "required": True, "default": "value",
                      "choices": [{"value": c, "label": c} for c in
                                  ("name", "value", "enabled", "offscreen", "rect", "autoId", "role", "className")]},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "structured"}]},
        "budget": {"timeoutMs": 5000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 3},
        "knownUnsupported": ["只有支持 ValuePattern 的控件能读 value"],
    },

    # ---- ground ----
    {
        "id": "locate.window", "version": "1.0.0", "layer": "ground", "operation": "locate",
        "summary": "在自有进程树的顶层窗口里选定目标窗口（按 className / title / 最大面积），**必须唯一**。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen"],
        "guarantees": [
            {"statement": "入选窗口的进程必须属于本次 Job（多进程应用的子进程窗口也算自有）", "check": "verify.target.identity"},
            {"statement": "候选数不为 1 时一定拒绝，绝不取第一个", "check": "locate.window"},
        ],
        "refuses": [
            {"condition": "自有进程还没有任何顶层窗口", "code": "target-windows-absent"},
            {"condition": "按给定条件匹配 0 个或多于 1 个", "code": "target-not-unique"},
            {"condition": "指定的选择方式不受支持", "code": "unsupported-locator"},
        ],
        "errors": [
            {"code": "target-windows-absent", "kind": "stale", "retryable": True},
            {"code": "target-not-unique", "kind": "blocked", "retryable": True},
            {"code": "unsupported-locator", "kind": "blocked", "retryable": False},
        ],
        "input": {"type": "object", "properties": {
            "kind": {"type": "choice", "label": "选择方式", "required": True, "default": "largest",
                     "choices": [{"value": "largest", "label": "最大客户区（默认）"},
                                 {"value": "className", "label": "窗口类名"},
                                 {"value": "title", "label": "标题含"},
                                 {"value": "hwnd", "label": "指定 hwnd"}]},
            "value": {"type": "string", "label": "选择值（除最大面积外必填）"},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "structured"}]},
        "budget": {"timeoutMs": 5000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 3},
        "knownUnsupported": [
            "真实应用会建出十几个顶层窗口（IME 指示器、托盘、歌词窗、SMTC 等）；"
            "\"自动唯一\"只适用自建的单窗口目标，真实应用必须先显式选定",
        ],
    },
    {
        "id": "act.window.fit", "version": "1.0.0", "layer": "execute", "operation": "act",
        "summary": "把自有目标窗口显示出来并定尺到可用几何（ShowWindow + SetWindowPos，不激活、不改 Z 序）。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [
            {"statement": "只改自有窗口的显示状态与几何，不抢前台、不动 Z 序", "check": "env.identity.probe"},
            {"statement": "定尺后窗口几何等于请求值且在尺寸预算内", "check": "observe.window.enumerate"},
        ],
        "refuses": [
            {"condition": "宽高超出尺寸预算", "code": "owned-window-size-budget"},
            {"condition": "目标不是自有隐藏桌面上的自有窗口", "code": "target-outside-owned-job"},
        ],
        "errors": [
            {"code": "owned-window-size-budget", "kind": "blocked", "retryable": False},
            {"code": "target-outside-owned-job", "kind": "blocked", "retryable": False},
        ],
        "input": {"type": "object", "properties": {
            "width": {"type": "integer", "label": "宽度（400..2048）", "default": 1600},
            "height": {"type": "integer", "label": "高度（300..2048）", "default": 1000},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "identity"}]},
        "budget": {"timeoutMs": 8000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 3},
        "knownUnsupported": [
            "不猜测应用自身的理想尺寸：调用方给出尺寸，超出预算一律拒绝",
        ],
    },
    {
        "id": "locate.structured", "version": "1.0.0", "layer": "ground", "operation": "locate",
        "summary": "按 autoId / role(+name) / label / text / className 在 UIA 树里定位，**必须唯一**，否则拒绝。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [
            {"statement": "匹配数不为 1 时一定拒绝，绝不取第一个", "check": "locate.structured"},
            {"statement": "只返回 enabled 且非 offscreen 的控件", "check": "locate.structured"},
        ],
        "refuses": [
            {"condition": "匹配 0 个或超过 1 个", "code": "target-not-unique"},
            {"condition": "目标被禁用或在屏外", "code": "target-not-usable"},
            {"condition": "指定的定位方式不受支持", "code": "unsupported-locator"},
            {"condition": "没找到，且本次枚举被预算截断（不能据此判定不存在）",
             "code": "enumeration-truncated"},
        ],
        "errors": [
            {"code": "target-not-unique", "kind": "blocked", "retryable": True},
            {"code": "target-not-usable", "kind": "stale", "retryable": True},
            {"code": "unsupported-locator", "kind": "blocked", "retryable": False},
            {"code": "enumeration-truncated", "kind": "stale", "retryable": True},
        ],
        "input": {"type": "object", "properties": {
            "kind": {"type": "choice", "label": "定位方式", "required": True, "default": "autoId",
                     "choices": [{"value": "autoId", "label": "autoId"},
                                 {"value": "role", "label": "role(+name)"},
                                 {"value": "label", "label": "label（name 相等）"},
                                 {"value": "text", "label": "text（name 含）"},
                                 {"value": "className", "label": "className"}]},
            "value": {"type": "string", "label": "目标值", "required": True},
            "role": {"type": "string", "label": "role（选 role 方式时必填，如 Button）"},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "structured"}]},
        "budget": {"timeoutMs": 5000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 4},
        "knownUnsupported": ["坐标与截图模板不能作为主要定位方式（本家族未实现模板/视觉/OCR）"],
    },
    {
        "id": "locate.template", "version": "0.0.0", "layer": "ground", "operation": "locate",
        "summary": "OpenCV 模板匹配定位（未实现）。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "planned",
        "environments": [{"kind": "hidden-desktop", "status": "planned", "evidence": "未实现"}],
        "requires": ["hiddenDesktopOpen"], "guarantees": [], "refuses": [],
        "errors": [{"code": "not-implemented", "kind": "unavailable", "retryable": False}],
        "input": {"type": "object", "properties": {}}, "output": {"result": {}, "evidence": []},
        "budget": {"timeoutMs": 1000}, "conformance": {"suite": "", "cases": 0}, "knownUnsupported": [],
    },
    {
        "id": "locate.vision", "version": "0.0.0", "layer": "ground", "operation": "locate",
        "summary": "截图 + 模型边界框定位（未实现）。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "planned",
        "environments": [{"kind": "hidden-desktop", "status": "planned", "evidence": "未实现"}],
        "requires": ["hiddenDesktopOpen"], "guarantees": [], "refuses": [],
        "errors": [{"code": "not-implemented", "kind": "unavailable", "retryable": False}],
        "input": {"type": "object", "properties": {}}, "output": {"result": {}, "evidence": []},
        "budget": {"timeoutMs": 1000}, "conformance": {"suite": "", "cases": 0}, "knownUnsupported": [],
    },
    {
        "id": "locate.ocr", "version": "0.0.0", "layer": "ground", "operation": "locate",
        "summary": "文字识别定位（未实现）。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "planned",
        "environments": [{"kind": "hidden-desktop", "status": "planned", "evidence": "未实现"}],
        "requires": ["hiddenDesktopOpen"], "guarantees": [], "refuses": [],
        "errors": [{"code": "not-implemented", "kind": "unavailable", "retryable": False}],
        "input": {"type": "object", "properties": {}}, "output": {"result": {}, "evidence": []},
        "budget": {"timeoutMs": 1000}, "conformance": {"suite": "", "cases": 0}, "knownUnsupported": [],
    },

    # ---- execute ----
    {
        "id": "act.click", "version": "1.0.0", "layer": "execute", "operation": "act",
        "summary": "向目标控件发左键点击（定向窗口消息，含双击）；按控件矩形换算点位，并沿窗口树下钻到真正接收输入的窗口。",
        "effects": dict(NO_USER_IMPACT), "idempotent": False, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [
            {"statement": "消息只投递给自有进程的窗口", "check": "verify.target.identity"},
            {"statement": "点击后默认桌面未切换、前台窗口未变", "check": "env.identity.probe"},
        ],
        "refuses": [
            {"condition": "目标不唯一", "code": "target-not-unique"},
            {"condition": "坐标落在目标客户区之外", "code": "click-outside-target"},
            {"condition": "目标不是自有进程/自有桌面/本次 Job", "code": "target-not-owned"},
            {"condition": "租约已过期", "code": "lease-expired"},
        ],
        "errors": [
            {"code": "target-not-unique", "kind": "blocked", "retryable": True},
            {"code": "click-outside-target", "kind": "stale", "retryable": True},
            {"code": "target-not-owned", "kind": "blocked", "retryable": False},
            {"code": "lease-expired", "kind": "stale", "retryable": True},
            {"code": "dispatch-effect-unknown", "kind": "unknown", "retryable": False},
        ],
        "input": {"type": "object", "properties": {
            "target": _target_field(),
            "offsetX": {"type": "integer", "label": "偏移 X（像素，留空=中心）"},
            "offsetY": {"type": "integer", "label": "偏移 Y（像素，留空=中心）"},
            "double": {"type": "boolean", "label": "双击", "default": False},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "identity"}, {"kind": "screenshot"}]},
        "budget": {"timeoutMs": 2000, "maxCalls": 16},
        "conformance": {"suite": "tests/test_capabilities.py", "cases": 4},
        "knownUnsupported": ["拖拽、滚轮、多指手势"],
    },
    {
        "id": "act.type", "version": "1.0.0", "layer": "execute", "operation": "act",
        "summary": "用 WM_CHAR 逐字把文本送进目标控件（定向输入，不经过键盘与 IME）；有控件矩形时下钻到真正的输入接收窗口。",
        "effects": dict(NO_USER_IMPACT), "idempotent": False, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [{"statement": "文本经窗口消息直投目标，不进入系统输入队列", "check": "verify.target.identity"}],
        "refuses": [
            {"condition": "目标不唯一", "code": "target-not-unique"},
            {"condition": "文本超过 512 字符", "code": "text-limit-reached"},
            {"condition": "租约已过期", "code": "lease-expired"},
        ],
        "errors": [
            {"code": "target-not-unique", "kind": "blocked", "retryable": True},
            {"code": "text-limit-reached", "kind": "blocked", "retryable": False},
            {"code": "lease-expired", "kind": "stale", "retryable": True},
        ],
        "input": {"type": "object", "properties": {
            "target": _target_field(),
            "text": {"type": "string", "label": "要输入的文本", "required": True},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "structured"}]},
        "budget": {"timeoutMs": 5000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 3},
        "knownUnsupported": ["不支持 IME 组词、快捷键组合、粘贴板"],
    },
    {
        "id": "act.set_value", "version": "1.0.0", "layer": "execute", "operation": "act",
        "summary": "UIA ValuePattern 语义赋值，并**读回校验**；不一致即报错。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [{"statement": "返回成功时控件值确实等于目标值", "check": "observe.state.read"}],
        "refuses": [
            {"condition": "目标不唯一", "code": "target-not-unique"},
            {"condition": "控件不支持 ValuePattern", "code": "value-pattern-unavailable"},
            {"condition": "1.5 秒内值未生效", "code": "value-effect-mismatch"},
        ],
        "errors": [
            {"code": "target-not-unique", "kind": "blocked", "retryable": True},
            {"code": "value-pattern-unavailable", "kind": "unavailable", "retryable": False},
            {"code": "value-effect-mismatch", "kind": "unknown", "retryable": False},
        ],
        "input": {"type": "object", "properties": {
            "target": _target_field(),
            "text": {"type": "string", "label": "目标值", "required": True},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "structured"}]},
        "budget": {"timeoutMs": 4000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 3},
        "knownUnsupported": ["部分控件只更新显示值而不触发业务逻辑"],
    },
    {
        "id": "act.invoke", "version": "1.0.0", "layer": "execute", "operation": "act",
        "summary": "UIA InvokePattern.Invoke。取不到则明确失败，不退化成物理点击。",
        "effects": dict(NO_USER_IMPACT), "idempotent": False, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [{"statement": "调用的是目标控件自身的可访问性接口", "check": "verify.target.identity"}],
        "refuses": [
            {"condition": "目标不唯一", "code": "target-not-unique"},
            {"condition": "控件不支持 InvokePattern", "code": "invoke-pattern-unavailable"},
        ],
        "errors": [
            {"code": "target-not-unique", "kind": "blocked", "retryable": True},
            {"code": "invoke-pattern-unavailable", "kind": "unavailable", "retryable": False},
        ],
        "input": {"type": "object", "properties": {"target": _target_field()}},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "structured"}]},
        "budget": {"timeoutMs": 3000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 2},
        "knownUnsupported": [],
    },
    {
        "id": "act.cancel", "version": "1.0.0", "layer": "execute", "operation": "act",
        "summary": "WM_CANCELMODE：清掉目标窗口内持有的鼠标捕获等状态，属目标局部清理。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen"],
        "guarantees": [{"statement": "只影响目标窗口自身状态", "check": "verify.target.identity"}],
        "refuses": [{"condition": "目标窗口已不存在", "code": "target-exited"}],
        "errors": [{"code": "target-exited", "kind": "stale", "retryable": True}],
        "input": {"type": "object", "properties": {}},
        "output": {"result": {"type": "object"}, "evidence": []},
        "budget": {"timeoutMs": 2000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 2},
        "knownUnsupported": [],
    },
    {
        "id": "act.keypress", "version": "0.0.0", "layer": "execute", "operation": "act",
        "summary": "键盘序列输入（未实现；能力表 RAW_ISOLATED_INPUT = NOT_PROVEN）。",
        "effects": dict(NO_USER_IMPACT), "idempotent": False, "status": "planned",
        "environments": [{"kind": "hidden-desktop", "status": "planned", "evidence": "未实现"}],
        "requires": ["hiddenDesktopOpen"], "guarantees": [], "refuses": [],
        "errors": [{"code": "not-implemented", "kind": "unavailable", "retryable": False}],
        "input": {"type": "object", "properties": {}}, "output": {"result": {}, "evidence": []},
        "budget": {"timeoutMs": 1000}, "conformance": {"suite": "", "cases": 0}, "knownUnsupported": [],
    },
    {
        "id": "act.drag", "version": "0.0.0", "layer": "execute", "operation": "act",
        "summary": "拖拽（未实现）。",
        "effects": dict(NO_USER_IMPACT), "idempotent": False, "status": "planned",
        "environments": [{"kind": "hidden-desktop", "status": "planned", "evidence": "未实现"}],
        "requires": ["hiddenDesktopOpen"], "guarantees": [], "refuses": [],
        "errors": [{"code": "not-implemented", "kind": "unavailable", "retryable": False}],
        "input": {"type": "object", "properties": {}}, "output": {"result": {}, "evidence": []},
        "budget": {"timeoutMs": 1000}, "conformance": {"suite": "", "cases": 0}, "knownUnsupported": [],
    },
    {
        "id": "act.scroll", "version": "0.0.0", "layer": "execute", "operation": "act",
        "summary": "滚轮（未实现）。",
        "effects": dict(NO_USER_IMPACT), "idempotent": False, "status": "planned",
        "environments": [{"kind": "hidden-desktop", "status": "planned", "evidence": "未实现"}],
        "requires": ["hiddenDesktopOpen"], "guarantees": [], "refuses": [],
        "errors": [{"code": "not-implemented", "kind": "unavailable", "retryable": False}],
        "input": {"type": "object", "properties": {}}, "output": {"result": {}, "evidence": []},
        "budget": {"timeoutMs": 1000}, "conformance": {"suite": "", "cases": 0}, "knownUnsupported": [],
    },

    # ---- verify ----
    {
        "id": "verify.target.identity", "version": "1.0.0", "layer": "verify", "operation": "verify",
        "summary": "归属核对：pid / 桌面 / 会话 / 同用户 / 在 Job 内 / 镜像路径。只读。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [{"statement": "全部子判据为真才返回 ok", "check": "verify.target.identity"}],
        "refuses": [
            {"condition": "窗口不在自有桌面或不属于自有进程", "code": "target-not-owned"},
            {"condition": "进程不在本次 Job 内", "code": "target-outside-owned-job"},
        ],
        "errors": [
            {"code": "target-not-owned", "kind": "blocked", "retryable": False},
            {"code": "target-outside-owned-job", "kind": "blocked", "retryable": False},
        ],
        "input": {"type": "object", "properties": {}},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "identity"}]},
        "budget": {"timeoutMs": 4000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 3},
        "knownUnsupported": [],
    },
    {
        "id": "verify.capture.rendered", "version": "1.0.0", "layer": "verify", "operation": "verify",
        "summary": "抓一次画面并判定是否真的渲染了（单色 = 未渲染）。只读。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [{"statement": "判定与抓取在同一次调用内完成，不用旧帧", "check": "observe.capture"}],
        "refuses": [{"condition": "没有唯一自有窗口", "code": "requires-unique-window"}],
        "errors": [{"code": "requires-unique-window", "kind": "stale", "retryable": True}],
        "input": {"type": "object", "properties": {}},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "screenshot"}]},
        "budget": {"timeoutMs": 6000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 2},
        "knownUnsupported": [],
    },
    {
        "id": "verify.structured.equals", "version": "1.0.0", "layer": "verify", "operation": "verify",
        "summary": "结构化字段严格相等断言：目标唯一 + 字段完全相等才算达成。只读。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen", "targetWindowResolved"],
        "guarantees": [{"statement": "是严格相等，不是包含", "check": "observe.state.read"}],
        "refuses": [
            {"condition": "目标不唯一", "code": "target-not-unique"},
            {"condition": "字段值不相等", "code": "assertion-failed"},
        ],
        "errors": [
            {"code": "target-not-unique", "kind": "blocked", "retryable": True},
            {"code": "assertion-failed", "kind": "blocked", "retryable": True},
        ],
        "input": {"type": "object", "properties": {
            "target": _target_field(),
            "field": {"type": "choice", "label": "字段", "required": True, "default": "value",
                      "choices": [{"value": c, "label": c} for c in ("value", "name", "enabled")]},
            "expected": {"type": "string", "label": "期望值（严格相等）", "required": True},
        }},
        "output": {"result": {"type": "object"}, "evidence": [{"kind": "structured"}]},
        "budget": {"timeoutMs": 5000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 3},
        "knownUnsupported": [],
    },

    # ---- control ----
    {
        "id": "control.lease.renew", "version": "1.0.0", "layer": "control", "operation": "act",
        "summary": "显式续租：把 deadline 推到 now + lifetime。过期后仍可用，但不做静默续期。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": ["hiddenDesktopOpen"],
        "guarantees": [{"statement": "只有打开且未封锁时才能续租", "check": "env.identity.probe"}],
        "refuses": [
            {"condition": "隐藏桌面未打开", "code": "hidden-desktop-not-open"},
            {"condition": "已封锁（清理未确认）", "code": "cleanup-unconfirmed"},
        ],
        "errors": [
            {"code": "hidden-desktop-not-open", "kind": "stale", "retryable": True},
            {"code": "cleanup-unconfirmed", "kind": "unknown", "retryable": False},
        ],
        "input": {"type": "object", "properties": {
            "seconds": {"type": "integer", "label": "租约秒数（1..3600，留空=沿用当前）"},
        }},
        "output": {"result": {"type": "object"}, "evidence": []},
        "budget": {"timeoutMs": 1000}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 4},
        "knownUnsupported": [],
    },
    {
        "id": "control.budget.consume", "version": "1.0.0", "layer": "control", "operation": "verify",
        "summary": "查看本次会话的动作计数与上限（只读计数，不消耗）。",
        "effects": dict(NO_USER_IMPACT), "idempotent": True, "status": "verified",
        "environments": HIDDEN_ONLY, "requires": [],
        "guarantees": [{"statement": "只读计数", "check": "control.budget.consume"}],
        "refuses": [], "errors": [],
        "input": {"type": "object", "properties": {}},
        "output": {"result": {"type": "object"}, "evidence": []},
        "budget": {"timeoutMs": 500}, "conformance": {"suite": "tests/test_capabilities.py", "cases": 2},
        "knownUnsupported": [],
    },
]

for _item in CAPABILITIES:
    if _item['id'] == 'locate.structured':
        _item['input']['optionalConstraints'] = _target_field()['optionalConstraints']
    if any(field.get('type') == 'target' for field in _item['input']['properties'].values()) \
            or _item['id'] in ('locate.structured', 'observe.uia.tree', 'verify.target.identity'):
        _item['version'] = '1.1.0'

CAPABILITY_INDEX = {item["id"]: item for item in CAPABILITIES}

# 平台级错误码目录：与单条能力的拒绝条件无关，但**任何**能力都可能返回它们
# （探测不可用、桌面绑定漂移、画面资源失效、UIA 不可用、消息超时……）。
# 存在的意义是让"内部异常 → 稳定错误码"成为闭集：调用方只依赖 code，
# 不允许内部码悄悄退化成"未知"。完整性由 test_capabilities 的门禁测试保证。
ERROR_CATALOG = {
    "probe-unavailable": ("unavailable", True),
    "invalid-argument": ("blocked", False),
    "target-desktop-mismatch": ("stale", True),
    "requires-owned-process": ("stale", True),
    "preview-unavailable": ("stale", True),
    "preview-not-found": ("stale", True),
    "preview-path-escape": ("blocked", False),
    "preview-integrity-failed": ("blocked", False),
    "uia-unavailable": ("unavailable", True),
    "target-identity-changed": ("stale", False),
    "message-timeout": ("stale", True),
    "process-snapshot-unavailable": ("unavailable", True),
}

# 错误码 → 稳定分类：先用声明里的，再用平台目录补齐；调用方应只依赖 code。
ERROR_KINDS = {entry["code"]: entry["kind"]
               for item in CAPABILITIES for entry in item.get("errors", [])}
for _code, (_kind, _retry) in ERROR_CATALOG.items():
    ERROR_KINDS.setdefault(_code, _kind)


class CapabilityError(Exception):
    """能力拒绝或失败；message 是稳定错误码，细节放在 detail。"""

    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code = code
        self.detail = detail
        self.kind = ERROR_KINDS.get(code, "unknown")

    def payload(self):
        return {"code": self.code, "kind": self.kind, "detail": self.detail}


def _as_code(error):
    """把内部异常翻译成稳定错误码。"""
    if isinstance(error, CapabilityError):
        return error
    if isinstance(error, UiaError):
        text = str(error)
        mapping = {
            "uia-requires-unique-owned-window": "requires-unique-window",
            "uia-tree-budget-exhausted": "tree-budget-exhausted",
            "uia-element-process-mismatch": "element-process-mismatch",
            "uia-password-element-forbidden": "element-process-mismatch",
            "uia-native-window-outside-workspace": "native-window-outside-workspace",
            "uia-value-effect-mismatch": "value-effect-mismatch",
            "uia-unsupported-role": "unsupported-locator",
            "uia-query-role-mismatch": "target-not-usable",
            "uia-target-identity-changed": "target-identity-changed",
            "uia-ancestry-unproven": "target-not-usable",
            "uia-runtime-id-unavailable": "uia-unavailable",
        }
        if text in mapping:
            return CapabilityError(mapping[text], text)
        if text.startswith("uia-hresult-80040204") or text.startswith("uia-hresult-80004002"):
            return CapabilityError("value-pattern-unavailable", text)
        uia_mapping = {
            "uia-client-creation-failed": "uia-unavailable",
            "uia-com-initialization-failed": "uia-unavailable",
            "uia-null-interface": "uia-unavailable",
            "uia-native-window-process-mismatch": "native-window-outside-workspace",
        }
        if text in uia_mapping:
            return CapabilityError(uia_mapping[text], text)
        # 其余 hresult 不猜具体含义，交给声明里的通用未知分类。
        return CapabilityError("dispatch-effect-unknown", text)
    if isinstance(error, CleanupUnconfirmed):
        return CapabilityError("cleanup-unconfirmed", error.errors)
    if isinstance(error, Blocked):
        mapping = {
            "hidden_desktop_not_open": "hidden-desktop-not-open",
            "hidden_desktop_lease_expired": "lease-expired",
            "cleanup_unconfirmed": "cleanup-unconfirmed",
            "target_not_unique": "target-not-unique",
            "target_windows_absent": "target-windows-absent",
            "unsupported_locator": "unsupported-locator",
            "owned_window_size_budget": "owned-window-size-budget",
            "target_not_owned_process": "target-not-owned",
            "target_desktop_mismatch": "target-not-owned",
            "target_outside_owned_job": "target-outside-owned-job",
            "target_exited": "target-exited",
            "click_outside_target": "click-outside-target",
            "already_started": "already-started",
            "invalid_executable": "invalid-executable",
            "desktop_already_exists": "desktop-already-exists",
            "interactive_session_not_active": "session-not-default",
            "user_input_desktop_not_default": "session-not-default",
            "ordinary_medium_required": "integrity-not-medium",
            "invalid_capture_geometry": "invalid-capture-geometry",
            "preview_size_limit": "preview-size-limit",
            "preview_pending_limit": "preview-pending-limit",
            "preview_unrendered": "preview-unrendered",
            "invalid_desktop_name": "target-not-owned",
            "invalid_preview_token": "target-not-owned",
            "process_snapshot_unavailable": "process-snapshot-unavailable",
            # 以下内部码在真实应用验证中被实际触发过：它们必须各自有稳定归属，
            # 不允许退化成 dispatch-effect-unknown。
            "capture_requires_owned_process": "requires-owned-process",
            "capture_requires_unique_window": "target-not-unique",
            "capture_ownership_unconfirmed": "target-outside-owned-job",
            "default_restore_unconfirmed": "target-desktop-mismatch",
            "hidden_desktop_bind_failed": "target-desktop-mismatch",
            "hidden_desktop_bind_unconfirmed": "target-desktop-mismatch",
            "desktop_name_unavailable": "probe-unavailable",
            "window_class_unavailable": "probe-unavailable",
            "window_style_unavailable": "probe-unavailable",
            "token_information_unavailable": "probe-unavailable",
            "invalid_lease_seconds": "invalid-argument",
            "job_already_exists": "desktop-already-exists",
            "preview_not_found": "preview-not-found",
            "preview_unavailable": "preview-unavailable",
            "preview_path_escape": "preview-path-escape",
            "preview_integrity_failed": "preview-integrity-failed",
            "preview_identity_changed": "target-identity-changed",
            "message_timeout": "message-timeout",
        }
        if str(error) in mapping:
            return CapabilityError(mapping[str(error)], str(error))
        return CapabilityError("dispatch-effect-unknown", str(error))
    return CapabilityError("dispatch-effect-unknown", "%s: %s" % (type(error).__name__, error))


class CapabilityRuntime:
    """持有隐藏桌面会话，按能力 id 分发实现，并由声明驱动可用性判定。"""

    def __init__(self, lease=300, clock=time.monotonic):
        self.clock = clock
        self.lease = lease
        self.desktop = None
        self.log = []
        self.actions = 0
        self.max_actions = 256

    # -- 会话 -------------------------------------------------------------- #
    def _fresh(self):
        if self.desktop is None or self.desktop.blocked or not self.desktop.context:
            self.desktop = HiddenDesktop(clock=self.clock, lifetime=self.lease)
        return self.desktop

    def log_line(self, message, level="info"):
        entry = {"at": time.strftime("%H:%M:%S"), "level": level, "message": message}
        self.log.append(entry)
        del self.log[:-400]
        return entry

    # -- 事实探测（调用方不能申报） ----------------------------------------- #
    def facts(self):
        facts = {"hiddenDesktopOpen": False, "ownedAppRunning": False,
                 "targetWindowResolved": False, "targetWindowSource": None,
                 "uniqueOwnedWindow": False, "leaseActive": False, "budgetAvailable": True}
        desktop = self.desktop
        if desktop is None or not desktop.context:
            return facts
        facts["hiddenDesktopOpen"] = True
        facts["leaseActive"] = desktop.remaining() not in (None, 0)
        facts["ownedAppRunning"] = bool(desktop.process)
        facts["budgetAvailable"] = self.actions < self.max_actions
        # 目标窗口按"显式选定的优先，否则要求自动唯一"解析；解析不出来就是不可用。
        # 这里刻意不用"可见性"当判据：真实 CEF 应用的界面窗口在显示前是不可见的小尺寸占位。
        try:
            hwnd, source = desktop.target_window()
        except Exception:
            facts["targetWindowResolved"] = False
        else:
            facts["targetWindowResolved"] = True
            facts["targetWindowSource"] = source
            facts["targetWindow"] = hwnd
        try:
            facts["ownedWindowCount"] = len(desktop.owned_windows())
        except Exception:
            facts["ownedWindowCount"] = None
        try:
            facts["uniqueOwnedWindow"] = len(desktop.main_windows()) == 1
        except Exception:
            facts["uniqueOwnedWindow"] = False
        return facts

    def evaluate(self, capability, facts):
        """按声明判定可用性：planned 一律 unavailable；事实为 False 也 unavailable。"""
        reasons = []
        if capability["status"] == "planned":
            reasons.append("尚未实现")
        for fact in capability.get("requires", []):
            if facts.get(fact) is False:
                reasons.append("前置不满足：%s" % fact)
            elif facts.get(fact) is None:
                reasons.append("等待检查：%s" % fact)
        if capability["status"] != "verified":
            availability = "unavailable"
        elif any(facts.get(f) is False for f in capability.get("requires", [])):
            availability = "unavailable"
        elif any(facts.get(f) is None for f in capability.get("requires", [])):
            availability = "pending"
        else:
            availability = "ready"
        return {"id": capability["id"], "availability": availability, "reasons": reasons}

    # -- 分发 -------------------------------------------------------------- #
    def invoke(self, capability_id, arguments):
        capability = CAPABILITY_INDEX.get(capability_id)
        if capability is None:
            raise CapabilityError("unsupported-capability", capability_id)
        if capability["status"] == "planned":
            raise CapabilityError("not-implemented", capability_id)
        if capability["layer"] == "execute" and self.actions >= self.max_actions:
            raise CapabilityError("budget-exhausted")
        started = self.clock()
        try:
            handler = getattr(self, "_do_" + capability_id.replace(".", "_"))
        except AttributeError:
            raise CapabilityError("not-implemented", capability_id)
        try:
            result = handler(arguments or {})
        except CapabilityError:
            raise
        except Exception as error:
            # 内部异常一律翻译成声明里的稳定错误码：调用方只依赖 code。
            raise _as_code(error) from error
        elapsed = int((self.clock() - started) * 1000)
        if capability["layer"] == "execute":
            self.actions += 1
        return {"result": result, "elapsedMs": elapsed,
                "budget": {"timeoutMs": capability["budget"]["timeoutMs"],
                           "actionsUsed": self.actions, "actionsMax": self.max_actions}}

    # -- 辅助 -------------------------------------------------------------- #
    def _require_open(self):
        desktop = self.desktop
        if desktop is None or not desktop.context:
            raise CapabilityError("hidden-desktop-not-open")
        if desktop.blocked:
            raise CapabilityError("cleanup-unconfirmed")
        return desktop

    def _target_window(self):
        desktop = self._require_open()
        try:
            hwnd, _source = desktop.target_window()
        except Blocked as error:
            if str(error) == "target_not_unique":
                raise CapabilityError("requires-unique-window",
                                      "自有顶层窗口数 %d，无法自动唯一，请先用 locate.window 选定"
                                      % len(desktop.owned_windows()))
            raise
        return desktop, hwnd

    def _tree(self, desktop, hwnd=None):
        return UiaTree(desktop, hwnd)

    def _locate(self, tree, spec):
        """严格定位：唯一 + enabled + 非 offscreen，否则拒绝。

        两条纪律：
          * 匹配数不为 1 一律拒绝，绝不"取第一个"；
          * 若枚举被预算截断（真实 CEF 应用可能几百上千个元素），
            **没找到≠不存在**，此时必须报 `enumeration-truncated` 而不是 `target-not-unique`。
        """
        kind = spec.get("kind") or "autoId"
        value = spec.get("value") or ""
        role_name = (spec.get("role") or "").strip()
        if kind == "role":
            if not role_name:
                raise CapabilityError("unsupported-locator", "role 方式需要 role 参数")
            wanted = {k for k, v in ROLE_NAMES.items() if v.lower() == role_name.lower()}
            if not wanted:
                raise CapabilityError("unsupported-locator", "未知 role: " + role_name)
            # 原生查询仍扫描全部后代；批量缓存 ControlType 后在本地筛选，
            # 仅对匹配项读取 live 详细属性。这里不承诺缩小 provider 的搜索范围。
            rows = tree.enumerate(roles=wanted)
            found = [r for r in rows if not value or r["name"] == value]
        else:
            rows = tree.enumerate()
            if kind == "autoId":
                found = [r for r in rows if r["autoId"] == value]
            elif kind == "label":
                found = [r for r in rows if r["name"] == value]
            elif kind == "text":
                found = [r for r in rows if value and value in r["name"]]
            elif kind == "className":
                found = [r for r in rows if r["className"] == value]
            else:
                raise CapabilityError("unsupported-locator", kind)
        if tree.truncated:
            raise CapabilityError("enumeration-truncated",
                                  "查询范围共 %d 个元素，本次只枚举了前 %d 个，不能据此判定不存在或唯一"
                                  % (tree.available, len(rows)))
        if len(found) != 1:
            raise CapabilityError("target-not-unique", "匹配 %d 个" % len(found))
        row = found[0]
        if not row["enabled"] or row["offscreen"]:
            raise CapabilityError("target-not-usable",
                                  "enabled=%s offscreen=%s" % (row["enabled"], row["offscreen"]))
        proof = tree.prove_target(row)
        expected = spec.get('expectedIdentity')
        if expected is not None and not same_identity(expected, proof):
            raise CapabilityError('target-identity-changed', '新观察的目标与上一定位身份不一致；请重新发现')
        row['identity'] = {**proof, 'localUnique': True, 'globalUnique': True,
                           'queryScope': 'all-descendants'}
        return row

    # -- 实现 -------------------------------------------------------------- #
    def _do_env_hidden_open(self, _arguments):
        desktop = self._fresh()
        if desktop.context:
            raise CapabilityError("desktop-already-exists", "已打开，先清理")
        context = desktop.open()
        self.log_line("打开隐藏桌面 " + context["desktop"])
        return context

    def _do_env_app_launch(self, arguments):
        desktop = self._require_open()
        if desktop.process:
            raise CapabilityError("already-started")
        app = arguments.get("app") or "builtin"
        if app == "builtin":
            executable, args = sys.executable, [TARGET_APP]
        else:
            executable = os.path.abspath((arguments.get("path") or "").strip())
            if not executable.lower().endswith(".exe") or not os.path.isfile(executable):
                raise CapabilityError("invalid-executable", executable)
            args = [part for part in str(arguments.get("args") or "").split() if part]
            # 单实例应用的前置：已有同名进程在跑时，新进程会把请求转交过去并立即退出，
            # 于是自有隐藏桌面上不会有自有窗口。这里必须先拒绝，而不是启动一个马上消失的进程。
            existing = desktop.api.running_image_pids(executable)
            if existing:
                raise CapabilityError("existing-instance",
                                      "%s 已有 %d 个实例在运行（pid %s）"
                                      % (os.path.basename(executable), len(existing),
                                         ", ".join(str(p) for p in existing[:5])))
        pid = desktop.start(executable, args)
        self.log_line("启动 %s%s -> pid %d"
                      % (os.path.basename(executable), (" " + " ".join(args)) if args else "", pid))
        return {"pid": pid, "executable": executable, "args": args, "desktop": desktop.name}

    def _do_env_app_close(self, arguments):
        desktop = self.desktop
        if desktop is None or not desktop.context:
            return {"cleaned": True, "note": "无会话可清理"}
        result = desktop.close()
        self.log_line("清理完成，桌面已确认消失")
        return result

    def _do_env_identity_probe(self, _arguments):
        desktop = self.desktop or HiddenDesktop(clock=self.clock, lifetime=self.lease)
        api = desktop.api
        probe = {"session": api.session(os.getpid()),
                 "integrity": api.token_facts(os.getpid())[2],
                 "inputDesktop": api.input_desktop(),
                 "station": api.station_name()}
        try:
            api.assert_default()
            probe["sessionActiveAndDefault"] = True
        except Exception as error:
            probe["sessionActiveAndDefault"] = False
            probe["sessionReason"] = str(error)
        probe["hiddenDesktopOpen"] = bool(desktop.context)
        probe["desktopName"] = desktop.context["desktop"] if desktop.context else None
        probe["remainingSeconds"] = desktop.remaining()
        probe["blocked"] = bool(desktop.blocked)
        return probe

    def _do_observe_window_enumerate(self, _arguments):
        desktop = self._require_open()
        items = []
        owned = set(desktop.owned_windows())
        for hwnd in desktop.windows():
            items.append({"hwnd": hwnd, "pid": desktop.api.window_pid(hwnd),
                          "className": desktop.api.window_class(hwnd),
                          "title": desktop.api.window_title(hwnd),
                          "visible": desktop.api.is_window_visible(hwnd),
                          "root": desktop.api.is_root_window(hwnd),
                          "owned": hwnd in owned,
                          "rect": desktop.api.window_rect(hwnd)})
        try:
            hwnd, source = desktop.target_window()
            target = {"hwnd": hwnd, "source": source}
        except Exception as error:
            target = {"hwnd": None, "source": None, "reason": str(error)}
        return {"count": len(items), "items": items,
                "ownedWindows": sorted(owned), "ownedCount": len(owned),
                "target": target, "mainWindows": desktop.main_windows()}

    def _do_locate_window(self, arguments):
        desktop = self._require_open()
        outcome = desktop.select_target({"kind": arguments.get("kind") or "largest",
                                         "value": arguments.get("value") or ""})
        self.log_line("选定目标窗口 %s (%s)，候选 %d 个"
                      % (outcome["window"]["className"], outcome["target"], outcome["considered"]))
        try:
            desktop.api.capture_dpi()
        except Exception:
            pass
        return outcome

    def _do_act_window_fit(self, arguments):
        desktop = self._require_open()
        hwnd, _source = desktop.target_window()
        width = int(arguments.get("width") or 1600)
        height = int(arguments.get("height") or 1000)
        outcome = desktop.present_window(hwnd, width, height)
        self.log_line("目标窗口显示并定尺为 %dx%d" % (width, height))
        return outcome

    def _do_observe_uia_tree(self, arguments):
        desktop, hwnd = self._target_window()
        role = str(arguments.get("role") or "").strip()
        roles = {int(role)} if role else None
        with self._tree(desktop, hwnd) as tree:
            rows = tree.enumerate(roles)
            available, truncated = tree.available, tree.truncated
        return {"count": len(rows), "items": rows, "availableElements": available,
                "enumerationComplete": not truncated, "budget": MAX_ELEMENTS,
                "queryScope": {"kind": "all-descendants",
                               "roles": sorted(roles) if roles is not None else [],
                               "roleRead": "batch-cache" if roles is not None else "current",
                               "stageTimingsMs": dict(getattr(tree, "timings", {}))}}

    def _do_observe_capture(self, arguments):
        desktop, _hwnd = self._target_window()
        info = desktop.capture(allow_unrendered=bool(arguments.get("allowUnrendered", True)))
        return info

    def _do_observe_state_read(self, arguments):
        desktop, hwnd = self._target_window()
        field = arguments.get("field") or "name"
        with self._tree(desktop, hwnd) as tree:
            row = self._locate(tree, arguments.get("target") or {})
            if field == "value":
                try:
                    value = tree.value(row["index"])
                except UiaError as error:
                    raise CapabilityError("value-pattern-unavailable", str(error)) from error
                return {"field": field, "value": value, "target": row["autoId"], 'identity': row['identity']}
            if field not in row:
                raise CapabilityError("unsupported-locator", field)
            return {"field": field, "value": row[field], "target": row["autoId"], 'identity': row['identity']}

    def _do_locate_structured(self, arguments):
        desktop, hwnd = self._target_window()
        with self._tree(desktop, hwnd) as tree:
            row = self._locate(tree, arguments)
        return row

    def _do_act_click(self, arguments):
        desktop, hwnd = self._target_window()
        with self._tree(desktop, hwnd) as tree:
            row = self._locate(tree, arguments.get("target") or {})
        handle = row["native"] or hwnd
        # 点击点必须由**目标控件自己的矩形**换算，不能取窗口中心：
        # CEF 类元素没有自己的 HWND，退化到"窗口中心"会点到完全无关的地方。
        left, top, right, bottom = row["rect"]
        offset_x, offset_y = arguments.get("offsetX"), arguments.get("offsetY")
        screen_x = left + (int(offset_x) if offset_x is not None else (right - left) // 2)
        screen_y = top + (int(offset_y) if offset_y is not None else (bottom - top) // 2)
        x, y = desktop.api.screen_to_client(handle, screen_x, screen_y)
        client_left, client_top, client_right, client_bottom = desktop.api.client_rect(handle)
        width, height = client_right - client_left, client_bottom - client_top
        if not (0 <= x < width and 0 <= y < height):
            raise CapabilityError("click-outside-target",
                                  "换算后 (%d,%d) 落在客户区 %dx%d 之外" % (x, y, width, height))
        info = desktop.click(handle, x, y, double=bool(arguments.get("double")))
        self.log_line("点击 %s(hwnd=%d) @(%d,%d)" % (row["autoId"] or row["roleName"], handle, x, y))
        return {**info, "target": row["autoId"] or row["roleName"],
                'identity': row['identity'],
                "clickPoint": [x, y], "targetRect": row["rect"], "clientSize": [width, height]}

    def _do_act_type(self, arguments):
        desktop, hwnd = self._target_window()
        text = arguments.get("text") or ""
        if len(text) > 512:
            raise CapabilityError("text-limit-reached", len(text))
        with self._tree(desktop, hwnd) as tree:
            row = self._locate(tree, arguments.get("target") or {})
        handle = row["native"] or hwnd
        # 有控件矩形时先按该点下钻到真正的输入接收窗口：CEF 类应用把 WM_CHAR 发到外层
        # 窗口是"消息成功、界面无变化"——比报错更糟。没有矩形（经典控件带自己的 HWND）时
        # 直接发给控件本身。
        point = None
        if not row["native"] and row["rect"]:
            left, top, right, bottom = row["rect"]
            point = desktop.api.screen_to_client(hwnd, (left + right) // 2, (top + bottom) // 2)
        info = desktop.type_text(handle, text, point=point)
        self.log_line("WM_CHAR 输入 %d 字符 -> %s" % (len(text), row["autoId"] or row["roleName"]))
        return {**info, "target": row["autoId"] or row["roleName"],
                'identity': row['identity'],
                "routedToRenderer": bool(point)}

    def _do_act_set_value(self, arguments):
        desktop, hwnd = self._target_window()
        text = arguments.get("text") or ""
        with self._tree(desktop, hwnd) as tree:
            row = self._locate(tree, arguments.get("target") or {})
            try:
                tree.set_value(row["index"], text)
            except UiaError as error:
                code = ("value-pattern-unavailable" if "hresult-80040204" in str(error)
                        or "hresult-80004002" in str(error) else "value-effect-mismatch")
                raise CapabilityError(code, str(error)) from error
        self.log_line("ValuePattern 赋值 -> %s" % (row["autoId"] or row["roleName"],))
        return {"dispatched": True, "value": text, "target": row["autoId"] or row["roleName"], 'identity': row['identity']}

    def _do_act_invoke(self, arguments):
        desktop, hwnd = self._target_window()
        with self._tree(desktop, hwnd) as tree:
            row = self._locate(tree, arguments.get("target") or {})
            try:
                tree.invoke(row["index"])
            except UiaError as error:
                raise CapabilityError("invoke-pattern-unavailable", str(error)) from error
        self.log_line("InvokePattern -> %s" % (row["autoId"] or row["roleName"],))
        return {"dispatched": True, "target": row["autoId"] or row["roleName"], 'identity': row['identity']}

    def _do_act_cancel(self, _arguments):
        desktop = self._require_open()
        try:
            hwnd = desktop.target_window()[0]
        except Blocked:
            hwnd = None
        return desktop.cancel_owned_input(hwnd)

    def _do_verify_target_identity(self, _arguments):
        desktop, hwnd = self._target_window()
        facts = desktop.identity(hwnd)
        ok = bool(facts["inJob"] and facts["sameUser"] and facts["sameSession"]
                  and facts["session"] == desktop.context["session"])
        if not facts["inJob"]:
            raise CapabilityError("target-outside-owned-job", facts)
        return {"ok": ok, **facts, "desktopName": desktop.context["desktop"],
                "instanceId": desktop.context['instanceId'],
                "desktopOwner": desktop.name, "jobActive": desktop.api.job_active(desktop.job)}

    def _do_verify_capture_rendered(self, _arguments):
        desktop, _hwnd = self._target_window()
        info = desktop.capture(allow_unrendered=True)
        return {"rendered": not info["unrendered"], **info}

    def _do_verify_structured_equals(self, arguments):
        desktop, hwnd = self._target_window()
        field = arguments.get("field") or "value"
        expected = arguments.get("expected") or ""
        with self._tree(desktop, hwnd) as tree:
            row = self._locate(tree, arguments.get("target") or {})
            actual = tree.value(row["index"]) if field == "value" else row[field]
        if isinstance(actual, bool):
            matched = str(actual).lower() == str(expected).lower()
        else:
            matched = str(actual) == str(expected)
        if not matched:
            raise CapabilityError("assertion-failed", {"field": field, "expected": expected,
                                                       "actual": actual})
        return {"ok": True, "field": field, "expected": expected, "actual": actual,
                "target": row["autoId"], 'identity': row['identity']}

    def _do_control_lease_renew(self, arguments):
        desktop = self._require_open()
        seconds = arguments.get("seconds")
        result = desktop.renew(int(seconds) if seconds else None)
        self.log_line("续租 %d 秒，剩余 %d 秒" % (result["leaseSeconds"], round(result["remaining"])))
        return result

    def _do_control_budget_consume(self, _arguments):
        return {"actionsUsed": self.actions, "actionsMax": self.max_actions,
                "remaining": self.max_actions - self.actions, "readOnly": True}


CAPABILITY_RUNTIME_LEASE_DEFAULT = 300
MAX_LEASE = MAX_LIFETIME_SECONDS
