/**
 * dsh-jev-decide — 概率条小组件（components/ 域内模块，经 interface.ts 门面引用）。
 *
 * 细条 + 阈值线 + 数字（禁重色块；无运行时图表库，手写 div）。
 * 渲染只用文本节点；零 bare import。
 */
import { clamp01 } from "../api/interface.ts";
import type { JevHistoryEntry, JevTier } from "../api/interface.ts";
import { badge, el } from "./atoms.ts";

/** 高置信阈值线（展示用；判定以服务端 tier 为准，本线仅视觉参考）。 */
export const HIGH_LINE = 0.8;

export function tierBadge(tier: JevTier): HTMLElement {
  if (tier === "high") return badge("high", "dj-badgeOn");
  if (tier === "low") return badge("low", "dj-badgeWarn");
  return badge("none");
}

export function probRow(entry: JevHistoryEntry): HTMLElement {
  const row = el("div", { class: "dj-probRow" });
  // D5：score 为 1-5 打分制，按 score/5 归一后再进 0..1 钳制（禁原文直接喂入导致的恒 100%）；
  // confidence 优先（0..1），两者皆无回 0。
  const hasConf = entry.confidence !== 0;
  const p = hasConf
    ? clamp01(entry.confidence)
    : entry.score !== undefined
      ? clamp01(entry.score / 5)
      : 0;
  const bar = el("div", { class: "dj-bar" });
  const fill = el("div", {
    class:
      "dj-barFill" +
      (entry.tier === "high" ? " dj-barFillHigh" : entry.tier === "low" ? " dj-barFillLow" : ""),
  });
  (fill as HTMLElement).style.width = Math.round(p * 100) + "%";
  bar.appendChild(fill);
  const line = el("div", { class: "dj-barThreshold" });
  (line as HTMLElement).style.left = Math.round(HIGH_LINE * 100) + "%";
  line.title = "high 线 80%";
  bar.appendChild(line);
  row.appendChild(bar);
  const num = el("span", { class: "dj-probNum", text: Math.round(p * 100) + "%" });
  num.title = hasConf
    ? "confidence " +
      entry.confidence +
      (entry.score !== undefined ? " / score " + entry.score + "/5" : "")
    : entry.score !== undefined
      ? "score " + entry.score + "/5"
      : "无概率";
  row.appendChild(num);
  return row;
}
