# dsh-provider-usage 改造实施计划（v2 — 评审修订版）

> 基于现有 `dsh-provider-usage` 代码改造，保留配置页面和已实现的胶囊/面板。
> 本版为三份对抗性评审（架构/兼容性、模型配置/安全、客户端/UX）的合并修订版。
> 主要内容：1. 核心决策 → 2. 契约设计 → 3. 保留/修改清单 → 4. 实施阶段 → 5. 割接策略 → 6. 风险

## 0. 核心决策（用户已确认 + 评审修正）

**用户确认：**
1. **不保留旧契约**：删除 `HostProviderAdapter` / `ClientProviderRenderer` / `ProviderUsage` 归一化，全部走新契约（`fetchData` / `formatCapsule` / `formatPanel` 三函数 mjs）。
2. **内置 opencode-go 重写**：适配新 mjs 契约（内置实现与新契约同构，行为不退化）。
3. **保留配置页面和胶囊/面板**：`settings.ts` + `client/index.ts` 挂载/轮询/定位/可见性机制保留。

**评审修正（新增）：**
4. **执行模型：宿主端渲染**（评审 P0-2）：`formatCapsule`/`formatPanel` 在 **宿主端 Node.js 执行**，返回 HTML 字符串随 API 响应下发。客户端只做 `innerHTML` 注入。**用户 mjs 只加载在宿主端**，不存在双运行时问题，无 Node 模块约束。
5. **模型配置读取：V1 配置链，放弃 V2**（评审 P0-1）：`LlmConfigurableProvider` 无标准化 `apiKey`/`baseURL` 字段（官方类型确认），V2 settings 命名空间读取不可行。永久方案 = 配置链（显式配置 → 环境变量 → `.credentials.yaml` → `auth.json`）。
6. **新契约含 `version: 2` 判别信号**（评审 P0-1）：防止与旧契约形状猜测歧义。
7. **新契约补 `providers` 和 `label`**（评审 P0-3）：复用现有 registry 的 provider 关联、启用选择、面板展示机制。
8. **纪律**：用户代码报错不崩溃；不阻塞/不挂起连接（取数强制超时、锁预检）。

## 1. 契约设计（评审修订版）

### 1.1 用户 mjs 适配器契约

```typescript
// 用户写一个 mjs 文件，导出以下内容：

/** 契约版本（固定为 2，用于与旧契约 v1 区分） */
export const version = 2;

/** 适配器唯一标识（用于日志、历史目录名；白名单 ^[A-Za-z0-9_-]{2,64}$） */
export const name: string;

/** 展示名（面板/设置页展示，可选，默认取 name） */
export const label?: string;

/** 认领的 provider 列表（复用现有 registry 的 provider 关联机制，必填） */
export const providers: string[];

/** 可选：数据留存策略（默认 30 天 / 20MB） */
export const retention?: {
  maxAge?: number;    // 毫秒，默认 30 * 24 * 60 * 60 * 1000
  maxSize?: number;   // 字节，默认 20 * 1024 * 1024
};

/**
 * 1. 获取原始数据（宿主端 Node.js 执行）
 *    入参由插件注入 apiEndpoint/staticPath/apiKey。密钥从模型配置/配置链读取，
 *    用户不需要自己处理密钥获取逻辑。
 *    ⚠️ 必填：缺此函数 → 适配器不加载（fail-fast）
 */
export async function fetchData(context: {
  apiEndpoint: string;        // 插件配置/模型配置中的 API 基础地址
  staticPath: string;         // 用户定义的 API 路径
  apiKey?: string;            // 密钥
  provider: string;           // 当前调用的 provider 名
  timeoutMs: number;          // 超时配置（默认 2000）
  signal?: AbortSignal;       // 超时信号
}): Promise<Record<string, unknown>>;

/**
 * 2. 格式化胶囊展示内容（宿主端执行，返回 HTML 字符串，注入客户端胶囊框架）
 *    ⚠️ 必填：缺此函数 → 适配器不加载（fail-fast）
 *    安全提示：外部 API 数据拼入 HTML 前请用 `esc()` 转义（见 1.2）
 */
export function formatCapsule(input: {
  time: number;
  data: Record<string, unknown>;
  status: 'fresh' | 'cached' | 'stale';
  error?: string;
}): string;

/**
 * 3. 格式化面板展示内容（宿主端执行，返回 HTML 字符串，注入客户端面板框架）
 *    ⚠️ 必填：缺此函数 → 适配器不加载（fail-fast）
 */
export function formatPanel(input: {
  entries: Array<{ time: number; data: Record<string, unknown> }>;
  range: { start: number; end: number };
  truncated: boolean;
}): string;
```

### 1.2 XSS 防护（评审 P0-1）

**结构：** 契约入参注入 `esc` 助手（`CapsuleInput.esc`）：

```typescript
export function formatCapsule(input: { ..., esc: (s: unknown) => string }): string {
  return `<span>${esc(input.data.visits)}</span>`;
}
```

`esc` 实现：将字符串中的 `&` `<` `>` `"` `'` 转义为 HTML 实体。**宿主端渲染在 `innerHTML` 前做一次结构化净化**（DOMPurify 构建期内联，~8KB gzip），白名单式过滤 `<script>`、`on*` 事件、`javascript:` 协议、`<iframe>` 等。

README `## 安全模型` 章节明确：**适配器文件在宿主端以完整 Node 权限运行；外部 API 数据流入 HTML 模板时须转义；插件层做结构化净化作为兜底。**

### 1.3 内置 opencode-go 适配器示例

```javascript
// 内置 opencode-go 适配器（重写为新契约格式）
export const version = 2;
export const name = 'opencode-go-builtin';
export const label = 'OpenCode Go';
export const providers = ['opencode-go'];

export async function fetchData({ apiEndpoint, staticPath, apiKey, provider, timeoutMs, signal }) {
  const url = apiEndpoint + staticPath;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  return res.json();
}

export function formatCapsule({ time, data, status, esc }) {
  const visits = esc(data.visits ?? 0);
  return `<span style="font-weight:600">${visits} 次</span>`;
}

export function formatPanel({ entries, range, truncated, esc }) {
  const rows = entries.map(e => `<tr>
    <td>${new Date(e.time).toLocaleString()}</td>
    <td>${esc(e.data.visits ?? '-')}</td>
  </tr>`).join('');
  return `<table>${rows}</table>`;
}
```

## 2. 保留与修改清单（逐文件，评审修订版）

### 2.1 保留不动

| 文件 | 备注 |
|------|------|
| `package.json` | 包名、exports、构建脚本不变；新增 `async-mutex` devDeps |
| `tsconfig.json` | 不变 |
| `cordis.patch.yml` | id `ui-provider-usage` 不变 |
| `src/path-resolve.ts` | 路径解析安全不变 |
| `src/client/css.d.ts` | CSS 类型声明 |
| `src/client/react-shim.d.ts` | React 类型声明 |

### 2.2 保留改造

| 文件 | 改动内容 |
|------|---------|
| `src/client/settings.ts`（666 行） | 适配新配置项和新契约信息；新增契约适配器信息独立区域（默认折叠） |
| `src/client/index.ts`（515 行） | 保留挂载/轮询/定位/可见性；内容源改为：`/stats` 响应中的 `capsuleHtml` 注入胶囊框架，`/history` 响应中的 `panelHtml` 注入面板框架 |
| `src/client/core.ts`（286 行） | 删渲染器注册表，简化为纯数据层（provider 检测、数据拉取） |
| `src/client/renderers/opencode-go.ts` | 重写为新契约格式（内置 opencode-go 适配器） |
| `src/client/renderers/balance.ts` | 同上 |
| `src/client/style.css` | 新增框架类 + 用户 HTML 容器兜底样式 |
| `src/client-logic.ts` | 适配新契约（派生逻辑简化） |
| `test/smoke.ts` | 新增用例，删旧契约用例 |

### 2.3 改造（大改）

| 文件 | 改动量 |
|------|--------|
| `src/index.ts`（1748 行） | 删旧契约注册表/collectStats 旧路径；改为：新契约加载 + 管道化 fetcher + 热更新 + 新配置项 | 大 |
| `src/contracts.ts`（432 行） | **删除旧接口**，只留新契约 + 错误码 + 工具类型（`esc`、`isUsageStatsAdapter`） | 大 |
| `src/registry.ts`（331 行） | 简化为新契约加载器 + provider 关联 + enabled 选择 | 中 |
| `src/adapters/opencode-go.mjs`（+ `.d.mts`） | 重写为 mjs 格式（内置实现；#215 图表函数走注入 utils） | 大 |

### 2.4 新增

| 文件 | 内容 |
|------|------|
| `src/core/guards.ts` | `safeFetchData`（5s 固定超时 + 序列化校验 + AbortSignal）、`safeFormat`（超时同源注入 + 类型校验）、`fetchWithTimeout`（AbortController） |
| `src/core/history.ts` | 按天分片 JSONL HistoryStore（兼容读取旧 v3 格式） |
| `src/pipeline/v2.ts` | 新契约管道：fetchData → 校验 → 落盘 → 格式化（formatCapsule/formatPanel）→ 返回 |
| `src/hotreload.ts` | mtime+size 轮询热更新 + 校验和验证 + 原子切换 |
| `src/provider-config.ts` | 模型配置读取（V1：配置链，显式配置 → 环境变量 → .credentials.yaml → auth.json） |
| `src/sanitize.ts` | HTML 结构化净化（DOMPurify 内联 / 白名单过滤） |
| `docs/implementation-plan.md` | 本文件 |
| `src/adapters/*.mjs`（+ 同名 `.d.mts`） | 内置适配器（参考实现；原独立示例文件已移除，接入参照内置源码与 docs/adapter-guide.md） |

## 3. 实施阶段（7 阶段，约 8-10 天）

### 阶段 1：契约基础设施（1 天）

- `contracts.ts`：删除旧接口，定义新契约 + `esc` + `isUsageStatsAdapter` 校验函数
- `normalizeConfig` 新增 `staticPath` / `provider` 等新配置项
- 补阶段 1 的 smoke 用例（契约校验）

### 阶段 2：核心安全模块（1 天）

- `src/core/guards.ts`：`safeFetchData`、`safeFormat`、`fetchWithTimeout`
- `src/sanitize.ts`：结构化净化器（DOMPurify 内联或白名单过滤）
- 补阶段 2 的 smoke 用例（超时/净化）

### 阶段 3：存储历史（1.5 天）

- `src/core/history.ts`：按天分片 JSONL（`historyDir/<safe-provider>/<safe-name>/YYYY-MM-DD.jsonl`）
- 兼容读取旧 v3 多文件 JSON 桶（一次性迁移 → 标记 .bak）
- `historyRoute` 重写为只读新格式
- 补阶段 3 的 smoke 用例（双态读写）

### 阶段 4：适配器加载与管道（2 天）

- `src/adapters/opencode-go.mjs`：重写为新契约格式（#215 mjs 化 + 注入 utils 消费）
- `src/pipeline/v2.ts`：新契约管道（fetchData → 校验 → 落盘 → formatCapsule/formatPanel → 返回）
- `src/index.ts`：`collectStats` 简化为调用 `runV2Pipeline`
- `src/registry.ts`：简化为新契约加载器 + provider 关联 + fail-fast 校验
- `src/hotreload.ts`：mtime+size 轮询 + 校验和验证 + 原子切换
- 补阶段 4 的 smoke 用例（fail-fast、热更新）

### 阶段 5：模型配置读取（1 天）

- `src/provider-config.ts`：V1 配置链（显式配置 → 环境变量 → `.credentials.yaml` → `auth.json`）
- 注：V2 settings 命名空间路径经评审确认不可行，不提
- 补阶段 5 的 smoke 用例

### 阶段 6：客户端融合（1.5 天）

- `src/client/index.ts`：胶囊框架注入 `/stats` 响应中的 `capsuleHtml`，面板框架注入 `/history` 响应中的 `panelHtml`
- `src/client/core.ts`：删渲染器注册表，简化为纯数据层
- `src/client/settings.ts`：适配新配置项；新增契约适配器信息独立区域（默认折叠）
- 内置 opencode-go 渲染器重写（适配新数据格式）
- `src/client/style.css`：新增框架基础类 + 用户 HTML 容器兜底样式
- 补阶段 6 的 smoke 用例（渲染回落、胶囊 HTML 注入）

### 阶段 7：测试与文档（1 天）

- 全量回归：`pnpm build && pnpm contract && pnpm test && pnpm pack:check`
- `README.md`：`## 安全模型` 章节（适配器全权限、密钥配置链、HTML 转义义务、loopback 围栏边界）
- 配置项说明更新
- 适配器参考实现（见 `src/adapters/`，原独立示例文件已移除）
- 容错矩阵

## 4. 割接与兼容策略

### 4.1 旧契约 → 新契约

- 旧 `HostProviderAdapter` 代码全部删除，不存在兼容期
- 内置 opencode-go 适配器重写为新格式
- `registry.ts` 的 `isHostProviderAdapter` 校验函数删除，替换为 `isUsageStatsAdapter`
- 用户自定义旧适配器 mjs 需要迁移：`fetchUsage` → `fetchData`，新增 `formatCapsule`/`formatPanel`，补 `providers`/`version`

### 4.2 存储格式

- 旧 v3 多文件 JSON 桶 → 一次性迁移到按天分片 JSONL
- 启动时检测旧 `history/` 目录，读取后标记 `.bak`，后续写入全走新格式
- 2 版本后删除旧格式读取代码

### 4.3 配置迁移

- `normalizeConfig` 兼容旧配置项（`baseUrl`/`apiKey`/`timeoutMs`/`cacheTtlMs`/`limits` 在新版本中 deprecated 但有效）
- 新配置项：`adapter` / `staticPath` / `provider`
- 设置页同时展示新旧配置项，旧项标记 deprecated

## 5. 关键设计决策摘要

| 决策 | 选择 | 评审来源 |
|------|------|---------|
| 执行模型 | **宿主端渲染**（format 在 Node 执行，返回 HTML） | P0-2（架构/UX） |
| 模型配置读取 | **V1 配置链**，放弃 V2 settings 命名空间 | P0-1（模型配置） |
| 契约判别信号 | 显式 `version: 2` | P0-1（架构） |
| Provider 关联 | 补 `providers: string[]`、`label` | P0-3（架构/UX） |
| XSS 防护 | `esc` 助手 + 结构化净化器（DOMPullify 内联） | P0-1（UX） |
| 热更新安全 | 校验和验证 + 原子切换 + 失败回退 | P0-2（安全） |
| 管道化 | 独立 `src/pipeline/v2.ts`，不膨胀 `collectStats` | P0-4（UX） |
| 存储目录键 | `safe(provider)/safe(name)/YYYY-MM-DD.jsonl` | P2-7（架构） |
| 依赖 | `async-mutex`（红线审批）或自写 30 行 Mutex | P2-1（架构） |
| 缓存 | 保留现有 `makeUsageCache`（Map），不引入 lru-cache | P2-1（原方案） |

## 6. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| 旧历史数据迁移丢失 | 低 | 旧格式标记 `.bak`，保留 2 版本 |
| 热更新 ESM 缓存绕行不稳定 | 低 | `import(url + '?t=' + mtimeMs)` 实测 + smoke 断言 |
| `async-mutex` 红线审批不通过 | 低 | 自写 30 行 Mutex 兜底 |
| 用户现有自定义适配器需迁移 | 中 | 提供迁移指南 + 示例 + 适配器模板 |
| DOMPurify 内联增加包体积 | 低 | ~8KB gzip，license 自动归集 |
| 胶囊语义（dot/aria/title）被 HTML 覆盖 | 中 | 胶囊框架保留外层按钮 + dot，`formatCapsule` 只返回内容段 |

## 7. 评审记录

- **评审 A（架构/兼容性）**：P0×3（契约判别信号、执行端定宿、provider 关联）、P1×5、P2×7
- **评审 B（模型配置/安全）**：P0×3（V2 不可行、热更新安全、全权限文档化）、P1×4、P2×5
- **评审 C（客户端/UX）**：P0×4（XSS 信任域、双运行时、provider 关联、双链路膨胀）、P1×5、P2×6
- 合并去重后修订：宿主端渲染、V1 配置链、契约补 `version:2`/`providers`/`label`、`esc`+ 净化器、管道化、存储目录键带 provider