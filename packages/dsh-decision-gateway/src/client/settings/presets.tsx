/**
 * dsh-decision-gateway — 模板库 tab（React，settings.section 独立页）。
 *
 * 要素：5 出题规范开关 + automationCap 三档（0=none/1=low/2=high，绝非百分比滑杆）
 * + 导出 JSON，无导入。行内详情单开（aria-expanded），复制为自定义走新增接口（P1 占位）。
 * 出题规范英文原文直排（数据不翻译）。保存携带快照 connection/history 原值回写。
 */
import * as React from "react";
import {
  APP_ROUTES,
  capLabel,
  failureCategory,
  fetchTimeout,
  normalizeCap,
  parseConfigPayload,
  parsePresetsPayload,
} from "../api/interface.ts";
import type {
  AutomationCap,
  DecisionConfigV1,
  DecisionPresetConfigEntry,
  DecisionPresetInfo,
} from "../api/interface.ts";
import { t } from "../locale.ts";

interface CustomDraft {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly cap: AutomationCap;
}

interface Row {
  readonly id: string;
  readonly custom: boolean;
  readonly label: string;
  readonly templateVersion?: number;
  readonly desc?: string;
  enabled: boolean;
  cap: AutomationCap;
}

type Msg = { readonly kind: "info" | "error" | "ok"; readonly text: string };

/**
 * 目录面与配置面合并成渲染行。
 *
 * 行序以目录面为准（infos 为空才回落配置面）——预设卡片按模板库顺序呈现，配置面
 * 只提供开关与上限，不决定出现顺序。id 缺席处一律回落到可见占位（label 回落 id、
 * enabled 回落 false），不因某一侧缺项而丢行。
 */
/**
 * 目录侧视图（GET /presets 元素；整项缺席即全空，label 缺席回落可见 id）。
 *
 * 缺席判定显式写成 undefined 比较而不是 ?. —— 一屏预设卡片的可见性全靠这里的
 * 占位回落，链式可选会在某一侧缺项时静默变成 undefined 字段而不是回落值。
 */
function infoView(
  info: DecisionPresetInfo | undefined,
  id: string,
): {
  readonly custom: boolean;
  readonly label: string;
  readonly templateVersion: number | undefined;
  readonly desc: string | undefined;
} {
  if (info === undefined) {
    return { custom: false, label: id, templateVersion: undefined, desc: undefined };
  }
  return {
    custom: info.custom === true,
    label: info.label ?? id,
    templateVersion: info.templateVersion,
    desc: info.description ?? info.label,
  };
}

/** 配置侧视图（GET /config 的 presets 元素；缺席即关闭 + none 档）。 */
function cfgView(row: DecisionPresetConfigEntry | undefined): {
  readonly enabled: boolean;
  readonly cap: AutomationCap;
} {
  if (row === undefined) return { enabled: false, cap: 0 };
  return { enabled: row.enabled, cap: normalizeCap(row.automationCap) };
}

/** 单行合成（两侧视图合一张卡片行；任一侧缺项都不丢行）。 */
function toRow(
  id: string,
  info: DecisionPresetInfo | undefined,
  cfgRow: DecisionPresetConfigEntry | undefined,
): Row {
  const iv = infoView(info, id);
  const cv = cfgView(cfgRow);
  return {
    id,
    custom: iv.custom,
    label: iv.label,
    templateVersion: iv.templateVersion,
    desc: iv.desc,
    enabled: cv.enabled,
    cap: cv.cap,
  };
}

export function mergeRows(infos: readonly DecisionPresetInfo[], cfg: DecisionConfigV1): Row[] {
  const byCfg = new Map(cfg.presets.map((p) => [p.id, p]));
  const byInfo = new Map(infos.map((i) => [i.id, i]));
  const ids = infos.length > 0 ? infos.map((i) => i.id) : cfg.presets.map((p) => p.id);
  return ids.map((id) => toRow(id, byInfo.get(id), byCfg.get(id)));
}

export function PresetsPane(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<DecisionConfigV1 | null>(null);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [openDetail, setOpenDetail] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<Msg | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [draftId, setDraftId] = React.useState("");
  const [draftLabel, setDraftLabel] = React.useState("");
  const [draftDesc, setDraftDesc] = React.useState("");
  const [draftCap, setDraftCap] = React.useState<AutomationCap>(1);
  const [armedDelete, setArmedDelete] = React.useState<string | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = React.useCallback(() => {
    setFailed(false);
    setMsg({ kind: "info", text: t("loading") });
    void Promise.all([
      fetchTimeout(APP_ROUTES.presets, { headers: { accept: "application/json" } }).then(
        async (res) => {
          if (!res.ok) throw new Error("presets-http-" + res.status);
          return parsePresetsPayload(await res.json());
        },
      ),
      fetchTimeout(APP_ROUTES.config, { headers: { accept: "application/json" } }).then(
        async (res) => {
          if (!res.ok) throw new Error("config-http-" + res.status);
          const cfg = parseConfigPayload(await res.json());
          if (cfg === null) throw new Error("config-shape-unknown");
          return cfg;
        },
      ),
    ])
      .then(([infos, cfg]: [DecisionPresetInfo[], DecisionConfigV1]) => {
        if (!alive.current) return;
        setSnapshot(cfg);
        setRows(mergeRows(infos, cfg));
        setMsg({ kind: "info", text: t("presetsMergedNote") });
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setSnapshot(null);
        setRows([]);
        setFailed(true);
        setMsg({
          kind: "error",
          text: t("loadFail") + (e instanceof Error ? e.message : String(e)),
        });
      });
  }, []);
  React.useEffect(load, [load]);

  const patchRow = (id: string, patch: Partial<Row>): void => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const doExport = (): void => {
    if (rows.length === 0) return;
    const doc = {
      plugin: "dsh-decision-gateway",
      version: 1 as const,
      exportedAt: Date.now(),
      presets: rows.map((r) => ({
        id: r.id,
        enabled: r.enabled,
        automationCap: r.cap,
        ...(r.templateVersion !== undefined ? { templateVersion: r.templateVersion } : {}),
      })),
    };
    try {
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "dsh-decision-gateway-presets.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg({ kind: "ok", text: t("presetsExported", { n: rows.length }) });
    } catch (e: unknown) {
      setMsg({ kind: "error", text: t("saveFail") + (e instanceof Error ? e.message : String(e)) });
    }
  };

  const putCustoms = (customs: CustomDraft[]): void => {
    setSaving(true);
    setMsg({ kind: "info", text: t("saving") });
    void fetchTimeout(APP_ROUTES.config, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        customPresets: customs.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
          enabled: c.enabled,
          automationCap: c.cap,
        })),
      }),
    })
      .then(async (res) => {
        if (!alive.current) return;
        if (!res.ok) {
          let cat = "http-" + res.status;
          try {
            cat = failureCategory(res.status, await res.json());
          } catch {
            /* keep status */
          }
          throw new Error(cat);
        }
        setFormOpen(false);
        setMsg({ kind: "ok", text: t("customSaved") });
        load();
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setMsg({
          kind: "error",
          text: t("saveFail") + (e instanceof Error ? e.message : String(e)),
        });
      })
      .finally(() => {
        if (alive.current) setSaving(false);
      });
  };

  const createCustom = (): void => {
    const id = draftId.trim();
    if (id === "" || draftLabel.trim() === "" || draftDesc.trim() === "") {
      setMsg({ kind: "error", text: t("customFormInvalid") });
      return;
    }
    const next: CustomDraft[] = rows
      .filter((r) => r.custom)
      .map((r) => ({
        id: r.id,
        label: r.label,
        description: r.desc ?? r.id,
        enabled: r.enabled,
        cap: r.cap,
      }))
      .filter((r) => r.id !== id);
    next.push({
      id,
      label: draftLabel.trim(),
      description: draftDesc.trim(),
      enabled: false,
      cap: draftCap,
    });
    putCustoms(next);
  };

  const save = (): void => {
    if (snapshot === null || saving) return;
    const presets = rows
      .filter((r) => !r.custom)
      .map((r) => ({ id: r.id, enabled: r.enabled, automationCap: r.cap }));
    const customs = rows
      .filter((r) => r.custom)
      .map((r) => ({
        id: r.id,
        label: r.label,
        description: r.desc ?? r.id,
        enabled: r.enabled,
        automationCap: r.cap,
      }));
    const conn = snapshot.connection;
    const body: Record<string, unknown> = {
      version: 1,
      connection: {
        timeoutMs: conn.timeoutMs,
        maxConcurrency: conn.maxConcurrency,
        truncBudget: conn.truncBudget,
        ...(conn.apiKeyRef !== undefined && conn.apiKeyRef !== ""
          ? { apiKeyRef: conn.apiKeyRef }
          : {}),
      },
      presets,
      customPresets: customs,
      history: {
        perSession: snapshot.history.perSession,
        totalSessions: snapshot.history.totalSessions,
      },
    };
    setSaving(true);
    setMsg({ kind: "info", text: t("saving") });
    void fetchTimeout(APP_ROUTES.config, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!alive.current) return;
        if (!res.ok) {
          let cat = "http-" + res.status;
          try {
            cat = failureCategory(res.status, await res.json());
          } catch {
            /* 非 JSON 即保持状态码类别 */
          }
          throw new Error(cat);
        }
        setMsg({ kind: "ok", text: t("presetsSaved", { n: presets.length }) });
        load();
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setMsg({
          kind: "error",
          text: t("saveFail") + (e instanceof Error ? e.message : String(e)),
        });
      })
      .finally(() => {
        if (alive.current) setSaving(false);
      });
  };

  return (
    <div className="dj-pane" data-tab="presets">
      <div className="dj-tools">
        <span className="dj-badge">
          {rows.length === 0 ? t("loading") : t("presetsCount", { n: rows.length })}
        </span>
      </div>
      {msg !== null && (
        <div className="dj-field">
          <span className={msg.kind === "error" ? "dj-errLine" : "dj-note"}>{msg.text}</span>
        </div>
      )}
      <div className="dj-field">
        {rows.length === 0 && !failed ? (
          <div className="dj-note">{t("emptyPresets")}</div>
        ) : (
          rows.map((row) => {
            const open = openDetail === row.id;
            return (
              <div className="dj-preset" key={row.id}>
                <div className="dj-presetHead">
                  <span className="dj-presetId">{row.id}</span>
                  {row.custom && <span className="dj-badge dj-badgeInfo">{t("customBadge")}</span>}
                  <label className="dj-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t("enablePresetAria") + row.id}
                      checked={row.enabled}
                      onChange={(e) => patchRow(row.id, { enabled: e.target.checked })}
                    />
                    {row.enabled ? t("enabledOn") : t("enabledOff")}
                  </label>
                </div>
                {row.templateVersion !== undefined && (
                  <div className="dj-note">
                    {t("tplVersion")}
                    {row.templateVersion}
                    {t("frozenNote")}
                  </div>
                )}
                <div className="dj-rangeRow">
                  <label>{t("capLabel")}</label>
                  <select
                    className="dj-select"
                    autoComplete="off"
                    aria-label={t("capLabel") + " " + row.id}
                    value={String(row.cap)}
                    onChange={(e) =>
                      patchRow(row.id, { cap: normalizeCap(Number(e.target.value)) })
                    }
                  >
                    <option value="0">{t("capNone")}</option>
                    <option value="1">low</option>
                    <option value="2">high</option>
                  </select>
                  <span className="dj-rangeVal">{capLabel(row.cap)}</span>
                </div>
                <div className="dj-tools">
                  <button
                    type="button"
                    className="dj-btn dj-btnSmall"
                    aria-expanded={open ? "true" : "false"}
                    aria-controls={"dj-detail-" + row.id}
                    onClick={() => setOpenDetail(open ? null : row.id)}
                  >
                    {t("detail")}
                  </button>
                </div>
                {open && (
                  <div className="dj-field" id={"dj-detail-" + row.id}>
                    <div className="dj-note">{row.desc ?? t("emptySpec")}</div>
                    <div className="dj-tools">
                      <button
                        type="button"
                        className="dj-btn dj-btnSmall"
                        onClick={() => {
                          setDraftId(row.id + "-copy");
                          setDraftLabel(row.label);
                          setDraftDesc(row.desc ?? "");
                          setDraftCap(row.cap);
                          setFormOpen(true);
                        }}
                      >
                        {t("copyCustom")}
                      </button>
                      {row.custom && (
                        <button
                          type="button"
                          className="dj-btn dj-btnSmall dj-btnDanger"
                          onClick={() => {
                            if (armedDelete === row.id) {
                              setArmedDelete(null);
                              void putCustoms(
                                rows
                                  .filter((r) => r.custom && r.id !== row.id)
                                  .map((r) => ({
                                    id: r.id,
                                    label: r.label,
                                    description: r.desc ?? r.id,
                                    enabled: r.enabled,
                                    cap: r.cap,
                                  })),
                              );
                            } else {
                              setArmedDelete(row.id);
                              setMsg({ kind: "info", text: t("confirmDeleteCustom") });
                            }
                          }}
                        >
                          {armedDelete === row.id ? t("confirmDelete") : t("deleteCustom")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="dj-tools">
        <button type="button" className="dj-btn dj-btnSmall" onClick={() => setFormOpen((v) => !v)}>
          {t("addCustom")}
        </button>
      </div>
      {formOpen && (
        <div className="dj-field">
          <label>{t("customIdLabel")}</label>
          <input
            className="dj-input"
            autoComplete="off"
            aria-label={t("customIdLabel")}
            value={draftId}
            placeholder="my-board"
            onChange={(e) => setDraftId(e.target.value)}
          />
          <label>{t("customLabelLabel")}</label>
          <input
            className="dj-input"
            autoComplete="off"
            aria-label={t("customLabelLabel")}
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
          />
          <label>{t("customDescLabel")}</label>
          <textarea
            className="dj-input"
            rows={3}
            aria-label={t("customDescLabel")}
            value={draftDesc}
            onChange={(e) => setDraftDesc(e.target.value)}
          />
          <label>{t("capLabel")}</label>
          <select
            className="dj-select"
            autoComplete="off"
            value={String(draftCap)}
            onChange={(e) => setDraftCap(normalizeCap(Number(e.target.value)))}
          >
            <option value="0">{t("capNone")}</option>
            <option value="1">low</option>
            <option value="2">high</option>
          </select>
          <span className="dj-note">{t("customDraftNote")}</span>
          <div className="dj-tools">
            <button type="button" className="dj-btn dj-btnSmall" onClick={() => setFormOpen(false)}>
              {t("cancelCustom")}
            </button>
            <button
              type="button"
              className="dj-btn dj-btnPrimary"
              disabled={saving}
              onClick={createCustom}
            >
              {t("createCustom")}
            </button>
          </div>
        </div>
      )}
      <div className="dj-foot">
        {failed && (
          <button type="button" className="dj-btn dj-btnSmall" onClick={load}>
            {t("retry")}
          </button>
        )}
        <button
          type="button"
          className="dj-btn dj-btnSmall"
          disabled={rows.length === 0}
          onClick={doExport}
        >
          {t("exportJson")}
        </button>
        <button
          type="button"
          className="dj-btn dj-btnPrimary"
          disabled={saving || snapshot === null}
          onClick={save}
        >
          {t("save")}
        </button>
      </div>
      <div className="dj-note">{t("noImportNote")}</div>
    </div>
  );
}
