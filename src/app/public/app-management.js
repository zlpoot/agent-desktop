window.createAppManagement = (root, options = {}) => {
  const preflight = options.preflight === true;
  const readonlyDiscovery = preflight && options.readonlyDiscovery === true;
  const bridgePreview = preflight && options.bridgePreview === true;
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
  const phases = node('section', '', 'apps-phases'); phases.className = 'apps-phases'; phases.setAttribute('aria-label', '应用接入事实');
  const capabilityDetails = node('section', '', 'apps-capability-details'); capabilityDetails.hidden = true;
  const lookup = (table, key) => Object.hasOwn(table, key) ? table[key] : undefined;
  const search = node('input', '', 'apps-search'); search.placeholder = '输入应用名称筛选已扫描结果，不会再次扫描'; search.setAttribute('aria-label', '筛选已扫描应用');
  search.maxLength = 256; search.hidden = !readonlyDiscovery;
  const reportView = node('section', '', 'apps-scan-report'); reportView.hidden = true;
  const sourceNames = { 'start-menu-user': '当前用户开始菜单', 'start-menu-public': '所有用户开始菜单',
    'app-paths-hkcu': '当前用户应用路径登记', 'app-paths-hklm-32': '系统应用路径登记（32 位）',
    'app-paths-hklm-64': '系统应用路径登记（64 位）', 'manual-path': '操作者指定的本地路径',
    'environment-discovery': '所选环境的收集器' };
  const sourceText = sources => sources.map(source => lookup(sourceNames, source) || '其他只读来源（见技术详情）').join('、');
  const scanStates = { complete: '已完整读取限定来源', incomplete: '读取不完整', unavailable: '读取不可用' };
  const coverageStates = { complete: '已完成', truncated: '达到读取限制或部分条目被拒绝', timeout: '读取超时', unavailable: '无法完整读取' };
  function scanReason(reason) {
    if (!reason) return '';
    if (reason.includes('identity')) return '安装域身份无法核对或发生变化，已拒绝结果；请刷新配置，检查可信配置后重启服务。';
    if (reason.includes('FileNotFoundError')) return '文件或来源不存在，请检查所选环境中的路径。';
    if (reason.includes('PermissionError')) return '没有读取权限；请检查该来源的权限。';
    if (reason.includes('timeout')) return '达到读取时间限制，可查看已有来源覆盖后手动重扫。';
    if (reason.includes('limit') || reason.includes('incomplete')) return '部分来源达到读取限制或不可读取；结果不能证明应用没有安装。';
    if (reason.includes('unsupported') || reason.includes('invalid-')) return '该文件、路径或快捷方式不在安全读取范围内；只支持本地固定磁盘上的安全 EXE 和快捷方式。';
    if (reason.includes('windows-app-scanner')) return 'Windows 收集器不可用，请检查所指定 Python 的依赖后重启服务。';
    return '该来源或条目无法安全读取；请检查来源、权限和依赖。原始原因见技术详情。';
  }
  function pathReason(reason) {
    if (!reason) return '';
    if (reason.includes('FileNotFoundError')) return '路径不存在：请核对文件名和所选环境中的完整路径。';
    if (reason.includes('PermissionError')) return '拒绝访问：没有读取该路径的权限，请检查文件或目录权限。';
    if (reason.includes('unsupported-app-file-type')) return '不支持该文件类型：请指定 .exe 或 .lnk 文件。';
    if (reason.includes('unsupported-nonlocal-drive') || reason.includes('unsupported-shortcut-volume') ||
        reason.includes('unsupported-shortcut-network')) return '不支持该位置：仅支持本地固定磁盘，不支持网络盘、可移动盘或指向网络位置的快捷方式。';
    if (reason.includes('unsupported-local-app-path')) return '路径格式不受支持：请使用本地磁盘上的绝对路径，不支持网络路径、相对路径或附加命令。';
    if (reason.includes('unsupported-reparse-path')) return '不支持重定向路径：文件或所在目录是重解析点或符号链接，请选择安全的本地文件。';
    if (reason.includes('app-path-is-directory')) return '该路径是目录：请选择具体的 .exe 或 .lnk 文件。';
    if (reason.includes('app-path-not-file')) return '该路径不是可读取的普通文件，请选择具体的 .exe 或 .lnk 文件。';
    if (reason.includes('invalid-executable-header')) return '文件不是有效的 EXE，不能作为应用候选读取。';
    if (reason.includes('app-target-exceeds-read-limit')) return '文件大小超过本轮读取上限，无法检查此候选。';
    if (reason.includes('unsupported-app-wrapper')) return '不支持脚本包装器或该快捷方式目标，请选择应用本身的安全 EXE。';
    return scanReason(reason);
  }
  const capabilityNames = {
    'observation.pixels': ['窗口画面读取', '读取环境或目标窗口的截图，用于查看画面。此能力本身不执行点击或输入。'],
    'observation.accessibility': ['控件信息读取', '读取应用提供的按钮、输入框、名称和位置等辅助功能信息；具体控件是否能可靠读取仍需核验。'],
    'isolation.separateDesktop': ['独立桌面隔离', '在与日常桌面分开的桌面中运行应用。同一台电脑上的独立桌面仍可能共享操作系统和登录会话。'],
    'isolation.separateOs': ['独立操作系统隔离', '应用运行在独立的操作系统环境中，例如虚拟机；需要单独证明该环境的身份与隔离边界。'],
    'isolation.sharedUserSession': ['共享登录会话', '沿用当前用户的登录会话，可能共享账户和系统资源。这项支持不代表与用户操作完全隔离。'],
    'input.rawIsolated': ['原始键鼠输入隔离', '处理某些游戏等应用使用的原始键鼠事件，并确保输入只送达隔离目标；必须有相应隔离证据。'],
    'input.semantic': ['按控件含义操作', '通过控件接口设置文本或选择控件，例如向已核对的搜索框填写文字；支持范围取决于具体应用、控件和版本。'],
    'input.targetedWindow': ['向指定窗口发送输入', '将操作发送给已绑定的目标窗口；必须核对窗口归属，且不能由此推断任意应用都能处理这些输入。'],
    'input.globalInput': ['系统全局键鼠输入', '通过系统输入通道发送键鼠事件，可能受前台焦点影响并干扰日常操作；是否允许由安全策略单独决定。'],
    'control.humanTakeover': ['人工接管控制', '在项目管理的控制通道中把控制权交给操作者；不代表已经证明所有真实硬件输入都能安全并行。'],
    'control.resumable': ['暂停后恢复控制', '重新核对身份、现场与权限后恢复受控执行；结果未知的旧动作不能自动重放。'],
    'control.leaseProtected': ['限时控制权限保护', '控制权限带有有效期和身份校验；过期或撤销后应拒绝旧控制方的新操作。'],
  };
  const capabilityStates = {
    supported: ['已声明支持', '环境提供方声明已实现，但只限声明范围；仍需连接实际环境、核对目标并取得操作权限。'],
    'not-proven': ['尚未验证', '证据不足，尚不能证明这项能力在相应范围内可用或安全，不能按已支持使用。'],
    unsupported: ['不支持', '该环境没有提供这项能力；选择环境或增加操作许可不会自动获得它。'],
    forbidden: ['禁止使用', '当前安全策略禁止调用；即使存在技术实现，也不能作为允许操作的依据。'],
  };
  const scopeNames = { providerId: '环境提供方', environmentKind: '环境类型', application: '应用',
    applicationVersion: '应用版本', targetRole: '目标控件', action: '操作', mechanism: '实现方式' };
  const environmentNames = { 'current-interactive-desktop': '当前登录的系统桌面',
    'local-workspace:netease': '网易云音乐限定工作区', 'local-workspace:fixture': '合成测试工作区' };
  const scopeValues = {
    physical: '本机交互桌面', 'hyper-v': '虚拟机', 'virtual-machine': '虚拟机', 'local-workspace': '本地隔离工作区',
    'netease-cloud-music': '网易云音乐', 'd0-synthetic-fixture': '合成测试应用',
    'owned-main-window': '已核对归属的主窗口', 'search-editor': '搜索输入框', 'playback-button': '播放按钮',
    'fixture-editor': '合成测试输入框', 'fixture-button': '合成测试按钮',
    observe: '读取画面或信息', 'run-validated-scenario': '执行已验证的有限场景', 'viewer-click': '操作者点击', 'viewer-edit': '操作者编辑文本',
    'local-window': '本机窗口接口', 'local-uia': '本机辅助功能接口', 'physical-context': '本机交互桌面上下文',
    'physical-policy': '本机输入安全策略', 'managed-client': '项目管理的控制通道',
    'd0-local-workspace': '已有有限工作区实现', 'uia-valuepattern': '辅助功能文本设置接口',
    'uia-control-selection': '辅助功能控件选择接口', 'uia-owned-descendants': '已核对归属的控件读取',
    'owned-hwnd-message': '向已核对归属的窗口发送消息', 'owned-hwnd-char': '向已核对归属的窗口发送字符',
    'win32-hidden-desktop': '独立隐藏桌面', 'same-windows-session': '同一个系统登录会话', 'system-input': '系统输入通道',
    'raw-hidden-desktop-input': '隐藏桌面原始输入', 'd0-owner-epoch-and-viewer-lease': '控制归属、代次与限时权限校验',
    'guest-frame': '虚拟机内画面读取', 'host-global-fallback': '回退宿主机全局输入', 'legacy-control': '既有受控通道',
  };
  function scopeText(scope) {
    const fields = Object.entries(scope || {});
    return fields.length ? fields.map(([key, values]) => `${lookup(scopeNames, key) || '其他限制'}：${values.length
      ? values.map(value => key === 'applicationVersion' ? value : lookup(scopeValues, value) || '指定值（见技术标识）').join('、')
      : '没有允许值（不能据此准入）'}`).join('\n') : '未列出范围限制；实际使用仍须核对目标与权限。';
  }
  function renderCapabilities(info) {
    capabilityDetails.hidden = false;
    capabilityDetails.append(node('h2', '环境提供方的能力声明'),
      node('p', `这里描述提供方已实现的能力及适用范围，不是当前机器、应用已经就绪的证明。${readonlyDiscovery ? '本轮扫描仅使用独立的只读收集器，以下声明不会开放启动或输入。' : '本轮仅做环境预检，以下声明不会开放扫描、启动或输入。'}`));
    const legend = node('dl'); legend.className = 'apps-capability-legend';
    for (const [label, explanation] of Object.values(capabilityStates)) legend.append(node('dt', label), node('dd', explanation));
    capabilityDetails.append(legend);
    const wrapper = node('div'); wrapper.className = 'apps-capability-table';
    const table = node('table'); table.append(node('caption', '同一能力的不同应用、版本或操作范围分别列出，不能相互套用。'));
    const head = node('thead'), headings = node('tr');
    for (const label of ['能力', '声明状态', '能力说明', '适用范围']) { const cell = node('th', label); cell.scope = 'col'; headings.append(cell); }
    head.append(headings); table.append(head); const body = node('tbody');
    for (const [key, declarations] of Object.entries(info.capabilities)) {
      const [label, explanation] = lookup(capabilityNames, key) || ['未识别的能力', '尚无对应说明，不能自动推断其可用性；原始标识保留在下方供排查。'];
      for (const declaration of declarations.length ? declarations : [{ state: 'undeclared', scope: {} }]) {
        const stateLabel = lookup(capabilityStates, declaration.state)?.[0] || '未知或未声明';
        const row = node('tr'), title = node('th', label); title.scope = 'row';
        row.append(title, node('td', stateLabel), node('td', explanation), node('td', scopeText(declaration.scope))); body.append(row);
      }
    }
    if (!Object.keys(info.capabilities).length) capabilityDetails.append(node('p', '尚无能力声明，不能据此开放操作。'));
    table.append(body); wrapper.append(table); capabilityDetails.append(wrapper);
    const diagnostics = node('details'); diagnostics.append(node('summary', '技术标识（仅排查问题时使用）'),
      node('pre', JSON.stringify({ providerId: state.scope.providerId, environmentId: state.scope.environmentId, capabilities: info.capabilities }, null, 2), 'apps-capability-diagnostics'));
    capabilityDetails.append(diagnostics);
  }
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
  root.append(node('h1', '应用管理'), node('p', '应用发现、明确确认、历史启动验证与业务操作分别记录；路径和身份详情仅供本机核对。'), environment, status, phases, capability, controls, path, capabilityDetails,
    node('h2', '发现候选'), search, reportView, candidates, identity, confirmation, node('h2', '已注册配置与验证历史'), registered, help);
  const launchText = spec => spec.kind === 'package'
    ? `启动类型：MSIX/AppX（没有适配时不可启动）\n包身份：${spec.packageFamilyName}\n应用标识：${spec.applicationUserModelId}`
    : `启动类型：${spec.kind === 'shortcut' ? '本地快捷方式' : 'Win32 EXE'}\n路径：${spec.executable}\n${spec.kind === 'shortcut' ? `快捷方式：${spec.shortcutPath}\n` : ''}参数：${spec.args.join(' | ') || '无'}\n工作目录：${spec.workingDirectory || '默认'}`;
  let version = 0, state, busy = false, loaded = false, lastAction;
  const buttons = [];
  function button(label, action, parent = controls) {
    const item = node('button', label); item.type = 'button'; item.onclick = action; parent.append(item); return item;
  }
  const scan = button('扫描 / 重扫', () => act('scan'));
  const manual = button('指定路径', () => act('path', { path: path.value }));
  const refresh = button('刷新配置', () => preflight ? select() : act('list'));
  const prepare = button('查看确认内容', () => {
    const selected = state?.candidates.find(item => item.candidateId === candidates.value);
    if (selected) void act('prepare', { candidateId: selected.candidateId, candidateRevision: selected.revision });
  });
  const cancel = button('取消本次接入', () => reset());
  buttons.push(scan, manual, refresh, prepare);
  if (preflight) {
    path.hidden = !readonlyDiscovery;
    if (readonlyDiscovery) {
      const explanation = 'A2 仅做只读应用发现，不开放确认或启动验证；“查看确认内容”在本阶段保持禁用。';
      prepare.title = explanation; prepare.setAttribute('aria-describedby', 'apps-prepare-note');
      controls.after(node('p', explanation, 'apps-prepare-note'));
    }
    help.replaceChildren(node('summary', '本轮体验步骤与限制'),
      node('p', '先保持未选环境，再明确选择本机或已配置的工作区，检查身份与缺失适配器原因；切换环境、刷新配置或重载页面，检查旧状态是否清空。'),
      node('p', bridgePreview ? '本轮只查看环境诊断与拟议测试预览；发现、历史启动验证、任务桥接和本次操作授权分别核对。实际目标验收仍待反馈，不会执行预览。' : readonlyDiscovery ? '选择环境后点击扫描，用名称筛选已扫描结果；多版本请分别核对安装实例、版本与路径。扫描不完整或不可用不表示未安装。指定路径只读取本地安全 EXE / 快捷方式，不会执行它；自行安装后可以点击重扫。真实路径和清单只保留在本机页面，请勿公开上传。'
        : '扫描和路径检查等待 A1 体验反馈后的 A2；本轮不能确认、启动、撤销注册、发送任务、接管输入或控制虚拟机。'),
      node('p', '本轮不能确认、启动、撤销注册、发送任务、接管输入或控制虚拟机。刷新或切换环境会丢弃旧结果；不会自动重扫。'));
  }
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
    version++; const old = state; state = undefined; busy = false; path.value = ''; search.value = ''; lastAction = undefined;
    if (clearSelection) environment.value = '';
    end(old); render(); status.textContent = '先选择执行环境；不会自动扫描或启动。';
  }
  async function select() {
    reset(false); const selected = target(); if (!selected) return;
    const current = version; busy = true; render(); status.textContent = '正在读取所选环境配置…';
    try {
      const result = await post({ action: 'open', desktopTarget: selected });
      if (current !== version) { end(result); return; }
      state = result; status.textContent = readonlyDiscovery ? '配置已读取。点击扫描或指定路径才读取应用信息；启动保持关闭。'
        : bridgePreview ? '配置已读取。P8-B 只读预览；扫描、启动和任务保持关闭。' : preflight ? '配置已读取。A1 仅预检；扫描和启动尚未开放。' : '配置已读取。扫描和启动必须由你显式操作。';
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
      state = result; lastAction = action;
      status.textContent = readonlyDiscovery && result.report
        ? `${action === 'path' ? '路径检查' : '扫描'}：${lookup(scanStates, result.report.status) || '未知，不能证明完整'} · ${result.candidates.length} 个候选。${(action === 'path' ? pathReason(result.report.reason) : scanReason(result.report.reason)) || '请核对来源和覆盖限制。'}`
        : result.report ? `扫描：${result.report.status} · ${result.report.reason || (result.candidates.length ? '请明确选择候选' : '仅在已扫描来源中未找到，可指定路径或安装后重扫')}` : '配置已更新';
    } catch (error) {
      if (current === version) status.textContent = `操作被拒绝：${error.message}。先刷新配置；候选或环境发生变化时重新选择并扫描，不自动重试启动。`;
    } finally { if (current === version) { busy = false; render(); } }
  }
  function render() {
    for (const item of buttons) item.disabled = !state || busy;
    if (preflight) refresh.disabled = !state; // Can discard an in-flight read without waiting for it.
    path.disabled = !state || busy; cancel.disabled = !state && !busy;
    scan.disabled ||= !state?.readiness.discovery; manual.disabled ||= !state?.readiness.discovery;
    scan.disabled ||= preflight && !readonlyDiscovery; manual.disabled ||= preflight && !readonlyDiscovery;
    search.disabled = !state?.report || busy;
    prepare.disabled ||= !candidates.value || !state?.readiness.controlledLaunch;
    const previous = candidates.value; candidates.replaceChildren(node('option', '请选择具体安装实例'));
    candidates.firstChild.value = '';
    const query = search.value.normalize('NFKC').toLowerCase().trim();
    const matching = (state?.candidates || []).filter(item => !readonlyDiscovery || !query ||
      [item.candidate.displayName, ...item.candidate.aliases].some(name => name.normalize('NFKC').toLowerCase().includes(query)));
    for (const item of matching) {
      const option = node('option', `${item.candidate.displayName} · ${item.version || '版本未知'} · ${item.publisher || '发布者未知'} · ${readonlyDiscovery ? sourceText(item.sources) : item.sources.join(', ')}`);
      option.value = item.candidateId; candidates.append(option);
    }
    candidates.value = previous; candidates.disabled = !state || busy;
    const selected = state?.candidates.find(item => item.candidateId === candidates.value);
    const existing = selected && state.registered.find(app => app.installationId === selected.candidate.installationId &&
      app.validity === 'current' && app.trust !== 'discovered' && app.identity?.fingerprint === selected.contentFingerprint &&
      (!selected.version || app.identity.version === selected.version) && JSON.stringify(app.launchSpec) === JSON.stringify(selected.candidate.launchSpec));
    identity.textContent = selected ? `名称：${selected.candidate.displayName}\n别名：${selected.candidate.aliases.join('、') || '无'}\n版本：${selected.version || '未知'} · 发布者：${selected.publisher || '未知'}\n来源：${readonlyDiscovery ? sourceText(selected.sources) : selected.sources.join('、')}\n安装实例：${selected.candidate.installationId}\n${launchText(selected.candidate.launchSpec)}\n状态：${readonlyDiscovery ? '仅发现，尚未确认、注册或启动' : 'discovered（仅发现，尚未确认此候选）'}\n限制：${readonlyDiscovery ? '扫描不能证明业务能力、运行状态或启动许可；路径与身份详情仅供本机核对。' : selected.limitation || '业务能力仍须独立证明'}` : '';
    if (existing) identity.textContent += '\n已保存同一配置：无需重复确认，请使用下方配置的重新验证启动。';
    prepare.disabled = preflight || !selected || busy || !state?.readiness.controlledLaunch || !!existing;
    phases.replaceChildren();
    const profiles = state?.registered || [];
    const confirmedProfiles = profiles.filter(app => app.validity === 'current' && app.confirmations.some(item => item.profileRevision === app.profileRevision && item.profileDigest === app.profileDigest));
    for (const [title, fact] of [['发现', state?.candidates.length ? `${state.candidates.length} 个候选，尚需明确选择` : '尚无候选记录，不代表未安装'],
      ['确认', `${confirmedProfiles.length} 个当前配置已确认；不授予业务输入`],
      ['启动验证', `${confirmedProfiles.filter(app => app.trust === 'verified' && app.availability === 'available').length} 个当前配置有启动验证；仅为历史事实`],
      ['业务操作', state?.readiness.businessCapable === true ? '后台声明可用；仍须当次目标、范围和授权检查' : 'not-proven · 尚未证明通用业务能力']]) {
      const card = node('div'); card.append(node('h3', title), node('p', fact)); phases.append(card);
    }
    for (const [item, reason] of [[scan, '需读取当前环境配置且后台声明 discovery；扫描不会启动。'], [manual, '需后台允许所选环境的路径发现；不从路径取得启动许可。'], [prepare, '需明确候选、当前配置与 controlledLaunch；查看后仍需单独确认启动。']]) item.title = item.disabled ? reason : '';
    capability.textContent = state ? `${state.scope.providerId} / ${state.scope.environmentId} · 安装域 ${state.scope.installationScopeId}\n发现适配：${state.readiness.discovery}；受控启动端口：${state.readiness.controlledLaunch}；Task 兼容准入：${state.readiness.taskCompatibility} ${state.readiness.blockedReason || ''}\nBusiness-capable：not-proven。启动验证不会升级 P6 业务证据；Task 仍需可信 bridge，以及原有能力、风险、预算、输入权和独立结果验证。\nP6 有限场景（仍需独立准入）：${state.readiness.scenarios.map(item => `${item.label}：${item.availability} ${item.reason || ''} · ${item.application || '限定应用'} ${item.applicationVersion || '限定版本'}`).join('；') || '无已装配场景'}\n安装来源：${state.report?.installationOrigin || '尚未扫描'}\n扫描来源覆盖：${state.report?.coverage.map(item => `${item.source}：${item.status} ${item.reason || ''}`).join('；') || '尚无来源覆盖记录'}` : '';
    capabilityDetails.replaceChildren(); capabilityDetails.hidden = true;
    if (state?.preflight) {
      const info = state.preflight;
      const providerLabel = lookup(scopeValues, state.scope.providerId) || '已选择的环境提供方';
      const environmentLabel = lookup(environmentNames, state.scope.environmentId) || '已选择的环境（标识见下方技术详情）';
      const launchReason = info.launchReason.replaceAll('Task', '任务执行').replaceAll('VM', '虚拟机');
      const discoveryLabel = readonlyDiscovery && state.readiness.discovery ? '可由操作者点击读取。' : '暂不可用。';
      const originLabel = readonlyDiscovery && state.readiness.discovery
        ? info.installationOrigin === 'shared-host-os' ? '本机共享操作系统的安装来源，只读；不继承本机启动或输入许可。' : '所选本机环境的限定安装来源，只读。'
        : '暂不可用，尚未接入可信安装清单，也没有扫描。';
      capability.textContent = `主机：${info.hostLabel}\n环境提供方：${providerLabel}\n执行环境：${environmentLabel}\n连接状态：配置可见，尚未连接原生会话；实际运行状态未知，能力就绪情况尚未验证。\n应用管理：可读取预检配置；本轮配置清单临时且为空，不代表电脑没有安装应用。\n应用发现：${discoveryLabel}${info.discoveryReason}\n安装来源：${originLabel}\n受控启动：暂不可用。${launchReason}\n业务操作：尚未验证；声明支持某项基础能力，不代表已经能够完成你的具体任务。`;
      if (info.taskBridge) capability.textContent += `\n任务桥接：不可用。${info.taskBridge.reason}\n受控实测：尚未授权，需单独授权；发现与历史启动验证都不能开放任务或输入。`;
      renderCapabilities(info);
    }
    reportView.replaceChildren(); reportView.hidden = !readonlyDiscovery || !state?.report;
    if (!reportView.hidden) {
      const report = state.report;
      reportView.append(node('h3', `${lastAction === 'path' ? '路径检查' : '扫描'}结果与来源覆盖`),
        node('p', `覆盖结论：${lookup(scanStates, report.status) || '未知'}。${report.status === 'complete'
          ? '仅代表列出的来源已按限定范围读取，不代表全盘或所有安装方式。' : '部分来源无法读取或达到限制，不能据此判断应用未安装。'}`),
        node('p', `安装来源：${report.installationOrigin === 'shared-host-os' ? '本机共享操作系统（只读，不继承启动许可）' : '所选环境（只读）'}。清单和路径仅供本机操作者查看。`));
      if (lastAction === 'path' && report.reason) reportView.append(node('p', pathReason(report.reason)));
      for (const item of report.coverage) reportView.append(node('p', `${sourceText([item.source])}：${lookup(coverageStates, item.status) || '未知'}；检查 ${item.inspected} 条，拒绝 ${item.rejected} 条。${scanReason(item.reason)}`));
      if (!report.coverage.length) reportView.append(node('p', '这是单一路径检查，没有目录扫描覆盖记录，不能证明整体安装清单完整。'));
      reportView.append(node('p', matching.length > 1
        ? `当前显示 ${matching.length} 个候选；可能存在同名多版本或不同安装，请明确选择并核对实例与路径，不会自动选择。`
        : matching.length ? '找到一个候选，也需要你明确选择；不会自动确认或启动。'
          : report.status === 'complete' && lastAction !== 'path' ? '仅在已扫描的限定来源中没有匹配结果；可指定路径检查，或自行安装后重扫。'
            : '当前没有匹配候选；读取不完整、不可用或路径检查失败都不能证明没有安装。可检查来源和权限、指定路径或手动重扫。'));
      const technical = node('details'); technical.append(node('summary', '扫描技术详情（本机私有）'), node('pre', JSON.stringify(report, null, 2))); reportView.append(technical);
    }
    confirmation.replaceChildren();
    if (!preflight && state?.confirmation) {
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
      verify.title = verify.disabled ? '需当前确认及后台受控启动适配；历史验证不授予新启动权限。' : '将显式请求受控启动验证，不授予业务操作。';
      const revoke = button('撤销注册', () => act('revoke', { appBindingId: app.appBindingId, expectedRevision: app.revision }), card);
      revoke.disabled = preflight || busy || app.validity === 'revoked';
      registered.append(card);
    }
  }
  candidates.onchange = render; search.oninput = render; environment.onchange = () => { void select(); };
  window.addEventListener('pagehide', () => reset());
  render();
  let loading;
  async function load() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
    environment.replaceChildren(node('option', '请选择执行环境')); environment.firstChild.value = '';
    try {
      const response = await fetch('/api/desktop/environments'); const result = await response.json();
      if (!response.ok) throw new Error(result.error || '环境不可用');
      for (const item of result.environments) {
        const kindLabel = ({ physical: '本机交互桌面', 'virtual-machine': '虚拟机', 'local-workspace': '本地隔离工作区' })[item.kind] || '执行环境';
        const option = node('option', preflight ? `${kindLabel} · ${lookup(environmentNames, item.environmentId) || item.environmentId}（${readonlyDiscovery ? '只读发现，连接尚未验证' : '仅预检，连接尚未验证'}）`
          : `${kindLabel} · ${item.environmentId}${item.blockedReason ? ` · ${item.blockedReason}` : ''}`);
        option.value = JSON.stringify([item.providerId, item.environmentId]); environment.append(option);
      }
      loaded = true;
    } catch (error) { loaded = false; status.textContent = `读取环境失败：${error.message}`; }
    finally { loading = undefined; }
    })();
    return loading;
  }
  return { load, async selectEnvironment(scope) {
    const current = version; await load();
    if (current !== version) return;
    const value = JSON.stringify([scope.providerId, scope.environmentId]);
    if (!loaded || ![...environment.options].some(option => option.value === value)) { status.textContent = '此环境不在应用目录中，请刷新并重新选择。'; return; }
    environment.value = value; const selection = select(); const selectedVersion = version; await selection;
    if (version === selectedVersion) environment.focus();
  }, leave() { reset(); } };
};
