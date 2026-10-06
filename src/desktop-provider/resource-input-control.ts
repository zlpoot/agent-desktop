import { randomUUID } from "node:crypto";
import type { DesktopSessionIdentity } from "../contracts/desktop-environment.js";
import type { DesktopInputArbiter, InputAuthority, InputClient } from "../contracts/desktop-input-control.js";
import { deny, sameSession } from "./admission.js";
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
  blockedGeneration: number;
}
interface Participant {
  validate(binding: DesktopSessionIdentity): boolean;
  drain(authority: InputAuthority, successor?: InputAuthority): Promise<void>;
  activate?: (authority: InputAuthority) => Promise<void>;
}

/** In-process managed-client arbiter; backend gates and authenticated infrastructure remain mandatory.
 * One shared object must be injected for all Sessions/providers aliasing a resource.
 * A monotonic clock and bounded lease are injected; no timers or physical input. */
export class ResourceInputControl implements DesktopInputArbiter {
  private readonly resources = new Map<string, Resource>();
  private readonly participants = new Set<Participant>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly leaseMs = 3000) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Invalid input lease");
  }
  registerBackend(validate: (binding: DesktopSessionIdentity) => boolean,
    drain: (authority: InputAuthority, successor?: InputAuthority) => Promise<void>,
    activate?: (authority: InputAuthority) => Promise<void>): void {
    this.participants.add({ validate, drain, activate });
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
    if (![...this.participants].some(participant => participant.validate(binding))) deny("stale-session");
  }
  private resource(id: string): Resource {
    let resource = this.resources.get(id);
    if (!resource) {
      resource = { epoch: 0, expiresAt: 0, serial: Promise.resolve(), blocked: false, blockedGeneration: 0 };
      this.resources.set(id, resource);
    }
    return resource;
  }
  private exclusive<T>(resource: Resource, work: () => Promise<T>): Promise<T> {
    const result = resource.serial.then(work);
    resource.serial = result.then(() => {}, () => {});
    return result;
  }
  private authority(binding: DesktopSessionIdentity, owner: InputClient, epoch: number): InputAuthority {
    if (!binding.inputResourceId) deny("observation-only");
    if (!["agent", "human"].includes(owner.kind) || !owner.clientId.trim()) deny("invalid-owner");
    return Object.freeze({ ...sessionIdentity(binding), inputResourceId: binding.inputResourceId,
      owner: Object.freeze({ ...owner }), epoch, grantId: randomUUID() });
  }
  private async install(resource: Resource, authority: InputAuthority): Promise<InputAuthority> {
    this.valid(authority);
    const generation = resource.blockedGeneration;
    resource.grant = authority; resource.epoch = authority.epoch; resource.expiresAt = this.now() + this.leaseMs;
    resource.blocked = true; // The next owner is not usable until every matching backend ACKs activation.
    const failures: unknown[] = [];
    for (const participant of this.participants) if (participant.activate && participant.validate(authority)) {
      try { await participant.activate(authority); }
      catch (error) { failures.push(error); }
    }
    try {
      this.valid(authority);
      if (resource.blockedGeneration !== generation || resource.expiresAt <= this.now())
        deny("resource-drain-unconfirmed");
    } catch (error) { failures.push(error); }
    if (failures.length) {
      resource.grant = undefined; resource.expiresAt = -Infinity; resource.epoch++; // Never retry this epoch.
      for (const participant of this.participants) {
        try { await participant.drain(authority); }
        catch (error) { failures.push(error); }
      }
      throw new AggregateError(failures, "Input backend activation unconfirmed; resource permanently blocked");
    }
    resource.blocked = false;
    return authority;
  }
  private async revoke(resource: Resource, successor?: InputAuthority): Promise<void> {
    const generation = resource.blockedGeneration;
    const previous = resource.grant;
    // Disable both owners before drain. Failure permanently blocks new grants until explicit infrastructure recovery.
    resource.grant = undefined; resource.epoch++; resource.blocked = true;
    const failures: unknown[] = [];
    if (previous) for (const participant of this.participants) {
      try { await participant.drain(previous, successor); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Input resource drain failed");
    if (resource.blockedGeneration !== generation) deny("resource-drain-unconfirmed");
    resource.blocked = false;
  }
  private grant(resource: Resource, binding: DesktopSessionIdentity, owner: InputClient): InputAuthority {
    this.valid(binding);
    return this.authority(binding, owner, ++resource.epoch);
  }
  acquire(binding: DesktopSessionIdentity, owner: InputClient): Promise<InputAuthority> {
    if (!binding.inputResourceId) return Promise.reject(new Error("observation-only"));
    const resource = this.resource(binding.inputResourceId);
    return this.exclusive(resource, async () => {
      this.valid(binding);
      if (resource.blocked) deny("resource-drain-unconfirmed");
      if (resource.grant && this.now() >= resource.expiresAt) {
        const next = this.authority(binding, owner, resource.epoch + 2);
        await this.revoke(resource, next);
        return this.install(resource, next);
      }
      if (resource.grant) deny("input-resource-busy");
      return this.install(resource, this.grant(resource, binding, owner));
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
      const next = this.authority(authority, owner, resource.epoch + 2);
      await this.revoke(resource, next);
      return this.install(resource, next);
    });
  }
  /** Trusted management handshake deadline; action requests cannot extend the lease. */
  remainingLease(authority: InputAuthority): number {
    this.assertAuthority(authority, authority);
    return this.resources.get(authority.inputResourceId)!.expiresAt - this.now();
  }
  renewAuthority(authority: InputAuthority): void {
    this.assertAuthority(authority, authority);
    this.resources.get(authority.inputResourceId)!.expiresAt = this.now() + this.leaseMs;
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
  blockResource(binding: DesktopSessionIdentity): void {
    if (!binding.inputResourceId) return;
    const resource = this.resource(binding.inputResourceId);
    resource.grant = undefined;
    resource.expiresAt = -Infinity;
    resource.epoch++;
    resource.blocked = true;
    resource.blockedGeneration++;
  }
}
