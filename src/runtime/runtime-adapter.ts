import type { ActionResult, ComputerAction, GroundingResult, Observation } from "../actions/schema.js";
import type { ActionResolution } from "../actions/action-resolution.js";
import type { TokenUsage } from "../agent/model-adapter.js";
import type { DesktopFileSnapshot } from "../verification/file-evidence.js";

export interface RuntimeAdapter {
  readonly name?: string;
  observe(): Promise<Observation>;
  restore?(observation: Observation): Promise<void>;
  ground?(action: ComputerAction): Promise<GroundingResult>;
  resolveAction?(action: ComputerAction): Promise<ActionResolution>;
  /** 恢复当前已绑定窗口的前台状态；失败时不得执行旧动作。 */
  recoverFocus?(): Promise<void>;
  execute(action: ComputerAction, resolution?: ActionResolution, actionId?: string): Promise<ActionResult>;
  inspectFile?(path:string):Promise<DesktopFileSnapshot>;
  /**
   * 业务无关的浏览器只读 DOM 探针：供扩展侧 facet provider 在当次页面上读取指定元素，
   * 选择器与属性白名单、数量上限由运行时强制；provider 不能注入脚本。桌面运行时不提供。
   */
  readDom?(request:{selector:string;attribute?:string}):
    Promise<Array<{text?:string;attr?:string}>>;
  takeOperationMetric?(): ({ actor: "model"; operator: string; modelName: string } & TokenUsage) | undefined;
}

/** Deterministic runtime for M0. M1 supplies a Playwright implementation. */
export class FakeRuntime implements RuntimeAdapter {
  readonly name = "模拟运行时";
  readonly executed: ComputerAction[] = [];
  private url = "about:blank";

  constructor(private readonly failAt: ReadonlySet<number> = new Set()) {}

  async observe(): Promise<Observation> {
    return { url: this.url, pageText: `Fake page at ${this.url}`, dom: "<main>Fake page</main>" };
  }

  async execute(action: ComputerAction): Promise<ActionResult> {
    this.executed.push(action);
    if (this.failAt.has(this.executed.length)) return { ok: false, message: "simulated failure" };
    if (action.kind === "navigate") this.url = action.url;
    return { ok: true, message: `${action.kind} executed` };
  }
}
