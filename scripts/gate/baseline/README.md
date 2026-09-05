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
  - 任务统一收敛至互斥并发组 `concurrency: group: mutation-baseline-sync`。
- **本地调试**：
  - 本地若需要远端基线辅助增量测试，可执行：
    `node scripts/gate/orphan-baseline.mjs restore`
