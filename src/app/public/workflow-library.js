window.createWorkflowLibrary = function (container) {
  const el = (tag, text, cls = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = cls; return node;
  };
  const heading = el('h1', '流程库');
  const note = el('p', '选择固定版本，核对来源、条件和参数。预览不执行；实际回放仍受版本、环境与后台许可限制。');
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
  const ownedChrome = flow => flow.steps.some(step => step.preferredMethods?.includes('owned-chrome-cdp'));
  function replayRestriction(flow) {
    if (ownedChrome(flow)) return `Hidden Chrome 创建流程：${flow.successCount === 0 && flow.failureCount === 0 ? '未回放' : '回放计数不授予通用许可'} / 不允许通用回放${flow.status === 'candidate' ? ' / 未晋升' : ''}。一次创建许可不可继承，须另行授权固定任务。`;
    if (flow.status === 'retired') return '此版本已停用，仅供审计和预览，不允许直接启动。';
    if (flow.scope === 'stage') return '阶段流程需要阶段上下文与 Stage Verifier，不能作为整任务单独试运行。';
    if (flow.inputs.some(input => ['number', 'bool'].includes(input.kind))) return '现有页面预览接口仅接受文字参数，数值 / 布尔参数执行适配未接通；此版本仅可查看与文字展开预览。';
    if (!['windows', 'browser'].includes(flow.environment)) return `环境 ${flow.environment} 未接通通用回放，仅可预览。`;
    if (!['candidate', 'verified'].includes(flow.status)) return '版本状态未支持，不能执行。';
    return '';
  }
  function stepList(steps) {
    const rows = el('ol', '', 'workflow-definition-steps');
    for (const step of steps) {
      const row = el('li', '');
      const condition = step.successCondition || {};
      row.append(el('strong', step.goal), el('p', `动作：${step.action.kind} · 后置：${condition.kind || '未记录'}${condition.value !== undefined ? ' · ' + condition.value : ''}`),
        el('small', step.idempotent === false ? '非幂等动作：可能产生新副作用，预览不授予执行权限。' : step.idempotent === true ? '定义声明幂等；当次权限仍由后台核对。' : '幂等性未声明，不能推断可安全重试。'));
      rows.append(row);
    }
    if (!steps.length) rows.append(el('li', '未记录步骤。'));
    return rows;
  }
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
      const body = el('div', '', 'workflow-version-layout');
      const definition = el('section', '', 'workflow-definition'); definition.setAttribute('aria-label', '流程定义与参数');
      const lifecycle = el('aside', '', 'workflow-lifecycle'); lifecycle.setAttribute('aria-label', '版本资格与回放记录');
      body.append(definition, lifecycle); detail.append(body);
      const restriction = replayRestriction(flow);
      const sourceName = flow.sourceTrace?.split(/[\\/]/).at(-1) || '未记录';
      definition.append(el('h3', '用途与来源'), el('p', `目标：${flow.taskPattern}`),
        el('p', `来源 Task：${flow.sourceTaskId || '未记录'} · 轨迹：${sourceName}`),
        el('h3', `固定步骤 · ${flow.steps.length} 步`), stepList(flow.steps));
      const conditions = el('section', '', 'workflow-conditions'); conditions.append(el('h3', '前置与完成条件'));
      for (const condition of flow.preconditions) conditions.append(el('p', `${condition.kind} · ${condition.value ?? `${condition.source} / ${condition.role} / ${condition.name}`}`));
      if (!flow.preconditions.length) conditions.append(el('p', '未声明前置条件，不代表任意环境可用。'));
      if (flow.scope === 'stage') conditions.append(el('p', `阶段完成条件：${flow.stageCondition || '未记录'}`));
      showJSON('完成条件与文件结果声明（非生成证明）', { successConditions: flow.successConditions, durableContract: flow.durableContract || [] }, conditions);
      definition.append(conditions);
      lifecycle.append(el('h3', '版本资格'), el('p', flow.status === 'candidate' ? '候选尚未晋升；保存候选不证明可回放。' : flow.status === 'verified' ? '此固定版本已验证；当次环境、参数和权限仍须重新核对。' : '已停用版本保留历史，不直接运行。'),
        el('p', restriction || '仅对现有 Windows / Browser 整任务接口开放；预览不授予输入权。', 'workflow-restriction'));
      lifecycle.append(el('h3', '已知限制'));
      for (const failure of flow.knownFailures || []) lifecycle.append(el('p', failure));
      if (!flow.knownFailures?.length) lifecycle.append(el('p', '未记录已知失败，不代表不存在风险。'));
      const edit = el('details', '', 'workflow-description'); edit.append(el('summary', '编辑名称与说明'));
      const editForm = el('form', '');
      const nameLabel = el('label', '流程名称'); const nameInput = el('input', ''); nameInput.value = metadata[flow.id].displayName || flow.taskPattern.slice(0, 80); nameInput.maxLength = 80; nameInput.required = true; nameLabel.append(nameInput);
      const descLabel = el('label', '用途说明'); const descInput = el('textarea', ''); descInput.value = metadata[flow.id].description; descInput.maxLength = 500; descInput.rows = 3; descLabel.append(descInput);
      const save = el('button', '保存名称与说明'); save.type = 'submit'; const saveMessage = el('p', '所有版本共用名称与说明；不会修改执行步骤或验证状态。'); saveMessage.setAttribute('role', 'status');
      editForm.append(nameLabel, descLabel, save, saveMessage); edit.append(editForm); definition.append(edit);
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
      lifecycle.append(el('p', `成功 ${flow.successCount} 次 / 失败 ${flow.failureCount} 次；最近成功回放：${flow.lastVerifiedAt || '尚无成功回放记录'}`));
      lifecycle.append(el('p', flow.scope === 'stage'
        ? '阶段候选在相似任务中尝试回放；只有阶段验收通过且未回退探索才自动晋级。已验证也不代表所有环境都适用。'
        : '页面试运行只记录结果并保留候选状态；“已验证”是后台版本状态，须结合回放证据核对，不代表所有环境都适用。'));
      if (flow.status === 'candidate' && flow.scope !== 'stage') {
        const publishReview = el('details', '', 'workflow-publish');
        publishReview.append(el('summary', '审核并发布此候选版本'));
        publishReview.append(el('p', `请核对 v${flow.version} 的步骤、完成条件与最近回放：成功 ${flow.successCount} 次，失败 ${flow.failureCount} 次。发布后此版本可被正常执行和匹配。`));
        const publish = el('button', '确认发布为已验证'); publish.type = 'button';
        publish.disabled = ownedChrome(flow) || flow.successCount < 1;
        const publishMessage = el('p', ownedChrome(flow) ? restriction : flow.successCount < 1 ? '至少需要一次成功试运行。' : '');
        publishMessage.setAttribute('role', 'status');
        publish.onclick = async () => {
          if (ownedChrome(flow) || flow.successCount < 1 || current !== requestId) return;
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
          finally { if (current === requestId) publish.disabled = ownedChrome(flow) || flow.successCount < 1; }
        };
        publishReview.append(publish, publishMessage); lifecycle.append(publishReview);
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
        form.append(el('p', `参数类型：${input.kind || 'text'}${input.boundTo ? ` · 绑定步骤 ${input.boundTo.stepId} / ${input.boundTo.argument}` : ' · 未声明步骤绑定'}`));
      }
      if (!flow.inputs.length) form.append(el('p', '此版本没有参数。'));
      const button = el('button', '预览步骤（不执行）'); button.type = 'submit'; form.append(button);
      const preview = el('div', '', 'workflow-preview'); preview.setAttribute('aria-live', 'polite');
      const execution = el('div', '', 'workflow-execution');
      const execute = el('button', '执行此版本'); execute.type = 'button'; execute.disabled = true;
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
      const eligible = !restriction;
      if (trial) execute.textContent = '试运行此候选版本';
      execution.append(el('p', eligible ? '执行前会准备目标并重新观察；流程偏离时停止，不转入自由探索。请先预览并核对步骤。' : '当前版本仅可预览。'), budgetOptions, execute, executionMessage);
      execute.title = restriction || '须先预览并核对当次参数、环境；后台继续检查授权。';
      if (trial && eligible) execution.firstChild.textContent = '试运行会实际执行，并记录成功或失败；不会自动发布。请审核回放证据后显式发布。';
      if (flow.scope === 'stage') execution.firstChild.textContent = '这是阶段流程，需要阶段上下文与 Stage Verifier，目前不能作为整任务单独试运行。可继续预览。';
      let prepared = null, submitting = false;
      let desktopSelection;
      const updateDesktopSelection = () => {
        const problem = desktopSelection?.problem();
        execute.disabled = !eligible || !prepared || submitting || !!problem;
        if (!submitting) executionMessage.textContent = problem || '';
      };
      if (eligible && flow.environment === 'windows') {
        const label = el('label', '执行桌面'); const select = el('select', ''); select.id = 'workflow-desktop-target';
        label.append(select); execution.prepend(label);
        desktopSelection = window.createDesktopSelection(select, false, updateDesktopSelection);
        select.onchange = updateDesktopSelection;
      }
      execute.onclick = async () => {
        if (!eligible || !prepared || submitting || current !== requestId) return;
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
          const selectedTarget = desktopSelection?.payload().desktopTarget;
          const response = await fetch(`${endpoint(flow)}/${trial ? 'trial' : 'execute'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: selectedPreview.values, definitionHash: selectedPreview.definitionHash, destination: flow.environment,
              ...(selectedTarget ? { desktopTarget: selectedTarget } : {}),
              ...(Object.keys(budget).length ? { budget } : {}) }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '提交失败');
          prepared = null;
          executionMessage.textContent = `任务已提交：${result.taskId}`;
          document.dispatchEvent(new CustomEvent('workbench:workflow-submitted', { detail: `${result.source}/${result.taskId}` }));
        } catch (error) { executionMessage.textContent = `${String(error)} 若网络中断，请先检查任务记录再重试。`; }
        finally { submitting = false; execute.disabled = !eligible || !prepared || !!desktopSelection?.problem(); }
      };
      let previewRequest = 0, previewing = false;
      form.oninput = () => {
        prepared = null; execute.disabled = true; executionMessage.textContent = '';
        try { sessionStorage.setItem(draftKey, JSON.stringify(Object.fromEntries(new FormData(form)))); } catch {}
        previewRequest++; preview.replaceChildren(el('p', '参数已改变，请重新预览。'));
      };
      form.onsubmit = async event => {
        event.preventDefault(); if (previewing || current !== requestId) return;
        const previewId = ++previewRequest; previewing = true; button.disabled = true; prepared = null; execute.disabled = true;
        preview.replaceChildren(el('p', '正在展开参数…'));
        try {
          const result = await fetch(`${endpoint(flow)}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: Object.fromEntries(new FormData(form)) }) });
          const value = await result.json();
          if (current !== requestId || previewId !== previewRequest) return;
          if (!result.ok) throw new Error(value.error || '参数预览失败');
          if (value.executed !== false || value.id !== flow.id || value.version !== flow.version || typeof value.definitionHash !== 'string') throw new Error('预览身份或只读结果不匹配，请重新读取版本。');
          prepared = value; execute.disabled = !eligible || submitting || !!desktopSelection?.problem();
          preview.replaceChildren(el('p', `v${value.version} 参数预览 · 未执行任何动作`));
          const steps = el('ol', '', 'workflow-step-preview');
          const actions = { click: '点击', double_click: '双击', type: '输入文字', paste_text: '粘贴文字', keypress: '按键', scroll: '滚动', navigate: '打开网页', wait: '等待' };
          const conditions = { text_includes: '画面包含文字', accessibility_includes: '控件包含文字', url_includes: '网址包含', state_changed: '画面状态发生变化' };
          for (const step of value.steps) {
            const row = el('li', ''); row.append(el('strong', step.goal), el('p', `${actions[step.action.kind] || step.action.kind} · 验证：${conditions[step.successCondition.kind] || step.successCondition.kind}${step.successCondition.value ? `「${step.successCondition.value}」` : ''}`));
            steps.append(row);
          }
          preview.append(steps);
          preview.append(el('p', restriction || '本次只展开参数；实际执行仍需后台检查环境、前置条件、风险和许可。'));
          if (value.steps.some(step => step.idempotent === false)) preview.append(el('p', '包含非幂等步骤：可能创建或修改数据，结果未知时禁止自动重试。'));
          preview.append(el('p', `当前参数：${JSON.stringify(value.values)}`));
          if (flow.scope === 'stage' && value.stageCondition) preview.append(el('p', `阶段完成条件：${value.stageCondition}`));
          showJSON('查看完整步骤定义', value.steps, preview);
          showJSON('前置条件与完成条件', { preconditions: value.preconditions, successConditions: value.successConditions }, preview);
        } catch (error) { if (current === requestId && previewId === previewRequest) preview.replaceChildren(el('p', String(error))); }
        finally { previewing = false; button.disabled = false; }
      };
      definition.append(form, preview); lifecycle.append(execution);
      showJSON('原始步骤与前置条件', { steps: flow.steps, preconditions: flow.preconditions, successConditions: flow.successConditions }, technical);
      showJSON('已知失败', flow.knownFailures, technical);
      lifecycle.append(el('h3', '最近回放记录'));
      lifecycle.append(el('p', data.runsAvailable ? `最多展示最近 ${data.runsLimit} 条，此处仅记录流程回放结果。` : '旧存储没有回放记录表。'));
      if (!data.runs.length) lifecycle.append(el('p', '暂无回放记录。'));
      for (const run of data.runs) lifecycle.append(el('p', `${run.outcome === 'success' ? '成功' : run.outcome === 'failure' ? '失败' : run.outcome || 'UNKNOWN'} · ${run.createdAt} · 任务 ${run.taskId}${run.stageId ? ` · 阶段 ${run.stageId}` : ''}${run.reason ? ` · ${run.reason}` : ''}`));
      definition.append(technical);
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
