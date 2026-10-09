import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadDesktopEnvironmentConfig} from '../src/composition/desktop-environment-config.js';
import {createRootAssembly} from '../src/composition/root.js';
import {HiddenChromeCreationPermit,validateChromeCreationAuthorization} from '../src/desktop-provider/hidden-chrome-creation.js';

test('explicit Hidden Chrome config registers lazy read-only scenario and never promotes generic Tasks',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'hidden-chrome-config-'));
  const path=join(directory,'operator.json');
  const config={hiddenChrome:{path:resolve('synthetic/chrome.exe')}};
  writeFileSync(path,JSON.stringify(config));
  const assembly=await createRootAssembly({rootDir:directory,...loadDesktopEnvironmentConfig(path),
    model:{createModel(){assert.fail('discovery cannot call a model');}}});
  try {
    const options=await assembly.controller.desktopOptions();
    const chrome=options.find(item=>item.environmentId==='local-workspace:chrome');
    if(process.platform==='win32') {
      assert.ok(chrome);assert.equal(chrome.executable,false);assert.equal(chrome.scenarios?.length,1);
      assert.equal(chrome.scenarios![0]!.id,'live-01-chrome-readonly-8102');
      assert.equal(chrome.scenarios![0]!.availability,'supported');
    }else assert.equal(chrome,undefined);
    assert.equal(options.some(item=>item.environmentId==='local-workspace:fixture'),false);
    for(const invalid of [{hiddenChrome:{path:'chrome.exe'}},{hiddenChrome:{path:resolve('other.exe')}},
      {hiddenChrome:{...config.hiddenChrome,unknown:true}},{...config,localWorkspace:{app:'fixture'}}]) {
      writeFileSync(path,JSON.stringify(invalid));assert.throws(()=>loadDesktopEnvironmentConfig(path),/invalid-hidden-chrome-config/);
    }
  }finally{await assembly.dispose();rmSync(directory,{recursive:true,force:true});}
});

const creation={authorizationId:'11111111-1111-4111-8111-111111111111',keyName:'agent-desktop-hidden-chrome-20261009-2',
  outputFile:'AgentDesktop_8102_API_Key_20261009_2.txt',allModels:true as const,maxOutputTokens:40000 as const,otherDefaults:true as const};
test('explicit new authorization lists both finite scenes lazily without opening Chrome or enabling generic execution',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'chrome-authorized-config-')),path=join(directory,'operator.json');
  writeFileSync(path,JSON.stringify({hiddenChrome:{path:resolve('synthetic/chrome.exe'),creationAuthorization:creation}}));
  const assembly=await createRootAssembly({rootDir:directory,...loadDesktopEnvironmentConfig(path),
    model:{createModel(){assert.fail('catalog cannot call a model');}}});
  try {
    const option=(await assembly.controller.desktopOptions()).find(item=>item.environmentId==='local-workspace:chrome');
    if(process.platform==='win32') {
      assert.equal(option?.executable,false);assert.equal(option?.scenarios?.length,2);
      assert.equal(option?.scenarios?.[1]?.id,'live-01-chrome-create-one-8102');assert.equal(option?.scenarios?.[1]?.availability,'supported');
    }
  }finally{await assembly.dispose();rmSync(directory,{recursive:true,force:true});}
});
test('one-Key local authorization validates fixed settings and refuses original output or arbitrary names',()=>{
  validateChromeCreationAuthorization(creation);
  for(const invalid of [{...creation,outputFile:'AgentDesktop_8102_API_Key.txt'},
    {...creation,outputFile:'../outside.txt'},{...creation,keyName:'unknown'},
    {...creation,maxOutputTokens:1},{...creation,allModels:false},{...creation,otherDefaults:false},
    {...creation,authorizationId:'not-a-new-id'},{...creation,unapproved:true}])
    assert.throws(()=>validateChromeCreationAuthorization(invalid),/invalid-hidden-chrome-creation-authorization/);
});
test('creation permission is lazy, exclusive across Tasks/restart, single-dispatch and never overwrites output',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'chrome-permit-'));
  const permit=new HiddenChromeCreationPermit(directory,creation,()=>directory);
  try {
    assert.equal(permit.available(),true);
    const claims=await Promise.allSettled([permit.reserve('synthetic-a'),permit.reserve('synthetic-b')]);
    assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(permit.available(),false);
    assert.equal(new HiddenChromeCreationPermit(directory,creation,()=>directory).available(),false);
    const granted=claims.find(r=>r.status==='fulfilled');assert.ok(granted?.status==='fulfilled');
    await granted.value.claim();await assert.rejects(granted.value.claim());
    const second=new HiddenChromeCreationPermit(directory,{...creation,authorizationId:'22222222-2222-4222-8222-222222222222'},()=>directory);
    writeFileSync(join(directory,creation.outputFile),'SYNTHETIC_EXISTING_OUTPUT');
    await assert.rejects(second.reserve('synthetic-c'),/output conflict/);
    assert.equal(second.available(),true,'conflict is detected before reserving or dispatching');
  }finally{rmSync(directory,{recursive:true,force:true});}
});
