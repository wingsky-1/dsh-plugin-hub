# 1. 适配器契约本（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件细化 M1/M2 的接口契约、归一化模型、版本、错误码与注册表运行时。

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
  /** 该适配器认领的 provider 名（可多个）。 */
  providers: string[];
  /** 拉取该 provider 的用量/信息，归一化返回。失败抛错或返回 error 态。 */
  fetchUsage(ctx: HostFetchContext): Promise<ProviderUsage>;
  /** 可选：自定义调解逻辑（如重试/限流），缺省走插件默认策略。 */
  retryPolicy?: { maxRetries?: number; backoffMs?: number };
}

/** fetchUsage 的入参上下文。 */
export interface HostFetchContext {
  provider: string;      // 当前会话解析出的 provider 名
  model?: string;        // 当前会话模型 id（可选）
  sessionId?: string;    // 当前选中会话 id（可选；多会话语义见 4-history）
  apiKey?: string;       // 插件解析出的该 provider token（宿主进程内存，不进返回）
  baseUrl?: string;      // 该 provider 的 baseUrl（来自配置或适配器自身）
  fetch: FetchLike;      // 插件注入的 fetch（可替换实现便于测试）
  signal?: AbortSignal;  // 超时/卸载取消（见 7-dataflow）
}
```

验证（加载即做，失败 warn + 该 provider 回落）：
- `version` 匹配；`providers` 是非空 string 数组；`fetchUsage` 是函数。
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

  /** 可选：用量窗口约定（用量型适配器用它；插件通用渲染器可解读）。 */
  windows?: Array<{
    key: string; name: string;
    percent: number | null;   // 0-100
    raw?: string;             // 原文展示，如 "$3.2 / $12"
    limit?: number;
    resetsAt?: string;        // ISO
    resetPeriodMs?: number;
  }>;
  /** 可选：自由形态附加数据（非用量型中转站直接塞原始结构）。 */
  data?: unknown;
  /** 可选：异常态说明（ok=false 时错误码见 1.4）。 */
  error?: string | null;
  meta?: Record<string, unknown>;
}
```

- **强制最小集 = `{ok, provider, label, fetchedAt}`**；其余全部可选。渲染器只在
  对应字段存在时消费，避免强耦合。
- 约定：数值口径为 0–100 百分比；`raw` 用于展示原文，不做业务计算（沿用「权威数据、
  零本地计算」）。

---

## 1.3 客户端渲染器（ClientProviderRenderer）

用户注入的**客户端 .js** 经全局桥接注册：

```ts
export interface ClientProviderRenderer {
  version: number;       // 契约版本
  providers: string[];   // 认领的 provider 名
  /** 渲染卡片/面板内容。返回可选卸载函数。 */
  render(ctx: RenderContext): void | (() => void);
}

export interface RenderContext {
  provider: string;
  data?: ProviderUsage;      // 宿主端归一化数据（可能因未配置/失败为 null）
  mount: HTMLElement;        // 插件提供的挂载容器
  // 低嵌入可选：客户端连接 API（拿更全的会话/模型信息）；缺省不强制
  api?: unknown;
  dispose?: () => void;      // 插件卸载时的清理钩子（与 render 返回值合并语义）
}
```

**挂载约定**：
- `render` 负责把内容画进 `mount`，返回的函数在 provider 切换/插件卸载时被调用
  （清 listener、断开 observer、revoke blob 等）。
- 同 provider 重复渲染时，插件先调用上一次的 disposer 再渲染新内容，防泄漏。

---

## 1.4 错误码（跨宿主/客户端共享枚举）

| 码 | 含义 | 渲染提示 |
| --- | --- | --- |
| `no-provider` | 会话无 provider / 未识别 | 显示「未识别提供商」引导 |
| `no-adapter` | provider 有，但无任何适配器 | 显示「该提供商未配置适配器」+ 配置引导 |
| `no-api-key` | 缺 token | 显示「未找到 API Key」 |
| `unauthorized` | 401/403 | 显示「token 无效或过期」 |
| `http-<status>` | 服务端错误 | 显示具体状态码 |
| `timeout` | 超时 | 显示「请求超时」 |
| `network` | 网络失败 | 显示「网络错误」 |
| `bad-data` | 返回结构无法解释 | 显示「数据格式异常」 |
| `adapter-load-failed` | 用户适配器加载失败 | 显示「自定义适配器加载失败」+ 文件诊断 |
| `adapter-crash` | 用户适配器运行抛错 | 显示「适配器出错」+ 保留上一次成功数据 |

错误码由宿主端归一化（`error` 字段）产出，客户端只负责展示 + 引导，不做业务判断。

---

## 1.5 注册表运行时（宿主 + 客户端）

**宿主端 `HostAdapterRegistry`**：
- `register(adapter)` / `unregister(provider|adapter)` / `get(provider)` / `snapshot()`。
- 加载顺序：内置 OpenCode Go 先注册；用户宿主适配器后注册，**同 provider 用户覆盖
  内置**（D4）。
- `get(provider)` 未命中 → 返回 `{ ok:false, error:"no-adapter" }` 归一化结果。

**客户端 `RendererRegistry`**：
- 维护 `Map<provider, ClientProviderRenderer>`，由内置渲染器 + 用户注入渲染器填充。
- 查表 + 渲染分派见 `7-dataflow-and-errors.md` 的「渲染状态机」。

---

## 1.6 内置 OpenCode Go 适配器（M1 迁移清单）

把现有 `fetchUsage` 逻辑迁移为内置宿主适配器 `opencode-go`：
- `providers: ["opencode-go"]`（与 `SessionModels.current.provider` 的取值对齐，
  实际值以 M0 烟测为准）。
- `fetchUsage` 内部 = 现有 `loadApiKey + fetchUsage + parseUsageResponse`，产出
  `windows: [rolling, weekly, monthly]`。
- 现有行为（TTL 缓存、同分钟去重采样、落盘）保留在插件编排层，不搬进适配器（适配器
  只做「取一份归一化数据」）。

内置客户端渲染器迁移现有 `renderCharts / miniChartSvgMarkup` 为 `render(ctx)`，
行为不退化。
