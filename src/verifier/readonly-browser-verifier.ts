import type { Observation } from '../actions/schema.js';
import type { PlannedVerificationContract } from '../agent/task-planner.js';
import { deterministicChecks, normalizeEvidence, type AcceptanceReport } from './hybrid-verifier.js';
import type { CompletionCriteria } from './verifier.js';
import { auditTaskContractCoverage } from '../verification/task-contract-coverage.js';
import { matchesReadonlyBrowserContract } from '../agent/readonly-browser-plan.js';

/** Conservative serialized-DOM title read; markup inside raw text is not a title element. */
function domTitle(dom?:string):string|undefined {
  const html=dom?.replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const head=html?.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1];
  if(head===undefined || /<template\b/i.test(head))return undefined;
  const titles=[...head.matchAll(/<title\b[^>]*>([^<]*)<\/title\s*>/gi)];
  return titles.length===1?titles[0][1]:undefined;
}

/** Narrow read-only identity check: URL, DOM title and body marker, frozen before execution. */
export function isReadonlyBrowserContract(goal:string, contract?:PlannedVerificationContract):boolean {
  return matchesReadonlyBrowserContract(goal,contract,contract?.successConditions);
}

/** No model fallback: missing, partial or mismatched provenance must remain UNKNOWN. */
export function readonlyBrowserAcceptance(goal:string, criteria:CompletionCriteria|undefined,
  observation:Observation|undefined, contract:PlannedVerificationContract):AcceptanceReport {
  const report:AcceptanceReport={mode:'assist',verdict:'unknown',
    observationId:normalizeEvidence(observation).observationId,checks:[],
    reason:'evidence_unavailable',message:'只读网页缺少同次采集的完整 URL / DOM 证据'};
  if(!matchesReadonlyBrowserContract(goal,contract,criteria))
    return {...report,reason:'unsupported_condition',message:'只读网页完成条件与冻结契约不一致或不受支持'};
  if(!auditTaskContractCoverage(goal,criteria).covered)
    return {...report,reason:'unsupported_condition',message:'原始目标仍缺少文件或持久结果契约，禁止以只读页面条件放行'};
  // Eligibility already requires the exact title element derived from the full goal.
  // Keep the frozen DOM substring check and the independent head/title comparison.
  const frozenTitle=criteria?.domIncludes;
  const expectedTitle=frozenTitle?.match(/^<title>([^<>]+)<\/title>$/i)?.[1]
    ?? (frozenTitle && !/[<>]/.test(frozenTitle)?frozenTitle:undefined);
  if(expectedTitle===undefined)
    return {...report,reason:'unsupported_condition',message:'只读网页标题条件须为纯标题文字或完整 title 元素'};
  const capture=observation?.capture;
  if(!capture || !capture.epoch || capture.object!==`page:${capture.epoch}` || capture.clock!=='collector'
    || !Number.isInteger(capture.sequence) || capture.sequence<1
    || !Number.isFinite(capture.startedAt) || !Number.isFinite(capture.finishedAt)
    || capture.finishedAt<capture.startedAt
    || !(['url','dom','pageText'] as const).every(field=>capture.fields[field]?.complete===true
      && capture.fields[field]?.source===(field==='url'?'api':'dom')))
    return report;
  const checks=deterministicChecks(criteria,observation,contract);
  let expectedUrl:string;
  try {
    const url=new URL(criteria!.urlIncludes!);
    if(!['http:','https:'].includes(url.protocol))throw Error('Unsupported URL');
    expectedUrl=url.href;
  } catch {return {...report,reason:'unsupported_condition',message:'只读网页需要冻结的完整 HTTP(S) URL'};}
  checks.push({criterion:'browserUrl',verdict:observation?.url===undefined?'unknown':observation.url===expectedUrl?'pass':'fail',
    ...(observation?.url===undefined?{reason:'evidence_unavailable' as const}:{}),
    message:'最终 URL 必须与冻结的完整地址一致'});
  // domIncludes alone can match a body heading while <title> is wrong.
  const title=domTitle(observation?.dom);
  checks.push({criterion:'browserTitle',verdict:title===undefined?'unknown':title===expectedTitle?'pass':'fail',
    ...(title===undefined?{reason:'evidence_unavailable' as const}:{}),message:'DOM <title> 必须与冻结的网页标题一致'});
  const verdict=checks.some(check=>check.verdict==='fail')?'fail'
    : checks.length>0 && checks.every(check=>check.verdict==='pass')?'pass':'unknown';
  return {...report,checks,verdict,reason:verdict==='unknown'?'evidence_unavailable':undefined,
    message:verdict==='pass'?'只读网页 URL、DOM 标题及正文标记已通过冻结条件验收'
      :verdict==='fail'?'当前只读网页证据与冻结条件存在明确反证':report.message};
}
