import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AppCandidate, AppConfirmationRequest, AppLaunchVerification, EnvironmentAppBinding,
  EnvironmentAppRegistry, EnvironmentAppScope } from '../contracts/environment-apps.js';
import { candidateValue, identityValue, profileDigest, sameAppScope, scopeValue, textValue, timestamp } from './validation.js';

type Row = { data_json: string };

/** Private SQLite configuration store; deliberately independent of Task audit/checkpoint stores. */
export class SqliteEnvironmentAppStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.db = new DatabaseSync(path, { timeout: 1000 });
    this.db.exec(`CREATE TABLE IF NOT EXISTS app_environments (
      provider_id TEXT NOT NULL, environment_id TEXT NOT NULL, installation_scope_id TEXT NOT NULL,
      scope_revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(provider_id, environment_id));
      CREATE TABLE IF NOT EXISTS environment_apps (
      provider_id TEXT NOT NULL, environment_id TEXT NOT NULL, installation_scope_id TEXT NOT NULL,
      installation_id TEXT NOT NULL, app_binding_id TEXT NOT NULL, data_json TEXT NOT NULL,
      PRIMARY KEY(provider_id, environment_id, app_binding_id),
      UNIQUE(provider_id, environment_id, installation_scope_id, installation_id));
      CREATE TABLE IF NOT EXISTS environment_app_history (
      provider_id TEXT NOT NULL, environment_id TEXT NOT NULL, app_binding_id TEXT NOT NULL,
      revision INTEGER NOT NULL, data_json TEXT NOT NULL,
      PRIMARY KEY(provider_id, environment_id, app_binding_id, revision));`);
    const columns = this.db.prepare('PRAGMA table_info(app_environments)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'scope_revision')) {
      this.db.exec('ALTER TABLE app_environments ADD COLUMN scope_revision INTEGER NOT NULL DEFAULT 1');
    }
  }

  /** Composition-only: synchronizes a trusted installation scope and invalidates old views. */
  bind(value: EnvironmentAppScope): EnvironmentAppRegistry {
    const scope = scopeValue(value);
    const scopeRevision = this.transaction(() => {
      const previous = this.db.prepare('SELECT installation_scope_id, scope_revision FROM app_environments WHERE provider_id=? AND environment_id=?')
        .get(scope.providerId, scope.environmentId) as { installation_scope_id: string; scope_revision: number } | undefined;
      const nextRevision = previous ? previous.scope_revision + Number(previous.installation_scope_id !== scope.installationScopeId) : 1;
      if (previous && previous.installation_scope_id !== scope.installationScopeId) {
        for (const app of this.readList(scope)) {
          if (app.validity !== 'revoked') this.save({ ...app, revision: app.revision + 1,
            validity: 'stale', lastError: 'installation-scope-changed' });
        }
      }
      this.db.prepare(`INSERT INTO app_environments (provider_id, environment_id, installation_scope_id, scope_revision) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider_id, environment_id) DO UPDATE SET installation_scope_id=excluded.installation_scope_id,
        scope_revision=excluded.scope_revision`)
        .run(scope.providerId, scope.environmentId, scope.installationScopeId, nextRevision);
      return nextRevision;
    });
    const current = () => this.assertScope(scope, scopeRevision);
    const get = (id: string) => { current(); textValue(id); return this.read(scope, id); };
    const mutate = (id: string, revision: number, change: (app: EnvironmentAppBinding) => EnvironmentAppBinding) =>
      this.transaction(() => {
        current();
        const app = this.require(scope, id, revision);
        if (app.validity === 'revoked') throw new Error('app-revoked');
        return this.save(change(app));
      });
    return Object.freeze({
      scope,
      list: () => { current(); return this.readList(scope); },
      get,
      resolveName: (name: string) => {
        current(); textValue(name);
        const key = name.normalize('NFKC').toLowerCase();
        const apps = this.readList(scope).filter(app => app.validity !== 'revoked' && sameAppScope(app.scope, scope) &&
          [app.displayName, app.applicationId, ...(app.trust === 'discovered' ? [] : app.aliases)]
            .some(alias => alias.normalize('NFKC').toLowerCase() === key));
        return apps.length === 0 ? { kind: 'not-found' as const } : apps.length === 1 ?
          { kind: 'unique' as const, app: apps[0] } : { kind: 'ambiguous' as const, apps };
      },
      discover: (candidate: AppCandidate, expectedRevision?: number) => this.transaction(() => {
        current(); const snapshot = candidateValue(candidate, scope);
        const row = this.db.prepare(`SELECT data_json FROM environment_apps WHERE provider_id=? AND environment_id=?
          AND installation_scope_id=? AND installation_id=?`)
          .get(scope.providerId, scope.environmentId, scope.installationScopeId, snapshot.installationId) as Row | undefined;
        const previous = row ? JSON.parse(row.data_json) as EnvironmentAppBinding : undefined;
        if (previous) {
          this.assertRevision(previous, expectedRevision);
          if (previous.validity === 'revoked') throw new Error('app-revoked');
          const digest = profileDigest(snapshot);
          if (previous.profileDigest === digest && previous.validity === 'current') return previous;
          return this.save({ ...snapshot, appBindingId: previous.appBindingId, revision: previous.revision + 1,
            profileRevision: previous.profileRevision + 1, profileDigest: digest, trust: 'discovered',
            validity: 'stale', availability: 'available', lastError: 'configuration-changed',
            confirmations: previous.confirmations, verifications: previous.verifications });
        }
        if (expectedRevision !== undefined && expectedRevision !== 0) throw new Error('app-revision-conflict');
        return this.save({ ...snapshot, appBindingId: randomUUID(), revision: 1, profileRevision: 1,
          profileDigest: profileDigest(snapshot), trust: 'discovered', validity: 'current', availability: 'available',
          confirmations: [], verifications: [] });
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
        current(); const app = this.require(scope, id, revision); this.assertReusable(app); return app;
      },
      history: (id: string) => {
        current(); textValue(id);
        return (this.db.prepare(`SELECT data_json FROM environment_app_history WHERE provider_id=? AND
          environment_id=? AND app_binding_id=? ORDER BY revision`).all(scope.providerId, scope.environmentId, id) as Row[])
          .map(row => JSON.parse(row.data_json) as EnvironmentAppBinding);
      },
    });
  }

  close(): void { this.db.close(); }
  private assertScope(scope: EnvironmentAppScope, revision: number): void {
    const row = this.db.prepare('SELECT installation_scope_id, scope_revision FROM app_environments WHERE provider_id=? AND environment_id=?')
      .get(scope.providerId, scope.environmentId) as { installation_scope_id: string; scope_revision: number } | undefined;
    if (row?.installation_scope_id !== scope.installationScopeId || row?.scope_revision !== revision) {
      throw new Error('installation-scope-changed');
    }
  }
  private read(scope: EnvironmentAppScope, id: string): EnvironmentAppBinding | undefined {
    const row = this.db.prepare('SELECT data_json FROM environment_apps WHERE provider_id=? AND environment_id=? AND app_binding_id=?')
      .get(scope.providerId, scope.environmentId, id) as Row | undefined;
    return row ? JSON.parse(row.data_json) as EnvironmentAppBinding : undefined;
  }
  private readList(scope: EnvironmentAppScope): EnvironmentAppBinding[] {
    return (this.db.prepare('SELECT data_json FROM environment_apps WHERE provider_id=? AND environment_id=? ORDER BY app_binding_id')
      .all(scope.providerId, scope.environmentId) as Row[]).map(row => JSON.parse(row.data_json) as EnvironmentAppBinding);
  }
  private assertRevision(app: EnvironmentAppBinding, expected: number | undefined): void {
    if (!Number.isSafeInteger(expected) || expected !== app.revision) throw new Error('app-revision-conflict');
  }
  private require(scope: EnvironmentAppScope, id: string, revision: number): EnvironmentAppBinding {
    textValue(id); const app = this.read(scope, id);
    if (!app) throw new Error('app-binding-not-found');
    this.assertRevision(app, revision);
    if (!sameAppScope(app.scope, scope)) throw new Error('installation-scope-changed');
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
  private save(app: EnvironmentAppBinding): EnvironmentAppBinding {
    const json = JSON.stringify(app);
    this.db.prepare(`INSERT INTO environment_apps VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, environment_id, app_binding_id) DO UPDATE SET data_json=excluded.data_json`)
      .run(app.scope.providerId, app.scope.environmentId, app.scope.installationScopeId, app.installationId, app.appBindingId, json);
    this.db.prepare('INSERT INTO environment_app_history VALUES (?, ?, ?, ?, ?)')
      .run(app.scope.providerId, app.scope.environmentId, app.appBindingId, app.revision, json);
    return JSON.parse(json) as EnvironmentAppBinding;
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
