// Layout and presentation only. Control authorization remains on the Host.
window.Workbench = (() => {
  if (new URLSearchParams(location.search).has('legacy')) return null;
  document.body.classList.add('workbench');
  const $ = id => document.getElementById(id);
  const main = document.querySelector('.main');
  const sidebar = document.querySelector('.sidebar');
  const desktop = document.querySelector('.desktop-panel');
  const composer = document.querySelector('.composer');
  const detail = $('detail');
  const empty = $('empty');
  const create = (tag, cls, text) => {
    const element = document.createElement(tag);
    element.className = cls;
    if (text) element.textContent = text;
    return element;
  };
  document.title = 'Agent Desktop · 工作台';
  document.querySelector('.brand strong').textContent = 'Agent Desktop';
  document.querySelector('.brand small').textContent = '任务与桌面工作台';
  const shell = window.createAppShell(navigate);
  const filters = create('div', 'run-filters');
  const search = create('input', '');
  search.type = 'search'; search.placeholder = '搜索目标、Task ID 或来源'; search.setAttribute('aria-label', '搜索任务');
  const filter = create('select', ''); filter.setAttribute('aria-label', '筛选任务状态');
  for (const [value, label] of [['all', '所有状态'], ['attention', '待处理'], ['running', '执行中'], ['waiting_user', '等待人工'], ['paused', '已暂停'], ['done', '已完成'], ['failed', '失败'], ['blocked', '已阻断'], ['unknown', '结果未知'], ['stopped', '已停止']]) {
    const option = create('option', '', label); option.value = value; filter.append(option);
  }
  const records = create('select', ''); records.setAttribute('aria-label', '任务记录范围');
  for (const [value, label] of [['all', '全部记录'], ['current', '进行中 / 待处理'], ['history', '终态记录']]) {
    const option = create('option', '', label); option.value = value; records.append(option);
  }
  filters.append(search, records, filter); $('run-list').before(filters);
  search.oninput = records.onchange = filter.onchange = () => document.dispatchEvent(new Event('workbench:filter'));
  const legacy = create('a', 'legacy-link', '切换旧版布局'); legacy.href = '/?legacy=1';
  sidebar.querySelector('.side-foot').textContent = '本地工作区';
  sidebar.querySelector('.side-foot').append(legacy);

  const title = document.querySelector('.topbar > span');
  const workspace = create('div', 'workspace-grid');
  const historyList = create('section', 'history-list panel');
  historyList.setAttribute('aria-label', '任务记录列表');
  const historyHeading = sidebar.querySelector('.side-heading');
  historyHeading.querySelector('span').textContent = '任务记录';
  historyList.append(historyHeading, filters, $('run-list'));
  workspace.append(historyList);
  const taskPane = create('aside', 'task-pane'); taskPane.setAttribute('aria-label', '任务面板');
  const context = create('p', 'task-context', '当前现场 · 等待状态');
  context.setAttribute('role', 'status');
  const diagnostics = create('details', 'task-diagnostics');
  diagnostics.append(create('summary', '', '执行过程、证据与运行分析'));
  for (const child of [...detail.children]) if (!child.classList.contains('hero')) diagnostics.append(child);
  detail.append(diagnostics);
  detail.insertBefore($('stage-list').closest('section'), diagnostics);
  taskPane.append(context, $('task-message'), empty, detail);
  workspace.append(taskPane); main.append(workspace);
  const home = create('section', 'workspace-home'); home.id = 'workspace-home';
  const homeHeader = create('header', 'home-header');
  homeHeader.append(create('h1', '', '今天想让 Agent 做什么？'), create('p', '', '描述目标，明确选择环境，再查看执行范围。'));
  const homeLayout = create('div', 'home-layout');
  const homeContextToggle = create('button', 'context-toggle', '收起准备上下文'); homeContextToggle.type = 'button';
  homeContextToggle.setAttribute('aria-expanded', 'true');
  homeContextToggle.onclick = () => {
    const collapsed = homeLayout.classList.toggle('home-context-collapsed');
    homeContextToggle.textContent = collapsed ? '展开准备上下文' : '收起准备上下文';
    homeContextToggle.setAttribute('aria-expanded', String(!collapsed));
  };
  homeHeader.append(homeContextToggle);
  const homeMain = create('div', 'home-main');
  const composerDisclosure = create('details', 'composer-disclosure'); composerDisclosure.open = true;
  composerDisclosure.append(create('summary', '', '新建任务'), composer);
  homeMain.append(composerDisclosure);
  const idleContext = create('aside', 'workspace-idle-context panel'); idleContext.setAttribute('aria-label', '任务准备上下文');
  const environment = create('button', 'home-environment', '尚未选择执行环境');
  environment.type = 'button'; environment.onclick = () => navigate('desktop');
  const homeCurrent = create('section', 'panel home-current'); homeCurrent.setAttribute('aria-label', '当前任务');
  const recent = create('section', 'panel home-recent'); recent.setAttribute('aria-label', '最近完成');
  const draftContext = create('p', '', '选择环境后显示真实支持范围。'); draftContext.id = 'workspace-draft-context';
  const workflowEntry = create('button', '', '查看已保存工作流'); workflowEntry.type = 'button'; workflowEntry.onclick = () => navigate('workflows');
  idleContext.append(create('h2', '', '准备与上下文'), environment, draftContext, workflowEntry, homeCurrent, recent);
  homeLayout.append(homeMain, idleContext); home.append(homeHeader, homeLayout); taskPane.prepend(home);
  const desktopPage = create('section', 'workspace-desktop'); desktopPage.append(desktop); main.append(desktopPage);
  const connectionPanel = create('section', 'desktop-overview panel'); connectionPanel.setAttribute('aria-label', '连接检查');
  const connectionTitle = create('h1', '', '环境连接与能力');
  const connectionSummary = create('p', '', '正在读取连接状态'); connectionSummary.setAttribute('role', 'status');
  const recoveryHint = create('p', 'desktop-recovery-hint');
  const checkConnection = create('button', '', '刷新连接状态'); checkConnection.type = 'button';
  checkConnection.onclick = () => document.dispatchEvent(new Event('workbench:refresh-desktop'));
  const openTask = create('button', '', '查看占用任务'); openTask.type = 'button'; openTask.hidden = true;
  openTask.onclick = () => { if (state.taskId) document.dispatchEvent(new CustomEvent('workbench:open-run', { detail: `web-tasks.sqlite/${state.taskId}` })); };
  const recoverySteps = create('details', 'desktop-recovery'); recoverySteps.append(create('summary', '', '连接恢复步骤'));
  const steps = create('ol', '');
  for (const text of ['先在工作台明确选择执行环境；可查看应用管理中的真实支持范围。', '仅对已配置的虚拟机使用下方启动与窗口入口，确认 Windows 已登录且 Worker 已启动。', '当前流仅提供已连接 Session 的画面；其它 Provider 不据此宣称离线。', '保留任务请从任务页打开，核对其环境、证据与控制资格；不自动重放。']) steps.append(create('li', '', text));
  recoverySteps.append(steps);
  connectionPanel.append(connectionTitle, connectionSummary, recoveryHint, checkConnection, openTask, recoverySteps);
  desktopPage.prepend(connectionPanel);
  const taskHeader = create('header', 'task-heading panel');
  const hero = detail.querySelector('.hero');
  taskHeader.append(hero.querySelector('.eyebrow'), hero.querySelector('.hero-title'), hero.querySelector('.meta'));
  const contextToggle = create('button', 'context-toggle', '收起上下文'); contextToggle.type = 'button'; contextToggle.setAttribute('aria-expanded', 'true');
  contextToggle.onclick = () => {
    const collapsed = detail.classList.toggle('context-collapsed'); contextToggle.textContent = collapsed ? '展开上下文与任务控制' : '收起上下文';
    contextToggle.setAttribute('aria-expanded', String(!collapsed));
  };
  taskHeader.append(contextToggle);
  const taskLayout = create('div', 'task-detail-layout');
  const scene = create('section', 'task-scene'); scene.setAttribute('aria-label', '任务现场与证据');
  const liveSlot = create('div', 'task-live-slot');
  const recorded = create('section', 'task-recorded panel'); recorded.id = 'task-recorded';
  const views = create('div', 'task-view-tabs'); views.setAttribute('aria-label', '现场视图');
  let observationView = false;
  const imageView = create('button', '', '画面与证据'); const textView = create('button', '', '文字与结构');
  const observation = create('section', 'task-observation panel'); observation.setAttribute('aria-label', '已记录观察');
  observation.append(create('h2', '', '执行现场 · 已记录观察'));
  const observationNote = create('p', ''), observationFacts = create('pre', ''); observation.append(observationNote, observationFacts);
  for (const [button, value] of [[imageView, false], [textView, true]]) {
    button.type = 'button'; button.onclick = () => { observationView = value; sync(currentRun); }; views.append(button);
  }
  const timeline = create('section', 'panel section workspace-timeline'); timeline.append(create('h2', '', '实际过程 · 最近执行步骤'));
  const timelineItems = create('ol', ''); timeline.append(timelineItems);
  const controlAvailability = create('p', 'control-availability'); controlAvailability.id = 'task-control-availability';
  const runtimeSummary = create('p', 'task-runtime-summary');
  const unavailableControls = create('div', 'unsupported-task-controls');
  for (const label of ['接管任务', '停止任务', '紧急停止']) {
    const button = create('button', '', label); button.type = 'button'; button.disabled = true;
    button.title = '此任务接口未声明该操作；已连接桌面另按其真实控制资格处理。'; unavailableControls.append(button);
  }
  hero.append(create('h2', 'context-title', '任务上下文'), runtimeSummary, controlAvailability, unavailableControls);
  scene.append(views, liveSlot, recorded, observation, timeline); taskLayout.append(scene, hero);
  detail.prepend(taskHeader, taskLayout);
  const settings = create('section', 'workspace-settings panel');
  const settingsIntro = create('p', 'settings-intro', '');
  settings.append(create('h1', '', '设置'), settingsIntro);
  const configNote = create('section', 'settings-config-note');
  configNote.append(create('h2', '', '任务运行配置'), create('p', '', '全局预算是新任务的默认值；工作台可为单次任务覆盖。执行位置在提交时选择。'));
  settings.append(configNote);
  const budgetPanel = create('section', 'settings-config-note');
  budgetPanel.append(create('h2', '', '全局模型预算'), create('p', '', '分别限制 DeepSeek 与 JEV。调用次数在请求前硬限制；Token 按服务返回用量累计，到限后拦截下一次调用。已提交任务使用提交时的预算快照。'));
  const budgetFields = {};
  for (const [kind, label] of [['deepseek', 'DeepSeek'], ['jev', 'JEV']]) {
    const group = create('div', 'budget-row'); group.append(create('strong', '', label));
    for (const [key, name] of [['maxCalls', '最多调用次数'], ['maxTokens', '最多 Token']]) {
      const wrapper = create('label', '', name); const input = create('input', '');
      input.type = 'number'; input.min = '1'; input.max = '1000000'; input.step = '1';
      input.id = `global-budget-${kind}-${key}`; wrapper.append(input); group.append(wrapper);
      budgetFields[`${kind}.${key}`] = input;
    }
    budgetPanel.append(group);
  }
  const saveBudget = create('button', '', '保存全局预算'); saveBudget.type = 'button';
  const budgetMessage = create('span', ''); budgetMessage.setAttribute('role', 'status');
  budgetPanel.append(saveBudget, budgetMessage); settings.append(budgetPanel);
  fetch('/api/settings/task-budget').then(response => response.json()).then(data => {
    if (!data.budget) throw new Error(data.error || '无法读取预算');
    for (const [path, input] of Object.entries(budgetFields)) {
      const [kind, key] = path.split('.'); input.value = String(data.budget[kind][key]);
    }
  }).catch(error => { budgetMessage.textContent = `预算读取失败：${error.message || error}`; });
  saveBudget.onclick = async () => {
    const budget = { deepseek: {}, jev: {} };
    for (const [path, input] of Object.entries(budgetFields)) {
      const [kind, key] = path.split('.'); const value = input.value.trim();
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000000) {
        budgetMessage.textContent = '预算必须是 1 到 1000000 的整数'; return;
      }
      budget[kind][key] = Number(value);
    }
    saveBudget.disabled = true;
    try {
      const response = await fetch('/api/settings/task-budget', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(budget) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '保存失败');
      budgetMessage.textContent = '已保存，后续新任务将使用这些默认值';
      document.dispatchEvent(new Event('workbench:budget-updated'));
    } catch (error) { budgetMessage.textContent = `保存失败：${error.message || error}`; }
    finally { saveBudget.disabled = false; }
  };
  settings.append($('prompt-editor')); main.append(settings);
  const appsPage = create('section', 'workspace-apps panel'); main.append(appsPage);
  const appManagement = window.createAppManagement(appsPage);
  const environmentsPage = create('section', 'workspace-environments');
  const environmentTabs = create('nav', 'environment-tabs'); environmentTabs.setAttribute('aria-label', '环境与应用视图');
  const environmentTab = create('button', '', '环境'), appsTab = create('button', '', '已接入应用');
  environmentTab.type = appsTab.type = 'button'; environmentTab.onclick = () => navigate('desktop'); appsTab.onclick = () => navigate('apps');
  environmentTabs.append(environmentTab, appsTab); environmentsPage.append(environmentTabs, desktopPage, appsPage); main.append(environmentsPage);
  const library = create('section', 'workspace-library'); main.append(library);
  const workflowLibrary = window.createWorkflowLibrary(library);
  const runtimePanel = create('section', 'workspace-library runtime-panel'); main.append(runtimePanel);
  const runtimePlugins = window.createRuntimePlugins(runtimePanel);
  const settingsNav = create('nav', 'settings-nav'); settingsNav.setAttribute('aria-label', '设置分类');
  const promptTab = create('button', '', '提示词配置'); promptTab.type = 'button'; promptTab.onclick = () => navigate('settings');
  const pluginTab = create('button', '', '插件与扩展'); pluginTab.type = 'button'; pluginTab.onclick = () => navigate('plugins');
  settingsNav.append(promptTab, pluginTab); settings.querySelector('h1').after(settingsNav);
  settings.append(runtimePanel);
  const frameLabel = create('div', 'frame-freshness', '等待实时画面');
  frameLabel.setAttribute('role', 'status');
  desktop.querySelector('.desktop-screen').before(frameLabel);
  desktop.querySelector('.section-head h2').textContent = '当前桌面';
  const diagnostic = create('details', 'desktop-diagnostics');
  diagnostic.append(create('summary', '', '连接与控制诊断'));
  diagnostic.append($('desktop-connection-state'), desktop.querySelector('details'), desktop.querySelector('.desktop-meta'));
  desktop.append(diagnostic);
  desktop.querySelector('.desktop-screen').after($('desktop-ownership'));
  $('task-message').textContent = '';
  empty.replaceChildren(create('h2', '', '当前没有活动任务'), create('p', '', '可以提交新任务，或在任务记录中查看已有结果。'));
  let mode = 'live';
  let state = {};
  let frameAt = 0;
  let streamDisconnected = true;
  let submittedKey = null;
  try { submittedKey = sessionStorage.getItem('agent-desktop.submitted-task'); } catch { /* storage unavailable */ }
  let changed = () => {};
  let routeTask = null;
  let currentRun = null;
  let draftEnvironment = '';
  function readRoute() {
    return shell.readRoute();
  }
  function navigate(next, task = null, fromHistory = false) {
    desktopPage.append(desktop);
    if (next === 'environments') next = 'desktop';
    if (!['live', 'history', 'workflows', 'desktop', 'apps', 'settings', 'plugins'].includes(next)) next = 'live';
    routeTask = next === 'history' ? task : null;
    const hash = shell.route(next, routeTask);
    if (!fromHistory && location.hash !== hash) history.pushState(null, '', hash);
    mode = next;
    workspace.hidden = !['history', 'live'].includes(next); settings.hidden = !['settings', 'plugins'].includes(next);
    home.hidden = next !== 'live'; desktopPage.hidden = next !== 'desktop';
    environmentsPage.hidden = !['desktop', 'apps'].includes(next);
    environmentTab.setAttribute('aria-current', next === 'desktop' ? 'page' : 'false');
    appsTab.setAttribute('aria-current', next === 'apps' ? 'page' : 'false');
    if (next === 'live') composer.prepend($('task-message'));
    else taskPane.prepend($('task-message'));
    appsPage.hidden = next !== 'apps';
    if (next === 'apps') void appManagement.load();
    else appManagement.leave();
    library.hidden = next !== 'workflows';
    runtimePanel.hidden = next !== 'plugins';
    desktop.hidden = next !== 'desktop'; composer.hidden = next !== 'live';
    $('prompt-editor').hidden = next !== 'settings';
    configNote.hidden = next !== 'settings';
    budgetPanel.hidden = next !== 'settings';
    settingsIntro.textContent = next === 'plugins' ? '查看 Host 当前装载的插件、依赖与扩展能力。' : '设置新任务的全局模型预算和提示词；已有任务保留提交时的预算。';
    promptTab.setAttribute('aria-current', next === 'settings' ? 'page' : 'false');
    pluginTab.setAttribute('aria-current', next === 'plugins' ? 'page' : 'false');
    historyList.hidden = next !== 'history';
    workspace.classList.toggle('history-view', next === 'history');
    shell.render(next);
    title.textContent = { live: '工作台', history: '任务 / 记录与详情', desktop: '环境与应用 / 环境', workflows: '工作流 / 版本与参数', apps: '环境与应用 / 已接入应用', plugins: '设置 / 插件与扩展', settings: '设置 / 预算与提示词' }[next];
    if (next === 'plugins') void runtimePlugins.load();
    if (next === 'workflows') void workflowLibrary.load();
    if (next === 'settings') $('prompt-editor').open = true;
    changed();
    requestAnimationFrame(() => { window.scrollTo(0, 0); main.scrollTop = 0; taskPane.scrollTop = 0; window.dispatchEvent(new Event('resize')); });
  }
  function sync(run) {
    const changedRun = currentRun?.taskId !== run?.taskId || currentRun?.source !== run?.source;
    currentRun = run;
    const isActive = run && run.source === 'web-tasks.sqlite' && run.taskId === state.taskId;
    const isSubmitted = run && `${run.source}/${run.taskId}` === submittedKey;
    const inProgress = run && run.source === 'web-tasks.sqlite' && ['queued', 'running', 'waiting_user', 'pause_requested'].includes(run.status);
    const hide = mode === 'live' && !isActive && !isSubmitted && !inProgress;
    detail.hidden = !run || hide; empty.hidden = mode === 'live' || !!run && !hide;
    context.hidden = !run || hide;
    home.classList.toggle('has-current-task', !!run && !hide);
    empty.querySelector('h2').textContent = mode === 'history' ? routeTask ? '找不到指定任务记录' : '暂无任务记录' : '当前没有活动任务';
    empty.querySelector('p').textContent = mode === 'history' ? routeTask ? '记录可能已移除。请从任务列表选择其他记录。' : '提交任务后，可在这里查看执行结果与证据。' : '可以提交新任务，或在任务记录中查看已有结果。';
    // This stream belongs to the Guest Session, never to Browser/Hidden Chrome.
    const guestTask = run?.desktopTarget?.providerId === 'hyper-v' || (!run?.desktopTarget && run?.desktopTargetRequired === true);
    const showLive = ['history', 'live'].includes(mode) && guestTask && isActive && !['done', 'failed', 'stopped'].includes(run.status)
      && (!routeTask || routeTask === `${run.source}/${run.taskId}`);
    if (showLive) { liveSlot.append(desktop); desktop.hidden = false; }
    else { desktopPage.append(desktop); desktop.hidden = mode !== 'desktop'; }
    liveSlot.hidden = !showLive || observationView; recorded.hidden = !!showLive || observationView;
    observation.hidden = !observationView;
    imageView.setAttribute('aria-pressed', String(!observationView)); textView.setAttribute('aria-pressed', String(observationView));
    taskLayout.classList.toggle('has-live', !!showLive);
    context.textContent = mode === 'history' ? showLive ? '当前任务 · 实时桌面与控制归属已核对' : '任务记录 · 展示历史证据，不发送桌面输入' : isSubmitted && !isActive ? '本次提交的任务 · 输入归属以所选环境的后台检查为准' : '当前现场 · 服务端活动任务';
    $('task-controls').classList.remove('workspace-suppressed');
    shell.run(run && !hide ? run : null);
    shell.environment(run && !hide ? run.desktopTarget ? `${run.desktopTarget.providerId} / ${run.desktopTarget.environmentId}` : '浏览器 / 记录' : draftEnvironment);
    if (changedRun && run && !hide && inProgress && !composer.contains(document.activeElement)) composerDisclosure.open = false;
    if (changedRun || run?.status === 'waiting_user') {
      detail.classList.remove('context-collapsed');
      contextToggle.setAttribute('aria-expanded', 'true'); contextToggle.textContent = '收起上下文';
    }
    contextToggle.disabled = run?.status === 'waiting_user';
    contextToggle.title = contextToggle.disabled ? '等待人工处理时保留审批与任务控制入口。' : '折叠或展开当前任务上下文';
    const latest = run?.steps?.at(-1);
    observationNote.textContent = latest ? `第 ${latest.step} 步 · 已记录观察，非实时画面。${latest.time ? '记录于 ' + new Date(latest.time).toLocaleString('zh-CN') : '未记录时间。'}` : '本环境暂无可用现场视图；等待后端记录观察。';
    observationFacts.textContent = latest ? JSON.stringify({step:latest.step, sources:latest.textSources || [],
      action:latest.action?.kind || '尚未决定', dispatch:latest.result?.ok === true ? '已发出' : latest.result?.ok === false ? '失败' : '未知',
      verification:latest.verification?.ok === true ? '通过' : latest.verification?.ok === false ? '未通过' : '未知',
      recordedText:latest.pageText || '未记录可读文本；请查看已有证据。'}, null, 2) : '';
    timelineItems.replaceChildren();
    for (const step of (run?.steps || []).slice(-6)) {
      const row = create('li', '', `第 ${step.step} 步 · ${step.action?.kind || '观察'} · 动作 ${step.result?.ok === true ? '已发出' : step.result?.ok === false ? '失败' : '未知'} · 验证 ${step.verification?.ok === true ? '通过' : step.verification?.ok === false ? '未通过' : '未知'}`);
      timelineItems.append(row);
    }
    if (!timelineItems.children.length) timelineItems.append(create('li', '', '尚无已记录步骤。'));
    controlAvailability.textContent = !run ? '选择任务后核对控制资格。' : run.desktopScenario
      ? '固定规则计划：仅后端声明的“停止并清理”可用；暂停后不支持 Resume、接管或自动重放。'
      : `暂停 / 继续：${run.canPause ? '按当前 Task 状态提供' : '后端未声明'}。接管 / 停止 / 紧急停止：通用 Task 未提供独立接口；桌面控制须匹配当前 Session。`;
    runtimeSummary.textContent = !run ? '' : `环境：${run.desktopTarget ? run.desktopTarget.providerId + ' / ' + run.desktopTarget.environmentId : run.desktopTargetRequired ? '旧桌面绑定，需后台核对' : '浏览器'}\n来源：${run.source}\n${run.desktopScenario ? '计划：固定规则计划；不启用模型' : '模型：' + (run.modelNames?.join('、') || '尚未记录模型名称')}\n预算：${run.taskBudget ? Object.entries(run.taskBudget.limits).map(([name, limit]) => `${name} ${limit.maxCalls} 次 / ${limit.maxTokens} Token`).join('；') : '该记录未提供预算快照'}\n当前步骤：${latest ? latest.step : '尚无记录'} · 独立验证：${latest?.verification?.ok === true ? '通过' : latest?.verification?.ok === false ? '未通过' : '未知'}`;
    if (run) {
      $('progress-number').textContent = run.stagePlanVersion ? `${run.completedStages.length} 阶段完成` : '按实际步骤执行';
      $('progress-fill').parentElement.hidden = true;
    }
  }
  function freshness() {
    const age = frameAt ? Math.floor((Date.now() - frameAt) / 1000) : null;
    const stale = age === null || age > 10 || streamDisconnected || state.workerReady === false;
    frameLabel.textContent = age === null ? '等待实时画面' : `${stale ? '画面已过期 · ' : '实时画面 · '}最近接收于 ${age} 秒前${stale ? '，请等待连接恢复' : ''}`;
    frameLabel.classList.toggle('stale', stale);
    desktop.classList.toggle('frame-stale', stale);
    const worker = state.workerReady === true ? 'Worker 已就绪' : state.workerReady === false ? 'Worker 未就绪' : 'Worker 状态未知';
    connectionSummary.textContent = `${worker} · ${streamDisconnected ? '画面连接未建立' : stale ? '画面待更新' : '画面实时'} · ${state.mode === 'HUMAN_CONTROL' ? '人工控制中' : state.taskId ? '有保留任务' : !state.mode || state.mode === 'ERROR' ? '控制归属待确认' : '无占用任务'}`;
    recoveryHint.textContent = state.mode === 'STOPPED' ? '任务已停止并保存在任务记录中。点击下方“准备新任务”后可再次提交。'
      : state.connection?.status === 'incompatible' ? 'Worker 身份或协议不兼容，请展开连接诊断核对错误。'
      : state.workerReady !== true ? '当前桌面流未就绪；请核对所选 Provider 的连接与能力，不据此判断其它执行环境。'
      : stale ? 'Worker 可达，但画面尚未恢复，请等待新画面后再操作。'
      : state.taskId ? '当前 Session 已就绪。进入占用任务核对暂停原因与恢复资格。' : '当前 Session 已就绪。控制操作仍以服务端资格为准。';
    openTask.hidden = !state.taskId;
  }
  const initialRoute = readRoute();
  navigate(initialRoute.page, initialRoute.task, true);
  window.addEventListener('hashchange', () => { const route = readRoute(); navigate(route.page, route.task, true); });
  setInterval(freshness, 1000);
  return {
    get mode() { return mode; },
    get routeTask() { return routeTask; },
    bind(callback) { changed = callback; },
    navigate, sync,
    draft({label, description}) {
      draftEnvironment = label;
      environment.textContent = label ? `所选环境：${label} →` : '选择与管理执行环境 →';
      draftContext.textContent = description;
      if (!currentRun || detail.hidden) shell.environment(label);
    },
    runs(runs) {
      const addRun = (parent, run) => {
        const button = create('button', 'home-run', run.goal.replace(/^VM:\s*/i, '').slice(0, 90));
        button.append(create('small', '', `${({ running: '执行中', paused: '已暂停', pause_requested: '正在暂停', waiting_user: '待你处理', done: '已完成' })[run.status] || run.status} · 查看任务 →`));
        button.type = 'button'; button.onclick = () => document.dispatchEvent(new CustomEvent('workbench:open-run', { detail: `${run.source}/${run.taskId}` }));
        parent.append(button);
      };
      homeCurrent.replaceChildren(create('h2', '', '当前任务'));
      const active = runs.filter(r => (r.taskId === state.taskId && r.source === 'web-tasks.sqlite' &&
        !['done', 'failed', 'stopped'].includes(r.status)) || ['running', 'pause_requested'].includes(r.status));
      if (!active.length) homeCurrent.append(create('p', '', '当前没有活动任务，可以从上方开始。'));
      for (const run of active.slice(0, 3)) addRun(homeCurrent, run);
      recent.replaceChildren(create('h2', '', '最近完成'));
      const completed = runs.filter(r => r.status === 'done').slice(0, 3);
      for (const run of completed) addRun(recent, run);
      if (!completed.length) recent.append(create('p', '', '完成任务后，结果会出现在这里。'));
    },
    submitted(key) {
      submittedKey = key;
      try { sessionStorage.setItem('agent-desktop.submitted-task', key); } catch { /* storage unavailable */ }
    },
    get submittedKey() { return submittedKey; },
    editDraft() { composerDisclosure.open = true; },
    select(runs, selected) {
      // An acknowledged submission keeps its identity even before the list catches up.
      if (mode === 'live' && submittedKey) return runs.find(run => `${run.source}/${run.taskId}` === submittedKey);
      return mode === 'live' ? runs.find(run => run.source === 'web-tasks.sqlite' && run.taskId === state.taskId &&
        !['done', 'failed', 'stopped'].includes(run.status))
        || runs.find(run => run.source === 'web-tasks.sqlite' && ['queued', 'running', 'waiting_user', 'pause_requested'].includes(run.status)) : runs.find(run => `${run.source}/${run.taskId}` === selected);
    },
    matches(run) {
      const terminal = ['done', 'completed', 'failed', 'blocked', 'stopped'].includes(run.status);
      return `${run.goal} ${run.source}/${run.taskId}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()) &&
        (records.value === 'all' || (records.value === 'history' ? terminal : !terminal)) &&
        (filter.value === 'all' || (filter.value === 'attention' ? ['paused', 'waiting_user', 'pause_requested', 'unknown'].includes(run.status) : run.status === filter.value));
    },
    control(next) {
      const previousTask = state.taskId; state = next;
      const resume = document.querySelector('[data-desktop-command="resume"]');
      resume.textContent = state.mode === 'HUMAN_CONTROL' ? '交还 Agent' : state.taskId ? '恢复执行' : '启用 Agent';
      for (const button of document.querySelectorAll('[data-desktop-command]')) {
        button.hidden = false;
        button.title = button.disabled ? '当前 Session 状态、连接或控制归属不允许此操作。' : '操作当前已连接 Session';
      }
      if (!state.taskId && state.mode !== 'HUMAN_CONTROL') resume.hidden = true;
      freshness();
      if (mode === 'live' && previousTask !== state.taskId) changed();
    },
    frame() { frameAt = Date.now(); streamDisconnected = false; freshness(); },
    disconnected() { streamDisconnected = true; freshness(); },
  };
})();
