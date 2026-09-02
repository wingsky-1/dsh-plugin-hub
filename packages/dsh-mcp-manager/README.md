# @wingsky-1/dsh-mcp-manager
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-mcp-manager)](https://www.npmjs.com/package/@wingsky-1/dsh-mcp-manager)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH（DeepSeek Harness）的 **MCP 服务器管理插件**：会话界面右上角浮窗 + 分级面板 +
快速接入（手工表单 + 粘贴 mcpServers JSON 导入，**不预设任何服务器**）。
MCP 协议客户端基于 `node:child_process` 与全局 `fetch` 直接实现，无需额外安装。

三档中间层模式（`middleware`）：`off`——全部服务器直呼 `mcp__<server>__<tool>`（旧行为）；
`project`（**默认**）——项目级走中间层、全局仍直呼；`all`——全局也走中间层
（含运行时注入的封装定义服务器如 codegraph），cwd 无项目时回落全局虚拟 root
`@global`，模型面完全收敛为四个原子工具
（`ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call`）。
`middleware` / `middlewarePolicy` 可在设置页热切换（保存即生效并持久化），
也可在配置文件中设置（插件启动时读取）；两级配置文件中的服务器列表（增删/启停/改配置）支持热加载、即时生效，无需重启。

## 核心优势

- **上下文成本可控**：项目级 MCP 默认经中间层收敛，模型面只占 `ws_mcp_list` /
  `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call` 四个原子工具位——当前工作空间
  的项目级接多少台服务器、多少个工具都不膨胀系统提示词；`middleware: all` 可把
  全局服务器也收进中间层，实现全量收敛（两级发现：`ws_mcp_list` 完整盘点 →
  `ws_mcp_detail` 按需拉完整 schema）
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
| 模型工具 | 全局服务器工具以 `mcp__<server>__<tool>` 注册（64 字符、`[A-Za-z0-9_-]`、冲突时哈希后缀）；项目级服务器默认经中间层 `ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call` 访问（`middleware: project`，推荐），不同工作空间互不冲突；`middleware: all` 时全局与运行时注入服务器（如 codegraph）也统一经中间层访问，不注册 `mcp__` 前缀 |
| 工作空间隔离 | 中间层按调用方会话当前 cwd 路由到对应工作空间的连接池；server 全名 `@<root>/<server>` 一致性校验防跨空间串台 |
| 断线重连 | 有界指数退避（500ms 起、30s 上限、10 次后停止后台重试；用户手动连接或 ws_mcp_call 触发可再试） |
| 结果截断 | 工具结果按 8KB 截断并标注（防超长 JSON 全量进上下文） |
| 超时下探 | 工具调用超时默认 60s → 15s（可按服务器 `toolCallTimeoutMs` 覆盖） |
| 状态推送自愈 | SSE 通道三重防护：服务端每 30s 发 data ping 心跳、客户端 60s 无帧即关旧建新（watchdog）、页面回前台强制重建连接——移动端切后台被系统静默掐断的半开连接可自愈，不堆积僵尸连接 |

## 配置（浮窗位置）

浮窗按钮（MCP 胶囊）的位置与偏移在 dsh **设置 → 插件 → MCP 管理器** 的插件卡中配置
（`position` / `offset`），走插件自身 `Config` 标准 cordis 配置注入，无需手改任何配置文件。

| 键 | 值域 | 默认 |
| --- | --- | --- |
| `position` | `top-right`（右上，默认）/ `top-left`（左上）/ `bottom-right`（右下）/ `bottom-left`（左下） | `top-right` |
| `offset.x` | 非负整数（水平偏移，单位 px） | `8` |
| `offset.y` | 非负整数（垂直偏移，单位 px） | `8` |
| `offset.blankY` | 非负整数（空白会话垂直偏移，单位 px） | `40` |
| `zIndexBase` | 整数，clamp 到 1–9000（浮窗层级基准；**胶囊与点击后弹出的主面板同取该配置值**，模态管理面板不受影响） | `10` |

当 `position = bottom-right` 或 `bottom-left` 时，下拉面板会**在胶囊上方展开**（底部
锚点向上弹出），不溢出视口、内容完整可见可点击；顶部锚点向下展开（历史行为，默认不变）。

**移动端 / 平板端适配**（issue #128）：断点判定基准是会话容器（conversationHost）
的视口宽度而非窗口媒体查询——窄屏（≤480px，手机竖屏 / 极窄分栏）下面板近全屏宽、
服务器卡片重排、操作按钮触控目标加大到 ≈44px；平板档（≤834px）过渡；桌面维持现状。
浮窗最终坐标经 JS 视口 clamp（safe-area 语义：宿主无 `viewport-fit=cover`，
`env(safe-area-inset-*)` 恒 0 时自然退化为普通 clamp）；软键盘弹出经
`visualViewport` resize 跟随，横竖屏切换后下一帧重算。

**跨包避让契约（源自 issue #116，不可回退）**：本插件浮窗默认 `top-right` 且距顶
8px、高约 26px；dsh-provider-usage 用量胶囊依赖这一默认位置以 `offsetY: 48`
在其正下方让位（两胶囊默认互不重叠）。修改本插件默认锚点 / 垂直偏移会使该避让
失效，属跨包行为契约，回退前须同步调整 provider-usage 默认值。

在设置页保存后即时生效，**无需重启 dsh web**、也无需手动刷新页面：宿主端经既有
SSE events 通道推送一变，客户端自动重新拉取 `/api/dsh-mcp/config` 并就地更新浮窗位置。

## 配置（中间层）

项目级 MCP 经中间层访问（`middleware: project`，默认）：项目级服务器不再注册
`mcp__` 工具，改经模型面四个原子工具访问（两级发现，业界标准形态）——
`ws_mcp_list`（完整盘点当前工作空间全部服务器 + 每台完整工具清单，不受
`ws_mcp_search` 的 limit 截断；支持 `server` 全名/裸名过滤，`perServerLimit`
每服务器工具条数上限默认 50 / 上限 500，超限置 `toolsTruncated`；空返回附明确
`message`，带 `server` 过滤 0 命中时 message 归因到过滤条件并列出可见项目级
服务器）/ `ws_mcp_detail`（按 `@<root>/<server>` + tool 裸名精确查询单工具
完整 `inputSchema`，错误三分：发现失败附原因 / 服务器未连接或未发现 / 工具
不存在）/ `ws_mcp_search`（关键词检索，先搜后调，输出 `truncated` 标志提示结果是否因
limit 截断）/ `ws_mcp_call`（按 `@<root>/<server>` 全名调用，参数 schema 用
`ws_mcp_detail` 核对），执行时按调用方会话当前 cwd 路由到对应工作空间
连接池，不同工作空间注入不同 MCP、无命名冲突；全局服务器仍直呼
`mcp__<server>__<tool>`（project 模式 detail/call 传全局级服务器会给出直呼引导）。
切换 `middleware: off` 回到旧行为（项目级也直接注册
`mcp__` 工具）；`middleware: all` 则全局服务器（含运行时注入的封装定义服务器，
如 dsh-codegraph 的 toolDefinitions）也走中间层（cwd 无项目时回落全局
虚拟 root `@global`），模型面完全收敛为四个原子工具——此时 list/search/detail
合并查询「项目 root 单元 + `@global` 单元」，call 放行 `@global` root（全局配置
跨工作空间共享，语义成立）。注：all 模式全局服务器增删改后需重启或触发会话
触达才刷新目录（既有行为）。

**中间层模式可在设置页热切换**（设置 → 插件 → MCP 管理器 → 中间层模式下拉），
保存即生效并持久化，无需重启 dsh web。

| 键 | 值域 | 默认 |
| --- | --- | --- |
| `middleware` | `off` / `project`（推荐）/ `all` | `project` |
| `middlewarePolicy` | `{ allowTools: {<serverKey>: [glob]}, denyTools: {<serverKey>: [glob]} }`（serverKey 为 `@<root>/<server>` 全名（工作空间隔离）或裸名（跨空间共用），全名优先；deny 优先） | `{}` |

### 工具级禁用（浮窗）

- 服务器卡片的「工具（N）」折叠区展开后为 **checkbox 列表**，逐个启停，点击即
  经 `PATCH /api/dsh-mcp/tool-disable` 持久化（落盘 `<DSH_HOME>/dsh-mcp-user-state.json`
  的 `disabledTools`，合并写盘、重启保留）；
- 语义：**project 模式只能禁用项目级服务器经中间层的工具；all 模式可禁用全局
  服务器（含 runtime 注入如 codegraph）经中间层的工具**；默认全部启用；
- 工具级禁用**独立于服务器级 enabled 开关**（服务器级复活不清工具级状态）；
- **作用于 mcp-manager 管辖的全部 MCP 工具**（mcp__ 前缀直呼与中间层 ws_mcp_*
  一致生效，all 模式 runtime 封装工具同样受控）；纪律裸名（dsh-codegraph 的
  `codegraph_explore` 等裸名直呼形态）不受影响（dsh-codegraph 侧由 #363 声明）；
- 超长工具名（>64 字符哈希后缀）不可逆 → 按未知 server 处理，不禁用/不误禁；
- project 模式浮窗显示全局服务器但无工具开关（全局工具此时经 supervisor 直呼，
  不经中间层），提示「切 all 模式可管理全局工具」；
- 浮窗与管理面板均按「项目级 / 全局级」两大分组展示（各自内部再按连接状态）。

## 路由（全部 loopback 围栏）

| 路由 | 说明 |
| --- | --- |
| `/api/dsh-mcp/health` | 健康检查（注意与目录名不同） |
| `/api/dsh-mcp/tool-disable` | 工具级禁用开关（PATCH，loopback-only） |
| `/api/dsh-mcp/*` | 服务器管理 / 连接控制 / 工具清单 / SSE 事件等 |

## 运行时注入（registerServer.toolDefinitions）

其他插件可经 `ctx.mcpManager.registerServer` 运行时注册 MCP 服务器（内存态不落盘，
同名幂等）。注册入参支持可选 `toolDefinitions`（调用方封装工具定义，`ToolDefinition[]`，
工具名用**裸名**，如 dsh-codegraph 的 `codegraph_explore`）：

- **有 `toolDefinitions`**：该服务器工具**全部用封装定义注册**——execute 来自调用方
  （如 dsh-codegraph 先 `codegraph sync` 再内部转发底层 CLI），跳过远端 schema 投影与
  通用 callTool，底层真实实现不外泄；
- **没有**：维持现状（远端 schema + 通用 callTool），其他服务器零影响；
- **命名仍由 manager 现有机制决定**：模型可见名为 `mcp__<server>__<tool>`（`publicToolName`，
  64 字符 / 哈希后缀规则不变）；all 模式经 `ws_mcp_call` 用裸名调用；
- **工具级禁用 / 可见性 / 能力目录对封装工具照常生效**（按服务器 + 工具名判定，与
  `mcp__` 前缀工具同口径）；
- 仅运行时注入面（runtimeRegistry）消费，不随 store 落盘、不随 mcpServers 导入透传。

```ts
await ctx.mcpManager.registerServer({
  name: "codegraph",
  transport: "stdio",
  command: "codegraph",
  args: ["serve", "--mcp"],
  toolDefinitions: [
    {
      name: "codegraph_explore",          // 裸名
      description: "查询 codegraph 代码图谱（先 sync 再查）",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      output: { schema: { ... }, render(args, value) { ... } },
      execute: async (args) => { await sync(); return forwarded; }, // 内部转发，不外泄
    },
  ],
});
```

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
- **中间层工具只读边界**：`ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` 纯读
  本地目录缓存（不触达远端服务器、不执行工具），不经过策略 guard；`ws_mcp_call`
  是唯一执行远端工具并受策略约束（deny 优先）的入口；`ws_mcp_call` 错误消息按
  「显式 + 下一步」规范给出（确认 server 连接 / 用 `ws_mcp_detail` 核对参数 /
  检查策略配置）
- **工具级禁用（三入口一致）**：`ws_mcp_call`（callTool 先查禁用表再查策略）、
  pre-execute guard（`mcp__` 前缀直呼工具）、纪律裸名（dsh-codegraph 侧 #363）
  统一走 `isToolDenied` 裁决；禁用只作用于 `mcp__` 前缀工具，拒绝原因附语义声明；
  禁用记录 `<DSH_HOME>/dsh-mcp-user-state.json` 的 `disabledTools`（`@global` key
  跨工作空间共享，合并写盘不整表覆盖）
- **凭据脱敏**：目录摘要与错误路径经 redactor 把 env/headers/URL 用户信息等
  凭据形状替换为 `[REDACTED]`
- 能力目录注入含来源标注与"不代表当前连接状态"说明

## 验证

测试单份维护、变异自动覆盖：单元测试只维护 `test/*.test.ts`（`import "../lib/index.js"` 测产物）；stryker 经 lib→src hook 复用同一份断言，无需手工同步副本。

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
- 中间层目录是「采集边界内的 last-good 快照」（单服务器 ≤512 工具 / ≤256KB 总量），
  发现失败时 list 透出 `unavailable` 原因
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
