import { createHash, randomUUID } from "node:crypto";
import type { Observation, ActionResult } from "../actions/schema.js";
import type { DesktopCapabilities, DesktopProvider, DesktopReadiness, DesktopSession,
  DesktopSessionIdentity, DesktopSessionStatus } from "../contracts/desktop-environment.js";
import type { InputControl, LegacyDesktopProvider } from "../contracts/desktop-provider.js";
import type { WorkerClient } from "../contracts/worker-client.js";
import { WorkerConnectionError } from "../contracts/worker-error.js";
import type { DesktopControl } from "../desktop-session/control.js";
import { GuestDesktopRuntime } from "../runtime/desktop/guest-runtime.js";
import { deny, sameSession } from "./admission.js";

type LegacyControl = Pick<DesktopControl, "reconnect" | "view" | "connectionIdentity" |
  "assertTaskAllowed" | "beginTask" | "finishTask" | "agentEpoch">;
interface Source { legacyId: string; control: LegacyControl; }
interface RecordBinding {
  identity: DesktopSessionIdentity;
  source: Source;
  vmId: string;
  endpoint: string;
  recoveryEpoch: string;
  state: DesktopSessionStatus["state"];
  taskId?: string;
  begun?: boolean;
  release?: Promise<boolean>;
  pending: Set<Promise<unknown>>;
  runtimes: Set<WorkerClient>;
  cleanup?: Promise<void>;
}
const key = (value: string) => createHash("sha256").update(value).digest("hex");
const environmentId = (vmId: string) => `vm:${vmId.toLowerCase()}`;

/** Infrastructure-only bridge. It reuses the one existing DesktopControl/Guest gate,
 * never creates an independent resource arbiter or infers app support from RPC flags.
 * The old task routing/Viewer/VM management remain compatibility consumers until P5. */
export class HyperVDesktopProvider implements DesktopProvider {
  readonly id = "hyper-v";
  readonly kind = "virtual-machine" as const;
  private readonly sources = new Map<string, Source>();
  private readonly bindings = new Map<string, RecordBinding>();
  private readonly owners = new Map<string, RecordBinding>();
  private readonly observations = new WeakMap<Observation, string>();
  private closed = false;
  constructor(private readonly legacy: LegacyDesktopProvider, private readonly token: string) {}

  async capabilities(): Promise<DesktopCapabilities> {
    const declaration = (state: "supported" | "not-proven" | "forbidden", mechanism?: string) => ({
      state, scope: { providerId: [this.id], environmentKind: [this.kind], ...(mechanism ? { mechanism: [mechanism] } : {}) },
      evidence: [{ source: "src/desktop-session/control.ts + guest/action-worker.py",
        description: "Existing protocol/control implementation guarantee only; not application or live VM acceptance" }],
    });
    return {
      "observation.pixels": [declaration("supported", "guest-frame")],
      "observation.accessibility": [declaration("not-proven")],
      "input.semantic": [declaration("not-proven")],
      "input.targetedWindow": [declaration("not-proven")],
      "input.rawIsolated": [declaration("not-proven")],
      "input.globalInput": [declaration("forbidden", "host-global-fallback")],
      "control.humanTakeover": [declaration("supported", "legacy-control")],
      "control.resumable": [declaration("supported", "legacy-control")],
      "control.leaseProtected": [declaration("supported", "legacy-control")],
      // A configured vm_id and an authenticated Worker do not prove an OS isolation claim.
      "isolation.separateOs": [declaration("not-proven")],
      "isolation.separateDesktop": [declaration("not-proven")],
      "isolation.sharedUserSession": [declaration("not-proven")],
    };
  }
  async discover() {
    if (this.closed) deny("provider-closed");
    return [...new Set(this.legacy.list().map(row => environmentId(row.vmId)))].sort()
      .map(id => ({ providerId: this.id, environmentId: id, kind: this.kind }));
  }
  /** Called by infrastructure scope wiring; no network or new control state machine. */
  registerControl(legacyId: string, control: LegacyControl): () => Promise<void> {
    if (this.closed) deny("provider-closed");
    const previous = this.sources.get(legacyId);
    if (previous) this.invalidate(previous);
    const source = { legacyId, control };
    this.sources.set(legacyId, source);
    return async () => {
      if (this.sources.get(legacyId) === source) this.sources.delete(legacyId);
      this.invalidate(source);
      const results = await Promise.allSettled([...this.bindings.values()]
        .filter(record => record.source === source).map(record => this.cleanup(record)));
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Compatibility Session cleanup unconfirmed");
    };
  }
  private invalidate(source: Source): void {
    for (const record of this.bindings.values()) if (record.source === source && record.state === "open") {
      record.state = "stale";
      void this.cleanup(record).catch(() => {}); // Repeated close/unregister still reports the same failure.
    }
  }
  private record(session: DesktopSessionIdentity): RecordBinding {
    const record = this.bindings.get(session.sessionId);
    if (!record || !sameSession(record.identity, session) || record.state !== "open" || this.closed) deny("stale-session");
    return record;
  }
  private controlsFor(id: string): Source[] {
    return [...this.sources.values()].filter(source => {
      const row = this.legacy.get(source.legacyId);
      return row && environmentId(row.vmId) === id;
    });
  }
  private async state(source: Source) {
    const row = this.legacy.get(source.legacyId);
    if (!row || !this.token) deny("missing-worker-configuration");
    const response = await fetch(`${row.workerEndpoint}/state`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) deny("worker-unavailable");
    const value = await response.json() as { vm_id?: string; recovery_epoch?: string; action_rpc?: boolean;
      control_rpc?: boolean; recovery_rpc?: boolean; control_epoch_rpc?: boolean; action_id_rpc?: boolean;
      ready_for_observation?: boolean; ready_for_input?: boolean };
    if (value.vm_id !== row.vmId || !value.recovery_epoch || typeof value.recovery_epoch !== "string" ||
      value.action_rpc !== true || value.control_rpc !== true || value.recovery_rpc !== true ||
      value.control_epoch_rpc !== true || value.action_id_rpc !== true ||
      typeof value.ready_for_observation !== "boolean" || typeof value.ready_for_input !== "boolean") deny("incompatible-worker");
    return { row, value };
  }
  private async fresh(record: RecordBinding): Promise<void> {
    this.record(record.identity);
    const row = this.legacy.get(record.source.legacyId);
    const controls = this.controlsFor(record.identity.environmentId);
    if (controls.length !== 1 || this.sources.get(record.source.legacyId) !== record.source || !row ||
      row.vmId !== record.vmId || row.workerEndpoint !== record.endpoint) {
      this.invalidate(record.source); deny("stale-session");
    }
    const state = await this.state(record.source);
    if (state.value.recovery_epoch !== record.recoveryEpoch) {
      this.invalidate(record.source); deny("stale-session");
    }
    await record.source.control.reconnect();
    this.record(record.identity);
    const current = this.legacy.get(record.source.legacyId);
    if (this.controlsFor(record.identity.environmentId).length !== 1 ||
      this.sources.get(record.source.legacyId) !== record.source || !current ||
      current.vmId !== record.vmId || current.workerEndpoint !== record.endpoint) {
      this.invalidate(record.source); deny("stale-session");
    }
    const handshake = record.source.control.connectionIdentity();
    if (handshake && (handshake.recoveryEpoch !== record.recoveryEpoch || handshake.endpoint !== record.endpoint)) {
      this.invalidate(record.source); deny("stale-session");
    }
    if (!handshake || !record.source.control.view().workerReady) deny("worker-not-ready");
  }
  async open(id: string): Promise<DesktopSession> {
    if (this.closed) deny("provider-closed");
    const candidates = this.controlsFor(id);
    // Separate legacy controllers for one Worker must not masquerade as independent new authorities.
    if (candidates.length !== 1) deny(candidates.length ? "ambiguous-input-resource" : "unmanaged-environment");
    const source = candidates[0];
    await source.control.reconnect();
    const { row, value } = await this.state(source);
    const current = this.legacy.get(source.legacyId);
    const handshake = source.control.connectionIdentity();
    if (this.closed || this.controlsFor(id).length !== 1 || this.sources.get(source.legacyId) !== source || !handshake ||
      current?.vmId !== row.vmId || current.workerEndpoint !== row.workerEndpoint ||
      handshake.recoveryEpoch !== value.recovery_epoch || handshake.endpoint !== row.workerEndpoint ||
      !value.ready_for_observation || !value.ready_for_input || environmentId(row.vmId) !== id) deny("worker-not-ready");
    for (const old of this.bindings.values()) if (old.source === source && old.state === "open" &&
      (old.recoveryEpoch !== value.recovery_epoch || old.endpoint !== row.workerEndpoint)) {
      this.invalidate(source); break;
    }
    const identity = Object.freeze({ providerId: this.id, environmentId: id, sessionId: randomUUID(),
      instanceId: key(`${row.vmId}\0${value.recovery_epoch}`), inputResourceId: `guest-input:${key(row.vmId.toLowerCase())}` });
    const record: RecordBinding = { identity, source, vmId: row.vmId, endpoint: row.workerEndpoint,
      recoveryEpoch: value.recovery_epoch!, state: "open", pending: new Set(), runtimes: new Set() };
    this.bindings.set(identity.sessionId, record);
    return Object.freeze({ ...identity,
      capabilities: async () => { this.record(identity); return this.capabilities(); },
      status: async () => {
        let ready = false;
        if (record.state === "open") { try { await this.fresh(record); ready = true; } catch { /* report unavailable/stale */ } }
        const capabilities = await this.capabilities();
        ready = ready && record.state === "open" && !this.closed;
        const readiness: DesktopReadiness = Object.fromEntries(Object.entries(capabilities)
          .map(([capability, declarations]) => [capability, { state: !ready ? "not-ready" :
            declarations.every(item => item.state === "supported") ? "ready" : "unknown" }]));
        return { state: record.state, readiness };
      },
      close: async () => { record.state = "closed"; await this.cleanup(record); },
    });
  }
  private track<T>(record: RecordBinding, promise: Promise<T>): Promise<T> {
    record.pending.add(promise);
    return promise.finally(() => { record.pending.delete(promise); });
  }
  /** Legacy task gate shim: actual owner/epoch/Viewer leases remain in the shared DesktopControl. */
  taskControl(session: DesktopSession): InputControl {
    const record = this.record(session);
    return {
      workerEndpoint: () => { this.record(session); return record.endpoint; },
      assertTaskAllowed: taskId => {
        this.record(session);
        if (this.owners.has(session.inputResourceId!)) deny("input-resource-busy");
        record.source.control.assertTaskAllowed(taskId);
      },
      agentEpoch: () => {
        this.record(session);
        return !record.release && this.owners.get(session.inputResourceId!) === record
          ? record.source.control.agentEpoch() : undefined;
      },
      beginTask: taskId => this.track(record, (async () => {
        await this.fresh(record);
        const owner = this.owners.get(record.identity.inputResourceId!);
        if (owner) deny("input-resource-busy");
        record.source.control.assertTaskAllowed(taskId);
        record.release = undefined; record.begun = false;
        this.owners.set(record.identity.inputResourceId!, record); record.taskId = taskId;
        try {
          await record.source.control.beginTask(taskId);
          record.begun = true;
          await this.fresh(record);
          if (!record.source.control.agentEpoch()) deny("missing-agent-epoch");
        } catch (error) {
          // Failed setup is cleaned through the lifecycle path, never silently retried elsewhere.
          if (record.state === "open") record.state = "stale";
          void this.cleanup(record).catch(() => {}); throw error;
        }
      })()),
      finishTask: (taskId, status) => {
        if (record.taskId !== taskId || this.owners.get(record.identity.inputResourceId!) !== record) deny("foreign-task");
        return this.release(record, status);
      },
    };
  }
  /** Existing Guest runtime, connected with the exact Session recovery identity. Infrastructure only. */
  connectRuntime(session: DesktopSession, artifactDir: string): Promise<WorkerClient> {
    const record = this.record(session);
    return this.track(record, (async () => {
      await this.fresh(record);
      if (record.release || this.owners.get(record.identity.inputResourceId!) !== record || !record.taskId) deny("input-not-owned");
      const epoch = record.source.control.agentEpoch();
      if (epoch === undefined) deny("missing-agent-epoch");
      let guest: GuestDesktopRuntime;
      try {
        guest = await GuestDesktopRuntime.connect(record.endpoint, this.token, record.vmId, artifactDir, epoch, record.recoveryEpoch);
      } catch (error) { this.workerFailure(record, error); throw error; }
      try {
        this.record(session);
        if (record.release || record.source.control.agentEpoch() !== epoch) deny("stale-agent-epoch");
      } catch (error) { await guest.close(); throw error; }
      let bound = false, observed = false, closed = false;
      const inflight = new Set<Promise<unknown>>();
      const stamp = (observation: Observation) => { this.observations.set(observation, session.sessionId); return observation; };
      const call = <T>(work: () => Promise<T>) => {
        const promise = (async () => {
          if (closed || record.release) deny("runtime-closed");
          await this.fresh(record);
          if (closed || record.release || this.owners.get(session.inputResourceId!) !== record || record.source.control.agentEpoch() !== epoch) deny("stale-agent-epoch");
          try { return await work(); }
          catch (error) { this.workerFailure(record, error); throw error; }
        })();
        inflight.add(promise);
        return promise.finally(() => { inflight.delete(promise); });
      };
      const requireObserved = () => { if (!bound || !observed) deny("rebind-and-observe-required"); };
      let closing: Promise<void> | undefined;
      const runtime: WorkerClient = {
        listWindows: filter => call(() => guest.listWindows(filter)),
        ensureApp: appId => call(() => guest.ensureApp(appId)),
        attach: options => call(async () => { bound = false; observed = false; await guest.attach(options); bound = true; }),
        observe: capture => call(async () => {
          if (!bound) deny("rebind-required");
          const observation = await guest.observe(capture); observed = true; return stamp(observation);
        }),
        probe: focus => call(() => guest.probe(focus)),
        recoverFocus: () => call(() => guest.recoverFocus()),
        ground: action => call(() => { requireObserved(); return guest.ground(action); }),
        resolveAction: action => call(() => { requireObserved(); return guest.resolveAction(action); }),
        execute: (action, resolution, actionId) => call(async () => {
          requireObserved(); observed = false;
          const result: ActionResult = await guest.execute(action, resolution, actionId);
          if (result.observation) { stamp(result.observation); observed = true; }
          return result;
        }),
        restore: observation => call(async () => {
          if (this.observations.get(observation) !== session.sessionId) deny("stale-observation");
          observed = false; await guest.restore(observation); bound = true;
        }),
        close: () => closing ??= (async () => {
          closed = true; await Promise.allSettled([...inflight]); await guest.close(); record.runtimes.delete(runtime);
        })(),
      };
      record.runtimes.add(runtime); return runtime;
    })());
  }
  private async drainRuntimes(record: RecordBinding): Promise<void> {
    await Promise.allSettled([...record.pending]);
    const results = await Promise.allSettled([...record.runtimes].map(runtime => runtime.close()));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "Runtime drain unconfirmed");
  }
  private workerFailure(record: RecordBinding, error: unknown): void {
    if (error instanceof WorkerConnectionError && /Worker session changed|instance changed/i.test(error.message)) {
      this.invalidate(record.source);
    }
  }
  private release(record: RecordBinding, status?: string): Promise<boolean> {
    // One fence shared by normal finish and lifecycle teardown. A rejected fence is permanent.
    return record.release ??= (async () => {
      await this.drainRuntimes(record);
      if (!record.begun) deny("input-setup-unconfirmed");
      const stopped = await record.source.control.finishTask(record.taskId!, status);
      const view = record.source.control.view();
      if (view.error || !view.workerReady || !["PAUSED", "STOPPED"].includes(view.mode)) deny("input-revocation-unconfirmed");
      this.owners.delete(record.identity.inputResourceId!); record.taskId = undefined;
      return stopped;
    })();
  }
  private cleanup(record: RecordBinding): Promise<void> {
    return record.cleanup ??= (async () => {
      await this.drainRuntimes(record);
      if (this.owners.get(record.identity.inputResourceId!) === record && record.taskId) {
        await this.release(record, "paused");
      }
    })();
  }
  /** Root-owned shutdown; does not power off VM or close the shared legacy manager. */
  async close(): Promise<void> {
    this.closed = true;
    for (const record of this.bindings.values()) record.state = "closed";
    const results = await Promise.allSettled([...this.bindings.values()].map(record => this.cleanup(record)));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "Hyper-V adapter cleanup unconfirmed");
  }
}
