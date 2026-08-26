# 变异测试提速方法论（#220）

> 状态：初稿（随 #220 推进持续更新；关闭 issue 前定稿）。
> 数据口径：GitHub Actions ubuntu-latest（4 核），Stryker 10 + tap-runner，perTest 覆盖分析 + 仓库内增量基线。

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
| 5 | mutate 段拆分 CI matrix（B） | **已落地（#257）** | 段式矩阵真实 CI 实例化正常；wall-clock 数据待段式基线就绪后回收 | 三慢包 provider-usage×2 / lan-proxy×3 / mcp-manager×4；判分聚合去重键教训见 §4.6；计费分钟×N 为已知代价 |
| 6 | 构建产物复用（build-all artifact，D） | 提案待裁定 | — | 只降计费分钟；wall-clock 持平、常态场景略变差（前置串行化） |
| 7 | testFiles 最小集裁剪（C） | 暂缓 | — | per-test 覆盖分析已做关联，剩余空间在大测试文件整体跳过，成本高收益不确定 |

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

## 5. 当前结论与后续候选

- 已完成：常态场景优化到位（§3 #1/#2）；重测高频瓶颈的两大杠杆（并发超订 + 段拆分）均已落地；
- 进行中：段式增量基线首次产出（夜间 observe glob 化后自动覆盖全部段配置）；就绪前段实例 notice 降级全量（慢但正确）；
- 待回收：B 落地后的重测 wall-clock 对比（基线均值 provider-usage 400s / mcp-manager 140s）；provider-usage 升 16 决策；
- 待裁定：D（计费分钟视角）；长期视基线刷新耗时再评估 C。
