import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ComputerAction } from "./actions/schema.js";
import { configuredModel } from "./agent/local-config.js";
import type { ModelAdapter } from "./agent/model-adapter.js";
import { createAgentLoop } from "./graph/graph.js";
import { resumeSavedTask } from "./graph/resume.js";
import { initialState, type ComputerState } from "./graph/state.js";
import { PlaywrightRuntime } from "./runtime/browser/playwright-runtime.js";
import { SqliteTrace } from "./trace/sqlite-trace.js";
import { FacetRegistry } from "./contracts/facets.js";
import { ContributorRegistry } from "./contracts/verifier-contributor.js";
import { createDomainEvaluator } from "./verification/domain-evaluator.js";
import { createShopExtension } from "./extensions/shop/shop-extension.js";

const [command = "start", taskArg, decision, ...answerParts] = process.argv.slice(2);
if (!["check", "start", "resume"].includes(command)) {
  throw new Error("用法：npm run demo:task-b:ai -- check|start|resume <任务 ID> approve|reject|answer <回答>");
}
if (command === "resume" && (!taskArg || !["approve", "reject", "answer"].includes(decision))) {
  throw new Error("恢复任务时需要任务 ID 和 approve、reject 或 answer <回答>");
}

const { model: languageModel, modelName } = configuredModel({
  allowedHosts: ["jd.com"],
  taskInstructions: "只在京东浏览商品，寻找总容量 32GB、当前价格不超过 2000 元的内存条并打开详情页。可以是单条 32GB 或两条 16GB 套装；不要假设台式机、笔记本或 DDR 代际。没有从详情页读取到明确价格时不可宣布完成。遇到登录页则请求用户自行登录。严禁加入购物车、购买、下单、支付、发送消息或修改账户信息。",
});

const prohibited = /购买|立即买|下单|结算|支付|加入购物车|去购物车|提交订单|buy|checkout|purchase|add.to.cart/i;
const model: ModelAdapter = {
  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    if (state.observation?.url?.startsWith("https://passport.jd.com/") ||
        state.observation?.url?.includes("cfe.m.jd.com/privatedomain/risk_handler")) {
      return { kind: "ask_user", question: "京东要求登录或风控验证。请在项目专用浏览器窗口自行处理，然后继续任务。" };
    }
    const action = await languageModel.decide(state);
    if (action.kind === "click" && prohibited.test(JSON.stringify(action.target))) {
      throw new Error("Task B 禁止购物车、下单和支付动作");
    }
    if (action.kind === "navigate") {
      const url = new URL(action.url);
      if (/(?:^|\.)(?:cart|order|cashier|pay)\.jd\.com$/i.test(url.hostname) ||
          /\/(?:cart|order|checkout|cashier)(?:\/|$)/i.test(url.pathname)) {
        throw new Error("Task B 禁止进入交易流程");
      }
    }
    return action;
  },
};

await languageModel.checkConnection();
if (command === "check") {
  console.log(`模型服务连接成功，${modelName} 可用。`);
} else {
  const taskId = command === "start" ? randomUUID() : taskArg;
  const dir = resolve(".artifacts", "task-b", taskId);
  await mkdir(dir, { recursive: true });
  const trace = new SqliteTrace("task-b-ai.sqlite");
  const checkpoint = SqliteSaver.fromConnString(resolve(dir, "checkpoints.sqlite"));
  let runtime: PlaywrightRuntime | undefined;
  try {
    runtime = await PlaywrightRuntime.launch({ artifactDir: resolve(dir, "screenshots"),
      userDataDir: resolve(".artifacts", "task-b", "browser-profile") });
    // 演示脚本在应用层组装 shop 扩展：核心运行时本身仍不认识任何站点。
    const shop = createShopExtension();
    const facetRegistry = new FacetRegistry();
    for (const provider of shop.facets ?? []) facetRegistry.register(provider);
    const contributorRegistry = new ContributorRegistry();
    for (const contributor of shop.contributors ?? []) contributorRegistry.register(contributor);
    const domainEvaluator = createDomainEvaluator(contributorRegistry, facetRegistry);
    const graph = createAgentLoop({ model, runtime, trace, checkpointer: checkpoint,
      maxSteps: 20, maxRetries: 2,
      facetProviders: [...facetRegistry.list()], domainEvaluator });
    const result = command === "start"
      ? await graph.invoke(initialState(taskId,
          "在京东搜索总容量 32GB、价格不超过 2000 元的内存条，打开符合条件的商品详情页；只浏览，不加入购物车或下单", [
            "打开京东并搜索 32GB 内存条", "筛选并核对容量及价格", "打开符合预算的详情页",
            "独立核验商品容量和当前价格",
          ], { urlIncludes: "item.jd.com", domainChecks: [
            { domain: "shop.jd", predicate: "titleIncludes", args: { includes: "内存" } },
            { domain: "shop.jd", predicate: "capacityGb", args: { equals: 32 } },
            { domain: "shop.jd", predicate: "priceAtMost", args: { max: 2000 } },
          ] }),
        { configurable: { thread_id: taskId } })
      : await resumeSavedTask(graph, runtime, taskId, decision === "answer"
        ? { answer: answerParts.join(" ") } : { approved: decision === "approve" });
    console.log(JSON.stringify({ taskId, status: result.status, error: result.error,
      summary: result.summary, url: result.observation?.url,
      shopFacet: result.observation?.facets?.["shop.jd"]?.data,
      goalVerification: result.goalVerification,
      screenshot: result.observation?.screenshot, trace: resolve("task-b-ai.sqlite") }, null, 2));
    if (result.status === "waiting_user") {
      const question = result.lastAction?.kind === "ask_user";
      console.log(question
        ? `请回答：npm run demo:task-b:ai -- resume ${taskId} answer <回答>`
        : `批准或拒绝：npm run demo:task-b:ai -- resume ${taskId} approve|reject`);
    }
    if (result.status === "failed") process.exitCode = 1;
  } finally { await runtime?.close(); trace.close(); checkpoint.db.close(); }
}
