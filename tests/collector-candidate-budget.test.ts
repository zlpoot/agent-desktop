import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve as resolvePath} from 'node:path';
import {PlaywrightRuntime} from '../src/runtime/browser/playwright-runtime.js';
import type {Observation} from '../src/actions/schema.js';
import {remapTarget} from '../src/workflows/target-remap.js';
import {classifyCandidateObservation} from '../src/observation/candidate-budget.js';

/**
 * P9-A4.5 F1 — C0 candidate-budget 治理验收（真实 Chromium + 本地合成页面）。
 * 页面结构复现 Wikipedia 形态：header 语言列表 / sidebar / TOC 的 li>a 壳层
 * （li 文本 == a 文本，旧 collector 双计耗尽 500 预算），正文链接排在文档最后。
 * 新 collector：壳层去重（li+a 双计 → 仅 a）+ 语义优先排序（交互在容器前）后再截断。
 */
function buildPageHtml(): string {
  const languageItems = Array.from({length: 120},(_,i)=>`<li><a href="/wiki/lang-${i}">lang-${i}</a></li>`).join('');
  const sidebarItems = Array.from({length: 100},(_,i)=>`<li><a href="/wiki/nav-${i}">nav-${i}</a></li>`).join('');
  const tocItems = Array.from({length: 60},(_,i)=>`<li><a href="/wiki/sec-${i}">sec-${i}</a></li>`).join('');
  const bodyLinks = Array.from({length: 30},(_,i)=>`<a href="/wiki/body-${i}">正文目标${i}</a>`).join(' ');
  const dupLinks = `<a href="/wiki/dup">重复目标</a> <a href="/wiki/dup">重复目标</a> <a href="/wiki/dup">重复目标</a>`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>合成预算页面</title></head>
<body>
<nav id="languages"><ul>${languageItems}</ul></nav>
<nav id="sidebar"><ul>${sidebarItems}</ul></nav>
<nav id="toc"><ul>${tocItems}</ul></nav>
<main><p>正文段落：${bodyLinks} ${dupLinks}</p>
<ul><li class="real">真实列表项 <a href="/wiki/inner">内部链接</a></li></ul>
<input type="checkbox" aria-label="同意条款">
<input type="text" value="查询">
</main>
</body></html>`;
}

test('F1: collector candidate-budget — 壳层去重 + 语义优先排序后正文链接全部进入 items',async()=>{
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.end(buildPageHtml());
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('server unavailable');
  const dir=mkdtempSync(join(tmpdir(),'p9-f1-budget-'));
  let runtime:PlaywrightRuntime|undefined;
  try {
    runtime=await PlaywrightRuntime.launch({headless:true,artifactDir:join(dir,'screenshots')});
    const url=`http://127.0.0.1:${address.port}/`;
    await runtime.execute({kind:'navigate',url});
    const observation:Observation=await runtime.observe();
    const structured=observation.structured!;
    assert.equal(structured.source,'dom');
    const items=structured.items!;
    // 1) 去重后候选池 < 500 → complete=true（旧行为：560 双计触顶 complete=false）
    assert.equal(structured.complete,true);
    assert.equal(structured.budgetSaturated,false);
    assert.equal(structured.retainedCount,items.length);
    assert.equal(structured.candidateCount,items.length);
    assert.ok(items.length<=500);
    // 2) 正文链接（文档最后、旧行为必丢）全部进入 items
    for(let i=0;i<30;i++) assert.ok(items.some((item)=>item.text===`正文目标${i}`),
      `正文目标${i} 应进入 structured candidates`);
    // 2b) 同 text+href 重复链接抑制：3 个"重复目标"只保留文档序首个
    assert.equal(items.filter((item)=>item.text==='重复目标').length,1,
      '同 text+href 重复候选应去重为 1 个（A4 remap unique hit）');
    // 3) 壳层 li 全部抑制：仅保留 1 个"真实列表项"（li 文本 ≠ a 文本）
    const listitems=items.filter((item)=>item.role==='listitem');
    assert.equal(listitems.length,1);
    assert.equal(listitems[0].text,'真实列表项 内部链接');
    // 4) li+a 双计去重：sidebar 词在 items 中只出现一次（a 的）
    for(let i=0;i<100;i++) assert.equal(items.filter((item)=>item.text===`nav-${i}`).length,1,
      `nav-${i} 不应因 li+a 双计重复`);
    // 5) 语义优先排序：所有 listitem（容器 rank 2）排在所有 link（交互 rank 0）之后
    const firstLink=items.findIndex((item)=>item.role==='link');
    const listitemIndex=items.findIndex((item)=>item.role==='listitem');
    assert.ok(firstLink>=0&&listitemIndex>firstLink,'容器 listitem 应排在交互 link 之后');
    // 6) 交互元素（checkbox/textbox）不被去重误伤
    assert.ok(items.some((item)=>item.role==='checkbox'&&item.text==='同意条款'));
    assert.ok(items.some((item)=>item.role==='textbox'&&item.value==='查询'));
  } finally {
    await runtime?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const target=resolvePath(dir);
    if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p9-f1-budget-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});

test('F1: collector 截断边界 — 区域语义优先使正文链接在预算内保留，超预算 complete 如实=false',async()=>{
  // 极端场景：600 个壳层 li>a（旧行为 1200 双计），去重后仍有 600 个 a > 500 → 截断；
  // 正文链接位于 <main> 内（rank 1）< 导航链接（rank 3）→ 截断时正文优先保留
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    const shell=Array.from({length:600},(_,i)=>`<li><a href="/wiki/s-${i}">s-${i}</a></li>`).join('');
    response.end(`<!doctype html><html><body><nav><ul>${shell}</ul></nav>
      <main><p><a href="/wiki/keep-a">关键目标甲</a> <a href="/wiki/keep-b">关键目标乙</a></p></main>
      <nav><a href="/wiki/tail">预算尾部目标</a></nav></body></html>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('server unavailable');
  const dir=mkdtempSync(join(tmpdir(),'p9-f1-trunc-'));
  let runtime:PlaywrightRuntime|undefined;
  try {
    runtime=await PlaywrightRuntime.launch({headless:true,artifactDir:join(dir,'screenshots')});
    await runtime.execute({kind:'navigate',url:`http://127.0.0.1:${address.port}/`});
    const observation:Observation=await runtime.observe();
    const items=observation.structured!.items!;
    assert.equal(observation.structured!.complete,false,'超过 500 预算时 complete 必须如实=false');
    assert.equal(items.length,500,'截断后 items 不得越过 500 上限');
    assert.equal(observation.structured!.retainedCount,500);
    assert.equal(observation.structured!.candidateCount,603);
    assert.equal(observation.structured!.candidateBudget,500);
    assert.equal(observation.structured!.budgetSaturated,true);
    assert.ok(observation.pageText!.includes('预算尾部目标'));
    assert.equal(classifyCandidateObservation(observation,'预算尾部目标').reason,'observation_budget_exhausted');
    assert.equal(classifyCandidateObservation(observation,'关键目标甲').reason,'captured');
    assert.equal(items.filter((item)=>item.role==='listitem').length,0,'壳层 li 全部抑制');
    // 正文区链接（main 内，语义优先）在截断预算内保留
    assert.ok(items.some((item)=>item.text==='关键目标甲'),'截断场景正文目标甲应保留（main 区语义优先）');
    assert.ok(items.some((item)=>item.text==='关键目标乙'),'截断场景正文目标乙应保留（main 区语义优先）');
    // 截断不整体保留空文本 <a>（噪声/ambiguity 约束）：不出现 text 为空的 link item
    assert.equal(items.filter((item)=>item.role==='link'&&!item.text).length,0);
  } finally {
    await runtime?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const target=resolvePath(dir);
    if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p9-f1-trunc-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});

test('G3: F1 collector 后同 text 不同 href 和相似目标仍冲突，70/15 安全边界不受排序影响',async()=>{
  const server=createServer((_request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.end(`<!doctype html><html><body>
      <nav><a href="/same-nav">同名目标</a><a href="/prefix-nav">相似目标乙</a>
        <a href="/margin-nav">相关边界目标乙</a></nav>
      <main><ul><li><a href="/same-body">同名目标</a></li></ul>
        <a href="/same-body">同名目标</a><a href="/prefix-body">相似目标甲</a>
        <a href="/margin-body">边界目标甲</a>
        <a href="/overlap">稳定核心 其他</a><a href="/href-only">无关证据</a>
      </main></body></html>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('server unavailable');
  const dir=mkdtempSync(join(tmpdir(),'p9-g3-'));
  let runtime:PlaywrightRuntime|undefined;
  try {
    runtime=await PlaywrightRuntime.launch({headless:true,artifactDir:join(dir,'screenshots')});
    await runtime.execute({kind:'navigate',url:`http://127.0.0.1:${address.port}/`});
    const observation=await runtime.observe();
    const candidates=observation.structured!.items;
    const same=candidates.filter(item=>item.text==='同名目标');
    assert.deepEqual(same.map(item=>item.href),['/same-body','/same-nav']);
    assert.notEqual(same[0].identity,same[1].identity);
    for(const [name,tokens] of [['同名目标',[]],['旧冻结名',['相似目标']]] as const){
      const verdict=remapTarget({spec:{kind:'role',role:'link',name},inputTokens:[...tokens],candidates});
      assert.equal(verdict.matched,false);
      assert.equal(verdict.rejectReason,'multi_candidate_conflict');
      assert.equal(verdict.target,undefined);
    }
    // Actual F1-ranked collection and reverse order must yield the same gates.
    for(const ordered of [candidates,[...candidates].reverse()]){
      const boundary=remapTarget({spec:{kind:'role',role:'link',name:'旧冻结名'},inputTokens:['边界目标'],candidates:ordered});
      assert.equal(boundary.matched,true); // 95 - 80 = 15, inclusive
      assert.equal(boundary.score,0.95);
      const narrow=remapTarget({spec:{kind:'role',role:'link',name:'旧冻结名'},inputTokens:['边界目标'],
        candidates:ordered,hrefFeatures:['/margin-nav']});
      assert.equal(narrow.rejectReason,'multi_candidate_conflict'); // 95 - 85 = 10
      const floor=remapTarget({spec:{kind:'role',role:'link',name:'稳定核心 原描述'},inputTokens:[],candidates:ordered});
      assert.equal(floor.matched,true);
      assert.equal(floor.score,0.70);
      const below=remapTarget({spec:{kind:'role',role:'link',name:'不存在'},inputTokens:[],
        candidates:ordered,hrefFeatures:['/href-only']});
      assert.equal(below.matched,false);
      assert.equal(below.rejectReason,'low_confidence');
      assert.equal(below.score,0.05);
    }
  } finally {
    await runtime?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const target=resolvePath(dir);
    if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p9-g3-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});

test('A5: 恰好 500 不误报 saturation，字段截断也不冒充候选预算耗尽',async()=>{
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    const content=request.url==='/long'?`<a href="/long">${'长'.repeat(301)}</a>`
      :Array.from({length:500},(_,i)=>`<a href="/target-${i}">唯一目标${i}</a>`).join('');
    response.end(`<!doctype html><html><body><main>${content}</main></body></html>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('server unavailable');
  const dir=mkdtempSync(join(tmpdir(),'p9-budget-meta-'));
  let runtime:PlaywrightRuntime|undefined;
  try{
    runtime=await PlaywrightRuntime.launch({headless:true,artifactDir:join(dir,'screenshots')});
    const url=`http://127.0.0.1:${address.port}`;
    await runtime.execute({kind:'navigate',url});
    const full=(await runtime.observe()).structured!;
    assert.equal(full.candidateCount,500);assert.equal(full.retainedCount,500);
    assert.equal(full.complete,true);assert.equal(full.budgetSaturated,false);
    await runtime.execute({kind:'navigate',url:url+'/long'});
    const long=(await runtime.observe()).structured!;
    assert.equal(long.candidateCount,1);assert.equal(long.retainedCount,1);
    assert.equal(long.complete,false);assert.equal(long.budgetSaturated,false);
  }finally{
    await runtime?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const target=resolvePath(dir);
    if(dirname(target)!==resolvePath(tmpdir())||!basename(target).startsWith('p9-budget-meta-'))
      throw new Error('Refusing to remove an unexpected test directory');
    rmSync(target,{recursive:true,force:true});
  }
});
