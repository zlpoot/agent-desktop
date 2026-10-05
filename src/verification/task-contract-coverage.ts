import type {CompletionCriteria} from '../verifier/verifier.js';
import {auditGoalFileCoverage} from './goal-file-coverage.js';

/** Frozen before the first action. This audit can identify a gap, never certify task success. */
export interface TaskContractCoverage {
  covered:boolean;
  reason?:string;
  requiredFiles:string[];
  reviewRequired:boolean;
}

const durableIntent=/(保存|提交|发布|支付|发送|\bsave\b|\bsubmit\b|\bpublish\b|\bpay\b|\bsend\b)/i;

export function auditTaskContractCoverage(goal:string,criteria:CompletionCriteria|undefined,
  declaredFilePaths:readonly string[]=[]):TaskContractCoverage {
  const files=auditGoalFileCoverage(goal,declaredFilePaths);
  if(!files.covered)return {covered:false,reason:files.reason,
    requiredFiles:files.requiredNames,reviewRequired:true};
  // 持久结果来源二选一：①独立结果控件（成功提示 field=text），或②可编辑字段的重投影持久化
  // 契约（persistedAfter=rebind，离开后以新控件身份重读到应用回填值）。当前输入框值不算。
  const durableStructured=criteria?.structuredStates?.some(item=>
      item.persistedAfter==='rebind' ||
      (item.field==='text' && ['text','status','alert'].includes(item.target.role.toLowerCase())));
  if(durableIntent.test(goal) && !declaredFilePaths.length && !durableStructured)
    return {covered:false,reason:'durable_result_source_missing',
      requiredFiles:files.requiredNames,reviewRequired:true};
  return {covered:true,requiredFiles:files.requiredNames,reviewRequired:false};
}
