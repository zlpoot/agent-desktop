import { randomUUID } from 'node:crypto';
import type { DesktopProvider, DesktopSession } from '../../src/contracts/desktop-environment.js';
import type { InputControl } from '../../src/contracts/desktop-provider.js';
import type { WorkerClient } from '../../src/contracts/worker-client.js';
import { desktopTarget } from '../../src/contracts/task-desktop.js';
import { TaskDesktopSessions } from '../../src/app/task-desktop-sessions.js';

export const fixtureDesktopTarget = desktopTarget('fixture-provider', 'fixture-environment');
/** No OS, transport or input: only a backend-established synthetic immutable identity. */
export function fixtureDesktopSessions(connect: () => Promise<WorkerClient>, control: InputControl = {
  assertTaskAllowed() {}, workerEndpoint: () => 'fixture', async beginTask() {}, async finishTask() { return false; },
}, lifecycleOwner: () => object = () => control): TaskDesktopSessions {
  const provider: DesktopProvider = {
    id: fixtureDesktopTarget.providerId, kind: 'virtual-machine', async capabilities() { return {}; },
    async discover() { return [{ ...fixtureDesktopTarget, kind: 'virtual-machine' }]; },
    async open(environmentId): Promise<DesktopSession> {
      if (environmentId !== fixtureDesktopTarget.environmentId) throw new Error('unknown-environment');
      let closed = false;
      return Object.freeze({ ...fixtureDesktopTarget, sessionId: randomUUID(), instanceId: 'fixture-instance',
        inputResourceId: 'fixture-input', async capabilities() { return {}; },
        async status() { return { state: closed ? 'closed' as const : 'open' as const, readiness: {} }; },
        async close() { closed = true; },
      });
    },
  };
  return new TaskDesktopSessions([provider], new Map([[provider.id, {
    taskControl: () => control, connectRuntime: connect, lifecycleOwner,
    completeTask: async (_session, taskId) => { await control.finishTask(taskId, 'done'); },
  }]]));
}
