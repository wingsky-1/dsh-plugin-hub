# #768 dsh-provider-usage 按域重构收官（ coincident with TOGAF 目标架构 v3）

> 状态：implemented（分支 task/768-refactor，PR #932）。基线 origin/main@2b36ac7e。
> 方法 docs/ARCHITECTURE-METHOD.md；目标 v3 draft-768-target-arch.md + PR #920（4A 图 BA11/AA19/DA12/TA9 边）。
> 本篇守住三件事：为什么是 13 域 + 一叶（往前看）；放弃了哪四条路（往回看）；等价性靠什么证明（证据链）。

## Decision 1：13 域 + server/shared 一叶（层非域），common 消除

- server 下 adapters/history/pipeline/registry（domain1 下移）+ aggregate/collect/execute/schedule（domain2 下移）+ data/report/ui 三路由 + config 新域 + upgrade 单一迁移域 = 13。
- server/shared 只收 errsurf 一叶（Q5 尺子写进文件头：无单一所有者、三域写 + 健康读、无域可收）。per-root 链留 schedule（METHOD §3 Q1 有主即止），file-io 新叶否决。
- 组合根 src/index.ts 为 apply/index.ts 的 211 值 + 71 类型具名薄转发；prepare-lib-entry 覆盖 tsc 产物但同靶等价（build 前后快照双 PASS）。

## Decision 2：upgrade 运行时完全解耦，源码允许纯面复用

- UpgradeDeps = logger + root 解析 + 旧文件显式读面（server/upgrade/deps.ts 纯类型面，零 import）；装配前 await，失败即抛；幂等三条各有集成判据。
- schedule 的 LAST_RUN_SCHEMA/derive/align 经 interface 以 type + pure 复用（非实例调用）；LEGACY 锁表是纯数据值导入（import type 带不动字符串常量，D1 实证）；per-root 链经 deps 注入。
- 回写：PR #920 §2 upgrade 句（1d678dd8）；v3 草稿 L19/L22 旧文“经其写面落盘”以本定义为准。

## Decision 3：门面互消费环 execute⇄schedule 维持 + 豁免（D13 重估注记）

- 环真实存在（executor 取 updateLastRun 值、store 取 parseReportIndexLines 值），双向门面收口，R-A impl 直引为 0。
- 维持理由：updateLastRun 是活引用临界区（注入需改 DueExecutorDeps 公共类型），纯解析方向是既立合法形态；单向化成本大于收益。豁免带 trackingIssue #768 + D13 重估注记。
- 翻转条件：任一方向出现第二条值边，或 scheduler 需要 execute 实例能力时，重估单向注入。

## Rejected（放弃的路，不重走）

- B 独立 schedule 小域 / C 门面不动目录 / routes 沿 mcp 含混名 / common 改名 util：见 unified-spec 否决理由（单文件域、结构债残留、改名一次付清、换名不改兜底）。
- S1-B 曾议 A（包侧先加 src/index.ts）/ C（基线递延 D13）：A 纠缠构建链 + 公共 API 面，C 丢失等价前件；选 B（门禁侧入口别名，D13 删除重冻，防腐 A/B 实证 exit 1/0）。
- D13 曾议删 v1 公共面 40 弃用：仍导出 + unit-v1 测试在，删 = 公共 API 行为变更，须红线另议，保留。

## Equivalence（等价证据链，行为零变更 + 两处单列例外）

- A 级差分：normalize 全分支、转录 16 常量块（首轮抓 V4 月报多 1 行错，已修正重绿）。
- B 级定向变异：fail-fast 8 形状、双启用单文件 2 红、净化摘除恰 4 红（主控亲证 4 红/10 绿）、悬挂四重、去 clearInterval 精准 1 红。
- C 级只读论证 + 基线逐条对账：改名面先对账后差分；导出面 282 符号/323 块零漂移。
- 单列例外：①history 段名 .. 穿透收敛（真漏洞，低危，随行合入）；②e2e 默认挂载断言改空形除外（S3 语义直接后果）。
- 冻结：store 多错语义（另立行为评审）；resolveCwd/性能预留延期未验证（owner collect/aggregate）。

## Metrics（收官读数，事实源为准）

| 面 | 基线 | 收官 | 口径 |
|---|---|---|---|
| 测试文件 | 26 | 34（--min34 精确对应） | run-vitest 收集数 |
| 断言 | — | 3106 全绿 | 包全套 |
| 门禁 | — | gate:pr 40/40 PASS（本地；CI 变异待判） | gate |
| 环/直引 | 叶环 1/文件环 1 | 0/0（门面环豁免 1） | verify-dir-imports |
| 导出面 | 282 符号 | 282 符号/323 块，零漂移 | export-surface |
| 变异面 | — | 293 命中 firing 文件，并集无收缩 | gen-stryker-conf |
| 覆盖率面 | — | 273 keys 缺失 0 | coverage-scope |
| lint | — | 0 错/190 warn（预算 215） | lint |
| homedir 接缝 | — | 新增零直调 | forbid-homedir |
| src 跟踪文件 | 75 | 103 | ls-files |
| domain2/common | 存在 | 目录消失，directImpl 0 | ls + 门禁 |

## Debt（遗留技术债务，带 owner 与退出条件）

| # | 债务 | owner | 退出条件 |
|---|---|---|---|
| 1 | 门面环 execute⇄schedule 豁免长期化 | #768 后续 | 任一方向第二值边出现即重估单向注入 |
| 2 | v1 公共面 40 弃用保留 | 红线评审 | 另立行为评审删（unit-v1 同步） |
| 3 | resolveCwd 运行时裁决 + 性能预留 | collect/aggregate | 观测后二选一（收敛/保留），标未验证消除 |
| 4 | warmup 仅文本级钉住 | 后续 | fake timer + spy 行为断言补到 B 级 |
| 5 | export-surface JSON 键序噪音（~340 行） | 工具 | 冻结脚本稳定键序 |
| 6 | schedule dispose 假时钟 flake | #929 | 最小复现 + 修同步点/隔离标记 |
| 7 | prepare-lib-entry 覆盖 tsc 产物冗余 | 构建链 | 入口面统一后删生成转发 |
| 8 | v3 草稿 L19/L22 旧文与实现定义并存 | 文档 | PR #920 正文即新定义，草稿归档 |

## Docs（文档治理：与实现同波次同步）

- 包内 docs：layer-architecture.md + refactor-implementation-plan.md 每提交同步；adapter-guide.md + architecture.md 路径同步； scattering 无。
- 架构总览：4A 图分支 task/768-diagrams（同源导出）；目标正文 PR #920 + 0-1 回写（1d678dd8）。
- 散文段数：gauntlet 12→13 与 topology segments 集合一致（prose-counts 门禁绿）。
- 本篇为 #768 实施期唯一新增 note；无重叠旧篇（已审计 proposed/implemented/rejected，无 768 归属篇）。
