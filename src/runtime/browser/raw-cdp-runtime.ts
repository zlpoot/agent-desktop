/**
 * RawCdpRuntime｜通用 CDP page-level RuntimeAdapter（Electron/第三方桌面应用 WebView）。
 *
 * 背景（P9-A2-0 Gate）：淘宝桌面版 3.0.0 的 CDP 只响应 page-level 会话，
 * browser 级握手（connectOverCDP）超时。本 runtime 用 page-level WebSocket +
 * Runtime.evaluate 完成观察/定位/执行，Observation 结构与 PlaywrightRuntime 对齐
 * （url/pageText/dom/accessibility/structured/capture），不含任何应用业务特判。
 *
 * 用法：const rt = await RawCdpRuntime.connect({ cdpEndpoint: "http://127.0.0.1:9222",
 *   urlFilter: "pages-fast.m.taobao.com" });
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DOM_COLLECTOR } from "./dom-collector.js";
import type { ActionResult, ComputerAction, GroundingResult, Observation, TargetSpec } from "../../actions/schema.js";
import type { RuntimeAdapter } from "../runtime-adapter.js";

export interface RawCdpRuntimeOptions {
  cdpEndpoint?: string;
  artifactDir?: string;
  /** 内容页 URL 过滤；缺省时自动选第一个可读内容页（textLen>50 且有可见 input）。 */
  urlFilter?: string;
  commandTimeoutMs?: number;
  navigationTimeoutMs?: number;
}

interface PageTarget { id: string; url: string; title: string; ws: string }

const DEFAULT_CDP = "http://127.0.0.1:9222";

/** 单次 CDP 调用（每次新建 page-level WebSocket，简单可靠；Electron 兼容）。 */
function cdpCall<T>(wsUrl: string, method: string, params: object, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let ws: WebSocket | undefined;
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => {
      try { ws?.close(); } catch { /* 忽略 */ }
      reject(new Error(`cdp timeout: ${method}`));
    }, timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      clearTimeout(timer);
      reject(new Error(`ws open failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    ws.on("open", () => ws?.send(JSON.stringify({ id, method, params })));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { id: number; error?: { message?: string }; result?: unknown };
      if (msg.id !== id) return;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* 忽略 */ }
      if (msg.error) reject(new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error).slice(0, 300)}`));
      else resolvePromise(msg.result as T);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}

/** 浏览器内定位：按 Target 语义找元素，返回稳定 CSS 路径（identity 同款）。
 *  用法：`(() => { const target = <json>; ${LOCATE_BODY} })()` */
const LOCATE_BODY = `const generation = String(performance.timeOrigin);
  const pathOf = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const parent = node.parentElement;
      let index = 1;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
        index = siblings.indexOf(node) + 1;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + index + ']');
      node = parent;
    }
    parts.unshift('html');
    return parts.join('>');
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'SELECT') return 'combobox';
    if (el.tagName === 'INPUT') return el.type === 'checkbox' ? 'checkbox' : 'textbox';
    if (el.tagName === 'TEXTAREA') return 'textbox';
    if (el.tagName === 'BUTTON') return 'button';
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'LI') return 'listitem';
    return el.tagName.toLowerCase();
  };
  const all = Array.from(document.querySelectorAll(
    'li,[role="row"],input,textarea,select,button,a[href],[role="checkbox"],[role="combobox"],' +
    '[role="textbox"],[role="button"],[role="link"]'));
  const nameOf = (el) => el.getAttribute('aria-label') || el.getAttribute('name') ||
    (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const candidates = [];
  for (const el of all) {
    if (target.kind === 'selector' && el.matches(target.selector)) { candidates.push(el); break; }
    if (target.kind === 'role') {
      const role = roleOf(el);
      const inputLike = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
      // 输入框语义互认：combobox 与 textbox 在 input 上等价（ARIA combobox 常无显式 role）
      const roleMatches = role === target.role ||
        (inputLike && ((role === 'combobox' && target.role === 'textbox') ||
          (role === 'textbox' && target.role === 'combobox')));
      if (!roleMatches) continue;
      if (target.name) {
        const aria = el.getAttribute('aria-label');
        const attrName = el.getAttribute('name');
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if ((aria && aria.includes(target.name)) || (attrName && attrName.includes(target.name)) ||
            text.includes(target.name)) candidates.push(el);
      } else { candidates.push(el); }
    } else if (target.kind === 'label' || target.kind === 'text') {
      const want = target.kind === 'label' ? target.label : target.text;
      if (nameOf(el).includes(want)) candidates.push(el);
    }
  }
  const visible = candidates.filter((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const pick = visible[0] || candidates[0];
  if (!pick) return { matched: false, detail: 'no element' };
  return { matched: true, identity: generation + ':' + pathOf(pick), detail: 'role/name located' };`;

/** DOM collector（与 PlaywrightRuntime 同源脚本，见 ./dom-collector.ts；经 CDP evaluate 执行）。 */

export class RawCdpRuntime implements RuntimeAdapter {
  readonly name = "RawCdp";
  private readonly cdpEndpoint: string;
  private readonly artifactDir: string;
  private readonly urlFilter?: string;
  private readonly commandTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private pageWs = "";
  private pageUrl = "about:blank";
  private readonly captureEpoch = randomUUID();
  private observationCount = 0;
  /** 运行开始（connect）时已存在的 page target；target 切换只允许绑定此后新出现的页，防遗留页污染统计。 */
  private readonly knownTargets = new Set<string>();

  private constructor(options: RawCdpRuntimeOptions) {
    this.cdpEndpoint = options.cdpEndpoint ?? DEFAULT_CDP;
    this.artifactDir = resolve(options.artifactDir ?? ".artifacts");
    this.urlFilter = options.urlFilter;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15000;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30000;
  }

  /** 连接已有 CDP：枚举 page targets，选择内容页（urlFilter 或可读冒烟），绑定其 page WS。 */
  static async connect(options: RawCdpRuntimeOptions = {}): Promise<RawCdpRuntime> {
    const runtime = new RawCdpRuntime(options);
    await runtime.bindContentPage();
    return runtime;
  }

  private async listPageTargets(): Promise<PageTarget[]> {
    const response = await fetch(`${this.cdpEndpoint}/json`);
    const targets = (await response.json()) as Array<{
      id?: string; type?: string; url?: string; title?: string; webSocketDebuggerUrl?: string;
    }>;
    return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl)
      .map((target) => ({ id: target.id ?? "", url: target.url ?? "", title: target.title ?? "",
        ws: target.webSocketDebuggerUrl! }));
  }

  /** 绑定内容页：优先 urlFilter 命中；否则依次冒烟选第一个可读内容页（textLen>50 且有可见 input）。 */
  private async bindContentPage(): Promise<void> {
    const targets = await this.listPageTargets();
    // 记录运行基线：这些 target 视为已存在，后续 target 切换不得绑定它们
    for (const target of targets) this.knownTargets.add(target.ws);
    const filter = this.urlFilter;
    const filtered = filter
      ? targets.filter((target) => filter.split("|").some((part) => target.url.includes(part)))
      : targets;
    for (const target of filtered.length ? filtered : targets) {
      if (await this.tryBind(target)) return;
    }
    throw new Error("raw-cdp: 未找到可读内容页（URL 过滤或可读冒烟均无命中）");
  }

  /** 尝试绑定单个 target：冒烟（textLen>50 且有可见 input）通过则设为当前页。 */
  private async tryBind(target: PageTarget): Promise<boolean> {
    if (!target.url || target.url === "about:blank" || target.url.startsWith("file:")) return false;
    try {
      const probe = await this.evaluate<string | undefined>(target.ws,
        `(() => { const b = document.body; const t = (b?.innerText ?? '').length;
          const hasVisibleInput = Array.from(document.querySelectorAll('input'))
            .some((i) => !!(i.offsetWidth || i.offsetHeight));
          return t > 50 && hasVisibleInput ? t + ':' + location.href : undefined; })()`);
      if (typeof probe === "string") {
        this.pageWs = target.ws;
        this.pageUrl = target.url;
        return true;
      }
    } catch { /* 该 target 不响应，继续下一个 */ }
    return false;
  }

  /** click 可能新开详情页 target（桌面 WebView 行为）：只绑定本次运行新出现的可读内容页。 */
  private async maybeSwitchPageTarget(): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
    const targets = await this.listPageTargets().catch(() => []);
    const candidates = targets.filter((t) => !this.knownTargets.has(t.ws) && t.ws !== this.pageWs);
    // 优先详情页特征（item.htm 等），其次任意新可读内容页
    const detail = candidates.find((t) => t.url.includes("item.htm"));
    const primary = detail ?? candidates[0];
    if (primary && (await this.tryBind(primary))) {
      this.knownTargets.add(primary.ws);
      return;
    }
    // 绑定失败的候选也计入已知，避免反复尝试
    for (const target of candidates) this.knownTargets.add(target.ws);
  }

  private async evaluate<T>(wsUrl: string, expression: string): Promise<T> {
    const result = await cdpCall<{ result?: { value?: T }; exceptionDetails?: unknown }>(
      wsUrl, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.commandTimeoutMs);
    if (result.exceptionDetails) {
      throw new Error(`eval exception: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    }
    return result.result?.value as T;
  }

  private async evaluateOnPage<T>(expression: string): Promise<T> {
    if (!this.pageWs) throw new Error("raw-cdp: 尚未绑定内容页");
    return this.evaluate<T>(this.pageWs, expression);
  }

  async observe(): Promise<Observation> {
    const startedAt = Date.now();
    await mkdir(this.artifactDir, { recursive: true });
    const url = await this.evaluateOnPage<string>("location.href");
    const pageText = (await this.evaluateOnPage<string>("document.body?.innerText ?? ''")).slice(0, 30000);
    const html = (await this.evaluateOnPage<string>("document.documentElement?.outerHTML ?? ''")).slice(0, 30000);
    const structured = await this.evaluateOnPage<Observation["structured"]>(DOM_COLLECTOR).catch(() => undefined);
    const accessibility = (structured?.items ?? []).map((item) =>
      [item.role, item.name, item.text, item.value].filter(Boolean).join(" ")).join("\n").slice(0, 30000);
    const screenshot = resolve(this.artifactDir, `observation-${++this.observationCount}.png`);
    try {
      const shot = await cdpCall<{ data?: string }>(this.pageWs, "Page.captureScreenshot",
        { format: "png" }, this.commandTimeoutMs);
      if (shot.data) await writeFile(screenshot, Buffer.from(shot.data, "base64"));
    } catch { /* 截图失败不阻断观察 */ }
    this.pageUrl = url;
    return {
      url,
      capture: { epoch: this.captureEpoch, sequence: this.observationCount,
        object: `page:${this.captureEpoch}`, startedAt, finishedAt: Date.now(),
        clock: "collector" as const, atomic: false,
        fields: { url: { complete: true, source: "api" as const },
          pageText: { complete: pageText.length < 30000, source: "dom" as const },
          dom: { complete: html.length < 30000, source: "dom" as const },
          accessibility: { complete: accessibility.length < 30000, source: "dom" as const },
          ...(structured ? { structured: { complete: structured.complete, source: "dom" as const } } : {}) } },
      screenshot,
      pageText,
      textEvidence: [{ source: "dom", text: pageText }],
      dom: html,
      accessibility,
      ...(structured ? { structured } : {}),
    };
  }

  async ground(action: ComputerAction): Promise<GroundingResult> {
    if (action.kind !== "click" && action.kind !== "double_click" && action.kind !== "type" &&
        action.kind !== "paste_text" && action.kind !== "set_checked" && action.kind !== "select_option") {
      return { attempts: [] };
    }
    if (action.target.kind === "candidates") return { attempts: [] };
    try {
      const located = await this.evaluateOnPage<{ matched: boolean; identity?: string; detail: string }>(
        `(() => { const target = ${JSON.stringify(action.target)}; ${LOCATE_BODY} })()`);
      if (!located.matched) {
        return { attempts: [{ strategy: action.target.kind, matched: false, selected: false,
          detail: located.detail }] };
      }
      // 返回原语义 target（role/label/text/selector）：execute 内经 LOCATE_BODY 重新定位，
      // 不引入跨导航失效的 identity 前缀选择器。
      return { target: action.target,
        attempts: [{ strategy: action.target.kind, matched: true, selected: true,
          detail: located.detail }] };
    } catch (error) {
      return { attempts: [{ strategy: action.target.kind, matched: false, selected: false,
        detail: error instanceof Error ? error.message : String(error) }] };
    }
  }

  async execute(action: ComputerAction): Promise<ActionResult> {
    try {
      switch (action.kind) {
        case "navigate": {
          await cdpCall(this.pageWs, "Page.navigate", { url: action.url }, this.commandTimeoutMs);
          await this.waitForReady();
          return { ok: true, message: `已导航 ${action.url.slice(0, 120)}` };
        }
        case "click":
        case "double_click": {
          if (action.target.kind === "candidates") throw new Error("动作目标尚未完成定位");
          const clicked = await this.dispatchOnTarget(action.target, "click");
          if (clicked.matched) await this.maybeSwitchPageTarget();
          return { ok: clicked.matched, message: clicked.matched ? "已点击" : `未定位：${clicked.detail}` };
        }
        case "type":
        case "paste_text": {
          if (action.target.kind === "candidates") throw new Error("动作目标尚未完成定位");
          const focused = await this.dispatchOnTarget(action.target, "focus");
          if (!focused.matched) return { ok: false, message: `未定位：${focused.detail}` };
          await cdpCall(this.pageWs, "Input.insertText", { text: action.text }, this.commandTimeoutMs);
          return { ok: true, message: `已输入 ${action.text.slice(0, 40)}` };
        }
        case "keypress": {
          const keys = action.keys;
          const prevUrl = await this.evaluateOnPage<string>("location.href").catch(() => "");
          if (keys === "Enter") {
            const enterParams = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
            await cdpCall(this.pageWs, "Input.dispatchKeyEvent",
              { ...enterParams, type: "rawKeyDown" }, this.commandTimeoutMs);
            await cdpCall(this.pageWs, "Input.dispatchKeyEvent",
              { ...enterParams, type: "char", text: "\r", unmodifiedText: "\r" }, this.commandTimeoutMs);
            await cdpCall(this.pageWs, "Input.dispatchKeyEvent",
              { ...enterParams, type: "keyUp" }, this.commandTimeoutMs);
          } else if (keys === "Backspace") {
            const bs = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
            await cdpCall(this.pageWs, "Input.dispatchKeyEvent", { ...bs, type: "rawKeyDown" }, this.commandTimeoutMs);
            await cdpCall(this.pageWs, "Input.dispatchKeyEvent", { ...bs, type: "keyUp" }, this.commandTimeoutMs);
          } else {
            throw new Error(`raw-cdp: 未支持按键 ${keys}`);
          }
          // 按键可能触发导航（Enter 提交搜索）：等待 url 变化 + 加载完成
          await this.waitForNavigation(prevUrl);
          return { ok: true, message: `已按键 ${keys}` };
        }
        case "wait":
          await new Promise((r) => setTimeout(r, action.ms));
          return { ok: true, message: `已等待 ${action.ms}ms` };
        case "screenshot":
          await this.observe();
          return { ok: true, message: "已截图" };
        case "done":
        case "ask_user":
          return { ok: true, message: action.kind === "done" ? action.summary : action.question };
        default:
          return { ok: false, message: `raw-cdp: 未支持动作 ${action.kind}（fail-closed）` };
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 在页面上定位目标并执行 DOM 动作（click/focus）；返回是否命中。 */
  private async dispatchOnTarget(target: TargetSpec & { kind: string },
    op: "click" | "focus"): Promise<{ matched: boolean; detail: string }> {
    const located = await this.evaluateOnPage<{ matched: boolean; identity?: string; detail: string }>(
      `(() => { const target = ${JSON.stringify(target)}; ${LOCATE_BODY} })()`);
    if (!located.matched || !located.identity) return { matched: false, detail: located.detail };
    const selector = located.identity.slice("identity:".length);
    await this.evaluateOnPage<unknown>(`(() => {
      const parts = ${JSON.stringify(selector)}.split('>').slice(1);
      let el = document.documentElement;
      for (const part of parts) {
        const m = /^([a-z]+)\\[(\\d+)\\]$/.exec(part);
        if (!m) return null;
        const siblings = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === m[1]);
        el = siblings[Number(m[2]) - 1];
        if (!el) return null;
      }
      if (el) { ${op === "click" ? "el.click()" : "el.focus()"}; }
      return !!el;
    })()`);
    return { matched: true, detail: located.detail };
  }

  /** 等 domcontentloaded：轮询 readyState（CDP Page.navigate 后）。 */
  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.navigationTimeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluateOnPage<string>("document.readyState").catch(() => "unknown");
      if (state === "complete" || state === "interactive") return;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("raw-cdp: 页面加载超时");
  }

  /** 等 url 变化（按键触发导航等）；变化后再等加载完成；无变化立即返回。 */
  private async waitForNavigation(previousUrl: string): Promise<void> {
    const deadline = Date.now() + this.navigationTimeoutMs;
    let changed = false;
    while (Date.now() < deadline) {
      const url = await this.evaluateOnPage<string>("location.href").catch(() => previousUrl);
      if (url !== previousUrl) { changed = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (changed) await this.waitForReady();
  }

  async close(): Promise<void> {
    this.pageWs = "";
  }
}
