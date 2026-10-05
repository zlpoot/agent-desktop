import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {win32} from 'node:path';
import {fileEvidenceInput,type DesktopFileSnapshot} from '../src/verification/file-evidence.js';
import {VerificationEngine} from '../src/verification/engine.js';
const hash='a'.repeat(64);

const base:DesktopFileSnapshot={path:'C:\\Users\\agent\\Desktop\\result.txt',root:'C:\\Users\\agent\\Desktop',
  capturedAt:1000,exists:false,complete:true};
const expected={kind:'desktop_file' as const,path:'result.txt',contentEquals:'hello'};
async function verdict(before:DesktopFileSnapshot|undefined,after:DesktopFileSnapshot|undefined,
  effect:'none'|'uncertain'|'dispatched'='dispatched') {
  const result=fileEvidenceInput('task',1,expected,before,after,effect);
  return {result,report:result.input?await new VerificationEngine().verify(result.input):undefined};
}

test('new Desktop file with exact independently read content passes without a model',async()=>{
  const {report}=await verdict(base,{...base,capturedAt:1100,exists:true,kind:'file',size:5,
    mtimeMs:1050,sha256:hash,text:'hello'});
  assert.equal(report?.verdict,'pass');assert.equal(report?.metrics.modelCalls,0);
});
test('missing file and wrong saved content fail deterministically',async()=>{
  assert.equal((await verdict(base,{...base,capturedAt:1100})).report?.verdict,'fail');
  assert.equal((await verdict(base,{...base,capturedAt:1100,exists:true,kind:'file',
    mtimeMs:1050,size:5,text:'wrong',sha256:hash})).report?.verdict,'fail');
});
test('uncertain dispatch, absent collector, stale and unchanged file remain unknown',async()=>{
  assert.equal((await verdict(base,{...base,capturedAt:1100},'uncertain')).result.reason,'action_dispatch_not_confirmed');
  assert.equal((await verdict(base,undefined)).result.reason,'missing_file_capture_boundary');
  assert.equal((await verdict(base,{...base,capturedAt:62_000})).result.reason,'file_capture_order_unconfirmed');
  const unchanged={...base,exists:true,kind:'file' as const,capturedAt:1000,mtimeMs:900,
    size:5,sha256:hash,text:'hello'};
  assert.equal((await verdict(unchanged,{...unchanged,capturedAt:1100})).result.reason,
    'file_unchanged_since_baseline');
  assert.equal((await verdict(base,{...base,capturedAt:1100,exists:true,kind:'file',
    complete:false})).result.reason,'file_capture_incomplete');
});
test('file path and root changes cannot be treated as same artifact',async()=>{
  assert.equal((await verdict(base,{...base,path:'C:\\Users\\agent\\Desktop\\other.txt',capturedAt:1100})).result.reason,
    'file_identity_changed');
  const other={...base,path:'C:\\Users\\agent\\Desktop\\other.txt'};
  assert.equal((await verdict(other,{...other,capturedAt:1100})).result.reason,
    'file_does_not_match_declared_path');
});

test('creation boundary across Windows casing (absent echoes request, existing is canonical) passes',async()=>{
  // Real Guest behavior observed live (P7C-C2D): an absent file echoes the
  // requested (lowercase frozen) path; once saved, inspect_file returns the
  // canonical on-disk (uppercase) path. Same artifact on case-insensitive NTFS.
  const absent={...base,path:'C:\\Users\\agent\\Desktop\\p7c-c2d-20260930.txt',capturedAt:2000};
  const created={...base,path:'C:\\Users\\agent\\Desktop\\P7C-C2D-20260930.txt',capturedAt:2500,
    exists:true,kind:'file' as const,size:21,mtimeMs:2400,sha256:hash,text:'P7C-C2D-20260930-BODY'};
  const exp={kind:'desktop_file' as const,path:'p7c-c2d-20260930.txt',contentEquals:'P7C-C2D-20260930-BODY'};
  const n=fileEvidenceInput('task',6,exp,absent,created,'dispatched');
  assert.ok(n.input,`should build input, got reason ${n.reason}`);
  const report=await new VerificationEngine().verify(n.input!);
  assert.equal(report.verdict,'pass');
  // A genuinely different filename must still be rejected even if casing matched.
  assert.equal((await verdict(base,{...base,path:'C:\\Users\\agent\\Desktop\\other.txt',capturedAt:1100}))
    .result.reason,'file_identity_changed');
});

test('synthetic Guest RPC snapshots replay pass, wrong content fail, missing boundary unknown without a model',async()=>{
  const sample=JSON.parse(readFileSync(new URL('../testbench/verification/synthetic-file-rpc.json',
    import.meta.url),'utf8')) as {source:string;actionSource:string;graphActionVerified:boolean;
    expectedContent:string;before:DesktopFileSnapshot;after:DesktopFileSnapshot;localSha256:string};
  assert.equal(sample.source,'synthetic_guest_rpc');
  assert.equal(sample.actionSource,'synthetic_fixture');
  assert.equal(sample.graphActionVerified,false);
  assert.equal(sample.after.sha256,sample.localSha256);
  const path=win32.basename(sample.after.path);
  const replay=async(contentEquals:string,before:DesktopFileSnapshot|undefined)=>{
    const normalized=fileEvidenceInput('guest-rpc-smoke',1,
      {kind:'desktop_file',path,contentEquals},before,sample.after,'dispatched');
    return {normalized,report:normalized.input?await new VerificationEngine().verify(normalized.input):undefined};
  };
  const match=await replay(sample.expectedContent,sample.before);
  assert.equal(match.report?.verdict,'pass');
  assert.equal(match.report?.metrics.modelCalls,0);
  const mismatch=await replay('incorrect',sample.before);
  assert.equal(mismatch.report?.verdict,'fail');
  assert.equal(mismatch.report?.metrics.modelCalls,0);
  assert.equal((await replay(sample.expectedContent,undefined)).normalized.reason,
    'missing_file_capture_boundary');
});
