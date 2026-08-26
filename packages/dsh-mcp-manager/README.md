# @wingsky-1/dsh-mcp-manager
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-mcp-manager)](https://www.npmjs.com/package/@wingsky-1/dsh-mcp-manager)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH（DeepSeek Harness）的 **MCP 服务器管理插件**：会话界面右上角浮窗 + 分级面板 +
快速接入（手工表单 + 粘贴 mcpServers JSON 导入，**不预设任何服务器**）。
MCP 协议客户端基于 `node:child_process` 与全局 `fetch` 直接实现，无需额外安装。

三档中间层模式（`middleware`）：`off`——全部服务器直呼 `mcp__<server>__<tool>`（旧行为）；
`project`（**默认**）——项目级走中间层、全局仍直呼；`all`——全局也走中间层，
cwd 无项目时回落全局虚拟 root `@global`，模型面完全收敛为两个原子工具。
注意生效时机：`middleware` / `middlewarePolicy` 只在插件启动时读取，**变更后需重启
`dsh web`**；两级配置文件中的服务器列表（增删/启停/改配置）支持热加载、即时生效，
无需重启。

## 核心优势

- **上下文成本可控**：项目级 MCP 默认经中间层收敛，模型面只占 `ws_mcp_search` /
  `ws_mcp_call` 两个原子工具位——当前工作空间的项目级接多少台服务器、多少个工具都
  不膨胀系统提示词；`middleware: all` 可把全局服务器也收进中间层，实现全量收敛
- **分工作目录维护**：项目级配置 `<项目根>/.dsh/mcp.json` 随仓库走、可提交 git 团队共享；
  全局配置 `<DSH_HOME>/dsh-mcp.json` 常连；切换会话自动加载当前目录的 MCP 集
- **工作空间隔离**：中间层以会话 cwd 路由到对应连接池，server 全名一致性校验防跨空间
  串台；不同目录注入同名 server 也互不冲突
- **安全的默认值**：配置只存 `${ENV}` 引用、不落盘密钥本身（0600 权限 + 原子写入）；
  stdio 子进程环境净化，宿主凭据形状变量不透传；目录摘要与错误路径经 redactor 脱敏
- **运维省心**：运行中/连接中/失败等分级状态一目了然；断线有界指数退避自动重连；
  直连模式下工具结果按 8KB 截断、调用超时可按 server 覆盖（`toolCallTimeoutMs`），
  中间层调用超时固定 30s

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
| 模型工具 | 全局服务器工具以 `mcp__<server>__<tool>` 注册（64 字符、`[A-Za-z0-9_-]`、冲突时哈希后缀）；项目级服务器默认经中间层 `ws_mcp_search` / `ws_mcp_call` 访问（`middleware: project`，推荐），不同工作空间互不冲突 |
| 工作空间隔离 | 中间层按调用方会话当前 cwd 路由到对应工作空间的连接池；server 全名 `@<root>/<server>` 一致性校验防跨空间串台 |
| 断线重连 | 有界指数退避（500ms 起、30s 上限、10 次后停止后台重试；用户手动连接或 ws_mcp_call 触发可再试） |
| 结果截断 | 工具结果按 8KB 截断并标注（防超长 JSON 全量进上下文） |
| 超时下探 | 工具调用超时默认 60s → 15s（可按服务器 `toolCallTimeoutMs` 覆盖） |

## 配置（浮窗位置）

浮窗按钮（MCP 胶囊）的位置与偏移在 dsh **设置 → 插件 → MCP 管理器** 的插件卡中配置
（`position` / `offset`），走插件自身 `Config` 标准 cordis 配置注入，无需手改任何配置文件。

| 键 | 值域 | 默认 |
| --- | --- | --- |
| `position` | `top-right`（右上，默认）/ `bottom-right`（右下） | `top-right` |
| `offset.x` | 非负整数（水平偏移，单位 px） | `8` |
| `offset.y` | 非负整数（垂直偏移，单位 px） | `8` |
| `offset.blankY` | 非负整数（空白会话垂直偏移，单位 px） | `40` |

当 `position = bottom-right` 时，下拉面板会**在胶囊上方展开**（底部锚点向上弹出），
不溢出视口、内容完整可见可点击；`top-right` 时向下展开（历史行为，默认不变）。

在设置页保存后即时生效，**无需重启 dsh web**、也无需手动刷新页面：宿主端经既有
SSE events 通道推送一变，客户端自动重新拉取 `/api/dsh-mcp/config` 并就地更新浮窗位置。

## 配置（中间层）

项目级 MCP 经中间层访问（`middleware: project`，默认）：项目级服务器不再注册
`mcp__` 工具，改经模型面两个原子工具访问——`ws_mcp_search`（先检索当前工作空间 MCP
工具）/ `ws_mcp_call`（按 `@<root>/<server>` 全名调用），执行时按调用方会话当前 cwd
路由到对应工作空间连接池，不同工作空间注入不同 MCP、无命名冲突；全局服务器仍直呼
`mcp__<server>__<tool>`。切换 `middleware: off` 回到旧行为（项目级也直接注册 `mcp__`
工具）；`middleware: all` 则全局服务器也走中间层（cwd 无项目时回落全局虚拟 root
`@global`），模型面完全收敛为两个原子工具。

| 键 | 值域 | 默认 |
| --- | --- | --- |
| `middleware` | `off` / `project`（推荐）/ `all` | `project` |
| `middlewarePolicy` | `{ allowTools: {<serverKey>: [glob]}, denyTools: {<serverKey>: [glob]} }`（serverKey 为 `@<root>/<server>` 全名（工作空间隔离）或裸名（跨空间共用），全名优先；deny 优先） | `{}` |

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
- **工作空间隔离（中间层）**：路由以调用方会话当前 cwd 为唯一输入；server
  全名一致性校验（参数声明的 root ≠ 路由 root → 拒绝）防跨空间串台；
  策略 guard（allowTools/denyTools，deny 优先）按 `@<root>/<server>` 全名或裸名配置（全名优先，工作空间隔离）
- **凭据脱敏**：目录摘要与错误路径经 redactor 把 env/headers/URL 用户信息等
  凭据形状替换为 `[REDACTED]`
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

## 类型依赖

宿主端类型来自官方 `@deepseek-ai/*` 包（`cordis` / `dsh-host-webserver` / `dsh-agent` /
`dsh-tools` / `dsh-system-prompt`，版本统一锁在仓库 `pnpm-workspace.yaml` catalog，
随 DSH 发布节奏升级）：**仅 `import type` 编译期使用**，编译产物零官方运行时导入。
包以 optional peerDependencies 声明这一宿主耦合；对插件做类型检查的消费者需可解析
这些官方包（跳过类型检查则无影响）。

## License

MIT
