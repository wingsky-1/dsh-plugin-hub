# dsh-plugin-hub

[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![CI](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wingsky-1/dsh-plugin-hub)](LICENSE)

**简体中文** | [English](README.en.md)

DSH（DeepSeek Harness）Web GUI 插件集，npm 分发：一键装全家桶，或按需单装。

- 聚合包：`@wingsky-1/dsh-plugins-all`（一键装齐全部插件；观察期插件除外，见下文插件列表）
- 单插件：`@wingsky-1/dsh-*`（按需安装）

## 核心优势

- **安全内建于默认**：坚持最小暴露面与最小凭据流转——管理面只对本机开放，
  密钥默认不明文落盘、不进浏览器；各插件的威胁模型与加固细节见其 README 安全章节
- **上下文成本可控的 MCP 管理**：项目级 MCP 默认经中间层收敛为 `ws_mcp_search` /
  `ws_mcp_call` 两个原子工具，项目级接入规模不再膨胀上下文（`middleware: all`
  可把全局服务器也收进中间层）；分工作目录维护项目级/全局两级配置，
  多仓库各配各的 MCP，互不串台
- **可扩展的用量统计框架**：通用 v2 适配器契约，内置 DeepSeek 官方与 OpenCode Go
  开箱即用；自写一个 mjs 文件即可接入任意数据源，设置页热插拔
- **工程质量背书**：每个插件自带 smoke 断言（路由围栏 / 客户端契约），构建契约 +
  打包校验等全部门禁在 CI 全量执行

## 插件列表

| 包名 | 功能 | 文档 | 状态 |
|---|---|---|---|
| `@wingsky-1/dsh-notifier` | 审批/完成/错误事件通知（浏览器 Notification + 系统 toast） | [README](packages/dsh-notifier/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-provider-usage` | 多 provider 用量统计悬浮框（通用适配器框架：内置 DeepSeek 官方与 OpenCode Go 开箱即用，自写 mjs 即可接入任意数据源） | [README](packages/dsh-provider-usage/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-lan-proxy` | 局域网访问 dsh web UI（HTTP/HTTPS/WS 转发 + TLS + HTTP 响应压缩，Brotli/gzip 自适应） | [README](packages/dsh-lan-proxy/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-mcp-manager` | MCP 服务器管理器（stdio/HTTP；分工作目录维护项目级/全局两级配置，项目级 MCP 经中间层收敛、免于工具洪水） | [README](packages/dsh-mcp-manager/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-web-file-preview` | 点击对话文件链接在 web 端预览（图片/文本/Markdown/代码/Diff/Mermaid） | [README](packages/dsh-web-file-preview/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-verify-isolated` | DSH 插件开发的隔离环境浏览器验证 skill（临时 DSH_HOME + 独立 profile 双重隔离） | [README](packages/dsh-verify-isolated/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-codegraph` | codegraph 本地代码图谱 MCP + worktree 开发纪律（经 mcp-manager 运行时注册） | [README](packages/dsh-codegraph/README.md) | ✅ 已发布（独立发包，暂不进聚合包） |

> **独立发包说明**：`@wingsky-1/dsh-codegraph` 为**独立发包**、**未包含在
> `dsh-plugins-all` 聚合包中**，需单独安装（它经 mcp-manager 运行时注册 codegraph MCP，
> 请先装 `dsh-mcp-manager` 或聚合包再配合使用）。

> **已停止维护**：`@wingsky-1/dsh-skill-explorer`（技能中心/skill 管理）已**不再维护**
> （npm 已 deprecate，插件包与聚合包均已移除）。web UI 侧已有更优实现
> `@linxin666/dsh-client-ui-skill-explorer`（`dsh-web-ui` 仓库 `packages/dsh-skill-explorer`），
> 支持符号链接识别、链接技能安全处理等，请直接使用 web UI 内置技能中心，勿再安装本包。
>
> **已停止维护**：`@wingsky-1/dsh-idle-archive`（会话闲置提醒归档）与
> `@wingsky-1/dsh-subagent-model-inherit`（子 Agent 自动继承父会话模型与思考等级）均已
> **不再维护**。前者因社区已有更成熟的会话生命周期管理/归档实现（如
> [dsh-session-pruner](https://github.com/mrzhangkris/dsh-session-pruner)），后者因官方
> dsh-subagent 0.1.2-alpha.2 已原生实现 `resolveChildAgentOptions`（子 Agent 继承父会话
> 模型/思考等级/输出上限）。两包均已从仓库移除、npm 已标 deprecated，请勿再安装；
> 此前安装过的用户请卸载：
>
> ```sh
> dsh plugin --profile web remove @wingsky-1/dsh-idle-archive
> dsh plugin --profile web remove @wingsky-1/dsh-subagent-model-inherit
> ```

> dsh-memory（项目长期记忆）暂未包含，规划中。

<details>
<summary><b>从旧包迁移（升级指导）</b>——装过 <code>dsh-gzip</code> / <code>dsh-opencode-usage</code> 的请展开</summary>

历史上发布过、现已不再分发的两个旧包，请按下面方式迁移（均先卸载旧包再安装新包，装完重启 `dsh web`）：

**`@wingsky-1/dsh-gzip` → 已合并进 `@wingsky-1/dsh-lan-proxy`**（0.1.9 起）

HTTP 响应压缩能力整体并入 lan-proxy（默认开启，Brotli/gzip 按 Accept-Encoding 自适应协商，SSE 流式响应豁免，可配置）。
卸载 dsh-gzip、安装 dsh-lan-proxy 即获得等价压缩能力：

```sh
dsh plugin --profile web remove @wingsky-1/dsh-gzip
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

**`@wingsky-1/dsh-opencode-usage` → 已重构更名为 `@wingsky-1/dsh-provider-usage`**

重构为多 provider 适配器框架（内置 OpenCode Go，支持用户自定义取数适配器）。
patch `id` 由 `ui-dsh-opencode-usage` 变为 `ui-dsh-provider-usage`，配置项亦有调整，
不会自动迁移——重装后请在设置面板重新确认配置（如 `apiKey`、`baseUrl`）：

```sh
dsh plugin --profile web remove @wingsky-1/dsh-opencode-usage
dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

> 两个旧包的 npm 版本均已标记 deprecated（安装时会提示迁移去向）。

</details>

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
# 一键装全家桶（推荐）
dsh plugin --profile web add @wingsky-1/dsh-plugins-all

# 或单独安装（按需）
dsh plugin --profile web add @wingsky-1/dsh-notifier
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

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

### 独立安装与全家桶：二选一（0.1.5 起）

独立包与聚合包的 patch `id` 相同（`ui-*`）。**请只选一种安装方式**——
同时装 `dsh-plugins-all` 与任一 `@wingsky-1/dsh-lan-proxy` 等独立包会导致同名 entry
重复，`dsh web` 启动时报 duplicate 错误（可发现，不代表损坏）。需要调整时：
卸载聚合包，或卸载对应独立包，重启即可。

## 相关项目

- [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（npm：`@dsh-external/dsh-mobile-nav`）— DSH web 移动端适配：窄屏自动收起侧栏、目录以抽屉方式展开。本项目的大部分开发与排障基于它在手机/平板上的远程使用完成。
- [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) — DSH web UI 皮肤集合。从中学习了很多优秀实践，也是 DSH 插件开发的启蒙项目。
- [dsh-routing-suite / dsh-router-standard](https://github.com/yjh051108/dsh-routing-suite) — 提供 Router Standard agent preset（任务感知的推理模式路由：spec / mixed / react），供会话选择预设使用。

## 安全提醒

- `dsh-lan-proxy` 装完即在 `0.0.0.0` 开放 HTTP/HTTPS 端口，**局域网所有设备可访问你的 dsh**——不需要时请卸载
- `dsh-mcp-manager` 的 stdio 子进程继承宿主权限，只配置可信的 MCP 服务器
- 各插件全部路由均 loopback 围栏（非回环 403 / 方法错 405）

## 开发

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
