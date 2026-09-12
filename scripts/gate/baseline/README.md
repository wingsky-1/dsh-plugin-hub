# Incremental mutation baseline（#572 孤立分支基线存储）

本目录的历史 JSON 基线文件已全量迁移至独立孤立分支 **`refs/heads/baseline/mutation`**（#572）。

### 为什么迁移至孤立分支？
此前（#204 方案 A）将 20 份 incremental 基线 JSON 提交至 main 分支本目录下，每次更新由机器自动提 PR 合并，导致：
1. 每次提交产生 8 万至 16 万行 JSON diff，使 Git 仓库历史严重膨胀；
2. PR 与 Commit 列表充斥大量机器噪音。

### 现状与维护机制（#572）
- **存储位置**：孤立分支 `baseline/mutation`（历史深度恒为 1，无父提交，不影响 main 分支代码树）；
- **存储格式**：解开的纯文本 JSON 目录树（`incremental-*.json` + `manifest.json`），充分利用 Git Blob 原生内容寻址与去重红利（未变动文件 0 开销）；
- **工作流同步**：
  - 全量班（`observe.yml`）跑完后，通过 `node scripts/gate/orphan-baseline.mjs archive` **并集入档**（见下节）；
  - 增量班（`observe-incremental.yml`）退役前仍走 `node scripts/gate/orphan-baseline.mjs push`（整树推送，
    但它先 `restore` 再跑，所以推回去的本身就是全集）；
  - PR 门禁（`ci.yml` 的 `mutation-gate`）通过 `node scripts/gate/orphan-baseline.mjs restore` 浅拉取恢复到 `coverage/mutation/`；
  - PR 合并到 main 后由 `baseline-overlay.yml` → `node scripts/gate/overlay-baseline.mjs` 秒级差量覆盖（复用该 PR CI 产出的 `mutation-incremental-*` artifact）；
  - 任务统一收敛至互斥并发组 `concurrency: group: mutation-baseline-sync`。

### 并集入档与可回滚（#718 S1.2）

`archive` 之前，写入口是**整树替换**——把「本班次目录里有什么」当成「归档的全部内容」。段一旦没产出
（矩阵实例超时/被杀），该段文件就不在新树里，归档**静默缩水**：实测 2026-09-12 全量班 33 段只成功
31 段，归档随之从 33 段掉到 31 段，且没有任何日志说明。现在：

- **并集语义**：先取回远端现存基线，再叠加本次产物。本次有的以本次为准（**新算**），本次没有但远端
  有的沿用旧文件（**沿用**），两边都没有的显式点名（**缺**）。段被失败实例吃掉因而在物理上不可能再发生。
- **逐项记账**：每次入档打印「期望 N 段：新算 x / 沿用 y / 缺 z / 退役 w」。缺段打 `::warning::` 并点名
  （不判红——拆段当夜新段本就无基线可沿用）；真·数据丢失由段报告齐备性校验与台账 `--check` 兜底判红。
- **退役清理**：期望集合由 `stryker.conf.d/dsh-*.json` 派生，不在集合里的遗留文件（段被拆并/改名后的旧文件）
  从归档移除并点名。并集语义本身不会删文件，所以这一支必须显式做，否则遗留段会永远留在归档里。
- **零新对象**：沿用文件直接复用远端 blob sha，不做内容往返，字节级一致因而保住「未变动文件 0 开销」。
  沿用段在 `manifest.json` 里保留远端条目（其 `mtime` 是上次**真实测量**时间；重新盖章会让陈旧判据失效）。
- **可回滚**：分支深度恒为 1（无父提交），可回滚性由**快照 tag** `baseline-snap-<UTC 时间戳>-<旧 tip 短 sha>`
  承担，保留最近 10 个（`ARCHIVE_SNAPSHOT_KEEP`）。回滚即
  `git push origin refs/tags/<快照 tag>:refs/heads/baseline/mutation --force`。
  tag 刻意不以 `v` 开头——`release.yml` 由 `push: tags: v*` 触发。
- **推送用显式租约**：`--force-with-lease=refs/heads/baseline/mutation:<读到的旧 sha>`。本路径不做 fetch，
  无参的 `--force-with-lease` 会退化成裸 `--force`（#718 裁决），故必须带上读到的期望值。
- **两条 fail-loud**：远端取不到（`present`/`unreachable` 且 fetch 失败）时拒绝入档——并集语义下
  「取不到远端」等于「沿用集合未知」，以空集合推送就是删段；`stryker.conf.d/` 派生不出期望集合时同样拒绝
  （空期望集合会把每个现存文件判成退役，反手删掉整棵归档）。

### 归档缺口与对账（#714 后续修复）
`overlay-baseline.mjs` 曾按 GitHub API 的**默认分页（30 条/页）**读取 artifact 列表，而一次 PR CI 会产生
70 个 artifact（其中 31 个 `mutation-incremental-*`），于是每次合并只覆盖 14 段，随后整棵树强推会把
未覆盖段的旧版本固化，`provider-usage-errsurf` 与 `web-file-preview` 两段更是每次被抹掉。

现行实现：
- 分页取全（`per_page=100` + 页号严格递增 + 空页/`total_count` 双终止条件 + 20 页硬上限）；
- 推送前**对账**：期望集合由 `stryker.conf.d/*.json` 派生，凡「既未被本次覆盖、也不在旧基线里」的段
  判为缺口并**非零退出 + 点名**（仍照常推送，避免归档停在更旧的树上）；
- artifact 列表查询失败改为 **fail-loud**（原来 `exit 0` 静默跳过，等于把「查不到」当成「没有」）；
- 纯函数（分页合并 / 期望集合派生 / 对账）在 `scripts/gate/baseline-archive.mjs`，由
  `scripts/test/baseline-archive.test.ts` 覆盖（含「旧实现只看到 14 段」的回归用例）。
- **本地调试**：
  - 本地若需要远端基线辅助增量测试，可执行：
    `node scripts/gate/orphan-baseline.mjs restore`
  - 注意：本地若没有可用的 `origin`（或远端不可达），该命令会**非零退出**，不再静默降级（见下节）。

### 恢复与查询失败的三态语义（#718）

`orphan-baseline.mjs restore` 与 `overlay-baseline.mjs` 的远端探针**共用同一判据**
（`baseline-archive.mjs` 的 `classifyRemoteProbe` / `decideRestoreOutcome`），用
`git ls-remote --exit-code` 的**退出码**分三态，不再用「stdout 是否为空」反推：

| 探针结果 | 含义 | 动作 |
|---|---|---|
| `present`（exit 0） | 本次广告里有 `baseline/mutation` | 拉取；拉取失败 → **fail-loud** |
| `absent`（exit 2） | 本次广告里没有该 ref | **唯一**允许降级为全量的情形（首夜，`::notice::`） |
| `unreachable`（其它/无退出码） | 远端不可达 / 权限故障 / URL 不可解析 | 不跳过 fetch；拉取仍失败 → **fail-loud** |

另有两条同类收紧：远端树里有 blob 却**无任何基线文件**（命名漂移）在写路径上判 fail-loud
（继续会用本班产物覆盖这些未知文件）；overlay 的「查询关联 PR」「查询 Workflow Runs」
两处失败也改为 fail-loud——**「查不了」与「查不到（空数组）」是两件事**，后者仍是正常 no-op。

表里 `unreachable` 只决定「是否跳过 fetch」，不单独决定最终动作：`decideRestoreOutcome` 把
`fetchOk` 放在第一位，所以**探针三连失败但 fetch 反而成功时，判为恢复而非判红**（探针假阴性
被救回）；只有 fetch 也失败才 fail-loud。`absent` 是唯一的确定结论——它直接跳过 fetch 并降级。

**已知边界（不要误读为强保证）**：`absent` 只能证明「本次广告里没有这条 ref」，**不能**证明
服务端上不存在——服务端可用 `uploadpack.hideRefs` 隐藏某条 ref，此时与真·首夜完全同形，
客户端无从区分。这一支上 workflow 层 `mutation-suites` 的 outcome 门控（`observe-incremental.yml`
的 push 步骤要求它非 `skipped`，而它依赖 restore 非零退出）仍在起作用；**写路径侧的防护**已由
#718 S1.2 落地：全量班改走并集入档（`planArchive`，见上节），且拉取失败一律 fail-loud，
「取不到就当空归档推回去」这条分支已不存在。

**两条路径的有意差异**：orphan 侧在「远端树里有 blob 却无基线文件」时**拒绝继续**（fail-loud）；
overlay 侧没有这个检查，而是由 `reconcileArchive` 以 `archiveGap` 判红、**仍照常推送**——
因为 overlay 是差量覆盖，拒绝推送会让归档停在更旧的树上。两处语义不同是有意的，不要当作不一致。

> 注：`.github/workflows/ci.yml`（「首夜/基线缺失时天然降级为全量变异，门禁语义不变仅变慢」等）
> 与 `observe-incremental.yml` 的对应注释**尚未同步**。`.github/` 属红线，须在 issue 内取得
> 维护者 `approved` 后单独修改；在同步之前，以本节与脚本头部注释为准。
