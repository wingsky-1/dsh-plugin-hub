# dsh-provider-usage 架构现状与决策记录（契约基线 v4）

> 状态：**当前架构的静态说明**。本文件原为分层重构实施计划（跟踪 issue #670，
> 重构已全部合入），落地后改写为现状记录；实施过程、阶段 PR 序列与评审往返不再体现。
> 契约基线：`docs/layer-architecture.md`（两大功能域分层 + 符号锚契约表 + 决策表 D1-D17）。
> 包入口：lib 产物经构建转发 `src/apply/index.ts`（`apply/` 为装配层组合根）。

---

## 1. 契约基线 v4（当前契约事实）

- **`layer-architecture.md §2` 契约表 = 当前契约事实**（符号锚约定 D14，不引用行号）。
- 层间裁定要点（现状）：
  - C1 物理目录 = `shared/`（契约/图表/配置/净化/双端共享底座），`interface.ts` 为 C1 门面
  - C2 registry 是公开管理对象，路由为合法下游，判断面（getEntry/hasCandidates）不收口
  - C3 StatsService 门面不暴露 cache/panelCache 写操作（D7：getPanelResult 整体下沉 + generation 失效 + per-key 单飞）
  - C4 纯存储，直读合法
  - C5 retention 死字段已删除（AdapterConfig 不再含 retention）
  - C6 面板缓存四段语义整体下沉为 `StatsService.getPanelResult`；registry/history 直读保留
  - E3⇄E4 双向静态依赖已解耦为**共同依赖域2公共层**（`domain2/common/last-run.ts`、`report-index.ts`，无状态无缓存）
  - E4 executor 独立工厂文件（`domain2/execute/executor.ts`），错误脱敏为工厂契约字段
  - E5 /events SSE 死面文档化保留（backlog，客户端零消费）
- 死面清理（已完成，收尾 #680）：`capsuleHtmlFromHistory` 已删除、`AdapterConfig.retention` 已删除；lib 导出面 213→212。

---

## 2. 测试分层策略（D17，四层）

| 层 | 形态 | 目标 | 组织 |
|---|---|---|---|
| **L1 层内单元测试** | 单层内部文件/类/函数 | 层内逻辑正确（状态机/纯函数/IO 隔离） | 测试目录与源码目录**镜像 1:1**：`test/unit/<layer>/` 对齐 `src/<domain>/<layer>/` |
| **L2 interface 测试（层间契约）** | 每目录 `interface.ts` ↔ 对应 `interface.test.ts` | **层间稳定性**：导出符号清单稳定性（显式清单断言，防意外增删）+ 关键契约行为（StatsService.getPanelResult 命中/miss/失败不写；executor 工厂幂等/脱敏；scheduler tick；TrendTracker 查询面） | `test/interface/<layer>.test.ts`；import 边界断言并入 `scripts/gate/verify-dir-imports.mjs`（跨目录直引软报告 + interface.ts 符号存在性硬校验） |
| **L3 集成测试（user case）** | 基于真实用户场景的端到端断言（复用 smoke 拉起机制 helpers.ts） | 整体功能正确（UC 全链路） | `test/integration/uc-<n>-<name>.test.ts`，按 UC 分组：UC1 适配器管理（候选/切换/清空/添加/热更）· UC2 拉取+胶囊（fresh/cached/stale 降级+注入）· UC3 历史面板（查询/缓存命中/append 全清）· UC4 趋势视图（事件→聚合→目录面/提供者面）· UC5 报告闭环（配置/调度/手动生成/幂等/失败不推进 lastRun/状态轮询）· UC6 系统面（health/ui-config/loopback 403/405/生命周期清理） |
| **L4 变异测试分层** | Stryker 段定义与**层对齐** | 每层杀灭面 = 该层 unit + interface 测试；threshold 60 per 段 | segments 与目录对齐，由 `scripts/data/mutation-topology.json`（SSOT）经 gen-stryker-conf 生成 |

- 测试纪律保持：smoke 全部离线无网络；临时 DSH_HOME 隔离；落盘 mkdtemp；smoke 仍为全链路冒烟壳。

---

## 3. 决策表（D1-D17 已拍板决策记录）

| # | 决策项 | 最终裁定 |
|---|---|---|
| D-1 | C2 六文件拆分 | 维持（并入 registry/ 目录） |
| D-2 | aggregator 拆分 | **已拆**：主类保留状态容器与方法，纯函数迁 `aggregate-rows.ts`（压实转换）/ `aggregate-query.ts`（查询投影），参数显式传入不接触 this（安全网 = R8 台账守恒断言，见 layer-architecture.md §2 E2） |
| D-3 | C3 编排/管道/守卫 | 维持 |
| D-4 | SSE /events 死面 | 文档化保留（backlog） |
| D-5 | contracts/charts 共享 | 物理化 = shared/（C1 底座目录） |
| D-6 | 客户端分层 | 分域保留；**客户端拆分本轮不做**（D15） |
| D-7 | StatsService 缓存收口 | **已实施**：整体下沉 getPanelResult + generation 失效 + per-key 单飞 |
| D-8 | executor 收敛 E4 | **已实施**：独立工厂 `execute/executor.ts` + common 归位（last-run/report-index）+ 报告面组合收敛（ReportConfigService、list-dirs） |
| D-9 | 目录化 + interface.ts | **已实施**：两级域→层 + 最小面具名导出；门禁 = verify-dir-imports 软/硬组合 |
| D-10 | 文件瘦身 | **已实施**（客户端除外） |
| D-11 | 注释清理 | **已实施**（删废话/过时/重复，保留 why 与 issue 关联） |
| D-12 | 变异网前置 | **已实施**：变异分层网先行建立，observe 夜间硬校验生效 |
| D-13 | 死面清理独立收尾 PR | **已完成**：capsuleHtmlFromHistory / AdapterConfig.retention 已清理（#680） |
| D-14 | 契约表符号锚 | **已实施**：契约引用一律「文件 · 符号」，不引用行号 |
| D-15 | 客户端拆分范围 | 本轮不做（backlog） |
| D-16 | 对外估算 | 8-12 天，内部 1.5-2×（实施历时符合） |
| D-17 | **测试分层** | **已实施**：L1 层内单元 + L2 interface 契约（层间稳定性）+ L3 user-case 集成（UC1-UC6 全链路）+ L4 变异按层分段（per-layer testFiles，threshold 60） |

---

## 4. 当前目录树（两级 · 先域再层）

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
    aggregate/  interface.ts + aggregator/aggregate-rows/aggregate-query/store/index   # E2（D2 纯函数拆分）
    common/     interface.ts + last-run/report-index/errsurf    # 域2公共层：无状态无缓存（D8 归位，errsurf 为 D2 错误面）
    schedule/   interface.ts + config/schedule/scheduler/tasks  # E3（DEFAULT_PROMPTS 在 config.ts 内）
    execute/    interface.ts + runner/generate/format/executor/list-dirs   # E4（executor 独立工厂 + list-dirs 收敛）
    routes/     interface.ts + ui/reports                       # E5 路由层（宿主）
  apply/                           # 装配层（组合根特权；零隐藏可变状态）
    interface.ts + apply/index/report-config-service
  client/                          # 客户端（本轮不改；双端共享经 shared/ 源码 import）
```

## 5. 当前文件 → 目录全量映射表（35 文件）

| 目录 | 文件 |
|---|---|
| shared/ | interface.ts、contracts.ts、charts.ts、config.ts、sanitize.ts、ui-config.ts、client-logic.ts、placement-math.ts |
| domain1/registry/ | interface.ts、registry.ts、user-adapters.ts、user-adapter-loader.ts、hotreload.ts、provider-config.ts、path-resolve.ts |
| domain1/pipeline/ | interface.ts、stats-service.ts、v2.ts、guards.ts |
| domain1/history/ | interface.ts、history.ts |
| domain1/adapters/ | interface.ts、deepseek-official.{mjs,d.mts}、opencode-go.{mjs,d.mts}、zai-coding-cn.{mjs,d.mts} |
| domain1/routes/ | interface.ts、stats.ts、adapters.ts |
| domain2/collect/ | interface.ts、collector.ts、types.ts |
| domain2/aggregate/ | interface.ts、aggregator.ts、aggregate-rows.ts、aggregate-query.ts、store.ts、index.ts |
| domain2/common/ | interface.ts、last-run.ts、report-index.ts、errsurf.ts |
| domain2/schedule/ | interface.ts、config.ts、schedule.ts、scheduler.ts、tasks.ts |
| domain2/execute/ | interface.ts、runner.ts、generate.ts、format.ts、executor.ts、list-dirs.ts |
| domain2/routes/ | interface.ts、ui.ts、reports.ts |
| apply/ | interface.ts、apply.ts、index.ts、report-config-service.ts |
| client/ | 保持目录化前布局（本轮未拆分） |

## 6. 跨域/跨层引用现状（实证）

- 域1/域2/装配 → 共享底座：**一律经各目录 `interface.ts` 面具消费** `shared/interface.ts` 转发的符号
  （charts/config/sanitize/ui-config/contracts 类型等），无跨目录直引实现文件。
- 域2 → 域1：`domain2/routes/ui.ts` 以 **type-only** 引用 `domain1/pipeline/interface.ts` 的
  `StatsService`（D7 后仅类型 + cacheSize() 方法调用）。
- E3⇄E4：不直接互引；`domain2/schedule/tasks.ts` 持有注入的 executor（经 `execute/interface.ts`
  工厂），双方共同依赖 `domain2/common/`（last-run/report-index，无状态无缓存防 indexCache 双份）。
- 域1 → 域2：**零**（业务面零依赖实证成立）。
- import 边界强制点：`scripts/gate/verify-dir-imports.mjs`（本包走 `--soft`：跨目录直引软报告
  不卡 CI；interface.ts 符号存在性两模式均硬校验）+ lib 导出面（contract/pack-check 既有）。

---

## 7. 边界与约束（原冲突裁决结论）

| 约束面 | 结论（当前生效） |
|---|---|
| import-boundary 门禁 | 不建独立门禁；verify-dir-imports 扩展（interface.ts 符号存在性硬校验 + 跨目录直引软报告，review 用不卡 CI）；真实强制点 = lib 导出面（contract/pack-check 既有） |
| interface.ts 粒度 | 每目录 interface.ts 保留 + **最小面具名导出**（禁整文件 re-export）；StatsService / executor 工厂 / 路由 context 做深封装 |
| 死面清理 | 已完成（capsuleHtmlFromHistory、AdapterConfig.retention 已删除，收尾 #680） |
| 测试结构 | smoke 壳 + 13 unit 套件 = 单进程三段式（非两层金字塔）；新测试文件必须进 mutation-topology testFiles 杀灭面（否则变异 0% 覆盖） |

---

## 8. 门禁现状

- 全量门禁：`pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck` + smoke
- 目录面门禁：`node scripts/gate/verify-dir-imports.mjs --package dsh-provider-usage --soft`
- 变异：夜间 observe 硬校验，per-layer 段 threshold 60（SSOT = `scripts/data/mutation-topology.json`）
- 测试落盘 mkdtemp 隔离；主 checkout 不触碰