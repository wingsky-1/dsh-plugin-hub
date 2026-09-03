# dsh-plugin-hub 插件架构文档

> 本目录用**图解为主**的方式，讲清每个插件的**功能、原理、使用方式**。
> 每份文档包含：功能概览 → 总体架构图 → 核心机制 / 时序 → 使用方式 → 安全模型与边界，
> 与各插件包 README（安装 / 配置 / 验证的快速上手）互补。
>
> 图使用两种载体（源数据均归档、可复现）：
> - **SVG 架构图**：按 diagram-design 编辑风手写 SVG，源文件
>   归档在 [diagrams/](diagrams/)，可直接用浏览器打开源 HTML 调整后重新导出
>   （`python3 scripts/lib/export-diagram-svg.py <源.html>`）；
> - **Mermaid 图**：内嵌在 md 中，GitHub 原生渲染，源码即文档（天然可维护）。
>
> 仓库级共享机制（loopback 围栏、官方 settings 存储、client 干净模块等）见
> [「通用机制」](#通用机制)。

## 插件索引

| 插件 | 一句话定位 | 架构文档 |
|---|---|---|
| `@wingsky-1/dsh-lan-proxy` | 局域网访问 dsh web：HTTP/HTTPS/WS 转发 + TLS + 响应压缩 | [dsh-lan-proxy.md](dsh-lan-proxy.md) |
| `@wingsky-1/dsh-mcp-manager` | MCP 服务器管理：stdio/HTTP 传输、工具注册、三档中间层收敛 | [dsh-mcp-manager.md](dsh-mcp-manager.md) |
| `@wingsky-1/dsh-notifier` | 审批/完成/错误事件通知：浏览器 Notification + 系统 toast + Bark | [dsh-notifier.md](dsh-notifier.md) |
| `@wingsky-1/dsh-provider-usage` | 多 provider 用量统计：v2 适配器契约 + 宿主端渲染 + 历史落盘 | [dsh-provider-usage.md](dsh-provider-usage.md) |
| `@wingsky-1/dsh-web-file-preview` | 点击对话文件链接在 web 端预览：图片/文本/Markdown/代码/Diff/HTML | [dsh-web-file-preview.md](dsh-web-file-preview.md) |
| `@wingsky-1/dsh-codegraph` | codegraph MCP + worktree 开发纪律（依赖 mcp-manager 运行时注册） | [dsh-codegraph.md](dsh-codegraph.md) |
| `@wingsky-1/dsh-verify-isolated` | 插件开发隔离浏览器验证 skill（临时 DSH_HOME + 独立 profile） | [dsh-verify-isolated.md](dsh-verify-isolated.md) |
| `@wingsky-1/dsh-plugins-all` | 全家桶聚合包（一键装齐 + 聚合 cordis patch） | [dsh-plugins-all.md](dsh-plugins-all.md) |

## 全景：插件如何挂载进 dsh web

所有插件都不修改 DSH 源码——统一经 **`cordis.patch.yml` + profile 机制**挂载：

```mermaid
flowchart LR
    subgraph npm["npm 分发（@wingsky-1/dsh-*）"]
        P1["dsh-lan-proxy"]
        P2["dsh-mcp-manager"]
        P3["dsh-notifier"]
        P4["dsh-provider-usage"]
        P5["dsh-web-file-preview"]
        P6["dsh-codegraph"]
        P7["dsh-verify-isolated"]
    end

    subgraph profile["dsh web profile（cordis 运行时）"]
        CORDIS["cordis.patch.yml<br/>insert: id + name 一行"]
        HOST["宿主端 lib/index.js<br/>apply(ctx) 在 Node 进程运行"]
        CLIENT["客户端 lib/client.js<br/>apply(ctx) 在浏览器运行"]
        ROUTES["/api 路由<br/>loopback 围栏"]
        CORDIS --> HOST
        CORDIS --> CLIENT
        HOST --> ROUTES
    end

    P1 --> CORDIS
    P2 --> CORDIS
    P3 --> CORDIS
    P4 --> CORDIS
    P5 --> CORDIS
    P6 --> CORDIS
    P7 --> CORDIS

    P6 -. "inject 强依赖 ctx.mcpManager" .-> P2
    P2 -. "提供 ctx.mcpManager service" .-> P6
```

要点：

- **安装**：`dsh plugin --profile web add <包名>` → 包内 `cordis.patch.yml` 的 insert 行
  被写进 profile 插件名册；`dsh web` 重启时组合 bundle，宿主端与客户端各跑一半；
- **宿主端**（`exports "."` → `lib/index.js`）：在 Node 进程中 `apply(ctx)`，注入
  `webServer` / `tools` / `settings` / `connection` 等官方服务，注册路由与事件监听；
- **客户端**（`exports "./client"` → `lib/client.js`）：干净模块（`apply(ctx)` +
  `inject`），构建期内联样式与依赖，通过 `__DSH_ROUTES__` 拿到真实路由表；
- **依赖关系**：`dsh-codegraph` 经 `inject: ["mcpManager"]` 强依赖
  `dsh-mcp-manager`（未启用时 cordis 内核自动停用）；其余插件彼此独立；
- `dsh-plugins-all` 是聚合包：dependencies 拉齐全部子包 + 聚合 cordis patch
  （`scripts/aggregate.ts` 自动生成，禁止手改）。

## 通用机制

所有插件遵循仓库级共享约定（单一事实源在 `shared/` 与 [docs/DEVELOPMENT.md](../DEVELOPMENT.md)）：

| 机制 | 说明 | 实现位置 |
|---|---|---|
| **loopback 围栏** | 所有 `/api` 路由强制回环来源（remoteAddress + Host + 非跨站 + Origin 同源），非法 403 / 方法错 405——DNS 重绑定与跨站防御 | `shared/loopback.js`（`isLoopbackRequest`） |
| **官方 settings 存储** | 插件配置存 dsh 官方 `settings.register` 命名空间（`<DSH_HOME>/settings.yaml`），组合层 cordis config 作 base 层，热更新由 `scope.watch` 驱动 | `shared/settings-namespace.js`（`installSettingsNamespace`） |
| **客户端干净模块** | 只 `export function apply(ctx)` + `export const inject`；样式独立 `src/client/style.css`；构建期内联（`scripts/build/build-client.ts`） | 各包 `src/client/index.ts` |
| **发布物自包含** | 第三方依赖构建期内联进 `lib/`，运行时零 npm 依赖；license 自动归集 `lib/THIRD-PARTY-LICENSES` | `scripts/build/` |
| **loopback 服务端/客户端契约** | 宿主端在 index.ts 透出纯函数/常量，smoke 从 `lib/index.js` 导入断言（路由围栏 + 客户端契约） | `test/*.test.ts` |

## 图源归档

`diagrams/` 目录存放每张 SVG 架构图的**源文件**（diagram-design HTML），命名与文档一一对应：

| 文档 | 图 | 源文件 |
|---|---|---|
| 本页（全景） | 挂载流程图 | mermaid 内嵌（无独立源） |
| [dsh-lan-proxy.md](dsh-lan-proxy.md) | 转发架构图 | `diagrams/lan-proxy-architecture.html` |
| [dsh-mcp-manager.md](dsh-mcp-manager.md) | 双轨架构图 | `diagrams/mcp-manager-architecture.html` |
| [dsh-notifier.md](dsh-notifier.md) | 通知管线图 | `diagrams/notifier-architecture.html` |
| [dsh-provider-usage.md](dsh-provider-usage.md) | 宿主端渲染架构图 | `diagrams/provider-usage-architecture.html` |
| [dsh-web-file-preview.md](dsh-web-file-preview.md) | 拦截与预览链路图 | `diagrams/web-file-preview-architecture.html` |
| [dsh-codegraph.md](dsh-codegraph.md) | 注册与纪律注入图 | `diagrams/codegraph-architecture.html` |

> 调整方法：用浏览器打开源 HTML → 修改 SVG 内容 → 重新导出 SVG
> （`python3 scripts/lib/export-diagram-svg.py <源.html>`）替换文档中的引用。
> Mermaid 图直接改 md 源码块即可（GitHub 原生渲染）。
