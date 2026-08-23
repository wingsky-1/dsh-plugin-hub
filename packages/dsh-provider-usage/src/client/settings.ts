/**
 * dsh-provider-usage — 设置面板独立 tab「用量统计」（v2 只读概览版）。
 *
 * 经 slots.inject("settings.section") 注册顶层 tab，React 渲染三区：
 * - 运行状态：各启用 provider 的胶囊内容 + 数据状态（/stats、/health）
 * - 适配器信息：当前生效适配器（name/label/source）+ 最近错误登记
 * - 配置引导：v2 适配器的 cordis.patch.yml 配置示例（复制即用）
 *
 * v2 变更：适配器管理（inspect/add/select）随旧契约移除——用户适配器改由
 * cordis.patch.yml 声明（adapter 路径），热更新自动生效，无需运行时管理。
 */
import * as React from "react";
import { STATS_URL, HEALTH_URL, fetchTimeout } from "./core.js";

/** /health 响应中本页消费的形状。 */
interface HealthView {
  ok?: boolean;
  provider?: string;
  adapterName?: string;
  adapters?: Array<{ name: string; label: string; source: string; enabled: boolean }>;
  errors?: Array<{ key: string; at: number; kind: string; message: string }>;
}

/** /stats 响应中本页消费的形状。 */
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

async function jsonGet(url: string): Promise<unknown> {
  const res = await fetchTimeout(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 数据状态 → 颜色（主题变量 + 浅色回退）。 */
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

const codeStyle: Object = {
  display: "block",
  padding: "8px 10px",
  borderRadius: 6,
  background: "var(--dsw-alias-bg-layer-2,#ffffff)",
  border: "1px solid var(--dsw-alias-border-l1,#eef0f4)",
  fontFamily: "monospace",
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all" as const,
};

const STATUS_LABEL: Record<string, string> = {
  fresh: "实时",
  cached: "缓存",
  stale: "陈旧（已降级，展示最近一次数据）",
};

/** 运行状态区：各 provider 的胶囊内容 + 状态。 */
function StatusSection({ statsByProvider }: { statsByProvider: Record<string, StatsView | null> }) {
  const providers = Object.keys(statsByProvider);
  if (providers.length === 0) {
    return React.createElement(
      "div",
      { style: sectionStyle },
      React.createElement("p", { style: titleStyle }, "运行状态"),
      React.createElement("div", null, "暂无启用的 provider 数据。"),
    );
  }
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("p", { style: titleStyle }, "运行状态"),
    ...providers.map((provider) => {
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

/** 适配器信息区：生效适配器 + 错误登记。 */
function AdapterSection({ health }: { health: HealthView | null }) {
  const adapters = health?.adapters ?? [];
  const errors = health?.errors ?? [];
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("p", { style: titleStyle }, "适配器"),
    adapters.length === 0
      ? React.createElement("div", null, "无已注册适配器。")
      : React.createElement(
          "ul",
          { style: { margin: "0", paddingLeft: 18 } },
          adapters.map((a) =>
            React.createElement(
              "li",
              { key: a.name },
              `${a.label}（${a.name} · ${a.source === "builtin" ? "内置" : "用户文件"}）`,
            ),
          ),
        ),
    errors.length > 0
      ? React.createElement(
          "div",
          { style: { marginTop: 8, color: "var(--dsw-alias-state-error-primary,#d64545)" } },
          "最近错误：",
          ...errors.slice(-3).map((e, i) =>
            React.createElement(
              "div",
              { key: i, style: { fontSize: 11 } },
              `[${e.kind}] ${e.key}: ${e.message}`,
            ),
          ),
        )
      : null,
  );
}

/** 配置引导区：v2 适配器接入示例。 */
function ConfigGuideSection() {
  const [copied, setCopied] = React.useState(false);
  const sample = [
    "# cordis.patch.yml（用户层）",
    "plugins:",
    "  '@wingsky-1/dsh-provider-usage':",
    "    adapter: './adapters/my-stats.mjs'   # 用户适配器（v2 契约三函数）",
    "    provider: 'opencode-go'              # 关联的模型 provider",
    "    staticPath: '/v1/usage'              # API 路径（与 apiEndpoint 拼接）",
    "    # autoReload: true                   # 编辑 mjs 后热更新（默认关）",
  ].join("\n");
  return React.createElement(
    "div",
    { style: sectionStyle },
    React.createElement("p", { style: titleStyle }, "接入自定义适配器（v2 契约）"),
    React.createElement(
      "div",
      null,
      "编写一个 mjs 文件导出 version/name/providers/fetchData/formatCapsule/formatPanel，然后在用户层 cordis.patch.yml 声明路径：",
    ),
    React.createElement("code", { style: { ...codeStyle, marginTop: 6 } }, sample),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          void copyText(sample).then((ok) => {
            setCopied(ok);
            setTimeout(() => setCopied(false), 2000);
          });
        },
        style: { marginTop: 6 },
      },
      copied ? "已复制 ✓" : "复制配置示例",
    ),
  );
}

export function SettingsPage() {
  const [health, setHealth] = React.useState<HealthView | null>(null);
  const [statsByProvider, setStatsByProvider] = React.useState<Record<string, StatsView | null>>({});

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      const h = (await jsonGet(HEALTH_URL).catch(() => null)) as HealthView | null;
      setHealth(h);
      // 对 health 报告的 provider 并行拉 /stats
      const providers = new Set<string>();
      if (h?.provider) providers.add(h.provider);
      for (const a of h?.adapters ?? []) {
        for (const p of a.enabled ? [h?.provider ?? ""] : []) if (p) providers.add(p);
      }
      const pairs = await Promise.all(
        [...providers].map(async (provider) => {
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

  return React.createElement(
    "div",
    { className: "dou-settings", style: { maxWidth: 560 } },
    React.createElement(StatusSection, { statsByProvider }),
    React.createElement(AdapterSection, { health }),
    React.createElement(ConfigGuideSection),
  );
}