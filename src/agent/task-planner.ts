import type { WindowInfo } from "../runtime/desktop/desktop-runtime.js";
import type { RegisteredApp } from "../runtime/desktop/app-catalog.js";
import type { CompletionCriteria } from "../verifier/verifier.js";

export interface PlannedTask {
  environment: "browser" | "windows";
  windowHandle?: number;
  appId?: string;
  plan: string[];
  completionCriteria: CompletionCriteria;
  verificationContract: PlannedVerificationContract;
}

const criterionNames = ["urlIncludes", "pageTextIncludes", "domIncludes", "accessibilityIncludes", "windowTitleIncludes", "structuredStates"] as const;
type PlannedEvidenceSource = "browser" | "dom" | "uia" | "window" | "visual_model" | "api";
export interface PlannedVerificationContract {
  goal: string;
  successConditions: CompletionCriteria;
  evidenceSources: Record<string, PlannedEvidenceSource>;
  verifierStrategy: "rules_then_jev";
}
const sources: Record<string, readonly PlannedEvidenceSource[]> = {
  urlIncludes: ["browser"], pageTextIncludes: ["dom", "uia", "visual_model"],
  domIncludes: ["dom"], accessibilityIncludes: ["uia"], windowTitleIncludes: ["window"],
  structuredStates: ["dom", "uia"],
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function parseVerificationContract(value: unknown, goal: string, override?: CompletionCriteria): PlannedVerificationContract {
  const contract = record(value, "任务验证契约");
  if (typeof contract.goal !== "string" || !contract.goal.trim() ||
      goal.trim() && contract.goal.trim() !== goal.trim()) throw new Error("任务验证契约的 Goal 必须等于原始目标");
  if (contract.verifierStrategy !== "rules_then_jev") throw new Error("不支持的 Verifier Strategy");
  const conditions = record(contract.successConditions, "Success Conditions");
  if (!Object.keys(conditions).length || Object.keys(conditions).some(key => !criterionNames.includes(key as typeof criterionNames[number]))) {
    throw new Error("Success Conditions 包含空值或不支持的字段");
  }
  const evidence = record(contract.evidenceSources, "Evidence Sources");
  if (Object.keys(evidence).length !== Object.keys(conditions).length ||
      Object.keys(evidence).some(key => !(key in conditions) ||
        !sources[key]?.includes(evidence[key] as PlannedEvidenceSource))) {
    throw new Error("Evidence Sources 必须与成功条件逐项对应且来源有效");
  }
  const successConditions: CompletionCriteria = {};
  for (const key of criterionNames) {
    const entry = conditions[key];
    if (entry === undefined) continue;
    if (key === 'structuredStates') {
      if (!Array.isArray(entry) || !entry.length || entry.length > 5) throw new Error('结构化完成条件数量无效');
      const source=evidence.structuredStates;
      successConditions.structuredStates=entry.map((raw:unknown) => {
        const item=record(raw,'结构化完成条件');
        const target=record(item.target,'目标控件');
        if (typeof target.role!=='string'||!target.role.trim()||target.role.length>50||
          !['name','text'].some(field=>typeof target[field]==='string'&&String(target[field]).trim())||
          Object.keys(target).some(field=>!['role','name','text'].includes(field))||
          ['name','text'].some(field=>target[field]!==undefined&&
            (typeof target[field]!=='string'||String(target[field]).length>300))||
          !['text','value','checked','classToken'].includes(item.field as string)||
          (item.field==='checked'?typeof item.equals!=='boolean':
            typeof item.equals!=='string'||!(item.equals as string).trim()||(item.equals as string).length>300)||
          (source==='uia'&&!['text','value'].includes(item.field as string))||
          (item.persistedAfter!==undefined&&
            (item.persistedAfter!=='rebind'||item.field!=='value'))||
          Object.keys(item).some(field=>!['target','field','equals','persistedAfter'].includes(field)))
          throw new Error('结构化完成条件必须绑定唯一目标、字段和预期值');
        return {target:target as {role:string;name?:string;text?:string},
          field:item.field as 'text'|'value'|'checked'|'classToken',equals:item.equals as string|boolean,
          ...(item.persistedAfter==='rebind'?{persistedAfter:'rebind' as const}:{})};
      });
      continue;
    }
    if (typeof entry !== "string" || entry.trim().length < 2 || entry.length > 200) {
      throw new Error(`完成条件 ${key} 无效`);
    }
    successConditions[key] = entry.trim();
  }
  if (override) {
    const fixed = structuredClone(override);
    const fixedSources: Record<string, PlannedEvidenceSource> = {};
    for (const key of Object.keys(fixed)) fixedSources[key] =
      key.startsWith('pageText') ? 'uia' : (sources[key]?.[0] ?? "api");
    return { goal: goal.trim() || contract.goal.trim(), successConditions: fixed,
      evidenceSources: fixedSources, verifierStrategy: "rules_then_jev" };
  }
  return { goal: goal.trim() || contract.goal.trim(), successConditions,
    evidenceSources: evidence as Record<string, PlannedEvidenceSource>, verifierStrategy: "rules_then_jev" };
}

export function parseTaskPlan(content: string, windows: readonly WindowInfo[], goal = "",
  apps: readonly RegisteredApp[] = [], criteriaOverride?: CompletionCriteria): PlannedTask {
  let value: unknown;
  try { value = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { throw new Error("任务规划器没有返回有效 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("任务规划结果无效");
  const item = value as Record<string, unknown>;
  if (item.environment !== "browser" && item.environment !== "windows") {
    throw new Error("任务规划器未确定浏览器或 Windows 环境");
  }
  if (!Array.isArray(item.plan) || !item.plan.length || item.plan.length > 8 ||
      item.plan.some((step) => typeof step !== "string" || !step.trim() || step.length > 120)) {
    throw new Error("任务规划器给出的步骤概要无效");
  }
  const contract = parseVerificationContract(item.verificationContract, goal, criteriaOverride);
  const criteria = contract.successConditions;
  if(criteria.structuredStates?.length&&contract.evidenceSources.structuredStates!==
    (item.environment==='browser'?'dom':'uia'))
    throw new Error('结构化完成条件的证据来源与执行环境不符');
  if (!Object.keys(criteria).length) throw new Error("规划器未提供可由工程检查的完成条件");
  if (item.environment === "windows") {
    const selectedWindow = Number.isInteger(item.windowHandle) &&
      windows.some((window) => window.handle === item.windowHandle && window.visible && !window.minimized);
    const selectedApp = typeof item.appId === "string" && apps.some((app) => app.id === item.appId);
    if (selectedWindow === selectedApp || (item.windowHandle !== undefined && !selectedWindow) ||
        (item.appId !== undefined && !selectedApp)) {
      throw new Error("规划器必须选择当前可见的 Windows 窗口或已登记应用，且只能选一个");
    }
    if (!criteria.pageTextIncludes && !criteria.accessibilityIncludes && !criteria.windowTitleIncludes &&
        !criteria.structuredStates?.length) {
      throw new Error("Windows 任务需要可观察的文本完成条件");
    }
    return { environment: "windows", ...(selectedWindow ? { windowHandle: item.windowHandle as number }
      : { appId: item.appId as string }),
      plan: item.plan as string[], completionCriteria: criteria, verificationContract: contract };
  }
  return { environment: "browser", plan: item.plan as string[], completionCriteria: criteria,
    verificationContract: contract };
}
