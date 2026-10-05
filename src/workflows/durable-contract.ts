import type { CompletionCriteria } from "../verifier/verifier.js";
import type { Workflow } from "./schema.js";
import type { DurableResultContract } from "./schema.js";

/**
 * B3-5 持久化结果契约。
 *
 * 职责边界：
 * - 提取：只从冻结 CompletionCriteria 的 persistedAfter:'rebind' 项与步骤 desktop_file 后置条件提取，
 *   绝不从自然语言 goal 猜。
 * - 声明：Workflow.durableContract 只是「完成后必须证明什么」的声明。
 * - 证明：durable_state 仍由核心 rebind 状态机（structured-rebind.ts 的 R0→edit→commit→absence→
 *   rebound→terminal 链）证明；desktop_file 仍由核心 file gate 证明。Workflow 没有也不可能有
 *   「durable 单步条件」——步骤条件种类中不存在 durable_* 分支。
 */

/** 从冻结完成条件提取 durable_state 契约（仅 rebind 项）。 */
export function extractDurableContract(criteria: CompletionCriteria | undefined): DurableResultContract[] {
  if (!criteria?.structuredStates) return [];
  const rebind = criteria.structuredStates.filter((item) => item.persistedAfter === 'rebind');
  if (!rebind.length) return [];
  return [{ kind: 'durable_state', structuredStates: rebind }];
}

/** 从步骤后置条件提取 desktop_file 契约（按 path 不区分大小写去重，保留首个声明）。 */
export function extractDesktopFileContract(steps: Workflow['steps']): DurableResultContract[] {
  const files: Array<{ kind: 'desktop_file'; path: string; contentEquals?: string; sha256?: string }> = [];
  for (const step of steps) {
    const action = step.action;
    if ('postcondition' in action && action.postcondition?.kind === 'desktop_file') {
      files.push({ kind: 'desktop_file', path: action.postcondition.path,
        ...(action.postcondition.contentEquals !== undefined
          ? { contentEquals: action.postcondition.contentEquals } : {}),
        ...(action.postcondition.sha256 !== undefined
          ? { sha256: action.postcondition.sha256 } : {}) });
    }
  }
  const unique = new Map<string, typeof files[number]>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (!unique.has(key)) unique.set(key, file);
  }
  return [...unique.values()];
}

export interface DurableContractViolation {
  reason: string;
}

/**
 * 校验契约与冻结完成条件对齐（fail-closed）：
 * - 每个 durable_state 契约必须逐项对得上 successConditions 里 persistedAfter:'rebind' 的结构化项
 *   （禁止声明 criteria 没有的 rebind 目标——即禁止从 goal 猜契约）。
 * - 每个 desktop_file 契约必须来自步骤后置条件（禁止凭空声明文件期望）。
 * - 契约里出现的 rebind 目标与字段/期望必须与 criteria 完全一致。
 */
export function validateDurableContract(workflow: Workflow): DurableContractViolation | undefined {
  if (!workflow.durableContract?.length) return undefined;
  const criteriaRebind = (workflow.successConditions.structuredStates ?? [])
    .filter((item) => item.persistedAfter === 'rebind');
  const declaredFiles = workflow.steps.flatMap((step) => {
    const action = step.action;
    return 'postcondition' in action && action.postcondition?.kind === 'desktop_file'
      ? [action.postcondition] : [];
  }).map((file) => file.path.toLowerCase());
  for (const contract of workflow.durableContract) {
    if (contract.kind === 'durable_state') {
      for (const item of contract.structuredStates) {
        if (item.persistedAfter !== 'rebind')
          return { reason: `durable_state 契约包含非 rebind 项（${JSON.stringify(item.target)}）` };
        const frozen = criteriaRebind.find((candidate) =>
          candidate.target.role === item.target.role && candidate.target.name === item.target.name &&
          candidate.field === item.field && candidate.equals === item.equals);
        if (!frozen)
          return { reason: `durable_state 契约的 ${JSON.stringify(item.target)}/${item.field} 不在冻结完成条件中（禁止从 goal 猜契约）` };
      }
    } else if (contract.kind === 'desktop_file') {
      if (!declaredFiles.includes(contract.path.toLowerCase()))
        return { reason: `desktop_file 契约路径 ${contract.path} 不在任何步骤后置条件中` };
    }
  }
  return undefined;
}
