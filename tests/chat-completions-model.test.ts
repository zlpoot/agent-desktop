import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { ChatCompletionsModel, parseModelAction } from "../src/agent/chat-completions-model.js";
import { initialState } from "../src/graph/state.js";

test("模型适配器读取模型列表，并把目标和页面观察转换为单步动作", async () => {
  let received: Record<string, unknown> | undefined;
  let completions = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer test-key") {
      response.statusCode = 401; response.end(JSON.stringify({ error: "未授权" })); return;
    }
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "deepseek-flash" }] })); return;
    }
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      received = JSON.parse(body) as Record<string, unknown>;
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        kind: "click", target: { kind: "role", role: "link", name: "LangGraph 教程" },
      }) } }], ...(completions++ === 0
        ? { usage: { prompt_tokens: 123, completion_tokens: 17, total_tokens: 140 } } : {}) }));
      return;
    }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("模拟服务未启动");
  try {
    const model = new ChatCompletionsModel({ baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key", model: "deepseek-flash", allowedHosts: ["bilibili.com"] });
    await model.checkConnection();
    const action = await model.decide({ ...initialState("task", "打开相关视频"),
      observation: { url: "https://search.bilibili.com/all", pageText: "LangGraph 教程",
        dom: "browser DOM marker" } });
    assert.deepEqual(action, { kind: "click", target: { kind: "role", role: "link", name: "LangGraph 教程" } });
    assert.equal(received?.model, "deepseek-flash");
    const messages = received?.messages as Array<{ role: string; content: string }>;
    const context = JSON.parse(messages.find(message => message.role === 'user')!.content);
    assert.equal(context.runtimeContext.clock.source, 'host');
    assert.ok(Math.abs(Date.now() - Date.parse(context.runtimeContext.clock.iso)) < 10000);
    assert.equal(typeof context.runtimeContext.clock.timeZone, 'string');
    assert.equal(context.observation.dom, "browser DOM marker");
    assert.match(JSON.stringify(received?.messages), /打开相关视频/);
    assert.match(JSON.stringify(received?.messages), /LangGraph 教程/);
    assert.deepEqual(model.takeUsage(), { inputTokens: 123, outputTokens: 17, totalTokens: 140 });
    assert.equal(model.takeUsage(), undefined);
    await model.decide({ ...initialState("task-2", "再次观察") });
    assert.equal(model.takeUsage(), undefined);
    const desktopModel = new ChatCompletionsModel({ baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key", model: "deepseek-flash", environment: "desktop" });
    await desktopModel.decide({ ...initialState("task-3", "保存记录"),
      stage: { id: "stage-1", goal: "打开表单", successCondition: "表单可见",
        startedAtStep: 0, actionCount: 1, planVersion: 1, isFinal: false },
      lastResult: { ok: true, message: "已打开", effect: "dispatched",
        observation: { dom: "STALE_DOM_MARKER" } },
      observation: { windowTitle: "目标表单", pageText: "手机号 13977770002",
        accessibility: "Edit | 手机号 | 13977770002", dom: "CURRENT_UIA_DOM_MARKER" } });
    const desktopMessages = received?.messages as Array<{ role: string; content: string }>;
    const desktopSystem = desktopMessages.find(message => message.role === "system")!.content;
    const desktopContext = JSON.parse(desktopMessages.find(message => message.role === "user")!.content);
    assert.match(desktopSystem, /只有用户总目标已达成时才返回 done/);
    assert.equal(desktopContext.lastResult.message, "已打开");
    assert.equal(desktopContext.lastResult.observation, undefined);
    assert.equal(desktopContext.observation.dom, undefined);
    assert.match(desktopContext.observation.accessibility, /13977770002/);
    assert.doesNotMatch(JSON.stringify(desktopMessages), /STALE_DOM_MARKER|CURRENT_UIA_DOM_MARKER/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("拒绝越界导航、模型直接给坐标和无效动作", () => {
  assert.throws(() => parseModelAction('{"kind":"navigate","url":"https://example.com"}',
    ["bilibili.com"]), /允许范围/);
  assert.deepEqual(parseModelAction('{"kind":"click","target":{"kind":"vision","description":"按钮"}}'),
    { kind: "click", target: { kind: "vision", description: "按钮" } });
  assert.throws(() => parseModelAction('{"kind":"click","target":{"kind":"coordinate","x":1,"y":2}}'),
    /目标类型不受支持/);
  assert.deepEqual(parseModelAction('{"kind":"paste_text","target":{"kind":"label","label":"搜索"},"text":"中文"}'),
    { kind: "paste_text", target: { kind: "label", label: "搜索" }, text: "中文" });
  assert.throws(() => parseModelAction('{"kind":"drag","source":{"kind":"vision","description":"按钮"},"destination":{"kind":"label","label":"区域"}}'),
    /明确的结构化目标/);
  assert.throws(() => parseModelAction("不是 JSON"), /有效的动作 JSON/);
});

test('动作可携带有限的预声明后置条件，含糊或视觉目标被拒绝',()=>{
  assert.deepEqual(parseModelAction(JSON.stringify({kind:'click',target:{kind:'role',role:'link',name:'结果'},
    postcondition:{kind:'url_equals',value:'https://example.com'}})),
    {kind:'click',target:{kind:'role',role:'link',name:'结果'},
      postcondition:{kind:'url_equals',value:'https://example.com/'}});
  const keypress=parseModelAction(JSON.stringify({kind:'keypress',keys:'Enter',
    postcondition:{kind:'uia_present',target:{kind:'role',role:'TabItem',name:'新标签'}}}));
  assert.equal(keypress.kind,'keypress');
  if(keypress.kind==='keypress')assert.deepEqual(keypress.postcondition,
    {kind:'uia_present',target:{kind:'role',role:'TabItem',name:'新标签'}});
  assert.throws(()=>parseModelAction(JSON.stringify({kind:'click',target:{kind:'role',role:'Button'},
    postcondition:{kind:'uia_present',target:{kind:'role',role:'TabItem'}}})),/唯一辨认/);
  assert.throws(()=>parseModelAction(JSON.stringify({kind:'click',target:{kind:'role',role:'Button'},
    postcondition:{kind:'url_includes',value:'ok'}})),/完整网址或明确路径/);
  const file=parseModelAction(JSON.stringify({kind:'keypress',keys:'Ctrl+S',
    postcondition:{kind:'desktop_file',path:'result.txt',contentEquals:'hello'}}));
  assert.equal(file.kind,'keypress');
  if(file.kind==='keypress')assert.deepEqual(file.postcondition,
    {kind:'desktop_file',path:'result.txt',contentEquals:'hello'});
  assert.throws(()=>parseModelAction(JSON.stringify({kind:'keypress',keys:'Ctrl+S',
    postcondition:{kind:'desktop_file',path:'..\\secret.txt'}})),/路径无效/);
});
