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
| `@wingsky-1/dsh-notifier` | 任务事件通知中心（6 类事件；浏览器 + 系统 toast 双通道 + Bark/Webhook 推送频道） |
| `@wingsky-1/dsh-provider-usage` | 多 provider 用量统计胶囊（v2 适配器框架：内置 DeepSeek 官方与 OpenCode Go，自写 mjs 接入任意数据源） |
| `@wingsky-1/dsh-lan-proxy` | 局域网访问 dsh web UI（HTTP/HTTPS/WS 转发 + TLS；Brotli/gzip 与 WebSocket 双压缩 + WS 半开探活 + 启动令牌自动注入） |
| `@wingsky-1/dsh-mcp-manager` | MCP 服务器管理器（stdio/HTTP；项目级/全局两级配置，项目级经中间层收敛为 4 个原子工具） |
| `@wingsky-1/dsh-web-file-preview` | 对话文件链接 web 端预览（图片 / Markdown（Mermaid）/ 代码高亮 / 文本 / Diff / HTML 沙箱 + 路径兜底搜索） |
| `@wingsky-1/dsh-verify-isolated` | 插件开发隔离验证 skill（DSH_HOME / profile / 端口 / 浏览器实例四重隔离 + 自带浏览器驱动） |

<details>
<summary><b>历史退役说明</b>——dsh-gzip / dsh-idle-archive / dsh-subagent-model-inherit（已退役）</summary>

`@wingsky-1/dsh-gzip` 已退役：HTTP 响应压缩合并进 dsh-lan-proxy，不再随全家桶
分发。此前单独安装过 dsh-gzip 的用户升级后请执行
`dsh plugin --profile web remove @wingsky-1/dsh-gzip` 卸载。

`@wingsky-1/dsh-idle-archive`（会话闲置提醒归档）与
`@wingsky-1/dsh-subagent-model-inherit`（子 Agent 模型继承）均已**退役**，不再随
全家桶分发：前者因社区已有更成熟的会话生命周期管理/归档实现，后者因官方
dsh-subagent 0.1.2-alpha.2 已原生实现 `resolveChildAgentOptions`。此前安装过的用户
请执行 `dsh plugin --profile web remove <包名>` 卸载。

</details>

> dsh-memory（项目长期记忆）未包含在本聚合包内。
>
> `@wingsky-1/dsh-codegraph`（codegraph MCP + worktree 开发纪律）为**独立发包**，
> 暂不包含在本聚合包内；如需使用请先安装本聚合包或 `dsh-mcp-manager` 后单独安装
> `dsh-codegraph`。

## 单独安装

只想用某个插件时单独安装（见各插件 README）：

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

## 安全提示

- `lan-proxy` 会在 0.0.0.0:<port> 监听端口并提供 HTTPS，使用前阅读其 README 安全说明。
- `mcp-manager` 会启动 MCP 服务器子进程（stdio）并执行其命令，仅配置可信服务器。
- `notifier` 在 Windows 通过 PowerShell WinRT 弹系统通知。
