import { randomUUID } from "node:crypto";
import type {
  CapabilityContext, DesktopCapabilities, DesktopCapability, DesktopEnvironmentKind,
  DesktopObservationBinding, DesktopProvider, DesktopReadiness, DesktopSession,
  DesktopSessionIdentity, DesktopSessionStatus, DesktopTargetBinding,
} from "../contracts/desktop-environment.js";
import type { DesktopInputArbiter, InputAuthority } from "../contracts/desktop-input-control.js";
import type { DesktopExecutionBackend, TargetBinding } from '../contracts/desktop-execution.js';
import { DesktopExecutionAdmission } from './execution-admission.js';
import { assertDesktopCapabilities, deny, sameSession } from "./admission.js";

export interface FakeTargetDefinition {
  readonly application: string;
  readonly applicationVersion: string;
  readonly targetRole: string;
  readonly capabilities: DesktopCapabilities;
  readonly readiness: DesktopReadiness;
}
export interface FakeOperation {
  readonly mechanism: string;
  /** Backend-owned executor requirements; a caller cannot remove capability gates. */
  readonly required: readonly DesktopCapability[];
}
export interface FakeBackendDefinition {
  readonly inputResourceId: string | null;
  readonly capabilities: DesktopCapabilities;
  readonly readiness: DesktopReadiness;
  readonly targets: Readonly<Record<string, FakeTargetDefinition>>;
  readonly operations: Readonly<Record<string, FakeOperation>>;
}
export interface FakeActionRequest {
  readonly observation: DesktopObservationBinding;
  readonly operationId: string;
  readonly authority: InputAuthority;
}
export interface FakeActionResult { readonly operationId: string; readonly targetId: string; }
export interface FakePendingAction {
  readonly actionId: string;
  readonly result: Promise<FakeActionResult>;
}
interface SessionRecord {
  identity: DesktopSessionIdentity;
  kind: DesktopEnvironmentKind;
  providerCapabilities: DesktopCapabilities;
  state: DesktopSessionStatus["state"];
}
interface TargetRecord {
  binding: DesktopTargetBinding;
  definitionKey: string;
  definition: FakeTargetDefinition;
  observation?: DesktopObservationBinding;
}
interface Pending {
  actionId: string;
  request: FakeActionRequest;
  resolve: (value: FakeActionResult) => void;
  reject: (error: Error) => void;
}

/** In-memory backend, including its own runtime nonce and independent dispatch gates.
 * Simulates no OS input, app launch, Guest transport, model or persistent state. */
export class FakeDesktopBackend {
  private instance = randomUUID();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly targets = new Map<string, TargetRecord>();
  private readonly pending = new Map<string, Pending>();
  private readonly definition: FakeBackendDefinition;
  private readonly accepted: FakeActionResult[] = [];
  constructor(definition: FakeBackendDefinition, readonly inputControl: DesktopInputArbiter) {
    this.definition = structuredClone(definition);
    inputControl.registerBackend(binding => this.isCurrent(binding), async authority => {
      this.cancel(request => request.authority.grantId === authority.grantId, "input-revoked");
    });
  }
  private isCurrent(binding: DesktopSessionIdentity): boolean {
    const record = this.sessions.get(binding.sessionId);
    return !!record && record.state === "open" && binding.instanceId === this.instance &&
      sameSession(binding, record.identity);
  }
  private current(binding: DesktopSessionIdentity): SessionRecord {
    if (!this.isCurrent(binding)) deny("stale-session");
    return this.sessions.get(binding.sessionId)!;
  }
  /** Backend handshake owns the runtime nonce; every returned Session is immutable. */
  open(providerId: string, environmentId: string, kind: DesktopEnvironmentKind,
    capabilities: DesktopCapabilities): DesktopSession {
    const identity = Object.freeze({ providerId, environmentId, sessionId: randomUUID(),
      instanceId: this.instance, inputResourceId: this.definition.inputResourceId });
    this.sessions.set(identity.sessionId, { identity, kind,
      providerCapabilities: structuredClone(capabilities), state: "open" });
    return Object.freeze({ ...identity,
      capabilities: async () => { this.current(identity); return structuredClone(this.definition.capabilities); },
      status: async () => ({ state: this.sessions.get(identity.sessionId)!.state,
        readiness: structuredClone(this.definition.readiness) }),
      close: () => this.close(identity),
    });
  }
  private cancel(matches: (request: FakeActionRequest) => boolean, reason: string): void {
    for (const [id, item] of this.pending) {
      if (matches(item.request)) {
        this.pending.delete(id); item.reject(new Error(reason));
      }
    }
  }
  private async close(binding: DesktopSessionIdentity): Promise<void> {
    const record = this.sessions.get(binding.sessionId)!;
    // Always await resource drain, including repeat closes after a failed drain.
    record.state = "closed";
    this.cancel(request => sameSession(request.observation, binding), "session-closed");
    for (const [id, target] of this.targets) if (sameSession(target.binding, binding)) this.targets.delete(id);
    await this.inputControl.revokeSession(binding);
  }
  async replaceInstance(): Promise<void> {
    // Invalidate all handles and queued actions synchronously before awaiting revocation ACK.
    this.instance = randomUUID();
    const old = [...this.sessions.values()].filter(record => record.state === "open");
    for (const record of old) record.state = "stale";
    this.targets.clear(); this.cancel(() => true, "instance-replaced");
    await Promise.all(old.map(record => this.inputControl.revokeSession(record.identity)));
  }
  setReadiness(readiness: DesktopReadiness): void {
    Object.assign(this.definition, { readiness: structuredClone(readiness) });
  }
  setTargetReadiness(key: string, readiness: DesktopReadiness): void {
    const definition = this.definition.targets[key];
    if (!definition) deny("unknown-target");
    Object.assign(definition, { readiness: structuredClone(readiness) });
    for (const target of this.targets.values()) {
      if (target.definitionKey === key) Object.assign(target.definition, { readiness: structuredClone(readiness) });
    }
  }
  bind(binding: DesktopSessionIdentity, key: string): DesktopTargetBinding {
    this.current(binding);
    const definition = this.definition.targets[key];
    if (!definition) deny("unknown-target");
    const target = Object.freeze({ ...this.sessions.get(binding.sessionId)!.identity, targetId: randomUUID() });
    this.targets.set(target.targetId, { binding: target, definitionKey: key, definition: structuredClone(definition) });
    return target;
  }
  private target(binding: DesktopTargetBinding): TargetRecord {
    this.current(binding);
    const target = this.targets.get(binding.targetId);
    if (!target || !sameSession(binding, target.binding)) deny("invalid-target");
    return target;
  }
  /** P6 trusted runtime port. Existing P1 synchronous fixtures remain available. */
  executionBackend(session: DesktopSession): DesktopExecutionBackend<string, FakeActionResult> {
    const describe = (binding: DesktopTargetBinding): TargetBinding => {
      if (!sameSession(session, binding)) deny('foreign-session');
      const target = this.target(binding);
      return Object.freeze({ ...target.binding, application: target.definition.application,
        applicationVersion: target.definition.applicationVersion, targetRole: target.definition.targetRole });
    };
    return {
      bind: async selector => describe(this.bind(session, selector)),
      targetStatus: async binding => {
        const target = this.target(binding);
        return { binding: describe(binding), state: 'bound',
          capabilities: structuredClone(target.definition.capabilities), readiness: structuredClone(target.definition.readiness) };
      },
      requirements: async (binding, action) => {
        describe(binding);
        const operation = this.definition.operations[action];
        if (!operation) deny('unknown-operation');
        return { action, ...structuredClone(operation) };
      },
      execute: async request => {
        const current = describe(request.target);
        if (['application', 'applicationVersion', 'targetRole'].some(key =>
          current[key as keyof TargetBinding] !== request.target[key as keyof TargetBinding])) deny('stale-target-binding');
        if (!sameSession(current, request.observation) || current.targetId !== request.observation.targetId) deny('observation-target-mismatch');
        if (request.authority.owner.kind !== 'agent') deny('agent-input-authority-required');
        const result = this.execute({ observation: request.observation, operationId: request.action, authority: request.authority });
        // P6 execution consumes the backend observation, even if a caller bypasses Host admission.
        this.target(current).observation = undefined;
        return result;
      },
    };
  }
  observe(binding: DesktopTargetBinding): DesktopObservationBinding {
    const target = this.target(binding);
    const observation = Object.freeze({ ...target.binding, observationId: randomUUID() });
    // Only a fresh observation of this exact target can authorize fixture execution.
    target.observation = observation;
    return observation;
  }
  assertAction(request: FakeActionRequest): void {
    const target = this.target(request.observation);
    if (!target.observation || target.observation.observationId !== request.observation.observationId) {
      deny("reobserve-required");
    }
    const record = this.current(request.observation);
    const operation = this.definition.operations[request.operationId];
    if (!operation) deny("unknown-operation");
    const context: CapabilityContext = { providerId: record.identity.providerId, environmentKind: record.kind,
      application: target.definition.application, applicationVersion: target.definition.applicationVersion,
      targetRole: target.definition.targetRole, action: request.operationId, mechanism: operation.mechanism };
    assertDesktopCapabilities(operation.required, context,
      { provider: record.providerCapabilities, session: this.definition.capabilities, target: target.definition.capabilities },
      { session: this.definition.readiness, target: target.definition.readiness });
    this.inputControl.assertAuthority(record.identity, request.authority);
  }
  /** Independent backend fence even when the caller bypasses FakeDesktopRuntime. */
  execute(request: FakeActionRequest): FakeActionResult {
    this.assertAction(request);
    // No async gap between authoritative checks and the synthetic effect.
    const result = Object.freeze({ operationId: request.operationId, targetId: request.observation.targetId });
    this.accepted.push(result);
    return result;
  }
  queue(request: FakeActionRequest): FakePendingAction {
    this.assertAction(request);
    const actionId = randomUUID();
    const result = new Promise<FakeActionResult>((resolve, reject) => {
      this.pending.set(actionId, { actionId, request: structuredClone(request), resolve, reject });
    });
    // Cancellation can precede a caller attaching its handler; preserve the original rejection.
    void result.catch(() => {});
    return { actionId, result };
  }
  dispatch(actionId: string): void {
    const pending = this.pending.get(actionId);
    if (!pending) deny("unknown-or-cancelled-action");
    this.pending.delete(actionId);
    try { pending.resolve(this.execute(pending.request)); }
    catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
  }
  executed(): readonly FakeActionResult[] { return structuredClone(this.accepted); }
}

/** Provider only discovers/opens environments. Runtime and InputControl remain separate. */
export class FakeDesktopProvider implements DesktopProvider {
  private readonly declarations: DesktopCapabilities;
  private readonly environments: ReadonlyMap<string, FakeDesktopBackend>;
  constructor(readonly id: string, readonly kind: DesktopEnvironmentKind,
    environments: ReadonlyMap<string, FakeDesktopBackend>, capabilities: DesktopCapabilities) {
    this.environments = new Map(environments); this.declarations = structuredClone(capabilities);
  }
  async capabilities(): Promise<DesktopCapabilities> { return structuredClone(this.declarations); }
  async discover() {
    return [...this.environments.keys()].map(environmentId => ({ providerId: this.id, environmentId, kind: this.kind }));
  }
  async open(environmentId: string): Promise<DesktopSession> {
    const backend = this.environments.get(environmentId);
    if (!backend) deny("unknown-environment");
    return backend.open(this.id, environmentId, this.kind, this.declarations);
  }
}

/** Synthetic bind/observe/execute fixture; never attached to the production Agent Loop. */
export class FakeDesktopRuntime {
  constructor(readonly session: DesktopSession, private readonly backend: FakeDesktopBackend) {}
  bind(targetKey: string): DesktopTargetBinding { return this.backend.bind(this.session, targetKey); }
  observe(target: DesktopTargetBinding): DesktopObservationBinding {
    if (!sameSession(this.session, target)) deny("foreign-session");
    return this.backend.observe(target);
  }
  execute(request: FakeActionRequest): FakeActionResult {
    if (!sameSession(this.session, request.observation)) deny("foreign-session");
    this.backend.assertAction(request); // Host admission; backend execute repeats its own fence.
    return this.backend.execute(request);
  }
  /** Synthetic composition of the shared P6 gate; no native runtime or Task support is implied. */
  scopedExecution(provider: DesktopProvider): DesktopExecutionAdmission<string, FakeActionResult> {
    return new DesktopExecutionAdmission(provider, this.session, this.backend.inputControl, this.backend.executionBackend(this.session));
  }
}
