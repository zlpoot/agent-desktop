/**
 * Observation Facet —— 业务无关的「域证据外壳」（P8 批次 2 / P8-A §11.2）。
 *
 * 核心只定义证据外壳与注册/校验规则，从不解读 `data` 的业务含义。
 * 「读什么、data 长什么样、域谓词怎么算」全部由扩展侧 provider/contributor 提供。
 *
 * fail-closed 不变量（任何扩展都不得绕过）：
 *  - facet 必须绑定到「当次 capture」与「唯一 subject」；历史缓存 / 仅凭 facetId 不能通过完成门；
 *  - schemaVersion/providerVersion/captureId/subjectRef/source/capturedAt/complete 缺一不可；
 *  - provider 注册时必须提供 schema validator，data 校验失败不得参与 PASS/FAIL；
 *  - 证据来源不包括 eval_oracle：EVAL/Oracle 旁路在类型与装配上都不能进入生产证据（见 §11.2）。
 */

/** 生产证据来源枚举。刻意不含 eval_oracle；EVAL 通道另立 EvalEvidenceProvenance，结构上不能传入生产 contributor。 */
export type FacetSource = "dom" | "uia" | "app_api" | "window" | "file";

/** Facet 绑定的任务对象身份；必须可与当次观察的页面/窗口核对。 */
export interface EvidenceSubjectRef {
  kind: "browser_page" | "desktop_window";
  /** 归一化对象键：浏览器为 origin+pathname，桌面为 handle+title；用于同一性判定。 */
  key: string;
  url?: string;
  windowHandle?: number;
  windowTitle?: string;
}

/** provider 采集后返回的域载荷；证据信封由核心统一盖章，provider 不能伪造 captureId/subject。 */
export interface FacetPayload {
  complete: boolean;
  data: unknown;
}

/** 落盘到 Observation.facets 上的、已盖章的 facet 值。 */
export interface FacetValue {
  facetId: string;
  schemaVersion: number;
  providerVersion: string;
  captureId: string;
  subjectRef: EvidenceSubjectRef;
  source: FacetSource;
  capturedAt: number;
  complete: boolean;
  data: unknown;
}

/** provider 采集时可见的最小、只读、已绑定上下文；不含 Oracle / 模型 / 历史动作。 */
export interface FacetContext {
  environment: "browser" | "windows";
  /** 当次 capture 身份（epoch:sequence）。 */
  captureId: string;
  /** 当次观察绑定的唯一对象。 */
  subject: EvidenceSubjectRef;
  /** 观察采集完成的采集器时钟毫秒；facet.capturedAt 必须紧邻该时刻。 */
  capturedAt: number;
  /** 当次观察的通用、业务无关证据；与 subject 同属一次 capture，provider 只可读取这些。 */
  pageUrl?: string;
  windowTitle?: string;
  accessibility?: string;
  /**
   * 浏览器环境下由核心托管的只读 DOM 查询（业务无关）；windows 环境为 undefined。
   * 选择器语义与长度/数量上限由运行时强制，provider 只声明选择器。
   */
  readDom?(request: FacetDomReadRequest): Promise<FacetDomReadResult[]>;
}

export interface FacetDomReadRequest {
  selector: string;
  /** 不填取文本；填写则取该属性。 */
  attribute?: string;
}

export interface FacetDomReadResult {
  text?: string;
  attr?: string;
}

export type FacetSchemaValidation =
  | { ok: true }
  | { ok: false; reason: string };

export type FacetSchemaValidator = (data: unknown) => FacetSchemaValidation;

export interface ObservationFacetProvider {
  readonly id: string;
  readonly schemaVersion: number;
  readonly providerVersion: string;
  readonly environment: "browser" | "windows";
  readonly source: FacetSource;
  /** 注册即提供的 data schema 校验器；校验失败的 facet 不得参与自动裁决。 */
  validate: FacetSchemaValidator;
  /** 不命中当前页面/窗口时返回 undefined（无 facet），不得抛错伪装证据。 */
  collect(ctx: FacetContext): Promise<FacetPayload | undefined>;
}

/** Facet 注册表：仅注册/查询，重复 id 拒绝；业务无关。 */
export class FacetRegistry {
  private readonly providers = new Map<string, ObservationFacetProvider>();

  register(provider: ObservationFacetProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Facet provider ${provider.id} 已注册`);
    if (!Number.isInteger(provider.schemaVersion) || provider.schemaVersion < 1) {
      throw new Error(`Facet provider ${provider.id} 的 schemaVersion 必须是 >=1 的整数`);
    }
    if (typeof provider.providerVersion !== "string" || !provider.providerVersion.trim()) {
      throw new Error(`Facet provider ${provider.id} 缺少 providerVersion`);
    }
    if (typeof provider.validate !== "function" || typeof provider.collect !== "function") {
      throw new Error(`Facet provider ${provider.id} 必须提供 validate 与 collect`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ObservationFacetProvider | undefined {
    return this.providers.get(id);
  }

  forEnvironment(environment: "browser" | "windows"): ObservationFacetProvider[] {
    return [...this.providers.values()].filter((provider) => provider.environment === environment);
  }

  list(): ObservationFacetProvider[] {
    return [...this.providers.values()];
  }
}

/**
 * 模型上下文用的通用 facet 摘要：仅暴露 facetId/complete/data，剥离采集元数据。
 * 核心与模型都不认识具体域，业务语义由 data 自身携带。无 facet 时返回 undefined。
 */
export function compactObservationFacets(facets: Record<string, FacetValue> | undefined):
    Array<{ facetId: string; complete: boolean; data: unknown }> | undefined {
  if (!facets) return undefined;
  const entries = Object.values(facets);
  if (entries.length === 0) return undefined;
  return entries.map((facet) => ({ facetId: facet.facetId, complete: facet.complete, data: facet.data }));
}
