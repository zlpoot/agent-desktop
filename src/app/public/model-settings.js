// Credentials are submitted once to the local Host; never cached or read back.
window.createModelSettings = function (container) {
  const make = (tag, value = '') => { const node = document.createElement(tag); node.textContent = value; return node; };
  const panel = make('section'); panel.className = 'settings-config-note model-settings';
  panel.append(make('h2', '模型与 Provider · Chat Completions'), make('p',
    '一个普通任务模型。保存只写本机私有配置，不测试连接；新任务开始执行时读取，活动任务保持本次配置。环境变量优先于本页保存值。'));
  const form = make('form'); form.autocomplete = 'off';
  const field = (id, label, type, limit) => {
    const wrapper = make('label', label), input = make('input'); input.id = id; input.type = type;
    input.maxLength = limit; input.autocomplete = 'off'; wrapper.append(input); form.append(wrapper); return input;
  };
  const endpoint = field('model-endpoint', 'API 地址（HTTP(S)）', 'url', 2048);
  const model = field('model-name', '模型名称', 'text', 200);
  const actionLabel = make('label', 'API Key 操作'), action = make('select'); action.id = 'model-key-action';
  for (const [value, label] of [['keep', '保留现有 Key'], ['replace', '替换 / 新设 Key'], ['clear', '显式清除本机 Key']]) {
    const option = make('option', label); option.value = value; action.append(option);
  }
  actionLabel.append(action); form.append(actionLabel);
  const apiKey = field('model-api-key', 'API Key（不回填）', 'password', 2048); apiKey.disabled = true;
  const save = make('button', '保存模型配置'); save.type = 'submit';
  const reload = make('button', '重新读取模型配置'); reload.type = 'button';
  const effective = make('p'); effective.id = 'model-effective';
  const message = make('p'); message.id = 'model-settings-message'; message.className = 'operation-feedback'; message.setAttribute('role', 'status');
  for (const input of [endpoint, model, action, apiKey]) input.setAttribute('aria-describedby', message.id);
  form.append(save, reload); panel.append(form, effective, message); container.append(panel);
  let loaded = false, busy = false;
  const controls = () => {
    save.disabled = busy || !loaded; reload.disabled = busy;
    for (const input of [endpoint, model, action]) input.disabled = busy;
    apiKey.disabled = busy || action.value !== 'replace'; apiKey.required = action.value === 'replace';
  };
  const valid = data => data && data.saved && data.effective &&
    typeof data.saved.endpoint === 'string' && typeof data.saved.model === 'string' &&
    typeof data.effective.keyConfigured === 'boolean' && typeof data.effective.ready === 'boolean' &&
    data.effective.sources && Array.isArray(data.effective.reasons) && data.appliesTo === 'next-task-start';
  const show = data => {
    if (!valid(data)) throw Error('invalid-response');
    endpoint.value = data.saved.endpoint; model.value = data.saved.model; apiKey.value = ''; action.value = 'keep';
    const state = data.effective, labels = { environment: '环境变量', 'private-file': '本机私有配置', 'env-local': '.env.local', none: '未配置' };
    effective.textContent = `当前有效：API 地址 ${state.endpoint || '未配置'}（${labels[state.sources.endpoint]}）；模型 ${state.model || '未配置'}（${labels[state.sources.model]}）；Key ${state.keyConfigured ? '已配置' : '未配置'}（${labels[state.sources.apiKey]}）。` +
      ` 本机保存 Key：${data.saved.keyCleared ? '已显式清除' : data.saved.keyConfigured ? '已配置' : '未设置'}。` +
      (Object.values(state.sources).includes('environment') ? ' 环境变量正在覆盖对应本机保存值；修改启动环境后才会改变覆盖项。' : '') +
      (state.ready ? ' 配置完整；尚未验证模型连接或调用。' : ` 配置不完整 / 未就绪：${state.reasons.join('；')}。`);
    loaded = true;
  };
  async function load() {
    if (busy) return;
    busy = true; loaded = false; apiKey.value = ''; controls(); message.dataset.state = 'loading'; message.textContent = '正在读取本机模型配置…';
    try {
      const response = await fetch('/api/settings/model'); const data = await response.json();
      if (!response.ok) throw Error('read-failed');
      show(data); message.dataset.state = 'success'; message.textContent = '已读取生效来源；API Key 不回填。';
    } catch {
      effective.textContent = '当前模型配置 UNKNOWN / 未读取。'; message.dataset.state = 'error';
      message.textContent = '模型配置读取失败，保存禁用；请重新读取。';
    } finally { busy = false; controls(); }
  }
  action.onchange = () => { apiKey.value = ''; controls(); message.dataset.state = 'pending'; message.textContent = '尚未保存；清除只影响本机配置，环境变量 Key 仍优先。'; };
  for (const input of [endpoint, model, apiKey]) input.oninput = () => {
    message.dataset.state = 'pending'; message.textContent = '尚未保存；不会改变活动任务。';
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !loaded) return;
    const body = { endpoint: endpoint.value.trim(), model: model.value.trim(), keyAction: action.value,
      ...(action.value === 'replace' ? { apiKey: apiKey.value } : {}) };
    // Erase the password before awaiting HTTP, including failed/unknown outcomes.
    apiKey.value = ''; busy = true; controls(); message.dataset.state = 'loading'; message.textContent = '正在保存本机模型配置…';
    try {
      const response = await fetch('/api/settings/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok || !valid(data) || data.saved.endpoint !== body.endpoint || data.saved.model !== body.model ||
          (body.keyAction === 'replace' && !data.saved.keyConfigured) || (body.keyAction === 'clear' && !data.saved.keyCleared)) throw Error('save-unconfirmed');
      show(data); message.dataset.state = 'success'; message.textContent = '已保存本机配置；生效项与覆盖来源见上方，新任务开始执行时读取。';
    } catch {
      loaded = false; message.dataset.state = 'error';
      message.textContent = '模型配置保存未确认；Key 输入已清空，请先重新读取核对，不自动重试。';
    } finally { delete body.apiKey; busy = false; controls(); document.dispatchEvent(new Event('workbench:model-updated')); }
  };
  reload.onclick = load; controls(); void load();
  return panel;
};
