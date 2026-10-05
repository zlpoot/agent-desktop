import { randomUUID } from "node:crypto";
import type { DesktopSessionIdentity } from "../contracts/desktop-environment.js";
import type { DesktopInputControl, InputAuthority, InputClient } from "../contracts/desktop-input-control.js";
import { deny } from "./admission.js";

export function sameSession(a: DesktopSessionIdentity, b: DesktopSessionIdentity): boolean {
  return a.providerId === b.providerId && a.environmentId === b.environmentId &&
    a.sessionId === b.sessionId && a.instanceId === b.instanceId && a.inputResourceId === b.inputResourceId;
}
function sessionIdentity(binding: DesktopSessionIdentity): DesktopSessionIdentity {
  return { providerId: binding.providerId, environmentId: binding.environmentId,
    sessionId: binding.sessionId, instanceId: binding.instanceId, inputResourceId: binding.inputResourceId };
}
interface Resource {
  epoch: number;
  grant?: InputAuthority;
  expiresAt: number;
  serial: Promise<void>;
  blocked: boolean;
}

/** Deterministic in-memory arbiter for P1 fixtures, not a production control adapter.
 * One shared object must be injected for all Sessions/providers aliasing a resource.
 * A monotonic clock and bounded lease are injected; no timers or physical input. */
export class FakeInputControl implements DesktopInputControl {
  private readonly resources = new Map<string, Resource>();
  private readonly validators = new Set<(binding: DesktopSessionIdentity) => boolean>();
  private readonly drains = new Set<(authority: InputAuthority) => Promise<void>>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly leaseMs = 3000) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Invalid fake lease");
  }
  registerBackend(validate: (binding: DesktopSessionIdentity) => boolean,
    drain: (authority: InputAuthority) => Promise<void>): void {
    this.validators.add(validate); this.drains.add(drain);
  }
  /** Viewer-safe snapshot: observing another owner never reveals its grant credential. */
  view(binding: DesktopSessionIdentity): { epoch: number; owner?: InputClient; state: "idle" | "held" | "expired" | "revoking" } {
    this.valid(binding);
    if (!binding.inputResourceId) return { epoch: 0, state: "idle" };
    const resource = this.resource(binding.inputResourceId);
    return { epoch: resource.epoch, owner: resource.grant && { ...resource.grant.owner },
      state: resource.blocked ? "revoking" : !resource.grant ? "idle" :
        this.now() >= resource.expiresAt ? "expired" : "held" };
  }
  private valid(binding: DesktopSessionIdentity): void {
    if (![...this.validators].some(validate => validate(binding))) deny("stale-session");
  }
  private resource(id: string): Resource {
    let resource = this.resources.get(id);
    if (!resource) {
      resource = { epoch: 0, expiresAt: 0, serial: Promise.resolve(), blocked: false };
      this.resources.set(id, resource);
    }
    return resource;
  }
  private exclusive<T>(resource: Resource, work: () => Promise<T>): Promise<T> {
    const result = resource.serial.then(work);
    resource.serial = result.then(() => {}, () => {});
    return result;
  }
  private async revoke(resource: Resource): Promise<void> {
    const previous = resource.grant;
    // Disable both owners before drain. Failure permanently blocks new grants in this fixture.
    resource.grant = undefined; resource.epoch++; resource.blocked = true;
    if (previous) for (const drain of this.drains) await drain(previous);
    resource.blocked = false;
  }
  private grant(resource: Resource, binding: DesktopSessionIdentity, owner: InputClient): InputAuthority {
    this.valid(binding);
    if (!binding.inputResourceId) deny("observation-only");
    if (!["agent", "human"].includes(owner.kind) || !owner.clientId.trim()) deny("invalid-owner");
    const authority: InputAuthority = Object.freeze({ ...sessionIdentity(binding), inputResourceId: binding.inputResourceId,
      owner: Object.freeze({ ...owner }), epoch: ++resource.epoch, grantId: randomUUID() });
    resource.grant = authority; resource.expiresAt = this.now() + this.leaseMs;
    return authority;
  }
  acquire(binding: DesktopSessionIdentity, owner: InputClient): Promise<InputAuthority> {
    if (!binding.inputResourceId) return Promise.reject(new Error("observation-only"));
    const resource = this.resource(binding.inputResourceId);
    return this.exclusive(resource, async () => {
      this.valid(binding);
      if (resource.blocked) deny("resource-drain-unconfirmed");
      if (resource.grant && this.now() >= resource.expiresAt) await this.revoke(resource);
      if (resource.grant) deny("input-resource-busy");
      return this.grant(resource, binding, owner);
    });
  }
  assertAuthority(binding: DesktopSessionIdentity, authority: InputAuthority): void {
    this.valid(binding);
    const resource = this.resources.get(authority.inputResourceId);
    const current = resource?.grant;
    if (!current || resource!.blocked || this.now() >= resource!.expiresAt || !sameSession(binding, authority) ||
      !sameSession(current, authority) || current.epoch !== authority.epoch || current.grantId !== authority.grantId ||
      current.owner.kind !== authority.owner.kind || current.owner.clientId !== authority.owner.clientId) {
      deny("invalid-input-authority");
    }
  }
  transfer(authority: InputAuthority, owner: InputClient): Promise<InputAuthority> {
    const resource = this.resource(authority.inputResourceId);
    return this.exclusive(resource, async () => {
      this.assertAuthority(authority, authority);
      await this.revoke(resource);
      return this.grant(resource, authority, owner);
    });
  }
  release(authority: InputAuthority): Promise<void> {
    const resource = this.resource(authority.inputResourceId);
    return this.exclusive(resource, async () => {
      this.assertAuthority(authority, authority);
      await this.revoke(resource);
    });
  }
  /** Close/replacement/disconnect does not need a still-valid lease to revoke it. */
  revokeSession(binding: DesktopSessionIdentity): Promise<void> {
    if (!binding.inputResourceId) return Promise.resolve();
    const resource = this.resource(binding.inputResourceId);
    // Invalidate immediately, even if a previous transfer is draining.
    if (resource.grant && sameSession(resource.grant, binding)) resource.expiresAt = -Infinity;
    return this.exclusive(resource, async () => {
      if (resource.blocked) deny("resource-drain-unconfirmed");
      if (resource.grant && sameSession(resource.grant, binding)) await this.revoke(resource);
    });
  }
}
