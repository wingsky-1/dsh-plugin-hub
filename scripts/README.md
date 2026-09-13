# scripts/ — 仓库维护脚本

按职能分目录：`build/` 构建流水线、`gate/` 根门禁与聚合 patch、`lib/` 纯共享库、
`release/` 发布/周期 CI、`test/` 脚本自测、`data/` 配置数据。

本文件的**索引边界是「仓库会调用什么」**，不是目录清单：新增一个会被调用点引用的脚本必须登记
在此（判据见 `gate/verify-scripts-index.mjs`，`pnpm verify:scripts-index`）；纯库、测试文件与
未被引用的文件不强制登记。

## ci/（CI 切片与矩阵派生）

- `ci/ci-matrix.mjs` — CI 矩阵派生（#722）：从 `ci.yml` filters 的包面算 build / test / typecheck 的实例清单与空切片哨兵项（包面归属的唯一事实源仍是 `ci.yml`，本文件不重述路径规则）；#742 起另为每个变异 combo 派生逐段超时（复用 `gate/mutation-plan.mjs` 的台账公式）与 `invalidateBaseline`。
- `ci/changed-test-packages.mjs` — 本次 diff 里 `packages/<pkg>/test/**` 有变更的包清单（#742 阶段 1.7）：Stryker 的 static mutant 无覆盖信息、测试变更对它们不可见，命中包改了测试就主动失效该包基线（维护者裁决 3）。口径 = `BASE...HEAD` 三点 diff + `--no-renames`。

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
- `gate/mutation-ledger.mjs` — 变异段实测台账（#718 S0.2）：从 Actions run 日志解析逐段 `wallSeconds`（真实执行时间，区别于会被增量班刷新的文件 mtime）与复用率/杀灭分布；`--check` 离线校验覆盖不变量（测量值 ∪ `unmeasured` == 当前 `stryker.conf.d` 段集合，消失的历史段须在 `superseded` 登记取代关系），由 `test:scripts` 调用。生成模式需 gh 与网络，故定位为维护者工具、不进 CI（进 CI 需改 `.github/`，属红线段）。
- `gate/mutation-plan.mjs` — 夜间变异矩阵的段清单与逐段超时派生（#718 S1.1/S1.4）：段清单 glob `stryker.conf.d/dsh-*.json`（与 ci-matrix / mutation-gate 同源），超时按 `mutation-segment-ledger.json` 里该段 `scope=full` 的实测墙钟 × 1.5 + 构建开销派生、下限 30 分钟，无实测的段取保守默认；输出按**估计耗时降序**排列的 matrix JSON（长段先跑 = LPT：GHA 以 `max-parallel` 个槽位按声明顺序消费，实测同一份台账下字典序 makespan 52.9 min 对降序 41.6 min，下界 41.4）供 `observe.yml` 的动态矩阵消费（GHA 矩阵只能引用 needs output、不能读工作区文件，故单列一个秒级 plan job）。
- `gate/verify-dir-imports.mjs` — 目录 `interface.ts` 门面静态检查 + 依赖图尺子（#664 D10 / #670 C2 / #690 S0）：跨模块引用只许走目标模块的 `interface.ts`，单调基线（`data/dir-imports-baseline.json`）存**证据集合**，放宽须登记到 `data/gate-exemptions.json`（gate=`verify-dir-imports`，path=`<包名>:<证据项>`，与另两闸同一套台账）。
- `gate/export-surface-snapshot.mjs` — 包导出面快照门禁（#669 M6）：`tsc --declaration` 产物与入库基线零 diff（符号集 + 导出符号定义块），必须显式 `--package`，基线更新须 `--snapshot` 并随 PR 提交。
- `gate/local-scope.mjs` — 「这次改了什么 → 本地该跑哪些包」的纯函数（#722 门禁分层）：包面只从 `ci.yml` 的 filters 解析，不在本地重述路径规则；全局面命中即把 `gate:changed` 升到 pr。
- `gate/repo-gate-assert.mjs` — repo-gate 聚合闸的 fail-closed 判定（#187 收敛 / #217 解耦）：上游任一 job 非 success 即红，判定逻辑收敛为纯函数（原先内联在 workflow 的 bash）。
- `gate/observe-check.mjs` — 夜间观察报告的阈值校验与回落检测（#85 v3 F1/F6）：产出报告正文 + 三态状态文件（`--status-file`，供通知步骤判「判分完成 / 判分违约 / 脚本崩了」，#733 G1）。
- `gate/mutation-gate.mjs` — PR 增量变异率判分（#178 v2；#217 起由 `mutation-verdict` job 在 artifact 汇合后统一调用），统计口径与夜间班共用 `lib/mutation-report-lib.mjs`。
- `gate/mutation-topology.mjs` — 变异拓扑的派生规则共享模块（#690 S2b / #710 F15），供 `gen-stryker-conf.mjs` 与各门禁共用同一套段/层派生。
- `gate/baseline-archive.mjs` — 变异基线归档分支的纯函数面（#572 / #714）。
- `gate/baseline-push.mjs` — 归档分支写路径的共用管线（#718 S2.1）：夜间并集入档与对账共用一条写路径。
- `gate/orphan-baseline.mjs` — 变异基线孤立分支（`baseline/mutation`）的管理脚本（读 / 并集写 / 清理）。
- `gate/overlay-baseline.mjs` — PR 增量变异产物合入后的秒级覆盖同步（#572）。
- `gate/collect-exemptions.mjs` — 豁免/临时项的到期台账收集（#733 计划项 3.2，裁决见 #765）：递归扫 `data/` 下全部 `reviewBy` 并打印，恒 exit 0——它是**报告**不是判据，到期由人工裁决（不会冻结 PR）。
- `gate/forbid-homedir-src.mjs` — #517 B5：插件 src 禁直连 HOME 来源 API（AST 扫描，`os.homedir` / `userInfo` / `process.env.HOME` / `untildify` 全形态），豁免要求**双源**（台账登记 + 调用点紧邻注释），解析失败 fail-closed。
- `gate/forbid-module-state-src.mjs` — #733 N2a：插件 src 禁**模块级可变状态**（只看 AST 作用域，缩进不再是绕过口），豁免走 `data/gate-exemptions.json` 登记。
- `gate/verify-scripts-index.mjs` — 本文件的索引门禁（#733 计划项 3.3 E2）：① 索引项必须存在 ② 被调用点引用的脚本必须登记（棘轮）。未被任何调用点引用的文件只报告、不判红。

- `gate/verify-coverage-scope.mjs` — 覆盖率面判据（#733 计划项 3.4）：`vitest.config.ts` 不得内联 `include`/`exclude`/`thresholds`；exclude 条目须带 `reason` 与 `kind`（`reviewBy`/`exitCriteria` 只允许 `pending-project`）；物理枚举的每个源文件必须落在 include 或某条 exclude 里（未分类即红）；模式命中 0 文件即红；产物 keys ⊆ include 面（产物比配置新时才执行）。

## maintenance/（一次性维护脚本，按需手工执行）

- `maintenance/repair-mcp-catalog-sessions.mjs` — #723 一次性修复：把 dsh-mcp-manager 0.2.x 及更早写入的旧目录 source（`kind: "mcp-catalog"`）改写成宿主词表内的通用形态，救回升级 dsh 后无法加载的历史会话（默认 dry-run，`--apply` 落盘并留 `.bak-<时间戳>` 备份）。根脚本别名：`pnpm repair:mcp-catalog`。
- `maintenance/scan-actions-concurrency.mjs` — Actions 并发峰值扫描（#718 S0.3）：从 run 日志的 job 起止时间算并发峰值，供「夜间变异段并发上限」这类决策取实测依据（不读工作区、需 gh 与网络，故不进 CI）。

## lib/（纯共享库，只被 import，不被 `node` 直接调用）

- `lib/client-contract-lib.ts` — 客户端契约断言（stub/执行实现同源唯一事实源）。
- `lib/plugins-manifest-lib.ts` — 插件清单单一事实源（issue #36）纯函数库。
- `lib/mutation-ledger-lib.mjs` — 变异段台账的解析与覆盖对账纯函数（#718 S0.2，与 `gate/mutation-ledger.mjs` 同源实现，测试离线 import）。
- `lib/exemption-gate.ts` — 路径受限门禁的**豁免机制**共享实现（#733 计划项 3.2.2）：真实行注释词法 / marker 匹配 / 双源三态裁决 / 台账反向腐烂校验 / 扫描面枚举；策略与扫描器留在各门禁自己手里。
- `lib/gate-scope-registry.ts` — 路径受限门禁的**扫描范围**读取与通配展开（#733 计划项 3.2.1）：未登记 / 范围解析为空一律抛错（未登记即红）。
- `lib/config-matrix-lib.ts` — 配置覆盖矩阵门禁的共享提取器与纯逻辑（issue #471）。
- `lib/dts-cordis-merge-lib.ts` — 「cordis 声明合并必须落在包入口的声明闭包内」判据（#733 宪法第 3 条）。
- `lib/export-faces-lib.ts` — 包导出面「分类登记」准入判据（#733 宪法第 3 条 / M2-3.5）：新增导出必须登记为安装面 / 配置面 / 契约面之一。
- `lib/exports-types-lib.ts` — `package.json` 的 `exports[].types` → 产物相对路径映射（单一实现，pack-check 与导出面校验共用）。
- `lib/surface-extract-lib.ts` — 包导出面提取与入口归属（单一实现，供 `gate/export-surface-snapshot.mjs` 与 pack-check 断言共用）。
- `lib/mutation-report-lib.mjs` — Stryker JSON 报告统计的单一事实源（covered 口径）：observe 夜间报告与 PR 增量门禁共用，防两处口径漂移。
- `lib/package-scope.ts` — 产物闸（contract / pack-check / verify-npmlayout）的包级切片参数解析（#722 门禁分层）。
- `lib/rewrite-dts-paths.ts` — bundle-host d.ts X1 2a 段「shared 相对引用改写」共享库（issue #478）。
- `lib/walk-files.ts` — 递归收集目录下满足谓词的文件（构建复制 d.ts X1 2b 段与 pack-check 随包断言共用同一遍历）。

## release/（发布/周期 CI 专用）

- `release/verify-version.ts` — 发布前校验全包版本 == tag。
- `release/publish-if-missing.ts` — 发布缺失包。
- `release/health-report-body.mjs` — 健康报告 body 生成。

## scripts/ 根

- `tsconfig.json` — `scripts/` 的**增量** typecheck 面（本期仅 `gate/verify-docs.ts` 入面，其余脚本入面属后续独立 issue，见 `scripts/tsconfig.json:1-2` 注释）。

## test/（脚本自测，`pnpm test:scripts`）

- `test/run-vitest.mjs` — 包级 test 脚本的 vitest 包装：在 vitest 之上恢复 `--min <文件数>` fail-closed 判据（防 include 漂移的假绿）。
- `test/build-client.test.ts` — build-client 脚本自测。
- `test/collect-licenses.test.ts` — collect-licenses 脚本自测。
- `test/crap-check.test.ts` — crap-check 脚本自测（config.strict 单一开关；#722 阶段五起含「非 src 口径数据必须 fail-closed」用例）。
- `test/threshold-monotonic.test.ts` — 阈值单调性自测（#722：vitest.config.ts 的 coverage.thresholds 提取、降线判红、缺块 fail-closed）。
- `test/mutation-ledger.test.ts` — 变异段台账自测（#718 S0.2：GHA 日志解析口径含单空格前缀与 ANSI 剥离、未闭合段宁缺勿造、`wallSeconds` 正数不变量、覆盖全部段对账、历史段 `superseded` 登记）。
- `test/mutation-plan.test.ts` — 变异矩阵段清单与超时派生自测（#718 S1.1/S1.4：段清单口径同源、超时只用 `scope=full` 实测、公式与下限不被放宽、无实测落保守默认）。
- `test/pack-check-scope.test.ts` — pack-check 聚合段切片口径自测（#722/#751：增量切片下不得对未构建的聚合包假红；全仓口径必须仍执行该段，缺产物 fail-loud 且 exit 与判定自洽；切片用例取 `script-test-prereqs.mjs` 的 PREREQ 包——取清单外的包会把假红从 pack:check 搬进 test:scripts）。
- `test/script-test-prereqs.mjs` — `test:scripts` 里依赖**编译产物**的用例前置包清单（#722）：CI（repo-gate 构建步骤）与本地门禁（`gate/local-gate.mjs`）同源读取，避免「少建一个包 → 门禁假红」。
- `test/mutation-probe.mjs` — 变异度量可信度探针（#722）：变异得分依赖测试运行器的覆盖分辨率，本探针用实测说明该依赖的边界。

## data/（配置数据）

- `data/plugins-manifest.json` — 插件清单（某插件是否参与聚合/发布校验的唯一声明处）。
- `data/mutation-segment-ledger.json` — 变异段实测台账（#718 S0.2）：逐段 `wallSeconds` + mutant 数 + 复用率，由 `gate/mutation-ledger.mjs` 从 run 日志生成；`unmeasured` 登记尚无测量值的段，`superseded` 登记被拆分/更名的历史段。
- `data/gauntlet.config.json` — 变异 / CRAP / ESLint 复杂度阈值唯一事实源（覆盖率阈值自 #722 阶段三起改由 `vitest.config.ts` 的 `coverage.thresholds` 承载；`complexity` 段自 #722 阶段五起供 `tools/lint` 消费）。
- `data/mutation-topology.json` — 测试分层与变异面登记的单一事实源（#690 S2b / #713 T1-T3）：runner 层 = `test/**/*.test.ts` 全集，变异面按段登记。
- `data/dir-imports-baseline.json` — 目录导入门禁的单调基线（#690 / #733 A）：结构型计数由 `--write-baseline` 登记，`quality` 段存质量型**证据集合**（边 `from|to|kind`、环签名、未覆盖源文件）。
- `data/gate-exemptions.json` — 路径受限门禁的豁免台账（#733 计划项 3.1.2 / 3.2.2）：文件级条目 + 可选 `reviewBy`（**有** = 临时、自动进到期台账；**无** = 长期设计事实）；机制实现见 `lib/exemption-gate.ts`。
- `data/gate-scope-registry.json` — 路径受限门禁的扫描范围登记（#733 计划项 3.2.1）：`scopeFrom` 三值（registry / cli / tree）+ `packages`；**未登记即红**（运行时与自测两处执行）。
- `data/dsh-lan-proxy-ui-exempt.json` — lan-proxy 客户端 UI 豁免表（#733 计划项 3.2.2）：哪些配置键有值但 GUI 不渲染，逐键给原因；条目数上限是**策略**，留在门禁代码里。
- `data/dsh-notifier-export-surface.json` — dsh-notifier 的导出面清单（消费者可见的类型/值面）：被包内 `consumer-types` 集成测试消费，该测试在 `vitest.stryker.d/dsh-notifier.config.ts` 的变异面 include 内。
- `data/dsh-notifier-export-faces.json` — dsh-notifier 的导出面准入清单：被常驻的 `test/export-faces-admission.test.ts` 消费（改这两个文件会命中 dsh-notifier 面，见 `data/ci-face-registry.json`）。
- `data/ci-face-registry.json` — `packages/` 之外每个 tracked 文件的 CI 归属登记（#742 阶段 2.3）：`faces`（`global` / 包名 / 空数组=显式豁免）+ `why`；`test/ci-face-coverage.test.ts` 用真实 `git ls-files` 与 ci.yml 的 filters 双向核对（未登记、悬空条目、面未接上、死 glob 四类都判红）。

- `data/coverage.config.json` — **覆盖率面单一事实源**（#733 计划项 3.4）：`include` / `exclude`（结构化条目，带 kind 与 reason）/ `thresholds`；`vitest.config.ts` 只 import 它。

## tools/lint/（lint 工具链隔离包，非发布包）

- 为什么不放 `packages/`：`typescript-eslint` 需要 TypeScript 的 compiler API，而仓根 `typescript` 是
  tsgo 7.x（无 API，且根 `tsc` 由它提供、各包 build/typecheck 依赖它）。子包隔离让 lint 专用 TS 6 与
  根 tsgo 共存；放在 `packages/` 之外还避免被插件清单 / 产物闸 / CI 矩阵误当插件包。
- `lint/bin/lint.mjs` — `pnpm lint` 入口：固定以仓库根为 cwd（ESLint 的 basePath 与 lint-staged 传入
  的路径据此同口径），默认 lint 面见脚本内 `DEFAULT_PATTERNS`。
- `lint/eslint.config.js` — 扁平配置：`complexity` + `sonarjs/cognitive-complexity`；阈值读
  `data/gauntlet.config.json` 的 `complexity` 段，不在配置里硬编码。
- 上述前提由 `test/lint-toolchain.test.ts` 逐条钉死（根仍是 tsgo、子包有 compiler API、两版本共存）。

## 仓库根的派生生成物

- `vitest.stryker.d/<pkg>.config.ts` — 每包一份的 Stryker vitest 配置（由 `gate/gen-stryker-conf.mjs` 生成，
  勿手改；测试面写在它的 `include` 里，Stryker 侧不再用 `testFiles`）。
- `stryker.conf.d/<pkg>-<segment>.json` — 各变异段配置（同源生成）。
