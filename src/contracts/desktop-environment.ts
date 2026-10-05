/** Environment contract. Legacy task/transport consumers migrate through compatibility adapters. */
export type DesktopEnvironmentKind = "physical" | "virtual-machine" | "local-workspace";
export type CapabilityState = "supported" | "unsupported" | "not-proven" | "forbidden";
export type DesktopCapability =
  | "observation.pixels" | "observation.accessibility"
  | "input.targetedWindow" | "input.semantic" | "input.rawIsolated" | "input.globalInput"
  | "control.humanTakeover" | "control.resumable" | "control.leaseProtected"
  | "isolation.separateDesktop" | "isolation.separateOs" | "isolation.sharedUserSession";

/** Exact allowlists; omitted dimensions are unconstrained, empty scopes cannot grant support.
 * Version ranges/predicates are deliberately deferred; a version string matches exactly. */
export interface CapabilityContext {
  readonly providerId: string;
  readonly environmentKind: DesktopEnvironmentKind;
  readonly application: string;
  readonly applicationVersion: string;
  readonly targetRole: string;
  readonly action: string;
  readonly mechanism: string;
}
export type CapabilityScope = Readonly<Partial<Record<keyof CapabilityContext, readonly string[]>>>;
export interface CapabilityEvidence {
  readonly source: string;
  readonly description: string;
}
export interface CapabilityDeclaration {
  readonly state: CapabilityState;
  readonly scope: CapabilityScope;
  readonly evidence?: readonly CapabilityEvidence[];
}
export type DesktopCapabilities = Readonly<Partial<Record<DesktopCapability, readonly CapabilityDeclaration[]>>>;
export interface CapabilityReadiness {
  readonly state: "ready" | "not-ready" | "unknown";
  readonly reason?: string;
}
export type DesktopReadiness = Readonly<Partial<Record<DesktopCapability, CapabilityReadiness>>>;

export interface DesktopSessionIdentity {
  readonly providerId: string;
  readonly environmentId: string;
  readonly sessionId: string;
  /** Established by backend handshake; replacement creates a new Session, never edits this. */
  readonly instanceId: string;
  /** Opaque actual input resource; null means observation-only. Not a Session exclusivity key. */
  readonly inputResourceId: string | null;
}
export interface DesktopEnvironment {
  readonly providerId: string;
  readonly environmentId: string;
  readonly kind: DesktopEnvironmentKind;
}
export interface DesktopSessionStatus {
  readonly state: "open" | "stale" | "closed";
  readonly readiness: DesktopReadiness;
}
export interface DesktopSession extends DesktopSessionIdentity {
  capabilities(): Promise<DesktopCapabilities>;
  status(): Promise<DesktopSessionStatus>;
  /** Idempotent release of this binding and authority; never destroys unrelated resources. */
  close(): Promise<void>;
}
export interface DesktopProvider {
  readonly id: string;
  readonly kind: DesktopEnvironmentKind;
  capabilities(): Promise<DesktopCapabilities>;
  discover(): Promise<readonly DesktopEnvironment[]>;
  open(environmentId: string): Promise<DesktopSession>;
}

/** Runtime-owned, opaque target identity. Backend keeps native handles behind this contract. */
export interface DesktopTargetBinding extends DesktopSessionIdentity {
  readonly targetId: string;
}
export interface DesktopObservationBinding extends DesktopTargetBinding {
  readonly observationId: string;
}
