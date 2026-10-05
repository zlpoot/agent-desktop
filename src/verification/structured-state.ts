import type {Observation} from '../actions/schema.js';
import type {CompletionCriteria} from '../verifier/verifier.js';

export type StructuredCondition = NonNullable<CompletionCriteria['structuredStates']>[number];
export type StructuredCheck = {verdict:'pass'|'fail'|'unknown';reason:string;message:string;
  actual?:string|boolean;expected?:string|boolean};

const clean=(value:string|undefined)=>(value??'').replace(/\s+/g,' ').trim();
const role=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'');

/** Evaluate a declared target against one fresh collector enumeration, never against flattened page text. */
export function checkStructuredState(condition:StructuredCondition, observation:Observation|undefined,
  source:'dom'|'uia'):StructuredCheck {
  const empty=(reason:string,message:string):StructuredCheck=>({verdict:'unknown',reason,message});
  let snapshot=observation?.structured;
  let stamped=observation?.capture?.fields.structured;
  // Existing Windows Worker exposes a complete, typed UIA control array in dom.
  // Normalize it on the Host so a P1 verifier upgrade does not require Guest deployment.
  if(!snapshot&&source==='uia'&&observation?.capture?.fields.dom?.source==='uia') {
    try {
      const controls=JSON.parse(observation.dom??'');
      if(Array.isArray(controls)&&controls.length<=501&&controls.every(item=>item&&typeof item==='object')) {
        snapshot={source:'uia',complete:observation.capture.fields.dom.complete,
          items:controls.filter(item=>item.visible).map(item=>({role:item.role,name:item.name,
            text:item.name,value:item.value,complete:item.nameComplete&&item.valueComplete}))};
        stamped=observation.capture.fields.dom;
      }
    } catch { /* Truncated or malformed control data remains UNKNOWN. */ }
  }
  if(!snapshot||!stamped||stamped.source!==source||snapshot.source!==source)
    return empty('evidence_unavailable','缺少指定来源的结构化控件采集');
  if(!snapshot.complete||!stamped.complete)
    return empty('evidence_unavailable','结构化控件枚举不完整，无法保证目标唯一');
  const matches=snapshot.items.filter(item=>role(item.role)===role(condition.target.role)&&
    (condition.target.name===undefined||clean(item.name)===clean(condition.target.name))&&
    (condition.target.text===undefined||clean(item.text)===clean(condition.target.text)));
  if(matches.length>1)return empty('target_ambiguous','目标控件匹配多个对象');
  // A complete view is not necessarily the entire application. The target may
  // live on another page/tab, so absence alone is not counterevidence.
  if(!matches.length)return empty('evidence_unavailable','当前视图没有目标控件，无法证明结果');
  const item=matches[0];
  if(item.complete===false)return empty('evidence_unavailable','目标控件属性采集不完整');
  let actual:string|boolean|undefined;
  if(condition.field==='classToken')actual=item.classTokens?.includes(condition.equals as string);
  else actual=item[condition.field];
  if(actual===undefined)return empty('evidence_unavailable',`目标控件缺少 ${condition.field} 属性`);
  const expected=condition.field==='classToken'?true:condition.equals;
  const equal=typeof actual==='string'&&typeof expected==='string'
    ?clean(actual)===clean(expected):actual===expected;
  return {verdict:equal?'pass':'fail',reason:equal?'predicate_satisfied':'predicate_contradicted',
    message:equal?'目标控件状态与预期一致':`目标控件 ${condition.field} 与预期不符`,
    actual,expected};
}
