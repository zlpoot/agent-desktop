import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadDesktopEnvironmentConfig} from '../src/composition/desktop-environment-config.js';
import {createRootAssembly} from '../src/composition/root.js';

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
