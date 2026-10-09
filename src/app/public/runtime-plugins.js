window.createRuntimePlugins = function (container) {
  const el = (tag, text, cls = '') => {
    const item = document.createElement(tag); item.textContent = text; item.className = cls; return item;
  };
  container.append(el('h1', '插件与扩展'), el('p', '查看当前 Host 装配的 Cordis 插件及业务扩展。这里只读取状态，不启停或卸载插件。'));
  const refresh = el('button', '刷新插件状态'); refresh.type = 'button';
  const status = el('p', '', 'runtime-status'); status.setAttribute('role', 'status'); status.classList.add('operation-feedback');
  const plugins = el('div', '', 'runtime-cards');
  const extensions = el('div', '', 'runtime-cards');
  container.append(refresh, status, el('h2', 'Cordis 插件'),
    el('p', '状态来自实际 Fiber。active 表示插件装载完成；Session 与目标就绪情况请查看环境与应用页。'), plugins,
    el('h2', '业务扩展 · ExtensionRegistry'), el('p', '这些扩展由基础设施插件持有，尚未拆成独立 Cordis 插件。'), extensions);
  const descriptions = { infrastructure: '基础设施：桌面、模型、存储与扩展注册表', taskController: '任务控制：提交、队列与恢复入口', taskRecovery: '启动恢复：检查并恢复已有任务状态' };
  const labels = { pending: '等待依赖', loading: '装载中', active: '已装载', failed: '装载失败', disposed: '已卸载', unloading: '卸载中', unknown: '未知' };
  let request = 0;
  async function load() {
    const current = ++request;
    status.textContent = '正在读取运行时…'; status.dataset.state = 'loading'; refresh.disabled = true; refresh.textContent = '正在刷新…';
    plugins.replaceChildren(); extensions.replaceChildren();
    try {
      const response = await fetch('/api/runtime/plugins'); const data = await response.json();
      if (current !== request) return;
      if (!response.ok) throw new Error(data.error || '读取失败');
      status.dataset.state = 'success';
      if (!data.available) { status.textContent = '此 Host 未提供 Cordis 装配快照。'; return; }
      status.textContent = `${data.plugins.length} 个装配插件 · ${data.extensions.length} 个业务扩展 · 更新于 ${new Date(data.capturedAt).toLocaleTimeString('zh-CN')}`;
      for (const plugin of data.plugins) {
        const card = el('section', '', 'panel runtime-card');
        card.append(el('h3', plugin.name), el('p', `${labels[plugin.state] || plugin.state} · ${plugin.state}`, `runtime-state ${plugin.state}`),
          el('p', descriptions[plugin.name] || (plugin.scope.startsWith('Session /') ? '桌面会话：输入控制、Worker 重连与资源释放' : '附加装配插件')),
          el('p', `作用域：${plugin.scope}`), el('p', `依赖：${plugin.dependencies.join('、') || '无声明依赖'}`),
          el('p', `提供服务：${plugin.services.join('、') || '未声明；可通过生命周期 effect 工作'}`));
        plugins.append(card);
      }
      for (const extension of data.extensions) {
        const card = el('section', '', 'panel runtime-card');
        card.append(el('h3', extension.name), el('p', extension.id), el('p', '已注册'),
          el('p', `能力：${extension.capabilities.join('、') || '无'}`),
          el('p', `场景配置：${extension.profiles.join('、') || '无'}`),
          el('p', `扩展依赖：${extension.dependsOn.join('、') || '无'}`));
        extensions.append(card);
      }
      if (!data.plugins.length) plugins.append(el('p', '暂无装配插件记录。'));
      if (!data.extensions.length) extensions.append(el('p', '暂无业务扩展注册。'));
    } catch (error) { if (current === request) { status.dataset.state = 'error'; status.textContent = `插件状态读取失败：${error.message || error}。请重试。`; } }
    finally { if (current === request) { refresh.disabled = false; refresh.textContent = status.dataset.state === 'error' ? '重试读取插件' : '刷新插件状态'; } }
  }
  refresh.onclick = load;
  return { load };
};
