import { randomUUID } from 'node:crypto';
import type { Workflow, WorkflowStep } from '../../src/workflows/schema.js';
import type { TraceStore } from '../../src/contracts/stores.js';
import { semanticTarget } from '../../src/actions/semantic-target.js';
import { KEY_SUBMIT_SELECTOR } from '../../src/desktop-provider/local-workspace-chrome-provider.js';

/** Curated candidate from the LIVE-01 rules' independently accepted REAL UI trace.
 * Core model-driven distillation is unchanged and does not accept rule/Fake traces.
 * This entry only saves a candidate, never promotes it or dispatches a replay. */
export function candidateFromLiveTrace(trace: TraceStore, taskId: string, sourceTrace: string): Workflow {
  const final=trace.load(taskId);
  if(final?.executorId!=='live-01-hidden-chrome'||final.status!=='done'||!final.goalVerification?.ok||
      final.acceptanceReport?.verdict!=='pass'||!final.verifiedFiles?.length||!final.completionCriteria)
    throw new Error('Live candidate requires independent task and file acceptance');
  const events=trace.events(taskId);
  const steps: WorkflowStep[]=[];
  for(const event of events.filter(event=>event.node==='execute'&&event.state.lastResult?.ok)) {
    const verified=events.some(next=>next.step===event.step&&next.node==='verify'&&next.state.lastVerification?.ok);
    const action=event.state.groundedAction??event.state.lastAction;
    if(!verified||!action)throw new Error('Live candidate action lacks verification');
    if(action.kind==='ask_user'||action.kind==='done'||action.kind==='screenshot'||action.kind==='wait')continue;
    if('target' in action&&(action.target?.kind==='coordinate'||action.target?.kind==='vision'||action.target?.kind==='candidates'))
      throw new Error('Live candidate requires a stable semantic/DOM target');
    const target='target' in action?action.target:undefined;
    const submit=action.kind==='click'&&action.target.kind==='selector'&&action.target.selector===KEY_SUBMIT_SELECTOR;
    steps.push({stepId:`live-${event.step}`,goal:submit?'一次性创建并私下保存 Key':action.kind,
      action:structuredClone(action),preferredMethods:['owned-chrome-cdp'],
      ...(target&&target.kind!=='candidates'?{targetHint:target,semanticTarget:semanticTarget(target)}:{}),
      successCondition:action.kind==='navigate'?{kind:'url_includes',value:'/'}:
        action.kind==='type'?{kind:'text_includes',value:action.text}:
        submit?{kind:'text_includes',value:'"apiKeyGenerated":true'}:{kind:'state_changed'},
      idempotent:!submit});
  }
  if(steps.filter(step=>step.action.kind==='click'&&step.action.target.kind==='selector'&&step.action.target.selector===KEY_SUBMIT_SELECTOR).length!==1)
    throw new Error('Live candidate must have one verified creation boundary');
  const inputs:Workflow['inputs']=[];
  for(const step of steps)if(step.action.kind==='type') {
    const name=step.action.text==='40000'?'maxOutputTokens':'keyName';
    inputs.push({name,example:step.action.text,kind:'text',boundTo:{stepId:step.stepId!,argument:'text'}});
    step.action.text=`{{${name}}}`;
    step.successCondition={kind:'text_includes',value:`{{${name}}}`};
  }
  return {id:randomUUID(),version:1,status:'candidate',workflowSchemaVersion:2,environment:'browser',
    taskPattern:final.goal.replaceAll('agent-desktop-hidden-chrome-20261009','{{keyName}}').replaceAll('40000','{{maxOutputTokens}}'),
    inputs,preconditions:[],steps,successConditions:structuredClone(final.completionCriteria),
    knownFailures:['规则驱动的真实 UI 轨迹；未调用模型，未触发核心模型驱动蒸馏或自动发布。'],
    sourceTaskId:taskId,sourceTrace,createdAt:new Date().toISOString(),successCount:0,failureCount:0};
}
