import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { test } from 'node:test';
const root=resolve('testbench/verification/v1');
const read=(name:string)=>JSON.parse(readFileSync(resolve(root,name),'utf8'));

test('验收数据集版本指纹与素材一致',()=>{
  const manifest=read('manifest.json');
  for(const [file,hash] of Object.entries(manifest.files)) {
    const rel=relative(root,resolve(root,file));assert.ok(!rel.startsWith('..')&&!isAbsolute(rel));
    assert.equal(createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex'),hash,file);
  }
});
test('同场景变体按 family 隔离，开发集与留出集不交叉',()=>{
  const dev=read('development.json'),holdout=read('holdout.json');
  const families=new Set(dev.map((c:any)=>c.family));
  assert.ok(holdout.every((c:any)=>!families.has(c.family)));
  const all=[...dev,...holdout];assert.equal(new Set(all.map(c=>c.id)).size,all.length);
  assert.ok(dev.every((c:any)=>c.split==='development'));assert.ok(holdout.every((c:any)=>c.split==='holdout'));
  for(const c of all) {assert.ok(c.expected.rationale);assert.ok(c.goal);assert.ok(c.input);
    assert.ok(['pass','fail','unknown'].includes(c.expected.verdict));assert.equal(c.provenance,'synthetic');}
});
test('当前所有动作种类有场景映射，每个基础场景包含三态对照',()=>{
  const scenarios=read('scenarios.json').scenarios;
  const kinds=new Set(scenarios.flatMap((s:any)=>s.actionKinds));
  for(const kind of ['navigate','click','double_click','type','paste_text','drag','keypress','scroll','wait','screenshot','ask_user','done'])assert.ok(kinds.has(kind),kind);
  const cases=[...read('development.json'),...read('holdout.json')];
  for(const s of scenarios) {
    for(const variant of ['pass','fail','unknown'])assert.ok(cases.some(c=>c.id===`${s.id}/${variant}`));
    for(const file of s.codeRefs)assert.ok(existsSync(resolve(file)),file);
  }
});
test('原始证据用例必须声明采集缺口，图片素材不可伪装成已执行验收',()=>{
  const raw=read('raw-cases.json');assert.ok(raw.length>0);
  for(const c of raw) {
    assert.equal(c.tier,'raw');assert.equal(c.executionStatus,'blocked-no-raw-collector-adapter');
    assert.ok(c.requiredFacts.length);assert.ok(c.expected.rationale);
    if(c.raw.image)assert.equal(createHash('sha256').update(readFileSync(resolve(root,c.raw.image.file))).digest('hex'),c.raw.image.sha256);
  }
});
