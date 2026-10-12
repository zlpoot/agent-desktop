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
  readiness: { controlledLaunch: boolean; discovery: boolean };
  report?: { status: 'complete' | 'incomplete' | 'unavailable' };
  confirmation?: WorkbenchAppConfirmation;
  configuredAppList?: boolean;
}
type WorkbenchAppChoice = { app: WorkbenchRegisteredApp; candidate?: never }
  | { candidate: WorkbenchAppCandidate; app?: never };
type WorkbenchAppAction = 'scan' | 'prepare' | 'confirm' | 'verify';
interface WorkbenchAppActionFields {
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
  const confirmation = node('section'); confirmation.id = 'task-app-confirmation';
  const refresh = button('刷新 App 列表', () => load());
  const scan = button('发现应用', () => act('scan'));
  function requestOpenSelectedApp() {
    const chosen = choices.get(select.value); if (!chosen) return;
    if (chosen.app) void act('verify', { appBindingId: chosen.app.appBindingId, expectedRevision: chosen.app.revision, allowLaunch: true });
    else void act('prepare', { candidateId: chosen.candidate.candidateId, candidateRevision: chosen.candidate.revision });
  }
  const open = button('打开应用', requestOpenSelectedApp);
  open.id = 'task-app-open';
  const actions = node('div'); actions.className = 'workbench-app-actions'; actions.append(open, scan, refresh);
  root.classList.add('workbench-app-launcher'); root.append(actions, identity, confirmation, status);
  let scope: WorkbenchAppTarget | undefined, state: WorkbenchAppView | undefined;
  let busy = false, version = 0, choices = new Map<string, WorkbenchAppChoice>();
  const key = (value: WorkbenchAppTarget | undefined) => value ? JSON.stringify([value.providerId, value.environmentId]) : '';
  const confirmed = (app: WorkbenchRegisteredApp) => app.validity === 'current' && ['confirmed', 'verified'].includes(app.trust) &&
    app.confirmations.some(item => item.profileRevision === app.profileRevision && item.profileDigest === app.profileDigest);
  const launchText = (spec: WorkbenchLaunchSpec) => spec.kind === 'package' ? `包：${spec.packageFamilyName} / ${spec.applicationUserModelId}`
    : `路径：${spec.executable}\n参数：${JSON.stringify(spec.args)}\n工作目录：${spec.workingDirectory || '默认'}`;
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
    version++; const old = state; state = undefined; busy = false; select.value = ''; end(old); render();
  }
  function render(previous = select.value) {
    choices = new Map(); select.replaceChildren(node('option', '请选择应用')); (select.firstChild as HTMLOptionElement).value = '';
    const registered = (state?.registered || []).filter(confirmed);
    const add = (value: string, label: string, choice: WorkbenchAppChoice) => { const option = node('option', label); option.value = value; select.append(option); choices.set(value, choice); };
    for (const app of registered) add(`app:${app.appBindingId}`, `${app.displayName} · ${app.identity?.version || '版本未知'}（已确认）`, { app });
    for (const candidate of state?.candidates || []) {
      if (registered.some(app => app.installationId === candidate.candidate.installationId && app.identity?.fingerprint === candidate.contentFingerprint &&
          (!candidate.version || app.identity!.version === candidate.version) && JSON.stringify(app.launchSpec) === JSON.stringify(candidate.candidate.launchSpec))) continue;
      add(`candidate:${candidate.candidateId}`, `${candidate.candidate.displayName} · ${candidate.version || '版本未知'} · ${candidate.publisher || '发布者未知'}（首次确认）`, { candidate });
    }
    select.value = choices.has(previous) ? previous : '';
    const chosen = choices.get(select.value), value = chosen?.app || chosen?.candidate?.candidate;
    select.disabled = busy || !choices.size;
    open.disabled = busy || !!state?.confirmation || !chosen || !state?.readiness.controlledLaunch;
    scan.disabled = busy || !state?.readiness.discovery;
    refresh.disabled = busy || !scope;
    identity.textContent = value ? `${value.displayName}\n环境：${scope!.providerId} / ${scope!.environmentId}\n${launchText(value.launchSpec)}` : '';
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
      status.textContent = !state.readiness.controlledLaunch ? '本环境尚未配置受控启动，请到“环境与应用”检查配置。'
        : state.registered.some(confirmed) ? '选择应用后点击“打开应用”。' : '尚无已确认应用。点击“发现应用”，选择后核对并打开。';
    } catch (error) { if (current === version) status.textContent = `App 列表不可用：${(error as Error).message}。可刷新重试或到“环境与应用”检查配置。`; }
    finally { if (current === version) { busy = false; render(); } }
    // An explicit operator-pinned App list can be read immediately; no system-wide scan or launch.
    if (current === version && state?.configuredAppList === true && state.readiness.discovery && !state.registered.some(confirmed)) await act('scan');
  }
  async function act(action: WorkbenchAppAction, extra: WorkbenchAppActionFields = {}) {
    if (!state || busy) return;
    const current = version, snapshot = state, selected = scope;
    const openedId = extra.appBindingId || snapshot.confirmation?.appBindingId;
    let preferred: string | undefined;
    busy = true; render(); status.textContent = action === 'scan' ? '正在发现本环境的应用…' : action === 'prepare' ? '正在核对应用身份…' : '正在打开应用…';
    try {
      const result = await post({ action, desktopTarget: snapshot.desktopTarget, sessionId: snapshot.sessionId,
        revision: snapshot.revision, requestId: crypto.randomUUID(), ...extra });
      if (current !== version) return;
      state = checked(result, selected);
      if (action === 'scan') {
        preferred = ''; status.textContent = `${state.candidates.length} 个应用候选。请明确选择；${state.report?.status === 'complete' ? '选择不会自动打开应用。' : '发现不完整或不可用，不能据此判断未安装。'}`;
      } else if (action === 'prepare') status.textContent = '请核对下方应用身份，再点击“确认并打开”。';
      else {
        const app = state.registered.find(item => item.appBindingId === openedId), last = app?.verifications.at(-1);
        const verified = last?.result === 'verified' && last.profileDigest === app!.profileDigest && last.profileRevision === app!.profileRevision &&
          last.processOwnershipVerified === true && last.windowOwnershipVerified === true;
        preferred = `app:${openedId}`;
        status.textContent = verified ? `应用已打开：${app!.displayName}。`
          : `打开未完成：${last?.reason || app?.lastError || '窗口身份未获确认'}。不会自动重试。`;
      }
    } catch (error) { if (current === version) { state!.confirmation = undefined; status.textContent = `操作被拒绝：${(error as Error).message}。请刷新核对，不会自动重试。`; } }
    finally { if (current === version) { busy = false; render(preferred ?? select.value); } }
  }
  select.onchange = () => {
    if (state) state.confirmation = undefined;
    render();
    status.textContent = !state?.readiness.controlledLaunch ? '本环境尚未配置受控启动，请到“环境与应用”检查配置。'
      : select.value ? '已选择应用，请点击“打开应用”。' : '请选择应用。';
  };
  window.addEventListener('pagehide', () => { scope = undefined; reset(); });
  render();
  return { setEnvironment(value) {
    const selected = value ? { providerId: value.providerId, environmentId: value.environmentId } : undefined;
    if (key(selected) === key(scope)) return;
    scope = selected; void load();
  }, reload() { return load(); } };
};
