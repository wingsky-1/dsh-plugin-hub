# gate 落点辨析（oss-pipeline 头部定义框下沉）

权威口径以根 `AGENTS.md` 门禁矩阵为准，本文件只做执行期阅读版，不另立口径。

## CI 落点三维度

总起：**CI 在 PR 上**的 `build` / `test` 按命中包切片（`ci.yml` 的 paths-filter），不是 `pnpm build && pnpm test` 的全仓口径。

- **全仓 build 在默认 PR 路径就会跑**（命中变异切片时 `mutation-gate` 先全量构建）。
- **全仓产物闸的聚合形态只在 `gate:full` 标签、夜间班次与 tag 触发的 `release.yml` 跑**——命中全局面、fail-closed 回退或全部包各自命中时，默认 PR 路径那个切片就是全集，覆盖效果等同（三闸的 `scoped === null` 与「传全包名」同口径）。
- **全仓 test / typecheck 没有 CI 聚合口径**——`ci.yml` 只按命中包逐包跑（同上三种情形该矩阵覆盖全部包），聚合 `pnpm test` 只在 tag 触发的 `release.yml`；本地 `gate:pr` 的全仓 test/typecheck 同样是逐包 `--filter` 形态（对象面等价），聚合 `pnpm typecheck` 只有 `gate:full`。故完成定义不读作「CI 已验全仓 test」。

## 旧称映射

旧称「五连门禁」= 全仓 `pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck`，**已整体并入 `pnpm gate:pr`**（本地 pr 即全仓口径；`gate:full` 在其上只多「豁免到期台账」收集，`--with-coverage` 再补 cov / crap）。注意旧写法本身自审计 P0-1 起已**不等价**：目录门面 / 导出面快照 / 跨包扇入三闸已迁成 ci.yml 与本地档位的直接步骤，照旧写法操作会得到更弱的覆盖面。`agents/` 与其它 skill 沿用旧称处按本文件理解。
