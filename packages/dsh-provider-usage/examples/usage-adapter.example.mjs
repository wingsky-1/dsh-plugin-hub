/**
 * dsh-provider-usage — v2 适配器完整示例（可直接复制修改使用）。
 *
 * 接入步骤：
 * 1. 把本文件保存到任意位置（如 ~/.dsh/adapters/my-stats.mjs）
 * 2. 在用户层 cordis.patch.yml 声明：
 *
 *    plugins:
 *      '@wingsky-1/dsh-provider-usage':
 *        adapter: ~/.dsh/adapters/my-stats.mjs
 *        provider: my-relay          # 关联的模型 provider 名
 *        staticPath: /api/usage      # API 路径
 *        apiEndpoint: https://relay.example.com   # 可选，缺省走凭据链
 *        autoReload: true            # 可选，编辑本文件后自动热更新
 *
 * 契约要点：
 * - version 固定为 2；name 满足 ^[A-Za-z0-9_-]{2,64}$
 * - fetchData 只在宿主端 Node.js 执行（拥有完整权限，也承担转义义务）
 * - formatCapsule/formatPanel 在宿主端执行并返回 HTML 字符串，
 *   插件净化后随 API 响应下发、客户端 innerHTML 注入
 * - 凡来自外部 API 的字符串拼入 HTML 一律经 esc() 转义（XSS 义务）
 */

// ---- 必填：契约版本与身份 ------------------------------------------------

export const version = 2;
export const name = "my-relay-stats";
export const label = "我的中转站用量";
export const providers = ["my-relay"];

// ---- 可选：留存策略（默认 30 天 / 20MB） ----------------------------------

export const retention = {
  maxAgeDays: 30,   // 天
  maxSizeMB: 20,    // MB
};

// ---- 必填 1/3：获取原始数据（宿主端执行）---------------------------------
// 入参由插件注入，用户不需要自己处理密钥获取逻辑。

export async function fetchData({ apiEndpoint, staticPath, apiKey, signal }) {
  if (!apiKey) throw new Error("no-api-key");
  const res = await fetch(apiEndpoint + staticPath, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal,
  });
  if (res.status === 401 || res.status === 403) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`http-${res.status}`);
  const body = await res.json();
  // ⚠️ 只保留展示所需的最小数据集（这些数据会按天落盘到历史 JSONL）
  return {
    totalTokens: body.total_tokens ?? 0,
    todayCost: body.today_cost ?? 0,
    quotaRemaining: body.quota_remaining ?? null,
  };
}

// ---- 必填 2/3：胶囊内容（宿主端执行，返回 HTML）---------------------------
// status: 'fresh'=新取 | 'cached'=缓存命中 | 'stale'=降级陈旧（error 有值）

export function formatCapsule({ data, status, esc }) {
  const cost = esc(data.todayCost ?? "-");
  const tokens = esc(data.totalTokens ?? "-");
  return `<span style="font-weight:600">$${cost}</span>`
    + `<span style="margin-left:8px;opacity:.7">${tokens} tok · ${status === "stale" ? "缓存" : "实时"}</span>`;
}

// ---- 必填 3/3：面板内容（宿主端执行，返回 HTML）---------------------------

export function formatPanel({ entries, truncated, esc }) {
  if (entries.length === 0) return "<p>暂无历史数据</p>";
  const rows = entries
    .slice(-60) // 面板最多渲染最近 60 条，防大范围卡顿
    .map((e) => {
      const time = esc(new Date(e.time).toLocaleString("zh-CN", { hour12: false }));
      const cost = esc(e.data.todayCost ?? "-");
      const quota = e.data.quotaRemaining != null ? esc(e.data.quotaRemaining) : "--";
      return `<tr><td>${time}</td><td>$${cost}</td><td>${quota}</td></tr>`;
    })
    .join("");
  const warn = truncated ? '<p style="opacity:.6">数据量过大已截断，请缩小时间范围。</p>' : "";
  return `${warn}<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr><th style="text-align:left">时间</th><th style="text-align:left">今日费用</th><th style="text-align:left">剩余额度</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
