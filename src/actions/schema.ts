export type Target =
  | { kind: "role"; role: string; name?: string }
  | { kind: "label"; label: string }
  | { kind: "text"; text: string }
  | { kind: "selector"; selector: string }
  | { kind: "vision"; description: string }
  | { kind: "coordinate"; x: number; y: number };

export type TargetSpec = Target | { kind: "candidates"; options: Target[] };

/** Optional, observable result frozen with a click/key action before dispatch. */
export type ActionPostcondition =
  | { kind: "url_equals"; value: string }
  | { kind: "url_includes"; value: string }
  | { kind: "uia_present"; target: Target }
  | { kind: "desktop_file"; path: string; contentEquals?: string; sha256?: string };

/** 定位策略；semantic_remap 为 P9-A4 通用语义目标重映射（纯函数，replay 语义漂移）。 */
export type GroundingStrategy = Target["kind"] | "semantic_remap";

export interface GroundingAttempt {
  strategy: GroundingStrategy;
  matched: boolean;
  selected: boolean;
  detail: string;
}

export interface GroundingResult {
  target?: Target;
  attempts: GroundingAttempt[];
}

export type ComputerAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: TargetSpec; postcondition?: ActionPostcondition }
  | { kind: "double_click"; target: TargetSpec; postcondition?: ActionPostcondition }
  | { kind: "type"; target: TargetSpec; text: string }
  | { kind: "paste_text"; target: TargetSpec; text: string }
  | { kind: "drag"; source: Target; destination: Target }
  | { kind: "keypress"; keys: string; postcondition?: ActionPostcondition }
  | { kind: "scroll"; direction: "up" | "down"; amount: number; target?: TargetSpec }
  | { kind: "wait"; ms: number }
  | { kind: "screenshot" }
  | { kind: "ask_user"; question: string }
  | { kind: "done"; summary: string }
  /** 通用勾选语义：把 checkbox 设置到目标布尔状态；已处于目标状态时不产生点击。 */
  | { kind: "set_checked"; target: TargetSpec; checked: boolean }
  /** 通用下拉选择语义：按选项文本选择 <select> 的选项。 */
  | { kind: "select_option"; target: TargetSpec; option: string };

export interface Observation {
  /** Collector-local clock/epoch; never assume synchronized with Host wall time. */
  capture?: {epoch:string;sequence:number;object:string;startedAt:number;finishedAt:number;
    clock:'collector';atomic:false;fields:Record<string,{complete:boolean;source?:'dom'|'uia'|'api'|'window'|'file'}>;enumerationComplete?:boolean};
  url?: string;
  windowTitle?: string;
  windowHandle?: number;
  windowRect?: { left: number; top: number; width: number; height: number };
  desktopPath?: string;
  screenshot?: string;
  screenshotHash?: string;
  /** Full Guest desktop evidence, separate from window-relative action coordinates. */
  desktopScreenshot?: string;
  desktopScreenshotHash?: string;
  desktopCapturedAt?: string;
  desktopCaptureError?: string;
  pageText?: string;
  /** 页面文本的原始来源；pageText 仅供展示和决策，验收时按来源核对。 */
  textEvidence?: Array<{ source: "dom" | "uia" | "visual_model"; text: string }>;
  dom?: string;
  accessibility?: string;
  /** Collector-scoped controls. A complete enumeration is required before absence can be a failure. */
  structured?: {source:"dom"|"uia";complete:boolean;
    /** Post-dedup candidate budget metadata; absent on legacy/UIA observations. */
    candidateCount?:number;retainedCount?:number;candidateBudget?:number;budgetSaturated?:boolean;
    items:Array<{
    role:string;name?:string;text?:string;href?:string;value?:string;checked?:boolean;
    classTokens?:string[];complete?:boolean;
    /** DOM 节点级运行时身份（browser）：页面加载世代 + 确定性 DOM 路径。跨导航必变，同页内唯一。 */
    identity?:string;
    /** <select> 可选项文本（browser，只读枚举；供 choice 参数化候选）。 */
    options?:string[];
  }>};
  /**
   * 域证据 facet（业务无关外壳）：key=facetId（如扩展注册的 shop 商品 / music 播放 facet）。
   * 核心只透传与做来源/新鲜/对象/schema 绑定校验，从不解读 data 的业务含义。
   * 类型这里用结构化最小形状，完整契约与校验见 contracts/facets。
   */
  facets?: Record<string, {
    facetId:string; schemaVersion:number; providerVersion:string; captureId:string;
    subjectRef:{kind:"browser_page"|"desktop_window";key:string;url?:string;windowHandle?:number;windowTitle?:string};
    source:"dom"|"uia"|"app_api"|"window"|"file"; capturedAt:number; complete:boolean; data:unknown;
  }>;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** none 才允许自动换执行器；uncertain 必须先重新观察。 */
  effect?: "none" | "uncertain" | "dispatched";
  /** 实际执行动作的工具；失败时可留空。 */
  provider?: string;
  observation?: Observation;
}
