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
| `baseUrl` | `https://opencode.ai/zen/go/v1/usage` | 用量接口地址（**可配置，即 token 转发目标**） |
| `timeoutMs` | `15000` | 请求超时（毫秒） |
| `cacheTtlMs` | `30000` | 用量缓存 TTL（毫秒） |
| `limits` | `{rolling:12, weekly:30, monthly:60}` | 展示用限额（美元/窗口） |
| `apiKey` | 无 | 显式 API Key（缺省走凭据解析链） |
| `maxAgeDays` | `14` | 历史采样保留天数（1–365） |
| `sampleIntervalMs` | `300000` | 宿主后台采样间隔（30s–1h） |
| `persistFile` | `<DSH_HOME>/dsh-opencode-usage/history.json` | 历史采样落盘路径 |

## 路由（全部 loopback 围栏）

| 路由 | 说明 |
| --- | --- |
| `GET /api/dsh-opencode-usage/stats` | 用量统计（TTL 缓存） |
| `GET /api/dsh-opencode-usage/history[?days=N]` | 历史采样序列 |
| `GET /api/dsh-opencode-usage/health` | 健康检查 |

## 安全与边界

- **token 不落盘、不落日志、不进浏览器端**：API Key 仅存于宿主进程内存，
  浏览器只经 `/stats` 拿百分比数值（`src/index.ts` 凭据解析链 + `stats` 路由
  均不回传 token）
- **`baseUrl` 可配置 = 你的 token 会发送到该地址**：仅配置可信的用量接口；
  默认官方 `https://opencode.ai/zen/go/v1/usage`
- 历史采样落盘 `0600` 权限（tmp + rename 原子写），目录默认
  `<DSH_HOME>/dsh-opencode-usage/`
- 所有路由 loopback 围栏（非回环 403 / 方法错 405）
- 官方接口请求频率受控：GUI 轮询 ≤1 次/60 秒 + 后台采样 ≤1 次/5 分钟
  （各另有 30s TTL 缓存抑制重复请求），不会限流

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-opencode-usage/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-opencode-usage build
node test/smoke.mjs
```

## License

MIT
