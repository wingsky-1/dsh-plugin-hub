/**
 * dsh-mcp-manager — 设置页插件卡（SettingsCard）。
 *
 * 浮窗位置 / 偏移编辑区，React 组件（经 build-client externals 注入）。
 * 读/写走 /api/dsh-mcp/config（GET 读 / POST 写），保存后经 SSE 热更新。
 * 注册面：slots.inject("settings.plugin.item")，由 index.ts 装配。
 */

import * as React from "react";
import { API } from "./constants.js";
import { api } from "./dom.js";

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
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null) as any;

  useEffect(() => {
    let live = true;
    api(API.config).then((c: any) => {
      if (live && c !== null && typeof c === "object") setCfg(c);
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (cfg === null) {
    return React.createElement("li", { className: "dm-set-card" }, "MCP 管理器：加载中…");
  }

  const set = (patch: any) => setCfg((c: any) => (c !== null ? Object.assign({}, c, patch) : c));
  const numInput = (key: string, label: string) =>
    React.createElement("label", { className: "dm-set-field" },
      label,
      React.createElement("input", {
        className: "dm-set-input",
        type: "number",
        min: 0,
        max: 2000,
        value: String(cfg[key]),
        onChange: (e: any) => {
          const v = Number(e.target.value);
          set({ [key]: Number.isFinite(v) ? Math.min(2000, Math.max(0, Math.round(v))) : 0 });
        },
      }),
    );
  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api(API.config, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      });
      setMsg({ ok: true, text: "已保存——浮窗位置即时生效（无需重启）" });
      setTimeout(() => setMsg(null), 2400);
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${e instanceof Error ? e.message : String(e)}` });
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
        React.createElement("span", { className: "dm-set-name" }, "MCP 管理器（dsh-mcp-manager）"),
        React.createElement("span", { className: "dm-set-description" }, "浮窗位置 / 水平·垂直·空白偏移"),
      ),
      React.createElement("span", { className: "dm-set-chevron" + (open ? " dm-set-chevronOpen" : "") }, "▾"),
    ),
    open ? React.createElement("div", { className: "dm-set-body" },
      React.createElement("div", { className: "dm-set-row" },
        React.createElement("label", { htmlFor: "dm-set-position" }, "锚点"),
        React.createElement("select", {
          id: "dm-set-position",
          className: "dm-set-input",
          value: cfg.position,
          onChange: (e: any) => set({ position: e.target.value }),
        },
          React.createElement("option", { value: "top-right" }, "右上（top-right）"),
          React.createElement("option", { value: "bottom-right" }, "右下（bottom-right）"),
        ),
      ),
      React.createElement("div", { className: "dm-set-row" },
        numInput("offsetX", "水平偏移"),
        numInput("offsetY", "垂直偏移"),
        numInput("blankY", "空白偏移"),
      ),
      React.createElement("div", { className: "dm-set-hint" },
        "保存即热更新：宿主经 SSE events 通道广播一变，所有标签页的浮窗即刻原位更新，无需重启 dsh web。"),
      React.createElement("div", { className: "dm-set-foot" },
        msg !== null
          ? React.createElement("span", { className: msg.ok ? "dm-set-saved" : "dm-set-error" }, msg.text)
          : null,
        React.createElement("button", {
          type: "button",
          className: "dm-set-save",
          disabled: saving,
          onClick: () => { void save(); },
        }, saving ? "保存中…" : "保存"),
      ),
    ) : null,
  );
}