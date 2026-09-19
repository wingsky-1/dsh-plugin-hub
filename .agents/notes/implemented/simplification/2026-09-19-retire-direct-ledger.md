# Agent Note: 直连账本退役（单池接管）

Status: implemented

## Problem

单池之前存在两套连接路径：manager 自持的“直连账本”（按裸名键）与中间层单元表 `middleware.units`（键为 (root, 裸名)）。两套账并存带来三个实质伤害：同名跨 scope（全局+项目级）按裸名键只能活一个、互相顶掉；旧账本有一条“直连兜底分支”（summarize 等读路径池 miss 时回落旧账），状态口径分裂；工具级禁用对直呼路径恒 miss（注册名中段是 id 不是裸名，不反解就查错键，#767 S1-5b 裁定 AG③）。修任何一条都要同时改两套账，收敛成本翻倍。

## Decision

连接只有一本账：中间层单元表 `middleware.units`。池归属判定（旧 `middlewareTakes`）恒真，manager 不再持有任何条目表；“拆”统一走池（`releaseConnection`/`dropMiddlewareConnection`），旧直连账本的 stop 与兜底分支随账本一并退役；健康检查三计数按单元表聚合，顶层键集逐字不变（外部形状守恒）。

## 机制实据

- 总纲：`packages/dsh-mcp-manager/src/server/connection/orchestrator/manager.ts:1-14`（文件头注释：单池 #767 笔 1a，直连账本并行路径整体退役）。
- 合流：`manager.ts:696-710`（`reconcileServers` 键为 (归属 root, 裸名)，与单元表同构；旧账本按裸名键的互顶限制随退役消除）。
- 拆：`manager.ts:932-940`（`unregisterServer` 拆统一走池账本）；`manager.ts:1107-1112`（`summarize` 一律从池单元+目录投影取，直连兜底分支已删）。
- 读路径：`packages/dsh-mcp-manager/src/server/api/routes.ts:171-176`（健康检查按单元表聚合，直连账本退役注记）。
- 现状锚：`docs/architecture/dsh-mcp-manager.md:51`（非目标：不提供直呼主形态）、`:190`（双轨 reconcile 口径）、`:332`（自研传输退役，四文件 S1-5c）。

## Alternatives considered

### 保留直连路径并行（被否）

对方最强的理由：渐进迁移风险最低，旧读路径（summarize/health）在池未建或单元缺失时仍有数据可回落，不会出现“池空即全空”的窗口；回滚也容易（开关一切回旧账）。

否决：与单池互斥。并行期间同名跨 scope 互顶限制永存（旧账本按裸名键的结构性缺陷修不掉）；禁用对直呼路径恒 miss 的安全缺口（S1-5b AG③）堵不上——留着旧账本就是留着绕过口。“池空即全空”不是新风险：池未建时旧账本同样无数据（它的数据也来自连接），兜底分支兜的是“旧实现残留条目”，不是“真实连接状态”。

## Consequences

- 收益：单口径（读写同一本账）；工具级禁用对直呼路径恒命中（配合 id 反解）；同名跨 scope 各成一条；runtime 注入（`runtimeRegistry`，同名 runtime 优先，内存态不落盘）双轨合并口径统一。
- 代价：删代码即删退路——旧账本相关分支、`middlewareTakes` 判定、`middlewarePolicy` 入参（#767 笔 2）全部移除；若官方装载语义变化，须先改 `servers/lifecycle` 域重建承接（退出条件见 `dsh-mcp-manager.md:332`），不能在本文另起第二套。
- 互链：决策正侧见 [single-pool](../architecture/2026-09-19-single-pool.md)；守卫侧见 [guard fail-closed B11](../architecture/2026-09-19-guard-fail-closed-b11.md)。
