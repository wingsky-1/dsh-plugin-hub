# 1. 适配器契约本（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件细化 R1/R2 的完整接口契约、归一化模型、版本、错误码、注册表候选+启用机制与工厂。

---

## 1.0 版本策略

- 契约本文档维护一个整版本号（`ADAPTER_CONTRACT_VERSION = 1`）。
- 宿主端适配器导出、客户端渲染器注册、`window.__DSH_USAGE__` 全局桥接均校验该版本；
  不匹配则 warn 并跳过（不崩溃），杜绝静默失效。
- 版本变更走「升主版本 + 保留旧版本兼容层 ≥1 个主版本」的平滑策略；灰度期旧版本仍
  可加载。

---

## 1.1 宿主端适配器（HostProviderAdapter）

用户注入的**宿主 .mjs / .js** 必须默认导出（或具名导出）契约对象：

```ts
/** 宿主端适配器契约（版本化）。 */
export interface HostProviderAdapter {
  /** 契约版本，必须 === ADAPTER_CONTRACT_VERSION。 */
  version: number;
  /** 适配器唯一名（设置面板候选列表展示，如 "opencode-go-builtin"）。 */
  id: string;
  /** 适配器展示名（如 "OpenCode Go 官方"）。 */
  label: string;
  /** 该适配器认领的 provider 名（可多个）。 */
  providers: string[];
  /** 拉取该 provider 的用量/信息，归一化返回。失败抛错或返回 error 态。 */
  fetchUsage(ctx: HostFetchContext): Promise<ProviderUsage>;
  /** 可选：轻量摘要（按钮文案/状态点）。只从统一缓存派生，禁止独立网络请求。 */
  summarize?(ctx: HostFetchContext): Promise<ProviderSummary>;
  /** 可选：历史采样点提取（结构化列声明）。 */
  samplePoint?(usage: ProviderUsage): { cols: UsageWindow[]; values: (number | null)[] } | null;
  /** 可选：自定义调解逻辑（如重试/限流），缺省走插件默认策略。 */
  retryPolicy?: { maxRetries?: number; backoffMs?: number };
}
```

**`summarize` 硬约束**：只允许从 `ctx` 提供的 usage/缓存派生，**禁止直接网络 IO**。
目的是保证 `/stats` 响应中内嵌的 summary 子树与真实数据源同口径，不出现胶囊与面板
数字矛盾（评审 P1-2 硬约束）。

**`samplePoint` 结构化列声明**：返回 `{ cols, values }`，其中 `cols` 为窗口定义
（key/name/limit/resetPeriodMs），`values` 为对应数值（长度 === cols.length）。
历史响应按 `(provider, adapterId)` 桶附带 `columns` 声明，渲染器据此对齐列语义。

**`defineUsageAdapter` 工厂**（推荐引入）：
```ts
// 典型用量型只需写 fetchUsage，工厂自动派生 summarize/samplePoint
const adapter = defineUsageAdapter({
  id: "opencode-go-builtin",
  label: "OpenCode Go 官方",
  providers: ["opencode-go"],
  async fetchUsage(ctx) { /* ... 返回含 windows 的 ProviderUsage */ },
  windows: [ // 窗口声明：用于自动派生 summarize 的 text/level 与 samplePoint 的 cols
    { key: "rolling", name: "5h 滚动", limit: 12, resetPeriodMs: 5 * 3600000 },
    { key: "weekly",  name: "每周",    limit: 30, resetPeriodMs: 7 * 86400000 },
    { key: "monthly", name: "每月",    limit: 60, resetPeriodMs: 30 * 86400000 },
  ],
});
// 等价于手动实现 summarize (windows → 拼接百分比 + 最高 percent 定 level) +
// samplePoint (windows → 提取 percent 列)
```

想完全自定义格式/文案的适配器直接导出完整 `HostProviderAdapter` 对象（含自定义
summarize/samplePoint），工厂与手写两通道并存。

### HostFetchContext

```ts
export interface HostFetchContext {
  provider: string;      // 当前会话解析出的 provider 名
  model?: string;        // 当前会话模型 id（可选）
  sessionId?: string;    // 当前选中会话 id（可选）
  apiKey?: string;       // 该 provider 的 token（宿主进程内存，不进返回）
  baseUrl?: string;      // 该 provider 的 baseUrl
  fetch: FetchLike;      // 插件注入的 fetch（可替换实现便于测试）
  signal?: AbortSignal;  // 超时/卸载取消
}
```

验证（加载即做，失败 warn + 该候选不注册）：
- `version` 匹配；`id`/`label` 是非空 string；`providers` 是非空 string 数组；
  `fetchUsage` 是函数。
- 任一不满足 → 不注册该适配器，记诊断。

---

## 1.2 归一化数据模型（ProviderUsage）

**尽量薄**：任何 provider 适配器都必须能返回，非用量型中转站也能用。

```ts
export interface ProviderUsage {
  /** 最小强制字段组（契约验证只强制这些）。 */
  ok: boolean;
  provider: string;
  label: string;         // 展示名，如 "OpenCode Go"
  fetchedAt: number;

  /** 可选：用量窗口约定（用量型适配器用它；通用渲染器可解读，编排层不解读）。 */
  windows?: UsageWindow[];
  /** 可选：自由形态附加数据（非用量型中转站直接塞原始结构，编排层不解读）。 */
  data?: unknown;
  /** 可选：异常态说明（ok=false 时错误码见 1.4）。 */
  error?: string | null;
  meta?: Record<string, unknown>;
}
```

- **强制最小集 = `{ok, provider, label, fetchedAt}`**；其余全部可选。
- **编排层不解读 `data`/`meta`**；`windows` 为通用约定字段，编排层仅做通用汇总
  （如 summarize 推导），渲染细节归渲染器。
- 数值口径为 0–100 百分比（约定）；`raw` 用于展示原文，不做业务计算。

---

## 1.3 轻量摘要（ProviderSummary）

```ts
export interface ProviderSummary {
  ok: boolean;
  provider: string;
  label: string;         // 展示名
  /** 按钮文案，如 "5h 2% · 周 1%" */
  text: string;
  /** 状态等级：ok | warn | err | off */
  level: "ok" | "warn" | "err" | "off";
  /** 可选工具提示 */
  hint?: string;
  /** 是否为服务端通用推导（非适配器 summarize 产出） */
  derived?: boolean;
  /** 当前是否有启用适配器 */
  hasAdapter: boolean;
  fetchedAt: number;
  error?: string | null;
}
```

- `derived=true` 时，客户端若本地持有含 `windows` 的详情数据，可自行推导 text/level
  覆盖服务端值（兼容旧行为）。
- `hasAdapter=false` → 客户端浮窗隐藏，60s 轻量探测直到 `hasAdapter` 恢复。

---

## 1.4 客户端渲染器（ClientProviderRenderer）

```ts
export interface ClientProviderRenderer {
  version: number;       // 契约版本
  providers: string[];   // 认领的 provider 名
  /** 可选：绑定某适配器；缺省 = 该 provider 的默认渲染器 */
  adapterId?: string;
  /** 可选：自定义按钮文案。返回 null 则走通用推导 */
  pill?(summary: ProviderSummary): { text: string; level: "ok" | "warn" | "err" | "off"; hint?: string } | null;
  /** 渲染卡片/面板内容。返回可选卸载函数 */
  render(ctx: RenderContext): void | (() => void);
}

export interface RenderContext {
  provider: string;
  adapterId?: string;    // 当前启用适配器 id
  data?: ProviderUsage | null;
  history?: { samples?: unknown[][]; columns?: UsageWindow[] };
  mount: HTMLElement;
  api?: unknown;
  dispose?: () => void;
}
```

- `pill` 钩子：完全自定义按钮文案。适配器对 `(provider, adapterId)` 指明使用哪个
  渲染器，默认渲染器不写 `adapterId`（兜底）。
- `render` 负责把内容画进 `mount`，返回的函数在 provider 切换/插件卸载时被调用。

---

## 1.5 错误码（跨宿主/客户端共享枚举）

| 码 | 含义 | 渲染提示 |
| --- | --- | --- |
| `no-provider` | 会话无 provider / 未识别 | 显示「未识别提供商」引导 |
| `no-adapter` | provider 有，但无任何适配器候选 | 显示「该提供商未配置适配器」+ 配置引导 |
| `no-enabled-adapter` | 有候选但无启用 | 显示「该提供商适配器未启用」+ 启用引导 |
| `no-api-key` | 缺 token | 显示「未找到 API Key」 |
| `unauthorized` | 401/403 | 显示「token 无效或过期」 |
| `http-<status>` | 服务端错误 | 显示具体状态码 |
| `timeout` | 超时 | 显示「请求超时」 |
| `network` | 网络失败 | 显示「网络错误」 |
| `bad-data` | 返回结构无法解释 | 显示「数据格式异常」 |
| `adapter-load-failed` | 用户适配器加载失败 | 显示「自定义适配器加载失败」+ 文件诊断 |
| `adapter-crash` | 用户适配器运行抛错 | 显示「适配器出错」+ 保留上一次成功数据 |

---

## 1.6 注册表运行时（候选 + 启用）

**宿主端 `HostAdapterRegistry`**：
- 注册表改为 `provider → 有序候选列表`，每条适配器条目带 `{ id, label, enabled, source, file, status, error? }`。
- `register(adapter, source, file?)`：校验 id 非空、同 id 重复拒绝（warn）；校验 contracts；
  校验 provider 冲突：已有候选时加入候选列表（不覆盖），改 `enabled` 布尔字段。
- `get(provider)`：返回该 provider 候选列表中 `enabled === true` 的条目；无启用条目返回 undefined。
- `select(provider, adapterId)`：切换启用适配器 + 清缓存。
- `snapshot()`：返回 `{ infos: [...], enabled: { provider: adapterId, ... } }`。

**客户端 `RendererRegistry`**：
- 支持 `adapterId` 匹配：`get(provider, adapterId?)` → 优先匹配 adapterId，否则回落无 adapterId 的。

---

## 1.7 内置 OpenCode Go 适配器（R1 更新清单）

- `id: "opencode-go-builtin"`, `label: "OpenCode Go 官方"`
- 实现 `summarize(ctx)`：从 `fetchUsage` 结果缓存派生，返回 `{ text: "5h 3% · 每周 1% · 每月 0%", level: "ok", ... }`
- 实现 `samplePoint(usage)`：从 `usage.windows` 提取 `{ cols: [...], values: [rolling%, weekly%, monthly%] }`
- 内置客户端渲染器 `adapterId: "opencode-go-builtin"`，`pill` 钩子返回 null（走通用）或自定义文案