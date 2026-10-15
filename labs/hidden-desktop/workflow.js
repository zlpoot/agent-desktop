// 页面只提交 JSON 能力/流程 ID 和输入，所有应用动作由共用执行器解释。
'use strict';
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let registry = null, state = null, running = false, job = null, objectUrl = null, frameSession = null;
const records = [];
const explainError = error => /learning-required|invalid-learning-json|capability-definition-changed/.test(error.message)
  ? '需要重新学习：已学参数缺失、目标失效或能力定义已变化。'+error.message : error.message;
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-Lab':'1'},body:JSON.stringify(body)});
  const result = await response.json();
  if (!result.ok) throw new Error(result.error?.detail || result.error?.code || result.message || '请求失败');
  return result;
}
function inputs() { return {song:$('song').value.trim(),artist:$('artist').value.trim()}; }
function resolve(value, params) {
  if (typeof value === 'string') return value;
  if (value.input) return params[value.input];
  return value.join.map(item => resolve(item,params)).join(value.separator);
}
function stepInputs(step) { const params=inputs();return Object.fromEntries(Object.entries(step.inputs).map(([key,value])=>[key,resolve(value,params)])); }
function controls() {
  const resetNeeded = state?.learned.requiresReset;
  const expired = state?.facts.hiddenDesktopOpen && !state.facts.leaseActive;
  $('run-workflow').disabled = running || !registry || !state || resetNeeded || expired;
  $('learn-paths').disabled = running || !registry || !state || resetNeeded || expired;
  document.querySelectorAll('[data-run-step]').forEach(button=>{button.disabled=running || !registry || !state || resetNeeded || expired;});
  for (const id of ['song','artist','reset','renew','export']) $(id).disabled=running;
}
function renderJob() {
  if (!job) return;
  if(job.status==='done' && job.action.startsWith('learn-workflow:'))
    $('verification').textContent='当前输入的定位参数已学习并验证，已保存为 JSON，可手动回放。';
  else if(job.status==='done' && job.action.startsWith('workflow:'))
    $('verification').textContent='当前输入已完成真实回放及播放状态核验，耗时和各项证据见下方调用记录。';
  const steps = job.workflow?.steps || [];
  for (const step of registry.workflow.steps) {
    const row=steps.find(s=>s.id===step.id);
    const own=job.action==='capability:'+step.capability;
    const status=row?.status || (own ? job.status==='running'?'running':job.status==='done'?'done':'failed' : 'pending');
    const card=document.querySelector(`[data-step="${step.id}"]`);
    card.dataset.status=status;
    card.querySelector('[data-verdict]').textContent=({pending:'未执行',running:'执行中',done:'调用完成',failed:'失败／已停止'})[status];
    card.querySelector('[data-verdict]').className='badge '+status;
    const duration=card.querySelector('[data-duration]');
    const timed=row?.startedAt ? row : own ? job : null;
    if(duration)duration.textContent=timed ? `本步 ${Math.max(0,(timed.finishedAt || Date.now()/1000)-timed.startedAt).toFixed(2)} 秒` : '';
    const output=row?.output || (own?job.output:null);
    card.querySelector('[data-output]').textContent=output ? JSON.stringify(output,null,2) : row?.error || '';
    const choice=job.calls.find(call=>call.result?.selectionPolicy==='first-visible-match'
      && (call.workflowStep===step.id || own));
    card.querySelector('[data-selection]').textContent=choice
      ? `找到 ${choice.result.candidateCountAtBinding ?? choice.result.candidateCount} 个歌名＋歌手匹配；按显示顺序选择首个匹配项。` : '';
  }
  $('trace-title').textContent=`调用能力、参数与验证结果（${job.calls.length} 次）`;
  $('trace').textContent=JSON.stringify(job,null,2);
  progress();
}
function renderInputs() {
  if(!registry)return;
  for(const step of registry.workflow.steps){
    document.querySelector(`[data-step="${step.id}"] [data-inputs]`).textContent=JSON.stringify(stepInputs(step),null,2);
  }
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
    const data=await request('/api/composition');registry=data.registry;
    for(const key of ['song','artist'])$(key).value=registry.workflow.parameters[key].default;
    $('verification').textContent='定位参数与执行规则已加载；最近运行及验证结果见下方记录。';
    $('workflow-json').textContent=JSON.stringify(registry.workflow,null,2);
    $('count').textContent=registry.capabilities.length+' 项 · 分别保存';
    $('steps').innerHTML=registry.workflow.steps.map((step,i)=>{
      const cap=registry.capabilities.find(c=>c.id===step.capability);
      return `<article class="panel step" data-step="${escapeHtml(step.id)}" data-status="pending"><span class="tag">独立子能力</span> <span class="badge" data-verdict>未执行</span><span class="muted" data-duration></span><h3 style="margin-top:8px">${i+1}. ${escapeHtml(cap.title)}</h3><code>${escapeHtml(cap.id)}</code><p class="muted">${escapeHtml(cap.operations[0].description)}</p><p class="muted">${cap.verification.status==='recorded'?'沿用已记录的参数和验证证据；参数化输入在运行时核验。':'已记录执行规则，待真实应用验证。'}</p><p class="muted" data-selection></p><button type="button" data-run-step="${escapeHtml(step.id)}">仅调用此子能力</button><details><summary>独立 JSON、参数及核验</summary><p class="muted">本次输入</p><pre data-inputs></pre><p class="muted">独立文件：${escapeHtml(cap.id)}.json</p><pre>${escapeHtml(JSON.stringify(cap,null,2))}</pre><pre data-output></pre></details></article>`;
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
for(const id of ['song','artist'])$(id).addEventListener('input',renderInputs);
$('steps').addEventListener('click',event=>{const button=event.target.closest('[data-run-step]');if(!button)return;const step=registry.workflow.steps.find(s=>s.id===button.dataset.runStep);run('capability:'+step.capability,stepInputs(step));});
$('reset').addEventListener('click',()=>run('reset',{}));
$('renew').addEventListener('click',async()=>{try{const result=await request('/api/invoke',{id:'control.lease.renew',arguments:{seconds:900}});preview.resume();updateState(result.state);}catch(error){$('result').textContent=error.message;}});
$('live').addEventListener('change',event=>preview.setEnabled(event.target.checked));
$('refresh-frame').addEventListener('click',()=>preview.capture(true));
$('export').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({workflow:registry?.workflow,records},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='cloudmusic-workflow-runs.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
document.addEventListener('visibilitychange',()=>preview.invalidate());
setInterval(progress,100);setInterval(refreshState,1500);setTimeout(tickFrame,1000);init();
