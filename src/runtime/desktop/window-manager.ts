import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DesktopRuntime, type DesktopProbe, type WindowFilter, type WindowInfo } from "./desktop-runtime.js";

export function selectUniqueWindow(windows: readonly WindowInfo[]): WindowInfo | undefined {
  if (windows.length > 1) throw new Error(`窗口匹配数量为 ${windows.length}，必须指定唯一的窗口`);
  return windows[0];
}

/** 仅管理明确指定的可见窗口；启动时只接受本机可执行文件绝对路径。 */
export class WindowManager {
  constructor(private readonly artifactDir: string, private readonly pythonPath?: string) {}

  list(filter: WindowFilter = {}): Promise<WindowInfo[]> {
    return DesktopRuntime.listWindows(filter, this.pythonPath);
  }

  async waitFor(filter: WindowFilter, timeoutMs = 10000): Promise<WindowInfo> {
    const deadline = Date.now() + timeoutMs;
    do {
      const found = selectUniqueWindow(await this.list(filter));
      if (found) return found;
      await new Promise((done) => setTimeout(done, 250));
    } while (Date.now() < deadline);
    throw new Error("目标窗口未在等待时间内出现");
  }

  async attach(filter: WindowFilter, timeoutMs = 0): Promise<DesktopRuntime> {
    const found = timeoutMs > 0 ? await this.waitFor(filter, timeoutMs)
      : selectUniqueWindow(await this.list(filter));
    if (!found) throw new Error("未找到符合条件的可见窗口");
    return DesktopRuntime.attach({ windowHandle: found.handle, windowTitle: found.title,
      windowClass: found.windowClass, processPath: found.processPath ?? undefined,
      artifactDir: this.artifactDir, pythonPath: this.pythonPath });
  }

  async ensure(filter: WindowFilter, executable: string, args: string[] = [], timeoutMs = 10000): Promise<DesktopRuntime> {
    if (!isAbsolute(executable)) throw new Error("启动应用必须使用可执行文件绝对路径");
    await access(executable);
    const expectedPath = resolve(executable);
    if (filter.processPath && resolve(filter.processPath).toLowerCase() !== expectedPath.toLowerCase()) {
      throw new Error("窗口过滤器的进程路径与待启动程序不一致");
    }
    const exactFilter = { ...filter, processPath: expectedPath };
    const found = selectUniqueWindow(await this.list(exactFilter));
    if (!found) {
      const child = spawn(expectedPath, args, { windowsHide: false, stdio: "ignore", detached: true });
      await new Promise<void>((done, fail) => {
        child.once("spawn", () => done());
        child.once("error", fail);
      });
      child.unref();
    }
    return this.attach(exactFilter, timeoutMs);
  }

  state(runtime: DesktopRuntime): Promise<DesktopProbe> { return runtime.probe(); }

  async focus(runtime: DesktopRuntime): Promise<DesktopProbe> {
    const state = await runtime.probe(true);
    if (!state.foreground) throw new Error("目标窗口未处于前台");
    return state;
  }
}
