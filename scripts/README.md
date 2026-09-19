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

- `gate/contract-check.ts` — 客户端契约门禁（load id === 包名、`dsh.client ⇒ exports["./client"]` 等）。目录门面 / 导出面快照 / 跨包扇入三闸原先内嵌在本脚本以 `spawnSync` 执行，审计 P0-1 后迁成 ci.yml 与本地档位的直接步骤——内嵌形态下 workflow 与本地计划都看不到它们，「每条判据至少一个可见执行点」因此恒为假。
- `gate/pack-check.ts` — tarball 完整性门禁（含聚合包、THIRD-PARTY-LICENSES 覆盖）。
- `gate/verify-npm-layout.ts` — npm 发布布局校验。
- `gate/verify-docs.ts` — 文档/description 校验（缺 .md、占位符残留）。相对链接面四档：
  包 README / 根 README.en / agent 规则文档（AGENTS.md、.dsh/skills/**、agents/**）/ docs 正文（#842）；
  另校验锚点可解析与文档里的 `pnpm <script>` 真实存在。
- `gate/aggregate.ts` — 聚合 `cordis.patch.yml` 生成 + 一致性校验（`--check` 供 CI）。
- `gate/crap-check.mjs` — 单函数 CRAP 复杂度检查（阈值唯一事实源 scripts/data/gauntlet.config.json 的 crap.threshold / crap.strict）。**#722 阶段五已重建为 src 口径**（复杂度取 ESLint 内置 complexity 规则、覆盖率取 `coverage/coverage-final.json`），此前「复杂度取自 lib 产物、与 src 口径行号不可比 → 入口自检 exit 2」的停用态**已不成立**；`crap.strict=false` 是观察期语义（超阈热点只落盘不判红），数据源缺失或解析失败仍 fail-closed exit 2。执行点：夜间 `observe.yml` 与 `gate:full --with-coverage`。
- `gate/forbid-src-tests.mjs` — #423 防双份回潮：扫 packages 下全部遗留 src 副本测试文件（含未跟踪），命中即 exit 1。
- `gate/red-line-approval.mjs` — 红线路径改动的「人工批准」判据（#843 M1 的代码侧落点）：PR 的 changed files 命中红线面且 labels 不含 `approved` 即判红；红线面是**派生**的——基座只有仓规 `AGENTS.md` 明写的 `.github/**`，其余是数据事实源声明表（默认 `data/threshold-registry.json`，可经 `--registry` 换）里每个 guard 的 `sources` 再加声明表自身（谁被声明为事实源谁就在面内；`scripts/gate/**` **不在**面内——#851 撤回了把门禁实现当加固面的扩大定义；声明表缺失时退化为仅 `.github/**` 并打 `::warning::`）；纯函数 `judgeRedLine` + CLI（输入缺失/不可解析 exit 2、判红 exit 1、放行 exit 0）。执行点 = `ci.yml` 的 `Build / Red-line approval` job（仅 PR），该 job 已挂进 repo-gate 的 `needs`。**本文件（`scripts/README.md`）不在红线面内**——派生面里的路径都不命中它，改它不需要 `approved` 标签。
- `gate/local-gate.mjs` — 本地/PR 门禁分层入口（`pnpm gate:changed` / `gate:pr` / `gate:full`，#726）；
  步骤表本体在 `gate/gate-steps.mjs`（无副作用纯函数，供接线断言直接 import）。`--dry-run --json` 输出结构化计划（人类可读输出不变），供 `test/gate-wiring.test.ts` 消费：
  按改动类型选闸：本地 pr / full 是全仓对象面，CI 在 PR 上默认走增量口径，打 `gate:full` 标签才补全仓产物闸；覆盖率另有前置——该 PR 须命中变异切片（`ci.yml` 的 coverage job 要求 `fullGate` 与 `hasMutations` 同时为真）。变异自 #742 起在 PR 上按命中切片强制跑（与标签无关）。
- `gate/gen-stryker-conf.mjs` — 变异配置生成/校验：派生 `vitest.stryker.d/<pkg>.config.ts` 并同步各包 `--min`（`--check` 供门禁，`--sync-test-min` 改 `--min`）。`--check` 的 ⑤/⑥ 判据落在 `gate/test-surface.mjs` 的 `mutationEntryProblems`：**⑤** 每条落盘 `mutate` 条目（正向与 `!` 排除同等）必须**锚定在本包（或 `shared/`）**且在**源码世界内命中 ≥1 文件**——只判命中时，一条广域 glob 会命中他包同名文件而恒绿；不锚定源码世界时，`packages/<pkg>/**` 会被同包构建产物 `lib/**` 满足；只比字面前缀时，`..` 归一化与 brace 展开会让前缀看着在本包而命中他包。**⑥** 每份 conf 的正向命中被 `!` 条目剔除后必须仍有剩余——⑤ 只判**单条**，一条包根级整包通配能在条数不变、⑤ 全绿的前提下把整包变异面清空，而 Stryker 对 0 mutant 不报错（判分与门禁都静默）。**⑦** 包级变异面并集棘轮（#843 计划项 3-1，落在 `gate/mutation-topology.mjs` 的 `mutationFaceRatchetProblems`，与基准 ref 比、默认 `origin/main`，`--base <ref>` / `GEN_STRYKER_BASE` 可覆盖）：⑤/⑥ 都不看基准，于是「把某文件从段 `mutate` 挪进**同段** `excludes`」逐条合法、有效面非空，文件静默退出变异面；⑦ 要求同一包的变异文件**并集**相对基准不收缩——段之间挪动合法，文件在本分支被真正删除属正当收缩，唯一放宽通道是 `data/gate-exemptions.json` 里 `gate=mutation-face` 的条目（`path=<包名>:<文件>` 或 `<包名>:*`，失效键按反向腐烂判红）。判据自带载体自证：进入比对面的包数 / 候选文件数任一为 0 即判红（不是恒绿），通过行会打印实际比过的包数与文件数；基准 ref 读不到走 exit 2（fail-closed）。另判派生 conf 名碰撞（fail-closed）。
- `gate/test-surface.mjs` / `gate/mutation-topology.mjs` — 测试分层与变异面登记校验（唯一事实源 `data/mutation-topology.json`）。段级 `excludes` 必填，且每条必须是非空字符串并以 `!` 开头（缺 `!` 会被原样拼进 conf 的 `mutate`，从「排除」**极性反转**成「要变异这个文件」）；`segments` 为空对象的包判红并指向 `$noMutationPackages`（它不派生任何 conf，⑤/⑥ 永远看不到它）。
- `gate/threshold-monotonic.mjs` — 阈值单调性校验（对比 `origin/main`）：**#843 D5 起由 `data/threshold-registry.json` 的声明表驱动**——每条事实源声明 `kind`（value / boolean / baseline / existence）、方向与删键语义，比较逻辑在 `lib/threshold-registry.mjs`；**未在表里登记的事实源一律判红**（枚举口径 = 运行时读 `data/*.json`，不在表里抄第二份清单）。覆盖面：`data/coverage.config.json` 的 `thresholds`（#733 计划项 3.4 起的覆盖率面**唯一事实源**；`vitest.config.ts` 只 import 它，内联字面量会被 `verify:coverage-scope` 判红——基准侧仍可能只有 `.ts`，故该源由声明表的 sources 表达双读并走 acorn 读取器）、`gauntlet.config.json` 的变异阈值 / 逐包回落锚点 / complexity / crap / lint 预算、`mutation-topology.json` 的 `timeoutMS`、`gate-wiring-exceptions.json` 的 9 个豁免预算。 声明表**自己**也被同一套「相对基准只许补全收紧」的语义守着（评审 P0-1）：guard 只许新增，同 id 的 kind / weaken / weakenValue / onRemoval / paths / keys / anchorFields / requireFields / sources / missingIsError / nonMonotonic / minAllowed / maxAllowed 只许补全收紧（`sources` 是回落链，只许**尾部追加**：前置影子源会让两侧读到不同的事实源；比较器另记录两侧实际命中的源，工作区命中基准未声明的文件同样判红），合法改动必须落在 `retired`（整条退役）或 `contractApprovals`（改某字段）里并带 trackingIssue + reason，两者都做反向腐烂校验；否则「删一条 guard / 翻一个 direction / 把 onRemoval 改成 ignore」就是一行数据改动且 CI 全绿。**边界（如实声明）**：面类判据不在本表——覆盖率 exclude 与变异段 mutate「相对基准的收窄」目前仍无守卫（`#848` 的判据⑤/⑥ 只保证锚定与非空，不看基准），本表只收 JSON 标量 / 布尔 / 存在性；`mutation.timeoutMS` 这类非单调旋钮的**收紧方向只报警不判红**（证据约束待设计）。
- `gate/mutation-ledger.mjs` — 变异段实测台账（#718 S0.2）：从 Actions run 日志解析逐段 `wallSeconds`（真实执行时间，区别于会被增量班刷新的文件 mtime）与复用率/杀灭分布；`--check` 离线校验覆盖不变量（测量值 ∪ `unmeasured` == 当前 `stryker.conf.d` 段集合，消失的历史段须在 `superseded` 登记取代关系），由 `test:scripts` 调用。生成模式需 gh 与网络，故定位为维护者工具、不进 CI（进 CI 需改 `.github/`，属红线段）。
- `gate/mutation-plan.mjs` — 夜间变异矩阵的段清单与逐段超时派生（#718 S1.1/S1.4）：段清单 glob `stryker.conf.d/dsh-*.json`（与 ci-matrix / mutation-gate 同源），超时按 `mutation-segment-ledger.json` 里该段 `scope=full` 的实测墙钟 × 1.5 + 构建开销派生、下限 30 分钟，无实测的段取保守默认；输出按**估计耗时降序**排列的 matrix JSON（长段先跑 = LPT：GHA 以 `max-parallel` 个槽位按声明顺序消费，实测同一份台账下字典序 makespan 52.9 min 对降序 41.6 min，下界 41.4）供 `observe.yml` 的动态矩阵消费（GHA 矩阵只能引用 needs output、不能读工作区文件，故单列一个秒级 plan job）。
- `gate/verify-dir-imports.mjs` — 目录 `interface.ts` 门面静态检查 + 依赖图尺子（#664 D10 / #670 C2 / #690 S0）：跨模块引用只许走目标模块的 `interface.ts`，单调基线（`data/dir-imports-baseline.json`）存**证据集合**，放宽须登记到 `data/gate-exemptions.json`（gate=`verify-dir-imports`，path=`<包名>:<证据项>`，与另两闸同一套台账）；**基线里没有本包条目本身判红**（#843 D15：旧实现会打印「基线无本包条目 —— fail-closed」却 exit 0，`--soft` 也不免这一条）；基线键集还必须**等于** `data/gate-scope-registry.json` 里该闸 `scopeFrom=cli` 的调用点并集——两侧任一方向漂移都判红，死条目与缺条目分别点名；调用点扫描面含 `ci.yml` / `observe.yml` / `release.yml` / `gate/gate-steps.mjs` 的两种写法（数组形态与 CLI 空格形态），且每个调用文件各自须覆盖登记全集（单点收窄并集不敏感，由逐文件断言拦；均见 `test/gate-scope-registry.test.ts`）——故 `--write-baseline` 的缺省范围也取自该注册表（不再全量扫描 `packages/` 下有 src 的目录，那正是死条目的生成器），范围读不到则 exit 2 不落盘；变异拓扑 `data/mutation-topology.json` 缺失 / 解析失败 / 内容非对象一律 fail-closed（#773 R3），`--write-baseline` 同样中止。
- `gate/export-surface-snapshot.mjs` — 包导出面快照门禁（#669 M6）：`tsc --declaration` 产物与入库基线零 diff（符号集 + 导出符号定义块），必须显式 `--package`，基线更新须 `--snapshot` 并随 PR 提交。
- `gate/local-scope.mjs` — 「这次改了什么 → 本地该跑哪些包」的纯函数（#722 门禁分层）：包面只从 `ci.yml` 的 filters 解析，不在本地重述路径规则；全局面命中即把 `gate:changed` 升到 pr。
- `gate/gate-steps.mjs` — 「档位 → 步骤表」的纯函数单一来源（审计 P0-1）：从 `local-gate.mjs` 抽出，使接线断言能直接 import 计划而不必解析 `--dry-run` 的人类可读输出（后者会被标签措辞、箭头形态、别名与直调的等价改写误红）。
- `gate/repo-gate-assert.mjs` — repo-gate 聚合闸的 fail-closed 判定（#187 收敛 / #217 解耦）：上游任一 job 非 success 即红，判定逻辑收敛为纯函数（原先内联在 workflow 的 bash）。
- `gate/observe-check.mjs` — 夜间观察报告的阈值校验与回落检测（#85 v3 F1/F6）：产出报告正文 + 三态状态文件（`--status-file`，供通知步骤判「判分完成 / 判分违约 / 脚本崩了」，#733 G1）。
- `gate/mutation-gate.mjs` — PR 增量变异率判分（#178 v2；#217 起由 `mutation-verdict` job 在 artifact 汇合后统一调用），统计口径与夜间班共用 `lib/mutation-report-lib.mjs`。
- `gate/mutation-topology.mjs` — 变异拓扑的派生规则共享模块（#690 S2b / #710 F15），供 `gen-stryker-conf.mjs` 与各门禁共用同一套段/层派生。
- `gate/baseline-archive.mjs` — 变异基线归档分支的纯函数面（#572 / #714）。
- `gate/baseline-push.mjs` — 归档分支写路径的共用管线（#718 S2.1）：夜间并集入档与对账共用一条写路径。
- `gate/orphan-baseline.mjs` — 变异基线孤立分支（`baseline/mutation`）的管理脚本（读 / 并集写 / 清理）。
- `gate/overlay-baseline.mjs` — PR 增量变异产物合入后的秒级覆盖同步（#572）。
- `gate/collect-exemptions.mjs` — 豁免/临时项的收口台账收集（#733 计划项 3.2，裁决见 #765）：递归扫 `data/` 下全部 `reviewBy`（到期日）与 `exitCriteria`（解除条件）并打印，恒 exit 0——它是**报告**不是判据，收口由人工裁决（不会冻结 PR）；只有到期日、没有解除条件的条目单独点名（日期只说明何时再看一眼，条件才说明凭什么能删）。
- `gate/forbid-homedir-src.mjs` — #517 B5：插件 src 禁直连 HOME 来源 API（AST 扫描，`os.homedir` / `userInfo` / `process.env.HOME` / `untildify` 全形态），**无豁免通道**（#765：本面收口到零豁免后机制一并删除，命中即违规），解析失败 fail-closed。
- `gate/forbid-module-state-src.mjs` — #733 N2a：插件 src 禁**模块级可变状态**（只看 AST 作用域，缩进不再是绕过口），豁免走 `data/gate-exemptions.json` 登记。
- `gate/forbid-raw-exit2.mjs` — #843 P-2 的否定判据：`scripts/gate/**` 与 `scripts/release/**` 内不得出现裸 `process.exit(2)` / `process.exitCode = 2` / `exitCode = 2`，必须经 `lib/gate-exit.mjs` 的 `failClosed()`（exit 2 的语义是「门禁故障（非判据结论）」，判词必须可检索）。检测走 AST，注释与字符串里的同形文本不命中；`return 2`（把退出码经返回值交给调用方，22 处）**显式排除**——它归已登记的 L3 退出码契约归一，见文件头注释。扫描面为空即 exit 2，不判绿。
- `gate/verify-scripts-index.mjs` — 本文件的索引门禁（#733 计划项 3.3 E2）：① 索引项必须存在 ② 被调用点引用的脚本必须登记（棘轮）。未被任何调用点引用的文件只报告、不判红。

- `gate/verify-coverage-scope.mjs` — 覆盖率面判据（#733 计划项 3.4）：`vitest.config.ts` 不得内联 `include`/`exclude`/`thresholds`；exclude 条目须带 `reason` 与 `kind`（值域三值），`reviewBy`/`exitCriteria` **只允许且必须由 `pending-project` 携带**——给永久事实编到期日是假条目，临时豁免缺了到期日或解除条件则成了永久事实；**kind 必须与命中文件形态自洽**：`not-source` 不得命中 include 面内的文件（判据取自 include 的 glob，不镜像后缀表——后缀是整面的并集，套到单条 pattern 上会误判）、也不得命中声明文件（面外的声明同样归 `type-only`）——边界：本判据只保证「`not-source` 不命中 include 面内文件」，不检查文件的资源性，面外的代码文件被标 `not-source` 不判红（它本来就不在分母里，也就不该被要求登记台账）；将来 include 面扩大时，本判据会对**当时的**面求值，那一刻就判红——`type-only` 只许命中 `.d.ts`/`.d.mts`、`pending-project` 不作形态限制，判词直接给出 pattern、命中了哪些文件、声明成什么 kind 与为什么不允许（关掉「把 `.ts` 源码声明成 `not-source` 移出覆盖分母、两条闸都不响」这条通道）；物理枚举的每个源文件必须落在 include 或某条 exclude 里（未分类即红）；模式命中 0 文件即红；产物 keys ⊆ include 面（产物比配置新时才执行）。

- `gate/verify-vendored-binaries.mjs` — 发布物面内 vendored 裸二进制判据（批 2b，来源 #784 遗留 D 项）：扫描面 = 各包 `package.json` 的 `files` 白名单（含 `!` 否定条目）∪ npm 无论 `files` 都强制包含的位置（`package.json`、根级 `README*`/`LICENSE*`/`CHANGELOG*`/`NOTICE*`、`bin`、`main`、`bundledDependencies` 展开出的包内 `node_modules` 子树）；判据轴是「会不会随发布物分发」，不是「文件是不是二进制」，故 `docs/` 下的 PNG 不算、`test/fixtures/*.bin` 只在被 `files` 包含时才算。**判据面是源码树（随包分发的源文件）**：未构建的工作副本扫描面会变小，构建产物由 `pack:check` 的 tarball 断言覆盖。面内的内容嗅探命中（头 8 KiB + 尾 1 KiB 双段采样）必须已在 `data/vendored-binaries.json` 登记且 sha256 一致；`kind: "vendored"`（缺省）另要求许可文本存在、非空且**同样在发布物面内**，`kind: "first-party"`（本仓自有资产）只要求哈希绑定。双向 fail-closed：未登记即红（问题文案直接带 sha256，便于登记），登记项消失/哈希漂移/内容已非二进制/登记表不可读（exit 2）也红——防「登记表腐坏后判据静默失效」；`files` 声明了但磁盘上不存在的条目与面内非普通文件（软链目录）只以 `NOTE` 报告，不判红。
- `gate/verify-shared-fanin.mjs` — 仓库根 shared/ 的跨包扇入判据（#792 跨包档收口，把 shared/README.md 准入规则 1 从文档变成判据）：扫 `packages/<pkg>/src` 的**直接**相对 import（生产口径，test/** 不计入消费者）得「shared 模块 → 消费包集合」；值面模块 < 2 包判红、类型面模块（只有 .d.ts）单列（≥ 1 包）、退役不豁免下限（标 DEPRECATED 仍按同一下限判，见 shared/README.md 准入规则 7）、悬空引用判红。执行点是 ci.yml 的 `Verify shared fan-in` 直接步骤与本地档位的 cheapGlobal（审计 P0-1 从 contract-check 迁出），README 不再维护人肉消费方快照；同一输出即消费方的实时派生来源。

## maintenance/（一次性维护脚本，按需手工执行）

- `maintenance/repair-mcp-catalog-sessions.mjs` — #723 一次性修复：把 dsh-mcp-manager 0.2.x 及更早写入的旧目录 source（`kind: "mcp-catalog"`）改写成宿主词表内的通用形态，救回升级 dsh 后无法加载的历史会话（默认 dry-run，`--apply` 落盘并留 `.bak-<时间戳>` 备份）。根脚本别名：`pnpm repair:mcp-catalog`。
- `maintenance/scan-actions-concurrency.mjs` — Actions 并发峰值扫描（#718 S0.3）：从 run 日志的 job 起止时间算并发峰值，供「夜间变异段并发上限」这类决策取实测依据（不读工作区、需 gh 与网络，故不进 CI；已过滤被取消 run 的作业——其排队窗口也带起止时间，会叠加成虚高峰值）。

## lib/（纯共享库，只被 import，不被 `node` 直接调用）

- `lib/client-contract-lib.ts` — 客户端契约断言（stub/执行实现同源唯一事实源）。
- `lib/plugins-manifest-lib.ts` — 插件清单单一事实源（issue #36）纯函数库。
- `lib/mutation-ledger-lib.mjs` — 变异段台账的解析与覆盖对账纯函数（#718 S0.2，与 `gate/mutation-ledger.mjs` 同源实现，测试离线 import）。
- `lib/gate-exit.mjs` — 门禁「自身故障」的唯一退出口（#843 P-2）：只暴露 `failClosed(why)`，打印 `::error::门禁故障（非判据结论）：<why>` 后 `process.exit(2)`。1 = 判据按设计判红、2 = 门禁自己坏了，两者必须在日志上可区分（本轮真实事故正是把 exit 2 读成了判红）。语义的唯一事实源在 `AGENTS.md` 的门禁一节。
- `lib/ci-ism-denylist.mjs` — 仓库根 CI-ism 未跟踪文件判据（#843 评论侧 L4）的纯实现：denylist（GitHub Actions 运行时文件 + `*.jsonl` / `undefined/`）+ 载体自证（扫描面为空 / 不是仓库根 / 清单漏形态一律判红）+ git 探测与裁决分离；`test/ci-ism-denylist.test.ts` 离线 import 它做注入对照。
- `lib/exemption-gate.ts` — 路径受限门禁的共享实现（#733 计划项 3.2.2）：豁免机制（真实行注释词法 / marker 匹配 / 三态裁决 / 台账读取与反向腐烂校验）+ 扫描面与参数枚举（`isScannedSourceFile` / `collectSrcFiles` / `listPackageNames` / `relPath` / `argValue`）；策略与扫描器留在各门禁自己手里。豁免机制当前只剩 `gate/forbid-module-state-src.mjs` 一个用户（`gate/verify-dir-imports.mjs` 共用台账读取；homedir 面已无豁免通道，#765）。
- `lib/threshold-registry.mjs` — 阈值声明表的读取、结构与覆盖面校验、按 kind 的通用比较器（#843 D5）：两侧事实源由调用方注入（`readBase` / `readWorkspace`），`makeSourceLoader` 按 `sources` 声明顺序取第一个**存在**的源（迁移期双读的形态即由此表达，而不是特判）；`validateDeclarations` 把「新数据文件未登记 / 幽灵声明 / 缺字段」变成判据，`validateGuardFacts` 拦「声明了但两侧都取不到值」的幽灵判据。
- `lib/gate-scope-registry.ts` — 路径受限门禁的**扫描范围**读取与通配展开（#733 计划项 3.2.1）：未登记 / 范围解析为空一律抛错（未登记即红）。
- `lib/config-matrix-lib.ts` — 配置覆盖矩阵门禁的共享提取器与纯逻辑（issue #471）。
- `lib/dts-cordis-merge-lib.ts` — 「cordis 声明合并必须落在包入口的声明闭包内」判据（#733 宪法第 3 条）。
- `lib/export-faces-lib.ts` — 包导出面「分类登记」准入判据（#733 宪法第 3 条 / M2-3.5）：新增导出必须登记为安装面 / 配置面 / 契约面之一。
- `lib/exports-types-lib.ts` — `package.json` 的 `exports[].types` → 产物相对路径映射（单一实现，pack-check 与导出面校验共用）。
- `lib/surface-extract-lib.ts` — 包导出面提取与入口归属（单一实现，供 `gate/export-surface-snapshot.mjs` 与 pack-check 断言共用）。
- `lib/mutation-report-lib.mjs` — Stryker JSON 报告统计的单一事实源（covered 口径）：observe 夜间报告与 PR 增量门禁共用，防两处口径漂移。
- `lib/glob-files.mjs` — 仓库根锚定的 glob → 物理文件展开 + **源码世界**定义（覆盖率面的「条目腐烂」判据与变异面的 ⑤/⑥ 共用同一份实现与同一个 universe；本仓原有三份同形实现，覆盖率面那份与变异面那份已收口到这里）。用 `node:fs` 的 `globSync`，不引第三方 glob。与 `test-surface.mjs` 的 `expandGlob` 差别**不是**锚点而是返回契约（本模块返回仓库根相对 posix，它返回绝对路径），故未合并。另记账：`verify-dir-imports.mjs` 还有第 4 份 glob 语义（手写 `globToRegExp`），今天实测 0 分歧（103 pattern × 370 文件），属 latent 漂移面。
- `lib/package-scope.ts` — 产物闸（contract / pack-check / verify-npmlayout）的包级切片参数解析（#722 门禁分层）。
- `lib/gate-endpoints.mjs` — 判据接线的解析层（审计 P0-1）：把一条命令行归一为「被执行的脚本身份」（`pnpm <别名>` → 查 `package.json` 展开 → 取脚本路径，再附**判据面摘要** = `--package` 取值 + `--packages` 之前的全部 token——后者的取值是 shell 替换，且「CI 切片 / 本地全仓」是真实口径差异，由 A9 的形态断言单独守；因此 `--soft`、`--test-name-pattern` 这类改变判据面或判红语义的开关都会改变身份）。`env` / `command` / `builtin` 前缀与 `cd <dir> &&` 载体不改变身份；注释剥离与续行判定**引号感知**：引号内的 `#` 不是注释（`$'…'` 与反引号也按 bash 语义建模，`$'a\' #'` 里的 `\'` 不是闭合引号，`\ #` 里被转义的空白之后 `#` 仍是字面量；`{` `}` 不是 bash 元字符，`{#` 里的 `#` 也是字面量）；续行按 bash 语义拼接（删掉反斜杠 + 换行，不额外插空格）。`--packages` 的**取值**不进身份，但它之后的 token 照旧进（否则悬空 token 会被吃掉）。workflow 与 lefthook 的 YAML **交给成熟的 `yaml` 包解析**（devDependency，不再是逐行正则：键的引号 / 空格变体、块标量与折叠标量、flow 写法、重复键都由解析器按 YAML 语义处理；解析错误、白名单之外的步骤键、非字符串 `run`、非映射的 `env` 都由 `parseIssues` 报出来判红）。在此之上再做三类「执行位藏在别处」的形态识别：shell 控制关键字之后（`if node …`）、命令内部（进程替换 `done < <(node …)`）、恒假分支的行级剔除。别名与直调归一到同一身份，是「CI ↔ 本地」双向比对能成立的前提。
- `lib/gate-wiring-lib.ts` — 判据接线的**判定层**（审计 P0-1）：接线断言的说服力所在（「怎样才算同一个判据」「什么条件算恒假」「一条 import 算不算有人依赖」）。逻辑都在库里并由 `test/gate-wiring-lib.test.ts` 独立单测钉住，`test/gate-wiring.test.ts` 只负责把库接到真实仓库上（读哪些文件、跑哪几档）；凡需要「当前这个仓库」才有意义的量（执行点全集、判据全集、可达库闭包）一律以参数注入，故本库不 import 任何仓库状态。
- `lib/rewrite-dts-paths.ts` — bundle-host d.ts X1 2a 段「shared 相对引用改写」共享库（issue #478）。
- `lib/walk-files.ts` — 递归收集目录下满足谓词的文件（构建复制 d.ts X1 2b 段与 pack-check 随包断言共用同一遍历）。
- `lib/vendored-binaries-lib.mjs` — 发布物面判定 + 内容嗅探 + 登记表校验（批 2b）：发布物面 = 各包 `package.json` 的 `files` 白名单 ∪ npm 强制包含集（不维护硬编码排除表），供 `gate/verify-vendored-binaries.mjs`、`build/collect-licenses.ts`、`gate/pack-check.ts` 三处共用同一套判据。

## release/（发布/周期 CI 专用）

- `release/verify-version.ts` — 发布前校验全包版本 == tag。
- `release/publish-if-missing.ts` — 发布缺失包。
- `release/collect-tgz-evidence.mjs` — 发布证据链（3.7 W1.3）：按 publish 步骤同一包集合（子进程复用 publish-if-missing.ts 取清单）逐个 `pnpm pack`，复制 tgz 到证据目录并生成 SHA256SUMS，随后删掉 tgz 本体（只上传校验和与日志）。`--out-dir` 必须绝对路径（workspace 零落盘的结构保证）。
- `release/health-report-body.mjs` — 健康报告 body 生成。
- `release/observe-precheck.mjs` — 发版前置判据（#843 R-2 / D4）：release.yml 的 `observe-precheck` job 在发布之前校验「最近 24 h 内至少一次 observe **成功收口**」，不满足即阻断发布（口径的三种候选取舍、边界语义与实测数据都在文件头注释里）。判定输入是观察班次的 run 列表（gh api 取 `workflow_runs`，也可用 `--runs-file` 离线复跑取证）：窗口内无 success 判红；**一切取数 / 解析失败一律 fail-closed**（没有「基线新鲜」的证据就不发版），exit 2 专留给参数非法。override 逃生口 = `--override` 或环境变量 `SKIP_OBSERVE_CHECK=true`（release.yml 把它接在 `workflow_dispatch.inputs.skip_observe_check` 上），放行时打印 `::warning::` 并要求在 PR / 发布记录写明理由。判定本体是可注入 now / 窗口 / override 的纯函数。
- `release/baseline-staleness.mjs` — 变异基线（`baseline/mutation`）新鲜度判据（#718 验收判据「基线陈旧可被观测」）：判据打在基线分支**最后提交时间**这一事实上（不看「observe 最近是否 success」这一代理——它会漏掉「observe 成功但未入档」与「observe 整体没跑」两种形态），阈值 48 h（= 连续两夜未入档），超阈输出 `::error::` 注解 + 幂等工单正文，未超阈由 `health-report-body.mjs` 在周报正文留一行基线龄；**观测没做成（unknown）与状态文件缺失由 workflow 最末的 verdict 步骤判红**（「环境失败不得静默降级」，放最末以免连坐建单留痕），stale 本身不判红（发现 ≠ 失败）；龄 → 三态的判定是可注入 now/阈值的纯函数。执行点 = health-report.yml 周报（监控者与被监控者分离：observe 是更新基线的一方，检查放进去会在它整体没跑时一起沉默），零权限变更。

## scripts/ 根

- `tsconfig.json` — `scripts/` 的 typecheck 面（**全树** `.ts/.mts/.cts` 入面，含 `test/**`；`allowJs` 让被 import 的 `.mjs` 进程序集**供类型推断**——`.mjs` 本体的类型检查（`checkJs`）仍是未决项，见 `scripts/tsconfig.json` 顶部注释）。在面与否由 `test/verify-docs-typecheck.test.ts` 的两条判据守：面外集合必须为空（任何 `.ts/.mts/.cts` 被 exclude 即红）、磁盘枚举非空（防枚举失效让面外判据恒真）。

## test/（脚本自测，`pnpm test:scripts`）

- `test/run-vitest.mjs` — 包级 test 脚本的 vitest 包装：在 vitest 之上恢复 `--min <文件数>` fail-closed 判据（防 include 漂移的假绿）。
- `test/build-client.test.ts` — build-client 脚本自测。
- `test/collect-licenses.test.ts` — collect-licenses 脚本自测。
- `test/crap-check.test.ts` — crap-check 脚本自测（config.strict 单一开关；#722 阶段五起含「非 src 口径数据必须 fail-closed」用例）。
- `test/threshold-monotonic.test.ts` — 阈值声明表与单调性自测（#722 / #843 D5 + 对抗评审收口）：coverage.thresholds 提取、降线判红、缺块 fail-closed；声明表三类判红（未登记数据文件 / 幽灵声明 / 幽灵判据）与声明表**自身的 P0-1 用例**（删 guard / 翻 weaken / onRemoval 改 ignore / paths 丢项 / 退役与 contractApprovals 两条通道及反向腐烂）；四类 kind 的放宽判红与收紧放行；逐包回落锚点（含非生效字段下调）、逐包阈值绝对下限、幽灵包条目、豁免命名空间拆分（#membership / #anchor）、陈旧豁免、损坏事实源 exit 2。fixture 自带最小声明表，另有本仓真值快照一致性地跑同一套代码路径。
- `test/mutation-ledger.test.ts` — 变异段台账自测（#718 S0.2：GHA 日志解析口径含单空格前缀与 ANSI 剥离、未闭合段宁缺勿造、`wallSeconds` 正数不变量、覆盖全部段对账、历史段 `superseded` 登记）。
- `test/mutation-plan.test.ts` — 变异矩阵段清单与超时派生自测（#718 S1.1/S1.4：段清单口径同源、超时只用 `scope=full` 实测、公式与下限不被放宽、无实测落保守默认）。
- `test/pack-check-scope.test.ts` — pack-check 聚合段切片口径自测（#722/#751：增量切片下不得对未构建的聚合包假红；全仓口径必须仍执行该段，缺产物 fail-loud 且 exit 与判定自洽；切片用例取 `script-test-prereqs.mjs` 的 PREREQ 包——取清单外的包会把假红从 pack:check 搬进 test:scripts）。
- `test/verify-shared-fanin.test.ts` — 跨包扇入门禁自测（#792）：说明符提取口径、fixture 正反例（值面 2/1/0 包、类型面下限、标 DEPRECATED 仍判红、悬空引用、test/ 引用不计入、端内门面转出计入、shared 内部依赖不传递）、真实仓库锚与登记链断言。
- `test/gate-wiring.test.ts` — 门禁接线断言（审计 P0-1），四族缺一不可（判定逻辑在 `lib/gate-wiring-lib.ts`，另有 `test/gate-wiring-lib.test.ts` 独立单测）。**一致性**：把 `ci.yml` 的 repo-gate 与本地 pr/full 档位计划归一到端点身份后**双向比对**，覆盖「判据脱离任一端」「args 被换」「步骤被 `if`/`continue-on-error` 静默关掉」「例外台账悬空或未分类」「判据被别的脚本子进程执行而无可见执行点」。**覆盖性**：判据面（`JUDGMENT_DIRS` = `scripts/gate` / `scripts/ci` / `scripts/release` / `tools`，口径与「哪些目录不在面内、为什么」的逐条理由见 `test/gate-wiring.test.ts` 里 `gateSources` 的注释）的判据全集 ↔「全部 workflow × 全部 job ∪ 本地档位 ∪ lefthook」的执行点全集，未覆盖且不被**会跑的**判据可达地 import 者必须显式登记——一致性只是相对不变量，两侧同时删掉同一执行点后仍然相等，只有这条绝对不变量拦得住。**形态性**（扫描面 = 全部 workflow × 全部 job）：判据步骤只允许一条直接的判据命令（`exit "0"` 前置 / `if [ ]; then` 包装 / `X=1 set +e` 一律失效，不依赖枚举），设计如此的例外逐条登记、再用**文本摘要** `digest` 钉死（否则往循环里插一行 `break` / `continue` 就能让剩下的判据不再执行，而步骤键与执行点全不变）；判据步骤的步骤级 `if`（`stepIfs`）与含判据的 job 的 job 级 `if`（`jobIfs`）逐字登记（扫描面都是全部 workflow，条件被改一个字即判红）；判据别名的**指向**逐条登记（两侧身份同源派生，改指向没人发现）；步骤 `shell:` 覆盖（含 workflow / job 级 `defaults.run.shell`）按模板判——内建关键字放行，自定义模板必须取 basename 后属 bash 家族、把 `{0}` 交给解释器且自带 errexit（`/bin/bash +e {0}`、`/bin/bash -c 'exit 0' {0}` 都判红）；判据步骤的 `#` 也 fail-closed（未登记的判据命令里出现 `#` 即红：注释起点与 bash 的判定不可能完全对齐）；判据步骤另不得带 `continue-on-error`、不得注入能改变执行环境的变量（`BASH_ENV` / `SHELLOPTS` / `NODE_OPTIONS` / `PATH` / `LD_PRELOAD` / …）、命令引号必须配对（都不设登记出口）；判据步骤的**有效 env 键**（workflow ∪ job ∪ 步骤三层）逐键登记在 `stepEnvs`；判据 job 的**环境面**按位置整条登记（不按字样找出口——硬编码 `_runner_file_commands` 路径、`printenv` 拼名、`node -e` 读环境都能绕开名字匹配）：判据步骤之前的每个非判据 run 步骤进 `priorRunSteps`（键 + **整步**摘要 + env 键，含 `if` / `shell` / `working-directory`），该 job 的**执行面**（前序步骤**有序**序列 + 全部 `uses:` 步骤整步文本 + job 级 `container` / `defaults`）进 `jobFaces`——action 里是任意代码，同样能写 `$GITHUB_ENV`；一处 `if: false` 也能让产物上传静默不跑；`container.env` 与 `defaults.run.working-directory` 都是换掉整 job 执行环境的 job 级键；判据步骤自己声明 `working-directory` 则是硬红；已登记条件里 `steps.<id>.outputs.<name>` 的**产出步骤及其输入步骤**（同 job 的 `uses` 整步面）逐条登记在 `conditionInputs`（条件原文没变：改产出、改它的 `uses` / `with` / `if`、或改另一个 job 的 `upload-artifact` 名都能让条件永不成立，三处都钉住）；本地 pr 档必须覆盖 full 档全部判据；判据不得内嵌进另一个判据的执行点。**PR 面覆盖（A14）**：执行点全部落在非 PR 面（CI 侧 = ci.yml 里**未**按 `gate:full` 标签收口的 job，本地侧 = **pr** 档）的判据必须登记 `nightly-only` 或 `tier-only`，「这个判据的回归 PR 上拦不住」是一份显式清单。含载体自证（`pnpm test:scripts` 自身有执行点；A13 钉住「工作流文件集合」与文件级解析，解析面失效时不许空转全绿；恒假的 job / 步骤不算执行点，decoy 顶替不了被删掉的判据）。例外与八张形态登记表都在 `data/gate-wiring-exceptions.json`。
- `test/script-test-prereqs.mjs` — `test:scripts` 里依赖**编译产物**的用例前置包清单（#722）：CI（repo-gate 构建步骤）与本地门禁（`gate/local-gate.mjs`）同源读取，避免「少建一个包 → 门禁假红」。
- `test/mutation-probe.mjs` — 变异度量可信度探针（#722）：变异得分依赖测试运行器的覆盖分辨率，本探针用实测说明该依赖的边界。

## data/（配置数据）

- `data/plugins-manifest.json` — 插件清单（某插件是否参与聚合/发布校验的唯一声明处）。
- `data/mutation-segment-ledger.json` — 变异段实测台账（#718 S0.2）：逐段 `wallSeconds` + mutant 数 + 复用率，由 `gate/mutation-ledger.mjs` 从 run 日志生成；`unmeasured` 登记尚无测量值的段，`superseded` 登记被拆分/更名的历史段。
- `data/gauntlet.config.json` — 变异 / CRAP / ESLint 复杂度阈值唯一事实源（覆盖率阈值自 #733 计划项 3.4 起在 `data/coverage.config.json`；`complexity` 段自 #722 阶段五起供 `tools/lint` 消费）。
- `data/mutation-topology.json` — 测试分层与变异面登记的单一事实源（#690 S2b / #713 T1-T3）：runner 层 = `test/**/*.test.ts` 全集，变异面按段登记。
- `data/dir-imports-baseline.json` — 目录导入门禁的单调基线（#690 / #733 A）：包键集 = 该闸 cli 调用点并集、且每个调用文件各自覆盖全集（#843 D15，漂移即红），结构型计数由 `--write-baseline` 登记，`quality` 段存质量型**证据集合**（边 `from|to|kind`、环签名、未覆盖源文件）。
- `data/gate-exemptions.json` — 路径受限门禁的豁免台账（#733 计划项 3.1.2 / 3.2.2）：文件级条目 + 可选 `reviewBy`（**有** = 临时、自动进到期台账；**无** = 长期设计事实）；机制实现见 `lib/exemption-gate.ts`。
- `data/gate-wiring-exceptions.json` — 门禁接线断言的例外台账（审计 P0-1）：`{endpoint, class, reason, via?}`，`class` ∈ infra / ci-only / tier-only / nightly-only / indirect；同文件另承载八张**形态**登记表 `structuredSteps`（判据步骤的闭合形态例外，含文本摘要 `digest`）、`stepIfs`（判据步骤的步骤级 if）、`stepEnvs`（判据步骤的有效 env 键）、`priorRunSteps`（判据 job 里判据之前的前序 run 步骤，按**位置**取闭合集合）、`jobFaces`（该 job 的执行面：前序步骤有序序列 + 全部 `uses:` 步骤整步文本 + job 级 `container` / `defaults`）、`conditionInputs`（登记条件的操作数来源及其输入面）、`jobIfs`（含判据 job 的 job 级 if，键 `<workflow>|<job>`）与 `judgmentAliases`（判据别名的指向）。两侧归一到端点身份后本应相等，只有**设计如此**的不对称在此显式登记；断言侧对该文件有悬空、class 方向相符、script 例外指向的脚本存在、总量上限（另钉一个测试内硬顶，防「只改数据即放宽」）、indirect 的 `via` 必须真的能到达（`via: package.json` 还要求该别名在仓库里确有出处）、indirect 必须真的没有执行点等守卫，防止它自己腐烂成第二个事实源，也防止它被当成消红工具。
- `data/gate-scope-registry.json` — 路径受限门禁的扫描范围登记（#733 计划项 3.2.1）：`scopeFrom` 三值（registry / cli / tree）+ `packages`；**未登记即红**（运行时与自测两处执行）。
- `data/vendored-binaries.json` — 发布物面内 vendored 裸二进制登记表（批 2b，`{path, sha256, kind?, license?, source?, licenseFile?}`；`kind` 缺省 `vendored`，`first-party` 只要求 `path`+`sha256`）：判据与接线见 `gate/verify-vendored-binaries.mjs`；`vendored` 条的许可文本由 `build/collect-licenses.ts` 并入随包的 `lib/THIRD-PARTY-LICENSES`，再由 `gate/pack-check.ts` 对最终 tarball 断言覆盖（第一方资产不进第三方许可段）。**今天为空**，它是为将来上的锁——这里不写死命中数：扫描面随各包 `files` 白名单与工作副本是否构建而漂移，写下来的数字会过期。
- `data/dsh-lan-proxy-ui-exempt.json` — lan-proxy 客户端 UI 豁免表（#733 计划项 3.2.2）：哪些配置键有值但 GUI 不渲染，逐键给原因；条目数上限是**策略**，留在门禁代码里。
- `data/dsh-notifier-export-surface.json` — dsh-notifier 的导出面清单（消费者可见的类型/值面）：被包内 `consumer-types` 集成测试消费，该测试在 `vitest.stryker.d/dsh-notifier.config.ts` 的变异面 include 内。
- `data/dsh-notifier-export-faces.json` — dsh-notifier 的导出面准入清单：被常驻的 `test/export-faces-admission.test.ts` 消费（改这两个文件会命中 dsh-notifier 面，见 `data/ci-face-registry.json`）。
- `data/dsh-lan-proxy-export-surface.json` — dsh-lan-proxy 的导出面清单（#826 冻结：「目录重排零行为变更」由人工一次性比对升级为可重复判据）：被 `gate/export-surface-snapshot.mjs --package dsh-lan-proxy` 逐字节比对，执行点见 ci.yml 的 Export surface snapshot 步骤。
- `data/dsh-lan-proxy-export-faces.json` — dsh-lan-proxy 的导出面准入清单：与基线同一次 `emitDeclarations()` 产物喂「新增导出必须显式分类」判据；与上面的导出面清单必须同批更新，改这两个文件会命中 dsh-lan-proxy 面（见 `data/ci-face-registry.json`）。
- `data/dsh-worktree-sidebar-export-surface.json` — dsh-worktree-sidebar 的导出面清单（#847 接线）：被 `gate/export-surface-snapshot.mjs --package dsh-worktree-sidebar` 逐字节比对，执行点见 ci.yml / observe.yml / release.yml 的 Export surface snapshot 步骤与 `gate/gate-steps.mjs` 本地档。
- `data/dsh-worktree-sidebar-export-faces.json` — dsh-worktree-sidebar 的导出面准入清单：与基线同一次 `emitDeclarations()` 产物喂「新增导出必须显式分类」判据；与上面的导出面清单必须同批更新，改这两个文件会命中 dsh-worktree-sidebar 面（见 `data/ci-face-registry.json`）。
- `data/ci-face-registry.json` — `packages/` 之外每个 tracked 文件的 CI 归属登记（#742 阶段 2.3；#843 L5 起带消费方）：`faces`（`global` / 包名 / 空数组=显式豁免）+ `why` + `consumers`（仓内直接读取方，路径必须存在且文件文本字面命中 source；没有直接读取方时改声明 `consumerGap`，`kind` ∈ none / external / indirect，两者排他）；`test/ci-face-coverage.test.ts` 用真实 `git ls-files` 与 ci.yml 的 filters 双向核对（未登记、悬空条目、面未接上、死 glob、消费方不实五类都判红）。

- `data/threshold-registry.json` — 阈值事实源的**声明表**（#843 D5）：`kind` = value（数字标量，`weaken` 指明哪个方向是放宽）/ boolean（开关，`weakenValue` = 等于它就等于放宽）/ baseline（逐包回落锚点，`anchorFields` 是回退链，读法与 `gate/observe-check.mjs` 的 `fixedCovered ?? baselineCovered` 一致）/ existence（集合存在性，`universe` 从 `packages/` 目录派生、`exemptFrom` 读 `mutation-topology.json` 的 `$noMutationPackages`）；`notAGate[]` 逐条说明「为什么它不是阈值事实源」。未登记的数据文件、幽灵声明、幽灵判据三类都判红；`kind=existence` 的豁免登记在 `data/gate-exemptions.json`（gate=`threshold-registry`），**按判据分开**：path=`<guard.path>.<包名>#membership` 只豁免「包在表里」、`#anchor` 只豁免「有回落锚点」，value 守卫的删键用 `<被移除的叶子路径>#removal`；认不出的键与已无缺口的键都判红（反向腐烂）。
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
