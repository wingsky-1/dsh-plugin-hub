# Incremental mutation baseline（#204 · #276 方案 A）

本目录存放定时全量变异产出的 Stryker incremental 基线（每段一个 JSON，含 mutant
指纹与覆盖信息），由 `.github/workflows/observe.yml` 每日四班次（北京 09/12/16/20）
更新、经 `create-pull-request` 自动合入 main（快照 PR 每日最多一次，日期闸）。

PR 的 `mutation-gate`（ci.yml）直接从本目录读取对应段基线文件，复制到
`coverage/mutation/` 供 Stryker 增量模式跳过未变 mutant——替代失效的
actions/cache 跨 ref 通道（actions/cache 按 ref 隔离，PR 永远 miss main 缓存，
详见 #204）。

文件：
- `incremental-<pkg>.json`：单段包基线（notifier / web-file-preview）
- `incremental-<pkg>-<seg>.json`：分段包基线（mcp-manager×3 / provider-usage×3 /
  lan-proxy×4）
- `manifest.json`：各基线文件 size / mtime / sha256，供判断基线是否有实质变化

基线口径（#276 方案 A）：mutate 直指 src（源文件名清单），mutant 位置键锚定
**源文件**而非 lib 产物行号——src 编辑造成的位移远小于 bundle 重建，增量命中率
更高。切换口径后旧 lib 基线全部删除，由首次四班次全量重建。

手动重建：本地跑 `node scripts/gate/collect-incremental-baseline.mjs`（需先有
`coverage/mutation/incremental-*.json` 产物）。
