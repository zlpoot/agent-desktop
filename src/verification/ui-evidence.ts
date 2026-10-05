import type {Page} from 'playwright';
import {checkBinding,normalizeFields,type CaptureBinding,type RawCheck} from './raw-evidence.js';
import type {Evidence,Scalar} from './contracts.js';

export interface UiNode {
  id?:string; owner?:string; role:string; name:string; nameComplete:boolean;
  visible?:boolean; selected?:boolean;
  fields:Record<string,{value:Scalar;complete:boolean}>;
}
export interface UiSnapshot {
  id:string;source:'dom'|'uia';binding:CaptureBinding;revision?:string;
  complete:boolean;nodes:UiNode[];
}
export interface UiQuery {id?:string;owner?:string;role?:string;name?:string;selected?:boolean}
export function inspectUi(snapshot:UiSnapshot,query:UiQuery,field?:string):RawCheck & {evidence:Evidence[]} {
  const no=(reason:string,verdict:RawCheck['verdict']='unknown')=>({verdict,reason,evidence:[]});
  const bound=checkBinding(snapshot.binding);if(bound.verdict!=='pass')return no(bound.reason);
  if(!snapshot.id||!Object.values(query).some(v=>v!==undefined))return no('missing_ui_target');
  // A missing identity/visibility property may hide another match; never discard it as a definite nonmatch.
  const possible=snapshot.nodes.filter(n=>
    (query.id===undefined||n.id===undefined||n.id===query.id)&&
    (query.owner===undefined||n.owner===undefined||n.owner===query.owner)&&
    (query.role===undefined||n.role===query.role)&&
    (query.name===undefined||!n.nameComplete||n.name===query.name)&&
    (query.selected===undefined||n.selected===undefined||n.selected===query.selected)&&n.visible!==false);
  const definite=possible.filter(n=>n.id&&n.visible===true&&
    (query.id===undefined||n.id===query.id)&&(query.owner===undefined||n.owner===query.owner)&&
    (query.name===undefined||n.nameComplete&&n.name===query.name)&&
    (query.selected===undefined||n.selected===query.selected));
  const ids=definite.map(n=>n.id);
  if(new Set(ids).size!==ids.length)return no('duplicate_ui_identity');
  if(definite.length>1)return no('multiple_visible_targets','fail');
  if(!snapshot.complete||possible.length!==1||definite.length!==1)return no('target_uniqueness_unconfirmed');
  if(!field)return {verdict:'pass',reason:'unique_visible_target',evidence:[]};
  const value=definite[0].fields[field];if(!value)return no('missing_bound_field');
  const normalized=normalizeFields(snapshot.binding,{id:snapshot.id,source:snapshot.source,revision:snapshot.revision,
    fields:[{field,...value}]});
  if(normalized.issues.length)return no(normalized.issues[0]);
  return {verdict:value.complete?'pass':'unknown',reason:value.complete?'bound_field_extracted':'partial_bound_field',evidence:normalized.evidence};
}

/** Legacy pipe-delimited diagnostics do not carry stable identity, visibility or truncation guarantees. */
export function parseLegacyUia(text:string):UiNode[] {
  return text.split(/\r?\n/).filter(Boolean).map(line=>{
    const parts=line.split('|').map(s=>s.trim());
    return {role:parts[0]??'',name:parts[1]??'',nameComplete:false,
      owner:parts.slice(2).find(s=>s.startsWith('container='))?.slice(10),fields:{}};
  });
}

/** Capture a scoped DOM field in one browser evaluation. Selectors are contract data, never inferred from labels. */
export async function collectDom(page:Page,binding:CaptureBinding,config:{id:string;scope:string;fieldSelector:string;
  field:string;limit?:number;maxText?:number}):Promise<UiSnapshot> {
  const limit=config.limit??100,maxText=config.maxText??4096;
  if(!Number.isInteger(limit)||limit<1||limit>1000||!Number.isInteger(maxText)||maxText<1||maxText>100000)
    throw new Error('Invalid DOM collection limits');
  const result=await page.evaluate(({scope,fieldSelector,field,limit,maxText})=>{
    const roots=Array.from(document.querySelectorAll(scope));
    return {complete:roots.length<=limit,nodes:roots.slice(0,limit).map((root,index)=>{
      const values=fieldSelector===':scope'?[root]:Array.from(root.querySelectorAll(fieldSelector));
      const target=values.length===1?values[0]:undefined;
      // Rendered text excludes hidden descendants; textContent would leak stale hidden success banners.
      const text=target instanceof HTMLElement?target.innerText:undefined;
      const isVisible=[root,...target?[target]:[]].every(node=>{
        for(let at:Element|null=node;at;at=at.parentElement) {
          const style=getComputedStyle(at);
          if(at.hasAttribute('hidden')||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
        }
        const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0;
      });
      return {id:`dom-${index}`,owner:scope,role:root.tagName.toLowerCase(),name:'',nameComplete:true,
        visible:isVisible,fields:text!==undefined?{[field]:{value:text.slice(0,maxText),complete:text.length<=maxText}}:{}};
    })};
  },{...config,limit,maxText});
  return {...result,id:config.id,source:'dom',binding};
}
