# dsh-plugin-hub

[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![CI](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wingsky-1/dsh-plugin-hub)](LICENSE)

**简体中文** | [English](README.en.md)

DSH（DeepSeek Harness）Web GUI 插件集，**npm 分发**：既可一键安装全家桶，也可单独安装单个插件。

- 聚合包：`@wingsky-1/dsh-plugins-all`（一键装齐全部插件）
- 单插件：`@wingsky-1/dsh-*`（按需安装）
- 所有插件走 DSH 官方 profile 机制挂载（`dsh.bundle.patch`），不改 DSH 源码
- 已发布到 npm（`@wingsky-1` scope），零运行时依赖

## 插件列表

| 包名 | 功能 | 文档 | 状态 |
|---|---|---|---|
| `@wingsky-1/dsh-notifier` | 审批/完成/错误事件通知（浏览器 Notification + 系统 toast） | [README](packages/dsh-notifier/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-opencode-usage` | OpenCode Go 套餐用量悬浮框（rolling/weekly/monthly） | [README](packages/dsh-opencode-usage/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-lan-proxy` | 局域网访问 dsh web UI（HTTP/HTTPS/WS 转发 + TLS） | [README](packages/dsh-lan-proxy/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-mcp-manager` | MCP 服务器管理器（stdio/HTTP，工具注册给模型） | [README](packages/dsh-mcp-manager/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-idle-archive` | 会话闲置提醒归档 | [README](packages/dsh-idle-archive/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-gzip` | /api 响应 gzip 压缩 | [README](packages/dsh-gzip/README.md) | ✅ 已发布 |
| `@wingsky-1/dsh-web-file-preview` | 点击对话文件链接在 web 端预览（图片/文本/Markdown/代码/Diff） | [README](packages/dsh-web-file-preview/README.md) | ✅ 已发布 |

> **已停止维护**：`@wingsky-1/dsh-skill-explorer`（技能中心/skill 管理）已**不再维护**
> （npm 已 deprecate，插件包与聚合包均已移除）。web UI 侧已有更优实现
> `@linxin666/dsh-client-ui-skill-explorer`（`dsh-web-ui` 仓库 `packages/dsh-skill-explorer`），
> 支持符号链接识别、链接技能安全处理等，请直接使用 web UI 内置技能中心，勿再安装本包。

> dsh-memory（项目长期记忆）暂未包含，规划中。

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

registry 尚未同步到最新、或最新版在你的环境有问题时，可在包名后追加 `@版本号`，`add` 与 `update` 通用：

```sh
# 安装指定版本（而非 latest）
dsh plugin --profile web add @wingsky-1/dsh-notifier@0.1.8

# 更新到指定版本
dsh plugin --profile web update @wingsky-1/dsh-notifier@0.1.8
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（`dsh plugin` 底层调用 `pnpm`，故仍需本机事先装好 `pnpm` 与 `Node.js`）：

```sh
# 装全家桶
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-plugins-all

# 单独安装（带版本号）
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-notifier@0.1.8

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

### 从 0.1.x 升级（patch id 迁移）

0.1.5 起独立包 patch `id` 由旧短名（如 `notifier`、`lan-proxy`、`dsh-gzip`）统一改为
`ui-<name>`（如 `ui-dsh-notifier`）。若你此前单独安装过独立包，profile 中可能残留旧
`id` 行——建议确认后通过以下命令检测，并重装对应包拉取新 patch：

```sh
# 检测 profile 中是否仍引用旧 id（home 级与 profile 级）
grep -rnE '^\s*id:\s*(dsh-gzip|dsh-idle-archive|lan-proxy|mcp-manager|notifier|opencode-usage)\s*$' \
  "$DSH_HOME/cordis.patch.yml" ~/.dsh/profiles/*/cordis.patch.yml 2>/dev/null
# 有输出 → 重装覆盖拉取新配置（默认装 latest，即当前最新版）
dsh plugin --profile web remove @wingsky-1/<包>
dsh plugin --profile web add @wingsky-1/<包>@latest
```

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

```sh
pnpm install
pnpm build        # 构建全部插件（宿主端 tsc + esbuild 内联 shared；客户端 build-client：干净模块→契约外壳）
pnpm contract     # 客户端契约检查（node scripts/contract-check.ts，load id/apply/inject/arrive）
pnpm test         # 全量 smoke（test/*.ts 直跑）
pnpm pack:check   # 打包冒烟：pnpm pack 后检查 tarball 内容完整性
```

目录结构：

```
packages/dsh-*/            # 每个插件 = 独立 npm 包（@wingsky-1/dsh-*）
  src/index.ts             # 宿主端入口（cordis service，export ROUTES 作客户端路由单一来源）
  src/client/index.ts      # 客户端干净模块入口（只 export apply/inject，无 load/IIFE 外壳）
  src/client/style.css     # 客户端样式（独立文件，构建期 text-loader 内联进 client.js）
  src/client/*.ts          # 客户端辅助模块（宿主用不到、仅浏览器侧）
  src/*.ts                 # 其余为宿主模块；宿主导出的 profile 依赖另见 cordis.patch.yml
packages/dsh-plugins-all/  # 聚合包（dependencies 引用全部子包，发布用 pnpm publish 替换版本号）
shared/                    # 宿主端共享层（loopback/host-utils/frontmatter），构建期内联进各包，不发布
types/dsh.d.ts             # 自建 DSH 插件类型层
scripts/                   # 构建/契约/打包校验脚本（*.ts，Node 直跑）
```

客户端开发（干净模块规范）：源码**不写** `window.__ModuleLoader__` / IIFE——只
`export function apply(ctx)` + `export const inject`；契约外壳（load/IIFE/Symbol.toStringTag
装配 + load id=包名）由 `scripts/build-client.ts` 统一生成。样式放独立 `style.css`（`.css`
text-loader 内联）。纯浏览器第三方库（如 web-file-preview 的 dompurify/diff2html）经
`dsh.client.inlineBareImports: true` 内联进产物，统一走 `src/client/` 目录。详见
[DEVELOPMENT.md](docs/DEVELOPMENT.md)。

插件迁入本仓库前均经过开源前审查（构建自包含、隐私清理、安全加固、元数据完整）。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)：Conventional Commits 提交规范、功能分支 + PR 流程、
提交前检查（敏感信息/发布物边界）。

## License

[MIT](LICENSE)
