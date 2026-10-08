(async () => {
  const status = document.getElementById('preflight-config');
  try {
    const response = await fetch('/api/dashboard/preflight');
    const view = await response.json();
    if (!response.ok || view.mode !== 'a1') throw new Error('preflight-unavailable');
    status.textContent = `主机：${view.hostLabel} · 配置：已显式加载操作员文件 · A1 预检模式`;
    document.getElementById('preflight-workspace').textContent = view.localWorkspaceConfigured
      ? 'Local Workspace 配置已加载；未创建 Hidden Desktop，未验证目标或启动适配器。'
      : 'Local Workspace 不可用：没有配置受支持的应用；不会自动选择夹具或回退本机。VM discovery 未接入，不读取 Host 安装清单代替 Guest。';
    await window.createAppManagement(document.getElementById('preflight-apps'), { preflight: true }).load();
  } catch { status.textContent = '环境预检不可用。请检查 localhost 服务与显式配置启动命令。'; }
})();
