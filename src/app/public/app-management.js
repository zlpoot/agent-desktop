window.createAppManagement = (root) => {
  const node = (tag, text, id) => {
    const item = document.createElement(tag); if (text) item.textContent = text; if (id) item.id = id; return item;
  };
  root.id = 'app-management';
  const environment = node('select', '', 'apps-environment'); environment.setAttribute('aria-label', '应用执行环境');
  const status = node('p', '先选择执行环境；不会自动扫描或启动。', 'apps-status'); status.setAttribute('role', 'status');
  const controls = node('div'); controls.className = 'app-onboarding-actions';
  const path = node('input', '', 'apps-path'); path.maxLength = 1024; path.placeholder = '该环境内的 .exe / .lnk 路径'; path.setAttribute('aria-label', '应用路径');
  const candidates = node('select', '', 'apps-candidate'); candidates.setAttribute('aria-label', '发现候选');
  const identity = node('pre', '', 'apps-identity');
  const confirmation = node('section', '', 'apps-confirmation');
  const registered = node('div', '', 'apps-registered');
  const capability = node('p', '', 'apps-capability');
  const help = node('details'); help.append(node('summary', '第一次使用与失败处理'));
  for (const text of [
    '选环境 → 下达任务 / 扫描应用 → 选择并首次确认候选 → 验证启动 → 保存配置 → 回到原任务。同环境有效配置后续不再确认。',
    '同名多版本请核对路径、版本、发布者和来源；唯一候选也需要明确选择。已运行的合法实例会先核对并复用。',
    '找不到时指定所选环境内的路径，或自行安装后重扫。扫描不完整、权限不足和离线不表示未安装。',
    '离线保留原确认；版本或启动路径/参数改变应重扫并重新确认验证。启动失败先查看原因，不盲目重试结果未知的启动。',
    '撤销仅移除本项目配置的信任，不卸载软件、不关闭用户进程，旧 Task 审计保留。刷新或环境切换会丢弃页面确认；Host 重启不会重放旧 Task。',
    '启动成功不证明业务支持。Physical generic 不支持；Native Physical 缺可信 dispatch fence 时拒绝新启动；Local Workspace 需要 managed backend 与 owned Hidden Desktop binding；真实 Task 还需要可信 bridge。RAW、Notepad、QQ音乐及未知应用只按已有 P6 证据开放有限场景。',
    '旧 JSON 由可信操作员使用 P7-A importLegacyApps，明确指定环境和来源；导入仅为 discovered，仍需检查、确认与验证。不要把 JSON 上传到普通 Task 接口。',
    '当前合成验收 NOT LIVE-VERIFIED；A5 safety FAIL / Windows PAUSED / overall INCOMPLETE。',
  ]) help.append(node('p', text));
  root.append(node('h1', '应用管理'), environment, status, capability, controls, path,
    node('h2', '发现候选'), candidates, identity, confirmation, node('h2', '已注册配置与验证历史'), registered, help);
  const launchText = spec => spec.kind === 'package'
    ? `启动类型：MSIX/AppX（没有适配时不可启动）\n包身份：${spec.packageFamilyName}\n应用标识：${spec.applicationUserModelId}`
    : `启动类型：${spec.kind === 'shortcut' ? '本地快捷方式' : 'Win32 EXE'}\n路径：${spec.executable}\n${spec.kind === 'shortcut' ? `快捷方式：${spec.shortcutPath}\n` : ''}参数：${spec.args.join(' | ') || '无'}\n工作目录：${spec.workingDirectory || '默认'}`;
  let version = 0, state, busy = false, loaded = false;
  const buttons = [];
  function button(label, action, parent = controls) {
    const item = node('button', label); item.type = 'button'; item.onclick = action; parent.append(item); return item;
  }
  const scan = button('扫描 / 重扫', () => act('scan'));
  const manual = button('指定路径', () => act('path', { path: path.value }));
  const refresh = button('刷新配置', () => act('list'));
  const prepare = button('查看确认内容', () => {
    const selected = state?.candidates.find(item => item.candidateId === candidates.value);
    if (selected) void act('prepare', { candidateId: selected.candidateId, candidateRevision: selected.revision });
  });
  const cancel = button('取消本次接入', () => reset());
  buttons.push(scan, manual, refresh, prepare);
  const target = () => environment.value ? { providerId: JSON.parse(environment.value)[0], environmentId: JSON.parse(environment.value)[1] } : undefined;
  async function post(body, keepalive = false) {
    const response = await fetch('/api/desktop/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
  }
  function end(old) {
    if (old) void post({ action: 'close', desktopTarget: old.desktopTarget, sessionId: old.sessionId,
      revision: old.revision, requestId: crypto.randomUUID() }, true).catch(() => {});
  }
  function reset(clearSelection = true) {
    version++; const old = state; state = undefined; busy = false; path.value = '';
    if (clearSelection) environment.value = '';
    end(old); render(); status.textContent = '先选择执行环境；不会自动扫描或启动。';
  }
  async function select() {
    reset(false); const selected = target(); if (!selected) return;
    const current = version; busy = true; render(); status.textContent = '正在读取所选环境配置…';
    try {
      const result = await post({ action: 'open', desktopTarget: selected });
      if (current !== version) { end(result); return; }
      state = result; status.textContent = '配置已读取。扫描和启动必须由你显式操作。';
    } catch (error) { if (current === version) status.textContent = `环境管理不可用：${error.message}。请检查可信装配与连接后重新选择环境。`; }
    finally { if (current === version) { busy = false; render(); } }
  }
  async function act(action, extra = {}) {
    if (!state || busy) return;
    const current = version, snapshot = state;
    busy = true; render(); status.textContent = '操作处理中…';
    try {
      const result = await post({ action, desktopTarget: snapshot.desktopTarget, sessionId: snapshot.sessionId,
        revision: snapshot.revision, requestId: crypto.randomUUID(), ...extra });
      if (current !== version) return;
      state = result;
      status.textContent = result.report ? `扫描：${result.report.status} · ${result.report.reason || (result.candidates.length ? '请明确选择候选' : '仅在已扫描来源中未找到，可指定路径或安装后重扫')}` : '配置已更新';
    } catch (error) {
      if (current === version) status.textContent = `操作被拒绝：${error.message}。先刷新配置；候选或环境发生变化时重新选择并扫描，不自动重试启动。`;
    } finally { if (current === version) { busy = false; render(); } }
  }
  function render() {
    for (const item of buttons) item.disabled = !state || busy;
    path.disabled = !state || busy; cancel.disabled = !state && !busy;
    scan.disabled ||= !state?.readiness.discovery; manual.disabled ||= !state?.readiness.discovery;
    prepare.disabled ||= !candidates.value || !state?.readiness.controlledLaunch;
    const previous = candidates.value; candidates.replaceChildren(node('option', '请选择具体安装实例'));
    candidates.firstChild.value = '';
    for (const item of state?.candidates || []) {
      const option = node('option', `${item.candidate.displayName} · ${item.version || '版本未知'} · ${item.publisher || '发布者未知'} · ${item.sources.join(', ')}`);
      option.value = item.candidateId; candidates.append(option);
    }
    candidates.value = previous; candidates.disabled = !state || busy;
    const selected = state?.candidates.find(item => item.candidateId === candidates.value);
    const existing = selected && state.registered.find(app => app.installationId === selected.candidate.installationId &&
      app.validity === 'current' && app.trust !== 'discovered' && app.identity?.fingerprint === selected.contentFingerprint &&
      (!selected.version || app.identity.version === selected.version) && JSON.stringify(app.launchSpec) === JSON.stringify(selected.candidate.launchSpec));
    identity.textContent = selected ? `名称：${selected.candidate.displayName}\n别名：${selected.candidate.aliases.join('、') || '无'}\n版本：${selected.version || '未知'} · 发布者：${selected.publisher || '未知'}\n来源：${selected.sources.join('、')}\n安装实例：${selected.candidate.installationId}\n${launchText(selected.candidate.launchSpec)}\n状态：discovered（仅发现，尚未确认此候选）\n限制：${selected.limitation || '业务能力仍须独立证明'}` : '';
    if (existing) identity.textContent += '\n已保存同一配置：无需重复确认，请使用下方配置的重新验证启动。';
    prepare.disabled = !selected || busy || !state?.readiness.controlledLaunch || !!existing;
    capability.textContent = state ? `${state.scope.providerId} / ${state.scope.environmentId} · 安装域 ${state.scope.installationScopeId}\n发现适配：${state.readiness.discovery}；受控启动端口：${state.readiness.controlledLaunch}；Task 兼容准入：${state.readiness.taskCompatibility} ${state.readiness.blockedReason || ''}\nBusiness-capable：not-proven。启动验证不会升级 P6 业务证据；Task 仍需可信 bridge，以及原有能力、风险、预算、输入权和独立结果验证。\nP6 有限场景（仍需独立准入）：${state.readiness.scenarios.map(item => `${item.label}：${item.availability} ${item.reason || ''} · ${item.application || '限定应用'} ${item.applicationVersion || '限定版本'}`).join('；') || '无已装配场景'}\n安装来源：${state.report?.installationOrigin || '尚未扫描'}\n扫描来源覆盖：${state.report?.coverage.map(item => `${item.source}：${item.status} ${item.reason || ''}`).join('；') || '尚无来源覆盖记录'}` : '';
    confirmation.replaceChildren();
    if (state?.confirmation) {
      confirmation.append(node('h3', '请核对并明确授权本环境启动验证'), node('pre', `应用：${state.confirmation.displayName} · ${state.confirmation.version} · ${state.confirmation.publisher}\n环境：${state.confirmation.scope.environmentId}\n来源：${state.confirmation.sources.join('、')}\n${launchText(state.confirmation.launchSpec)}\n配置版本：${state.confirmation.profileRevision}\n此操作会保存确认并执行受控启动验证；不会授权业务动作。`));
      const confirm = button('确认并验证启动', () => act('confirm', { confirmationId: state.confirmation.confirmationId, digest: state.confirmation.digest, allowLaunch: true }), confirmation);
      confirm.disabled = busy;
    }
    registered.replaceChildren();
    for (const app of state?.registered || []) {
      const card = node('article'); card.className = 'apps-profile';
      const confirmed = app.validity === 'current' && app.confirmations.some(item => item.profileRevision === app.profileRevision && item.profileDigest === app.profileDigest);
      const last = app.verifications.at(-1);
      const discovery = state.candidates.find(item => item.candidate.installationId === app.installationId);
      card.append(node('h3', app.displayName), node('p', `discovered · confirmed: ${confirmed} · launch-verified: ${app.trust === 'verified' && app.validity === 'current' && app.availability === 'available'} · business-capable: not-proven`),
        node('p', `别名：${app.aliases.join('、') || '无'} · 版本：${app.identity?.version || '未知'} · 发布者：${discovery?.publisher || '未保存，扫描后可查看'}\n来源：${app.source.reference} · 启动类型：${app.launchSpec.kind}\n安装实例：${app.installationId}`),
        node('p', `配置修订 ${app.profileRevision} / 记录修订 ${app.revision} · ${app.validity} · ${app.availability} · ${app.lastError || ''}`),
        node('p', `最近启动验证（历史记录，不代表当前运行目标）：${last?.checkedAt || '尚未验证'} · ${last?.result || 'not-proven'} · ${last?.reason || ''}`));
      const details = node('details'); details.append(node('summary', '安装身份、配置与历史（可信操作员）'), node('pre', JSON.stringify(app, null, 2))); card.append(details);
      const verify = button('重新验证启动（允许受控启动）', () => act('verify', { appBindingId: app.appBindingId, expectedRevision: app.revision, allowLaunch: true }), card);
      verify.disabled = busy || !confirmed || !state.readiness.controlledLaunch;
      const revoke = button('撤销注册', () => act('revoke', { appBindingId: app.appBindingId, expectedRevision: app.revision }), card);
      revoke.disabled = busy || app.validity === 'revoked';
      registered.append(card);
    }
  }
  candidates.onchange = render; environment.onchange = () => { void select(); };
  window.addEventListener('pagehide', () => reset());
  render();
  return { async load() {
    if (loaded) return; loaded = true;
    environment.replaceChildren(node('option', '请选择执行环境')); environment.firstChild.value = '';
    try {
      const response = await fetch('/api/desktop/environments'); const result = await response.json();
      if (!response.ok) throw new Error(result.error || '环境不可用');
      for (const item of result.environments) {
        const option = node('option', `${({ physical: '本机交互桌面', 'virtual-machine': '虚拟机', 'local-workspace': '本地隔离工作区' })[item.kind] || '执行环境'} · ${item.environmentId}${item.blockedReason ? ` · ${item.blockedReason}` : ''}`);
        option.value = JSON.stringify([item.providerId, item.environmentId]); environment.append(option);
      }
    } catch (error) { loaded = false; status.textContent = `读取环境失败：${error.message}`; }
  }, leave() { reset(); } };
};
