import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const result = spawnSync(process.execPath, [resolve("node_modules/playwright/cli.js"), "install", "chromium"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(".playwright-browsers") },
});
process.exit(result.status ?? 1);
