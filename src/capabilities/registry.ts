/** M6 第一版能力目录：记录可调用条件，不把应用名当成工具。 */
export type CapabilityLayer = "environment" | "observe" | "ground" | "execute" | "decide" | "verify_control";
export type CapabilityOperation = "attach" | "observe" | "locate" | "act" | "choose" | "verify";
export type CapabilityEnvironment = "browser" | "windows";
export type CapabilityStatus = "verified" | "partial" | "planned";
export type CapabilityFact =
  | "browserAttached" | "browserInstalled" | "windowDiscovered" | "windowAttached"
  | "uiaControls" | "screenshotAvailable" | "templateAvailable" | "windowForeground"
  | "permissionsCompatible" | "unrealWindow" | "deterministicIntent"
  | "unityWindow" | "clickAction" | "escapeAction"
  | "boundedCandidates" | "modelAvailable" | "completionCriteria"
  | "mediaObservable" | "appRegistered" | "clipboardPlainText" | "allowedFileRoot" | "structuredDrag";
export type CapabilityFacts = Partial<Record<CapabilityFact, boolean>>;

export interface CapabilityDescriptor {
  id: string;
  layer: CapabilityLayer;
  operation: CapabilityOperation;
  environment: CapabilityEnvironment;
  provider: string;
  status: CapabilityStatus;
  requires: readonly CapabilityFact[];
  rank: number;
  risk: "read" | "write" | "high_impact";
  evidence: string;
  limitation?: string;
}

export interface CandidateEvaluation {
  id: string;
  provider: string;
  status: CapabilityStatus;
  availability: "ready" | "pending" | "unavailable";
  reasons: string[];
}

export interface CapabilityResolution {
  layer: CapabilityLayer;
  operation: CapabilityOperation;
  environment: CapabilityEnvironment;
  selected?: string;
  candidates: CandidateEvaluation[];
}

const catalog: readonly CapabilityDescriptor[] = [
  { id: "browser.managed.attach", layer: "environment", operation: "attach", environment: "browser",
    provider: "PlaywrightRuntime", status: "verified", requires: ["browserInstalled"], rank: 10,
    risk: "read", evidence: "浏览器自动测试、Task A 真实任务" },
  { id: "windows.window.attach", layer: "environment", operation: "attach", environment: "windows",
    provider: "DesktopRuntime", status: "verified", requires: ["windowDiscovered"], rank: 10,
    risk: "read", evidence: "WinForms、桌面真实任务" },
  { id: "windows.app.ensure", layer: "environment", operation: "attach", environment: "windows",
    provider: "WindowManager", status: "verified", requires: ["appRegistered"], rank: 20,
    risk: "write", evidence: "已登记临时 WinForms 应用从 Web 规划到启动及完成验证通过" },
  { id: "browser.dom.observe", layer: "observe", operation: "observe", environment: "browser",
    provider: "PlaywrightRuntime", status: "verified", requires: ["browserAttached"], rank: 10,
    risk: "read", evidence: "浏览器自动测试、Task A 真实任务" },
  { id: "browser.dom.extract", layer: "observe", operation: "observe", environment: "browser",
    provider: "PlaywrightRuntime.extractDom", status: "partial", requires: ["browserAttached"], rank: 20,
    risk: "read", evidence: "受控网页摘录测试通过；尚未接入模型动作" },
  { id: "windows.system.inspect", layer: "observe", operation: "observe", environment: "windows",
    provider: "SystemInspector", status: "partial", requires: [], rank: 40,
    risk: "read", evidence: "本机进程与 TCP 端口测试通过；尚未接入模型动作" },
  { id: "windows.uia.observe", layer: "observe", operation: "observe", environment: "windows",
    provider: "DesktopRuntime/UIA", status: "verified", requires: ["windowAttached", "uiaControls"], rank: 10,
    risk: "read", evidence: "WinForms 真实任务", limitation: "自绘界面可能无内部控件" },
  { id: "windows.window.observe", layer: "observe", operation: "observe", environment: "windows",
    provider: "DesktopRuntime/截图", status: "verified", requires: ["windowAttached", "screenshotAvailable"], rank: 20,
    risk: "read", evidence: "WinForms、UnrealWindow 真实任务" },
  { id: "browser.dom.locate", layer: "ground", operation: "locate", environment: "browser",
    provider: "DOM Grounder", status: "verified", requires: ["browserAttached"], rank: 10,
    risk: "read", evidence: "浏览器自动测试、Task A 真实任务" },
  { id: "browser.vision.locate", layer: "ground", operation: "locate", environment: "browser",
    provider: "视觉定位", status: "planned", requires: ["browserAttached", "screenshotAvailable"], rank: 40,
    risk: "read", evidence: "尚未实现" },
  { id: "windows.uia.locate", layer: "ground", operation: "locate", environment: "windows",
    provider: "DesktopRuntime/UIA", status: "verified", requires: ["windowAttached", "uiaControls"], rank: 10,
    risk: "read", evidence: "WinForms 真实任务" },
  { id: "windows.template.locate", layer: "ground", operation: "locate", environment: "windows",
    provider: "OpenCV 模板", status: "verified", requires: ["windowAttached", "screenshotAvailable", "templateAvailable"], rank: 20,
    risk: "read", evidence: "WinForms、UnrealWindow 真实任务", limitation: "只识别已有且唯一的模板" },
  { id: "windows.ocr.locate", layer: "ground", operation: "locate", environment: "windows",
    provider: "OCR", status: "planned", requires: ["screenshotAvailable"], rank: 30,
    risk: "read", evidence: "尚未实现" },
  { id: "windows.vision.locate", layer: "ground", operation: "locate", environment: "windows",
    provider: "截图视觉定位", status: "verified", requires: ["windowAttached", "screenshotAvailable", "modelAvailable"], rank: 40,
    risk: "read", evidence: "deepseek-flash 图片定位与截图边界框校验", limitation: "目标需唯一且置信度至少 0.75" },
  { id: "browser.playwright.act", layer: "execute", operation: "act", environment: "browser",
    provider: "PlaywrightRuntime", status: "verified", requires: ["browserAttached"], rank: 10,
    risk: "write", evidence: "浏览器自动测试、Task A 真实任务" },
  { id: "windows.uia.act", layer: "execute", operation: "act", environment: "windows",
    provider: "DesktopRuntime/UIA", status: "verified", requires: ["windowAttached", "uiaControls"], rank: 10,
    risk: "write", evidence: "WinForms 真实任务" },
  { id: "windows.win32.act", layer: "execute", operation: "act", environment: "windows",
    provider: "Win32 SendInput", status: "verified",
    requires: ["windowAttached", "unrealWindow", "windowForeground", "permissionsCompatible"], rank: 20,
    risk: "write", evidence: "UnrealWindow Web 任务", limitation: "当前仅验证 UnrealWindow 的 Esc 与点击" },
  { id: "windows.win32.unity.click", layer: "execute", operation: "act", environment: "windows",
    provider: "Win32 SendInput", status: "verified",
    requires: ["windowAttached", "unityWindow", "clickAction", "windowForeground", "permissionsCompatible"], rank: 21,
    risk: "write", evidence: "UnityWndClass 设置页现场测试", limitation: "当前仅验证 UnityWndClass 的鼠标点击" },
  { id: "windows.pyautogui.unity.escape", layer: "execute", operation: "act", environment: "windows",
    provider: "PyAutoGUI", status: "verified",
    requires: ["windowAttached", "unityWindow", "escapeAction", "windowForeground", "permissionsCompatible"], rank: 22,
    risk: "write", evidence: "UnityWndClass 设置页现场测试", limitation: "当前仅验证 UnityWndClass 的 Esc" },
  { id: "windows.pyautogui.act", layer: "execute", operation: "act", environment: "windows",
    provider: "PyAutoGUI", status: "partial", requires: ["windowAttached", "windowForeground", "permissionsCompatible"], rank: 30,
    risk: "write", evidence: "代码接入，通用兜底尚未独立验收" },
  { id: "windows.pywinauto_mouse.act", layer: "execute", operation: "act", environment: "windows",
    provider: "pywinauto mouse", status: "partial", requires: ["windowAttached", "windowForeground", "permissionsCompatible"], rank: 31,
    risk: "write", evidence: "窗口内坐标分支已记录实际执行者，通用路径待验收" },
  { id: "windows.clipboard.paste_text", layer: "execute", operation: "act", environment: "windows",
    provider: "文本剪贴板", status: "partial", requires: ["windowAttached", "windowForeground", "clipboardPlainText"], rank: 32,
    risk: "write", evidence: "富格式剪贴板保护分支通过；实际中文粘贴尚待纯文本剪贴板现场验收" },
  { id: "windows.pyautogui.drag", layer: "execute", operation: "act", environment: "windows",
    provider: "PyAutoGUI", status: "partial", requires: ["windowAttached", "windowForeground", "structuredDrag"], rank: 33,
    risk: "write", evidence: "仅接入 UIA 双目标边界检查；真实拖拽待测试" },
  { id: "windows.file.act", layer: "execute", operation: "act", environment: "windows",
    provider: "FileTool", status: "partial", requires: ["allowedFileRoot"], rank: 34,
    risk: "write", evidence: "限定目录文件操作测试通过；尚未接入模型动作" },
  { id: "browser.rule.choose", layer: "decide", operation: "choose", environment: "browser",
    provider: "固定规则", status: "verified", requires: ["deterministicIntent"], rank: 10,
    risk: "read", evidence: "脚本化 Task A 任务" },
  { id: "windows.rule.choose", layer: "decide", operation: "choose", environment: "windows",
    provider: "固定规则", status: "verified", requires: ["deterministicIntent"], rank: 10,
    risk: "read", evidence: "WinForms、UnrealWindow 真实任务" },
  { id: "windows.jev.choose", layer: "decide", operation: "choose", environment: "windows",
    provider: "Jev", status: "partial", requires: ["boundedCandidates", "modelAvailable"], rank: 20,
    risk: "read", evidence: "真实服务候选选择通过，未接入正式路由" },
  { id: "windows.deepseek.choose", layer: "decide", operation: "choose", environment: "windows",
    provider: "deepseek-flash", status: "verified", requires: ["modelAvailable"], rank: 30,
    risk: "read", evidence: "受控桌面真实任务" },
  { id: "browser.deepseek.choose", layer: "decide", operation: "choose", environment: "browser",
    provider: "deepseek-flash", status: "verified", requires: ["modelAvailable"], rank: 30,
    risk: "read", evidence: "Task A 真实任务" },
  { id: "browser.criteria.verify", layer: "verify_control", operation: "verify", environment: "browser",
    provider: "Verifier", status: "verified", requires: ["completionCriteria"], rank: 10,
    risk: "read", evidence: "浏览器自动测试、Task A 真实任务" },
  { id: "windows.media.verify", layer: "verify_control", operation: "verify", environment: "windows",
    provider: "UIA 媒体状态", status: "verified", requires: ["mediaObservable"], rank: 10,
    risk: "read", evidence: "浏览器真实任务" },
  { id: "windows.template.verify", layer: "verify_control", operation: "verify", environment: "windows",
    provider: "OpenCV 模板", status: "verified", requires: ["screenshotAvailable", "templateAvailable"], rank: 20,
    risk: "read", evidence: "UnrealWindow 浏览器真实任务" },
  { id: "windows.text.verify", layer: "verify_control", operation: "verify", environment: "windows",
    provider: "UIA/OCR 文本条件", status: "verified", requires: ["windowAttached", "completionCriteria"], rank: 30,
    risk: "read", evidence: "WinForms 文本独立条件；截图文字识别须额外核验" },
];

export function listCapabilities(): readonly CapabilityDescriptor[] { return catalog; }

export function resolveCapability(operation: CapabilityOperation, environment: CapabilityEnvironment,
  facts: CapabilityFacts, entries: readonly CapabilityDescriptor[] = catalog): CapabilityResolution {
  const matches = entries.filter((entry) => entry.operation === operation && entry.environment === environment)
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const candidates = matches.map((entry): CandidateEvaluation => {
    const reasons: string[] = [];
    if (entry.status === "planned") reasons.push("尚未实现");
    if (entry.status === "partial") reasons.push("尚未完成独立验收");
    for (const fact of entry.requires) {
      if (facts[fact] === false) reasons.push(`前置条件不满足：${fact}`);
      else if (facts[fact] === undefined) reasons.push(`等待检查：${fact}`);
    }
    const availability = entry.status !== "verified" || entry.requires.some((fact) => facts[fact] === false)
      ? "unavailable" : entry.requires.some((fact) => facts[fact] === undefined) ? "pending" : "ready";
    return { id: entry.id, provider: entry.provider, status: entry.status, availability, reasons };
  });
  const selected = candidates.find((candidate) => candidate.availability === "ready")?.id;
  return { layer: matches[0]?.layer ?? "environment", operation, environment, selected, candidates };
}

export function requireCapability(resolution: CapabilityResolution): string {
  if (resolution.selected) return resolution.selected;
  const reasons = resolution.candidates.map((candidate) => `${candidate.id}: ${candidate.reasons.join("、")}`).join("；");
  throw new Error(`没有可用的 ${resolution.environment}/${resolution.operation} 能力${reasons ? `：${reasons}` : ""}`);
}
