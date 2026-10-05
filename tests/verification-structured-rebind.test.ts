import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../src/actions/schema.js';
import type { CompletionCriteria } from '../src/verifier/verifier.js';
import {
  captureRebindBaseline,
  ingestRebindObservation,
  evaluateRebindTask,
  type RebindStateMap,
} from '../src/verification/structured-rebind.js';

const OLD = '13900000001';
const NEW = '13977770002';
const R0 = [7, 1];
const R1 = [7, 2];

function uiaObs(sequence: number, controls: Array<{ role: string; name?: string; value?: string; runtimeId: unknown }>,
  complete = true): Observation {
  return {
    dom: JSON.stringify(controls.map((c) => ({ ...c }))),
    capture: {
      epoch: 'e', sequence, object: 'uia:desktop', startedAt: sequence, finishedAt: sequence + 1,
      clock: 'collector', atomic: false,
      fields: { dom: { complete: true, source: 'uia' as const } },
      enumerationComplete: complete,
    },
  };
}

const phone = (value: string, runtimeId: unknown = R0) => ({ role: 'Edit', name: '手机号', value, runtimeId });
const criteria: CompletionCriteria = {
  structuredStates: [
    { target: { role: 'Edit', name: '手机号' }, field: 'value', equals: NEW, persistedAfter: 'rebind' },
  ],
};
const cond = criteria.structuredStates![0];

/** 跑完整 PASS 链：基线 R0/A → 编辑 R0/B → 保存 → 离开(缺席) → 重开 R1=reboundValue。 */
function runChain(reboundValue: string, reboundId: unknown = R1) {
  let map: RebindStateMap = {};
  map[0] = captureRebindBaseline(undefined, uiaObs(0, [phone(OLD, R0)]), cond);
  // seq1：在同一身份 R0 上把缓冲改成 B（type，动作 dispatched，但同一步不算提交）。
  map[0] = ingestRebindObservation(map[0], uiaObs(1, [phone(NEW, R0)]), cond, true);
  // seq2：点击保存后仍停在详情，R0 缓冲还是 B；编辑之后的首个 dispatched 动作记为提交。
  map[0] = ingestRebindObservation(map[0], uiaObs(2, [phone(NEW, R0)]), cond, true);
  // seq3：离开详情，完整枚举中目标缺席（界面上即便有静态提示也与目标 Edit 无关）。
  map[0] = ingestRebindObservation(map[0], uiaObs(3, [{ role: 'Text', name: '提示', value: '客户资料已保存', runtimeId: [9] }]), cond, true);
  // seq4：重新打开，应用以新身份 R1 重建控件并用内部状态回填 reboundValue。
  map[0] = ingestRebindObservation(map[0], uiaObs(4, [{ role: 'Edit', name: '手机号', value: reboundValue, runtimeId: reboundId }]), cond, true);
  return map;
}

test('rebind PASS：保存→离开→重开，新身份重投影值=期望（输入框缓冲/静态提示不参与）', () => {
  const map = runChain(NEW, R1);
  const terminal = uiaObs(5, [{ role: 'Edit', name: '手机号', value: NEW, runtimeId: R1 }]);
  const report = evaluateRebindTask(criteria, map, terminal, 'uia');
  assert.equal(report.verdict, 'pass');
  assert.equal(report.checks[0].verdict, 'pass');
  assert.equal(report.checks[0].evidence?.actual, NEW);
  assert.equal(map[0].baseline?.runtimeId, JSON.stringify(R0));
  assert.notEqual(map[0].rebound?.runtimeId, JSON.stringify(R0));
});

test('rebind FAIL：应用拒绝保存，重开后新身份仍回填旧值——条件里没有任何 banner，仅凭重绑旧值即 FAIL', () => {
  // 成功/失败提示都不在完成条件中；即使界面上同时出现“保存失败”Text，门也不读取它。
  const map = runChain(OLD, R1);
  const terminal = uiaObs(5, [
    { role: 'Edit', name: '手机号', value: OLD, runtimeId: R1 },
    { role: 'Text', name: '提示', value: '保存失败，请重试', runtimeId: [9] },
  ]);
  const report = evaluateRebindTask(criteria, map, terminal, 'uia');
  assert.equal(report.verdict, 'fail');
  assert.equal(report.checks[0].verdict, 'fail');
  assert.equal(report.checks[0].evidence?.actual, OLD);
  assert.equal(report.contradiction, true);
  // 完成条件只有一个可编辑字段，证明 FAIL 完全来自重绑旧值而非错误提示识别。
  assert.equal(criteria.structuredStates!.length, 1);
});

test('rebind UNKNOWN：只有同一 R0 的编辑缓冲与静态已保存提示，从未离开/重绑', () => {
  let map: RebindStateMap = {};
  map[0] = captureRebindBaseline(undefined, uiaObs(0, [phone(OLD, R0)]), cond);
  map[0] = ingestRebindObservation(map[0], uiaObs(1, [
    phone(NEW, R0), { role: 'Text', name: '提示', value: '客户资料已保存', runtimeId: [9] },
  ]), cond, true);
  map[0] = ingestRebindObservation(map[0], uiaObs(2, [
    phone(NEW, R0), { role: 'Text', name: '提示', value: '客户资料已保存', runtimeId: [9] },
  ]), cond, true);
  const terminal = uiaObs(3, [
    phone(NEW, R0), { role: 'Text', name: '提示', value: '客户资料已保存', runtimeId: [9] },
  ]);
  const report = evaluateRebindTask(criteria, map, terminal, 'uia');
  assert.equal(report.verdict, 'unknown');
  assert.equal(report.checks[0].reason, 'missing_leave_boundary');
});

test('rebind UNKNOWN：缺席只来自不完整枚举时不成立，链不前进', () => {
  let map: RebindStateMap = {};
  map[0] = captureRebindBaseline(undefined, uiaObs(0, [phone(OLD, R0)]), cond);
  map[0] = ingestRebindObservation(map[0], uiaObs(1, [phone(NEW, R0)]), cond, true);
  map[0] = ingestRebindObservation(map[0], uiaObs(2, [phone(NEW, R0)]), cond, true);
  // 一次不完整枚举里看不到目标，绝不能当作「离开」反证或边界。
  map[0] = ingestRebindObservation(map[0], uiaObs(3, [], false), cond, true);
  const terminal = uiaObs(4, [phone(NEW, R0)]);
  const report = evaluateRebindTask(criteria, map, terminal, 'uia');
  assert.equal(report.verdict, 'unknown');
  assert.equal(report.checks[0].reason, 'missing_leave_boundary');
  assert.equal(map[0].absentSequence, undefined);
});

test('rebind UNKNOWN：终态控件身份不是重投影身份 R1（证据陈旧/被再次重开）', () => {
  const map = runChain(NEW, R1);
  const terminal = uiaObs(5, [{ role: 'Edit', name: '手机号', value: NEW, runtimeId: '[7,3]' }]);
  const report = evaluateRebindTask(criteria, map, terminal, 'uia');
  assert.equal(report.verdict, 'unknown');
  assert.equal(report.checks[0].reason, 'rebound_identity_not_current');
});

test('rebind UNKNOWN：缺少动作前基线（目标不可唯一/不可读）', () => {
  const map: RebindStateMap = { 0: captureRebindBaseline(undefined, undefined, cond) };
  const terminal = uiaObs(5, [{ role: 'Edit', name: '手机号', value: NEW, runtimeId: R1 }]);
  const report = evaluateRebindTask(criteria, map, terminal, 'uia');
  assert.equal(report.verdict, 'unknown');
  assert.equal(report.checks[0].reason, 'missing_rebind_baseline');
});

test('rebind UNKNOWN：终态完整枚举中重投影控件缺席', () => {
  const map = runChain(NEW, R1);
  const terminal = uiaObs(5, []);
  const report = evaluateRebindTask(criteria, map, terminal, 'uia');
  assert.equal(report.verdict, 'unknown');
  assert.equal(report.checks[0].reason, 'rebound_control_absent');
});

test('rebind UNKNOWN：保存前的离开不计入缺席边界', () => {
  let map: RebindStateMap = {};
  map[0] = captureRebindBaseline(undefined, uiaObs(0, [phone(OLD, R0)]), cond);
  // seq1：尚未编辑就离开（完整枚举缺席），这是保存前导航，不能算提交后缺席。
  map[0] = ingestRebindObservation(map[0], uiaObs(1, []), cond, true);
  map[0] = ingestRebindObservation(map[0], uiaObs(2, [phone(NEW, R0)]), cond, true);
  map[0] = ingestRebindObservation(map[0], uiaObs(3, [phone(NEW, R0)]), cond, true);
  const terminal = uiaObs(4, [phone(NEW, R0)]);
  const report = evaluateRebindTask(criteria, map, terminal, 'uia');
  assert.equal(report.verdict, 'unknown');
  assert.equal(map[0].absentSequence, undefined);
});
