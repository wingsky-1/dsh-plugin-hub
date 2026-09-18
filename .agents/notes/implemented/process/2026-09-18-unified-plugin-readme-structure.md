# Agent Note: 三插件 README 统一结构与安全模型节

Status: implemented

## Problem

dsh-lan-proxy、dsh-notifier、dsh-worktree-sidebar 三个插件的 README 各自演进：安全章节命名不一（`安全与边界` vs `安全模型`）、节顺序不同、根 `README.en.md` 插件表把 lan-proxy/notifier 链到中文 `README.md`。跨包用户找不到同一概念，安全节无法互链。

## Decision

lan-proxy 与 notifier README 采用同一七节骨架：快速导航 / 使用前须知 / `安全模型`（英文 `Security model`）/ 上手 / 配置 / 验证与排障 / 架构与参考。sidebar 保留自有节顺序（与其 TOGAF 架构文配套），对齐点只取三项：安全章节统名 `安全模型`、中英节标题 1:1 镜像、术语互链（loopback 围栏、3443 转发语义只引不复述）。根 `README.en.md` 插件表链各自 `README.en.md`；notifier 中文改名保留旧锚兼容行（`安全与边界`），不留死链。

相关入口：[lan-proxy README](../../../../packages/dsh-lan-proxy/README.md)、[notifier README](../../../../packages/dsh-notifier/README.md)、[sidebar README](../../../../packages/dsh-worktree-sidebar/README.md)。

镜像政策见[配置与契约文档以代码为单一事实源](./2026-09-18-config-doc-mirror-policy.md)。

## Alternatives considered

- 各包自定结构，只修错链：最省事，但安全概念仍无法跨包互链，用户在 lan-proxy 与 notifier 之间要重新定位同一节，被否。
- 一次性全仓统一（含 provider-usage、mcp-manager、verify-isolated 的同类错链）：超出本 PR 范围，那三行记为 follow-up，被否。

## Consequences

- 收益：安全上下文（loopback 围栏、3443 转发语义）三包互链不复述；新包照此骨架写即可。
- 代价：改名留下的旧锚兼容行是永久小负债；新增节必须双语同步写，否则中英镜像破裂由 `docs:check --strict-en` 拦。
