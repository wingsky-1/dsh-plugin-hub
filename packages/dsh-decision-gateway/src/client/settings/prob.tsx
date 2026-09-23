/** dsh-decision-gateway — 概率条小组件（React；无图表库，手写 div）。 */
import * as React from "react";
import { clamp01 } from "../api/interface.ts";
import type { DecisionHistoryEntry } from "../api/interface.ts";
import { t } from "../locale.ts";

/** 高置信阈值线（展示用；判定以服务端 tier 为准，本线仅视觉参考）。 */
export const HIGH_LINE = 0.8;

export function tierBadge(tier: DecisionHistoryEntry["tier"]): React.ReactElement {
  if (tier === "high") return <span className="dj-badge dj-badgeOn">high</span>;
  if (tier === "low") return <span className="dj-badge dj-badgeWarn">low</span>;
  return <span className="dj-badge">none</span>;
}

export function probPercent(entry: DecisionHistoryEntry): number {
  const hasConf = entry.confidence !== 0;
  const p = hasConf
    ? clamp01(entry.confidence)
    : entry.score !== undefined
      ? clamp01(entry.score / 5)
      : 0;
  return Math.round(p * 100);
}

export function ProbBar({ entry }: { readonly entry: DecisionHistoryEntry }): React.ReactElement {
  const hasConf = entry.confidence !== 0;
  const pct = probPercent(entry);
  const title = hasConf
    ? "confidence " +
      entry.confidence +
      (entry.score !== undefined ? " / score " + entry.score + "/5" : "")
    : entry.score !== undefined
      ? "score " + entry.score + "/5"
      : t("noProb");
  const fillCls =
    "dj-barFill" +
    (entry.tier === "high" ? " dj-barFillHigh" : entry.tier === "low" ? " dj-barFillLow" : "");
  return (
    <div className="dj-probRow">
      <div className="dj-bar">
        <div className={fillCls} style={{ width: pct + "%" }} />
        <div
          className="dj-barThreshold"
          style={{ left: Math.round(HIGH_LINE * 100) + "%" }}
          title={t("highLine")}
        />
      </div>
      <span className="dj-probNum" title={title}>
        {pct + "%"}
      </span>
    </div>
  );
}
