import type { Observation } from "../actions/schema.js";
import type { Workflow, WorkflowMatch } from "./schema.js";
import { applyWorkflowInputs, coerceMatchedInputs } from "./parameterization.js";
import { verifyStructuredAnchor } from "./structured-evidence.js";

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function withoutGuestRoutePrefix(value: string): string {
  return value.replace(/^\s*VM:\s*/i, "");
}

export function matchWorkflow(workflow: Workflow, goal: string, allowCandidate = false,
  ignoreGuestRoutePrefix = false): WorkflowMatch | undefined {
  if (workflow.status !== "verified" && !(allowCandidate && workflow.status === "candidate")) return undefined;
  const taskPattern = ignoreGuestRoutePrefix
    ? withoutGuestRoutePrefix(workflow.taskPattern) : workflow.taskPattern;
  const requestedGoal = ignoreGuestRoutePrefix ? withoutGuestRoutePrefix(goal) : goal;
  const names: string[] = [];
  let pattern = "";
  let cursor = 0;
  for (const match of taskPattern.matchAll(/\{\{([a-z][a-z0-9]*)\}\}/gi)) {
    pattern += escapeRegex(taskPattern.slice(cursor, match.index));
    pattern += "(.+?)";
    names.push(match[1]);
    cursor = match.index + match[0].length;
  }
  pattern += escapeRegex(taskPattern.slice(cursor));
  const matched = new RegExp(`^\\s*${pattern}\\s*$`, "i").exec(requestedGoal);
  if (!matched) return undefined;
  const values: Record<string, string> = {};
  names.forEach((name, index) => { values[name] = matched[index + 1].trim(); });
  if (Object.values(values).some((value) => !value || value.length > 300)) return undefined;
  return { workflow, values, score: names.length ? 0.95 : 1 };
}

export function selectWorkflow(workflows: readonly Workflow[], goal: string,
  allowCandidate = false, ignoreGuestRoutePrefix = false): WorkflowMatch | undefined {
  return workflows.map((workflow) => matchWorkflow(workflow, goal, allowCandidate,
    ignoreGuestRoutePrefix))
    .filter((item): item is WorkflowMatch => !!item)
    .sort((a, b) => Number(b.workflow.status === "verified") - Number(a.workflow.status === "verified") ||
      b.score - a.score || b.workflow.version - a.workflow.version)[0];
}

export function instantiateWorkflow(match: WorkflowMatch): Workflow {
  if (match.workflow.workflowSchemaVersion === 2) {
    return applyWorkflowInputs(match.workflow, coerceMatchedInputs(match.workflow, match.values));
  }
  const substitute = (value: string): string => value.replace(/\{\{([a-z][a-z0-9]*)\}\}/gi, (_, name: string) => {
    const replacement = match.values[name];
    if (replacement === undefined) throw new Error(`流程输入 ${name} 未提供`);
    return String(replacement);
  });
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return substitute(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  const copy = structuredClone(match.workflow);
  copy.steps = copy.steps.map((step) => ({ ...step, goal: substitute(step.goal),
    action: walk(step.action) as typeof step.action,
    ...(step.semanticTarget ? { semanticTarget: walk(step.semanticTarget) as typeof step.semanticTarget } : {}),
    successCondition: walk(step.successCondition) as typeof step.successCondition }));
  copy.successConditions = walk(copy.successConditions) as typeof copy.successConditions;
  copy.preconditions = walk(copy.preconditions) as typeof copy.preconditions;
  if (copy.stageCondition) copy.stageCondition = substitute(copy.stageCondition);
  return copy;
}

export function preconditionsMet(workflow: Workflow, observation: Observation): boolean {
  return workflow.preconditions.every((condition) => {
    if (condition.kind === "window_title") return observation.windowTitle === condition.value;
    if (condition.kind === "window_class") return observation.dom?.includes(`"className": "${condition.value}"`) ?? false;
    if (condition.kind === "url_host") {
      try { return new URL(observation.url ?? "").hostname === condition.value; }
      catch { return false; }
    }
    if (condition.kind === "structured_anchor") return verifyStructuredAnchor(observation, condition);
    return false;
  });
}
