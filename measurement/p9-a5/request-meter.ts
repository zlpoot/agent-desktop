/** Transport observer, not a model adapter counter. Concurrency is fixed to one run. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { appendRaw } from './runner-io.js';
import { byteHash, modelMeasurement } from './sidecar.js';

export interface RequestRow {
  requestId:string;phase:string;kind:'deepseek'|'jev';sent:boolean;failed:boolean;tokens:number|null;
  status:number|null;reason:string|null;endpoint:string;startedAt:string;finishedAt:string|null;bodyHash:string|null;
}
let installed=false;
const phase=new AsyncLocalStorage<string>();
const requestContext=new AsyncLocalStorage<RequestRow>();
function tokens(body:any):number|null {
  const u=body?.usage;if(!u||typeof u!=='object')return null;
  const total=u.total_tokens??(typeof (u.prompt_tokens??u.input_tokens)==='number'&&typeof (u.completion_tokens??u.output_tokens)==='number'
    ?(u.prompt_tokens??u.input_tokens)+(u.completion_tokens??u.output_tokens):null);
  return Number.isSafeInteger(total)&&total>=0?total:null;
}
export class RequestMeter {
  readonly requests:RequestRow[]=[];
  readonly invocations:{phase:string;blocked:boolean;sentRequests:number;error:string|null}[]=[];
  complete=true;auditOverheadMs=0;
  private original?:typeof fetch;
  private readonly sending=channel('undici:client:sendHeaders');
  private readonly sent=channel('undici:request:bodySent');
  private readonly physical=new WeakMap<object,RequestRow>();
  private readonly headerStarted=new Set<string>();
  private readonly onHeaders=(message:unknown)=>{
    const request=(message as {request:{method:string;origin:string;path:string}}).request,base=requestContext.getStore();
    if(!base||request.method!=='POST')return;
    let row=base;
    if(this.headerStarted.has(base.requestId)) {
      row={...base,requestId:randomUUID(),sent:false,failed:false,status:null,tokens:null,finishedAt:null,
        endpoint:String(request.origin)+request.path,startedAt:new Date().toISOString()};this.requests.push(row);
    }
    this.headerStarted.add(row.requestId);this.physical.set(request,row);
    this.persist('model-transport.jsonl',{event:'headers_prepared_not_yet_proven_sent',...row});
  };
  private readonly onSent=(message:unknown)=>{
    const row=this.physical.get((message as {request:object}).request);if(!row)return;
    row.sent=true;row.reason=null;
    this.persist('model-transport.jsonl',{event:'send',boundary:'undici:request:bodySent after socket writes',...row});
  };
  private persist(name:string,value:unknown) {
    // A logging failure cannot be mistaken for a sent request failure or modify Agent's transport.
    try{appendRaw(resolve(this.root,name),value);}catch{this.complete=false;}
  }
  constructor(readonly root:string,readonly endpoints:{url:string;kind:'deepseek'|'jev'}[],
    readonly allowedOrigins?:string[]) {}
  install() {
    if(installed)throw Error('measurement_transport_concurrency_violation');installed=true;
    this.original=globalThis.fetch;
    this.sending.subscribe(this.onHeaders);this.sent.subscribe(this.onSent);
    const original=this.original,self=this;
    globalThis.fetch=async function(input,init) {
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
      if(self.allowedOrigins&&!self.allowedOrigins.includes(new URL(url).origin)) {
        self.complete=false;throw Error('readiness_transport_external_destination_blocked');
      }
      const endpoint=self.endpoints.find(e=>e.url===url);
      if(!endpoint||method!=='POST') {
        if(phase.getStore()&&method==='POST')self.complete=false;
        return original(input,init);
      }
      const signal=init?.signal??(input instanceof Request?input.signal:undefined);
      const row:RequestRow={requestId:randomUUID(),phase:phase.getStore()??'unscoped_model_transport',kind:endpoint.kind,
        sent:false,failed:false,tokens:null,status:null,reason:signal?.aborted?'pre_send_aborted':null,
        endpoint:url,startedAt:new Date().toISOString(),finishedAt:null,
        bodyHash:typeof init?.body==='string'?byteHash(init.body):null};
      self.requests.push(row);
      // Dispatch is not a send. Only Node's HTTP transport bodySent event proves socket writes.
      self.persist('model-transport.jsonl',{event:signal?.aborted?'pre_send_blocked':'transport_dispatched_not_sent',...row});
      try {
        const response=await requestContext.run(row,()=>original(input,init));row.status=response.status;row.failed=!response.ok;
        if(!row.sent)self.complete=false;
        const started=performance.now();
        try {
          const text=await response.clone().text();
          let body:any;try{body=JSON.parse(text);}catch{body=null;}
          row.tokens=tokens(body);
          // No headers, API keys or request body are exported. Response evidence is read-only.
          self.persist('model-responses.jsonl',{requestId:row.requestId,status:row.status,
            responseHash:byteHash(text),body});
        }catch(error){row.reason='response_evidence_unavailable';self.complete=false;}
        self.auditOverheadMs+=performance.now()-started;
        return response;
      }catch(error){row.failed=true;row.reason=row.reason??(row.sent?'sent_transport_failure':'pre_send_transport_failure')+': '+String(error);
        // Headers were prepared but bodySent is absent: partial-write status is UNKNOWN.
        if(!row.sent&&self.headerStarted.has(row.requestId))self.complete=false;
        throw error;}
      finally{row.finishedAt=new Date().toISOString();self.persist('model-transport.jsonl',{event:'finish',...row});}
    };
  }
  restore() {if(this.original){globalThis.fetch=this.original;this.original=undefined;installed=false;
    this.sending.unsubscribe(this.onHeaders);this.sent.unsubscribe(this.onSent);}}
  async inPhase<T>(name:string,work:()=>Promise<T>):Promise<T> {
    const before=this.requests.length;let blocked=false,errorText:string|null=null;
    try{return await phase.run(name,work);}
    catch(error){blocked=(error as Error)?.name==='BudgetExceededError';errorText=String(error);
      if(blocked){const endpoint=this.endpoints.find(e=>e.kind===(name.startsWith('verify')?'jev':'deepseek'))!;
        const row:RequestRow={requestId:randomUUID(),phase:name,kind:endpoint.kind,sent:false,failed:false,tokens:null,
          status:null,reason:'frozen_budget_pre_send_blocked',endpoint:endpoint.url,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),bodyHash:null};
        this.requests.push(row);this.persist('model-transport.jsonl',{event:'pre_send_blocked',...row});}
      throw error;
    }finally{const invocation={phase:name,blocked,sentRequests:this.requests.slice(before).filter(r=>r.sent).length,error:errorText};
      this.invocations.push(invocation);this.persist('model-invocations.jsonl',invocation);}
  }
  wrap<T extends object>(adapter:T,prefix:string,methods:readonly string[]):T {
    return new Proxy(adapter,{get:(target,key)=>{
      const value=Reflect.get(target,key);if(typeof value!=='function')return value;
      if(methods.includes(String(key)))return (...args:unknown[])=>this.inPhase(prefix+'.'+String(key),()=>value.apply(target,args));
      return value.bind(target);
    }});
  }
  measurement(budgetCalls:number|null) {
    // The frozen budget is independently labelled; adapter/Trace invocation totals are never substituted.
    const knownPreSend=this.requests.filter(r=>!r.sent&&!this.headerStarted.has(r.requestId)&&r.reason!=='frozen_budget_pre_send_blocked').length;
    return {...modelMeasurement(this.requests,this.complete,budgetCalls===null?null:budgetCalls-knownPreSend),
      frozenBudgetCalls:budgetCalls,knownPreSendTransportAttempts:knownPreSend,
      transportEvidenceComplete:this.complete,
      reconciliationSource:'frozen budget dispatch counter; NOT Trace/adapter invocation',invocations:this.invocations,
      boundary:'undici:request:bodySent after socket writes; failed sent requests count; known pre-send failures excluded; partial-write uncertainty stays UNKNOWN'};
  }
}
