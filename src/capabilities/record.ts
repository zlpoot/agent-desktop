import type { TaskRequest } from "../contracts/task.js";
import type { TraceStore } from "../contracts/stores.js";
import { requireCapability, resolveCapability, type CapabilityFacts } from "./registry.js";

export function recordCapabilityChecks(trace: TraceStore, taskId: string, step: number,
  phase: string, request: TaskRequest, facts: CapabilityFacts, requireReady = true): void {
  for (const operation of request.operations) {
    const resolution = resolveCapability(operation, request.environment, facts);
    trace.recordCapabilityResolution(taskId, step, phase, resolution, facts);
    if (requireReady) requireCapability(resolution);
  }
}
