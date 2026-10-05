import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const promptDefinitions = [
  { id: "task-planner", label: "任务规划", file: "task-planner.md" },
  { id: "browser-decision", label: "浏览器决策", file: "browser-decision.md" },
  { id: "desktop-decision", label: "桌面决策", file: "desktop-decision.md" },
  { id: "desktop-visual", label: "桌面视觉补充", file: "desktop-visual.md" },
  { id: "vision-ocr", label: "截图文字识别", file: "vision-ocr.md" },
  { id: "vision-locate", label: "截图目标定位", file: "vision-locate.md" },
  { id: "workflow-match", label: "流程语义匹配", file: "workflow-match.md" },
  { id: "stage-planner", label: "滚动阶段规划", file: "stage-planner.md" },
  { id: "stage-verifier", label: "阶段验收", file: "stage-verifier.md" },
  { id: "stage-reconcile", label: "恢复时状态对齐", file: "stage-reconcile.md" },
  { id: "stage-diagnosis", label: "阶段停滞诊断", file: "stage-diagnosis.md" },
  { id: "jev-choice", label: "Jev 候选选择", file: "jev-choice.md" },
  { id: "jev-verifier", label: "JEV 辅助验收", file: "jev-verifier.md" },
] as const;

export type PromptId = (typeof promptDefinitions)[number]["id"];

function definition(id: string) {
  const item = promptDefinitions.find((entry) => entry.id === id);
  if (!item) throw new Error("未知的提示词类型");
  return item;
}

function promptPath(id: string, rootDir: string): string {
  return resolve(rootDir, "prompts", definition(id).file);
}

export function readPrompt(id: PromptId, rootDir = process.cwd()): string {
  const content = readFileSync(promptPath(id, rootDir), "utf8").trim();
  if (!content) throw new Error(`提示词 ${id} 为空`);
  return content;
}

export function savePrompt(id: PromptId, content: string, rootDir = process.cwd()): void {
  if (!content.trim() || content.length > 20000) throw new Error("提示词需为 1 到 20000 个字符");
  // 只能写入固定清单中的文件，防止路径遍历。
  writeFileSync(promptPath(id, rootDir), `${content.trim()}\n`, "utf8");
}

export function listPrompts(rootDir = process.cwd()) {
  return promptDefinitions.map(({ id, label }) => ({ id, label, content: readPrompt(id, rootDir) }));
}
