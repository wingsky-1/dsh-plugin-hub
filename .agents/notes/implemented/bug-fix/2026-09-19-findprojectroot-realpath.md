# Agent Note: normalizedProjectRoot 落 realpath 收敛双拼写

Status: implemented

## Problem

`normalizedProjectRoot` 的注释承诺 realpath 归一化，实现却直接返回 `findProjectRoot` 的 resolve 结果：同一项目经符号链接以不同拼写进入时，归一化输出仍是两种拼写。下游以该输出为键（中间层 `units`、项目 `projectStores`），两种拼写建出两套单元与两套 store：同一项目的服务器被连接两次，`units.size` 也不再为 1。注释与实现互相矛盾，按注释写去重假设的调用方全部落空。

## Decision

归一化点保留在 `normalizedProjectRoot`（发现与归一分离，发现仍返回 resolve 拼写），归一化对 `findProjectRoot` 结果做 `realpathSync`，抛错时回退该结果（不存在路径不断言、不抛）。`realpathSync` 取自 `node:fs`（与既有 `existsSync` 同模块，不新增 dir-imports 边；`fs/promises` 的异步形态在此处无收益且新增一条边）。两处既有注释（本文件 `:48`、`middleware.ts:223` 的 realpath 表述）随实现变真，不改。

## Alternatives considered

### 入口 canonicalize（被否）

对方最强的理由：离输入最近，一次改动覆盖全部调用方（含 `setSession`/`catalogServersFor` 的 raw 路径），不留第二种拼写。

否决：`findProjectRoot` 的调用方不全要 canonical 语义。`setSession` 的幂等比较与 `catalogServersFor` 的配置读取按 resolve 拼写工作已久，入口改动一次性改变全部调用方的键空间，回滚面大；B2 的故障点是归一化承诺未兑现，修承诺点（`normalizedProjectRoot`）即收敛全部经归一化取键的路径（执行路由、目录视图、中间层宿主），范围最小。入口方案的额外覆盖是另一个决策，不在本笔展开。

### 维持 resolve 加改注释（被否）

对方最强的理由：零行为风险，承认 resolve 语义，把两处 realpath 注释改成 resolve 表述，测试与实现都不用动。

否决：需求侧（F3-2）定的单元键语义就是 realpath，注释改弱等于把同一项目两种拼写建两套单元合法化：双连接、双 store、双目录缓存全部转正，后续只能在外层逐个调用点手写去重，复杂度更高。注释是契约，实现向契约看齐，不反过来。

## Consequences

- 收益：双拼写收敛同一键（回归锁定：归一化相等、`projectStoreFor` 同一实例、`units.size === 1`；反证：换回 resolve 则三者红）。
- 代价：`userState.json` 中历史 symlink 拼写键一次性变孤儿（新键为 real 路径，旧键不再命中），接受为一次性代价，不做迁移代码。孤儿键只占少量磁盘，不影响新单元行为；用户禁用态在新键下重新落盘一次。
- 边界：不存在路径走 catch 回退原样返回（回归锁定，防 stryker 存活）；`findProjectRoot` 本身仍返回 resolve 拼写，直接消费它的 raw 路径（`setSession`、`catalogServersFor`）不在本笔改动范围内。
