import type { AppLaunchSpec, EnvironmentAppBinding, EnvironmentAppScope, InstalledAppIdentity,
  AppLaunchVerification } from './environment-apps.js';

/** Private infrastructure API. Never installed on the model/tool or public HTTP surface. */
export interface AppInstallationCheck {
  readonly scope: EnvironmentAppScope;
  readonly launchSpec: AppLaunchSpec;
  readonly identity: InstalledAppIdentity;
}
export interface AppRuntimeContext {
  readonly scope: EnvironmentAppScope;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly windowsSessionId: number;
  readonly desktop: string;
}
/** Native handles stay in the execution adapter. This receipt cannot authorize an action. */
export interface AppRuntimeTarget extends AppRuntimeContext {
  readonly targetToken: string;
  readonly identity: InstalledAppIdentity;
}
export interface AppInstanceEvidence extends AppRuntimeTarget {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory?: string;
  readonly processOwnedByInstallation: boolean;
  readonly windowOwnedByProcess: boolean;
  readonly sameUser: boolean;
  readonly permissionsCompatible: boolean;
}
/** A managed reservation uses existing resource/window policy, never an Agent input grant.
 * Operations honor cancellation/deadlines; close is the drain/ACK boundary. Only an opaque
 * token issued by start can be cleaned, never a PID supplied by a caller. */
export interface AppLaunchExecution {
  readonly context: AppRuntimeContext;
  assertCurrent(): Promise<void>;
  inspect(spec: AppLaunchSpec): Promise<AppInstallationCheck>;
  instances(profile: EnvironmentAppBinding): Promise<readonly AppInstanceEvidence[]>;
  start(profile: EnvironmentAppBinding): Promise<string>;
  observe(profile: EnvironmentAppBinding, ownedToken?: string): Promise<readonly AppInstanceEvidence[]>;
  cleanupOwned(ownedToken: string): Promise<void>;
  close(keepTarget?: boolean): Promise<void>;
}
export interface ManagedAppLaunchBackend {
  readonly scope: EnvironmentAppScope;
  /** Read-only; must not reserve input, open a Workspace, or start an application. */
  inspect(spec: AppLaunchSpec, signal: AbortSignal): Promise<AppInstallationCheck>;
  /** Bounded managed reservation. Does not start an application. */
  open(signal: AbortSignal): Promise<AppLaunchExecution>;
  close?(): Promise<void>;
}
export interface EnvironmentAppOnboarding {
  prepare(value: { candidateId: string; candidateRevision: number }): Promise<AppConfirmationDisplay>;
  confirm(value: { confirmationId: string; digest: string }, operatorId: string): Promise<AppLaunchOutcome>;
  reuse(value: { appBindingId: string; expectedRevision: number; operationId: string }, operatorId: string): Promise<AppLaunchOutcome>;
  cancel(value: { operationId: string }): void;
  revoke(value: { appBindingId: string; expectedRevision: number }, reason: string): EnvironmentAppBinding;
  close(): Promise<void>;
}
export type AppLaunchFailureKind = 'stale' | 'unavailable' | 'unknown';
export interface AppLaunchOutcome {
  readonly verification: AppLaunchVerification;
  readonly target?: AppRuntimeTarget;
  readonly failureKind?: AppLaunchFailureKind;
}
export interface AppConfirmationDisplay {
  readonly confirmationId: string;
  readonly digest: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly appBindingId: string;
  readonly profileRevision: number;
  readonly scope: EnvironmentAppScope;
  readonly displayName: string;
  readonly sources: readonly string[];
  readonly launchSpec: AppLaunchSpec;
  readonly version: string;
  readonly publisher: string;
  readonly effect: 'confirm-and-verify-launch';
}
