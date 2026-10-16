// 页面只提交 JSON 能力/流程 ID 和输入，所有应用动作由共用执行器解释。
'use strict';
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let registry = null, state = null, running = false, job = null, objectUrl = null, frameSession = null;
let profile = 'default';
const records = [];
let roundStart = 0;
const explainError = error => /learning-required|invalid-learning-json|capability-definition-changed/.test(error.message)
  ? '需要重新学习：已学参数缺失、目标失效或能力定义已变化。'+error.message : error.message;
async function request(path, body) {
  if(path.startsWith('/api/') && path!=='/api/workflows')path+=(path.includes('?')?'&':'?')+'profile='+encodeURIComponent(profile);
  const response = await fetch(path, body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-Lab':'1'},body:JSON.stringify(body)});
  const result = await response.json();
  if (!result.ok) throw new Error(result.error?.detail || result.error?.code || result.message || '请求失败');
  return result;
}
function inputs() {
  return Object.fromEntries(Object.keys(registry?.workflow.parameters || {}).map(key=>[key,$('parameter-'+key).value.trim()]));
}
function resolve(value, params) {
  if (typeof value === 'string') return value;
  if (value.input) return params[value.input];
  return value.join.map(item => resolve(item,params)).join(value.separator);
}
function stepInputs(step) { const params=inputs();return Object.fromEntries(Object.entries(step.inputs).map(([key,value])=>[key,resolve(value,params)])); }
function preconditionReason(contract,args) {
  const required=contract.preconditions;
  if(required.ownedApplication && !state?.facts.ownedAppRunning)return '请先启动当前自有应用实例。';
  if(required.boundTargets.length && !state?.learned.bound)return '请先调用绑定目标能力：'+required.boundTargets.join('、');
  const verified=required.verifiedInput;
  if(required.absentStates?.some(key=>Object.hasOwn(state?.learned.values || {},key)))return '本轮已执行过此动作；可继续后续步骤，或清除临时证据开始新一轮。';
  if(verified && state?.learned.values?.[verified.state]!==args[verified.parameter])return '请先填写并独立核验本次输入。';
  return '';
}
function controls() {
  const resetNeeded = state?.learned.requiresReset;
  const expired = state?.facts.hiddenDesktopOpen && !state.facts.leaseActive;
  $('run-workflow').disabled = running || !registry || !state || resetNeeded || expired;
  $('learn-paths').disabled = running || !registry || !state || resetNeeded || expired;
  document.querySelectorAll('[data-run-step]').forEach(button=>{
    const step=registry.workflow.steps.find(s=>s.id===button.dataset.runStep);
    const contract=registry.contracts.find(c=>c.id===step.capability);
    const reason=preconditionReason(contract,stepInputs(step));
    button.disabled=running || !state || resetNeeded || expired || !!reason;
    button.closest('article').querySelector('[data-precondition]').textContent=reason;
  });
  document.querySelectorAll('[data-workflow-parameter]').forEach(input=>{input.disabled=running;});
  for (const id of ['reset','renew','export']) $(id).disabled=running;
}
function renderJob() {
  if (!job) return;
  if(job.status==='done' && job.action.startsWith('learn-workflow:'))
    $('verification').textContent='当前输入的定位参数已学习并验证，已保存为 JSON，可手动回放。';
  else if(job.status==='done' && job.action.startsWith('workflow:'))
    $('verification').textContent=job.verification.evidence;
  for (const step of registry.workflow.steps) {
    const previous=[...records.slice(roundStart),job].findLast(record=>record.action==='capability:'+step.capability
      || record.workflow?.steps.some(item=>item.id===step.id && item.status!=='pending'));
    const row=previous?.workflow?.steps.find(s=>s.id===step.id);
    const own=previous?.action==='capability:'+step.capability;
    const status=row?.status || (own ? previous.status==='running'?'running':previous.status==='done'?'done':previous.status==='waiting'?'waiting':'failed' : 'pending');
    const card=document.querySelector(`[data-step="${step.id}"]`);
    card.dataset.status=status;
    card.querySelector('[data-verdict]').textContent=({pending:'未执行',running:'执行中',done:'调用完成',waiting:'等待结果／可只读刷新',failed:'失败／已停止'})[status] || status;
    card.querySelector('[data-verdict]').className='badge '+status;
    const duration=card.querySelector('[data-duration]');
    const timed=row?.startedAt ? row : own ? previous : null;
    if(duration)duration.textContent=timed ? `本步 ${Math.max(0,(timed.finishedAt || Date.now()/1000)-timed.startedAt).toFixed(2)} 秒` : '';
    const output=row?.output || (own?previous.output:null);
    card.querySelector('[data-output]').textContent=output ? JSON.stringify(output,null,2) : row?.error || '';
    const choice=previous?.calls.find(call=>call.result?.selectionPolicy==='first-visible-match'
      && (call.workflowStep===step.id || own));
    card.querySelector('[data-selection]').textContent=choice
      ? `找到 ${choice.result.candidateCountAtBinding ?? choice.result.candidateCount} 个匹配项；按显示顺序选择首个匹配项。` : '';
  }
  const answer=job.output?.answer;
  $('answer-panel').hidden=!answer;
  $('answer').textContent=answer?.text || '';
  $('answer-verification').textContent=answer?.verification || '';
  $('trace-title').textContent=`调用能力、参数与验证结果（${job.calls.length} 次）`;
  $('trace').textContent=JSON.stringify(job,null,2);
  progress();
}
function renderInputs() {
  if(!registry)return;
  for(const step of registry.workflow.steps){
    document.querySelector(`[data-step="${step.id}"] [data-inputs]`).textContent=JSON.stringify(stepInputs(step),null,2);
  }
  controls();
}
function progress() {
  if (!job) return;
  const pending=job.calls.findLast(call=>call.status==='执行中');
  const target=pending?.arguments?.match?.name || pending?.arguments?.match?.autoId || pending?.arguments?.purpose || '';
  $('current').textContent=pending ? `当前子调用：${pending.capability}${target?' · '+target:''} · 已等待 ${Math.max(0,Date.now()/1000-pending.startedAt).toFixed(1)} 秒` : running?'等待执行器返回…':'';
  $('elapsed').textContent=`本次耗时 ${Math.max(0,(job.finishedAt || Date.now()/1000)-job.startedAt).toFixed(1)} 秒`;
}
async function run(action, params) {
  if (running) return;
  if(action==='reset' || action.startsWith('workflow:') || action.startsWith('learn-workflow:'))roundStart=records.length;
  running=true;job=null;controls();$('result').className='';$('result').textContent='执行中…';
  try {
    const start=await request('/api/learned/start',{action,inputs:params});
    await watch(start.jobId);
    records.push(job);
    $('result').textContent=job.verification.evidence;
    $('result').className=job.status==='failed'?'error':'';
  } catch(error) {
    $('result').textContent=`${explainError(error)}。请核对现场；请求未重发。`;
    $('result').className='error';
  } finally {running=false;controls();}
}
async function watch(jobId) {
  for(;;){
    const result=await request('/api/learned/status?id='+encodeURIComponent(jobId));
    job=result.job;if(result.state)updateState(result.state);renderJob();
    if(job.status!=='running')return;
    await new Promise(resolve=>setTimeout(resolve,400));
  }
}
function updateState(next) {
  state=next;
  if(frameSession!==next.previewSession){
    preview.invalidate();frameSession=next.previewSession;
    if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;
    $('frame').hidden=true;$('frame').removeAttribute('src');$('empty-frame').hidden=false;
  }
  const f=next.facts;
  $('environment').textContent=!f.hiddenDesktopOpen?'尚未启动实验实例，回放将从启动开始。':!f.leaseActive?'实验租约已到期，请显式续租。':`自有隐藏桌面 · ${f.ownedAppRunning?'应用已启动':'等待启动应用'} · 动作 ${next.actions.used}/${next.actions.max}`;
  $('renew').hidden=!f.hiddenDesktopOpen || f.leaseActive;
  controls();
}
const preview=new LivePreviewClient((path,options)=>fetch(path,options), async(info,blob)=>{
  const url=URL.createObjectURL(blob);if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=url;
  $('frame').src=url;$('frame').hidden=false;$('empty-frame').hidden=true;
  $('frame-meta').textContent=`${info.width}×${info.height} · ${info.capturedAt}`;
},text=>{$('frame-status').textContent=text;},()=>frameSession);
async function refreshState() {
  if(!running){try{updateState((await request('/api/state')).state);}catch(error){$('environment').textContent=error.message;}}
}
async function tickFrame() {
  if(document.visibilityState==='visible' && state?.facts.targetWindowResolved && state.facts.leaseActive && preview.enabled)await preview.capture();
  setTimeout(tickFrame,1000);
}
async function init() {
  try {
    const pages=(await request('/api/workflows')).pages;
    profile=pages[location.pathname] || 'default';
    const data=await request('/api/composition');registry=data.registry;
    $('workflow-title').textContent=registry.workflow.title;
    $('workflow-name').textContent=registry.workflow.title;
    document.title=registry.workflow.title;
    const layout=registry.capabilities[0].environment?.size;
    $('layout-description').textContent=(layout?`物理窗口 ${layout.width}×${layout.height} · `:'')+(registry.workflow.description || '');
    $('learn-paths').hidden=registry.executionModel==='capability-steps';
    $('run-workflow').textContent=registry.workflow.runLabel || '回放完整流程';
    for(const [key,spec] of Object.entries(registry.workflow.parameters)){
      const label=document.createElement('label');label.className='field';label.textContent=spec.label || key;
      const input=document.createElement('input');input.id='parameter-'+key;input.dataset.workflowParameter=key;
      input.maxLength=spec.maxLength;input.required=spec.required!==false;input.autocomplete='off';input.value=spec.default || '';
      input.addEventListener('input',renderInputs);label.append(input);$('workflow-parameters').append(label);
    }
    $('verification').textContent=registry.workflow.verification?.status==='packaged-pending-replay'
      ? registry.workflow.verification.scope : '定位参数与执行规则已加载；最近运行及验证结果见下方记录。';
    $('workflow-json').textContent=JSON.stringify(registry.workflow,null,2);
    $('count').textContent=registry.capabilities.length+' 项 · 分别保存';
    $('steps').innerHTML=registry.workflow.steps.map((step,i)=>{
      const cap=registry.contracts.find(c=>c.id===step.capability);
      return `<article class="panel step" data-step="${escapeHtml(step.id)}" data-status="pending"><span class="tag">独立子能力</span> <span class="badge" data-verdict>未执行</span><span class="muted" data-duration></span><h3 style="margin-top:8px">${i+1}. ${escapeHtml(cap.title)}</h3><code>${escapeHtml(cap.id)}</code><p class="muted">${escapeHtml(cap.description)}</p><p class="muted">${cap.recordedVerification?.status==='recorded'?'沿用历史验证记录；本轮结果由实际执行独立核验。':'已记录执行规则，待真实应用验证。'}</p><p class="muted" data-precondition></p><p class="muted" data-selection></p><button type="button" data-run-step="${escapeHtml(step.id)}">仅调用此子能力</button><details><summary>能力契约 JSON、参数及核验</summary><p class="muted">本次输入</p><pre data-inputs></pre><pre>${escapeHtml(JSON.stringify(cap,null,2))}</pre><pre data-output></pre></details></article>`;
    }).join('');
    renderInputs();await refreshState();controls();
    const latest=await request('/api/learned/latest');
    if(latest.job){
      job=latest.job;renderJob();
      if(job.status==='running'){
        running=true;controls();
        try{await watch(job.id);}finally{running=false;controls();}
      }
      records.push(job);$('result').textContent='最近调用：'+job.verification.evidence;
      $('result').className=job.status==='failed'?'error':'';controls();
    }
  } catch(error){$('verification').textContent=explainError(error);$('verification').className='error';}
}
$('run-workflow').addEventListener('click',()=>run('workflow:'+registry.workflow.id,inputs()));
$('learn-paths').addEventListener('click',()=>run('learn-workflow:'+registry.workflow.id,inputs()));
$('steps').addEventListener('click',event=>{const button=event.target.closest('[data-run-step]');if(!button)return;const step=registry.workflow.steps.find(s=>s.id===button.dataset.runStep);run('capability:'+step.capability,stepInputs(step));});
$('reset').addEventListener('click',()=>run('reset',{}));
$('renew').addEventListener('click',async()=>{try{const result=await request('/api/invoke',{id:'control.lease.renew',arguments:{seconds:900}});preview.resume();updateState(result.state);}catch(error){$('result').textContent=error.message;}});
$('live').addEventListener('change',event=>preview.setEnabled(event.target.checked));
$('refresh-frame').addEventListener('click',()=>preview.capture(true));
$('export').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({workflow:registry?.workflow,records},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=(registry?.workflow.id || 'workflow')+'-runs.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
document.addEventListener('visibilitychange',()=>preview.invalidate());
setInterval(progress,100);setInterval(refreshState,1500);setTimeout(tickFrame,1000);init();
