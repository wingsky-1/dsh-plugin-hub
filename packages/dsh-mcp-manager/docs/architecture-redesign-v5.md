# dsh-mcp-manager 架构重构方案 v5（目标架构与迁移计划）

> 关联：issue #767（本方案落地载体）、#773（0.2.5 排期与进度入口）、#770（遗留缺陷归拢载体）、#664（上一轮分层重构，已合并）、docs/ARCHITECTURE-METHOD.md（方法论事实源）、.dsh/skills/dsh-plugin-hub-refactor/SKILL.md（执行清单）。
>
> **定位**：取代 `architecture-redesign-v4.md`。v4 是「结构搬移、行为冻结」立场下的方案（该立场派生出的一整类自相矛盾，见附录 C 的处置表）；v3 的成果（目录分层 + 每目录 `interface.ts` 门面 + 测试三层登记）保留，本文件定义其未完成部分并**重定立场**。
>
> **口径**：存量数字来自实测，四要素为「commit + 脚本 + 粒度 + 计数单位」。基线 commit = `b490e87`（v0.2.4 发布点）；与最新 main 有行号偏差时以符号名为准。
>
> **参照实现**：`packages/dsh-notifier`（#733 / PR #777，同仓唯一已完成「按域重写」的插件）。本方案凡遇形态取舍，**先问「notifier 怎么做的」**；依据与 commit 证据见附录 B。参照包本身的缺口与妥协（6 条）单列，不照搬。

---

## 零、v5 相对 v4 的立场变化（8 条决策）

v4 的问题不是写错，而是立场选错：**「只搬结构、不动行为、旧树冻结、分段收缩」**。每一次妥协都在后面长出一处自相矛盾。v5 改为**一次做到最终正确形态**，并把「行为变更」从禁忌改为**显式登记**。

| # | 决策 | v4 的做法 | v5 的做法 | 依据（notifier 实证） |
|---|---|---|---|---|
| D1 | 导出面基线 | P0 冻结旧树 → 全期零漂移 → P5 独立收缩阶段 | 基线由**重构前那棵树**生成（早于第一个结构 commit）；**删除到位的那一个提交里**用 `--snapshot` 重冻结并逐符号说明；不设独立收缩阶段 | #669 PR1 `2370774` 冻结（早 2 天）；#733 在分支第 31/102 个 commit `8df3950` 一次性重冻结（100 → 4） |
| D2 | 兼容 shim | P1–P4 保留 re-export shim，P5 统一删 | **零 shim / 零 deprecated 桶 / 零 TODO**，搬迁一次到位 | #733 首笔 commit `db1ce0f` 直接砍到 4 个导出；全包 grep shim/deprecated/compat/TODO 只命中 React 类型 shim 与真实迁移语义 |
| D3 | 凭据出境 | 登记为 6 条已知缺陷，留给 #770 | **本轮修完**：唯一投影出口 + 掩码往返（按稳定 id）+ 掩码无原值 fail-closed + 六出口全覆盖契约测试；行为变更进登记 | notifier `config/impl/redact/index.ts` 是唯一脱敏器；字段清单唯一；`unmaskChannels` 按 id 还原、无原值 `ok:false` |
| D4 | 服务面 ABI | A13(a)：`getTools` 原样搬移，同源改写另立批次 | **同期收敛**：`getTools` 与查询出口同源；服务面加 `apiVersion` 字面量；四件套锁住（导出面快照 + 消费方编译夹具 + 服务槽类型相等 + 运行时无夹带断言） | notifier `fdbdec0` 同期收敛 ABI；`sdk/impl/service/type.ts:21` `readonly apiVersion: 2`；release notes 第 6 节给开发者写退役清单 |
| D5 | 跨端契约 | A14 已决新增 `src/shared/`，但 DTO 仍散在 `server/shared` | **跨端全部进 `src/shared/` 单点**：六态键集合、SSE 帧名、DTO 形状、路由路径常量；并**补 client 侧 import 判据**（门禁现在排除 client） | notifier 的门面 + 纯数据形态可照搬；「DTO 全进 src/shared」**超出**参照包（它允许 client `import type` 直引 server 内部且无判据），故必须自补判据 |
| D6 | 测试导入面 | A11(b)：暂不限制，降为 checklist | **判据上线**：只对 `test/unit/**` 生效；包范围登记在数据面；其他包 3 处存量走 `gate-exemptions.json` + tracking issue；本包 13 处随搬迁清零 | 参照包此处**无判据**（约定），v5 是加强；加强的成本与收益见 §8.1 |
| D7 | 门禁与登记接线 | P0 只写 baseline + faces + 两处登记 | P0 一次接线：baseline + faces + `gate-scope-registry.json`（两处扩包）+ `ci-face-registry.json` + `ci.yml` 的 `scripts/data/dsh-mcp-manager-*.json` glob + `mutation-topology.json`（`src/server` 超集段 + facade 重估 + `deps.ts` 新增条） | notifier 的 `gate-scope-registry` 由重写 PR 新建、`ci-face-registry` 与 `ci.yml` 数据面 glob 晚一天（#791）——属**事后补面**，不照搬 |
| D8 | 行为变更交付 | N12「不改可观察输出」当总口径 | 保留项/不保留项分列（§10.1）；每条变更按两件形态登记：commit 正文【公共 API 行为变更登记】块（变更点 / 零变更面 / 回落策略 / 授权出处）+ release notes 编号节 | `8142b13` 的登记块是模板；v0.2.4 release notes 第 4 / 6 节是模板；`a748361`（恢复重写静默删掉的四项能力）是反面教训 |

**红线授权路径（照搬 notifier 的正路）**：`.github/` 改动、新增第三方依赖、公共 API 行为变更，三条红线由**一次 #767 方案 `approved` 打包覆盖**（#733 的 7 笔 `.github/` 改动即由整包 approved 授权）。**不要引用 `yaml` 经 #781 合入的先例**（那次没有 approved，是维护者当次授权）。

---

## 一、为什么还要再重构一次

### 1.1 上一轮（#664）做到了什么

| 维度 | 实测值（`verify-dir-imports --package dsh-mcp-manager --graph`；粒度：叶子模块） |
|---|---|
| 叶子模块（含 `interface.ts` 的目录） | 14 |
| 参与规则扫描的 src 文件 | 63（src 下 TS 文件共 78） |
| 模块级值边 | 33 |
| missingInterface | 0 |
| 客户端分层 | `src/client/{core,float,settings}` 已成形态 |

### 1.2 还差什么

| 判据 | dsh-mcp-manager（基线） | dsh-notifier（参照终态） |
|---|---|---|
| 叶子模块级值环 | **4** | 0 |
| 文件级值环 | **4** | 0 |
| 规则 2 直引实现文件（directImpl） | **1**（`connection/interface.ts → connection/orchestrator/tool-names.ts`） | 0 |
| `deps.ts`（注入面） | **0 / 11 域** | 8 个（7 域根 + 1 块内），只有 channels 域零对上依赖不建 |
| 域间**值边** | 33（含跨域纯函数值引） | **0**——7 条值边全部指向 `shared/`，跨域只有类型边 |
| 宿主端最大单文件 | 1208 行（`McpManager`，43 成员） | 699 行（职责单一） |
| 包入口 | 231 行**纯 re-export 桶**，导出 100 个符号 | 306 行组合根，导出 **4 个符号** |

### 1.3 根因：边界画在同一个对象上

`McpManager` 同时是三个「最小面」的被依赖方（`types/host-faces.ts`）：`SupervisorLite/ManagerLite`（10 成员）、`MiddlewareHost`（8 成员）、`RoutesManager`（**23 成员，其中 8 个可选**）。连接域、中间层、API 面、服务面、目录域的边界都交在同一个类上——只要它还在，`deps.ts` 只能声明出一个大而全的 Port，环也拆不干净（4 条环里 2 条直接穿过 `manager.ts`）。

### 1.4 上一轮的测试面把违反方法论的做法写进了契约

| 被测导入方式 | 文件数 |
|---|---|
| `await import("../../src/index.ts")`（组合根汇聚面） | 13 |
| `await import("../../lib/index.js")`（产物） | 1（e2e/smoke） |
| 静态 `from "../../src/index.ts"` | 1（unit-manager） |

`docs/architecture-contract.md` §3.1 的 T1 定义（「模块公开符号（经 `lib/index.js` re-export **或目录 interface.ts**）」）把 ARCHITECTURE-METHOD §6 点名的反模式写成了本包契约；它同时解释了入口那个 231 行 re-export 桶的主要消费者是**测试**。

---

## 二、架构宪法（12 条不变式，每条配机器判据）

> 立宪原则来自 ARCHITECTURE-METHOD §1 第 4 条：**未被机器强制的约束等于不存在**。每条判据必须落到既有门禁（`pnpm contract` 段）或既有脚本的扩展上；挂不进机器判据的条目不得写成「不变式」。

### I1 宿主上下文只到组合根

- **不变式**：`src/server/**` 的任何域都拿不到 cordis `Context`；组合根把 `ctx` 收窄成能力面，域只声明「我要什么能力」。
- **判据**：`src/server/**` 无 `Context` 引用。白名单两处：组合根 `src/index.ts`；能力类型定义处 `server/shared/host-faces.ts` 与各域 `deps.ts` 里作为 `Pick<Context, …>` 出现的能力面。
- **现状**：违反（`new McpManager(ctx, store)` 把 Context 穿透进域）。

### I2 跨域只经 deps.ts 注入；值边只允许指向共享层

- **不变式**：域与域之间**不发生运行时的直接值引用**；消费方在自己的 `deps.ts` 里用 `Pick` 声明所需能力，组合根递提供方的命名空间对象。跨域共享的实现放 `server/shared/`（包内）或 `src/shared/`（跨端）。
- **判据**（`verify-dir-imports --graph` 的依赖矩阵；粒度：叶子模块）：①矩阵中除指向 `server/shared` 与 `shared` 的边外**不得出现值边**；②叶子模块级值环 = 0、文件级值环 = 0；③`deps.ts` 值 import = 0、死声明 = 0。
- **现状**：违反。33 条值边、4 + 4 条值环、1 条 `directImpl`（`connection/interface.ts → connection/orchestrator/tool-names.ts`）。
- **参照实证**：notifier 的依赖矩阵里域间**全是类型边**，7 条值边全部指向 `shared/`。**v4 的「纯函数直接值引对方是合法边」在参照终态里不存在**——本包 `pipeline` 对 `workspace` 的 4 个纯函数改经 `WorkspacePort` 注入。

### I3 同一判定只有一个物理定义

- **不变式**：脱敏、策略裁决、工具命名、状态投影、凭据字段清单，每一件事只有一个定义处；别处要用取能力，不抄规则。
- **判据**：投影/脱敏函数的构造点 = 1；凭据字段清单 = 1 处；策略拒绝文案单点。
- **现状**：违反。脱敏有 **4 个构造点**：`connection/runtime/middleware.ts:452`、`:783`、`connection/runtime/supervisor.ts:433`、`connection/orchestrator/manager.ts:209`；`mcp__` 反解两处；策略拒绝文案两处。

### I4 导出面尽可能小，且每个导出都有域外消费者

- **不变式**：入口只导出三类面——**安装面**（`apply`/`inject`/`name`/`Config`）、**配置面**、**契约面**（跨端 DTO、服务类型）；其余内部符号（`McpManager`/`McpStore`/`McpMiddleware` 等仅被测试从产物导入的）一律移出入口。
- **判据**：①既有 `export-surface-snapshot` 零 diff + 三面分类准入（`export-faces-lib.ts`）；②新增：域 `interface.ts` 的每个具名导出必须至少有一个**域外消费者**（消费者 = 非本域文件；组合根 `src/index.ts` 计入；本域 `impl` 与测试不计）。
- **现状**：违反。按上述口径实测**3** 个无消费者导出（`api/interface.ts` 的 `queryParam`、`connection/interface.ts` 与 `connection/orchestrator/interface.ts` 的 `stripMcpPrefix`——正是 TDZ 特例化的产物）；入口 100 个导出。
- **参照实证**：notifier 终态 **4 个**导出（`NotifierService` 类型 + `apply` + `inject` + `name`；`./client` 2 个）。

### I5 共享层按符号种类准入

- **不变式**：类型面门槛 3、函数与值面门槛 2。包内 `server/shared/` 与跨端 `src/shared/` 以**域**为计数单位，仓库 `shared/` 以插件为计数单位；单一消费者留包内。
- **判据**：`shared/README.md` 登记快照与实测一致；`src/server/shared/` 与 `src/shared/` 新增文件须写出消费者域清单。
- **现状**：登记已腐化（`loopback` 登记 4 实际 2；`settings-namespace` 登记 4 实际 3；`client/i18n` 登记 2 实际 3；`frontmatter` 0 未废弃）；`mcp-manager-service.d.ts` 类型面 1 消费者不达标 → 退回包内。

### I6 未装配即抛错，不写静默降级

- **不变式**：「没装配」与「装配了空实现」必须可区分。可选成员只用于调用方语义上真的可选的场合。
- **判据**：`src/server/**/deps.ts` 不得出现 `?:`（**参照实证：notifier 8 个 deps.ts 的 `?:` grep 零命中**）；域内禁三种存在性守卫（`typeof x.m !== "function"` / `x.m === undefined` 早退 / `x.m?.(…)`）。
- **现状**：违反。实测命中 `apply-services.ts:25`、`apply.ts:101`、`apply-runtime.ts:139/146`、`apply-config.ts:106/125`、`middleware-register.ts:174/311/317`；`RoutesManager` 的 8 个可选成员。

### I7 存储布局是单一事实源，迁移独占一域且装配最前

- **不变式**：文件名与**权限**都是迁移契约，只在 `server/shared/paths.ts` 定义一次，新旧位置同处声明。
- **判据**：`paths.ts` 是文件名字面量的唯一出处（grep 断言）；`upgrade/impl/steps` 是旧路径字面量的唯一出处；迁移测试覆盖**五态**（有旧文件 / 无旧文件 / 目标已存在 / IO 读失败 / 解析失败）。
- **现状**：违反。5 类文件散在 `DSH_HOME` 根（`dsh-mcp.json`、`dsh-mcp-user-state.json`、`dsh-mcp-catalog/<hash>.json`、`dsh-mcp-catalog.json`、`mcp-stats.json`）；无 `version` 刻度、无迁移机制；全包权限只有一处 `0o600`（`config/store/store.ts:66`）。

### I8 测试分层由导入面定义，不由文件名前缀定义（**本轮上线判据**）

- **不变式**：`test/unit/**` 白盒直连 `src/server/<域>/impl/<块>/`；`test/integration/**` 只 import 域 `interface.ts`/`deps.ts` 与跨端线协议；`test/e2e/**` 只经包产物入口 + `apply()`。
- **判据**：新增「测试导入面」判据，**扩展既有脚本**（不新增门禁工具、不新增 workflow）：①`test/unit/**` 不得出现 `src/index.ts` 与 `lib/`；②`test/e2e/**` 不得 import `src/`；③`test/integration/**` 不得 import `src/server/<域>/impl/`。**只对 `test/unit/**` 生效**（`client` / `e2e` 各有产物与浏览器语义）。包范围**登记在数据面**（不内嵌脚本常量）。
- **存量处置**：其他包 3 处（`dsh-lan-proxy` 的 `unit-proxy.test.ts:38`、`unit-apply.test.ts:38`；`dsh-web-file-preview` 的 `unit-present-open.test.ts:21`）走 `scripts/data/gate-exemptions.json`（文件级 + tracking issue，缺 issue 号判红）；本包 13 处走**单调基线**（只许降），随 §12 的批次清零。
- **成本与收益**：成本 = 一次脚本扩展 + 一条脚本自测 + 3 条豁免数据；收益 = 把「测试从产物入口导入」这条反模式从「约定」变成判据（v4 选 (b) 的代价是这条线交给时间腐化）。
- **现状**：违反（13 个单元测试经 `src/index.ts`；`architecture-contract.md` §3.1 把该形态写成 T1 契约）。

### I9 零模块级可变状态

- **不变式**：宿主端状态一律收进实例或闭包；模块级只允许常量表。
- **判据**：`scripts/gate/forbid-module-state-src.mjs`——**本轮把 `dsh-mcp-manager` 登记进 `scripts/data/gate-scope-registry.json` 的 packages`**（该闸 `scopeFrom=registry`，现为 `["dsh-notifier"]`，CI 无参调用 `ci.yml:783`，故本包今天**不在扫描面内**）。
- **现状**：达标以登记进扫描面后的实测为准；登记前不得写「本包 0 命中」。

### I10 状态与错误出口单链

- **不变式**：状态变更只有一个出口（`emitStatus` → summary 帧，零负载 + 客户端回拉）；**错误与凭据也只有一条出境链**——所有出境对象由一个投影函数构造，凭据字段按唯一清单掩码，写回按稳定 id 还原，掩码无原值 fail-closed。
- **判据**：①契约测试登记**六条出口**清单并全覆盖断言（新增出口判红）；②`src/server/api/**` 与 `src/server/sdk/**` 不得直接序列化 `ServerConfig`（文本/AST 断言：不得出现 `{ ...server }` 式展开）；③投影/脱敏构造点 = 1。
- **现状**：违反。状态链已单点；**凭据有六条出口未脱敏**（§6.2），脱敏器 4 个构造点。

### I11 ABI 名只有一个物理定义

- **不变式**：服务名、工具名前缀（`mcp__`）、路由常量、SSE 帧名、六态键集合，都以 `as const` 定义一次；声明合并用计算属性名引用；对外 ABI 带 `apiVersion` 字面量。
- **判据**：`pack:check` 的「声明合并可达性」+ 字面量重复的 grep 断言 + 服务槽类型相等断言。
- **现状**：部分达标。服务名 `"mcpManager"` 两处；`declare module` 现住 `integration/service.ts`；**服务面没有 `apiVersion`**（参照包有 `apiVersion: 2`）。

### I12 文档与实现同源，注释不复述结构

- **不变式**：契约文档每条判据与门禁同源；注释只写「为什么」。
- **判据**：`docs:check` + 验收三条（没有复述签名的注释、没有指向已删除符号的注释、没有整段注释掉的旧实现）。
- **现状**：违反（`architecture-contract.md` §3.1 的 T1 与 §8 冲突；`connection/interface.ts` 头注释记录的是 TDZ 特例）。

---

## 三、目标形态

### 3.1 目标目录结构

形态与 `packages/dsh-notifier/src` 对齐（域目录只有三样东西 + 两个层次的 shared）：

```
packages/dsh-mcp-manager/src/
  index.ts                组合根：bindHost(收窄 ctx) + assemble(顺序装配) + 逆序释放
                          + declare module 声明合并 + 包导出面（唯一汇聚点，目标 = 三面）
  server/
    shared/               包内共享层（叶子，无归属的宿主侧设施）
      interface.ts        门面：类型 ≥3 域消费 / 函数与值 ≥2 域消费才准入（I5）
      paths.ts            存储布局单一事实源：新路径 + legacyFile(旧路径) + 每文件 mode（I7）
      file-io.ts          原子写 / 容错读（以 atomically 承接，见 §7.5）
      host-faces.ts       宿主能力面类型（I1 白名单点名的能力类型定义处）
    upgrade/              { interface.ts, deps.ts, impl/{version, chain, steps, legacy} }
    store/                { interface.ts, deps.ts, impl/{user-state, catalog-cache, stats-file} }
    stats/                { interface.ts, deps.ts, impl/collector }
    pipeline/             { interface.ts, deps.ts, impl/{args, msg, redact, timeout, authorize, project} }
    config/               { interface.ts, deps.ts, impl/{model, input, ui} }
    workspace/            { interface.ts, deps.ts, impl/{root-resolution, full-name, scope, mode} }
    catalog/              { interface.ts, deps.ts, impl/{entries, digest, history, injection, cache-view, search} }
    connection/
      interface.ts
      deps.ts
      impl/
        orchestrator/     { type.ts, index.ts }   连接编排：代际仲裁 / 双轨 reconcile / 投影
        middleware/       { type.ts, index.ts }   中间层宿主：池 / 模式 / 热切换 / unit 生命周期
        supervisor/       { type.ts, index.ts }
        transport/        { type.ts, index.ts, stdio.ts, http.ts }
        protocol/         { type.ts, index.ts }
    inject/               { interface.ts, deps.ts, impl/{register, guard, prompt} }
    api/                  { interface.ts, deps.ts, impl/{routes, controllers, sse-exit, health} }
    sdk/                  { interface.ts, deps.ts, impl/{service, registry} }
  shared/                 **跨端层（D5）**：六态键集合 / SSE 帧名 / DTO 形状 / 路由路径常量 / 服务类型
    interface.ts          两端唯一引用落点
  client/                 保持结构（core/float/settings），归 #769；本轮只允许最小文案改动
```

**三条形态规则**（照搬 ARCHITECTURE-METHOD §2 与 refactor skill §1）：

1. **域目录只有三样东西**：`interface.ts`、`deps.ts`、`impl/`；`impl/` 根只放聚合器与跨块值文件，实现住 `impl/<块>/`，**类型的物理定义在 `impl/<块>/type.ts`**，门面只做收口。
2. **判据是「有对上依赖（他域能力或宿主能力）就建 `deps.ts`」**（照搬 notifier：`config/deps.ts` 只有 11 行、唯一成员是宿主 logger 端口，照样建；`channels` 域对其它域零依赖才不建）。
3. **跨域只有类型边**（I2）：运行时取数一律经 `deps.ts` 的 `Pick`；无归属的共享实现放 `server/shared/`，跨端共享放 `src/shared/`。

### 3.2 载体职责

| 载体 | 职责 | 允许的依赖 |
|---|---|---|
| `src/index.ts`（组合根） | 收窄宿主上下文成各域窄面；按依赖顺序装配；注册生命周期并逆序释放；包导出面与声明合并 | 各域 `interface.ts`。**不写业务判断** |
| `<域>/interface.ts` | 本域对外承诺：DTO + 能力对象类型 + `installXxx(deps)` / `releaseXxx()` 配对 | 本域 `impl`；他域 `interface.ts` 的类型 |
| `<域>/deps.ts` | 声明「我要外部什么」：按提供方分组的 `Pick` 端口；**纯类型面，零可选成员** | 他域 `interface.ts` |
| `<域>/impl/<块>/` | 实现；白盒直连的单元测试面 | 本域内 + 本域 `deps.ts` + `server/shared` 门面 |
| `server/shared/` | 无归属的宿主侧设施（路径单源 / IO 原语 / 宿主能力类型） | 零域依赖 |
| `src/shared/` | 跨端语言：状态键集合 / 帧名 / DTO / 路由常量 / 服务类型 | 零依赖，两端共用 |
| `client/` | 浏览器半区，经 HTTP + SSE 与宿主通信 | 只允许 `src/shared/` 与 `src/client/`（§5.3 判据） |

组合根三条纪律（照搬 notifier 的 `bindHost` / `assemble` / `safeDisposeAll`，`src/index.ts:118-306`）：

- 交付的是**能力**，不是算好的值。装配期取一次的快照会在用户改设置后失效，而它看起来与实时读取一模一样。
- **未装配的占位要抛错**（I6）；fire-and-forget 出口例外。
- 装配与卸载**成对**、释放逆序、每个域复位自己的装配标记。

### 3.3 中枢解体：McpManager 的归属

| # | 现职责 | 目标归属 |
|---|---|---|
| 1 | 服务器 CRUD 与归一化 | `config` |
| 2 | supervisors 池与连接生命周期 | `connection/impl/supervisor` + `orchestrator` |
| 3 | 中间层池 / 模式 / 热切换 | `connection/impl/middleware` |
| 4 | 目录缓存投影 | `catalog`（写经 `store`） |
| 5 | 调用统计埋点 | `stats` |
| 6 | 路由用到的 18 个成员 | `connection` 门面的**命名能力**（不递裸对象） |
| 7 | 中间层宿主 8 个方法 | `connection/interface.ts` 的 `MiddlewareHostPort`，由组合根递入 |
| 8 | supervisor 的 10 个依赖 | `connection` 门面（收窄为命名能力） |
| 9 | 服务面 8 方法 | `sdk` + `api`（同源查询出口） |
| 10 | 脱敏 | `pipeline`（I3 的单点） |

**验收判据**：`src/server/` 下不得存在任何名为 `Manager` 的类；`--graph` 的域间值边 = 0、值环归零；`pnpm crap` 无新增超阈热点。

### 3.4 deps.ts 逐域清单（按 notifier 判据）

| 域 | 对上依赖 | deps.ts |
|---|---|---|
| `upgrade` | `config`（读 `storePath` / `statsFile` 两键）+ 宿主 logger | 有 |
| `store` | 宿主 logger（写失败必须可见，不得静默） | 有 |
| `stats` | `store`（落盘）+ 宿主 logger | 有 |
| `pipeline` | `workspace`（纯函数经端口）+ `config` / `store`（禁用表与 servers 集合）+ 宿主 logger | 有 |
| `config` | 宿主 settings（UI 配置命名空间）+ logger | 有 |
| `workspace` | `config`（项目级 servers 读面）+ 宿主 sessions / logger | 有 |
| `catalog` | `config` + `store` + `connection`（live 视图）+ logger | 有 |
| `connection` | `config` / `workspace` / `catalog` / `stats` / `pipeline` + logger | 有 |
| `inject` | `connection` / `pipeline` / `catalog` / `workspace` / `stats` + 宿主 tools / events / prompt / logger | 有 |
| `api` | `connection` / `config` / `store` / `workspace` + 宿主 register / settings / logger | 有 |
| `sdk` | `connection` / `config` + 宿主 expose | 有 |

**11 个域全部建 `deps.ts`。** 若实现时某域实测为零对上依赖（既不取他域能力也不取宿主能力），按判据**不建**，但必须在 PR 里显式登记该裁量与理由（参照包 `channels` 的做法：在 `interface.ts` 头注释写明「本域对其它域零依赖」）。

### 3.5 Port 面（开写前按实际消费反查）

```
# 宿主能力（不属于任何域；由组合根 bindHost 收窄后递入，每个用到它的域自行声明）
HostPorts = {
  logger:   LoggerPort
  register: (route) => () => void          # ctx.webServer.register
  tools:    { register(def) }              # ctx.tools.register（仅 inject）
  events:   { onPreStep(handler) }         # ctx.on("agent/pre-step")（仅 inject）
  prompt:   { section(opts) }              # ctx.systemPrompt.section（仅 inject）
  settings: { read(), write(patch) }       # ctx.inject(["settings"]) + uiUpdate sink
  expose:   { provide(service) }           # ctx.provide（仅 sdk）
  sessions: { cwdOf(session) }             # ctx.sessions（workspace / api）
}

workspace/deps.ts    -> ConfigPort      = Pick<typeof configApi, "projectServersFor">
catalog/deps.ts      -> ConfigPort      = Pick<typeof configApi, "announceCatalogMaxEntries">
                        StorePort       = Pick<typeof storeApi, "readCatalog" | "writeCatalog" | "catalogPathFor">
                        ConnectionPort  = Pick<typeof connectionApi, "middleware" | "middlewareMode">   # catalogViewFor 要 live 单元与模式
connection/deps.ts   -> ConfigPort      = Pick<typeof configApi, "serversFor" | "saveServers">
                        WorkspacePort   = Pick<typeof workspaceApi, "normalizedProjectRoot" | "parseFullServerName" | "globalRoot">
                        CatalogPort     = Pick<typeof catalogApi, "view">                 # 只读视图；目录写面归 catalog
                        StatsPort       = Pick<typeof statsApi, "isEnabled" | "recordCall">
                        PipelinePort    = Pick<typeof pipelineApi, "normalizeArguments" | "projectCallToolResult" | "withTimeout" | "redactError">
inject/deps.ts       -> MiddlewarePort  = Pick<typeof connectionApi, "middleware" | "middlewareMode">
                        PolicyPort      = Pick<typeof pipelineApi, "isToolDenied" | "toolDisabledReason" | "policyAllows" | "policyDenialReason">
                        CatalogPort     = Pick<typeof catalogApi, "searchCatalogMulti" | "listCatalog" | "findToolDetail">
                        WorkspacePort   = Pick<typeof workspaceApi, "makeResolveRoot" | "parseFullServerName">
                        StatsPort       = Pick<typeof statsApi, "isEnabled" | "recordCall">
api/deps.ts          -> ConnectionPort  = Pick<typeof connectionApi,
                                            "summary" | "start" | "stop" | "connect" | "disconnect" | "reconnect" |
                                            "setToolDisabled" | "resumeReconnect" | "projectRoot" | "middlewareMode" |
                                            "setMiddlewareMode" | "healthCounts" | "serversForEdit" | "redactError">
                        ConfigPort      = Pick<typeof configApi, "uiConfig" | "updateUiConfig" | "add" | "update" | "remove">
                        StorePort       = Pick<typeof storeApi, "readUserState">
                        WorkspacePort   = Pick<typeof workspaceApi, "setSession" | "refreshFromDisk">
sdk/deps.ts          -> ConnectionPort  = Pick<typeof connectionApi, "summary" | "connect" | "disconnect" | "reconnect" | "registerServer" | "unregisterServer" | "toolsForServer">
                        ConfigPort      = Pick<typeof configApi, "serversFor">
```

四条收窄纪律：**`Pick` 越窄越好**；**端口传能力不传算好的值**；**包内 `server/shared/*.ts` 一律经 `server/shared/interface.ts` 门面**（直引会新增 `directImpl` 并判红；参照包 45 处引用全走门面、零直引）；**裸对象不算契约**——`api` 现直取 `manager.store` / `projectStoreOrThrow`（`routes-controllers.ts:320/323`）与 `manager.supervisors/catalogCache/middleware/sseHub`（`routes.ts`），目标形态必须变成命名能力（`healthCounts()`、`serversForEdit()`、`redactError()`）。按实测：`routes-controllers.ts` 用到 **18** 个 `manager.*` 成员，全 `src/api` 共 **22** 个（v4 写的「24 个」不成立）。

### 3.6 七处易错点

1. `connection` 不拥有目录缓存；目录写归 `catalog`（经 `store`），两者之间只留一条「工具集变了」事件。
2. `api` 与 `sdk` 共享**唯一查询出口**，各自 `Pick` 同一方法，不让两边各拿一个宽 Port。
3. 中间层宿主是「被注入」不是「被掏出」：`MiddlewareHostPort` 在 `connection/interface.ts` 有物理定义，由组合根在装配中间层块时递入。
4. **目录缓存的命名与落盘归属说死**：文件名与 hash 规则归 `server/shared/paths.ts`（I7）、`store` 执行写、`connection` 不再经 `MiddlewareHost` 拿路径。
5. **投影层不允许值替换占位符，只允许出真正构造的 DTO**：出境对象由投影函数**新建**（不是展开原对象），凭据值按唯一清单掩码；写回按稳定 id 还原；掩码无原值 → 400（详见 §6）。
6. 跨域常量归**语义所有者**（目录边界常量 → `catalog/interface.ts`）；跨域消费经 `deps.ts` 的 `Pick`（I2 禁域间值边），泄漏面统计纳入常量边。
7. `connection` 的**块级**边界没有机器判据（`moduleOf` 取含 `interface.ts` 的最近祖先，同域块间引用恒不判红）——故 B2 验收必须逐块写清**状态所有权**（谁改 supervisors 池、谁拥有 `registerQueue` 与 `syncChain` 的顺序）。

### 3.7 开闭量化（扩展点与同步点）

口径：按「必须修改的表/分支」计数，不按命中关键字行数（基线 `b490e87` 实测）。

| 扩展点 | 现状同步点 | 目标上限 | 目标形态的单点设计 |
|---|---|---|---|
| 新增一种 MCP 传输 | **≥9** | ≤3 | `connection/impl/transport/type.ts` 一张 `TRANSPORTS as const`（工厂 + 校验 + 凭据形态）→ 宿主校验/工厂/脱敏派生；客户端文案由 DTO 下发 |
| 新增一个服务器状态（现六态） | **≥10** | ≤3 | `src/shared/status.ts` 的 `SERVER_STATES as const`（状态键 + 计数键 + 投影兜底 + DTO 联合），**两端共用同一份**（D5） |
| 新增一条 HTTP 路由 | **4-5** | ≤3 | `src/shared/routes.ts` 的 `ROUTES as const`（路径 + 方法白名单 + 围栏）→ 装配数组与客户端路径表派生 |
| 新增一个 `ws_mcp_*` 工具 | **4-6** | ≤3 | `inject/impl/tools/table.ts` 一张工具表（名称 + 定义 + 是否受策略约束 + 提示词片段）→ 注册/guard/提示词派生 |

**验收**：本表在 B0 作为设计约束冻结；B2 完成后按同一口径重数一遍并写进 PR——任一维度仍 >3 必须说明理由。

---

## 四、逐域边界表（11 域 + 两个 shared）

> 口径：**功能边界** = 这个域回答什么问题；**数据边界** = 它拥有哪些状态与文件；**上游** = 它依赖谁的能力；**下游** = 它向谁承诺什么。

| 域 | 功能边界 | 数据边界 | 上游 | 下游 |
|---|---|---|---|---|
| `upgrade` | 「磁盘上的数据是哪一版形态」——把布局从旧位置推到新位置，在各域装配**之前**跑完 | `version` 刻度；旧文件归档 `*.migrated.bak` | `server/shared/paths` + `file-io` + `config` 的只读键面 | `installUpgrade/releaseUpgrade` |
| `store` | 「非配置类的数据怎么落盘」——禁用记录、目录 last-good、目录摘要、调用统计 | `user-state.json` / `catalog/<hash>.json` / `catalog-summary.json` / `stats.json` | `server/shared`（paths / file-io） | 原子写读面（按文件分能力） |
| `stats` | 「调用指标与渐进式披露漏斗怎么算」——收集、防抖、快照 | 内存计数 + 经 `store` 落盘 | `store` | `recordCall/isEnabled/snapshot` |
| `pipeline` | 「一次工具调用的裁决与投影」——参数归一、授权与禁用裁决、超时兜底、脱敏、结果投影 | 无持久化 | `workspace`（经端口）+ `config` / `store` | 纯函数族 + **唯一投影/脱敏单点** |
| `config` | 「用户可编辑的服务器配置长什么样」——schema / 归一化 / 导入 / UI 配置 / 全局与项目级读写 | `config.json`（全局）+ `<项目根>/.dsh/mcp.json`（项目级，**不动**）；UI 配置住宿主 settings | 宿主 settings | 配置模型 + servers 读写面 |
| `workspace` | 「当前会话在哪个项目根、这个全名属于谁」——root 发现与归一化、全名解析、scope、中间层模式归一 | 内存：当前 root、projectStores 缓存 | `config`（项目级 servers 读面）+ 宿主 sessions | `findProjectRoot/normalizedProjectRoot/makeResolveRoot/fullServerName/parseFullServerName` |
| `catalog` | 「模型能看见哪些工具」——条目合成、摘要、digest、注入决策、检索、缓存视图 | 经 `store` 落盘目录缓存 | `config` + `store` + `connection`（live 视图） | `composeCatalogEntries/searchCatalog/listCatalog/findToolDetail/catalogViewFor` |
| `connection` | 「这个服务器连着没有、中间层该不该接管」——代际仲裁、双轨 reconcile、生命周期、事件出口 | 内存：supervisors 池、中间层池、`syncChain`、`registerQueue` | `config` / `workspace` / `catalog` / `stats` / `pipeline` | **唯一查询出口**（一个对外名）、`start/stop/connect/disconnect/reconnect`、`MiddlewareHostPort` |
| `inject` | 「模型面工具怎么注册、怎么守门」——`ws_mcp_*` 四原子、`mcp__` 直呼 guard、提示词段落 | 无持久化 | `connection` / `pipeline` / `catalog` / `workspace` / `stats` + 宿主 tools / events / prompt | `registerMiddlewareTools/registerDirectMcpGuard/installInjection` |
| `api` | 「浏览器怎么读写与控制」——HTTP 路由（loopback 围栏）、SSE summary 帧、健康检查 | 无持久化（状态在 `connection`） | `connection` / `config` / `store` / `workspace` + 宿主 register / settings | `ROUTES/makeRoutes/makeEventsRoute/makeHealthRoute/emitStatus` |
| `sdk` | 「其他插件怎么用我」——服务面 + 运行时注册队列 + 服务类型 + `apiVersion` | 内存：`runtimeRegistry`、`registerQueue` | `connection`（含读工具集能力）/ `config` + 宿主 expose | `installSdk/releaseSdk` + 服务类型（从包入口导出） |

---

## 五、跨端契约（D5：全部收进 src/shared）

### 5.1 单点内容

| 内容 | 位置 | 消费者 |
|---|---|---|
| 六态键集合与计数键 | `src/shared/status.ts` | 宿主投影、SSE DTO、客户端分组 |
| SSE 帧名与负载形状 | `src/shared/frames.ts` | `api`、客户端 |
| DTO 形状（`McpServerSummary` / `ClientUiConfig` / 配置编辑面类型） | `src/shared/dto.ts` | 宿主投影、客户端 |
| 路由路径常量（11 条） | `src/shared/routes.ts` | `api` 装配数组、客户端 |
| 跨端服务类型 | `src/shared/service.ts`（宿主 `sdk` 引用其定义，入口 re-export 类型） | 宿主 + 兄弟插件 |

### 5.2 纪律

- **物理定义只有在 `src/shared/`**；两端都从 `src/shared/interface.ts` 引用（相对路径 import 同一文件）。宿主侧 DTO 由它派生，不另写。
- 客户端的**结构**归 #769；本轮只允许 `locales.ts` 两行文案降级（A12，前置到 B0）与取数路径改为引用 `src/shared`。
- 六态键集合与 DTO 形状**冻结**：本轮不改线协议语义（改的是它的物理位置）。

### 5.3 新增判据：client 侧 import 面

- **判据**：`src/client/**` 只允许 import `src/shared/**` 与 `src/client/**`；不得 import `src/server/**`。
- **实现**：扩展既有 `verify-dir-imports.mjs`（该脚本现自述「排除 client」，本轮补一条独立规则）；包范围登记在数据面。
- **前置实测**（照 `gate-scope-registry` 的 why 纪律：扩面前先实测他包存量）：实现前先跑一遍全仓，把命中包与文件数写进方案评论；若有他包存量，按 I8 同款走 `gate-exemptions.json`（文件级 + tracking issue）。
- **为什么需要**：参照包的 client 直接 `import type` 服务端内部（`client/reason-text.ts:11` → `server/shared/reason.ts`；`client/capabilities.ts:24` → `server/channels/impl/capabilities/type.ts`）且**无任何判据**——D5 选择「加强」，就必须自己补上这条，否则 `src/shared` 是「约定不漂移」而不是「不可能漂移」。

---

## 六、凭据出境单链（D3）

### 6.1 目标形态

```
  内部 ServerConfig（含明文 env / headers / url userinfo）
        |
        +-- projectServerSummary(server) --> McpServerSummary（**按声明面新建**，不含凭据字段）
        |                                     -> GET /servers、POST/PATCH 响应体、SSE、sdk 服务面、stats sink
        +-- redactError(error) -----------> 文本（已知 secret 值替换；stderr 尾巴过同一 redactor）
        |                                     -> 4xx body、日志、stderr 尾注
        +-- readServersForEdit(servers) ---> 配置编辑视图（凭据值掩码为 ********，其余原样）
                                              -> 客户端编辑表单；写回经 unmaskByStableId，无原值 -> 400
```

四条纪律：

1. **出口唯一**：所有出境对象由上述三个函数之一构造；`src/server/api/**`、`src/server/sdk/**` 不得展开式直出 `ServerConfig`（I10 判据②）。
2. **凭据字段清单唯一**（`pipeline/impl/redact` 的一张 `Record<transport, readonly string[]>`，照 notifier 的 `CHANNEL_SECRET_FIELDS`）；未知传输给空清单而不是抛错（在脱敏处抛错会让整页 500）。
3. **掩码往返按稳定 id**（server 的 `name` + `scope`），不按下标；掩码却无原值 = `ok:false`，调用方 400 拒绝——**掩码只能表达「未修改」，不能凭空造凭据**。
4. **类型即围栏**：`McpServerSummary` 的声明面本来就不含 `env` / `headers` / `url`（实测 `shared/mcp-manager-service.d.ts`），而现状用 `{ ...server } as unknown as McpServerSummary` 把明文带出去——投影层**真的构造**该类型即结构上不可能泄漏。

### 6.2 六条出口的处置（全部本轮修完）

| # | 出口 | 代码点 | 处置 |
|---|---|---|---|
| ① | 4xx 错误响应体 | `api/routes.ts:59-60` 直出 `error.message`；`src/api/` 零 `createRedactor` | 经 `redactError`（能力由 `api/deps.ts` 声明） |
| ② | `GET /servers` 响应体 + sdk 服务面 | `manager.ts:1143-1151`（`msgOf`）、`:1181-1184`（`supervisor.error.message`）；`apply-services.ts:36/56` 原样 `as McpServerSummary` | 改由 §6.1 的 `projectServerSummary` 构造 |
| ③ | env 展开后的真值 | `transport.ts:25-30` 连接时才展开，`redact.ts:23-27` 只收配置字面量 | 展开时把真值注册进唯一清单（或展开前先脱敏） |
| ④ | `stats.json` 的 `lastError` | `stats/collector.ts:165`（`slice(0,200)`）+ `:256` 落盘；两个 feeder：`inject/middleware-register.ts:323`、`connection/runtime/supervisor.ts:331` | 两个 feeder 一并收口（只改 collector 会改错层，它拿不到 server 配置） |
| ⑤ | `POST /servers` 201 与 `PATCH /servers` 200 响应体 | `api/routes-controllers.ts:165`（201）/ `:186`（200）返回 `{ server, summary }`，`server` 来自 `manager.add/update` = 完整 `ServerConfig` | 响应体改为投影后的对象（结构性绕过消失） |
| ⑥ | stdio stderr 尾巴 | `transport.ts:153` `slice(-4000)` → `protocol.ts:49-53` 拼尾注 → `supervisor.ts:383/494` 存入 `this.error` → 经 ② 直出 | stderr 尾巴过同一 redactor；它同时是 ③ 最可能的落地通道（子进程常回显 env） |

**验收**：`test/integration/redaction-exits.test.ts` 逐条断言六条出口不含明文（含「伪造含 URL 凭据的错误」正反例）；I10 判据②的文本/AST 断言判绿。

### 6.3 行为变更

本轮**有意**改变了可观察输出（错误文案与响应体不再带凭据）。这不是「不改行为」的例外，而是**必须登记**的一项：commit 正文写【公共 API 行为变更登记】块（照 `8142b13`：变更点 / 零变更面 / 回落策略 / 授权出处）；release notes 新增一节，写明「凭据不再出现在错误响应体与日志中」及对消费方的影响。

---

## 七、存储布局与迁移

### 7.1 目标布局（唯一事实源：`server/shared/paths.ts`）

| 内容 | 目标路径 | 归属域 | 旧路径 | mode |
|---|---|---|---|---|
| 全局服务器配置 | `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/config.json` | `config` | `<DSH_HOME>/dsh-mcp.json` | `0o600` |
| 用户状态（含 disabledTools） | `.../user-state.json` | `store` | `<DSH_HOME>/dsh-mcp-user-state.json` | `0o644` |
| 目录 last-good 缓存 | `.../catalog/<hash>.json` | `store` | `<DSH_HOME>/dsh-mcp-catalog/<hash>.json` | `0o644` |
| 目录摘要缓存 | `.../catalog-summary.json` | `store` | `<DSH_HOME>/dsh-mcp-catalog.json`（`catalog/cache-view.ts:27`；写路径 `manager.ts:188-193`） | `0o644` |
| 调用统计 | `.../stats.json` | `store` | `<DSH_HOME>/mcp-stats.json` | `0o644` |
| 存储版本刻度（新增） | `.../version` | `upgrade` | 无 | `0o644` |
| 项目级服务器配置 | `<项目根>/.dsh/mcp.json` | `config` | **不变** | 随项目（不设） |

**mode 是本包新增决定（标注）**：参照包 `paths.ts` **没有 mode**、`file-io` 签名也没有全包 mode 参数，故这不是照搬。采纳理由：权限是**文件的属性**而不是写函数参数的属性，登记在 `paths.ts` 后权限决策从 4 个调用点收敛到 1 处（满足 I3/I7）。落地约束：**写函数总是显式传入登记值**，不依赖 `atomically` 的「默认复制旧文件 mode」语义（避免「凭空改动权限」）；并配逐文件权限断言（现状 `0o600` 只有 `config/store/store.ts:66` 一处，其余四处均未设 mode → 目标保持 0644）。

### 7.2 迁移语义（照搬参照包 `upgrade/impl/steps/storage-layout.ts`）

| 情形 | 动作 |
|---|---|
| 目标存在、旧文件也存在 | **先比 mtime**：旧文件更新则**不覆盖也不归档、只 warn**；否则只归档旧文件（`rename` 为 `*.migrated.bak`），不覆盖 |
| 目标不存在、旧文件存在 | 读旧 → **原样文本**写目标 → 归档旧文件 |
| 两者都不存在 | 写**初始空形态**（`config.json` 为版本化空形，不是裸空对象） |
| **目录型旧路径**（`dsh-mcp-catalog/<hash>.json`） | 整目录语义：目标不存在 → 整目录 `rename`；已存在 → **逐文件**「不覆盖只归档」并 warn（参照包的 `LAYOUT` 是扁平单文件表，表达不了目录搬家——本条是本包增量） |
| 旧文件 **IO 失败 / 权限问题** | **抛错**（搬不动，不该被当成「没有旧数据」） |
| 旧文件 **内容解析失败（JSON 坏）** | warn + **保留旧文件原样、不迁移、不推进刻度** + 按空形态继续启动（现状读面全容错：`store.ts:38`、`middleware-state.ts:36`；不能因迁移把它变成装配期致命错误，否则一个坏配置会让 MCP 全不可用）。每次启动重试 |
| 目标已存在但旧文件不存在 | 什么都不做（重跑的常态） |

三条硬要求：**幂等**（归档名固定）；**失败即中止装配**，刻度**回写在 `run` 之后**（失败即不推进，下次从同一步重跑）；**纯文本搬移，不得解析后重写**（`config.json` 里存的是 env 引用而非密钥字面量，解析重写会顺手丢未知键）。

### 7.3 迁移的破坏性面（必须与用户可见行为同步）

| 面 | 处置 |
|---|---|
| 降级不兼容 | 回退到旧版读不到配置（旧文件已归档）→ **写进 release notes** |
| README（中英双语） | 6 处路径表述（含「数据与安全」章节）同步 |
| 客户端文案 | `src/client/locales.ts:74/177` 硬编码 `~/.dsh/dsh-mcp.json` → 降为「全局（本机配置）」（**前置到 B0**）；加静态断言「客户端产物不含 `~/.dsh` 字面量」 |
| 配置项 `storePath` | **不存在 `serverStorePath` 这个键**（`config/model/config-schema.ts:119/137` + `bootstrap/apply-config.ts:33-34`）。显式给了 `storePath` 就不迁移、不改写、继续读用户那个文件（用户可见契约，**必须有测试**） |
| 配置项 `statsFile` | 同 `storePath`；默认值从 `<DSH_HOME>/mcp-stats.json` 迁移（**旧文件名必须在迁移表里显式列出**，否则实施者会 new 一个空文件把用户历史指标丢掉）。键在 `config-schema.ts:31` |

### 7.4 upgrade 域的机制（照搬参照包六件套）

| # | 机制 | 语义（参照包 `src/server/upgrade/`） |
|---|---|---|
| 1 | **步骤表** | `STEPS: { fromVersion, targetVersion, run }[]`；新增版本必须追加一项（哪怕 `run` 空实现）——链以步骤为刻度 |
| 2 | **链驱动** | 读刻度 → 取待办步 → 按 `targetVersion` **升序**执行（不按声明顺序）→ 逐步回写刻度 → 与插件版本对账 |
| 3 | **刻度** | `version` 文件是**存储版本**；`pluginVersion()` 从 `package.json` 读（不写常量）；`compareVersions` 自实现逐段数值比较，不引 semver |
| 4 | **失败语义** | 任何一步失败即抛出、`apply` 中止（「带半完成迁移的存储比不启动危险得多」）；刻度回写在 `run` 之后 |
| 5 | **对账** | 链跑完比 `(recorded, pluginVersion)`，三种落差**分开 warn 且都不中止** |
| 6 | **装配标记** | 单例 + `installed`：重复装配是编程错误当场抛；`release` 只复位标记 |

本包差异：本次迁移只有**布局归位**（+ 目录搬家），故 `STEPS` 只有一步；但六件必须一次建齐。

### 7.5 IO 原语

`server/shared/file-io.ts` 以 `atomically`（MIT）承接，不再自写临时名 + `rename`：

- 依赖形态：`devDependencies`（**根** `package.json`）+ 构建期 esbuild 内联 + 许可归集进 `lib/THIRD-PARTY-LICENSES`；本包 `package.json` **无 `dependencies` 字段**（不是空对象）。
- **依赖链实测**：`atomically@2.1.1` 有 2 个直接依赖（`stubborn-fs` → `stubborn-utils`、`when-exit`），四个包全 MIT；`collect-licenses.ts` 从产物注释自动提取内联包，故许可面自动覆盖（无机制缺口），但 B1 验收必须含「build 后 `pack:check` 对 mcp 判绿 + `THIRD-PARTY-LICENSES` 含这四个包」。
- `fsync` 默认开启会拖慢写盘 → 用 `fsyncWait: false`。
- `fast-redact@3.5.0`（MIT / 0 依赖）：只用于**出口对象序列化**中确实需要掩码的字段；**本轮即有消费者**（§6.1 的出口视图），不再「先引后用」。

---

## 八、测试面目标架构

### 8.1 三层定义与判据

| 层 | 目录 | 只允许 import | 测什么 |
|---|---|---|---|
| 单元 | `test/unit/<域>/<块>.test.ts` | `src/server/<域>/impl/<块>/` + 本域 `deps.ts` 的 Port fake | 模块内函数与状态机 |
| 契约 | `test/integration/` | 域 `interface.ts` + `deps.ts` + 跨端线协议 | 接缝的形状与承诺 |
| 集成 | `test/e2e/` | 包产物入口 + `apply()` | 端到端 user case |
| 组合根 | `test/integration/real-context.test.ts` | `src/index.ts` + 真实 `Context` | 装配顺序、释放逆序、服务面、声明合并 |
| 客户端 | `test/client/` | `src/client/**` | UI 模块（归 #769） |

判据见 **I8**（本轮上线；执法点 = 扩展既有脚本）。**规则（A10 的必然推论）**：凡直接 `new` 内部类 / 取内部符号的 e2e 用例一律改为 `test/unit/<域>` 的白盒用例；e2e 只保留 `apply()` + 产物入口的 user case（现状 `smoke.test.ts` 有 **9 处** `new McpManager`：`:592/897/1928/2016/2102/2979/2997/3568/3659`）。

### 8.2 存量搬迁（16 个测试文件 / 14635 行）

按域落到 `test/unit/<域>/`：`unit-manager2`(3142) → `{connection,catalog,config,sdk,workspace}`；`unit-middleware`(2109) → `{connection,inject}`；`unit-supervisor`(900) / `unit-transport`(356) / `unit-manager`(271) → `connection/`；`unit-catalog`(771) → `catalog/`；`unit-routes-sse`(705) → `api/`（帧契约下沉 `integration/`）；`unit-store`(501) → `{config,store}/`；`unit-apply`(412) → `integration/real-context.test.ts`；`unit-hotspot`(370) 按被测符号归域；`unit-shared`(338) 被测对象是仓库 `shared/settings-namespace` → 迁 `scripts/test/` 或保留并登记；`unit-call-stats`(296) → `stats/`；`unit-pipeline`(203) → `pipeline/`；`unit-workspace`(79) → `workspace/`；`integration/service-contract`(338) → **消费方编译夹具**（现为读源文本比对 marker，该文件在重写后消失）；`e2e/smoke`(3844 / 159 it) 按**导入面**分层；`test/helpers.ts`(161) 保留。

**失锚断言的改写口径**（必须在 B3 前写死）：`unit-manager2` 对内部字段的耦合（`.supervisors` 45 / `.middleware` 45 / `.catalogCache` 24 / `.runtimeRegistry` 7）逐条映射到新域的 `interface.ts` 能力或 `deps.ts` 端口；找不到落点的断言按 §10.3 标 C 级并进 B2 的「被删能力」对账清单，**不得静默删除**（判据强度零放宽）。

### 8.3 度量面同步（先修尺子）

| 面 | 现状 | 动作 |
|---|---|---|
| 变异段 | 6 段（entry/manager/middleware/routes/supervisor/runtime），测试面为包级一份 | 随域重画 mutate 清单：**事实源是 `scripts/data/mutation-topology.json`**（`stryker.conf.d/*` 由 `gen-stryker-conf` 派生，直接手改会被 `--check` 判红） |
| 变异面排除项 | `mutation-topology.json` → `packages["dsh-mcp-manager"].testLayers.coverageExcludes` 第 1 条：`!.../src/**/interface.ts`，`kind=facade` | 重估该条（落到 notifier 形态后 `interface.ts` 带 `installXxx/releaseXxx` 配对状态，是可变异逻辑）；**新增 `deps.ts` 的 `type-only` 条**（11 个纯类型面文件）。注意：该条**不在** `coverage.config.json`（覆盖率面只有 5 条 exclude，无 facade 条） |
| 覆盖率面 | `coverage.config.json` 的 include/`exclude` | 按新结构重估；`verify-coverage-scope` 守面完整性（条目命中 0 文件判红） |
| 变异 src 超集 | — | B0 把 `packages/dsh-mcp-manager/src/server/**/*.ts` 以**超集**形式纳入 mutate（旧 glob 保留，否则 src 全覆盖断言会先红） |
| 测试文件下限 | `--min 16` | 随新增文件上调（该下限是**文件数**棘轮，防 include 漂移；参照包 40） |
| `testLayers` 登记 | `unitExemptions` + `testMutationExemptions` 共 2 条 | 前者随搬迁重判，后者随源文本断言退役而删 |

### 8.4 测试卫生

| 项 | 现状 | 目标 |
|---|---|---|
| `// @ts-nocheck` | 普遍（`helpers.ts`、`unit-pipeline`、`unit-workspace` 等） | **清零**（参照包零命中） |
| 源文本哨兵断言 | `service-contract.test.ts` 读源文件比对 marker | 改消费方编译夹具；静态文本断言**仅限真实 ABI 与安全约束**（参照包仍留 3 处，未超限但非清零） |
| 恒真断言 | 未系统清理 | 逐文件过一遍：只断言「不抛错」的改写成对结果的断言 |
| 判据强度 | — | **零放宽**；确需删除须在同批显式登记待补（refactor skill §7 第 5 条） |

### 8.5 契约文档修正

`docs/architecture-contract.md` 的 T1 定义必须改为「单元层白盒直连 `src/server/<域>/impl/<块>/`」；C-DIR 表、D10 条目、阶段不变式（`apply-services.ts` 禁止移动）随本轮作废或重述。**真正需要重新裁定的是约 200 行**（全文 257 行，判死符号遍布），按「保留（行为契约）/ 作废（阶段与目录形态）/ 重述（T1 与导入面）」三分类打标：**B0 打标，B3 合并归档**。注：`C-*` 前缀小节实测只有 **6** 个（`C-ABT/C-CFG/C-DIR/C-DTO/C-ERR/C-EVT`），v4 写的「13 条」口径不可复现，以 6 条为准逐条裁定。

---

## 九、上下游契约

### 9.1 上游：我们依赖宿主

| 契约 | 内容 | 本轮动作 |
|---|---|---|
| 插件契约 | `name` / `inject` / `apply(ctx, config)` / `Config` schema | 不变（导出面快照锁定） |
| 宿主能力 | `ctx.tools.register`、`ctx.webServer.register`、`ctx.systemPrompt.section`、`ctx.logger`、`ctx.on`、`ctx.effect`、`ctx.inject(["settings"])`、`ctx.sessions`、`ctx.provide` | **收窄**：全部经 `bindHost` 变成能力面（I1） |
| 宿主类型层 | catalog 锁版 `\@deepseek-ai/*`，仅 `import type` | 不变 |

### 9.2 下游：谁依赖我们

| 面 | 契约 | 纪律 |
|---|---|---|
| 模型面 | `mcp__<server>__<tool>` 注册名 + `ws_mcp_*` 四原子 + `pre-execute` guard | 名清单点（I11）；两套键口径（查询出口裸名 / `getTools` 注册名）必须文档化 |
| 兄弟插件 | `ctx.mcpManager` 服务面（登记 / 控制 / 查询）+ `registerServer` 运行时注入 + **`apiVersion`** | 服务名单点；类型从包入口导出；**`getTools` 与查询出口同源**（D4），ABI 变更按 §10.2 登记 |
| 浏览器前端 | `/api/dsh-mcp/*`（loopback 围栏，403 先于 405）+ SSE 帧集合 `{summary, ui-config-changed, ping}`（零负载 + 客户端回拉 + 60s watchdog） | 帧名与 DTO 在 `src/shared/` 单点；六态键集合冻结（物理位置本轮迁移） |
| 磁盘 | `config.json` / `user-state.json` / `catalog/<hash>.json` / `catalog-summary.json` / `stats.json` / `version`；项目级 `<项目根>/.dsh/mcp.json`；自定义 `storePath` / `statsFile` 以用户值为准 | 布局单源 + 迁移独占一域（I7）。**不新增 status.json`**（内存态 + SSE 零负载回拉已闭环） |
| 安全面 | 凭据不出境（§6）；stdio 子进程环境净化；`config.json` 保持 `0o600`，其余按 §7.1 表 | README 安全模型与实现同 PR 更新；**不再有「登记为已知缺陷」的出口** |

### 9.3 侧向：仓库共享层

| 模块 | 种类 | 消费者（实测） | 处置 |
|---|---|---|---|
| `loopback` / `placement-math` | 函数/值 | 2 | 合规保留 |
| `settings-namespace` | 函数/值 | 3 | 合规；登记快照修正（登记 4 实际 3） |
| `client/i18n` | 函数/值 | 3 | 合规；登记快照修正（登记 2 实际 3） |
| `host-utils` / `dsh-home` / `client/ensure-style` | 函数/值 | 4 | 合规 |
| `frontmatter` | 函数/值 | **0** | 挂 DEPRECATED，走废弃两步走 |
| `mcp-manager-service.d.ts` | **类型** | **1** | **退回包内**：类型定义住 `src/shared/service.ts`（D5）；`declare module` 写在包入口 `src/index.ts`（参照包 `src/index.ts:72-77` 注释原文「必须写在包入口」，键用 `as const` 常量引用） |
| 包内 `server/shared/` | — | 按域计数 | 不再新增仓库级 `shared/file-io`（该路径已取消） |

---

## 十、行为变更与等价性证据

### 10.1 保留 / 不保留边界（替代 v4 的绝对化 N12）

**保留（用户可见 / 跨插件 / 磁盘）**：① 存储布局迁移语义（含降级不兼容的 release note）；② HTTP 路由集合与 loopback 围栏（403 先于 405）；③ SSE 帧集合与零负载回拉 + 60s watchdog；④ `ctx.mcpManager` 的方法名与签名（除 D4 显式登记的 `getTools` 同源修正与 `apiVersion` 新增）；⑤ `config.json` 的 `0o600`。

**不保留（内部，且现状是缺陷）**：① 凭据出境口径（§6）；② `getTools` 的取数源（D4）；③ 命名双份（`summary()` 与 `summarize()` 收敛为一个对外名，实现名可私有）；④ 内部符号的导出位置（I4）；⑤ 注释与文档形态（I12）。

### 10.2 交付形态（照搬 notifier 两件）

1. **commit 正文**：【公共 API 行为变更登记】块——变更点逐条 / **零变更面**（逐值声明哪些路径不变）/ **回落策略** / 授权出处。
2. **release notes**：编号节（用户可感知的存储迁移 + 凭据出境变化 + 开发者面的 `apiVersion` 退役清单与影响分档）。

### 10.3 等价性证据分级（交付里必须标级）

| 级 | 手段 | 适用面 |
|---|---|---|
| **A 差分实测** | 旧新实现喂同一组输入比较输出 | 纯函数族（`pipeline/*`、`workspace/*`、`config/model/*`、`catalog/digest`） |
| **B 定向变异** | 改坏新实现那一行，确认只有用到它的用例红 | 抽出来的每个助手 |
| **C 读代码论证** | 写清「升到 A 级还缺什么」 | 装配顺序、生命周期 |

**整模块重写的面差分无效**：`manager.ts`(1208) / `middleware.ts`(837) / `middleware-register.ts`(842) / `routes-controllers.ts`(400) 只做**基线源码级逐条对账 + 定向变异**。实证：一次 1073 组 A 级差分全绿的按域重写，仍漏掉 4 项已实现能力被静默删除，两轮专家审计都没抓到；参照包为此专门发过一笔「恢复被静默删掉的四项能力」。

**证据要落仓库可复跑**（参照包的妥协点，本包不照搬）：差分脚本与对账表放 `scripts/`（登记进 `scripts/README.md` 索引），不放 gitignore 的草稿目录。

---

## 十一、这次不做什么（non-goals）

| # | 不做 | 理由 |
|---|---|---|
| N1 | 不重构 `src/client/**` 的**结构**（归 #769）；允许最小文案改动与取数路径改为引用 `src/shared` | 本轮责任面是宿主端与跨端**契约**的物理位置 |
| N2 | 不新增 workflow 与门禁工具；**允许扩展既有脚本**（I8 / §5.3 判据）与更新既有登记文件（`gate-scope-registry` / `ci-face-registry` / `mutation-topology` / `coverage.config` / `ci.yml` 的包面 glob） | 门禁随设计走（D7）；不新增工具链 |
| N3 | 不改 `ctx.mcpManager` 的方法名与签名（除 D4 显式登记项） | 跨插件 ABI |
| N4 | 不动仓库 `shared/` 其它模块与相对路径引用方式；不新增仓库级 `shared/file-io` | IO 原语由 `atomically` 承接（§7.5） |
| N5 | 不改线协议**语义**（帧集合、六态计数含义、403 先于 405）；物理位置移到 `src/shared` 属结构变更 | 契约冻结 |
| N6 | 不改 `.dsh/mcp.json`（项目级配置）的路径与格式 | 随项目走、可提交 git，是本插件唯一用户资产路径 |
| N7 | 不为数字拆函数、不做与插件无关的通用工具库、不发运行时依赖 | 仓规与 refactor skill |
| N8 | 不引入 `picomatch` / `p-retry` / `lru-cache` / `dotenv-expand` / SSE 服务端 hub；已知 secret 脱敏仍自写 | 语义变更或不符合分发模型（附录 B.3） |

---

## 十二、迁移批次（4 批）

> **PR 切分**：PR-1 = **B0**（契约冻结 + 门禁接线，必须早于第一个结构 commit）；PR-2 = **B1–B3**。硬约束：**每个 commit 只做一件事**（搬移或改行为），行为变更按 §10.2 登记。
>
> **登记面与结构同提交**（参照教训：notifier 的 76 个未覆盖文件红与导出面红各自悬了一整个窗口期）：每个批次的验收必须包含 `pnpm gate:pr` 全绿 + 该批涉及的**全部登记文件**同步（baseline / faces / `gate-scope-registry` / `ci-face-registry` / `mutation-topology` / `coverage.config` / `dir-imports-baseline`）。

| 批 | 内容 | 验收（每条都要 exit code） |
|---|---|---|
| **B0 契约与接线** | ①目标公共面清单（三面分类，逐符号）写进方案/文档；②`architecture-contract.md` 三分类打标；③**用重构前那棵树生成** `scripts/data/dsh-mcp-manager-export-surface.json` + 手写 `-export-faces.json`（`legacy` = 当前主入口导出全集）；④门禁接线：`contract-check.ts` 加 mcp、`gate-scope-registry.json`（`export-surface-snapshot` 扩 mcp + `forbid-module-state-src` 扩 mcp）、`ci-face-registry.json` 两条数据文件条目、`ci.yml` 的 `dsh-mcp-manager` 面加 `scripts/data/dsh-mcp-manager-*.json` glob（**红线，随本方案 approved**）；⑤`mutation-topology.json`：`src/server/**` 超集段 + facade 重估 + `deps.ts` 的 `type-only` 条、`coverage.config.json` 重估；⑥I8 判据上线（脚本扩展 + 自测 + 数据面范围 + 3 条跨包豁免带 tracking issue）；⑦`locales.ts` 两行文案降级 + 「客户端产物不含 `~/.dsh`」断言；⑧`--min` 上调 | `pnpm gate:pr` 全绿；`export-surface-snapshot --package dsh-mcp-manager` **exit 0**；`--graph` 基线与当前一致；新判据正反 fixture 双向断言；`test:scripts` 绿（含 `gate-scope-registry.test.ts` / `ci-face-coverage.test.ts`） |
| **B1 骨架与迁移** | `src/server/` 目录 + 各域 `interface.ts` / `deps.ts` 骨架 + 组合根（`bindHost` / `assemble` / 逆序释放 / 声明合并）+ `upgrade` 六件套 + `paths.ts` 单源（含 mode 表）+ `src/shared/` 五文件 + IO 原语（`atomically`） | 探针证明链路通（apply → install → release 各域标记复位）；迁移测试**五态**；`version` 刻度推进与失败不推进；`pack:check` 对 mcp 判绿 + `THIRD-PARTY-LICENSES` 含 `atomically` / `stubborn-fs` / `stubborn-utils` / `when-exit` |
| **B2 域重写** | 叶子域（`store/stats/pipeline/config/workspace`）→ 中枢域（`connection/catalog/inject`）→ 出口域（`api/sdk`）；`McpManager` 逐块搬空；**同期完成** D3（凭据单链）、D4（查询出口同源 + `apiVersion`）、D5（跨端引用改 `src/shared`）；删除 `bootstrap/` | 域间**值边 = 0**、值环归零（`--graph`）；投影/脱敏构造点 = 1；基线源码级逐条对账表（四文件）+ 定向变异；`crap` 无新增超阈热点；每个行为变更带 §10.2 登记 |
| **B3 收口** | 测试按域落位 + I8 判据存量清零；**删除到位的那一个提交**里 `--snapshot` 重冻结导出面 + faces `legacy` 收缩到三面 + 逐符号说明；契约文档重写与包内 docs 清理（`docs/` 只留有效专项设计 + 归档）；README 中英 + release notes（存储迁移 + 凭据出境 + `apiVersion`）；注释收口 | `pnpm gate:full` 绿；`uncoveredSrcFiles` 全空；注释验收三条；`docs:check` 绿；导出面快照在**新树**上 exit 0 |

**commit 上限建议**：B0 ≤10、B1 ≤12、B2 ≤5/域、B3 ≤25；合计 ≤80。squash merge 下批次粒度只存在于分支，交付物（逐符号收缩表、对账表、exit code）必须落 PR 正文或持久文档。

---

## 十三、已知盲区与风险

| # | 风险 | 对冲 |
|---|---|---|
| R1 | **整模块重写静默丢能力**（§10.3 已实证） | 基线源码级逐条对账 + 组合根真实 Context 集成测试 + 能力清单随 PR 逐条勾 |
| R2 | 存储迁移的降级不兼容 | 写进 release notes；旧文件归档 `.migrated.bak`；迁移五态测试 |
| R3 | 权限被凭空改动 | §7.1 逐文件 mode 表 + **显式传值**（不依赖 `atomically` 的复制语义）+ 落盘权限断言 |
| R4 | 覆盖率 / 变异基线回落 | `covered >= baseline - 1pp`；迁移 PR 走夜间重建豁免；`uncoveredSrcFiles` 全空 |
| R5 | 复杂度热点搬家 | 先接缝后抽函数；`pnpm crap` 观察期记录；不为数字拆函数 |
| R6 | `declare module` 的 mcp 特例（现住 `integration/service.ts`，带 stryker sandbox 注释） | 移到包入口（参照包）；判据用 `pack:check` 声明合并可达性 |
| R7 | 客户端文案与 #769 交叉 | 本轮只做两行文案 + 取数路径引用 `src/shared`；结构改动留给 #769 |
| R8 | `interface.ts` 纳入变异面后分母上升 | B0 重估排除面；`verify-coverage-scope` 守面完整性；宁可如实降分 |
| R9 | 子 Agent 评审结论需交叉复核 | 每条结论附 `文件:行` 或命令输出；协调者一手复跑 |
| R10 | **I8 判据上线会碰其他包** | 存量 3 处走 `gate-exemptions.json` + tracking issue；本包 13 处单调基线 |
| R11 | **`atomically` 的依赖链（4 包）与 `when-exit` 的退出钩子** | 许可归集自动覆盖；B1 验收含 `pack:check` 与 `THIRD-PARTY-LICENSES` 断言；`when-exit` 行为在 B1 探针里实测一次 |
| R12 | 本包既决缺陷（#770 13 项）里有 5 项与边界同源 | §6 本轮修完凭据面；其余按 §10.2 逐条登记「本轮改 / 不改」 |

---

## 附录 A 决策记录

见 §零 的 D1–D8 表。补充三条口径：

1. **红线授权**：`.github/` 改动 + 新增第三方依赖（`atomically` / `fast-redact`）+ 公共 API 行为变更（§6 / §10.1）由一次 #767 `approved` 覆盖；不引用 `yaml`（#781）的无 approved 先例。
2. **不做 shim**：无过渡 re-export 层，故 B3 只做一次基线重冻结。
3. **API 版本位**：`ctx.mcpManager` 增 `apiVersion` 字面量（本包首个版本位），退役 / 变更项在 release notes 逐条列出。

## 附录 B notifier 对照表（本方案形态取舍的依据）

### B.1 逐项对照

| 维度 | notifier 终态（证据） | v5 采纳 |
|---|---|---|
| 域数 / deps.ts | 8 域 + 2 个 shared；8 个 `deps.ts`（7 域根 + `channels/impl/system/deps.ts`）；`channels` 零对上依赖不建 | 11 个域全建（每个至少消费宿主 logger）；零依赖域按判据不建并登记 |
| 跨域值边 | **0**（7 条值边全指向 `shared/`；跨域全为类型边） | I2 写成判据：域间矩阵不得出现值边（shared 除外） |
| 组合根 | 306 行：`bindHost` / `assemble` / 逆序释放 / 计算属性名声明合并 | 照搬 |
| 导出面 | **4 个**符号；`./client` 2 个 | 目标 = 三面（安装 / 配置 / 契约），逐符号清单在 B0 冻结 |
| 基线时序 | `2370774`（`git archive` 重构前树，早 2 天）→ `8df3950`（分支第 31/102 commit，100 → 4，`--snapshot` + faces 同步 + mutate 段重画 + 未覆盖文件修正**同一笔**） | B0 冻结；B3 的「删除提交」内一次重冻结 + 逐符号说明 |
| shim | #669 用（29 行 re-export 桶）；#733 不用（首笔 commit 直接砍到 4 个） | 不用 |
| 脱敏 | 唯一脱敏器 + 唯一字段清单 + 掩码按 id 往返 + 无原值 fail-closed；**同类型值替换，不做 DTO 类型分离** | 照搬形态；本包额外把「声明面本来就不含凭据」的 DTO 真正构造出来（类型即围栏） |
| ABI | `apiVersion: 2` 字面量 + 重写同期退役 + release notes 第 6 节分档 | 照搬（`getTools` 同源 + `apiVersion`） |
| 行为变更登记 | commit 正文【公共 API 行为变更登记】块 + release notes 编号节 | 照搬两种形态 |
| 升级六件套 | 步骤表 / 链 / 刻度 / 失败语义 / 对账 / 装配标记 | 照搬（本包只一步迁移） |
| mode | `paths.ts` **无 mode**；`file-io` 无 mode 参数；唯一权限断言在运行期临时音频 | **本包新增决定**：`path + mode` 进 `paths.ts` + 显式传值 + 逐文件断言 |
| 契约文档 | 仓库级 `docs/architecture/dsh-notifier.md`（在重写 PR 内整体重写）；包内 docs 删 16 文件 / 15195 行，只留专项设计 + `archive/` | 照搬（B3） |
| 注释 | 只删复述结构 / 签名 / 指向已删符号；理由类一句不减（判据 = 读者不再被误导） | 照搬（I12 + 三条验收） |
| 测试下限 | `--min 40`（**文件数**棘轮） | B0 上调 |
| 测试导入面 | **无判据**（约定）；integration 至今 `await import("../../src/index.ts")` | **加强**（I8 判据上线，D6） |
| 跨端 | `src/shared/` 只放跨端值 + 转出门面；DTO 散在 server 侧且 client `import type` 直引（无判据） | **加强**（跨端全进 `src/shared/` + client import 判据，D5 / §5.3） |

### B.2 v4 对 notifier 的引用纠错

| v4 写的 | 实测 |
|---|---|
| deps.ts「7 / 9 域（无对上依赖的两域不建）」 | 实际 **8 个** `deps.ts`（7 域根 + 1 块内），只有 `channels` 一个域无域级 `deps.ts` |
| 判据「需要装配期才能确定的能力 / 实例才建」→ 6 有 / 5 无 | 判据是「**有对上依赖（他域或宿主能力）就建**」；反证 `config/deps.ts`（11 行、唯一成员宿主 logger 端口） |
| 「六态表跨端共用本轮不可达」 | `tones.ts` 即跨端值单源先例 → 可达（D5 已决） |
| 引 notifier `file-io.ts` 作 mode 缺省语义参照 | 它**没有 mode**，不能作参照 |

### B.3 评估后不替换的成熟实现（备查）

`picomatch`（glob 语义变更）、`p-retry`（本包只算延迟不跑重试循环）、`lru-cache`（BlueOak-1.0.0 + 2.7MB）、`dotenv-expand`（语义更复杂）、`eventsource-parser`（客户端解析器，非服务端 hub）、semver（自实现逐段比较）。**文本出口的 known-secret 脱敏**业界无标准库（DLP / 网关层能力），保留自写。

## 附录 C v4 复核发现的处置

v4 经四方复核（主控一手 + 三视角子 Agent）共提出 **3 条 P0 / 13 条 P1 / 约 20 条 P2**。按 v5 立场归位：

| 类别 | 条数 | 处置 |
|---|---|---|
| **因立场改变而在设计上消失** | 约 13 | P4 的 shim 与「导出面改口径」（D1 / D2 取消该动作）；P5 残留的 `testFiles` 策展与导入面清零（§8.3 / N2 重写）；`fast-redact` 无消费者（D3 使其立即有消费者）；A8 与 A14 互斥（D5 定死）；A13 原样搬移（D4 反转）；I10 的 J1 / J2 拆分（单链落地后是一条判据）；附录与 D 表口径不一致（v5 重写） |
| **仍需修（已在 v5 内修）** | 3 | P0③ 指错文件 → §8.3 明确 `mutation-topology.json`；`ci.yml` 数据面 glob 与两处登记 → B0④；`deps.ts` 面登记漏项 → §8.3 |
| **数字与行号卫生（v5 已核）** | 约 10 | 14800 → 14635（+helpers 161）；`RoutesManager` 24 / 5 → 23 / 8；`routes-controllers` 24 → 18；`smoke` 6 行号 → 9 处；`summary` / `summarize` 命名；`config-schema` / `host-faces` / `constants` / `statsFile` 等陈旧行号；`C-*` 13 → 6；`deps.ts`「0 / 14 域」→ 11 域 |
| **流程项** | 2 | v5 文档入库；I8 与 `ci.yml` 属红线，随 #767 一次 approved |

## 附录 D 交接状态

- **环境**：主 checkout `/mnt/ssd/dev/dsh-plugin-hub`（HEAD `b490e87`，**未改动**）；方案 worktree `/mnt/ssd/worktree/dsh-plugin-hub-task-767-arch-v4`（分支 `task/767-arch-v4`）。
- **交付物**：本文件（v5）+ `architecture-redesign-v4.md`（被取代，B3 归档时清理）。
- **状态**：v5 已按 D1–D8 定稿；**代码一行未动**（等 `approved`）。
- **下一步**：①本方案落 #767 评论（`needs-proposal-review`）；②维护者 `approved`（覆盖 `.github/`、新增依赖、公共 API 行为变更）；③实施 B0 → B1 → B2 → B3，每批验收含 exit code 与该批全部登记文件同步。
- **未决**：无（D1–D8 已全部裁定；附录 B.2 的三处对照数字纠错已并入 v5）。
