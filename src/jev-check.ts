import { configuredJev } from "./agent/local-config.js";
import { initialState } from "./graph/state.js";

const model = configuredJev({ candidateActions: () => [
  { kind: "click", target: { kind: "role", role: "Button", name: "搜索" } },
  { kind: "click", target: { kind: "role", role: "Button", name: "设置" } },
  { kind: "click", target: { kind: "role", role: "Button", name: "退出" } },
] });
await model.checkConnection();
const action = await model.decide({ ...initialState("jev-check", "选择搜索按钮"),
  observation: { accessibility: "Button | 搜索\nButton | 设置\nButton | 退出" } });
console.log(JSON.stringify({ model: model.name, action, usage: model.takeUsage() }, null, 2));
