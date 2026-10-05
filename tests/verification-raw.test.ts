import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkFrame,decodeFile,inspectPng,checkBinding,normalizeFields,type CaptureBinding} from '../src/verification/raw-evidence.js';
import {VerificationEngine} from '../src/verification/engine.js';
const image=readFileSync('testbench/verification/v1/assets/desktop-context.png');
const binding:CaptureBinding={session:'s',expectedSession:'s',object:'desktop',expectedObject:'desktop',capturedAt:90,now:100,notBefore:80,maxAgeMs:30};
test('PNG verifies payload; truncation, changed CRC and metadata mismatch cannot pass',()=>{
  const parsed=inspectPng(image)!;assert.ok(parsed);assert.equal(parsed.width,2048);assert.equal(parsed.height,1152);
  assert.equal(inspectPng(image.subarray(0,image.length-8)),undefined);
  const corrupt=Buffer.from(image);corrupt[50]^=1;assert.equal(inspectPng(corrupt),undefined);
  assert.equal(checkFrame(image,{width:1}).reason,'image_metadata_mismatch');
});
test('desktop label alone cannot prove coverage; window capture cannot be full desktop',()=>{
  assert.equal(checkFrame(image,{captureType:'desktop'}).verdict,'unknown');
  assert.equal(checkFrame(image,{captureType:'window'}).verdict,'fail');
});
test('bound geometry supports full desktop, clipping, scaling and negative monitor origins',()=>{
  const captureRect={x:-2048,y:0,width:2048,height:1152};
  const metadata={captureRect,desktopRect:{...captureRect},binding};
  assert.equal(checkFrame(image,metadata).verdict,'pass');
  assert.equal(checkFrame(image,{...metadata,desktopRect:{...captureRect,width:4096}}).verdict,'fail');
  assert.equal(checkFrame(image,{...metadata,captureRect:{...captureRect,width:1024}}).verdict,'unknown');
  assert.equal(checkFrame(image,{...metadata,binding:undefined}).verdict,'unknown');
});
test('capture session, object and time are mandatory; stale and future evidence rejected',()=>{
  assert.equal(checkBinding(binding).verdict,'pass');
  for(const patch of [{session:'other'},{object:'window'},{capturedAt:79},{capturedAt:101},{now:150},{maxAgeMs:0}])
    assert.equal(checkBinding({...binding,...patch}).verdict,'unknown');
});
test('byte decoding handles BOM and preserves exact newlines, rejects invalid UTF sequences',()=>{
  assert.equal(decodeFile(Buffer.from('efbbbf617070726f7665640d0a','hex'))?.text,'approved\r\n');
  assert.equal(decodeFile(Buffer.from('fffe1a90','hex'))?.text,'通');
  assert.equal(decodeFile(Buffer.from('e4b8','hex')),undefined);
});
test('structured collector preserves partial fields and binds engine evidence to the capture',async()=>{
  const capture={id:'capture',source:'uia' as const,revision:'v1',fields:[{field:'text',value:'approved',complete:false}]};
  const normalized=normalizeFields(binding,capture);assert.equal(normalized.evidence.length,1);
  const result=await new VerificationEngine().verify({session:'s',now:100,notBefore:80,evidence:normalized.evidence,
    contract:{id:'text',scope:'action',requirements:['text'],criteria:[{id:'text',requirement:'text',object:'desktop',field:'text',sources:['uia'],predicate:{op:'equals',expected:'approved'}}]}});
  assert.equal(result.verdict,'unknown');assert.equal(result.checks[0].reason,'partial_evidence');
  assert.equal(normalizeFields({...binding,session:'wrong'},capture).evidence.length,0);
  assert.equal(normalizeFields(binding,{...capture,fields:[...capture.fields,...capture.fields]}).evidence.length,0);
});
