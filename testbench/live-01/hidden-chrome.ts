import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ComputerAction } from '../../src/actions/schema.js';
import type { ModelAdapter } from '../../src/agent/model-adapter.js';
import { createAgentLoop } from '../../src/graph/graph.js';
import { initialState, type ComputerState } from '../../src/graph/state.js';
import { LocalWorkspaceChromeProvider, KEY_SUBMIT_SELECTOR, KEY_NAME_SELECTOR, KEY_TOKENS_SELECTOR, KEY_MODEL_PREFIX, type ChromeDiscovery } from '../../src/desktop-provider/local-workspace-chrome-provider.js';
import { Command, MemorySaver } from '@langchain/langgraph';
import { distillWorkflow } from '../../src/workflows/distill.js';
import { WorkflowStore } from '../../src/workflows/store.js';
import { normalizeEvidence } from '../../src/verifier/hybrid-verifier.js';
import { candidateFromLiveTrace } from './workflow-candidate.js';
import { ResourceInputControl } from '../../src/desktop-provider/resource-input-control.js';
import { SqliteTrace } from '../../src/trace/sqlite-trace.js';
import { createTaskBudget, runWithTaskBudget } from '../../src/runtime/model-budget.js';

const url = 'http://192.168.2.3:8102/';
const keyName = 'agent-desktop-hidden-chrome-20261009';
/** Live rules consume the real current DOM projection, never a FakeRuntime or a
 * prerecorded website snapshot. Discovery cannot mark the API Key task done. */
export class InspectKeyForm implements ModelAdapter {
  readonly name = 'LIVE-01 UI discovery rules';
  readonly kind = 'rule';
  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    if (state.observation?.url === 'about:blank') return { kind: 'navigate', url };
    const discovery = JSON.parse(state.observation?.pageText ?? '{}') as ChromeDiscovery;
    if (discovery.fields?.some(field => field.password)) return { kind: 'ask_user', question: 'BLOCKED_LOGIN: 请在本机完成站点认证；未创建 Key。' };
    const previous = state.recentHistory ?? [];
    if (previous.some(item => item.action.kind === 'click' && item.action.target.kind === 'selector' && item.action.target.selector === '#new-api-key'))
      return { kind: 'ask_user', question: 'BLOCKED_PERMISSION: Key 表单已打开，包含多项勾选授权、必填数值和下拉配置；需确认权限选择，未提交创建。' };
    if (previous.some(item => item.action.kind === 'click' && item.action.target.kind === 'role' && item.action.target.name === '接入权限'))
      return discovery.controls?.some(control => control.id === 'new-api-key' && !control.submit)
        ? { kind: 'click', target: { kind: 'selector', selector: '#new-api-key' } }
        : { kind: 'ask_user', question: 'BLOCKED_DISCOVERY: 接入权限页面已打开；没有唯一非提交的 Key 表单入口。' };
    const navigation = discovery.controls?.filter(control => control.name === '接入权限');
    if (navigation?.length === 1) return { kind: 'click', target: { kind: 'role', role: navigation[0]!.role, name: '接入权限' } };
    return { kind: 'ask_user', question: 'BLOCKED_DISCOVERY: 当前页面缺少唯一可用的接入权限导航，未创建 Key。' };
  }
}

export class CreateOneKey extends InspectKeyForm {
  constructor(private readonly configuredKeyName=keyName) {super();}
  override async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    const discovery = JSON.parse(state.observation?.pageText ?? '{}') as ChromeDiscovery;
    if(discovery.apiKeyGenerated) return {kind:'done',summary:'网页已显示新 Key；等待独立本机文件与设置验收'};
    const fields=discovery.fields??[];
    if(fields.some(field=>field.fieldName==='max_output_tokens')) {
      const name=fields.find(field=>field.fieldName==='name');
      if(name?.value!==this.configuredKeyName)return {kind:'type',target:{kind:'selector',selector:KEY_NAME_SELECTOR},text:this.configuredKeyName};
      if(fields.find(field=>field.fieldName==='max_output_tokens')?.value!=='40000')
        return {kind:'type',target:{kind:'selector',selector:KEY_TOKENS_SELECTOR},text:'40000'};
      const model=fields.find(field=>field.fieldName==='allowed_models'&&!field.checked);
      if(model&&Number.isInteger(model.modelIndex))return {kind:'set_checked',target:{kind:'selector',selector:KEY_MODEL_PREFIX+model.modelIndex},checked:true};
      if(!(state.recentHistory??[]).some(item=>item.action.kind==='click'&&item.action.target.kind==='selector'&&item.action.target.selector===KEY_SUBMIT_SELECTOR))
        return {kind:'click',target:{kind:'selector',selector:KEY_SUBMIT_SELECTOR}};
      return {kind:'ask_user',question:'UNKNOWN_CREATE_RESULT: 已发出一次创建，结果尚未确认；禁止再次提交。'};
    }
    return super.decide(state);
  }
}

async function main() {
  if (!process.argv.includes('--live') || process.platform !== 'win32') throw new Error('Explicit --live on Windows required');
  const chromePath = process.env.LIVE01_CHROME_PATH;
  if (!chromePath) throw new Error('Explicit LIVE01_CHROME_PATH required');
  const root = resolve('.');
  const createOne=process.argv.includes('--create-one');
  if(createOne&&(!process.argv.includes('--all-models')||!process.argv.includes('--max-output-tokens=40000')||!process.argv.includes('--other-defaults')))
    throw new Error('Explicit authorized model/output/default settings required');
  const ledger=resolve('.artifacts/live-01/create-once.json');
  if(createOne&&existsSync(ledger))throw new Error('Prior creation intent exists; read-only outcome reconciliation required, no repeated creation');
  const desktop = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8', windowsHide: true }).trim();
  if (!desktop) throw new Error('Windows Known Folder Desktop unavailable');
  const outputPath = resolve(desktop, 'AgentDesktop_8102_API_Key.txt');
  if (existsSync(outputPath)) throw new Error('Desktop output conflict; no site action performed');
  const taskId = randomUUID();
  const directory = resolve('.artifacts/live-01', taskId);
  await mkdir(directory, { recursive: true });
  createTaskBudget(directory, taskId);
  const tracePath=resolve(directory,'task.sqlite');
  const trace = new SqliteTrace(tracePath);
  const input = new ResourceInputControl();
  const provider = new LocalWorkspaceChromeProvider(input, root, chromePath, resolve(directory, 'native'));
  let session: Awaited<ReturnType<typeof provider.open>> | undefined;
  let state = initialState(taskId, `LIVE-01: 在 Hidden Workspace Chrome 访问 ${url}，创建一个 ${keyName} API Key，全部模型、max_output_tokens 40000、RPM/有效期默认；保存完整 Key 到当前用户桌面 AgentDesktop_8102_API_Key.txt`,undefined,
    {urlIncludes:url,pageTextIncludes:'"apiKeyGenerated":true'});
  state.executorId='live-01-hidden-chrome';
  trace.save('queued', state);
  let phase = 'open';
  let failure: string | undefined;
  try {
    session = await provider.open('local-workspace:chrome');
    session.setSecretOutputPath(outputPath);
    if(createOne)session.authorizeCreation({keyName,maxOutputTokens:40000,allModels:true,claim:()=>
      writeFile(ledger,JSON.stringify({taskId,origin:url,keyName,state:'dispatch_intent',allModels:true,maxOutputTokens:40000,otherDefaults:true}),{flag:'wx'})});
    phase = 'acquire';
    const authority = await input.acquire(session, { kind: 'agent', clientId: taskId });
    phase = 'connect';
    const runtime = await session.connectRuntime(authority);
    phase = 'graph';
    const graph=createAgentLoop({runtime,model:createOne?new CreateOneKey():new InspectKeyForm(),trace,
      maxSteps:24,maxRetries:0,checkpointer:createOne?new MemorySaver():undefined,
      acceptanceVerifier:createOne?{evaluate:async (_goal,_criteria,observation)=>{
        const facts=await session!.verifyKeyOutcome();
        const checks=Object.entries(facts).map(([criterion,passed])=>({criterion,verdict:passed?'pass' as const:'unknown' as const,message:passed?'独立只读验证通过':'证据未确认'}));
        const verdict=checks.every(check=>check.verdict==='pass')?'pass' as const:'unknown' as const;
        return {mode:'assist' as const,verdict,observationId:normalizeEvidence(observation).observationId,checks,message:verdict==='pass'?'GUI 新 Key 与当前桌面文件完整相等，授权配置匹配':'Key 结果或本机文件尚未独立确认'};
      }}:undefined});
    const config={configurable:{thread_id:taskId}};
    await runWithTaskBudget(directory,taskId,async()=>{
      state=await graph.invoke(state,config) as ComputerState;
      const snapshot=createOne?await graph.getState(config):undefined;
      const pending=snapshot?.values as ComputerState|undefined;
      if(createOne&&pending?.status==='waiting_user'&&pending.lastAction?.kind==='click'&&
          pending.lastAction.target.kind==='selector'&&pending.lastAction.target.selector===KEY_SUBMIT_SELECTOR&&
          !session!.creationDispatched) {
        // Owner's explicit one-Key authorization is consumed through the existing
        // risk interrupt. No other risk/duplicate/final-review gate is approved.
        trace.save('owner_creation_authorization',{...pending,summary:'Owner 已授权一次创建；全部模型，40000 输出 Token，其它默认'});
        state=await graph.invoke(new Command({resume:{approved:true}}),config) as ComputerState;
      }
    });
    await writeFile(resolve(directory, 'discovery.json'), JSON.stringify(session.discovery, null, 2), { flag: 'wx' });
    if(state.status==='done') {
      await session.assertArtifactHasNoKey(JSON.stringify(trace.events(taskId)));
      const candidate=distillWorkflow(trace,taskId,tracePath,'browser')??candidateFromLiveTrace(trace,taskId,tracePath);
      candidate.knownFailures.push('仅可在本次可信 Hidden Chrome Runtime 中执行；禁止 Host/Physical/直接 API 回退。',
        '创建提交为非幂等步骤；每次回放须另行获得一次新 Key 授权，先核对未知结果和输出文件冲突。',
        '桌面秘密保存由私有 Runtime sink 完成；Workflow 不保存 Key，不自动回放创建验证。');
      const navigate=candidate.steps.find(step=>step.action.kind==='navigate');
      if(navigate?.action.kind==='navigate')navigate.action.url='{{siteUrl}}';
      candidate.inputs.push({name:'siteUrl',example:url},{name:'outputFile',example:'AgentDesktop_8102_API_Key.txt'});
      candidate.taskPattern=candidate.taskPattern.replaceAll(url,'{{siteUrl}}').replaceAll('AgentDesktop_8102_API_Key.txt','{{outputFile}}');
      candidate.durableContract=[{kind:'desktop_file',path:'{{outputFile}}'}];
      for(const step of candidate.steps)if(step.action.kind==='click'&&step.action.target.kind==='selector'&&
          step.action.target.selector===KEY_SUBMIT_SELECTOR)
        step.action.postcondition={kind:'desktop_file',path:'{{outputFile}}'};
      candidate.successConditions.urlIncludes='{{siteUrl}}';
      await session.assertArtifactHasNoKey(JSON.stringify(candidate));
      const workflows=new WorkflowStore(resolve(directory,'workflows.sqlite'));
      try {const saved=workflows.addCandidate(candidate);await writeFile(resolve(directory,'workflow-candidate.json'),JSON.stringify(saved,null,2),{flag:'wx'});}finally{workflows.close();}
      await writeFile(ledger,JSON.stringify({taskId,origin:url,keyName,state:'confirmed_saved',allModels:true,maxOutputTokens:40000,otherDefaults:true}));
    }
  } catch (error) {
    failure = error instanceof AggregateError ? error.errors.map((item: unknown) => item instanceof Error &&
      /^(Chrome |Input |Desktop |Owned )/.test(item.message) ? item.message : item instanceof Error ? item.name : 'UnknownError').join(';') : error instanceof Error && error.message.startsWith('Chrome ')
      ? error.message : error instanceof Error ? error.name : 'UnknownError';
    const outcome = session?.creationDispatched
      ? session.keyFileSaved ? 'Key saved locally; later task processing failed; do not create again.' : 'One creation intent consumed; result unknown; do not create again.'
      : 'No creation submit dispatched.';
    state = { ...state, status: 'failed', error: 'BLOCKED_TECHNICAL: Hidden Chrome task did not complete. ' + outcome };
    trace.save('live_blocked', state);
  } finally {
    let cleanup = 'NOT_CONFIRMED';
    try { await session?.close(); cleanup = session?.cleanup?.ownedJobEmpty && session.cleanup.desktopHandleClosed ? 'CONFIRMED' : 'NOT_CONFIRMED'; }
    catch { cleanup = 'FAILED'; }
    const result = { taskId, status: state.status==='done'&&cleanup==='CONFIRMED'?'SUCCESS':'BLOCKED', taskStatus: state.status, reason: state.error,
      phase, failure, nativeFailure: session?.nativeFailure, chromeHiddenBinding: !!session, origin: url, steps: state.step,
      keyCreation: session?.creationDispatched?(session.keyFileSaved?'ONE_CONFIRMED':'UNKNOWN_NO_RETRY'):'NO_SUBMIT_ADMITTED',
      keyFile: session?.keyFileSaved ? 'SAVED_LOCAL' : 'NOT_CREATED', workflow: existsSync(resolve(directory,'workflow-candidate.json'))?'CANDIDATE_SAVED_NO_REPLAY':'NOT_DISTILLED_INCOMPLETE_TASK', cleanup,
      nativeCleanup: session?.cleanup };
    await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
    trace.close();
    console.log(JSON.stringify(result));
    if(result.status!=='SUCCESS')process.exitCode=1;
  }
}
if (process.argv[1]?.endsWith('hidden-chrome.ts')) await main();
