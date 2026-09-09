# dsh-provider-usage 分层重构实施计划（契约基线 v4 · 双专家评审合并版）

> 状态：**已定稿待实施**。本文件是「现状 → 目标架构」重构的实施方案唯一事实源。
> 输入：`layer-architecture.md`（分层模型 + 契约基线）+ 两图 JSON 快照 + 两轮独立对抗评审
> （首轮 D1-D8 方案评审；次轮微服务专家 + 资深架构师双视角评审，必改 8 项全部并入）。
> 实施跟踪：issue（编号见文末，各阶段 PR 关联之）。
> 红线：只在 worktree 内改代码/跑门禁；主 checkout 保持干净；方案已获用户认可。

---

## 1. 契约基线 v4（实施契约基线）

- **`layer-architecture.md §2` 契约表全表 = 实施基线**（行号锚已抽查 100% 吻合）。
- **符号锚约定（D14）**：契约引用一律以「文件 · 符号」为准；行号仅作为基线快照
  `e64f859` 的证据注释（重构后必然漂移，不再具约束力）。
- 层间裁定要点：
  - C1 物理目录 = `shared/`（契约/图表/配置/净化/双端共享底座）；散层三文件维持不拆子目录
  - C2 registry 是公开管理对象，路由为合法下游，判断面（getEntry/hasCandidates）不收口
  - C3 StatsService 门面不暴露 cache/panelCache 写操作（D7 整体下沉 + generation 失效 + per-key 单飞）
  - C4 纯存储，直读合法
  - C5 retention 死字段删除（收尾阶段，同步删 adapter-guide/README.en 文档示例）
  - C6 面板缓存四段语义整体下沉为 `StatsService.getPanelResult`；registry/history 直读保留
  - E3⇄E4 双向静态依赖 → **共同依赖域2公共层**（`domain2/common/last-run.ts`、`report-index.ts`，无状态无缓存）
  - E4 executor 独立工厂文件，错误脱敏为工厂契约字段
  - E5 /events SSE 死面文档化保留（backlog）
- 死面清理（收尾独立 PR）：`contracts.ts:108` retention、`capsuleHtmlFromHistory`（v2.ts:175，
  实现坏：读 history.last 弃结果只用 fallbackText；连带 index.ts re-export 与 unit-contract 用例；
  **先留 deprecated shim 一个版本周期再删**）。

---

## 2. 阶段方案（阶段零 → 收尾）

| 阶段 | 内容 | 时长 | 验证/门禁 |
|---|---|---|---|
| **阶段零** 变异网前置 | mutation-topology.json 补 testFiles（unit-trend/unit-report/unit-trend-view 进杀灭面）+ 增段（stats-service；trend 纯逻辑段先行）→ gen-stryker-conf 生成 → 夜间重建基线 | 2-3 天 | 变异观察（observe 夜间硬校验）成为后续重构安全网 |
| **阶段一** D7 行为等价收口 | 面板缓存整体下沉（getPanelResult：key 归一 → stale 判定 → miss 删除 → 管道 → 失败不写）+ **generation 失效**（purgeAllCaches 防在途旧结果污染）+ **per-key 单飞**（同 key 并发 miss 不双跑 formatPanel）+ smoke S1 扩展（失败不写/purge 后 miss/select×在途交错） | S（0.5-1 天） | TDD + 全量门禁；**不含死面删除** |
| **阶段二** D8 + 报告面收敛 | executor 独立工厂（`domain2/execute/executor.ts`，脱敏入契约）+ `domain2/common/`（last-run/report-index 移入，无状态无缓存防 indexCache 双份）+ **ReportConfigService**（reportCfg 双源收口，复用 updateLastRun 的 per-root 串行链，<50 行）+ listDirs 闭包收敛 + unit-report 断言迁移 | M（1 天） | TDD + 全量门禁 + 模型文档更新 |
| **阶段三** 护栏 + 拆分 | R8 四不变量断言（真缺口=记账守恒 Σ事件==buckets==agg==dirRows+unidentified，事件回放式端到端断言，入 testFiles）→ aggregator 拆分（纯函数提取；Stryker 文件粒度限制，独立段 5-8 分钟）→ 域2每层错误面 + /health per-layer（可选）→ 崩溃注入冒烟（可选） | M（2-3 天） | 全量门禁 + 变异（阶段零基线生效） |
| **阶段四** 目录化 | 两级「先域再层」目录 + interface.ts 最小面导出 + verify-docs 扩展（符号存在性硬校验 + 跨目录直引软报告）+ 契约表符号锚迁移 + **产物等价性 diff 验收**（重构前后 lib/index.js diff 仅 import 路径）+ AI 可导航性前后对比（修复典型 bug 打开文件数） | L（3-5 天） | 全量门禁 + 等价性 diff 证据 |
| **收尾** 死面清理 | capsuleHtmlFromHistory deprecated shim → 删除；retention 删除 + 文档示例同步（adapter-guide.md:173 / README.en.md:304） | S | 独立 PR，全量门禁 |

- 估算：对外 **8-12 天**（内部 1.5-2×）；变异基线重建/评审往返/文档同步独立列项。
- 客户端视图拆分：**本轮明确不做**（backlog）。
- 每阶段门禁：`pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck` + smoke；
  变异夜间硬校验（阶段零后全面生效）。

### 2.1 测试分层策略（D17，四层）

| 层 | 形态 | 目标 | 组织 |
|---|---|---|---|
| **L1 层内单元测试** | 单层内部文件/类/函数 | 层内逻辑正确（状态机/纯函数/IO 隔离） | 测试目录与源码目录**镜像 1:1**：`test/unit/<layer>/` 对齐 `src/<domain>/<layer>/`；每阶段随源码触碰同步迁移/补齐 |
| **L2 interface 测试（层间契约）** | 每目录 `interface.ts` ↔ 对应 `interface.test.ts` | **层间稳定性**：导出符号清单稳定性（显式清单断言，防意外增删）+ 关键契约行为（StatsService.getPanelResult 命中/miss/失败不写；executor 工厂幂等/脱敏；scheduler tick；TrendTracker 查询面） | `test/interface/<layer>.test.ts`；import 边界断言并入 verify-docs（符号存在性硬校验 + 跨目录直引软报告） |
| **L3 集成测试（user case）** | 基于真实用户场景的端到端断言（复用 smoke 拉起机制 helpers.ts） | 整体功能正确（UC 全链路） | `test/integration/uc-<n>-<name>.test.ts`，按 UC 分组：UC1 适配器管理（候选/切换/清空/添加/热更）· UC2 拉取+胶囊（fresh/cached/stale 降级+注入）· UC3 历史面板（查询/缓存命中/append 全清）· UC4 趋势视图（事件→聚合→目录面/提供者面）· UC5 报告闭环（配置/调度/手动生成/幂等/失败不推进 lastRun/状态轮询）· UC6 系统面（health/ui-config/loopback 403/405/生命周期清理） |
| **L4 变异测试分层** | Stryker 段定义与**层对齐**（mutation-topology.json segments 随目录化演进） | 每层杀灭面 = 该层 unit + interface 测试；threshold 60 per 段 | 阶段零：按现有文件组 + 新段（trend/report/routes/stats-service）分层；阶段四目录化后 segments 与目录对齐（gen-stryker-conf 由 SSOT 生成） |

- 测试纪律保持：smoke 全部离线无网络；临时 DSH_HOME 隔离；落盘 mkdtemp；smoke 仍为全链路冒烟壳。
- 阶段交付约定：**每个阶段 = 源码改动 + L1/L2 同步交付 + L3 关联 UC 补强 + L4 段更新**，缺一不可入 PR。

---

## 3. 决策表（D1-D16 最终裁定）

| # | 决策项 | 最终裁定 |
|---|---|---|
| D-1 | C2 六文件拆分 | 维持（并入 registry/ 目录） |
| D-2 | aggregator 1177 行拆分 | **拆**（R8 守恒断言 + 阶段零变异网双重前置） |
| D-3 | C3 编排/管道/守卫 | 维持 |
| D-4 | SSE /events 死面 | 文档化保留（backlog） |
| D-5 | contracts/charts 共享 | 物理化 = `shared/`（C1 底座目录） |
| D-6 | 客户端分层 | 分域保留；**客户端拆分本轮不做**（D15） |
| D-7 | StatsService 缓存收口 | **做**：整体下沉 + generation 失效 + per-key 单飞 |
| D-8 | executor 收敛 E4 | **做**：独立工厂 + common 归位 + 报告面组合收敛 |
| D-9 | 目录化 + interface.ts | **做**：两级域→层 + 最小面导出；门禁降级 verify-docs 软/硬组合 |
| D-10 | 文件瘦身 | **做**（~400 观察/>600 必裁定；客户端除外） |
| D-11 | 注释清理 | **做**（触碰面同步；删废话/过时/重复，保留 why 与 issue 关联） |
| D-12 | 变异网阶段零前置 | **做**（安全网先于重构） |
| D-13 | 死面清理独立收尾 PR | **做**（deprecated shim 一版） |
| D-14 | 契约表符号锚 | **做**（行号降为基线证据注释） |
| D-15 | 客户端拆分范围 | 本轮不做（backlog） |
| D-16 | 对外估算 | 8-12 天，内部 1.5-2× |
| D-17 | **测试分层** | **做**：L1 层内单元 + L2 interface 契约（层间稳定性）+ L3 user-case 集成（UC1-UC6 全链路）+ L4 变异按层分段（per-layer testFiles，threshold 60） |

---

## 4. 目标目录树（两级 · 先域再层）

```text
src/
  shared/                          # C1 契约/工具层 = 共享底座（双端构建共用；interface.ts 即 C1 门面）
    interface.ts contracts.ts charts.ts config.ts sanitize.ts ui-config.ts client-logic.ts placement-math.ts
  domain1/                         # 域1 · 适配器取数与胶囊展示框架
    registry/   interface.ts + registry/user-adapters/user-adapter-loader/hotreload/provider-config/path-resolve
    pipeline/   interface.ts + stats-service/v2/guards          # StatsService 门面：不暴露 cache/panelCache 写操作
    history/    interface.ts + history
    adapters/   interface.ts（薄）+ deepseek-official/opencode-go/zai-coding-cn（.mjs + .d.mts）
    routes/     interface.ts + stats/adapters                   # C6 路由层（宿主）
  domain2/                         # 域2 · 事件监听 · 趋势与报告框架
    collect/    interface.ts + collector/types                  # E1
    aggregate/  interface.ts + aggregator/store/index           # E2
    common/     interface.ts + last-run.ts + report-index.ts    # 域2公共层：无状态无缓存（新增）
    schedule/   interface.ts + config/schedule/scheduler/tasks + prompts.ts   # E3
    execute/    interface.ts + runner/generate/format + executor.ts           # E4（executor.ts 为 D8 产物）
    routes/     interface.ts + ui/reports                       # E5 路由层（宿主）
  apply/                           # 装配层（组合根特权；零隐藏可变状态）
    interface.ts + apply/index/hotreload-manager/timers/lifecycle + report-config-service.ts
  client/                          # 客户端（本轮不改；双端共享经 shared/ 源码 import）
```

## 5. 现有文件 → 目标目录全量映射表（35 文件）

| 目标目录 | 迁入文件 |
|---|---|
| shared/ | contracts.ts、charts.ts、config.ts、sanitize.ts、ui-config.ts、client-logic.ts、placement-math.ts |
| domain1/registry/ | registry.ts、user-adapters.ts、user-adapter-loader.ts、hotreload.ts、provider-config.ts、path-resolve.ts |
| domain1/pipeline/ | stats-service.ts、pipeline/v2.ts、core/guards.ts |
| domain1/history/ | core/history.ts |
| domain1/adapters/ | adapters/deepseek-official.{mjs,d.mts}、opencode-go.{mjs,d.mts}、zai-coding-cn.{mjs,d.mts} |
| domain1/routes/ | routes/stats.ts、routes/adapters.ts |
| domain2/collect/ | trend/collector.ts、trend/types.ts |
| domain2/aggregate/ | trend/aggregator.ts、trend/store.ts、trend/index.ts |
| domain2/common/（新增） | last-run.ts（自 scheduler.ts 移出）、report-index.ts（自 runner.ts 移出） |
| domain2/schedule/ | report/config.ts、report/schedule.ts、report/scheduler.ts、report/tasks.ts + prompts.ts（拆 DEFAULT_PROMPTS） |
| domain2/execute/ | report/runner.ts、report/generate.ts、report/format.ts + executor.ts（自 apply.ts 闭包移出） |
| domain2/routes/ | routes/ui.ts、routes/reports.ts |
| apply/ | apply.ts、index.ts + hotreload-manager/timers/lifecycle（拆）+ report-config-service.ts（新增） |
| client/ | 不动 |

## 6. 跨域/跨层引用完整清单（实证，供 verify-docs 软报告与目录化核对）

- 域2→共享底座：5 处 charts（aggregator:16 / index:12 / format:14 / runner:8 / schedule:13）+ sanitize + ui-config（ui.ts:12）
- 域2→域1：1 处 `ui.ts:9` StatsService（type-only；D7 后仅类型 + cacheSize() 方法调用）
- 域2 内部跨层：6 处（config:17→types / generate:28-29 / runner:9-11→aggregate+types）
- 域1→域2：**零**（业务面零依赖实证成立）

---

## 7. 双专家评审结论（已并入本计划）

### 必改 8 项（合并去重）
1. purge/clear 与在途 getStats 竞态 → generation 失效（阶段一）
2. getPanelResult 同 key 并发 → per-key 单飞（阶段一）
3. 死面清理移出阶段一 → 独立收尾 PR + deprecated shim（D13）
4. 变异网前置阶段零（安全网先于重构）（D12）
5. charts 等共享归 shared/ 底座（C1 = shared/，D5）
6. 契约表行号锚 → 符号锚（D14）
7. apply 拆分补报告面组合收敛（ReportConfigService + listDirs 收敛，零隐藏可变状态）
8. 估算修正 1.5-2×（对外 8-12 天，D16）

### 冲突裁决
| 冲突点 | 裁决 |
|---|---|
| import-boundary 门禁 | 不建独立门禁；verify-docs 扩展「interface.ts 符号存在性」硬校验 + 跨目录直引**软报告**（review 用，不卡 CI）；真实强制点 = lib 导出面（contract/pack-check 既有） |
| interface.ts 粒度 | 用户要求优先：每目录 interface.ts 保留 + 最小面导出（禁整文件 re-export）；StatsService/executor 工厂/路由 context 做深封装 |
| 死面删除时机 | 目录化后收尾独立 PR（两专家一致） |
| 测试结构表述 | smoke 壳 + 13 unit 套件 = 单进程三段式（非两层金字塔）；根因 = testFiles 缺三文件 |

---

## 8. 验收与门禁汇总

- 每阶段：`pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck` + smoke
- **每阶段测试交付（D17）**：L1 层内单元 + L2 interface 契约 + L3 关联 UC 集成补强 + L4 变异段更新，缺一不可入 PR
- 阶段一验收门：smoke 面板缓存专项（S1 扩展：失败不写 / purge 后 miss / select×在途交错）+ L2 `pipeline.interface.test.ts`（getPanelResult 四段语义契约）
- 阶段二验收门：L2 `execute.interface.test.ts`（executor 工厂幂等/脱敏契约）+ L3 UC5 报告闭环
- 阶段四验收门：产物等价性 diff（重构前后 lib/index.js 仅 import 路径差异）+ AI 可导航性前后对比 + L1/L2 测试目录镜像迁移完成
- 变异：夜间 observe 硬校验（阶段零重建基线后全面生效，per-layer 段 threshold 60）
- 注释清理随触碰面（D11）；测试落盘 mkdtemp 隔离；主 checkout 不触碰

---

## 9. 实施跟踪

- 跟踪 issue：#670
- 阶段 PR 序列：阶段零 → 一 → 二 → 三 → 四 → 收尾（各阶段独立 PR，一/二可并行开发）
