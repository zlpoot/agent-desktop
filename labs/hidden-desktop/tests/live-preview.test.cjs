const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const Client=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../live-preview.js'),'utf8')+'\nLivePreviewClient;');
const frame=()=>({ok:true,headers:{get:()=>JSON.stringify({width:8,height:6,sequence:1,capturedAtNs:100,instanceId:'fake',bytes:24})},blob:async()=>({type:'image/png',size:24})});
test('只发只读抓图请求，直接展示当前实例二进制帧',async()=>{
  let shown=0;
  const client=new Client(async(url,options)=>{assert.equal(url,'/api/preview/live');assert.equal(options.headers['X-Lab'],'1');return frame();},()=>shown++,()=>{},()=> 'fake');
  assert.equal(await client.capture(),true);
  assert.equal(shown,1);
});
test('同一客户端只允许一条在途请求；暂停后丢弃旧帧',async()=>{
  let release, shown=0, requests=0;
  const client=new Client(()=>{requests++;return new Promise(r=>release=r);},()=>shown++,()=>{},()=> 'fake');
  const pending=client.capture();
  assert.equal(await client.capture(),false);
  client.setEnabled(false);
  release(frame());
  await pending;
  assert.equal(shown,0);
  assert.equal(requests,1);
});
test('换实例不会显示旧窗口；隐藏页面的失效调用也不会显示旧帧',async()=>{
  let shown=0;
  const client=new Client(async()=>frame(),()=>shown++,()=>{},()=> 'new-instance');
  await client.capture();
  assert.equal(shown,0);
});
test('限频/未渲染只是等待，归属或租约失败暂停，手动重试可恢复',async()=>{
  let code='preview-rate-limited',status;
  const client=new Client(async()=>({ok:false,json:async()=>({error:{code}})}),()=>{},s=>status=s,()=> 'fake');
  await client.capture(); assert.equal(client.suspended,false);
  code='preview-unrendered'; await client.capture(); assert.equal(client.suspended,false);
  code='hidden-desktop-lease-expired'; await client.capture(); assert.equal(client.suspended,true);
  assert.match(status,/暂停/);
  client.request=async()=>frame();
  assert.equal(await client.capture(),false);
  assert.equal(await client.capture(true),true);
});
test('超大或不匹配的帧不进入页面，也不生成自动输入',async()=>{
  let shown=0;
  const bad=frame();bad.blob=async()=>({type:'image/png',size:4194305});
  const client=new Client(async()=>bad,()=>shown++,()=>{},()=> 'fake');
  await client.capture();assert.equal(shown,0);assert.equal(client.suspended,true);
});
test('暂停开关禁止自动请求，手动刷新只取一帧且不重新开启',async()=>{
  let requests=0;
  const client=new Client(async()=>{requests++;return frame();},()=>{},()=>{},()=> 'fake');
  client.setEnabled(false);
  assert.equal(await client.capture(),false);
  assert.equal(requests,0);
  assert.equal(await client.capture(true),true);
  assert.equal(requests,1);
  assert.equal(client.enabled,false);
});
