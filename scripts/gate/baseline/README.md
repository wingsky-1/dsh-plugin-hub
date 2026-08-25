# Incremental mutation baseline（#204）

本目录存放夜间全量变异产出的 Stryker incremental 基线（每包一个 JSON，含 mutant
指纹与覆盖信息），由 `.github/workflows/observe.yml` 每夜更新、经
`create-pull-request` 自动合入 main。

PR 的 `mutation-gate`（ci.yml）直接从本目录读取对应包基线文件，复制到
`coverage/mutation/` 供 Stryker 增量模式跳过未变 mutant——替代失效的
actions/cache 跨 ref 通道（actions/cache 按 ref 隔离，PR 永远 miss main 缓存，
详见 #204）。

文件：
- `incremental-<pkg>.json`：六包 Stryker 基线（notifier / idle-archive /
  web-file-preview / mcp-manager / provider-usage / lan-proxy）
- `manifest.json`：各基线文件 size / mtime / sha256，供判断基线是否有实质变化

手动重建：本地跑 `node scripts/gate/collect-incremental-baseline.mjs`（需先有
`coverage/mutation/incremental-*.json` 产物）。
