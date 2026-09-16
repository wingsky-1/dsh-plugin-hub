# DEVELOPMENT — dsh-plugin-hub 开发规范

> 覆盖**宿主端 / 客户端**两类代码的写法与构建契约，以及我们统一后的客户端形态
> （干净模块 + 独立 CSS + `src/client/` 目录 + 第三方内联）。适用于本公开仓库
> `packages/dsh-*` 的开发与维护。构建/契约/发布脚本见 `scripts/`；仓库级硬性规则见根
> [AGENTS.md](../AGENTS.md)，发版执行规程见 [.dsh/skills/dsh-plugin-release/SKILL.md](../.dsh/skills/dsh-plugin-release/SKILL.md)。

<a id="0-构建总览"></a><a id="user-content-0-构建总览"></a>

## 0. 构建总览

每个插件包 = 独立 npm 包（`@wingsky-1/dsh-*`），发布物自包含（第三方依赖构建期内联）。

> **安装依赖**：本仓库是 pnpm workspace（`pnpm-workspace.yaml` + 包间 `workspace:*`
> 协议 + pnpm 严格 node_modules）。动手前必须 `pnpm install`（在仓库根执行）。
> **不要用 `npm install`**——它会因 `workspace:*` 协议与 pnpm 布局而失败，且无法
> 复现 CI 的依赖解析结果。

```sh
pnpm install       # 仓库根，pnpm workspace 依赖安装（必须先于一切构建）
pnpm build        # 全仓构建 = pnpm -r build（各包：clean-lib → tsc → bundle-host）
pnpm contract     # 客户端契约（node scripts/gate/contract-check.ts）
pnpm test         # 全量 smoke（Node ≥23.6 原生 type stripping 直跑）
pnpm cov          # 覆盖率采集 + 阈值判分（vitest coverage / istanbul provider，只跑 unit + integration）
pnpm crap         # 单函数 CRAP 检查（阈值唯一事实源 scripts/data/gauntlet.config.json 的 crap.threshold / crap.strict）
                  # src 口径（#722 阶段五重建）；crap.strict=false 为观察期语义，见下方引用块
pnpm pack:check   # tarball 完整性（含聚合包）
pnpm typecheck    # 全仓类型检查
```

> Node 版本：本地直跑 TS 需 **≥23.6**（type stripping 门槛）；CI 固定 Node 24。
> 阈值事实源分处两处，按维度划分：**覆盖率**在 `scripts/data/coverage.config.json`
> 的 `thresholds`（#733 计划项 3.4 起；`vitest.config.ts` 只 import 它，不得再内联
> `include`/`exclude`/`thresholds`——降线由 `scripts/gate/threshold-monotonic.mjs` 对比
> `origin/main` 守护，面完整性由 `pnpm verify:coverage-scope` 守）；
> **变异与 CRAP**在 `scripts/data/gauntlet.config.json`。
>
> **覆盖率口径（#722 阶段三 / #769 收窄）**：`pnpm cov` = vitest 的 istanbul provider，
> 跑 unit + integration + client-unit + client-dom（四层都**直连 `src/`**）。分母是
> `scripts/data/coverage.config.json` 的
> `include`：`packages/*/src/**/*.{ts,tsx}` + `packages/*/src/**/*.mjs`（#733 3.4 补入的 3 个
> 适配器实现，1756 行）+ `shared/**/*.js` 的**源文件**——零 vendor、零 lib 产物，且未加载的
> 源文件按 0% 计入分母（分母不随「加载了什么」变化）。排除项是**结构化条目**（pattern +
> reason + kind），`verify:coverage-scope` 保证 src 下没有任何文件既不在 include 也不在
> exclude 里（静默逃逸即判红）。e2e（不可复现）与 contract（测 lib
> 产物）不进覆盖率，仍由 `pnpm test` 全量执行。阈值判分就是 `pnpm cov` 的退出码，
> 不再有独立判分步骤；PR 的 `gate:full` 标签与 `observe.yml` 夜间班次共用这一执行点。
>
> **client 面按包按面收窄（#769）**：此前是一条 `**/client/**` 整体排除，理由是「这些文件
> 没有直连 src 的判据，计入分母只会稀释阈值」。那条理由对**一部分**文件成立、对另一部分不成立：
> notifier 的 15 个纯 `.ts` 客户端模块里 12 个有直连判据（另有 2 个 DOM 面判据），它们计入分母
> 后实测全局 lines 82.48 → 81.76、functions 83.17 → 81.99，四项仍在阈值之上。故拆成 5 条
> `pending-project` 条目：notifier 只排除 `.tsx` 渲染面（等组件级渲染判据），另外 3 个包
> 各自的整个 client 面仍排除（尚未重写、没有直连判据），`shared/client/**` 排除（其测试在
> `scripts/test` 下、不属于任何 vitest project）；#840 退役 dsh-web-file-preview 后它那条随之删除。
> 全部带 `reviewBy` 与 `exitCriteria`，进 `collect-exemptions` 的到期台账；条目腐烂由
> `verify:coverage-scope` 判红。
> **某个包的客户端有了直连判据就删掉它自己那一条——不要等「全部重写完」再一次性解绑。**
>
> **`pnpm crap` 现状（#722 阶段五已重建为 src 口径）**：圈复杂度取 ESLint 内置
> `complexity` 规则，覆盖率取同一份 src 口径产物（`coverage/coverage-final.json`），
> 两者同源——此前「复杂度取自 lib 产物、与 src 口径行号不可比 → 入口自检 exit 2」的
> 停用态**已不成立**。`crap.strict=false` 是**观察期**语义：超阈热点只落盘
> `coverage/crap-report.json` 并 exit 0，置 true 才判红；数据源缺失或解析失败仍
> fail-closed `exit 2`。执行点：夜间 `observe.yml` 与 `gate:full --with-coverage`。

### 变异测试与增量链路（#178 / #187）

变异配置集中在 `stryker.conf.d/dsh-<pkg>.json`（未拆分包）与 `stryker.conf.d/dsh-<pkg>-<段名>.json`
（拆分包，段名=功能域，如 `dsh-notifier-server.json`；除 dsh-lan-proxy（待迁移功能段名）外
已弃用数字段号）。mutate 区间、
变异面测试清单、阈值口径与 `gauntlet.config.json` 三方一致，由 workflow-assert 自测锚定。增量链路：

**全量分工总述**：PR 门管变更切片；夜间 observe 门管主干全量；发版前
release.yml tag 管线跑全量门禁——全量只在这三处语义中的后两处真实执行。

- **observe 调度（#433 / #572 / #718）**：每日全量班（observe.yml，北京次日 04:00 = UTC
  20:00，cron `0 20 * * *`）刷新基线——刻意不 restore 任何缓存——无 incremental
  基线即天然全量。基线存**孤立分支** `refs/heads/baseline/mutation`（单 commit 纯文本树，
  #572：彻底剥离 main 分支代码树与自动 PR 噪音；旧 #204 方案 A 的「收进仓库目录
  `scripts/gate/baseline/` + 自动开 PR」已废除）。班次结构为三段式（#718 S1.1/S1.5）：
  `mutation-plan` 派生段清单与逐段超时 → `quality`（cov/契约/打包闸）∥ `mutation-shards`
  （逐段矩阵，`max-parallel: 8`、`fail-fast: false`、单段超时按实测校准）→
  `mutation-collect`（判分 + **单点并集入档** + 报告 + 工单，`if: always()` 收口）。
  逐包容错记账：单段失败不连坐，结尾统一非零退出。
  入档是**并集语义**（#718 S1.2）：先取回远端再叠加本次产物，本次未产出的段沿用远端文件，
  日志逐项记账「新算/沿用/缺/退役」——段被失败实例吃掉因而在物理上不可能再发生。
  **增量班（observe-incremental.yml）已于 #718 S2.2 退役**：其唯一独有价值是修复整树替换
  丢掉的段，而并集入档后该职责消失；基线新鲜度由「PR 合入即 overlay
  （baseline-overlay.yml，秒级复用该 PR CI 产出的 incremental 产物，不重跑变异）」+
  「夜间并集入档」两条路径承担。
  **基线陈旧可被观测（#718 验收判据）**：health-report.yml 周报（独立班次）在数据采集前读基线分支
  **最后提交时间**这一事实，超 48 h（连续两夜未入档）即输出 `::error::` 注解并按稳定标题幂等
  建/追工单，未超阈则在周报正文留一行基线龄；判定与阈值见 `scripts/release/baseline-staleness.mjs`。
  **发现与失败分开判**：stale（检查做成了）由工单承接、run 保持绿；unknown（gh api 失败 / 分支被改名
  或删除 / 响应缺字段，含状态文件缺失或状态文件缺 `status` 字段）由本 job **最末**的 verdict 步骤
  判红（白名单：只有 fresh|stale 绿，其余落兜底）——「环境失败不得静默降级」，放最末才不会连坐吞掉
  周报与陈旧工单两份留痕。
  **判据口径（勿说大）**：基线有两条写入路径——observe.yml 夜班并集入档
  （`scripts/gate/orphan-baseline.mjs`）、baseline-overlay.yml 在 push main 时对增量基线做秒级
  overlay（`scripts/gate/overlay-baseline.mjs`，两者共用 `scripts/gate/baseline-push.mjs` 写路径）。
  故本判据的真实语义是「**两条入档路径都停了**」，不是「observe 单点停了」：**绿 != observe 健康**
  ——夜班停摆但仍有触及变异切片的 PR 合入时，基线会被 overlay 持续刷新而恒 fresh；要单点观测
  observe 需另看它自己最近一次 run，本判据不做这个代理。**落点依据**是「监控者不得是被监控者」：
  本 workflow 独立于那两条写入路径，检查放进去会在它们停摆时一起沉默。
- **PR 门禁分层**（ci.yml，#722）：默认走**增量**，只有给 PR 打 `gate:full` 标签才跑全量链路
  （`pull_request.types` 含 `labeled`/`unlabeled`，打标签即触发重跑）。策略由 `changes`
  job 一处计算为 `fullGate` 输出，判定表与三个全量 job 的 `if` 共用同源布尔。
  1. `build-test` 矩阵（矩阵 = paths-filter 命中的包；空切片时补 1 个哨兵实例，防 GHA
     零实例矩阵回报 failure）：按命中包切片构建 + test + typecheck，artifact 只上传命中包；
  2. `repo-gate` 分两组——
     组 A（廉价全仓闸，恒跑）：判定脚本 `repo-gate-assert.mjs`、`threshold-monotonic`、
     `aggregate:check`、`stryker:check`、`test:scripts`、`forbid-src-tests`、
     `forbid-homedir-src`、`forbid-module-state-src`、`verify-scripts-index`、
     `verify-coverage-scope`、`verify:vendored-binaries`、`verify-dir-imports`（3 包硬判
     + provider-usage `--soft`）、`export-surface-snapshot`（dsh-notifier）、
     `verify-shared-fanin`、`docs:check`、`lint`、`format:check`
     （本清单是导读，**事实源是 ci.yml 的 repo-gate 步骤本身**。接线由
     `scripts/test/gate-wiring.test.ts` 两族断言守护，缺一不可：**一致性**——「本地档位计划 ↔
     CI 恒跑段」两侧各自现场派生「被执行的脚本身份」后双向比对，改任一侧漏改另一侧即判红；
     **覆盖性**——一致性只是相对不变量，两侧**同时**删掉同一执行点后集合仍然相等，故还要拿
     `scripts/gate` 下的判据全集比「全部 workflow × 全部 job ∪ 本地 pr/full 档 ∪ lefthook」的
     执行点全集，既无执行点、又不被非测试源码 import 的判据必须显式登记
     （`scripts/data/gate-wiring-exceptions.json`，受悬空、class 方向、脚本存在、总量上限、
     indirect 的 `via` 可达（`via: package.json` 还要求该别名在仓库里确有出处）且真的没有执行点
     等守卫）。另外几族拦的是「执行点在、判据也在跑，但退出码到不了步骤」，扫描面是**全部
     workflow 的全部 job**：① 判据步骤只允许**一条直接的判据命令**（`exit "0"` 前置、
     `if [ ]; then` 包装、`X=1 set +e` 这类写法列举不完，故闭合形态而非继续补枚举），设计如此的
     例外（产物闸的 if/else 双形态、变异判分的循环与聚合等）逐条登记在 `structuredSteps`，登记项
     再用**文本摘要** `digest` 钉死（否则往循环里插一行 `break` / `continue` 就能让剩下的判据不再
     执行，而步骤键、执行点、两侧身份全不变）；② 步骤级 `if`（`stepIfs`）与含判据的 job 的 job 级
     `if`（`jobIfs`）必须逐字登记——它们是「改一处即静默停闸」的开关，而「这个条件会不会成立」
     静态判不出（等于停机问题），登记制是唯一能把静默开关变成 diff 里显眼一行的手段；③ workflow 与
     lefthook 的 YAML **交给成熟的 `yaml` 包解析**（devDependency；引号键 / 空格冒号 / 块标量与折叠
     标量 / flow 写法 / 重复键都由它按 YAML 语义处理，文件级解析错误、白名单之外的步骤键、非字符串
     `run` / 非映射的 `env` 都由 `parseIssues` / `yamlErrors` 报出来判红；工作流**文件集合**本身也是
     硬编码契约，防文件被删或改名时断言整体空转全绿），判据步骤另不得覆盖 `shell`（内建关键字放行，
     自定义模板必须取 basename 后属 bash 家族、把 `{0}` 交给解释器且自带 errexit）、不得带
     `continue-on-error`、不得注入能改变执行环境的变量（`BASH_ENV` / `SHELLOPTS` / `NODE_OPTIONS` / `PATH` / …）、命令引号
     必须配对（都不设登记出口），判据步骤的**有效 env 键**（workflow ∪ job ∪ 步骤三层）逐键登记在新增的
     `stepEnvs`；判据 job 的**环境面**按位置整条登记（不按「谁写了 `$GITHUB_ENV`」判——字样总能被绕开）：判据步骤
     之前的每个非判据 run 步骤进 `priorRunSteps`（整步摘要 + env 键），该 job 的**执行面**（前序步骤有序
     序列 + 全部 `uses:` 步骤整步文本 + job 级 `container` / `defaults`）进 `jobFaces`——action 里是任意
     代码，同样能写 `$GITHUB_ENV`；一处 `if: false` 也能让产物上传静默不跑；`container.env` 与
     `defaults.run.working-directory` 是换掉整 job 执行环境的 job 级键，判据步骤自己声明 `working-directory`
     则直接判红（不设登记出口）；已登记条件的操作数来源、其输入步骤（同 job 的 `uses` 整步面）与 artifact 产出端登记在
     `conditionInputs`——这些都是「条件 / 环境成立与否的输入面」，只钉条件原文挡不住改产出；④ 判据别名的展开结果必须干净，且**指向必须逐条登记在
     `judgmentAliases`**——期望身份与别名指向同源派生，改名改参会让两侧一起移动、比对仍然相等，
     故需要这条外部锚点；⑤ 本地 pr 档必须覆盖 full 档的全部判据端点（差额只能登记 `tier-only`），
     判据不得内嵌进另一个判据的执行点。产物闸 `contract` / `pack:check` / `verify:npmlayout` 还必须
     同时存在切片与全仓两种调用形态，删掉任一侧即判红。
     覆盖性只要求「至少一处执行点」，不要求该点在 PR 面——某判据只在 `observe` / `release` 跑时，
     它在 PR 上的回归不会被拦住；故执行点全部落在非 PR 面（CI 侧 = ci.yml 里**未**按 `gate:full`
     标签收口的 job，本地侧 = **pr** 档）的判据必须登记 `nightly-only` 或 `tier-only`，这份清单就是
     「PR 上拦不住哪些判据」的答案；恒假（`if: false`）的 job / 步骤不算执行点，否则一个 decoy
     步骤就能顶替被删掉的判据）
     （`format:check` 是形态的唯一执行点：面由 `.prettierignore` 显式圈定，只格式化代码面，
     文档 / `.github/` / 生成器写入的数据与派生物被排除并各带理由；
     **纯格式化提交必须登记到仓库根的 `.git-blame-ignore-revs`**：否则一次全仓重排会把数百个
     文件的 blame 全部算到格式化提交上，真实作者与改动动机一起被淹没。GitHub 的 blame 视图
     原生读该文件，本地需 `git config blame.ignoreRevsFile .git-blame-ignore-revs` 开一次；
     混入语义改动的提交不得登记（会被整条跳过）；
     `test:scripts` 的编译面前置包清单见
     `scripts/test/script-test-prereqs.mjs`，CI 与本地门禁同源读取；
     `verify-scripts-index` 的判据见 `scripts/README.md` 顶部说明——**索引边界是「仓库会调用
     什么」**：索引项必须存在，被调用点引用的脚本必须登记）；
     组 B（产物闸，按 `fullGate` 切口径）：`contract` / `pack:check` / `verify:npmlayout`
     —— 默认只验命中包（`--packages <命中清单>`），`gate:full` 时验全仓；
  3. `coverage`（全量链路）：只在打了 `gate:full` 标签的 PR 上实例化；`mutation-gate` /
     `mutation-verdict` 自 #742 阶段 1 起**与标签解耦**——PR 上一律按命中切片强制跑。coverage 全局单次采集（`pnpm cov` = vitest coverage，只跑 unit +
     integration，阈值判分即其退出码；摘要产物经 artifact 留档——cov 从变异矩阵剥离后，
     矩阵多实例各自全仓 smoke 导致的端口竞争 flake 随之消除）；mutation 按命中包切片跑
     Stryker（incremental 跳过未变 mutant）；verdict 汇合变异报告逐包判分（变异率 covered
     ≥ per-package threshold，受 `mutation.strict` 约束；覆盖率维度已上移到 coverage job，
     改由 repo-gate 判定表按 `fullGate` 裁决——verdict 不再以 coverage 结果为 `if` 前提，
     故 cov 失败/skip 不会吞掉变异判分）。矩阵实例级 failure 时 verdict
     仍聚合判分（缺报告包 exit 2 fail-closed）。

  判定表为**六维**「事件 × fullGate × 切片(hasMutations) × coverage × 变异矩阵 ×
  verdict」，由单测全组合锁死。默认增量路径下三段必须**全部 skipped**——对称 fail-closed：
  没打标签却跑了全量同样判红。不新增分支保护 required check 名。

- **为什么分层**（#722）：覆盖率是「全仓分母」口径，变异单段最坏约 20 分钟（#720），而
  两者夜间 observe.yml（每日全量班）已完整覆盖，PR 上属重复执行且拖长
  反馈回路。高风险改动（重构、依赖跃迁、发版前）在 PR 上加 `gate:full` 标签按需补跑；
  全仓产物闸在 `gate:full` PR 与 observe 全量班两处落地，默认 PR 只验命中包。
- **触发面收敛**（#187 / #217 扩展）：全量三段 job 仅限 pull_request 触发——push 到 main
  时 diff 基准取 `github.event.before`（只有 force push / 新分支首推这类全零 SHA 才走
  fail-closed 全量 fallback），变异在非 PR 事件下整体 skipped、与当晚夜间全量不重复；主干覆盖与变异覆盖由 observe.yml 夜间全量承接、发版前
  由 release.yml tag 管线承接，非 PR 事件下三段 job 整体 skipped 且 `fullGate` 恒为 false
  （repo-gate 判定表显式放行）。
- 本地手动入口：`npx stryker run stryker.conf.d/dsh-<pkg>.json`（临时强制全量用
  官方 `--force` 参数，勿改配置文件）。
- **测试单份维护（#423 方案 A）**：变异测试复用 `packages/*/test/*.test.ts`，
  测试单份维护、变异自动覆盖。**#722 起变异面（`unit/`、`integration/` 两层）内的
  `*.test.ts` 直接 `import "../src/**"`**，变异与覆盖率都跑在源码上，不再需要解析期
  重定向；`#423` 时代的 `scripts/test/mutation-lib-to-src-{hook,loader}.mjs` 已随
  #722 阶段五退役（连同其最后的消费者 `scripts/gate/cov.mjs`）。`e2e/` 与 `client/`
  层仍读 `lib/` 产物（前者跑真实 IO、后者测客户端契约），二者不在变异面内。
  仓库出现任何遗留 src 副本测试文件（含未跟踪）即 `scripts/gate/forbid-src-tests.mjs`
  判红（ci.yml repo-gate 步骤「Forbid legacy src tests」）。

目录结构：

```text
packages/dsh-*/            # 每个插件 = 独立 npm 包（@wingsky-1/dsh-*）
  src/index.ts             # 宿主端入口（cordis service，export ROUTES 作客户端路由单一来源）
  src/client/index.ts      # 客户端干净模块入口（只 export apply/inject，无 load/IIFE 外壳）
  src/client/style.css     # 客户端样式（独立文件，构建期 text-loader 内联进 client.js）
  src/client/*.ts          # 客户端辅助模块（宿主用不到、仅浏览器侧）
  src/*.ts                 # 其余为宿主模块；宿主导出的 profile 依赖另见 cordis.patch.yml
packages/dsh-plugins-all/  # 聚合包（dependencies 引用全部子包，发布用 pnpm publish 替换版本号）
shared/                    # 宿主端共享层（loopback/host-utils/frontmatter），构建期内联进各包，不发布
scripts/                   # 仓库维护脚本（*.ts，Node 直跑；按职能分 build/ gate/ lib/ release/ test/ data/）
```

`scripts/build/bundle-host.ts` 编排单包构建：

1. esbuild 内联 `shared/*` 进 `lib/index.js`（宿主端自包含单文件）。
2. 客户端经 `scripts/build/build-client.ts`（唯一契约外壳/注入点）构建 `lib/client.js`。
3. d.ts X1：shared 声明随包机制（见下小节）。
4. 拷贝资源（非代码文件，递归且保持相对路径）+ LICENSE。
5. 第三方 license 归集：扫描产物中 esbuild 的 node_modules 模块注释，把真实被内联
   的第三方库（含传递依赖）license 文本写入 `lib/THIRD-PARTY-LICENSES`
   （`scripts/build/collect-licenses.ts`）。**运行时依赖 = 构建期内联**——内联在法律上
   等于分发该库副本，必须随发布物附其 license 文本与版权声明；`pack:check` 断言
   「有内联 ⇒ 清单存在、非空、含 MIT/BSD/Apache 字样且覆盖每个被内联的包名」。

<a id="dts-x1"></a><a id="user-content-dts-x1"></a>

### d.ts X1：shared 声明随包机制（#478）

宿主端共享层（shared/）是 **js + d.ts 双写**（tsc `rootDir` 硬约束，shared 不可
TS 化）：`.js` 实现经 esbuild 内联进各包运行时，`.d.ts` 声明则经 X1 随包发布。
X1 在 bundle-host 构建宿主产物时对 **tsc 声明产物**做两件事（纯类型层，运行时无关）：

- **2a 路径改写**（`scripts/lib/rewrite-dts-paths.ts`，`rewriteDtsPaths`）：改写
  `lib/**/*.d.ts` 中所有指向**仓库外 shared/** 的相对引用——tsc 从 src/ 原样写入
  声明的 `../../shared/` 等（实际形态 `(?:\\.\\.\\/)+shared/`）→ 指向**包内副本**。
  前缀按当前文件在 lib/ 下的目录深度归一为 `'../'.repeat(depth + 1)`：整体吞掉任意
  深度 `../` 前缀后按文件深度重算——顶层 `lib/x.d.ts`（depth 0）→ `../shared/`，
  子目录 `lib/client/x.d.ts`（depth 1）→ `../../shared/`。引用原深度与文件深度无
  对应关系（归一化语义：一律按**文件**深度）。顺带把相对 `.ts` 后缀 import 回写
  `.js`（rewriteRelativeImportExtensions 的 d.ts 不回写缺口，issue #276；未启用该
  flag 的包无匹配，天然无操作）。发布后 d.ts 不再引用包外路径，类型解析全部落在
  包内副本。
- **2b 声明副本进包**：把仓库根 `shared/` 下全部 `.d.ts`（递归，含子目录如 `client/`）复制进 `packages/<pkg>/shared/`（保留相对目录结构），随包发布。
  复制谓词与遍历实现 = `scripts/lib/walk-files.ts` 的 `walkFiles`（单一事实源）。

**副本清单来源**：不是包内静态清单——每次构建**实时枚举仓库 shared/**（`walkFiles`
谓词 `.d.ts`）。包根 `shared/` 不入 git、属构建产物（.gitignore
`packages/*/shared/`；clean-lib 只清 lib/ 不清包根 shared/），经各包 package.json
`files` 白名单 `shared/**/*.d.ts` 发布。

**与 shared 准入规则的关系**：X1 是 shared 契约的**发布面强制器**——准入规则
（shared/README.md 准入 1-7：≥2 稳定消费者、无包级常量依赖、跨 apply 状态语义明确、
无泄漏、登记消费方与行为契约、独立测试、显式废弃两步走）约束**哪些模块有资格进
shared**；X1 保证**已准入的模块随每个消费包完整发布**（机制保证）。「准入审核 →
进 shared → 自动随包」，使 shared 单点维护而各包发布物自包含不断链。

**断言链**（`scripts/lib/shared-dts-lib.ts` + `pack:check`）：

- `listSharedDts(ROOT)` 用与 2b **同一 walkFiles 谓词**枚举仓库 shared/ 全部 .d.ts
  相对路径；pack:check 打包每个插件后逐包比对 tarball：
  - `assertSharedDtsPresent` 查缺：新增 shared 子目录/文件漏随包 → fail-loud；
  - `assertSharedDtsNoExtras` 查多（#478）：**retired 残留**——shared 模块退休
    （DEPRECATED 两步走 → 移除）后，旧声明副本残留在包内 shared/（bundle-host 每次
    构建覆盖写入新副本但从不清理已移除者，files 白名单仍会把它带进 tarball，过期
    声明随包发布 = 陈旧类型面）→ 报「shared 副本残留」fail-loud。
    枚举与复制同源，杜绝两处漂移；双向（缺/多）断言把「机制保证」升级为「断言保证」。

宿主端类型一律用官方类型层（pnpm-workspace catalog 锁版：`@deepseek-ai/cordis`
的 `Context` + `@deepseek-ai/dsh-host-webserver` 的 `WebRoute`/ctx.webServer 增强 +
`@deepseek-ai/dsh-tools` 的 `ToolDefinition`/ctx.tools 增强等；仅 import type，
contract-check 禁止运行时值导入）。原自建类型层 `types/dsh.d.ts` 已删除（issue #48）。

**版本适配策略（只适配 rc）**：官方类型层 catalog 升级以 **dsh rc 版本**为锚定
基线（当前 `0.1.5-rc.1`），peer 与 catalog 锁步；**不对 alpha 版本适配**，除非
维护者明确决策。升级 catalog 须跑全量门禁并核验受影响的结构（如
SessionHeader.origin / Agent.session），并同步根 README「版本适配」与 release notes
锚定声明。

<a id="1-宿主端srcindexts规范"></a><a id="user-content-1-宿主端srcindexts规范"></a>

## 1. 宿主端（`src/index.ts`）规范

- **单入口**：`src/index.ts` export 一个 cordis service；需要给客户端传路由时
  `export const ROUTES` 作为**单一事实源**——`bundle-host` 经 `__DSH_ROUTES__`
  define 注入给客户端（客户端不引用则零影响）。
- **依赖纪律**：只 import `../../shared/*`（loopback / host-utils / frontmatter，构建期
  内联）与 Node 内置模块；**任何第三方运行时依赖一律由 esbuild `--bundle` 内联**
  （如 mcp-manager 宿主用的 `fast-glob`），发布物不以运行时 npm 依赖形式发布。
- **安全**：全部路由强制 loopback 围栏（非回环 403、方法错 405），`/health` 必项；
  RPC/端点做参数校验；密钥/凭据不入包。
- **挂载**：`cordis.patch.yml`，patch **id 用 `ui-<name>`**；声明 `dsh.client` 时必须有
  `exports["./client"]`（`contract-check` 联动断言，缺则整包拒载）。**独立包与聚合包
  禁双装**（同 id 双装 loader 报 duplicate）；改独立包 patch 后必须
  `node scripts/gate/aggregate.ts` 重新生成聚合 patch。
- **测试**：`pnpm test` 直跑（包内实现为 `node ../../scripts/test/run-vitest.mjs --min <N>`）。
  运行器由 vitest 承载：根 `vitest.config.ts` 从 `scripts/data/mutation-topology.json` 的
  `$testLayers.layers` 派生六个 project（`test/unit` → `unit`、
  `test/integration` → `integration`、`test/client-unit` → `client-unit`（直连 src 的客户端
  纯逻辑判据）、`test/client-dom` → `client-dom`（happy-dom 环境，直连 src 的 DOM 单测）、
  `test/client` → `contract`、`test/e2e` → `e2e`；
  层 glob 与 `--min` 口径因此同源，不再三处声明），
  每个测试文件独立环境（per-file 隔离），包级调用按 cwd 自动收窄到本包；
  乱序验证用 `--sequence.shuffle` 透传。
  测试文件直跑 TS 源码，但部分文件断言 `lib/` 产物
  （如客户端产物契约），故跑前仍需 `pnpm build`；必含 403/405 围栏用例 +
  客户端契约断言（`assertClientSourceContract` / `assertClientProductContract`）。
  `--min` 是**测试文件数**下限（vitest json reporter 的 `testResults` 计数），用于封堵
  include 配置漂移导致部分文件漏收集的假绿向量；各包 `--min` 与实际文件数由
  `node scripts/gate/gen-stryker-conf.mjs --check` 强制同步（判据 ③）。

### 测试分层与变异面登记（#690 S2b / #713 T1–T3）

测试文件按**机制**分层，目录即分类源（不按文件名判断）：

| 层                    | 判据                                                                                                                                                | 进变异面 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `test/unit/**`        | 单模块 / 纯逻辑 / fake 驱动、只做临时目录 I/O（允许为覆盖分支而短暂 bind 一个端口，如 lan-proxy 的 EADDRINUSE 用例）                                | 是       |
| `test/integration/**` | 以真实 socket/真实组合根为被测对象：起真实 http server（内核临时端口）走完整转发链、真实 cordis Context、真实配置迁移                               | 是       |
| `test/client-unit/**` | 直连 `src/client/**` 的**纯逻辑**判据（判定、映射表、状态机），不需要 DOM；环境 `node`                                                                  | 是       |
| `test/client-dom/**`  | 直连 `src/client/**` 但被测模块在**加载期或运行期真的读写 DOM**（`document.title`、横幅挂载），必须 `happy-dom`；文件头用 `@vitest-environment happy-dom` 声明（派生配置是单 project `node`，不吃根配置的层环境） | 是       |
| `test/client/**`      | 断言对象是客户端**构建产物**形态（`lib/client.js`、或 in-place esbuild 后执行已构建副本）——产物外壳无法用 perTest 覆盖分析归因到任何 `src/**` 模块，登记进变异面只增加每个段的 dry run 成本、杀灭贡献为零；直连 src 的判据在 `client-unit` / `client-dom` | 否       |
| `test/e2e/**`         | 真实监听端口 / spawn 子进程 / 真机系统调用的大 smoke                                                                                                | 否       |

支撑模块不入任何层：`test/helpers.ts`、`test/client-helpers.ts`（客户端判据共用的替身，只服务
一个域故不上提包级夹具）、`test/smoke-lib.ts`、`test/smoke-pure.ts`、`test/*.worker.mjs`
（它们不是测试条目）。**判层按机制而非文件名**：notifier 的
`e2e-*.test.ts` 用的是 in-process cordis Context + fake 驱动（不 listen、不 spawn），
故归集成层并保留在变异面；反之 `smoke.test.ts`（真实端口/子进程）归 e2e 层。

登记链路（唯一事实源 = `scripts/data/mutation-topology.json` 的 `$testLayers` 与各包 `testLayers`）：

- 变异面测试清单由 `scripts/gate/gen-stryker-conf.mjs` **从层 glob 展开为真实文件清单**，落在
  每包一份的 `vitest.stryker.d/<pkg>.config.ts` 的 `include` 上（#722 方案 A 路径一）。
  为什么不由 Stryker 的 `testFiles` 承载：该字段非空会让 core 把 static mutant 判成 runtime
  激活（上游 #6144 未修），模块级变异体在模块加载后永久漏判（实测 80.49 → 0.00）。
  为什么不把 `**` 通配直接交给 Stryker：#712 已 CI 实证沙箱语义失败（`smoke.test.ts` 的
  provide 方法面断言）+ mcp 5 个段 dry run 撞 5 分钟预算；
- `pnpm stryker:check` 是登记完整性门禁（实现见 `scripts/gate/test-surface.mjs`，纯函数、import 无副作用）：
  ① 磁盘上有测试的**每个包**都必须在拓扑登记（漏登即在 `$noMutationPackages` 写明理由），且该包
  `test/` 下每个 `*.test.ts` 都要有层归属——新增测试必须显式决定层归属，不能靠「没写进清单」逃逸；
  ② 每条登记与每条豁免在磁盘上真实存在；③ 每个有测试的包（含未登记变异面的包）`--min` == runner glob
  实际文件数；④ **充分性下限**：`mutationLayers` 必须包含 `test-surface.mjs` 里的 `REQUIRED_MUTATION_LAYERS`
  （unit + integration）且每包变异面非空——防「两行拓扑改动把变异面削掉」；
  ⑤ 每条派生 `mutate` 条目（正向与 `!` 排除同等）必须**锚定在本包（或 `shared/`）**、在**源码世界内
  命中 ≥1 文件**、且命中面不越出本包或 `shared/`。字面前缀不足以证明锚定：`..` 会被 glob 归一化、
  brace 会展开，两者都能让前缀看着在本包而命中他包文件（独立复核各实测出绕过形态）；
  ⑥ **有效面非空**：一份 conf 的正向命中被 `!` 条目剔除后必须仍有剩余——⑤ 只判**单条**条目，
  一条包根级整包通配能在条数不变、⑤ 全绿的前提下把整包变异面清空，而 Stryker 对 0 mutant 不报错
  （判分与门禁都静默）。此外段级 `excludes` 的**条目形状**（非空字符串 + `!` 前缀，缺 `!` 会极性
  反转）与包登记（空 `segments` 指向 `$noMutationPackages`）在派生前先判；
- 新增测试文件后的固定动作：放进对应层目录 → `node scripts/gate/gen-stryker-conf.mjs --sync-test-min`
  → `pnpm stryker:gen` → 提交。单元层与集成层**零手工登记**；`testMutationExemptions`（按层分组）只用于
  「刻意不进变异面」的逐条裁决，必须写明理由，模型样例两条：
  mcp 的 `unit/unit-shared.test.ts`（测的是 shared 层，不在本包 mutate 面内）、
  notifier 的 `integration/real-context.test.ts`（Stryker 沙箱内 dry run 失败，属 #712 记录的沙箱语义族）；
- 变异面扩缩**在 PR 门禁里看不出来**（`incremental: true` 复用基线状态）。真信号来自 observe.yml
  班次全量重建；PR 内的自证方式是「派生测试面 ↔ 基线的集合对比 + 单段真跑 stryker 报告的
  mutant 状态分布与基线一致」。

### 落盘路径必须感知 DSH_HOME（#510）

凡插件自行落盘或读取持久化文件（配置、历史、状态、缓存等），路径 base 一律
`process.env.DSH_HOME ?? join(homedir(), ".dsh")`，**禁止直拼 `join(homedir(), ".dsh", ...)`**：

- **为什么**：官方 dsh 在隔离环境（多实例 / 测试沙箱 / dsh-verify-isolated 临时
  home）下运行时，settings 存储等宿主数据已随 `DSH_HOME` 隔离；插件若仍硬拼
  `~/.dsh`，读写两面都会串到真实 home——#510 即 dsh-notifier 通知历史/投递状态
  落真实 `~/.dsh`，隔离实例的通知记录 tab 读出用户真实数据。
- **写法先例**：`packages/dsh-provider-usage/src/path-resolve.ts`（`pluginHome()`）；
  收敛方向为 `shared/dsh-home.js` 单一事实源（#517 C10 接缝），现阶段各包内聚
  helper 亦可，但不得绕过 env 读取。
- **豁免口径**：读取**非 dsh 生态**的外部凭据/配置（如 provider-usage 读 opencode
  自家目录）不跟随 `DSH_HOME`，属合法例外——豁免须在代码注释说明「为什么不跟随」。
- **测试义务**：新增/改动落盘路径时，路径契约断言必须双锁定——默认形态
  （无 `DSH_HOME`）路径逐字节不变 + 设 `DSH_HOME` 后路径随隔离 home（finally
  恢复 env，防污染同进程其他用例）；写面用 e2e 落盘断言锁定（读函数返回值不足
  以证明写面）。
- **门禁（已落地）**：`scripts/gate/forbid-homedir-src.mjs`（B5，#517）以 AST 扫描
  禁止插件 src 直连 HOME 来源 API（`os.homedir` / `os.userInfo` / `process.env.HOME` /
  `untildify`，含 import 别名、`os["homedir"]` 中括号混淆形态与动态 import
  命名空间形态；`.ts/.tsx/.mts/.mjs` 全覆盖，解析失败一律 fail-closed 判红）。本闸
  **没有豁免通道**（#765）：该面收口到零豁免后，台账条目与调用点注释词法一并删除，命中即
  违规——需要 home 路径就走 `shared/dsh-home.js` 的 `dshHome()`。留一个零命中的豁免入口
  只会让下一处命中默认「先开豁免」而不是「先看接缝」；确有域外合法场景时先在 #765 讨论，
  不要在闸内复活豁免常量或注释词法。
  本地运行 `pnpm gate:homedir`；CI 在 repo-gate 段执行。解析器说明：typescript 7 已移除
  经典 JS AST API，扫描链为 esbuild 剥类型 + acorn estree 解析 + node:module
  SourceMap 行映射回 TS 原文（行号以原文为准，transform 会剥离注释）。

### 事件订阅与 scope 语义（cordis dispatch 过滤）

cordis `EventsService.dispatch` 对已注册监听器的过滤条件为
`hook.global || !filter || filter.call(thisArg, hook.ctx)`（`hook` = 监听记录，
`thisArg` = 派发载体）：

- **`hook.global` 无条件放行**：注册第三参数 `{ global: true }`（cordis
  `EventOptions.global`，官方语义 = "Receive the event regardless of context
  filter checks"）使该监听器跳过一切 filter 检查；
- **`!filter` 放行**：裸 `ctx.emit(name, ...)` 派发（`thisArg` 无
  `[Context.filter]` 标签）对所有监听器放行；
- **untagged listener ctx 放行**：宿主 dsh-scope 的 `scopeTarget(agent, agent)`
  carrier 派发带 filter（`scopeOf(ctx) === undefined → true`）——**无 scope 标签
  的 listener ctx 直接放行**。第三方 bundle 插件经 `cordis.patch.yml` 平铺
  insert 挂载、ctx 无 `kScope` 标签时，agent 作用域事件默认可达，**无需**
  `{global:true}` 即可收到（该假设已由真实 cordis Context 契约用例固化——
  见 dsh-notifier `test/integration/real-context.test.ts`，宿主若收紧 untagged 放行语义，
  用例先红而非静默漏检）。

**第三方 bundle 插件接收 agent 作用域事件的推荐做法**：

- 默认挂载形态（untagged 平铺）下不加 `{ global: true }` 也能收到事件——它是
  **消费端防御而非必需**：对「事件必须到达」的关键监听（如通知类插件的完成/
  错误事件）建议加 `{ global: true }`，把事件到达与宿主 scope 分发语义解耦，
  即使未来以 private-scoped 形态挂载（listener ctx 带 scope 标签且与事件
  carrier 的 scope 不一致）仍全收（dsh-notifier 全部 `ctx.on` 均如此）；
- **代价**：`global` 会收到**跨 scope** 的事件——消费端必须按「payload 自校验
  - 事件内容过滤」处理（事件载荷跨宿主边界不受信，逐字段运行时校验），仅想靠
    scope 过滤防串扰的监听不应加 `global`。

## 2. 客户端（`src/client/index.ts`）规范 — 干净模块

**核心：源码只写干净模块，不写任何 loader 痕迹。**

```ts
import STYLE from "./style.css"; // 样式走独立 CSS（见 §3）

// ... 顶部模块体（函数、常量、DOM 渲染）...

export function apply(ctx: any): void {
  // 挂载入口
  // ctx.get("connection"/"sessions"/"workspaces"/"slots") ...
  // 卸载清理必须写在 ctx.effect(() => () => { ... }) 返回的 disposer 里
  ctx.effect(
    () => () => {
      cleanup();
    },
    "dsh-<name>: ui",
  );
}

export const inject: string[] = []; // 声明 apply 用到的 ctx 服务（如 ["slots"]）
```

**禁止在源码里**：`window.__ModuleLoader__.load`、手拼 `__DSH_PLUGIN_ID__`、`require(`、
外层 IIFE `(function(){})()`、`declare var module` / `interface Window.__ModuleLoader__`。
这些（load 注册、IIFE 闭包工厂、`Symbol.toStringTag` 装配、`exports.apply/inject`、
**load id === 包名**）全部由 `scripts/build/build-client.ts` 构建期统一生成——是唯一事实源，
内建「load id === 包名」硬校验（构建即失败）。

### 2.1 三种客户端路径（build-client 自动选择，作者不用配置）

| 路径                | 触发                                      | 说明                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯净 wrapper        | 干净模块、无 bare import                  | esbuild iife + 生成契约外壳；`apply/inject` 直出                                                                                                                                                                                 |
| wrapper + externals | 干净模块 `import * as React from "react"` | 干净模块 cjs 内联进 `factory(require)`，React 由 loader 的 `require("react")` 注入（dsh web **无全局 React**）。需同目录 `react-shim.d.ts`（`declare module "react"`，不引 @types/react），`peerDependencies.react` + `optional` |
| 第三方内联          | `dsh.client.inlineBareImports: true`      | 干净模块的 bare import（dompurify/diff2html/marked/highlight…）由 esbuild **内联进 client.js**，产物仍自包含。用于纯浏览器第三方库、无宿主注入 JS 模块的场景                                                                     |

> ⚠️ **互斥**：默认「bare import = 宿主注入 external（React）」；`inlineBareImports: true`
> 则全部内联。按包二选一，不要混用。

### 2.2 目录约定

- 客户端入口统一 `src/client/index.ts`（`src/client.ts` 已停用）。
- **拆 CSS 或带多模块/React shim 的包**：客户端专属模块（`md/code/renderer` 等）、
  `style.css`、`react-shim.d.ts`、`css.d.ts` 都归位 `src/client/`；宿主模块留 `src/` 根。
- **宿主 & 客户端共享**的模块（如双端共用的后缀表 / 契约常量）留 `src/` 根，
  客户端经 `../grouping.js` 引用——不要为"客户端专用"而把共享模块搬走。
- **例外：包内 `src/shared/**`（#769 起）**。双端共享且要求**零 import**（或只做同目录
  `.ts` 相对 import）才能两端各自 inline 的模块（典型是契约常量表与种类表）归位
  `src/shared/`，两端都经 `src/shared/interface.ts` 这一处门面引用（目录头写明约束，
  见 `packages/dsh-notifier/src/shared/interface.ts`）。放进这个目录的意义不是分类而是
  **可审**：`scripts/test/shared-leaf-imports.test.ts` 按「客户端是否经门面消费」推导扫描面，
  对门面转出链上的每个叶子模块机械判红（值引 `node:*` 会构建失败、值引 bare 包会**静默内联**
  进浏览器产物）。该目录的最终形态（包内 `src/shared/` 还是独立 shard 目录）由 #792 的三档
  共享规范裁定。

### 2.3 客户端其它要点

- `inject` 语义：声明 `apply` 运行时用到的 ctx 服务；不需要则 `[]`。**这是运行时的
  服务注入声明**，与宿主的 cordis `inject`（插槽）是两码事，别混。
- 生命周期：所有卸载清理写进 `ctx.effect(() => () => {})` 的 disposer。
- 样式：带插件前缀隔离 + `CSS_VERSION`/`dataset.version` 失效（热更新重建 `<style>`）；
  颜色用 `--dsw-alias-*` / `--dsw-hljs-*` 主题变量 + 浅色回退，明暗自适应。
- 挂载失败 `console.warn` 不 throw，绝不让 GUI 启动失败。
- 路由引用用构建期注入的 `__DSH_ROUTES__`（或宿主 ROUTES 字面量），防两端漂移。

## 3. CSS 规范（独立文件，不写进 TS）

- 客户端样式放独立 `src/client/style.css`，源码 `import STYLE from "./style.css"`，
  经共享 helper 注入（issue #477 收敛 `shared/client/ensure-style.js`）：
  `ensureStyle({ id: "dsh-<pkg>-style", cssText: STYLE, version: CSS_VERSION })`——
  按 id 幂等、head 缺失静默 no-op 不抛、version 变化重建 `<style>`（热更新失效）、
  返回 disposer；不要在包内自写 `createElement("style")` 注入段。
- `.css` 经 `build-client` 的 **text-loader** 构建期**原样内联**成字符串打进
  `lib/client.js`——产物仍自包含单文件、无独立网络请求。
- `src/client/css.d.ts` 提供 `declare module "*.css"`（tsc 的 `verbatimModuleSyntax`
  需要类型；仅类型面无运行时）。
- 用**格式化多行**书写（区别于旧的字符串拼接）；前缀硬编码进 CSS 与 JS 常量保持一致。

## 4. 契约与门禁

- `pnpm contract`（contract-check）：load id === 包名、`dsh.client ⇒ exports["./client"]`、
  `src/client/index.ts ⇒ lib/client.js` 产物、arrive 可解析、`exports.apply/inject` 装配。
  下列两条门禁原先内嵌在本脚本里以 `spawnSync` 执行——判据确实在跑，但 workflow 与本地档位
  计划里都看不到它们，于是「每条判据至少一个可见执行点」对它们恒为假。审计 P0-1 后迁成
  **可见的直接步骤**：CI 侧在 `ci.yml` 的 repo-gate，本地侧在 `gate-steps.mjs` 的 cheapGlobal；
  接线由 `scripts/test/gate-wiring.test.ts` 双向断言守护，**本段不再执行它们**：
  - **依赖图门禁（`scripts/gate/verify-dir-imports.mjs`；#690 S0 / #733 M0）**：模块按
    **叶子粒度**（递归含 `interface.ts` 的目录，分组层透明）划分，跨模块引用只能走目标
    模块的 `interface.ts`（入口）或 `deps.ts`（出口）。`scripts/data/dir-imports-baseline.json`
    是单调基线，两类入库形态不同：**结构型**存计数（模块数/源文件数/边数/引用数等规模计数），
    随新增文件与目录合法上升，由 `--write-baseline` 登记；**质量型**存**证据集合**
    （`leafModuleCycles` / `fileCycles` 的环签名、`raLegacy` / `implToOtherImpl` 的
    `from|to|kind` 边、`missingInterface` / `directImpl` 边、`uncoveredSrcFiles` 清单）——
    新增证据判红、证据消失视为改善（写入时自动清理）、`kind` 由 value→type 视为收口、
    type→value 判红。放宽质量证据**不止一条通道**，各通道的可审计性不同：
    - **台账通道**（唯一带收口复核）：登记到 `scripts/data/gate-exemptions.json`
      （`gate=verify-dir-imports`，`path=<包名>:<证据项>`，必填 reason 与 trackingIssue，
      可选 reviewBy 与 exitCriteria）——与另两闸共用同一份台账、同一个校验器与同一条收口台账
      （#765 收口：原先的 `--accept-quality-new` / 基线内 `$acceptances` 是本闸私有的第二套
      豁免机制，没有 trackingIssue、reviewBy 与腐烂校验，故删除。#765 后续裁决「**目标是零豁免**，
      台账只是过渡期手段」后，`exitCriteria`（凭什么能删）与 `reviewBy`（何时再看一眼）平级入账，
      只有日期没有条件的条目会在台账里被单独点名）。
    - **数据层通道（不经台账、无 reason/reviewBy、不进到期台账；「登记即声明」，
      变更只能靠 diff 审阅）**——下列并非穷举：段级 `segments.*.excludes` 同样进
      `∪excludes`（它是变异面自身的定义面），因而同样能让文件退出 `uncoveredSrcFiles`：
      · `testLayers.coverageExcludes`：把文件写进该包的覆盖排除面 ⇒ 该文件退出
        `uncoveredSrcFiles` 质量证据，门禁输出称之为「质量证据改善（--write-baseline
        会清理入库）」。**当前实际在用的是这条**（dsh-mcp-manager / dsh-notifier /
        dsh-provider-usage 均在使用，共 **12** 条），台账里 `gate=verify-dir-imports`
        尚无条目。条目形状与 vitest 面 `coverage.config.json` 的 exclude **同形同键名**：
        `{ pattern, reason, kind }`——`pattern` 带 `!` 前缀，`reason` 不少于 10 字
        （与 `verify-coverage-scope.mjs` 同一下限）。**裸 glob 即判红**：形状不合法由共享
        校验器给出判词，不等 `--check` 的「与派生不一致」误诊，回归用例在
        `scripts/test/mutation-topology-coverage.test.ts`。
        `kind` 是**本面自有值域**（定义在 `scripts/gate/mutation-topology.mjs`），两处
        同名不等于同义：`type-only`（与 vitest 面同义：真无运行时代码——`.d.ts`/`.d.mts`、
        纯类型依赖声明出口）、`not-source`（与 vitest 面同义：src 下的非源码资源）、
        **`facade`（本面增补）**：域门面 `interface.ts`——转译后**可能有运行时代码**
        （装配/卸载转调、re-export），只是本身不做裁决，vitest 面的 `type-only` 不含此义、
        故另立一值）、**`not-mutated`（本面增补）**：是源码、有运行时实现但有意不进变异面。
        同一条 glob 也要按事实拆分：notifier 的 `**/deps.ts` 现为两条——`server/*/deps.ts`
        （7 个纯类型域出口，`type-only`）与 `channels/impl/system/deps.ts`（含值导入与真实
        默认实现，`not-mutated`，是否纳入度量待裁决）。
      · `$noMutationPackages`：该包不进变异面 ⇒ 源码全覆盖断言**不适用**（不是「通过」）。
        该包没有可判定的变异面，登记本身即对该事实的声明（跟踪 #690 S6/S8 / #773，见
        #773 批 B / #710 §2-2）。
    另含 `src ⊆ ∪mutate ∪ ∪excludes` 全覆盖断言（新增 src 未被变异面或排除面覆盖即红）；
    `coverageExcludes` 进的正是该断言的 `∪excludes`，故它同时就是上面那条质量证据通道。
    `$noMutationPackages` 成员**不适用**该断言；其 `dir-imports-baseline.json` 里的
    `uncoveredSrcFiles: []` 是「未登记拓扑时该字段恒为空」造成的已知假绿，不是「已覆盖」的
    证据——判绿输出会显式声明「源码全覆盖断言不适用」，不得读作已验证全覆盖。两处都未登记的包
    仍是 fail-closed；拓扑文件整份缺失或内容非对象时本门禁自身判红（无从判定，输出
    `[topology] 变异拓扑单一事实源缺失` / `…顶层不是对象` 并 exit 1），
    `scripts/test/workflow-assert.test.ts` 的「单一事实源在位」断言保留为冗余兜底，不再是唯一兜底。
    死声明判据为**值面判死、类型面豁免**：`deps.ts` 的 `import type` 是声明即完整性，不参与
    死声明计算（#733 M0a）。**可见度边界**：只管依赖方向与环路，不管符号签名。
  - **导出面门禁（`scripts/gate/export-surface-snapshot.mjs`；#669 PR1 / #733 M0+M2a / N0(B)）**：
    `tsc --declaration` 产物是包对外契约的编译期镜像，固化为入库基线
    `scripts/data/<pkg>-export-surface.json`，重构前后零 diff 即机器证据。粒度两条（**逐入口**）：
    ① 每个入口的顶层导出符号集（name + isType）——增删改导出符号都红；② **每个入口内导出面
    符号的定义块**（该入口前缀所辖全部 `.d.ts` 里、名字在**该入口**导出面的 `export declare ...`
    块，按名过滤后比**块多重集**）——被比对到的块，签名/泛型/联合改写即红；声明块搬去哪个
    文件不影响。**该集合不是「全部声明块」**：打印的总数是全部 `.d.ts` 的顶层声明块数，判据
    比对的只是其中「名字在该入口导出面」的块，两者不要求相等（verbose 分列「当前 / 基线」）。
    **入口模型**（#733 M2c 后续 N0(B)；模型本身即判据，勿读作实现细节）：入口集 = `package.json`
    的 `exports` 中带 `types` 条件的子路径（显式排除 `./package.json` 这类无 `types` 的）；
    `typesTarget(e)` = `exports[e].types` 去掉 `./lib/` 前缀后的**本次 emit 产物**相对路径
    （解析根 = tsc `--declaration` 产物，与是否已 build 无关）；`prefix(e)` = `dirname(typesTarget(e))`，
    每个 emit `.d.ts` 按**最长前缀**归属，**同长度多命中判红**、**未被任何前缀归属判红**（不得
    静默丢弃）；**每入口至少辖 1 个 `.d.ts` / 1 条声明块**、各入口 `typesTarget` **互不相同**，
    否则判红。基线形态 v2（兼容形态，两个既有消费者零改动）：`{ package, exports, declBlocks,
entries }`——兼容字段 `exports` = **主入口**的导出面、`declBlocks` = **全部块的多重集**；
    `entries[e]` = `{ types, exports, blocks: { 名: [块…] } }`（`exports` 取该入口 `typesTarget`
    单文件的导出面，**不是**前缀所辖全部文件的导出名并集——实测 152 ≠ 100）。自洽断言常驻：
    `exports == entries["."].exports`、`declBlocks == 各入口块的多重集并集`（逐条相等，禁止用 Set）。
    **可见度边界（#733 M2c R4 + 独立复核对抗实测，勿读作只有两类）**：
    ① `export interface` / `export type` 无 `declare` 关键字，进不了 ② 的提取器，interface/
    type 体由 `packages/<pkg>/test/integration/consumer-types.test.ts` 的类型体锚兜住；
    ② 不在包导出面的域内符号不参与比对（实测四条门禁 + 包内测试全绿）；
    ③ 导出面里两侧都无定义块的名字被直接跳过（100 个里 32 个，其中 4 个是值符号
    `readBody`/`writeJson`/`errorMessage`/`isLoopbackRequest`，re-export 自 `shared/`）
    ——其签名改动无任何判据覆盖；
    ④ **按名过滤的域内残块**：前缀内但不在该入口导出面的块不参与按名比对——当前实例 =
    `client/locales.d.ts` 的 `en`/`zh`（`./client` 4 块里的 2 块），属 ② 的一个实例而非新增类；
    要覆盖须改为「不按 exports 过滤」（会显著收紧，须另裁决）。
    **同一入口内同名多块的分支当前不构成判据**（实测 `.` 101 块、`./client` 4 块，各自块名无
    重复）；跨入口同名（`apply`/`inject`）各归各入口比对才是 N0(B) 的核心收益——旧实现
    `declMapFor` 的 `Map.set(name, block)` 只留排序末块，改**宿主** `apply` 签名实测 exit=0
    （漏判）、改客户端块才红（归属错误）；F-1（旧 `extractExports` 只读 `index.d.ts` ⇒ `./client`
    入口零判据）同样已修。提取/归属实现抽到 `scripts/lib/surface-extract-lib.ts`（门禁与 fixture
    自测同一实现，§9 禁止双轨）。
  - **新增导出准入（`export-surface-snapshot` 内的分类判据；#733 M2a-3.5）**：目标不变式是
    包导出面 ⊆ 安装面 ∪ 配置面 ∪ 契约面，**当前只对「新增导出」强制**——新导出必须在
    `scripts/data/<pkg>-export-faces.json` 的 `faces` 显式登记三类面之一，未登记判红。
    **存量尚未分类**：dsh-notifier 实测 `faces = {}` / `legacy = 100`，100 个存量符号全走
    `legacy` 白名单（`legacy` 不属三类面之一），存量分类（保留 / 移除清单）是 M2b 的一等
    交付物，本阶段不预判。`legacy` 上**没有**机器判据阻止其增大：`checkExportFaces` 只强制
    「无重复 / 条目必须仍在导出面 / 与 `faces` 互斥」，把新符号塞进 `legacy` 可绕过准入判据
    ——那是一次显眼且可评审的登记文件改动，本判据的价值是让「静默增长」不可能（口径与
    `scripts/lib/export-faces-lib.ts` 的注释同源，可用 `node --input-type=module -e` 直接复现）。
    判据实现 `scripts/lib/export-faces-lib.ts` 被门禁与 fixture 自测复用（§9 禁止双轨）；
    `--snapshot` 只写基线、不碰登记文件，故「更新基线」不会顺手把新符号变成合法导出。
    **判据的论域 = 主入口（`.`）的导出面**：非主入口（如 `./client`）只进导出面快照比对，
    不喂 `checkExportFaces`——客户端入口首次出现独有导出（UI 组件/类型）时无法归入三类面，
    只能塞 `legacy`，与 M2b「legacy 归零」冲突（同写在 ARCHITECTURE-METHOD §6 与门禁自述）。
- **跨包类型可达闭包（`pnpm pack:check` 内；#733 M2a-3.1）**：源面声明了 cordis 声明合并
  （`declare module "@deepseek-ai/cordis"`）⇒ 该合并必须落在 tarball 内 `lib/index.d.ts` 的
  相对 import 闭包内。写在源 `.d.ts` 的合并不会被 emit，消费方按包名导入时服务面与事件面
  全部失类型，而既有门禁都看不见（实证：`packages/dsh-notifier/src/service.d.ts`）；判据
  实现 `scripts/lib/dts-cordis-merge-lib.ts`（含正反 fixture 自测）。
- **`exports[].types` 可解析（`pnpm pack:check` 内；#733 M2c 后续 N9）**：发布物（tarball）
  每个**带 `types` 条件**的导出子路径，其 `types` 必须指向包内真实文件。实证缺陷：
  `exports["./client"].types` 曾写 `./lib/client.d.ts`（实际产出 `lib/client/index.d.ts`），
  严格 TS 消费方按包名子路径导入时静默降级为 `any`（TS7016），而 `pack:check` /
  `contract-check` 都看不见（后者只断言 `exports['./client']` 键存在）。**该缺陷实测存在于
  全部 4 个有客户端的包**（dsh-notifier / dsh-lan-proxy / dsh-mcp-manager /
  dsh-provider-usage），判据面对全部包生效、不留切片。判据实现
  `scripts/lib/exports-types-lib.ts`——与导出面快照门禁**共用**「`exports[].types` → 产物
  相对路径」映射，但**判的是不同产物**（此处判 tarball，门禁判 emit 产物），故不是双轨；
  消费方探针：隔离目录软链 `node_modules/@wingsky-1/<pkg>` → 包目录 + `--strict
--moduleResolution bundler`，四包实测统一为「对照组主入口 exit=0 / 子路径修复前 TS7016 /
  修复后 TS2322」。
- `assertClientSourceContract`（smoke-lib）：兼容三种产物形态（纯净 wrapper /
  React externals / legacy），断言 `"use strict"`、契约外壳、Symbol.toStringTag、
  `factory: function(`、load 注册。
- **插件清单单一来源**（issue #36）：某插件是否参与聚合/发布校验，唯一事实源是
  `scripts/data/plugins-manifest.json`。四个脚本共用 `plugins-manifest-lib.ts` 的目录
  枚举（`isDirectory` 过滤 + 排除聚合包 + 稳定排序）；其中 `aggregate.ts` 与
  `pack-check.ts` 另做「packages/ 目录集 == manifest.active ∪ standalone 集」双向
  相等断言，以及聚合 deps 键集 / patch id 集对 active 的双向相等断言。
  - **新增插件**：建目录后必须同步把目录名加入 `active`（参与聚合的常规插件）
    或 `standalone`（独立发包、不进聚合包，如 demo 演进包），否则全部门禁红
    （opt-in fail-closed 设计：防止半成品目录被自动卷进聚合 patch 与发布管线）；
  - **独立发包插件**（`standalone`）：与 active 同样参与目录登记、pack tarball
    校验与发布管线，但不出现在聚合包 deps 与聚合 cordis.patch.yml 中；
    聚合 deps 误引 standalone 包会被 fail-loud；
  - **退役插件**：删除 packages/ 目录（git 历史保留），并在 `retired` 数组登记
    `{ name, reason, successor }` 档案；
  - `active`/`standalone` 刻意**不自动生成**：它们就是「当前有哪些插件」的人工确认点，
    自动枚举会退回「目录即事实源」的 fail-open 老路；
  - schema 加载/校验逻辑只有一份：`scripts/lib/plugins-manifest-lib.ts`（纯函数，
    入口脚本只喂数据），测试见 `scripts/test/plugins-manifest.test.ts`。
- **复杂度门禁（#722 阶段五）**：`pnpm lint` = ESLint `complexity` + `sonarjs/cognitive-complexity`，
  跑在 `packages/*/src`、`packages/*/test`、`shared`、`scripts` 的手写源码上（秒级）。
  - **工具链隔离**：lint 工具链装在 `tools/lint`（刻意不在 `packages/` 下）——typescript-eslint
    需要 TypeScript 的 compiler API，而仓根 `typescript` 是 tsgo 7.x（无 API，且根 `tsc` 由它
    提供、各包 build/typecheck 依赖它）。pnpm 的子包隔离让 lint 专用的 TS 6 与根 tsgo 共存；
    `scripts/test/lint-toolchain.test.ts` 逐条钉死该前提——隔离一旦被破坏，失败形态是
    「lint 全绿但没在跑规则」或「build 悄悄换了编译器」，两者都不会自己报出来。
  - **阈值唯一事实源**：`scripts/data/gauntlet.config.json` 的 `complexity` 段。起步值 =
    全域实测最大值（cyclomatic 78 / cognitive 84），只拦新增劣化；收紧路线与目标见 issue #732。
  - **与 CRAP 的关系**：`pnpm crap` 的圈复杂度**取自同一条 ESLint 规则**（`Linter` API + 阈值 0
    枚举全部函数），不实现第二份算法——两者是同一事实源的消费方，不存在口径漂移面。
  - **规则面与类型感知（#764）**：非类型感知的 `tseslint.configs.recommended` 打底；三条
    type-checked 规则（`no-floating-promises` / `no-misused-promises` / `await-thenable`）与
    `sonarjs/deprecation` 挂在 `packages/*/src/**`（`parserOptions.projectService`，用 `tools/lint`
    里的真 TS 6）。**该面是刻意的最小面**：类型感知要建 program，成本随文件数走；更要紧的是
    sonarjs 的 typed 规则**缺 program 时静默 `return {}`**（typescript-eslint 的
    `getParserServices` 则会抛错），所以给一条 typed 规则配一个没有 program 的面 = 假绿。
    扩面必须同时给那个面配 `projectService`。
  - **警告预算是硬判据**：阈值在 `gauntlet.config.json` 的 `lint.maxWarnings`（只许降，上调由
    `threshold-monotonic.mjs` 判红）；入口对 `errorCount + warningCount` 求和判定，**读不到预算
    即 fail-closed**。ESLint 自带的 `--max-warnings` 在本仓无效（参数会被入口的参数过滤丢弃）。
  - **存量基线与「只许收缩」棘轮**：`eslint-suppressions.json` 承载已登记为 error 的规则的存量
    （当前只有 `sonarjs/deprecation` 的 52 处 v1→v2 迁移债）。官方 Bulk Suppressions 的两个硬
    约束决定了流程：只有 **error** 级规则会被抑制，且**创建/修剪只能走 CLI**（Node API 只应用）。
    维护动作（两条命令的口径都在这里，别处不再复述）：
    - 收紧：`./tools/lint/node_modules/.bin/eslint --config tools/lint/eslint.config.js --prune-suppressions --suppressions-location eslint-suppressions.json <面>`
    - 新增挂账：把上面的 `--prune-suppressions` 换成 `--suppress-all`（**只给确实要挂账的规则用**，
      它会把该面上所有 error 全量入账）。
    官方只在 CLI 侧检查「不再出现的条目」，Node API 的 `lintFiles` 会把 `unused` 直接丢弃——所以
    `tools/lint/bin/lint.mjs` **自补了这条棘轮**：基线条目数 > 实际被抑制数即判红，并打印可照抄的
    prune 命令。含义是「修掉存量必须同步收缩基线」，基线只能单向下行。
  - **新规则的准入**（#764 A5 决议）：只收**实测零误报**的 correctness 规则，一次不进超过三条；
    `sonarjs` 的非类型感知 problem 面**整体不启用**（实测 242 处命中经逐条复核真问题为 0：门禁脚本
    调 `git`、`=== undefined` 防御判空、测试里的假 `/tmp/` 路径与负例夹具、字符串数组的确定性
    排序……），且那批规则无任何配置项可收窄误报。**升级 `eslint-plugin-sonarjs` 时新增规则默认
    不启用**，须先按上述标准实测（依据：Microsoft .NET warning waves 的 opt-in 语义，
    typescript-eslint 对稳定配置的 semver 承诺——规则增删只在大版本）。
- **本地提交门禁（#722 阶段五，lefthook）**：`pnpm install` 经 `prepare` 自动装钩子。
  - `pre-commit`：`lint-staged` 只把**本次 staged 的源文件**交给 `tools/lint/bin/lint.mjs`，
    秒级；复杂度超阈即拦下本次提交（staged 之外的存量超标函数不影响提交）。
  - `commit-msg`：`commitlint` 校验 Conventional Commits（规则集用官方 `config-conventional`，
    未做自定义放宽——实测与本仓既有提交实践兼容）。
  - **职责边界**：钩子是「提交瞬间的最内层」，不做 build / typecheck / 变异 / 覆盖率，
    **不替代** `gate:changed` / `gate:pr` / `gate:full`（分层口径见根
    [AGENTS.md 门禁矩阵](../AGENTS.md)）。钩子配置见根 `lefthook.yml`。
- **新增/修改客户端后**：`pnpm gate:pr` 全绿再提交（= 全仓 build/test/typecheck + 全仓
  产物闸 + 廉价全仓一致性闸；迭代中用 `pnpm gate:changed`，`gate:full` 在其上另收豁免到期台账。
  分层口径与「改动类型 → 归属层」对照表见根 [AGENTS.md 门禁矩阵](../AGENTS.md)）。

<a id="equivalence-refactor"></a><a id="user-content-equivalence-refactor"></a>

### 4.1 等价重构类改动的验证三件套（#732 / #839）

改脚本、门禁、构建链这类**只搬不改**的重构（抽函数、拆模块、删死代码），判据不是「测试还是绿的」，
而是**能不能证明行为没变**。实测教训：三层常规手段会**同时**漏掉「控制流等价性」类回归
（如状态没复位、分支顺序变了、统一尾部追加被改成逐分支追加）——字面量/对象键的多重集比对看不见
（注释文本与状态不是字面量）、真实仓库上的端到端行为指纹看不见（本仓语料里没有触发形态）、
既有归属用例也可能只覆盖一半形态。#732 清 `scripts/` 面复杂度时就踩到过一次：
`verify-dir-imports.mjs` 的 `stripComments` 引号态复位写错（拿字符串去比对状态对象，恒假），
进入字符串后状态永不复位，**字符串之后出现的注释不再被剥离**——而既有的 F5 与 F5b 两条用例
在当时**都是绿的**（把 bug 种回去实测：F5 pass、F5b pass，补的 F5c 才 fail）。

所以这类改动验收必须凑齐三件，缺一不可：

1. **探针**：把目标阈值临时压到目标口径，**只对目标面跑**、**用完立刻还原**。
   复杂度探针 = `node tools/lint/bin/lint.mjs '<面 glob>'`（如 `'scripts/**/*.{ts,mjs}'`），
   超阈项数按输出里的 error 行**自己数**——命令本身只打印 `error X，warning Y` 汇总行，
   不会打「超阈 N 项 / M 文件」。按面跑是必须的：不带 glob 会把面外存量一起报出来
   （压到 10/15 实测全仓 error 234，其中 `scripts/**` 面 0 条，其余全在 `packages/**` / `shared/` /
   `tools/`，rc=1 属预期，别误判成自己改坏了）。
   探针不是门禁——它临时改的是全局事实源（如 `gauntlet.config.json` 的 complexity 段），
   留在工作区等于把阈值悄悄降了，而且**没有闸会替你发现**：实测把 cyclomatic 从 78 压到 10，
   `threshold-monotonic` 仍 rc=0（它只管覆盖率 / 变异 / lint 警告预算三个维度）。这条单调性
   缺口已立项（#843 的 M3）——在它补齐前，本条「立刻还原」是唯一防线。
   #839 的做法：压到 10/15 → 跑 `scripts/**` 面 → `git checkout --` 该文件，并复核 `git status` 里该文件已干净。
2. **机制性等价性检查器**：把基线版与改动版各自解析成 AST，抽取**字符串 / 模板 / 数字字面量、
   正则、对象字面量键、`process.exit(n)` / `process.exitCode = n`** 的多重集做差集。
   差异只允许两类：**空**，或抽函数**必然**产生的「结构回声」（返回对象与解构参数使同一键计数 +N）。
   后者逐条登记在对照表里并写明理由，**未登记差异一律报红**。
   两个必补的专项：**数字字面量是否整段消失**（防丢上界/阈值）、**新增函数是否零引用**（防抽了不用）。
3. **归属自测 + 被改函数的差分对拍**：先 `grep -rl '<脚本名>' scripts/test/` 找归属用例并全部跑通；
   再对**被改的每个纯函数**做「旧实现（`git show origin/main:<file>` 取原文）vs 新实现、同输入」
   对拍。第 2 件抓不到上面那类控制流回归，只有这一件能抓——它针对的正是**被改的那个函数**。

适用范围：三件套针对**不在覆盖率 / 变异面内**的代码（`scripts/**`、构建链、门禁脚本）——这类改动
的行为等价性没有任何自动信号兜底。重构 `packages/<pkg>/src` 时，CI 的 PR 切片变异（#742 阶段 1）
与 `gate:full --with-coverage` 会免费再给一层信号，但它只证明「判据仍被杀」，不证明判据没被
改弱，所以替代不了第 3 件；包内重构的证据分级与「实验放探针 worktree」纪律见
[dsh-plugin-hub-refactor skill §8](../.dsh/skills/dsh-plugin-hub-refactor/SKILL.md#user-content-8-重构之后的验收复杂度与等价性)，
本节不复述其口径。

三件都过之后，再让 `pnpm gate:pr` 全绿 + CI 绿，并按
[PR 评审 skill](../.dsh/skills/dsh-plugin-hub-pr-review/SKILL.md) 派**上下文独立**的对抗子代理复核一次
（#839 的实践：两个子代理分工不重叠——语义等价性 / 门禁与测试质量；用例规模见 `df68b9b` 提交
信息，本规程不复述它——离了脚本与粒度就不可复跑）。**声称「零行为变更」时，三件的实测输出要
连同 exit code 一起写进 PR 描述**（口径纪律见
[ARCHITECTURE-METHOD.md §10](ARCHITECTURE-METHOD.md#user-content-10-口径与证据纪律)）。

<a id="5-smoke-测试防-flake-纪律"></a><a id="user-content-5-smoke-测试防-flake-纪律"></a>

## 5. Smoke 测试防 flake 纪律

### 5.1 基本要求

- **无网络与零真实凭据**：smoke 测试全部无网络、无真实凭据，本地可直接离线运行。
- **断言全覆盖**：新功能/修复必须带 smoke 断言（含路由 403/405 围栏用例、client 契约断言）。
- **CI 稳定性门槛**：新增 / 修改测试文件后，本地在该包目录内连续跑 **≥10 次**确认无 flake
  再提交，如 `cd packages/<pkg> && for i in $(seq 1 10); do node ../../scripts/test/run-vitest.mjs --min <N>; done`
  （`--min` 取值见该包 `package.json` 的 test script）。

### 5.2 防 flake 核心原则

背景：notifier 的 history 路由测试曾因「多个 `apply()` 实例共享同一 `history.jsonl` +
`appendHistory` 为 fire-and-forget 异步写盘 + 固定 `setTimeout(50)` 后断言『最后一条
为 test』」而 CI 偶发失败（issue #17）。根因是**测试多实例共享全局默认持久化路径、且
依赖异步写盘时序**，与产品逻辑无关。以下纪律用于前置拦截此类 flake。

核心原则：**smoke 测试不得依赖「全局默认持久化路径 + 异步写盘的时序」**。

1. **显式隔离文件路径**：每个测试块必须显式传入 `historyFile` / `persistFile` /
   `storePath` 等，指向 `join(work, "<包>-<块名>.jsonl")` 之类的**唯一临时文件**；
   **禁止多个 `apply()` 实例共享同一文件路径**，尤其禁止依赖 `homedir()` / `DSH_HOME`
   下的默认文件（默认路径是全局单文件，多实例各起一条写链会互相 read-modify-write 竞态）。
2. **测试前置设置 `DSH_HOME` 等环境到临时目录**：所有测试开头
   `process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "<pkg>-"))`，结尾还原（delete 或
   复位原值）。这同时杜绝两件事：① 向真实 `~/.dsh` 写测试数据（污染 + 跨运行状态泄漏）；
   ② 多个测试块 / 运行间共享同一默认文件。**mcp-manager 已如此实践，作为强制基准。**
3. **异步落盘用轮询替代固定 sleep**：断言持久化状态前必须 `poll-until` 满足条件再断言，
   严禁 `setTimeout(resolve, 50 / 300)` 这类「等够毫秒」的时序假设。参考 notifier 的
   `waitForHistory(route, predicate)` 辅助（轮询 GET 直到谓词成立，超时兜底返回当前态）。
   **轮询不得设「轮次预算」**：`for (let i = 0; i < 2000 && !hit; i += 1) await new Promise((r) => setImmediate(r))`
   这类**有界轮次上限**是伪装成轮询的墙钟预算——#771 实测 2000 次 `setImmediate` 只值
   7.3ms 墙钟（3.67µs/轮）：无负载时 21 轮 / 2ms 命中，注入 10ms 的 fs 往返延迟即耗尽 2000 轮，
   断言以 `expected false to be true` 假红，并让 Stryker dry run 整段 `ConfigError`
   （该用例被 12/32 个变异段共用）。等待异步条件必须等**语义终点**：由被测代码在观测点
   兑现的可注入同步点（deferred / barrier），或被测面提供的可等待句柄（`await flushNow()`）。
   确需防挂死时，兜底只能挂在**失败路径**（如与「被测动作自身完成」竞速：窗口没开而动作
   已结束即判红），且不得把兜底当成功判据，也不得用更大轮数 / 更长墙钟「再赌一次」。
4. **e2e 不得以墙钟观察异步行为，必须驱动或注入**：等待异步动作生效（热更新、定时轮询、
   防抖落盘）时，禁止用「轮询墙钟直到断言成立」代替确定性驱动——那只是把 flake 从
   「窗口太小」换成「窗口随负载漂移」。#722 实证：provider-usage e2e 用 6s 窗口等 2s 热更新
   轮询，单跑必绿、与包内其它文件并行必红，红的条目随负载漂移，窗口放大到 20s 亦然。
   正解是语义下沉 unit 层、用公开驱动面确定性驱动（如 `HotReloadableAdapter.pollOnce()`），
   e2e 只断言路由可见效果；需要越过内部接线拿实例时用原型打桩再驱动。
   **不注入更短间隔**：间隔本身仍是墙钟，只是更快撞上同一问题。
5. **测试文件禁止顶层悬挂 promise**：`node --test` 以「模块求值结束」判定文件测试通过，
   悬挂的 `main().catch(...)` 会让体内断言在文件测试判定之后才跑，被整段吞掉（#690 S2 实测：
   注入必然失败的断言仍得 exit 0）。统一写法是顶层 `await main();`。
   **#690 S2c 切默认 per-file 隔离后复查：本约定仍然必要，故保留**——实测把
   `dsh-lan-proxy/test/e2e/smoke.test.ts` 的顶层 `await main();` 改回悬挂形态，per-file 与
   `--test-isolation=none` 两种模式下都是 `pass 1 / fail 0` + exit 0（假绿）。原因是 per-file
   隔离只封堵「顶层 unsettled await」（模块求值永不完成 → node 判 `not ok`），封不住
   fire-and-forget 的异步体（模块求值立即完成 → node 判通过）。唯一例外是经
   `execFileSync` + 退出码/输出标记双重校验的 worker 脚本
   （`test/*.worker.mjs`，不参与 `test/**/*.test.ts` glob）。
   **#722 起测试载体换为 vitest 的 describe/it，文件级判定不再由「模块求值结束」决定，
   本条前提随之消失**；保留为迁移期的实测记录。
6. **fire-and-forget 写入禁止跨块断言顺序**：若写是 `void flush()` / 防抖定时器
   （如 opencode-usage 的 `schedulePersist`、notifier 的 `appendHistory`），绝不能依赖
   「最后一条是 X」「条数 === N」等顺序敏感断言；必须**隔离文件 + 轮询**。理想情况：
   被测插件暴露 `await flushPersist()` 之类的可等待落盘钩子，测试直接 `await` 比轮询更稳。

反例（notifier #17，已修）：多个 `apply(...)` 都传 `historyFile: join(work, "history.jsonl")`
（共享文件）；`await setTimeout(resolve, 50)` 后 `assert.equal(records.at(-1).kind, "test")`。
正例：路由块改用专属 `history-route.jsonl`；落盘用 `waitForHistory` 轮询。

正例（mcp-manager）：设 `DSH_HOME` 到临时目录、每块显式 `storePath: join(dir, "dsh-mcp.json")`、
写盘为 `await writeFile`（已等待）。

<a id="zero-pollution"></a><a id="user-content-zero-pollution"></a>

### 5.3 测试产物零污染纪律（#218）

- **临时落盘隔离**：测试运行时落盘**必须**落在 `mkdtempSync` 隔离目录（`DSH_HOME` 已隔离），
  **禁止**产生任何含 `undefined` 段的路径（如 `packages/*/undefined/**`）；
- **提交前自查**：`git status` 出现 `packages/*/undefined/`、`*.jsonl` 等运行时产物
  一律视为污染，不得提交；自动收集脚本（基线等）只收白名单路径。

<a id="port-handle-discipline"></a><a id="user-content-port-handle-discipline"></a>

### 5.4 端口与残留句柄纪律（#690 S2c）

- **端口一律动态分配**：测试需要监听端口时用 `server.listen(0, ...)`，再从
  `server.address().port` 读实际端口，**禁止写死端口号**——也包括「固定基数 + 随机区间」
  这类写法，窄区间在并发下仍会碰撞。为什么：写死端口只在「严格串行 + 无残留进程」这一
  脆弱前提下成立；实测同一端口被 8 个文件并发持有时 7 个 `EADDRINUSE`，Stryker 并发下
  亦有 19998 互踩的历史记录（#147 / #217）。
  「端口被占 → 启动失败」的**负向用例仍然保留**：先 `listen(0)` 占位拿到端口，再让被测
  对象去绑同一端口——语义不变，只是不再写死端口号。
- **残留句柄在 `finally` 里回收**：测试自己起的 server / socket / 定时器 / watcher 必须在
  用例结束时关闭。per-file 隔离（每个测试文件独立环境）下，未回收的句柄会让**整个包**挂到
  runner 超时才判红，而不是只红那一个文件。

## 6. 多端兼容（三操作系统 + 三访问形态 + 明暗双主题）

dsh web 部署在 Linux 服务器，经局域网被多种设备 / 系统访问。插件（尤其客户端 UI 与
涉及文件 / 命令的宿主逻辑）必须同时满足以下三端兼容要求：

1. **三操作系统（mac / linux / windows）**：插件在三种 OS 下都能正确工作。
   - 路径 / 分隔符一律用 `node:path`（`join` / `sep`），禁止字符串拼接 `/` 或 `\`；
     行尾、大小写敏感路径按 OS 处理。
   - 不写死 OS 专属命令 / 二进制；若必须（如 notifier 的 Windows `toast.ps1`），按 OS
     分支并提供 mac / linux 等价实现或优雅降级，不抛错阻断。
   - 脚本 / 构建不得依赖 POSIX 专属行为（CI 目前仅 ubuntu-latest 单平台，跨 OS
     兼容由本地验证保障；后续可为 CI 增加三 OS matrix）。

2. **三访问形态（PC / pad / phone）**：界面响应式、触控友好、窄屏可用。
   - 布局用响应式（flex / grid + 媒体查询），不写死宽度；触控目标足够大、间距合理。
   - 窄屏（phone / pad 竖屏）下信息不溢出、可滚动、关键操作可达；pad / phone 经局域网
     访问是主要场景之一。

3. **明暗双主题（light / dark）**：**禁止硬编码单一配色**。
   - 颜色统一走 `--dsw-alias-*` / `--dsw-hljs-*` 等实时主题变量 + 浅色回退
     （见 §2.3 / §3），明暗自适应；不要在 CSS / TS 里写死 `#fff` / `rgb(...)` 固定色。
   - 挂载失败只 `console.warn`，绝不让 GUI 启动失败。

验证：客户端交互改动须真机 / 浏览器在**双主题 + 窄屏（pad / phone）**下实测 DOM
（浏览器 DevTools 或浏览器自动化 MCP 均可）；宿主端逻辑须在三 OS 下可运行。
构造的样例 fixture 放仓库外工作区，不纳入发布物。

## 7. 浮窗移动端适配约定（#128，dsh-mcp-manager / dsh-provider-usage）

带浮窗胶囊的插件共用以下跨包约定；判定与 clamp 逻辑以纯函数形式放在各包
`src/placement-math.ts`（零依赖单一事实源：宿主端 re-export 供 smoke 断言、
客户端直接内联），两包保持同构。

1. **断点档位**：判定基准 = conversationHost 的 rect 宽度（JS 判定 + data 属性
   `data-dm-bp` / `data-dou-bp` 切换样式），**不用窗口 @media**——防桌面窄窗 /
   iPad Slide Over 误触发。阈值：narrow ≤480 < tablet ≤834 < wide。
2. **z-index 基准**：单字段 `zIndexBase`（clamp 1–9000），**胶囊与点击后弹出的
   主面板 computed z-index 均取该配置值**（#128 重开维护者要求，不再派生 +30）；
   面板内子浮层（设置卡片等次级层）允许实现侧派生（不占用 zIndexBase 预算）；
   默认 mcp-manager=10、provider-usage=40 与各自 CSS 默认一致。模态管理类
   overlay 不占用该预算。
3. **终坐标视口 clamp（safe-area 语义）**：对算好的 fixed 坐标统一过
   `clampPointToViewport`；宿主 viewport meta 无 `viewport-fit=cover`，
   `env(safe-area-inset-*)` 恒 0 → safeInset 缺省 0 自然退化为普通 clamp。
   禁止改宿主 viewport meta。
4. **软键盘 / 旋转**：`visualViewport` resize 监听跟随键盘弹出收起；
   `orientationchange` 后 rAF 一帧重算（切换瞬间 rect 未更新）。
5. **触控目标分层**：伪元素外扩热区保 WCAG 2.2 AA ≥24px 底线；narrow 档主操作
   min-height 36px + 外扩命中区 ≈44px。悬停态一律包 `@media(hover:hover)`。
6. **滚动性能**：scroll/resize/vv-resize/orientationchange 统一 rAF 合并调度；
   MutationObserver 回调去抖到帧。面板高度用 dvh 级联回退（先 vh 声明再 dvh 覆写）。
7. **offsetY=48 跨包避让契约（源自 issue #116，不可回退）**：mcp-manager 浮窗
   默认 top-right、距顶 8px、高约 26px；provider-usage 胶囊默认 offsetY=48 在其
   正下方让位。任一侧默认锚点 / 垂直偏移的变更都属跨包行为契约变更，两包 README
   与默认值必须联动评估调整。

---

> **隔离环境浏览器验证**：客户端 UI 改动（`packages/*/src/client/**` 等）的隔离环境
> 搭建、浏览器 MCP 核验方法、证据归档与流程契约，统一走
> [`@wingsky-1/dsh-verify-isolated`](../packages/dsh-verify-isolated/README.md) 插件包
> 注册的 `dsh-verify-isolated` skill（临时 `DSH_HOME` + 独立 `verify_<随机>` profile
> 双重隔离，一键脚本自动构建/挂载/启动/清理；安装：
> `dsh plugin --profile web add @wingsky-1/dsh-verify-isolated`）。
