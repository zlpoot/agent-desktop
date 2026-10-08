import { randomUUID } from 'node:crypto';

/** Test-only protocol reference. No native APIs, Registry, Worker or production composition. */
export interface SyntheticProducerBinding {
  providerId: string; environmentId: string; installationScopeId: string;
  appBindingId: string; profileRevision: number; profileDigest: string;
  installationFingerprint: string; applicationVersion: string; launchDefinitionDigest: string;
  issuerIncarnation: string; targetToken: string; processIncarnation: string; windowIncarnation: string;
  windowsSession: number; desktop: string; taskSession: string; taskInstance: string;
  inputLease: string; inputEpoch: number; scenario: string;
}
const bindingFields = ['providerId', 'environmentId', 'installationScopeId', 'appBindingId', 'profileRevision', 'profileDigest',
  'installationFingerprint', 'applicationVersion', 'launchDefinitionDigest', 'issuerIncarnation', 'targetToken',
  'processIncarnation', 'windowIncarnation', 'windowsSession', 'desktop', 'taskSession', 'taskInstance',
  'inputLease', 'inputEpoch', 'scenario'] as const;
const bindingKey = (binding: SyntheticProducerBinding) => JSON.stringify(bindingFields.map(field => binding[field]));
const draftVersion = 'p8b-app-revoke-reference-1';
interface RevokeRequest { version: string; nonce: string; appEpoch: number; binding: SyntheticProducerBinding }
interface RevokeAck extends RevokeRequest { lastCommitSequence: number; denied: true; drained: true }
/** Committed fake durable state. Checkpoint/reopen models storage surviving a Host crash;
 * this does not implement disk persistence, fsync or the production Registry schema. */
type DenyIntent = { phase: 'denied-pending' | 'revoked'; request: RevokeRequest };
const denialKey = (binding: SyntheticProducerBinding) => JSON.stringify([binding.providerId, binding.environmentId, binding.appBindingId]);
export class SyntheticDenyJournal {
  private readonly intents: Map<string, DenyIntent>;
  available = true;
  failBegin = false;
  failComplete = false;
  constructor(committed: readonly [string, DenyIntent][] = []) { this.intents = new Map(structuredClone(committed)); }
  private readable() { if (!this.available) throw new Error('deny-journal-unavailable'); }
  checkpoint() { this.readable(); return structuredClone([...this.intents.entries()]); }
  denied(binding: SyntheticProducerBinding) { this.readable(); return this.intents.has(denialKey(binding)); }
  begin(request: RevokeRequest) {
    this.readable();
    if (this.failBegin || this.intents.size >= 128) { this.available = false; throw new Error('deny-intent-write-unconfirmed'); }
    if (this.intents.has(denialKey(request.binding))) throw new Error('deny-intent-already-present');
    this.intents.set(denialKey(request.binding), { phase: 'denied-pending', request: structuredClone(request) });
  }
  complete(request: RevokeRequest) {
    this.readable();
    if (this.failComplete) throw new Error('deny-completion-write-unconfirmed');
    const intent = this.intents.get(denialKey(request.binding));
    if (!intent || intent.phase !== 'denied-pending' || JSON.stringify(intent.request) !== JSON.stringify(request)) throw new Error('deny-intent-mismatch');
    // Retain a denial tombstone; completing pending never restores admission.
    this.intents.set(denialKey(request.binding), { phase: 'revoked', request: structuredClone(request) });
  }
}

/** All three fake admission paths consult committed state on every call, not a cached flag. */
export class SyntheticAppAdmissions {
  readonly minted: string[] = [];
  constructor(private readonly journal: SyntheticDenyJournal, private readonly registry: { current: boolean }) {}
  private admit(kind: string, binding: SyntheticProducerBinding) {
    if (this.journal.denied(binding) || !this.registry.current) throw new Error('persistent-app-denial');
    this.minted.push(kind);
  }
  newTask(binding: SyntheticProducerBinding) { this.admit('task', binding); }
  reuseApplication(binding: SyntheticProducerBinding) { this.admit('reuse', binding); }
  authorizeInput(binding: SyntheticProducerBinding) { this.admit('input', binding); }
}
type Action = 'focus' | 'restore' | 'search' | 'play';
const roles: Record<Action, string> = { focus: 'original-window', restore: 'original-window', search: 'fixed-search', play: 'fixed-play' };

export class SyntheticAppProducer {
  current: SyntheticProducerBinding;
  ready = true;
  inputCurrent = true;
  deadline = 60;
  private readonly committed: { sequence: number; action: Action }[] = [];
  get effects() { return structuredClone(this.committed); }
  private readonly anchor: SyntheticProducerBinding;
  private readonly operations = new Set<string>();
  private denied = false;
  private appEpoch = 1;
  private acknowledgement?: RevokeAck;
  constructor(binding: SyntheticProducerBinding, private readonly clock = () => 0) {
    this.anchor = Object.freeze(structuredClone(binding)); this.current = structuredClone(binding);
  }
  async dispatch(id: string, binding: SyntheticProducerBinding, action: Action, role: string, queued?: Promise<void>) {
    const snapshot = structuredClone(binding);
    if (!id || this.operations.has(id) || this.operations.size >= 256) throw new Error('operation-replay-or-limit');
    this.operations.add(id); // no replay, including rejected/uncertain operations
    await queued;
    // Reference linearization point: all guard checks + the ledger append are synchronous.
    // The ledger is the entire fake effect, not a queue ACK or a native callback.
    if (this.denied) throw new Error('app-revoked');
    if (bindingKey(snapshot) !== bindingKey(this.anchor) || bindingKey(this.current) !== bindingKey(this.anchor)) throw new Error('target-or-grant-changed');
    if (!this.ready || !this.inputCurrent || this.clock() >= this.deadline) throw new Error('input-or-deadline-unavailable');
    if (!Object.hasOwn(roles, action) || roles[action] !== role || snapshot.scenario !== 'synthetic-fixed-track') throw new Error('action-or-role-unavailable');
    this.committed.push({ sequence: this.committed.length + 1, action });
  }
  revoke(request: RevokeRequest): RevokeAck {
    if (this.acknowledgement && JSON.stringify(request) === JSON.stringify({ version: this.acknowledgement.version,
      nonce: this.acknowledgement.nonce, appEpoch: this.acknowledgement.appEpoch, binding: this.acknowledgement.binding })) {
      return structuredClone(this.acknowledgement);
    }
    if (request.version !== draftVersion || !request.nonce || request.appEpoch !== this.appEpoch + 1 || this.denied ||
      bindingKey(request.binding) !== bindingKey(this.anchor) || bindingKey(this.current) !== bindingKey(this.anchor)) throw new Error('revoke-context-unavailable');
    // Same synchronous producer boundary as the actual fake effect above.
    this.denied = true; this.appEpoch = request.appEpoch;
    this.acknowledgement = { ...structuredClone(request), lastCommitSequence: this.effects.length, denied: true, drained: true };
    return structuredClone(this.acknowledgement);
  }
}

/** Models a proposed separate async management API. Never implements P7 synchronous revoke. */
export class SyntheticRevokeManagement {
  private state: 'active' | 'denied-pending' | 'confirmed' | 'unknown' = 'active';
  get phase() { return this.state; }
  private admissionDenied = false; // not the existing Registry validity field
  get localDenied() { return this.admissionDenied; }
  private persisted = false;
  get registryRevoked() { return this.persisted; }
  private readonly anchor: SyntheticProducerBinding;
  constructor(binding: SyntheticProducerBinding, private readonly peer: () => SyntheticProducerBinding,
    private readonly journal: SyntheticDenyJournal, private readonly lastObservedCommitSequence = 0, private readonly persist = () => {}) {
    this.anchor = Object.freeze(structuredClone(binding));
    // Restart does not resume or mint a new grant from a still-current Registry.
    try { if (journal.denied(this.anchor)) { this.admissionDenied = true; this.state = 'unknown'; } }
    catch { this.admissionDenied = true; this.state = 'unknown'; }
  }
  async revoke(send: (request: RevokeRequest) => Promise<unknown>): Promise<RevokeAck> {
    if (this.phase !== 'active') throw new Error('revoke-no-retry-or-recovery');
    this.admissionDenied = true; this.state = 'denied-pending';
    const request = { version: draftVersion, nonce: randomUUID(), appEpoch: 2, binding: structuredClone(this.anchor) };
    try {
      this.journal.begin(request); // durability barrier before the native request
      const result = await send(structuredClone(request));
      const ack = result as RevokeAck;
      const keys = ['version', 'nonce', 'appEpoch', 'binding', 'lastCommitSequence', 'denied', 'drained'];
      if (!ack || typeof ack !== 'object' || Object.keys(ack).length !== keys.length || keys.some(key => !Object.hasOwn(ack, key)) ||
        ack.version !== request.version || ack.nonce !== request.nonce || ack.appEpoch !== request.appEpoch ||
        ack.denied !== true || ack.drained !== true || !ack.binding || bindingKey(ack.binding) !== bindingKey(this.anchor) ||
        bindingKey(this.peer()) !== bindingKey(this.anchor) || !Number.isSafeInteger(ack.lastCommitSequence) ||
        ack.lastCommitSequence < this.lastObservedCommitSequence) throw new Error('revoke-ack-unconfirmed');
      this.persist(); this.persisted = true;
      if (bindingKey(this.peer()) !== bindingKey(this.anchor)) throw new Error('revoke-peer-changed-during-persist');
      this.journal.complete(request); // only after checked ACK + final Registry write
      this.state = 'confirmed'; return structuredClone(ack);
    } catch (error) { this.state = 'unknown'; throw error; }
  }
}

export function producerReferenceFixture() {
  const binding: SyntheticProducerBinding = {
    providerId: 'synthetic-workspace', environmentId: 'synthetic-env', installationScopeId: 'synthetic-install-domain',
    appBindingId: 'synthetic-app', profileRevision: 1, profileDigest: 'synthetic-profile-digest',
    installationFingerprint: 'synthetic-binary', applicationVersion: 'synthetic-version', launchDefinitionDigest: 'synthetic-definition',
    issuerIncarnation: 'synthetic-issuer', targetToken: 'synthetic-token', processIncarnation: 'synthetic-process-lifetime',
    windowIncarnation: 'synthetic-window-lifetime', windowsSession: 7, desktop: 'synthetic-hidden-desktop',
    taskSession: 'synthetic-task', taskInstance: 'synthetic-task-instance', inputLease: 'synthetic-lease', inputEpoch: 1,
    scenario: 'synthetic-fixed-track',
  };
  const producer = new SyntheticAppProducer(binding);
  const journal = new SyntheticDenyJournal(), registry = { current: true };
  const admissions = new SyntheticAppAdmissions(journal, registry);
  const management = new SyntheticRevokeManagement(binding, () => producer.current, journal, 0, () => { registry.current = false; });
  return { binding, producer, management, journal, registry, admissions };
}
