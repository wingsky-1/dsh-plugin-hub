/**
 * dsh-mcp-manager — 插件行配置页（SettingsCard）。
 *
 * 浮窗位置 / 偏移编辑区，React 组件（经 build-client externals 注入）。
 * 读/写走 /api/dsh-mcp/config（GET 读 / POST 写），保存后经 SSE 热更新。
 * 注册面：plugins.row.config，由 index.ts 装配。
 */

import * as React from "react";
import { API } from "../core/constants.ts";
import { api } from "../core/api.ts";
import { t } from "../../../../../shared/client/i18n.js";
import type { ClientUiConfig } from "../../shared/interface.ts";

/** plugins.row.config owner 传给组件的视图与表单能力。 */
export interface SettingsCardProps {
  view: "summary" | "page";
  form?: unknown;
}

/**
 * summary 由插件行自身呈现；此组件不发配置/健康请求，也不返回嵌套 page DOM。
 * page 挂载独立表单组件，切换视图时也不会跨分支改变 Hook 顺序。
 */
export function SettingsCard(props: SettingsCardProps): React.ReactElement | null {
  if (props.view === "summary") return null;
  return <SettingsPage />;
}

function SettingsPage(): React.ReactElement {
  const useState = React.useState;
  const useEffect = React.useEffect;
  // 显式声明状态形状：useState(null) 会把状态推成字面 null，故显式泛型为扁平 UI 5 键。
  // cfg 是 GET /config 回执的副本，形状与跨端 ClientUiConfig 同源（DTO 单点）。
  const [cfg, setCfg] = useState<ClientUiConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null as { ok: boolean; text: string } | null);
  // C5：成功提示消失定时器登记 ref，卸载清理——匿名 setTimeout 在组件卸载
  // （HMR/设置页关闭）后仍 setState 触发 React 告警与潜在泄漏。
  // 显式泛型：useRef(undefined) 会把 ref 推成 undefined，setTimeout 的返回值写不进去。
  const msgTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api<ClientUiConfig | null>(API.config)
      .then((c: ClientUiConfig | null) => {
        if (live && c !== null && typeof c === "object") {
          setCfg(c);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
      if (msgTimer.current !== undefined) {
        clearTimeout(msgTimer.current);
        msgTimer.current = undefined;
      }
    };
  }, []);

  if (cfg === null) {
    return (
      <div className="dm-set-card">
        <div className="dm-set-body">{t("settingsLoading")}</div>
      </div>
    );
  }

  const set = (patch: Partial<ClientUiConfig>) => {
    setCfg((c) => (c !== null ? Object.assign({}, c, patch) : c));
  };
  // 层级基准与偏移量分开钳制：层级 1-9000（#128），偏移维持 0-2000。
  // 数字键仅四枚（position 走下拉），故收为数字键联合，索引与写回皆精确。
  type CfgNumberKey = "offsetX" | "offsetY" | "blankY" | "zIndexBase";
  const numInput = (key: CfgNumberKey, label: string, min = 0, max = 2000) => (
    <label className="dm-set-field">
      {label}
      <input
        className="dm-set-input"
        type="number"
        min={min}
        max={max}
        value={String(cfg[key])}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          const v = Number(e.target.value);
          set({
            [key]: Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : min,
          } as Partial<ClientUiConfig>);
        }}
      />
    </label>
  );

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      // 提交面恒为扁平 UI 5 键（与 POST /config 的白名单同源）：GET 回来的形状即提交形状，spread 超集保留。
      const payload: ClientUiConfig = { ...cfg };
      await api<unknown>(API.config, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMsg({ ok: true, text: t("settingsSavedOk") });
      if (msgTimer.current !== undefined) clearTimeout(msgTimer.current);
      msgTimer.current = setTimeout(() => {
        msgTimer.current = undefined;
        setMsg(null);
      }, 2400);
    } catch (e) {
      setMsg({
        ok: false,
        text: t("saveFail", { msg: e instanceof Error ? e.message : String(e) }),
      });
    }
    setSaving(false);
  };

  return (
    <div className="dm-set-card">
      <div className="dm-set-body">
        <div className="dm-set-row">
          <label htmlFor="dm-set-position">{t("anchorLabel")}</label>
          <select
            id="dm-set-position"
            className="dm-set-input"
            value={cfg.position}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              set({ position: e.target.value as ClientUiConfig["position"] });
            }}
          >
            <option value="top-right">{t("posTopRight")}</option>
            <option value="top-left">{t("posTopLeft")}</option>
            <option value="bottom-right">{t("posBottomRight")}</option>
            <option value="bottom-left">{t("posBottomLeft")}</option>
          </select>
        </div>
        <div className="dm-set-row">
          {numInput("offsetX", t("offsetX"))}
          {numInput("offsetY", t("offsetY"))}
          {numInput("blankY", t("blankY"))}
          {numInput("zIndexBase", t("zIndexBase"), 1, 9000)}
        </div>
        <div className="dm-set-hint">{t("settingsHint")}</div>
        <div className="dm-set-foot">
          {msg !== null ? (
            <span className={msg.ok ? "dm-set-saved" : "dm-set-error"}>{msg.text}</span>
          ) : null}
          <button
            type="button"
            className="dm-set-save"
            disabled={saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? t("savingNow") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
