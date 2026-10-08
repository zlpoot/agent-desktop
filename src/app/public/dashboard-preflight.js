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
      document.getElementById('preflight-acceptance').textContent = 'A1、A2 人工体验已收到操作者通过反馈；独立审查仍待完成。A5 安全测试失败 / Windows 实验暂停 / 项目总体未完成。';
    }
    document.getElementById('preflight-workspace').textContent = view.localWorkspaceConfigured
      ? '本地隔离工作区配置已加载；尚未创建独立隐藏桌面，未验证应用目标或启动适配器。'
      : '本地隔离工作区不可用：没有配置受支持的应用；不会自动选择合成测试应用或回退本机。虚拟机环境发现未接入，不以本机安装清单代替虚拟机内的软件清单。';
    const bridgePreview = !!view.bridgePreview;
    if (bridgePreview) {
      document.title = document.getElementById('preflight-title').textContent = 'Agent Desktop · P8-B 任务桥接只读预览';
      status.textContent = `主机：${view.hostLabel} · 配置：已显式加载操作员文件 · P8-B 只读预览`;
      document.getElementById('preflight-boundary').textContent = '本页只解释所选环境的桥接缺口并展示拟议步骤，不扫描安装清单，不确认、启动、运行任务或发送输入。';
      document.getElementById('preflight-acceptance').textContent = 'P8-B 尚未完成人工验收及独立审查。P8-A 人工反馈仅覆盖本机只读体验和未配置工作区诊断。A5 安全测试失败 / Windows 实验暂停 / 项目总体未完成。';
      const element = (tag, text) => { const item = document.createElement(tag); item.textContent = text; return item; };
      const panel = element('section', ''); panel.id = 'bridge-test-preview';
      panel.append(element('h2', '拟议受控测试预览（不会执行）'), element('p', '以下候选只供反馈，与上方环境选择分开；不自动选择或绑定真实目标。'));
      const candidate = view.bridgePreview;
      panel.append(element('p', `候选环境：${candidate.environment}\n候选应用：${candidate.application} · 限定版本：${candidate.applicationVersion}\n机制：${candidate.mechanism}`));
      panel.append(element('p', candidate.targetStatus));
      const table = element('table', ''), body = element('tbody', '');
      for (const [stage, explanation] of [
        ['发现候选', '本页不扫描，当前没有读取安装清单；发现软件不代表已确认或允许启动。'],
        ['历史启动验证', '本页不导入私有应用信任记录。即使已有历史启动验证，也不证明原进程仍在，更不授予本次启动许可。'],
        ['任务桥接', '不可用：同签发者原实例解析和应用撤销后的原生效果栅栏未证明；不会回退普通运行时。'],
        ['受控实测', '尚未授权：必须另行核对并授权准确环境、版本、动作和时间窗口；本页不会派发。'],
      ]) { const row = element('tr', ''); row.append(element('th', stage), element('td', explanation)); body.append(row); }
      table.append(body); panel.append(table);
      const actions = element('ol', ''); for (const action of candidate.actions) actions.append(element('li', `拟议：${action}`));
      panel.append(actions, element('p', candidate.consent));
      document.getElementById('preflight-apps').after(panel);
    }
    await window.createAppManagement(document.getElementById('preflight-apps'), { preflight: true, readonlyDiscovery, bridgePreview }).load();
  } catch { status.textContent = '环境预检不可用。请检查 localhost 服务与显式配置启动命令。'; }
})();
