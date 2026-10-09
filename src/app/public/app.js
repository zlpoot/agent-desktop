const byId = (id) => document.getElementById(id);
const workbench = window.Workbench;
const taskExperience = workbench && window.createTaskExperience();
let selectionRequest = 0;
const taskLoadFeedback = node('section', 'task-load-feedback panel'); taskLoadFeedback.hidden = true;
const taskLoadMessage = node('p', 'operation-feedback'); taskLoadMessage.setAttribute('role', 'status');
const taskLoadRetry = node('button', '', '重试读取任务'); taskLoadRetry.type = 'button';
taskLoadRetry.onclick = () => { void loadSelected(); };
taskLoadFeedback.append(taskLoadMessage, taskLoadRetry); byId('detail').before(taskLoadFeedback);
let reportUrl;
const evidenceTools = document.createElement('div');
evidenceTools.className = 'evidence-navigation';
const previousEvidence = node('button', '', '上一步'); previousEvidence.type = 'button';
const nextEvidence = node('button', '', '下一步'); nextEvidence.type = 'button';
const evidencePosition = node('span', '', '');
evidenceTools.append(previousEvidence, evidencePosition, nextEvidence);
document.querySelector('.evidence-detail .section-head').after(evidenceTools);
const report = node('a', 'report-download', '下载执行报告（JSON）');
const workflowBinding = node('p', 'workflow-binding');
document.querySelector('.hero').append(workflowBinding, report);
const artifactNote = node('p', 'artifact-note', '此处提供执行报告与已记录截图。Guest 内生成的文件尚未接入下载，不根据任务描述推断文件已生成。');
report.after(artifactNote);
function moveEvidence(offset) {
  const steps = view.detail?.steps || [];
  const index = steps.findIndex(step => step.step === view.activeStep);
  const next = steps[index + offset];
  if (next) { selectStep(next.step); showStepTab('screenshot'); }
}
previousEvidence.onclick = () => moveEvidence(-1);
nextEvidence.onclick = () => moveEvidence(1);
const view = { runs: [], selected: null, detail: null, activeStep: null,
  activeTab: "process", activeStepTab: "action", prompts: [] };
const statusText = { queued: "排队中", preparing: "准备中", verifying: "正在验证", unknown: "结果未知", running: "运行中", pause_requested: "请求暂停中", paused: "已暂停",
  waiting_user: "等待人工", done: "已完成", failed: "失败", stopped: "已停止" };
const actionText = { navigate: "打开网页", click: "点击", double_click: "双击", type: "输入", keypress: "按键", scroll: "滚动", wait: "等待", screenshot: "截图", ask_user: "询问用户", done: "结束" };
const phaseText = { observe: "观察", decide: "决策", ground: "定位", resolve_action: "工具选择", risk_check: "风险检查", execute: "执行", verify: "动作验证", verify_task: "目标验证", recover: "重试", human_interrupt: "人工确认", finish: "结束" };
const evidenceSourceText = { dom: "网页 DOM", uia: "Windows UIA", visual_model: "截图模型转录", browser: "浏览器地址", window: "窗口标题", human: "人工核对", unknown: "来源未记录" };

function node(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content != null) item.textContent = String(content);
  return item;
}
function clear(item) { item.replaceChildren(); }
function when(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function duration(value) {
  if (value == null || !Number.isFinite(value)) return "未记录";
  return value < 1000 ? `${Math.max(1, Math.round(value))} ms` : `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} s`;
}
function shortTarget(action) {
  const target = action?.target;
  if (!target) return action?.url || action?.keys || "";
  if (target.kind === "candidates") return `${target.options.length} 个候选目标`;
  return target.name || target.label || target.text || target.selector || target.description ||
    (target.kind === "coordinate" ? `(${target.x}, ${target.y})` : "");
}
function labelAction(action) { return action ? `${actionText[action.kind] || action.kind}${shortTarget(action) ? ` · ${shortTarget(action)}` : ""}` : "尚未决定"; }
function key(run) { return `${run.source}/${run.taskId}`; }
function criteriaText(criteria) {
  if (!criteria) return "";
  const fields = [];
  if (criteria.pageTextIncludes) fields.push(`画面文字含“${criteria.pageTextIncludes}”`);
  for (const label of criteria.pageTextNumberLabels || []) fields.push(`“${label}”有数值`);
  for (const label of criteria.pageTextIncludesAll || []) fields.push(`画面文字含“${label}”`);
  if (criteria.accessibilityIncludes) fields.push(`控件信息含“${criteria.accessibilityIncludes}”`);
  if (criteria.urlIncludes) fields.push(`网址含“${criteria.urlIncludes}”`);
  return fields.length ? `验收条件：${fields.join("；")}` : "";
}

async function refresh() {
  try {
    const response = await fetch("/api/runs");
    if (!response.ok) throw new Error("无法读取执行记录");
    view.runs = (await response.json()).runs;
    if (workbench?.mode === 'history' && workbench.routeTask) view.selected = workbench.routeTask;
    else if (!view.selected || !view.runs.some((run) => key(run) === view.selected)) view.selected = view.runs[0] ? key(view.runs[0]) : null;
    if (workbench?.mode === 'live') view.selected = workbench.select(view.runs, view.selected) ? key(workbench.select(view.runs, view.selected)) : null;
    renderRuns();
    if (view.selected) await loadSelected();
    else { selectionRequest++; taskLoadFeedback.hidden = true; view.detail = null; byId("empty").hidden = false; byId("detail").hidden = true; workbench?.sync(null); }
    byId("last-update").textContent = `最近更新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (error) { byId("last-update").textContent = String(error); }
}

function renderRuns() {
  workbench?.runs(view.runs);
  taskExperience?.runs(view.runs);
  const list = byId("run-list"); clear(list);
  for (const run of view.runs) {
    if (workbench && !workbench.matches(run)) continue;
    const button = node("button", `run-card${key(run) === view.selected ? " active" : ""}`);
    button.type = "button";
    button.append(node("span", "run-title", run.goal), node("span", "run-meta"));
    button.lastChild.append(node("span", "", statusText[run.status] || run.status), node("span", "", when(run.updatedAt)));
    button.addEventListener("click", async () => {
      view.selected = key(run); view.activeStep = null; view.activeTab = "process";
      if (workbench) workbench.navigate('history', key(run));
      view.activeStepTab = "action"; renderRuns(); await loadSelected();
    });
    list.append(button);
  }
  if (!list.children.length) list.append(node('p', 'task-list-empty', view.runs.length ? '没有匹配的任务，请调整搜索或状态筛选。' : '暂无任务记录，可到工作台开始新任务。'));
}

async function loadSelected() {
  const run = view.runs.find((item) => key(item) === view.selected);
  if (!run) { selectionRequest++; taskLoadFeedback.hidden = true; view.detail = null; workbench?.sync(null); return; }
  const request = ++selectionRequest;
  if (!view.detail || key(view.detail) !== key(run)) {
    view.detail = null; workbench?.sync(null); byId('detail').hidden = true;
    taskLoadFeedback.hidden = false; taskLoadRetry.hidden = true;
    taskLoadMessage.dataset.state = 'loading'; taskLoadMessage.textContent = '正在读取任务详情…';
  }
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(run.source)}/${encodeURIComponent(run.taskId)}`);
    if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
    const sameRun = view.detail && key(view.detail) === view.selected;
    const scroll = sameRun ? Object.fromEntries(["flow-chart", "step-list", "step-detail", "evidence-detail"]
      .map((id) => [id, (byId(id) || document.querySelector(`.${id}`))?.scrollTop || 0])) : null;
    const result = await response.json();
    if (request !== selectionRequest || key(run) !== view.selected) return;
    taskLoadFeedback.hidden = true;
    view.detail = result;
    renderDetail();
    taskExperience?.detail(view.detail);
    workbench?.sync(view.detail);
    if (scroll) for (const [id, position] of Object.entries(scroll)) {
      const item = byId(id) || document.querySelector(`.${id}`);
      if (item) item.scrollTop = position;
    }
  } catch (error) {
    if (request !== selectionRequest || key(run) !== view.selected) return;
    view.detail = null; workbench?.sync(null); byId('detail').hidden = true;
    taskLoadFeedback.hidden = false; taskLoadRetry.hidden = false;
    taskLoadMessage.dataset.state = 'error'; taskLoadMessage.textContent = `任务详情暂不可用：${error.message || error}。可重试，系统也会自动刷新。`;
  }
}

function showTab(tab) {
  view.activeTab = tab;
  for (const button of document.querySelectorAll(".detail-tab")) {
    const selected = button.dataset.tab === tab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  for (const panel of document.querySelectorAll("[data-tab-panel]")) panel.hidden = panel.dataset.tabPanel !== tab;
}

function showStepTab(tab) {
  view.activeStepTab = tab;
  for (const button of document.querySelectorAll(".step-tab")) {
    const selected = button.dataset.stepTab === tab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  for (const panel of document.querySelectorAll("[data-step-panel]")) panel.hidden = panel.dataset.stepPanel !== tab;
}

function renderDetail() {
  const run = view.detail;
  if (!run) return;
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  reportUrl = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(),
    evidenceNote: '历史记录；截图单独下载；不包含 Guest 输出文件。', run }, null, 2)], { type: 'application/json' }));
  report.href = reportUrl; report.download = `task-${run.taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
  workflowBinding.textContent = run.workflowRef
    ? `${run.workflowRef.trial ? '候选试运行' : '绑定流程'}：${run.workflowRef.id} · v${run.workflowRef.version} · ${run.workflowRef.definitionHash ? '已记录定义摘要' : '旧记录无定义摘要'}（恢复不会自动升级版本）`
    : '此记录未绑定固定 Workflow 版本。';
  byId("empty").hidden = true; byId("detail").hidden = false;
  byId("source-name").textContent = run.source;
  byId("goal").textContent = run.goal;
  const statusLabel = run.status === 'done' && run.humanReview?.approved ? '人工确认完成' : statusText[run.status] || run.status;
  const status = byId("status"); status.textContent = statusLabel; status.className = `status ${run.status}`;
  byId("summary").textContent = (run.status === "failed" ? run.error : run.summary) ||
    run.error || run.summary || "任务仍在进行，结果尚未生成。";
  const outcomeLabels = { execution_failure: '执行失败', verification_failure: '验证失败',
    verifier_unsupported: '验证器不支持当前完成条件', human_confirmed_auto_unknown: '人工确认完成；自动验收仍未知',
    evidence_insufficient: '结果证据不足', verified: '自动验证通过', in_progress: '尚未得到最终结果' };
  const outcome = run.outcome;
  const evidenceDetails = run.goalVerification?.evidence?.length
    ? `；证据：${run.goalVerification.evidence.map((item) =>
      `${evidenceSourceText[item.source] || item.source}（${item.strength === "strong" ? "强" : item.strength === "weak" ? "弱" : "未知"}）`).join("、")}` : "";
  byId("goal-verification").textContent = outcome
    ? `结果判断：${outcomeLabels[outcome.diagnosis] || outcome.diagnosis}；自动验收 ${outcome.autoVerification.verdict.toUpperCase()}${outcome.autoVerification.reason ? `（${outcome.autoVerification.reason}）` : ''}${outcome.autoVerification.message ? `；${outcome.autoVerification.message}` : ''}${evidenceDetails}`
    : run.goalVerification
    ? `完成验证：${run.goalVerification.message}${run.goalVerification.evidence?.length
      ? `；证据：${run.goalVerification.evidence.map((item) =>
        `${evidenceSourceText[item.source] || item.source}（${item.strength === "strong" ? "强" : item.strength === "weak" ? "弱" : "未知"}）`).join("、")}` : ""}` : "";
  byId("goal-criteria").textContent = criteriaText(run.completionCriteria);
  const reviewRecord = byId('manual-review-record');
  reviewRecord.hidden = false;
  reviewRecord.textContent = run.humanReview
    ? `人工验收：${run.humanReview.approved ? '确认完成' : '暂不确认'} · ${when(run.humanReview.reviewedAt)} · ${run.humanReview.note}` : '暂无可读取的系统内人工验收记录';
  byId("facet-state").textContent = facetSummaryLine(run.facets);
  const resume = byId("resume-controls");
  resume.hidden = !(run.source === "web-tasks.sqlite" && run.status === "waiting_user" && run.interactionKind !== 'app_onboarding');
  byId("resume-question").textContent = run.error || "任务等待人工处理";
  const interaction = run.interactionKind || (run.steps.at(-1)?.action?.kind === "ask_user"
    ? "question" : "approval");
  byId("resume-answer").hidden = interaction !== "question";
  byId("resume-reject").hidden = interaction === "question";
  byId("resume-approve").textContent = interaction === "final_review" ? "确认完成"
    : interaction === "question" ? "提交回答" : "允许执行";
  byId("resume-reject").textContent = interaction === "final_review" ? "尚未完成" : "拒绝执行";
  byId('manual-review-controls').hidden = !run.canManualReview;
  byId('manual-review-question').textContent = run.canManualReview
    ? `自动验收未能确认最终结果（${run.acceptanceReport?.message || '证据不足'}）。请独立核对实际结果并填写依据；人工结论不计为自动验收或 Workflow 晋级。`
    : '';
  const controls = byId("task-controls");
  controls.hidden = !run.canPause || run.appOnboarding?.state === 'new_task_required' ||
    !["running", "pause_requested", "paused"].includes(run.status);
  byId("task-pause").hidden = run.status !== "running";
  byId("task-continue").hidden = !!run.desktopScenario || run.status !== "paused";
  byId("task-pause").textContent = run.desktopScenario ? '停止并清理' : '暂停任务';
  byId("task-control-note").textContent = run.desktopScenario ? '停止后撤销许可并清理；UNKNOWN 不重放，只能显式新建任务。' : run.status === "pause_requested"
    ? "当前动作完成并验证后暂停" : run.status === "paused"
      ? run.recoveryRequired ? "任务现场已保留；继续时重新观察，旧动作不会直接重放"
        : "可手动操作目标应用，继续时会重新观察" : "可在安全边界暂停";
  byId("task-id").textContent = `任务 ID · ${run.taskId}`;
  byId("updated-at").textContent = `更新于 ${when(run.updatedAt)}`;
  const staged = !!run.stagePlanVersion;
  const percentage = run.status === "done" ? 100 : run.plan.length
    ? Math.min(99, Math.round(run.completedActions / run.plan.length * 100)) : 0;
  byId("progress-number").textContent = staged
    ? `${run.completedStages.length} 阶段完成` : `${percentage}%`;
  byId("progress-fill").parentElement.hidden = staged;
  byId("progress-fill").style.width = `${percentage}%`;
  byId("action-count").textContent = String(run.completedActions);
  byId("elapsed-time").textContent = duration(run.elapsedMs);
  byId("active-time").textContent = run.activeDurationMs == null
    ? "旧任务未采集处理耗时" : `节点处理 ${duration(run.activeDurationMs)}`;
  byId("token-count").textContent = run.taskBudget ? String(run.taskBudget.usage.deepseek.tokens + run.taskBudget.usage.jev.tokens)
    : !run.metricsAvailable ? "未记录" : run.modelCalls === 0 ? "0"
    : run.reportedTokenCalls ? String(run.totalTokens) : "未提供";
  byId("model-calls").textContent = run.taskBudget
    ? `DeepSeek ${run.taskBudget.usage.deepseek.calls}/${run.taskBudget.limits.deepseek.maxCalls} 次、${run.taskBudget.usage.deepseek.tokens}/${run.taskBudget.limits.deepseek.maxTokens} Token；JEV ${run.taskBudget.usage.jev.calls}/${run.taskBudget.limits.jev.maxCalls} 次、${run.taskBudget.usage.jev.tokens}/${run.taskBudget.limits.jev.maxTokens} Token${run.taskBudget.usage.deepseek.unreportedCalls + run.taskBudget.usage.jev.unreportedCalls ? '（部分调用未返回用量）' : ''}`
    : !run.metricsAvailable ? "旧任务未采集模型用量" : run.modelCalls === 0 ? "规则或脚本决策，无模型调用"
    : `${run.modelNames.join("、") || "模型"} · ${run.reportedTokenCalls}/${run.modelCalls} 次返回用量`;
  byId("result-label").textContent = statusLabel;
  byId("result-note").textContent = (run.status === "failed" ? run.error : run.summary) ||
    run.error || run.summary || "等待后续步骤";
  byId("plan-source").textContent = staged ? `滚动计划 v${run.stagePlanVersion}` : run.planSource;
  const planList = byId("plan-list"); clear(planList);
  const planRows = staged ? [...run.completedStages.map((item) => item.goal),
    ...(run.stage ? [run.stage.goal] : [])] : run.plan;
  planRows.forEach((item, index) => {
    const complete = staged ? index < run.completedStages.length
      : run.status === "done" || index < run.completedActions;
    const row = node("li", complete ? "complete" : "");
    row.append(node("span", "plan-dot", complete ? "✓" : index + 1), node("span", "", item)); planList.append(row);
  });
  byId("step-count").textContent = `${run.steps.length} 步`;
  if (view.activeStep == null || !run.steps.some((step) => step.step === view.activeStep)) {
    view.activeStep = [...run.steps].reverse().find((step) => step.hasScreenshot)?.step ?? run.steps.at(-1)?.step ?? null;
  }
  renderSteps(); renderStepDetail(); renderFlow(); renderStats(); renderCapabilities(); renderWorkflowEvents(); renderStages();
  showTab(view.activeTab); showStepTab(view.activeStepTab);
}

function renderStages() {
  const container = byId("stage-list"); clear(container);
  const run = view.detail;
  for (const stage of run.completedStages || []) {
    container.append(node("p", "", `✓ ${stage.goal} · ${stage.evidence}`));
  }
  if (run.stage) container.append(node("p", "", `进行中：${run.stage.goal} · ${run.stage.successCondition}`));
  if (run.diagnosis) container.append(node("p", "", `自主诊断：${run.diagnosis.reason}；下一步：${run.diagnosis.remedy}`));
  if (!container.childNodes.length) container.append(node("p", "", "尚未生成阶段计划"));
}

function flowGroups(run) {
  const stages = [...(run.completedStages || []).map((stage, index) => ({
    title: stage.goal, start: stage.startStep, end: stage.endStep,
    state: "complete", number: index + 1, key: `stage-${index + 1}`,
  })), ...(run.stage ? [{ title: run.stage.goal, start: run.stage.startedAtStep,
    end: Infinity, state: "current", number: (run.completedStages || []).length + 1,
    key: `stage-${(run.completedStages || []).length + 1}` }] : [])];
  if (!stages.length) return [{ key: "all", title: "执行步骤", state: "current", steps: run.steps }];
  const groups = [];
  let previousEnd = 0;
  for (const stage of stages) {
    const before = run.steps.filter((step) => step.step > previousEnd && step.step <= stage.start);
    if (before.length) groups.push({ key: `before-${stage.number}`, title: "准备与探索", state: "other", steps: before });
    const steps = run.steps.filter((step) => step.step > stage.start && step.step <= stage.end);
    groups.push({ key: stage.key, title: `阶段 ${stage.number} · ${stage.title}`, state: stage.state, steps });
    previousEnd = stage.end;
  }
  const after = run.steps.filter((step) => step.step > previousEnd);
  if (after.length) groups.push({ key: "after", title: "后续动作", state: "other", steps: after });
  return groups;
}

function selectStep(step, fromFlow = false) {
  view.activeStep = step;
  if (fromFlow) {
    showTab("evidence");
    requestAnimationFrame(() => document.querySelector(".detail-tabs")?.scrollIntoView({ block: "start" }));
  }
  renderSteps(); renderStepDetail(); renderFlow();
}

function renderFlow() {
  const container = byId("flow-chart");
  const run = view.detail;
  if (!run) return;
  const previousOpen = view.flowRun === key(run)
    ? new Set([...container.querySelectorAll(".flow-stage[open]")].map((item) => item.dataset.group))
    : null;
  view.flowRun = key(run);
  clear(container);
  const start = node("div", "flow-node start");
  start.append(node("span", "flow-kicker", "开始 · 规划"), node("strong", "", run.goal),
    node("small", "", `${run.plan.length} 项计划`));
  container.append(start);
  for (const group of flowGroups(run)) {
    container.append(node("span", "flow-arrow", "↓"));
    const stage = node("details", `flow-stage ${group.state}`);
    stage.dataset.group = group.key;
    stage.open = previousOpen ? previousOpen.has(group.key) ||
      group.steps.some((step) => step.step === view.activeStep)
      : group.steps.some((step) => step.step === view.activeStep) ||
        (run.steps.length <= 4 && group.state === "current");
    const summary = node("summary", "flow-stage-summary");
    summary.append(node("strong", "", group.title), node("span", "", `${group.steps.length} 步`));
    stage.append(summary);
    const items = node("div", "flow-stage-steps");
    if (!group.steps.length) items.append(node("p", "", "等待执行动作"));
    for (const step of group.steps) {
      const outcome = step.verification || step.result;
      const state = outcome ? outcome.ok ? "success" : "failure" : "pending";
      const card = node("button", `flow-node action ${state}${view.activeStep === step.step ? " active" : ""}`);
      card.type = "button";
      card.append(node("span", "flow-kicker", `第 ${step.step} 步 · ${duration(step.durationMs)}`),
        node("strong", "", labelAction(step.action)),
        node("small", "", outcome ? `${outcome.ok ? "通过" : "未通过"} · ${outcome.message}` : "等待执行或确认"));
      card.addEventListener("click", () => selectStep(step.step, true));
      items.append(card);
    }
    stage.append(items); container.append(stage);
  }
  container.append(node("span", "flow-arrow", "↓"));
  const end = node("div", `flow-node end ${run.status}`);
  end.append(node("span", "flow-kicker", "当前结果"),
    node("strong", "", statusText[run.status] || run.status),
    node("small", "", run.goalVerification?.message || run.error || run.summary || "等待后续步骤"));
  container.append(end);
}

function renderWorkflowEvents() {
  const container = byId("workflow-events"); clear(container);
  const events = view.detail.workflowEvents || [];
  if (!events.length) { container.append(node("p", "", "固定任务或旧记录没有流程检索记录")); return; }
  for (const event of events) {
    container.append(node("p", "", `${when(event.time)} · ${event.kind === "workflow_search" ? "流程检索" : "回退探索"} · ${event.detail || ""}`));
  }
}

function renderCapabilities() {
  const container = byId("capability-resolutions");
  const rows = view.detail.capabilityResolutions || [];
  const openGroups = new Set([...container.querySelectorAll(".capability-group[open]")]
    .map((item) => item.dataset.phase));
  const openItems = new Set([...container.querySelectorAll(".capability-item[open]")]
    .map((item) => item.dataset.index));
  clear(container);
  if (!rows.length) { container.append(node("p", "", "旧任务未记录能力选择")); return; }
  const operationNames = { attach: "绑定", observe: "观察", locate: "定位", act: "执行", choose: "决策", verify: "验证" };
  const groups = new Map();
  rows.forEach((item, index) => {
    if (!groups.has(item.phase)) groups.set(item.phase, []);
    groups.get(item.phase).push({ item, index });
  });
  for (const [phase, entries] of groups) {
    const group = node("details", "capability-group");
    group.dataset.phase = phase;
    group.open = openGroups.has(phase);
    const summary = node("summary", "capability-summary");
    summary.append(node("strong", "", phase), node("span", "", `${entries.length} 次选择 · 点击展开`));
    group.append(summary);
    for (const { item, index } of entries) {
      const entry = node("details", "capability-item");
      entry.dataset.index = String(index);
      entry.open = openItems.has(String(index));
      const selected = item.candidates.find((candidate) => candidate.id === item.selected);
      const rejected = item.candidates.filter((candidate) => candidate.id !== item.selected)
        .map((candidate) => `${candidate.provider}：${candidate.reasons.join("、") || "优先级较低"}`);
      const row = node("summary", "capability-choice");
      row.append(node("span", "", operationNames[item.operation] || item.operation),
        node("strong", "", selected?.provider ||
          (item.candidates.some((candidate) => candidate.availability === "pending") ? "等待检查" : "不可用")));
      entry.append(row, node("p", "capability-reasons", rejected.join("；") || "条件满足"));
      group.append(entry);
    }
    container.append(group);
  }
}

function renderSteps() {
  const list = byId("step-list"); clear(list);
  for (const step of view.detail.steps) {
    const button = node("button", `step-card${step.step === view.activeStep ? " active" : ""}`);
    button.type = "button";
    const top = node("div", "step-card-top");
    const outcome = step.verification || step.result;
    top.append(node("span", "", `${String(step.step).padStart(2, "0")}  ${actionText[step.action?.kind] || step.action?.kind || "步骤"}`),
      node("span", outcome ? (outcome.ok ? "ok" : "bad") : "pending",
        `${duration(step.durationMs)} · ${outcome ? (outcome.ok ? "已验证" : "未通过") : "待处理"}`));
    button.append(top, node("small", "", shortTarget(step.action) || step.url || ""));
    button.addEventListener("click", () => selectStep(step.step));
    list.append(button);
  }
}

function addRow(parent, label, value, pre = false) {
  const row = node("div", "detail-row"); row.append(node("span", "", label), node(pre ? "pre" : "strong", "", value || "—")); parent.append(row);
}

/** 域无关的业务证据（facet）展示：核心 UI 不认识任何具体域，只按 facetId/data 通用渲染。 */
function facetDataText(data) {
  if (data === null || data === undefined) return "—";
  if (typeof data !== "object") return String(data);
  return Object.entries(data).map(([key, value]) =>
    `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join("\n");
}
function facetRows(parent, facets) {
  for (const facet of facets ?? []) {
    addRow(parent, `业务证据 ${facet.facetId}${facet.complete ? "" : "（不完整）"}`,
      facetDataText(facet.data), true);
  }
}
function facetSummaryLine(facets) {
  if (!facets?.length) return "";
  return facets.map((facet) =>
    `${facet.facetId}${facet.complete ? "" : "（不完整）"}：${facetDataText(facet.data).replace(/\n/g, "；")}`).join("\n");
}

function renderStepDetail() {
  const step = view.detail.steps.find((item) => item.step === view.activeStep);
  const index = view.detail.steps.indexOf(step);
  previousEvidence.disabled = index <= 0;
  nextEvidence.disabled = index < 0 || index >= view.detail.steps.length - 1;
  evidencePosition.textContent = step ? `历史记录 · ${index + 1} / ${view.detail.steps.length} · 第 ${step.step} 步` : '暂无步骤';
  byId("step-number").textContent = step ? `第 ${step.step} 步` : "";
  const detail = byId("step-detail"); clear(detail);
  const image = byId("screenshot"); clear(image);
  const metrics = byId("step-metrics"); clear(metrics);
  if (!step) { detail.append(node("p", "", "暂无步骤")); image.append(node("span", "", "暂无截图")); return; }
  addRow(detail, "动作", labelAction(step.action));
  addRow(detail, "步骤处理耗时", duration(step.durationMs));
  const decision = step.metrics?.find((item) => item.node === "decide");
  const execution = step.metrics?.find((item) => item.node === "execute");
  addRow(detail, "决策方式", decision ? `${decision.actor === "model" ? "模型" : "规则"} · ${decision.operator}` : "旧记录未采集");
  addRow(detail, "执行方式", execution?.operator || "尚未执行");
  const resolution = (view.detail.actionResolutions || []).find((item) => item.step === step.step);
  if (resolution) {
    addRow(detail, "预选工具", resolution.selected);
    addRow(detail, "选择原因", resolution.reason);
    addRow(detail, "候选工具", resolution.candidates.map((item) =>
      `${item.provider}：${item.available ? "可用" : "不可用"}，${item.reason}`).join("；"), true);
    addRow(detail, "执行回退", resolution.executionNote || "尚未执行");
  }
  const attempts = (view.detail.providerAttempts || []).filter((item) => item.step === step.step);
  if (attempts.length) addRow(detail, "工具尝试", attempts.map((item) =>
    `${item.provider}：${item.ok ? "成功" : item.effect === "none" ? "未执行" : "结果不明"}，${item.message}`)
    .join("；"), true);
  addRow(detail, "模型用量", decision?.actor === "model"
    ? decision.totalTokens == null ? "服务未返回 token 用量"
      : `${decision.totalTokens} token（输入 ${decision.inputTokens ?? "?"}，输出 ${decision.outputTokens ?? "?"}）`
    : decision ? "0 token（规则决策）" : "未记录");
  addRow(detail, "定位方式", step.strategy || "—");
  if (step.targetBinding) {
    addRow(detail, "语义目标", step.targetBinding.semantic?.label || "未标注");
    addRow(detail, "目标定位证据", `${step.targetBinding.strategy} · ${step.targetBinding.detail}`);
  }
  addRow(detail, "执行结果", step.result ? `${step.result.ok ? "成功" : "失败"} · ${step.result.message}` : "尚未执行");
  addRow(detail, "独立验证", step.verification ? `${step.verification.ok ? "通过" : "未通过"} · ${step.verification.message}` : "尚未验证");
  addRow(detail, "页面地址", step.url || "—");
  facetRows(detail, step.facets);
  addRow(detail, "页面文本摘录", step.pageText || "—", true);
  if (step.textSources?.length) addRow(detail, "文本来源", step.textSources.map((source) =>
    evidenceSourceText[source] || source).join("、"));
  if (step.metrics?.length) {
    metrics.append(node("h3", "", "阶段耗时与执行者"));
    const table = node("table"), head = node("thead"), body = node("tbody"), header = node("tr");
    for (const title of ["阶段", "执行者", "耗时", "Token"]) header.append(node("th", "", title));
    head.append(header);
    for (const item of step.metrics) {
      const row = node("tr");
      for (const value of [phaseText[item.node] || item.node, item.operator,
        duration(item.durationMs), item.actor === "model" ? item.totalTokens ?? "未提供" : "—"]) {
        row.append(node("td", "", value));
      }
      body.append(row);
    }
    table.append(head, body); metrics.append(table);
  }
  if (step.hasScreenshot) {
    const img = node("img"); img.alt = `第 ${step.step} 步的页面截图`;
    img.src = `/api/screenshots/${encodeURIComponent(view.detail.source)}/${encodeURIComponent(view.detail.taskId)}/${step.step}`;
    const caption = node('p', 'evidence-caption', `历史观察截图 · ${step.screenshotScope === "desktop" ? "完整桌面" : step.screenshotScope === "window" ? "窗口截图，未包含桌面" : "页面截图"}${step.desktopCaptureError ? " · 完整桌面采集失败" : ""} · ${when(step.screenshotTime)} · 仅回看，不发送桌面输入`);
    const download = node('a', 'report-download', '下载此截图'); download.href = img.src; download.download = `step-${step.step}.png`;
    img.onerror = () => { img.hidden = true; download.hidden = true; caption.textContent = '截图文件缺失或不可读取；此步骤的文字证据仍保留。'; };
    image.append(caption, img, download);
  } else image.append(node("span", "", "该步骤没有截图"));
}

function renderStats() {
  const container = byId("grounding-stats"); clear(container);
  if (!view.detail.groundingStats.length) { container.append(node("p", "", "暂无定位统计")); return; }
  const table = node("table"), head = node("thead"), body = node("tbody"), row = node("tr");
  for (const title of ["策略", "尝试", "命中", "执行成功"]) row.append(node("th", "", title));
  head.append(row);
  for (const stat of view.detail.groundingStats) {
    const item = node("tr");
    for (const value of [stat.strategy, stat.attempts, stat.matches, stat.successes]) item.append(node("td", "", value));
    body.append(item);
  }
  table.append(head, body); container.append(table);
}

byId("refresh").addEventListener("click", refresh);
for (const button of document.querySelectorAll(".detail-tab")) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}
for (const button of document.querySelectorAll(".step-tab")) {
  button.addEventListener("click", () => showStepTab(button.dataset.stepTab));
}

const promptRetry = node('button', '', '重试读取提示词'); promptRetry.type = 'button'; promptRetry.hidden = true;
byId('prompt-message').after(promptRetry);
byId('prompt-message').classList.add('operation-feedback');
let promptsLoading = false;
const promptDrafts = new Map();
try { for (const [id, content] of Object.entries(JSON.parse(sessionStorage.getItem('agent-desktop.prompt-drafts') || '{}'))) if (typeof content === 'string') promptDrafts.set(id, content); } catch {}
function storePromptDrafts() { try { sessionStorage.setItem('agent-desktop.prompt-drafts', JSON.stringify(Object.fromEntries(promptDrafts))); } catch {} }
async function loadPrompts() {
  if (promptsLoading) return;
  promptsLoading = true; promptRetry.hidden = true;
  byId('prompt-save').disabled = true;
  byId('prompt-message').textContent = '正在读取提示词…';
  byId('prompt-message').dataset.state = 'loading';
  try {
  const response = await fetch("/api/prompts");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "读取提示词失败");
  view.prompts = result.prompts;
  const select = byId("prompt-select"); clear(select);
  for (const prompt of view.prompts) {
    const option = node("option", "", prompt.label); option.value = prompt.id; select.append(option);
  }
  showPrompt();
  } catch (error) {
    byId('prompt-message').dataset.state = 'error';
    byId('prompt-message').textContent = `提示词读取失败：${error.message || error}。请重试。`;
    promptRetry.hidden = false;
  } finally { promptsLoading = false; byId('prompt-save').disabled = !view.prompts.length; }
}
promptRetry.onclick = loadPrompts;
function showPrompt() {
  const prompt = view.prompts.find((item) => item.id === byId("prompt-select").value);
  byId("prompt-content").value = promptDrafts.get(prompt?.id) ?? prompt?.content ?? "";
  byId("prompt-message").dataset.state = "success";
  byId("prompt-message").textContent = promptDrafts.has(prompt?.id) ? "尚未保存 · 已恢复本页草稿" : view.prompts.length ? "" : "暂无可编辑的提示词。";
}
byId("prompt-editor").addEventListener("toggle", () => {
  if (byId("prompt-editor").open && !view.prompts.length) loadPrompts().catch((error) => {
    byId("prompt-message").textContent = String(error);
  });
});
byId("prompt-select").addEventListener("change", showPrompt);
byId("prompt-content").addEventListener("input", () => {
  if (byId('prompt-select').value) { promptDrafts.set(byId('prompt-select').value, byId('prompt-content').value); storePromptDrafts(); }
  byId("prompt-message").dataset.state = "pending"; byId("prompt-message").textContent = "尚未保存";
});
byId("prompt-save").addEventListener("click", async () => {
  const button = byId("prompt-save"); button.disabled = true;
  byId("prompt-message").dataset.state = "loading";
  byId("prompt-message").textContent = "正在保存…";
  const id = byId("prompt-select").value;
  const content = byId("prompt-content").value;
  try {
    const response = await fetch(`/api/prompts/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败");
    const prompt = view.prompts.find((item) => item.id === id);
    if (prompt) prompt.content = content.trim();
    if (promptDrafts.get(id) === content) { promptDrafts.delete(id); storePromptDrafts(); }
    if (byId('prompt-select').value === id) {
      byId("prompt-message").dataset.state = promptDrafts.has(id) ? 'pending' : 'success';
      byId("prompt-message").textContent = promptDrafts.has(id) ? '此前内容已保存；当前编辑尚未保存' : '已保存；下一次模型调用会读取新内容';
    }
  } catch (error) { if (byId("prompt-select").value !== id) return; byId("prompt-message").dataset.state = "error"; byId("prompt-message").textContent = `保存未确认：${error.message || error}。输入已保留，可重试保存。`; }
  finally { button.disabled = false; }
});

let taskSubmitting = false;
byId("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (taskSubmitting) return;
  const goal = byId("task-goal").value.trim();
  const submit = byId("task-submit");
  let requestIssued = false, responseRead = false;
  byId("task-message").textContent = "正在提交任务……";
  byId("task-message").dataset.state = 'loading';
  try {
    const options = taskExperience ? taskExperience.payload() : {};
    if (!options.scenarioId && !goal) { byId("task-goal").focus(); return; }
    taskSubmitting = true;
    submit.disabled = true;
    taskExperience?.submitting(true);
    requestIssued = true;
    const response = await fetch(options.scenarioId ? '/api/desktop/scenarios/tasks' : '/api/tasks', { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.scenarioId ? options : { goal, ...options,
        admin: byId("task-admin").checked }) });
    const result = await response.json();
    responseRead = true;
    if (!response.ok) throw new Error(result.error || "提交失败");
    if (typeof result.taskId !== 'string' || typeof result.source !== 'string') {
      responseRead = false; throw new Error('未返回可核对的 Task ID');
    }
    view.selected = `${result.source}/${result.taskId}`;
    workbench?.submitted(view.selected);
    view.activeStep = null;
    view.activeTab = "process";
    view.activeStepTab = "action";
    byId("task-message").textContent = !options.scenarioId && byId("task-admin").checked
      ? `任务已提交：${result.taskId}。请在 Windows UAC 窗口确认管理员权限。`
      : `任务已提交：${result.taskId}`;
    byId("task-message").dataset.state = 'success';
    byId("task-goal").value = "";
    taskExperience?.submitted();
    workbench?.navigate('live');
    await refresh();
  } catch (error) {
    byId("task-message").dataset.state = requestIssued ? responseRead ? 'error' : 'unknown' : 'admission';
    byId("task-message").textContent = requestIssued && !responseRead
      ? `提交结果未知：${error.message || error}。请先查看任务记录核对，不要重复提交；页面不会自动重试。`
      : String(error);
  }
  finally { taskSubmitting = false; submit.disabled = false; taskExperience?.submitting(false); }
});

byId("task-goal").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    byId("task-form").requestSubmit();
  }
});

async function resumeTask(approved) {
  const run = view.detail;
  if (!run || run.source !== "web-tasks.sqlite") return;
  const isQuestion = run.interactionKind === "question" ||
    (!run.interactionKind && run.steps.at(-1)?.action?.kind === "ask_user");
  const answer = isQuestion ? byId("resume-answer").value.trim() : "";
  if (isQuestion && !answer) throw new Error("请先输入回答");
  byId("resume-approve").disabled = true;
  byId("resume-reject").disabled = true;
  try {
  const response = await fetch(`/api/tasks/${encodeURIComponent(run.taskId)}/resume`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(isQuestion ? { answer } : { approved }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "恢复失败");
  byId("task-message").textContent = `已提交处理：${run.taskId}`;
  byId("resume-answer").value = "";
  await refresh();
  } finally {
    byId("resume-approve").disabled = false;
    byId("resume-reject").disabled = false;
  }
}
byId("resume-approve").addEventListener("click", () => {
  resumeTask(true).catch((error) => { byId("task-message").textContent = String(error); });
});
byId("resume-reject").addEventListener("click", () => {
  resumeTask(false).catch((error) => { byId("task-message").textContent = String(error); });
});
async function manualReview(approved) {
  const run = view.detail;
  if (!run?.canManualReview) return;
  const note = byId('manual-review-note').value.trim();
  if (note.length < 3) throw new Error('请先填写至少 3 字的核对依据');
  const buttons = [byId('manual-review-approve'), byId('manual-review-reject')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(run.taskId)}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, note }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '人工验收记录失败');
    byId('task-message').textContent = approved ? '已记录人工确认；自动验收结论保持原样' : '已记录暂不确认，任务保持暂停';
    byId('manual-review-note').value = '';
    await refresh();
  } finally { buttons.forEach(button => { button.disabled = false; }); }
}
byId('manual-review-approve').addEventListener('click', () => {
  manualReview(true).catch(error => { byId('task-message').textContent = String(error); });
});
byId('manual-review-reject').addEventListener('click', () => {
  manualReview(false).catch(error => { byId('task-message').textContent = String(error); });
});
async function taskControl(action) {
  const run = view.detail;
  if (!run || run.source !== "web-tasks.sqlite") return;
  const response = await fetch(`/api/tasks/${encodeURIComponent(run.taskId)}/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "任务控制失败");
  byId("task-message").textContent = action === "pause" ? "已请求暂停，等待安全边界" : "已请求继续，正在重新观察";
  await refresh();
}
byId("task-pause").addEventListener("click", () => taskControl("pause").catch((error) => {
  byId("task-message").textContent = String(error);
}));
byId("task-continue").addEventListener("click", () => taskControl("continue").catch((error) => {
  byId("task-message").textContent = String(error);
}));
workbench?.bind(() => {
  if (workbench.mode === 'live') {
    const active = workbench.select(view.runs, view.selected);
    view.selected = active ? key(active) : null;
  } else if (workbench.mode === 'history' && workbench.routeTask) {
    view.selected = workbench.routeTask;
  } else if (!view.selected && view.runs.length) {
    view.selected = key(view.runs[0]);
  }
  selectionRequest++;
  workbench.sync(view.detail);
  renderRuns();
  if (view.selected) void loadSelected();
});
document.addEventListener('workbench:filter', renderRuns);
document.addEventListener('workbench:workflow-submitted', async event => {
  view.selected = event.detail; workbench.submitted(event.detail);
  workbench.navigate('history', event.detail); await refresh();
});
document.addEventListener('workbench:open-run', async event => {
  view.selected = event.detail; view.activeStep = null;
  workbench.navigate('history', event.detail); renderRuns(); await loadSelected();
});
refresh();
setInterval(refresh, 5000);

let desktopSocket;
let desktopSessionId;
let desktopFrameUrl;
function updateDesktopImageSize() {
  const image = byId("desktop-frame");
  if (!image.naturalWidth || image.hidden) return;
  const scale = Math.round(image.getBoundingClientRect().width / image.naturalWidth * 100);
  byId("desktop-image-size").textContent = `画面：${image.naturalWidth}×${image.naturalHeight} · 显示 ${scale}%`;
}
function setDesktopView(mode) {
  byId("desktop-frame").parentElement.classList.toggle("fit", mode === "fit");
  byId("desktop-view-actual").setAttribute("aria-pressed", String(mode === "actual"));
  byId("desktop-view-fit").setAttribute("aria-pressed", String(mode === "fit"));
  try { localStorage.setItem("desktop-view-mode", mode); } catch { /* browser storage unavailable */ }
  requestAnimationFrame(updateDesktopImageSize);
}
byId("desktop-view-actual").addEventListener("click", () => setDesktopView("actual"));
byId("desktop-view-fit").addEventListener("click", () => setDesktopView("fit"));
try { setDesktopView(localStorage.getItem("desktop-view-mode") === "actual" ? "actual" : "fit"); }
catch { setDesktopView("fit"); }
window.addEventListener("resize", updateDesktopImageSize);
function showDesktopSession(session) {
  const workerTimeout = /TimeoutError|timed?\s?out|aborted due to timeout/i.test(session?.lastError || "");
  byId("desktop-status").textContent = session?.status === "online" ?
    (session.lastError ? `已连接 · ${session.lastError}` : "已连接") :
    session?.status === "offline" ? workerTimeout
      ? "离线 · Worker 连接超时" : `离线 · ${session.lastError || "Worker 未响应"}` : "连接中";
  if (session?.status !== "online" && byId("desktop-frame").hidden) {
    byId("desktop-placeholder").textContent = workerTimeout
      ? "请确认虚拟机已登录，并在虚拟机内检查 AgentDesktop Worker 计划任务。"
      : "等待 Desktop Worker 连接";
  }
  byId("desktop-session-id").textContent = `Session：${session?.sessionId || "—"}`;
  byId("desktop-vm-id").textContent = `VM：${session?.vmId || "—"}`;
  byId("desktop-heartbeat").textContent = `心跳：${when(session?.lastSeenAt)}`;
}
async function refreshDesktop() {
  try {
    const response = await fetch("/api/desktop/sessions");
    if (!response.ok) throw new Error("无法读取 Desktop Session");
    const sessions = (await response.json()).sessions;
    const session = sessions.find((item) => item.sessionId === desktopSessionId) || sessions[0];
    if (!session) { byId("desktop-status").textContent = "未配置 VM"; return; }
    showDesktopSession(session);
    if (desktopSocket && desktopSessionId === session.sessionId &&
      [WebSocket.OPEN, WebSocket.CONNECTING].includes(desktopSocket.readyState)) return;
    desktopSocket?.close();
    desktopSessionId = session.sessionId;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    desktopSocket = new WebSocket(`${scheme}://${location.host}/api/desktop/sessions/${encodeURIComponent(session.sessionId)}/stream`);
    desktopSocket.binaryType = "blob";
    desktopSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "session") showDesktopSession(message.session);
        if (message.type === "client") desktopClientId = message.clientId;
        if (message.type === "control") {
          if (message.requestId === pendingInputId) { humanInputPending = false; pendingInputId = undefined; }
          if (message.error) byId("desktop-control-message").textContent = message.error;
          else if (message.result?.mode) showControl(message.result);
          void refreshControl();
          if (message.error) humanInputQueue.length = 0;
          flushHumanInput();
        }
        return;
      }
      const nextUrl = URL.createObjectURL(event.data);
      const image = byId("desktop-frame");
      image.onload = () => {
        if (desktopFrameUrl) URL.revokeObjectURL(desktopFrameUrl);
        desktopFrameUrl = nextUrl;
        workbench?.frame();
        updateDesktopImageSize();
      };
      image.src = nextUrl;
      image.hidden = false;
      byId("desktop-placeholder").hidden = true;
    });
    desktopSocket.addEventListener("close", () => { byId("desktop-status").textContent = "画面连接已断开";
      workbench?.disconnected();
      desktopClientId = undefined; humanInputPending = false; showControl({ mode: "ERROR" }); });
  } catch (error) { byId("desktop-status").textContent = String(error); }
}
refreshDesktop();
setInterval(refreshDesktop, 5000);

async function refreshVm() {
  try {
    const response = await fetch("/api/desktop/vm");
    const result = await response.json();
    if (!result.configured) {
      byId("desktop-vm-state").textContent = "虚拟机：未配置";
      return;
    }
    if (!response.ok) throw new Error(result.error || "无法读取虚拟机状态");
    const state = result.vm.state;
    byId("desktop-vm-state").textContent = `虚拟机：${state}${result.vm.ipv4 ? ` · ${result.vm.ipv4}` : ""}`;
    byId("desktop-vm-start").hidden = state !== "Off";
    byId("desktop-vm-console").hidden = false;
  } catch (error) { byId("desktop-vm-state").textContent = `虚拟机：${String(error)}`; }
}
async function vmAction(action) {
  const button = byId(action === "start" ? "desktop-vm-start" : "desktop-vm-console");
  button.disabled = true;
  byId("desktop-control-message").textContent = action === "start" ? "正在启动虚拟机…" : "正在打开窗口…";
  try {
    const response = await fetch(`/api/desktop/vm/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "操作失败");
    byId("desktop-control-message").textContent = action === "start"
      ? "虚拟机已启动；登录 Windows 后 Worker 将自动启动。" : "已打开虚拟机窗口";
    await refreshVm();
  } catch (error) { byId("desktop-control-message").textContent = String(error); }
  finally { button.disabled = false; }
}
byId("desktop-vm-start").addEventListener("click", () => { void vmAction("start"); });
byId("desktop-vm-console").addEventListener("click", () => { void vmAction("console"); });
refreshVm();
setInterval(refreshVm, 5000);

let desktopClientId;
let controlState = { mode: 'PAUSED' };
let humanInputPending = false;
let pendingInputId;
const humanInputQueue = [];
const controlLabels = { AGENT_CONTROL: 'Agent 操作中', PAUSING: '等待当前动作结束', PAUSED: '输入冻结',
  HUMAN_CONTROL: '人工接管中', RESUMING: '重新观察并恢复', STOPPED: '已停止', ERROR: '控制异常', unavailable: '未配置' };
function ownsHumanInput() {
  return controlState.mode === 'HUMAN_CONTROL' && controlState.humanClient === desktopClientId &&
    desktopSocket?.readyState === WebSocket.OPEN;
}
function showControl(state) {
  controlState = state;
  if (!ownsHumanInput()) humanInputQueue.length = 0;
  const connection = state.connection;
  byId('desktop-control-state').textContent = state.workerReady === false
    ? connection?.status === 'not_ready' ? 'Worker 在线，桌面未就绪（输入冻结）'
      : '等待 Worker 重连（输入冻结）' : controlLabels[state.mode] || state.mode;
  const permitted = { pause: ['AGENT_CONTROL'], take: ['PAUSED'], resume: ['PAUSED', 'HUMAN_CONTROL'],
    stop: ['AGENT_CONTROL', 'PAUSING', 'PAUSED', 'HUMAN_CONTROL', 'RESUMING'],
    emergency: ['AGENT_CONTROL', 'PAUSING', 'PAUSED', 'HUMAN_CONTROL', 'RESUMING', 'ERROR'],
    reset: ['STOPPED', 'ERROR'] };
  document.querySelectorAll('[data-desktop-command]').forEach(button => {
    button.disabled = !permitted[button.dataset.desktopCommand].includes(state.mode) ||
      desktopSocket?.readyState !== WebSocket.OPEN ||
      state.workerReady === false && !['emergency', 'stop', 'pause'].includes(button.dataset.desktopCommand);
  });
  const connectionLabels = { connecting: '正在连接', ready: '已就绪', not_ready: '在线但桌面未就绪',
    offline: '等待重连', incompatible: '身份或协议不兼容' };
  byId('desktop-connection-state').textContent = connection
    ? `Worker：${connectionLabels[connection.status] || connection.status}${connection.lastConnectedAt ? ` · 最近连接 ${when(connection.lastConnectedAt)}` : ''}${connection.status === 'not_ready' ? ` · 可观察：${connection.readyForObservation ? '是' : '否'} · 可输入：${connection.readyForInput ? '是' : '否'}` : ''}${connection.error ? ` · ${connection.error}` : ''}${state.mode === 'STOPPED' ? ' · 请点击“准备新任务”解除停止锁定' : connection.status === 'ready' ? ' · 恢复任务请点击继续或交还 Agent' : ' · 输入已冻结，请检查 Worker 与 Guest 登录状态'}`
    : '';
  byId('desktop-human-tools').hidden = !ownsHumanInput();
  byId('desktop-frame').style.cursor = ownsHumanInput() ? 'crosshair' : 'default';
  const task = state.task;
  byId('desktop-task-state').textContent = state.error || (task
    ? `任务：${task.goal} · ${statusText[task.status] || task.status} · 阶段：${task.stage || '—'} · 动作：${task.action || '—'} · 工具：${task.provider || '—'} · 验证：${task.verify || '—'}`
    : '没有活动任务，可以接管桌面或提交新任务。');
  byId('desktop-control-events').textContent = (state.events || []).map(event =>
    `${when(event.created_at)} ${event.kind}`).join('\n');
  workbench?.control(state);
  taskExperience?.control(state);
  workbench?.sync(view.detail);
}
async function refreshControl() {
  try { const response = await fetch('/api/desktop/control'); if (!response.ok) throw new Error('无法读取控制状态'); showControl(await response.json()); }
  catch { showControl({ mode: 'ERROR', error: '控制状态读取失败' }); }
}
function sendControl(command, event) {
  if (desktopSocket?.readyState !== WebSocket.OPEN) return;
  if (command === 'input') {
    if (!ownsHumanInput() || humanInputQueue.length >= 32) return;
    humanInputQueue.push(event); flushHumanInput(); return;
  }
  humanInputQueue.length = 0;
  desktopSocket.send(JSON.stringify({ requestId: crypto.randomUUID(), command, event }));
}
function flushHumanInput() {
  if (!ownsHumanInput() || humanInputPending || !humanInputQueue.length) return;
  humanInputPending = true; pendingInputId = crypto.randomUUID();
  desktopSocket.send(JSON.stringify({ requestId: pendingInputId, command: 'input', event: humanInputQueue.shift() }));
}
document.querySelectorAll('[data-desktop-command]').forEach(button => {
  button.addEventListener('click', () => sendControl(button.dataset.desktopCommand));
});
const humanFrame = byId('desktop-frame');
function framePoint(event) {
  const box = humanFrame.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
    y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
}
let pointerStart, singleClickTimer, dragged = false;
humanFrame.addEventListener('pointerdown', event => {
  if (!ownsHumanInput() || event.button !== 0) return;
  event.preventDefault(); humanFrame.focus();
  pointerStart = { point: framePoint(event), x: event.clientX, y: event.clientY };
  humanFrame.setPointerCapture(event.pointerId);
});
humanFrame.addEventListener('pointerup', event => {
  if (!pointerStart) return;
  const start = pointerStart; pointerStart = undefined;
  dragged = Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5;
  if (dragged) sendControl('input', { kind: 'drag', point: start.point, destination: framePoint(event) });
});
humanFrame.addEventListener('pointercancel', () => { pointerStart = undefined; });
humanFrame.addEventListener('click', event => {
  if (!ownsHumanInput() || dragged) { dragged = false; return; }
  clearTimeout(singleClickTimer);
  const point = framePoint(event);
  singleClickTimer = setTimeout(() => sendControl('input', { kind: 'click', point }), 250);
});
humanFrame.addEventListener('dblclick', event => {
  event.preventDefault(); clearTimeout(singleClickTimer);
  sendControl('input', { kind: 'double_click', point: framePoint(event) });
});
humanFrame.addEventListener('contextmenu', event => {
  if (!ownsHumanInput()) return;
  event.preventDefault(); sendControl('input', { kind: 'click', button: 'right', point: framePoint(event) });
});
humanFrame.addEventListener('wheel', event => {
  if (!ownsHumanInput()) return;
  event.preventDefault(); sendControl('input', { kind: 'scroll', point: framePoint(event), amount: event.deltaY > 0 ? -3 : 3 });
}, { passive: false });
humanFrame.addEventListener('keydown', event => {
  if (!ownsHumanInput()) return;
  event.preventDefault();
  if (event.repeat || event.isComposing || ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
  if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    sendControl('input', { kind: 'text', text: event.key }); return;
  }
  const key = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    Escape: 'esc', ' ': 'space', PageUp: 'pageup', PageDown: 'pagedown' })[event.key] || event.key.toLowerCase();
  sendControl('input', { kind: 'key', keys: [...(event.ctrlKey ? ['ctrl'] : []),
    ...(event.altKey ? ['alt'] : []), ...(event.shiftKey ? ['shift'] : []), ...(event.metaKey ? ['winleft'] : []), key] });
});
byId('desktop-send-text').addEventListener('click', () => {
  const text = byId('desktop-human-text').value;
  if (text) sendControl('input', { kind: 'text', text });
});
setInterval(() => { void refreshControl(); }, 1000);
void refreshControl();

document.addEventListener('workbench:refresh-desktop', () => { void refreshVm(); void refreshDesktop(); void refreshControl(); });
