import type {
  CapabilityContext, CapabilityDeclaration, DesktopCapabilities, DesktopCapability,
  DesktopReadiness, DesktopSessionIdentity,
} from "../contracts/desktop-environment.js";

export class DesktopAdmissionError extends Error {
  constructor(readonly reason: string) { super(`Desktop admission denied: ${reason}`); }
}
export function deny(reason: string): never { throw new DesktopAdmissionError(reason); }

export function sameSession(a: DesktopSessionIdentity, b: DesktopSessionIdentity): boolean {
  return a.providerId === b.providerId && a.environmentId === b.environmentId &&
    a.sessionId === b.sessionId && a.instanceId === b.instanceId && a.inputResourceId === b.inputResourceId;
}

const dimensions = new Set<keyof CapabilityContext>([
  "providerId", "environmentKind", "application", "applicationVersion", "targetRole", "action", "mechanism",
]);
function validScope(declaration: CapabilityDeclaration): boolean {
  if (!declaration || typeof declaration !== 'object') return false;
  const scope = declaration.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  const entries = Object.entries(scope);
  return entries.length > 0 && entries.every(([key, values]) =>
    dimensions.has(key as keyof CapabilityContext) && Array.isArray(values) && values.length > 0 &&
    Array.from(values).every(value => typeof value === "string" && value.trim().length > 0));
}
function matches(declaration: CapabilityDeclaration, context: CapabilityContext): boolean {
  return Object.entries(declaration.scope).every(([key, values]) =>
    values!.includes(context[key as keyof CapabilityContext]));
}

/** No layer can widen a missing/unproven/forbidden parent. Readiness is not evidence.
 * This is capability admission only; callers must ALSO check backend identity,
 * target/observation validity and input authority at dispatch, not just at planning. */
export function assertDesktopCapabilities(
  required: readonly DesktopCapability[], context: CapabilityContext,
  layers: { provider: DesktopCapabilities; session: DesktopCapabilities; target: DesktopCapabilities },
  readiness: { session: DesktopReadiness; target: DesktopReadiness },
): void {
  if (!Array.isArray(required) || !required.length) deny("missing-requirements");
  if (!context || [...dimensions].some(key => typeof context[key] !== 'string' || !context[key].trim())) {
    deny('invalid-capability-context');
  }
  const checkedRequired: readonly DesktopCapability[] = required;
  for (const capability of checkedRequired) {
    if (typeof capability !== 'string' || !capability.trim()) deny('invalid-capability-requirement');
    for (const layer of ["provider", "session", "target"] as const) {
      const raw = layers[layer]?.[capability];
      if (!Array.isArray(raw) || !raw.length) deny(`${layer}:${capability}:missing`);
      const declarations: readonly CapabilityDeclaration[] = raw;
      if (Array.from(declarations).some(declaration => !validScope(declaration))) deny(`${layer}:${capability}:invalid-scope`);
      const applicable = declarations.filter(declaration => matches(declaration, context));
      if (!applicable.length) deny(`${layer}:${capability}:scope-mismatch`);
      for (const declaration of applicable) {
        if (declaration.state !== "supported") deny(`${layer}:${capability}:${declaration.state}`);
        if (!Array.isArray(declaration.evidence) || !declaration.evidence.length || Array.from(declaration.evidence).some(item =>
          !item || typeof item.source !== "string" || !item.source.trim() ||
          typeof item.description !== "string" || !item.description.trim())) {
          deny(`${layer}:${capability}:missing-evidence`);
        }
      }
    }
    for (const layer of ["session", "target"] as const) {
      if (readiness[layer]?.[capability]?.state !== "ready") deny(`${layer}:${capability}:not-ready`);
    }
  }
}
