import { createHash } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';
import type { AppCandidate, AppLaunchSpec, EnvironmentAppScope, InstalledAppIdentity, ModelAppView,
  EnvironmentAppBinding } from '../contracts/environment-apps.js';
import { desktopTarget, sameDesktopTarget } from '../contracts/task-desktop.js';

function object(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid-app-fields');
}
export function textValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 4096 ||
      /[\u0000-\u001f]/.test(value)) throw new Error('invalid-app-text');
}
export function scopeValue(value: EnvironmentAppScope): EnvironmentAppScope {
  object(value, ['providerId', 'environmentId', 'installationScopeId']);
  desktopTarget(value.providerId, value.environmentId); textValue(value.installationScopeId);
  textValue(value.providerId); textValue(value.environmentId);
  return Object.freeze({ providerId: value.providerId, environmentId: value.environmentId,
    installationScopeId: value.installationScopeId });
}
export function sameAppScope(a: EnvironmentAppScope, b: EnvironmentAppScope): boolean {
  return sameDesktopTarget(a, b) && a.installationScopeId === b.installationScopeId;
}
function absolute(value: unknown): asserts value is string {
  textValue(value);
  if (!isAbsolute(value) && !win32.isAbsolute(value) || /^[a-z]:[^\\/]/i.test(value)) {
    throw new Error('app-path-must-be-absolute');
  }
}
export function identityValue(value: InstalledAppIdentity): void {
  object(value, ['productId', 'version', 'fingerprint']);
  textValue(value.productId); textValue(value.version); textValue(value.fingerprint);
}
export function launchValue(value: AppLaunchSpec): void {
  if (value?.kind === 'package') {
    object(value, ['kind', 'packageFamilyName', 'applicationUserModelId']);
    textValue(value.packageFamilyName); textValue(value.applicationUserModelId); return;
  }
  if (value?.kind !== 'exe' && value?.kind !== 'shortcut') throw new Error('invalid-app-launch-kind');
  object(value, value.kind === 'shortcut' ? ['kind', 'shortcutPath', 'executable', 'args', 'workingDirectory'] :
    ['kind', 'executable', 'args', 'workingDirectory']);
  absolute(value.executable);
  if (value.kind === 'shortcut') absolute(value.shortcutPath);
  if (value.workingDirectory !== undefined) absolute(value.workingDirectory);
  if (!Array.isArray(value.args) || value.args.length > 32 ||
      Array.from(value.args).some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\u0000\r\n]/.test(arg))) {
    throw new Error('invalid-app-args');
  }
}
export function candidateValue(value: AppCandidate, scope: EnvironmentAppScope): AppCandidate {
  object(value, ['scope', 'installationId', 'applicationId', 'displayName', 'aliases', 'launchSpec', 'identity', 'source']);
  scopeValue(value.scope);
  if (!sameAppScope(value.scope, scope)) throw new Error('app-environment-mismatch');
  textValue(value.installationId); textValue(value.applicationId); textValue(value.displayName);
  if (!Array.isArray(value.aliases) || value.aliases.length > 32) throw new Error('invalid-app-aliases');
  Array.from(value.aliases).forEach(textValue); launchValue(value.launchSpec);
  if (value.identity !== undefined) identityValue(value.identity);
  object(value.source, ['kind', 'reference', 'observedAt']);
  if (!['discovery', 'manual', 'legacy-import'].includes(value.source.kind)) throw new Error('invalid-app-source');
  textValue(value.source.reference); timestamp(value.source.observedAt);
  // Canonical construction discards undefined fields and fixes property order for digests.
  const spec = value.launchSpec;
  const launchSpec: AppLaunchSpec = spec.kind === 'package' ? { kind: spec.kind,
    packageFamilyName: spec.packageFamilyName, applicationUserModelId: spec.applicationUserModelId } :
    spec.kind === 'shortcut' ? { kind: 'shortcut', shortcutPath: spec.shortcutPath, executable: spec.executable,
      args: [...spec.args], ...(spec.workingDirectory === undefined ? {} : { workingDirectory: spec.workingDirectory }) } :
    { kind: 'exe', executable: spec.executable, args: [...spec.args],
      ...(spec.workingDirectory === undefined ? {} : { workingDirectory: spec.workingDirectory }) };
  return { scope: scopeValue(value.scope), installationId: value.installationId, applicationId: value.applicationId,
    displayName: value.displayName, aliases: [...value.aliases], launchSpec,
    ...(value.identity ? { identity: { productId: value.identity.productId, version: value.identity.version,
      fingerprint: value.identity.fingerprint } } : {}), source: { ...value.source } };
}
export function timestamp(value: unknown): asserts value is string {
  textValue(value);
  if (!Number.isFinite(Date.parse(value))) throw new Error('invalid-app-timestamp');
}
/** Binds operator-visible configuration as well as the executable/installation identity. */
export function profileDigest(value: AppCandidate): string {
  const { source: _source, ...configuration } = candidateValue(value, value.scope);
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}
export function modelAppView(value: EnvironmentAppBinding): ModelAppView {
  return { appBindingId: value.appBindingId, applicationId: value.applicationId, displayName: value.displayName,
    aliases: value.trust === 'discovered' ? [] : [...value.aliases], profileRevision: value.profileRevision,
    trust: value.trust, validity: value.validity, availability: value.availability };
}
