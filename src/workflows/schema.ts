import type { ComputerAction, Target } from "../actions/schema.js";
import type { SemanticTarget } from "../actions/semantic-target.js";
import type { CapabilityEnvironment } from "../capabilities/registry.js";
import type { CompletionCriteria } from "../verifier/verifier.js";

export interface WorkflowInput {
  name: string;
  example: string;
  /** v2 typed input；缺省为 text（v1 兼容）。 */
  kind?: WorkflowInputKind;
  /** kind=choice 时的候选值，必须非空且 example 在其中。 */
  choices?: string[];
  /** v2：参数绑定到某步骤的某参数（stepId + 规范 argument），绝不绑定数组下标。 */
  boundTo?: WorkflowInputBinding;
}

export type WorkflowInputKind = "text" | "number" | "choice" | "bool";

/** typed 参数值：text/choice 为字符串，number 为有限数字，bool 为布尔。 */
export type WorkflowInputValue = string | number | boolean;

/** 规范参数键：text=动作文本字段；value/text=数值字段或文本字段；choice=点击目标选项文本；checked=勾选期望（bool）；
 *  digit_sequence=数字值按位展开为数字按钮序列点击（通用可访问性语义，适用于数字键盘型 UI）。 */
export type WorkflowInputArgument = "text" | "value/text" | "choice" | "checked" | "digit_sequence";

export interface WorkflowInputBinding {
  /** 参数绑定目标步骤的持久化 stepId；stepId 不存在视为定义无效。 */
  stepId: string;
  argument: WorkflowInputArgument;
}

export type WorkflowPrecondition =
  | { kind: "url_host" | "window_title" | "window_class"; value: string }
  /** 结构化锚点前置：当次完整枚举中必须唯一存在 role+name 控件；缺失/不唯一/incomplete/来源不符都 fail closed。 */
  | { kind: "structured_anchor"; source: "dom" | "uia"; role: string; name: string };

export interface WorkflowStep {
  /** v2 必填：步骤持久化标识，供参数绑定（boundTo）与结构化条件引用；v1 缺省。 */
  stepId?: string;
  goal: string;
  /** 只保存有语义的目标。窗口坐标和截图模板不能成为主要动作。 */
  action: ComputerAction;
  preferredMethods: string[];
  targetHint?: Target;
  semanticTarget?: SemanticTarget;
  successCondition: WorkflowStepCondition;
  idempotent?: boolean;
  fallbackEvidence?: string[];
}

export type WorkflowStepCondition =
  | { kind: "url_includes"; value: string }
  | { kind: "text_includes"; value: string }
  | { kind: "accessibility_includes"; value: string }
  | { kind: "state_changed" }
  | { kind: "checked_equals"; target: Target; value: boolean }
  /** 结构化字段断言：仅当次完整枚举（source 匹配 + 唯一控件 + 字段严格相等）才算达成。 */
  | { kind: "structured_equals"; source: "dom" | "uia"; target: Target;
      field: "text" | "value" | "checked"; expected: string | boolean };

/** v1 = 旧格式（inputs 无类型、step 无 stepId）；v2 = 泛化格式（typed inputs、stepId、结构化条件、持久化契约）。 */
export type WorkflowSchemaVersion = 1 | 2;

/**
 * 读取守卫认可的 Schema 版本集合（正面白名单）：缺省 + 1 + 2。
 * 缺省与 1 同义（历史 v1 库），2 为泛化格式；除此之外的一律视为未知。
 */
const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/** 只描述类型；未知字符串可能含敏感内容，禁止回显原值或其前缀。 */
function describeSchemaValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function briefId(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value) : "unavailable";
}

/**
 * 未知 `workflowSchemaVersion` 读取守卫（fail-closed，纯校验，不读不写任何存储）：
 * - 缺省 / 1 / 2 放行；
 * - 其他数值（如 3）、null、字符串（如 "2"）、布尔、数组、对象一律拒绝。
 * 因此未知版本不会被自动当成 v1，也不可能进入 matcher / preview / replay / publish。
 * 错误信息只携带序号与版本便于诊断（Issue #75 要求），不含指针/行内容等私有数据。
 */
export function assertKnownWorkflowSchemaVersion(workflow: Workflow, origin: string): void {
  const raw = (workflow as { workflowSchemaVersion?: unknown }).workflowSchemaVersion;
  if (raw === undefined || SUPPORTED_SCHEMA_VERSIONS.has(raw as number)) return;
  throw new Error(`unsupported-workflow-schema-version: ${describeSchemaValue(raw)} ` +
    `(workflowId=${briefId(workflow?.id)}, version=${briefId(workflow?.version)}, source=${origin})`);
}

/**
 * 持久化结果契约：Workflow 只「声明」完成后必须证明的持久结果，证明权始终在核心 Verifier——
 * durable_state 必须由核心 rebind 状态机证明（R0→edit→commit→absence→rebound→terminal），
 * desktop_file 必须由核心 file gate 证明。Workflow 不得把持久化压成单步条件（不存在 durable 条件种类）。
 */
export type DurableResultContract =
  | { kind: "durable_state"; structuredStates: NonNullable<CompletionCriteria["structuredStates"]> }
  | { kind: "desktop_file"; path: string; contentEquals?: string; sha256?: string };

export interface Workflow {
  id: string;
  version: number;
  status: "candidate" | "verified" | "retired";
  /** 缺省/1 视为 v1（旧库兼容）；2 为批次 3 泛化格式。 */
  workflowSchemaVersion?: WorkflowSchemaVersion;
  /** 缺省为旧版整任务流程；阶段流程由外层 Stage Verifier 验收。 */
  scope?: "task" | "stage";
  stageCondition?: string;
  environment: CapabilityEnvironment;
  taskPattern: string;
  inputs: WorkflowInput[];
  preconditions: WorkflowPrecondition[];
  steps: WorkflowStep[];
  successConditions: CompletionCriteria;
  /** v2：持久化结果契约（仅声明；证明走核心 rebind 状态机与 file gate）。 */
  durableContract?: DurableResultContract[];
  knownFailures: string[];
  sourceTaskId: string;
  sourceTrace: string;
  createdAt: string;
  lastVerifiedAt?: string;
  successCount: number;
  failureCount: number;
}

export interface WorkflowMatch {
  workflow: Workflow;
  values: Record<string, WorkflowInputValue>;
  score: number;
}
