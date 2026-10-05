import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DesktopRuntime } from "./runtime/desktop/desktop-runtime.js";

const handle = Number(process.argv[2]);
if (!Number.isInteger(handle) || handle <= 0) {
  throw new Error("用法：node --import tsx src/desktop-inspect.ts <窗口句柄>");
}
const runtime = await DesktopRuntime.attach({ windowHandle: handle,
  artifactDir: resolve(".artifacts", "desktop-inspect", randomUUID()) });
try {
  const observation = await runtime.observe();
  console.log(JSON.stringify({ windowTitle: observation.windowTitle,
    windowHandle: observation.windowHandle, pageText: observation.pageText?.slice(0, 10000),
    accessibility: observation.accessibility?.slice(0, 12000),
    screenshot: observation.screenshot }, null, 2));
} finally { await runtime.close(); }
