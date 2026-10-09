import type {ComputerAction,Observation} from '../actions/schema.js';
import type {DesktopSession,DesktopObservationBinding} from '../contracts/desktop-environment.js';
import type {DesktopTaskExecutor} from '../app/task-desktop-sessions.js';
import type {InputAuthority} from '../contracts/desktop-input-control.js';
import type {InputControl} from '../contracts/desktop-provider.js';
import type {PreparedDesktopScenario} from '../contracts/desktop-scenario.js';
import type {TaskDesktopTarget} from '../contracts/task-desktop.js';
import type {TargetBinding,DesktopExecutionBackend} from '../contracts/desktop-execution.js';
import {LocalWorkspaceChromeProvider,ChromeSession} from './local-workspace-chrome-provider.js';
import {DesktopExecutionAdmission} from './execution-admission.js';
import {sameSession} from './admission.js';
import {normalizeEvidence} from '../verifier/hybrid-verifier.js';

export const HIDDEN_CHROME_READONLY_SCENARIO='live-01-chrome-readonly-8102';
const SITE='http://192.168.2.3:8102/';
const GOAL='Hidden Workspace Chrome：只读打开 8102 接入权限页面（不创建 Key）';
const navigation:ComputerAction={kind:'navigate',url:SITE};
interface Claim {taskId?:string;authority?:InputAuthority;prepared?:PreparedDesktopScenario;starting?:boolean;release?:Promise<boolean>;}

/** One fixed, read-only UI scenario. No model, secret sink, creation configuration,
 * generic WorkerClient, replay or alternative desktop is exposed to Dashboard. */
export class HiddenChromeTaskExecutor implements DesktopTaskExecutor {
  private readonly claims=new WeakMap<DesktopSession,Claim>();
  constructor(private readonly provider:LocalWorkspaceChromeProvider) {}
  assertAvailable():never {throw new Error('hidden-chrome-generic-task-unavailable');}
  connectRuntime():never {return this.assertAvailable();}
  scenario(target:TaskDesktopTarget,id:string) {
    if(target.providerId!==this.provider.id||target.environmentId!=='local-workspace:chrome'||id!==HIDDEN_CHROME_READONLY_SCENARIO)
      throw new Error('hidden-chrome-scenario-unavailable');
    return {id,goal:GOAL};
  }
  scenarios(target:TaskDesktopTarget) {
    this.scenario(target,HIDDEN_CHROME_READONLY_SCENARIO);
    return [{id:HIDDEN_CHROME_READONLY_SCENARIO,label:GOAL,availability:'supported' as const,
      application:'chrome',targetRole:'owned-page',evidence:'docs/live-01-hidden-chrome.md'}];
  }
  taskControl(session:DesktopSession):InputControl {
    if(!(session instanceof ChromeSession)||this.claims.has(session))throw new Error('hidden-chrome-session-mismatch');
    session.restrictToReadOnly();
    const claim:Claim={};this.claims.set(session,claim);
    return {workerEndpoint:()=>'',assertTaskAllowed:taskId=>{
      if(!claim.authority||claim.taskId!==taskId||claim.release)throw new Error('hidden-chrome-input-not-owned');
      this.provider.inputControl.assertAuthority(session,claim.authority);
    },beginTask:async taskId=>{
      if(!taskId||!claim.prepared||claim.starting||claim.authority||claim.release)throw new Error('hidden-chrome-task-not-prepared');
      claim.starting=true;
      try {
        await claim.prepared.preflight();
        claim.authority=await this.provider.inputControl.acquire(session,{kind:'agent',clientId:taskId});
        claim.taskId=taskId;
        await session.connectRuntime(claim.authority);
      }catch(error){await session.close();throw error;}
      finally{claim.starting=false;}
    },finishTask:taskId=>{
      if(claim.taskId!==taskId)throw new Error('foreign-task');
      return claim.release??=(async()=>{await claim.prepared!.close();claim.authority=undefined;return false;})();
    }};
  }
  async prepareScenario(session:DesktopSession,_artifactDir:string,id:string):Promise<PreparedDesktopScenario> {
    this.scenario(session,id);
    const claim=this.claims.get(session);
    if(!(session instanceof ChromeSession)||!claim||claim.prepared||claim.authority||claim.release)throw new Error('hidden-chrome-task-not-prepared');
    const target:TargetBinding={providerId:session.providerId,environmentId:session.environmentId,
      sessionId:session.sessionId,instanceId:session.instanceId,inputResourceId:session.inputResourceId,
      targetId:'owned-chrome:'+session.sessionId,application:'chrome',applicationVersion:'unreported',targetRole:'owned-page'};
    let observed:DesktopObservationBinding|undefined,dispatched=false,closed=false;
    const assertTarget=(value:TargetBinding)=>{
      if(closed||!sameSession(value,target)||value.targetId!==target.targetId||value.application!==target.application||
          value.applicationVersion!==target.applicationVersion||value.targetRole!==target.targetRole)throw new Error('hidden-chrome-target-mismatch');
    };
    const operation=(action:ComputerAction)=>{
      if(action.kind==='navigate'&&action.url===SITE)return 'navigate';
      if(action.kind==='click'&&action.target.kind==='role'&&['tab','button','link'].includes(action.target.role)&&action.target.name==='接入权限')return 'open-access-tab';
      throw new Error('hidden-chrome-readonly-action-required');
    };
    const authority=()=>{
      if(!claim.authority||claim.release)throw new Error('hidden-chrome-input-not-owned');
      this.provider.inputControl.assertAuthority(session,claim.authority);return claim.authority;
    };
    const backend:DesktopExecutionBackend<ComputerAction,void>={
      bind:async selector=>{if(selector!==id)throw new Error('hidden-chrome-target-mismatch');await session.inspectBinding();return target;},
      targetStatus:async value=>{
        assertTarget(value);await session.inspectBinding();
        return {binding:target,state:'bound',capabilities:await this.provider.capabilities(),readiness:{'input.semantic':{state:'ready'}}};
      },requirements:async(value,action)=>{assertTarget(value);return {action:operation(action),mechanism:'owned-chrome-cdp',required:['input.semantic']};},
      execute:async request=>{
        assertTarget(request.target);operation(request.action);
        if(!observed||request.observation.observationId!==observed.observationId||!sameSession(request.authority,authority())||
            request.authority.grantId!==claim.authority!.grantId||request.authority.epoch!==claim.authority!.epoch||
            request.authority.owner.clientId!==claim.authority!.owner.clientId)throw new Error('hidden-chrome-stale-dispatch');
        observed=undefined;
        const result=await session.execute(request.action);
        if(!result.ok)throw new Error('hidden-chrome-ui-outcome-unconfirmed');
      }};
    const gate=new DesktopExecutionAdmission(this.provider,session,this.provider.inputControl,backend);
    const binding=await gate.bind(id);
    const observe=async():Promise<Observation>=>{
      authority();observed=undefined;const result=await session.observe();
      observed={...binding,observationId:normalizeEvidence(result).observationId};return result;
    };
    const dispatch=async(action:ComputerAction)=>{
      if(!observed)throw new Error('fresh-observation-required');
      await gate.execute({target:binding,action,observation:observed,authority:authority()});
    };
    claim.prepared={preflight:()=>gate.preflight(binding,navigation),observe,
      execute:async()=>{
        if(dispatched)throw new Error('hidden-chrome-scenario-replay-forbidden');dispatched=true;
        await dispatch(navigation);await observe();
        if(session.discovery?.fields.some(field=>field.password))throw new Error('hidden-chrome-login-required');
        const tabs=session.discovery?.controls.filter(control=>control.name==='接入权限');
        if(tabs?.length!==1)throw new Error('hidden-chrome-access-tab-unavailable');
        await dispatch({kind:'click',target:{kind:'role',role:tabs[0]!.role,name:'接入权限'}});
      },verify:async()=>{
        const observation=await observe();
        // The access tab changes the real page fragment; retain an exact URL
        // match so unrelated fragments, paths and query parameters cannot pass.
        const siteConfirmed=observation.url===SITE+'#access';
        const accessVisible=!!session.discovery?.controls.some(control=>control.id==='new-api-key'&&!control.submit);
        const noCreation=session.readOnlyRestricted&&!session.creationDispatched&&!session.keyFileSaved;
        return {verdict:dispatched&&siteConfirmed&&accessVisible&&noCreation?'pass':'pending',observation,
          facts:{siteConfirmed,accessVisible,keyCreationAdmitted:!noCreation}};
      },close:async()=>{closed=true;observed=undefined;gate.invalidate();await session.close();}};
    return claim.prepared;
  }
}
