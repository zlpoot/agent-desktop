import { createHash, randomUUID } from 'node:crypto';
import type { ReadonlyAppDiscovery } from '../contracts/app-discovery.js';
import type { AppConfirmationDisplay, AppLaunchOutcome } from '../contracts/app-launch.js';
import type { EnvironmentAppBinding, EnvironmentAppRegistry } from '../contracts/environment-apps.js';
import { assertLegacyAppAdmission } from './admission-gate.js';
import { AppLaunchError, ControlledAppLauncher } from './launcher.js';
import { candidateValue, sameAppScope, textValue } from './validation.js';

type Pending = { display: AppConfirmationDisplay; app: EnvironmentAppBinding; candidateDigest: string;
  expiresAt: number; cancelled: boolean; operatorId?: string; operation?: Promise<AppLaunchOutcome> };
function request(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error('invalid-app-management-request');
}
/** Trusted operator API only. Task waiting/UI and all business action authorization remain in P7-D/P6. */
export class AppOnboardingService {
  private readonly pending = new Map<string, Pending>();
  private readonly uses = new Map<string, { id: string; revision: number; operatorId: string; operation: Promise<AppLaunchOutcome>;
    cancel: AbortController }>();
  private readonly running = new Map<string, AbortController>();
  private closed = false;
  constructor(readonly registry: EnvironmentAppRegistry, private readonly discovery: ReadonlyAppDiscovery,
    private readonly launcher: ControlledAppLauncher, private readonly clock = () => Date.now(),
    private readonly timeoutMs = 15000) {
    if (!sameAppScope(registry.scope, discovery.scope) || !sameAppScope(registry.scope, launcher.scope)) throw new Error('app-port-environment-mismatch');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new Error('invalid-app-launch-timeout');
  }
  private current(): void { if (this.closed) throw new Error('app-onboarding-closed'); this.registry.list(); }
  async prepare(value: { candidateId: string; candidateRevision: number }): Promise<AppConfirmationDisplay> {
    this.current(); request(value, ['candidateId', 'candidateRevision']); textValue(value.candidateId);
    for (const [id, pending] of this.pending) if (!pending.operation && this.clock() > pending.expiresAt) this.pending.delete(id);
    if (this.pending.size >= 128) throw new Error('app-confirmation-limit');
    const snapshot = this.discovery.candidate(value.candidateId, value.candidateRevision);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const checked = await this.launcher.inspect(snapshot.candidate.launchSpec, controller.signal);
      this.current(); if (controller.signal.aborted) throw new Error('app-inspection-timeout');
      if (checked.identity.fingerprint !== snapshot.contentFingerprint || snapshot.version && checked.identity.version !== snapshot.version) {
        throw new AppLaunchError('stale', 'app-candidate-installation-changed;rescan-required');
      }
      if (this.discovery.candidate(value.candidateId, value.candidateRevision).digest !== snapshot.digest) throw new Error('app-candidate-changed');
      const candidate = candidateValue({ ...snapshot.candidate, identity: checked.identity }, this.registry.scope);
      const previous = this.registry.list().find(app => app.installationId === candidate.installationId);
      const app = this.registry.discover(candidate, previous?.revision);
      const content = { candidateId: snapshot.candidateId, candidateRevision: snapshot.revision,
        appBindingId: app.appBindingId, profileRevision: app.profileRevision, scope: app.scope,
        displayName: app.displayName, sources: [...snapshot.sources], launchSpec: app.launchSpec,
        version: checked.identity.version, publisher: snapshot.publisher ?? 'unknown', effect: 'confirm-and-verify-launch' as const };
      const confirmationId = randomUUID();
      const display = { ...content, confirmationId, digest: createHash('sha256').update(JSON.stringify([
        content, snapshot.digest, app.revision, app.profileDigest])).digest('hex') };
      this.pending.set(confirmationId, { display: structuredClone(display), app, candidateDigest: snapshot.digest,
        expiresAt: this.clock() + 300000, cancelled: false });
      return structuredClone(display);
    } finally { clearTimeout(timer); }
  }
  /** operatorId comes from the trusted calling session, never from the request body. */
  confirm(value: { confirmationId: string; digest: string }, operatorId: string): Promise<AppLaunchOutcome> {
    this.current(); request(value, ['confirmationId', 'digest']); textValue(operatorId);
    const pending = this.pending.get(value.confirmationId);
    if (!pending || pending.cancelled || pending.display.digest !== value.digest || this.clock() > pending.expiresAt) {
      throw new Error('app-confirmation-expired-or-mismatch');
    }
    if (pending.operation) {
      if (pending.operatorId !== operatorId) throw new Error('app-confirmation-operator-mismatch');
      // Idempotency never restores revoked/changed trust or launches again.
      assertLegacyAppAdmission(this.registry, pending.app.appBindingId);
      const current = this.registry.get(pending.app.appBindingId);
      if (!current || current.validity !== 'current' || current.profileDigest !== pending.app.profileDigest) throw new Error('app-confirmation-no-longer-current');
      return pending.operation.then(result => { assertLegacyAppAdmission(this.registry, pending.app.appBindingId); return structuredClone(result); });
    }
    if (this.discovery.candidate(pending.display.candidateId, pending.display.candidateRevision).digest !== pending.candidateDigest) {
      throw new Error('app-candidate-changed');
    }
    const app = this.registry.confirm({ appBindingId: pending.app.appBindingId, expectedRevision: pending.app.revision,
      profileDigest: pending.app.profileDigest, operatorId });
    pending.app = app; pending.operatorId = operatorId;
    const controller = new AbortController(); this.running.set(value.confirmationId, controller);
    pending.operation = this.run(app, controller, () => {
      if (pending.cancelled) throw new AppLaunchError('unavailable', 'app-launch-cancelled');
      if (this.discovery.candidate(pending.display.candidateId, pending.display.candidateRevision).digest !== pending.candidateDigest) {
        throw new AppLaunchError('stale', 'app-candidate-changed');
      }
    }).finally(() => this.running.delete(value.confirmationId));
    return pending.operation.then(result => { assertLegacyAppAdmission(this.registry, pending.app.appBindingId); return structuredClone(result); });
  }
  /** Lightweight inspect + actual-instance validation. No discovery.scan/query, no new confirmation. */
  reuse(value: { appBindingId: string; expectedRevision: number; operationId: string }, operatorId: string): Promise<AppLaunchOutcome> {
    this.current(); request(value, ['appBindingId', 'expectedRevision', 'operationId']); textValue(operatorId); textValue(value.operationId);
    const old = this.uses.get(value.operationId);
    if (old) {
      if (old.id !== value.appBindingId || old.revision !== value.expectedRevision || old.operatorId !== operatorId) throw new Error('app-operation-conflict');
      assertLegacyAppAdmission(this.registry, old.id);
      const app = this.registry.get(old.id);
      if (!app || app.validity !== 'current' || app.trust === 'discovered') throw new Error('app-profile-not-reusable');
      return old.operation.then(result => { assertLegacyAppAdmission(this.registry, old.id); return structuredClone(result); });
    }
    assertLegacyAppAdmission(this.registry, value.appBindingId);
    const app = this.registry.get(value.appBindingId);
    if (this.uses.size >= 512) throw new Error('app-operation-limit');
    if (!app || app.revision !== value.expectedRevision) throw new Error('app-revision-conflict');
    if (app.trust === 'discovered' || app.validity !== 'current' || !app.confirmations.some(item =>
      item.profileRevision === app.profileRevision && item.profileDigest === app.profileDigest)) throw new Error('app-profile-not-reusable');
    // An unavailable profile keeps its confirmation; explicit reuse rechecks installation and readiness.
    const controller = new AbortController();
    const operation = this.run(app, controller, () => {});
    this.uses.set(value.operationId, { id: value.appBindingId, revision: value.expectedRevision, operatorId, operation, cancel: controller });
    return operation.then(result => { assertLegacyAppAdmission(this.registry, value.appBindingId); return structuredClone(result); });
  }
  private async run(original: EnvironmentAppBinding, controller: AbortController, guard: () => void): Promise<AppLaunchOutcome> {
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let app = original;
    const check = () => { this.current(); assertLegacyAppAdmission(this.registry, original.appBindingId); guard(); if (controller.signal.aborted) throw new AppLaunchError('unavailable', 'app-launch-cancelled-or-timeout'); };
    try {
      check();
      if (app.availability === 'unavailable') {
        // Read-only identity validation cannot clear stale/revoked state, and creates no process.
        const identity = await this.launcher.inspect(app.launchSpec, controller.signal); check();
        if (!app.identity || identity.identity.productId !== app.identity.productId || identity.identity.version !== app.identity.version ||
            identity.identity.fingerprint !== app.identity.fingerprint) return this.failed(app, 'stale', 'app-installation-identity-changed');
        app = this.registry.setAvailability(app.appBindingId, app.revision, true);
      }
      const boundary = [...original.verifications].reverse().find(item => item.profileRevision === original.profileRevision &&
        item.profileDigest === original.profileDigest && (item.result === 'verified' || item.reason?.startsWith('launch-result-unknown:')));
      const authorization = this.launcher.authorize(this.registry, app.appBindingId, app.revision, controller.signal, check,
        boundary?.result !== 'verified' && boundary?.reason?.startsWith('launch-result-unknown:') === true);
      await this.launcher.verify(authorization.profile, authorization.permission);
      const outcome = this.launcher.outcome(authorization.permission);
      // No current target escapes when cancellation, revocation or CAS wins during drain.
      this.current(); assertLegacyAppAdmission(this.registry, original.appBindingId); guard();
      if (controller.signal.aborted && outcome.target) throw new AppLaunchError('unknown', 'app-launch-cancelled-during-drain');
      this.registry.recordVerification(app.appBindingId, app.revision, outcome.verification);
      return outcome;
    } catch (error) {
      if (error instanceof AppLaunchError) return this.failed(app, error.kind, error.message);
      throw error;
    } finally { clearTimeout(timer); }
  }
  private failed(app: EnvironmentAppBinding, kind: 'stale' | 'unavailable' | 'unknown', reason: string): AppLaunchOutcome {
    const verification = { scope: app.scope, profileRevision: app.profileRevision, profileDigest: app.profileDigest,
      checkedAt: new Date(this.clock()).toISOString(), result: kind === 'stale' ? 'mismatch' as const : 'unavailable' as const,
      processOwnershipVerified: false, windowOwnershipVerified: false, evidence: 'controlled-launch-preflight',
      reason: kind === 'unknown' ? `launch-result-unknown:${reason}` : reason };
    if (app.availability === 'unavailable') app = this.registry.setAvailability(app.appBindingId, app.revision, true);
    this.registry.recordVerification(app.appBindingId, app.revision, verification);
    return { verification, failureKind: kind };
  }
  cancel(value: { operationId: string }): void {
    request(value, ['operationId']); textValue(value.operationId);
    const pending = this.pending.get(value.operationId);
    if (pending) pending.cancelled = true;
    this.running.get(value.operationId)?.abort(); this.uses.get(value.operationId)?.cancel.abort();
  }
  revoke(value: { appBindingId: string; expectedRevision: number }, reason: string): EnvironmentAppBinding {
    this.current(); request(value, ['appBindingId', 'expectedRevision']);
    for (const [id, pending] of this.pending) if (pending.app.appBindingId === value.appBindingId) this.cancel({ operationId: id });
    for (const [id, use] of this.uses) if (use.id === value.appBindingId) this.cancel({ operationId: id });
    return this.registry.revoke(value.appBindingId, value.expectedRevision, reason);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.launcher.retireIssuer();
    for (const pending of this.pending.values()) pending.cancelled = true;
    for (const controller of this.running.values()) controller.abort();
    for (const use of this.uses.values()) use.cancel.abort();
    const results = await Promise.allSettled([...this.pending.values()].flatMap(item => item.operation ? [item.operation] : []).concat(
      [...this.uses.values()].map(item => item.operation)));
    this.pending.clear(); this.uses.clear();
    this.launcher.assertDrained();
    // Closed/revoked state can legitimately reject a result; cleanup-unconfirmed remains explicit.
    if (results.some(result => result.status === 'fulfilled' && result.value.verification.reason?.includes('cleanup-unconfirmed'))) {
      throw new Error('app-launch-cleanup-unconfirmed');
    }
  }
}
