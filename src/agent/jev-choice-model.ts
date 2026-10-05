import type { ComputerAction } from "../actions/schema.js";
import type { ComputerState } from "../graph/state.js";
import type { ModelAdapter, TokenUsage } from "./model-adapter.js";
import { readPrompt } from "./prompt-store.js";
import { meteredModelRequest } from "../runtime/model-budget.js";
import { compactObservationFacets } from "../contracts/facets.js";

export interface JevChoiceOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  candidateActions(state: Readonly<ComputerState>): readonly ComputerAction[];
  confidenceThreshold?: number;
  timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Jev 返回的数据不是对象");
  }
  return value as Record<string, unknown>;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 只让 Jev 从项目生成的动作中选择，不接受模型自行生成的目标或文字。 */
export class JevChoiceModel implements ModelAdapter {
  readonly kind = "model";
  readonly name: string;
  private readonly baseUrl: string;
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private lastUsage?: TokenUsage;

  constructor(private readonly options: JevChoiceOptions) {
    if (!options.apiKey) throw new Error("缺少 Jev 服务 API Key");
    this.name = options.model ?? "jev";
    this.baseUrl = options.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.threshold = options.confidenceThreshold ?? 0.75;
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (this.threshold < 0 || this.threshold > 1) throw new Error("Jev 置信度阈值必须在 0 到 1 之间");
  }

  private async request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const invoke = async () => {
    const response = await fetch(`${this.baseUrl}/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Jev 服务返回 HTTP ${response.status}`);
    return record(payload);
    };
    return body === undefined ? invoke() : meteredModelRequest('jev', invoke);
  }

  async checkConnection(): Promise<void> {
    const payload = await this.request("/models");
    const available = Array.isArray(payload.data)
      ? payload.data.some((item) => item && typeof item === "object" &&
          (item as { id?: unknown }).id === this.name)
      : Array.isArray(payload.models) && payload.models.some((item) =>
          item && typeof item === "object" && (item as { name?: unknown }).name === this.name);
    if (!available) throw new Error(`Jev 模型列表中未找到 ${this.name}`);
  }

  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    this.lastUsage = undefined;
    const actions = this.options.candidateActions(state);
    if (!actions.length || actions.length > 64) {
      throw new Error("Jev 需要 1 到 64 个由项目生成的候选动作");
    }
    // choice 的键只由本地代码生成，服务返回值只能映射回这些动作。
    const criteria = Object.fromEntries(actions.map((action, index) =>
      [`action_${index}`, JSON.stringify(action)]));
    const observation = state.observation;
    const payload = await this.request("/systemone", {
      model: this.name,
      state: { goal: state.goal, plan: state.plan, step: state.step,
        lastAction: state.lastAction, lastResult: state.lastResult,
        lastVerification: state.lastVerification, error: state.error,
        observation: observation && { url: observation.url, windowTitle: observation.windowTitle,
          pageText: observation.pageText?.slice(0, 6000),
          accessibility: observation.accessibility?.slice(0, 10000),
          dom: observation.dom?.slice(0, 6000),
          // 业务证据以通用 facet 信封透传，JEV 只看到域 id 与数据，不依赖核心专有字段。
          facets: compactObservationFacets(observation.facets) } },
      questions: { next_action: { type: "choice",
        instructions: readPrompt("jev-choice"),
        criteria } },
    });
    if (payload.usage) {
      const usage = record(payload.usage);
      const inputTokens = nonnegative(usage.input_tokens);
      const outputTokens = nonnegative(usage.output_tokens);
      this.lastUsage = { inputTokens, outputTokens,
        totalTokens: inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens : undefined };
    }
    const answer = record(record(payload.answers).next_action);
    const choice = answer.choice;
    const confidence = nonnegative(answer.confidence);
    if (answer.type !== "choice" || typeof choice !== "string" ||
        !Object.hasOwn(criteria, choice) || confidence === undefined || confidence > 1) {
      throw new Error("Jev 返回了无效的候选动作或置信度");
    }
    if (confidence < this.threshold) {
      throw new Error(`Jev 对候选动作的置信度不足：${confidence.toFixed(2)}`);
    }
    return actions[Number(choice.slice("action_".length))];
  }

  takeUsage(): TokenUsage | undefined {
    const usage = this.lastUsage;
    this.lastUsage = undefined;
    return usage;
  }
}
