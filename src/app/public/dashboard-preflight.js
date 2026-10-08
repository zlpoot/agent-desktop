(async () => {
  const status = document.getElementById('preflight-config');
  try {
    const response = await fetch('/api/dashboard/preflight');
    const view = await response.json();
    if (!response.ok || !['a1', 'a2'].includes(view.mode)) throw new Error('preflight-unavailable');
    const readonlyDiscovery = view.mode === 'a2';
    status.textContent = `主机：${view.hostLabel} · 配置：已显式加载操作员文件 · ${readonlyDiscovery ? 'A2 只读应用发现' : 'A1 预检模式'}`;
    if (readonlyDiscovery) {
      document.title = document.getElementById('preflight-title').textContent = 'Agent Desktop · 只读应用发现 A2';
      document.getElementById('preflight-boundary').textContent = '只有明确选择环境并点击扫描或指定路径，才读取应用信息；不会启动应用、发送任务、调用模型、接管输入或控制虚拟机。';
      document.getElementById('preflight-acceptance').textContent = 'A1 人工体验已通过；A2 人工体验待操作者反馈，独立审查仍待完成。A5 安全测试失败 / Windows 实验暂停 / 项目总体未完成。';
    }
    document.getElementById('preflight-workspace').textContent = view.localWorkspaceConfigured
      ? '本地隔离工作区配置已加载；尚未创建独立隐藏桌面，未验证应用目标或启动适配器。'
      : '本地隔离工作区不可用：没有配置受支持的应用；不会自动选择合成测试应用或回退本机。虚拟机环境发现未接入，不以本机安装清单代替虚拟机内的软件清单。';
    await window.createAppManagement(document.getElementById('preflight-apps'), { preflight: true, readonlyDiscovery }).load();
  } catch { status.textContent = '环境预检不可用。请检查 localhost 服务与显式配置启动命令。'; }
})();
