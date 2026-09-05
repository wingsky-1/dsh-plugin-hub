/**
 * dsh-provider-usage — 设置页「悬浮胶囊」分区（#532 拆分自 settings.ts，行为不变）。
 *
 * 锚点 + 偏移输入，保存即热更新（宿主落盘 + 客户端轮询收敛）。设置页 tab「悬浮窗」窗格。
 */
import * as React from "react";
import { fetchUiConfig, saveUiConfig } from "../core.ts";
import type { UiPlacementConfig } from "../core.ts";
import { t } from "../../../../../shared/client/i18n.js";
import type { ProviderUsageLocaleKey } from "../locales.ts";
import { sectionStyle, titleStyle } from "./shared.ts";

/** 胶囊位置配置区：锚点 + 偏移输入，保存即热更新（宿主落盘 + SSE 广播）。
 *  label 存字典 key（i18n：渲染期经 t 求值，模块加载时 t 尚未装配）。 */
const PLACEMENT_OPTIONS: Array<{ value: UiPlacementConfig["placement"]; key: ProviderUsageLocaleKey }> = [
  { value: "top-right", key: "posTopRight" },
  { value: "top-left", key: "posTopLeft" },
  { value: "bottom-right", key: "posBottomRight" },
  { value: "bottom-left", key: "posBottomLeft" },
];

export function UiSection(): React.ReactElement | null {
  const [cfg, setCfg] = React.useState<UiPlacementConfig | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  React.useEffect(() => {
    let live = true;
    void fetchUiConfig().then((c) => {
      if (live) setCfg(c);
    });
    return () => {
      live = false;
    };
  }, []);

  if (cfg === null) return null; // 未加载完成不渲染，避免表单闪烁

  const set = (patch: Partial<UiPlacementConfig>): void => setCfg((c) => (c !== null ? { ...c, ...patch } : c));

  const save = async (): Promise<void> => {
    setSaving(true);
    setMsg(null);
    try {
      await saveUiConfig(cfg);
      setMsg({ ok: true, text: t("uiSavedOk") });
    } catch (e) {
      setMsg({ ok: false, text: t("uiSaveFail", { msg: e instanceof Error ? e.message : String(e) }) });
    }
    setSaving(false);
  };

  // 层级基准与偏移量分开钳制：层级 1-9000（#128），偏移维持 0-2000。
  const numInput = (key: "offsetX" | "offsetY" | "panelOffsetY" | "zIndexBase", label: string, min = 0, max = 2000): React.ReactNode =>
    React.createElement(
      "label",
      { style: { marginRight: 12, whiteSpace: "nowrap" } },
      label,
      React.createElement("input", {
        type: "number",
        min,
        max,
        value: String(cfg[key]),
        style: { width: 64, marginLeft: 6, padding: "2px 6px", border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)", borderRadius: 4 },
        onChange: (e: unknown) => {
          const v = Number((e as { target: { value: string } }).target.value);
          set({ [key]: Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : min } as Partial<UiPlacementConfig>);
        },
      }),
    );

  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, t("uiTitle")),
    React.createElement(
      "div",
      { style: { marginBottom: 8 } },
      t("uiAnchor"),
      React.createElement(
        "select",
        {
          value: cfg.placement,
          style: { marginLeft: 6, padding: "2px 6px", border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)", borderRadius: 4 },
          onChange: (e: unknown) => set({ placement: (e as { target: { value: UiPlacementConfig["placement"] } }).target.value }),
        },
        PLACEMENT_OPTIONS.map((o) => React.createElement("option", { key: o.value, value: o.value }, t(o.key))),
      ),
    ),
    // #543 窄屏兜底：四个数字输入行允许换行（约 350px 内容宽度下 nowrap 横排会溢出）
    React.createElement(
      "div",
      { style: { marginBottom: 8, display: "flex", flexWrap: "wrap", rowGap: 6 } },
      numInput("offsetX", t("offsetX")),
      numInput("offsetY", t("offsetY")),
      numInput("panelOffsetY", t("panelOffsetY")),
      numInput("zIndexBase", t("zIndexBase"), 1, 9000),
    ),
    React.createElement(
      "button",
      {
        type: "button",
        className: "dou-btn",
        disabled: saving,
        onClick: () => {
          void save();
        },
      },
      saving ? t("savingNow") : t("save"),
    ),
    msg !== null
      ? React.createElement(
          "span",
          { style: { marginLeft: 10, color: msg.ok ? "var(--dsw-alias-state-success-primary,#0f9d6e)" : "var(--dsw-alias-state-error-primary,#d64545)" } },
          msg.text,
        )
      : null,
  );
}
