import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopCapabilities, DesktopEnvironmentKind, DesktopObservationBinding } from '../src/contracts/desktop-environment.js';
import type { DesktopExecutionBackend, DesktopExecutionRequest, TargetBinding } from '../src/contracts/desktop-execution.js';
import { DesktopExecutionAdmission } from '../src/desktop-provider/execution-admission.js';
import { FakeInputControl } from '../src/desktop-provider/fake-input-control.js';
import { FakeDesktopBackend, FakeDesktopProvider, type FakeActionResult } from '../src/desktop-provider/fake-provider.js';
import { capabilities, declaration, definition, fixture, ready, semantic } from './fixtures/desktop-provider.js';

async function scoped(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  const port = f.backend.executionBackend(f.session);
  const gate = f.runtime.scopedExecution(f.provider);
  const target = await gate.bind('editor');
  const observation = f.backend.observe(target);
  const request: DesktopExecutionRequest<string> = { target, observation, action: 'edit', authority: f.authority };
  return { ...f, port, gate, target, observation, request };
}

async function idleScoped(input = new FakeInputControl(() => 0)) {
  const backend = new FakeDesktopBackend(definition(), input);
  const provider = new FakeDesktopProvider('fake', 'local-workspace', new Map([['fixture', backend]]), capabilities());
  const session = await provider.open('fixture');
  const gate = new DesktopExecutionAdmission(provider, session, input, backend.executionBackend(session));
  const target = await gate.bind('editor');
  return { input, backend, provider, session, gate, target };
}

test('preflight rejects unproven drag while idle; supported edit needs no authority and returns no token', async () => {
  const f = await idleScoped();
  f.input.assertAuthority = () => assert.fail('preflight must not inspect authority');
  f.input.acquire = () => assert.fail('preflight must not acquire input');
  f.input.renewAuthority = () => assert.fail('preflight must not renew input');
  try {
    const idle = f.input.view(f.session);
    assert.equal(idle.state, 'idle');
    await assert.rejects(f.gate.preflight(f.target, 'drag'), /target:input.semantic:not-proven/);
    assert.deepEqual(f.input.view(f.session), idle);
    assert.equal(await f.gate.preflight(f.target, 'edit'), undefined);
    assert.deepEqual(f.input.view(f.session), idle);
    assert.equal(f.backend.executed().length, 0);
  } finally { await f.session.close(); }
});

test('supported preflight neither renews an existing grant nor replaces an expired one', async () => {
  let now = 0;
  const f = await idleScoped(new FakeInputControl(() => now));
  try {
    const authority = await f.input.acquire(f.session, { kind: 'agent', clientId: 'task' });
    const held = f.input.view(f.session);
    now = 2999;
    await f.gate.preflight(f.target, 'edit');
    assert.deepEqual(f.input.view(f.session), held);
    now = 3000;
    assert.throws(() => f.input.assertAuthority(f.session, authority), /invalid-input-authority/);
    const expired = f.input.view(f.session);
    assert.equal(expired.state, 'expired');
    await f.gate.preflight(f.target, 'edit');
    assert.deepEqual(f.input.view(f.session), expired);
    assert.throws(() => f.input.assertAuthority(f.session, authority), /invalid-input-authority/);
    assert.equal(f.backend.executed().length, 0);
  } finally { await f.session.close(); }
});

test('preflight uses current bound identity and both readiness layers without owning input', async () => {
  const f = await idleScoped();
  try {
    for (const key of ['sessionId', 'instanceId', 'targetId', 'applicationVersion'] as const) {
      await assert.rejects(f.gate.preflight({ ...f.target, [key]: 'foreign' }, 'edit'), /unknown-or-changed/);
    }
    f.backend.setReadiness(ready('unknown'));
    await assert.rejects(f.gate.preflight(f.target, 'edit'), /session:input.semantic:not-ready/);
    f.backend.setReadiness(ready());
    f.backend.setTargetReadiness('editor', ready('not-ready'));
    await assert.rejects(f.gate.preflight(f.target, 'edit'), /target:input.semantic:not-ready/);
    f.backend.setTargetReadiness('editor', ready());
    assert.equal(f.input.view(f.session).state, 'idle');
    await f.backend.replaceInstance();
    await assert.rejects(f.gate.preflight(f.target, 'edit'), error => {
      assert(error instanceof AggregateError);
      assert(error.errors.every(item => /stale-session/.test(String(item))));
      return true;
    });
    assert.equal(f.backend.executed().length, 0);
  } finally { await f.session.close(); }
});

test('preflight before acquire cannot cache readiness, requirements or authority for execution', async () => {
  const f = await idleScoped();
  try {
    await f.gate.preflight(f.target, 'edit');
    assert.equal(f.input.view(f.session).state, 'idle');
    const authority = await f.input.acquire(f.session, { kind: 'agent', clientId: 'task' });
    const request = { target: f.target, action: 'edit', authority, observation: f.backend.observe(f.target) };
    f.backend.setTargetReadiness('editor', ready('not-ready'));
    await assert.rejects(f.gate.execute(request), /target:input.semantic:not-ready/);
    f.backend.setTargetReadiness('editor', ready());
    await assert.rejects(f.gate.execute({ ...request, action: 'drag' }), /target:input.semantic:not-proven/);
    await f.input.release(authority);
    await assert.rejects(f.gate.execute(request), /invalid-input-authority/);
    assert.equal(f.backend.executed().length, 0);
    await f.gate.preflight(f.target, 'edit');
    const fresh = await f.input.acquire(f.session, { kind: 'agent', clientId: 'task' });
    await f.gate.execute({ ...request, authority: fresh, observation: f.backend.observe(f.target) });
    assert.equal(f.backend.executed().length, 1);
  } finally { await f.session.close(); }
});

test('P6 admits the exact target/action across all environment families, without promoting drag', async () => {
  for (const kind of ['physical', 'virtual-machine', 'local-workspace'] satisfies DesktopEnvironmentKind[]) {
    const f = await scoped({ kind });
    try {
      assert.equal(Object.isFrozen(f.target), true);
      assert.deepEqual(Object.keys(f.target).sort(), ['providerId', 'environmentId', 'sessionId', 'instanceId',
        'inputResourceId', 'targetId', 'application', 'applicationVersion', 'targetRole'].sort());
      assert.equal(f.target.applicationVersion, '1.0');
      await assert.rejects(f.gate.execute({ ...f.request, action: 'drag' }), /target:input.semantic:not-proven/);
      assert.deepEqual(await f.gate.execute(f.request), { operationId: 'edit', targetId: f.target.targetId });
      await assert.rejects(f.gate.execute(f.request), /reobserve-required/);
      assert.equal(f.backend.executed().length, 1);
    } finally { await f.session.close(); }
  }
});

test('a desktop selection, external binding or forged target metadata never authorizes execution', async () => {
  const f = await scoped();
  try {
    const unissued = f.backend.bind(f.session, 'editor');
    await assert.rejects(f.gate.execute({ ...f.request, target: { ...f.target, ...unissued } }), /unknown-or-changed/);
    for (const key of ['providerId', 'environmentId', 'sessionId', 'instanceId', 'inputResourceId',
      'targetId', 'application', 'applicationVersion', 'targetRole'] as const) {
      await assert.rejects(f.gate.execute({ ...f.request, target: { ...f.target, [key]: 'foreign' } }), /unknown-or-changed/);
    }
    await assert.rejects(f.gate.bind('unlisted-app'), /unknown-target/);
    assert.equal(f.backend.executed().length, 0);
  } finally { await f.session.close(); }
});

test('binding rejects a foreign Session, changed trusted target and closure during an asynchronous bind', async () => {
  for (const change of ['session', 'version', 'close'] as const) {
    const f = await fixture();
    const port = f.backend.executionBackend(f.session);
    const changed = { ...port, bind: async (selector: string) => {
      const target = await port.bind(selector);
      if (change === 'close') await f.session.close();
      if (change === 'session') return { ...target, sessionId: 'foreign' };
      if (change === 'version') return { ...target, applicationVersion: '2' };
      return target;
    } };
    const gate = new DesktopExecutionAdmission(f.provider, f.session, f.input, changed);
    try {
      await assert.rejects(gate.bind('editor'), /foreign-target-session|stale-target-binding|stale-session/);
      assert.equal(f.backend.executed().length, 0);
    } finally { await f.session.close(); }
  }
});

test('observation must belong to the exact session, instance, resource and target', async () => {
  const f = await scoped();
  try {
    for (const key of ['providerId', 'environmentId', 'sessionId', 'instanceId', 'inputResourceId', 'targetId'] as const) {
      await assert.rejects(f.gate.execute({ ...f.request, observation: { ...f.observation, [key]: 'foreign' } }), /observation-target-mismatch/);
    }
    await assert.rejects(f.gate.execute({ ...f.request, observation: { ...f.observation, observationId: 'invented' } }), /reobserve-required/);
    f.backend.observe(f.target);
    await assert.rejects(f.gate.execute(f.request), /reobserve-required/);
    assert.equal(f.backend.executed().length, 0);
  } finally { await f.session.close(); }
});

for (const layer of ['provider', 'session', 'target'] as const) {
  for (const state of ['missing', 'unsupported', 'not-proven', 'forbidden'] as const) {
    test(`P6 execution rejects ${layer} ${state} despite ready descendants`, async () => {
      const config = definition();
      const denied = state === 'missing' ? {} : capabilities(state);
      if (layer === 'session') Object.assign(config, { capabilities: denied });
      if (layer === 'target') Object.assign(config.targets.editor, { capabilities: denied });
      const f = await scoped({ definition: config, providerCapabilities: layer === 'provider' ? denied : capabilities() });
      try {
        await assert.rejects(f.gate.execute(f.request), new RegExp(`${layer}:input.semantic:${state}`));
        assert.equal(f.backend.executed().length, 0);
      } finally { await f.session.close(); }
    });
  }
}

test('missing evidence, conflicting declarations and every scope dimension fail through the execution gate', async () => {
  const scope = { providerId: ['fake'], environmentKind: ['local-workspace'], application: ['fake-app'],
    applicationVersion: ['1.0'], targetRole: ['edit'], action: ['edit'], mechanism: ['fake-semantic'] };
  const cases: DesktopCapabilities[] = [
    { [semantic]: [{ state: 'supported', scope }] },
    { [semantic]: [declaration(), declaration('forbidden')] },
    ...Object.keys(scope).map(key => ({ [semantic]: [declaration('supported', { ...scope, [key]: ['foreign'] })] })),
  ];
  for (const providerCapabilities of cases) {
    const f = await scoped({ providerCapabilities });
    try {
      await assert.rejects(f.gate.execute(f.request), /missing-evidence|forbidden|scope-mismatch/);
      assert.equal(f.backend.executed().length, 0);
    } finally { await f.session.close(); }
  }
});

test('all executor requirements must pass; permitted mechanism cannot hide a forbidden fallback', async () => {
  const config = definition();
  Object.assign(config, { capabilities: { ...capabilities(), 'input.globalInput': [declaration('forbidden')] } });
  Object.assign(config.operations.edit, { required: [semantic, 'input.globalInput'] });
  const f = await scoped({ definition: config, providerCapabilities: {
    ...capabilities(), 'input.globalInput': [declaration('forbidden')],
  } });
  try {
    await assert.rejects(f.gate.execute(f.request), /provider:input.globalInput:forbidden/);
    assert.equal(f.backend.executed().length, 0);
  } finally { await f.session.close(); }
});

test('readiness is re-read per execution and does not rewrite evidence', async () => {
  const f = await scoped();
  try {
    for (const layer of ['session', 'target'] as const) {
      for (const state of ['not-ready', 'unknown', 'missing'] as const) {
        const value = state === 'missing' ? {} : ready(state);
        if (layer === 'session') f.backend.setReadiness(value);
        else f.backend.setTargetReadiness('editor', value);
        await assert.rejects(f.gate.execute(f.request), new RegExp(`${layer}:input.semantic:not-ready`));
        assert.equal((await f.session.capabilities())[semantic]![0].state, 'supported');
      }
      if (layer === 'session') f.backend.setReadiness(ready());
      else f.backend.setTargetReadiness('editor', ready());
    }
    await f.gate.execute(f.request);
    assert.equal(f.backend.executed().length, 1);
  } finally { await f.session.close(); }
});

test('backend effect fence rejects readiness/observation/revocation changes after Host admission', async () => {
  for (const change of ['readiness', 'observation', 'authority'] as const) {
    const f = await scoped();
    const port: DesktopExecutionBackend<string, FakeActionResult> = { ...f.port,
      execute: async request => {
        if (change === 'readiness') f.backend.setTargetReadiness('editor', ready('not-ready'));
        if (change === 'observation') f.backend.observe(f.target);
        if (change === 'authority') await f.input.release(f.authority);
        return f.port.execute(request);
      },
    };
    const gate = new DesktopExecutionAdmission(f.provider, f.session, f.input, port);
    try {
      const target = await gate.bind('editor');
      f.target = target;
      await assert.rejects(gate.execute({ ...f.request, target, observation: f.backend.observe(target) }),
        /not-ready|reobserve-required|invalid-input-authority/);
      assert.equal(f.backend.executed().length, 0);
    } finally { await f.session.close(); }
  }
});

test('backend bypass independently checks scoped support, authority and single-use observation', async () => {
  const f = await scoped();
  try {
    await assert.rejects(f.port.execute({ ...f.request, action: 'drag' }), /not-proven/);
    await assert.rejects(f.port.execute({ ...f.request, target: { ...f.target, applicationVersion: '2' } }), /stale-target/);
    await f.port.execute(f.request);
    await assert.rejects(f.port.execute(f.request), /reobserve-required/);
    await f.input.release(f.authority);
    await assert.rejects(f.port.execute({ ...f.request, observation: f.backend.observe(f.target) }), /invalid-input-authority/);
    assert.equal(f.backend.executed().length, 1);
  } finally { await f.session.close(); }
});

test('retained gate cannot adopt a replaced backend or restore serialized target/observation authority', async () => {
  const f = await scoped();
  try {
    await f.backend.replaceInstance();
    await assert.rejects(f.gate.execute(f.request), /stale-session/);
    await assert.rejects(f.gate.bind('editor'), /stale-session/);
    const replacement = await f.provider.open('fixture');
    try {
      const gate = new DesktopExecutionAdmission(f.provider, replacement, f.input, f.backend.executionBackend(replacement));
      await assert.rejects(gate.execute(structuredClone(f.request)), /unknown-or-changed/);
      assert.equal(f.backend.executed().length, 0);
    } finally { await replacement.close(); }
  } finally { await f.session.close(); }
});

test('expired/forged Agent authority and a valid Human grant never admit Agent execution', async () => {
  let now = 0;
  const f = await scoped({ input: new FakeInputControl(() => now) });
  try {
    await assert.rejects(f.gate.execute({ ...f.request, authority: { ...f.authority, grantId: 'forged' } }), /invalid-input-authority/);
    now = 3001;
    await assert.rejects(f.gate.execute(f.request), /invalid-input-authority/);
    const human = await f.input.acquire(f.session, { kind: 'human', clientId: 'viewer' });
    await assert.rejects(f.gate.execute({ ...f.request, authority: human }), /agent-input-authority-required/);
    assert.equal(f.backend.executed().length, 0);
  } finally { await f.session.close(); }
});

test('caller mutation during admission cannot alter dispatched payload and concurrent execution rejects', async () => {
  const f = await scoped();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const port = { ...f.port, requirements: async (target: TargetBinding, action: string) => {
    await pending; return f.port.requirements(target, action);
  } };
  const gate = new DesktopExecutionAdmission(f.provider, f.session, f.input, port);
  try {
    const target = await gate.bind('editor');
    const request = { ...f.request, target, observation: f.backend.observe(target) };
    const execution = gate.execute(request);
    await assert.rejects(gate.execute(request), /execution-admission-busy/);
    request.action = 'drag'; request.observation = {} as DesktopObservationBinding;
    release();
    assert.equal((await execution).operationId, 'edit');
    assert.equal(f.backend.executed().length, 1);
  } finally { release(); await f.session.close(); }
});

test('Host rechecks input after asynchronous capability reads and explicit invalidation closes admission', async () => {
  for (const change of ['release', 'invalidate'] as const) {
    const f = await scoped();
    let gate!: DesktopExecutionAdmission<string, FakeActionResult>;
    const port = { ...f.port, requirements: async (target: TargetBinding, action: string) => {
      const requirements = await f.port.requirements(target, action);
      if (change === 'release') await f.input.release(f.authority);
      else gate.invalidate();
      return requirements;
    } };
    gate = new DesktopExecutionAdmission(f.provider, f.session, f.input, port);
    try {
      const target = await gate.bind('editor');
      await assert.rejects(gate.execute({ ...f.request, target, observation: f.backend.observe(target) }),
        /invalid-input-authority|execution-admission-closed/);
      assert.equal(f.backend.executed().length, 0);
    } finally { await f.session.close(); }
  }
});

test('trusted target status cannot replace a binding, and malformed requirements fail closed', async () => {
  for (const change of ['version', 'target', 'empty', 'mechanism'] as const) {
    const f = await scoped();
    let mutate = false;
    const port = { ...f.port,
      targetStatus: async (target: TargetBinding) => {
        const status = await f.port.targetStatus(target);
        if (mutate && change === 'version') return { ...status, binding: { ...target, applicationVersion: '2' } };
        if (mutate && change === 'target') return { ...status, binding: { ...target, targetId: 'replacement' } };
        return status;
      },
      requirements: async (target: TargetBinding, action: string) => {
        const operation = await f.port.requirements(target, action);
        if (change === 'empty') return { ...operation, required: [] };
        if (change === 'mechanism') return { ...operation, mechanism: 'unproven-fallback' };
        return operation;
      },
    };
    const gate = new DesktopExecutionAdmission(f.provider, f.session, f.input, port);
    try {
      const target = await gate.bind('editor'); mutate = true;
      await assert.rejects(gate.execute({ ...f.request, target, observation: f.backend.observe(target) }),
        /stale-target-binding|missing-requirements|scope-mismatch/);
      assert.equal(f.backend.executed().length, 0);
    } finally { await f.session.close(); }
  }
});
