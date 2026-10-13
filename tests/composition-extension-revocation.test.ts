import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionRegistry } from '../src/contracts/extension.js';
import type { ObservationFacetProvider } from '../src/contracts/facets.js';
import type { VerifierContributor } from '../src/contracts/verifier-contributor.js';
import type { Observation } from '../src/actions/schema.js';
import type { ModelProvider, PlanningModel } from '../src/contracts/model-provider.js';
import type { WorkerClient } from '../src/contracts/worker-client.js';
import type { PlannedVerificationContract } from '../src/agent/task-planner.js';
import { extensionVerification } from '../src/composition/extension-verification.js';
import { createRootAssembly } from '../src/composition/root.js';
import { collectFacets } from '../src/verification/facet-binding.js';
import { HybridVerifier } from '../src/verifier/hybrid-verifier.js';
import { SqliteTrace } from '../src/trace/sqlite-trace.js';
import { fixtureDesktopSessions, fixtureDesktopTarget } from './fixtures/task-desktop.js';

const domain = 'synthetic.revocable';
const criteria = { windowTitleIncludes: '合成窗口',
  domainChecks: [{ domain, predicate: 'equals', args: { value: 1 } }] };
function fixture() {
  let collected = 0, evaluated = 0;
  const provider: ObservationFacetProvider = { id: domain, schemaVersion: 1, providerVersion: '1',
    environment: 'windows', source: 'uia', validate: () => ({ ok: true }),
    async collect() { collected++; return { complete: true, data: { value: 1 } }; } };
  const contributor: VerifierContributor = { id: domain, criterionSchemaVersion: 1,
    canEvaluate: () => true, validateCriterion: () => ({ ok: true }),
    evaluate(_criterion, bound) {
      evaluated++;
      const facet = bound.requireFacet(domain);
      return { verdict: 'pass', message: '合成域满足', criterionSchemaVersion: 1,
        evidenceRefs: [{ facetId: domain, captureId: bound.captureId, subjectRef: bound.subject,
          providerVersion: facet.providerVersion, schemaVersion: facet.schemaVersion }] };
    } };
  const registry = new ExtensionRegistry();
  registry.register({ id: domain, facets: [provider], contributors: [contributor] });
  return { registry, provider, contributor, counts: () => ({ collected, evaluated }) };
}
function observation(sequence = 1): Observation {
  const now = Date.now();
  return { windowTitle: '合成窗口', windowHandle: 1, dom: '[]',
    capture: { epoch: 'synthetic', sequence, object: 'window:synthetic:1',
      startedAt: now, finishedAt: now, clock: 'collector', atomic: false,
      enumerationComplete: true, fields: { dom: { complete: true, source: 'uia' },
        windowTitle: { complete: true, source: 'window' } } } };
}

test('同一 Root 启用→运行→卸载→再运行：不调用旧 Facet/Contributor，域条件 UNKNOWN 而非 PASS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'composition-revocation-'));
  const f = fixture();
  const model: ModelProvider = { createModel() { return {
    name: '合成域规划', kind: 'rule', async decide() { return { kind: 'done', summary: '核对完成' }; },
    async planStage() { return { goal: '核对窗口', successCondition: '合成窗口已核对', isFinal: true }; },
    async verifyStage() { return { ok: true, confidence: 1, evidence: '合成窗口', source: 'uia' }; },
    async planTask(goal: string) { return { task: { environment: 'windows', plan: ['核对窗口'],
      completionCriteria: criteria, verificationContract: { goal, successConditions: criteria,
        evidenceSources: { windowTitleIncludes: 'window', domainChecks: 'uia' }, verifierStrategy: 'rules_then_jev' } } }; },
    async transcribeScreenshot() { return { text: '' }; },
    async locateVisualTarget() { throw Error('不应定位'); }, takeVisualUsage() { return undefined; },
  } as PlanningModel; } };
  let sequence = 0;
  const worker: WorkerClient = {
    async listWindows() { return []; }, async ensureApp() { throw Error('不应启动 APP'); }, async attach() {},
    async observe() { return observation(++sequence); },
    async probe() { return { windowClass: 'SyntheticWindow', foreground: true, elevated: false,
      targetElevated: false, permissionsCompatible: true, title: '合成窗口', processId: 1, processPath: null,
      visible: true, minimized: false, rect: { left: 0, top: 0, width: 800, height: 600 }, uiaControls: true }; },
    async recoverFocus() {}, async ground() { return { attempts: [] }; },
    async resolveAction() { throw Error('不应解析动作'); }, async execute() { throw Error('不应输入'); },
    async restore() {}, async close() {},
  };
  const root = await createRootAssembly({ rootDir: dir, extensionRegistry: f.registry, model,
    desktopSessions: fixtureDesktopSessions(async () => worker) });
  const trace = new SqliteTrace(join(dir, 'web-tasks.sqlite'));
  const run = async () => {
    const id = root.controller.submit('核对合成窗口', { desktopTarget: fixtureDesktopTarget });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = trace.load(id);
      if (state && ['done', 'failed', 'paused', 'waiting_user'].includes(state.status)) return state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error(`合成任务未收尾：${JSON.stringify(trace.load(id))}`);
  };
  try {
    const enabled = await run();
    assert.equal(enabled.status, 'done'); assert.equal(enabled.goalVerification?.ok, true);
    assert.equal(enabled.baselineChecks?.find(check => check.criterion.startsWith('domainChecks:'))?.verdict, 'pass');
    assert.ok(f.counts().collected > 0); assert.ok(f.counts().evaluated > 0);
    await f.registry.unregister(domain);
    const before = f.counts();
    const revoked = await run();
    assert.deepEqual(f.counts(), before, '实际任务采集/验收不得调用已卸载引用');
    assert.notEqual(revoked.status, 'done'); assert.notEqual(revoked.goalVerification?.ok, true);
    const check = revoked.baselineChecks?.find(item => item.criterion.startsWith('domainChecks:'));
    assert.equal(check?.verdict, 'unknown'); assert.equal(check?.reason, 'unsupported_condition');
    assert.equal(check?.domainAudit?.contributorFound, false);
  } finally { await root.dispose(); trace.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('已持有的采集列表和长期 HybridVerifier 在卸载后拒绝旧引用与缓存证据；重新注册可恢复', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw Error('不允许网络/辅助模型'); });
  const f = fixture(), ports = extensionVerification(f.registry);
  const retained = ports.facetProviders;
  const verifier = new HybridVerifier({ ...ports, baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic',
    mode: 'assist', confidenceThreshold: 0.8, timeoutMs: 100, instructions: () => '' });
  const decisive = { ...criteria, structuredStates: [{ target: { role: 'Edit', name: 'Value' },
    field: 'value' as const, equals: 'ok' }] };
  const contract: PlannedVerificationContract = { goal: '核对合成窗口', successConditions: decisive,
    evidenceSources: { windowTitleIncludes: 'window', domainChecks: 'uia', structuredStates: 'uia' },
    verifierStrategy: 'rules_then_jev' };
  const observed = () => ({ ...observation(), dom: JSON.stringify([{ role: 'Edit', name: 'Value', value: 'ok',
    visible: true, enabled: true, nameComplete: true, valueComplete: true }]) });
  const captured = await collectFacets(observed(), retained);
  assert.equal((await verifier.evaluate('核对合成窗口', decisive, captured, 'task', contract)).verdict, 'pass');
  await f.registry.unregister(domain);
  const before = f.counts();
  assert.equal((await collectFacets(observation(), retained)).facets?.[domain], undefined);
  assert.equal((await verifier.evaluate('核对合成窗口', decisive, captured, 'task', contract)).verdict, 'unknown');
  assert.equal(ports.domainEvaluator(criteria.domainChecks, captured)[0].audit.contributorFound, false);
  assert.deepEqual(f.counts(), before);
  const replacement = fixture();
  f.registry.register(replacement.registry.listExtensions()[0]);
  assert.equal((await collectFacets(observation(), retained)).facets?.[domain], undefined, '同 ID 重注册不激活旧实例');
  const fresh = await collectFacets(observed(), ports.facetProviders);
  assert.equal((await verifier.evaluate('核对合成窗口', decisive, fresh, 'task', contract)).verdict, 'pass');
  assert.equal(replacement.counts().collected, 1); assert.ok(replacement.counts().evaluated > 0);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('Facet collect 在途时卸载：返回的旧载荷被丢弃，后续不再调用旧 collect', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  f.provider.collect = async () => { calls++; await gate; return { complete: true, data: { value: 1 } }; };
  const ports = extensionVerification(f.registry), retained = ports.facetProviders;
  const pending = collectFacets(observation(), retained);
  assert.equal(calls, 1);
  try { await f.registry.unregister(domain); }
  finally { release(); }
  const captured = await pending;
  assert.equal(captured.facets?.[domain], undefined);
  assert.equal(ports.domainEvaluator(criteria.domainChecks, captured)[0].verdict, 'unknown');
  await collectFacets(observation(), retained);
  assert.equal(calls, 1);
});
