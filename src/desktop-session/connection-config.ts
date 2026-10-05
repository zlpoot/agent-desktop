import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ConnectionConfig { pollMs: number; timeoutMs: number; retryMaxMs: number }
export const connectionDefaults: ConnectionConfig = { pollMs: 5000, timeoutMs: 5000, retryMaxMs: 30000 };
export function connectionConfig(rootDir: string): ConnectionConfig {
  const path = resolve(rootDir, "config", "desktop-connection.json");
  const config = { ...connectionDefaults, ...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) };
  for (const key of Object.keys(connectionDefaults) as (keyof ConnectionConfig)[]) {
    if (!Number.isInteger(config[key]) || config[key] < 100 || config[key] > 120000) throw new Error(`desktop-connection ${key} 必须是 100–120000 毫秒的整数`);
  }
  if (config.retryMaxMs < config.pollMs) throw new Error("retryMaxMs 不能小于 pollMs");
  return config;
}
