import type { TaskDesktopTarget } from './task-desktop.js';
import type { EnvironmentAppOnboarding } from './app-launch.js';

/** Installation/user-domain identity comes from trusted infrastructure, never a Task/model. */
export interface EnvironmentAppScope extends TaskDesktopTarget {
  readonly installationScopeId: string;
}
export type AppLaunchSpec =
  | { readonly kind: 'exe'; readonly executable: string; readonly args: readonly string[]; readonly workingDirectory?: string }
  | { readonly kind: 'shortcut'; readonly shortcutPath: string; readonly executable: string;
      readonly args: readonly string[]; readonly workingDirectory?: string }
  | { readonly kind: 'package'; readonly packageFamilyName: string; readonly applicationUserModelId: string };
export interface InstalledAppIdentity {
  readonly productId: string;
  readonly version: string;
  /** Adapter-derived identity of the installation contents; a path is not identity evidence. */
  readonly fingerprint: string;
}
export interface AppCandidate {
  readonly scope: EnvironmentAppScope;
  readonly installationId: string;
  readonly applicationId: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly launchSpec: AppLaunchSpec;
  /** Absent for uninspected legacy/manual candidates. Such candidates cannot be verified. */
  readonly identity?: InstalledAppIdentity;
  readonly source: { readonly kind: 'discovery' | 'manual' | 'legacy-import'; readonly reference: string; readonly observedAt: string };
}
export interface AppConfirmation {
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly operatorId: string;
  readonly confirmedAt: string;
}
export interface AppLaunchVerification {
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly scope: EnvironmentAppScope;
  readonly checkedAt: string;
  readonly result: 'verified' | 'unavailable' | 'mismatch';
  readonly identity?: InstalledAppIdentity;
  readonly processOwnershipVerified: boolean;
  readonly windowOwnershipVerified: boolean;
  readonly evidence: string;
  readonly reason?: string;
}
/** Private configuration only. No session, instance, PID, HWND, observation or authority. */
export interface EnvironmentAppBinding extends AppCandidate {
  readonly appBindingId: string;
  readonly revision: number;
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly trust: 'discovered' | 'confirmed' | 'verified';
  readonly validity: 'current' | 'stale' | 'revoked';
  readonly availability: 'available' | 'unavailable';
  readonly lastError?: string;
  readonly confirmations: readonly AppConfirmation[];
  readonly verifications: readonly AppLaunchVerification[];
}
export type AppNameResolution =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unique'; readonly app: EnvironmentAppBinding }
  | { readonly kind: 'ambiguous'; readonly apps: readonly EnvironmentAppBinding[] };
export interface AppConfirmationRequest {
  readonly appBindingId: string;
  readonly expectedRevision: number;
  readonly profileDigest: string;
  readonly operatorId: string;
}
/** Trusted operator/storage port; never injected into the model action surface. */
export interface EnvironmentAppRegistry {
  readonly scope: EnvironmentAppScope;
  list(): readonly EnvironmentAppBinding[];
  get(appBindingId: string): EnvironmentAppBinding | undefined;
  resolveName(name: string): AppNameResolution;
  discover(candidate: AppCandidate, expectedRevision?: number): EnvironmentAppBinding;
  confirm(request: AppConfirmationRequest): EnvironmentAppBinding;
  recordVerification(appBindingId: string, expectedRevision: number, result: AppLaunchVerification): EnvironmentAppBinding;
  setAvailability(appBindingId: string, expectedRevision: number, available: boolean, reason?: string): EnvironmentAppBinding;
  markStale(appBindingId: string, expectedRevision: number, reason: string): EnvironmentAppBinding;
  revoke(appBindingId: string, expectedRevision: number, reason: string): EnvironmentAppBinding;
  /** Reusable configuration, not launch authorization or P6 capability evidence. */
  requireLaunchProfile(appBindingId: string, expectedRevision: number): EnvironmentAppBinding;
  history(appBindingId: string): readonly EnvironmentAppBinding[];
}
export interface EnvironmentAppDiscovery {
  readonly scope: EnvironmentAppScope;
  scan(): Promise<{ readonly status: 'complete' | 'incomplete' | 'unavailable'; readonly candidates: readonly AppCandidate[]; readonly reason?: string }>;
  inspect(launchSpec: AppLaunchSpec): Promise<AppCandidate>;
}
/** Separate, effectful infrastructure port. P7-A implements no launcher or permit issuer. */
export interface EnvironmentAppLauncher {
  readonly scope: EnvironmentAppScope;
  verify(profile: EnvironmentAppBinding, permission: {
    readonly scope: EnvironmentAppScope; readonly appBindingId: string;
    readonly profileRevision: number; readonly profileDigest: string; readonly permitId: string;
  }): Promise<AppLaunchVerification>;
}
export interface EnvironmentAppService {
  readonly registry: EnvironmentAppRegistry;
  readonly discovery?: EnvironmentAppDiscovery;
  readonly launcher?: EnvironmentAppLauncher;
  readonly onboarding?: EnvironmentAppOnboarding;
}
export interface EnvironmentAppServices {
  forEnvironment(target: TaskDesktopTarget): EnvironmentAppService;
}
/** Deliberately excludes paths, arguments, installation details and launch receipts. */
export interface ModelAppView {
  readonly appBindingId: string;
  readonly applicationId: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly profileRevision: number;
  readonly trust: EnvironmentAppBinding['trust'];
  readonly validity: EnvironmentAppBinding['validity'];
  readonly availability: EnvironmentAppBinding['availability'];
}
