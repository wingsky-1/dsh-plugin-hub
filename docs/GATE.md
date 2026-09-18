# 门禁语义与分层（docs/GATE.md）

本文件是门禁口径的**唯一语义出处**；`AGENTS.md` 门禁节只定决策（哪档何时用），
闸名单、数量、阈值、收口状态一律以本文件与所指事实源为准，不在别处复述。
各脚本头部那行「退出码：」只讲它自己的归类（用法面），语义分歧以本文件为准。

## 1. 分层与命令

| 层       | 命令                                      | 口径 |
| -------- | ----------------------------------------- | ---- |
| 快线     | `pnpm gate:changed`                       | 迭代中反复跑：只跑 diff 命中包的 build + test + typecheck |
| 最小集   | `pnpm gate:pr`                            | 开 PR 前本地最后一遍：全仓口径（全仓 build/test/typecheck + 全仓产物闸 + 廉价全仓一致性闸 + `test:scripts`，见 §2） |
| 收尾     | `pnpm gate:full`                          | 同最小集，另加「豁免到期台账」收集；`--with-coverage` 再补 cov / crap；改过构建链、包结构或发版前跑一遍 |
| 全量     | CI 夜间班次（`observe.yml`）              | 全仓产物闸 + 覆盖率 + 全量变异与基线并集入档；本地不默认跑 |
| 提交钩子 | `lefthook`（`pre-commit` / `commit-msg`） | 提交瞬间最内层：只对本次 staged 源文件跑 lint 并校验提交信息；不替代上面任何一层 |

包面归属取自 `ci.yml` 的 paths-filter（唯一事实源，本地不重述路径规则）；
命中全局面时自动升级为 `gate:pr`，解析失败一律回退全量（fail-closed）。
本地实现：`scripts/gate/local-gate.mjs --tier <changed|pr|full>`。

最小集与收尾是**全仓对象面**（本地没有 PR 上下文可切，包面恒为全部包），
全仓产物闸（`contract` / `pack:check` / `verify:npmlayout`）传全包包名；
廉价全仓一致性闸：`threshold-monotonic`、`stryker:check`、`aggregate:check`、
`test:src-tests`、`gate:homedir`、`gate:module-state`、`docs:check`、
`verify:scripts-index`、`verify:coverage-scope`、`verify:vendored-binaries`、
`lint`、`format:check`（均秒级且不依赖 lib 产物）；
`test:scripts` 有编译面用例依赖声明产物，本地会先跑一次编译面前置包 build。
收尾 ≠ 夜间口径：夜间 `observe.yml` 另含覆盖率与全量变异、且不跑全仓 test/typecheck
（全仓 build 在夜间两个 job 内各有一处：quality 一次 + mutation-shards 每个变异段一次）。

## 2. 改动类型 → 归属层

| 改动类型                                                                     | 归属层                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 新增 / 退役包、改 `cordis.patch.yml`                                         | `gate:full`（含全仓 `aggregate:check` + `verify:npmlayout`）                                   |
| 新增 `*.src.test.ts`                                                         | `gate:pr` 起（含 `test:src-tests`）                                                            |
| 改 `src/` 里 HOME 来源 API                                                   | `gate:pr` 起（含 `gate:homedir`）                                                              |
| 改 `scripts/` / workflow                                                     | `gate:pr` 起（含 `test:scripts`）；改 `.github/` 属红线，先评审                                |
| 改 README、新增文档链接                                                      | `gate:pr` 起（含 `docs:check`，见 `scripts/gate/verify-docs.ts`）                                |
| 改任意手写源码（`packages/*/src`、`packages/*/test`、`shared/`、`scripts/`） | `gate:pr` 起（含 `lint`：ESLint 复杂度门禁，阈值见 `scripts/data/gauntlet.config.json` 的 `complexity` 段） |
| 提交前最终一遍                                                               | `pnpm gate:pr`；单包迭代用 `pnpm gate:changed`                                                 |

分层**不减少检查，只改变时机**：CI 的 PR 默认路径与本地 `gate:changed` 走增量
（命中包切片）；只有“必须全仓才能判定”的覆盖率分母与全量变异基线留夜间；
高风险改动打 `gate:full` 标签在 PR 上补跑（追加覆盖率与全仓产物闸）。

## 3. 变异口径

变异不在本地任何档，但 PR 上强制跑：命中变异切片的 PR 一律实例化该切片的变异矩阵
并聚合判分（打不打 `gate:full` 标签都跑），改的是命中包 `test/**` 时该包基线会被
主动失效、退化为全量。因此**本地 `gate:*` 全绿不等于 CI 绿**——变异不达标只在 CI 上暴露。
段划分见 `scripts/data/mutation-topology.json`（段 ≠ 配置文件，不在本文件复述数量），
实测台账见 `scripts/data/mutation-segment-ledger.json`，守卫与判分见
`scripts/gate/mutation-gate.mjs`、`scripts/gate/mutation-topology.mjs`、
`scripts/gate/mutation-ledger.mjs`。

## 4. 退出码三态

`0` = 判据通过；`1` = 判据按设计判红（结论可信：改动确实不达标）；
`2` = **门禁故障（非判据结论）**——读不到输入、配置损坏、环境缺件，此时门禁不可信，
既不能读成「通过」也不能读成「不达标」。
`scripts/gate/**` 与 `scripts/release/**` 里的 exit 2 一律经
`scripts/lib/gate-exit.mjs` 的 `failClosed()` 出口（裸写法由
`scripts/gate/forbid-raw-exit2.mjs` 拦）；上游 job 报 `failure` 时靠状态文件 +
`GATE_FAILURE_CLASS` 区分两类（缺省 = `crashed`，fail-closed）。
本契约按门禁逐个收口；未收口门禁的 exit 2 同按不可信处理，不得据此读成全仓已收口。
exit 2 一律按「门禁不可信 ⇒ **禁止合并**」处理，并在原 issue 开一条 P0 跟踪项
（gate 缺陷），**不允许以「环境抖动」结案**；同一 exit-2 判词在 30 天内第二次出现
即升级为熔断（`blocked-human`）。

## 5. homedir 零豁免

新增 `homedir()` / `process.env.HOME` / `untildify()` 调用**没有豁免通道**：
一律改走 `shared/dsh-home.js` 的 `dshHome()` 接缝，写在插件 src 里即判红
（见 `scripts/gate/forbid-homedir-src.mjs`）。确有「DSH_HOME 域之外」的合法场景时
先在 #765 讨论，不得在闸内复活豁免常量或注释词法。

## 6. 覆盖率 / 变异 / CRAP 事实源

质量指标 `pnpm cov` / `pnpm crap`。阈值事实源按维度分处：**覆盖率**在
`scripts/data/coverage.config.json`（`vitest.config.ts` 只 import 它，不得再内联
`include`/`exclude`/`thresholds`；降线由 `scripts/gate/threshold-monotonic.mjs`
对比 `origin/main` 拦截，面完整性由 `verify:coverage-scope` 守），**变异与 CRAP** 在
`scripts/data/gauntlet.config.json`。观察期开关不得自行改，开启时机另行裁决；
数据源缺失或解析失败仍 fail-closed `exit 2`（见 `scripts/gate/crap-check.mjs`），
与观察期语义不矛盾。
