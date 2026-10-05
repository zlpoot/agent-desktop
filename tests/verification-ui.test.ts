import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {collectDom,inspectUi,parseLegacyUia,type UiSnapshot} from '../src/verification/ui-evidence.js';
const binding={session:'s',expectedSession:'s',object:'doc',expectedObject:'doc',capturedAt:90,now:100,notBefore:80,maxAgeMs:30};
function snapshot():UiSnapshot {return {id:'capture',source:'uia',binding,complete:true,nodes:[
  {id:'one',owner:'dialog-A',role:'Button',name:'Submit',nameComplete:true,visible:true,selected:true,
    fields:{value:{value:'approved',complete:true}}}]};}
test('UI unique match requires complete enumeration, bound identity and visibility',()=>{
  const s=snapshot();assert.equal(inspectUi(s,{role:'Button',name:'Submit'},'value').verdict,'pass');
  assert.equal(inspectUi({...s,complete:false},{role:'Button'}).verdict,'unknown');
  s.nodes[0].visible=undefined;assert.equal(inspectUi(s,{role:'Button'}).verdict,'unknown');
  s.nodes[0].visible=true;s.nodes[0].id=undefined;assert.equal(inspectUi(s,{role:'Button'}).verdict,'unknown');
});
test('duplicate visible targets fail; owner scopes isolate, duplicate IDs never prove uniqueness',()=>{
  const s=snapshot();s.nodes.push({...s.nodes[0],id:'two',owner:'dialog-B'});
  assert.equal(inspectUi(s,{role:'Button'}).verdict,'fail');
  assert.equal(inspectUi(s,{owner:'dialog-A',role:'Button'}).verdict,'pass');
  s.nodes[1].id='one';assert.equal(inspectUi(s,{role:'Button'}).verdict,'unknown');
});
test('unknown owner or selected state may hide another match; partial value stays partial',()=>{
  const s=snapshot();s.nodes.push({...s.nodes[0],id:'two',selected:undefined});
  assert.equal(inspectUi(s,{selected:true}).verdict,'unknown');
  s.nodes.pop();s.nodes[0].fields.value.complete=false;
  const result=inspectUi(s,{selected:true},'value');assert.equal(result.verdict,'unknown');
  assert.equal(result.evidence[0].complete,false);
  assert.equal(inspectUi({...s,binding:{...binding,session:'wrong'}},{selected:true}).evidence.length,0);
});
test('legacy UIA text does not manufacture stable identity or selected document state',()=>{
  const nodes=parseLegacyUia('TabItem | saved.txt\nTabItem | changed.txt\nButton | Submit | container=dialog-A');
  assert.equal(nodes[2].owner,'dialog-A');assert.equal(nodes[0].id,undefined);assert.equal(nodes[0].selected,undefined);
  assert.equal(inspectUi({...snapshot(),nodes,complete:false},{role:'TabItem',selected:true}).verdict,'unknown');
});
test('DOM extracts scoped row, excludes hidden text and preserves truncation; scripts/network disabled',async()=>{
  process.env.PLAYWRIGHT_BROWSERS_PATH??=resolve('.playwright-browsers');
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
    await context.route('**/*',route=>route.abort());
    const page=await context.newPage();
    await page.setContent('<table><tr data-id="other"><td>21</td></tr><tr data-id="target"><td data-field="quantity">12</td></tr></table><div hidden id="old">success</div>');
    const config={id:'dom',scope:'tr[data-id="target"]',fieldSelector:'[data-field="quantity"]',field:'quantity'};
    const s=await collectDom(page,binding,config);
    const result=inspectUi(s,{owner:config.scope},'quantity');assert.equal(result.verdict,'pass');assert.equal(result.evidence[0].value,'12');
    const hidden=await collectDom(page,binding,{...config,scope:'#old',fieldSelector:':scope'});
    assert.equal(inspectUi(hidden,{owner:'#old'},'quantity').verdict,'unknown');
    const partial=await collectDom(page,binding,{...config,maxText:1});
    assert.equal(inspectUi(partial,{owner:config.scope},'quantity').verdict,'unknown');
    await page.setContent('<button>A</button><button>B</button>');
    const limited=await collectDom(page,binding,{...config,scope:'button',fieldSelector:':scope',limit:1});
    assert.equal(inspectUi(limited,{role:'button'}).verdict,'unknown');
    await page.setContent('<div id="result"><span hidden>success</span>processing</div>');
    const rendered=await collectDom(page,binding,{...config,scope:'#result',fieldSelector:':scope'});
    assert.equal(inspectUi(rendered,{owner:'#result'},'quantity').evidence[0].value,'processing');
  } finally {await browser.close();}
});
