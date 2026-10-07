import type {
  DesktopCapabilities, DesktopCapability, DesktopObservationBinding, DesktopReadiness,
  DesktopTargetBinding,
} from './desktop-environment.js';
import type { InputAuthority } from './desktop-input-control.js';

/** Backend-issued target identity. Native handles, endpoints and grants stay out of it.
 * Application/version/role come from trusted binding, never planner or Viewer labels. */
export interface TargetBinding extends DesktopTargetBinding {
  readonly application: string;
  readonly applicationVersion: string;
  readonly targetRole: string;
}
export interface DesktopTargetStatus {
  readonly binding: TargetBinding;
  readonly state: 'bound' | 'stale' | 'closed';
  readonly capabilities: DesktopCapabilities;
  readonly readiness: DesktopReadiness;
}
/** Trusted executor describes the actual operation, including every possible input mechanism.
 * A fallback needs its own admission; it cannot inherit a selected mechanism's proof. */
export interface DesktopExecutionRequirements {
  readonly action: string;
  readonly mechanism: string;
  readonly required: readonly DesktopCapability[];
}
export interface DesktopExecutionRequest<Action> {
  readonly target: TargetBinding;
  readonly observation: DesktopObservationBinding;
  readonly action: Action;
  readonly authority: InputAuthority;
}
/** Composition-owned runtime port, deliberately separate from Provider management.
 * bind must uniquely validate the target; status must check current backend identity.
 * targetStatus and requirements are read-only preflight ports: they require no input
 * authority and must not acquire/renew input, consume observations or produce effects.
 * execute MUST independently repeat identity, observation freshness/consumption, authority,
 * requirements, all capability layers and readiness at effect time (including queued work).
 * Host admission is not an authorization token and must never bypass native fences. */
export interface DesktopExecutionBackend<Action, Result> {
  bind(selector: string): Promise<TargetBinding>;
  targetStatus(binding: TargetBinding): Promise<DesktopTargetStatus>;
  requirements(binding: TargetBinding, action: Action): Promise<DesktopExecutionRequirements>;
  execute(request: DesktopExecutionRequest<Action>): Promise<Result>;
}
