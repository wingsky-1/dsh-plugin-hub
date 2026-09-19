# Agent Note: 迁移归档多代语义

Status: implemented

## Problem

降级写入会让已归档的旧文件重现：若归档固定覆盖旧名，第一代证据（迁移当时搬走的原样）被悄悄替换，事后无法举证迁移前真相。

## Decision

归档首选固定名（`${source}.migrated.bak` 即“这一份处理过”标记，幂等语义不变）；该名已存在时按 `.2`、`.3` 留多代，永不覆盖第一代证据；占位的是目录则改名失败照抛，旧报警保留。

## 机制与实据

- `archive`（`packages/dsh-mcp-manager/src/server/upgrade/impl/steps/storage-layout.ts:126-142`）：`isRegularFile(target)` 循环递增代际；`renameSync` 失败即抛“改名失败”，不吞为“没有旧数据”。
- 常规文件判定（同文件 `:108-115`）：只跳过多代检查中的常规文件冲突，占位目录走失败路径，旧报警保留。
- 降级提示：源比目标新才出声，且只影响文案、不改变动作（同文件 `:96-106`）；读不出即抛，不当“没有旧数据”（`:117-124`）。
- 回归：重跑不累积、旧文件重现走 `.2` 且第一代逐字保留（`packages/dsh-mcp-manager/test/unit/upgrade/storage-layout.test.ts:189-203`、`205-223`）。
- 现状细节见 [`dsh-mcp-manager.md` §3.6](../../../../docs/architecture/dsh-mcp-manager.md)（布局迁移条），本篇只记取舍。

## Alternatives considered

- 覆盖旧归档：最强理由是目录干净、少占盘。否定：降级写重现场景下第一代证据被覆盖，迁移可举证性丢失（上文测试 `:205-223` 即此场景的锁）。
- 目录占位同样多代：最强理由是对称、旧报警一并保留。否定：目录占位意味着路径形态已坏，“搬不动”必须 loud——改名失败照抛、旧报警保留（上文 `:108` 注释），多代只服务于常规文件。

## Consequences

- 收益：迁移证据链完整，降级写可被发现（warn）且不灭证；重跑幂等。
- 代价：反复降级会累积 `.2`、`.3` 文件，需人工清理；固定名即“处理过”标记的语义须口口相传（见本篇），删 `.bak` 会触发重复迁移（内容不变、可接受）。

同源决策：[持久化正确性](./2026-09-19-store-serial-snapshot-failclosed.md)（同为 fail-closed 方向）。文档镜像纪律见[配置与契约文档以代码为单一事实源](../../implemented/process/2026-09-18-config-doc-mirror-policy.md)。
