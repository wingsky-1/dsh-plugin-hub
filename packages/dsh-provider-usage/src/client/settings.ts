/**
 * dsh-provider-usage — 设置面板独立 tab「用量统计」（v2 适配器管理版）。
 *
 * 经 slots.inject("settings.section") 注册顶层 tab，React 渲染：
 * - 运行状态：各启用 provider 的胶囊内容 + 数据状态（/stats、/health）
 * - 适配器管理（主区）：提供商 → 适配器候选行（每行独立开关，唯一启用）；
 *   [+ 添加适配器] 输入文件路径 → 检测（inspect）回显导出信息 → 确认添加（add）
 * - 最近错误登记展示
 *
 * 承载原则：用户不在 cordis.patch.yml 手改适配器配置，全部经此界面管理
 * （add 持久化到 user-adapters.json，select 持久化到 adapter-state.json）。
 */
import * as React from "react";
import { STATS_URL, HEALTH_URL, ADAPTERS_URL, SELECT_URL, INSPECT_URL, ADD_URL, fetchTimeout } from "./core.js";

// ---------------------------------------------------------------- 类型

interface HealthView {
  ok?: boolean;
  provider?: string;
  adapterName?: string;
  adapters?: Array<{ name: string; label: string; source: string; enabled: boolean }>;
  errors?: Array<{ key: string; at: number; kind: string; message: string }>;
}

interface StatsView {
  provider?: string;
  adapterName?: string;
  status?: "fresh" | "cached" | "stale";
  capsuleHtml?: string;
  ok?: boolean;
  configured?: boolean;
  error?: string | null;
}

/** adapters.json 响应形状。 */
interface AdaptersMeta {
  version?: number;
  host?: AdapterInfo[];
  enabled?: Record<string, string>;
  modelProviders?: string[];
  errors?: AdapterErrorEntry[];
}

interface AdapterInfo {
  name: string;
  label: string;
  providers: string[];
  source: "builtin" | "user-file";
  file?: string | null;
  enabled?: boolean;
}

interface AdapterErrorEntry {
  key: string;
  at: number;
  kind: string;
  message: string;
}

/** inspect 回显的导出信息。 */
interface InspectAdapter {
  name: string;
  label: string;
  providers: string[];
  version: number;
}

interface InspectResult {
  ok: boolean;
  adapter?: InspectAdapter;
  detail?: string;
}

interface AddResult {
  ok: boolean;
  detail?: string;
}

// ---------------------------------------------------------------- 工具

async function jsonGet(url: string): Promise<unknown> {
  const res = await fetchTimeout(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 状态等级 → 颜色（主题变量 + 浅色回退）。 */
function statusColor(status: string | undefined): string {
  if (status === "stale") return "var(--dsw-alias-state-warn-primary,#c9820b)";
  if (status === "fresh" || status === "cached") return "var(--dsw-alias-state-success-primary,#0f9d6e)";
  return "var(--dsw-alias-state-error-primary,#d64545)";
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

const rowStyle: Object = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 0",
};

const STATUS_LABEL: Record<string, string> = {
  fresh: "实时",
  cached: "缓存",
  stale: "陈旧（已降级）",
};

// ---------------------------------------------------------------- 运行状态区

function StatusSection({ statsByProvider }: { statsByProvider: Record<string, StatsView | null> }) {
  const providers = Object.keys(statsByProvider);
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("p", { style: titleStyle }, "运行状态"),
    providers.length === 0
      ? React.createElement("div", null, "暂无启用的 provider 数据。")
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
            },
          });
          return React.createElement(
            "div",
            { key: provider, style: { marginBottom: 8 } },
            React.createElement(
              "div",
              null,
              dot,
              React.createElement("strong", null, provider),
              React.createElement(
                "span",
                { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)", marginLeft: 8 } },
                `（${s?.adapterName ?? "-"} · ${STATUS_LABEL[s?.status ?? ""] ?? "未配置"}）`,
              ),
            ),
            s?.capsuleHtml
              ? React.createElement("div", {
                  style: { marginTop: 4 },
                  dangerouslySetInnerHTML: { __html: s.capsuleHtml },
                })
              : null,
            s?.error
              ? React.createElement(
                  "div",
                  { style: { color: "var(--dsw-alias-state-error-primary,#d64545)", marginTop: 2 } },
                  String(s.error),
                )
              : null,
          );
        }),
  );
}

// ---------------------------------------------------------------- 适配器管理区

/** 提供商内嵌组：候选行（开关）+ 添加表单。 */
function ProviderGroup({
  provider,
  candidates,
  enabledName,
  busy,
  onSwitch,
  onDisable,
  onInspect,
  onAdd,
}: {
  provider: string;
  candidates: AdapterInfo[];
  enabledName: string | undefined;
  busy: boolean;
  onSwitch: (provider: string, name: string) => void;
  onDisable: (provider: string) => void;
  onInspect: (file: string) => Promise<InspectResult>;
  onAdd: (provider: string, form: { file: string }) => Promise<AddResult>;
}) {
  const [adding, setAdding] = React.useState(false);
  const [file, setFile] = React.useState("");
  const [inspect, setInspect] = React.useState<InspectResult | null>(null);
  const [addMsg, setAddMsg] = React.useState<string | null>(null);

  const doInspect = async (): Promise<void> => {
    if (file.trim() === "") return;
    const r = await onInspect(file.trim());
    setInspect(r);
    setAddMsg(null);
  };

  const doAdd = async (): Promise<void> => {
    const r = await onAdd(provider, { file: file.trim() });
    setAddMsg(r.ok ? "已添加并启用 ✓" : `添加失败：${r.detail ?? "未知错误"}`);
    if (r.ok) {
      setAdding(false);
      setFile("");
      setInspect(null);
    }
  };

  return React.createElement(
    "div",
    { style: { marginBottom: 10 } },
    React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, provider),
    candidates.length === 0
      ? React.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } }, "该提供商暂无适配器候选。")
      : candidates.map((c) =>
          React.createElement(
            "div",
            { key: `${provider}/${c.name}`, style: rowStyle },
            React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, flex: 1 } },
              React.createElement("input", {
                type: "checkbox",
                checked: enabledName === c.name,
                disabled: busy,
                onChange: () => {
                  if (enabledName === c.name) onDisable(provider);
                  else onSwitch(provider, c.name);
                },
              }),
              React.createElement("span", null, c.label),
              React.createElement(
                "span",
                { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)", fontSize: 11 } },
                `（${c.name}${c.source === "user-file" ? ` · ${c.file ?? ""}` : " · 内置"}）`,
              ),
            ),
          ),
        ),
    !adding
      ? React.createElement(
          "button",
          { type: "button", onClick: () => setAdding(true), style: { marginTop: 4 } },
          "+ 添加适配器",
        )
      : React.createElement(
          "div",
          { style: { marginTop: 6, border: "1px solid var(--dsw-alias-border-l1,#eef0f4)", borderRadius: 6, padding: 8, background: "var(--dsw-alias-bg-layer-2,#ffffff)" } },
          React.createElement("div", null, "适配器文件路径（支持 ~ 展开 / 绝对路径）："),
          React.createElement("input", {
            type: "text",
            value: file,
            onChange: (e: { target: { value: string } }) => setFile(e.target.value),
            placeholder: "~/.dsh/adapters/my-stats.mjs",
            style: { width: "100%", boxSizing: "border-box" as const, marginTop: 4 },
          }),
          React.createElement(
            "div",
            { style: { marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" as const } },
            React.createElement("button", { type: "button", onClick: () => { void doInspect(); }, disabled: busy || file.trim() === "" }, "检测文件"),
            file.trim() !== "" && inspect?.ok
              ? React.createElement("button", { type: "button", onClick: () => { void doAdd(); }, disabled: busy }, "确认添加")
              : null,
            React.createElement("button", { type: "button", onClick: () => { setAdding(false); setInspect(null); setAddMsg(null); } }, "取消"),
          ),
          inspect !== null
            ? React.createElement(
                "div",
                { style: { marginTop: 6, fontSize: 11, color: inspect.ok ? "var(--dsw-alias-state-success-primary,#0f9d6e)" : "var(--dsw-alias-state-error-primary,#d64545)" } },
                inspect.ok
                  ? `检测通过：${inspect.adapter?.label}（${inspect.adapter?.name} · providers: ${inspect.adapter?.providers.join(", ")}）`
                  : `检测失败：${inspect.detail ?? "未知错误"}`,
              )
            : null,
          addMsg !== null
            ? React.createElement("div", { style: { marginTop: 6, fontSize: 11, color: addMsg.startsWith("已添加") ? "var(--dsw-alias-state-success-primary,#0f9d6e)" : "var(--dsw-alias-state-error-primary,#d64545)" } }, addMsg)
            : null,
        ),
  );
}

function AdaptersSection({
  meta,
  busy,
  onSwitch,
  onDisable,
  onInspect,
  onAdd,
}: {
  meta: AdaptersMeta | null;
  busy: boolean;
  onSwitch: (provider: string, name: string) => void;
  onDisable: (provider: string) => void;
  onInspect: (file: string) => Promise<InspectResult>;
  onAdd: (provider: string, form: { file: string }) => Promise<AddResult>;
}) {
  const host = meta?.host ?? [];
  const enabled = meta?.enabled ?? {};
  // 主列表 = modelProviders；额外 provider 收进独立分组
  const modelProviders = meta?.modelProviders ?? [];
  const providerNames = [
    ...modelProviders,
    ...host.flatMap((h) => h.providers).filter((p) => !modelProviders.includes(p)),
  ];
  const seen = new Set<string>();
  const uniqueProviders = providerNames.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

  const errors = meta?.errors ?? [];

  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("p", { style: titleStyle }, "适配器管理"),
    uniqueProviders.length === 0
      ? React.createElement("div", null, "暂无提供商。")
      : uniqueProviders.map((provider) => {
          const candidates = host.filter((h) => h.providers.includes(provider));
          return React.createElement(ProviderGroup, {
            key: provider,
            provider,
            candidates,
            enabledName: enabled[provider],
            busy,
            onSwitch,
            onDisable,
            onInspect,
            onAdd,
          });
        }),
    errors.length > 0
      ? React.createElement(
          "div",
          { style: { marginTop: 10, color: "var(--dsw-alias-state-error-primary,#d64545)" } },
          "最近错误：",
          ...errors.slice(-3).map((e, i) =>
            React.createElement("div", { key: i, style: { fontSize: 11 } }, `[${e.kind}] ${e.key}: ${e.message}`),
          ),
        )
      : React.createElement(
          "div",
          { style: { marginTop: 10, fontSize: 11, color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } },
          "适配器经此界面添加/切换后自动持久化，无需手动编辑配置文件。内置 opencode-go 默认启用。",
        ),
  );
}

// ---------------------------------------------------------------- 主组件

export function SettingsPage() {
  const [meta, setMeta] = React.useState<AdaptersMeta | null>(null);
  const [statsByProvider, setStatsByProvider] = React.useState<Record<string, StatsView | null>>({});
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      const m = (await jsonGet(ADAPTERS_URL).catch(() => null)) as AdaptersMeta | null;
      if (m !== null) setMeta(m);
      // 对启用中的 provider 拉 /stats
      const providers = Object.keys(m?.enabled ?? {});
      const pairs = await Promise.all(
        providers.map(async (provider) => {
          const s = (await jsonGet(`${STATS_URL}?provider=${encodeURIComponent(provider)}`).catch(() => null)) as StatsView | null;
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

  /** 登记适配器：仅 file（身份以导出为准），热注册生效并持久化。 */
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
    React.createElement(StatusSection, { statsByProvider }),
    React.createElement(AdaptersSection, { meta, busy, onSwitch, onDisable, onInspect, onAdd }),
  );
}