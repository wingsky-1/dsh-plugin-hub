# Agent Note: 歧义直呼 fail-open 被否

Status: rejected — 注册名含连续双下划线时无法唯一反解 (server, tool)，放行即禁用绕过，故 guard fail-closed（#903 B-M4）

## Problem

直呼守卫 `handleDirectMcpGuard` 收到 `mcp__<segment>__<tool>` 形态的注册名时，必须把中段切回 (server, tool) 再查禁用表。当 tool 段本身含连续双下划线（`mcp__my__sv__t`），第一个 `__` 分割有两种合法切法：server="my"+tool="sv__t"，或 server="my__sv"+tool="t"。切法选错，查的就是另一把键，工具级禁用对这条调用恒 miss——禁用形同虚设。

## Alternatives considered

### A. 放行（fail-open，被否）

对方最强的理由：与官方 `mcp__` 契约的字面兼容最好，含 `__` 的工具经直呼路径照常用，不打断任何现有调用；歧义只是“查哪把键”的小概率事件，为小概率误杀一条可用路径不值。

否决：歧义不是小概率误判，是**不可逆的信息丢失**——分割点无法从名字本身唯一还原，选哪一边都是猜。放行猜错的那一边恰好是已禁用工具时，禁用被静默绕过（安全边界击穿，且无日志）。fail-open 把“可用性”建在“猜对”上，不可接受。

### B. 映射表精确反解（延期，非被否）

注册名中段 id 的分配方（池侧单元表 `entry.id`、直连侧账本）各持一张 (id → (root, name)) 映射，直呼时查表即得唯一解，无歧义。这是正解，但需要跨域值边或调用点契约扩展（见 `middleware-register.ts:718-726` 的 I2① 约束），#903 范围内做不完。列入后续增强，见代码注释 `middleware-register.ts:751`。

### C. 改 publicToolName 编码避开歧义（被否）

对方最强的理由：换一种无歧义的注册名编码（如转义 `__`），根上消灭歧义，守卫与 dispatch 两侧同时受益。

否决：注册名是官方 `mcp__` 契约面（`publicToolName`/`INVALID_NAME_CHARS`），改编码即改对宿主与外部的可见契约，冲击面远超一个守卫分支。以后若官方编码本身变化再跟随，见代码注释 `middleware-register.ts:751-752`。

## Consequences

- 含 `__` 的工具经直呼路径被拒绝，错误信息指往 `ws_mcp_call`（服务器裸名+工具裸名确定性裁决，该路径照常用，无能力损失）。
- 与 dispatch 侧不对称即复活本风险：`workspace/impl/full-name` 的 `normalizeToolName` 对跨 server 前缀同样 fail-closed，两侧必须同向；任一侧改回 fail-open，禁用绕过重现。
- 实据：`packages/dsh-mcp-manager/src/server/inject/middleware-register.ts:745-759`（B11 fail-closed 分支）；回归 `packages/dsh-mcp-manager/test/unit/unit-middleware.test.ts:2364`（B11 拒绝用例，#903 B-M4）。
- 互链：放行侧的正解是 [guard fail-closed B11](../../implemented/architecture/2026-09-19-guard-fail-closed-b11.md)；连接路径单本账背景见 [single-pool](../../implemented/architecture/2026-09-19-single-pool.md)。
