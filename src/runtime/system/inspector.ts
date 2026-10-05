import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface ProcessDetails { pid: number; name: string; status: string; executable: string }
export interface PortDetails { address: string; port: number; status: string; pid: number | null }

async function query<T>(kind: "process" | "port", number: number): Promise<T> {
  if (!Number.isInteger(number) || number <= 0 || (kind === "port" && number > 65535)) {
    throw new Error("查询参数必须是合法正整数");
  }
  const child = spawn("python", [resolve("src/runtime/system/inspector.py")], {
    cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  let errors = "";
  const timeout = setTimeout(() => child.kill(), 8000);
  child.stdout.on("data", (data: Buffer) => { output = (output + data.toString()).slice(0, 100000); });
  child.stderr.on("data", (data: Buffer) => { errors = (errors + data.toString()).slice(0, 2000); });
  child.stdin.end(JSON.stringify({ kind, number }));
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`系统查询失败：${errors || `退出码 ${code}`}`);
  let result: { result?: T; error?: string };
  try { result = JSON.parse(output) as typeof result; }
  catch { throw new Error("系统查询未返回有效结果"); }
  if (result.error) throw new Error(result.error);
  return result.result as T;
}

/** 固定、只读查询；不接受脚本或任意 Shell 命令。 */
export const inspectProcess = (pid: number) => query<ProcessDetails | null>("process", pid);
export const inspectPort = (port: number) => query<PortDetails[]>("port", port);
