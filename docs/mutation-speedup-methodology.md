# 变异测试提速方法论（#220 · #276 方案 A）

> 状态：定稿（#276 方案 A 全量落地后最终更新）。
> 数据口径：GitHub Actions ubuntu-latest（4 核），Stryker 10 + tap-runner，perTest 覆盖分析 + 仓库内增量基线。Node 24+。

## 1. 背景与指标口径

变异测试门禁的耗时优化必须先分清三个指标——**混用会导致错误决策**：

| 指标 | 定义 | 本仓现状 |
|---|---|---|
| PR wall-clock | PR CI 最慢链路时长 | 常态（增量基线命中）mutation job 20-38s；失效重测长尾 290-339s |
| Runner 计费分钟 | 所有 job 时长之和 | 每个 mutation matrix job 各付一份 install+build 固定成本（最多 6 份/PR） |
| 增量命中率 | 跳过的 mutant / 总 mutant | 由 #204/#178 增量基线决定，是常态耗时的主导项 |

关键教训：**优化手段只作用于特定指标与特定场景**。例如构建产物复用（D）降计费分钟但对 wall-clock 无贡献；并发超订对等待主导型测试收益巨大、对 CPU 密集型收益有限。

## 2. 场景切分：常态 vs 重测

| 场景 | 触发条件 | 耗时构成 | 优化杠杆 |
|---|---|---|---|
| 常态 | PR 未触及包的 mutate 面 | install+build 占大头（20-38s） | 已足够快，不值得再投入 |
| 基线失效重测 | 源码改动使 mutant 基线失效 | stryker 本体占大头 | 并发超订、mutate 段拆分 |

**重测不是低频长尾**（2026-08-26 全量统计，近 66 个成功 PR run / 191 个 mutation job）：
整体 p50=56s、p90=517s、max=803s，**超 2min 占 37%（70/191）**。按包均值：
provider-usage **400s**（n=49，频率与耗时双高）、lan-proxy 204s、mcp-manager 140s
（已 16 并发仍如此 → 瓶颈在 4 段大 mutate 面而非并发数）、notifier 75s、idle-archive 44s、web-file-preview 42s。
活跃开发中的包高频处于重测态，「长尾」实为这些包的常态。

## 3. 手段清单与实测记录

| # | 手段 | 状态 | 实测效果 | 关键约束 |
|---|---|---|---|---|
| 1 | 增量基线仓库内文件化（#204/#178） | 已落地 | 常态 mutation job 分钟级 → **20-38s 全程** | actions/cache 按 ref 隔离不可用；基线必须入 git |
| 2 | concurrency 超订（notifier 先例 #159） | 已落地（16×3 包） | notifier **6m54s → 1m42s** | 仅等待主导型收益巨大；见 §4.2 分级评估法 |
| 3 | provider-usage 4→8（#249）+ timeoutMS 60s→30s（#257） | 已落地 | 同机基准 4→8 提速 **42%**（771.9s→449.9s），score/killed 与独立全量逐项一致；CI 首跑无假阳性 | 收紧只减假阳性 killed，方向安全；升 16 待 CI 自然场景数据 |
| 4 | lan-proxy / idle-archive 维持 4 | 决策维持 | — | #147 端口互踩实证 / testFiles 含固定端口 smoke.ts |
| 5 | mutate 段拆分 CI matrix（B） | **已落地（#257）→ 方案 A 落地后整体退役（#276）** | 段式矩阵真实 CI 实例化正常；wall-clock 数据待段式基线就绪后回收 | 三慢包 provider-usage×2 / lan-proxy×3 / mcp-manager×4；判分聚合去重键教训见 §4.6；计费分钟×N 为已知代价。方案 A 落地后 mutate 改为 src 级文件组分段（mcp-manager×3 / provider-usage×3 / lan-proxy×4），行号区间整套退役 |
| 6 | 构建产物复用（build-all artifact，D） | **否决（维护者裁定）** | — | 收益模型失效：本仓为 PUBLIC，GitHub Actions 对公共仓库免费不限时长，「降计费分钟」不适用；剩余次要价值撑不起 ci.yml 改造面与红线流程。教训见 §4.7 |
| 7 | testFiles 最小集裁剪（C） | 暂缓 | — | per-test 覆盖分析已做关联，剩余空间在大测试文件整体跳过，成本高收益不确定 |
| 8 | **方案 A：mutate 直指 src（#276）** | **已落地** | 见 §3.1 详细实测 | 依赖全仓 `.ts` 后缀相对 import + Node strip-types 加载插桩 src；开销与对策见 §4.8 |
| 9 | Node compile cache（#276 配套） | 已落地（bridge 注入） | src 级全量 420s → 250s（-41%），判分分布不变 | Node ≥24.12 `module.enableCompileCache()`；失败的进程静默降级（try/catch 包裹） |
| 10 | 大文件拆分（src 级分段前置） | 已落地 | mcp-manager index 1237→147 / middleware 1046→511 / provider-usage index 1122→73 / lan-proxy index 991→59 | 分段粒度下限是整文件；拆文件让密度均匀、段可细切。维护收益 + CRAP 模块精度 |
| 11 | src 级两级分段（文件组声明） | 已落地 | mcp-manager×3 / provider-usage×3 / lan-proxy×4 段，单段 wall ≤~120s | 段 = 源文件名清单（非行号），永不漂移，无 sync/guard 开销 |
| 12 | 四班次调度 + 快照 PR 日期闸（#276 配套） | 已落地 | 基线快照 PR 有界（≤4/日，实际随当日合入） | observe.yml cron UTC 01/04/08/12（北京 09/12/16/20）；push 触发移除；snapshot PR 每日最多一次 |

### 3.1 方案 A 实测记录（#276，同机同口径、冷缓存全量、每侧 ≥2 轮）

| 配置 | 现状（lib 段拆分 ×N） | 方案 A（src 全量单 conf） | 倍率 |
|---|---|---|---|
| 无 compile cache | 279s / 293s（两轮） | 417s / 422s（两轮） | ×1.47 |
| **双方启用 compile cache** | **228s** | **250s** | **×1.10** |

- ×1.10 ≤ 预注册达标线 ×1.25 → 判定 **go**；
- 等价性：killed+timeout A=1340（两轮分布一致）、基线=1316，killed/总数 31.8% vs 31.7% 容差内——compile cache 只省加载、不碰判分；
- 首轮 spike（2026-08-26）曾判 no-go（×1.47），引入业界对策（Node compile cache，nodejs/node#56629）后复测翻转——**预注册判据的意义在于防止事后挪门柱，而非拒绝新增技术变量**；
- 本次实测证明：src 级 vs bundle 级的每 mutant 开销差（+51%）**主因是 sandbox 内 TS 转译加载的重复成本**，compile cache 吃掉了绝大部分（-41%）。

### 3.2 原文件拆分实测（src 级分段前置）

| 文件 | 拆分前 | 拆分后 | 拆分产物 |
|---|---|---|---|
| mcp-manager index.ts | 1237 行 | 147 行 | normalize / config-schema / manager / apply（#286 四步） |
| mcp-manager middleware.ts | 1046 行 | 511 行 | middleware-const / -utils / -state / -register / -types |
| provider-usage index.ts | 1122 行 | 73 行 | config / ui-config / user-adapters / apply |
| lan-proxy index.ts | 991 行 | 59 行 | config / settings / migrate / config-routes / apply |

全部「导出面零破坏」（index 保留 re-export + apply 契约），每步独立 commit、五连门禁全绿。

## 4. 方法论：如何评估下一个提速手段

### 4.1 收益窗口分析（先算账再动手）

1. 定位目标场景（常态 or 长尾）与其耗时构成（固定成本 or stryker 本体）；
2. 区分目标指标（wall-clock or 计费分钟），写出改前/改后公式：
   - 并行矩阵下 wall-clock ≈ max(各 job) = 固定成本 + 最慢本体；
   - 前置串行化后 wall-clock ≈ Σ串行段 + 本体；
   - 计费分钟 ≈ N × (固定成本 + 本体/N)；
3. 用真实 run 的 job 时间戳代入公式验证方向，警惕「并行收益」与「串行代价」互相抵消。

### 4.2 并发超订分级评估法

按 testFiles 的资源形态分三级：

- **可直升 16**：纯 unit、无端口绑定、无全局单例、非 CPU 密集（如 web-file-preview）；
- **先 8 观察**：CPU 密集为主但无共享资源冲突（如 provider-usage——apiEndpoint 用 discard 端口、socket 为 mock 字面量）；达标后再升；
- **维持低并发**：testFiles 存在真实固定端口监听（lan-proxy #147 实证 19998 互踩 → EADDRINUSE 假阳性 Killed）或固定端口 smoke 文件（idle-archive）。

### 4.3 假阳性防护：timeout 计入 detected 的陷阱

Stryker 将 timeout 计入 detected，高并发导致调度延迟时边际 mutant 可能从「存活」误判为「timeout 杀灭」，**虚增 score 掩盖真存活 mutant**。任何提并发的变更必须核对：

- [ ] total mutant 数不变；
- [ ] timeout / error 计数无异常抬升；
- [ ] score 与基线口径一致。

（lan-proxy `timeoutMS=15000` 的敏感性为前车之鉴：放宽到 60s 曾使总时长冲到 15 分钟以上。）

### 4.4 纯配置改动不触发变异切片

paths-filter 只匹配 `packages/<pkg>/**` 与全局路径，`stryker.conf.d/**` 改动不会实例化 mutation-gate——此类 PR 的效果验证顺延至下一个触及对应包源码的 PR（#249 即此情形，须在 issue 台账显式标注「待首跑验证」，防止误读为已验证）。

### 4.5 红线与流程约束

触 `.github/` workflow 的手段（B/D）走 needs-proposal-review 流程；纯 `stryker.conf.d` 调整可直接 PR。所有手段的效果数据回填 issue 台账，关闭前沉淀为本文档。

### 4.6 跨报告聚合：mutant id 是报告内序号（#257 首跑实证）

把 mutate 面拆成多份配置后，同包多份 Stryker JSON 报告聚合判分时**严禁用 mutant.id 做去重键**——id 是每份报告独立生成的全局序号（实证 seg1 的 "434" 与 seg2 的 "213" 毫无对应），按 id 去重会把跨段不同 mutant 误合并、冲突保守取值再二次压分，分数被打到假低（首跑 53.52/50.1/41.75 全红）。

正确做法：以「源文件路径 + 完整位置（start/end line+column）+ mutatorName + replacement」为键。修复后在真实报告上验证的三个交叉证据：

1. 三包真实聚合 64.82/63.67/64.37 全部回到阈值之上；
2. covered 计数与独立同机全量基准逐项吻合（K1440/T36/S801）；
3. 重叠区间 147 对同位置 mutant 状态冲突 0。

配套纪律：契约测试锁定 conf 文件集 ↔ jsonReporter/incrementalFile 命名 ↔ gauntlet 包集三方一致；期望段数由 conf 目录推导，缺任一段报告 exit 2 fail-closed。

### 4.7 成本模型先核实：公共仓库 Actions 免费

D 方案从「提案待裁定」到「否决」的根因不是工程问题，而是**收益模型前提失效**：「降计费分钟」仅对私有仓库成立（GitHub 托管 runner 按分钟计费），本仓 PUBLIC 完全免费。教训：评估任何成本节约型手段前，先核实本仓形态下该成本是否真实存在；对公共仓库，runner 分钟类优化一律不构成收益项。

### 4.8 src 级变异（方案 A）的实施条件与开销对策

**可行性条件**（缺一不可）：
1. 全仓相对 import 统一 `.ts` 后缀 + tsconfig `rewriteRelativeImportExtensions`（源码写 `.ts`，emit 自动回写 `.js`）；
2. **d.ts 不回写是上游行为**（TS 5.9/7.x 实测）：`rewriteRelativeImportExtensions` 只回写 JS emit，声明文件仍带 `.ts`——需构建期修正（本仓在 bundle-host d.ts X1 改写处统一处理）；
3. 全 src 必须**可擦除语法**（`--erasableSyntaxOnly` 通过）：Node strip-only 模式拒绝 enum / namespace / 构造器参数属性等非可擦除语法（provider-usage hotreload.ts 实证踩坑）；
4. 变异测试必须**直连 src 入口**（插桩代码由测试加载）：测试从 `import ../lib/index.js` 改为 `../src/index.ts`；smoke/契约保持 lib 口径（双轨，cov/crap 不受影响）。

**开销与对策**：
- src 级每 mutant 开销比 bundle 高 ~50%（sandbox 内 TS 转译加载）；`enableCompileCache()`（Node ≥24.12，bridge `-r` 注入）实测 -41%，把倍率从 ×1.47 压到 ×1.10；
- Stryker CLI 的 `-c` 是 `--concurrency` 短旗标，conf 文件必须用**位置参数**传入（`npx stryker run <conf>`）；
- incremental 文件会让二轮对照测量失真（每段数秒假象），对照测量前须清理或 `--force`；
- 分段声明用源文件名清单（永不漂移），sync/guard/行号机器派生整套退役。

### 4.9 两级分段设计（包 → 文件组）

- 一级 = 插件包（monorepo 天然边界，PR 变动包映射第一级，业界同款——StrykerJS 官方仓库自身即按 scope 分 job）；
- 二级 = 包内源文件名清单，按 mutant 密度均衡（不按目录硬切：密度不均；不做动态 round-robin：PR 变动段映射需要文件→段静态归属）；
- 段数在「单段 wall-clock ≤~120s」约束下取最少段数（每 conf 有 ~15-20s 启动+dryRun 开销）；体量小的包单段即可；
- 单文件 mutant 数超段目标时**先拆文件再声明分段**（拆的动机排序：可维护性 > CRAP 精度 > 变异均衡，阈值 ≳1000 行且多职责）。

## 5. 当前结论与后续候选

- 已完成：常态场景优化到位（§3 #1/#2）；重测高频瓶颈的两大杠杆（并发超订 + 段拆分）均已落地；**方案 A（mutate 直指 src）全量落地**——src 级文件组分段替代产物行号矩阵，配合 compile cache 与四班次调度；
- 已退役：mutate 段拆分 CI matrix（产物行号区间）、sync-mutate-segments、mutate-scope-guard（F5）、mutation-segments.json——漂移治理整套随方案 A 删除；
- 已落地调度：observe 四班次全量（北京 09/12/16/20）+ 快照 PR 每日最多一次日期闸（git 膨胀有界化）；
- 待 observe 首轮四班次运行后回收：新 src 口径基线的增量命中率、PR 门禁常态 wall-clock（预期不劣于旧口径，因 src 位置键位移更小）；
- 长期候选：若四班次全量仍偏慢，可评估 c8 增量覆盖或按文件更细分段。
