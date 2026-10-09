// Read-only directory. Catalog availability never grants Session, target or input readiness.
window.createEnvironmentCatalog = (root, openApps) => {
  const el = (tag, text, cls = '') => { const node = document.createElement(tag); node.textContent = text; node.className = cls; return node; };
  const kinds = { physical: 'Physical Desktop · 本机桌面', 'virtual-machine': 'Virtual Machine · 虚拟机', 'local-workspace': 'Local Workspace · 隔离工作区' };
  const states = { supported: '已声明支持', unsupported: '不支持', 'not-proven': '尚未验证', forbidden: '禁止使用', unavailable: '当前不可用' };
  const refresh = el('button', '刷新环境目录'); refresh.type = 'button';
  const search = el('input', ''); search.type = 'search'; search.placeholder = '搜索 Provider 或环境 ID'; search.setAttribute('aria-label', '搜索执行环境');
  const filter = el('select', ''); filter.setAttribute('aria-label', '环境类型');
  for (const [value, label] of [['all', '所有环境类型'], ...Object.entries(kinds)]) { const option = el('option', label); option.value = value; filter.append(option); }
  const toolbar = el('div', '', 'catalog-toolbar'); toolbar.append(search, filter, refresh);
  const status = el('p', '打开环境页后读取目录，不启动应用或获取输入权。', 'operation-feedback'); status.setAttribute('role', 'status');
  const cards = el('div', '', 'environment-cards');
  const legend = el('details', '', 'capability-legend'); legend.append(el('summary', '能力声明与当前就绪的区别'));
  for (const [state, explanation] of [['supported', '仅在声明范围内支持，不证明当前目标或输入权就绪。'], ['unsupported', '未实现，增加授权不能获得该能力。'], ['not-proven', '证据不足，不能按支持处理。'], ['forbidden', '策略禁止，即使有实现也不允许调用。']]) legend.append(el('p', `${state} · ${states[state]}：${explanation}`));
  root.classList.add('environment-catalog'); root.setAttribute('aria-label', '执行环境目录');
  root.append(el('h1', '环境与应用'), el('p', '同一目录组织三类环境；通用任务准入、有限场景、连接、应用与输入许可分别核对。'), toolbar, status, legend, cards);
  let environments = [], sessions = [], sessionError = '', request = 0;
  function render() {
    cards.replaceChildren();
    const visible = environments.filter(item => (filter.value === 'all' || filter.value === item.kind) && `${item.providerId} ${item.environmentId}`.toLowerCase().includes(search.value.toLowerCase()));
    if (!visible.length) cards.append(el('p', environments.length ? '没有匹配环境，请调整搜索或类型。' : '目录中没有已注册环境；没有自动创建或连接。'));
    for (const item of visible) {
      const card = el('article', '', 'environment-card panel');
      card.append(el('h2', item.environmentId === 'local-workspace:chrome' ? 'Hidden Workspace Chrome' : kinds[item.kind] || '未知环境类型'), el('p', `${item.providerId} / ${item.environmentId}`, 'environment-identity'),
        el('p', item.executable ? '通用任务接口：允许提交；运行前仍须后台检查。' : `通用任务接口：未开放。${item.blockedReason || '未记录具体原因'}`));
      // Records do not expose active ownership. Preserve every match; never pick a current Session.
      const bound = sessions.filter(session => {
        if (Object.hasOwn(session, 'providerId') || Object.hasOwn(session, 'environmentId')) {
          return session.providerId === item.providerId && session.environmentId === item.environmentId;
        }
        return item.providerId === 'hyper-v' && item.kind === 'virtual-machine' && session.vmId && item.environmentId === `vm:${session.vmId}`;
      });
      card.append(el('p', bound.length ? `${bound.length} 条匹配 Session 记录；活跃归属 UNKNOWN，不能从记录顺序或连接状态判定当前 Session。` : `Session：未记录匹配绑定，连接状态 UNKNOWN。${sessionError}`));
      if (bound.length) {
        const history = el('ul', '', 'environment-sessions'); history.setAttribute('aria-label', '匹配 Session 记录');
        for (const session of bound) history.append(el('li', `已记录 Session：${session.sessionId} · 连接 ${session.status || '未知'} · 创建：${session.createdAt || '未记录'} · 最近联系：${session.lastSeenAt || '未记录'}${session.lastError ? ' · 错误：' + session.lastError : ''}`));
        card.append(history);
      }
      card.append(el('p', 'Target readiness / 输入权：目录未提供当次目标证明，不能从环境类型、通用准入、Session 连接状态或其它 Guest 状态推断。'));
      const scenes = el('ul', '', 'environment-scenarios');
      for (const scene of item.scenarios || []) scenes.append(el('li', `${scene.label} · ${states[scene.availability] || '状态未知'} (${scene.availability})${scene.reason ? ' · ' + scene.reason : ''}`));
      card.append(el('h3', '有限场景声明'), scenes);
      if (!item.scenarios?.length) card.append(el('p', '未记录有限场景；不代表任意应用可操作。'));
      card.append(el('p', 'Provider 基础能力明细：目录未提供；不得把通用准入当作 supported 声明。应用发现、历史启动验证与业务能力仍需分别核对。'));
      const apps = el('button', '查看此环境的应用'); apps.type = 'button'; apps.onclick = () => openApps({ providerId: item.providerId, environmentId: item.environmentId }); card.append(apps);
      cards.append(card);
    }
  }
  async function load() {
    const current = ++request; environments = []; sessions = []; sessionError = ''; cards.replaceChildren();
    status.textContent = '正在读取环境目录与已记录 Session…'; status.dataset.state = 'loading'; refresh.disabled = true;
    try {
      const [directory, connections] = await Promise.allSettled([
        fetch('/api/desktop/environments').then(async response => { const data = await response.json(); if (!response.ok || !Array.isArray(data.environments)) throw new Error(data.error || '目录读取失败'); return data.environments; }),
        fetch('/api/desktop/sessions').then(async response => { const data = await response.json(); if (!response.ok || !Array.isArray(data.sessions)) throw new Error('Session 读取失败'); return data.sessions; }),
      ]);
      if (current !== request) return;
      if (directory.status === 'rejected') throw directory.reason;
      const seen = new Set();
      for (const item of directory.value) {
        const key = JSON.stringify([item.providerId, item.environmentId]);
        if (typeof item.providerId !== 'string' || !item.providerId || typeof item.environmentId !== 'string' || !item.environmentId || typeof item.executable !== 'boolean' || seen.has(key)) throw new Error('环境目录身份或准入数据无效');
        seen.add(key);
      }
      environments = directory.value;
      if (connections.status === 'fulfilled') sessions = connections.value;
      else sessionError = 'Session 读取失败，请刷新核对；不据此判断其它环境离线。';
      status.dataset.state = 'success'; status.textContent = `${environments.length} 个已注册环境；仅目录查询。${sessionError}`; render();
    } catch (error) { if (current === request) { status.dataset.state = 'error'; status.textContent = `环境目录读取失败：${error.message || error}。请刷新重试。`; } }
    finally { if (current === request) refresh.disabled = false; }
  }
  search.oninput = filter.onchange = render; refresh.onclick = load;
  return { load, leave() { request++; refresh.disabled = false; } };
};
