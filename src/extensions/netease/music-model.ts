import type { ComputerAction } from "../../actions/schema.js";
import type { ModelAdapter } from "../../agent/model-adapter.js";
import type { ComputerState } from "../../graph/state.js";
import type { MusicPlaybackData } from "./music-facet.js";

export interface MusicSelection { search: string; title: string; artist?: string }

function lines(accessibility: string | undefined): string[] {
  return (accessibility ?? "").split("\n");
}

function songRows(accessibility: string | undefined): string[] {
  return lines(accessibility).map((line) => line.match(/^Group \| (\d{1,3} .+) \|  \| autoId=/)?.[1])
    .filter((row): row is string => !!row);
}

function rowMatches(row: string, request: MusicSelection): boolean {
  const numbered = row.replace(/^\d{1,3}\s+/, "");
  if (!numbered.startsWith(request.title)) return false;
  const rest = numbered.slice(request.title.length);
  if (!rest || /^[（(]/.test(rest) || /^\s+[（(]/.test(rest)) return false;
  if (!/^\s/.test(rest)) return false;
  if (request.artist && (!row.includes(request.artist) || /原唱[:：]\s*[^\s]*$/.test(row))) return false;
  return true;
}

/** 网易云选曲规则模型：只服务 netease.play 扩展，核心循环不识别应用名。 */
export class MusicModel implements ModelAdapter {
  readonly name = "网易云选曲规则";
  readonly kind = "rule";
  constructor(private readonly request: MusicSelection) {}

  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    const observation = state.observation;
    if (!observation) throw new Error("网易云音乐窗口尚未观察到");
    // 播放状态从扩展自己的 music.netease 当次 facet 读取（核心不再提供 media 字段）。
    const media = observation.facets?.["music.netease"]?.data as MusicPlaybackData | undefined;
    const matchingSong = media?.title?.includes(this.request.title) &&
      (!this.request.artist || media.artist?.includes(this.request.artist));
    if (matchingSong && media?.playing) {
      return { kind: "done", summary: `正在播放 ${media.title}${media.artist ? ` - ${media.artist}` : ""}` };
    }
    if (matchingSong && media?.playing === false) {
      const clickedPlay = state.executedImpactActions?.some((item) =>
        item.includes("btn_pc_minibar_play"));
      if (clickedPlay && state.lastAction?.kind === "click") return { kind: "wait", ms: 900 };
      if (clickedPlay && state.lastAction?.kind === "wait") {
        throw new Error("播放器仍处于暂停状态，歌曲可能无法播放");
      }
      return { kind: "click", target: { kind: "selector", selector: "autoId=btn_pc_minibar_play" } };
    }

    const ui = lines(observation.accessibility);
    const edit = ui.find((line) => line.startsWith("Edit | "));
    if (!edit) throw new Error("网易云音乐没有可用的搜索输入框");
    const searchValue = edit.split(" | ")[2] ?? "";
    if (searchValue !== this.request.search) {
      return { kind: "type", target: { kind: "role", role: "Edit" }, text: this.request.search };
    }
    if (state.lastAction?.kind === "type") {
      return { kind: "keypress", keys: "Enter" };
    }
    if (!ui.includes(`Text | ${this.request.search} |  | autoId=`)) {
      if (state.lastAction?.kind === "keypress") return { kind: "wait", ms: 900 };
      if (state.lastAction?.kind === "wait") {
        return { kind: "click", target: { kind: "role", role: "Button", name: "search" } };
      }
      return { kind: "keypress", keys: "Enter" };
    }
    if (!ui.some((line) => line.startsWith("TabItem | 单曲 |"))) {
      return { kind: "click", target: { kind: "role", role: "Button", name: "search" } };
    }
    const rows = songRows(observation.accessibility);
    if (!ui.some((line) => line.startsWith("Table | grid |"))) {
      if (state.lastAction?.kind === "click" && state.lastAction.target.kind === "role" &&
          state.lastAction.target.name === "单曲") return { kind: "wait", ms: 900 };
      return { kind: "click", target: { kind: "role", role: "TabItem", name: "单曲" } };
    }
    if (!rows.length) {
      if (state.lastAction?.kind === "wait") throw new Error("单曲结果没有加载出来");
      return { kind: "wait", ms: 900 };
    }
    const row = rows.find((candidate) => rowMatches(candidate, this.request));
    if (!row) {
      throw new Error(`搜索结果中没有找到准确的“${this.request.artist ? `${this.request.artist} - ` : ""}${this.request.title}”单曲`);
    }
    if (state.lastAction?.kind === "double_click") return { kind: "wait", ms: 900 };
    if (state.lastAction?.kind === "wait" && state.executedImpactActions?.some((item) =>
      item.includes('"kind":"double_click"'))) {
      throw new Error("已双击歌曲，但播放器没有显示匹配的歌曲");
    }
    return { kind: "double_click", target: { kind: "role", role: "Group", name: row } };
  }
}
