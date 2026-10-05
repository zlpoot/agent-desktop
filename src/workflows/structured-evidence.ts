import type { Observation } from "../actions/schema.js";
import type { WorkflowPrecondition, WorkflowStepCondition } from "./schema.js";

/**
 * B3-4 结构化证据门（P7/P8 证据语义）：
 * 任何 structured 判定都只消费「当次 observe 返回的枚举」——条件本身不携带任何旧证据快照，
 * 因此旧 DOM/UIA 不可能被回放拿去判步骤成功。
 * 判定四要件缺一不可：当次 capture（observation.structured 存在）+
 * complete===true（完整枚举）+ source 匹配 + 唯一 subject（0 个或 >1 个都 fail closed）。
 */

export interface StructuredSubject {
  role: string;
  name?: string;
  text?: string;
  value?: string;
  checked?: boolean;
  classTokens?: string[];
  complete?: boolean;
}

export function resolveStructuredSubject(
  observation: Observation, source: "dom" | "uia", role: string, name: string,
): StructuredSubject | undefined {
  const structured = observation.structured;
  // 证据缺失 / 枚举不完整 / 来源不符 → 不可判定（fail closed）
  if (!structured || structured.complete !== true || structured.source !== source) return undefined;
  const matches = structured.items.filter((item) => item.role === role && item.name === name);
  // 0 个 = 不存在；>1 个 = ambiguous。都不能 PASS。
  if (matches.length !== 1) return undefined;
  return matches[0];
}

export function verifyStructuredAnchor(
  observation: Observation, condition: Extract<WorkflowPrecondition, { kind: "structured_anchor" }>,
): boolean {
  return resolveStructuredSubject(observation, condition.source, condition.role, condition.name) !== undefined;
}

export function verifyStructuredEquals(
  observation: Observation,
  condition: Extract<WorkflowStepCondition, { kind: "structured_equals" }>,
): boolean {
  const target = condition.target;
  if (target.kind !== "role" || !target.name) return false;
  const subject = resolveStructuredSubject(observation, condition.source, target.role, target.name);
  if (!subject) return false;
  const field = condition.field;
  if (field === "checked") return subject.checked === condition.expected;
  const actual = field === "text" ? subject.text : subject.value;
  return actual === condition.expected;
}
