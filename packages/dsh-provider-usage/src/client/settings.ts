/**
 * dsh-provider-usage — 设置面板独立 tab「用量统计」（M3b，issue #38 重构；v2 交互收敛）。
 *
 * 经 slots.inject("settings.section") 注册顶层 tab，React 渲染两区：
 * - 提供商列表（主区）：与 dsh 模型配置页提供商列表精确一致（adapters.json
 *   modelProviders = ctx.llm.listProviders() 注册路由）；每个提供商展开后展示
 *   适配器候选行，**每行独立开关**（唯一启用，开启一个自动关掉上一个；关闭当前
 *   启用者 = 停用该 provider 的用量取数，不影响模型配置页的提供商可用性）。
 *   [+ 添加适配器] 内嵌于对应提供商：仅输入文件路径，检测（inspect 路由）回显
 *   导出信息后确认添加（add 路由，身份以导出为准）。
 * - 用量可视化：summary 文案 + 各窗口明细表（保留）。
 *
 * 数据面：全部走宿主 loopback 路由（/stats、/adapters.json、POST /adapters/select、
 * POST /adapters/inspect、POST /adapters/add），不引入额外 RPC 通道。
 */
import * as React from "react";
import { STATS_URL, ADAPTERS_URL, SELECT_URL, INSPECT_URL, ADD_URL } from "./core.js";
import { splitProviderList, providerBadgeText } from "../client-logic.js";
import type { ProviderListItem } from "../client-logic.js";

/** 候选条目（adapters.json host[]）。 */
interface AdapterInfo {
  id: string;
  label: string;
  providers: string[];
  source: "builtin" | "user-file";
  file?: string | null;
  enabled?: boolean;
}

/** 错误登记条目（adapters.json errors[]，issue #38）。 */
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
  /** 模型配置页提供商路由（与 dsh 设置「模型」页同源，主列表权威清单）。 */
  modelProviders?: string[];
  errors?: AdapterErrorEntry[];
}

/** /stats 响应中本页消费的字段。 */
interface StatsView {
  provider?: string;
  label?: string;
  adapterId?: string | null;
  hasAdapter?: boolean;
  summary?: { text?: string; level?: string; hint?: string } | null;
  usage?: { ok?: boolean; error?: string | null; windows?: Array<{ key: string; name: string; percent: number | null; limit?: number; resetsAt?: string }> } | null;
}

/** inspect 回显的导出信息（以模块导出为准）。 */
interface InspectAdapter {
  id: string;
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
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 复制文本到剪贴板（设置页「复制引导指令」用；失败静默返回 false）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 状态等级 → 颜色（主题变量 + 浅色回退）。 */
function levelColor(level: string | undefined): string {
  if (level === "err") return "var(--dsw-alias-state-error-primary,#d64545)";
  if (level === "warn") return "var(--dsw-alias-state-warn-primary,#c9820b)";
  if (level === "ok") return "var(--dsw-alias-state-success-primary,#0f9d6e)";
  return "var(--dsw-alias-label-tertiary,#9aa0ab)";
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

/** 用量可视化区：各 provider 一张窗口明细表。 */
function UsageSection({ statsByProvider }: { statsByProvider: Record<string, StatsView | null> }) {
  const providers = Object.keys(statsByProvider);
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, "用量可视化"),
    providers.length === 0
      ? React.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } }, "暂无窗口数据")
      : providers.map((provider) => {
          const windows = statsByProvider[provider]?.usage?.windows ?? [];
          return React.createElement(
            "div",
            { key: provider, style: { marginBottom: 10 } },
            React.createElement("div", { style: { fontWeight: 600 } }, provider),
            windows.length === 0
              ? React.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } }, "暂无窗口数据")
              : React.createElement(
                  "table",
                  { style: { width: "100%", borderCollapse: "collapse" } },
                  React.createElement(
                    "thead",
                    null,
                    React.createElement(
                      "tr",
                      null,
                      ["窗口", "当前", "限额", "重置"].map((h) =>
                        React.createElement("th", { key: h, style: { textAlign: "left", padding: "2px 6px" } }, h),
                      ),
                    ),
                  ),
                  React.createElement(
                    "tbody",
                    null,
                    windows.map((w) =>
                      React.createElement(
                        "tr",
                        { key: w.key },
                        React.createElement("td", { style: { padding: "2px 6px" } }, w.name),
                        React.createElement("td", { style: { padding: "2px 6px", color: levelColor(typeof w.percent === "number" && w.percent >= 80 ? (w.percent >= 95 ? "err" : "warn") : "ok") } }, typeof w.percent === "number" ? `${w.percent}%` : "--"),
                        React.createElement("td", { style: { padding: "2px 6px" } }, w.limit !== undefined ? String(w.limit) : "-"),
                        React.createElement("td", { style: { padding: "2px 6px" } }, w.resetsAt ?? "-"),
                      ),
                    ),
                  ),
                ),
          );
        }),
  );
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
  candidates: Array<{ id: string; label: string; source: string }>;
  errorByKey: Map<string, AdapterErrorEntry>;
  busy: boolean;
  onSwitch(provider: string, adapterId: string): void;
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

  /** 一句话引导指令：无候选时复制到会话，agent 按 9-agent-guide-mjs.md 自主引导。 */
  const guideCommand = `请为提供商 ${item.provider} 创建用量统计适配器：以该提供商在模型配置中的 API 端点（baseUrl）为起点，自行确认用量接口与鉴权方式，自主设计适配器方案（id/展示名/窗口字段），先给我审核方案（含 API 端点），确认后生成 .mjs 文件、告诉保存路径并引导我在「用量统计」设置页添加适配器。`;
  const onCopyGuide = async (): Promise<void> => {
    if (await copyText(guideCommand)) {
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

  /** 确认添加：仅 file（身份以导出为准），add 路由热注册。 */
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
    const err = errorByKey.get(c.id);
    const enabled = c.id === item.enabledId;
    return React.createElement(
      "div",
      { key: c.id, className: `dou-adapterRow${enabled ? " dou-active" : ""}` },
      React.createElement(
        "div",
        { className: "dou-adapterInfo" },
        React.createElement("span", { className: "dou-adapterName" }, c.label),
        React.createElement("span", { className: "dou-adapterMeta" }, `${c.id} · ${c.source === "builtin" ? "内置" : "自定义"}`),
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
            if (checked) onSwitch(item.provider, c.id);
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
          React.createElement("div", { className: "dou-inspectRow" }, React.createElement("span", { className: "dou-inspectK" }, "适配器 ID"), React.createElement("span", { className: "dou-inspectV" }, inspected.id)),
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
        React.createElement("span", { className: "dou-addOnly" }, "（唯一输入——id/展示名/归属提供商从文件导出自动读取）"),
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
        { type: "button", className: "dou-btn", disabled: busy || adding || inspected === null, onClick: submitAdd },
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
    // 折叠头：▸/▾ + provider 名 + 徽标（已启用: <adapter-id> / 未启用适配器）
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
          // 无候选引导（已知清单里的 provider 尚无任何适配器）：文件注入 + 复制一句话引导指令
          candidates.length === 0
            ? [
                React.createElement(
                  "div",
                  { key: "hint", className: "dou-hint" },
                  "该提供商暂无候选适配器——可通过下方 [+ 添加适配器] 注入本地适配器文件，或在 cordis.patch.yml 的 adapters.host 中配置；也可复制引导指令，让 Agent 帮你创建适配器。",
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
  onSwitch(provider: string, adapterId: string): void;
  onDisable(provider: string): void;
  onInspect(file: string): Promise<InspectResult>;
  onAdd(provider: string, form: { file: string }): Promise<AddResult>;
}) {
  // host[] 按 providers 分组为候选映射
  const candidatesByProvider = new Map<string, Array<{ id: string; label: string; source: string }>>();
  for (const info of meta?.host ?? []) {
    for (const provider of info.providers) {
      const list = candidatesByProvider.get(provider) ?? [];
      list.push({ id: info.id, label: info.label, source: info.source });
      candidatesByProvider.set(provider, list);
    }
  }
  const errorByKey = new Map<string, AdapterErrorEntry>();
  for (const e of meta?.errors ?? []) errorByKey.set(e.key, e);
  // 用户文件加载失败错误无 provider 归属（登记 key=file:<名>），在列表顶部全局展示一次
  const fileErrors = [...errorByKey.entries()].filter(([k]) => k.startsWith("file:"));
  // 列表完全为空（adapters.json 不可达或模型配置无 provider）时的全局引导复制
  const [copiedGlobal, setCopiedGlobal] = React.useState<boolean>(false);
  const globalGuideCommand =
    "请帮我接入一个提供商的用量统计：以你在模型配置中该提供商的 API 端点（baseUrl）为起点，自行确认用量接口与鉴权方式、自主设计适配器方案并先给我审核（含 API 端点），确认后生成 .mjs 文件、告诉保存路径并引导我在「用量统计」设置页完成登记。";
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
    // 尾部独立分组：候选/启用态指向不在模型配置中的 provider（用户适配器自定义路由，
    // 避免静默消失，不计入主列表数量；模型页补建该提供商后自动并入主列表）
    extra.length > 0
      ? React.createElement(
          "div",
          null,
          React.createElement(
            "h4",
            { style: titleStyle },
            "自定义提供商",
          ),
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
        const grouped: Record<string, Array<{ id: string; label: string; source: string }>> = {};
        for (const info of m.host ?? []) {
          for (const provider of info.providers) {
            (grouped[provider] ??= []).push({ id: info.id, label: info.label, source: info.source });
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
    (provider: string, adapterId: string): void => {
      mutate(() =>
        fetch(SELECT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, adapterId }),
        }),
      );
    },
    [reload],
  );

  // 关闭开关 = select 清空该 provider 启用项（停用该 provider 的用量取数）
  const onDisable = React.useCallback(
    (provider: string): void => {
      mutate(() =>
        fetch(SELECT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, adapterId: null }),
        }),
      );
    },
    [reload],
  );

  /** 检测文件：仅回显导出信息，不登记。 */
  const onInspect = React.useCallback(async (file: string): Promise<InspectResult> => {
    try {
      const res = await fetch(INSPECT_URL, {
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

  /** 登记适配器：仅 file（身份以导出为准），热注册生效。 */
  const onAdd = React.useCallback(
    async (_provider: string, form: { file: string }): Promise<AddResult> => {
      try {
        const res = await fetch(ADD_URL, {
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