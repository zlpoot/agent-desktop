import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import type { AppLaunchSpec, EnvironmentAppBinding, EnvironmentAppLauncher, EnvironmentAppRegistry,
  EnvironmentAppScope, InstalledAppIdentity } from '../contracts/environment-apps.js';
import type { AppInstallationCheck, AppInstanceEvidence, AppLaunchExecution, AppLaunchFailureKind,
  AppLaunchOutcome, AppRuntimeContext, ManagedAppLaunchBackend } from '../contracts/app-launch.js';
import { identityValue, launchValue, sameAppScope, scopeValue, textValue } from './validation.js';
import type { DesktopSession } from '../contracts/desktop-environment.js';
import { assertAppAdmission } from './admission-gate.js';

export class AppLaunchError extends Error {
  constructor(readonly kind: AppLaunchFailureKind, reason: string) { super(reason); }
}
function identityEqual(a: InstalledAppIdentity, b: InstalledAppIdentity): boolean {
  return a.productId === b.productId && a.version === b.version && a.fingerprint === b.fingerprint;
}
export function launchDefinition(spec: AppLaunchSpec): string {
  launchValue(spec);
  if (spec.kind === 'package') throw new AppLaunchError('unavailable', 'package-launch-unsupported');
  const path = (value: string) => {
    if (!/^[a-z]:[\\/]/i.test(value) || /[<>"|?*]|[\u0000-\u001f]/.test(value) || value.slice(2).includes(':')) {
      throw new AppLaunchError('stale', 'unsupported-local-app-path');
    }
    return win32.normalize(value).toLowerCase();
  };
  const executable = path(spec.executable);
  if (!executable.endsWith('.exe') || /(?:^|\\)(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|python|pythonw|node|bash|wsl)\.exe$/.test(executable)) {
    throw new AppLaunchError('stale', 'unsupported-app-wrapper');
  }
  if (spec.kind === 'shortcut' && !path(spec.shortcutPath).endsWith('.lnk')) throw new AppLaunchError('stale', 'unsupported-shortcut');
  return JSON.stringify([spec.kind, spec.kind === 'shortcut' ? path(spec.shortcutPath) : '', executable,
    [...spec.args], spec.workingDirectory ? path(spec.workingDirectory) : '']);
}
export function checkedInstallation(value: AppInstallationCheck, scope: EnvironmentAppScope, spec: AppLaunchSpec): AppInstallationCheck {
  if (!value || !sameAppScope(scopeValue(value.scope), scope) || launchDefinition(value.launchSpec) !== launchDefinition(spec)) {
    throw new AppLaunchError('stale', 'app-installation-definition-mismatch');
  }
  identityValue(value.identity); return structuredClone(value);
}
function contextValue(value: AppRuntimeContext, scope: EnvironmentAppScope): void {
  if (!value || !sameAppScope(scopeValue(value.scope), scope)) throw new AppLaunchError('unknown', 'app-runtime-environment-mismatch');
  textValue(value.sessionId); textValue(value.instanceId); textValue(value.desktop);
  if (!Number.isSafeInteger(value.windowsSessionId) || value.windowsSessionId < 0) throw new AppLaunchError('unknown', 'app-runtime-session-unproven');
}
function sameContext(a: AppRuntimeContext, b: AppRuntimeContext): boolean {
  return sameAppScope(a.scope, b.scope) && a.sessionId === b.sessionId && a.instanceId === b.instanceId &&
    a.windowsSessionId === b.windowsSessionId && a.desktop === b.desktop;
}
type Permit = Parameters<EnvironmentAppLauncher['verify']>[1];
type Grant = { profile: EnvironmentAppBinding; registry: EnvironmentAppRegistry; guard(): void; signal: AbortSignal; observeOnly: boolean };
type IssuedTargetRecord = { profile: string; target: string; registry: EnvironmentAppRegistry; consumed: boolean; retired: boolean };
type TargetHandoff = { record: IssuedTargetRecord; registry: EnvironmentAppRegistry;
  profile: EnvironmentAppBinding; target: NonNullable<AppLaunchOutcome['target']>;
  session: DesktopSession; sessionKey: string };

function taskSessionKey(session: DesktopSession): string {
  for (const value of [session.providerId, session.environmentId, session.sessionId, session.instanceId]) textValue(value);
  if (session.inputResourceId !== null) textValue(session.inputResourceId);
  return JSON.stringify([session.providerId, session.environmentId, session.sessionId, session.instanceId, session.inputResourceId]);
}

/** Backend-specific launch policy and native process evidence stay behind this port.
 * Permit objects are single-use, issuer-local objects; serializing/copying an ID grants nothing. */
export class ControlledAppLauncher implements EnvironmentAppLauncher {
  readonly scope: EnvironmentAppScope;
  private readonly permits = new WeakMap<object, Grant>();
  private readonly outcomes = new WeakMap<object, { outcome: AppLaunchOutcome; profile: EnvironmentAppBinding;
    registry: EnvironmentAppRegistry; generation: object }>();
  private readonly issuedTargets = new Map<string, IssuedTargetRecord>();
  private readonly handoffs = new WeakMap<object, TargetHandoff>();
  private readonly active = new Set<string>();
  private blocked = false;
  private closed = false;
  private reservationGeneration: object = {};
  constructor(private readonly backend: ManagedAppLaunchBackend, private readonly now = () => new Date().toISOString()) {
    this.scope = scopeValue(backend.scope);
  }
  inspect(spec: AppLaunchSpec, signal: AbortSignal): Promise<AppInstallationCheck> {
    this.assertOpen();
    launchDefinition(spec);
    return this.backend.inspect(structuredClone(spec), signal).then(value => {
      this.assertOpen(); return checkedInstallation(value, this.scope, spec);
    });
  }
  /** Trusted service-only API, not a path/shell endpoint. A profile is re-read from its scoped Registry. */
  authorize(registry: EnvironmentAppRegistry, id: string, revision: number, signal: AbortSignal,
    guard: () => void, observeOnly = false): { permission: Permit; profile: EnvironmentAppBinding } {
    this.assertOpen();
    if (!sameAppScope(registry.scope, this.scope)) throw new Error('app-launch-environment-mismatch');
    const profile = registry.requireLaunchProfile(id, revision);
    const permission: Permit = Object.freeze({ scope: this.scope, appBindingId: id,
      profileRevision: profile.profileRevision, profileDigest: profile.profileDigest, permitId: randomUUID() });
    this.permits.set(permission, { profile: structuredClone(profile), registry, signal, observeOnly, guard: () => {
      this.assertOpen();
      guard(); registry.requireLaunchProfile(id, revision);
      if (signal.aborted) throw new AppLaunchError('unavailable', 'app-launch-cancelled');
    } });
    return { permission, profile };
  }
  async verify(profile: EnvironmentAppBinding, permission: Permit) {
    const grant = this.permits.get(permission); this.permits.delete(permission);
    this.assertOpen();
    if (!grant || JSON.stringify(profile) !== JSON.stringify(grant.profile)) throw new Error('app-launch-permit-invalid-or-consumed');
    if (this.blocked) throw new Error('app-launch-resource-blocked');
    if (this.active.size) throw new AppLaunchError('unavailable', 'app-launch-resource-busy');
    this.active.add(profile.appBindingId);
    let execution: AppLaunchExecution | undefined, owned: string | undefined, target: AppLaunchOutcome['target'];
    let generation = this.reservationGeneration;
    let kind: AppLaunchFailureKind | undefined, reason: string | undefined;
    try {
      grant.guard(); launchDefinition(profile.launchSpec);
      if (!profile.identity) throw new AppLaunchError('stale', 'app-installation-identity-unproven');
      const preflight = await this.inspect(profile.launchSpec, grant.signal); grant.guard();
      if (!identityEqual(preflight.identity, profile.identity)) throw new AppLaunchError('stale', 'app-installation-identity-changed');
      // Native reserve_context clears its targets; even a failed new reservation
      // cannot preserve proof of an earlier live target. Keep replay tombstones.
      this.retireTargets();
      generation = this.reservationGeneration = {};
      execution = await this.backend.open(grant.signal); contextValue(execution.context, this.scope);
      const boundary = structuredClone(execution.context);
      const fresh = async () => { grant.guard(); await execution!.assertCurrent(); grant.guard();
        if (!sameContext(boundary, execution!.context)) throw new AppLaunchError('unknown', 'app-runtime-instance-changed'); };
      await fresh();
      const inspected = checkedInstallation(await execution.inspect(profile.launchSpec), this.scope, profile.launchSpec);
      if (!identityEqual(inspected.identity, profile.identity)) throw new AppLaunchError('stale', 'app-installation-identity-changed');
      const select = (values: readonly AppInstanceEvidence[]) => {
        if (!Array.isArray(values) || values.length > 64) throw new AppLaunchError('unknown', 'invalid-app-instance-evidence');
        if (!values.length) return undefined;
        // Never ignore a wrong/ambiguous instance and silently launch a second copy.
        if (values.length !== 1) throw new AppLaunchError('unavailable', 'app-instance-ambiguous');
        const value = values[0]; contextValue(value, this.scope); identityValue(value.identity); textValue(value.targetToken);
        const expected = profile.launchSpec;
        if (expected.kind === 'package' || !sameContext(value, boundary) || !identityEqual(value.identity, profile.identity!) ||
            win32.normalize(value.executable).toLowerCase() !== win32.normalize(expected.executable).toLowerCase() ||
            JSON.stringify(value.args) !== JSON.stringify(expected.args) ||
            (value.workingDirectory ? win32.normalize(value.workingDirectory).toLowerCase() : '') !==
              (expected.workingDirectory ? win32.normalize(expected.workingDirectory).toLowerCase() : '') ||
            value.processOwnedByInstallation !== true || value.windowOwnedByProcess !== true || value.sameUser !== true ||
            value.permissionsCompatible !== true) throw new AppLaunchError('unknown', 'app-process-window-ownership-unproven');
        return value;
      };
      let instance = select(await execution.instances(profile)); await fresh();
      if (!instance) {
        if (grant.observeOnly) throw new AppLaunchError('unknown', 'app-launch-result-still-unknown');
        // Adapter must recheck installation, policy and cancellation atomically at dispatch.
        owned = await execution.start(profile); textValue(owned); await fresh();
        instance = select(await execution.observe(profile, owned));
      }
      if (!instance) throw new AppLaunchError('unknown', 'app-launch-no-verified-window');
      await fresh();
      const finalInstallation = checkedInstallation(await execution.inspect(profile.launchSpec), this.scope, profile.launchSpec);
      if (!identityEqual(finalInstallation.identity, profile.identity)) throw new AppLaunchError('stale', 'app-installation-identity-changed');
      await fresh();
      target = { scope: this.scope, sessionId: boundary.sessionId, instanceId: boundary.instanceId,
        windowsSessionId: boundary.windowsSessionId, desktop: boundary.desktop,
        targetToken: instance.targetToken, identity: { ...instance.identity } };
    } catch (error) {
      kind = error instanceof AppLaunchError ? error.kind : 'unknown';
      reason = error instanceof AppLaunchError ? error.message : 'app-launch-result-unknown';
    } finally {
      if (target) {
        try { grant.guard(); }
        catch (error) { target = undefined; kind = error instanceof AppLaunchError ? error.kind : 'unknown';
          reason = error instanceof AppLaunchError ? error.message : 'app-launch-invalidated-before-drain'; }
      }
      try {
        try { if (execution && owned && !target) await execution.cleanupOwned(owned); }
        finally { if (execution) await execution.close(!!target); }
      } catch { this.blocked = true; kind = 'unknown'; reason = 'app-launch-cleanup-unconfirmed'; target = undefined; }
      this.active.delete(profile.appBindingId);
    }
    const verification = { scope: this.scope, profileRevision: profile.profileRevision, profileDigest: profile.profileDigest,
      checkedAt: this.now(), result: target ? 'verified' as const : kind === 'stale' ? 'mismatch' as const : 'unavailable' as const,
      ...(target ? { identity: target.identity } : {}), processOwnershipVerified: !!target, windowOwnershipVerified: !!target,
      evidence: target ? 'managed-installation-process-window-session-desktop-verification' : 'managed-launch-failure',
      ...(reason ? { reason: kind === 'unknown' ? `launch-result-unknown:${reason}` : reason } : {}) };
    this.outcomes.set(permission, { profile: structuredClone(profile), registry: grant.registry, generation,
      outcome: { verification, ...(target ? { target } : {}), ...(kind ? { failureKind: kind } : {}) } });
    return verification;
  }
  outcome(permission: Permit): AppLaunchOutcome {
    this.assertOpen();
    const value = this.outcomes.get(permission); this.outcomes.delete(permission);
    if (!value) throw new Error('app-launch-outcome-unavailable');
    const outcome = structuredClone(value.outcome);
    if (outcome.target && outcome.verification.result === 'verified') {
      // A native target token need not identify a verification issuance. Never rearm
      // it: retain consumed/reissued tombstones for this issuer's whole lifetime.
      // At the bounded history limit, new provenance stays unavailable; no eviction
      // may erase replay history. Historical launch verification remains unchanged.
      const previous = this.issuedTargets.get(outcome.target.targetToken);
      const currentGeneration = value.generation === this.reservationGeneration;
      if (previous) { previous.consumed = true; previous.retired = true; }
      else if (this.issuedTargets.size < 128) this.issuedTargets.set(outcome.target.targetToken, {
        profile: this.profileKey(value.profile), target: this.targetKey(outcome.target), registry: value.registry,
        consumed: !currentGeneration, retired: !currentGeneration,
      });
    }
    return outcome;
  }
  private profileKey(profile: EnvironmentAppBinding): string {
    identityValue(profile.identity!);
    return JSON.stringify([scopeValue(profile.scope), profile.appBindingId, profile.installationId,
      profile.profileRevision, profile.profileDigest, [profile.identity!.productId, profile.identity!.version, profile.identity!.fingerprint], launchDefinition(profile.launchSpec)]);
  }
  private targetKey(target: NonNullable<AppLaunchOutcome['target']>): string {
    contextValue(target, this.scope); textValue(target.targetToken); identityValue(target.identity);
    return JSON.stringify([scopeValue(target.scope), target.sessionId, target.instanceId, target.windowsSessionId,
      target.desktop, target.targetToken, [target.identity.productId, target.identity.version, target.identity.fingerprint]]);
  }
  /** Private composition API. Consume once; never accepts a copied permit/boolean as issuer proof.
   * Matching this record does not prove current native lifetime, Task mapping or input authority. */
  consumeIssuedTarget(profile: EnvironmentAppBinding, target: NonNullable<AppLaunchOutcome['target']>): void {
    this.assertOpen();
    this.assertDrained();
    const record = this.issuedTargets.get(target.targetToken);
    if (!record || record.consumed || record.retired) throw new Error('app-task-issued-target-unavailable-or-consumed');
    if (record.profile !== this.profileKey(profile) || record.target !== this.targetKey(target)) throw new Error('app-task-issued-target-mismatch');
    record.consumed = true;
  }
  /** Private source handoff, NOT native lifetime/Worker/input authority proof.
   * The field-free object can only be resolved by this live issuer. Bind the exact
   * Registry and Task Session objects, never equate reservation and Task IDs. */
  async handoffIssuedTarget(registry: EnvironmentAppRegistry, profile: EnvironmentAppBinding,
    target: NonNullable<AppLaunchOutcome['target']>, session: DesktopSession): Promise<object> {
    this.assertOpen(); this.assertDrained();
    const snapshot = structuredClone({ profile, target });
    const handle = Object.freeze(Object.create(null)) as object;
    const record = this.issuedTargets.get(snapshot.target.targetToken);
    if (!record || record.registry !== registry || record.consumed || record.retired) {
      throw new Error('app-task-issued-target-unavailable-or-consumed');
    }
    const handoff: TargetHandoff = { ...snapshot, record, registry, session, sessionKey: taskSessionKey(session) };
    this.handoffs.set(handle, handoff);
    this.assertIssuedTargetHandoff(handle, session);
    // Claim before the first await: concurrent attempts cannot acquire this record.
    this.consumeIssuedTarget(snapshot.profile, snapshot.target);
    try {
      const status = await session.status();
      this.assertIssuedTargetHandoff(handle, session);
      if (status.state !== 'open') throw new Error('app-task-provider-session-stale');
      return handle;
    } catch (error) {
      this.handoffs.delete(handle); // Failed/unknown handoffs are never rearmed.
      throw error;
    }
  }
  assertIssuedTargetHandoff(handle: object, session: DesktopSession): void {
    try { this.assertHandoff(handle, session); }
    catch (error) { this.handoffs.delete(handle); throw error; }
  }
  private assertHandoff(handle: object, session: DesktopSession): void {
    this.assertOpen(); this.assertDrained();
    const value = this.handoffs.get(handle);
    if (!value || value.record.retired || this.issuedTargets.get(value.target.targetToken) !== value.record) {
      throw new Error('app-task-issued-handoff-unavailable');
    }
    if (session !== value.session || taskSessionKey(session) !== value.sessionKey ||
        session.providerId !== this.scope.providerId || session.environmentId !== this.scope.environmentId) {
      throw new Error('app-task-provider-session-mismatch');
    }
    assertAppAdmission(value.registry, value.profile.appBindingId);
    const current = value.registry.get(value.profile.appBindingId);
    if (!sameAppScope(value.registry.scope, this.scope) || !current || current.validity !== 'current' ||
        current.trust !== 'verified' || current.availability !== 'available' ||
        this.profileKey(current) !== value.record.profile || this.targetKey(value.target) !== value.record.target) {
      throw new Error('app-task-profile-no-longer-current');
    }
  }
  private retireTargets(): void {
    for (const record of this.issuedTargets.values()) record.retired = true;
  }
  /** Synchronous invalidation precedes any asynchronous service/backend drain.
   * It does not acknowledge native revocation or release a user-owned process. */
  retireIssuer(): void { this.closed = true; this.retireTargets(); }
  private assertOpen(): void {
    if (this.closed) throw new Error('app-launch-issuer-closed');
    if (!sameAppScope(this.scope, this.backend.scope)) {
      this.blocked = true; this.retireTargets();
      throw new Error('app-launch-issuer-scope-changed');
    }
  }
  assertDrained(): void {
    if (this.active.size || this.blocked) throw new Error('app-launch-cleanup-unconfirmed');
  }
}
