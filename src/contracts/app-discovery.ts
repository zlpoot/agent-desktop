import type { AppCandidate, AppLaunchSpec, EnvironmentAppDiscovery, EnvironmentAppScope } from './environment-apps.js';

export interface AppScanLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly timeoutMs: number;
}
export interface AppSourceCoverage {
  readonly source: string;
  readonly status: 'complete' | 'unavailable' | 'truncated' | 'timeout';
  readonly inspected: number;
  readonly rejected: number;
  readonly reason?: string;
}
/** Private infrastructure response, never a model action or an executable command. */
export interface CollectedApp {
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly launchSpec: AppLaunchSpec;
  readonly source: string;
  readonly version?: string;
  readonly publisher?: string;
  readonly contentFingerprint: string;
}
export interface AppCollection {
  readonly scope: EnvironmentAppScope;
  readonly entries: readonly CollectedApp[];
  readonly coverage: readonly AppSourceCoverage[];
}
export interface AppDiscoveryCollector {
  readonly scope: EnvironmentAppScope;
  collect(limits: AppScanLimits, signal: AbortSignal): Promise<AppCollection>;
  inspectPath(path: string, limits: AppScanLimits, signal: AbortSignal): Promise<AppCollection>;
}
export interface DiscoveredApp {
  readonly candidateId: string;
  readonly revision: number;
  readonly digest: string;
  readonly candidate: AppCandidate;
  readonly sources: readonly string[];
  readonly version?: string;
  readonly publisher?: string;
  readonly limitation?: string;
  readonly trust: 'discovered';
}
export interface AppScanReport {
  readonly scope: EnvironmentAppScope;
  readonly status: 'complete' | 'incomplete' | 'unavailable';
  readonly candidates: readonly AppCandidate[];
  readonly snapshots: readonly DiscoveredApp[];
  readonly coverage: readonly AppSourceCoverage[];
  readonly reason?: string;
  readonly installationOrigin: 'selected-environment' | 'shared-host-os';
}
export interface AppQueryResult {
  readonly kind: 'found' | 'ambiguous' | 'not-found-within-scanned-sources' | 'unavailable';
  readonly matches: readonly DiscoveredApp[];
  readonly report: AppScanReport;
  readonly nextActions: readonly ('specify-path' | 'rescan-after-install' | 'cancel')[];
}
export interface ManualAppResult {
  readonly status: 'candidate' | 'unsupported' | 'unavailable';
  readonly snapshot?: DiscoveredApp;
  readonly reason?: string;
}
export interface ModelDiscoveredApp {
  readonly candidateId: string;
  readonly revision: number;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly trust: 'discovered';
}
export interface ReadonlyAppDiscovery extends EnvironmentAppDiscovery {
  scan(): Promise<AppScanReport>;
  query(name: string): Promise<AppQueryResult>;
  inspectPath(path: string): Promise<ManualAppResult>;
  /** A rescan invalidates prior snapshots; confirmation belongs to P7-C. */
  candidate(candidateId: string, revision: number): DiscoveredApp;
}
