import { resolve } from 'node:path';
import type { InputControl } from '../contracts/desktop-provider.js';
import type { PreparedDesktopScenario, DesktopScenarioVerification } from '../contracts/desktop-scenario.js';
import type { TraceStore } from '../contracts/stores.js';
import type { DesktopSession } from '../contracts/desktop-environment.js';
import type { ComputerState } from '../graph/state.js';
import type { TaskDesktopSessions } from './task-desktop-sessions.js';

/** Uses the same queue, durable Task/Session binding, budget and pause lifecycle.
 * Its entire action space is one explicit finite scenario; no generic planner/runtime fallback. */
export async function runDesktopScenarioTask(rootDir: string, taskId: string, trace: TraceStore,
  sessions: TaskDesktopSessions, setControl: (control: InputControl) => void, cancelled: () => boolean): Promise<void> {
  let state: ComputerState | undefined, session: DesktopSession | undefined, control: InputControl | undefined,
    prepared: PreparedDesktopScenario | undefined, claimed = false, verified: DesktopScenarioVerification | undefined,
    earlyCleanupError: unknown;
  const checkPause = () => {
    if (cancelled() || trace.pauseRequested(taskId)) throw new Error('DESKTOP_SCENARIO_PAUSED');
  };
  try {
    state = trace.load(taskId);
    if (!state?.desktopScenario || !state.desktopTarget) throw new Error('desktop-scenario-required');
    if (state.desktopExecutionBinding || state.desktopScenarioDispatched) throw new Error('desktop-scenario-replay-forbidden');
    checkPause();
    trace.save('desktop_scenario_preparing', { ...state, summary: '正在绑定并检查固定场景；尚未取得输入许可' });
    const entry = await sessions.acquire(taskId, state, binding => {
      state = { ...state!, desktopExecutionBinding: binding };
      trace.save('desktop_bound', state);
    });
    session = entry.session; control = entry.control; setControl(control);
    checkPause();
    prepared = await entry.executor.prepareScenario!(session,
      resolve(rootDir, '.artifacts', 'web-tasks', taskId, 'screenshots'), state.desktopScenario);
    await prepared.preflight();
    checkPause();
    await control.beginTask(taskId); claimed = true;
    checkPause(); control.assertTaskAllowed(taskId);
    const observation = await prepared.observe();
    checkPause(); control.assertTaskAllowed(taskId);
    state = { ...state, observation, beforeObservation: observation, step: 1 };
    trace.save('observe', state);
    state = { ...state, status: 'running', observation, beforeObservation: observation, step: 1,
      desktopScenarioDispatched: true, verificationPending: true, summary: '执行固定有限场景；等待独立结果观察' };
    trace.save('desktop_scenario_dispatch', state); // Ambiguous dispatch is never automatically replayed.
    await prepared.execute();
    trace.save('desktop_scenario_verifying', { ...state, summary: '固定场景已发出一次，正在独立观察验证' });
    const deadline = performance.now() + 45000;
    do {
      checkPause(); control.assertTaskAllowed(taskId);
      verified = await prepared.verify();
      checkPause(); control.assertTaskAllowed(taskId);
      if (verified.verdict === 'pass') break;
      if (performance.now() >= deadline) throw new Error('desktop-scenario-verification-timeout');
      await new Promise<void>(resolveWait => setTimeout(resolveWait, 100));
    } while (true);
    state = { ...state, observation: verified.observation, verificationPending: false,
      goalVerification: { ok: true, message: '固定场景通过独立结果观察' },
      desktopScenarioVerification: { verdict: verified.verdict, facts: verified.facts } };
    trace.save('observe', state);
    trace.save('verify', { ...state, lastVerification: state.goalVerification });
    trace.save('desktop_scenario_verified', state);
  } catch (error) {
    if (/cleanup|drain/i.test(String(error))) earlyCleanupError = error;
    state = trace.load(taskId) ?? state;
    if (state) {
      const uncertain = state.desktopScenarioDispatched === true;
      state = { ...state, status: uncertain || String(error).includes('DESKTOP_SCENARIO_PAUSED') ? 'paused' : 'failed',
        verificationPending: false, recoveryRequired: uncertain, recoveryUncertain: uncertain,
        error: String(error), summary: uncertain ? '有限场景已发出，结果未确认；禁止自动重放，请显式提交新任务' : '有限场景未执行' };
      trace.save('desktop_scenario_error', state);
    }
    verified = undefined;
  } finally {
    const errors: unknown[] = earlyCleanupError ? [earlyCleanupError] : [];
    // A recording failure must not prevent revocation and resource cleanup.
    try { if (state) trace.save('desktop_scenario_cleanup', { ...state, summary: '正在撤销输入许可并清理所属资源' }); }
    catch (error) { errors.push(error); }
    // Even preflight rejection closes the newly opened owned Job/Desktop, without claiming input.
    for (const cleanup of [async () => { if (claimed) await control!.finishTask(taskId, state?.status); },
      () => prepared?.close(), () => session?.close()]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length && state) {
      state = { ...state, status: 'failed', recoveryRequired: true, recoveryUncertain: true,
        error: [state.error, 'desktop-scenario-cleanup-unconfirmed', ...errors.map(String)].filter(Boolean).join('; '),
        summary: '有限场景清理未确认，输入资源保持阻断' };
      trace.save('desktop_scenario_cleanup_error', state);
    } else if (state) {
      trace.save('desktop_scenario_cleanup_done', state);
      if (verified?.verdict === 'pass') trace.save('desktop_scenario_done', { ...state, status: 'done', recoveryRequired: false, recoveryUncertain: false,
        error: undefined, summary: '固定有限场景通过独立结果观察；所属 Job/Desktop 已清理' });
    }
    trace.close();
  }
}
