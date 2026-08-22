/**
 * dsh-provider-usage — 设置面板独立 tab「用量统计」（M3b）。
 *
 * 经 slots.inject("settings.section") 注册顶层 tab，React 渲染四区：
 * - 总览：当前会话 provider 识别结果 + 生效适配器
 * - 用量可视化：summary 文案 + 各窗口明细表
 * - 适配器管理：按 provider 分组的候选列表（id/label/来源/enabled），单选切换启用
 * - 配置：常用配置键展示（patch 层为单一事实源，此处只读）
 *
 * 数据面：全部走宿主 loopback 路由（/stats、/adapters.json、POST /adapters/select），
 * 不引入额外 RPC 通道。
 */
import * as React from "react";
import { STATS_URL, ADAPTERS_URL, SELECT_URL } from "./core.js";

/** 候选条目（adapters.json host[]）。 */
interface AdapterInfo {
  id: string;
  label: string;
  providers: string[];
  source: "builtin" | "user-file";
  file?: string | null;
  enabled?: boolean;
}

/** adapters.json 响应形状。 */
interface AdaptersMeta {
  version?: number;
  host?: AdapterInfo[];
  enabled?: Record<string, string>;
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
                  "该提供商暂无启用的适配器——请在下方「适配器管理」启用一个候选。",
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

/** 适配器管理区：候选列表 + 单选启用。 */
function AdapterSection({ meta, onSwitch, busy }: { meta: AdaptersMeta | null; onSwitch(provider: string, adapterId: string): void; busy: boolean }) {
  const infos = meta?.host ?? [];
  // 按 provider 分组
  const byProvider = new Map<string, AdapterInfo[]>();
  for (const info of infos) {
    for (const provider of info.providers) {
      const list = byProvider.get(provider) ?? [];
      list.push(info);
      byProvider.set(provider, list);
    }
  }
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("h4", { style: titleStyle }, "适配器管理"),
    byProvider.size === 0
      ? React.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary,#9aa0ab)" } }, "无已注册适配器")
      : [...byProvider.entries()].map(([provider, candidates]) =>
          React.createElement(
            "div",
            { key: provider, style: { marginBottom: 8 } },
            React.createElement("div", { style: { fontWeight: 600 } }, `provider：${provider}`),
            ...candidates.map((c) =>
              React.createElement(
                "label",
                { key: c.id, style: { display: "flex", alignItems: "center", gap: 6, cursor: busy ? "wait" : "pointer" } },
                React.createElement("input", {
                  type: "radio",
                  name: `dou-adm-${provider}`,
                  checked: c.enabled === true,
                  disabled: busy,
                  onChange: () => onSwitch(provider, c.id),
                }),
                React.createElement(
                  "span",
                  null,
                  `${c.label}（${c.id}${c.source === "builtin" ? " · 内置" : " · 自定义"}）`,
                ),
              ),
            ),
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

/** 设置页根组件：按 adapters.json enabled 映射逐 provider 拉取 /stats，渲染四区。 */
export function SettingsPage() {
  // 注：react 类型面在 #28 引入最小声明后再补泛型标注（当前 shim 为宽松形态）
  const [statsByProvider, setStatsByProvider] = React.useState({});
  const [meta, setMeta] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      // issue #27：总览不再硬编码 ?provider=opencode-go——先取 adapters.json 的
      // enabled 映射（provider → adapterId），再对每个启用 provider 并行拉 /stats。
      const m = (await jsonGet(ADAPTERS_URL).catch(() => null)) as AdaptersMeta | null;
      const providers = Object.keys(m?.enabled ?? {});
      const pairs = await Promise.all(
        providers.map(async (provider) => {
          const s = (await jsonGet(`${STATS_URL}?provider=${encodeURIComponent(provider)}`).catch(
            () => null,
          )) as StatsView | null;
          return [provider, s] as const;
        }),
      );
      setMeta(m);
      setStatsByProvider(Object.fromEntries(pairs));
    } catch {
      /* 面板数据拉取失败静默（保留旧值） */
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const onSwitch = React.useCallback(
    (provider: string, adapterId: string): void => {
      setBusy(true);
      fetch(SELECT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, adapterId }),
      })
        .then(async () => {
          await reload();
        })
        .catch(() => {})
        .finally(() => setBusy(false));
    },
    [reload],
  );

  return React.createElement(
    "div",
    { className: "dou-settings", style: { maxWidth: 560 } },
    React.createElement(OverviewSection, { statsByProvider }),
    React.createElement(UsageSection, { statsByProvider }),
    React.createElement(AdapterSection, { meta, onSwitch, busy }),
    React.createElement(ConfigSection, null),
  );
}