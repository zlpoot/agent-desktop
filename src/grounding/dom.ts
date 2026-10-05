import type { Locator, Page } from "playwright";
import type { ComputerAction, GroundingAttempt, GroundingResult, Target, TargetSpec } from "../actions/schema.js";

const priority: Record<Target["kind"], number> = {
  role: 0, label: 1, text: 2, selector: 3, vision: 4, coordinate: 5,
};

function candidates(spec: TargetSpec): Target[] {
  const source: Target[] = spec.kind === "candidates" ? spec.options : [spec];
  // 单个角色提示可以复用其名称，先尝试无障碍定位，再尝试标签和文本。
  if (spec.kind === "role" && spec.name) {
    source.push({ kind: "label", label: spec.name }, { kind: "text", text: spec.name });
  }
  const unique = new Map(source.map((target) => [JSON.stringify(target), target]));
  return [...unique.values()].sort((a, b) => priority[a.kind] - priority[b.kind]);
}

export function targetLocator(page: Page, target: Target): Locator {
  switch (target.kind) {
    case "role": return page.getByRole(target.role as Parameters<Page["getByRole"]>[0],
      target.name ? { name: target.name, exact: true } : undefined);
    case "label": return page.getByLabel(target.label, { exact: true });
    case "text": return page.getByText(target.text, { exact: true });
    case "selector": return page.locator(target.selector);
    case "vision": throw new Error("视觉定位尚未实现");
    case "coordinate": throw new Error("坐标目标不使用 DOM 定位器");
  }
}

export async function groundDomTarget(page: Page, action: ComputerAction): Promise<GroundingResult> {
  if (action.kind !== "click" && action.kind !== "double_click" && action.kind !== "type" &&
      action.kind !== "paste_text" && action.kind !== "set_checked" &&
      action.kind !== "select_option") return { attempts: [] };
  const attempts: GroundingAttempt[] = [];
  for (const target of candidates(action.target)) {
    const attempt: GroundingAttempt = { strategy: target.kind, matched: false, selected: false, detail: "" };
    attempts.push(attempt);
    if (target.kind === "vision") {
      attempt.detail = "视觉定位留待后续阶段";
      continue;
    }
    if (target.kind === "coordinate") {
      const size = page.viewportSize();
      if (action.kind === "type" || action.kind === "paste_text" || action.kind === "set_checked" ||
          action.kind === "select_option" || !size || target.x < 0 || target.y < 0 ||
          target.x >= size.width || target.y >= size.height) {
        attempt.detail = "坐标不适用于当前动作或超出视口";
        continue;
      }
      attempt.matched = true;
      attempt.selected = true;
      attempt.detail = "坐标位于视口内";
      return { target, attempts };
    }
    try {
      const locator = targetLocator(page, target);
      await locator.first().waitFor({ state: "visible", timeout: 700 });
      const count = await locator.count();
      if (count !== 1) {
        attempt.detail = `匹配 ${count} 个元素，需要唯一目标`;
        continue;
      }
      if (!await locator.isEnabled()) {
        attempt.detail = "元素不可用";
        continue;
      }
      if ((action.kind === "type" || action.kind === "paste_text") &&
          !await locator.isEditable().catch(() => false)) {
        attempt.detail = "元素不可编辑";
        continue;
      }
      attempt.matched = true;
      attempt.selected = true;
      attempt.detail = "已定位唯一可操作元素";
      return { target, attempts };
    } catch (error) {
      attempt.detail = String(error).split("\n")[0];
    }
  }
  return { attempts };
}
