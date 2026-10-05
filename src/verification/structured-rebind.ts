import type { Observation } from '../actions/schema.js';
import type { CompletionCriteria } from '../verifier/verifier.js';
import {checkStructuredState} from './structured-state.js';

/**
 * 可编辑结构化字段的「提交 ↔ 应用自身重投影」持久化门（通用，不绑定任何应用/夹具）。
 *
 * 仅靠当前屏幕上输入框里的值不能证明一次保存被应用接受：那可能只是尚未提交的编辑缓冲，
 * 也可能是任务开始前就存在的旧值。要把「本次保存动作」归因到「应用内部的持久结果」，
 * 必须在一条完整因果链里观察到目标控件的身份与值：
 *
 *   R0(基线, 旧值 A) → 保存动作 dispatched → 目标在一次完整枚举中缺席（离开详情/页面切换）
 *     → 目标以不同 runtimeId R1 重新投影（应用重建控件并用其内部状态回填）
 *     → 终态新鲜定位到 R1：值=期望 B → PASS；值在场但仍为旧值/≠B → 可归因 FAIL。
 *
 * 链上任一环缺失（未重绑的同一 R0 编辑缓冲、静态结果提示、没有缺席边界、没有新身份、
 * 枚举不完整、终态定位到的不是 R1）一律 UNKNOWN。本模块从不读取动作文本之外的进程名、
 * 命令行参数或任何测试模式；banner/错误提示不参与裁决。
 */

export type RebindVerdict = 'pass' | 'fail' | 'unknown';
export type RebindReason =
  | 'missing_rebind_baseline'
  | 'missing_commit'
  | 'missing_leave_boundary'
  | 'missing_rebound_control'
  | 'rebound_identity_not_current'
  | 'rebound_control_absent'
  | 'target_ambiguous'
  | 'evidence_unavailable';

export type StructuredCondition = NonNullable<CompletionCriteria['structuredStates']>[number];

/** 原始控件（保留 runtimeId 身份；归一化 structured.items 不含身份）。 */
export interface RawControl {
  role: string;
  name?: string;
  value?: string;
  checked?: boolean;
  runtimeId: string;
  nameComplete?: boolean;
  valueComplete?: boolean;
}

interface RebindCheckEvidence {
  source: 'dom' | 'uia';
  target: StructuredCondition['target'];
  field: string;
  actual?: string | boolean;
  expected: string | boolean;
  captureSequence?: number;
}

export interface RebindCheck {
  criterion: string;
  verdict: RebindVerdict;
  message: string;
  reason?: RebindReason;
  evidence?: RebindCheckEvidence;
}

/** 单个 rebind 条件跨观察累积的链状态，随 checkpoint 持久化。 */
export interface RebindConditionState {
  /** 动作前：目标控件身份 R0 与其旧值 A（首个唯一完整枚举冻结，只冻结一次；value 兼容 checked）。 */
  baseline?: { sequence: number; runtimeId: string; value: string | boolean };
  /** R0 编辑缓冲首次变为≠A 的序号（证明 Agent 在目标控件里输入了新值 B）。 */
  editedSequence?: number;
  /** 编辑之后、首个已 dispatched 动作（保存/提交）所在的观察序号；缺席/重绑只在其后统计。 */
  committedSequence?: number;
  /** 提交后：目标至少在一次完整枚举中缺席（离开详情/页面切换）的序号。 */
  absentSequence?: number;
  /** 随后以不同 runtimeId R1 重投影时的身份与值。 */
  rebound?: { sequence: number; runtimeId: string; value: string | boolean };
  /** 目标在任一完整枚举中命中多个身份，无法唯一绑定。 */
  ambiguous?: boolean;
}

export type RebindStateMap = Record<number, RebindConditionState>;

/** 从观察自推断证据来源：uia（Windows 原始控件数组）或 dom（Browser 结构化枚举）。 */
function evidenceSourceOf(observation: Observation | undefined): 'dom' | 'uia' | undefined {
  if (observation?.capture?.fields.dom?.source === 'uia') return 'uia';
  if (observation?.structured?.source === 'dom') return 'dom';
  return undefined;
}

/** 字段值比较：字符串按空白规整后比较，布尔严格比较。 */
function fieldEquals(actual: string | boolean | undefined, expected: string | boolean): boolean {
  if (actual === undefined) return false;
  return typeof actual === 'string' && typeof expected === 'string'
    ? actual.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim()
    : actual === expected;
}

/**
 * 仅在一次「完整枚举」中返回原始控件；非完整/不可解析时返回 undefined，
 * 调用方据此 fail-closed，绝不把缺席当反证。
 * uia：Windows Worker 的原始 UIA 控件数组（JSON dom，runtimeId 身份）。
 * dom：Browser 当次结构化枚举（items 必须带节点级 identity，缺失视为不可解析）。
 */
export function parseRawControls(observation: Observation | undefined,
  source: 'dom' | 'uia'): RawControl[] | undefined {
  if (source === 'uia') {
    const dom = observation?.dom;
    if (typeof dom !== 'string' || !dom.trim()) return undefined;
    if (observation?.capture?.fields.dom?.source !== 'uia') return undefined;
    if (!observation.capture?.enumerationComplete) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(dom); } catch { return undefined; }
    if (!Array.isArray(parsed) || parsed.length > 500) return undefined;
    const controls: RawControl[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return undefined;
      const node = item as Record<string, unknown>;
      if (typeof node.role !== 'string' || node.runtimeId === undefined || node.runtimeId === null) return undefined;
      const control: RawControl = {
        role: node.role,
        runtimeId: JSON.stringify(node.runtimeId),
        ...(typeof node.name === 'string' ? { name: node.name } : {}),
        ...(typeof node.value === 'string' ? { value: node.value } : {}),
        ...(node.nameComplete === false ? { nameComplete: false } : {}),
        ...(node.valueComplete === false ? { valueComplete: false } : {}),
      };
      controls.push(control);
    }
    return controls;
  }
  // dom：Browser 当次结构化枚举。identity（页面加载世代 + DOM 路径）即运行时身份；
  // 跨导航必变，同页内唯一。任何一项缺 identity 都视为不可解析（fail closed）。
  const structured = observation?.structured;
  if (!structured || structured.source !== 'dom' || !structured.complete) return undefined;
  const controls: RawControl[] = [];
  for (const item of structured.items) {
    if (!item.identity) return undefined;
    controls.push({
      role: item.role,
      ...(item.name !== undefined ? { name: item.name } : {}),
      ...(item.value !== undefined ? { value: item.value } : {}),
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      runtimeId: item.identity,
      ...(item.complete === false ? { nameComplete: false, valueComplete: false } : {}),
    });
  }
  return controls;
}

/** 读取条件字段对应的持久属性（value 字符串 / checked 布尔）；其他字段不支持 rebind，返回 undefined。 */
function readField(control: RawControl, field: StructuredCondition['field']): string | boolean | undefined {
  if (field === 'checked') return control.checked;
  if (field === 'value') return control.value;
  return undefined;
}

/** 该字段是否被完整采集（无法读取时链保持缺失 → 终态 UNKNOWN）。 */
function fieldComplete(control: RawControl, field: StructuredCondition['field']): boolean {
  if (field === 'checked') return control.checked !== undefined;
  if (field === 'value') return control.value !== undefined && control.valueComplete !== false;
  return false;
}

function roleMatches(control: RawControl, target: StructuredCondition['target']): boolean {
  return control.role.toLowerCase() === target.role.toLowerCase();
}

function nameMatches(control: RawControl, target: StructuredCondition['target']): boolean {
  if (target.name !== undefined) {
    if (control.name !== target.name || control.nameComplete === false) return false;
    return roleMatches(control, target);
  }
  return roleMatches(control, target);
}

/** 在完整枚举中唯一定位目标：0 缺席 / 1 唯一 / >1 歧义。 */
export function locateTarget(controls: readonly RawControl[], condition: StructuredCondition):
  { count: number; control?: RawControl } {
  const matched = controls.filter((control) => nameMatches(control, condition.target));
  return { count: matched.length, ...(matched.length === 1 ? { control: matched[0] } : {}) };
}

/** step0 冻结基线身份与旧值。仅在唯一、可读时写入；否则保持缺失→终态 UNKNOWN。 */
export function captureRebindBaseline(previous: RebindConditionState | undefined,
  observation: Observation | undefined, condition: StructuredCondition): RebindConditionState {
  if (previous?.baseline) return previous;
  const source = evidenceSourceOf(observation);
  const controls = source ? parseRawControls(observation, source) : undefined;
  if (!controls) return previous ?? {};
  const located = locateTarget(controls, condition);
  if (located.count !== 1 || !located.control) {
    return { ...(previous ?? {}), ...(located.count > 1 ? { ambiguous: true } : {}) };
  }
  const control = located.control;
  if (!fieldComplete(control, condition.field)) return previous ?? {};
  return { ...(previous ?? {}),
    baseline: { sequence: observation?.capture?.sequence ?? 0, runtimeId: control.runtimeId,
      value: readField(control, condition.field)! } };
}

/**
 * 在一次动作后的新观察上推进链（纯观察 + 该动作是否已 dispatched，通用，不识别任何应用/按钮名）。
 * 非完整枚举/不可解析时不改动链。顺序：基线 R0/A → R0 缓冲变为≠A(edited) → 编辑后首个 dispatched
 * 动作(committed，保存/提交) → 其后完整枚举缺席 → 再后以不同身份 R1 重投影。保存前的离开不会被统计。
 */
export function ingestRebindObservation(previous: RebindConditionState | undefined,
  observation: Observation | undefined, condition: StructuredCondition, dispatched: boolean): RebindConditionState {
  const next: RebindConditionState = { ...(previous ?? {}) };
  const baseline = next.baseline;
  if (!baseline) return next;
  const source = evidenceSourceOf(observation);
  const controls = source ? parseRawControls(observation, source) : undefined;
  if (!controls) return next;
  const located = locateTarget(controls, condition);
  const sequence = observation?.capture?.sequence ?? 0;
  if (located.count > 1) { next.ambiguous = true; return next; }

  // 阶段1：确认 Agent 在同一身份 R0 上把缓冲改成了≠A 的新值。
  if (next.committedSequence === undefined) {
    if (located.count === 1 && located.control!.runtimeId === baseline.runtimeId) {
      const value = readField(located.control!, condition.field);
      if (value !== undefined && !fieldEquals(value, baseline.value) && next.editedSequence === undefined)
        next.editedSequence = sequence;
    }
    // 编辑之后的首个已发出动作即视为提交（点击保存/回车等）；不在同一步把输入自身当提交。
    if (next.editedSequence !== undefined && sequence > next.editedSequence && dispatched)
      next.committedSequence = sequence;
  }
  if (next.committedSequence === undefined || sequence < next.committedSequence) return next;

  // 阶段2：提交之后，完整枚举缺席=离开详情（边界，不是反证）；不同身份重投影=应用回填。
  if (located.count === 0) {
    if (next.absentSequence === undefined) next.absentSequence = sequence;
    return next;
  }
  const control = located.control!;
  if (control.runtimeId !== baseline.runtimeId && next.absentSequence !== undefined && !next.rebound) {
    const value = readField(control, condition.field);
    next.rebound = { sequence, runtimeId: control.runtimeId,
      ...(value !== undefined ? { value } : { value: '' }) };
  }
  return next;
}

function rebindCheck(condition: StructuredCondition, index: number, state: RebindConditionState | undefined,
  terminal: Observation | undefined): RebindCheck {
  const criterion = `structuredStates:${index}`;
  const expected = condition.equals;
  const source = evidenceSourceOf(terminal) ?? 'uia';
  const unknown = (reason: RebindReason, message: string, actual?: string | boolean): RebindCheck => ({
    criterion, verdict: 'unknown', reason, message,
    evidence: { source, target: condition.target, field: condition.field, expected,
      ...(actual !== undefined ? { actual } : {}), captureSequence: terminal?.capture?.sequence } });
  if (state?.ambiguous)
    return unknown('target_ambiguous', '目标控件在完整枚举中不唯一，无法绑定重投影身份');
  if (!state?.baseline)
    return unknown('missing_rebind_baseline', '缺少动作前冻结的基线控件身份与旧值，无法证明本次保存归因');
  if (state.editedSequence === undefined || state.committedSequence === undefined)
    return unknown('missing_commit', '未观察到在目标控件编辑新值后发出保存/提交动作，或当前值只是未提交的编辑缓冲');
  if (state.absentSequence === undefined)
    return unknown('missing_leave_boundary', '保存后未观察到目标在完整枚举中缺席（离开详情），同一输入框可能只是未提交的编辑缓冲');
  if (!state.rebound)
    return unknown('missing_rebound_control', '未观察到目标以新控件身份重新投影，无法读取应用自身回填的持久值');
  const controls = source === 'uia' ? parseRawControls(terminal, 'uia') : parseRawControls(terminal, 'dom');
  if (!controls)
    return unknown('evidence_unavailable', '终态缺少完整的结构化枚举，无法新鲜定位重投影控件');
  const located = locateTarget(controls, condition);
  if (located.count > 1)
    return unknown('target_ambiguous', '终态目标控件不唯一');
  if (located.count === 0)
    return unknown('rebound_control_absent', '终态完整枚举中重投影控件已缺席，终态与重绑身份不一致');
  const control = located.control!;
  if (control.runtimeId !== state.rebound.runtimeId)
    return unknown('rebound_identity_not_current', '终态控件身份不是重投影身份 R1，证据可能陈旧，拒绝放行');
  if (!fieldComplete(control, condition.field))
    return unknown('evidence_unavailable', '重投影控件的字段读取不完整');
  const actual = readField(control, condition.field)!;
  if (fieldEquals(actual, expected))
    return { criterion, verdict: 'pass',
      message: `保存动作后离开并重开，应用以新控件身份重投影，新鲜值等于期望（${JSON.stringify(condition.target.name ?? condition.target.text)}）`,
      evidence: { source, target: condition.target, field: condition.field, actual, expected,
        captureSequence: terminal?.capture?.sequence } };
  // 关键：仅凭重绑后的旧值/矛盾值即 FAIL，不引用任何 banner 或错误提示。
  return { criterion, verdict: 'fail',
    message: `保存已发出且应用以新身份重投影，但重投影值仍为 ${JSON.stringify(actual)}，不等于期望 ${JSON.stringify(String(expected))}：应用拒绝/未接受本次保存`,
    evidence: { source, target: condition.target, field: condition.field, actual, expected,
      captureSequence: terminal?.capture?.sequence } };
}

export interface RebindTaskReport {
  verdict: RebindVerdict;
  checks: RebindCheck[];
  /** 存在「重绑后值矛盾」的可归因 FAIL（区别于证据不足）。 */
  contradiction: boolean;
  message: string;
}

/**
 * 终态裁决：对冻结条件里带 persistedAfter:'rebind' 的结构化项走重投影链；同一 structuredStates
 * 数组里的普通项仍按单快照确定性核对。任何 FAIL 优先；全部 PASS 才 PASS；否则 UNKNOWN。
 */
export function evaluateRebindTask(criteria: CompletionCriteria,
  rebind: RebindStateMap | undefined, terminal: Observation | undefined,
  source: 'dom' | 'uia' = 'uia'): RebindTaskReport {
  const checks: RebindCheck[] = [];
  for (const [index, condition] of (criteria.structuredStates ?? []).entries()) {
    if (condition.persistedAfter === 'rebind') {
      checks.push(rebindCheck(condition, index, rebind?.[index], terminal));
    } else {
      const checked = source === 'dom' || source === 'uia'
        ? checkStructuredState(condition, terminal, source)
        : { verdict: 'unknown' as const, reason: 'unsupported_condition' as const, message: '缺少冻结的结构化证据来源' };
      checks.push({ criterion: `structuredStates:${index}`, verdict: checked.verdict, message: checked.message,
        ...(checked.verdict === 'unknown' ? { reason: 'evidence_unavailable' as const } : {}) });
    }
  }
  const contradiction = checks.some((check) => check.verdict === 'fail');
  const anyUnknown = checks.some((check) => check.verdict === 'unknown');
  const verdict: RebindVerdict = contradiction ? 'fail' : anyUnknown || !checks.length ? 'unknown' : 'pass';
  const message = verdict === 'pass'
    ? '可编辑字段经「保存→离开→重开→新身份重投影」证明持久结果等于期望'
    : verdict === 'fail'
      ? '重投影的持久值与期望矛盾：应用未接受本次保存（忽略任何提示横幅仍成立）'
      : (checks.find((check) => check.verdict === 'unknown')?.message ?? '重投影因果链不完整，保持 UNKNOWN');
  return { verdict, checks, contradiction, message };
}

/** 冻结条件中是否包含 rebind 持久化项。 */
export function hasRebindCondition(criteria: CompletionCriteria | undefined): boolean {
  return !!criteria?.structuredStates?.some((item) => item.persistedAfter === 'rebind');
}

/** 需要走 rebind 门的条件下标。 */
export function rebindConditionIndexes(criteria: CompletionCriteria | undefined): number[] {
  return (criteria?.structuredStates ?? [])
    .map((item, index) => (item.persistedAfter === 'rebind' ? index : -1))
    .filter((index) => index >= 0);
}
