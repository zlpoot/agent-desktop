const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Client = vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../learned-skills.js'),'utf8') + '\nLearnedSkillClient;');
const definition = {id:'synthetic', operations:[{id:'synthetic.fill',title:'Fill'}]};
test('共用客户端只发送操作和参数，不在浏览器拼接 UIA 或应用动作', async () => {
  const calls=[];
  const client=new Client(async (url, body) => {
    calls.push({url,body});
    if(body) return {ok:true,jobId:'fake-job'};
    return {ok:true,job:{status:'done',calls:[{capability:'replay.value.read',status:'调用成功'}],
      output:{verifiedValue:'test'},verification:{status:'通过',evidence:'fresh value'}},
      state:{learned:{definition,bound:true,values:{verifiedQuery:'test'}}}};
  });
  client.sync({definition,learningRequired:false,values:{}});
  await client.runSkill('synthetic.fill',{term:'test'});
  assert.equal(calls.length,2);
  assert.equal(calls[0].body.action,'synthetic.fill');
  assert.equal(calls[0].body.inputs.term,'test');
  assert.equal(client.records[0].output.verifiedValue,'test');
  assert.equal(client.bound,true);
  assert.equal(client.progress(),null);
});
test('失去请求回执时不重发、不假装后台已取消', async () => {
  let attempts=0;
  const client=new Client(async () => {attempts++;throw new Error('network-lost');});
  client.sync({definition,values:{}});
  await client.runSkill('synthetic.fill');
  assert.equal(attempts,1);
  assert.equal(client.failed,true);
  assert.match(client.message,/不要重复/);
});
test('没有学习记录时允许显式学习，失败后允许清除绑定', async () => {
  const client=new Client(async (url,body) => body ? {ok:true,jobId:'j'} : {ok:true,job:{status:'done',calls:[],verification:{status:'通过',evidence:'learned'}}});
  client.sync({definition,learningRequired:true,values:{}});
  assert.match(client.message,/学习/);
  await client.runSkill('learn');
  client.stale=true;
  await client.reset();
  assert.equal(client.stale,false);
  assert.equal(client.records.length,2);
});

test('操作学习使用同一执行接口，保留学习与回放的不同记录', async () => {
  const actions=[];
  const client=new Client(async (url,body) => {
    if(body){actions.push(body.action);return {ok:true,jobId:'j'};}
    return {ok:true,job:{status:'done',calls:[],verification:{status:'通过',evidence:'verified'}}};
  });
  client.sync({definition,values:{}});
  await client.runSkill('learn:synthetic.fill');
  await client.runSkill('synthetic.fill');
  assert.deepEqual(actions,['learn:synthetic.fill','synthetic.fill']);
  assert.match(client.records[0].title,/学习并验证/);
  assert.equal(client.records[1].skill,'synthetic.fill');
});
