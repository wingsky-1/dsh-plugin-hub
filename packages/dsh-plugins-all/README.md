# @wingsky-1/dsh-plugins-all
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH 插件全家桶**聚合包**：安装本包 = 一键装齐全部功能插件。

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-plugins-all
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-plugins-all
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-plugins-all
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-plugins-all@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-plugins-all
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-plugins-all
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-plugins-all
```

## 包含的插件

| 包 | 功能 |
|---|---|
| `@wingsky-1/dsh-notifier` | 审批/完成/错误事件通知（浏览器 Notification + 系统 toast） |
| `@wingsky-1/dsh-opencode-usage` | OpenCode Go 套餐用量悬浮框 |
| `@wingsky-1/dsh-lan-proxy` | 局域网访问 dsh web UI（HTTP/HTTPS/WS + TLS） |
| `@wingsky-1/dsh-mcp-manager` | MCP 服务器管理器（stdio/HTTP，工具注册给模型） |
| `@wingsky-1/dsh-idle-archive` | 会话闲置提醒归档 |
| `@wingsky-1/dsh-gzip` | /api 响应 gzip 压缩 |

> dsh-memory（项目长期记忆）未包含在本聚合包内。

## 单独安装

只想用某个插件时单独安装（见各插件 README）：

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

## 安全提示

- `lan-proxy` 会在 0.0.0.0:<port> 监听端口并提供 HTTPS，使用前阅读其 README 安全说明。
- `mcp-manager` 会启动 MCP 服务器子进程（stdio）并执行其命令，仅配置可信服务器。
- `notifier` 在 Windows 通过 PowerShell WinRT 弹系统通知。
