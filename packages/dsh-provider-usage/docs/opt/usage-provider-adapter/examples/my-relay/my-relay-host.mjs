/**
 * my-relay 宿主取数适配器示例（HostProviderAdapter 契约，version 1）。
 *
 * 用途：对接你的中转站/聚合服务的用量接口，归一化为 ProviderUsage 返回。
 * 运行环境：DSH 宿主 Node 进程（完整 Node 权限——仅加载你信任的本地文件）。
 *
 * 接线（cordis.patch.yml / 用户 patch 层）：
 *   plugins:
 *     ui-dsh-provider-usage:
 *       adapters:
 *         host:
 *           - provider: my-relay
 *             file: ~/.dsh/my-relay-host.mjs
 */

/** 中转站用量接口地址（改成你自己的）。 */
const BASE_URL = "https://relay.example.com/v1/usage";

export default {
  /** 契约版本，必须 === 1。 */
  version: 1,
  /** 适配器唯一名（设置面板候选列表展示、历史桶目录名）。 */
  id: "my-relay",
  /** 展示名。 */
  label: "我的中转站",
  /** 认领的 provider 名（会话模型选到该 provider 时本适配器被分派）。 */
  providers: ["my-relay"],

  /**
   * 必选：拉取该 provider 的用量并归一化。
   * @param ctx - { provider, apiKey?, baseUrl?, fetch, signal? }
   * @returns ProviderUsage：强制最小集 { ok, provider, label, fetchedAt }；
   *   windows（通用窗口约定）与 data（自由格式）可选。
   */
  async fetchUsage(ctx) {
    const res = await ctx.fetch(`${ctx.baseUrl ?? BASE_URL}`, {
      headers: {
        // 鉴权自定：可用 ctx.apiKey（插件解析链传入），也可完全自带
        ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
        Accept: "application/json",
      },
      signal: ctx.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, provider: "my-relay", label: this.label, fetchedAt: Date.now(), error: "unauthorized" };
    }
    if (!res.ok) {
      return { ok: false, provider: "my-relay", label: this.label, fetchedAt: Date.now(), error: `http-${res.status}` };
    }
    const body = await res.json();

    // 方式 A（推荐）：映射为通用 windows 约定 → 插件可自动派生胶囊文案与历史采样
    return {
      ok: true,
      provider: "my-relay",
      label: this.label,
      fetchedAt: Date.now(),
      windows: [
        { key: "credit", name: "额度", percent: body.creditPercent ?? null, raw: body.creditRaw, resetsAt: body.resetAt },
      ],
      data: body, // 原始结构透传给渲染器（编排层不解读）
    };

    // 方式 B（完全自定义）：不返回 windows，只塞 data —— 此时建议自行实现
    // summarize（胶囊文案）与 samplePoint（历史采样列），见下方注释。
  },

  /**
   * 可选：自定义胶囊文案。只准从 ctx.usage 派生，**禁止独立网络请求**
   * （保证与面板数据同口径）。缺省由插件从 windows 通用推导。
   */
  async summarize(ctx) {
    const pct = ctx.usage?.windows?.[0]?.percent;
    return {
      ok: true,
      provider: "my-relay",
      label: this.label,
      text: typeof pct === "number" ? `额度 ${pct}%` : this.label,
      level: typeof pct === "number" && pct >= 90 ? "warn" : "ok",
      hasAdapter: true,
      fetchedAt: Date.now(),
    };
  },

  /**
   * 可选：声明历史采样列（结构化）。返回 null 表示该次不采样。
   * 缺省：有 windows 时插件自动按 percent 列采样。
   */
  samplePoint(usage) {
    const w = usage.windows?.[0];
    if (!w || typeof w.percent !== "number") return null;
    return { cols: [{ key: "credit", name: "额度" }], values: [w.percent] };
  },
};
