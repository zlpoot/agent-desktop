// Product navigation and summaries only; Task/Provider admission stays on Host.
window.createAppShell = function (navigate) {
  const make = (tag, text, cls = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = cls; return node;
  };
  const pages = [['live', '工作台', '◈'], ['history', '任务', '≡'], ['workflows', '工作流', '◇'],
    ['environments', '环境与应用', '▦'], ['settings', '设置', '⚙']];
  const sidebar = document.querySelector('.sidebar');
  const nav = make('nav', '', 'workspace-nav'); nav.setAttribute('aria-label', '主要导航');
  const buttons = new Map();
  for (const [id, label, symbol] of pages) {
    const button = make('button', ''); button.type = 'button'; button.dataset.page = id;
    const icon = make('span', symbol, 'nav-icon'); icon.setAttribute('aria-hidden', 'true');
    button.append(icon, make('span', label, 'nav-label')); button.setAttribute('aria-label', label);
    button.onclick = () => navigate(id); nav.append(button); buttons.set(id, button);
  }
  sidebar.querySelector('.brand').after(nav);
  const toggle = make('button', '收起导航', 'shell-toggle'); toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-label', '收起导航');
  toggle.onclick = () => {
    const collapsed = document.body.classList.toggle('nav-collapsed');
    toggle.textContent = collapsed ? '展开' : '收起导航';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开导航' : '收起导航');
  };
  nav.after(toggle);
  const bar = document.querySelector('.topbar');
  const environment = make('span', '执行环境：未选择', 'shell-environment'); environment.id = 'shell-environment';
  const status = make('span', '等待任务', 'shell-run-state'); status.id = 'shell-run-state';
  const settings = make('button', '打开设置', 'shell-settings'); settings.type = 'button'; settings.onclick = () => navigate('settings');
  bar.querySelector('.topbar-actions').prepend(environment, status, settings);
  const primary = page => ['desktop', 'apps', 'environments'].includes(page) ? 'environments' : page === 'plugins' ? 'settings' : page;
  return {
    readRoute() {
      const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
      const params = new URLSearchParams(query);
      const page = path === 'environments' ? params.get('view') === 'apps' ? 'apps' : 'desktop'
        : path === 'settings' && params.get('view') === 'plugins' ? 'plugins'
        : ['live', 'history', 'workflows', 'desktop', 'apps', 'plugins', 'settings'].includes(path) ? path : 'live';
      return {page, task:params.get('task')};
    },
    route(page, task) {
      const params = new URLSearchParams();
      if (page === 'apps') params.set('view', 'apps');
      if (page === 'plugins') params.set('view', 'plugins');
      if (page === 'history' && task) params.set('task', task);
      return `#/${primary(page)}${params.size ? '?' + params : ''}`;
    },
    render(page) {
      for (const [id, button] of buttons) button.setAttribute('aria-current', id === primary(page) ? 'page' : 'false');
    },
    environment(label) { environment.textContent = `执行环境：${label || '未选择'}`; },
    run(run) {
      status.textContent = !run ? '等待任务' : ({queued:'排队中', running:'执行中', pause_requested:'正在停止或暂停',
        waiting_user:'等待人工处理', paused:'已暂停', failed:'失败', stopped:'已停止', done:'已完成'})[run.status] || run.status;
    },
  };
};
