/**
 * dsh-provider-usage — 设置面板独立 tab「用量统计」（M3b，issue #38 重构）。
 *
 * 经 slots.inject("settings.section") 注册顶层 tab，React 渲染四区：
 * - 总览：当前生效适配器逐 provider 摘要（enabled 映射驱动，保留）
 * - 用量可视化：summary 文案 + 各窗口明细表（保留）
 * - 提供商列表（替代原「适配器管理」平铺区块）：全集 = 已注册候选 ∪ 运行时
 *   启用 ∪ 内置已知清单（无候选也展示并给引导）；折叠态徽标显示
 *   「启用中: <adapter-id>」，展开页内管理候选适配器（名称/来源/启用开关单选）、
 *   [禁用该提供商]、[+ 添加适配器]（本地文件路径登记并热注册）
 * - 配置：常用配置键展示（patch 层为单一事实源，此处只读）
 *
 * 数据面：全部走宿主 loopback 路由（/stats、/adapters.json、POST /adapters/select、
 * POST /adapters/add），不引入额外 RPC 通道。
 */
import * as React from "react";
import { STATS_URL, ADAPTERS_URL, SELECT_URL, ADD_URL } from "./core.js";
import { unionProviders, providerBadgeText } from "../client-logic.js";
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
  knownProviders?: string[];
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

/** 添加适配器表单值。 */
interface AddFormValue {
  id: string;
  label: string;
  file: string;
}

async function jsonGet(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

/** 总览区：按 provider 逐行展示当前生效适配器 + summary 文案（enabled 映射驱动）。 */
function OverviewSection({ statsByProvider }: { statsByProvider: Record<string, StatsView | null> }) {
  const providers = Object.keys(statsByProvider);
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, "总览"),
    providers.length === 0
      ? React.createElement(
          "div",
          { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } },
          "暂无已启用的 provider（adapters.json enabled 映射为空）。",
        )
      : providers.map((provider) => {
          const stats = statsByProvider[provider];
          const label = stats?.label ?? provider;
          const adapter = stats?.adapterId ?? null;
          return React.createElement(
            "div",
            { key: provider, style: { marginBottom: 6 } },
            React.createElement(
              "div",
              null,
              `${provider} · 生效适配器：${adapter ?? "无"}`,
            ),
            React.createElement(
              "div",
              { style: { color: levelColor(stats?.summary?.level) } },
              stats?.summary?.text ? `${label}：${stats.summary.text}` : `${label}：暂无数据`,
            ),
            !stats?.hasAdapter
              ? React.createElement(
                  "div",
                  { style: { color: "var(--dsw-alias-state-error-primary,#d64545)" } },
                  "该提供商暂无启用的适配器——请在下方提供商列表中展开并启用。",
                )
              : null,
          );
        }),
  );
}

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

/** 单个提供商手风琴项：折叠头（徽标）+ 展开管理区（候选单选/禁用/添加）。 */
function ProviderItem({
  item,
  candidates,
  errorByKey,
  busy,
  onSwitch,
  onDisable,
  onAdd,
}: {
  item: ProviderListItem;
  candidates: Array<{ id: string; label: string; source: string }>;
  errorByKey: Map<string, AdapterErrorEntry>;
  busy: boolean;
  onSwitch(provider: string, adapterId: string): void;
  onDisable(provider: string): void;
  onAdd(provider: string, form: AddFormValue): Promise<{ ok: boolean; detail?: string }>;
}) {
  const [open, setOpen] = React.useState<boolean>(false);
  const [showAddForm, setShowAddForm] = React.useState<boolean>(false);
  const [form, setForm] = React.useState<AddFormValue>({ id: "", label: "", file: "" });
  const [addMsg, setAddMsg] = React.useState<string | null>(null);
  const [addErr, setAddErr] = React.useState<boolean>(false);
  const [adding, setAdding] = React.useState<boolean>(false);

  const submitAdd = (): void => {
    if (form.id.trim() === "" || form.label.trim() === "" || form.file.trim() === "" || busy || adding) return;
    setAdding(true);
    onAdd(item.provider, { id: form.id.trim(), label: form.label.trim(), file: form.file.trim() })
      .then((r) => {
        if (r.ok) {
          setForm({ id: "", label: "", file: "" });
          setShowAddForm(false);
          setAddErr(false);
          setAddMsg(null);
        } else {
          setAddErr(true);
          setAddMsg(r.detail ?? "添加失败");
        }
      })
      .catch(() => {
        setAddErr(true);
        setAddMsg("添加失败（网络错误）");
      })
      .finally(() => setAdding(false));
  };

  return React.createElement(
    "div",
    { className: "dou-provItem" },
    // 折叠头：▸/▾ + provider 名 + 徽标（启用中: <adapter-id> / 未启用）
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
          // 无候选引导（已知清单里的 provider 尚无任何适配器）
          candidates.length === 0
            ? React.createElement(
                "div",
                { className: "dou-hint" },
                "该提供商暂无候选适配器——可通过下方 [+ 添加适配器] 注入本地适配器文件，或在 cordis.patch.yml 的 adapters.host 中配置。",
              )
            : candidates.map((c) => {
                const err = errorByKey.get(c.id);
                return React.createElement(
                  "div",
                  { key: c.id },
                  React.createElement(
                    "label",
                    { className: "dou-radioRow" },
                    React.createElement("input", {
                      type: "radio",
                      name: `dou-adm-${item.provider}`,
                      checked: c.id === item.enabledId,
                      disabled: busy,
                      onChange: () => onSwitch(item.provider, c.id),
                    }),
                    React.createElement(
                      "span",
                      null,
                      `${c.label}（${c.id}${c.source === "builtin" ? " · 内置" : " · 自定义"}）`,
                    ),
                  ),
                  err !== undefined
                    ? React.createElement("div", { className: "dou-provErr" }, `最近一次错误：${err.message}`)
                    : null,
                );
              }),
          // 操作行：禁用该提供商 / + 添加适配器
          React.createElement(
            "div",
            { className: "dou-provActions" },
            React.createElement(
              "button",
              {
                type: "button",
                className: "dou-btn",
                disabled: busy || item.enabledId === null,
                onClick: () => onDisable(item.provider),
              },
              "禁用该提供商",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dou-btn",
                disabled: busy,
                onClick: () => {
                  setShowAddForm((v) => !v);
                  setAddMsg(null);
                },
              },
              "+ 添加适配器",
            ),
          ),
          // 添加表单（本期仅文件路径注入；粘贴 JS 落盘后续再加）
          !showAddForm
            ? null
            : React.createElement(
                "div",
                { className: "dou-addForm" },
                React.createElement(
                  "div",
                  { className: "dou-addField" },
                  React.createElement("span", { className: "dou-addLabel" }, "适配器 ID"),
                  React.createElement("input", {
                    className: "dou-input",
                    value: form.id,
                    maxLength: 128,
                    placeholder: "须与模块导出 id 一致",
                    onChange: (e: unknown) => setForm((f) => ({ ...f, id: (e as { target: { value: string } }).target.value })),
                  }),
                ),
                React.createElement(
                  "div",
                  { className: "dou-addField" },
                  React.createElement("span", { className: "dou-addLabel" }, "展示名"),
                  React.createElement("input", {
                    className: "dou-input",
                    value: form.label,
                    maxLength: 128,
                    placeholder: "如 My Relay 官方",
                    onChange: (e: unknown) => setForm((f) => ({ ...f, label: (e as { target: { value: string } }).target.value })),
                  }),
                ),
                React.createElement(
                  "div",
                  { className: "dou-addField" },
                  React.createElement("span", { className: "dou-addLabel" }, "文件路径"),
                  React.createElement("input", {
                    className: "dou-input",
                    value: form.file,
                    placeholder: "~/.dsh/plugins/provider-usage/my-relay.mjs 或绝对路径",
                    onChange: (e: unknown) => setForm((f) => ({ ...f, file: (e as { target: { value: string } }).target.value })),
                  }),
                ),
                React.createElement(
                  "div",
                  { className: "dou-addField" },
                  React.createElement("span", { className: "dou-addLabel" }, "归属提供商"),
                  React.createElement("span", null, item.provider),
                ),
                addMsg !== null
                  ? React.createElement("div", { className: addErr ? "dou-provErr" : "dou-hint" }, addMsg)
                  : null,
                React.createElement(
                  "button",
                  { type: "button", className: "dou-btn", disabled: busy || adding, onClick: submitAdd },
                  adding ? "添加中…" : "确认添加",
                ),
              ),
        ),
  );
}

/** 提供商列表区（issue #38）：全集合并 + 手风琴展开管理。 */
function ProviderListSection({
  meta,
  items,
  busy,
  onSwitch,
  onDisable,
  onAdd,
}: {
  meta: AdaptersMeta | null;
  items: ProviderListItem[];
  busy: boolean;
  onSwitch(provider: string, adapterId: string): void;
  onDisable(provider: string): void;
  onAdd(provider: string, form: AddFormValue): Promise<{ ok: boolean; detail?: string }>;
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

  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, "提供商"),
    React.createElement(
      "div",
      { className: "dou-hint" },
      "提供商全集 = 已注册适配器 ∪ 运行时识别 ∪ 内置已知清单；展开某个提供商以切换/禁用其适配器或添加新适配器。",
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
    items.length === 0
      ? React.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } }, "无提供商数据（adapters.json 不可达）")
      : React.createElement(
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
              onAdd,
            }),
          ),
        ),
  );
}

/** 配置区：常用键只读展示（patch 层为单一事实源）。 */
function ConfigSection() {
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, "配置"),
    React.createElement(
      "div",
      { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } },
      "baseUrl / timeoutMs / cacheTtlMs / maxAgeDays / sampleIntervalMs / stripSecrets / adapters 等键经 cordis.patch.yml（用户 patch 层）配置；修改后重启 dsh web 生效。",
    ),
  );
}

/** 设置页根组件：提供商全集驱动手风琴；总览/可视化仅对启用中的 provider 拉 /stats。 */
export function SettingsPage() {
  const [statsByProvider, setStatsByProvider] = React.useState<Record<string, StatsView | null>>({});
  const [meta, setMeta] = React.useState<AdaptersMeta | null>(null);
  const [items, setItems] = React.useState<ProviderListItem[]>([]);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      const m = (await jsonGet(ADAPTERS_URL).catch(() => null)) as AdaptersMeta | null;
      if (m !== null) {
        setMeta(m);
        // issue #38：提供商全集 = 已注册候选 ∪ 运行时启用 ∪ 内置已知清单
        const grouped: Record<string, Array<{ id: string; label: string; source: string }>> = {};
        for (const info of m.host ?? []) {
          for (const provider of info.providers) {
            (grouped[provider] ??= []).push({ id: info.id, label: info.label, source: info.source });
          }
        }
        setItems(
          unionProviders({
            candidatesByProvider: grouped,
            enabled: m.enabled,
            known: m.knownProviders ?? [],
          }),
        );
      }
      // 总览/可视化：仅对运行时启用的 provider 并行拉 /stats
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

  // issue #38：「禁用该提供商」= select 清空该 provider 启用项（adapterId: null）
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

  // issue #38：「+ 添加适配器」= adapters/add 登记本地文件并热注册
  const onAdd = React.useCallback(
    async (provider: string, form: AddFormValue): Promise<{ ok: boolean; detail?: string }> => {
      try {
        const res = await fetch(ADD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: form.id, label: form.label, provider, file: form.file }),
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
    React.createElement(OverviewSection, { statsByProvider }),
    React.createElement(UsageSection, { statsByProvider }),
    React.createElement(ProviderListSection, { meta, items, busy, onSwitch, onDisable, onAdd }),
    React.createElement(ConfigSection, null),
  );
}
