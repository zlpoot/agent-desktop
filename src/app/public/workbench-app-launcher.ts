// Operator-only App opening on the workbench; uses the existing scoped management port.
// App choices never become Task/runtime bindings or input permission.
type WorkbenchAppTarget = import('../../contracts/task-desktop.js').TaskDesktopTarget;
type WorkbenchRegisteredApp = import('../../contracts/environment-apps.js').EnvironmentAppBinding;
type WorkbenchLaunchSpec = import('../../contracts/environment-apps.js').AppLaunchSpec;
type WorkbenchAppCandidate = import('../../contracts/app-discovery.js').DiscoveredApp;
type WorkbenchAppConfirmation = import('../../contracts/app-launch.js').AppConfirmationDisplay;
interface WorkbenchAppView {
  desktopTarget: WorkbenchAppTarget;
  scope: import('../../contracts/environment-apps.js').EnvironmentAppScope;
  sessionId: string;
  revision: number;
  registered: readonly WorkbenchRegisteredApp[];
  candidates: readonly WorkbenchAppCandidate[];
  readiness: { controlledLaunch: boolean; discovery: boolean; preview?: boolean; stop?: boolean };
  report?: { status: 'complete' | 'incomplete' | 'unavailable' };
  confirmation?: WorkbenchAppConfirmation;
  configuredAppList?: boolean;
  liveStatus?: Record<string, import('../../contracts/environment-apps.js').AppLiveStatus>;
}
type WorkbenchAppChoice = { app: WorkbenchRegisteredApp; candidate?: never }
  | { candidate: WorkbenchAppCandidate; app?: never };
type WorkbenchAppAction = 'list' | 'path' | 'scan' | 'prepare' | 'confirm' | 'verify' | 'stop';
interface WorkbenchAppActionFields {
  path?: string;
  displayName?: string;
  save?: true;
  appBindingId?: string;
  expectedRevision?: number;
  candidateId?: string;
  candidateRevision?: number;
  confirmationId?: string;
  digest?: string;
  allowLaunch?: true;
}
interface Window {
  createWorkbenchAppLauncher(root: HTMLElement, select: HTMLSelectElement): {
    setEnvironment(value?: WorkbenchAppTarget): void;
    reload(): Promise<void>;
  };
}

window.createWorkbenchAppLauncher = (root, select) => {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const value = document.createElement(tag); value.textContent = text; return value; };
  const button = (label: string, action: () => unknown) => { const value = node('button', label); value.type = 'button'; value.onclick = action; return value; };
  const status = node('p', '选择桌面环境后，可选择并打开应用。'); status.id = 'task-app-status'; status.setAttribute('role', 'status');
  const identity = node('p'); identity.id = 'task-app-identity';
  const identityDetails = node('details'); identityDetails.className = 'workbench-app-details';
  identityDetails.append(node('summary', '应用信息'), identity);
  const confirmation = node('section'); confirmation.id = 'task-app-confirmation';
  const preview = node('section'); preview.id = 'task-app-preview';
  const previewImage = node('img'); previewImage.hidden = true; previewImage.alt = '所选应用在 Hidden Desktop 中的窗口画面';
  const previewStatus = node('p', '打开应用后显示窗口画面。'); previewStatus.setAttribute('role', 'status');
  preview.append(node('h3', '应用画面'), previewImage, previewStatus);
  const refresh = button('刷新应用', () => load());
  const scan = button('发现应用', () => act('scan'));
  function requestOpenSelectedApp() {
    const chosen = choices.get(select.value); if (!chosen) return;
    if (chosen.app) void act('verify', { appBindingId: chosen.app.appBindingId, expectedRevision: chosen.app.revision, allowLaunch: true });
    else void act('prepare', { candidateId: chosen.candidate.candidateId, candidateRevision: chosen.candidate.revision });
  }
  const open = button('打开应用', requestOpenSelectedApp);
  open.id = 'task-app-open';
  const stop = button('关闭应用', () => {
    const app = choices.get(select.value)?.app;
    if (app) void act('stop', { appBindingId: app.appBindingId, expectedRevision: app.revision });
  }); stop.id = 'task-app-stop';
  const addApp = button('添加应用', () => { form.hidden = !form.hidden; }); addApp.id = 'task-app-add';
  const form = node('section'); form.hidden = true;
  const path = node('input'); path.id = 'task-app-path'; path.placeholder = 'C:\\Apps\\Example.exe';
  const pathLabel = node('label', '所选环境中的 .exe 绝对路径'); pathLabel.htmlFor = path.id;
  const name = node('input'); name.id = 'task-app-name'; name.maxLength = 128;
  const nameLabel = node('label', '应用名称（可修改）'); nameLabel.htmlFor = name.id;
  path.oninput = () => { name.value = path.value.trim().split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '') || ''; };
  const save = button('检查并保存', () => act('path', { path: path.value.trim(), displayName: name.value.trim(), save: true }));
  form.append(pathLabel, path, nameLabel, name, save, node('p', '保存应用后，在列表中选择并打开。'));
  const actions = node('div'); actions.className = 'workbench-app-actions'; actions.append(open, stop, addApp, scan, refresh);
  root.classList.add('workbench-app-launcher'); root.append(actions, form, identityDetails, confirmation, status, preview);
  let scope: WorkbenchAppTarget | undefined, state: WorkbenchAppView | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined, previewVersion = 0, previewBusy = false;
  let previewUrl: string | undefined;
  let busy = false, version = 0, choices = new Map<string, WorkbenchAppChoice>();
  const key = (value: WorkbenchAppTarget | undefined) => value ? JSON.stringify([value.providerId, value.environmentId]) : '';
  const confirmed = (app: WorkbenchRegisteredApp) => app.validity === 'current' && ['confirmed', 'verified'].includes(app.trust) &&
    app.confirmations.some(item => item.profileRevision === app.profileRevision && item.profileDigest === app.profileDigest);
  const launchText = (spec: WorkbenchLaunchSpec) => spec.kind === 'package' ? `包：${spec.packageFamilyName} / ${spec.applicationUserModelId}`
    : `路径：${spec.executable}\n参数：${JSON.stringify(spec.args)}\n工作目录：${spec.workingDirectory || '默认'}`;
  const failureText = (reason: string | undefined) => reason === 'workbench-app-in-use'
    ? '请先关闭当前应用，再打开所选 APP' : reason || '窗口身份未获确认';
  async function post(body: Record<string, unknown>, keepalive = false): Promise<WorkbenchAppView> {
    const response = await fetch('/api/desktop/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });
    const result: unknown = await response.json();
    if (!response.ok) throw Error((result as { error?: string }).error || `HTTP ${response.status}`);
    return result as WorkbenchAppView;
  }
  function end(old: WorkbenchAppView | undefined) {
    if (old) void post({ action: 'close', desktopTarget: old.desktopTarget, sessionId: old.sessionId,
      revision: old.revision, requestId: crypto.randomUUID() }, true).catch(() => {});
  }
  function checked(result: WorkbenchAppView, selected: WorkbenchAppTarget | undefined) {
    if (!result || key(result.desktopTarget) !== key(selected) || key(result.scope) !== key(selected) ||
        typeof result.sessionId !== 'string' || !Number.isInteger(result.revision) || !Array.isArray(result.registered) ||
        !Array.isArray(result.candidates) || typeof result.readiness?.controlledLaunch !== 'boolean') throw Error('应用列表身份无效，请刷新');
    return result;
  }
  function reset() {
    clearPreview();
    if (pollTimer) clearTimeout(pollTimer);
    version++; const old = state; state = undefined; busy = false; select.value = ''; form.hidden = true; path.value = name.value = ''; end(old); render();
  }
  function render(previous = select.value) {
    choices = new Map(); select.replaceChildren(node('option', '请选择应用')); (select.firstChild as HTMLOptionElement).value = '';
    const registered = (state?.registered || []).filter(confirmed);
    const add = (value: string, label: string, choice: WorkbenchAppChoice) => { const option = node('option', label); option.value = value; select.append(option); choices.set(value, choice); };
    for (const app of registered) add(`app:${app.appBindingId}`, `${app.displayName}${app.identity?.version ? ` · ${app.identity.version}` : ''}`, { app });
    for (const candidate of state?.candidates || []) {
      if (registered.some(app => app.installationId === candidate.candidate.installationId && app.identity?.fingerprint === candidate.contentFingerprint &&
          (!candidate.version || app.identity!.version === candidate.version) && JSON.stringify(app.launchSpec) === JSON.stringify(candidate.candidate.launchSpec))) continue;
      add(`candidate:${candidate.candidateId}`, `${candidate.candidate.displayName} · ${candidate.version || '版本未知'} · ${candidate.publisher || '发布者未知'}（首次确认）`, { candidate });
    }
    select.value = choices.has(previous) ? previous : '';
    const chosen = choices.get(select.value), value = chosen?.app || chosen?.candidate?.candidate;
    select.disabled = busy || !choices.size;
    open.disabled = busy || !!state?.confirmation || !chosen || !state?.readiness.controlledLaunch;
    const live = chosen?.app && state?.liveStatus?.[chosen.app.appBindingId];
    stop.disabled = busy || !chosen?.app || !state?.readiness.stop || !live || !['window-confirmed', 'unknown'].includes(live.state);
    scan.disabled = busy || !state?.readiness.discovery;
    refresh.disabled = busy || !scope;
    addApp.disabled = save.disabled = busy || !state?.readiness.controlledLaunch || !state?.readiness.discovery;
    path.disabled = name.disabled = busy;
    identity.textContent = value ? `${value.displayName}\n环境：${scope!.providerId} / ${scope!.environmentId}\n${launchText(value.launchSpec)}` : '';
    identityDetails.hidden = !value;
    confirmation.replaceChildren();
    if (state?.confirmation) {
      const display = state.confirmation;
      confirmation.append(node('h3', '首次打开：请核对应用'), node('p', `${display.displayName} · ${display.version} · ${display.publisher}\n环境：${display.scope.environmentId}\n${launchText(display.launchSpec)}`));
      const confirm = button('确认并打开', () => act('confirm', { confirmationId: display.confirmationId, digest: display.digest, allowLaunch: true }));
      confirm.disabled = busy; confirmation.append(confirm);
    }
  }
  async function load() {
    reset(); if (!scope) { status.textContent = '选择桌面环境后，可选择并打开应用。'; return; }
    const current = version, selected = scope; busy = true; render(); status.textContent = '正在读取本环境的 App 列表…';
    try {
      const result = await post({ action: 'open', desktopTarget: selected });
      if (current !== version) { end(result); return; }
      state = checked(result, selected);
      status.textContent = !state.readiness.controlledLaunch ? '请到“环境与应用”完成应用启动配置。'
        : state.registered.some(confirmed) ? '选择应用后点击“打开应用”。' : '点击“添加应用”，保存本环境中的应用。';
    } catch (error) { if (current === version) status.textContent = `App 列表不可用：${(error as Error).message}。可刷新重试或到“环境与应用”检查配置。`; }
    finally { if (current === version) { busy = false; render(); } }
  }
  async function act(action: WorkbenchAppAction, extra: WorkbenchAppActionFields = {}) {
    if (!state || busy) return;
    if (action !== 'list') clearPreview();
    const current = version, snapshot = state, selected = scope;
    const openedId = extra.appBindingId || snapshot.confirmation?.appBindingId;
    let received = false;
    let preferred: string | undefined;
    busy = true; render(); status.textContent = action === 'list' ? '正在核对窗口状态…' : action === 'stop' ? '正在关闭本次受控应用…' : action === 'path' ? '正在检查并保存配置…' : action === 'scan' ? '正在发现本环境的应用…' : action === 'prepare' ? '正在核对应用身份…' : '正在打开应用…';
    try {
      const result = await post({ action, desktopTarget: snapshot.desktopTarget, sessionId: snapshot.sessionId,
        revision: snapshot.revision, requestId: crypto.randomUUID(), ...extra });
      if (current !== version) return;
      state = checked(result, selected);
      received = true;
      if (action === 'scan') {
        preferred = ''; status.textContent = `${state.candidates.length} 个应用候选。请明确选择；${state.report?.status === 'complete' ? '选择不会自动打开应用。' : '发现不完整或不可用，不能据此判断未安装。'}`;
      } else if (action === 'path') {
        const app = state.registered.find(item => item.launchSpec.kind === 'exe' && item.launchSpec.executable.toLowerCase().replaceAll('/', '\\') === extra.path?.toLowerCase().replaceAll('/', '\\'));
        preferred = app ? `app:${app.appBindingId}` : '';
        form.hidden = true; status.textContent = '配置已保存，尚未打开。选择应用后点击“打开应用”。';
      } else if (action === 'list') showLiveStatus();
      else if (action === 'stop') status.textContent = '关闭已处理，正在核对退出状态…';
      else if (action === 'prepare') status.textContent = '请核对下方应用身份，再点击“确认并打开”。';
      else {
        const app = state.registered.find(item => item.appBindingId === openedId), last = app?.verifications.at(-1);
        const verified = last?.result === 'verified' && last.profileDigest === app!.profileDigest && last.profileRevision === app!.profileRevision &&
          last.processOwnershipVerified === true && last.windowOwnershipVerified === true;
        preferred = `app:${openedId}`;
        status.textContent = verified ? `应用已打开：${app!.displayName}（窗口已确认）。`
          : `打开未完成：${failureText(last?.reason || app?.lastError)}。不会自动重试。`;
      }
    } catch (error) { if (current === version) {
      state!.confirmation = undefined;
      if (['list', 'verify', 'confirm', 'stop'].includes(action)) state!.liveStatus = undefined;
      clearPreview('预览已停止，请刷新核对窗口状态。');
      status.textContent = `${action === 'stop' ? '关闭结果未知或被拒绝' : ['list', 'verify', 'confirm'].includes(action) ? '结果未知或打开被拒绝' : '操作被拒绝'}：${(error as Error).message}。请刷新核对，不会自动重试。`;
    } }
    finally { if (current === version) {
      busy = false; render(preferred ?? select.value);
      if (received && ['verify', 'confirm', 'stop'].includes(action)) showLiveStatus();
      scheduleStatus();
      if (received && ['list', 'verify', 'confirm'].includes(action)) void loadPreview();
    } }
  }
  function showLiveStatus() {
    const app = choices.get(select.value)?.app;
    if (!app || !state?.liveStatus) return;
    const live = state.liveStatus[app.appBindingId];
    if (!live || live.state === 'unknown' || !Number.isFinite(Date.parse(live.checkedAt)) || Date.now() - Date.parse(live.checkedAt) > 5000) {
      clearPreview('窗口状态未知，预览已停止。');
      status.textContent = `结果未知：${live?.reason || '当前窗口状态不可用'}。不会自动重试。`; return;
    }
    if (live.state === 'window-confirmed') {
      if (live.expiresAt && Date.parse(live.expiresAt) <= Date.now()) { clearPreview('资源期限已到，预览已停止。'); status.textContent = '资源期限已到，正在核对退出状态…'; return; }
      status.textContent = `应用已打开：${app.displayName}（窗口已确认）。资源最迟于 ${live.expiresAt ? new Date(live.expiresAt).toLocaleTimeString() : '未知时间'} 回收（60 秒期限）。`;
    } else if (live.state === 'exited') {
      const last = app.verifications.at(-1);
      const failedLaunch = live.reason === 'workbench-owned-resources-cleaned' && last &&
        last.profileDigest === app.profileDigest && last.profileRevision === app.profileRevision &&
        ['unavailable', 'mismatch'].includes(last.result);
      clearPreview(failedLaunch ? '启动验证失败，本次启动资源已清理；没有已确认窗口可预览。' : '应用已退出，预览已停止。');
      status.textContent = failedLaunch
        ? `打开失败：${failureText(last.reason || app.lastError)}。本次启动资源已清理，不会自动重试。`
        : `已退出：${live.reason || '原进程已结束'}。`;
    }
    else {
      clearPreview();
      const last = app.verifications.at(-1);
      status.textContent = last?.result === 'unavailable' || last?.result === 'mismatch'
        ? `打开失败/未知：${failureText(last.reason || app.lastError)}。不会自动重试。`
        : '配置已保存，尚未打开。';
    }
  }
  function clearPreview(message = '窗口确认后显示画面。仅查看，不接收鼠标键盘操作。') {
    previewVersion++; previewBusy = false;
    if (previewTimer) clearTimeout(previewTimer);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
    previewImage.hidden = true; previewImage.removeAttribute('src'); previewStatus.textContent = message;
  }
  async function loadPreview() {
    const app = choices.get(select.value)?.app, snapshot = state;
    if (document.hidden || !app || !snapshot?.readiness.preview || snapshot.liveStatus?.[app.appBindingId]?.state !== 'window-confirmed' || previewBusy) return;
    const generation = previewVersion, selected = version, chosen = select.value;
    previewBusy = true;
    try {
      const response = await fetch('/api/desktop/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', desktopTarget: snapshot.desktopTarget, sessionId: snapshot.sessionId,
          revision: snapshot.revision, requestId: crypto.randomUUID(), appBindingId: app.appBindingId, expectedRevision: app.revision }) });
      const result = await response.json() as { error?: string; desktopTarget: WorkbenchAppTarget; sessionId: string;
        appBindingId: string; profileDigest: string; frame: import('../../contracts/environment-apps.js').AppWindowPreview };
      if (generation !== previewVersion || selected !== version || chosen !== select.value) return;
      if (!response.ok) throw Error(result.error || '窗口预览不可用');
      const frame = result.frame, now = Date.now();
      if (key(result.desktopTarget) !== key(scope) || result.sessionId !== snapshot.sessionId || result.appBindingId !== app.appBindingId || result.profileDigest !== app.profileDigest ||
          !frame || typeof frame.png !== 'string' || frame.png.length > 5592408 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.png) ||
          !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.width > 2048 || frame.height < 1 || frame.height > 2048 ||
          !Number.isFinite(Date.parse(frame.capturedAt)) || now - Date.parse(frame.capturedAt) > 5000 || Date.parse(frame.capturedAt) > now + 1000 ||
          !Number.isFinite(Date.parse(frame.expiresAt)) || Date.parse(frame.expiresAt) <= now) throw Error('窗口画面身份无效或已过期');
      const bytes = Uint8Array.from(atob(frame.png), char => char.charCodeAt(0));
      const oldUrl = previewUrl;
      previewUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      previewImage.src = previewUrl; previewImage.hidden = false;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      previewStatus.textContent = `只读画面 · ${frame.width} × ${frame.height} · 更新于 ${new Date(frame.capturedAt).toLocaleTimeString()}。不提供鼠标键盘控制。`;
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => clearPreview('画面已过期，等待当前窗口的新画面。'), Math.min(5000 - (now - Date.parse(frame.capturedAt)), Date.parse(frame.expiresAt) - now));
    } catch (error) {
      if (generation === previewVersion && selected === version && chosen === select.value) clearPreview(`预览不可用：${(error as Error).message}。`);
    } finally { if (generation === previewVersion) previewBusy = false; }
  }
  function scheduleStatus() {
    if (pollTimer) clearTimeout(pollTimer);
    if (!state?.liveStatus || !choices.get(select.value)?.app) return;
    pollTimer = setTimeout(() => { if (!busy) void act('list'); else scheduleStatus(); }, 2000);
  }
  select.onchange = () => {
    clearPreview();
    if (state) state.confirmation = undefined;
    render();
    status.textContent = !state?.readiness.controlledLaunch ? '请到“环境与应用”完成应用启动配置。'
      : select.value ? '配置已保存，尚未打开；请点击“打开应用”。' : '请选择应用。';
    showLiveStatus(); scheduleStatus();
    void loadPreview();
  };
  window.addEventListener('pagehide', () => { scope = undefined; reset(); });
  document.addEventListener('visibilitychange', () => {
    clearPreview(document.hidden ? '预览已暂停。' : '正在重新核对当前窗口画面…');
    if (!document.hidden && state && !busy) void act('list');
  });
  render();
  return { setEnvironment(value) {
    const selected = value ? { providerId: value.providerId, environmentId: value.environmentId } : undefined;
    if (key(selected) === key(scope)) return;
    scope = selected; void load();
  }, reload() { return load(); } };
};
