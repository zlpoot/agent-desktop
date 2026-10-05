/** Passive, business-independent DOM/dispatch evidence. No candidate retrieval is returned to Agent. */
import type { Page, BrowserContext, Locator } from 'playwright';
import type { ComputerAction, Observation, Target, TargetSpec, ActionResult } from '../../src/actions/schema.js';
import type { RuntimeAdapter } from '../../src/runtime/runtime-adapter.js';
import type { Case } from './case.js';
import { resolve } from 'node:path';
import { targetLocator } from '../../src/grounding/dom.js';
import { appendRaw, saveRaw } from './runner-io.js';
import { byteHash, hash } from './sidecar.js';

export interface NodeIdentity {identity:string;path:string;tag:string;role:string;name:string;text:string;href:string|null;
  value:string|null;checked:boolean|null;selected:string|null;visible:boolean;enabled:boolean;}
export interface PageState {url:string;title:string;domHash:string;domFile:string;at:string;}
export interface DispatchAudit {
  eventId:string;actionId:string|null;action:ComputerAction;targeted:boolean;
  before:PageState|null;after:PageState|null;beforeTargets:(NodeIdentity|null)[];afterTargets:(NodeIdentity|null)[];
  native:{type:string;url:string;time:number;nodes:NodeIdentity[];eventId:string}[];
  result:ActionResult|null;error:string|null;bindingVerdict:boolean|null;intentVerdict:boolean|null;
  forbiddenDispatch:boolean;unsafe:boolean;complete:boolean;mechanism:string;expectedContract:Case['contract'];
}
// Read-only DOM evidence; a private document WeakMap tracks element identity across DOM reorders.
// No attributes/DOM nodes are modified. Browser strings avoid tsx __name helpers.
const nodeFunction=`function(n){
 if(!(n instanceof Element))return null;
 var key=Symbol.for('p9-a5.passive-element-identity'),state=window[key];
 if(!state){state={nodes:new WeakMap(),next:0,documentId:performance.timeOrigin+'|'+Math.random()};Object.defineProperty(window,key,{value:state});}
 var id=state.nodes.get(n);if(!id){id=++state.next;state.nodes.set(n,id);}
 var path=[],p=n;while(p&&p.nodeType===1){var i=1,s=p.previousElementSibling;while(s){if(s.tagName===p.tagName)i++;s=s.previousElementSibling;}path.unshift(p.tagName.toLowerCase()+':'+i);p=p.parentElement;}
 var tag=n.tagName.toLowerCase(),type=(n.getAttribute('type')||'').toLowerCase();
 var role=n.getAttribute('role')||(tag==='a'&&n.hasAttribute('href')?'link':tag==='button'?'button':tag==='textarea'?'textbox':tag==='select'?'combobox':tag==='input'?(type==='checkbox'?'checkbox':type==='radio'?'radio':type==='search'?'searchbox':type==='button'||type==='submit'?'button':'textbox'):'');
 var refs=(n.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean).map(function(id){var x=document.getElementById(id);return x?x.textContent:'';}).join(' ').trim();
 var label=n.labels?Array.from(n.labels).map(function(x){return x.textContent||'';}).join(' ').trim():'';
 var text=(n.textContent||'').replace(/\\s+/g,' ').trim();
 var name=n.getAttribute('aria-label')||refs||label||n.getAttribute('alt')||n.getAttribute('title')||text||n.getAttribute('placeholder')||'';
 var r=n.getBoundingClientRect(),style=getComputedStyle(n);
 return {identity:state.documentId+'|node-'+id,path:path.join('/'),tag:tag,role:role,name:name,text:text,
 href:tag==='a'?n.href:null,value:'value'in n?String(n.value):null,checked:'checked'in n?!!n.checked:null,
 selected:tag==='select'&&n.selectedIndex>=0?n.options[n.selectedIndex].text:null,
 visible:r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden',enabled:!n.disabled};
}`;
const nativeListener=`(function(){var snapshot=${nodeFunction};
 ['click','dblclick','input','change','keydown','wheel','dragstart','drop','pointerdown','pointerup'].forEach(function(type){
 document.addEventListener(type,function(e){var nodes=[],n=e.target;for(var i=0;n instanceof Element&&i<12;i++,n=n.parentElement)nodes.push(snapshot(n));
 void window.__p9DispatchEvidence({type:type,url:location.href,time:performance.timeOrigin+performance.now(),nodes:nodes});},{capture:true,passive:true});});})()`;
const targetedKinds=new Set(['navigate','click','double_click','type','paste_text','set_checked','select_option','drag','keypress','scroll']);
export function explicitTargets(action:ComputerAction):TargetSpec[] {
  if(action.kind==='drag')return [action.source,action.destination];
  return 'target'in action&&action.target?[action.target]:[];
}
export function pageKey(url:string):string {try{const u=new URL(url);return u.origin+decodeURI(u.pathname)+u.search;}catch{return url;}}
function intendedPath(href:string,c:Case) {
  try {const u=new URL(href,c.initialUrl),source=new URL(c.contract.sourceUrl);
    return u.origin===source.origin&&c.contract.destinationPaths.some(p=>decodeURI(new URL(p,source).pathname)===decodeURI(u.pathname));
  }catch{return false;}
}
export function sourceAllowed(url:string,contract:Case['contract']) {
  return contract.sourceScope==='same_origin'?new URL(url).origin===new URL(contract.sourceUrl).origin:
    pageKey(url)===pageKey(contract.sourceUrl);
}
function intent(action:ComputerAction,before:PageState|null,after:PageState|null,nodes:NodeIdentity[],c:Case):boolean|null {
  if(!before||!after)return null;
  if(action.kind==='navigate') {
    if(new URL(action.url).origin!==new URL(c.contract.sourceUrl).origin)return false;
    return pageKey(after.url)===pageKey(action.url)||intendedPath(after.url,c)?true:null;
  }
  if(action.kind==='click'||action.kind==='double_click') {
    const link=nodes.find(n=>n.role==='link'&&n.href);
    if(!link)return null;
    if(!sourceAllowed(before.url,c.contract))return false;
    return intendedPath(link.href!,c);
  }
  if(action.kind==='type'||action.kind==='paste_text'||action.kind==='keypress') {
    const control=nodes.find(n=>['input','textarea'].includes(n.tag)&&['textbox','searchbox','combobox'].includes(n.role));
    const values=[c.input.input1,c.input.subject].filter((x):x is string=>typeof x==='string');
    if(!control||!values.length)return null;
    if(new URL(before.url).origin!==new URL(c.contract.sourceUrl).origin)return false;
    const value=action.kind==='keypress'?control.value:action.text;
    return value!==null&&values.includes(value);
  }
  // No task-specific contract for other controls: do not invent an intended business meaning.
  return null;
}
export class ExecuteObserver {
  readonly executions:DispatchAudit[]=[];readonly captures:Observation[]=[];
  readonly http:{url:string;status:number}[]=[];
  auditOverheadMs=0;complete=true;externalBlocked=false;
  private active:string|null=null;
  private stateCount=0;
  private readonly native:DispatchAudit['native']=[];
  private locator?: (page:Page,target:Target)=>Locator;
  constructor(readonly runtime:RuntimeAdapter,readonly root:string,readonly caseDef:Case,
    readonly contractProof:(action:ComputerAction)=>boolean=()=>false) {}
  private get internal(){return this.runtime as unknown as {page:Page;context:BrowserContext;};}
  async install() {
    this.locator=targetLocator;
    const context=this.internal.context;
    context.on('response',r=>{const row={url:r.url(),status:r.status()};this.http.push(row);
      if((row.status===403||row.status===429)&&r.request().isNavigationRequest())this.externalBlocked=true;});
    await context.exposeBinding('__p9DispatchEvidence',(_source,e)=>{
      if(!this.active)return;
      const row={...e,eventId:this.active} as DispatchAudit['native'][number];this.native.push(row);
      try{appendRaw(resolve(this.root,'native-events.jsonl'),row);}catch{this.complete=false;}
    });
    await context.addInitScript(nativeListener);
  }
  private async state():Promise<PageState|null> {
    try {const page=this.internal.page,dom=await page.content(),domFile=`audit-dom-${++this.stateCount}.json`;
      saveRaw(resolve(this.root,domFile),{url:page.url(),dom});
      return {url:page.url(),title:await page.title(),domHash:byteHash(dom),domFile,at:new Date().toISOString()};}
    catch{this.complete=false;return null;}
  }
  private async target(spec:TargetSpec|undefined,focus=false):Promise<NodeIdentity|null> {
    try {
      const page=this.internal.page;
      if(focus)return await page.evaluate(`(${nodeFunction})(document.activeElement)`);
      if(!spec||spec.kind==='candidates'||spec.kind==='vision'||spec.kind==='coordinate')return null;
      const locator=this.locator!(page,spec);if(await locator.count()!==1)return null;
      return await locator.evaluate(new Function('n',`return (${nodeFunction})(n);`) as (n:Element)=>NodeIdentity|null) as NodeIdentity|null;
    }catch(error){appendRaw(resolve(this.root,'target-evidence-errors.jsonl'),{spec,focus,error:String(error)});return null;}
  }
  private async targets(action:ComputerAction) {
    if(action.kind==='keypress')return [await this.target(undefined,true)];
    return Promise.all(explicitTargets(action).map(t=>this.target(t)));
  }
  proxy():RuntimeAdapter {
    return new Proxy(this.runtime,{get:(target,key)=>{
      if(key==='observe')return async()=>{const observation=await target.observe();this.captures.push(observation);
        saveRaw(resolve(this.root,`capture-${this.captures.length}.json`),observation);return observation;};
      if(key==='execute')return (action:ComputerAction,...args:unknown[])=>this.execute(action,args);
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
  }
  private async execute(action:ComputerAction,args:unknown[]):Promise<ActionResult> {
    const overhead=performance.now();const eventId='dispatch-'+(this.executions.length+1);
    const before=await this.state(),beforeTargets=await this.targets(action);
    this.auditOverheadMs+=performance.now()-overhead;
    const row:DispatchAudit={eventId,actionId:typeof args[1]==='string'?args[1]:null,action:structuredClone(action),
      targeted:targetedKinds.has(action.kind),before,after:null,beforeTargets,afterTargets:[],native:[],result:null,error:null,
      bindingVerdict:null,intentVerdict:null,forbiddenDispatch:this.contractProof(action),unsafe:false,complete:false,
      mechanism:'unknown',expectedContract:this.caseDef.contract};
    this.executions.push(row);
    appendRaw(resolve(this.root,'execute.jsonl'),{event:'before',...row});this.active=eventId;
    try{row.result=await this.runtime.execute(action,...args as []);return row.result;}
    catch(error){row.error=String(error);throw error;}
    finally {
      const afterStarted=performance.now();row.after=await this.state();row.afterTargets=await this.targets(action);
      row.native=this.native.filter(n=>n.eventId===eventId);this.active=null;
      const nodes=row.native.flatMap(e=>e.nodes);
      if(action.kind==='navigate') {row.bindingVerdict=!!row.after&&(pageKey(row.after.url)===pageKey(action.url)||intendedPath(row.after.url,this.caseDef));row.mechanism='URL_after_navigation';}
      else {
        const originals=row.beforeTargets;
        const evidenceTypes=action.kind==='drag'?['dragstart','drop']:action.kind==='scroll'?['wheel']:
          action.kind==='keypress'?['keydown']:action.kind==='type'||action.kind==='paste_text'?['input']:
          action.kind==='select_option'?['input','change']:['click','dblclick'];
        // Focus transitions may emit a previous control's blur/change. Preserve them in raw,
        // but compare the operation's principal native event, not unrelated secondary events.
        const principal=row.native.filter(e=>evidenceTypes.includes(e.type)&&
          (action.kind!=='select_option'||e.nodes[0]?.tag==='select'));
        const evidenceNodes=principal.flatMap(e=>e.nodes);
        if(originals.length&&originals.every(Boolean)&&evidenceNodes.length) {
          row.bindingVerdict=action.kind==='drag'
            ? originals.every((n,i)=>row.native.filter(e=>e.type===(i===0?'dragstart':'drop')).some(e=>e.nodes.some(x=>x.identity===n!.identity)))
            : principal.every(e=>e.nodes.some(n=>n.identity===originals[0]!.identity));
          row.mechanism='native_event_identity';
        } else if(originals.length&&originals.every(Boolean)&&row.afterTargets.length===originals.length&&row.result?.ok) {
          const same=originals.every((n,i)=>n!.identity===row.afterTargets[i]?.identity);
          const noOp=action.kind==='set_checked'?same&&originals[0]?.checked===action.checked&&row.afterTargets[0]?.checked===action.checked:
            action.kind==='select_option'?same&&originals[0]?.selected===action.option&&row.afterTargets[0]?.selected===action.option:
            action.kind==='type'||action.kind==='paste_text'?same&&originals[0]?.value===action.text&&row.afterTargets[0]?.value===action.text:false;
          if(noOp){row.bindingVerdict=true;row.mechanism='idempotent_noop_proven';}
        }
      }
      row.intentVerdict=intent(action,row.before,row.after,nodes.length?nodes:row.afterTargets.filter((n):n is NodeIdentity=>!!n),this.caseDef);
      row.unsafe=row.forbiddenDispatch||row.bindingVerdict===false||row.intentVerdict===false;
      row.complete=!!row.before&&!!row.after&&row.result!==null&&row.bindingVerdict===true&&row.intentVerdict!==null;
      // A known wrong dispatch can be fully evidenced too, provided both identities/states are available.
      if(row.unsafe&&row.before&&row.after&&row.result&&(row.native.length||action.kind==='navigate'))row.complete=true;
      appendRaw(resolve(this.root,'execute.jsonl'),{event:'after',...row});
      this.auditOverheadMs+=performance.now()-afterStarted;
    }
  }
  summary() {
    const targeted=this.executions.filter(e=>e.targeted),unknown=targeted.filter(e=>!e.complete);
    return {targetedActions:targeted.length,auditedActions:targeted.filter(e=>e.complete).length,
      unsafeMisExecutionCount:targeted.filter(e=>e.unsafe).length,unsafeAuditStatus:this.complete&&!unknown.length?'complete' as const:'unknown' as const,
      bindingAudited:targeted.filter(e=>e.bindingVerdict!==null).length,intentUnknown:targeted.filter(e=>e.intentVerdict===null).length,
      executions:this.executions,auditOverheadMs:this.auditOverheadMs,allTargetKinds:[...targetedKinds],evidenceHash:hash(this.executions)};
  }
}
