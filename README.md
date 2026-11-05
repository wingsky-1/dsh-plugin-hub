# dsh-plugin-hub

[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![CI](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wingsky-1/dsh-plugin-hub)](LICENSE)

<p align="center">
  <img src=".github/assets/banner.png" alt="DSH Plugin Hub">
</p>

**简体中文** | [English](README.en.md)

## 维护状态：有限维护

我目前已暂时停止使用 DeepSeek Harness，本项目转入有限维护阶段。后续优先评估用户反馈的可复现缺陷，尤其是安全、数据完整性与核心功能问题；上游 rc 版本适配按实际需求、改动成本和个人精力评估，不保证逐版跟进，也不承诺固定的响应、修复或发布时间。

新功能、全面重构与 1.0.0 重写计划暂时搁置。仓库与已发布包继续保留，欢迎社区修复、fork 或讨论接手维护；PR 按精力评审，不保证及时合并。兼容范围以本 README 和对应发布说明为准，不承诺 alpha 兼容。

完整说明与交接讨论见[维护状态公告](https://github.com/wingsky-1/dsh-plugin-hub/issues/1121)。

DSH（DeepSeek Harness）Web GUI 插件集，npm 分发：一键装全家桶，或按需单装。

- 聚合包：`@wingsky-1/dsh-plugins-all`（一键装齐全部插件）
- 单插件：`@wingsky-1/dsh-*`（按需安装）
- 当前源码树维护 5 个包：1 个聚合包与 4 个功能包；聚合包包含这 4 个功能包

## 快速导航

[使用前须知](#使用前须知) · [最短上手](#最短上手) · [插件列表](#插件列表) · [常用配置与维护](#常用配置与维护) · [验证与排障](#验证与排障) · [详细参考](#详细参考) · [开发与架构](#开发与架构)

<a id="使用前须知"></a><a id="user-content-使用前须知"></a>
## 使用前须知

### 版本适配（只适配 rc）

本插件集当前只适配 DeepSeek Harness `0.2.2-rc.1`（Cordis `4.1.0`）。

> `0.2.11` 对应以下 rc.1 基线，`0.2.10` 对应旧 rc.2 基线。安装前请确认目标插件版本已在 registry 发布，并与使用的 DSH 版本匹配。

- `pnpm-workspace.yaml` 的官方类型层 catalog 是权威版本事实源；本分支各包 peerDependencies 是维护流程生成的精确版本投影，锁定 `dsh 0.2.2-rc.1` 与 Cordis `4.1.0`；其他 DSH 版本不在本轮支持范围
- 运行 DSH `0.2.2-rc.1` 要求 Node `>=24.9`；本仓本地测试直接用原生 type stripping 跑 TS 的 Node `>=23.6` 是开发工具门槛，两者不可混用
- 升级顺序：先停止正在运行的旧 `dsh web` 并备份插件配置与会话数据，再把 DSH CLI 升级到 `0.2.2-rc.1`，然后通过 `dsh plugin ... update` 将插件更新到 `0.2.11`，最后启动并验收。发布或安装制品可以先于使用端升级，但旧 CLI 不能正常安装或加载新插件；不要用 `allow-version` 绕过 peer 校验
- 每版的具体适配基线、破坏性变更与升级指南见 [Release Notes](docs/release-notes/)
- catalog 更新前，不对 alpha、旧 runtime 或其他版本作兼容承诺

### 独立安装与全家桶：二选一

独立包与聚合包的 patch `id` 相同（`dsh-*`）。**请只选一种安装方式**——
同时装 `dsh-plugins-all` 与任一 `@wingsky-1/dsh-notifier` 等独立包会导致同名 entry
重复，`dsh web` 启动时报 duplicate 错误（可发现，不代表损坏）。需要调整时：
卸载聚合包，或卸载对应独立包，重启即可。

### 逐插件安全说明

- DSH 原生 LAN 入口只应显式绑定一个具体的本机 IPv4/IPv6 地址；`--public-url` 只用于对外公布 URL，不授予信任，`--trusted-host` 只扩展接受的 Host/Origin authority
- 原生 TLS 保护传输，但不单独认证请求者。插件 API 保留 loopback 快路径；非回环短请求只有在官方 `ctx.connection.requestRejection(req)` 返回 `undefined` 时才可准入。该校验覆盖 Host/Origin、跨站、cookie 与 API peer，异常必须 fail-closed。非回环 SSE 等长流还必须经 `ctx.connection.admit` 取得并保留 `PeerScope`，将关闭绑定到 Peer 生命周期；Peer 释放后必须立即停止广播并关闭流。新部署启用 LAN 前，应按插件完成认证、SSE/WebSocket 与真实设备验收；**HTTPS 握手成功本身不能证明插件可用**
- TLS 证书链、私钥配对应由使用者管理，客户端需信任对应 CA，证书 SAN 必须覆盖实际访问 authority；不要把私钥、启动令牌或会话凭据写入仓库、日志或公开报告
- `dsh-mcp-manager` 的 stdio 子进程继承宿主权限，只配置可信的 MCP 服务器
- 插件管理路由使用 loopback 快路径与官方身份准入；错误 Host/Origin、跨站、缺失凭据、401/403、admission 异常及长流生命周期绑定失败都保持 fail-closed，错误方法仍返回 405。
- `dsh-notifier` 自持配置文件；设置响应掩码频道凭据，但通知正文与出口错误详情不打码，可能进入日志、历史与推送服务。
- `dsh-provider-usage` 的 API 密钥留在宿主端，不进浏览器。
- `dsh-verify-isolated` 使用临时 DSH_HOME、独立 profile、端口与浏览器实例；这是验证隔离边界，不是全局安全承诺。

各插件的威胁模型与加固细节见其 README 安全章节。

<a id="最短上手"></a><a id="user-content-最短上手"></a>
## 最短上手

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
# 一键装全家桶（推荐）
dsh plugin --profile web add @wingsky-1/dsh-plugins-all

# 或单独安装（按需）
dsh plugin --profile web add @wingsky-1/dsh-notifier
dsh plugin --profile web add @wingsky-1/dsh-mcp-manager
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合），侧边栏/设置页才反映变化。

### 访问与验证

重启 `dsh web`，打开启动时给出的 URL，在「设置 → 插件」确认已安装插件的卡片。notifier 可发送测试通知；`dsh-lan-proxy` 已退役，局域网访问的安全差异与迁移步骤见 [lan-proxy 退役迁移](docs/migrations/dsh-lan-proxy.md)。

<a id="插件列表"></a><a id="user-content-插件列表"></a>
## 插件列表

| 包名 | 功能 | 文档 | 状态 |
|---|---|---|---|
| `@wingsky-1/dsh-notifier` | 浏览器、宿主 toast、Bark 与 Webhook 任务事件通知。 | [README](packages/dsh-notifier/README.md) · [架构图解](docs/architecture/dsh-notifier.md) | 已发布 |
| `@wingsky-1/dsh-provider-usage` | 支持自定义适配器的多 provider 用量、趋势与报告。 | [README](packages/dsh-provider-usage/README.md) · [适配器开发指南](packages/dsh-provider-usage/docs/adapter-guide.md) · [架构图解](docs/architecture/dsh-provider-usage.md) | 已发布 |
| `@wingsky-1/dsh-mcp-manager` | 按工作空间管理 MCP 配置与中间层工具接入。 | [README](packages/dsh-mcp-manager/README.md) · [架构图解](docs/architecture/dsh-mcp-manager.md) · [升级修复](#mcp-catalog-修复与升级须知) | 已发布 |
| `@wingsky-1/dsh-verify-isolated` | 为 DSH 插件开发提供隔离环境浏览器验证。 | [README](packages/dsh-verify-isolated/README.md) · [架构图解](docs/architecture/dsh-verify-isolated.md) | 已发布 |

<a id="常用配置与维护"></a><a id="user-content-常用配置与维护"></a>
## 常用配置与维护

在「设置 → 插件」进入对应卡片；各插件的配置与存储边界不同，请按对应 README 操作。

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-notifier
```

### 更新插件（update）

```sh
# 更新单个插件到最新
dsh plugin --profile web update @wingsky-1/dsh-notifier

# 更新全家桶（聚合包 + 其拉齐的子包）到最新
dsh plugin --profile web update @wingsky-1/dsh-plugins-all

# 更新当前 profile 下全部插件
dsh plugin --profile web update
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合），侧边栏/设置页才反映变化。

<a id="验证与排障"></a><a id="user-content-验证与排障"></a>
## 验证与排障

安装后未出现插件时先重启 `dsh web`；出现 duplicate entry 时，检查是否同时安装聚合包与独立包。

> **升级后历史会话打不开？**
> 当前版本只写 producer-owned V4 source。旧插件留下的历史产物不属于业务兼容范围，需先用维护脚本修复 source 元数据：
>
> ```sh
> # 落盘前先停 dsh web；正在写入的日志不保证可安全重写
> node scripts/maintenance/repair-mcp-catalog-sessions.mjs          # 预演
> node scripts/maintenance/repair-mcp-catalog-sessions.mjs --apply  # 落盘并自动备份，随后重启 dsh web
> ```
>
> 详见 [升级与历史会话边界](#mcp-catalog-修复与升级须知) · [issue #723](https://github.com/wingsky-1/dsh-plugin-hub/issues/723)

<a id="mcp-catalog-修复与升级须知"></a>
## 升级与历史会话边界（mcp-catalog）

当前 `dsh-mcp-manager` 只生成 producer-owned V4 source：
`kind: "plugin:@wingsky-1/dsh-mcp-manager"`。业务代码不提供旧 V0/V2/V3 parser，也不承诺旧格式兼容。

历史 `mcp-catalog` source 属于一次性维护边界。脚本只把旧 source 元数据修为 V3 wrapper，保留消息正文与事件序列；它不写 V4，也不实现 v3→v4 迁移。修复后由目标 dsh（版本见 catalog）的官方迁移链依次恢复并转为 V4，当前 V4 产物不动。执行前先停止 `dsh web`，先用默认预演模式核对，再加 `--apply` 落盘。

详见 [dsh-mcp-manager README](packages/dsh-mcp-manager/README.md#升级与历史会话边界)。

<a id="详细参考"></a><a id="user-content-详细参考"></a>
## 详细参考

### 功能详解

- **任务事件通知中心**：提问 / 审批 / 完成 / 子代理完成 / 错误 / 轮次完成 6 类任务事件
  双通道提醒（浏览器通知 + 系统 toast），经 Bark / Webhook 可推送到手机；免打扰时段与
  紧急例外、按通道独立的弹窗/声音开关（4 音色）、宿主能力自检（`/diagnostics`）
- **上下文成本可控的 MCP 管理**：项目级 MCP 默认经中间层收敛为 `ws_mcp_list` /
  `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call` 四个原子工具，项目级接入规模
  不再膨胀上下文（`middleware: all` 可把全局服务器也收进中间层，设置页热切换）；
  分工作目录维护项目级/全局两级配置，多仓库各配各的 MCP，互不串台
- **可扩展的用量统计框架**：支持多 provider 用量统计与自定义数据源接入；覆盖每日
  用量推算、使用趋势、峰谷倒计时与日/周/月报告
- **工程质量背书**：每个插件自带 smoke 断言（路由围栏 / 客户端契约），构建契约 +
  打包校验等全部门禁在 CI 全量执行

### `@wingsky-1/dsh-notifier`

任务事件通知中心：6 类事件（提问/审批/完成/子代理完成/错误/轮次完成），双通道（浏览器通知 + 宿主系统 toast）+ Bark/Webhook 推送频道（ntfy、Gotify、自建网关）；免打扰时段与紧急例外、按通道独立弹窗/声音（4 音色）、宿主能力自检（`/diagnostics` 给可用性与处置建议）

### `@wingsky-1/dsh-provider-usage`

多 provider 用量统计框架（v2 适配器契约）：常驻胶囊 + 详情面板；内置 DeepSeek 官方（区间记账法推算每日用量 + 峰谷倒计时徽标，官方无用量接口也能算）与 OpenCode Go 开箱即用；自写一个 mjs 即可接入任意数据源、设置页热插拔；日/周/月用量报告（经宿主 llm 生成，含目录与时段维度观察）；密钥只在宿主端不进浏览器

### `@wingsky-1/dsh-mcp-manager`

MCP 服务器管理器（stdio / streamable-http）：项目级/全局两级配置分工作目录维护；全部 MCP 经中间层收敛为 4 个原子工具（模型不可见 `mcp__` 直呼工具）；工作空间隔离防串台；配置只存 `${ENV}` 引用不落盘密钥；提供运行时注册接口供其他插件注入 MCP；可选 MCP 调用统计与 debug 模式（metadata-only，默认关）

### `@wingsky-1/dsh-verify-isolated`

DSH 插件开发的隔离环境浏览器验证 skill：临时 DSH_HOME + 独立 profile + 独立端口 + 独立浏览器实例四重隔离，一键拉起、退出自动清理；自带 raw CDP 零依赖浏览器驱动（快照/点击/截图/求值，支持设备视口模拟），可选隔离审计；首启弹窗默认跳过

<details>
<summary>低频安装变体：指定版本与 npx</summary>

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`，`add` 与 `update` 通用：

```sh
# 安装指定版本（而非 latest）
dsh plugin --profile web add @wingsky-1/dsh-notifier@<版本号>

# 更新到指定版本
dsh plugin --profile web update @wingsky-1/dsh-notifier@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（`dsh plugin` 底层调用 `pnpm`，故仍需本机事先装好 `pnpm` 与 `Node.js`）：

```sh
# 装全家桶
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-plugins-all

# 单独安装（带版本号）
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-notifier@<版本号>

# 卸载 / 更新（同理，把 add 换成 remove / update）
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-notifier
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-plugins-all
```

> `npx` 每次会临时拉取 `@deepseek-ai/dsh`；若想固定，可 `pnpm add -g @deepseek-ai/dsh`（或 `npm i -g @deepseek-ai/dsh`）后直接使用 `dsh`。

</details>

<details>
<summary><b>历史维护与迁移</b>——已停止维护的包、旧包迁移指引（装过旧包/退役包的用户请展开）</summary>

**已停止维护（勿再安装，npm 均已标 deprecated）**：

- `@wingsky-1/dsh-skill-explorer`（技能中心/skill 管理）已不再维护，插件包与聚合包均已移除。
  web UI 侧已有更优实现 `@linxin666/dsh-client-ui-skill-explorer`（`dsh-web-ui` 仓库
  `packages/dsh-skill-explorer`），支持符号链接识别、链接技能安全处理等，请直接使用
  web UI 内置技能中心。
- `@wingsky-1/dsh-idle-archive`（会话闲置提醒归档）已不再维护：社区已有更成熟的会话
  生命周期管理/归档实现（如 [dsh-session-pruner](https://github.com/mrzhangkris/dsh-session-pruner)）。
- `@wingsky-1/dsh-subagent-model-inherit`（子 Agent 自动继承父会话模型与思考等级）已不再维护：
  官方 dsh-subagent 0.1.2-alpha.2 已原生实现 `resolveChildAgentOptions`（子 Agent 继承父会话
  模型/思考等级/输出上限）。
- `@wingsky-1/dsh-codegraph`（codegraph 本地代码图谱 MCP + worktree 开发纪律）已不再维护：
  封装工具与 codegraph CLI 版本强耦合，维护成本高于收益。
- `@wingsky-1/dsh-mem0`（mem0 长期记忆系统）已不再维护：环境隔离等缺陷未收敛
  （#644 / #612），质量未达继续维护标准。
- `@wingsky-1/dsh-web-file-preview`（把对话内「用默认应用打开」改写为官方右侧栏预览）
  已不再维护：官方 dsh 0.1.6 起交付物提及点击已改走官方侧栏预览，仅剩卡片菜单
  「用默认应用打开」这一显式外开入口，改写它与用户显式意图相反（#840）。
- `@wingsky-1/dsh-worktree-sidebar`（把某个 git worktree 登记给当前会话的侧栏文件树）
  已不再维护：DSH 0.2.1-rc.2 提供不同语义的官方替代，迁移与退役说明见
  [docs/migrations/worktree-sidebar.md](docs/migrations/worktree-sidebar.md)。退役的是旧外部适配包；
  DSH 官方可选 Git Worktrees bundle 在 `0.2.2-rc.1` 仍受支持，其 metadata 仍可按官方机制加载。
- `@wingsky-1/dsh-lan-proxy`（局域网 HTTP/HTTPS/WebSocket 转发、TLS、压缩与保活）
  已停止独立维护并退出当前源码树与聚合包：官方原生 LAN/TLS 覆盖了主要入口；native remote
  mux 已实际协商 `permessage-deflate`，并提供 Ping/不活跃终止，但旧包的逐路径 WS 白名单、
  压缩桥接与半开保活策略仍不承诺等价，认证、证书管理和插件 API 围栏也仍有真实差异；迁移见
  [docs/migrations/dsh-lan-proxy.md](docs/migrations/dsh-lan-proxy.md)。
- `@wingsky-1/dsh-decision-gateway`（通用辅助决策网关，JEV 为首个 provider）
  已不再维护：无直接替代；[退役说明](docs/archive/dsh-decision-gateway-retirement.md)
  记录归档与残留清理方式。

此前安装过上述退役包的用户请卸载：

```sh
dsh plugin --profile web remove @wingsky-1/dsh-skill-explorer
dsh plugin --profile web remove @wingsky-1/dsh-idle-archive
dsh plugin --profile web remove @wingsky-1/dsh-subagent-model-inherit
dsh plugin --profile web remove @wingsky-1/dsh-codegraph
dsh plugin --profile web remove @wingsky-1/dsh-mem0
dsh plugin --profile web remove @wingsky-1/dsh-web-file-preview
dsh plugin --profile web remove @wingsky-1/dsh-worktree-sidebar
dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
dsh plugin --profile web remove @wingsky-1/dsh-decision-gateway
```

> dsh-memory（项目长期记忆）暂未包含，规划中。

**旧包迁移（历史上发布过、现已不再分发）**：

`@wingsky-1/dsh-gzip` 与后续承接它的 `@wingsky-1/dsh-lan-proxy` 均已退役。

历史版本中，HTTP 响应压缩曾从 dsh-gzip 并入 lan-proxy；当前宿主原生压缩只承诺
`none | gzip`；native remote mux 的 WebSocket 路径已实际协商 `permessage-deflate`，并以
Ping/不活跃终止处理连接，但这不等于旧 lan-proxy 的逐路径 WS 压缩桥接、半开保活和移动端
重连策略。需要原生 LAN 的用户应先阅读迁移页并接受这些非等价差异，不要再通过安装两个
退役包完成迁移：

```sh
dsh plugin --profile web remove @wingsky-1/dsh-gzip
dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
```

`@wingsky-1/dsh-opencode-usage` → 已重构更名为 `@wingsky-1/dsh-provider-usage`

重构为多 provider 适配器框架（内置 OpenCode Go，支持用户自定义取数适配器）。
patch `id` 由 `ui-dsh-opencode-usage` 变为 `ui-dsh-provider-usage`，配置项亦有调整，
不会自动迁移——重装后请在设置面板重新确认配置（如 `apiKey`、`baseUrl`）：

```sh
dsh plugin --profile web remove @wingsky-1/dsh-opencode-usage
dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

> 两个旧包的 npm 版本均已标记 deprecated（安装时会提示迁移去向）。

**插件行 ID 迁移（v0.2.5 → 新版本）**

新版本将插件行 ID 统一为 `dsh-*`。旧 profile 不会自动改写；请先停止 `dsh web`，再执行迁移。

源码仓库或维护者环境：

```sh
pnpm migrate:plugin-rows -- --home "$DSH_HOME"
# 核对 dry-run 报告后：
pnpm migrate:plugin-rows -- --home "$DSH_HOME" --apply
```

工具只改 patch 的 `id` 字段，保留 `name`、`disabled`、config 和行顺序，并生成备份。已通过 npm 安装、没有源码 checkout 的用户不要直接运行仓库脚本；请按对应版本 release notes 执行一次性迁移。人工兜底时必须先备份 profile patch，只把 `id: ui-dsh-*` 改为 `id: dsh-*`，不要改 `name` 或 `config`，再启动 DSH。

</details>

### 相关项目

- [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（npm：`@dsh-external/dsh-mobile-nav`）— DSH web 移动端适配：窄屏自动收起侧栏、目录以抽屉方式展开。本项目的大部分开发与排障基于它在手机/平板上的远程使用完成。
- [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) — DSH web UI 皮肤集合。从中学习了很多优秀实践，也是 DSH 插件开发的启蒙项目。
- [dsh-routing-suite / dsh-router-standard](https://github.com/yjh051108/dsh-routing-suite) — 提供 Router Standard agent preset（任务感知的推理模式路由：spec / mixed / react），供会话选择预设使用。

<a id="开发与架构"></a><a id="user-content-开发与架构"></a>
## 开发与架构

运行前提：DSH `0.2.2-rc.1` 要求 Node `>=24.9`。仓库开发和测试用原生 type stripping
直跑 TS，工具门槛单独为 Node `>=23.6`；pnpm 要求 `>=11`。

构建 / 契约 / 测试 / 打包命令、目录结构、宿主端与客户端写法规范，统一见
[DEVELOPMENT.md](docs/DEVELOPMENT.md)（从 §0 构建总览开始）；贡献流程见
[CONTRIBUTING.md](CONTRIBUTING.md)；issue 处理流程见
[ISSUE-WORKFLOW.md](docs/ISSUE-WORKFLOW.md)；**各插件架构图解（功能 / 原理 / 使用方式，
含 SVG 架构图与 Mermaid 时序图）见 [插件架构文档](docs/architecture/README.md)**。

插件迁入本仓库前均经过开源前审查（构建自包含、隐私清理、安全加固、元数据完整）。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)：Conventional Commits 提交规范、功能分支 + PR 流程、
提交前检查（敏感信息/发布物边界）。

## License

[MIT](LICENSE)
