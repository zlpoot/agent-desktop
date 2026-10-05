window.createWorkflowLibrary = function (container) {
  const el = (tag, text, cls = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = cls; return node;
  };
  const heading = el('h1', '流程库');
  const note = el('p', '选择流程，再选择固定版本。填写参数并预览后，可执行或试运行。');
  const search = el('input', ''); search.type = 'search'; search.placeholder = '搜索流程名称或 ID'; search.setAttribute('aria-label', '搜索流程');
  const status = el('select', ''); status.setAttribute('aria-label', '流程状态');
  const labels = { candidate: '候选', verified: '已验证', retired: '已停用' };
  for (const [id, label] of [['all', '所有版本状态'], ...Object.entries(labels)]) {
    const option = el('option', label); option.value = id; status.append(option);
  }
  const refresh = el('button', '刷新流程'); refresh.type = 'button';
  const toolbar = el('div', '', 'library-toolbar'); toolbar.append(search, status, refresh);
  const message = el('p', '', 'library-message'); message.setAttribute('role', 'status'); message.classList.add('operation-feedback');
  const list = el('div', '', 'workflow-list');
  const detail = el('section', '选择一个流程，查看版本与参数', 'workflow-detail panel');
  detail.setAttribute('aria-label', '流程版本详情');
  const grid = el('div', '', 'library-grid'); grid.append(list, detail);
  container.append(heading, note, toolbar, message, grid);
  let workflows = [], metadata = {}, selected = null, requestId = 0, listRequest = 0;
  const nameOf = w => metadata[w.id]?.displayName || (w.taskPattern.length > 48 ? `${w.taskPattern.slice(0, 48)}…` : w.taskPattern);
  const key = workflow => JSON.stringify([workflow.id, workflow.version]);
  const endpoint = workflow => `/api/workflows/${encodeURIComponent(workflow.id)}/${workflow.version}`;
  function renderList() {
    list.replaceChildren();
    const visible = workflows.filter(w => `${metadata[w.id]?.displayName || ''} ${metadata[w.id]?.description || ''} ${w.taskPattern} ${w.id}`.toLowerCase().includes(search.value.toLowerCase()) && (status.value === 'all' || status.value === w.status));
    if (!visible.length && workflows.length) {
      list.append(el('p', '没有匹配的流程，请调整搜索或状态筛选。'));
      const reset = el('button', '清除流程筛选'); reset.type = 'button'; reset.onclick = () => { search.value = ''; status.value = 'all'; renderList(); }; list.append(reset);
    }
    for (const id of new Set(visible.map(w => w.id))) {
      const versions = visible.filter(w => w.id === id).sort((a, b) => b.version - a.version);
      const w = versions.find(v => key(v) === selected) || versions[0];
      const count = workflows.filter(v => v.id === id).length;
      const button = el('button', '', `workflow-card${workflows.some(v => v.id === id && selected === key(v)) ? ' active' : ''}`);
      button.type = 'button';
      button.append(el('strong', nameOf(w)), el('small', `${w.scope === 'stage' ? '阶段' : '整任务'} · ${count} 个版本 · v${w.version} ${labels[w.status] || w.status}`));
      button.title = w.taskPattern;
      button.onclick = () => open(w); list.append(button);
    }
  }
  function showJSON(label, value, parent = detail) {
    const disclosure = el('details', ''); disclosure.append(el('summary', label), el('pre', JSON.stringify(value, null, 2))); parent.append(disclosure);
  }
  async function open(w) {
    selected = key(w); const current = ++requestId;
    renderList(); detail.replaceChildren(el('p', '正在读取版本…'));
    try {
      const response = await fetch(endpoint(w)); const data = await response.json();
      if (current !== requestId) return;
      if (!response.ok) throw new Error(data.error || '无法读取版本');
      const flow = data.workflow;
      metadata[flow.id] = data.metadata || metadata[flow.id] || { displayName: '', description: '', revision: 0 };
      renderList();
      const flowTitle = el('h2', nameOf(flow));
      const description = el('p', metadata[flow.id].description || '尚未填写用途说明。');
      const versionLabel = el('label', '当前版本'); const versionPicker = el('select', ''); versionPicker.setAttribute('aria-label', '流程版本');
      for (const version of workflows.filter(v => v.id === flow.id).sort((a, b) => b.version - a.version)) {
        const option = el('option', `v${version.version} · ${labels[version.status]} · ${version.steps.length} 步`); option.value = version.version; versionPicker.append(option);
      }
      versionPicker.value = String(flow.version); versionPicker.onchange = () => open(workflows.find(v => v.id === flow.id && String(v.version) === versionPicker.value));
      versionLabel.append(versionPicker);
      detail.replaceChildren(flowTitle, description, versionLabel, el('p', `v${flow.version} · ${labels[flow.status]} · ${flow.scope === 'stage' ? '阶段流程' : '整任务流程'} · ${flow.environment}`));
      const edit = el('details', '', 'workflow-description'); edit.append(el('summary', '编辑名称与说明'));
      const editForm = el('form', '');
      const nameLabel = el('label', '流程名称'); const nameInput = el('input', ''); nameInput.value = metadata[flow.id].displayName || flow.taskPattern.slice(0, 80); nameInput.maxLength = 80; nameInput.required = true; nameLabel.append(nameInput);
      const descLabel = el('label', '用途说明'); const descInput = el('textarea', ''); descInput.value = metadata[flow.id].description; descInput.maxLength = 500; descInput.rows = 3; descLabel.append(descInput);
      const save = el('button', '保存名称与说明'); save.type = 'submit'; const saveMessage = el('p', '所有版本共用名称与说明；不会修改执行步骤或验证状态。'); saveMessage.setAttribute('role', 'status');
      editForm.append(nameLabel, descLabel, save, saveMessage); edit.append(editForm); detail.append(edit);
      let revision = metadata[flow.id].revision;
      editForm.onsubmit = async event => {
        event.preventDefault(); save.disabled = true;
        try {
          const result = await fetch(`/api/workflows/${encodeURIComponent(flow.id)}/metadata`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: nameInput.value, description: descInput.value, revision }) });
          const saved = await result.json(); if (!result.ok) throw new Error(saved.error || '保存失败');
          metadata[flow.id] = saved.metadata; revision = saved.metadata.revision;
          if (current === requestId) { flowTitle.textContent = nameOf(flow); description.textContent = saved.metadata.description || '尚未填写用途说明。'; saveMessage.textContent = '名称与说明已保存'; renderList(); }
        } catch (error) { saveMessage.textContent = String(error); } finally { save.disabled = false; }
      };
      detail.append(el('p', `成功 ${flow.successCount} 次 / 失败 ${flow.failureCount} 次；最近成功回放：${flow.lastVerifiedAt || '尚无成功回放记录'}`));
      detail.append(el('p', flow.scope === 'stage'
        ? '阶段候选在相似任务中尝试回放；只有阶段验收通过且未回退探索才自动晋级。已验证也不代表所有环境都适用。'
        : '试运行只记录结果并保留候选状态；“已验证”表示此版本已显式发布，不代表所有环境都适用。'));
      if (flow.status === 'candidate' && flow.scope !== 'stage') {
        const publishReview = el('details', '', 'workflow-publish');
        publishReview.append(el('summary', '审核并发布此候选版本'));
        publishReview.append(el('p', `请核对 v${flow.version} 的步骤、完成条件与最近回放：成功 ${flow.successCount} 次，失败 ${flow.failureCount} 次。发布后此版本可被正常执行和匹配。`));
        const publish = el('button', '确认发布为已验证'); publish.type = 'button';
        publish.disabled = flow.successCount < 1;
        const publishMessage = el('p', flow.successCount < 1 ? '至少需要一次成功试运行。' : '');
        publishMessage.setAttribute('role', 'status');
        publish.onclick = async () => {
          publish.disabled = true; publishMessage.textContent = '正在核对版本与回放记录…';
          try {
            const response = await fetch(`${endpoint(flow)}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ definitionHash: data.definitionHash, successCount: flow.successCount, failureCount: flow.failureCount }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '发布失败');
            if (current !== requestId) return;
            const index = workflows.findIndex(w => key(w) === key(flow));
            if (index >= 0) workflows[index] = result.workflow;
            await open(result.workflow);
          } catch (error) { if (current === requestId) publishMessage.textContent = `${String(error)}。请刷新版本并重新审核。`; }
          finally { if (current === requestId) publish.disabled = false; }
        };
        publishReview.append(publish, publishMessage); detail.append(publishReview);
      }
      const technical = el('details', '', 'workflow-technical'); technical.append(el('summary', '技术详情与原始定义'));
      showJSON('执行定义摘要与来源', { id: flow.id, taskPattern: flow.taskPattern, definitionHash: data.definitionHash, sourceTaskId: flow.sourceTaskId, createdAt: flow.createdAt }, technical);
      const form = el('form', '', 'workflow-parameters'); form.append(el('h3', '参数预览'));
      const draftKey = `agent-desktop.workflow-draft.v1:${key(flow)}`;
      let draft = {};
      try { draft = JSON.parse(sessionStorage.getItem(draftKey) || '{}') || {}; } catch {}
      for (const input of flow.inputs) {
        const label = el('label', input.name); const field = el('input', '');
        field.name = input.name; field.required = true; field.maxLength = 300; field.placeholder = input.example || '请输入参数';
        if (typeof draft[input.name] === 'string') field.value = draft[input.name];
        label.append(field); form.append(label);
      }
      if (!flow.inputs.length) form.append(el('p', '此版本没有参数。'));
      const button = el('button', '预览步骤（不执行）'); button.type = 'submit'; form.append(button);
      const preview = el('div', '', 'workflow-preview'); preview.setAttribute('aria-live', 'polite');
      const execution = el('div', '', 'workflow-execution');
      const execute = el('button', '在当前虚拟桌面执行此版本'); execute.type = 'button'; execute.disabled = true;
      const executionMessage = el('p', ''); executionMessage.setAttribute('role', 'status');
      const budgetOptions = el('details', '', 'workflow-budget-options');
      budgetOptions.append(el('summary', '本次模型预算（可选）'), el('p', '留空使用设置页的全局预算；仅对这次执行生效。'));
      const budgetInputs = {};
      for (const [kind, label] of [['deepseek', 'DeepSeek'], ['jev', 'JEV']]) {
        for (const [key, name] of [['maxCalls', '最多调用次数'], ['maxTokens', '最多 Token']]) {
          const wrapper = el('label', `${label} ${name}`); const input = el('input', '');
          input.type = 'number'; input.min = '1'; input.max = '1000000'; input.step = '1'; input.placeholder = '使用全局值';
          wrapper.append(input); budgetOptions.append(wrapper); budgetInputs[`${kind}.${key}`] = input;
        }
      }
      const trial = flow.status === 'candidate';
      const eligible = ['candidate', 'verified'].includes(flow.status) && flow.scope !== 'stage' && flow.environment === 'windows';
      if (trial) execute.textContent = '在当前虚拟桌面试运行此候选版本';
      execution.append(el('p', eligible ? '执行前会准备目标窗口并重新观察；流程偏离时停止，不转入自由探索。请先预览并核对步骤。' : '当前版本仅可预览。执行入口支持已验证的整任务 Windows 流程。'), budgetOptions, execute, executionMessage);
      execute.hidden = !eligible;
      if (trial && eligible) execution.firstChild.textContent = '试运行会实际操作虚拟桌面，并记录成功或失败；不会自动发布。请审核回放证据后显式发布。';
      if (flow.scope === 'stage') execution.firstChild.textContent = '这是阶段流程，需要阶段上下文与 Stage Verifier，目前不能作为整任务单独试运行。可继续预览。';
      let prepared = null, submitting = false;
      execute.onclick = async () => {
        if (!prepared || submitting) return;
        const selectedPreview = prepared;
        submitting = true; execute.disabled = true;
        executionMessage.textContent = '正在检查桌面状态并提交…';
        try {
          const budget = {};
          for (const [path, input] of Object.entries(budgetInputs)) {
            const value = input.value.trim(); if (!value) continue;
            if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000000) throw new Error('模型预算必须是 1 到 1000000 的整数');
            const [kind, key] = path.split('.'); (budget[kind] ||= {})[key] = Number(value);
          }
          const status = await fetch('/api/desktop/control'); const control = await status.json();
          if (!status.ok || !control.workerReady || control.mode !== 'PAUSED' || control.taskId) throw new Error('虚拟桌面尚未就绪或被任务/人工占用，请先到桌面页处理。');
          const response = await fetch(`${endpoint(flow)}/${trial ? 'trial' : 'execute'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: selectedPreview.values, definitionHash: selectedPreview.definitionHash, destination: flow.environment,
              ...(Object.keys(budget).length ? { budget } : {}) }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '提交失败');
          prepared = null;
          executionMessage.textContent = `任务已提交：${result.taskId}`;
          document.dispatchEvent(new CustomEvent('workbench:workflow-submitted', { detail: `${result.source}/${result.taskId}` }));
        } catch (error) { executionMessage.textContent = `${String(error)} 若网络中断，请先检查任务记录再重试。`; }
        finally { submitting = false; execute.disabled = !prepared; }
      };
      let previewRequest = 0;
      form.oninput = () => {
        prepared = null; execute.disabled = true; executionMessage.textContent = '';
        try { sessionStorage.setItem(draftKey, JSON.stringify(Object.fromEntries(new FormData(form)))); } catch {}
        previewRequest++; preview.replaceChildren(el('p', '参数已改变，请重新预览。'));
      };
      form.onsubmit = async event => {
        event.preventDefault(); const previewId = ++previewRequest; button.disabled = true; prepared = null; execute.disabled = true;
        preview.replaceChildren(el('p', '正在展开参数…'));
        try {
          const result = await fetch(`${endpoint(flow)}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: Object.fromEntries(new FormData(form)) }) });
          const value = await result.json();
          if (current !== requestId || previewId !== previewRequest) return;
          if (!result.ok) throw new Error(value.error || '参数预览失败');
          prepared = value; execute.disabled = !eligible || submitting;
          preview.replaceChildren(el('p', `v${value.version} 参数预览 · 未执行任何动作`));
          const steps = el('ol', '', 'workflow-step-preview');
          const actions = { click: '点击', double_click: '双击', type: '输入文字', paste_text: '粘贴文字', keypress: '按键', scroll: '滚动', navigate: '打开网页', wait: '等待' };
          const conditions = { text_includes: '画面包含文字', accessibility_includes: '控件包含文字', url_includes: '网址包含', state_changed: '画面状态发生变化' };
          for (const step of value.steps) {
            const row = el('li', ''); row.append(el('strong', step.goal), el('p', `${actions[step.action.kind] || step.action.kind} · 验证：${conditions[step.successCondition.kind] || step.successCondition.kind}${step.successCondition.value ? `「${step.successCondition.value}」` : ''}`));
            steps.append(row);
          }
          preview.append(steps);
          if (flow.scope === 'stage' && value.stageCondition) preview.append(el('p', `阶段完成条件：${value.stageCondition}`));
          showJSON('查看完整步骤定义', value.steps, preview);
          showJSON('前置条件与完成条件', { preconditions: value.preconditions, successConditions: value.successConditions }, preview);
        } catch (error) { if (current === requestId && previewId === previewRequest) preview.replaceChildren(el('p', String(error))); }
        finally { button.disabled = false; }
      };
      detail.append(form, preview, execution);
      showJSON('原始步骤与前置条件', { steps: flow.steps, preconditions: flow.preconditions, successConditions: flow.successConditions }, technical);
      showJSON('已知失败', flow.knownFailures, technical);
      detail.append(el('h3', '最近回放记录'));
      detail.append(el('p', data.runsAvailable ? `最多展示最近 ${data.runsLimit} 条，此处仅记录流程回放结果。` : '旧存储没有回放记录表。'));
      if (!data.runs.length) detail.append(el('p', '暂无回放记录。'));
      for (const run of data.runs) detail.append(el('p', `${run.outcome === 'success' ? '成功' : '失败'} · ${run.createdAt} · 任务 ${run.taskId}${run.stageId ? ` · 阶段 ${run.stageId}` : ''}${run.reason ? ` · ${run.reason}` : ''}`));
      detail.append(technical);
    } catch (error) { if (current === requestId) { const retry = el('button', '重试读取版本'); retry.type = 'button'; retry.onclick = () => open(w); detail.replaceChildren(el('p', `版本读取失败：${error.message || error}`, 'operation-feedback'), retry); } }
  }
  async function load() {
    const current = ++listRequest; ++requestId;
    message.dataset.state = 'loading'; refresh.disabled = true; refresh.textContent = '正在刷新…'; list.replaceChildren(); workflows = [];
    message.textContent = '正在读取流程库…'; detail.replaceChildren(el('p', '选择一个流程，查看版本与参数'));
    try {
      const response = await fetch('/api/workflows'); const data = await response.json();
      if (current !== listRequest) return;
      if (!response.ok) throw new Error(data.error || '无法读取流程库');
      message.dataset.state = 'success'; workflows = data.workflows; metadata = data.metadata || {}; selected = null; renderList();
      message.textContent = workflows.length ? `${new Set(workflows.map(w => w.id)).size} 个流程 · ${workflows.length} 个版本` : '流程库为空。完成任务并生成候选流程后会显示在这里。';
    } catch (error) { if (current === listRequest) { workflows = []; renderList(); message.dataset.state = 'error'; message.textContent = `流程库读取失败：${error.message || error}。请重试。`; detail.replaceChildren(el('p', '流程库暂不可用，重试成功后可选择流程。'));  } }
    finally { if (current === listRequest) { refresh.disabled = false; refresh.textContent = message.dataset.state === 'error' ? '重试读取流程' : '刷新流程'; } }
  }
  search.oninput = status.onchange = renderList; refresh.onclick = load;
  return { load };
};
