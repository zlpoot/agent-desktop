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
