# Agent Note: 持久化正确性：串行链、全文快照与写前 fail-closed

Status: implemented

## Problem

三类丢数据：同毫秒内两次写使 mtime 检测漏检；跨实例并发 `save` 在检查与落盘之间插空、互相覆盖；外部编辑（git pull / 手动改）被静默覆盖等于丢用户数据。

## Decision

同路径 `save` 经模块级串行链排队（跨实例生效，前败不阻断后续）；基线为 mtime + 全文快照双锁；写前在链内复检基线，失配即 fail-closed 抛错。

## 机制与实据

- 串行链（#903 M-store）：`saveChains` 模块级、`previous.then(onFulfilled, onRejected)` 双回调接续，前一次失败不阻断下一次；冲突检查必须在链内，检查放链外形同虚设（`packages/dsh-mcp-manager/src/server/store/impl/store.ts:18-27`、`83-98`）。
- 唯一临时名：pid + 时间戳 + 随机后缀，同名 tmp 永不复用；失败清理 tmp 后上抛原错误（同文件 `:24-27`、`119-135`）。
- 双锁基线（#903 M3-store）：`mtimeMs` + `snapshot` 全文快照；mtime 相等再比全文，防同毫秒漏检；损坏存储保持内存态、不崩溃（同文件 `:43-49`、`57-80`、`144-161`）。
- 写前 fail-closed：`writeSnapshot` 首行复检，失配抛错由路由 `handleError` 如实返回；无基线（新 store 未 load）不视为冲突（同文件 `:100-108`）。
- 现状细节见 [`dsh-mcp-manager.md` §3.2](../../../../docs/architecture/dsh-mcp-manager.md) 与 file-io 收敛点（`docs:246`），本篇只记取舍。

## Alternatives considered

- 直接调 `writeFileAtomic`（file-io 唯一收敛点）：最强理由是单点复用、少一层特例。否定：回落写盘会被变成写失败——`middleware-state#writeStateFile`、`manager#writeCatalogCacheFile` 与 S2-B 的 `store.save` 三处同式只能硬化（唯一 tmp 名 + 清理，不改写盘语义），见 docs `248` 行段。
- mtime-only 检测：最强理由是少一次全文读、更快。否定：同毫秒多次写与外部改同毫秒必漏检（上文 `:154` 注释实据），快照是第二道锁，不可省。
- 不加串行链（`rename` 原子即够）：最强理由是 POSIX 原子语义已保证不断裂。否定：原子只保不断裂，不保先后顺序——同毫秒两次 save 的 tmp 同名互盖加 rename 竞态照样丢更新（上文 `:18-20`）。

## Consequences

- 收益：并发与外部编辑两类覆盖丢失被消除或转为显式错误；损坏文件不崩溃、不复活已删配置。
- 代价：每次 `save` 潜在多一次全文读；基线失配时调用方须重载重试（写失败显式化，调用链须处理）；串行链是进程内语义，跨进程并发仍靠基线复检兜底。

同源决策：[单池](./2026-09-19-single-pool.md)（守卫名单落盘正确才可信）。文档镜像纪律见[配置与契约文档以代码为单一事实源](../../implemented/process/2026-09-18-config-doc-mirror-policy.md)。
