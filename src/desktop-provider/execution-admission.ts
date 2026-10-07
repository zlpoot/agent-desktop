import type { DesktopProvider, DesktopSession, DesktopSessionIdentity } from '../contracts/desktop-environment.js';
import type { DesktopInputControl } from '../contracts/desktop-input-control.js';
import type { DesktopExecutionBackend, DesktopExecutionRequest, TargetBinding } from '../contracts/desktop-execution.js';
import { assertDesktopCapabilities, deny, sameSession } from './admission.js';

const identityKeys = ['providerId', 'environmentId', 'sessionId', 'instanceId', 'inputResourceId'] as const;
const targetKeys = ['targetId', 'application', 'applicationVersion', 'targetRole'] as const;
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
function targetBinding(value: TargetBinding): TargetBinding {
  if (!value || [...identityKeys.filter(key => key !== 'inputResourceId'), ...targetKeys]
    .some(key => !identifier(value[key])) || value.inputResourceId !== null && !identifier(value.inputResourceId)) {
    deny('invalid-target-binding');
  }
  // Copy only public fields; runtime-specific properties must not escape the port.
  return Object.freeze({ providerId: value.providerId, environmentId: value.environmentId,
    sessionId: value.sessionId, instanceId: value.instanceId, inputResourceId: value.inputResourceId,
    targetId: value.targetId, application: value.application, applicationVersion: value.applicationVersion,
    targetRole: value.targetRole });
}
function sameTarget(a: TargetBinding, b: TargetBinding): boolean {
  return sameSession(a, b) && targetKeys.every(key => a[key] === b[key]);
}
function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

/** Reusable P6 Host admission. No Provider-id/kind switch, policy promotion, cached grant,
 * automatic rebind or fallback. Backend dispatch remains a second independent fence. */
export class DesktopExecutionAdmission<Action, Result> {
  private readonly identity: DesktopSessionIdentity;
  private readonly providerId: string;
  private readonly kind: DesktopProvider['kind'];
  private readonly targets = new Map<string, TargetBinding>();
  private busy = false;
  private closed = false;
  constructor(private readonly provider: DesktopProvider, private readonly session: DesktopSession,
    private readonly input: Pick<DesktopInputControl, 'assertAuthority'>,
    private readonly backend: DesktopExecutionBackend<Action, Result>) {
    this.identity = Object.freeze({ providerId: session.providerId, environmentId: session.environmentId,
      sessionId: session.sessionId, instanceId: session.instanceId, inputResourceId: session.inputResourceId });
    this.providerId = provider.id; this.kind = provider.kind;
    this.assertIdentity();
  }
  private assertIdentity(): void {
    if (this.closed) deny('execution-admission-closed');
    if (this.provider.id !== this.providerId || this.provider.kind !== this.kind ||
        this.identity.providerId !== this.providerId || !sameSession(this.session, this.identity)) {
      deny('execution-binding-identity-changed');
    }
  }
  async bind(selector: string): Promise<TargetBinding> {
    this.assertIdentity();
    if (!identifier(selector)) deny('invalid-target-selector');
    if ((await this.session.status()).state !== 'open') deny('stale-session');
    this.assertIdentity();
    const binding = targetBinding(await this.backend.bind(selector));
    this.assertIdentity();
    if (!sameSession(binding, this.identity)) deny('foreign-target-session');
    const status = structuredClone(await this.backend.targetStatus(binding));
    this.assertIdentity();
    if (status.state !== 'bound' || !sameTarget(binding, targetBinding(status.binding))) deny('stale-target-binding');
    if ((await this.session.status()).state !== 'open') deny('stale-session');
    this.assertIdentity();
    const previous = this.targets.get(binding.targetId);
    if (previous && !sameTarget(previous, binding)) deny('target-binding-identity-changed');
    this.targets.set(binding.targetId, binding);
    return binding;
  }
  private assertBoundTarget(value: TargetBinding): TargetBinding {
    this.assertIdentity();
    const target = targetBinding(value);
    const retained = this.targets.get(target.targetId);
    if (!retained || !sameTarget(retained, target)) deny('unknown-or-changed-target-binding');
    return target;
  }
  /** Non-authorizing proof of current support before input.acquire/beginTask.
   * No authority, input acquisition/renewal, observation or authorization token.
   * A successful preflight never replaces the fresh checks in execute(). */
  async preflight(binding: TargetBinding, action: Action): Promise<void> {
    const target = this.assertBoundTarget(binding);
    await this.assertCapabilities(target, structuredClone(action));
    this.assertIdentity();
  }
  private async assertCapabilities(target: TargetBinding, action: Action): Promise<void> {
    // Each port returns fresh evidence/readiness. Snapshot immediately on resolution.
    const results = await Promise.allSettled([
      this.provider.capabilities().then(value => structuredClone(value)),
      this.session.capabilities().then(value => structuredClone(value)),
      this.session.status().then(value => structuredClone(value)),
      this.backend.targetStatus(target).then(value => structuredClone(value)),
      this.backend.requirements(target, action).then(value => structuredClone(value)),
    ] as const);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'execution-admission-read-failed');
    const provider = fulfilled(results[0]), session = fulfilled(results[1]), status = fulfilled(results[2]);
    const targetStatus = fulfilled(results[3]), operation = fulfilled(results[4]);
    this.assertIdentity();
    if (status.state !== 'open') deny('stale-session');
    if (targetStatus.state !== 'bound' || !sameTarget(target, targetBinding(targetStatus.binding))) {
      deny('stale-target-binding');
    }
    if (!operation || !identifier(operation.action) || !identifier(operation.mechanism)) deny('invalid-executor-requirements');
    assertDesktopCapabilities(operation.required, { providerId: this.providerId, environmentKind: this.kind,
      application: target.application, applicationVersion: target.applicationVersion, targetRole: target.targetRole,
      action: operation.action, mechanism: operation.mechanism },
    { provider, session, target: targetStatus.capabilities }, { session: status.readiness, target: targetStatus.readiness });
  }
  async execute(request: DesktopExecutionRequest<Action>): Promise<Result> {
    this.assertIdentity();
    if (this.busy) deny('execution-admission-busy');
    // Pin caller-owned payloads before the first await; labels cannot replace trusted metadata.
    const pinned = structuredClone(request);
    const target = this.assertBoundTarget(pinned.target);
    if (!pinned.observation || !identifier(pinned.observation.observationId) ||
        !sameSession(target, pinned.observation) || target.targetId !== pinned.observation.targetId) {
      deny('observation-target-mismatch');
    }
    if (!pinned.authority || pinned.authority.owner?.kind !== 'agent') deny('agent-input-authority-required');
    this.input.assertAuthority(this.identity, pinned.authority);
    this.busy = true;
    try {
      await this.assertCapabilities(target, pinned.action);
      this.assertIdentity();
      this.input.assertAuthority(this.identity, pinned.authority);
      // Dispatch is immediately handed to the backend, which must recheck at the actual effect.
      return await this.backend.execute({ target, observation: pinned.observation,
        action: pinned.action, authority: pinned.authority });
    } finally { this.busy = false; }
  }
  /** Invalidates this Host gate only. Session/input/runtime cleanup belongs to their lifecycle owner. */
  invalidate(): void { this.closed = true; this.targets.clear(); }
}
