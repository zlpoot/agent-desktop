import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createDashboardServer } from "../src/app/server.js";
import { initialState } from "../src/graph/state.js";
import { SqliteTrace } from "../src/trace/sqlite-trace.js";
import { resolveCapability } from "../src/capabilities/registry.js";
import { promptDefinitions, readPrompt } from "../src/agent/prompt-store.js";

test('历史截图优先提供完整桌面，并明确标注旧窗口截图', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desktop-evidence-'));
  mkdirSync(join(dir,'.artifacts'));
  const windowFile=join(dir,'.artifacts','window.png'), desktopFile=join(dir,'.artifacts','desktop.png');
  writeFileSync(windowFile,Buffer.from('window'));writeFileSync(desktopFile,Buffer.from('desktop'));
  const trace=new SqliteTrace(join(dir,'runs.sqlite'));
  const state=initialState('capture','观察桌面');
  trace.save('observe',{...state,step:1,observation:{windowHandle:1,screenshot:windowFile}});
  trace.save('observe',{...state,step:2,observation:{windowHandle:1,screenshot:windowFile,
    desktopScreenshot:desktopFile,desktopCapturedAt:'2026-09-27T02:00:00Z'}});
  trace.close();
  const server=createDashboardServer(dir);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();if(!address||typeof address==='string')throw new Error('address');
  const base=`http://127.0.0.1:${address.port}`;
  try {
    const run=await (await fetch(`${base}/api/runs/runs.sqlite/capture`)).json();
    assert.deepEqual(run.steps.map((s:{screenshotScope:string})=>s.screenshotScope),['window','desktop']);
    assert.equal(await (await fetch(`${base}/api/screenshots/runs.sqlite/capture/1`)).text(),'window');
    assert.equal(await (await fetch(`${base}/api/screenshots/runs.sqlite/capture/2`)).text(),'desktop');
  } finally {await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

test("只读页面列出任务、计划、进度、结果和项目内截图", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-use-dashboard-"));
  const artifactDir = join(dir, ".artifacts");
  mkdirSync(artifactDir);
  mkdirSync(join(dir, "prompts"));
  for (const item of promptDefinitions) {
    copyFileSync(resolve("prompts", item.file), join(dir, "prompts", item.file));
  }
  const screenshot = join(artifactDir, "sample.png");
  writeFileSync(screenshot, Buffer.from("89504e470d0a1a0a", "hex"));
  const trace = new SqliteTrace(join(dir, "runs.sqlite"));
  const start = initialState("task-1", "打开示例网页", ["导航", "检查页面"]);
  trace.save("observe", start);
  const decided = { ...start, step: 1, lastAction: { kind: "navigate" as const, url: "https://example.com" } };
  trace.save("decide", decided);
  trace.save("ground", { ...decided, targetBinding: { semantic: { label: "示例网页" },
    selected: { kind: "text", text: "示例网页" }, strategy: "text", detail: "唯一匹配",
    context: { url: "https://example.com" } } });
  trace.save("execute", { ...decided, lastResult: { ok: true, message: "已导航" } });
  trace.save("observe", { ...decided, observation: { url: "https://example.com", screenshot,
    pageText: "示例网页", textEvidence: [{ source: "dom", text: "示例网页" }] },
    lastResult: { ok: true, message: "已导航" } });
  trace.save("verify", { ...decided, lastVerification: { ok: true, message: "页面网址匹配" } });
  trace.save("finish", { ...decided, status: "done", summary: "网页已打开",
    goalVerification: { ok: true, message: "独立条件已通过", evidence: [
      { criterion: "pageTextIncludes", source: "dom", strength: "strong" }] } });
  trace.recordNodeMetric("task-1", { step: 1, node: "decide", startedAt: new Date().toISOString(),
    durationMs: 125.4, actor: "model", operator: "deepseek-flash", modelName: "deepseek-flash",
    inputTokens: 30, outputTokens: 5, totalTokens: 35 });
  trace.recordNodeMetric("task-1", { step: 1, node: "execute", startedAt: new Date().toISOString(),
    durationMs: 1100, actor: "runtime", operator: "Playwright" });
  const facts = { browserAttached: true };
  trace.recordCapabilityResolution("task-1", 0, "浏览器检查",
    resolveCapability("locate", "browser", facts), facts);
  trace.recordActionResolution("task-1", 1, { selected: "browser.playwright.act",
    reason: "已绑定浏览器页面", candidates: [{ provider: "browser.playwright.act",
      available: true, reason: "页面可操作" }] });
  trace.recordActionExecution("task-1", 1, "browser.playwright.act", true, "导航已完成");
  trace.recordProviderAttempt("task-1", 1, "browser.playwright.act", true, "dispatched", "导航已完成");
  trace.close();
  const approvalDir = join(artifactDir, "approval-demo", "approval-1");
  mkdirSync(approvalDir, { recursive: true });
  const approvalTrace = new SqliteTrace(join(approvalDir, "trace.sqlite"));
  approvalTrace.save("risk_check", { ...initialState("approval-1", "提交本地表单"),
    step: 1, status: "waiting_user", error: "高风险动作需要人工确认",
    lastAction: { kind: "click", target: { kind: "role", role: "button", name: "提交" } } });
  approvalTrace.close();
  const interactionTrace = new SqliteTrace(join(dir, "web-tasks.sqlite"));
  interactionTrace.save("human_interrupt", { ...initialState("review-1", "进入佣兵之书"),
    status: "waiting_user", error: "请确认当前画面确已进入佣兵之书",
    finalReviewPending: true });
  interactionTrace.save("human_interrupt", { ...initialState("approve-1", "执行测试动作"),
    status: "waiting_user", error: "是否批准执行此动作？",
    lastAction: { kind: "click", target: { kind: "text", text: "目标" } } });
  interactionTrace.save("human_interrupt", { ...initialState("question-1", "查询目标"),
    status: "waiting_user", error: "请输入目标名称",
    lastAction: { kind: "ask_user", question: "请输入目标名称" } });
  interactionTrace.close();
  const server = createDashboardServer(dir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("页面服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  let browser: import("playwright").Browser | undefined;
  try {
    const list = await fetch(`${base}/api/runs`);
    assert.equal(list.status, 200);
    const approvalList = (await list.json()).runs;
    assert.ok(approvalList.some((run: { goal: string }) => run.goal === "打开示例网页"));
    assert.ok(approvalList.some((run: { source: string; status: string }) =>
      run.source === "approval-demo:approval-1" && run.status === "waiting_user"));
    const approvalDetail = await fetch(`${base}/api/runs/approval-demo%3Aapproval-1/approval-1`);
    assert.equal(approvalDetail.status, 200);
    const detail = await fetch(`${base}/api/runs/runs.sqlite/task-1`);
    const run = await detail.json();
    assert.deepEqual(run.plan, ["导航", "检查页面"]);
    assert.equal(run.status, "done");
    assert.equal(run.summary, "网页已打开");
    assert.equal(run.steps[0].result.ok, true);
    assert.equal(run.steps[0].verification.message, "页面网址匹配");
    assert.equal(run.goalVerification.ok, true);
    assert.equal(run.goalVerification.evidence[0].source, "dom");
    assert.deepEqual(run.steps[0].textSources, ["dom"]);
    assert.equal(run.steps[0].targetBinding.semantic.label, "示例网页");
    assert.equal(run.steps[0].durationMs, 1225.4);
    assert.equal(run.totalTokens, 35);
    assert.equal(run.modelCalls, 1);
    assert.equal(run.reportedTokenCalls, 1);
    assert.equal(run.steps[0].metrics[0].operator, "deepseek-flash");
    assert.ok(run.elapsedMs >= 0);
    assert.equal(run.activeDurationMs, 1225.4);
    assert.equal(run.capabilityResolutions[0].selected, "browser.dom.locate");
    assert.equal(run.actionResolutions[0].actual, "browser.playwright.act");
    assert.equal(run.providerAttempts[0].effect, "dispatched");
    const image = await fetch(`${base}/api/screenshots/runs.sqlite/task-1/1`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal((await fetch(`${base}/api/runs/other.sqlite/task-1`)).status, 404);
    const review = await (await fetch(`${base}/api/runs/web-tasks.sqlite/review-1`)).json();
    assert.equal(review.interactionKind, "final_review");
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".playwright-browsers");
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await page.locator(".run-card").filter({ hasText: "打开示例网页" }).click();
    await page.getByRole("heading", { name: "打开示例网页" }).waitFor();
    await page.locator('.task-diagnostics > summary').click();
    assert.match(await page.locator("#plan-list").innerText(), /导航/);
    assert.equal(await page.locator("#panel-process").isVisible(), true);
    await page.getByRole("button", { name: "步骤证据" }).click();
    assert.match(await page.locator("#step-detail").innerText(), /已导航/);
    assert.match(await page.locator("#step-detail").innerText(), /页面网址匹配/);
    assert.match(await page.locator("#step-detail").innerText(), /预选工具/);
    assert.match(await page.locator("#step-detail").innerText(), /工具尝试/);
    assert.match(await page.locator("#step-detail").innerText(), /文本来源\s*网页 DOM/);
    assert.match(await page.locator("#step-detail").innerText(), /目标定位证据\s*text · 唯一匹配/);
    assert.match(await page.locator("#goal-verification").innerText(), /网页 DOM（强）/);
    assert.equal(await page.locator("#token-count").innerText(), "35");
    assert.match(await page.locator("#step-detail").innerText(), /1\.23 s/);
    await page.getByRole("button", { name: "模型与耗时" }).click();
    assert.match(await page.locator("#step-metrics").innerText(), /deepseek-flash/);
    assert.match(await page.locator("#step-metrics").innerText(), /125 ms/);
    await page.getByRole("button", { name: "执行过程" }).click();
    assert.match(await page.locator("#flow-chart").innerText(), /开始 · 规划/);
    assert.match(await page.locator("#flow-chart").innerText(), /第 1 步/);
    assert.match(await page.locator("#flow-chart").innerText(), /当前结果/);
    await page.locator("#flow-chart button").first().click();
    assert.equal(await page.locator("#panel-evidence").isVisible(), true);
    await page.getByRole("button", { name: "动作与验证" }).click();
    assert.match(await page.locator("#step-detail").innerText(), /已导航/);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator("#prompt-select").selectOption("task-planner");
    await page.locator("#prompt-content").fill("页面中修改的规划提示词");
    await page.locator("#prompt-save").click();
    await page.getByText("已保存；下一次模型调用会读取新内容").waitFor();
    assert.equal(readPrompt("task-planner", dir), "页面中修改的规划提示词");
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await page.getByRole("button", { name: "运行分析" }).click();
    await page.locator("#capability-resolutions .capability-group summary").first().click();
    assert.match(await page.locator("#capability-resolutions").innerText(), /DOM Grounder/);
    await page.getByRole("button", { name: "步骤证据" }).click();
    await page.getByRole("button", { name: "截图", exact: true }).click();
    assert.equal(await page.locator("#screenshot img").count(), 1);
    await page.locator(".run-card").filter({ hasText: "进入佣兵之书" }).click();
    await page.getByRole("button", { name: "确认完成" }).waitFor();
    assert.equal(await page.locator("#resume-answer").isVisible(), false);
    assert.equal(await page.locator("#resume-approve").innerText(), "确认完成");
    assert.equal(await page.locator("#resume-reject").innerText(), "尚未完成");
    await page.locator(".run-card").filter({ hasText: "执行测试动作" }).click();
    await page.getByRole("button", { name: "允许执行" }).waitFor();
    assert.equal(await page.locator("#resume-answer").isVisible(), false);
    assert.equal(await page.locator("#resume-approve").innerText(), "允许执行");
    await page.locator(".run-card").filter({ hasText: "查询目标" }).click();
    await page.getByRole("button", { name: "提交回答" }).waitFor();
    assert.equal(await page.locator("#resume-answer").isVisible(), true);
    assert.equal(await page.locator("#resume-reject").isVisible(), false);
    assert.equal(await page.locator("#resume-approve").innerText(), "提交回答");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
