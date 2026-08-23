# @wingsky-1/dsh-provider-usage
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-provider-usage)](https://www.npmjs.com/package/@wingsky-1/dsh-provider-usage)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH（DeepSeek Harness）Web GUI 插件：**用量统计悬浮框**（v2 契约重构版）。

聊天界面右上角常驻悬浮胶囊，展示模型 provider 的用量信息；点击展开详情面板。
渲染在**宿主端**完成——用户适配器返回 HTML，客户端只做注入。

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-provider-usage
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-provider-usage
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

## 工作原理（v2）

```
宿主端（Node）                                客户端（浏览器）
─────────────────────────────                ─────────────────────
预热定时器(5min) ─┐
                  ├→ getStats()               60s 轮询 /stats
客户端轮询 ───────┘   │ Mutex 互斥锁              ↓
                      │ 60s 缓存              胶囊框架 ← capsuleHtml
                      │ 2s 取数超时           面板框架 ← panelHtml(/history)
                      ↓
                adapter.fetchData(ctx)   ← 用户 mjs（apiEndpoint/staticPath/apiKey 注入）
                      ↓
                按天分片 JSONL 历史落盘
                      ↓
                adapter.formatCapsule/Panel() → 净化 → HTML 下发
```

内置适配器 `opencode-go-builtin`（OpenCode Go 官方 `/v1/usage` 三窗口用量）开箱即用。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 插件开关 |
| `adapter` | 无 | 用户适配器 mjs 路径（缺省用内置 opencode-go） |
| `provider` | `opencode-go` | 关联的模型 provider 名 |
| `staticPath` | 无 | API 路径（注入 fetchData 入参，与 apiEndpoint 拼接） |
| `apiEndpoint` | 无 | API 基础地址（可选；显式配置优先于凭据链） |
| `apiKey` | 无 | 显式密钥（可选；缺省走凭据解析链，不进设置面板回显） |
| `historyDir` | `<DSH_HOME>/dsh-provider-usage/` | 历史存储根目录 |
| `warmupIntervalMs` | `300000` | 后台预热间隔（无客户端访问时保持历史连续） |
| `cacheDurationMs` | `60000` | 缓存新鲜度（毫秒） |
| `fetchTimeoutMs` | `2000` | fetchData 强制超时（500–30000ms） |
| `autoReload` | `false` | 热更新开关（编辑适配器文件后自动加载） |
| `maxDetailRows` | `5000` | /history 单次查询行数上限 |
| `maxAgeDays` | `30` | 历史保留天数 |
| `maxSizeMB` | `20` | 历史大小上限（MB，超限从最旧日文件删） |

## 密钥解析顺序（V1 配置链）

1. 插件配置 `apiKey`（显式指定）
2. 环境变量 `{PROVIDER}_API_KEY`（大写，连字符换下划线，如 `OPENCODE_GO_API_KEY`）
3. `<DSH_HOME>/.credentials.yaml` 中的 `{PROVIDER}_API_KEY`
4. opencode-go 兼容：环境变量 `OPENCODE_GO_API_KEY`、
   `~/.local/share/opencode/auth.json` 的 `opencode-go` 条目

## 路由（全部 loopback 围栏）

| 路由 | 说明 |
| --- | --- |
| `GET /api/dsh-provider-usage/stats?provider=X` | 用量统计 + `capsuleHtml`（胶囊内容）+ `status`/`adapterVersion` |
| `GET /api/dsh-provider-usage/history?provider=X&days=N` | 历史查询 + `panelHtml`（面板内容）+ `truncated` 标记 |
| `GET /api/dsh-provider-usage/health` | 健康检查 + 适配器快照 + 错误登记 |
| `GET /api/dsh-provider-usage/adapter.mjs` | 用户适配器文件静态服务（供浏览器查看；未配置时 404） |

## 适配器开发指南（v2 契约）

写一个 mjs 文件即可接入任意数据源（完整示例见 `examples/usage-adapter.example.mjs`）：

```js
// my-stats.mjs
export const version = 2;                    // 必填：契约版本（固定 2）
export const name = "my-stats";              // 必填：唯一名（^[A-Za-z0-9_-]{2,64}$）
export const label = "我的统计";              // 可选：展示名
export const providers = ["my-relay"];       // 必填：认领的 provider 列表
export const retention = { maxAgeDays: 30 }; // 可选：留存策略

/** 必填：获取原始数据（宿主端执行；入参由插件注入） */
export async function fetchData({ apiEndpoint, staticPath, apiKey, signal, timeoutMs }) {
  const res = await fetch(apiEndpoint + staticPath, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json(); // 只返回展示所需的最小数据集
}

/** 必填：胶囊内容（宿主端执行，返回 HTML 字符串） */
export function formatCapsule({ data, status, esc }) {
  return `<span style="font-weight:600">${esc(data.visits ?? 0)} 次</span>`;
}

/** 必填：面板内容（宿主端执行，返回 HTML 字符串） */
export function formatPanel({ entries, range, truncated, esc }) {
  const rows = entries.slice(-60).map((e) =>
    `<tr><td>${esc(new Date(e.time).toLocaleString("zh-CN"))}</td><td>${esc(e.data.visits)}</td></tr>`).join("");
  return `<table>${rows}</table>`;
}
```

**接线配置**（推荐设置页承载，无需手改配置文件）：

1. 打开 dsh 设置 → 插件 →「用量统计」
2. 在目标 provider 下点「+ 添加适配器」，输入 mjs 文件路径（支持 `~` 展开 / 绝对路径）
3. 点「检测文件」回显导出信息 → 确认添加（自动持久化 + 热注册为该 provider 启用者）
4. 切换启用 / 停用：候选行开关实时生效并持久化

也兼容 cordis.patch.yml 声明（可选，配置态叠加）：

```yml
plugins:
  '@wingsky-1/dsh-provider-usage':
    adapter: ~/dsh/my-stats.mjs
    provider: my-relay
    staticPath: /api/usage
    autoReload: true        # 编辑 mjs 后自动热更新
```

加载失败 fail-fast 拒收并登记错误（设置面板可见），不影响插件其余功能。路径安全：相对路径只允许落在 `DSH_HOME` 或插件 home 内，未规整形态（`../` 穿越）一律 400 拒绝。

### v1 → v2 迁移

| v1（旧） | v2（新） |
| --- | --- |
| `fetchUsage(ctx)` 返回归一化 ProviderUsage | `fetchData(ctx)` 返回原始对象（只包装 `{time,data}` 入库） |
| 客户端渲染器 `.js` + 全局桥接注册 | `formatCapsule`/`formatPanel` 返回 HTML（宿主端渲染） |
| `id` 字段 | `name` 字段（白名单校验更严） |
| `summarize`/`samplePoint`/windows | 移除——胶囊/面板直接由 format 函数产出 |
| 设置页运行时添加/切换适配器（v1 既有） | **保留**：设置页「用量统计」承载（检测/添加/切换/停用，自动持久化）；cordis.patch.yml 声明仅为可选叠加 |

## 安全模型

- **适配器代码 = 宿主完整 Node 权限**（网络/文件/环境变量），等同用户自己写的进程内插件；
  仅加载你信任的本地文件，插件绝不从网络拉取执行代码
- **密钥不进浏览器端**：apiKey 仅存于宿主进程内存，经入参注入 fetchData；
  适配器文件即使被静态服务暴露也不含密钥值
- **XSS 双层防护**：外部 API 数据流入 HTML 前必须经 `esc()` 助手转义（文档义务）；
  插件在宿主端对所有 format 输出做结构化净化兜底（script/iframe/on* 属性/javascript: 协议移除）
- **热更新安全**：默认关闭；开启后以 mtime+size 轮询检测变化，新版校验通过才原子切换，
  失败保留旧版并登记错误
- **超时纪律**：fetchData 强制 2s 超时 + AbortSignal 传递；锁忙时不排队、直接降级返回缓存——
  任何情况下不阻塞页面其他请求
- **fail-fast 加载**：适配器缺导出/类型错/name 不合白名单 → 拒绝加载并登记可排障错误
- **历史数据**：按天分片 JSONL 落盘（`0600` 权限），超龄/超量自动清理；
  原始 data 在落盘前经过序列化校验（不可序列化对象拒收）
- 所有路由 loopback 围栏（非回环 403 / 方法错 405）；管理端点信息面最小披露
  （用户文件只显示 basename）；请求频率受控（轮询 ≤1 次/60s + 预热 ≤1 次/5min + 60s TTL 缓存）

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-provider-usage/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-provider-usage build
node test/smoke.ts
```

## License

MIT