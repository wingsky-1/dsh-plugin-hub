# @wingsky-1/dsh-mcp-manager
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-mcp-manager)](https://www.npmjs.com/package/@wingsky-1/dsh-mcp-manager)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH（DeepSeek Harness）的 **MCP 服务器管理插件**：会话界面右上角浮窗 + 分级面板 +
快速接入（手工表单 + 粘贴 mcpServers JSON 导入，**不预设任何服务器**），支持
**项目级 MCP 跟随会话切换**。已连接服务器的工具以 `mcp__<serverName>__<rawName>`
注册给模型直接调用。MCP 协议客户端基于 `node:child_process`
与全局 `fetch` 直接实现，无需额外安装。

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-mcp-manager
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-mcp-manager
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-mcp-manager
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-mcp-manager@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-mcp-manager
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-mcp-manager
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-mcp-manager
```

## 能力

| 能力 | 说明 |
| --- | --- |
| 右上角浮窗 | 状态点 + 计数摘要（`MCP 2/3`），点击展开下拉面板；随会话切换自动刷新 |
| 项目级 MCP | 服务器分「项目级 / 全局」两级：项目级存 `<项目根>/.dsh/mcp.json`（随项目走、可提交 git），全局存 `<DSH_HOME>/dsh-mcp.json` 常连 |
| 分级展示 | 运行中 / 连接中 / 重连中 / 未连接 / 已停用 / 失败；每台显示传输、端点、工具数 |
| 服务器管理 | 增删改查（可选项目级/全局）、连接 / 断开 / 重连；配置版本化 JSON，原子写入 |
| 两种传输 | stdio（本地子进程，env 支持 `${ENV}` 引用）与 streamable-http（远程，header 支持 `${ENV}` 引用，自动回传 `Mcp-Session-Id`） |
| JSON 导入 | 粘贴 mcpServers JSON 文本导入（仅 JSON 格式；不扫描任何应用配置文件） |
| 模型工具 | 已连接服务器的工具以 `mcp__<server>__<tool>` 注册（64 字符、`[A-Za-z0-9_-]`、冲突时哈希后缀） |
| 断线重连 | 指数退避（500ms 起、30s 上限、10 次后放弃并注销工具） |
| 结果截断 | 工具结果按 8KB 截断并标注（防超长 JSON 全量进上下文） |
| 超时下探 | 工具调用超时默认 60s → 15s（可按服务器 `toolCallTimeoutMs` 覆盖） |

## 路由（全部 loopback 围栏）

| 路由 | 说明 |
| --- | --- |
| `/api/dsh-mcp/health` | 健康检查（注意与目录名不同） |
| `/api/dsh-mcp/*` | 服务器管理 / 连接控制 / 工具清单 / SSE 事件等 |

## 数据与安全

- 服务器配置：`<DSH_HOME>/dsh-mcp.json`（仅存 `${ENV}` 引用，**不落盘密钥本身**）；
  落盘 0600 权限 + 原子写入
- 所有 `/api/dsh-mcp/*` 路由仅限 loopback 访问（非回环 403 / 方法错 405）
- **stdio 子进程环境净化**：父环境去除凭据形状（KEY/TOKEN/SECRET/PASSWORD…）
  与陈旧 `DSH_*` 变量后再合并显式 env——避免把宿主机密透传给 MCP 子进程
- **stdio 子进程继承宿主权限**：MCP 服务器命令在宿主进程权限下执行，
  仅配置可信的服务器
- **MCP 工具在真实服务器上执行，先确认再操作**；工具结果原样返回，
  可能含敏感信息；工具描述/结果按不可信输入对待
- 能力目录注入含来源标注与"不代表当前连接状态"说明

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-mcp/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-mcp-manager build
node test/smoke.mjs
```

## 已知限制

- 不订阅 MCP 的 `tools/list_changed` 通知（无 SSE 长连接）；工具列表变化在
  重连 / 手动刷新时重新同步
- 仅桥接工具能力；MCP 的 resources 与 prompts 尚无 harness 消费接口
- 依赖 Node ≥ 20

## License

MIT
