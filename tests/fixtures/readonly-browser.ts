import { prepareReadonlyBrowserTask, type ReadonlyBrowserTask } from '../../src/agent/readonly-browser-plan.js';

/** Explicit trusted fixture, including the entire goal; no language matcher. */
export function readonlyFixture(goal: string, url: string, title: string, marker: string) {
  const request: ReadonlyBrowserTask = { sourceId: 'synthetic-fixture', scope: 'complete-task', goal, url, title, marker,
    allowedActions: ['navigate', 'done', 'wait', 'ask_user'] };
  return { request, ...prepareReadonlyBrowserTask(goal, request) };
}
