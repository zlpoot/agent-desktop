import { randomUUID } from "node:crypto";
import type { Observation } from "../actions/schema.js";
import type { DesktopCapabilities, DesktopProvider, DesktopSession, DesktopSessionIdentity,
  DesktopSessionStatus } from "../contracts/desktop-environment.js";
import type { DesktopInputArbiter, InputAuthority } from "../contracts/desktop-input-control.js";
import { DesktopRuntime, PhysicalWorkerTransportError, type DesktopRuntimeOptions, type PhysicalHandshake,
  type PhysicalInputPolicy, type WindowFilter, type WindowInfo } from "../runtime/desktop/desktop-runtime.js";
import type { VisionDesktopRuntime } from "../runtime/desktop/vision-runtime.js";
import { DesktopAdmissionError, deny, sameSession } from "./admission.js";

/** Trusted local backend management surface, separate from runtime/Viewer clients. */
export interface PhysicalBackend extends VisionDesktopRuntime {
  physicalHandshake(policy: PhysicalInputPolicy): Promise<PhysicalHandshake>;
  grantPhysical(authority: InputAuthority, expiresAt: number): Promise<void>;
  renewPhysical?(authority: InputAuthority, expiresAt: number): Promise<void>;
  revokePhysical(authority: InputAuthority): Promise<void>;
  bindPhysical(options: DesktopRuntimeOptions): Promise<void>;
  windowsPhysical(filter?: WindowFilter): Promise<WindowInfo[]>;
}
export interface PhysicalInputArbiter extends DesktopInputArbiter {
  remainingLease(authority: InputAuthority): number;
}
export type PhysicalBackendFactory = (policy: PhysicalInputPolicy) => Promise<PhysicalBackend>;
export interface PhysicalBoundRuntime extends VisionDesktopRuntime {
  heartbeat(): Promise<void>;
  attach(options: DesktopRuntimeOptions): Promise<void>;
  listWindows(filter?: WindowFilter): Promise<WindowInfo[]>;
}
interface Binding {
  identity: DesktopSessionIdentity;
  state: DesktopSessionStatus["state"];
  cleanup?: Promise<void>;
}
interface ActiveRuntime { binding: Binding; authority: InputAuthority; close(): Promise<void>; }
const closedPolicy: PhysicalInputPolicy = { windowManagement: false, executors: [] };

/** One managed local Worker, one shared actual-desktop arbiter. Hardware input is outside this broker. */
export class PhysicalDesktopProvider implements DesktopProvider {
  readonly id = "physical";
  readonly kind = "physical" as const;
  readonly inputControl: PhysicalInputArbiter;
  private readonly policy: PhysicalInputPolicy;
  private readonly bindings = new Map<string, Binding>();
  private connection?: Promise<PhysicalBackend>;
  private backend?: PhysicalBackend;
  private handshake?: PhysicalHandshake;
  private serial: Promise<void> = Promise.resolve();
  private active?: ActiveRuntime;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly input: PhysicalInputArbiter,
    private readonly factory: PhysicalBackendFactory = policy => DesktopRuntime.connectPhysical(policy),
    policy: PhysicalInputPolicy = closedPolicy, private readonly available = process.platform === "win32") {
    if (typeof policy.windowManagement !== "boolean" || !Array.isArray(policy.executors) ||
      policy.executors.some(executor => typeof executor !== "string" || !executor.trim())) throw new Error("Invalid physical input policy");
    this.policy = Object.freeze({ windowManagement: policy.windowManagement, executors: Object.freeze([...policy.executors]) });
    this.inputControl = input;
    input.registerBackend(identity => this.valid(identity), async authority => {
      if (this.active && sameSession(this.active.authority, authority) && this.active.authority.grantId === authority.grantId) {
        await this.active.close();
      }
    });
  }
  async capabilities(): Promise<DesktopCapabilities> {
    const declaration = (state: "supported" | "unsupported" | "not-proven" | "forbidden", mechanism: string) => ({
      state, scope: { providerId: [this.id], environmentKind: [this.kind], mechanism: [mechanism] },
      evidence: [{ source: "physical-provider.ts + physical_context.py + physical_gate.py",
        description: "Managed local implementation; no live Windows/application or hardware-human concurrency acceptance" }],
    });
    return {
      "observation.pixels": [declaration("supported", "local-window")],
      "observation.accessibility": [declaration("not-proven", "local-uia")],
      "isolation.separateDesktop": [declaration("unsupported", "physical-context")],
      "isolation.separateOs": [declaration("unsupported", "physical-context")],
      "isolation.sharedUserSession": [declaration("supported", "physical-context")],
      "input.rawIsolated": [declaration("unsupported", "physical-context")],
      "input.semantic": [declaration("not-proven", "local-uia")],
      "input.targetedWindow": [declaration("not-proven", "local-window")],
      // Explicit policy permission is not evidence that an application or parallel human use is safe.
      "input.globalInput": [declaration(this.policy.executors.length ? "not-proven" : "forbidden", "physical-policy")],
      "control.humanTakeover": [declaration("supported", "managed-client")],
      "control.resumable": [declaration("supported", "managed-client")],
      "control.leaseProtected": [declaration("supported", "managed-client")],
    };
  }
  async discover() {
    if (this.closed) deny("provider-closed");
    return this.available ? [{ providerId: this.id, environmentId: "current-interactive-desktop", kind: this.kind }] : [];
  }
  private valid(identity: DesktopSessionIdentity): boolean {
    const record = this.bindings.get(identity.sessionId);
    return !this.closed && !!record && record.state === "open" && sameSession(identity, record.identity);
  }
  private record(identity: DesktopSessionIdentity): Binding {
    if (!this.valid(identity)) deny("stale-session");
    return this.bindings.get(identity.sessionId)!;
  }
  private invalidate(): void {
    for (const record of this.bindings.values()) if (record.state === "open") {
      record.state = "stale"; void this.cleanup(record).catch(() => {});
    }
  }
  private check(value: PhysicalHandshake, requireReady = true): void {
    if (!value || typeof value.instanceId !== "string" || !value.instanceId ||
      typeof value.inputResourceId !== "string" || !value.inputResourceId || typeof value.ready !== "boolean") {
      this.invalidate(); deny("incompatible-physical-backend");
    }
    if (this.handshake && (this.handshake.instanceId !== value.instanceId ||
      this.handshake.inputResourceId !== value.inputResourceId)) {
      this.invalidate(); deny("physical-instance-changed");
    }
    if (requireReady && !value.ready) deny("physical-not-ready");
  }
  private async inspect(backend: PhysicalBackend, requireReady = true): Promise<PhysicalHandshake> {
    try {
      const value = await backend.physicalHandshake(this.policy); this.check(value, requireReady); return value;
    } catch (error) {
      if (!(error instanceof DesktopAdmissionError) || error.reason !== "physical-not-ready") this.invalidate();
      throw error;
    }
  }
  private async connect(): Promise<PhysicalBackend> {
    if (!this.available || this.closed) deny("physical-unavailable");
    return this.connection ??= this.factory(this.policy).then(async backend => {
      this.backend = backend;
      const value = await this.inspect(backend, false);
      this.handshake = Object.freeze({ ...value }); return backend;
    });
  }
  private async fresh(record: Binding): Promise<PhysicalBackend> {
    this.record(record.identity);
    const backend = await this.connect();
    await this.inspect(backend);
    this.record(record.identity); return backend;
  }
  async open(id: string): Promise<DesktopSession> {
    if (id !== "current-interactive-desktop") deny("unknown-physical-environment");
    const backend = await this.connect(); await this.inspect(backend);
    if (this.closed) deny("provider-closed");
    const identity = Object.freeze({ providerId: this.id, environmentId: id, sessionId: randomUUID(),
      instanceId: this.handshake!.instanceId, inputResourceId: this.handshake!.inputResourceId });
    const record: Binding = { identity, state: "open" }; this.bindings.set(identity.sessionId, record);
    return Object.freeze({ ...identity,
      capabilities: async () => { this.record(identity); return this.capabilities(); },
      status: async () => {
        let ready = false;
        if (record.state === "open") { try { await this.fresh(record); ready = true; } catch { /* status reports unavailable */ } }
        const capabilities = await this.capabilities(); ready = ready && record.state === "open" && !this.closed;
        return { state: record.state, readiness: Object.fromEntries(Object.entries(capabilities).map(([key, values]) =>
          [key, { state: !ready ? "not-ready" as const : values.every(item => item.state === "supported") ? "ready" as const : "unknown" as const }])) };
      },
      close: async () => { record.state = "closed"; await this.cleanup(record); },
    });
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work); this.serial = result.then(() => {}, () => {}); return result;
  }
  /** Compatibility runtime factory, invoked only by trusted infrastructure with a broker-issued grant. */
  connectRuntime(session: DesktopSession, authority: InputAuthority, artifactDir: string,
    onClosing?: () => void): Promise<PhysicalBoundRuntime> {
    const record = this.record(session);
    this.input.assertAuthority(session, authority);
    if (authority.owner.kind !== "agent") deny("agent-authority-required");
    if (this.active) deny("physical-runtime-busy");
    let closed = false, bound = false, observed = false;
    let installed = false, closing: Promise<void> | undefined;
    const observations = new WeakSet<Observation>();
    const call = <T>(work: (backend: PhysicalBackend) => Promise<T>) => this.enqueue(async () => {
      if (closed) deny("physical-runtime-closed");
      const backend = await this.fresh(record);
      this.input.assertAuthority(session, authority);
      if (closed) deny("physical-runtime-closed");
      try { return await work(backend); }
      catch (error) {
        if (error instanceof PhysicalWorkerTransportError ||
          error instanceof Error && /Physical Worker instance\/resource changed/.test(error.message)) this.invalidate();
        throw error;
      }
    });
    const requireObserved = () => { if (!bound || !observed) deny("physical-rebind-and-observe-required"); };
    const runtime: PhysicalBoundRuntime = {
      heartbeat: () => call(async backend => {
        if (!backend.renewPhysical || !this.input.renewAuthority) deny('physical-task-renewal-unavailable');
        // A live handshake and still-valid full authority are required. Expired grants never revive.
        this.input.renewAuthority(authority);
        try { await backend.renewPhysical(authority, Date.now() + this.input.remainingLease(authority)); }
        catch (error) { this.invalidate(); throw error; }
        this.input.assertAuthority(session, authority);
      }),
      listWindows: filter => call(backend => backend.windowsPhysical(filter)),
      attach: options => call(async backend => {
        if (!this.policy.windowManagement) deny("physical-window-management-forbidden");
        bound = observed = false; await backend.bindPhysical({ ...options, artifactDir }); bound = true;
      }),
      observe: capture => call(async backend => {
        if (!bound) deny("physical-rebind-required");
        const observation = await backend.observe(capture); observations.add(observation); observed = true; return observation;
      }),
      probe: focus => call(backend => {
        if (focus && !this.policy.windowManagement) deny("physical-window-management-forbidden");
        return backend.probe(focus);
      }),
      recoverFocus: () => call(async backend => {
        if (!this.policy.windowManagement) deny("physical-window-management-forbidden");
        await backend.recoverFocus();
      }),
      ground: action => call(backend => { requireObserved(); return backend.ground(action); }),
      resolveAction: action => call(backend => { requireObserved(); return backend.resolveAction(action); }),
      execute: (action, resolution) => call(async backend => {
        requireObserved();
        if (!resolution?.selected || !resolution.candidates.some(candidate => candidate.available && candidate.provider === resolution.selected)) deny("missing-physical-executor");
        if (!["wait", "screenshot"].includes(action.kind) && !this.policy.executors.includes(resolution.selected)) deny("physical-global-input-forbidden");
        // A candidate list must never authorize a fallback outside the explicit selected policy.
        const selected = { ...resolution, candidates: resolution.candidates.filter(candidate => candidate.provider === resolution.selected && candidate.available) };
        observed = false; const result = await backend.execute(action, selected);
        if (result.observation) { observations.add(result.observation); observed = true; } return result;
      }),
      restore: observation => call(async backend => {
        if (!this.policy.windowManagement) deny("physical-window-management-forbidden");
        if (!observations.has(observation)) deny("stale-physical-observation");
        observed = false; await backend.restore(observation); bound = true;
      }),
      close: () => closing ??= (async () => {
        closed = true;
        onClosing?.();
        await this.enqueue(async () => { if (installed) await this.backend!.revokePhysical(authority); });
        if (this.active === active) this.active = undefined;
      })(),
    };
    const active: ActiveRuntime = { binding: record, authority, close: runtime.close }; this.active = active;
    return this.enqueue(async () => {
      const backend = await this.fresh(record); this.input.assertAuthority(session, authority);
      if (closed) deny("physical-runtime-closed");
      // Mark before sending: a lost ACK is an unconfirmed grant that still needs forced revoke.
      installed = true;
      await backend.grantPhysical(authority, Date.now() + this.input.remainingLease(authority));
      this.record(session); this.input.assertAuthority(session, authority); return runtime;
    }).catch(async error => {
      if (error instanceof PhysicalWorkerTransportError ||
        error instanceof Error && /Physical Worker instance\/resource changed/.test(error.message)) this.invalidate();
      await runtime.close(); throw error;
    });
  }
  private cleanup(record: Binding): Promise<void> {
    return record.cleanup ??= this.input.revokeSession(record.identity);
  }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.closed = true;
    for (const record of this.bindings.values()) record.state = "closed";
    const results = await Promise.allSettled([...this.bindings.values()].map(record => this.cleanup(record)));
    if (this.connection) await this.connection.catch(() => {});
    await this.serial;
    try { await this.backend?.close(); }
    finally {
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Physical resource cleanup unconfirmed");
    }
  }
}
