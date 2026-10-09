// Shared by Task drafts and fixed-version Workflow execution. Values carry both identity dimensions.
window.createDesktopSelection = function (select, includeBrowser, changed, allowScenarios = false, explicitSelection = false) {
  let environments = [], loaded = false, error = '', fixtureOnly = false;
  const key = item => JSON.stringify([item.providerId, item.environmentId]);
  const option = (value, label, disabled = false) => {
    const node = [...select.options].find(item => item.value === value) || document.createElement('option');
    node.value = value; node.textContent = label; node.disabled = disabled;
    if (!node.parentElement) select.append(node);
  };
  if (includeBrowser) { if (explicitSelection) option('', '请选择执行环境'); option('browser', '浏览器'); }
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
      if (item.scenarios !== undefined) {
        const ids = new Set();
        if (!Array.isArray(item.scenarios)) throw new Error('场景选择数据无效');
        for (const scene of item.scenarios) {
          if (!scene || typeof scene.id !== 'string' || !scene.id.trim() || ids.has(scene.id) ||
              typeof scene.label !== 'string' || !scene.label.trim() ||
              !['supported', 'unavailable', 'unsupported', 'not-proven'].includes(scene.availability)) throw new Error('场景选择数据无效');
          ids.add(scene.id);
        }
      }
    }
    environments = data.environments; loaded = true;
    fixtureOnly = data.mode === 'synthetic-fixture';
    if (fixtureOnly) {
      const wasBrowser = select.value === 'browser';
      select.querySelector('option[value="browser"]')?.remove();
      option('', '请选择合成执行环境');
      if (wasBrowser) select.value = '';
    }
    const labels = { physical: '本机桌面', 'virtual-machine': '虚拟机', 'local-workspace': 'Local Workspace' };
    for (const item of environments) option(key(item), `${item.environmentId === 'local-workspace:chrome' ? 'Hidden Workspace Chrome' : labels[item.kind] || item.kind} · ${item.providerId} / ${item.environmentId}${!item.executable ? item.scenarios?.length ? '（仅支持有限场景）' : '（暂不支持此任务）' : ''}`, !item.executable && !(allowScenarios && item.scenarios?.length));
  }).catch(failure => { error = failure.message; option('unavailable', '桌面列表读取失败，请刷新', true); }).finally(changed);
  return {
    ready,
    restore(value) {
      if (![...select.options].some(item => item.value === value)) option(value, '此前选择的桌面不可用，请重新选择', true);
      select.value = value; changed();
    },
    selected: () => environments.find(item => key(item) === select.value),
    synthetic: () => fixtureOnly,
    problem(scenarioId) {
      if (includeBrowser && select.value === 'browser' && !fixtureOnly) return '';
      if (!loaded) return error || '正在读取执行桌面';
      const item = this.selected();
      if (!item) return '请选择可用的执行环境';
      if (allowScenarios && scenarioId) {
        const scene = item.scenarios?.find(scene => scene.id === scenarioId);
        return scene?.availability === 'supported' ? '' : '此前选择的场景不可用，请重新选择。';
      }
      if (allowScenarios && !item.executable && item.scenarios?.length) return '请选择一个已支持的固定场景；不会自动选择。';
      if (!item.executable) return item.kind === 'local-workspace'
        ? 'Local Workspace 仅支持有限的已验证场景，暂不支持通用任务或 Workflow。'
        : item.blockedReason === 'physical-task-policy-required' ? '本机桌面尚未配置输入策略。'
        : item.blockedReason === 'physical-task-capability-not-proven' ? '本机桌面通用执行能力尚未完成范围化验证。'
        : '该桌面没有可用的任务执行器。';
      return '';
    },
    payload(scenarioId) {
      const problem = this.problem(scenarioId); if (problem) throw new Error(problem);
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
  function clearAdmissionMessage() {
    if ($('task-message').dataset.state === 'admission') { $('task-message').textContent = ''; delete $('task-message').dataset.state; }
  }
  document.querySelector('.composer-intro h2').textContent = '告诉 Agent 想完成什么';
  document.querySelector('.composer-intro p').textContent = '任务、规则计划与工作流共用已有执行记录。权限与结果以后台检查为准。';
  $('task-goal').placeholder = '例如：整理当前文档，并说明希望得到的结果…';
  const targetLabel = el('label', '执行环境');
  const target = el('select', ''); target.id = 'task-destination';
  targetLabel.append(target); form.prepend(targetLabel);
  const scenarioLabel = el('label', '执行计划 / 已支持的固定场景');
  const scenario = el('select', ''); scenario.id = 'task-scenario'; scenarioLabel.append(scenario); targetLabel.after(scenarioLabel);
  scenarioLabel.hidden = true;
  const choices = el('div', '', 'composer-choices'); choices.append(targetLabel, scenarioLabel);
  const modes = [['stable','稳定','通过已验证工作流运行；工作台尚未接通稳定模式，请从工作流页核对版本与执行资格。'],
    ['autonomous','自主','沿用通用任务入口。模型配置、目标连接、权限和预算仍由后端执行前检查；可提交不代表已就绪。'],
    ['learning','学习','待启用：尚无专用学习执行适配，不用自主任务冒充学习模式。'],
    ['optimize','优化','待实现：尚无版本优化执行适配；可在工作流页查看已有版本与证据。']];
  const modeField = el('input', ''); modeField.type = 'hidden'; modeField.id = 'task-mode'; modeField.value = 'autonomous';
  const modeSelector = el('fieldset', '', 'mode-selector'); modeSelector.append(el('legend', '运行模式'));
  const modeOptions = el('div', '', 'mode-options');
  const modeDescription = el('p', '', 'mode-description'); modeDescription.id = 'task-mode-description'; modeDescription.setAttribute('role', 'status');
  const radios = [];
  for (const [value, label] of modes) {
    const wrapper = el('label', ''); const radio = el('input', ''); radio.type = 'radio'; radio.name = 'task-mode-choice';radio.value = value;
    radio.setAttribute('aria-label', label); radio.setAttribute('aria-describedby','task-mode-description');
    const caption = el('span', label);
    caption.append(el('small', ({stable:'需工作流入口', autonomous:'后台预检', learning:'待启用', optimize:'待实现'})[value]));
    wrapper.append(radio, caption); modeOptions.append(wrapper);radios.push(radio);
    radio.onchange = () => {clearAdmissionMessage();modeField.value = value;save();update();};
  }
  modeSelector.append(modeField, modeOptions, modeDescription);
  form.querySelector('.task-composer').after(modeSelector, choices);
  const appLabel = el('label', '应用（可选）'); const app = el('select', ''); app.disabled = true;
  app.id = 'task-application'; app.setAttribute('aria-label', '应用（可选）');
  app.append(el('option', '从任务目标发现并确认；工作台暂不支持手动绑定'));appLabel.append(app);choices.append(appLabel);
  app.title = '任务中的应用发现与确认复用后台接入流程；这里不生成绑定或启动应用。';
  const readiness = el('section', '', 'readiness-card'); readiness.setAttribute('role', 'status');
  const heading = el('h3', '正在检查执行环境'); const hint = el('p', ''); readiness.append(heading, hint);
  form.before(readiness);
  $('task-goal').maxLength = 2000;
  const advanced = el('details', '', 'task-options'); advanced.append(el('summary', '完成条件、操作限制与单次预算（可选）'));
  const fields = { goal: $('task-goal'), destination: target, scenario, mode:modeField };
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
  const preview = el('details', '', 'execution-preview'); preview.id = 'task-execution-preview';
  const previewText = el('p', ''); previewText.id = 'task-preview-summary';
  preview.append(el('summary', '查看执行计划与准备条件'), previewText);
  const workflowButton = el('button', '选择与预览工作流'); workflowButton.type = 'button';workflowButton.onclick = () => window.Workbench.navigate('workflows');
  preview.append(workflowButton);form.append(preview,form.querySelector('.task-composer-footer'));
  readiness.remove(); form.append(readiness); // Readiness stays next to the real submit button.
  form.append(form.querySelector('.task-composer-footer'));
  const submitStatus = el('span', '');submitStatus.id = 'task-submit-state';submitStatus.setAttribute('role', 'status');readiness.append(submitStatus);
  const attention = el('section', '', 'attention-list panel'); attention.append(el('h3', '待处理'));
  attention.hidden = true;
  const attentionItems = el('div', ''); attention.append(attentionItems);
  document.querySelector('.home-recent').before(attention);
  const requestBox = el('section', '', 'request-card');
  const requestTitle = el('h3', ''); const requestNext = el('p', '');
  const reason = el('p', '', 'task-issue');
  requestBox.append(requestTitle, reason, requestNext, $('resume-controls'), $('task-controls'));
  const appCard = el('section', '', 'app-onboarding'); appCard.id = 'app-onboarding'; requestBox.append(appCard);
  let appRenderKey = '', appBusy = false;
  function renderApp(run) {
    const app = run.appOnboarding;
    appCard.hidden = !app || ['ready', 'reusing', 'cancelled'].includes(app.state);
    if (appCard.hidden) { appRenderKey = ''; return; }
    const key = JSON.stringify([run.taskId, app]);
    if (key === appRenderKey) return;
    appRenderKey = key; appCard.replaceChildren();
    appCard.append(el('h3', `需要应用：${app.appName}`), el('p', `当前环境：${app.desktopTarget.providerId} / ${app.desktopTarget.environmentId}`),
      el('p', `安装域：${app.scope?.installationScopeId || '暂不可用'}`));
    const messages = { discovering: '正在只读发现应用', candidates: '请选择候选，确认后验证启动。', not_found: '已扫描的来源中未找到应用。可自行安装后重扫。',
      unavailable: '扫描、环境或启动不可用；这不代表应用未安装。', rejected: '已拒绝候选，不会自动采用其他应用。', launching: '正在验证启动，请等待。',
      new_task_required: '旧 Session 无法恢复。应用配置成果保留，请新建任务。' };
    appCard.append(el('p', messages[app.state] || app.state));
    if (app.reason) appCard.append(el('p', app.reason));
    const feedback = el('p', ''); feedback.id = 'app-onboarding-feedback'; feedback.setAttribute('role', 'status');
    const selected = el('select', ''); selected.id = 'app-onboarding-candidate';
    const placeholder = el('option', '请选择应用，单个候选也需要确认'); placeholder.value = ''; selected.append(placeholder);
    for (const item of app.candidates) {
      const choice = el('option', `${item.displayName} · ${item.path} · 参数 ${JSON.stringify(item.args)} · 工作目录 ${item.workingDirectory || '默认'} · ${item.version || '版本未知'} · ${item.publisher || '发布者未知'} · ${item.sources.join(', ')}${item.limitation ? ` · ${item.limitation}` : ''}`);
      choice.value = item.candidateId; selected.append(choice);
    }
    selected.value = ''; appCard.append(selected);
    selected.setAttribute('aria-label', '应用候选');
    const candidateDetail = el('p', '', 'app-onboarding-identity'); appCard.append(candidateDetail);
    const actions = el('div', '', 'app-onboarding-actions');
    const path = el('input', ''); path.id = 'app-onboarding-path'; path.placeholder = '所选环境内的 .exe 或 .lnk 完整路径'; path.maxLength = 1024;
    path.setAttribute('aria-label', '所选环境内应用路径');
    async function act(action) {
      if (app.state === 'new_task_required') return;
      if (appBusy && action !== 'cancel') return;
      const candidate = app.candidates.find(item => item.candidateId === selected.value);
      if (['confirm', 'reject'].includes(action) && !candidate) return;
      appBusy = true; updateButtons(); feedback.textContent = '正在处理…';
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(run.taskId)}/app-onboarding`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactionId: app.interactionId,
            desktopTarget: app.desktopTarget, action, ...(['confirm', 'reject'].includes(action) ? {
              candidateId: candidate.candidateId, candidateRevision: candidate.candidateRevision } : action === 'path' ? { path: path.value.trim() } : {}) }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || '应用接入失败');
        document.dispatchEvent(new CustomEvent('workbench:open-run', { detail: `${run.source}/${run.taskId}` }));
      } catch (error) { feedback.textContent = error.message; }
      finally { appBusy = false; updateButtons(); }
    }
    const buttons = [];
    for (const [action, label] of [['confirm', '确认并验证启动'], ['reject', '不是这个应用'], ['path', '指定路径'],
      ['rescan', '重新扫描'], ['rescan', '安装后重扫'], ['cancel', '取消任务']]) {
      const button = el('button', label); button.type = 'button'; button.dataset.action = action;
      button.onclick = () => act(action); buttons.push(button); actions.append(button);
    }
    function updateButtons() {
      const terminal = app.state === 'new_task_required';
      selected.disabled = terminal; path.disabled = terminal;
      const candidate = app.candidates.find(item => item.candidateId === selected.value);
      candidateDetail.textContent = candidate ? `${candidate.displayName} · ${candidate.path}\n参数 ${JSON.stringify(candidate.args)} · 工作目录 ${candidate.workingDirectory || '默认'}\n${candidate.version || '版本未知'} · ${candidate.publisher || '发布者未知'} · ${candidate.sources.join(', ')}` : '';
      for (const button of buttons) button.disabled = terminal || appBusy && button.dataset.action !== 'cancel' || run.status !== 'waiting_user' ||
        app.state === 'launching' && button.dataset.action !== 'cancel' ||
        ['confirm', 'reject'].includes(button.dataset.action) && !selected.value || button.dataset.action === 'path' && !path.value.trim();
    }
    selected.onchange = updateButtons; path.oninput = updateButtons;
    appCard.append(path, actions, feedback); updateButtons();
  }
  document.querySelector('.hero').prepend(requestBox);
  const original = el('details', '', 'original-goal'); original.append(el('summary', '查看完整任务要求'));
  const originalText = el('p', ''); original.append(originalText); $('goal').parentElement.after(original);
  const resultTitle = el('h3', '执行结果'); $('summary').before(resultTitle);
  const sceneResult = el('section', '', 'scenario-card panel'); sceneResult.id = 'scenario-result';
  const sceneStatus = el('p', ''); sceneStatus.id = 'scenario-status';
  const sceneFacts = el('pre', ''); sceneFacts.id = 'scenario-facts';
  const sceneHistory = el('ol', ''); sceneHistory.id = 'scenario-history';
  const issueLabel = el('label', '使用反馈（随问题记录下载）');
  const issueNote = el('textarea', ''); issueNote.maxLength = 2000; issueNote.id = 'scenario-issue-note'; issueLabel.append(issueNote);
  const download = el('a', '下载问题记录', 'report-download'); download.href = '#'; download.id = 'scenario-report';
  sceneResult.append(el('h3', '固定场景结果'), sceneStatus, sceneFacts, sceneHistory, issueLabel, download);
  document.querySelector('.task-scene').prepend(sceneResult); sceneResult.hidden = true;
  let issueReportUrl;
  download.onclick = event => {
    if (!currentRun?.desktopScenario) { event.preventDefault(); return; }
    const data = { recordedAt: new Date().toISOString(), note: issueNote.value.trim(), source: currentRun.source,
      taskId: currentRun.taskId, desktopTarget: currentRun.desktopTarget, scenarioId: currentRun.desktopScenario,
      status: currentRun.status, error: currentRun.error, summary: currentRun.summary, result: currentRun.desktopScenarioResult };
    if (issueReportUrl) URL.revokeObjectURL(issueReportUrl);
    issueReportUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    download.href = issueReportUrl; download.download = `agent-desktop-${currentRun.taskId}.json`;
  };
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
  let busy = false, currentRun = null, budgetReady = false, globalBudget = null;
  const storageKey = 'agent-desktop.task-draft.v2';
  let draftDestination, draftScenario, renderedDestination;
  try {
    const draft = JSON.parse(sessionStorage.getItem(storageKey) || sessionStorage.getItem('agent-desktop.task-draft.v1') || 'null');
    if (draft) {
      for (const [key, field] of Object.entries(fields)) if (!['destination', 'scenario'].includes(key) && typeof draft[key] === 'string') field.value = draft[key];
      draftDestination = draft.destination;
      draftScenario = draft.scenario;
    }
  } catch {}
  if (!modes.some(([id])=>id === modeField.value)) modeField.value = 'autonomous';
  const selection = window.createDesktopSelection(target, true, update, true, true);
  if (typeof draftDestination === 'string') selection.restore(draftDestination);
  function save() { try { sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])))); } catch {} }
  function update() {
    const item = selection.selected();
    const catalog = item?.scenarios || [];
    const renderKey = JSON.stringify([target.value, catalog]);
    if (renderedDestination !== renderKey) {
      renderedDestination = renderKey;
      scenario.replaceChildren();
      const placeholder = el('option', item?.executable ? '通用任务' : '请选择固定场景'); placeholder.value = ''; scenario.append(placeholder);
      const labels = { supported: '已支持', unavailable: '不可用', unsupported: '不支持', 'not-proven': '尚未验证' };
      for (const scene of catalog) {
        const choice = el('option', `${scene.label} · ${labels[scene.availability]}${scene.reason ? ` · ${scene.reason}` : ''}`);
        choice.value = scene.id; choice.disabled = scene.availability !== 'supported'; scenario.append(choice);
      }
      if (target.value === draftDestination && draftScenario && item) {
        if (![...scenario.options].some(choice => choice.value === draftScenario)) {
          const missing = el('option', '此前选择的场景不可用，请重新选择'); missing.value = draftScenario; missing.disabled = true; scenario.append(missing);
        }
        scenario.value = draftScenario; draftScenario = undefined;
      }
    }
    scenarioLabel.hidden = !catalog.length && !scenario.value;
    const finite = !!scenario.value;
    fields.goal.disabled = finite; fields.criteria.disabled = finite; fields.constraints.disabled = finite; $('task-admin').disabled = finite;
    const mode = modes.find(([id])=>id === modeField.value);
    const modeProblem = !finite && modeField.value !== 'autonomous' ? mode[2] : '';
    for (const radio of radios) {radio.checked = radio.value === modeField.value;radio.disabled = finite;}
    modeDescription.textContent = finite ? '当前明确选择了固定规则计划；四种模式不参与该计划执行。' : mode[2];
    const problem = selection.problem(scenario.value) || modeProblem;
    const blocked = !!problem;
    $('task-submit').disabled = busy || !!blocked || !budgetReady;
    readiness.dataset.state = problem || !budgetReady ? 'blocked' : 'ready';
    heading.textContent = problem ? '尚不可提交' : !budgetReady ? '任务预算服务未就绪' : finite ? '可提交固定规则计划 · 后台重新预检' : '可提交通用任务 · 后台检查模型与环境';
    hint.textContent = (selection.synthetic() ? '合成体验：无真实桌面输入、应用启动或模型调用；NOT HUMAN VERIFIED。' : '') +
      (problem || (!budgetReady ? '任务预算服务暂不可用。' : finite ? '仅执行所选固定场景，自由任务文本、完成条件与管理员开关不参与执行。支持状态不代表当前窗口已就绪；执行时重新检查目标、能力与输入租约。' : target.value === 'browser' ? '在浏览器中执行任务。' : '执行时检查所选桌面的连接、窗口、权限与输入租约；已占用或未就绪时拒绝执行。'));
    const label = target.value ? target.selectedOptions[0]?.textContent || '' : '';
    const budgetText = globalBudget ? [['deepseek', 'DeepSeek'], ['jev', 'JEV']].map(([key, name]) =>
      `${name} ${fields[key + 'Calls'].value || globalBudget[key].maxCalls} 次 / ${fields[key + 'Tokens'].value || globalBudget[key].maxTokens} Token`).join('；') : '预算服务未就绪';
    previewText.textContent = `模式：${finite ? '固定规则计划（不属于四种模式）' : mode[1]}\n环境：${label || '待选择'}\n计划：${finite ? scenario.selectedOptions[0]?.textContent : modeProblem ? '此模式没有已接通的工作台执行入口' : '根据目标在后台规划；未获得输入与副作用许可前不执行'}\n应用：按当前任务的后台发现与确认，页面不自动启动\n文件：只从实际执行与验收记录确认；此预览不创建文件\n模型 / 预算：${finite ? '规则执行；不启用模型' : '模型配置在后台核对'}；${budgetText}\n权限 / 副作用：动作可能修改应用或文件；真实风险批准与一次性授权由后台校验，本预览不发出动作。`;
    submitStatus.textContent = busy ? '提交处理中，请勿重复发送。' : blocked ? '禁用原因见上方；选择与预览不会执行。' : '';
    window.Workbench?.draft({label,description:modeDescription.textContent+' '+hint.textContent});
  }
  function loadBudget() {
    budgetReady = false; update();
    return fetch('/api/settings/task-budget').then(response => response.ok ? response.json() : Promise.reject(new Error('预算服务不可用')))
    .then(result => { globalBudget = result.budget; budgetReady = !!globalBudget; update(); }).catch(() => { budgetReady = false; update(); });
  }
  void loadBudget();
  document.addEventListener('workbench:budget-updated', loadBudget);
  form.addEventListener('input', () => { clearAdmissionMessage(); save(); update(); });
  target.addEventListener('change', () => { clearAdmissionMessage(); draftScenario = undefined; update(); save(); });
  scenario.addEventListener('change', () => { clearAdmissionMessage(); save(); update(); });
  retry.onclick = () => {
    if (!currentRun) return;
    fields.goal.value = currentRun.goal;
    draftDestination = currentRun.desktopTarget ? JSON.stringify([currentRun.desktopTarget.providerId, currentRun.desktopTarget.environmentId]) : 'browser';
    draftScenario = currentRun.desktopScenario; renderedDestination = undefined;
    selection.restore(currentRun.desktopTarget ? JSON.stringify([currentRun.desktopTarget.providerId, currentRun.desktopTarget.environmentId]) : currentRun.desktopTargetRequired ? 'legacy-desktop-target-required' : 'browser');
    fields.criteria.value = ''; fields.constraints.value = ''; save();
    window.Workbench.navigate('live'); window.Workbench.editDraft(); update(); fields.goal.focus();
  };
  return {
    control() { update(); },
    submitting(value) { busy = value; update(); },
    payload() {
      if (busy) throw new Error('任务提交处理中，不重复提交。');
      update(); if ($('task-submit').disabled) throw new Error(hint.textContent);
      const budget = {};
      for (const [kind, names] of Object.entries({ deepseek: ['deepseekCalls', 'deepseekTokens'], jev: ['jevCalls', 'jevTokens'] })) {
        const entries = names.map((name, index) => [index ? 'maxTokens' : 'maxCalls', fields[name].value.trim()])
          .filter(([, value]) => value);
        if (entries.length) {
          for (const [, value] of entries) if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000000) throw new Error('模型预算必须是 1 到 1000000 的整数');
          budget[kind] = Object.fromEntries(entries.map(([key, value]) => [key, Number(value)]));
        }
      }
      const selected = selection.payload(scenario.value);
      if (scenario.value) return { desktopTarget: selected.desktopTarget, scenarioId: scenario.value,
        ...(Object.keys(budget).length ? { budget } : {}) };
      return { ...selected, criteria: fields.criteria.value.trim(), constraints: fields.constraints.value.trim(),
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
      if (currentRun?.taskId !== run.taskId || currentRun?.source !== run.source) { $('resume-answer').value = ''; issueNote.value = ''; }
      currentRun = run;
      renderApp(run);
      const shot = [...(run.steps || [])].reverse().find(step => step.hasScreenshot);
      const url = shot ? `/api/screenshots/${encodeURIComponent(run.source)}/${encodeURIComponent(run.taskId)}/${shot.step}` : '';
      if (url !== evidenceUrl) {
        evidenceUrl = url; evidenceImage.hidden = !url; evidenceLink.hidden = !url; missingEvidence.hidden = !!url;
        if (url) { evidenceImage.src = url; evidenceLink.href = url; } else { evidenceImage.removeAttribute('src'); evidenceLink.removeAttribute('href'); }
      }
      if (!url) { evidenceImage.hidden = true; evidenceLink.hidden = true; missingEvidence.hidden = false; missingEvidence.textContent = '此任务尚无已记录截图。本环境暂无可用现场视图；可查看已记录观察和执行过程。'; }
      evidenceCaption.textContent = shot ? `第 ${shot.step} 步 · ${shot.screenshotTime ? new Date(shot.screenshotTime).toLocaleString('zh-CN') : '时间未记录'} · ${shot.screenshotScope === "desktop" ? "完整桌面" : shot.screenshotScope === "window" ? "窗口截图，未包含桌面" : "页面截图"} · 历史画面，不代表当前桌面${shot.desktopCaptureError ? " · 完整桌面采集失败" : ""}` : '不会用其他任务的实时画面替代证据。';
      const text = run.goal.replace(/^VM:\s*/i, ''); $('goal').textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      originalText.textContent = run.goal; original.hidden = text.length <= 60;
      const waiting = run.status === 'waiting_user'; const paused = ['paused', 'pause_requested'].includes(run.status);
      requestBox.hidden = !waiting && !paused && run.status !== 'failed' && run.status !== 'stopped' && !(run.canPause && run.status === 'running');
      reason.textContent = run.error || run.summary || '尚未记录具体原因，请查看执行过程。';
      reason.hidden = run.status === 'running';
      requestTitle.textContent = waiting ? ({ app_onboarding: '需要确认应用配置', question: '需要补充信息', final_review: '请确认最终结果', approval: '需要批准下一步动作' }[run.interactionKind] || '需要你处理') : '任务已暂停或正在暂停';
      requestNext.textContent = waiting ? run.interactionKind === 'final_review' ? '核对下方结果与截图后，再确认完成；未满足目标请选择“尚未完成”。' : run.interactionKind === 'question' ? '提交回答后任务继续处理。' : '查看动作说明后决定是否允许。' : run.recoveryRequired && run.canPause ? '任务现场已保留。先确认环境就绪，继续时会重新观察，再判断下一步。' : '核对原因与已有证据；下一步操作以当前任务的控制资格为准。';
      if (run.status === 'failed' || run.status === 'stopped') { requestTitle.textContent = run.status === 'failed' ? '任务未完成' : '任务已停止'; requestNext.textContent = '查看原因和历史证据，可用下方“新建草稿”修改要求后重新提交。'; }
      if (run.status === 'running') { requestTitle.textContent = '任务正在执行'; requestNext.textContent = '需要介入时可请求暂停，等待当前动作到达安全边界。'; }
      if (run.interactionKind === 'app_onboarding') requestNext.textContent = '配置完成后继续当前任务，无需重输要求；应用启动不代表业务完成。';
      if (run.appOnboarding?.state === 'new_task_required') requestNext.textContent = '应用配置成果保留。请用下方“以此任务新建草稿”明确创建新任务；旧动作不会重放。';
      resultTitle.textContent = run.status === 'done' ? '完成结果' : run.status === 'failed' ? '未完成 · 原因' : '当前进展';
      sceneResult.hidden = !run.desktopScenario;
      if (run.desktopScenario) {
        const result = run.desktopScenarioResult;
        const phases = { queued: '排队', desktop_scenario_preparing: '环境与目标预检', desktop_scenario_dispatch: '执行一次',
          desktop_scenario_verifying: '独立验证', desktop_scenario_verified: '验证通过', desktop_scenario_cleanup: '停止与清理',
          desktop_scenario_cleanup_done: '清理完成', desktop_scenario_done: '完成', desktop_scenario_error: '阻断', desktop_scenario_cleanup_error: '清理失败' };
        sceneStatus.textContent = `${run.desktopTarget?.providerId} / ${run.desktopTarget?.environmentId} · ${run.desktopScenario}\n` +
          `阶段：${phases[result?.phase] || result?.phase || 'UNKNOWN'} · ${result?.blocked ? 'BLOCKED · ' : ''}执行 ${result?.execution || 'UNKNOWN'} · 验证 ${result?.verification || 'UNKNOWN'} · 清理 ${result?.cleanup || 'UNKNOWN'} · NOT HUMAN VERIFIED\n暂无可读取的系统内人工验收记录；外部 Owner 报告另行保留。${result?.execution === 'UNKNOWN' || result?.verification === 'UNKNOWN' ? '\n结果未知，不自动重放。' : ''}`;
        sceneFacts.textContent = JSON.stringify(result?.facts || {}, null, 2);
        sceneHistory.replaceChildren(...(result?.events || []).map(event => el('li', `${new Date(event.time).toLocaleString('zh-CN')} · ${phases[event.kind] || event.kind} · ${event.detail || ''}`)));
        if (paused || run.status === 'failed') requestNext.textContent = '固定场景停止后清理资源；不支持 Dashboard 接管或 Resume。先核对结果与清理记录；UNKNOWN 不自动重放。需要重试时显式新建任务。';
        if (paused) requestTitle.textContent = run.status === 'pause_requested' ? '固定场景正在停止' : '固定场景已停止';
        if (run.status === 'running') requestNext.textContent = '可点击“停止并清理”；等待当前调用返回后撤销许可、清理资源，不自动重放。';
      }
    },
  };
};
