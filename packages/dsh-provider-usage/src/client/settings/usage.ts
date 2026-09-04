/**
 * dsh-provider-usage — 设置页「用量可视化」分区（#532 拆分自 settings.ts，行为不变）。
 *
 * 各启用 provider 的状态点 + 胶囊内容（宿主端渲染 HTML），设置页 tab「用量」窗格。
 */
import * as React from "react";
import { t } from "../../../../../shared/client/i18n.js";
import { sectionStyle, titleStyle } from "./shared.ts";

/** /stats 响应中本页消费的字段（v2）。 */
export interface StatsView {
  provider?: string;
  adapterName?: string;
  status?: "fresh" | "cached" | "stale";
  capsuleHtml?: string;
  ok?: boolean;
  configured?: boolean;
  error?: string | null;
  fetchedAt?: number;
}

/** 状态 → 文案（i18n：渲染期求值）。 */
function statusLabel(status: string | undefined): string {
  if (status === "fresh") return t("statusFresh");
  if (status === "cached") return t("statusCached");
  if (status === "stale") return t("statusStale");
  return t("statusUnconfigured");
}

/** 状态 → 颜色（主题变量 + 浅色回退）。 */
function statusColor(status: string | undefined): string {
  if (status === "stale") return "var(--dsw-alias-state-warn-primary,#c9820b)";
  if (status === "fresh" || status === "cached") return "var(--dsw-alias-state-success-primary,#0f9d6e)";
  return "var(--dsw-alias-state-error-primary,#d64545)";
}

/** 用量可视化区：各启用 provider 的状态点 + 胶囊内容（宿主端渲染 HTML）。 */
export function UsageSection({ statsByProvider }: { statsByProvider: Record<string, StatsView | null> }): React.ReactElement {
  const providers = Object.keys(statsByProvider);
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, t("usageTitle")),
    providers.length === 0
      ? React.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } }, t("noProviders"))
      : providers.map((provider) => {
          const s = statsByProvider[provider];
          const dot = React.createElement("span", {
            key: "dot",
            style: {
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColor(s?.status),
              marginRight: 6,
              verticalAlign: "middle",
            },
          });
          // 适配器名与 provider 同名时省略，避免「rjkrjk」式连读
          const adapterPart = s?.adapterName && s.adapterName !== provider ? `${s.adapterName} · ` : "";
          const meta = `${adapterPart}${statusLabel(s?.status)}${
            typeof s?.fetchedAt === "number"
              ? ` · ${t("updatedAt", { t: new Date(s.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false }) })}`
              : ""
          }`;
          return React.createElement(
            "div",
            { key: provider, style: { marginBottom: 10 } },
            React.createElement(
              "div",
              { style: { marginBottom: 4 } },
              dot,
              React.createElement("span", { style: { fontWeight: 600 } }, provider),
              React.createElement(
                "span",
                { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)", marginLeft: 8, fontSize: 11 } },
                meta,
              ),
            ),
            s?.capsuleHtml
              ? React.createElement("div", { dangerouslySetInnerHTML: { __html: s.capsuleHtml } })
              : s?.error
                ? React.createElement(
                    "div",
                    { style: { color: "var(--dsw-alias-state-error-primary,#d64545)" } },
                    String(s.error),
                  )
                : React.createElement(
                    "div",
                    { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } },
                    t("noData"),
                  ),
          );
        }),
  );
}
