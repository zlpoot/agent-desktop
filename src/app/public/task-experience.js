// Shared by Task drafts and fixed-version Workflow execution. Values carry both identity dimensions.
window.createDesktopSelection = function (select, includeBrowser, changed) {
  let environments = [], loaded = false, error = '';
  const key = item => JSON.stringify([item.providerId, item.environmentId]);
  const option = (value, label, disabled = false) => {
    const node = [...select.options].find(item => item.value === value) || document.createElement('option');
    node.value = value; node.textContent = label; node.disabled = disabled;
    if (!node.parentElement) select.append(node);
  };
  if (includeBrowser) option('browser', '浏览器');
  else option('', '请选择执行桌面');
  const ready = fetch('/api/desktop/environments').then(async response => {
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.environments)) throw new Error('无法读取桌面选择');
    const keys = new Set();
    for (const item of data.environments) {
      if (!item || typeof item.providerId !== 'string' || !item.providerId.trim() ||
          typeof item.environmentId !== 'string' || !item.environmentId.trim() ||
          typeof item.executable !== 'boolean' || keys.has(key(item))) throw new Error('桌面选择数据无效');
      keys.add(key(item));
    }
    environments = data.environments; loaded = true;
    const labels = { physical: '本机桌面', 'virtual-machine': '虚拟机', 'local-workspace': 'Local Workspace' };
    for (const item of environments) option(key(item), `${labels[item.kind] || item.kind} · ${item.providerId} / ${item.environmentId}${!item.executable ? item.kind === 'local-workspace' ? '（仅支持有限场景）' : '（暂不支持此任务）' : ''}`, !item.executable);
  }).catch(failure => { error = failure.message; option('unavailable', '桌面列表读取失败，请刷新', true); }).finally(changed);
  return {
    ready,
    restore(value) {
      if (![...select.options].some(item => item.value === value)) option(value, '此前选择的桌面不可用，请重新选择', true);
      select.value = value; changed();
    },
    selected: () => environments.find(item => key(item) === select.value),
    problem() {
      if (includeBrowser && select.value === 'browser') return '';
      if (!loaded) return error || '正在读取执行桌面';
      const item = this.selected();
      if (!item) return '请选择可用的执行桌面';
      if (!item.executable) return item.kind === 'local-workspace'
        ? 'Local Workspace 仅支持有限的已验证场景，暂不支持通用任务或 Workflow。'
        : item.blockedReason === 'physical-task-policy-required' ? '本机桌面尚未配置输入策略。' : '该桌面没有可用的任务执行器。';
      return '';
    },
    payload() {
      const problem = this.problem(); if (problem) throw new Error(problem);
      const item = this.selected();
      return item ? { destination: 'desktop', desktopTarget: { providerId: item.providerId, environmentId: item.environmentId } }
        : { destination: 'browser' };
    },
  };
};

window.createTaskExperience = function () {
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls = '') => { const e = document.createElement(tag); e.textContent = text; e.className = cls; return e; };
  const form = $('task-form');
  const targetLabel = el('label', '执行位置');
  const target = el('select', ''); target.id = 'task-destination';
  targetLabel.append(target); form.prepend(targetLabel);
  const readiness = el('section', '', 'readiness-card'); readiness.setAttribute('role', 'status');
  const heading = el('h3', '正在检查执行环境'); const hint = el('p', ''); readiness.append(heading, hint);
  form.before(readiness);
  $('task-goal').maxLength = 2000;
  const advanced = el('details', '', 'task-options'); advanced.append(el('summary', '完成条件、操作限制与单次预算（可选）'));
  const fields = { goal: $('task-goal'), destination: target };
  for (const [name, label] of [['criteria', '完成条件'], ['constraints', '操作限制']]) {
    const wrapper = el('label', label); const input = el('textarea', ''); input.rows = 2; input.maxLength = 500;
    input.id = `task-${name}`; wrapper.append(input); advanced.append(wrapper); fields[name] = input;
  }
  advanced.append(el('p', '模型预算留空时使用设置页的全局值；仅对本次任务生效。'));
  for (const [name, label] of [['deepseekCalls', 'DeepSeek 最多调用次数'], ['deepseekTokens', 'DeepSeek 最多 Token'],
    ['jevCalls', 'JEV 最多调用次数'], ['jevTokens', 'JEV 最多 Token']]) {
    const wrapper = el('label', label); const input = el('input', '');
    input.type = 'number'; input.min = '1'; input.max = '1000000'; input.step = '1'; input.placeholder = '使用全局值';
    input.id = `task-${name}`; wrapper.append(input); advanced.append(wrapper); fields[name] = input;
  }
  form.append(advanced);
  const attention = el('section', '', 'attention-list panel'); attention.append(el('h3', '待处理'));
  attention.hidden = true;
  const attentionItems = el('div', ''); attention.append(attentionItems);
  document.querySelector('.home-recent').before(attention);
  const requestBox = el('section', '', 'request-card');
  const requestTitle = el('h3', ''); const requestNext = el('p', '');
  const reason = el('p', '', 'task-issue');
  requestBox.append(requestTitle, reason, requestNext, $('resume-controls'), $('task-controls'));
  document.querySelector('.hero').prepend(requestBox);
  const original = el('details', '', 'original-goal'); original.append(el('summary', '查看完整任务要求'));
  const originalText = el('p', ''); original.append(originalText); $('goal').parentElement.after(original);
  const resultTitle = el('h3', '执行结果'); $('summary').before(resultTitle);
  const retry = el('button', '以此任务新建草稿'); retry.type = 'button'; document.querySelector('.hero').append(retry);
  const recorded = $('task-recorded');
  const evidenceTitle = el('h2', '最近记录的画面');
  const evidenceCaption = el('p', '');
  const evidenceImage = el('img', ''); evidenceImage.alt = '任务历史截图，仅供查看';
  const missingEvidence = el('p', '');
  const evidenceLink = el('a', '下载此截图'); evidenceLink.download = 'task-evidence.png';
  recorded.append(evidenceTitle, evidenceCaption, evidenceImage, missingEvidence, evidenceLink);
  let evidenceUrl = '';
  evidenceImage.onerror = () => { evidenceImage.hidden = true; evidenceLink.hidden = true; missingEvidence.hidden = false; missingEvidence.textContent = '截图文件不可读取，请查看执行记录中的文字证据。'; };
  let busy = false, currentRun = null, budgetReady = false;
  const storageKey = 'agent-desktop.task-draft.v2';
  let draftDestination;
  try {
    const draft = JSON.parse(sessionStorage.getItem(storageKey) || sessionStorage.getItem('agent-desktop.task-draft.v1') || 'null');
    if (draft) {
      for (const [key, field] of Object.entries(fields)) if (key !== 'destination' && typeof draft[key] === 'string') field.value = draft[key];
      draftDestination = draft.destination;
    }
  } catch {}
  const selection = window.createDesktopSelection(target, true, update);
  if (typeof draftDestination === 'string') selection.restore(draftDestination);
  function save() { try { sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])))); } catch {} }
  function update() {
    const problem = selection.problem();
    const blocked = !!problem;
    $('task-submit').disabled = busy || !!blocked || !budgetReady;
    heading.textContent = problem ? '执行桌面不可用' : !budgetReady ? '任务预算服务未就绪' : `执行位置：${target.selectedOptions[0]?.textContent || ''}`;
    hint.textContent = problem || (!budgetReady ? '任务预算服务暂不可用。' : target.value === 'browser' ? '在浏览器中执行任务。' : '执行时检查所选桌面的连接、窗口、权限与输入租约；已占用或未就绪时拒绝执行。');
  }
  fetch('/api/settings/task-budget').then(response => response.ok ? response.json() : Promise.reject(new Error('预算服务不可用')))
    .then(result => { budgetReady = !!result.budget; update(); }).catch(() => { budgetReady = false; update(); });
  form.addEventListener('input', () => { save(); update(); });
  target.addEventListener('change', () => { save(); update(); });
  retry.onclick = () => {
    if (!currentRun) return;
    fields.goal.value = currentRun.goal;
    selection.restore(currentRun.desktopTarget ? JSON.stringify([currentRun.desktopTarget.providerId, currentRun.desktopTarget.environmentId]) : currentRun.desktopTargetRequired ? 'legacy-desktop-target-required' : 'browser');
    fields.criteria.value = ''; fields.constraints.value = ''; save();
    window.Workbench.navigate('live'); update(); fields.goal.focus();
  };
  return {
    control() { update(); },
    submitting(value) { busy = value; update(); },
    payload() {
      update(); if ($('task-submit').disabled && !busy) throw new Error(hint.textContent);
      const budget = {};
      for (const [kind, names] of Object.entries({ deepseek: ['deepseekCalls', 'deepseekTokens'], jev: ['jevCalls', 'jevTokens'] })) {
        const entries = names.map((name, index) => [index ? 'maxTokens' : 'maxCalls', fields[name].value.trim()])
          .filter(([, value]) => value);
        if (entries.length) {
          for (const [, value] of entries) if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000000) throw new Error('模型预算必须是 1 到 1000000 的整数');
          budget[kind] = Object.fromEntries(entries.map(([key, value]) => [key, Number(value)]));
        }
      }
      return { ...selection.payload(), criteria: fields.criteria.value.trim(), constraints: fields.constraints.value.trim(),
        ...(Object.keys(budget).length ? { budget } : {}) };
    },
    submitted() { fields.goal.value = ''; fields.criteria.value = ''; fields.constraints.value = '';
      for (const name of ['deepseekCalls', 'deepseekTokens', 'jevCalls', 'jevTokens']) fields[name].value = '';
      save(); },
    runs(runs) {
      attentionItems.replaceChildren(); const pending = runs.filter(run => ['paused', 'waiting_user'].includes(run.status));
      attention.hidden = !pending.length;
      attention.querySelector('h3').textContent = `待处理 · ${pending.length}`;
      for (const run of pending.slice(0, 5)) {
        const button = el('button', `${run.status === 'paused' ? '已暂停' : '等待确认'} · ${run.goal.replace(/^VM:\s*/i, '').slice(0, 45)}`);
        button.type = 'button'; button.onclick = () => document.dispatchEvent(new CustomEvent('workbench:open-run', { detail: `${run.source}/${run.taskId}` })); attentionItems.append(button);
      }
      if (pending.length > 5) attentionItems.append(el('p', '更多事项请到任务记录筛选“待处理”。'));
    },
    detail(run) {
      if (currentRun?.taskId !== run.taskId || currentRun?.source !== run.source) $('resume-answer').value = '';
      currentRun = run;
      const shot = [...(run.steps || [])].reverse().find(step => step.hasScreenshot);
      const url = shot ? `/api/screenshots/${encodeURIComponent(run.source)}/${encodeURIComponent(run.taskId)}/${shot.step}` : '';
      if (url !== evidenceUrl) {
        evidenceUrl = url; evidenceImage.hidden = !url; evidenceLink.hidden = !url; missingEvidence.hidden = !!url;
        if (url) { evidenceImage.src = url; evidenceLink.href = url; } else { evidenceImage.removeAttribute('src'); evidenceLink.removeAttribute('href'); }
      }
      if (!url) { evidenceImage.hidden = true; evidenceLink.hidden = true; missingEvidence.hidden = false; missingEvidence.textContent = '此任务尚无已记录截图。'; }
      evidenceCaption.textContent = shot ? `第 ${shot.step} 步 · ${shot.screenshotTime ? new Date(shot.screenshotTime).toLocaleString('zh-CN') : '时间未记录'} · ${shot.screenshotScope === "desktop" ? "完整桌面" : shot.screenshotScope === "window" ? "窗口截图，未包含桌面" : "页面截图"} · 历史画面，不代表当前桌面${shot.desktopCaptureError ? " · 完整桌面采集失败" : ""}` : '不会用其他任务的实时画面替代证据。';
      const text = run.goal.replace(/^VM:\s*/i, ''); $('goal').textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      originalText.textContent = run.goal; original.hidden = text.length <= 60;
      const waiting = run.status === 'waiting_user'; const paused = ['paused', 'pause_requested'].includes(run.status);
      requestBox.hidden = !waiting && !paused && run.status !== 'failed' && run.status !== 'stopped' && !(run.canPause && run.status === 'running');
      reason.textContent = run.error || run.summary || '尚未记录具体原因，请查看执行过程。';
      reason.hidden = run.status === 'running';
      requestTitle.textContent = waiting ? ({ question: '需要补充信息', final_review: '请确认最终结果', approval: '需要批准下一步动作' }[run.interactionKind] || '需要你处理') : '任务已暂停或正在暂停';
      requestNext.textContent = waiting ? run.interactionKind === 'final_review' ? '核对下方结果与截图后，再确认完成；未满足目标请选择“尚未完成”。' : run.interactionKind === 'question' ? '提交回答后任务继续处理。' : '查看动作说明后决定是否允许。' : run.recoveryRequired ? '任务现场已保留。先确认环境就绪，继续时会重新观察，再判断下一步。' : '核对原因及现场后继续，或在桌面页接管处理。';
      if (run.status === 'failed' || run.status === 'stopped') { requestTitle.textContent = run.status === 'failed' ? '任务未完成' : '任务已停止'; requestNext.textContent = '查看原因和历史证据，可用下方“新建草稿”修改要求后重新提交。'; }
      if (run.status === 'running') { requestTitle.textContent = '任务正在执行'; requestNext.textContent = '需要介入时可请求暂停，等待当前动作到达安全边界。'; }
      resultTitle.textContent = run.status === 'done' ? '完成结果' : run.status === 'failed' ? '未完成 · 原因' : '当前进展';
    },
  };
};
