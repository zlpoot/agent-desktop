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
  const nav = create('nav', 'workspace-nav');
  nav.setAttribute('aria-label', '主要导航');
  sidebar.querySelector('.brand').after(nav);
  const buttons = new Map();
  for (const [id, label] of [['live', '工作台'], ['history', '任务'], ['workflows', '流程库'], ['desktop', '桌面'], ['settings', '设置']]) {
    if (id === 'live' || id === 'desktop') nav.append(create('span', 'nav-group', id === 'live' ? '工作' : '管理'));
    const button = create('button', '', label);
    button.type = 'button'; button.onclick = () => navigate(id);
    nav.append(button); buttons.set(id, button);
  }
  const filters = create('div', 'run-filters');
  const search = create('input', '');
  search.type = 'search'; search.placeholder = '搜索任务'; search.setAttribute('aria-label', '搜索任务');
  const filter = create('select', ''); filter.setAttribute('aria-label', '筛选任务状态');
  for (const [value, label] of [['all', '所有状态'], ['attention', '待处理'], ['running', '执行中'], ['done', '已完成'], ['failed', '失败']]) {
    const option = create('option', '', label); option.value = value; filter.append(option);
  }
  filters.append(search, filter); $('run-list').before(filters);
  search.oninput = filter.onchange = () => document.dispatchEvent(new Event('workbench:filter'));
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
  taskPane.append(context, $('task-message'), empty, detail, composer);
  workspace.append(desktop, taskPane); main.append(workspace);
  const home = create('section', 'workspace-home'); home.id = 'workspace-home';
  const homeHeader = create('header', 'home-header');
  homeHeader.append(create('h1', '', '工作台'), create('p', '', '开始新任务，或处理需要你介入的事项。'));
  const environment = create('button', 'home-environment', '正在检查桌面状态');
  environment.type = 'button'; environment.onclick = () => navigate('desktop');
  const homeCurrent = create('section', 'panel home-current'); homeCurrent.setAttribute('aria-label', '当前任务');
  const recent = create('section', 'panel home-recent'); recent.setAttribute('aria-label', '最近完成');
  home.append(homeHeader, environment, composer, homeCurrent, recent); main.append(home);
  const desktopPage = create('section', 'workspace-desktop'); desktopPage.append(desktop); main.append(desktopPage);
  const connectionPanel = create('section', 'desktop-overview panel'); connectionPanel.setAttribute('aria-label', '连接检查');
  const connectionTitle = create('h1', '', '桌面连接');
  const connectionSummary = create('p', '', '正在读取连接状态'); connectionSummary.setAttribute('role', 'status');
  const recoveryHint = create('p', 'desktop-recovery-hint');
  const checkConnection = create('button', '', '刷新连接状态'); checkConnection.type = 'button';
  checkConnection.onclick = () => document.dispatchEvent(new Event('workbench:refresh-desktop'));
  const openTask = create('button', '', '查看占用任务'); openTask.type = 'button'; openTask.hidden = true;
  openTask.onclick = () => { if (state.taskId) document.dispatchEvent(new CustomEvent('workbench:open-run', { detail: `web-tasks.sqlite/${state.taskId}` })); };
  const recoverySteps = create('details', 'desktop-recovery'); recoverySteps.append(create('summary', '', '连接恢复步骤'));
  const steps = create('ol', '');
  for (const text of ['虚拟机关机时，使用下方“启动虚拟机”。', '打开虚拟机窗口，确认 Windows 已登录，AgentDesktop Worker 正在运行。', 'Worker 会自动重连。刷新状态后，确认画面为实时画面。', '如有保留任务，进入任务详情检查现场，再决定继续或停止。']) steps.append(create('li', '', text));
  recoverySteps.append(steps);
  connectionPanel.append(connectionTitle, connectionSummary, recoveryHint, checkConnection, openTask, recoverySteps);
  desktopPage.prepend(connectionPanel);
  const taskHeader = create('header', 'task-heading panel');
  const hero = detail.querySelector('.hero');
  taskHeader.append(hero.querySelector('.eyebrow'), hero.querySelector('.hero-title'), hero.querySelector('.meta'));
  const taskLayout = create('div', 'task-detail-layout');
  const scene = create('section', 'task-scene'); scene.setAttribute('aria-label', '任务现场与证据');
  const liveSlot = create('div', 'task-live-slot');
  const recorded = create('section', 'task-recorded panel'); recorded.id = 'task-recorded';
  scene.append(liveSlot, recorded); taskLayout.append(scene, hero);
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
    } catch (error) { budgetMessage.textContent = `保存失败：${error.message || error}`; }
    finally { saveBudget.disabled = false; }
  };
  settings.append($('prompt-editor')); main.append(settings);
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
  let changed = () => {};
  let routeTask = null;
  function readRoute() {
    const [path, query] = location.hash.slice(2).split('?');
    return { page: buttons.has(path) || path === 'plugins' ? path : 'live', task: new URLSearchParams(query).get('task') };
  }
  function navigate(next, task = null, fromHistory = false) {
    desktopPage.append(desktop);
    if (!buttons.has(next) && next !== 'plugins') next = 'live';
    routeTask = next === 'history' ? task : null;
    const hash = `#/${next}${routeTask ? `?${new URLSearchParams({ task: routeTask })}` : ''}`;
    if (!fromHistory && location.hash !== hash) history.pushState(null, '', hash);
    mode = next;
    workspace.hidden = next !== 'history'; settings.hidden = !['settings', 'plugins'].includes(next);
    home.hidden = next !== 'live'; desktopPage.hidden = next !== 'desktop';
    if (next === 'live') composer.prepend($('task-message'));
    else taskPane.prepend($('task-message'));
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
    for (const [id, button] of buttons) button.setAttribute('aria-current', id === (next === 'plugins' ? 'settings' : next) ? 'page' : 'false');
    title.textContent = { live: '工作台', history: '任务 / 记录与详情', desktop: '桌面 / 连接与人工控制', workflows: '流程库 / 版本与参数', plugins: '设置 / 插件与扩展', settings: '设置 / 预算与提示词' }[next];
    if (next === 'plugins') void runtimePlugins.load();
    if (next === 'workflows') void workflowLibrary.load();
    if (next === 'settings') $('prompt-editor').open = true;
    changed();
    requestAnimationFrame(() => { window.scrollTo(0, 0); main.scrollTop = 0; taskPane.scrollTop = 0; window.dispatchEvent(new Event('resize')); });
  }
  function sync(run) {
    const isActive = run && run.source === 'web-tasks.sqlite' && run.taskId === state.taskId;
    const isSubmitted = run && `${run.source}/${run.taskId}` === submittedKey;
    const hide = mode === 'live' && !isActive && !isSubmitted;
    detail.hidden = !run || hide; empty.hidden = !!run && !hide;
    empty.querySelector('h2').textContent = mode === 'history' ? routeTask ? '找不到指定任务记录' : '暂无任务记录' : '当前没有活动任务';
    empty.querySelector('p').textContent = mode === 'history' ? routeTask ? '记录可能已移除。请从任务列表选择其他记录。' : '提交任务后，可在这里查看执行结果与证据。' : '可以提交新任务，或在任务记录中查看已有结果。';
    const showLive = mode === 'history' && isActive && !['done', 'failed', 'stopped'].includes(run.status)
      && (!routeTask || routeTask === `${run.source}/${run.taskId}`);
    if (showLive) { liveSlot.append(desktop); desktop.hidden = false; }
    else { desktopPage.append(desktop); desktop.hidden = mode !== 'desktop'; }
    liveSlot.hidden = !showLive; recorded.hidden = !!showLive;
    taskLayout.classList.toggle('has-live', !!showLive);
    context.textContent = mode === 'history' ? showLive ? '当前任务 · 实时桌面与控制归属已核对' : '任务记录 · 展示历史证据，不发送桌面输入' : isSubmitted && !isActive ? '本次提交的任务 · 当前未占用桌面输入权' : '当前现场 · 服务端活动任务';
    $('task-controls').classList.toggle('workspace-suppressed', mode === 'live' && !!isActive);
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
      : state.workerReady !== true ? '先确认虚拟机已登录且 Worker 已启动，系统会自动尝试重连。'
      : stale ? 'Worker 可达，但画面尚未恢复，请等待新画面后再操作。'
      : state.taskId ? '连接已就绪。可进入占用任务查看暂停原因与恢复操作。' : '连接已就绪。可以接管桌面，或回到工作台提交任务。';
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
    submitted(key) { submittedKey = key; },
    select(runs, selected) {
      return mode === 'live' ? runs.find(run => run.source === 'web-tasks.sqlite' && run.taskId === state.taskId &&
        !['done', 'failed', 'stopped'].includes(run.status))
        || runs.find(run => `${run.source}/${run.taskId}` === submittedKey) : runs.find(run => `${run.source}/${run.taskId}` === selected);
    },
    matches(run) {
      return run.goal.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()) &&
        (filter.value === 'all' || (filter.value === 'attention' ? ['paused', 'waiting_user', 'pause_requested'].includes(run.status) : run.status === filter.value));
    },
    control(next) {
      const previousTask = state.taskId; state = next;
      environment.textContent = `桌面：${next.workerReady ? '已连接' : '未就绪'} · ${next.mode === 'STOPPED' ? '已停止，准备新任务' : next.taskId ? '有保留任务' : next.mode === 'HUMAN_CONTROL' ? '人工控制中' : '查看与管理'} →`;
      const resume = document.querySelector('[data-desktop-command="resume"]');
      resume.textContent = state.mode === 'HUMAN_CONTROL' ? '交还 Agent' : state.taskId ? '恢复执行' : '启用 Agent';
      for (const button of document.querySelectorAll('[data-desktop-command]')) {
        button.hidden = button.disabled && !['stop', 'emergency'].includes(button.dataset.desktopCommand);
      }
      if (!state.taskId && state.mode !== 'HUMAN_CONTROL') resume.hidden = true;
      freshness();
      if (mode === 'live' && previousTask !== state.taskId) changed();
    },
    frame() { frameAt = Date.now(); streamDisconnected = false; freshness(); },
    disconnected() { streamDisconnected = true; freshness(); },
  };
})();
