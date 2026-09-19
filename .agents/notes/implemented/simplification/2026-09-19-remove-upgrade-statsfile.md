# Agent Note: 删除 UpgradeDeps.statsFile 死字段

Status: implemented

## Problem

`UpgradeDeps.statsFile`（“用户显式配置的统计落盘路径”）在 upgrade 域内零读取点：升级链实际只用 `logger` 与 `storePath`（`packages/dsh-mcp-manager/src/server/upgrade/deps.ts:15-27` 现状即只剩这两项）。死字段的伤害不在运行时，在误导：后人看到装配点传入 `statsFile`，会误以为统计落盘路径仍经 deps 传入 upgrade 域（实际走 `debug.statsFile` 配置链：`config-schema.ts` → `index.ts` → stats collector，与 upgrade 域无关），改统计行为时改错地方。

## Decision

删除 `UpgradeDeps.statsFile` 字段及全部装配传入点（共 5 处，随 `da4eea6e` 落盘）；`debug.statsFile` 配置链（schema、装配、collector）原样不动。字段的唯一真实语义（“显式值 vs 生效路径”，见 `storePath` 注释）本就只属于 `storePath`，`statsFile` 上的“语义同上”注记是复制粘贴残留，随字段一并移除。

## 机制实据

- 删除：`git show da4eea6e -- packages/dsh-mcp-manager/src/server/upgrade/deps.ts`（`statsFile: string;` 及其注释两行删除；同批另 4 处装配点见该 commit 说明）。
- 现状：`packages/dsh-mcp-manager/src/server/upgrade/deps.ts:15-27`（`UpgradeDeps` 只剩 `logger` + `storePath`）。
- 未动链：`packages/dsh-mcp-manager/src/index.ts:207,508,516,607,617`、`server/config/config-schema.ts:31-36`、`server/stats/impl/collector.ts:15-30`（`debug.statsFile` 配置链完好，统计落盘行为零变化）。

## Alternatives considered

### 留字段供未来统计用（被否，YAGNI）

对方最强的理由：upgrade 链将来可能要落统计（如每步耗时），届时 deps 里已有现成字段，省一次接口变更；留一个 `string` 字段成本几乎为零。

否决：成本不在字段本身，在误导。未来真需要时从 git 历史（`da4eea6e`）找回只需一分钟，而留着的每一天都在向读者撒谎（“upgrade 域消费统计路径”)。需要时再加，且按彼时的真实语义命名，不继承今天这个错位的名字。

## Consequences

- 收益：`UpgradeDeps` 即文档——读者看到的两个字段就是 upgrade 域的全部外部依赖；装配点少一处可错传的值。
- 代价：若有外部构造 `UpgradeDeps` 字面量的代码会编译失败；经查构造点全在包内（组合根 + 单测），已同批改完，无外部构造点。
- 本篇只删不增：统计行为、配置键、落盘路径零变化；统计侧的取舍另记，不属本篇。
