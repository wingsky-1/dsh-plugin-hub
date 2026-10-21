/**
 * dsh-provider-usage — 胶囊「最后更新」标注的 DOM 接线（#1167 评审 P1-3）。
 *
 * 从 client/index.tsx 的编排面拆出：纯推导仍在 float-view.staleAgeText，本模块只做
 * 「无标注即 no-op」的 DOM 追加。拆出的目的是让 client-dom 能直接断言接线存在——
 * 删掉追加逻辑或用例消失时都必须变红（原实现整段删除仍 3749 全绿）。
 */
import type { StatsResponseV2 } from "./core.ts";
import { PILL_PREFIX, staleAgeText } from "./float-view.ts";

/** 标注类名（样式见 client/style.css 的 .dou-stale-age）。 */
export const STALE_AGE_CLASS = `${PILL_PREFIX}stale-age`;

/**
 * 在胶囊 label 内追加「最后更新 X 前」。
 * @param labelEl 胶囊 label（调用方每次重建 innerHTML 后再调用，避免重复叠加）。
 * @param stats 最近一次 /stats 响应。
 * @returns 是否追加（无标注时 no-op）。
 */
export function appendStaleAgeNote(labelEl: Element, stats: StatsResponseV2 | null): boolean {
  const text = staleAgeText(stats);
  if (text === "") return false;
  const note = document.createElement("span");
  note.className = STALE_AGE_CLASS;
  note.textContent = ` · ${text}`;
  labelEl.appendChild(note);
  return true;
}
