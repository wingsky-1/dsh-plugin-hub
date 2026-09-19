# Agent Note: 歧义直呼 fail-closed（B11）

Status: implemented

## Problem

注册名含连续双下划线时，第一个 `__` 分割无法唯一反解 `(server, tool)`（`mcp__my__sv__t` 既可能是 server=`my`+tool=`sv__t`，也可能是 server=`my__sv`+tool=`t`）。旧口径 fail-open 放行让已禁用的含 `__` 工具经直呼路径绕过禁用、复活。

## Decision

tool 段仍含 `__` 即存在歧义，一律拒绝并指往 `ws_mcp_call`（裸名确定性裁决，含 `__` 工具经由该路径照常用）。本次 #903 B-M4 即这次 fail-open→fail-closed 翻转，不另立篇。

## 机制与实据

- 裁决点 `handleDirectMcpGuard`（`packages/dsh-mcp-manager/src/server/inject/middleware-register.ts:745-760`）：`tool.includes("__")` 即 deny，reason 指往 `ws_mcp_call`；与 dispatch 侧 `normalizeToolName` 对跨 server 前缀的 fail-closed 同口径。
- 回归两例：错位形态记录与真实形态记录同样拒绝（`packages/dsh-mcp-manager/test/unit/unit-middleware.test.ts:2364-2375`、`2377-2387`）。
- 边界：id 反解（注册名中段是分配 id 而非裸名）缺失时按裸名解释，旧形态名与测试假条目口径不变（同文件 `:761-766`）；root 不可解析时仅 `@global` 共享记录生效（`:767-776`）。
- 现状细节见 [`dsh-mcp-manager.md` §2](../../../../docs/architecture/dsh-mcp-manager.md)，本篇只记取舍。

## Alternatives considered

- 维持 fail-open 放行：最强理由是可用性优先，歧义名照常用、不误伤。否定：已验证旧口径下已禁用的含 `__` 工具经直呼复活（上文测试实据），可用性不能以禁用 bypass 为代价。
- id→名映射表精确裁决：最强理由是零误伤、两可形态各得其所。否定方向是暂缓而非抛弃：映射表已列入后续增强（同文件 `:751`），本次先以 fail-closed 保安全下限。
- 改 `publicToolName` / `INVALID_NAME_CHARS` 根除 `__`：最强理由是一次性消除歧义源。否定：冲击官方 `mcp__` 契约（同文件 `:751-752`），越界代价不可接受。

## Consequences

- 收益：禁用表对直呼路径无 bypass；裁决口径与 dispatch 侧统一，含 `__` 工具仍有确定性可用路径。
- 代价：歧义名直呼被拒，用户须改走 `ws_mcp_call`（多一步）；映射表未建之前，真实形态记录同样被拒（误伤换安全，待增强消除）。

同源决策：[单池](./2026-09-19-single-pool.md)（唯一连接路径是本裁决的前提）。文档镜像纪律见[配置与契约文档以代码为单一事实源](../../implemented/process/2026-09-18-config-doc-mirror-policy.md)。
