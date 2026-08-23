/**
 * dsh-provider-usage — 设置面板独立 tab「用量统计」（v2 数据面 + v1 交互样式）。
 *
 * 经 slots.inject("settings.section") 注册顶层 tab。UI/交互与 v1 保持一致
 * （手风琴提供商列表 + 候选开关 + 内嵌添加表单 + 检测卡片 + 引导指令复制），
 * 仅数据面对接 v2：适配器字段 id→name、select body {provider, adapterName}、
 * 用量可视化展示宿主端渲染的胶囊 HTML。
 */
import * as React from "react";
import { STATS_URL, ADAPTERS_URL, SELECT_URL, INSPECT_URL, ADD_URL, fetchTimeout } from "./core.js";
import { splitProviderList, providerBadgeText } from "../client-logic.js";
import type { ProviderListItem } from "../client-logic.js";

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

const STATUS_LABEL: Record<string, string> = {
  fresh: "实时",
  cached: "缓存",
  stale: "陈旧（已降级）",
};

/** 状态 → 颜色（主题变量 + 浅色回退）。 */
function statusColor(status: string | undefined): string {
  if (status === "stale") return "var(--dsw-alias-state-warn-primary,#c9820b)";
  if (status === "fresh" || status === "cached") return "var(--dsw-alias-state-success-primary,#0f9d6e)";
  return "var(--dsw-alias-state-error-primary,#d64545)";
}

/** 用量可视化区：各启用 provider 的状态点 + 胶囊内容（宿主端渲染 HTML）。 */
function UsageSection({ statsByProvider }: { statsByProvider: Record<string, StatsView | null> }) {
  const providers = Object.keys(statsByProvider);
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, "用量可视化"),
    providers.length === 0
      ? React.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } }, "暂无启用的 provider")
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
          const meta = `${adapterPart}${STATUS_LABEL[s?.status ?? ""] ?? "未配置"}${
            typeof s?.fetchedAt === "number"
              ? ` · 更新于 ${new Date(s.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
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
                    "暂无数据",
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
      else setInspErr(r.detail ?? "检测失败");
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
      setAddMsg(r.detail ?? "添加失败");
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
          `${c.name} · ${c.source === "builtin" ? "内置" : "自定义"}${c.file ? ` · ${c.file}` : ""}`,
        ),
      ),
      React.createElement(
        "label",
        { className: "dou-switchWrap", title: enabled ? "停用该适配器（仅影响用量取数）" : "启用该适配器" },
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
        ? React.createElement("div", { className: "dou-provErr" }, `最近一次错误：${err.message}`)
        : null,
    );
  });

  const inspectCard =
    inspected === null
      ? null
      : React.createElement(
          "div",
          { className: "dou-inspectCard" },
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, "适配器名"), React.createElement("span", { className: "dou-inspectV" }, inspected.name)),
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, "展示名"), React.createElement("span", { className: "dou-inspectV" }, inspected.label)),
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, "归属提供商"), React.createElement("span", { className: "dou-inspectV" }, inspected.providers.join("、") || item.provider)),
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, "契约版本"), React.createElement("span", { className: "dou-inspectV" }, `version ${inspected.version} ✓`)),
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
        "文件路径",
        React.createElement("span", { className: "dou-addOnly" }, "（唯一输入——name/展示名/归属提供商从文件导出自动读取）"),
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
        inspecting ? "检测中…" : "检测文件",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "dou-btn",
          disabled: busy || adding || inspected === null,
          onClick: submitAdd,
          title: inspected === null ? "请先通过「检测文件」后再确认添加" : undefined,
        },
        adding ? "添加中…" : "确认添加",
      ),
      React.createElement("button", { type: "button", className: "dou-btn", disabled: busy || adding, onClick: toggleAdd }, "取消"),
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
        providerBadgeText(item),
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
                  "该提供商暂无候选适配器——可通过下方 [+ 添加适配器] 注入本地适配器文件；也可复制引导指令，让 Agent 帮你创建适配器。",
                ),
                React.createElement(
                  "div",
                  { key: "guide", className: "dou-provActions" },
                  React.createElement(
                    "button",
                    { type: "button", className: "dou-btn", disabled: busy, onClick: onCopyGuide },
                    copied ? "已复制 ✓" : "复制引导指令",
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
              showAddForm ? "收起" : "+ 添加适配器",
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
    React.createElement("h4", { style: titleStyle }, "提供商"),
    React.createElement(
      "div",
      { className: "dou-hint" },
      `提供商列表与模型配置页保持一致（共 ${main.length} 个）；展开某个提供商以切换适配器开关或添加新适配器。`,
    ),
    fileErrors.length > 0
      ? fileErrors.map(([k, e]) =>
          React.createElement(
            "div",
            { key: k, className: "dou-provErr" },
            `用户文件 ${k.slice(5)} 加载失败：${e.message}`,
          ),
        )
      : null,
    main.length === 0
      ? React.createElement(
          "div",
          { className: "dou-hint" },
          "未发现已配置的提供商（adapters.json 不可达或模型配置页尚未配置提供商）。可复制引导指令，让 Agent 帮你接入数据源并创建适配器。",
          React.createElement(
            "div",
            { className: "dou-provActions" },
            React.createElement(
              "button",
              { type: "button", className: "dou-btn", disabled: busy, onClick: onCopyGlobalGuide },
              copiedGlobal ? "已复制 ✓" : "复制引导指令",
            ),
          ),
        )
      : accordion(main),
    extra.length > 0
      ? React.createElement(
          "div",
          null,
          React.createElement("h4", { style: titleStyle }, "自定义提供商"),
          React.createElement(
            "div",
            { className: "dou-hint" },
            "以下 providers 未出现在 dsh 模型配置页（模型暂选不到该提供商，先登记适配器；在模型页补建后即可选用），不计入上方数量。",
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
    React.createElement(UsageSection, { statsByProvider }),
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