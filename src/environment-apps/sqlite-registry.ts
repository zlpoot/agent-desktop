import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AppCandidate, AppConfirmationRequest, AppLaunchVerification, EnvironmentAppBinding,
  EnvironmentAppRegistry, EnvironmentAppScope } from '../contracts/environment-apps.js';
import { installAppAdmissionGate } from './admission-gate.js';
import { candidateValue, identityValue, profileDigest, sameAppScope, scopeValue, textValue, timestamp } from './validation.js';

type Row = { data_json: string };
type BindingRow = Row & { scope_revision: number };
const bindingTable = `CREATE TABLE environment_apps (
  provider_id TEXT NOT NULL, environment_id TEXT NOT NULL, installation_scope_id TEXT NOT NULL,
  scope_revision INTEGER NOT NULL, installation_id TEXT NOT NULL, app_binding_id TEXT NOT NULL, data_json TEXT NOT NULL,
  PRIMARY KEY(provider_id, environment_id, app_binding_id),
  UNIQUE(provider_id, environment_id, installation_scope_id, scope_revision, installation_id))`;

/** Private SQLite configuration store; deliberately independent of Task audit/checkpoint stores. */
export class SqliteEnvironmentAppStore {
  private readonly db: DatabaseSync;
  private denialFault = false;
  constructor(path: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.db = new DatabaseSync(path, { timeout: 1000 });
    try {
      // Commit on this same connection is the private denial barrier.
      this.db.exec('PRAGMA synchronous=EXTRA');
      if ((this.db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous !== 3) throw new Error('app-storage-durability-unavailable');
      const gateTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('private_app_denials', 'private_app_denial_store')").all();
      if (gateTables.length !== 0 && gateTables.length !== 2) throw new Error('app-denial-storage-incomplete');
      if (gateTables.length === 0) this.transaction(() => {
        this.db.exec(`CREATE TABLE private_app_denial_store (version INTEGER PRIMARY KEY CHECK(version=1));
          INSERT INTO private_app_denial_store VALUES (1);
          CREATE TABLE private_app_denials (
            provider_id TEXT NOT NULL, environment_id TEXT NOT NULL, app_binding_id TEXT NOT NULL,
            installation_id TEXT NOT NULL, application_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase='denied-pending'),
            nonce TEXT NOT NULL, profile_json TEXT NOT NULL, intent_json TEXT NOT NULL,
            PRIMARY KEY(provider_id, environment_id, app_binding_id));`);
      });
      this.assertDenialStore();
      this.db.prepare('SELECT provider_id, environment_id, app_binding_id, installation_id, application_id, phase, nonce, profile_json, intent_json FROM private_app_denials LIMIT 0').all();
      this.db.exec(`CREATE TABLE IF NOT EXISTS app_environments (
        provider_id TEXT NOT NULL, environment_id TEXT NOT NULL, installation_scope_id TEXT NOT NULL,
        scope_revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(provider_id, environment_id));
        ${bindingTable.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')};
        CREATE TABLE IF NOT EXISTS environment_app_history (
        provider_id TEXT NOT NULL, environment_id TEXT NOT NULL, app_binding_id TEXT NOT NULL,
        revision INTEGER NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY(provider_id, environment_id, app_binding_id, revision));`);
      const columns = this.db.prepare('PRAGMA table_info(app_environments)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'scope_revision')) {
        this.db.exec('ALTER TABLE app_environments ADD COLUMN scope_revision INTEGER NOT NULL DEFAULT 1');
      }
      this.migrateBindingGenerations();
    } catch (error) { this.db.close(); throw error; }
  }

  /** Composition-only: synchronizes a trusted installation scope and invalidates old views. */
  bind(value: EnvironmentAppScope): EnvironmentAppRegistry {
    const scope = scopeValue(value);
    const scopeRevision = this.transaction(() => {
      const previous = this.db.prepare('SELECT installation_scope_id, scope_revision FROM app_environments WHERE provider_id=? AND environment_id=?')
        .get(scope.providerId, scope.environmentId) as { installation_scope_id: string; scope_revision: number } | undefined;
      const nextRevision = previous ? previous.scope_revision + Number(previous.installation_scope_id !== scope.installationScopeId) : 1;
      if (previous && previous.installation_scope_id !== scope.installationScopeId) {
        this.assertEnvironmentNotDenied(scope);
        for (const app of this.readList(scope, previous.scope_revision)) {
          if (app.validity !== 'revoked') this.save({ ...app, revision: app.revision + 1,
            validity: 'stale', lastError: 'installation-scope-changed' }, previous.scope_revision);
        }
      }
      this.db.prepare(`INSERT INTO app_environments (provider_id, environment_id, installation_scope_id, scope_revision) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider_id, environment_id) DO UPDATE SET installation_scope_id=excluded.installation_scope_id,
        scope_revision=excluded.scope_revision`)
        .run(scope.providerId, scope.environmentId, scope.installationScopeId, nextRevision);
      return nextRevision;
    });
    const current = () => this.assertScope(scope, scopeRevision);
    const get = (id: string) => {
      current(); textValue(id); const row = this.read(scope, id);
      return row ? JSON.parse(row.data_json) as EnvironmentAppBinding : undefined;
    };
    const mutate = (id: string, revision: number, change: (app: EnvironmentAppBinding) => EnvironmentAppBinding) =>
      this.transaction(() => {
        current();
        const app = this.require(scope, scopeRevision, id, revision);
        this.assertNotDenied(scope, id);
        if (app.validity === 'revoked') throw new Error('app-revoked');
        return this.save(change(app), scopeRevision);
      });
    const registry: EnvironmentAppRegistry = Object.freeze({
      scope,
      list: () => { current(); return this.readList(scope, scopeRevision); },
      get,
      resolveName: (name: string) => {
        current(); textValue(name);
        const key = name.normalize('NFKC').toLowerCase();
        const apps = this.readList(scope, scopeRevision).filter(app => app.validity !== 'revoked' && sameAppScope(app.scope, scope) &&
          [app.displayName, app.applicationId, ...(app.trust === 'discovered' ? [] : app.aliases)]
            .some(alias => alias.normalize('NFKC').toLowerCase() === key));
        return apps.length === 0 ? { kind: 'not-found' as const } : apps.length === 1 ?
          { kind: 'unique' as const, app: apps[0] } : { kind: 'ambiguous' as const, apps };
      },
      discover: (candidate: AppCandidate, expectedRevision?: number) => this.transaction(() => {
        current(); this.assertDenialStore(); const snapshot = candidateValue(candidate, scope);
        // No rediscovery or new binding ID may bypass a pending logical application.
        if (this.db.prepare(`SELECT 1 FROM private_app_denials WHERE provider_id=? AND environment_id=?
            AND (installation_id=? OR application_id=?) LIMIT 1`).get(scope.providerId, scope.environmentId,
              snapshot.installationId, snapshot.applicationId.normalize('NFKC').toLowerCase())) throw new Error('app-admission-denied-pending');
        const row = this.db.prepare(`SELECT data_json FROM environment_apps WHERE provider_id=? AND environment_id=?
          AND installation_scope_id=? AND scope_revision=? AND installation_id=?`)
          .get(scope.providerId, scope.environmentId, scope.installationScopeId, scopeRevision, snapshot.installationId) as Row | undefined;
        const previous = row ? JSON.parse(row.data_json) as EnvironmentAppBinding : undefined;
        const digest = createHash('sha256').update(JSON.stringify([scopeRevision, profileDigest(snapshot)])).digest('hex');
        if (previous) {
          this.assertRevision(previous, expectedRevision);
          if (previous.validity === 'revoked') throw new Error('app-revoked');
          // A migrated first-generation profile may retain its original confirmed digest.
          if ((previous.profileDigest === digest || scopeRevision === 1 && previous.profileDigest === profileDigest(snapshot)) &&
              previous.validity === 'current') return previous;
          return this.save({ ...snapshot, appBindingId: previous.appBindingId, revision: previous.revision + 1,
            profileRevision: previous.profileRevision + 1, profileDigest: digest, trust: 'discovered',
            validity: 'stale', availability: 'available', lastError: 'configuration-changed',
            confirmations: previous.confirmations, verifications: previous.verifications }, scopeRevision);
        }
        if (expectedRevision !== undefined && expectedRevision !== 0) throw new Error('app-revision-conflict');
        return this.save({ ...snapshot, appBindingId: randomUUID(), revision: 1, profileRevision: 1,
          profileDigest: digest, trust: 'discovered', validity: 'current', availability: 'available',
          confirmations: [], verifications: [] }, scopeRevision);
      }),
      confirm: (request: AppConfirmationRequest) => mutate(request.appBindingId, request.expectedRevision, app => {
        textValue(request.operatorId);
        if (app.trust !== 'discovered' || app.availability !== 'available' ||
            app.validity === 'stale' && app.lastError !== 'configuration-changed' ||
            request.profileDigest !== app.profileDigest) throw new Error('app-confirmation-mismatch');
        const confirmedAt = this.now(); timestamp(confirmedAt);
        return { ...app, revision: app.revision + 1, trust: 'confirmed', validity: 'current', lastError: undefined,
          confirmations: [...app.confirmations, { profileRevision: app.profileRevision,
            profileDigest: app.profileDigest, operatorId: request.operatorId, confirmedAt }] };
      }),
      recordVerification: (id: string, revision: number, result: AppLaunchVerification) => mutate(id, revision, app => {
        this.assertReusable(app);
        this.validateVerification(app, result);
        return { ...app, revision: app.revision + 1,
          trust: result.result === 'verified' ? 'verified' : app.trust,
          validity: result.result === 'mismatch' ? 'stale' : app.validity,
          availability: result.result === 'unavailable' ? 'unavailable' : 'available',
          lastError: result.result === 'verified' ? undefined : result.reason,
          verifications: [...app.verifications, structuredClone(result)] };
      }),
      setAvailability: (id: string, revision: number, available: boolean, reason?: string) => mutate(id, revision, app => {
        if (typeof available !== 'boolean') throw new Error('invalid-app-availability');
        if (!available) textValue(reason);
        return { ...app, revision: app.revision + 1, availability: available ? 'available' : 'unavailable',
          lastError: !available ? reason : app.validity === 'stale' ? app.lastError : undefined };
      }),
      markStale: (id: string, revision: number, reason: string) => mutate(id, revision, app => {
        textValue(reason);
        return { ...app, revision: app.revision + 1, validity: 'stale', lastError: reason };
      }),
      revoke: (id: string, revision: number, reason: string) => mutate(id, revision, app => {
        textValue(reason);
        return { ...app, revision: app.revision + 1, validity: 'revoked', lastError: reason };
      }),
      requireLaunchProfile: (id: string, revision: number) => {
        current(); this.assertNotDenied(scope, id); const app = this.require(scope, scopeRevision, id, revision); this.assertReusable(app); return app;
      },
      history: (id: string) => {
        current(); textValue(id);
        return (this.db.prepare(`SELECT data_json FROM environment_app_history WHERE provider_id=? AND
          environment_id=? AND app_binding_id=? ORDER BY revision`).all(scope.providerId, scope.environmentId, id) as Row[])
          .map(row => JSON.parse(row.data_json) as EnvironmentAppBinding);
      },
    });
    installAppAdmissionGate(registry, id => { current(); this.assertNotDenied(scope, id); });
    return registry;
  }

  /** Trusted composition-only denial, not an authorization or native ACK.
   * No sender/finalizer is exposed in this first storage slice. */
  beginAppDenial(scopeValueInput: EnvironmentAppScope, id: string, revision: number, reason: string): void {
    const scope = scopeValue(scopeValueInput); textValue(id); textValue(reason);
    this.transaction(() => {
      const environment = this.db.prepare('SELECT installation_scope_id, scope_revision FROM app_environments WHERE provider_id=? AND environment_id=?')
        .get(scope.providerId, scope.environmentId) as { installation_scope_id: string; scope_revision: number } | undefined;
      if (!environment || environment.installation_scope_id !== scope.installationScopeId) throw new Error('installation-scope-changed');
      const app = this.require(scope, environment.scope_revision, id, revision);
      this.assertNotDenied(scope, id);
      if (app.validity === 'revoked') throw new Error('app-revoked');
      if ((this.db.prepare('SELECT count(*) AS count FROM private_app_denials').get() as { count: number }).count >= 4096) {
        throw new Error('app-denial-storage-limit');
      }
      const createdAt = this.now(); timestamp(createdAt);
      try {
        this.db.prepare('INSERT INTO private_app_denials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(scope.providerId, scope.environmentId, id, app.installationId, app.applicationId.normalize('NFKC').toLowerCase(),
            'denied-pending', randomUUID(), JSON.stringify(app), JSON.stringify({ denialEpoch: 1, reason, createdAt }));
      } catch (error) { this.denialFault = true; throw error; }
    });
  }
  private assertDenialStore(): void {
    if (this.denialFault) throw new Error('app-denial-storage-unavailable');
    const versions = this.db.prepare('SELECT version FROM private_app_denial_store').all() as { version: number }[];
    if (versions.length !== 1 || versions[0].version !== 1) throw new Error('app-denial-storage-unavailable');
  }
  private assertNotDenied(scope: EnvironmentAppScope, id: string): void {
    this.assertDenialStore(); textValue(id);
    const row = this.db.prepare('SELECT phase FROM private_app_denials WHERE provider_id=? AND environment_id=? AND app_binding_id=?')
      .get(scope.providerId, scope.environmentId, id);
    // Presence always denies, including malformed/unrecognized phases. No clearing API.
    if (row) throw new Error('app-admission-denied-pending');
  }
  private assertEnvironmentNotDenied(scope: EnvironmentAppScope): void {
    this.assertDenialStore();
    if (this.db.prepare('SELECT 1 FROM private_app_denials WHERE provider_id=? AND environment_id=? LIMIT 1')
        .get(scope.providerId, scope.environmentId)) throw new Error('app-denial-blocks-scope-change');
  }

  close(): void { this.db.close(); }
  private assertScope(scope: EnvironmentAppScope, revision: number): void {
    const row = this.db.prepare('SELECT installation_scope_id, scope_revision FROM app_environments WHERE provider_id=? AND environment_id=?')
      .get(scope.providerId, scope.environmentId) as { installation_scope_id: string; scope_revision: number } | undefined;
    if (row?.installation_scope_id !== scope.installationScopeId || row?.scope_revision !== revision) {
      throw new Error('installation-scope-changed');
    }
  }
  private read(scope: EnvironmentAppScope, id: string): BindingRow | undefined {
    return this.db.prepare('SELECT data_json, scope_revision FROM environment_apps WHERE provider_id=? AND environment_id=? AND app_binding_id=?')
      .get(scope.providerId, scope.environmentId, id) as BindingRow | undefined;
  }
  private readList(scope: EnvironmentAppScope, generation: number): EnvironmentAppBinding[] {
    return (this.db.prepare('SELECT data_json FROM environment_apps WHERE provider_id=? AND environment_id=? AND scope_revision=? ORDER BY app_binding_id')
      .all(scope.providerId, scope.environmentId, generation) as Row[]).map(row => JSON.parse(row.data_json) as EnvironmentAppBinding);
  }
  private assertRevision(app: EnvironmentAppBinding, expected: number | undefined): void {
    if (!Number.isSafeInteger(expected) || expected !== app.revision) throw new Error('app-revision-conflict');
  }
  private require(scope: EnvironmentAppScope, generation: number, id: string, revision: number): EnvironmentAppBinding {
    textValue(id); const row = this.read(scope, id);
    if (!row) throw new Error('app-binding-not-found');
    const app = JSON.parse(row.data_json) as EnvironmentAppBinding;
    this.assertRevision(app, revision);
    if (!sameAppScope(app.scope, scope) || row.scope_revision !== generation) throw new Error('installation-scope-changed');
    return app;
  }
  private assertReusable(app: EnvironmentAppBinding): void {
    if (app.validity !== 'current' || app.availability !== 'available' || app.trust === 'discovered' ||
        !app.confirmations.some(item => item.profileRevision === app.profileRevision && item.profileDigest === app.profileDigest)) {
      throw new Error('app-profile-not-reusable');
    }
  }
  private validateVerification(app: EnvironmentAppBinding, result: AppLaunchVerification): void {
    if (!result || Object.keys(result).some(key => !['profileRevision', 'profileDigest', 'scope', 'checkedAt', 'result',
      'identity', 'processOwnershipVerified', 'windowOwnershipVerified', 'evidence', 'reason'].includes(key))) {
      throw new Error('invalid-app-verification');
    }
    scopeValue(result.scope); timestamp(result.checkedAt); textValue(result.evidence);
    if (result.identity) identityValue(result.identity);
    if (!sameAppScope(result.scope, app.scope) || result.profileRevision !== app.profileRevision ||
        result.profileDigest !== app.profileDigest || !['verified', 'unavailable', 'mismatch'].includes(result.result) ||
        typeof result.processOwnershipVerified !== 'boolean' || typeof result.windowOwnershipVerified !== 'boolean' ||
        Date.parse(result.checkedAt) < Date.parse(app.confirmations.at(-1)!.confirmedAt)) throw new Error('app-verification-mismatch');
    if (result.result === 'verified') {
      if (!app.identity || !result.identity || app.identity.productId !== result.identity.productId ||
          app.identity.version !== result.identity.version || app.identity.fingerprint !== result.identity.fingerprint ||
          !result.processOwnershipVerified || !result.windowOwnershipVerified) throw new Error('app-identity-not-verified');
    } else textValue(result.reason);
  }
  private save(app: EnvironmentAppBinding, generation: number): EnvironmentAppBinding {
    const json = JSON.stringify(app);
    this.db.prepare(`INSERT INTO environment_apps
      (provider_id, environment_id, installation_scope_id, scope_revision, installation_id, app_binding_id, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, environment_id, app_binding_id) DO UPDATE SET data_json=excluded.data_json`)
      .run(app.scope.providerId, app.scope.environmentId, app.scope.installationScopeId, generation, app.installationId, app.appBindingId, json);
    this.db.prepare('INSERT INTO environment_app_history VALUES (?, ?, ?, ?, ?)')
      .run(app.scope.providerId, app.scope.environmentId, app.appBindingId, app.revision, json);
    return JSON.parse(json) as EnvironmentAppBinding;
  }
  /** Old rows cannot prove their incarnation after a scope transition; preserve them as audit-only. */
  private migrateBindingGenerations(): void {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(environment_apps)').all() as Array<{ name: string }>;
      if (columns.some(column => column.name === 'scope_revision')) return;
      this.db.exec(`ALTER TABLE environment_apps RENAME TO environment_apps_legacy; ${bindingTable};`);
      const rows = this.db.prepare(`SELECT old.data_json, current.installation_scope_id, current.scope_revision
        FROM environment_apps_legacy old LEFT JOIN app_environments current
        ON old.provider_id=current.provider_id AND old.environment_id=current.environment_id`)
        .all() as Array<Row & { installation_scope_id: string | null; scope_revision: number | null }>;
      for (const row of rows) {
        const app = JSON.parse(row.data_json) as EnvironmentAppBinding;
        // Generation 1 proves the environment has never left its initial domain.
        // Generation 0 quarantines unprovable legacy incarnations and is never active.
        const generation = row.scope_revision === 1 && row.installation_scope_id === app.scope.installationScopeId ? 1 : 0;
        this.db.prepare(`INSERT INTO environment_apps VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(app.scope.providerId, app.scope.environmentId, app.scope.installationScopeId, generation,
            app.installationId, app.appBindingId, row.data_json);
        if (generation === 0 && app.validity === 'current') this.save({ ...app, revision: app.revision + 1,
          validity: 'stale', lastError: 'installation-generation-unproven' }, generation);
      }
      this.db.exec('DROP TABLE environment_apps_legacy');
    });
  }
  private transaction<T>(operation: () => T): T {
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      const result = operation(); this.db.exec('COMMIT'); begun = false; return result;
    } catch (error) {
      // A failed lock/write/COMMIT cannot leave this connection minting grants.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SQLITE_ERROR') this.denialFault = true;
      if (begun) try { this.db.exec('ROLLBACK'); } catch { this.denialFault = true; }
      throw error;
    }
  }
}
