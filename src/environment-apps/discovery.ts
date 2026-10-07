import { createHash, randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import type { AppLaunchSpec, EnvironmentAppScope, EnvironmentAppServices } from '../contracts/environment-apps.js';
import type { AppCollection, AppDiscoveryCollector, AppQueryResult, AppScanLimits, AppScanReport,
  CollectedApp, DiscoveredApp, ManualAppResult, ModelDiscoveredApp, ReadonlyAppDiscovery } from '../contracts/app-discovery.js';
import { candidateValue, launchValue, sameAppScope, scopeValue, textValue } from './validation.js';
import type { TaskDesktopTarget } from '../contracts/task-desktop.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const defaultAppScanLimits: AppScanLimits = Object.freeze({ maxEntries: 500, maxDepth: 5, timeoutMs: 5000 });
export function appScanLimits(value: AppScanLimits): AppScanLimits {
  if (!value || Object.keys(value).some(key => !['maxEntries', 'maxDepth', 'timeoutMs'].includes(key)) ||
      !Number.isInteger(value.maxEntries) || value.maxEntries < 1 || value.maxEntries > 2000 ||
      !Number.isInteger(value.maxDepth) || value.maxDepth < 0 || value.maxDepth > 10 ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 10 || value.timeoutMs > 30000) throw new Error('invalid-app-scan-limits');
  return Object.freeze({ ...value });
}
function localPath(path: string): string {
  textValue(path);
  if (!/^[a-z]:[\\/]/i.test(path) || /[<>"|?*]|[\u0000-\u001f]/.test(path) || path.slice(2).includes(':')) {
    throw new Error('unsupported-local-app-path');
  }
  return win32.normalize(path).toLowerCase();
}
function definition(spec: AppLaunchSpec): unknown {
  launchValue(spec);
  if (spec.kind === 'package') return [spec.kind, spec.packageFamilyName, spec.applicationUserModelId];
  const executable = localPath(spec.executable);
  if (!executable.endsWith('.exe') || /(?:^|\\)(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|python|pythonw|node|bash|wsl)\.exe$/.test(executable)) {
    throw new Error('unsupported-app-wrapper');
  }
  if (spec.kind === 'shortcut') localPath(spec.shortcutPath);
  return ['exe', executable, [...spec.args], spec.workingDirectory ? localPath(spec.workingDirectory) : ''];
}
/** No Registry writes, capability evidence, process startup, or environment fallback. */
export class ScopedAppDiscovery implements ReadonlyAppDiscovery {
  readonly scope: EnvironmentAppScope;
  private readonly limits: AppScanLimits;
  private readonly snapshots = new Map<string, DiscoveredApp>();
  private revision = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(scope: EnvironmentAppScope, private readonly collector: AppDiscoveryCollector,
    limits = defaultAppScanLimits, private readonly origin: AppScanReport['installationOrigin'] = 'selected-environment') {
    this.scope = scopeValue(scope); this.limits = appScanLimits(limits);
    const source = scopeValue(collector.scope);
    if (origin === 'shared-host-os' ? source.providerId !== 'physical' || this.scope.providerId !== 'local-workspace' ||
        source.installationScopeId !== this.scope.installationScopeId : !sameAppScope(this.scope, source)) {
      throw new Error('app-collector-environment-mismatch');
    }
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation); this.tail = next.catch(() => {}); return next;
  }
  private async collect(path?: string): Promise<AppCollection> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('app-scan-timeout'));
      }, this.limits.timeoutMs); });
      const request = path === undefined ? this.collector.collect(this.limits, controller.signal) :
        this.collector.inspectPath(path, this.limits, controller.signal);
      const result = await Promise.race([request, timeout]);
      if (!sameAppScope(scopeValue(result.scope), this.collector.scope)) throw new Error('app-collector-identity-mismatch');
      if (!Array.isArray(result.entries) || result.entries.length > this.limits.maxEntries ||
          !Array.isArray(result.coverage) || result.coverage.length < 1 || result.coverage.length > 16) {
        throw new Error('invalid-app-collection');
      }
      for (const item of result.coverage) {
        textValue(item.source);
        if (!['complete', 'unavailable', 'truncated', 'timeout'].includes(item.status) ||
            !Number.isInteger(item.inspected) || item.inspected < 0 || !Number.isInteger(item.rejected) || item.rejected < 0) {
          throw new Error('invalid-app-coverage');
        }
        if (item.reason !== undefined) textValue(item.reason);
      }
      return structuredClone(result);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private snapshot(entry: CollectedApp, sources: readonly string[], revision: number, manual = false): DiscoveredApp {
    textValue(entry.displayName); textValue(entry.source); textValue(entry.contentFingerprint);
    if (entry.version !== undefined) textValue(entry.version);
    if (entry.publisher !== undefined) textValue(entry.publisher);
    const key = definition(entry.launchSpec);
    const candidate = candidateValue({ scope: this.scope, installationId: hash([this.scope.installationScopeId, key]),
      applicationId: entry.displayName.normalize('NFKC').toLowerCase(), displayName: entry.displayName,
      aliases: entry.aliases, launchSpec: entry.launchSpec,
      source: { kind: manual ? 'manual' : 'discovery', reference: sources.join(' | '), observedAt: new Date().toISOString() } }, this.scope);
    const limitation = entry.launchSpec.kind === 'package' ? 'package-launch-not-implemented' :
      this.origin === 'shared-host-os' ? 'installed-on-host-os;workspace-launch-and-operation-not-proven' : undefined;
    return { candidateId: randomUUID(), revision, candidate, sources: [...sources],
      digest: hash([candidate.scope, key, entry.contentFingerprint, entry.displayName, entry.aliases, entry.version, entry.publisher]),
      ...(entry.version ? { version: entry.version } : {}), ...(entry.publisher ? { publisher: entry.publisher } : {}),
      ...(limitation ? { limitation } : {}), trust: 'discovered' };
  }
  scan(): Promise<AppScanReport> { return this.serialized(async () => {
    const revision = ++this.revision; this.snapshots.clear();
    try {
      const result = await this.collect();
      const groups = new Map<string, { entry: CollectedApp; sources: string[] }>();
      for (const entry of result.entries) {
        // Validate before merging so malicious duplicates cannot hide invalid fields.
        this.snapshot(entry, [entry.source], revision);
        const key = hash(definition(entry.launchSpec)), previous = groups.get(key);
        if (previous) {
          previous.sources.push(entry.source);
          previous.entry = { ...previous.entry, aliases: [...new Set([...previous.entry.aliases, entry.displayName, ...entry.aliases])].slice(0, 32) };
        } else groups.set(key, { entry, sources: [entry.source] });
      }
      const snapshots = [...groups.values()].map(({ entry, sources }) => this.snapshot(entry, [...new Set(sources)], revision));
      snapshots.forEach(item => this.snapshots.set(item.candidateId, structuredClone(item)));
      const usable = result.coverage.some(item => item.status !== 'unavailable');
      const status = !usable ? 'unavailable' : result.coverage.every(item => item.status === 'complete') ? 'complete' : 'incomplete';
      return { scope: this.scope, status, candidates: snapshots.map(item => item.candidate), snapshots,
        coverage: result.coverage, ...(status !== 'complete' ? { reason: 'scan-sources-incomplete' } : {}), installationOrigin: this.origin };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'app-discovery-unavailable';
      return { scope: this.scope, status: 'unavailable', candidates: [], snapshots: [], installationOrigin: this.origin,
        coverage: [{ source: 'environment-discovery', status: reason === 'app-scan-timeout' ? 'timeout' : 'unavailable',
          inspected: 0, rejected: 0, reason }], reason };
    }
  }); }
  async query(name: string): Promise<AppQueryResult> {
    textValue(name); const report = await this.scan(), key = name.normalize('NFKC').toLowerCase();
    const matches = report.snapshots.filter(item => [item.candidate.displayName, item.candidate.applicationId,
      ...item.candidate.aliases].some(alias => alias.normalize('NFKC').toLowerCase().includes(key)))
      .sort((a, b) => Number(b.candidate.displayName.normalize('NFKC').toLowerCase() === key) -
        Number(a.candidate.displayName.normalize('NFKC').toLowerCase() === key) || a.candidate.displayName.localeCompare(b.candidate.displayName));
    return { kind: matches.length > 1 ? 'ambiguous' : matches.length === 1 ? 'found' :
      report.status === 'complete' ? 'not-found-within-scanned-sources' : 'unavailable', matches, report,
      nextActions: ['specify-path', 'rescan-after-install', 'cancel'] };
  }
  inspectPath(path: string): Promise<ManualAppResult> { return this.serialized(async () => {
    try {
      localPath(path);
      if (!/\.(exe|lnk)$/i.test(path)) return { status: 'unsupported', reason: 'unsupported-app-file-type' };
      const result = await this.collect(path);
      if (result.entries.length !== 1) {
        const reason = result.coverage[0]?.reason ?? 'manual-path-unavailable';
        return { status: reason.includes('unsupported-') ? 'unsupported' : 'unavailable', reason };
      }
      const snapshot = this.snapshot(result.entries[0], [result.entries[0].source], ++this.revision, true);
      this.snapshots.set(snapshot.candidateId, structuredClone(snapshot)); return { status: 'candidate', snapshot };
    } catch (error) { return { status: 'unavailable', reason: error instanceof Error ? error.message : 'manual-path-unavailable' }; }
  }); }
  async inspect(spec: AppLaunchSpec) {
    launchValue(spec);
    if (spec.kind === 'package') throw new Error('manual-package-inspection-unsupported');
    const result = await this.inspectPath(spec.kind === 'shortcut' ? spec.shortcutPath : spec.executable);
    if (!result.snapshot) throw new Error(result.reason);
    // Caller-supplied arguments never replace the environment's parsed definition.
    if (hash(definition(spec)) !== hash(definition(result.snapshot.candidate.launchSpec))) throw new Error('app-inspection-definition-mismatch');
    return result.snapshot.candidate;
  }
  candidate(id: string, revision: number): DiscoveredApp {
    const result = this.snapshots.get(id);
    if (!result || result.revision !== revision) throw new Error('app-candidate-stale-or-unknown');
    return structuredClone(result);
  }
}
export function modelDiscoveredApp(value: DiscoveredApp): ModelDiscoveredApp {
  return { candidateId: value.candidateId, revision: value.revision, displayName: value.candidate.displayName,
    aliases: [...value.candidate.aliases], trust: 'discovered' };
}
/** Selection validation precedes every adapter call. Legacy discovery lacks B coverage evidence. */
export async function queryEnvironmentApps(services: EnvironmentAppServices,
  target: TaskDesktopTarget, name: string): Promise<AppQueryResult> {
  const service = services.forEnvironment(target), port = service.discovery as ReadonlyAppDiscovery | undefined;
  if (!port || typeof port.query !== 'function') throw new Error('app-discovery-port-unavailable');
  if (!sameAppScope(port.scope, service.registry.scope)) throw new Error('app-port-environment-mismatch');
  service.registry.list(); // rejects an obsolete installation-generation handle before scanning
  return port.query(name);
}
