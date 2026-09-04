/**
 * dsh-provider-usage — 设置面板独立 tab「用量统计」（v2 数据面 + v1 交互样式）。
 *
 * 经 slots.inject("settings.section") 注册顶层 tab。UI/交互与 v1 保持一致
 * （手风琴提供商列表 + 候选开关 + 内嵌添加表单 + 检测卡片 + 引导指令复制），
 * 仅数据面对接 v2：适配器字段 id→name、select body {provider, adapterName}、
 * 用量可视化展示宿主端渲染的胶囊 HTML。
 */
import * as React from "react";
import { STATS_URL, ADAPTERS_URL, SELECT_URL, INSPECT_URL, ADD_URL, fetchTimeout, fetchUiConfig, saveUiConfig } from "./core.ts";
import type { UiPlacementConfig } from "./core.ts";
import { splitProviderList, providerBadgeText } from "../client-logic.ts";
import type { ProviderListItem } from "../client-logic.ts";
import { t } from "../../../../shared/client/i18n.js";
import type { ProviderUsageLocaleKey } from "./locales.ts";
// #503：设置页顶部「使用趋势」区块（三维切换 + 堆叠柱状 + 汇总卡）
import { TrendSection } from "./trend.ts";

// ---------------------------------------------------------------- 类型

/** 候选条目（adapters.json host[]）。 */
interface AdapterInfo {
  name: string;
  label: string;
  providers: string[];
  source: "builtin" | "user-file";
  file?: string | null;
  enabled?: boolean;
}

/** 错误登记条目（adapters.json errors[]）。 */
interface AdapterErrorEntry {
  key: string;
  at: number;
  kind: string;
  message: string;
}

/** adapters.json 响应形状。 */
interface AdaptersMeta {
  version?: number;
  host?: AdapterInfo[];
  enabled?: Record<string, string>;
  modelProviders?: string[];
  errors?: AdapterErrorEntry[];
}

/** /stats 响应中本页消费的字段（v2）。 */
interface StatsView {
  provider?: string;
  adapterName?: string;
  status?: "fresh" | "cached" | "stale";
  capsuleHtml?: string;
  ok?: boolean;
  configured?: boolean;
  error?: string | null;
  fetchedAt?: number;
}

/** inspect 回显的导出信息（v2：name 字段）。 */
interface InspectAdapter {
  name: string;
  label: string;
  providers: string[];
  version: number;
}

/** inspect 结果（ok=false 时 detail 可回显给用户排障）。 */
interface InspectResult {
  ok: boolean;
  adapter?: InspectAdapter;
  detail?: string;
}

/** add 结果（ok=false 时 detail 可回显给用户排障）。 */
interface AddResult {
  ok: boolean;
  detail?: string;
}

async function jsonGet(url: string): Promise<unknown> {
  const res = await fetchTimeout(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 复制文本到剪贴板（失败静默返回 false）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const sectionStyle: Object = {
  marginBottom: 16,
  padding: "10px 12px",
  border: "1px solid var(--dsw-alias-border-l2,#e8eaf0)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1,#f8f9fb)",
  fontSize: 12,
  lineHeight: 1.7,
};

const titleStyle: Object = {
  fontSize: 13,
  fontWeight: 600,
  margin: "0 0 6px",
};

/** 状态 → 文案（i18n：渲染期求值，t 装配后才可见文案而非 key）。 */
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

/** 胶囊位置配置区：锚点 + 偏移输入，保存即热更新（宿主落盘 + SSE 广播）。
 *  label 存字典 key（i18n：渲染期经 t 求值，模块加载时 t 尚未装配）。 */
const PLACEMENT_OPTIONS: Array<{ value: UiPlacementConfig["placement"]; key: ProviderUsageLocaleKey }> = [
  { value: "top-right", key: "posTopRight" },
  { value: "top-left", key: "posTopLeft" },
  { value: "bottom-right", key: "posBottomRight" },
  { value: "bottom-left", key: "posBottomLeft" },
];

function UiSection() {
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
    React.createElement(
      "div",
      { style: { marginBottom: 8 } },
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

/** 用量可视化区：各启用 provider 的状态点 + 胶囊内容（宿主端渲染 HTML）。 */
function UsageSection({ statsByProvider }: { statsByProvider: Record<string, StatsView | null> }) {
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
    return React.createElement(
      "div",
      { key: c.name, className: `dou-adapterRow${enabled ? " dou-active" : ""}` },
      React.createElement(
        "div",
        { className: "dou-adapterInfo" },
        React.createElement("span", { className: "dou-adapterName" }, c.label),
        React.createElement(
          "span",
          { className: "dou-adapterMeta" },
          `${c.name} · ${c.source === "builtin" ? t("adapterBuiltin") : t("adapterCustom")}${c.file ? ` · ${c.file}` : ""}`,
        ),
      ),
      React.createElement(
        "label",
        { className: "dou-switchWrap", title: enabled ? t("switchOffTitle") : t("switchOnTitle") },
        React.createElement("input", {
          type: "checkbox",
          className: "dou-switch",
          checked: enabled,
          disabled: busy,
          onChange: (e: unknown) => {
            const checked = (e as { target: { checked: boolean } }).target.checked;
            if (checked) onSwitch(item.provider, c.name);
            else onDisable(item.provider);
          },
        }),
        React.createElement("span", { className: "dou-switchTrack", "aria-hidden": "true" }),
      ),
      err !== undefined
        ? React.createElement("div", { className: "dou-provErr" }, t("lastError", { msg: err.message }))
        : null,
    );
  });

  const inspectCard =
    inspected === null
      ? null
      : React.createElement(
          "div",
          { className: "dou-inspectCard" },
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, t("inspectKName")), React.createElement("span", { className: "dou-inspectV" }, inspected.name)),
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, t("inspectKLabel")), React.createElement("span", { className: "dou-inspectV" }, inspected.label)),
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, t("inspectKProviders")), React.createElement("span", { className: "dou-inspectV" }, inspected.providers.join("、") || item.provider)),
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, t("inspectKVersion")), React.createElement("span", { className: "dou-inspectV" }, `version ${inspected.version} ✓`)),
        );

  const addForm = React.createElement(
    "div",
    { className: "dou-addForm" },
    React.createElement(
      "div",
      { className: "dou-addField" },
      React.createElement(
        "span",
        { className: "dou-addLabel" },
        t("filePath"),
        React.createElement("span", { className: "dou-addOnly" }, t("filePathOnly")),
      ),
    ),
    React.createElement("input", {
      className: "dou-input",
      value: file,
      placeholder: "~/.dsh/.../xxx.mjs 或绝对路径",
      maxLength: 1024,
      onChange: (e: unknown) => setFile((e as { target: { value: string } }).target.value),
    }),
    React.createElement(
      "div",
      { className: "dou-provActions" },
      React.createElement(
        "button",
        { type: "button", className: "dou-btn", disabled: busy || inspecting || file.trim() === "", onClick: doInspect },
        inspecting ? t("detecting") : t("detectFile"),
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "dou-btn",
          disabled: busy || adding || inspected === null,
          onClick: submitAdd,
          title: inspected === null ? t("detectFirst") : undefined,
        },
        adding ? t("adding") : t("confirmAdd"),
      ),
      React.createElement("button", { type: "button", className: "dou-btn", disabled: busy || adding, onClick: toggleAdd }, t("cancel")),
    ),
    inspErr !== null ? React.createElement("div", { className: "dou-provErr" }, inspErr) : null,
    inspectCard,
    addMsg !== null
      ? React.createElement("div", { className: addErr ? "dou-provErr" : "dou-hint" }, addMsg)
      : null,
  );

  return React.createElement(
    "div",
    { className: "dou-provItem" },
    // 折叠头：▸/▾ + provider 名 + 徽标（已启用: <name> / 未启用适配器）
    React.createElement(
      "button",
      {
        type: "button",
        className: "dou-provHead",
        onClick: () => setOpen((v) => !v),
        "aria-expanded": open,
      },
      React.createElement("span", { className: `dou-provArrow${open ? " dou-provArrowOpen" : ""}`, "aria-hidden": "true" }, "▸"),
      React.createElement("span", { className: "dou-provName" }, item.provider),
      React.createElement(
        "span",
        { className: `dou-provBadge${item.enabledId === null ? " dou-provBadgeOff" : ""}` },
        badge,
      ),
    ),
    !open
      ? null
      : React.createElement(
          "div",
          { className: "dou-provBody" },
          // 无候选引导：文件注入 + 复制一句话引导指令（v2 文档）
          candidates.length === 0
            ? [
                React.createElement(
                  "div",
                  { key: "hint", className: "dou-hint" },
                  t("noCandidates"),
                ),
                React.createElement(
                  "div",
                  { key: "guide", className: "dou-provActions" },
                  React.createElement(
                    "button",
                    { type: "button", className: "dou-btn", disabled: busy, onClick: onCopyGuide },
                    copied ? t("copied") : t("copyGuide"),
                  ),
                ),
              ]
            : adapterRows,
          React.createElement(
            "div",
            { className: "dou-provActions" },
            React.createElement(
              "button",
              { type: "button", className: "dou-btn", disabled: busy, onClick: toggleAdd },
              showAddForm ? t("collapse") : t("addAdapter"),
            ),
          ),
          !showAddForm ? null : addForm,
        ),
  );
}

/** 提供商列表区：主列表对齐模型配置页 + 自定义 provider 独立分组。 */
function ProviderListSection({
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
}) {
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
  const accordion = (items: ProviderListItem[]): React.ReactElement =>
    React.createElement(
      "div",
      { className: "dou-provList" },
      items.map((item) =>
        React.createElement(ProviderItem, {
          key: item.provider,
          item,
          candidates: candidatesByProvider.get(item.provider) ?? [],
          errorByKey,
          busy,
          onSwitch,
          onDisable,
          onInspect,
          onAdd,
        }),
      ),
    );

  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, t("provTitle")),
    React.createElement(
      "div",
      { className: "dou-hint" },
      t("provListHint", { n: main.length }),
    ),
    fileErrors.length > 0
      ? fileErrors.map(([k, e]) =>
          React.createElement(
            "div",
            { key: k, className: "dou-provErr" },
            t("fileLoadFail", { f: k.slice(5), msg: e.message }),
          ),
        )
      : null,
    main.length === 0
      ? React.createElement(
          "div",
          { className: "dou-hint" },
          t("noProvHint"),
          React.createElement(
            "div",
            { className: "dou-provActions" },
            React.createElement(
              "button",
              { type: "button", className: "dou-btn", disabled: busy, onClick: onCopyGlobalGuide },
              copiedGlobal ? t("copied") : t("copyGuide"),
            ),
          ),
        )
      : accordion(main),
    extra.length > 0
      ? React.createElement(
          "div",
          null,
          React.createElement("h4", { style: titleStyle }, t("customProvTitle")),
          React.createElement(
            "div",
            { className: "dou-hint" },
            t("customProvHint"),
          ),
          accordion(extra),
        )
      : null,
  );
}

/** 设置页根组件：模型配置提供商列表驱动手风琴；用量可视化对启用中的 provider 拉 /stats。 */
export function SettingsPage() {
  const [statsByProvider, setStatsByProvider] = React.useState<Record<string, StatsView | null>>({});
  const [meta, setMeta] = React.useState<AdaptersMeta | null>(null);
  const [list, setList] = React.useState<{ main: ProviderListItem[]; extra: ProviderListItem[] }>({ main: [], extra: [] });
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      const m = (await jsonGet(ADAPTERS_URL).catch(() => null)) as AdaptersMeta | null;
      if (m !== null) {
        setMeta(m);
        // 主列表 = modelProviders（与模型配置页精确一致），额外 provider 收进独立分组
        const grouped: Record<string, Array<{ name: string; label: string; source: string }>> = {};
        for (const info of m.host ?? []) {
          for (const provider of info.providers) {
            (grouped[provider] ??= []).push({ name: info.name, label: info.label, source: info.source });
          }
        }
        setList(
          splitProviderList({
            candidatesByProvider: grouped,
            enabled: m.enabled,
            modelProviders: m.modelProviders ?? [],
          }),
        );
      }
      // 用量可视化：仅对运行时启用的 provider 并行拉 /stats
      const providers = Object.keys(m?.enabled ?? {});
      const pairs = await Promise.all(
        providers.map(async (provider) => {
          const s = (await jsonGet(`${STATS_URL}?provider=${encodeURIComponent(provider)}`).catch(
            () => null,
          )) as StatsView | null;
          return [provider, s] as const;
        }),
      );
      setStatsByProvider(Object.fromEntries(pairs));
    } catch {
      /* 面板数据拉取失败静默（保留旧值） */
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  /** 统一包装：请求期间置 busy，完成后刷新面板数据。 */
  function mutate(action: () => Promise<unknown>): void {
    setBusy(true);
    action()
      .catch(() => {})
      .then(() => reload())
      .finally(() => setBusy(false));
  }

  const onSwitch = React.useCallback(
    (provider: string, adapterName: string): void => {
      mutate(() =>
        fetchTimeout(SELECT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, adapterName }),
        }),
      );
    },
    [reload],
  );

  // 关闭开关 = select 清空该 provider 启用项（停用该 provider 的用量取数）
  const onDisable = React.useCallback(
    (provider: string): void => {
      mutate(() =>
        fetchTimeout(SELECT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, adapterName: null }),
        }),
      );
    },
    [reload],
  );

  /** 检测文件：仅回显导出信息，不登记。 */
  const onInspect = React.useCallback(async (file: string): Promise<InspectResult> => {
    try {
      const res = await fetchTimeout(INSPECT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; adapter?: InspectAdapter; error?: string; detail?: string };
      if (!res.ok) {
        return { ok: false, detail: body.detail ?? body.error ?? `HTTP ${res.status}` };
      }
      return { ok: true, adapter: body.adapter };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }, []);

  /** 登记适配器：仅 file（身份以导出为准），add 路由热注册并持久化。 */
  const onAdd = React.useCallback(
    async (_provider: string, form: { file: string }): Promise<AddResult> => {
      try {
        const res = await fetchTimeout(ADD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: form.file }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
        if (!res.ok) {
          return { ok: false, detail: body.detail ?? body.error ?? `HTTP ${res.status}` };
        }
        await reload();
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
    [reload],
  );

  return React.createElement(
    "div",
    { className: "dou-settings", style: { maxWidth: 560 } },
    // #503：使用趋势区块置顶（三维切换 + 堆叠柱状 + 汇总卡），原有三节行为不变
    React.createElement(TrendSection),
    React.createElement(UsageSection, { statsByProvider }),
    React.createElement(UiSection),
    React.createElement(ProviderListSection, {
      meta,
      main: list.main,
      extra: list.extra,
      busy,
      onSwitch,
      onDisable,
      onInspect,
      onAdd,
    }),
  );
}