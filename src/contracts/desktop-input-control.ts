import type { DesktopSessionIdentity } from "./desktop-environment.js";

export interface InputClient {
  readonly kind: "agent" | "human";
  readonly clientId: string;
}
export interface InputAuthority extends DesktopSessionIdentity {
  readonly inputResourceId: string;
  readonly owner: InputClient;
  /** Resource-arbiter generation, shared by every Session/Viewer on this resource. */
  readonly epoch: number;
  /** Opaque grant identity; knowing the current epoch is insufficient to obtain authority. */
  readonly grantId: string;
}
/** Independent of Provider. Promise completion is the revoke/drain/ACK boundary.
 * Implementations must authenticate clients and enforce these checks at the backend too. */
export interface DesktopInputControl {
  acquire(binding: DesktopSessionIdentity, owner: InputClient): Promise<InputAuthority>;
  transfer(authority: InputAuthority, owner: InputClient): Promise<InputAuthority>;
  release(authority: InputAuthority): Promise<void>;
  assertAuthority(binding: DesktopSessionIdentity, authority: InputAuthority): void;
}

/** Trusted backend/lifecycle surface, separate from authority-holding clients.
 * Share one arbiter for all aliases of the same actual input resource. */
export interface DesktopInputArbiter extends DesktopInputControl {
  /** Register backend identity validation and revoke/drain participation.
   * Every participant must be attempted on revocation, even if another fails.
   * Any failure rejects the ACK and leaves the resource blocked. */
  registerBackend(validate: (binding: DesktopSessionIdentity) => boolean,
    drain: (authority: InputAuthority) => Promise<void>): void;
  /** System close/disconnect/instance replacement: does not require a valid grant.
   * Immediately disables authority for this binding, then awaits drain/ACK.
   * Must not revoke another Session's authority or clear an unconfirmed drain. */
  revokeSession(binding: DesktopSessionIdentity): Promise<void>;
}
