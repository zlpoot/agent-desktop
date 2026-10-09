import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,isAbsolute} from 'node:path';
import {Command,MemorySaver} from '@langchain/langgraph';
import type {RuntimeAdapter} from '../runtime/runtime-adapter.js';
import type {ComputerState} from '../graph/state.js';
import {initialState} from '../graph/state.js';
import {createAgentLoop} from '../graph/graph.js';
import {SqliteTrace} from '../trace/sqlite-trace.js';
import {WorkflowStore} from '../workflows/store.js';
import {normalizeEvidence} from '../verifier/hybrid-verifier.js';
import {CreateOneKey} from '../../testbench/live-01/hidden-chrome.js';
import {candidateFromLiveTrace} from '../../testbench/live-01/workflow-candidate.js';
import {KEY_SUBMIT_SELECTOR,type ChromeSession} from './local-workspace-chrome-provider.js';

/** Trusted local operator configuration, never accepted from a Task HTTP body.
 * Each new authorization admits one explicitly submitted fixed Task only. */
export interface HiddenChromeCreationAuthorization {
  authorizationId:string;keyName:string;outputFile:string;
  allModels:true;maxOutputTokens:40000;otherDefaults:true;
}
export function validateChromeCreationAuthorization(value:unknown):asserts value is HiddenChromeCreationAuthorization {
  const v=value as HiddenChromeCreationAuthorization;
  if(!v||typeof v!=='object'||Array.isArray(v)||
    Object.keys(v).some(key=>!['authorizationId','keyName','outputFile','allModels','maxOutputTokens','otherDefaults'].includes(key))||
    typeof v.authorizationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.authorizationId)||
    typeof v.keyName!=='string'||!/^agent-desktop-hidden-chrome-[0-9]{8}-[1-9][0-9]{0,5}$/.test(v.keyName)||
    typeof v.outputFile!=='string'||!/^AgentDesktop_8102_API_Key_[0-9]{8}_[1-9][0-9]{0,5}\.txt$/.test(v.outputFile)||
    v.allModels!==true||v.maxOutputTokens!==40000||v.otherDefaults!==true)
    throw new Error('invalid-hidden-chrome-creation-authorization');
}
export function currentWindowsDesktop():string {
  if(process.platform!=='win32')throw new Error('Chrome current Windows Desktop unavailable');
  const desktop=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Environment]::GetFolderPath('Desktop')"],
    {encoding:'utf8',windowsHide:true}).trim();
  if(!isAbsolute(desktop))throw new Error('Chrome current Windows Desktop unavailable');
  return desktop;
}
export class HiddenChromeCreationPermit {
  private readonly ledger:string;
  readonly config:Readonly<HiddenChromeCreationAuthorization>;
  constructor(private readonly root:string,config:HiddenChromeCreationAuthorization,
    private readonly desktop:()=>string=currentWindowsDesktop) {
    validateChromeCreationAuthorization(config);this.config=Object.freeze({...config});
    this.ledger=resolve(root,'.artifacts/live-01/authorizations',config.authorizationId+'.json');
  }
  available(){return !existsSync(this.ledger);}
  async reserve(taskId:string) {
    if(!this.available())throw new Error('Chrome creation authorization already reserved; no replay');
    const directory=this.desktop();
    if(!isAbsolute(directory))throw new Error('Chrome Desktop unavailable');
    const outputPath=resolve(directory,this.config.outputFile);
    if(existsSync(outputPath))throw new Error('Chrome Desktop output conflict; no creation admitted');
    await mkdir(resolve(this.root,'.artifacts/live-01/authorizations'),{recursive:true});
    // Exclusive reservation also fences two queued Tasks and a Host restart.
    await writeFile(this.ledger,JSON.stringify({taskId,state:'reserved',...this.config}),{flag:'wx'});
    return {outputPath,claim:()=>writeFile(this.ledger+'.dispatch',JSON.stringify({taskId,state:'dispatch_intent'}),{flag:'wx'})};
  }
}

/** Existing rule adapter + Agent Loop + file gate, retained by the normal fixed
 * Task lifecycle. The inner trace records every UI step without replacing the
 * outer Task/Session binding, budget, pause or cleanup owner. */
export class HiddenChromeCreationRun {
  private final?:ComputerState;
  private workflowId?:string;
  private started=false;
  constructor(private readonly root:string,private readonly taskId:string,private readonly directory:string,
    private readonly config:Readonly<HiddenChromeCreationAuthorization>,private readonly session:ChromeSession,
    private readonly runtime:RuntimeAdapter) {}
  async execute() {
    if(this.started)throw new Error('Chrome creation Task replay forbidden');this.started=true;
    await mkdir(this.directory,{recursive:true});
    const path=resolve(this.directory,'task.sqlite'),trace=new SqliteTrace(path,{journalMode:'wal'});
    const main=new SqliteTrace(resolve(this.root,'web-tasks.sqlite'));
    try {
      const graph=createAgentLoop({runtime:this.runtime,model:new CreateOneKey(this.config.keyName),trace,
        maxSteps:24,maxRetries:0,checkpointer:new MemorySaver(),pauseRequested:id=>main.pauseRequested(id),
        acceptanceVerifier:{evaluate:async(_goal,_criteria,observation)=>{
          const facts=await this.session.verifyKeyOutcome();
          const checks=Object.entries(facts).map(([criterion,passed])=>({criterion,
            verdict:passed?'pass' as const:'unknown' as const,message:passed?'独立只读验证通过':'证据未确认'}));
          return {mode:'assist' as const,verdict:checks.every(check=>check.verdict==='pass')?'pass' as const:'unknown' as const,
            observationId:normalizeEvidence(observation).observationId,checks,message:'GUI / 本机文件 / 设置独立验收'};
        }}});
      const goal=`在 Hidden Workspace Chrome 访问 http://192.168.2.3:8102/，创建一个 ${this.config.keyName} API Key，全部模型、max_output_tokens 40000、其它默认；保存完整 Key 到当前用户桌面 ${this.config.outputFile}`;
      const initial={...initialState(this.taskId,goal,undefined,{urlIncludes:'http://192.168.2.3:8102/',pageTextIncludes:'"apiKeyGenerated":true'}),
        executorId:'live-01-hidden-chrome'};
      const checkpoint={configurable:{thread_id:this.taskId}};
      this.final=await graph.invoke(initial,checkpoint) as ComputerState;
      const pending=(await graph.getState(checkpoint)).values as ComputerState;
      if(pending.status==='waiting_user'&&pending.lastAction?.kind==='click'&&
          pending.lastAction.target.kind==='selector'&&pending.lastAction.target.selector===KEY_SUBMIT_SELECTOR&&
          !this.session.creationDispatched&&!main.pauseRequested(this.taskId)) {
        // Only the separately granted one-Key permission consumes this risk interrupt.
        trace.save('owner_creation_authorization',{...pending,summary:'Owner 新增一次创建授权；全部模型，40000，其它默认'});
        this.final=await graph.invoke(new Command({resume:{approved:true}}),checkpoint) as ComputerState;
      }
      if(this.final.status!=='done'||!this.final.goalVerification?.ok||this.final.acceptanceReport?.verdict!=='pass')
        throw new Error(this.session.creationDispatched?'Chrome creation result unconfirmed; no retry':'Chrome creation Task blocked before confirmed completion');
      await this.session.assertArtifactHasNoKey(JSON.stringify(trace.events(this.taskId)));
      const candidate=candidateFromLiveTrace(trace,this.taskId,path);
      for(const step of candidate.steps)if(step.action.kind==='navigate')step.action.url='{{siteUrl}}';
      candidate.inputs.push({name:'siteUrl',example:'http://192.168.2.3:8102/'},{name:'outputFile',example:this.config.outputFile});
      candidate.taskPattern=candidate.taskPattern.replaceAll('http://192.168.2.3:8102/','{{siteUrl}}').replaceAll(this.config.outputFile,'{{outputFile}}');
      candidate.durableContract=[{kind:'desktop_file',path:'{{outputFile}}'}];
      // The accepted final file belongs to the sole creation effect. Declare
      // the same result on that step so the existing durable schema aligns.
      for(const step of candidate.steps)if(step.action.kind==='click'&&step.action.target.kind==='selector'&&
          step.action.target.selector===KEY_SUBMIT_SELECTOR)
        step.action.postcondition={kind:'desktop_file',path:'{{outputFile}}'};
      candidate.successConditions.urlIncludes='{{siteUrl}}';
      candidate.knownFailures.push('创建为非幂等动作；回放须新增一次授权，未知结果禁止重试。',
        'Key 只在私有本机 sink；候选没有密钥，未回放或晋升。仅支持可信 Hidden Chrome，通用 Workflow 执行未接通。');
      await this.session.assertArtifactHasNoKey(JSON.stringify(candidate));
      const store=new WorkflowStore(resolve(this.root,'workflows.sqlite'));
      try {this.workflowId=store.addCandidate(candidate).id;}finally{store.close();}
    } finally {main.close();trace.close();}
  }
  async verify() {
    const observation=await this.runtime.observe(),facts=await this.session.verifyKeyOutcome();
    const innerTaskDone=this.final?.status==='done'&&this.final.acceptanceReport?.verdict==='pass';
    const workflowCandidateSaved=!!this.workflowId;
    return {verdict:innerTaskDone&&workflowCandidateSaved&&Object.values(facts).every(Boolean)?'pass' as const:'pending' as const,
      observation,facts:{...facts,innerTaskDone,workflowCandidateSaved,workflowId:this.workflowId??'',
        outputFile:this.config.outputFile,keyName:this.config.keyName,uiSteps:this.final?.step??0,keyCreationDispatched:this.session.creationDispatched,
        keyFileSaved:this.session.keyFileSaved}};
  }
}
