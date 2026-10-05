import { resolve } from "node:path";
import { PlaywrightRuntime } from "./runtime/browser/playwright-runtime.js";

const runtime = await PlaywrightRuntime.launch({ headless: false,
  artifactDir: resolve(".artifacts", "task-b", "login-screenshots"),
  userDataDir: resolve(".artifacts", "task-b", "browser-profile") });
try {
  await runtime.execute({ kind: "navigate", url: "https://passport.jd.com/new/login.aspx" });
  console.log("请在打开的 Chromium 窗口中自行登录京东。完成后回到终端按 Enter 关闭窗口。");
  process.stdin.resume();
  await new Promise<void>((done) => process.stdin.once("data", () => done()));
} finally { await runtime.close(); }
