# Agent Note: 单池：中间层连接池为唯一连接路径

Status: implemented

## Problem

连接多轨并存时，禁用表与单元归属语义分裂：直调旁路与池内单元各持一份可见面，守卫与模型隐藏面无法全覆盖同一份名单，禁了也可能从另一条轨道复活。

## Decision

全部服务器只有一条连接轨道：项目级、全局级（`@global`）与 runtime 注入条目都由中间层连接池持有，`initMiddleware` 不接受任何模式入参，池归属恒为全部服务器。

## 机制与实据

- 模式键删除（#767 笔 2）：`middleware` / `middlewarePolicy` 双键删净，顶层键集 8→6，删后二者与任意陌生键同走 400 未知键路径（`packages/dsh-mcp-manager/src/server/api/routes-controllers.ts:90-109`；`packages/dsh-mcp-manager/test/e2e/smoke.test.ts:1482-1491`、`2556-2562`；`packages/dsh-mcp-manager/test/unit/unit-routes-sse.test.ts:831-834`）。
- 策略裁决族随键同删：`policyAllows` / `policyDenialReason` 不再存在（`packages/dsh-mcp-manager/src/server/pipeline/impl/authorize/index.ts:10`）；单池后守卫与模式无关（`packages/dsh-mcp-manager/test/unit/unit-apply.test.ts:304`）。
- 池内聚合口径：`/health` 三计数与 middleware 子对象按池单元表聚合（`packages/dsh-mcp-manager/test/unit/unit-routes-sse.test.ts:378`、`packages/dsh-mcp-manager/test/unit/unit-manager2.test.ts:744-756`）。
- 现状细节见 [`dsh-mcp-manager.md` §1](../../../../docs/architecture/dsh-mcp-manager.md)（单池前导与显式非目标表），本篇只记取舍。

## Alternatives considered

- 保留双键做模式分支（笔 2 删掉的旧态）：最强理由是渐进迁移，旧配置靠开关保持行为可控。否定：保留键留下永远走不到的分支（见上文 docs §1“为什么只有一种能力”），且双轨下禁用与单元语义分裂正是本篇 Problem，留开关等于留缺口。
- 按目标拆多池（故障隔离、直连少一跳更快）：最强理由是单点故障域更小。否定：每个工作空间一套常驻连接、按会话 cwd 路由已覆盖隔离需求，而多池让守卫与可见面名单覆盖不全；多出来的一跳是已接受的显式代价。

## Consequences

- 收益：禁用、单元、可见面三者同源，守卫裁决无旁路；删除分支后装配语义与测试口径唯一。
- 代价：多一跳中间层转发；`allowTools`/`denyTools` 准入闸能力随策略键消失，缺口单列、替代品归阶段 3 的 governance/visibility；旧配置带已删键时走 400 而非静默兼容（启动期旧文件照常启动，见 docs M2）。

相关裁决：歧义直呼同样 fail-closed，见 [B11 守卫](./2026-09-19-guard-fail-closed-b11.md)。文档镜像纪律见[配置与契约文档以代码为单一事实源](../../implemented/process/2026-09-18-config-doc-mirror-policy.md)。
