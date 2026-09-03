/**
 * dsh-mcp-manager — 设置页插件卡（SettingsCard）。
 *
 * 浮窗位置 / 偏移编辑区，React 组件（经 build-client externals 注入）。
 * 读/写走 /api/dsh-mcp/config（GET 读 / POST 写），保存后经 SSE 热更新。
 * 注册面：slots.inject("settings.plugin.item")，由 index.ts 装配。
 */

import * as React from "react";
import { API } from "./constants.ts";
import { api } from "./dom.ts";
import { t } from "../../../../shared/client/i18n.js";

/**
 * 设置页插件卡（settings.plugin.item）：浮窗位置 / 偏移编辑区。
 * 与 provider-usage「胶囊位置」编辑区同构友好度（锚点下拉 + 水平/垂直偏移 +
 * 空白偏移 + 保存），读/写走 /api/dsh-mcp/config（GET 读 / POST 写），
 * 保存后经 SSE 热更新。
 */
export function SettingsCard() {
  const useState = React.useState;
  const useEffect = React.useEffect;
  const [cfg, setCfg] = useState(null) as any;
  const [middleware, setMiddleware] = useState("project");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null) as any;

  useEffect(() => {
    let live = true;
    api(API.config).then((c: any) => {
      if (live && c !== null && typeof c === "object") {
        setCfg(c);
        if (typeof c.middleware === "string") setMiddleware(c.middleware);
      }
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (cfg === null) {
    return React.createElement("li", { className: "dm-set-card" }, t("settingsLoading"));
  }

  const set = (patch: any) => setCfg((c: any) => (c !== null ? Object.assign({}, c, patch) : c));
  // 层级基准与偏移量分开钳制：层级 1-9000（#128），偏移维持 0-2000。
  const numInput = (key: string, label: string, min = 0, max = 2000) =>
    React.createElement("label", { className: "dm-set-field" },
      label,
      React.createElement("input", {
        className: "dm-set-input",
        type: "number",
        min,
        max,
        value: String(cfg[key]),
        onChange: (e: any) => {
          const v = Number(e.target.value);
          set({ [key]: Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : min });
        },
      }),
    );
  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload: any = { ...cfg };
      if (middleware !== (cfg.middleware ?? "project")) payload.middleware = middleware;
      await api(API.config, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMsg({ ok: true, text: t("settingsSavedOk") });
      setTimeout(() => setMsg(null), 2400);
    } catch (e) {
      setMsg({ ok: false, text: t("saveFail", { msg: e instanceof Error ? e.message : String(e) }) });
    }
    setSaving(false);
  };

  return React.createElement("li", { className: "dm-set-card" + (open ? " dm-set-cardOpen" : "") },
    React.createElement("button", {
      type: "button",
      className: "dm-set-head",
      "aria-expanded": open,
      onClick: () => setOpen(!open),
    },
      React.createElement("span", { className: "dm-set-headText" },
        React.createElement("span", { className: "dm-set-name" }, t("settingsName")),
        React.createElement("span", { className: "dm-set-description" }, t("settingsDescription")),
      ),
      React.createElement("svg", {
        className: "dm-set-chevron" + (open ? " dm-set-chevronOpen" : ""),
        width: 14,
        height: 14,
        viewBox: "0 0 14 14",
        fill: "none",
        xmlns: "http://www.w3.org/2000/svg",
        "aria-hidden": "true",
      },
        React.createElement("path", {
          d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
          fill: "currentColor",
        }),
      ),
    ),
    open ? React.createElement("div", { className: "dm-set-body" },
      React.createElement("div", { className: "dm-set-row" },
        React.createElement("label", { htmlFor: "dm-set-position" }, t("anchorLabel")),
        React.createElement("select", {
          id: "dm-set-position",
          className: "dm-set-input",
          value: cfg.position,
          onChange: (e: any) => set({ position: e.target.value }),
        },
          React.createElement("option", { value: "top-right" }, t("posTopRight")),
          React.createElement("option", { value: "top-left" }, t("posTopLeft")),
          React.createElement("option", { value: "bottom-right" }, t("posBottomRight")),
          React.createElement("option", { value: "bottom-left" }, t("posBottomLeft")),
        ),
      ),
      React.createElement("div", { className: "dm-set-row" },
        React.createElement("label", { htmlFor: "dm-set-middleware" }, t("modeLabel")),
        React.createElement("select", {
          id: "dm-set-middleware",
          className: "dm-set-input",
          value: middleware,
          onChange: (e: any) => setMiddleware(e.target.value),
        },
          React.createElement("option", { value: "project" }, t("modeProject")),
          React.createElement("option", { value: "all" }, t("modeAll")),
          React.createElement("option", { value: "off" }, t("modeOff")),
        ),
      ),
      React.createElement("div", { className: "dm-set-row" },
        numInput("offsetX", t("offsetX")),
        numInput("offsetY", t("offsetY")),
        numInput("blankY", t("blankY")),
        numInput("zIndexBase", t("zIndexBase"), 1, 9000),
      ),
      React.createElement("div", { className: "dm-set-hint" },
        t("settingsHint")),
      React.createElement("div", { className: "dm-set-foot" },
        msg !== null
          ? React.createElement("span", { className: msg.ok ? "dm-set-saved" : "dm-set-error" }, msg.text)
          : null,
        React.createElement("button", {
          type: "button",
          className: "dm-set-save",
          disabled: saving,
          onClick: () => { void save(); },
        }, saving ? t("savingNow") : t("save")),
      ),
    ) : null,
  );
}