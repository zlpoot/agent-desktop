import { randomUUID } from 'node:crypto';
import type { EnvironmentAppScope, EnvironmentAppService, EnvironmentAppServices } from '../contracts/environment-apps.js';
import type { ReadonlyAppDiscovery, DiscoveredApp, AppScanReport } from '../contracts/app-discovery.js';
import type { AppConfirmationDisplay } from '../contracts/app-launch.js';
import { desktopTarget, sameDesktopTarget, type TaskDesktopTarget } from '../contracts/task-desktop.js';
import { sameAppScope, textValue } from '../environment-apps/validation.js';
import type { TaskDesktopOption } from './task-desktop-sessions.js';

type Session = { id: string; target: TaskDesktopTarget; scope: EnvironmentAppScope; service: EnvironmentAppService; revision: number;
  expires: number; candidates: readonly DiscoveredApp[]; report?: Omit<AppScanReport, 'candidates' | 'snapshots'>;
  display?: AppConfirmationDisplay; operations: Map<string, { key: string; promise: Promise<unknown> }>;
  active: Set<string>; busy: boolean; closed: boolean; timer?: ReturnType<typeof setTimeout> };
const fields: Record<string, readonly string[]> = {
  open: [], list: [], scan: [], path: ['path'], prepare: ['candidateId', 'candidateRevision'],
  confirm: ['confirmationId', 'digest', 'allowLaunch'], verify: ['appBindingId', 'expectedRevision', 'allowLaunch'],
  revoke: ['appBindingId', 'expectedRevision'], cancel: [], close: [],
};
/** Private Dashboard operator port. Uses the very same P7-C services as Task onboarding.
 * Sessions and receipts are ephemeral; no Task continuation or runtime target is returned. */
export class AppManagement {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  constructor(private readonly apps: EnvironmentAppServices, private readonly environments: () => Promise<readonly TaskDesktopOption[]>,
    private readonly clock = () => Date.now()) {}
  private service(session: Session) {
    const service = this.apps.forEnvironment(session.target);
    service.registry.list();
    if (service !== session.service || !sameAppScope(session.scope, service.registry.scope) || service.discovery && !sameAppScope(session.scope, service.discovery.scope)) {
      throw new Error('app-management-scope-changed');
    }
    return service;
  }
  private async current(session: Session) {
    if (this.closed || session.closed || session.expires <= this.clock()) {
      this.end(session); throw new Error('app-management-session-expired');
    }
    const option = (await this.environments()).find(item => sameDesktopTarget(item, session.target));
    if (!option) { this.end(session); throw new Error('app-management-environment-unavailable'); }
    try { this.service(session); }
    catch (error) { this.end(session); throw error; }
    if (this.closed || session.closed) throw new Error('app-management-session-expired');
    return option;
  }
  private end(session: Session) {
    session.closed = true;
    if (session.timer) clearTimeout(session.timer);
    const port = session.service.onboarding;
    for (const operationId of session.active) port?.cancel({ operationId });
    if (session.display) port?.cancel({ operationId: session.display.confirmationId });
    this.sessions.delete(session.id);
  }
  private async view(session: Session) {
    const option = await this.current(session), service = this.service(session);
    const registered = service.registry.list();
    return { sessionId: session.id, revision: session.revision, desktopTarget: session.target, scope: session.scope,
      registered, candidates: session.candidates, report: session.report, confirmation: session.display,
      readiness: { discovery: typeof (service.discovery as ReadonlyAppDiscovery)?.candidate === 'function',
        controlledLaunch: !!service.onboarding, taskCompatibility: option.executable, blockedReason: option.blockedReason,
        scenarios: option.scenarios ?? [], businessCapable: false,
        businessReason: 'not-proven: launch verification is not P6 action evidence; Tasks still require a trusted runtime bridge and independent capability/risk/budget/input/result gates' } };
  }
  async act(body: Record<string, unknown>): Promise<unknown> {
    const action = body.action;
    if (typeof action !== 'string' || !Object.hasOwn(fields, action)) throw new Error('invalid-app-management-action');
    const allowed = ['action', 'desktopTarget', ...(action === 'open' ? [] : ['sessionId', 'revision', 'requestId']), ...fields[action]];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error('invalid-app-management-fields');
    const selected = body.desktopTarget as TaskDesktopTarget;
    if (!selected || Object.keys(selected).some(key => !['providerId', 'environmentId'].includes(key))) throw new Error('desktop-target-required');
    const target = desktopTarget(selected.providerId, selected.environmentId);
    if (this.closed) throw new Error('app-management-closed');
    if (action === 'open') {
      for (const session of this.sessions.values()) if (session.expires <= this.clock()) this.end(session);
      if (this.sessions.size >= 128) throw new Error('app-management-session-limit');
      if (!(await this.environments()).some(item => sameDesktopTarget(item, target))) throw new Error('app-management-environment-unavailable');
      const service = this.apps.forEnvironment(target); service.registry.list();
      const session: Session = { id: randomUUID(), target, scope: service.registry.scope, service, revision: 0,
        expires: this.clock() + 300000, candidates: [], operations: new Map(), active: new Set(), busy: false, closed: false };
      session.timer = setTimeout(() => this.end(session), 300000); session.timer.unref();
      this.sessions.set(session.id, session); return this.view(session);
    }
    const session = this.sessions.get(String(body.sessionId));
    if (!session || !sameDesktopTarget(target, session.target)) throw new Error('app-management-session-target-mismatch');
    await this.current(session);
    textValue(body.requestId);
    if (String(body.requestId).length > 100) throw new Error('app-management-request-id-too-long');
    if (action === 'close' || action === 'cancel') {
      // Cancellation must remain available during an operation; it invalidates the whole page session.
      this.end(session); return { closed: true };
    }
    const key = JSON.stringify(body), old = session.operations.get(String(body.requestId));
    if (old) {
      if (old.key !== key) throw new Error('app-management-operation-conflict');
      await old.promise; return this.view(session); // Never return an obsolete cached profile/status.
    }
    if (body.revision !== session.revision) throw new Error('app-management-revision-conflict');
    if (session.busy) throw new Error('app-management-operation-busy');
    if (session.operations.size >= 128) throw new Error('app-management-operation-limit');
    session.busy = true;
    const promise = this.perform(session, action, body).finally(() => { session.busy = false; });
    session.operations.set(String(body.requestId), { key, promise });
    return promise;
  }
  private async perform(session: Session, action: string, body: Record<string, unknown>) {
    const service = this.service(session), discovery = service.discovery as ReadonlyAppDiscovery | undefined;
    if (action === 'scan' || action === 'path' || action === 'prepare') {
      if (typeof discovery?.candidate !== 'function') throw new Error('app-discovery-port-unavailable');
      if (session.display) service.onboarding?.cancel({ operationId: session.display.confirmationId });
      session.display = undefined;
      if (action === 'scan') {
        const { candidates: _raw, snapshots, ...report } = await discovery.scan();
        await this.current(session); session.candidates = snapshots; session.report = report;
      } else if (action === 'path') {
        textValue(body.path); if (String(body.path).length > 1024) throw new Error('app-path-too-long');
        const result = await discovery.inspectPath(body.path as string); await this.current(session);
        session.candidates = result.snapshot ? [result.snapshot] : [];
        session.report = { scope: session.scope, status: result.snapshot ? 'complete' : 'unavailable',
          coverage: [], reason: result.reason, installationOrigin: result.snapshot?.limitation?.startsWith('installed-on-host-os')
            ? 'shared-host-os' : session.report?.installationOrigin ?? 'selected-environment' };
      } else {
        const candidate = session.candidates.find(item => item.candidateId === body.candidateId && item.revision === body.candidateRevision);
        if (!candidate || !service.onboarding) throw new Error('app-management-candidate-or-launch-unavailable');
        const existing = service.registry.list().find(app => app.installationId === candidate.candidate.installationId &&
          app.validity === 'current' && app.trust !== 'discovered' && app.identity?.fingerprint === candidate.contentFingerprint &&
          (!candidate.version || app.identity.version === candidate.version) &&
          JSON.stringify(app.launchSpec) === JSON.stringify(candidate.candidate.launchSpec));
        if (existing) throw new Error('app-management-already-confirmed-use-reverify');
        const display = await service.onboarding.prepare({ candidateId: candidate.candidateId, candidateRevision: candidate.revision });
        try { await this.current(session); session.display = display; }
        catch (error) { service.onboarding.cancel({ operationId: display.confirmationId }); throw error; }
      }
    } else if (action === 'confirm' || action === 'verify') {
      if (!service.onboarding || body.allowLaunch !== true) throw new Error('app-management-explicit-launch-permission-required');
      const display = session.display;
      if (action === 'confirm' && (!display || display.confirmationId !== body.confirmationId || display.digest !== body.digest)) {
        throw new Error('app-management-confirmation-mismatch');
      }
      const operationId = action === 'confirm' ? display!.confirmationId : `dashboard:${session.id}:${body.requestId}`;
      session.active.add(operationId);
      try {
        if (action === 'confirm') await service.onboarding.confirm({ confirmationId: display!.confirmationId, digest: display!.digest }, 'dashboard-local-operator');
        else {
          textValue(body.appBindingId);
          await service.onboarding.reuse({ appBindingId: body.appBindingId as string,
            expectedRevision: body.expectedRevision as number, operationId }, 'dashboard-local-operator');
        }
        await this.current(session); session.display = undefined;
      } finally { session.active.delete(operationId); }
    } else if (action === 'revoke') {
      textValue(body.appBindingId);
      if (service.onboarding) service.onboarding.revoke({ appBindingId: body.appBindingId as string,
        expectedRevision: body.expectedRevision as number }, 'local-operator-revoked');
      else service.registry.revoke(body.appBindingId, body.expectedRevision as number, 'local-operator-revoked');
      session.display = undefined;
    }
    session.revision++;
    return this.view(session);
  }
  async close() {
    this.closed = true;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) this.end(session);
    await Promise.allSettled(sessions.flatMap(session => [...session.operations.values()].map(item => item.promise)));
  }
}
