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
- `gate/crap-check.mjs` — 单函数 CRAP 复杂度检查（阈值唯一事实源 scripts/data/gauntlet.config.json 的 crap.threshold / crap.strict，观察期仅记录，翻期可置 true 判红）

## lib/（纯共享库，只被 import，不被 `node` 直接调用）

- `lib/client-contract-lib.ts` — 客户端契约断言（stub/执行实现同源唯一事实源）。
- `lib/plugins-manifest-lib.ts` — 插件清单单一事实源（issue #36）纯函数库。

## release/（发布/周期 CI 专用）

- `release/verify-version.ts` — 发布前校验全包版本 == tag。
- `release/publish-if-missing.ts` — 发布缺失包。
- `release/health-report-body.mjs` — 健康报告 body 生成。

## test/（脚本自测，`pnpm test:scripts`）

- `test/build-client.test.ts` — build-client 脚本自测。
- `test/collect-licenses.test.ts` — collect-licenses 脚本自测。
- `test/plugins-manifest.test.ts` — plugins-manifest-lib 自测。

## data/（配置数据）

- `data/plugins-manifest.json` — 插件清单（某插件是否参与聚合/发布校验的唯一声明处）。
- `data/gauntlet.config.json` — CRAP 阈值唯一事实源。
