# scripts/ — 仓库维护脚本

按职能分目录：`build/` 构建流水线、`gate/` 根门禁与聚合 patch、`lib/` 纯共享库、
`release/` 发布/周期 CI、`test/` 脚本自测、`data/` 配置数据。

## build/（构建流水线，每个插件包 build 都会跑）

- `build/clean-lib.ts` — 构建前清空插件 `lib/`（产物目录）。
- `build/bundle-host.ts` — 宿主端发布构建（esbuild 内联 shared + d.ts X1），单包构建编排。
- `build/build-client.ts` — 客户端契约外壳/唯一注入点，构建 `lib/client.js`。
- `build/collect-licenses.ts` — 归集被内联第三方库的 LICENSE 进 `lib/THIRD-PARTY-LICENSES`。

## gate/（根 pnpm 门禁 + 聚合 patch）

- `gate/contract-check.ts` — 客户端契约门禁（load id === 包名、`dsh.client ⇒ exports["./client"]` 等）。
- `gate/pack-check.ts` — tarball 完整性门禁（含聚合包、THIRD-PARTY-LICENSES 覆盖）。
- `gate/verify-npm-layout.ts` — npm 发布布局校验。
- `gate/verify-docs.ts` — 文档/description 校验（缺 .md、占位符残留）。
- `gate/aggregate.ts` — 聚合 `cordis.patch.yml` 生成 + 一致性校验（`--check` 供 CI）。
- `gate/crap-check.mjs` — 单函数 CRAP 复杂度检查（阈值唯一事实源 scripts/data/gauntlet.config.json 的 crap.threshold / crap.strict）。**现状为 fail-closed 停用态（#722 阶段三）**：其圈复杂度取自 lib 编译产物，而覆盖率已切 src 口径，两者行号不可比——入口自检不匹配即 exit 2，不再以「0 个函数」静默放行；src 口径重建归阶段 5（与 ESLint 复杂度规则同批）。
- `gate/forbid-src-tests.mjs` — #423 防双份回潮：扫 packages 下全部遗留 src 副本测试文件（含未跟踪），命中即 exit 1。
- `gate/local-gate.mjs` — 本地/PR 门禁分层入口（`pnpm gate:changed` / `gate:pr` / `gate:full`，#726）：
  按改动类型选闸，PR 默认走增量口径，打 `gate:full` 标签才跑全量（覆盖率 + 变异 + 全仓产物闸）。
- `gate/gen-stryker-conf.mjs` — 变异配置生成/校验：派生 `vitest.stryker.d/<pkg>.config.ts` 并同步各包 `--min`（`--check` 供门禁，`--sync-test-min` 改 `--min`）。
- `gate/test-surface.mjs` / `gate/mutation-topology.mjs` — 测试分层与变异面登记校验（唯一事实源 `data/mutation-topology.json`）。
- `gate/threshold-monotonic.mjs` — 阈值单调性校验（对比 `origin/main`，只许升不许降）：守护 `vitest.config.ts` 的 `coverage.thresholds`（#722 阶段三起的覆盖率唯一事实源）与 `gauntlet.config.json` 的变异阈值。

## maintenance/（一次性维护脚本，按需手工执行）

- `maintenance/repair-mcp-catalog-sessions.mjs` — #723 一次性修复：把 dsh-mcp-manager 0.2.x 及更早写入的旧目录 source（`kind: "mcp-catalog"`）改写成宿主词表内的通用形态，救回升级 dsh 后无法加载的历史会话（默认 dry-run，`--apply` 落盘并留 `.bak-<时间戳>` 备份）。根脚本别名：`pnpm repair:mcp-catalog`。

## lib/（纯共享库，只被 import，不被 `node` 直接调用）

- `lib/client-contract-lib.ts` — 客户端契约断言（stub/执行实现同源唯一事实源）。
- `lib/plugins-manifest-lib.ts` — 插件清单单一事实源（issue #36）纯函数库。

## release/（发布/周期 CI 专用）

- `release/verify-version.ts` — 发布前校验全包版本 == tag。
- `release/publish-if-missing.ts` — 发布缺失包。
- `release/health-report-body.mjs` — 健康报告 body 生成。

## test/（脚本自测，`pnpm test:scripts`）

- `test/run-vitest.mjs` — 包级 test 脚本的 vitest 包装：在 vitest 之上恢复 `--min <文件数>` fail-closed 判据（防 include 漂移的假绿）。
- `test/build-client.test.ts` — build-client 脚本自测。
- `test/collect-licenses.test.ts` — collect-licenses 脚本自测。
- `test/crap-check.test.ts` — crap-check 脚本自测（config.strict 单一开关；#722 起含「src 口径数据必须 fail-closed」用例）。
- `test/threshold-monotonic.test.ts` — 阈值单调性自测（#722：vitest.config.ts 的 coverage.thresholds 提取、降线判红、缺块 fail-closed）。
- `test/mutation-lib-to-src-hook.mjs` / `mutation-lib-to-src-loader.mjs` — #423 方案 A：Stryker 宿主将同包 `packages/<pkg>/lib/<relative-file>.(js|ts)` 重定向到 `src/<relative-file>.ts`；只处理相对/file URL，保留 packages 边界并排除 shared、node_modules、client 与路径穿越。

## data/（配置数据）

- `data/plugins-manifest.json` — 插件清单（某插件是否参与聚合/发布校验的唯一声明处）。
- `data/gauntlet.config.json` — 变异与 CRAP 阈值唯一事实源（覆盖率阈值自 #722 阶段三起改由 `vitest.config.ts` 的 `coverage.thresholds` 承载）。

## 仓库根的派生生成物

- `vitest.stryker.d/<pkg>.config.ts` — 每包一份的 Stryker vitest 配置（由 `gate/gen-stryker-conf.mjs` 生成，
  勿手改；测试面写在它的 `include` 里，Stryker 侧不再用 `testFiles`）。
- `stryker.conf.d/<pkg>-<segment>.json` — 各变异段配置（同源生成）。
