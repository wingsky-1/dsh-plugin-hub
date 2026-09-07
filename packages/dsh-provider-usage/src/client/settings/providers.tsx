/**
 * dsh-provider-usage — 设置页「适配器」分区（#532 拆分自 settings.ts，行为不变）。
 *
 * 提供商手风琴列表（主列表对齐模型配置页 + 自定义 provider 独立分组）：
 * 候选开关 + 内嵌添加表单 + 检测卡片 + 引导指令复制。
 */
import * as React from "react";
import { fetchTimeout, SELECT_URL, INSPECT_URL, ADD_URL } from "../core.ts";
import { splitProviderList, providerBadgeText } from "../../client-logic.ts";
import type { ProviderListItem } from "../../client-logic.ts";
import { t } from "../../../../../shared/client/i18n.js";
import { copyText, sectionStyle, titleStyle } from "./shared.ts";

/** 候选条目（adapters.json host[]）。 */
export interface AdapterInfo {
  name: string;
  label: string;
  providers: string[];
  source: "builtin" | "user-file";
  file?: string | null;
  enabled?: boolean;
}

/** 错误登记条目（adapters.json errors[]）。 */
export interface AdapterErrorEntry {
  key: string;
  at: number;
  kind: string;
  message: string;
}

/** adapters.json 响应形状。 */
export interface AdaptersMeta {
  version?: number;
  host?: AdapterInfo[];
  enabled?: Record<string, string>;
  modelProviders?: string[];
  errors?: AdapterErrorEntry[];
}

/** inspect 回显的导出信息（v2：name 字段）。 */
export interface InspectAdapter {
  name: string;
  label: string;
  providers: string[];
  version: number;
}

/** inspect 结果（ok=false 时 detail 可回显给用户排障）。 */
export interface InspectResult {
  ok: boolean;
  adapter?: InspectAdapter;
  detail?: string;
}

/** add 结果（ok=false 时 detail 可回显给用户排障）。 */
export interface AddResult {
  ok: boolean;
  detail?: string;
}

/** 一句话引导指令（v2 文档链接）。 */
function guideCommand(provider: string): string {
  return `请为提供商 ${provider} 创建用量统计适配器（v2 契约）：以该提供商在模型配置中的 API 端点（baseUrl）为起点，自行确认用量接口与鉴权方式，自主设计适配器方案（name/展示名/接口路径），先给我审核方案（含 API 端点），确认后生成 .mjs 文件、告诉保存路径并引导我在「用量统计」设置页添加适配器。按用量统计适配器开发引导文档（https://github.com/wingsky-1/dsh-plugin-hub/blob/main/packages/dsh-provider-usage/docs/adapter-guide.md）执行引导流程。`;
}

/** 单个提供商手风琴项：折叠头（徽标）+ 展开管理区（候选开关 + 内嵌添加表单）。 */
function ProviderItem({
  item,
  candidates,
  errorByKey,
  busy,
  onSwitch,
  onDisable,
  onInspect,
  onAdd,
}: {
  item: ProviderListItem;
  candidates: Array<{ name: string; label: string; source: string; file?: string | null }>;
  errorByKey: Map<string, AdapterErrorEntry>;
  busy: boolean;
  onSwitch(provider: string, adapterName: string): void;
  onDisable(provider: string): void;
  onInspect(file: string): Promise<InspectResult>;
  onAdd(provider: string, form: { file: string }): Promise<AddResult>;
}) {
  const [open, setOpen] = React.useState<boolean>(false);
  const [showAddForm, setShowAddForm] = React.useState<boolean>(false);
  const [file, setFile] = React.useState<string>("");
  const [inspecting, setInspecting] = React.useState<boolean>(false);
  const [inspected, setInspected] = React.useState<InspectAdapter | null>(null);
  const [inspErr, setInspErr] = React.useState<string | null>(null);
  const [addMsg, setAddMsg] = React.useState<string | null>(null);
  const [addErr, setAddErr] = React.useState<boolean>(false);
  const [adding, setAdding] = React.useState<boolean>(false);
  const [copied, setCopied] = React.useState<boolean>(false);

  const guide = guideCommand(item.provider);
  const onCopyGuide = async (): Promise<void> => {
    if (await copyText(guide)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  const badge = providerBadgeText(item, t as (key: string, params?: Record<string, unknown>) => string);

  /** 检测文件：inspect 路由回显导出信息，不注册（确认后才 add）。 */
  const doInspect = async (): Promise<void> => {
    if (file.trim() === "" || busy || inspecting) return;
    setInspecting(true);
    setInspErr(null);
    setInspected(null);
    setAddMsg(null);
    try {
      const r = await onInspect(file.trim());
      if (r.ok) setInspected(r.adapter ?? null);
      else setInspErr(r.detail ?? t("inspectFail"));
    } finally {
      setInspecting(false);
    }
  };

  /** 确认添加：仅 file（身份以导出为准），add 路由热注册并持久化。 */
  const submitAdd = async (): Promise<void> => {
    if (file.trim() === "" || inspected === null || busy || adding) return;
    setAdding(true);
    setAddMsg(null);
    const r = await onAdd(item.provider, { file: file.trim() });
    if (r.ok) {
      setFile("");
      setInspected(null);
      setShowAddForm(false);
      setInspErr(null);
    } else {
      setAddErr(true);
      setAddMsg(r.detail ?? t("addFail"));
    }
    setAdding(false);
  };

  /** 展开/收起内嵌添加表单（重置状态）。 */
  const toggleAdd = (): void => {
    setShowAddForm((v) => !v);
    setFile("");
    setInspected(null);
    setInspErr(null);
    setAddMsg(null);
    setAddErr(false);
  };

  const adapterRows = candidates.map((c) => {
    const err = errorByKey.get(c.name);
    const enabled = c.name === item.enabledId;
    return (
      <div key={c.name} className={`dou-adapterRow${enabled ? " dou-active" : ""}`}>
        <div className="dou-adapterInfo">
          <span className="dou-adapterName">{c.label}</span>
          <span className="dou-adapterMeta">
            {`${c.name} · ${c.source === "builtin" ? t("adapterBuiltin") : t("adapterCustom")}${c.file ? ` · ${c.file}` : ""}`}
          </span>
        </div>
        <label className="dou-switchWrap" title={enabled ? t("switchOffTitle") : t("switchOnTitle")}>
          <input
            type="checkbox"
            className="dou-switch"
            checked={enabled}
            disabled={busy}
            onChange={(e: unknown) => {
              const checked = (e as { target: { checked: boolean } }).target.checked;
              if (checked) onSwitch(item.provider, c.name);
              else onDisable(item.provider);
            }}
          />
          <span className="dou-switchTrack" aria-hidden="true" />
        </label>
        {err !== undefined ? <div className="dou-provErr">{t("lastError", { msg: err.message })}</div> : null}
      </div>
    );
  });

  const inspectCard =
    inspected === null ? null : (
      <div className="dou-inspectCard">
        <div className="dou-inspectRow"><span className="dou-inspectK">{t("inspectKName")}</span><span className="dou-inspectV">{inspected.name}</span></div>
        <div className="dou-inspectRow"><span className="dou-inspectK">{t("inspectKLabel")}</span><span className="dou-inspectV">{inspected.label}</span></div>
        <div className="dou-inspectRow"><span className="dou-inspectK">{t("inspectKProviders")}</span><span className="dou-inspectV">{inspected.providers.join("、") || item.provider}</span></div>
        <div className="dou-inspectRow"><span className="dou-inspectK">{t("inspectKVersion")}</span><span className="dou-inspectV">{`version ${inspected.version} ✓`}</span></div>
      </div>
    );

  const addForm = (
    <div className="dou-addForm">
      <div className="dou-addField">
        <span className="dou-addLabel">
          {t("filePath")}
          <span className="dou-addOnly">{t("filePathOnly")}</span>
        </span>
      </div>
      <input
        className="dou-input"
        value={file}
        placeholder="~/.dsh/.../xxx.mjs 或绝对路径"
        maxLength={1024}
        onChange={(e: unknown) => setFile((e as { target: { value: string } }).target.value)}
      />
      <div className="dou-provActions">
        <button
          type="button"
          className="dou-btn"
          disabled={busy || inspecting || file.trim() === ""}
          onClick={doInspect}
        >
          {inspecting ? t("detecting") : t("detectFile")}
        </button>
        <button
          type="button"
          className="dou-btn"
          disabled={busy || adding || inspected === null}
          onClick={submitAdd}
          title={inspected === null ? t("detectFirst") : undefined}
        >
          {adding ? t("adding") : t("confirmAdd")}
        </button>
        <button type="button" className="dou-btn" disabled={busy || adding} onClick={toggleAdd}>{t("cancel")}</button>
      </div>
      {inspErr !== null ? <div className="dou-provErr">{inspErr}</div> : null}
      {inspectCard}
      {addMsg !== null ? <div className={addErr ? "dou-provErr" : "dou-hint"}>{addMsg}</div> : null}
    </div>
  );

  return (
    <div className="dou-provItem">
      {/* 折叠头：▸/▾ + provider 名 + 徽标（已启用: <name> / 未启用适配器） */}
      <button
        type="button"
        className="dou-provHead"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`dou-provArrow${open ? " dou-provArrowOpen" : ""}`} aria-hidden="true">▸</span>
        <span className="dou-provName">{item.provider}</span>
        <span className={`dou-provBadge${item.enabledId === null ? " dou-provBadgeOff" : ""}`}>
          {badge}
        </span>
      </button>
      {!open ? null : (
        <div className="dou-provBody">
          {/* 无候选引导：文件注入 + 复制一句话引导指令（v2 文档） */}
          {candidates.length === 0 ? [
            <div key="hint" className="dou-hint">
              {t("noCandidates")}
            </div>,
            <div key="guide" className="dou-provActions">
              <button type="button" className="dou-btn" disabled={busy} onClick={onCopyGuide}>
                {copied ? t("copied") : t("copyGuide")}
              </button>
            </div>,
          ] : adapterRows}
          <div className="dou-provActions">
            <button type="button" className="dou-btn" disabled={busy} onClick={toggleAdd}>
              {showAddForm ? t("collapse") : t("addAdapter")}
            </button>
          </div>
          {!showAddForm ? null : addForm}
        </div>
      )}
    </div>
  );
}

/** 提供商列表区：主列表对齐模型配置页 + 自定义 provider 独立分组。 */
export function ProviderListSection({
  meta,
  main,
  extra,
  busy,
  onSwitch,
  onDisable,
  onInspect,
  onAdd,
}: {
  meta: AdaptersMeta | null;
  main: ProviderListItem[];
  extra: ProviderListItem[];
  busy: boolean;
  onSwitch(provider: string, adapterName: string): void;
  onDisable(provider: string): void;
  onInspect(file: string): Promise<InspectResult>;
  onAdd(provider: string, form: { file: string }): Promise<AddResult>;
}): React.ReactElement {
  // host[] 按 providers 分组为候选映射
  const candidatesByProvider = new Map<string, Array<{ name: string; label: string; source: string; file?: string | null }>>();
  for (const info of meta?.host ?? []) {
    for (const provider of info.providers) {
      const list = candidatesByProvider.get(provider) ?? [];
      list.push({
        name: info.name,
        label: info.label,
        source: info.source,
        ...(info.file !== undefined && info.file !== null ? { file: info.file } : {}),
      });
      candidatesByProvider.set(provider, list);
    }
  }
  const errorByKey = new Map<string, AdapterErrorEntry>();
  for (const e of meta?.errors ?? []) errorByKey.set(e.key, e);
  // 用户文件加载错误无 provider 归属（key=file:<名>），列表顶部全局展示一次
  const fileErrors = [...errorByKey.entries()].filter(([k]) => k.startsWith("file:"));
  // 列表完全为空时的全局引导复制
  const [copiedGlobal, setCopiedGlobal] = React.useState<boolean>(false);
  const globalGuideCommand =
    "请帮我接入一个提供商的用量统计：以你在模型配置中该提供商的 API 端点（baseUrl）为起点，自行确认用量接口与鉴权方式、自主设计适配器方案并先给我审核（含 API 端点），确认后生成 .mjs 文件、告诉保存路径并引导我在「用量统计」设置页完成登记。按用量统计适配器开发引导文档（https://github.com/wingsky-1/dsh-plugin-hub/blob/main/packages/dsh-provider-usage/docs/adapter-guide.md）执行引导流程。";
  const onCopyGlobalGuide = async (): Promise<void> => {
    if (await copyText(globalGuideCommand)) {
      setCopiedGlobal(true);
      setTimeout(() => setCopiedGlobal(false), 2000);
    }
  };

  /** 手风琴渲染复用（主分组与额外分组同构）。 */
  const accordion = (items: ProviderListItem[]): React.ReactElement => (
    <div className="dou-provList">
      {items.map((item) => (
        <ProviderItem
          key={item.provider}
          item={item}
          candidates={candidatesByProvider.get(item.provider) ?? []}
          errorByKey={errorByKey}
          busy={busy}
          onSwitch={onSwitch}
          onDisable={onDisable}
          onInspect={onInspect}
          onAdd={onAdd}
        />
      ))}
    </div>
  );

  return (
    <div style={sectionStyle}>
      <h4 style={titleStyle}>{t("provTitle")}</h4>
      <div className="dou-hint">{t("provListHint", { n: main.length })}</div>
      {fileErrors.length > 0
        ? fileErrors.map(([k, e]) => (
            <div key={k} className="dou-provErr">
              {t("fileLoadFail", { f: k.slice(5), msg: e.message })}
            </div>
          ))
        : null}
      {main.length === 0 ? (
        <div className="dou-hint">
          {t("noProvHint")}
          <div className="dou-provActions">
            <button type="button" className="dou-btn" disabled={busy} onClick={onCopyGlobalGuide}>
              {copiedGlobal ? t("copied") : t("copyGuide")}
            </button>
          </div>
        </div>
      ) : accordion(main)}
      {extra.length > 0 ? (
        <div>
          <h4 style={titleStyle}>{t("customProvTitle")}</h4>
          <div className="dou-hint">{t("customProvHint")}</div>
          {accordion(extra)}
        </div>
      ) : null}
    </div>
  );
}

/** fetchTimeout re-export（保持 index.ts 内 onInspect 实现可用）。 */
export { fetchTimeout };
