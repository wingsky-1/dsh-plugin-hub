# @wingsky-1/dsh-opencode-usage
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-opencode-usage)](https://www.npmjs.com/package/@wingsky-1/dsh-opencode-usage)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH（DeepSeek Harness）Web GUI 插件：**OpenCode Go 套餐用量悬浮框 + 三窗口迷你图**。

聊天界面右上角常驻悬浮胶囊，实时显示 OpenCode Go 套餐三窗口消耗百分比
（颜色随消耗程度变化：>80% 黄、>95% 红），点击展开详情面板：

- 三张迷你图卡片（rolling 5 小时滚动 / weekly / monthly），各窗口独立自适应
  y 轴与 x 轴时间刻度、100% 配额参考虚线、重置标记线（按 resetsAt 反推）
- 后台采样保历史连续（浏览器关闭也持续），数据来自官方 `/v1/usage` 接口
  （权威数据，零本地计算）

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-opencode-usage
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-opencode-usage
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-opencode-usage
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-opencode-usage@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-opencode-usage
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-opencode-usage
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-opencode-usage
```

## 数据源

插件直接调用 OpenCode Go 官方用量接口：

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

响应带 30 秒 TTL 缓存（可配置），避免高频请求。

## API Key 解析顺序

1. 插件配置 `config.apiKey`（显式指定，可选）
2. 环境变量 `OPENCODE_GO_API_KEY`
3. DSH 凭据文件 `<DSH_HOME>/.credentials.yaml`（DSH_HOME 优先，默认 `~/.dsh`）
   中的 `OPENCODE_GO_API_KEY`
4. OpenCode 自身 `~/.local/share/opencode/auth.json` 的 `opencode-go`
   （回退 `opencode`）条目

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 插件开关 |
| `baseUrl` | `https://opencode.ai/zen/go/v1/usage` | 内置 opencode-go 用量接口地址（**可配置，即 token 转发目标**） |
| `timeoutMs` | `15000` | 请求超时（毫秒） |
| `cacheTtlMs` | `30000` | 用量缓存 TTL（毫秒） |
| `limits` | `{rolling:12, weekly:30, monthly:60}` | 展示用限额（美元/窗口） |
| `apiKey` | 无 | 显式 API Key（缺省走凭据解析链） |
| `maxAgeDays` | `30` | 历史采样保留天数（1–365） |
| `sampleIntervalMs` | `300000` | 宿主后台采样间隔（30s–1h；遍历所有已启用适配器） |
| `persistFile` | 无（默认历史根 `<DSH_HOME>/dsh-opencode-usage/`，多文件桶存于其 `history/` 子目录） | 历史根目录覆盖（其目录为历史根） |
| `adapters.host[]` | 无 | 自定义宿主取数适配器候选（`provider`/`file`/`enabled`，见下节） |
| `adapters.client[]` | 无 | 自定义客户端渲染器文件（`file`） |

### 适配器候选与启用

同一 provider 允许多个候选适配器（内置 + 用户注入），**任一时刻只启用一个**：

- 内置 `opencode-go-builtin` 默认启用；
- 配置中显式列出的用户适配器默认启用（成为该 provider 当前启用者），`enabled: false` 可显式关闭；
- 运行时切换：设置面板（M3b）或 `POST /api/dsh-opencode-usage/adapters/select`
  （body `{ provider, adapterId }`），切换后该 provider 缓存立即失效；
- 当前会话 provider 无启用适配器时浮窗隐藏，恢复启用后自动重现。

## 路由（全部 loopback 围栏）

| 路由 | 说明 |
| --- | --- |
| `GET /api/dsh-opencode-usage/stats[?provider=X]` | 用量统计 + 内嵌 `summary` 子树（胶囊轻量内容）+ `adapterId`/`hasAdapter` |
| `GET /api/dsh-opencode-usage/history[?provider=&adapterId=&days=N]` | 历史采样序列（含 `columns` 列声明） |
| `GET /api/dsh-opencode-usage/adapters.json` | 适配器候选元数据（id/label/providers/source/file/enabled） |
| `POST /api/dsh-opencode-usage/adapters/select` | 切换启用适配器（body `{provider, adapterId}`） |
| `GET /api/dsh-opencode-usage/user/<n>.js` | 用户客户端渲染器静态服务 |
| `GET /api/dsh-opencode-usage/health` | 健康检查 + 适配器快照 |

## Provider 适配器开发指南

自定义一个中转站只需两个文件（完整示例见
`docs/opt/usage-provider-adapter/examples/my-relay/`）：

**1. 宿主取数适配器 `.mjs`**（默认导出契约对象）：

```js
export default {
  version: 1,
  id: "my-relay",            // 适配器唯一名（设置面板候选展示）
  label: "我的中转站",
  providers: ["my-relay"],   // 认领的 provider 名
  async fetchUsage(ctx) {    // 必选：拉数并归一化
    const res = await ctx.fetch("https://relay.example.com/v1/usage");
    const body = await res.json();
    return { ok: true, provider: "my-relay", label: "我的中转站",
             fetchedAt: Date.now(), data: body };   // data 格式自定
  },
  // 可选 summarize(ctx)：自定义胶囊文案（只准从 ctx.usage 派生，禁止联网）
  // 可选 samplePoint(usage)：声明历史采样列 { cols, values }
};
```

推荐用工厂降载（自动派生 summarize/samplePoint）：

```js
import { defineUsageAdapter } from "@wingsky-1/dsh-opencode-usage";
export default defineUsageAdapter({
  id: "my-relay", label: "我的中转站", providers: ["my-relay"],
  windows: [{ key: "credit", name: "额度", limit: 100 }],
  async fetchUsage(ctx) { /* ...返回含 windows 的数据 */ },
});
```

**2. 客户端渲染器 `.js`**（自注册到全局桥接）：

```js
window.__DSH_USAGE__?.registerRenderer({
  version: 1,
  providers: ["my-relay"],
  adapterId: "my-relay",     // 可选：绑定适配器；缺省为该 provider 默认渲染器
  pill(summary) { return null; },  // 可选：自定义胶囊文案
  render(ctx) {              // 必选：画进 ctx.mount，返回清理函数（可选）
    const div = document.createElement("div");
    div.textContent = JSON.stringify(ctx.data?.data ?? {});
    ctx.mount.appendChild(div);
  },
});
```

**接线配置**（cordis.patch.yml / 用户 patch 层）：

```yml
plugins:
  ui-dsh-opencode-usage:
    adapters:
      host:
        - provider: my-relay
          file: ~/.dsh/my-relay-host.mjs
      client:
        - file: ~/.dsh/my-relay-client.js
```

路径支持 `~` 展开 / 绝对路径 / 相对 DSH_HOME。加载失败只 warn + 该候选不注册，
不阻断插件其余功能。

## 安全模型

- **token 不落盘、不落日志、不进浏览器端**：API Key 仅存于宿主进程内存，
  浏览器只经 `/stats` 拿展示字段
- **`baseUrl` 可配置 = 你的 token 会发送到该地址**：仅配置可信的用量接口；
  默认官方 `https://opencode.ai/zen/go/v1/usage`
- **stripSecrets 护栏（默认开，`stripSecrets: false` 关）**：对归一化返回
  （含 summary 文案字段）做两层脱敏——键名含 `secret/token/key/apikey` 且值为字符串
  （≥8 字符）→ 替换 `<redacted>`；值命中疑似密钥模式（`Bearer xxx` / `sk-xxx` /
  `api_key=xxx` / 长 hex）→ 整值脱敏。护栏是尽力而为，**不承诺绝对隔离**
- **用户自定义宿主 js = 完整 Node 权限**（网络/文件/环境变量），等同用户自己写的
  插件进程；仅加载你信任的本地文件，插件绝不从网络拉取执行
- **用户自定义客户端 js** 与其它 web 插件同信任级（浏览器沙箱内），经版本化桥接
  注册（契约不符只 warn 跳过）
- 历史采样多文件落盘（每 `(provider, adapterId)` 一桶一文件，`0600` 权限 tmp+rename
  原子写）；旧版单文件升级时重命名 `.bak` **保留不删除，由用户自行清理**
- 所有路由 loopback 围栏（非回环 403 / 方法错 405）；`select` 接口参数限长 128
- 官方接口请求频率受控：GUI 轮询 ≤1 次/60 秒 + 后台采样 ≤1 次/5 分钟
  （各另有 30s TTL 缓存抑制重复请求），不会限流

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-opencode-usage/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-opencode-usage build
node test/smoke.ts
```

## License

MIT
