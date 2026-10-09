import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import type { ActionResult, ComputerAction, GroundingResult, Observation } from "../../actions/schema.js";
import { singleProvider } from "../../actions/action-resolution.js";
import { groundDomTarget, targetLocator } from "../../grounding/dom.js";
import type { RuntimeAdapter } from "../runtime-adapter.js";
import { DOM_COLLECTOR } from "./dom-collector.js";

export interface PlaywrightRuntimeOptions {
  headless?: boolean;
  artifactDir?: string;
  userDataDir?: string;
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
}

export interface DomExtraction { text: string; attributes: Record<string, string> }

export class PlaywrightRuntime implements RuntimeAdapter {
  readonly name = "Playwright";
  private observationCount = 0;
  private readonly captureEpoch = randomUUID();
  private page: Page;
  private readonly artifactDir: string;
  private readonly actionTimeoutMs: number;
  private readonly navigationTimeoutMs: number;

  private constructor(
    private readonly browser: Browser | undefined,
    private readonly context: BrowserContext,
    page: Page,
    options: PlaywrightRuntimeOptions,
  ) {
    this.page = page;
    this.artifactDir = resolve(options.artifactDir ?? ".artifacts");
    this.actionTimeoutMs = options.actionTimeoutMs ?? 5000;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 15000;
  }

  static async launch(options: PlaywrightRuntimeOptions = {}): Promise<PlaywrightRuntime> {
    // 默认使用项目内的浏览器文件，避免依赖用户目录的缓存权限。
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".playwright-browsers");
    const { chromium } = await import("playwright");
    const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    const launchOptions = {
      headless: options.headless ?? true,
      proxy: proxyUrl ? { server: proxyUrl, bypass: process.env.NO_PROXY } : undefined,
    };
    const browser = options.userDataDir ? undefined : await chromium.launch(launchOptions);
    const context = options.userDataDir
      ? await chromium.launchPersistentContext(resolve(options.userDataDir), {
          ...launchOptions, viewport: { width: 1280, height: 800 },
        })
      : await browser!.newContext({ viewport: { width: 1280, height: 800 } });
    const page = context.pages()[0] ?? await context.newPage();
    return new PlaywrightRuntime(browser, context, page, options);
  }

  /** Attach to a caller-owned, already authenticated page. Never launches a browser.
   * The caller retains native identity, input authority, observation and cleanup gates. */
  static attach(page: Page, options: PlaywrightRuntimeOptions = {}): PlaywrightRuntime {
    return new PlaywrightRuntime(undefined, page.context(), page, options);
  }

  async restore(observation: Observation): Promise<void> {
    if (!observation.url) throw new Error("保存的页面观察缺少网址");
    const url = new URL(observation.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只能恢复 HTTP(S) 页面");
    const matchingPage = this.context.pages().find((page) => page.url() === url.href);
    if (matchingPage) { this.page = matchingPage; return; }
    await this.page.goto(url.href, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
  }

  async observe(): Promise<Observation> {
    const startedAt=Date.now();
    await mkdir(this.artifactDir, { recursive: true });
    const screenshot = resolve(this.artifactDir, `observation-${++this.observationCount}.png`);
    await this.page.screenshot({ path: screenshot, fullPage: false });
    const body = this.page.locator("body");
    const text = await body.innerText().catch(() => undefined);
    const html = await this.page.content();
    const aria = await body.ariaSnapshot().catch(() => undefined);
    // 注意：collector 必须以字符串常量传递（DOM_COLLECTOR）——tsx keepNames 会给命名/箭头
    // 函数注入 __name helper，浏览器上下文没有该全局，evaluate 会抛 ReferenceError。
    const structured = await this.page.evaluate(DOM_COLLECTOR).catch(() => undefined) as Observation['structured'];
    const pageText = (text??'').slice(0,30000);
    return {
      url: this.page.url(),
      capture:{epoch:this.captureEpoch,sequence:this.observationCount,object:`page:${this.captureEpoch}`,startedAt,
        finishedAt:Date.now(),clock:'collector',atomic:false,fields:{
            url:{complete:true,source:'api'},
            pageText:{complete:text!==undefined&&text.length<=30000,source:'dom'},dom:{complete:html.length<=30000,source:'dom'},
          accessibility:{complete:aria!==undefined&&aria.length<=30000,source:'dom'},
          ...(structured?{structured:{complete:structured.complete,source:'dom' as const}}:{})}},
      screenshot,
      pageText,
      textEvidence: [{ source: "dom", text: pageText }],
      dom: html.slice(0,30000),
      accessibility: (aria??'').slice(0,30000),
      ...(structured?{structured}:{}),
      // 默认 observe 不再产出任何站点业务 facet；商品等富化由扩展注册的 facet provider 采集。
    };
  }

  async ground(action: ComputerAction): Promise<GroundingResult> {
    return groundDomTarget(this.page, action);
  }

  async resolveAction(action: ComputerAction) {
    return singleProvider("browser.playwright.act", `${action.kind} 已绑定项目浏览器页面，使用 Playwright 执行`);
  }

  /** 受控 DOM 读取：只取指定元素文本和少量属性，不执行调用方脚本。 */
  async extractDom(selector: string, attributes: string[] = []): Promise<DomExtraction[]> {
    if (!selector.trim() || selector.length > 200 || attributes.length > 5 ||
        attributes.some((name) => !/^(href|src|alt|title|aria-label|value)$/.test(name))) {
      throw new Error("DOM 摘录参数无效");
    }
    const locator = this.page.locator(selector);
    const count = await locator.count();
    if (count > 20) throw new Error("DOM 摘录匹配过多元素");
    const output: DomExtraction[] = [];
    for (let index = 0; index < count; index++) {
      const element = locator.nth(index);
      const values: Record<string, string> = {};
      for (const name of attributes) values[name] = (await element.getAttribute(name) ?? "").slice(0, 500);
      output.push({ text: (await element.textContent() ?? "").trim().slice(0, 2000), attributes: values });
    }
    return output;
  }

  /**
   * 业务无关的只读 DOM 探针（RuntimeAdapter.readDom）：供扩展 facet provider 在当次页面读取
   * 单个选择器的文本或一个安全属性；不执行脚本，选择器/数量/长度受限。
   */
  async readDom(request: { selector: string; attribute?: string }):
      Promise<Array<{ text?: string; attr?: string }>> {
    const { selector, attribute } = request;
    if (!selector.trim() || selector.length > 200) throw new Error("DOM 读取选择器无效");
    if (attribute !== undefined &&
        !/^(href|src|alt|title|aria-label|value|content)$/.test(attribute)) {
      throw new Error("DOM 读取属性不在允许列表");
    }
    const locator = this.page.locator(selector);
    const count = await locator.count();
    if (count > 20) throw new Error("DOM 读取匹配过多元素");
    const output: Array<{ text?: string; attr?: string }> = [];
    for (let index = 0; index < count; index++) {
      const element = locator.nth(index);
      if (attribute === undefined) {
        output.push({ text: (await element.textContent() ?? "").trim().slice(0, 2000) });
      } else {
        output.push({ attr: (await element.getAttribute(attribute) ?? "").slice(0, 500) });
      }
    }
    return output;
  }

  async execute(action: ComputerAction): Promise<ActionResult> {
    try {
      switch (action.kind) {
        case "navigate":
          await this.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
          break;
        case "click":
        case "double_click": {
          const openedPage = this.context.waitForEvent("page", { timeout: 2000 }).catch(() => undefined);
          if (action.target.kind === "candidates") throw new Error("动作目标尚未完成定位");
          if (action.target.kind === "coordinate") {
            await this.page.mouse.click(action.target.x, action.target.y,
              { clickCount: action.kind === "double_click" ? 2 : 1 });
          } else {
            const locator = targetLocator(this.page, action.target);
            if (action.kind === "double_click") await locator.dblclick({ timeout: this.actionTimeoutMs });
            else await locator.click({ timeout: this.actionTimeoutMs });
          }
          const newPage = await openedPage;
          if (newPage) {
            this.page = newPage;
            await this.page.waitForLoadState("domcontentloaded", { timeout: this.navigationTimeoutMs });
          }
          break;
        }
        case "type":
        case "paste_text":
          if (action.target.kind === "candidates") throw new Error("动作目标尚未完成定位");
          if (action.target.kind === "coordinate") throw new Error("输入文字需要结构化目标");
          await targetLocator(this.page, action.target).fill(action.text, { timeout: this.actionTimeoutMs });
          break;
        case "set_checked": {
          // 通用「设为目标状态」语义：Playwright setChecked 先读当前值，已匹配则不产生点击；
          // 未匹配才执行一次点击切换。绝不盲目 toggle。
          if (action.target.kind === "candidates") throw new Error("动作目标尚未完成定位");
          if (action.target.kind === "coordinate") throw new Error("勾选需要结构化目标");
          await targetLocator(this.page, action.target).setChecked(action.checked,
            { timeout: this.actionTimeoutMs });
          break;
        }
        case "select_option": {
          if (action.target.kind === "candidates") throw new Error("动作目标尚未完成定位");
          if (action.target.kind === "coordinate") throw new Error("下拉选择需要结构化目标");
          await targetLocator(this.page, action.target).selectOption({ label: action.option },
            { timeout: this.actionTimeoutMs });
          break;
        }
        case "drag": {
          if (action.source.kind === "coordinate" || action.destination.kind === "coordinate" ||
              action.source.kind === "vision" || action.destination.kind === "vision") {
            throw new Error("浏览器拖拽只允许 DOM 目标");
          }
          const source = targetLocator(this.page, action.source);
          const destination = targetLocator(this.page, action.destination);
          if (await source.count() !== 1 || await destination.count() !== 1) {
            throw new Error("拖拽起点和终点必须各自唯一");
          }
          await source.dragTo(destination, { timeout: this.actionTimeoutMs });
          break;
        }
        case "keypress": {
          const openedPage = /^(enter|return)$/i.test(action.keys)
            ? this.context.waitForEvent("page", { timeout: 2000 }).catch(() => undefined)
            : undefined;
          await this.page.keyboard.press(action.keys);
          const newPage = await openedPage;
          if (newPage) {
            this.page = newPage;
            await this.page.waitForLoadState("domcontentloaded", { timeout: this.navigationTimeoutMs });
          }
          break;
        }
        case "scroll":
          await this.page.mouse.wheel(0, action.amount * (action.direction === "down" ? 1 : -1));
          break;
        case "wait":
          await this.page.waitForTimeout(Math.min(Math.max(action.ms, 0), 10000));
          break;
        case "screenshot":
          return { ok: true, message: "已截图", provider: "browser.playwright.act",
            observation: await this.observe() };
        case "ask_user":
        case "done":
          throw new Error(`${action.kind} 由 Agent Loop 处理`);
        default: {
          const unsupported: never = action;
          throw new Error(`不支持的浏览器动作：${JSON.stringify(unsupported)}`);
        }
      }
      return { ok: true, message: `${action.kind} 已执行`, provider: "browser.playwright.act" };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser?.close();
  }
}
