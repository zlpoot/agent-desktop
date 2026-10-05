import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface RegisteredApp {
  id: string;
  name: string;
  executable: string;
  args: string[];
  windowTitle?: string;
  windowClass?: string;
}

function validApp(value: unknown): RegisteredApp {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("应用登记项无效");
  const item = value as Record<string, unknown>;
  const args = item.args ?? [];
  if (typeof item.id !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(item.id) ||
      typeof item.name !== "string" || !item.name.trim() || item.name.length > 80 ||
      typeof item.executable !== "string" || !isAbsolute(item.executable) ||
      !Array.isArray(args) || args.length > 12 ||
      args.some((arg: unknown) => typeof arg !== "string" || arg.length > 200) ||
      (item.windowTitle !== undefined && (typeof item.windowTitle !== "string" || !item.windowTitle.trim())) ||
      (item.windowClass !== undefined && (typeof item.windowClass !== "string" || !item.windowClass.trim()))) {
    throw new Error("应用登记必须包含合法 id、名称和绝对可执行文件路径");
  }
  return { id: item.id, name: item.name, executable: resolve(item.executable),
    args: args as string[],
    ...(typeof item.windowTitle === "string" ? { windowTitle: item.windowTitle } : {}),
    ...(typeof item.windowClass === "string" ? { windowClass: item.windowClass } : {}) };
}

/** 只向规划器提供本机已登记的应用 ID，不接受模型生成的程序路径。 */
export async function registeredApps(rootDir: string): Promise<RegisteredApp[]> {
  const builtins: RegisteredApp[] = process.platform === "win32" ? [{
    id: "notepad", name: "记事本", executable: resolve(process.env.SystemRoot ?? "C:\\Windows",
      "System32", "notepad.exe"), args: [],
  }] : [];
  let custom: unknown = [];
  try { custom = JSON.parse(await readFile(resolve(rootDir, "apps.local.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!Array.isArray(custom)) throw new Error("apps.local.json 必须是应用数组");
  const apps = [...builtins, ...custom.map(validApp)];
  if (new Set(apps.map((app) => app.id)).size !== apps.length) throw new Error("应用 ID 重复");
  return apps;
}

/** Guest apps live in a separate manifest copied to the VM. The model sees IDs, never paths. */
export async function registeredGuestApps(rootDir: string): Promise<RegisteredApp[]> {
  const custom = JSON.parse(await readFile(resolve(rootDir, "config", "agent-desktop-apps.json"), "utf8")) as unknown;
  if (!Array.isArray(custom)) throw new Error("Agent Desktop 应用配置必须是数组");
  const apps = custom.map(validApp);
  if (new Set(apps.map((app) => app.id)).size !== apps.length) throw new Error("Agent Desktop 应用 ID 重复");
  if (apps.some((app) => !app.windowClass && !app.windowTitle)) {
    throw new Error("Agent Desktop 应用需要窗口类名或标题以核验启动结果");
  }
  return apps;
}
