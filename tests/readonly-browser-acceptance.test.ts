import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {FakeModel} from '../src/agent/model-adapter.js';
import {FakeRuntime} from '../src/runtime/runtime-adapter.js';
import {createAgentLoop} from '../src/graph/graph.js';
import {initialState} from '../src/graph/state.js';
import {SqliteTrace} from '../src/trace/sqlite-trace.js';
import {auditTaskContractCoverage} from '../src/verification/task-contract-coverage.js';
import {isReadonlyBrowserContract,readonlyBrowserAcceptance} from '../src/verifier/readonly-browser-verifier.js';
import type {Observation} from '../src/actions/schema.js';
import type {CompletionCriteria} from '../src/verifier/verifier.js';
import type {PlannedVerificationContract} from '../src/agent/task-planner.js';

const url='http://example.test/readonly.html';
const title='Synthetic Readonly Title';
const marker='SYNTHETIC-READ-OK-42';
const goal=`仅打开 ${url}，读取网页标题和页面唯一标记 ${marker}，并报告观察结果。只读，不访问其他地址，不点击、输入、下载或登录。
完成条件：最终 URL 为 ${url}，网页标题为 ${title}，页面正文含唯一标记 ${marker}。以实际页面 DOM 和最终 URL 独立核验。
操作限制：仅允许导航到 ${url} 并读取观察。禁止其他地址、第三方站点、账号登录、点击、输入、下载、文件或站点写入及 Native/VM 输入。`;
const criteria:CompletionCriteria={urlIncludes:url,domIncludes:`<title>${title}</title>`,pageTextIncludes:marker};
const contract:PlannedVerificationContract={goal,successConditions:criteria,
  evidenceSources:{urlIncludes:'browser',domIncludes:'dom',pageTextIncludes:'dom'},
  verifierStrategy:'rules_then_jev'};
function observed():Observation {
  return {url,dom:`<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${marker}</p></body></html>`,
    pageText:`${title}\n${marker}`,textEvidence:[{source:'dom',text:marker}],
    capture:{epoch:'synthetic',sequence:2,object:'page:synthetic',startedAt:10,finishedAt:11,
      clock:'collector',atomic:false,fields:{url:{complete:true,source:'api'},
        dom:{complete:true,source:'dom'},pageText:{complete:true,source:'dom'}}}};
}

test('readonly identity uses current source-bound rules without any fetch',t=>{
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw Error('No network permitted');});
  const result=readonlyBrowserAcceptance(goal,criteria,observed(),contract);
  assert.equal(isReadonlyBrowserContract(goal,contract),true);
  assert.equal(result.verdict,'pass');
  assert.equal(result.auxiliary,undefined);
  assert.equal(result.checks.length,5);
  assert.equal(fetchMock.mock.calls.length,0);
});

test('only the exact title condition from the complete original goal qualifies without changing criteria',t=>{
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw Error('No network permitted');});
  const wrapped={...criteria,domIncludes:`<title>${title}</title>`};
  const frozen={...contract,successConditions:wrapped};
  assert.equal(readonlyBrowserAcceptance(goal,wrapped,observed(),frozen).verdict,'pass');
  assert.equal(frozen.successConditions.domIncludes,`<title>${title}</title>`);
  const plain={...criteria,domIncludes:title};
  const plainContract={...contract,successConditions:plain};
  assert.equal(isReadonlyBrowserContract(goal,plainContract),false);
  assert.equal(readonlyBrowserAcceptance(goal,plain,observed(),plainContract).verdict,'unknown');
  const wrong=observed();
  wrong.dom=`<html><head><title>Wrong</title></head><body><template><title>${title}</title></template>${marker}</body></html>`;
  assert.equal(readonlyBrowserAcceptance(goal,wrapped,wrong,frozen).verdict,'fail');
  assert.equal(fetchMock.mock.calls.length,0);
});

test('partial, ambiguous or unrelated title markup remains unsupported',()=>{
  for(const domIncludes of [`<title>${title}`,`<title>${title}</title><title>Wrong</title>`,
    `<h1>${title}</h1>`,`<title><b>${title}</b></title>`,`<title></title>`]){
    const unsupported={...criteria,domIncludes};
    const report=readonlyBrowserAcceptance(goal,unsupported,observed(),{...contract,successConditions:unsupported});
    assert.equal(report.verdict,'unknown');
    assert.equal(report.reason,'unsupported_condition');
  }
});

test('wrong URL, title (despite matching H1), or marker never passes',()=>{
  const cases:Array<[string,(o:Observation)=>void]>=[
    ['different URL',o=>{o.url='http://example.test/other.html';}],
    ['different query',o=>{o.url=`${url}?other=1`;}],
    ['different title',o=>{o.dom=o.dom!.replace(`<title>${title}</title>`,'<title>Wrong</title>');}],
    ['title in a comment',o=>{o.dom=`<html><!-- <head><title>${title}</title></head> --><head><title>Wrong</title></head><body>${title} ${marker}</body></html>`;}],
    ['title in a script',o=>{o.dom=`<html><head><script>const markup='<title>${title}</title>';</script><title>Wrong</title></head><body>${title} ${marker}</body></html>`;}],
    ['missing marker',o=>{o.pageText=title;o.textEvidence=[{source:'dom',text:title}];}],
  ];
  for(const [name,change] of cases){
    const o=observed();change(o);
    assert.notEqual(readonlyBrowserAcceptance(goal,criteria,o,contract).verdict,'pass',name);
  }
});

test('missing, partial, foreign or unsupported evidence remains UNKNOWN',()=>{
  assert.equal(readonlyBrowserAcceptance(goal,undefined,observed(),contract).verdict,'unknown');
  const cases:Array<(o:Observation)=>void>=[
    o=>{delete o.capture;},
    o=>{delete o.url;},
    o=>{o.capture!.fields.dom.complete=false;},
    o=>{o.capture!.fields.pageText.complete=false;},
    o=>{o.capture!.fields.url.source='dom';},
    o=>{o.capture!.object='page:other-epoch';},
    o=>{o.capture!.finishedAt=9;},
    o=>{o.dom='<h1>Synthetic Readonly Title</h1>';},
    o=>{o.textEvidence=[{source:'visual_model',text:marker}];},
  ];
  for(const change of cases){const o=observed();change(o);
    assert.equal(readonlyBrowserAcceptance(goal,criteria,o,contract).verdict,'unknown');}
  assert.equal(readonlyBrowserAcceptance(goal,{...criteria,domIncludes:'edited'},observed(),contract).verdict,'unknown');
  assert.equal(readonlyBrowserAcceptance(goal,criteria,observed(),{...contract,goal:'different goal'}).verdict,'unknown');
  assert.equal(readonlyBrowserAcceptance(goal,criteria,observed(),{...contract,
    evidenceSources:{...contract.evidenceSources,domIncludes:'uia'}}).verdict,'unknown');
  const extended={...criteria,accessibilityIncludes:'unverified'};
  assert.equal(readonlyBrowserAcceptance(goal,extended,observed(),{...contract,successConditions:extended}).verdict,'unknown');
  const saveGoal=`${goal} 然后保存客户资料`;
  assert.equal(readonlyBrowserAcceptance(saveGoal,criteria,observed(),{...contract,goal:saveGoal}).verdict,'unknown');
  const fileGoal=`${goal} 然后保存桌面 report.txt`;
  assert.equal(readonlyBrowserAcceptance(fileGoal,criteria,observed(),{...contract,goal:fileGoal}).verdict,'unknown');
});

class ReadonlyModel extends FakeModel {
  visualChecks=0;
  async planStage(){return {goal:'已打开页面并读取标题和标记',
    successCondition:`地址栏为 ${url}，标签标题为 ${title}，正文为 ${marker}`,isFinal:true};}
  async verifyStage(){this.visualChecks++;return {ok:false,confidence:1,
    evidence:'网页截图不包含地址栏和标签',source:'visual_model' as const};}
}
class ReadonlyRuntime extends FakeRuntime {
  constructor(private readonly change?:(o:Observation)=>void){super();}
  override async observe(){const current=await super.observe();const o=observed();
    if(current.url==='about:blank'){o.url=current.url;o.dom='<title>Blank</title>';o.pageText='Blank';}
    else this.change?.(o);
    return o;
  }
}

test('production graph closes a frozen readonly final stage despite browser chrome absent from screenshots',async t=>{
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw Error('No network permitted');});
  for(const variant of ['pass','plain-title','partial','wrong-title','coverage-blocked','non-final'] as const){
    const dir=mkdtempSync(join(tmpdir(),'readonly-browser-'));
    const trace=new SqliteTrace(join(dir,'trace.sqlite'));
    const model=new ReadonlyModel([{kind:'navigate',url},{kind:'done',summary:'observed'}]);
    if(variant==='non-final')model.planStage=async()=>({goal:'中间阶段',successCondition:'地址栏可见',isFinal:false});
    const runtime=new ReadonlyRuntime(o=>{
      if(variant==='partial')o.capture!.fields.dom.complete=false;
      if(variant==='wrong-title')o.dom=o.dom!.replace(`<title>${title}</title>`,'<title>Wrong</title>');
    });
    try {
      const frozenCriteria=variant==='plain-title'?{...criteria,domIncludes:title}:criteria;
      const frozenContract={...contract,successConditions:frozenCriteria};
      const coverage=auditTaskContractCoverage(goal,frozenCriteria);
      assert.equal(coverage.covered,true);
      const state={...initialState(`readonly-${variant}`,goal,undefined,frozenCriteria),
        verificationContract:frozenContract,contractCoverage:variant==='coverage-blocked'
          ?{...coverage,covered:false,reason:'test-missing-proof',reviewRequired:true}:coverage,
        // Generic production Task contracts do not have an environment field.
        taskContract:{target:goal,constraint:'只读',stageActionLimit:4,taskActionLimit:4}};
      const result=await createAgentLoop({model,runtime,trace,maxSteps:4}).invoke(state);
      assert.equal(runtime.executed.length,1);
      assert.equal(runtime.executed[0].kind,'navigate');
      if(variant==='pass'){
        assert.equal(result.status,'done');
        assert.equal(result.goalVerification?.ok,true);
        assert.equal(result.acceptanceReport?.verdict,'pass');
        assert.equal(result.acceptanceReport?.auxiliary,undefined);
        assert.equal(result.completedStages?.[0].source,'dom');
        assert.equal(model.visualChecks,2,'no extra visual call after done');
      }else{
        assert.notEqual(result.status,'done',variant);
        assert.notEqual(result.goalVerification?.ok,true,variant);
        assert.equal(model.visualChecks,variant==='non-final'||variant==='plain-title'?3:2,
          'unsupported contracts retain the original stage verifier; eligible rules do not fall back');
      }
    }finally{
      trace.close();
      const target=resolve(dir);
      if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('readonly-browser-'))
        throw Error('Unexpected temporary directory');
      rmSync(target,{recursive:true,force:true});
    }
  }
  assert.equal(fetchMock.mock.calls.length,0);
});

test('an additional product price requirement cannot pass the readonly identity shortcut',async t=>{
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw Error('No network permitted');});
  const priceGoal=`${goal} 另外核对商品价格为 42 元。`;
  const incompleteContract={...contract,goal:priceGoal};
  assert.equal(isReadonlyBrowserContract(priceGoal,incompleteContract),false);
  assert.equal(readonlyBrowserAcceptance(priceGoal,criteria,observed(),incompleteContract).verdict,'unknown');
  const dir=mkdtempSync(join(tmpdir(),'readonly-browser-')),trace=new SqliteTrace(join(dir,'trace.sqlite'));
  const model=new ReadonlyModel([{kind:'navigate',url},{kind:'done',summary:'only title and marker observed'}]);
  try{
    const result=await createAgentLoop({model,runtime:new ReadonlyRuntime(),trace,maxSteps:4}).invoke({
      ...initialState('readonly-price',priceGoal,undefined,criteria),verificationContract:incompleteContract,
      contractCoverage:auditTaskContractCoverage(priceGoal,criteria),
      taskContract:{target:priceGoal,constraint:'只读',stageActionLimit:4,taskActionLimit:4}});
    assert.notEqual(result.status,'done');
    assert.notEqual(result.goalVerification?.ok,true);
    assert.equal(result.acceptanceReport,undefined);
    assert.equal(model.visualChecks,3,'unsupported goal stays on the existing verification path');
    assert.equal(fetchMock.mock.calls.length,0);
  }finally{
    trace.close();
    const target=resolve(dir);
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('readonly-browser-'))throw Error('Unexpected temp path');
    rmSync(target,{recursive:true,force:true});
  }
});
