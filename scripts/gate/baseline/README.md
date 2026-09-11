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
  - 全量班（`observe.yml`）与增量班（`observe-incremental.yml`）跑完后，通过 `node scripts/gate/orphan-baseline.mjs push` 强推至孤立分支；
  - PR 门禁（`ci.yml` 的 `mutation-gate`）通过 `node scripts/gate/orphan-baseline.mjs restore` 浅拉取恢复到 `coverage/mutation/`；
  - 增量班通过 `node scripts/gate/orphan-baseline.mjs restore` 恢复基线并执行增量；
  - PR 合并到 main 后由 `baseline-overlay.yml` → `node scripts/gate/overlay-baseline.mjs` 秒级差量覆盖（复用该 PR CI 产出的 `mutation-incremental-*` artifact）；
  - 任务统一收敛至互斥并发组 `concurrency: group: mutation-baseline-sync`。

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
