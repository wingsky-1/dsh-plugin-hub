# @wingsky-1/dsh-mcp-manager
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-mcp-manager)](https://www.npmjs.com/package/@wingsky-1/dsh-mcp-manager)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH（DeepSeek Harness）的 **MCP 服务器管理插件**：会话界面右上角浮窗 + 分级面板 +
快速接入（手工表单 + 粘贴 mcpServers JSON 导入，**不预设任何服务器**）。
连接与协议交官方 `@deepseek-ai/dsh-mcp-client`（宿主 cordis loader 按包名装载到 dsh 安装内的副本），本插件只留配置面与模型可见面；官方客户端不随包分发，也无需额外安装。

模型可见面只有四个原子工具（`ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` /
`ws_mcp_call`）：项目级、全局级与运行时注入的封装定义条目**一律经中间层访问**，两级发现
（`ws_mcp_list` 完整盘点 → `ws_mcp_detail` 按需拉完整 schema）；cwd 无项目时回落全局虚拟
root `@global`。宿主仍按 `mcp__<id>__<tool>` 注册工具（`id` 是本次装配按
(工作空间, 服务器名) 分配的不透明短串，不能由服务器名推导），但这些名字**会被从模型的
工具列表中摘除**，禁止直呼。
两级配置文件中的服务器列表（增删/启停/改配置）支持热加载、即时生效，无需重启。
（`middleware` / `middlewarePolicy` 两个配置键已在 #767 笔 2 废除——旧配置里写了不生效、
也不会被本插件改写。）

> **升级后历史会话打不开？**
> 当前版本只生成 producer-owned V4 source；旧 source 仅通过一次性维护脚本处理，详见[升级与历史会话边界](#升级与历史会话边界)。

## 一键安装

```sh
dsh plugin --profile web add @wingsky-1/dsh-mcp-manager
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

## 核心优势

- **上下文成本可控**：全部 MCP 经中间层收敛，模型面只占 `ws_mcp_list` /
  `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call` 四个原子工具位——接多少台
  服务器、多少个工具都不膨胀系统提示词（两级发现：`ws_mcp_list` 完整盘点 →
  `ws_mcp_detail` 按需拉完整 schema）
- **分工作目录维护**：项目级配置 `<项目根>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json` 随仓库走、可提交 git 团队共享；
  全局配置 `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json` 常连；切换会话自动加载当前目录的 MCP 集
- **工作空间隔离**：中间层以会话 cwd 路由到对应连接池，server 全名一致性校验防跨空间
  串台；不同目录注入同名 server 也互不冲突
- **安全的默认值**：配置只存 `${ENV}` 引用、不落盘密钥本身（0600 权限 + 原子写入）；
  stdio 子进程环境净化，宿主凭据形状变量不透传；目录摘要与错误路径经 redactor 脱敏
- **运维省心**：运行中/连接中/失败等分级状态一目了然；断线有界指数退避自动重连；
  工具结果按 8KB 截断、调用超时可按 server 覆盖（`toolCallTimeoutMs`），
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
| 项目级 MCP | 服务器分「项目级 / 全局」两级：项目级存 `<项目根>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json`（随项目走、可提交 git），全局存 `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json` 常连 |
| 分级展示 | 运行中 / 连接中 / 重连中 / 未连接 / 已停用 / 失败；每台显示传输、端点、工具数；客户端未知状态按「未连接」投影、不丢卡（C13 统一口径） |
| 服务器管理 | 增删改查（可选项目级/全局）、连接 / 断开 / 重连；配置版本化 JSON，原子写入 |
| 两种传输 | stdio（本地子进程，env 支持 `${ENV}` 引用）与 streamable-http（远程，header 支持 `${ENV}` 引用，自动回传 `Mcp-Session-Id`） |
| JSON 导入 | 粘贴 mcpServers JSON 文本导入（仅 JSON 格式；不扫描任何应用配置文件） |
| 模型工具 | 全部服务器（项目级 / 全局 / runtime 注入）一律经中间层四个原子工具访问：`ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call`，不同工作空间互不冲突；宿主注册名 `mcp__<id>__<tool>`（`id` 按 (工作空间, 服务器名) 随机分配、同一次装配内稳定、不透明；工具名仍受 64 字符 / `[A-Za-z0-9_-]` / 冲突哈希后缀约束）会被从模型工具列表摘除——模型不可见、不得直呼 |
| 工作空间隔离 | 中间层按调用方会话当前 cwd 路由到对应工作空间的连接池；server 全名 `@<root>/<server>` 一致性校验防跨空间串台 |
| 断线重连 | 有界指数退避（500ms 起、30s 上限、10 次后停止后台重试；用户手动连接或 ws_mcp_call 触发可再试） |
| 结果截断 | 工具结果按 8KB 截断并标注（防超长 JSON 全量进上下文） |
| 超时下探 | 工具调用超时默认 60s → 15s（可按服务器 `toolCallTimeoutMs` 覆盖） |
| 状态推送自愈 | SSE 通道共享 sse-hub（#515）：服务端每 30s data ping 心跳 + stalled 超窗回收 + maxAge 轮换（120min 无业务帧主动断开）；客户端 60s 无帧即关旧建新（watchdog）、页面回前台强制重建；SSE 连续失败降级 10s 轮询，期间每 5 个轮询周期自动探测恢复推送（C2，页面失联自愈）——移动端切后台被静默掐断的半开连接由客户端自愈 + 服务端确定性回收，不堆积僵尸连接 |

## 配置（浮窗位置）

配置页入口：**Plugin Manager → dsh-mcp-manager → Configure**。浮窗按钮（MCP 胶囊）的位置与偏移（`position` / `offset`）在此保存，canonical row id 与 settings 条目 id 均为 `ui-dsh-mcp-manager`，保存后即时生效。

> 非回环 LAN 地址（例如 `192.168.*:3081`）默认不提供持久化设置面，Configure 按钮按 DSH 安全策略隐藏；请从 `127.0.0.1:3080` / `127.0.0.1:3081` 或 SSH 回环隧道管理。只有在可信 LAN、明确接受共享控制面风险时，才通过 dsh-lan-proxy 的 `ownsHostCompat` 恢复远程设置入口。

| 键 | 值域 | 默认 |
| --- | --- | --- |
| `position` | `top-right`（右上，默认）/ `top-left`（左上）/ `bottom-right`（右下）/ `bottom-left`（左下） | `top-right` |
| `offset.x` | 非负整数（水平偏移，单位 px） | `8` |
| `offset.y` | 非负整数（垂直偏移，单位 px） | `8` |
| `offset.blankY` | 非负整数（空白会话垂直偏移，单位 px） | `40` |
| `zIndexBase` | 整数，clamp 到 1–9000（浮窗层级基准；**胶囊与点击后弹出的主面板同取该配置值**，模态管理面板不受影响） | `10` |

#### RC7 旧 settings section 迁移

DSH 0.1.7-rc.1 会把旧的 `~/.dsh/settings.yaml` 改名为 `settings.yaml.imported`。
该文件是已消费旧文档的**审计副本**，不是当前配置源；不要复制整个 imported 文件。
迁移只消费旧 `dsh-mcp-manager` section 中当前设置页支持的 `ui` 子树，字段按
`settings.yaml.imported < settings.yaml < 当前 canonical user` 合并。其它顶层键，
包括已废弃的 `middleware`、`middlewarePolicy`，以及非 volatile 字段，明确丢弃，
不会写入 canonical patch。完成 marker 为插件私有目录中的 `settings.migrated`
（版本 `1`）。canonical 写入前先创建 `settings.migrated.pending` receipt，成功后
promote 为完成 marker；未知失败恢复只完成 marker、不重放旧值，避免 DSH `unset`
后把用户已清除的值写回；只有明确的 revision 冲突才清理 receipt 并重试。可编辑字段最终位于 active profile 的
`~/.dsh/profiles/<profile>/cordis.patch.yml`，canonical id 为 `ui-dsh-mcp-manager`。

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

全部 MCP 经中间层访问（单池，**没有模式开关**）：任何服务器都不产生模型可见的 `mcp__`
直呼工具，统一经四个原子工具访问（两级发现，业界标准形态）——
`ws_mcp_list`（完整盘点当前工作空间全部服务器 + 每台完整工具清单，不受
`ws_mcp_search` 的 limit 截断；支持 `server` 全名/裸名过滤，`perServerLimit`
每服务器工具条数上限默认 50 / 上限 500，超限置 `toolsTruncated`；空返回附明确
`message`，带 `server` 过滤 0 命中时 message 归因到过滤条件并列出可见项目级
服务器）/ `ws_mcp_detail`（按 `@<root>/<server>` + tool 裸名精确查询单工具
完整 `inputSchema`，错误三分：发现失败附原因 / 服务器未连接或未发现 / 工具
不存在）/ `ws_mcp_search`（关键词检索，先搜后调，输出 `truncated` 标志提示结果是否因
limit 截断）/ `ws_mcp_call`（按 `@<root>/<server>` 全名调用，参数 schema 用
`ws_mcp_detail` 核对），执行时按调用方会话当前 cwd 路由到对应工作空间
连接池，不同工作空间注入不同 MCP、无命名冲突；cwd 无项目时回落全局虚拟 root
`@global`，list/search/detail 恒合并查询「项目 root 单元 + `@global` 单元」，
call 放行 `@global` root（全局配置跨工作空间共享，语义成立）。宿主注册名形如
`mcp__<id>__<tool>`，`id` 不透明、以工具清单为准；它只作内部标识（模型工具列表里看不到），
封装定义条目（`toolDefinitions`）只经 `ws_mcp_call` 按 `@<root>/<server>` 触达。
注：全局服务器增删改后需重启或触发会话触达才刷新目录（既有行为）。

### 顶层配置键（Config schema）

顶层键（`packages/dsh-mcp-manager/src/server/config/config-schema.ts` 的 `Config`）默认值与语义：

| 键 | 默认值 | 语义 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用本插件（插件级总开关）。 |
| `announceToAgent` | `true` | 是否向 Agent 宣告插件（能力清单由 `<available_mcp_servers>` 承担）。 |
| `storePath` | 留空（默认 `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json`） | 全局服务器配置路径，留空用默认路径。 |
| `announceCatalog` | `true` | 是否注入 MCP 能力目录（`<available_mcp_servers>`）。 |
| `catalogMaxEntries` | `6` | 目录注入条目上限。 |
| `debug.callStats` | `false` | 是否开启调用统计调试与落盘（默认关闭，仅可通过配置文件开启；详见下节“调用统计与 Debug 模式”）。 |
| `debug.statsFile` | 留空（默认 `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/stats.json`） | 统计落盘路径，留空使用默认路径。 |
| `ui` | 见“配置（浮窗位置）”节（`position` 默认 `top-right`；`offset.x` / `offset.y` 默认 `8`，`blankY` 默认 `40`；`zIndexBase` 默认 `10`，clamp 到 1–9000） | 浮窗位置与层级配置，详见“配置（浮窗位置）”节。 |

**已废除的配置键**（#767 笔 2）：`middleware`（`off` / `project` / `all` 三档模式）与
`middlewarePolicy`（`allowTools` / `denyTools` 策略）。设置页的模式下拉已删除；旧配置里写了
这两个键**不报错也不生效**（键被原样带过、没有任何消费者），本插件也不会改写用户的配置文件。
工具级禁用是唯一的准入裁决。

**已退役的实现**：S1-5c 自研连接栈退役（`runtime/supervisor.ts`、`runtime/reconnect.ts` 等四文件整体退役，连接改走官方引擎）；W11b2a `src/types` 与 `src/integration` 删除（无迁移动作）。

### 工具级禁用（浮窗）

- 服务器卡片的「工具（N）」折叠区展开后为 **checkbox 列表**，逐个启停，点击即
  经 `PATCH /api/dsh-mcp/tool-disable` 持久化（落盘 `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/user-state.json`
  的 `disabledTools`，合并写盘、重启保留）；
- 语义：**项目级与全局级服务器的工具都可禁用**（单池后两类都经中间层；全局记录以
  `@global` 为 key 跨工作空间共享）；默认全部启用；
- 工具级禁用**独立于服务器级 enabled 开关**（服务器级复活不清工具级状态）；
- **作用于 mcp-manager 管辖的全部 MCP 工具**（mcp__ 前缀直呼与中间层 ws_mcp_*
  一致生效，runtime 封装工具同样受控）；插件侧自行声明的纪律裸名工具
  不受影响；
- 超长工具名（>64 字符哈希后缀）不可逆 → 按未知 server 处理，不禁用/不误禁；
- 浮窗与管理面板的「项目级」「全局级」分组**都渲染工具开关**（单池后两类都经中间层，
  全局组的开关同样生效）；
- 浮窗与管理面板均按「项目级 / 全局级」两大分组展示（各自内部再按连接状态）；
- 全名形态 `@@global/<name>` 或 `@<绝对路径>/<name>`（与宿主 `parseFullServerName`
  归一化一致）；宿主重启后 `projectRoot` 暂缺时客户端防御性跳过提交（不发送非法
  `@/name`，C6）；浮窗与管理面板的连接 / 断开 / 重连 / 启停操作携带当前会话 cwd，
  宿主重启场景可自愈恢复会话（C7）。

## 路由（全部 loopback 围栏）

| 路由 | 说明 |
| --- | --- |
| `/api/dsh-mcp/health` | 健康检查（注意与目录名不同） |
| `/api/dsh-mcp/tool-disable` | 工具级禁用开关（PATCH，loopback-only） |
| `/api/dsh-mcp/*` | 服务器管理 / 连接控制 / 工具清单 / SSE 事件等 |

## 运行时注入（registerServer.toolDefinitions）

其他插件可经 `ctx.mcpManager.registerServer` 运行时注册 MCP 服务器（内存态不落盘，
同名幂等）。注册入参支持可选 `toolDefinitions`（调用方封装工具定义，`ToolDefinition[]`，
工具名用**裸名**）：

- **有 `toolDefinitions`**：该服务器工具**全部用封装定义注册**——execute 来自调用方
  （调用方可先做预处理再内部转发底层命令），跳过远端 schema 投影与
  通用 callTool，底层真实实现不外泄；
- **没有**：维持现状（远端 schema + 通用 callTool），其他服务器零影响；
- **模型不可见 `mcp__` 直呼工具：只经 `ws_mcp_call` 用裸名调用**（`@<root>/<server>`
  + 裸名；封装的 execute 是调用方 JS，没有远端实现可直呼）。调用名派生仍走
  `publicToolName`（64 字符 / 哈希后缀规则不变），但它只作为中间层 callTool 的转发名；
- **工具级禁用 / 可见性 / 能力目录对封装工具照常生效**（按服务器 + 工具名判定，与
  `mcp__` 前缀工具同口径）；
- 仅运行时注入面（runtimeRegistry）消费，不随 store 落盘、不随 mcpServers 导入透传。

```ts
await ctx.mcpManager.registerServer({
  name: "my-mcp",
  transport: "stdio",
  command: "my-mcp-server",
  args: ["serve", "--mcp"],
  toolDefinitions: [
    {
      name: "my_tool",                    // 裸名
      description: "调用方自定义的封装工具",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      output: { schema: { ... }, render(args, value) { ... } },
      execute: async (args) => { await prepare(); return forwarded; }, // 内部转发，不外泄
    },
  ],
});
```

## 数据与安全

- 服务器配置：`<DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json`（仅存 `${ENV}` 引用，**不落盘密钥本身**）；
  落盘 0600 权限 + 原子写入
- 所有 `/api/dsh-mcp/*` 路由仅限 loopback 访问（非回环 403 / 方法错 405）
- **stdio 子进程环境净化（官方 dsh-mcp-client 口径）**：净化只作用于**继承的父环境**——
  凭据词根（`KEY` / `PASSWORD` / `SECRET` / `TOKEN`）与全部 `DSH_*` 变量从父环境摘掉，
  避免把宿主机密隐式透传给 MCP 子进程；**用户在配置里显式声明的 `env` 原样传给子进程**
  （显式层在净化之后合并）——`env` 不是脱敏面，要隔离就别往里写凭据
- **stdio 子进程继承宿主权限**：MCP 服务器命令在宿主进程权限下执行，
  仅配置可信的服务器
- **MCP 工具在真实服务器上执行，先确认再操作**；工具结果原样返回，
  可能含敏感信息；工具描述/结果按不可信输入对待
- **注入信任分级**：远端工具描述/结果为不可信输入，仅展示与传参，不作指令执行；本地配置与用户显式操作为可信
- **工作空间隔离（中间层）**：路由以调用方会话当前 cwd 为唯一输入；server
  全名一致性校验（参数声明的 root ≠ 路由 root → 拒绝）防跨空间串台；
  工具级禁用表按 `@<root>/<server>` 全名或裸名裁决（全名优先；`@global` 记录跨工作空间共享）
- **中间层工具只读边界**：`ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` 纯读
  本地目录缓存（不触达远端服务器、不执行工具）；`ws_mcp_call`
  是唯一执行远端工具的入口，并受工具级禁用表约束；`ws_mcp_call` 错误消息按
  「显式 + 下一步」规范给出（确认 server 连接 / 用 `ws_mcp_detail` 核对参数 /
  检查工具级禁用状态）
- **工具级禁用（三入口一致）**：`ws_mcp_call`（callTool 查禁用表）、
  pre-execute guard（`mcp__` 前缀直呼工具）、插件侧声明的纪律裸名工具
  统一走 `isToolDenied` 裁决；禁用只作用于 `mcp__` 前缀工具，拒绝原因附语义声明；
  禁用记录 `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/user-state.json` 的 `disabledTools`（`@global` key
  跨工作空间共享，合并写盘不整表覆盖）
- **凭据脱敏**：目录摘要与错误路径经 redactor 把 env/headers/URL 用户信息
  （username/password/searchParams）等凭据形状替换为 `[REDACTED]`；URL 主机与
  路径无凭据部分保留可读（可诊断性，B8 口径）；percent-encoding 的 raw 形态与
  decoded 形态双注册，防编码绕过；supervisor/manager 错误日志与 HTTP body 同口径
  脱敏
- **调用统计与 Debug 模式（Metadata-Only）**：默认关闭；启用后把 MCP 调用指标与渐进式披露漏斗防抖原子持久化至 `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/stats.json`，且控制台输出单行跟踪；严格不持久化用户 arguments 与返回 content
- 能力目录注入含来源标注与“不代表当前连接状态”说明
- **能力目录 source**：`ui-dsh-mcp-manager` 是 canonical row/settings 条目 id；目录消息的当前业务格式是 producer-owned V4：`{ kind: "plugin:@wingsky-1/dsh-mcp-manager", form: "snapshot", sections: [{ name: "mcp-catalog", text }] }`

<a id="升级与历史会话边界"></a>
## 升级与历史会话边界

当前写入与业务读取只认 producer-owned V4；本包不提供旧 V0/V2/V3 parser，也不把旧格式写成业务兼容。

旧 `mcp-catalog` source 属于一次性维护责任。`scripts/maintenance/repair-mcp-catalog-sessions.mjs` 只把旧 source 元数据修为 V3 wrapper，保留消息正文与事件序列；它不写 V4，也不实现或伪造 v3→v4 迁移。修复后由 `dsh 0.1.7-rc.1` 的官方迁移链依次恢复旧产物并转为 V4，当前 V4 产物不动。

```sh
# 先停止 dsh web；默认预演，只列出受影响会话
node scripts/maintenance/repair-mcp-catalog-sessions.mjs

# 核对后落盘；自动备份，随后重启 dsh web
node scripts/maintenance/repair-mcp-catalog-sessions.mjs --apply
```

默认处理 v0/v1/v2 与 v3 中残留的旧 source；`--legacy-only` 只处理 v0/v1/v2。脚本幂等，可用 `--home` 或 `DSH_HOME` 指定目录、用 `--session <id>` 限定单个会话。

## 验证

测试单份维护、变异自动覆盖：单元测试只维护 `test/*.test.ts`（`import "../lib/index.js"` 测产物）；stryker 经 lib→src hook 复用同一份断言，无需手工同步副本。

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-mcp/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-mcp-manager build
pnpm --filter @wingsky-1/dsh-mcp-manager test
```

## 已知限制

- **`mcp__` 注册名只作内部标识**：服务器由官方 dsh-mcp-client 装载，宿主注册名为
  `mcp__<id>__<tool>`，`id` 是按 (工作空间, 服务器名) 分配的 **随机短串**（同一次插件装配内
  稳定；插件重载或宿主重启后变化；不透明，不能由服务器名推导）。这些名字会被从模型工具列表
  摘除，模型经 `ws_mcp_call` 转发触达——**不要在任何脚本或提示词里写死工具名**，
  一律用 `ws_mcp_list` / `ws_mcp_detail` 取名字
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
