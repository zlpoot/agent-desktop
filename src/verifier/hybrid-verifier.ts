import { createHash } from 'node:crypto';
import { isBudgetExceeded, meteredModelRequest } from '../runtime/model-budget.js';
import type { Observation } from '../actions/schema.js';
import { verifyGoal, type CompletionCriteria, type VerificationResult } from './verifier.js';
import {checkStructuredState} from '../verification/structured-state.js';
import type {PlannedVerificationContract} from '../agent/task-planner.js';
import type { FacetRegistry } from '../contracts/facets.js';
import type { ContributorRegistry } from '../contracts/verifier-contributor.js';
import type { DomainCheckOutcome, DomainEvaluator } from '../verification/domain-evaluator.js';
import { createDomainEvaluator } from '../verification/domain-evaluator.js';

export type Verdict = 'pass' | 'fail' | 'unknown';
const durableResultGoal=/(保存|提交|发布|支付|发送|\bsave\b|\bsubmit\b|\bpublish\b|\bpay\b|\bsend\b)/i;
export type UnknownReason = 'unsupported_condition' | 'evidence_unavailable' | 'target_ambiguous' |
  'observation_stale' | 'verification_error' | 'rebind_pending';
export interface AcceptanceReport {
  mode: 'shadow' | 'assist';
  verdict: Verdict;
  observationId: string;
  checks: Array<{ criterion: string; verdict: Verdict; message: string; reason?: UnknownReason;
    evidence?:{source:'dom'|'uia';target:{role:string;name?:string;text?:string};field:string;
      actual?:string|boolean;expected:string|boolean;captureSequence?:number};
    domainAudit?: DomainCheckOutcome['audit'] }>;
  reason?: UnknownReason;
  auxiliary?: { verdict: Verdict; confidence: number; error?: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; durationMs: number };
  message: string;
}
export interface AcceptanceVerifier {
  evaluate(goal: string, criteria: CompletionCriteria | undefined, observation: Observation | undefined,
    scope: 'task' | 'stage', contract?:PlannedVerificationContract,
    baselineChecks?:AcceptanceReport['checks']): Promise<AcceptanceReport>;
}

/** Normalize provenance, not truth: UI text remains untrusted content; desktopPath is not a saved-file path. */
export function normalizeEvidence(observation?: Observation) {
  const facts = {
    window: { title: observation?.windowTitle, handle: observation?.windowHandle,
      meaning: '当前窗口身份；标题不能证明文件路径或持久化' },
    browser: { url: observation?.url, dom: observation?.dom?.slice(0, 16000) },
    accessibility: { text: observation?.accessibility?.slice(0, 16000),
      meaning: '当前UIA文本；可能包含多个对象，必须确认目标绑定；未修改表示无未保存修改，已修改表示有未保存修改' },
    text: observation?.textEvidence?.map(e => ({ source: e.source, text: e.text.slice(0, 8000),
      authoritative: e.source !== 'visual_model' })).slice(0, 16),
    desktopDirectory: { path: observation?.desktopPath, meaning: '用户桌面目录配置，不证明任何文件存在于此' },
    // 业务无关的域证据外壳：核心只透传已盖章 facet（含信封），不解读其 data 的业务含义。
    facets: Object.values(observation?.facets ?? {}).map((facet) => ({
      facetId: facet.facetId, schemaVersion: facet.schemaVersion, providerVersion: facet.providerVersion,
      captureId: facet.captureId, subjectRef: facet.subjectRef, source: facet.source,
      capturedAt: facet.capturedAt, complete: facet.complete, data: facet.data })),
  };
  return { observationId: createHash('sha256').update(JSON.stringify(observation ?? null)).digest('hex'),
    scope: '仅当前观察，不引用历史动作成功或旧观察', facts };
}

export function deterministicChecks(criteria?: CompletionCriteria, observation?: Observation,
  contract?:PlannedVerificationContract, evaluateDomain?: DomainEvaluator): AcceptanceReport['checks'] {
  if (!criteria || !Object.keys(criteria).length) return [{criterion:'completionCriteria', verdict:'unknown',
    reason:'unsupported_condition', message:'未配置完整的独立完成条件'}];
  const scalarKeys=['urlIncludes','windowTitleIncludes','pageTextIncludes','pageTextIncludesAll',
    'pageTextNumberLabels','domIncludes','accessibilityIncludes'] as const;
  const checks:AcceptanceReport['checks']=Object.entries(criteria)
    .filter(([key,v])=>key!=='structuredStates'&&key!=='domainChecks'
      &&scalarKeys.includes(key as typeof scalarKeys[number])&&v !== undefined).map(([criterion]) => {
    const result = verifyGoal({[criterion]:criteria[criterion as keyof CompletionCriteria]}, observation);
    // Missing text in partial UIA/DOM is not proof of a negative. Only explicit scalar counterevidence is a failure.
    const actual: Record<string, unknown> = {
      urlIncludes: observation?.url, windowTitleIncludes: observation?.windowTitle,
    };
    const supported = scalarKeys.includes(criterion as typeof scalarKeys[number]);
    const expectedSource=contract?.evidenceSources[criterion];
    const capturedSource=criterion==='windowTitleIncludes'&&observation?.capture?.object.startsWith('window:')
      ?'window':observation?.capture?.fields[criterion==='urlIncludes'?'url':
        criterion==='pageTextIncludes'||criterion==='pageTextIncludesAll'?'pageText':
        criterion==='domIncludes'?'dom':'accessibility']?.source;
    const sourceMatches=!contract||!!expectedSource&&
      (expectedSource==='browser'?'api':expectedSource)===capturedSource;
    const verdict: Verdict = !supported||!sourceMatches ? 'unknown' : result.ok ? 'pass'
      : actual[criterion] !== undefined ? 'fail' : 'unknown';
    return {criterion, verdict, message:supported ? result.message : '不支持的完成条件，禁止静默忽略',
      ...(verdict==='unknown' ? {reason:supported ? 'evidence_unavailable' as const
        : 'unsupported_condition' as const} : {})};
  });
  // 域完成条件：业务无关地交给已注册 contributor；缺装配/缺当次证据一律 UNKNOWN（fail-closed）。
  const recognizedKeys = new Set<string>([...scalarKeys, 'structuredStates', 'domainChecks']);
  for (const key of Object.keys(criteria)) {
    if (!recognizedKeys.has(key) && (criteria as Record<string, unknown>)[key] !== undefined) {
      checks.push({ criterion: key, verdict: 'unknown', reason: 'unsupported_condition',
        message: `不支持的完成条件 ${key}，禁止静默忽略` });
    }
  }
  if (criteria.domainChecks?.length) {
    if (!evaluateDomain) {
      criteria.domainChecks.forEach((_, index) => checks.push(
        {criterion:`domainChecks:${index}`,verdict:'unknown',reason:'unsupported_condition',
          message:'配置了域完成条件，但核心未装配域验收贡献器，禁止静默忽略'}));
    } else {
      for (const outcome of evaluateDomain(criteria.domainChecks, observation)) {
        checks.push({criterion:outcome.criterion,verdict:outcome.verdict,message:outcome.message,
          ...(outcome.verdict==='unknown'
            ?{reason:(outcome.reason as UnknownReason)??'evidence_unavailable'}:{}),
          domainAudit:outcome.audit});
      }
    }
  }
  for(const [index,condition] of (criteria.structuredStates??[]).entries()) {
    if(condition.persistedAfter==='rebind'){
      // 可编辑持久字段绝不在单快照上裁决：当前输入框值可能只是未提交缓冲。终态由 graph 的
      // rebind 链（离开→新身份重投影）给出 pass/fail/unknown，这里保持 fail-closed 占位。
      checks.push({criterion:`structuredStates:${index}`,verdict:'unknown',reason:'rebind_pending',
        message:'可编辑字段需经保存后离开并重开、以新控件身份重投影来证明持久值，当前输入框值不构成证据'});
      continue;
    }
    const source=contract?.evidenceSources.structuredStates;    const checked=source==='dom'||source==='uia'
      ?checkStructuredState(condition,observation,source)
      :{verdict:'unknown' as const,reason:'unsupported_condition',message:'缺少冻结的结构化证据来源'};
    checks.push({criterion:`structuredStates:${index}`,verdict:checked.verdict,message:checked.message,
      ...(checked.verdict==='unknown'?{reason:checked.reason as UnknownReason}:{}),
      ...(source==='dom'||source==='uia'?{evidence:{source,target:condition.target,
        field:condition.field,actual:checked.actual,expected:condition.equals,
        captureSequence:observation?.capture?.sequence}}:{})});
  }
  return checks;
}

export class HybridVerifier implements AcceptanceVerifier {
  private readonly domainEvaluator?: DomainEvaluator;
  constructor(private readonly options: { baseUrl: string; apiKey: string; mode: 'shadow' | 'assist';
    confidenceThreshold: number; timeoutMs: number; instructions: () => string;
    facets?: FacetRegistry; contributors?: ContributorRegistry }) {
    if (!Number.isFinite(options.confidenceThreshold) || options.confidenceThreshold < 0 || options.confidenceThreshold > 1)
      throw new Error('Invalid verifier confidence threshold');
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error('Invalid verifier timeout');
    // 注册表缺省时域条件一律 UNKNOWN：核心不内置任何业务 contributor（fail-closed）。
    if (options.facets && options.contributors) {
      this.domainEvaluator = createDomainEvaluator(options.contributors, options.facets);
    }
  }
  async evaluate(goal: string, criteria: CompletionCriteria | undefined, observation: Observation | undefined,
    scope: 'task' | 'stage', contract?:PlannedVerificationContract,
    baselineChecks?:AcceptanceReport['checks']): Promise<AcceptanceReport> {
    const evidence = normalizeEvidence(observation);
    const checks = scope === 'stage' ? []
      : deterministicChecks(criteria, observation, contract, this.domainEvaluator);
    if (scope === 'task' && durableResultGoal.test(goal) && baselineChecks) {
      criteria?.structuredStates?.forEach((condition, index) => {
        if (condition.field !== 'text' || !['text','status','alert'].includes(condition.target.role.toLowerCase())) return;
        const key = `structuredStates:${index}`;
        if (baselineChecks.some(check => check.criterion === key && check.verdict === 'pass')) {
          const current = checks.find(check => check.criterion === key);
          if (current?.verdict === 'pass') {
            current.verdict = 'unknown'; current.reason = 'observation_stale';
            current.message = '结果提示在本次任务开始前已存在，不能证明本次保存或提交成功';
          }
        }
      });
    }
    const report: AcceptanceReport = {mode:this.options.mode, observationId:evidence.observationId,
      checks, verdict:'unknown', reason:checks.find(c=>c.verdict==='unknown')?.reason??'evidence_unavailable',
      message:'证据不足，需补充观察，不能重复有副作用的动作'};
    if(scope==='task'&&contract&&
      (contract.goal.trim()!==goal.trim()||JSON.stringify(contract.successConditions)!==JSON.stringify(criteria)))
      return {...report,checks:[{criterion:'frozen_contract',verdict:'unknown',
        reason:'unsupported_condition',message:'当前完成条件与执行前冻结的契约不一致'}],
        reason:'unsupported_condition'};
    if (checks.some(c=>c.verdict==='fail')) return {...report, verdict:'fail', reason:undefined,
      message:'确定性验证存在明确反证'};
    if (!observation || checks.some(c=>c.verdict==='unknown')) return report;
    if(scope==='task'&&durableResultGoal.test(goal)&&
      !criteria?.structuredStates?.some(item=>item.persistedAfter==='rebind'||
        (item.field==='text'&&['text','status','alert'].includes(item.target.role.toLowerCase())))) {
      const missing={criterion:'durable_outcome',verdict:'unknown' as const,
        reason:'unsupported_condition' as const,
        message:'目标要求保存或提交结果，但冻结条件缺少绑定的独立结果控件，当前文字或输入值不足以证明结果'};
      return {...report,checks:[...checks,missing],reason:'unsupported_condition',message:missing.message};
    }
    // A frozen, source-bound structured result is already decisive. JEV cannot
    // improve an exact current control value and need not consume tokens here.
    if(scope==='task' && criteria?.structuredStates?.length && checks.length &&
      checks.every(c=>c.verdict==='pass'))return {...report,verdict:'pass',reason:undefined,
        message:'目标控件与全部冻结完成条件已通过确定性验收'};
    const started = Date.now();
    try {
      const payload = await meteredModelRequest('jev', async () => {
      const response = await fetch(`${this.options.baseUrl.replace(/\/+$/,'').replace(/\/v1$/,'')}/v1/systemone`, {
        method:'POST', headers:{Authorization:`Bearer ${this.options.apiKey}`, 'Content-Type':'application/json'},
        signal:AbortSignal.timeout(this.options.timeoutMs), body:JSON.stringify({model:'jev',
          state:{goal, scope, criteria, deterministicChecks:checks, evidence,
            hostClock:{iso:new Date().toISOString(), localDate:new Date().toLocaleDateString('en-CA'),
              timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}},
          questions:{verdict:{type:'choice', instructions:this.options.instructions(), criteria:{
            pass:'完整目标的全部条件均有当前且属于目标对象的证据支持，无冲突。',
            fail:'当前可信证据明确反驳至少一个目标条件。',
            unknown:'缺失、冲突、过期、对象不明或仅部分满足；禁止用动作成功推断目标完成。',
          }}}}),
      });
      if (!response.ok) throw new Error(`JEV HTTP ${response.status}`);
      return await response.json() as {answers?:{verdict?:{type?:string;choice?:string;confidence?:number}};
        usage?:{input_tokens?:number;output_tokens?:number}};
      });
      const a = payload.answers?.verdict;
      if (a?.type !== 'choice' || !['pass','fail','unknown'].includes(a.choice ?? '') ||
        typeof a.confidence !== 'number' || !Number.isFinite(a.confidence) || a.confidence<0 || a.confidence>1)
        throw new Error('JEV 返回的验收结论格式无效');
      report.auxiliary={verdict:a.choice as Verdict, confidence:a.confidence, durationMs:Date.now()-started,
        usage:{inputTokens:payload.usage?.input_tokens, outputTokens:payload.usage?.output_tokens,
          totalTokens:payload.usage?.input_tokens !== undefined && payload.usage?.output_tokens !== undefined
            ? payload.usage.input_tokens + payload.usage.output_tokens : undefined}};
      report.verdict=a.confidence >= this.options.confidenceThreshold ? a.choice as Verdict : 'unknown';
      report.reason=report.verdict==='unknown'?'evidence_unavailable':undefined;
      report.message=report.verdict==='pass' ? '确定性条件与 JEV 完整目标辅助验收通过'
        : report.verdict==='fail' ? 'JEV 指出当前证据不满足目标' : 'JEV 证据不足或置信度不足，需要补充证据';
    } catch(error) {
      if (isBudgetExceeded(error)) throw error;
      report.auxiliary={verdict:'unknown',confidence:0,durationMs:Date.now()-started,
        error:error instanceof Error ? error.message : 'JEV 验收服务异常'};
      report.reason='verification_error';
      report.message='JEV 验收暂不可用，未放行任务';
    }
    return report;
  }
}

export function applyAcceptance(original: VerificationResult, report: AcceptanceReport): VerificationResult {
  if(report.mode==='shadow') return original;
  return {...original, ok:original.ok && report.verdict==='pass', message:report.message};
}
