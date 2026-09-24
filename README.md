# dsh-plugin-hub

[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![CI](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wingsky-1/dsh-plugin-hub)](LICENSE)

<p align="center">
  <img src=".github/assets/banner.png" alt="DSH Plugin Hub">
</p>

**简体中文** | [English](README.en.md)

DSH（DeepSeek Harness）Web GUI 插件集，npm 分发：一键装全家桶，或按需单装。

- 聚合包：`@wingsky-1/dsh-plugins-all`（一键装齐全部插件）
- 单插件：`@wingsky-1/dsh-*`（按需安装）

## 快速导航

[使用前须知](#使用前须知) · [最短上手](#最短上手) · [插件列表](#插件列表) · [常用配置与维护](#常用配置与维护) · [验证与排障](#验证与排障) · [详细参考](#详细参考) · [开发与架构](#开发与架构)

<a id="使用前须知"></a><a id="user-content-使用前须知"></a>
## 使用前须知

### 版本适配（只适配 rc）

本插件集当前只适配 DeepSeek Harness `0.1.7-rc.1`。

- 官方类型层 catalog 与各包 peerDependencies 一致锁定 `dsh 0.1.7-rc.1`；其他 DSH 版本不在本轮支持范围
- 安装/更新时若 DSH 版本不匹配，npm/pnpm 会给出 peer 提示——请先将 DSH 本体切换到该版本
- 每版的具体适配基线、破坏性变更与升级指南见 [Release Notes](docs/release-notes/)
- catalog 更新前，不对 alpha、旧 runtime 或其他版本作兼容承诺

### 独立安装与全家桶：二选一

独立包与聚合包的 patch `id` 相同（`ui-*`）。**请只选一种安装方式**——
同时装 `dsh-plugins-all` 与任一 `@wingsky-1/dsh-lan-proxy` 等独立包会导致同名 entry
重复，`dsh web` 启动时报 duplicate 错误（可发现，不代表损坏）。需要调整时：
卸载聚合包，或卸载对应独立包，重启即可。

### 逐插件安全说明

- `dsh-lan-proxy` 装完即在 `0.0.0.0` 开放 HTTP/HTTPS 端口，**局域网所有设备可访问你的 dsh**——不需要时请卸载
- `dsh-lan-proxy` 的启动令牌自动注入（`injectToken`）**默认开启**：局域网内任何能访问该端口的设备免 token 获得完整 dsh 控制权（等效信任整个局域网，bash 直通宿主机）——仅在可信内网开启，不可信网段务必在设置卡片关闭
- `dsh-mcp-manager` 的 stdio 子进程继承宿主权限，只配置可信的 MCP 服务器
- 插件管理路由有 loopback 围栏（非回环 403 / 方法错 405）；经 `dsh-lan-proxy` 转发的请求按设计视为受信，并不隔离局域网客户端。
- `dsh-notifier` 自持配置文件；设置响应掩码频道凭据，但通知正文与出口错误详情不打码，可能进入日志、历史与推送服务。
- `dsh-provider-usage` 的 API 密钥留在宿主端，不进浏览器。
- `dsh-verify-isolated` 使用临时 DSH_HOME、独立 profile、端口与浏览器实例；这是验证隔离边界，不是全局安全承诺。
- `dsh-worktree-sidebar` 只改变侧栏根目录；会话 cwd、`@` 引用与 `present` 仍锚定 cwd。

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
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合），侧边栏/设置页才反映变化。

### 访问与验证

重启 `dsh web`，打开启动时给出的 URL，在「设置 → 插件」确认已安装插件的卡片。notifier 可发送测试通知；局域网访问按 [lan-proxy 访问与健康检查](packages/dsh-lan-proxy/README.md#最短上手) 验证。

<a id="插件列表"></a><a id="user-content-插件列表"></a>
## 插件列表

| 包名 | 功能 | 文档 | 状态 |
|---|---|---|---|
| `@wingsky-1/dsh-notifier` | 浏览器、宿主 toast、Bark 与 Webhook 任务事件通知。 | [README](packages/dsh-notifier/README.md) · [架构图解](docs/architecture/dsh-notifier.md) | 已发布 |
| `@wingsky-1/dsh-provider-usage` | 支持自定义适配器的多 provider 用量、趋势与报告。 | [README](packages/dsh-provider-usage/README.md) · [适配器开发指南](packages/dsh-provider-usage/docs/adapter-guide.md) · [架构图解](docs/architecture/dsh-provider-usage.md) | 已发布 |
| `@wingsky-1/dsh-lan-proxy` | 带 TLS、压缩与保活的局域网 HTTP/HTTPS/WebSocket 转发。 | [README](packages/dsh-lan-proxy/README.md) · [架构图解](docs/architecture/dsh-lan-proxy.md) | 已发布 |
| `@wingsky-1/dsh-mcp-manager` | 按工作空间管理 MCP 配置与中间层工具接入。 | [README](packages/dsh-mcp-manager/README.md) · [架构图解](docs/architecture/dsh-mcp-manager.md) · [升级修复](#mcp-catalog-修复与升级须知) | 已发布 |
| `@wingsky-1/dsh-verify-isolated` | 为 DSH 插件开发提供隔离环境浏览器验证。 | [README](packages/dsh-verify-isolated/README.md) · [架构图解](docs/architecture/dsh-verify-isolated.md) | 已发布 |
| `@wingsky-1/dsh-worktree-sidebar` | 绑定会话侧栏 worktree，不改变会话 cwd。 | [README](packages/dsh-worktree-sidebar/README.md) · [架构图解](docs/architecture/dsh-worktree-sidebar.md) | 未发布 |

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

历史 `mcp-catalog` source 属于一次性维护边界。脚本只把旧 source 元数据修为 V3 wrapper，保留消息正文与事件序列；它不写 V4，也不实现 v3→v4 迁移。修复后由 `dsh 0.1.7-rc.1` 的官方迁移链依次恢复并转为 V4，当前 V4 产物不动。执行前先停止 `dsh web`，先用默认预演模式核对，再加 `--apply` 落盘。

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

### `@wingsky-1/dsh-lan-proxy`

局域网访问 dsh web UI：HTTP/HTTPS/WS 转发 + TLS（自签名/自定义证书）；HTTP（Brotli/gzip 自适应）与 WebSocket（permessage-deflate）双压缩；WS 半开探活，移动端切后台不僵死；启动令牌自动注入，LAN 设备免手工拿 token；DNS 重绑定防护 + 回环目标白名单

### `@wingsky-1/dsh-mcp-manager`

MCP 服务器管理器（stdio / streamable-http）：项目级/全局两级配置分工作目录维护；全部 MCP 经中间层收敛为 4 个原子工具（模型不可见 `mcp__` 直呼工具）；工作空间隔离防串台；配置只存 `${ENV}` 引用不落盘密钥；提供运行时注册接口供其他插件注入 MCP；可选 MCP 调用统计与 debug 模式（metadata-only，默认关）

### `@wingsky-1/dsh-verify-isolated`

DSH 插件开发的隔离环境浏览器验证 skill：临时 DSH_HOME + 独立 profile + 独立端口 + 独立浏览器实例四重隔离，一键拉起、退出自动清理；自带 raw CDP 零依赖浏览器驱动（快照/点击/截图/求值，支持设备视口模拟），可选隔离审计；首启弹窗默认跳过

### `@wingsky-1/dsh-worktree-sidebar`

给 agent 三个工具（register / create / remove），把某个 git worktree 登记给当前会话，让该会话右侧栏文件树指向那个 worktree，而**会话 cwd 不变**（`@` 引用、`present` 落点仍锚 cwd）；子 agent 会话继承父会话的登记；只在「打开页签 / 点官方刷新 / 窗口重新可见」时重读，不轮询

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

此前安装过上述退役包的用户请卸载：

```sh
dsh plugin --profile web remove @wingsky-1/dsh-skill-explorer
dsh plugin --profile web remove @wingsky-1/dsh-idle-archive
dsh plugin --profile web remove @wingsky-1/dsh-subagent-model-inherit
dsh plugin --profile web remove @wingsky-1/dsh-codegraph
dsh plugin --profile web remove @wingsky-1/dsh-mem0
dsh plugin --profile web remove @wingsky-1/dsh-web-file-preview
```

> dsh-memory（项目长期记忆）暂未包含，规划中。

**旧包迁移（历史上发布过、现已不再分发）**：

`@wingsky-1/dsh-gzip` → 已合并进 `@wingsky-1/dsh-lan-proxy`（0.1.9 起）

HTTP 响应压缩能力整体并入 lan-proxy（默认开启，Brotli/gzip 按 Accept-Encoding 自适应协商，SSE 流式响应豁免，可配置）。
卸载 dsh-gzip、安装 dsh-lan-proxy 即获得等价压缩能力：

```sh
dsh plugin --profile web remove @wingsky-1/dsh-gzip
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
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

</details>

### 相关项目

- [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（npm：`@dsh-external/dsh-mobile-nav`）— DSH web 移动端适配：窄屏自动收起侧栏、目录以抽屉方式展开。本项目的大部分开发与排障基于它在手机/平板上的远程使用完成。
- [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) — DSH web UI 皮肤集合。从中学习了很多优秀实践，也是 DSH 插件开发的启蒙项目。
- [dsh-routing-suite / dsh-router-standard](https://github.com/yjh051108/dsh-routing-suite) — 提供 Router Standard agent preset（任务感知的推理模式路由：spec / mixed / react），供会话选择预设使用。

<a id="开发与架构"></a><a id="user-content-开发与架构"></a>
## 开发与架构

要求：Node ≥ 23.6（测试用原生 type stripping 直跑 TS）、pnpm ≥ 11。

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
