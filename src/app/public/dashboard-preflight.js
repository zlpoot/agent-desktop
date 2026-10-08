(async () => {
  const status = document.getElementById('preflight-config');
  try {
    const response = await fetch('/api/dashboard/preflight');
    const view = await response.json();
    if (!response.ok || view.mode !== 'a1') throw new Error('preflight-unavailable');
    status.textContent = `主机：${view.hostLabel} · 配置：已显式加载操作员文件 · A1 预检模式`;
    document.getElementById('preflight-workspace').textContent = view.localWorkspaceConfigured
      ? '本地隔离工作区配置已加载；尚未创建独立隐藏桌面，未验证应用目标或启动适配器。'
      : '本地隔离工作区不可用：没有配置受支持的应用；不会自动选择合成测试应用或回退本机。虚拟机环境发现未接入，不以本机安装清单代替虚拟机内的软件清单。';
    await window.createAppManagement(document.getElementById('preflight-apps'), { preflight: true }).load();
  } catch { status.textContent = '环境预检不可用。请检查 localhost 服务与显式配置启动命令。'; }
})();
