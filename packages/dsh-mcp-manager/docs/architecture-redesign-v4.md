# dsh-mcp-manager 架构重构方案 v4（目标架构与迁移计划）

> 关联：issue #767（本方案落地载体）、#773（0.2.5 排期与进度入口）、#770（遗留缺陷归拢载体）、
> #664（上一轮分层重构，已合并）、docs/ARCHITECTURE-METHOD.md（方法论事实源）、
> .dsh/skills/dsh-plugin-hub-refactor/SKILL.md（执行清单）。
>
> **定位**：本文件取代 packages/dsh-mcp-manager/docs/architecture-redesign.md（v3，已完成 #664 阶段 0-8）。
> v3 的成果（目录分层 + 每目录 interface.ts 门面 + 测试三层登记）保留；本文件定义其**未完成部分**：
> 依赖边界、中枢解体、存储布局、测试面导入面矩阵。
>
> **口径**：文中存量数字均来自实测，四要素为「commit + 脚本 + 粒度 + 计数单位」，逐条标注。
> 基线 commit 为主 checkout `b490e87`（v0.2.4 发布点）；若与最新 main 有行号偏差，以符号名为准。

---

> 历史注（#767 DOC-A）：本文是 #767 的 v4 方案稿（已被 v5 取代），正文冻结不再改真；现行事实以包实现为准。

## 一、为什么还要再重构一次

### 1.1 上一轮做到了什么

#664 阶段 0-8 完成的是「目录分层 + 门面收口」：

| 维度 | 实测值（脚本：scripts/gate/verify-dir-imports.mjs --package dsh-mcp-manager --graph；粒度：叶子模块） |
|---|---|
| 叶子模块（含 interface.ts 的目录） | 14 |
| 参与规则扫描的 src 文件 | 63（src 下 TS 文件共 78） |
| 跨模块引用 | 134 条，全部落到目标的 interface.ts |
| 模块级值边 | 33 条 |
| missingInterface（目标目录缺门面） | 0 |
| 客户端分层 | src/client/{core,float,settings} 已成形态 |

### 1.2 还差什么

同一次实测的其余数字，正是本方案要处理的：

| 判据 | dsh-mcp-manager | dsh-notifier（同仓已落地的目标形态） |
|---|---|---|
| 叶子模块级值环 | **4** | 0 |
| 文件级值环 | **4** | 0 |
| 规则 2 直引实现文件（directImpl） | **1** | 0 |
| deps.ts（依赖注入面）数量 | **0 / 14 域** | 7 / 9 域（无对上依赖的两域不建） |
| 宿主端最大单文件 | 1208 行（McpManager，43 成员 / 19 可变字段） | 699 行（config/impl/input，职责单一） |
| 组合根 | `src/index.ts` 231 行**纯 re-export 桶**；装配散在 `bootstrap/` 5 文件 | `src/index.ts` 306 行：bindHost 收窄 + assemble 顺序 + 逆序释放 |

四条模块级值环（`verify-dir-imports --graph`，基线 scripts/data/dir-imports-baseline.json 的 quality 段）：

```
config/model → catalog → connection → connection/orchestrator → config/model
connection → connection/orchestrator → connection/runtime → connection
catalog → connection → connection/orchestrator → connection/runtime → catalog
catalog → connection → connection/orchestrator → catalog
```

四条文件级值环里，`connection/orchestrator/interface.ts → manager.ts → interface.ts` 是教科书式自环。
它的存在方式写在 `src/connection/interface.ts` 的头注释里——为了绕开环，门面被特例化：

> stripMcpPrefix 直连 orchestrator/tool-names（纯函数）而非 orchestrator/interface.ts：后者聚合 McpManager
> 值导出会拉入 manager.ts → config/model（config-schema）反向依赖 connection → manager 的模块初始化环（TDZ）。
> McpManager 类由 src/index.ts 经 orchestrator/interface.ts 直接取（汇聚点特例）。

这正是 ARCHITECTURE-METHOD §1 原则 4 描述的形态：**环在文件级存在，模块粒度门禁看不见，于是用特例绕过**。

### 1.3 根因：边界画在同一个对象上

McpManager 同时是三个「最小面」的被依赖方（`src/types/host-faces.ts`）：

- `SupervisorLite` / `ManagerLite`：supervisor 从它取 tools/logger/enhancement/emitStatus/recordCatalogTools/stats
- `MiddlewareHost`：中间层从它取 projectServersFor/globalServers/normalizedProjectRoot/saveUserState/emitStatus/catalogCachePath/isGlobalServer/isRuntimeServer
- `RoutesManager`：路由从它取 24 个成员（含 5 个可选成员 setToolDisabled?/setMiddlewareMode?/resumeReconnect?/uiUpdate?/sseHub?）

也就是说：**连接域、中间层、API 面、服务面、目录域的边界都交在同一个类上**。只要它还在，`deps.ts` 只能声明出一个大而全的 Port——那只是把 host-faces.ts 换个文件名，环也拆不干净（4 条环里 2 条直接穿过 manager.ts）。

### 1.4 上一轮的测试面把违反方法论的做法写进了契约

实测（`grep -oE 'await import\\([^)]*\\)' test/**/*.test.ts | sort | uniq -c`）：

| 被测导入方式 | 文件数 |
|---|---|
| `await import("../../src/index.ts")`（组合根汇聚面） | 13 |
| `await import("../../lib/index.js")`（产物） | 1（e2e/smoke） |
| 静态 `from "../../src/index.ts"` | 1（unit-manager） |

对照 notifier：单元测试一律 `import ... from "../../../src/server/<域>/impl/<块>/index.ts"`（白盒直连实现文件）。

而 `docs/architecture-contract.md` §3.1 的 T1 定义原文是「模块公开符号（经 `lib/index.js` re-export **或目录 interface.ts**）」——
ARCHITECTURE-METHOD §6 点名的反模式（「测试从产物入口导入 = 把内部符号钉死在公共 API 上」）被写成了本包契约。
它同时解释了 `src/index.ts` 那个 231 行纯 re-export 桶的主要消费者是谁：**测试**。

## 二、架构宪法（12 条不变式，每条配机器判据）

> 立宪原则来自 ARCHITECTURE-METHOD §1 第 4 条：**未被机器强制的约束等于不存在**。
> 每条判据必须落到既有门禁（`pnpm contract` 段）或新增脚本断言上；挂不进机器判据的条目，写进本表即为待办。

### I1 宿主上下文只到组合根

- **不变式**：`src/server/**` 的任何域都拿不到 cordis 的 `Context`。组合根把 `ctx` 收窄成各域要用的**能力面**（logger / 路由注册口 / 事件订阅口 / 服务出口 / settings 读面），域只声明「我要什么能力」。
- **判据**：`src/server/**` 不得出现 `import type { Context }` 或 `import { Context }`。**白名单两处**：组合根 `src/index.ts`、以及能力类型定义处（`src/server/shared/host-faces.ts` 与各域 `deps.ts` 里作为 `Pick<Context, …>` 出现的能力面）。域签名里不出现 `ctx` 变量。**注意 `inject` 域合法需要「工具注册口」与「事件订阅口」两类能力**（现状 `inject/middleware-register.ts:735/779` 用 `ctx.on("agent/pre-step")`）——它们经 `bindHost` 收窄后传入，不是删掉。另：`workspace/root-resolution.ts:13` 与 `catalog/cache-view.ts` 现经 `import type { McpManager }` 隐式依赖连接域，值判据看不见——目标形态改由 `deps.ts` 声明 `resolveRoot` 能力。
- **现状**：违反。`new McpManager(ctx, store)` 把整个 Context 穿透进域，域内直接使用 `ctx.tools` / `ctx.on` / `ctx.effect` / `ctx.inject` / `ctx.get` / `ctx.sessions`（实测 10 处 types 面 + 6 处实参）。

### I2 跨域运行时能力一律经 deps.ts 注入

- **不变式**：域之间不互相引用实现文件，也不通过上下文穿透取对方的东西。消费侧在自己的 `deps.ts` 里用 `Pick` 声明所需能力，按提供方分组；组合根递**提供方的命名空间对象**。
- **判据**：`verify-dir-imports --graph` 的 `implToOtherImpl = 0`、叶子模块值环 = 0、文件级值环 = 0；`deps.ts` 死声明 = 0、`deps.ts` 值 import = 0（后者已硬判红）。
- **现状**：违反。0 个 `deps.ts`；4 + 4 条值环；1 条 `directImpl`（`connection/interface.ts → connection/orchestrator/tool-names.ts`）。

### I3 同一判定只有一个物理定义

- **不变式**：脱敏、策略裁决、工具命名、状态投影，每一件事只有一个定义处。别处要用，取能力而不是抄规则。
- **判据**：清单式断言 + 定向测试。首批三张清单：①脱敏集合来源（**基线 b490e87 实测为 4 个 `createRedactor` 构造点**：`connection/runtime/middleware.ts:452`（`redact`）、`connection/runtime/middleware.ts:783`（`hostRedact`）、`connection/runtime/supervisor.ts:433`、`connection/orchestrator/manager.ts:209`；其中 manager 那份的集合 = 全局 store + runtimeRegistry，**不含项目级 servers**——已知盲区，登记 #770 第 8 项。原稿写的 `middleware.ts:391`/`manager.ts:194`/`supervisor.ts:369` 取自 9dc7492，在声明的基线上不指向脱敏代码，属行号漂移）；②`mcp__` 反解与禁用表键规则（现为两处：`inject/middleware-register.ts` 的 guard 反解 vs `connection/orchestrator/tool-names.ts`）；③策略拒绝文案（guard 侧缺后缀，`inject/middleware-register.ts` vs `connection/runtime/middleware.ts`）。
- **现状**：违反（#770 第 8/9/10 项）。本方案的处理口径见 §9.2：**结构性单点化、可观察行为不变**。

### I4 导出面尽可能小，且每个导出都有域外消费者

- **不变式**：域的 `interface.ts` 只承诺该域对外真正被消费的东西；包导出面按三层裁定（安装面 / 配置面 / 契约面），不属于三类的内部符号不入包入口。
- **判据**：①既有 `export-surface-snapshot` 零漂移 + 三层分类准入；②**新增**：`interface.ts` 的每个具名导出必须至少有一个域外消费者。**口径必须写明**：组合根 `src/index.ts` 与包入口 re-export **计入域外消费者**（各域 `installXxx/releaseXxx` 的唯一消费者就是它）；仅被本域 `impl` 与测试使用的导出判红。若把组合根排除，参照包 notifier 会一次判红 30+ 条。**协调者实测**：按 import 解析（含 namespace），mcp 现状 145 个门面导出里只有 **3** 个无消费者（`api/interface.ts: queryParam`、`connection/interface.ts` 与 `connection/orchestrator/interface.ts: stripMcpPrefix`），且这 3 个正是 §1.2 描述的「为绕 TDZ 特例化门面」的产物——判据的现状列应据此改写（初稿写成了 host-faces 的可选成员，性质不同）。
- **现状**：部分违反。`types/host-faces.ts` 的 4 个面共 40+ 成员，其中 `RoutesManager` 的 24 个成员里有 5 个是「可能不存在」的可选成员。

### I5 共享层按符号种类准入

- **不变式**：类型面（type-only）门槛 3，函数与值面门槛 2；包内 `server/shared/` 以**域**为计数单位，仓库 `shared/` 以**插件**为计数单位。单一消费者留包内；跨包设施必须登记消费者与行为契约。
- **判据**：`shared/README.md` 的登记快照须与实测一致（`grep -rl "shared/<name>\\.js" packages/*/src`），差异判红；包内 `server/shared/` 新增文件须写出消费者域清单。
- **现状**：登记已腐化（实测：`loopback` 登记 4 实际 2；`settings-namespace` 登记 4 实际 3；`client/i18n` 登记 2 实际 3；`frontmatter` 登记「现生产已退役」实际 0 但未走废弃两步走）。按新线重新裁定后：`loopback`(2)/`placement-math`(2) 为函数值面，门槛 2，**合规**；`frontmatter`(0) 应废弃；`mcp-manager-service.d.ts` 为类型面、1 个消费者，不达标。

### I6 未装配即抛错，不写静默降级

- **不变式**：「没装配」与「装配了一个空实现」必须可区分。可选成员（`method?:`）只用于**调用方语义上真的可选**的场合，不用于掩盖装配缺失。
- **判据**：`src/server/**/deps.ts` 的 Port 成员不得出现 `?:`；域内不得对**经 deps 注入的成员**做存在性守卫，三种形态全禁：`typeof x.method !== "function"`、`x.method === undefined` 早退、`x.method?.(…)` 可选调用。实测现状命中：`apply-services.ts:25`、`apply.ts:101`、`apply-runtime.ts:139/146`、`apply-config.ts:106/125`、`middleware-register.ts:174/311/317`（`stats?.isEnabled()`）。真正的可选语义只能写在 `deps.ts` 类型里并注明理由。
- **现状**：违反。`RoutesManager` 的 5 个可选成员（`setToolDisabled?`/`setMiddlewareMode?`/`resumeReconnect?`/`uiUpdate?`/`sseHub?`）、`apply-services.ts` 的 `provide` 探测（「fake ctx 可能无 provide，可选调用静默降级」）、`apply.ts` 的 `as unknown as`（#770 第 14 项）。

### I7 存储布局是单一事实源，迁移独占一个域且装配最前

- **不变式**：文件名是**迁移契约**，只允许在 `paths` 单源里定义；「旧文件在哪」与「新文件在哪」在同一处声明。迁移在各域装配之前跑，幂等、失败不回写进度刻度。业务域不认识旧格式。
- **判据**：`src/server/shared/paths.ts` 是文件名字面量的唯一出处（grep 断言）；`upgrade` 域的 `impl/steps` 是旧路径字面量的唯一出处；迁移测试覆盖「有旧文件 / 无旧文件 / 目标已存在 / 读失败」四态。
- **现状**：违反。5 类文件散在 `DSH_HOME` 根：`dsh-mcp.json`、`dsh-mcp-user-state.json`、`dsh-mcp-catalog/<hash>.json`、`dsh-mcp-catalog.json`（单文件摘要缓存，`src/catalog/cache-view.ts:27`）、`mcp-stats.json`（连前缀都没有）；无 `version` 刻度、无迁移机制。

### I8 测试分层由导入面定义，不由文件名前缀定义

- **不变式**：单元层只 import `src/server/<域>/impl/<块>/` 内的文件；契约层只 import 域 `interface.ts` / `deps.ts` 与跨端线协议；集成层经包产物入口 + `apply()`。文件名与目录是导入面的投影，不是判据本身。
- **判据：本轮不设机器判据**（A11 已决：**测试导入暂不限制**）——降级为**约定 + PR 评审清单**（`test/unit/<域>/**` 白盒直连 `impl/`；`test/e2e/**` 只 import 产物入口；`test/integration/**` 只经 `interface.ts`/`deps.ts`）。**补门禁的打算留痕**：跟踪 issue 待建（本方案批准后由维护者决定是否立）。选此路的代价必须写明——它与 ARCHITECTURE-METHOD §1 原则 4「未被机器强制的约束等于不存在」、§8「分层必须可机器校验」相抵触，故本条**不写成「不变式 + 判据」形式**，避免造出一条永远不被强制的条款。
- **现状**：违反（见 §1.4）。13 个单元测试经 `src/index.ts`，且 `architecture-contract.md` §3.1 把该形态写成了 T1 契约。

### I9 零模块级可变状态

- **不变式**：宿主端状态一律收进实例或闭包；模块级只允许常量表。
- **判据**：既有门禁 `scripts/gate/forbid-module-state-src.mjs`（本包当前 0 命中）。
- **现状**：达标，重写期须保持。

### I10 状态与错误出口单链

- **不变式**：状态变更只有一个出口（`emitStatus` → summary 帧，零负载 + 客户端回拉）；错误文案是稳定测试面（声明「无业务错误码，文案即契约」），HTTP body 与日志同口径脱敏。
- **判据**：**拆两条，状态不同**。**J1（现在可绿）**：契约测试断言两帧触发源集合（summary = 状态变更；ui-config-changed = settings onChange，独立链不 coalesce）。**J2（pending #770，本轮不启用绝对值断言）**：「伪造含 URL 凭据的错误 → HTTP body 与日志两侧都脱敏」。J2 本轮改用**单调基线的证据集合**口径：在包级契约测试（`test/integration/redaction-exits.test.ts`，不新增门禁工具、不撞 N9/N10）登记 §7.4 的六条出口清单——**新增出口判红、出口消失即改善并强制更新清单**；#770 第 1/7 项修复批次清空清单后，才启用 J2 的绝对值断言。
- **现状**：J1 可绿；J2 不达标——**六条出口**（§7.4，第二轮评审实证不是四条）。若按初稿把 J2 写成无条件硬判据，P0 会当场不可能绿（P0 验收写的是 `gate:pr` 全绿，而 P0 正是加判据的批次）。

### I11 ABI 名只有一个物理定义

- **不变式**：服务名、工具名前缀（`mcp__`）、路由常量、SSE 帧名，都以 `as const` 常量定义一次，声明合并用计算属性名引用。
- **判据**：`pack:check` 的「声明合并可达性」判据（`lib/index.d.ts` 的相对 import 闭包内必须有 `declare module "@deepseek-ai/cordis"`）+ 字面量重复的 grep 断言。
- **现状**：部分达标。服务名 `"mcpManager"` 在 `apply-services.ts` 与 `integration/service.ts` 各出现一次；`declare module` 现住 `integration/service.ts`（该文件有 stryker sandbox 相关的历史注释，重写时须重新解一次）。

### I12 文档与实现同源，注释不复述结构

- **不变式**：契约文档的每条判据必须与门禁实现同源；注释只写「为什么」，不写「怎么做」，不pointer 已删除的符号。
- **判据**：`docs:check`；重写后逐文件自查三条（没有复述签名的注释、没有指向已删除符号的注释、没有整段注释掉的旧实现）。
- **现状**：违反。`architecture-contract.md` §3.1 的 T1 定义与 ARCHITECTURE-METHOD §8 冲突；`connection/interface.ts` 的头注释记录的是「为绕环而设的特例」，重写后该注释的主语消失。

---

## 三、目标形态：目录结构、载体职责、中枢解体

### 3.1 目标目录结构

形态与 `packages/dsh-notifier/src` 对齐（同仓唯一已完成「按域重写」的样板，PR #777：101 commits / 602 files / notifier 侧 223 files）：

```
packages/dsh-mcp-manager/src/
  index.ts                    组合根：bindHost(收窄 ctx) + assemble(顺序装配) + 逆序释放
                              + declare module 声明合并 + 包导出面（唯一汇聚点）
  server/
    shared/                   包内共享层（叶子，不依赖任何域）
      interface.ts            门面：类型 ≥3 域消费 / 函数与值 ≥2 域消费才准入（宪法 I5）
      paths.ts                存储布局单一事实源（迁移契约，宪法 I7）
      file-io.ts              原子写 / 容错读原语（A9：包内先落；mode 参数化，缺省语义见 A2）
      host-faces.ts           宿主能力面类型（I1 白名单点名的能力类型定义处）
      type.ts                 跨域 DTO 的类型（跨端面另见 src/shared/，见裁决点 A14）
    upgrade/                  { interface.ts, impl/{version, chain, steps, legacy} }
    store/                    { interface.ts, impl/{user-state, catalog-cache, stats-file, status} }
    stats/                    { interface.ts, impl/collector }
    pipeline/                 { interface.ts, impl/{args, msg, redact, timeout, authorize, project} }
    config/                   { interface.ts, impl/{model, input, ui} }
    workspace/                { interface.ts, deps.ts, impl/{root-resolution, full-name, scope, mode} }
    catalog/                  { interface.ts, deps.ts, impl/{entries, digest, history, injection, cache-view, search} }
    connection/
      interface.ts
      deps.ts
      impl/
        orchestrator/         { type.ts, index.ts }   连接编排：代际仲裁 / 双轨 reconcile / summary
        middleware/           { type.ts, index.ts }   中间层宿主：池 / 模式 / 热切换 / unit 生命周期
        supervisor/           { type.ts, index.ts }
        transport/            { type.ts, index.ts, stdio.ts, http.ts }
        protocol/             { type.ts, index.ts }
    inject/                   { interface.ts, deps.ts, impl/{register, guard, prompt} }
    api/                      { interface.ts, deps.ts, impl/{routes, controllers, sse-exit, health} }
    sdk/                      { interface.ts, deps.ts, impl/{service, registry} }
  shared/                     **跨端层**（A14 已决）：跨端 DTO 与线协议类型（六态键集合、SSE 帧名、DTO 形状），两端共用
  client/                     保持现状（core/float/settings），归 #769
```

三条形态规则（照搬 ARCHITECTURE-METHOD §2 与 refactor skill §1）：

1. **域目录只有三样东西**：`interface.ts`、`deps.ts`、`impl/`。`impl/` 根只放聚合器与跨块的值文件，实现住 `impl/<块>/`。
2. **判据是「需要装配期才能确定的能力/实例才建 `deps.ts`」，不是「有没有对上依赖」**。纯函数直接 import 对方 `interface.ts` 是**合法边**——`pipeline` 值引 `workspace` 的 4 个纯函数就属此类（实测 `pipeline/authorize.ts:11-16`），为它套一层注入才是过度设计。按此口径：**6 个域有 `deps.ts`**（workspace / catalog / connection / inject / api / sdk），**5 个没有**（upgrade / store / stats / pipeline / config）；`pipeline` 无 `deps.ts` 但**有**两条登记边（→ workspace 值、→ types 类型）。
3. **类型的物理定义在 `impl/` 的块里**，`interface.ts` 只 re-export。契约做收口，不做定义——两份定义迟早分叉。

### 3.2 载体职责

| 载体 | 职责 | 允许的依赖 |
|---|---|---|
| `src/index.ts`（组合根） | 收窄宿主上下文成各域窄面；按依赖顺序装配；注册生命周期并**逆序**释放；包导出面与声明合并 | 各域 `interface.ts`。**不写业务判断** |
| `<域>/interface.ts` | 本域对外承诺：DTO + 能力对象类型 + `installXxx(deps)` / `releaseXxx()` 配对 | 本域 impl；他域 `interface.ts` 的类型 |
| `<域>/deps.ts` | 声明「我要外部什么」：按提供方分组的 Port（`Pick` 收窄）；**纯类型面** | 他域 `interface.ts` |
| `<域>/impl/<块>/` | 实现；白盒直连的单元测试面 | 本域内 + 本域 `deps.ts` |
| `server/shared/` | 跨域、无归属、稳定的语言（路径单源 / 宿主能力类型 / 跨端 DTO） | 零依赖 |
| `client/` | 浏览器半区，经 HTTP + SSE 与宿主通信 | `shared/client/*` |

组合根三条纪律（照搬 notifier 的 `bindHost` / `assemble` / `safeDisposeAll` 形态）：

- 交付的是**能力**，不是算好的值。装配期取一次的快照会在用户改设置后失效，而它看起来与实时读取一模一样。
- **未装配的占位要抛错**（宪法 I6），fire-and-forget 出口例外（「没人听」与「没有出口」对它没有区别）。
- 装配与卸载**成对**，释放逆序，每个域复位自己的装配标记。不对称的后果是同进程第二次装配在某处抛错，而那看起来与该处以外的任何征兆都无关。

### 3.3 中枢解体：McpManager（1208 行 / 43 成员 / 19 可变字段）的归属

McpManager **彻底消失**，不保留编排器（理由见 §1.3：它是四个域边界的交汇点，保留它等于让 `deps.ts` 声明出一个大而全的 Port）。19 个可变字段与 43 个成员的归属：

| # | 能力块 | 代表成员 | 目标域 |
|---|---|---|---|
| 1 | 连接编排 | `supervisors`、`startAll/start/stop/connect/disconnect/reconnect`、`reconcileServers`、`summary/summarize`、`registerQueue` 之外的 syncChain | `connection/impl/orchestrator` |
| 2 | 中间层宿主 | `middleware`、`middlewareMode`、`initMiddleware`、`setMiddlewareMode`、`middlewareTakes`、`ensureMiddlewareServer`、`dropMiddlewareConnection`、`middlewareUnitFor` | `connection/impl/middleware` |
| 3 | 目录缓存 | `catalogCache`、`catalogCachePath`、`catalogViewResolver`、`loadCatalogCache`、`recordCatalogTools`、`catalogServersFor`、`catalogViewFor`、`catalogCachePathFor` | `catalog` |
| 4 | 配置与 UI 配置 | `store`、`projectStore`、`projectStores`、`uiConfigSource`、`uiUpdate`、`uiConfig`、`updateUiConfig`、`enhancement` | `config` |
| 5 | 服务面与注册队列 | `runtimeRegistry`、`registerServer`、`unregisterServer`、`registerQueue` | `sdk` |
| 6 | 会话跟随 | `projectRoot`、`setSession`、`resumeReconnect` | `workspace`（依赖 config 的项目级 servers 读面） |
| 7 | 工具禁用与策略裁决 | `setToolDisabled`、`disabledByRoot`、`disabledTools`（现住 `inject/middleware-register.ts`） | `pipeline`（裁决）+ `store`（持久化）+ `inject`（guard 挂载） |
| 8 | 状态事件出口 | `listeners`、`emitStatus`、`statusTimer`、`onStatus`、`sseHub` | `api` |
| 9 | 统计 | `stats` | `stats`（已是独立域） |
| 10 | 脱敏 | `redactError` | `pipeline`（宪法 I3 的单点） |

**验收判据**：`src/server/` 下不得存在任何名为 `Manager` 的类；`verify-dir-imports --graph` 的叶子值环与文件级值环归零；`pnpm crap` 无新增超阈热点。

---

## 四、逐域边界表（11 域 + 包内 shared）

> 口径：**功能边界**= 这个域回答什么问题；**数据边界**= 它拥有哪些状态与文件；**上游**= 它依赖谁的能力；**下游**= 它向谁承诺什么。判据形态照搬 #733 §二。

| 域 | 功能边界 | 数据边界 | 上游 | 下游 |
|---|---|---|---|---|
| `upgrade` | 「磁盘上的数据是哪一版形态」——把存储布局从旧位置推到新位置，并在各域装配**之前**跑完 | `<home>/version` 刻度；旧文件归档 `*.migrated.bak` | `server/shared/paths` + `server/shared/file-io`（A9：包内先落）+ **只读配置面**（`storePath`/`debug.statsFile` 两个用户覆盖键要能读出来） | `installUpgrade/releaseUpgrade` |
| `store` | 「非配置类的数据怎么落盘」——用户禁用记录、目录 last-good、目录摘要、调用统计 | `user-state.json`、`catalog/<hash>.json`、`catalog-summary.json`、`stats.json` | 无（叶子） | 原子写/读面（按文件分能力） |
| `stats` | 「调用指标与渐进式披露漏斗怎么算」——收集、防抖、快照 | 内存计数 + 经 store 落盘 | 无（叶子） | `recordCall/isEnabled/snapshot` |
| `pipeline` | 「一次工具调用的裁决与投影」——参数归一、授权与禁用裁决、超时兜底、脱敏、结果投影 | 无持久化 | `workspace`（**值依赖**：`fullServerName/parseFullServerName/bareServerName/MIDDLEWARE_GLOBAL_ROOT`，实测 `pipeline/authorize.ts:11-16`）+ `types` | 纯函数族 + 脱敏单点 |
| `config` | 「用户可编辑的服务器配置长什么样」——schema / 归一化 / 导入 / UI 配置 / 项目级与全局级 store 读写 | `config.json`（全局 servers）、`<项目根>/.dsh/mcp.json`（项目级，**不动**）；UI 配置住宿主 settings 命名空间 | 无（自写，走 `shared/file-io`） | 配置模型 + servers 读写面 |
| `workspace` | 「当前会话在哪个项目根、这个全名属于谁」——root 发现与归一化、全名解析、scope、中间层模式归一 | 内存：当前 root、projectStores 缓存 | `config`（项目级 servers 读面） | `findProjectRoot/normalizedProjectRoot/makeResolveRoot/fullServerName/parseFullServerName` |
| `catalog` | 「模型能看见哪些工具」——条目合成、摘要、digest、注入决策、检索、缓存视图 | 经 `store` 落盘目录缓存 | `config`（公告常量）、`store`（落盘） | `composeCatalogEntries/searchCatalog/listCatalog/findToolDetail/catalogViewFor` |
| `connection` | 「这个服务器连着没有、中间层该不该接管」——代际仲裁、双轨 reconcile、生命周期、事件出口 | 内存：supervisors 池、中间层连接池、syncChain | `config`（servers 读写）、`workspace`（root/全名）、`catalog`（目录写面）、`stats`（埋点）、`pipeline`（纯函数） | `summary()`（唯一查询出口）、`start/stop/connect/disconnect/reconnect`、`installConnection/releaseConnection` |
| `inject` | 「模型面工具怎么注册、怎么守门」——`ws_mcp_*` 四原子、`mcp__` 直呼 guard、提示词段落 | 无持久化 | `connection`（中间层实例窄面）、`pipeline`（裁决）、`catalog`（检索）、`stats`、`workspace` | `registerMiddlewareTools/registerDirectMcpGuard/installInjection` |
| `api` | 「浏览器怎么读写与控制」——HTTP 路由（loopback 围栏）、SSE summary 帧、健康检查、状态事件出口 | 无持久化（状态在 connection） | `connection`（summary/生命周期）、`config`（CRUD）、`store`（用户状态）、`workspace`（会话） | `ROUTES/makeRoutes/makeEventsRoute/makeHealthRoute/emitStatus` |
| `sdk` | 「其他插件怎么用我」——`ctx.mcpManager` 服务面 8 方法 + 运行时注册队列 + 服务面类型 | 内存：runtimeRegistry、registerQueue | `connection`（生命周期 + **读 supervisor 工具集**的窄面，供 `getTools` 用）、`config` | `installSdk/releaseSdk` + 服务类型（**从包内导出**，见 §八）。**`getTools` 的现状是只读 `manager.supervisors`（`bootstrap/apply-services.ts:41-55`），中间层接管时恒返回 `[]`**——原稿写「与 summary 同源」是**假的**（summary 走中间层投影 `manager.ts:1122-1139`）。按 A13 决策本轮**原样搬移**：sdk 需要一条明确的「读 supervisor 工具集」能力（端口名待 §4.1 定稿），同源改写另立批次并登记 #770 |

### 4.1 `deps.ts` 的 Port 面（6 个域 + 宿主能力分组）

**口径**：端口必须按「本域**实际消费**的方法」反查而写，不能按印象写。评审实证：初稿的 `api` 端口漏了 5 个以上能力，而实测 `routes-controllers.ts` 用到 **24 个** `manager.` 成员、`routes.ts` 还直读 `supervisors/catalogCache/middleware/sseHub` 四个内部字段。

```text
# 宿主能力（不属于任何域；由组合根 bindHost 收窄后递入，每个用到它的域自行声明）
HostPorts = {
  logger:   LoggerPort
  register: (route) => () => void          # ctx.webServer.register
  tools:    { register(def) }              # ctx.tools.register（仅 inject）
  events:   { onPreStep(handler) }         # ctx.on("agent/pre-step")（仅 inject）
  prompt:   { section(opts) }              # ctx.systemPrompt.section（仅 inject）
  settings: { read(), write(patch) }       # ctx.inject(["settings"]) + uiUpdate sink
  expose:   { provide(service) }           # ctx.provide（仅 sdk）
  sessions: { cwdOf(session) }             # ctx.sessions（workspace/api）
}

workspace/deps.ts    → ConfigPort      = Pick<typeof configApi, "projectServersFor">
                       Host: logger, sessions
catalog/deps.ts      → ConfigPort      = Pick<typeof configApi, "announceCatalogMaxEntries">
                       StorePort       = Pick<typeof storeApi, "readCatalog/ writeCatalog/ catalogPathFor">
                       ConnectionPort  = Pick<typeof connectionApi, "middleware()/ mode()">   # catalogViewFor 要 live 单元与模式（初稿漏）
                       Host: logger
connection/deps.ts   → ConfigPort      = Pick<typeof configApi, "serversFor/ saveServers">
                       WorkspacePort   = Pick<typeof workspaceApi, "normalizedProjectRoot/ parseFullServerName/ globalRoot">
                       CatalogPort     = Pick<typeof catalogApi, "view">                    # 只读视图；目录写面归 catalog
                       StatsPort       = Pick<typeof statsApi, "isEnabled/ recordCall">
                       PipelinePort    = Pick<typeof pipelineApi, "normalizeArguments/ projectCallToolResult/ withTimeout/ createRedactor">
                       Host: logger
inject/deps.ts       → MiddlewarePort  = Pick<typeof connectionApi, "middleware()/ mode()">
                       PolicyPort      = Pick<typeof pipelineApi, "isToolDenied/ toolDisabledReason/ policyAllows/ policyDenialReason">
                       CatalogPort     = Pick<typeof catalogApi, "searchCatalogMulti/ listCatalog/ findToolDetail">
                       WorkspacePort   = Pick<typeof workspaceApi, "makeResolveRoot/ parseFullServerName">
                       StatsPort       = Pick<typeof statsApi, "isEnabled/ recordCall">   # 初稿漏
                       Host: logger, tools, events, prompt
api/deps.ts          → ConnectionPort  = Pick<typeof connectionApi,
                                            "summary/ start/ stop/ connect/ disconnect/ reconnect/
                                            setToolDisabled/ resumeReconnect/ projectRoot/ middlewareMode/ setMiddlewareMode/
                                            healthCounts">                                # health 要中间层池计数，summary 给不出
                       ConfigPort      = Pick<typeof configApi, "uiConfig/ updateUiConfig/ add/ update/ remove">
                       StorePort       = Pick<typeof storeApi, "readUserState">
                       WorkspacePort   = Pick<typeof workspaceApi, "setSession/ refreshFromDisk">
                       Host: logger, register, settings
sdk/deps.ts          → ConnectionPort  = Pick<typeof connectionApi, "summary/ connect/ disconnect/ reconnect/ registerServer/ unregisterServer">
                       ConfigPort      = Pick<typeof configApi, "serversFor">
                       CatalogPort     = Pick<typeof catalogApi, "toolsForServer">
                       Host: logger, expose
```

四条收窄纪律：**`Pick` 越窄越好**；**端口传能力不传算好的值**；**共享设施不入注入面**，但两条引用纪律要分开（评审实证：`verify-dir-imports` 的 `isFacade` 只认 `interface.ts`/`deps.ts`，而包内 `server/shared/` 有 `interface.ts` → 它是模块）：**仓库级 `shared/*.js` 由实现块直接 import**（在门禁扫描面外）；**包内 `server/shared/*.ts` 一律经 `server/shared/interface.ts` 门面**——直引 `paths.ts` 会新增 `directImpl` 质量证据并判红（参照包实证：notifier 包内 shared 引用 45 处全走门面、零直引）；**裸对象不算契约**——以下四项初稿缺失，必须在实现前收口：

1. `api` 现直取 `manager.store` / `projectStoreOrThrow()`（`routes-controllers.ts:320/323`）与 `manager.supervisors/catalogCache/middleware/sseHub`（`routes.ts`）。目标形态下这些必须变成 `connection` 门面上的**命名能力**（如 `healthCounts()`、`projectServersForEdit()`），不能递裸对象。
2. `catalogViewFor` 的数据源是**运行中的中间层实例与模式**（`catalog/cache-view.ts:31-36/76-113`），事件通知替代不了。二选一：给 `catalog/deps.ts` 一个 `ConnectionPort`（**推荐**，视图是目录域的语义、取数经端口），或把 `catalogViewFor` 整体归 `connection`。
3. `MiddlewareHostPort` 必须在 `connection/interface.ts` 有物理定义，并写明**由组合根在装配中间层块时递入**（不是从编排块掏）。
4. 若 `stats` 落盘经 `store`（裁决点 A7），则 `stats/deps.ts` 必须存在，「5 个域无 `deps.ts`」应改为 4 个。

### 4.2 七处易错点

1. **`connection` 不拥有目录缓存**。目录缓存的写入归 `catalog`，两者之间只留一条事件通知（「工具集变了」），否则目录数据源会再次穿过连接域，第 3 条环会长回来。
2. **`api` 与 `sdk` 共享 `summary()`**。summary 是 `connection` 门面的**唯一查询出口**，两边各自 `Pick` 同一方法——而不是让两边各拿一个宽 Port。
3. **中间层宿主是「被注入」而不是「被掏出」**。现状是中间层反向从 manager 借 8 个方法（`MiddlewareHost`）；目标形态下 `connection` 定义 `MiddlewareHostPort`（它需要什么），由组合根在装配时把能力递进去。
4. **目录缓存的命名与落盘归属必须说死**。现状：文件名/路径在 `config/store/middleware-state.ts:65-68`（`catalogCacheFileFor`）与 `catalog/cache-view.ts:27`（`catalogCacheFile`），写入方却是 `connection/runtime/middleware.ts` 的 `persistCatalog`，而 `MiddlewareHost` 又要求 manager 提供 `catalogCachePath(root)`（`types/host-faces.ts:85`）。目标形态：文件名与每 root hash 规则归 `server/shared/paths.ts`（I7 单源）、`store` 执行写、`connection` **不再经 MiddlewareHost 拿路径**——它只发「工具集变了」事件，落盘由 `catalog` 经 `store` 完成。只写「留一条事件通知」不可执行，第 3 条环会在 P3 原地复现。
5. **`summary()` 是凭据出境面的主要收口点，但不是唯一**。它既是 `connection` 的唯一查询出口、也覆盖 `api` 与 `sdk` 两路——但评审实证：**`POST/PATCH /servers` 的响应体直接返回 `{server, summary}`（`api/routes-controllers.ts:165/187`），绕过投影**，所以「投影层脱敏即覆盖全部」是**假的**（完整六条见 §7.4）。三条纪律：① 脱敏做在投影层；② **投影层只允许删键 / 去 URL userinfo，禁止把 secret 值替换为占位符**——`update()` 是 **merge 语义**（`manager.ts:928` `normalizeServer({...existing, ...patch, name})`，缺键保留、有键覆盖），客户端编辑表单会回填 `env`/`headers`（`float/quick-add.ts:104-115`），值替换会在用户「编辑 → 保存」时把占位符写回配置、**静默毁掉真实凭据**（这是数据损坏路径，不是加固）；③ ⑤ 那条单独处置。
6. **跨域常量必须显式登记**。实测两条常量边：`catalog/search.ts:10-16` 从 `connection/interface.ts` 取 5 个目录边界常量（`CATALOG_TTL_MS`/`LIST_DEFAULT_TOOLS_PER_SERVER`/`MAX_BYTES_PER_TOOL`/`MAX_TOOLS_PER_SERVER`/`MAX_TOTAL_CATALOG_BYTES`，物理定义在 `connection/runtime/limits.ts:16-30`）；`inject/middleware-register.ts:14-20` 从 `connection/runtime/interface.ts` 取 5 个超时/限额常量。这些边**不成环就不被值环判据拦下**，但会让意图图与事实图长期不一致。口径：常量归**语义所有者**（目录边界常量应归 `catalog`），跨域常量消费写进 `deps.ts`；泄漏面统计需纳入常量边（裁决点 A4）。
7. **`connection` 的块级边界没有机器判据**。`verify-dir-imports` 的 `moduleOf` 取「最近的含 `interface.ts` 的祖先目录」（`scripts/gate/verify-dir-imports.mjs:544-556`），所以 `connection/impl/orchestrator/**` 与 `connection/impl/middleware/**` 同属一个叶子模块，块间引用恒不判红（notifier 的块级 `deps.ts` 同样是自觉纪律）。**P3 验收因此不能只写「无 Manager 类 + 行数」**：必须逐块写清状态所有权（谁改 supervisors 池、谁拥有 `registerQueue` 与 `syncChain` 的顺序），或补一条块级 import 判据。

### 4.3 扩展点与同步点（开闭量化）

> ARCHITECTURE-METHOD §5 是方法论里**唯一带量化验收**的原则：「对每个可扩展维度盘点『新增一项要改几处』，超过 3 处即判违反开闭原则……重构后重数一遍，把数字写进验收判据」。初稿完全没有这一节（评审实测：全文 grep『开闭 / 单点注册 / 派生 / 扩展点』0 命中）。

口径：按「必须修改的表/分支」计数，不按命中关键字行数；数字为协调者实测（基线 b490e87）。

| 扩展点 | 现状同步点 | 目标上限 | 目标形态的单点设计 |
|---|---|---|---|
| 新增一种 MCP 传输 | **≥9**：`types/server.ts:14` 联合、`config/model/normalize.ts:25-46/66` 校验分支、`connection/runtime/transport.ts:181-190` 工厂分支、新 Transport 类、`pipeline/redact.ts:26` 凭据分支、客户端 `locales.ts` 4 组文案 ×2 语言、`float/quick-add.ts:53/202-204/295`、`float/servers.ts:18/92/93`、`config/model/import.ts:22/38` | ≤3 | `connection/impl/transport/type.ts` 一张 `TRANSPORTS as const` 表（每项含工厂 + 校验 + 凭据形态）→ 宿主校验/工厂/脱敏分支全部**派生**；客户端文案由服务端 DTO 下发，不在两端各写一份 |
| 新增一个服务器状态（现六态） | **≥10**：`supervisor.ts:398/403/424/461/467/494`、`middleware.ts:205/250/279/314/351/365/620-623`、`manager.ts:1087-1094` 六键计数表 + `1158/1183` 投影兜底、`api/routes.ts:179/190`、`types/status.ts:9`（`state: string`，零约束）、`shared/mcp-manager-service.d.ts:25-26`、`service-contract.test.ts:55-60`、客户端 `core/constants.ts:28-56/59-66` 两张六项表、`locales.ts` zh/en 六组、`float.ts:131/141/242`、`servers.ts:142/149/204/278`、`smoke.test.ts:1107` 对客户端源码文本的哨兵 | ≤3 | 一张 `SERVER_STATES as const` 表（状态键 + 计数键 + 投影兜底 + DTO 联合）→ 状态转移、六键计数、契约测试、客户端分组全部派生；**跨端共用同一张表**（客户端经 DTO 取）——**本轮不可达**（需跨端面与客户端改动，撞 N5/A12；另立 #769 批次，见 A14） |
| 新增一条 HTTP 路由 | **4-5**：`api/routes.ts:41-53` ROUTES 表、`:71-81` 装配数组、新控制器工厂、客户端 `core/constants.ts:13-23`（**11 条路径在宿主与客户端各写一份，无共同事实源**）、smoke 的 403/405 围栏 | ≤3 | `api/impl/routes/table.ts` 一张 `ROUTES as const`（路径 + 方法白名单 + 围栏）→ 装配数组与客户端路径表由它派生 |
| 新增一个 `ws_mcp_*` 工具 | **4-6**：`inject/middleware-register.ts` 工厂 + `:823-828` 工具数组 + guard 分支（`:743` 仅 `ws_mcp_call` 单点硬编码）+ `bootstrap/apply-guidance.ts:8-12` 提示词 + 测试/README | ≤3 | `inject/impl/tools/table.ts` 一张工具表（名称 + 定义 + 是否受策略约束 + 提示词片段）→ 注册、guard、提示词三处派生 |

**验收**：本表在 P0 作为设计约束冻结；**P3/P4 完成后按同一口径重数一遍**并写进 PR——任一维度仍 >3 必须说明理由。这是「维护成本降了吗」的唯一可答证据。

---

## 五、存储布局与迁移

### 5.1 目标布局（唯一事实源：`server/shared/paths.ts`）

| 内容 | 目标路径 | 归属域 | 旧路径 |
|---|---|---|---|
| 全局服务器配置 | `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/config.json` | `config` | `<DSH_HOME>/dsh-mcp.json` |
| 用户状态（含 disabledTools） | `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/user-state.json` | `store` | `<DSH_HOME>/dsh-mcp-user-state.json` |
| 目录 last-good 缓存 | `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/catalog/<hash>.json` | `store` | `<DSH_HOME>/dsh-mcp-catalog/<hash>.json` |
| 目录摘要缓存（单文件） | `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/catalog-summary.json` | `store` | `<DSH_HOME>/dsh-mcp-catalog.json`（`src/catalog/cache-view.ts:27`；写路径在 `src/connection/orchestrator/manager.ts:188-193`） |
| 调用统计 | `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/stats.json` | `store` | `<DSH_HOME>/mcp-stats.json` |
| 存储版本刻度（新增） | `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/version` | `upgrade` | 无 |
| 项目级服务器配置 | `<项目根>/.dsh/mcp.json` | `config` | **不变**（随项目走、可提交 git，是本插件唯一的用户资产路径） |

参照 `packages/dsh-notifier/src/server/shared/paths.ts`：`PACKAGE_DIR` 常量 + `xxxFile(name)` 取路径 + `legacyFile(name)` 取旧位置——「旧文件在哪」与「新文件在哪」放同一处，分开会各自漂移，而漂移的那次就是迁移读空。

### 5.2 迁移语义（照搬 notifier `upgrade/impl/steps/storage-layout.ts`，逐条都踩过坑）

| 情形 | 动作 |
|---|---|
| 目标存在、旧文件也存在 | **先比 mtime**：旧文件更新则**不覆盖也不归档、只 warn**（评审实证的丢数据路径：降级期间用户在新旧任一路径改过配置，再升级时无条件归档会静默丢弃编辑）；否则只归档旧文件（`rename` 为 `*.migrated.bak`），不覆盖——用户可能在新位置已经改过东西，用旧文件盖回去等于用历史覆盖现在 |
| 目标不存在、旧文件存在 | 读旧 → **原样文本**写目标 → 归档旧文件 |
| 两者都不存在 | 写**初始空形态**，不写全量默认值快照——写全量默认值会把「用户覆盖过哪些键」冲掉。注意 `config.json` 的形态是 `{version:1,servers:[]}` 而不是裸 `{}`（`McpStore.load` 对 `{}` 只在内存补空、首次 `save` 才写回全形，`store.ts:38-57/59-71`） |
| **目录型旧路径**（`dsh-mcp-catalog/<hash>.json`，N 个文件、文件名由任意项目 root 决定） | 整目录语义：目标目录不存在→整目录 `rename`；目标目录已存在→**逐文件**「不覆盖只归档」并 warn。参照包的 `LAYOUT` 是**扁平单文件表**（`storage-layout.ts:24-49`），表达不了目录搬家——本条是本包相对参照包的增量 |
| 旧文件读不出来 | **两种失败语义不同**：① **IO 失败 / 权限问题** → 抛错（搬不动，不该被当成「没有旧数据」）；② **内容解析失败（JSON 坏）** → 现状读面是**容错**的（`store.ts:38` 文件不存在/解析失败保持内存态、`middleware-state.ts:36` 「损坏忽略」、`readCatalogServerFromDisk`「缺失/损坏 → undefined」），**不能因迁移把它变成装配期致命错误**——那会让一个损坏的旧配置从「静默回落空、插件可用」变成「apply 失败、MCP 全不可用」（撞 N12）。推荐口径：解析失败 → warn + **保留旧文件原样、不迁移** + 按空形态继续启动。列裁决点 A3 |
| 目标已存在但旧文件不存在 | 什么都不做（这就是重跑的常态） |

三条硬要求：**幂等**（归档名固定，重跑不累积）；**失败即中止装配**——任何一步抛错，`apply` 随之失败（参照包 `upgrade/impl/chain` 的文件头原文：「带半完成迁移的存储比不启动危险得多」）；刻度**回写在 `run` 之后**，失败即不推进，下次启动从同一步重跑。**原稿「失败不推进刻度（迁移没做完而启动照常）」的措辞可读成「启动照常」，与 abort 语义相反，已修正**；**纯文本搬移，不得解析后重写**——`config.json` 里存的是 `${ENV}` 引用（不落盘密钥），解析重写会顺手丢掉未知键，正是 §8 记录的「保留键写拒 / 未知键透传被静默删除」现场。

### 5.3 迁移的破坏性面（必须与用户可见行为同步）

| 面 | 处置 |
|---|---|
| 降级不兼容 | 用户从新版回退到旧版会读不到配置（旧文件已归档）。**必须写进 release notes** |
| README（中英双语） | `README.md` / `README.en.md` 共 6 处路径表述（含「数据与安全」章节）同步 |
| 客户端文案 | `src/client/locales.ts:74/177` 硬编码 `~/.dsh/dsh-mcp.json`。**A12 已决：改文案，但不引入路径**——降为「全局（本机配置）」。**理由**：全局配置路径可被用户用 `storePath` 覆盖，硬编码任何具体路径（含新路径）都可能不准；显示路径对用户也无价值。这是一处最小客户端改动（2 行文案），不碰结构、不动 DTO。**落地批次改到 P0**（二轮评审）：它与业务无关、2 行、独立可评；放 P6 有与 #769 重排 `locales.ts` 撞车的顺序风险（R7 自己承认交叉）。并加一条廉价静态断言：**客户端产物不含 `~/.dsh` 字面量** |
| 配置项 `storePath`（**不存在 `serverStorePath` 这个键**；实测 `config/model/config-schema.ts:119/137` + `bootstrap/apply-config.ts:33-34`） | 保留为**用户显式覆盖**：显式给了 `storePath` 就不迁移、不改写、继续读用户那个文件。**这是用户可见契约，必须有测试**：显式 `storePath` + 旧默认路径有文件 → 不迁移、读到用户文件 |
| 配置项 `statsFile`（`config/model/config-schema.ts:34`） | 同 `storePath`：显式给了就按用户值落盘、不进迁移；默认值从 `<DSH_HOME>/mcp-stats.json` 迁到包私有目录（**旧文件名要在迁移表里显式列出**，否则实施者会 new 一个空文件把用户历史指标丢掉） |
| `#723` 修复脚本 | 它操作的是宿主 session 文件，与本插件的存储布局无关，不受影响 |

### 5.4 `upgrade` 域的机制（照搬参照包 `packages/dsh-notifier/src/server/upgrade/` 的六件套）

> 协调者实测发现：方案初稿只抄了 `storage-layout` 一层，而该域真正的工作量在链驱动与失败语义上。**P1 批次必须实现下列六项**，否则"迁移做了一半"会在用户现场表现为数据形态错乱。

| # | 机制 | 语义 |
|---|---|---|
| 1 | **步骤表** | `STEPS: { fromVersion, targetVersion, run }[]`。**新增版本必须追加一项**（哪怕 `run` 是空实现）——链的推进以步骤为刻度，漏掉一个版本会让存储刻度永久停在旧值 |
| 2 | **链驱动** | 读刻度 → 取"刻度仍停在起点或更早"的步骤 → 按 `targetVersion` **升序**执行（不按声明顺序）→ 逐步回写刻度 → 与插件版本对账 |
| 3 | **刻度** | `version` 文件是**存储版本**（不是插件版本）；`pluginVersion()` 从 `package.json` 读（不写常量——常量与发布版本之间没有机制保证同步）；`compareVersions` 自实现逐段数值比较，不引 semver |
| 4 | **失败语义** | 任何一步失败即抛出、`apply` 随之中止——"带半完成迁移的存储比不启动危险得多"。刻度**回写在 `run` 之后**（刻度是"这一步做完了"的凭证，先写刻度等于把凭证发给一件还没做完的事），失败即不推进，下次启动从同一步重跑 |
| 5 | **对账** | 链跑完后比 `(recorded, pluginVersion)`，三种落差**分开告警**且都不中止启动：落后（缺步骤，开发期漏项）/ 步骤表超前于 package.json（两者未同步）/ 装的是更旧的包（降级——本插件不回退） |
| 6 | **装配标记** | 单例 + `installed` 标志：重复装配是编程错误、当场抛；`release` 只复位标记（本域只写文件，没有需要释放的东西） |

本包的差异：本次迁移只有**布局归位**（无配置形态割接），所以 `STEPS` 只有一步；但步骤表、刻度、对账、失败语义四件必须一次建齐——后续任何存储格式演进都要靠它们。

---

## 六、测试面目标架构

### 6.1 三层定义与导入面矩阵

| 层 | 目录 | 只允许 import | 测什么 | 替身 |
|---|---|---|---|---|
| 单元 | `test/unit/<域>/<块>.test.ts` | `src/server/<域>/impl/<块>/` 内文件（同域白盒）+ **本域 `deps.ts` 的 Port fake** | 模块内函数与状态机 | 同域 Port 可用 fake（参照包实证：notifier 单测直接 import `api/deps.ts` 的 `StorePort` 造 fake。原稿写「零替身」比判据句更严，会让同款写法当场判红） |
| 契约 | `test/integration/` | 域 `interface.ts` + `deps.ts` + 跨端线协议（HTTP / SSE / DTO） | 接缝的形状与承诺，不测实现细节 | 入口本身即注入面，可用 fake |
| 集成 | `test/e2e/` | 包产物入口 + `apply()` | 端到端 user case | 仅系统边界（网络、子进程、临时目录、时钟） |
| 组合根 | `test/integration/real-context.test.ts` | `src/index.ts` + 真实 `Context` | 装配顺序、释放逆序、服务面、声明合并 | 真实宿主面 |
| 客户端 | `test/client/` | `src/client/**` | UI 模块 | 归 #769 |

**分层不能只靠文件名前缀，必须由导入面定义**。**A11 已决：本轮暂不设机器判据**，下列三条作为 **PR 评审清单**执行（跟踪 issue 待建）：

- `test/unit/**` 不得出现 `../../src/index.ts` 或 `lib/`（判红了 §1.4 的全部 13 处）
- `test/e2e/**` 不得 import `src/`（保证它是产物口径）
- `test/integration/**` 不得 import `src/server/<域>/impl/`（保证它只测接缝）

### 6.2 存量搬迁映射（16 个测试文件 / 14800 行）

| 现文件 | 行数 | 目标 |
|---|---|---|
| `unit/unit-manager2.test.ts` | 3142 | 随中枢解体拆入 `unit/{connection,catalog,config,sdk,workspace}/` |
| `unit/unit-middleware.test.ts` | 2109 | 拆入 `unit/connection/` + `unit/inject/` |
| `unit/unit-supervisor.test.ts` | 900 | `unit/connection/` |
| `unit/unit-catalog.test.ts` | 771 | `unit/catalog/` |
| `unit/unit-routes-sse.test.ts` | 705 | `unit/api/`（帧契约部分下沉 `integration/`） |
| `unit/unit-store.test.ts` | 501 | `unit/{config,store}/` |
| `unit/unit-apply.test.ts` | 412 | `integration/real-context.test.ts`（组合根真实 Context） |
| `unit/unit-hotspot.test.ts` | 370 | 按被测符号归域 |
| `unit/unit-transport.test.ts` | 356 | `unit/connection/` |
| `unit/unit-shared.test.ts` | 338 | 被测对象是仓库 `shared/settings-namespace`，迁 `scripts/test/` 或保留并登记（现登记为「零杀灭」） |
| `unit/unit-call-stats.test.ts` | 296 | `unit/stats/` |
| `unit/unit-manager.test.ts` | 271 | `unit/connection/` |
| `unit/unit-pipeline.test.ts` | 203 | `unit/pipeline/`（两路径同构契约下沉 `integration/`） |
| `unit/unit-workspace.test.ts` | 79 | `unit/workspace/` |
| `integration/service-contract.test.ts` | 338 | 改为**消费方编译夹具**（现为读 `src/bootstrap/apply-services.ts` 源文本比对 marker，该文件在重写后消失） |
| `e2e/smoke.test.ts` | 3844 / 159 it | 按**导入面**而非 describe 名分层：整体走产物（T3）保留 `e2e/`；其中的「两路径同构」「DTO 形状」「SSE 帧集合」下沉 `integration/` |
| `test/helpers.ts` | 161 | 保留在 `test/`；`pollUntil/assertNoGrowth` 等防 flake 原语是单一事实源，继续沿用 |
| **规则（A10 的必然推论）** | — | `smoke.test.ts:55-87` 从 `lib/index.js` 一次取 30+ 符号、`grep -c 'new McpManager'` = **9 处**、相关内部符号引用 **39 处**。A10 让这些符号移出入口后，它们**既不能留 e2e**（§6.1 判据禁 e2e import `src/`）**也不能进 integration**（禁 import `impl/`）——**规则：凡直接 new 内部类 / 取内部符号的 e2e 用例一律改为 `test/unit/<域>` 的白盒用例；e2e 只保留 `apply()` + 产物入口的 user case** |

### 6.3 度量面同步（先修尺子，再动测试）

| 面 | 现状 | 动作 |
|---|---|---|
| 变异段 | 6 段（entry / manager / middleware / routes / supervisor / runtime），测试面是**包级一份** `vitest.stryker.d/dsh-mcp-manager.config.ts`（13 文件清单，6 段共用） | 随域重画 mutate 清单。**原稿写的「testFiles 按层策展」在现有机制下不可实现**（评审实证：`gen-stryker-conf.mjs:344-349` 显式判红 Stryker 顶层 `testFiles`，测试面由拓扑自动派生成包级一份）——该条删除，改为「测试面随 `testLayers` 自动派生」 |
| **变异面**排除项（**不是覆盖率面**——该条目住 `scripts/data/mutation-topology.json` 的 `testLayers.coverageExcludes`，语义是变异/源码覆盖排除） | `!packages/dsh-mcp-manager/src/**/interface.ts`，kind=`facade`，理由「只有 re-export」。覆盖率面（`coverage.config.json`）**没有**这条排除，14 个门面本来就在覆盖率分母里 | **重估变异面**：落到 notifier 形态后 `interface.ts` 带 `installXxx/releaseXxx` 配对状态，是可变异逻辑。删/窄化该条时**必须同步** `scripts/test/mutation-topology-coverage.test.ts` 的硬编码计数（mcp=1、total=12）与 reason 唯一性；`verify-coverage-scope` 守的是覆盖率面，不是这条 |
| 测试文件下限 | `--min 16` | 随新增文件上调（该下限只封堵零匹配/漏跑，不自动跟随） |
| `testLayers` 登记 | `unitExemptions` + `testMutationExemptions` 共 2 条（均指向 `unit-shared` / `service-contract`） | 前者随搬迁重判，后者随源文本断言退役而删除 |
| `coverage.config.json` client 面 | 客户端不在本包覆盖率面 | 归 #769 |

### 6.4 测试卫生与假绿封堵

| 项 | 现状 | 目标 |
|---|---|---|
| `// @ts-nocheck` | 测试文件普遍带（`helpers.ts`、`unit-pipeline`、`unit-workspace` 等） | **清零**（排在各域测试搬迁之后做，避免同一文件改两遍）；测试进类型检查面 |
| 源文本哨兵断言 | `service-contract.test.ts` 读源文件比对 marker | 改为消费方编译夹具（notifier `consumer-types.test.ts` 范式）；静态文本断言仅限真实 ABI 与安全约束 |
| 恒真断言 | 未系统清理 | 逐文件过一遍：只断言「不抛错」的改写成对结果的断言 |
| 假绿三向量（零匹配 / 零断言 / 吞失败 exit 0） | 由仓库门禁兜 | 本包验收显式复核一次 |
| 判据强度 | — | **零放宽**：结构重构不得删断言；确需删除须在同一批显式登记待补（refactor skill §7 第 5 条） |

### 6.5 契约文档的修正

`docs/architecture-contract.md` §3.1 的 T1 定义（「经 `lib/index.js` re-export 或目录 interface.ts」）与 ARCHITECTURE-METHOD §8 冲突，必须改为「单元层白盒直连 `src/server/<域>/impl/<块>/`」。同时该文档的 C-DIR 表、D10 条目、阶段不变式（`apply-services.ts` 禁止移动）均随本轮重写作废或重述——**把违反 §8 的做法写成契约，比违反它本身更贵**。

**成本修正**：初稿说「四处作废」，实测被判死符号遍布全文 257 行——C-ERR/C-EVT/C-CFG/C-ABT（`:22-85`）引用的 `routes.ts L100-102`、`manager.ts` 十余处行号、`apply-config.ts L86-95`、`middleware-utils.ts L568-594` 在本轮全部消失；§2.1/§2.3 依赖 `apply-services.ts` 源文本扫描，而 §6.2 已把该测试改成编译夹具；§2.4/§2.5/§三/§四的阶段落位列与 §五 阶段 0 完成定义全部作废。**真正需要重新裁定的是约 200 行**，其中 13 条 C-* 行为契约里哪些仍有效必须逐条裁定。处置：**P0 就按「保留（行为契约）/ 作废（阶段与目录形态）/ 重述（T1 与导入面）」三分类打标**，P6 只做合并归档。

---

## 七、上下游契约

### 7.1 上游：我们依赖宿主

| 契约 | 内容 | 本轮动作 |
|---|---|---|
| 插件契约 | `name` / `inject = ["tools","webServer","systemPrompt"]` / `apply(ctx, config)` / `Config` schema | 不变（导出面快照锁定） |
| 宿主能力 | `ctx.tools.register`、`ctx.webServer.register`、`ctx.systemPrompt.section`、`ctx.logger`、`ctx.on`、`ctx.effect`、`ctx.inject(["settings"])`、`ctx.sessions`、`ctx.provide` | **收窄**：全部经 `bindHost` 变成能力面（宪法 I1） |
| 宿主类型层 | catalog 锁版 `@deepseek-ai/*`，仅 `import type` | 不变；tsconfig 不得指向任何 DSH 源码 checkout |

### 7.2 下游：谁依赖我们

| 面 | 契约 | 纪律 |
|---|---|---|
| 模型面 | `mcp__<server>__<tool>` 注册名 + `ws_mcp_*` 四原子 + `pre-execute` guard | ABI 名单点定义（宪法 I11）；键口径两套（`summary().tools` 裸名 / `getTools` 注册名）必须文档化 |
| 兄弟插件 | `ctx.mcpManager` 服务面 8 方法 + `registerServer` 运行时注入（`registerServer.toolDefinitions` 透传 supervisor） | 服务名字面量单点定义；服务面类型**从包入口导出** |
| 浏览器前端 | `/api/dsh-mcp/*`（loopback 围栏，403 先于 405）+ SSE 帧集合 `{summary, ui-config-changed, ping}`（零负载 + 客户端回拉 + 60s watchdog 自愈） | 帧集合写成显式清单；DTO 形状与六态计数键集合（connected/connecting/reconnecting/disabled/stopped/failed）冻结 |
| 磁盘 | `config.json` / `user-state.json` / `catalog/<hash>.json` / `catalog-summary.json` / `stats.json` / `version`；项目级 `<项目根>/.dsh/mcp.json`；自定义 `storePath`/`statsFile` 时以用户值为准 | 布局单一事实源 + 迁移独占一域（宪法 I7，见 §五）。**不新增 `status.json`**（评审否决：内存态 + SSE 零负载回拉已闭环，落盘零增益，且会让 connection/api/store 三处争归属） |
| 安全面·**本轮承诺** | 凭据脱敏 raw/decoded 双形态；stdio 子进程环境净化；`config.json` 保持 `0o600` | README 安全模型与实现同 PR 更新 |
| 安全面·**登记为已知缺陷（不承诺、不写进 README 承诺段）** | **六条**，完整清单见 **§7.4**（初稿只列四条；第二轮评审实证漏了 ⑤ POST/PATCH 响应体与 ⑥ stdio stderr 尾巴，且 ②④ 注册不完整） | 全部 → **#770 第 1 项**。**缓解结论已修正**：①④⑥ 在 loopback 围栏后（`routes-controllers.ts:139`）；**② 另有一条无围栏的进程内出口**（`ctx.mcpManager.list()/getStatus()` 直接用同一份 `summary().servers`，`bootstrap/apply-services.ts:36/56`）——任何兄弟插件都能拿到 `env`/`headers` 明文，**不得按「不可远程利用」降级** |

### 7.3 侧向：仓库共享层

| 模块 | 种类 | 消费者（实测） | 新准入门槛 | 处置 |
|---|---|---|---|---|
| `server/shared/file-io.ts`（**包内**，不是仓库 shared） | 函数/值 | 本包 3 个域（config/store/stats）+ upgrade | 2 | **包内准入**；仓库级 `shared/file-io` 的抽取按 A9 决策延后（另开 issue） |
| `loopback` | 函数/值 | 2 | 2 | 合规（保留） |
| `placement-math` | 函数/值 | 2 | 2 | 合规（保留） |
| `settings-namespace` | 函数/值 | 3 | 2 | 合规；登记快照修正（登记 4 实际 3） |
| `client/i18n` | 函数/值 | 3 | 2 | 合规；登记快照修正（登记 2 实际 3） |
| `host-utils` / `dsh-home` / `client/ensure-style` | 函数/值 | 4 | 2 | 合规 |
| `frontmatter` | 函数/值 | **0** | 2 | 挂 DEPRECATED，走废弃两步走 |
| `mcp-manager-service.d.ts` | **类型** | **1** | 3 | **退回 mcp 包内**（类型定义住 `src/server/sdk/interface.ts`）——消费方本来就「从本包引类型」，对消费方零影响。**但 `declare module` 必须写在包入口 `src/index.ts`**（参照包 notifier 的实证：`src/index.ts:72-77`，注释原文「必须写在包入口」，且键用 sdk 域的 `as const` 常量引用）——初稿在 §3.1 与 §7.3 里给了两个不同位置，已按参照包钉死 |

`shared/file-io` 的形态要求（三家口径差异必须在此统一，否则是把差异固化成契约）：

- 签名：`readTextFileSync(file): FileRead`、`writeTextAtomic(file, text, { mode }): Promise<FileWrite>`、`writeTextAtomicSync(file, text, { mode }): FileWrite`
- **`mode` 的现状必须逐文件说清**（实测 b490e87）：mcp **只有一处** `0o600` —— `config/store/store.ts:66`（全局配置），README 的 0600 声明也只覆盖它。其余 4 点**现状不设 mode**（0666&~umask，通常 0644）：`config/store/middleware-state.ts:57`（user-state）、`:174`（disabledTools）、`connection/runtime/middleware.ts:497`（catalog/<hash>.json）、`connection/orchestrator/manager.ts:192`（catalog-summary）、`stats/collector.ts:256`（stats.json）。照「mcp 与 provider-usage 都以 0o600 落盘」的归纳去实施，会**凭空改变 4 个文件的权限**——那是可观察的磁盘行为变更，撞 N6/§9.2 且无差分记录
- **`mode` 必填 vs 可选属待裁决项 A2**：必填会让 notifier 的 8 个调用点全部编译失败并逐个要定权限（与 N11「不动其它包」冲突）；`mode?: number` + mcp 侧显式传值 + store 域落盘权限断言是侵入面小一个数量级的形态
- 返回判别式（`{ok:true} | {ok:false, reason}`），调用方决定抛或吞（`store` 的 `McpStore.save` 现为上抛，在调用点转抛即可）
- 临时文件名取 **pid + 时间戳**（mcp 的 B17 口径），不是 notifier 的「只 pid」——共用顺带收敛掉一个同进程并发写互相踩的真实缺陷
- 落位（**A9 已决：包内先落**）：`src/server/shared/file-io.ts`（TS 源码，经 `server/shared/interface.ts` 门面 re-export）+ 包内单测 `test/unit/shared/file-io.test.ts`。**不是**仓库 `shared/file-io.js + .d.ts`——那套双写与 `shared/README.md` 登记随仓库级提升的 issue 一起做

---

### 7.4 凭据出境面清单（六条，第二轮评审实证补全）

> 口径：**载波** = 数据经什么出去；**是否被 summary 投影覆盖** = §4.2 第 5 条所说的「投影层收口」能否覆盖到它。这张表同时是 P0/P2 契约测试（`test/integration/redaction-exits.test.ts`）的登记面——**新增出口判红、出口消失即改善并强制更新清单**（单调基线的「证据集合」口径，见 §二 I10 的 J2）。

| # | 出口 | 载波 | 代码点 | 被投影层覆盖？ |
|---|---|---|---|---|
| ① | 4xx 错误响应体 | `writeJson(res, 400, { error })` | `api/routes.ts:59-60` `handleError` 直出 `error.message`；`src/api/**` 零 `createRedactor`。真实样例：`config/model/normalize.ts:43` 的 `invalid url:` 文案把含 userinfo 的 URL 送进 400 body | 否 |
| ② | `GET /servers` 响应体 + **sdk 服务面** | `summary().servers` | **两处直出**：`manager.ts:1181-1184`（`error: supervisor.error.message`）与 `manager.ts:1143-1151`（`error: msgOf(entry.error)`）；两处都 `{...server}` 展开含 `env`/`headers`/`url`。sdk 侧 `apply-services.ts:36/56` 原样 `as McpServerSummary` | 部分 |
| ③ | `${ENV}` 展开后的真值 | 任何含该真值的错误文案 | `transport.ts:25-30` 连接时才展开，而 `pipeline/redact.ts:23-27` 的 secret 集合只收配置**字面量** → 真值匹配不到 | 否（集合本身缺值） |
| ④ | `stats.json` 的 `lastError` | 磁盘文件 | sink：`stats/collector.ts:165`（`slice(0,200)`）+ `:256` 落盘。**两个 feeder 必须一起改**：`inject/middleware-register.ts:323`（直传 `error.message`）与 `connection/runtime/supervisor.ts:331`（`msgOf(error)`）——只改 collector 会改错层（collector 拿不到 server 配置）。对照：同源错误在 `middleware.ts:776/782` 走了 `hostRedact` | 否 |
| ⑤ | **`POST /servers` 201 与 `PATCH /servers` 200 响应体** | `{ server, summary }` | `api/routes-controllers.ts:165/187` 的 `server` 来自 `manager.add/update`（`manager.ts:917/941`）= 完整 `ServerConfig`，`config/model/normalize.ts:70-84` 保留 `env`/`headers`/`url`——**完全绕过 summary 投影** | **否（结构性绕过）** |
| ⑥ | **stdio stderr 尾巴** | 拼进错误文案 | `transport.ts:153` 截 4000 字符 → `protocol.ts:49-53` 拼成 stderr 尾注 → `supervisor.ts:383/494` 存入 `this.error` → 经 ② 直出；同时也是 ③ 最可能的落地通道（子进程常回显 env） | 否 |

**修复口径（留给 #770 批次）**：①②⑤ 靠「投影层只允许删键 / 去 URL userinfo」（见 §4.2 第 5 条）；③ 靠把展开后的真值注册进 redactor（或展开前先脱敏）；④ 靠两个 feeder 一并收口；⑥ 靠 stderr 尾巴过 redactor。

---

## 八、这次不做什么（non-goals）

| # | 不做 | 理由 |
|---|---|---|
| N1 | **不重构** `src/client/**`（结构统一归 #769），**但允许为迁移同步做最小必要改动**（A12 已决：仅限文案级、不新增 DTO 字段、不改结构） | 本重构的责任面是宿主↔客户端契约（路由集合 / SSE 帧 / DTO 形状）；客户端结构归 #769 |
| N2 | 包导出面**按三层裁定**：入口 = 安装面 / 配置面 / 契约面；内部符号（含 `McpManager` / `McpStore` / `McpMiddleware` 等仅被测试从产物导入的符号）移出入口 | **A10 已决**：P0 用重构前那棵树冻结基线 → 重写期保持零漂移 → P5 的收缩作为**显式基线变更、逐符号说明理由**（评审实证：`McpManager` 今天在 `src/index.ts:76`，smoke 直接 `new McpManager()`；不让它漂移就等于把测试专用内部符号永久钉在公共 API 上） |
| N3 | 不改 `ctx.mcpManager` 服务面的**内容**（8 方法名与签名） | 它是跨插件 ABI。本轮只改它的**定义位置**（`shared/mcp-manager-service.d.ts` → `src/server/sdk/interface.ts`），消费方仍从包入口取类型 |
| N4 | 不改 HTTP 路由集合与 SSE 帧语义 | 帧集合 `{summary, ui-config-changed, ping}`、零负载 + 回拉 + watchdog 自愈是前端契约 |
| N5 | 不改跨端 DTO 形状与六态计数键集合 | 同上 |
| N6 | **磁盘格式变更仅限存储布局归位**（§五），且由 `upgrade` 域独占 | 除布局外的格式演进不属本轮 |
| N7 | 不动仓库 `shared/` 的其它模块与相对路径引用方式 | **A9 已决后本轮的 shared 面改动归零**（file-io 落包内）；唯一例外是 `mcp-manager-service.d.ts` 退回包内 |
| N8 | 不新增运行时依赖、不动 catalog 锁版 | 仓库约定：只适配 rc、发布物自包含、第三方依赖构建期内联 |
| N9 | **不新增工作流与门禁工具**；**允许扩展既有脚本**（A11 已决：并入 `verify-dir-imports.mjs` 的规则集，不新建文件、不新建 workflow）；只允许更新 `dir-imports-baseline.json` / `mutation-topology.json` / `coverage.config.json` / `gate-scope-registry.json` / `ci-face-registry.json` 等**数据面** | 执法点只有一个（既有 `contract` 段）；判据的包范围显式登记在数据面、**不得内嵌脚本常量**（`gate-scope-registry.json` 的 note 原文即反对这件事） |
| N10 | **不新增门禁工具** | 同上：能挂既有段的一律挂既有段，避免双轨 |
| N11 | **不动其它 `packages/dsh-*` 的代码**（A9 撤销前置 PR 后，本轮没有任何跨包代码改动） | 无例外；仓库级 file-io 提升另开 issue |
| N12 | **#770 的 13 项行为缺陷不在本轮修**（见 §9.2 的口径） | 维护者裁决：先重构再修 bug；本轮只做「结构性单点化、可观察行为不变」 |
| N13 | 不放宽任何测试判据 | 结构重构不得删断言；确需删除须显式登记待补 |

---

## 九、迁移策略与批次

### 9.1 IO 原语：mcp 包内先落（**A9 已决：撤销仓库级前置 PR**）

> **决策依据**：provider-usage 的写盘面实测为 `rename 33 / readFile 31 / writeFile 16 / mkdir 16 / appendFile 9 / open 4`，提议的 3 函数面覆盖不了，仓库级迁移是约 8 个模块的重写而非机械替换；且按 I5 计数，新增共享文件时消费者恒为 0，属提前抽象。**本轮改为在包内解决**：若采纳 A16 则直接依赖 `atomically`（能力全面超出，见附录《成熟实现复用调研》）；否则落 `server/shared/file-io.ts`，并**以 notifier 包内版为唯一参照、逐条登记有意差异**（`mode` / tmp 名 / 是否含 `remove`）。仓库级提升另开 issue。**代价**：包内多一份待迁出的设施（登记于 §十 R11）。

**A9 已决，本段原方案作废**：不做仓库级独立 PR，改为在 `src/server/shared/file-io.ts` 落一份同形态实现（经 `server/shared/interface.ts` 门面暴露），消费者是本包 `config`/`store`/`stats` 与 `upgrade` 四域。**仓库级提升另开 issue**，触发条件是「第三个包真的需要同一形状」（届时 notifier 与 provider-usage 的迁移成本见 A9 裁决列）。**迁移成本的实测（已修正）**：notifier 侧 `file-io` 的引用点是 **31 处 / 10 个文件**（`grep -rn 'writeTextAtomic|readTextFileSync' src`），其中 8 个是真实调用点（`upgrade/impl/steps/*`、`upgrade/impl/version`、`stores/impl/{history,status}`、`api/impl/stream`、`config/impl/service`）——**若 `mode` 必填，这 8 个调用点全部编译失败并逐个要定权限**（与 N11 冲突）；若 `mode?: number`，则只需改 1 处 re-export + 删 1 文件。这正是裁决点 A2 的成本差。provider-usage 侧有 8 个文件内联 tmp+rename 写盘（实测 `grep -rln 'rename(' src`）。**不塞进本重构 PR**：它是仓库级变更，与包级重构的可回退性天然冲突。

### 9.2 缺陷口径：结构性单点化、可观察行为不变

#770 中与边界同源的 5 项（脱敏三口径 / guard 反解与禁用表键 / policy 不覆盖 `mcp__` 直呼轨 / `dispose()` 漏 `transport.close()` / 类型契约与实现不一致）在本轮的处理是：

- **允许**：把三处脱敏合并成一个 redactor 能力（结构单点化），把 `host-faces` 的 4 个面迁成 `deps.ts` 的 Port（类型收窄）；
- **不允许**：改变任何可观察输出（三处输入的 servers 集合差异用参数显式保留；guard 反解与禁用表键的现有映射关系保持；策略拒绝文案保持现状）；
- **验收**：这些面的等价性必须给 A 级差分（同一组输入喂旧实现与新实现，输出逐字节比对），差分不覆盖的分支给 B 级定向变异。

理由：把「三份实现」原样搬进新架构会让新边界一落地就自带错误契约，而缺陷批次还得再造一次边界（同一处改两遍）；但若同批改口径，重构 PR 就无法用「行为等价」自证，diff 也分不清「搬移」与「改行为」。

### 9.3 六个批次（**两段式 PR**，测试跟随每批）

> **PR 切分（二轮评审建议，原因可审性）**：P0 是「公共 API 基线冻结 + 门禁范围变更」，与 P1–P6 的搬移混在一个 PR 里，reviewer 无法把「尺子」与「被尺子判定」分开——而 A10 的零漂移证据正建立在这个分离上。**PR-1 = P0**（尺子与接线，必须早于第一个结构 commit）；**PR-2 = P1–P6**（人力允许再切 P1–P4 / P5–P6）。
>
> **commit 上限建议**：P0 ≤10、P1 ≤12、P2 ≤5/域（5 域 ≤25）、P3 ≤30、P4 ≤15、P5 ≤30、P6 ≤12（合计 ≤130）；硬约束是**每个 commit 只做一件事**（搬移 or 改行为），与 §9.5 探针纪律同源。**squash merge 下批次粒度只存在于分支**，交付物（逐符号收缩表、等价性证据、exit code）必须落 PR 正文或持久文档，否则合并后消失。

| 批 | 内容 | 验收（每条都要 exit code） |
|---|---|---|
| **P0 尺子** | ①修正/作废 `architecture-contract.md` 的 T1 定义与阶段不变式；②`verify-dir-imports` 对 `src/server/` 分组层的支持（**协调者已实测**：`collectModules` 递归取含 `interface.ts` 的叶子目录、分组层天然透明；`inClient` 只看顶层 `client` 目录——P0 只需补 fixture 正反断言）；③重估 `coverage.config.json` 的 `interface.ts` facade 排除项；④清理 `testLayers` 两条失效登记；**变异段重画分两次**——P0 只把 `src/server/**` 以**超集**形式纳入 mutate（旧 glob 保留，否则源文件全覆盖断言会打红 P0 自己），P4/P5 旧树删净后再收敛；⑤**~~新增测试导入面判据~~ 已取消**（A11 已决：暂不限制，改为 PR 评审清单，见 §6.1）；⑥**为 `dsh-mcp-manager` 冻结导出面基线并接入 `contract` 段**（实测 `scripts/data/` 只有 `dsh-notifier-export-surface.json` / `dsh-notifier-export-faces.json`，`contract-check.ts:297` 只对 notifier 跑；`node scripts/gate/export-surface-snapshot.mjs --package dsh-mcp-manager` 报「基线不存在」——**基线必须在第一个结构 commit 之前、用重构前那棵树生成**：若等重写完再跑 `--snapshot`，基线会从新树派生，静默的公共 API 收缩会被永久合法化。**同时必须新建 faces 分类登记 `scripts/data/dsh-mcp-manager-export-faces.json`**（评审实证：`export-surface-snapshot.mjs` 无条件 `loadExportFaces`，缺文件直接 throw exit 1 而不是判红；且 A10 要的「逐符号收缩说明」本有机器承载点——`export-faces-lib.ts:69-72` 规定 legacy 含已不存在的导出即判红，收养它就能把收缩变成可评审的登记改动）。P0 的 exit code 交付项必须含这两条，否则 N2 与 P4 的零漂移验收在本包没有执行者） | `pnpm gate:pr` 全绿；`--graph` 基线与当前一致；新判据的正反 fixture 双向断言；导出面基线已生成且 `export-surface-snapshot` 对 mcp 判绿。**还要补两处漏掉的登记处（二轮评审实测会先红两次）**：`scripts/data/gate-scope-registry.json` 的 `export-surface-snapshot.packages`（现为 "dsh-notifier" 单项，`gate-scope-registry.test.ts:100-118` 断言它必须等于调用点并集）与 `scripts/data/ci-face-registry.json`（`ci-face-coverage.test.ts:14` 用 `git ls-files` 断言 packages/ 之外每个 tracked 文件被某条命中）。**P0 内部 commit 顺序写死**：数据文件（baseline + faces + 两处登记）→ 接线 → fixture |
| **P1 骨架 + 迁移** | `src/server/` 目录 + 各域 `interface.ts`（`installXxx(deps)`/`releaseXxx()` 签名）+ `src/index.ts` 组合根（`bindHost`/`assemble`/逆序释放/声明合并）+ `upgrade` 域 + `paths` 单源（**含 `path + mode` 文件规格**）+ 存储布局迁移 + **IO 原语**（按 A16：`atomically` 或包内 `server/shared/file-io.ts` 经门面导出；`upgrade` 是它的第一个消费者，不落则 P1 迁移无法实现） | 探针证明链路通（apply → install → release 各域标记复位）；迁移测试覆盖四态（有旧文件/无旧文件/目标已存在/读失败）；`version` 刻度推进与失败不推进 |
| **P2 叶子域** | `store` / `stats` / `pipeline` / `config` / `workspace`（各自 impl 分块 + 需要者建 `deps.ts`）+ 对应测试按域落位并改白盒直连 | 每域 `--graph` 无新环；纯函数族 A 级差分；`covered` 不回落 |
| **P3 中枢域** | `connection`（orchestrator + middleware + supervisor + transport + protocol）/ `catalog` / `inject`；McpManager 逐块搬空 | **基线源码级逐条对账**（`git show <baseline>:src/connection/orchestrator/manager.ts` 的对外可观察行为逐条列出 → 新树找落点，找不到即被删的能力）；两路径同构契约测试 |
| **P4 出口域** | `api` / `sdk`；删除 McpManager 与 `bootstrap/`；服务面类型退回包内 | 组合根真实 Context 集成测试（装配顺序/逆序释放/服务面/声明合并）；**导出面验收改口径**：`export-surface-snapshot` 是精确相等、没有「只许收缩」模式，而 P4 要删 `McpManager`（`src/index.ts:76`）与 `bootstrap` 的 6 个符号——两者不可能同时成立。**改为「保留符号的符号集与块多重集零 diff」**，并在 P1–P4 期间对将删的内部符号保留**兼容 re-export shim**（文档已在此写死），P5 统一删除并走 A10 的逐符号基线变更说明 |
| **P5 测试面** | 全部测试按域落位 + 白盒直连；`smoke.test.ts` 按导入面分层；清 `@ts-nocheck`；变异 `testFiles` 改策展；测试导入面判据的存量清零 | 新判据无豁免通过；`uncoveredSrcFiles` 全空；`--min` 上调；`covered` 不回落 |
| **P6 收口** | 中英 README（新存储路径 + 安全模型）、`architecture-contract.md` 重写、v4 归档进 `docs/architecture/dsh-mcp-manager.md`、客户端文案去硬编码、**过时文档清理与注释收口（§9.6）**、`shared/README.md` 登记修正 | `docs:check` 绿（内链不悬空）；包内 `docs/` 只剩有效专项设计 + v4；注释验收三条；`pnpm gate:full` 绿；文案与实现同源复核 |

### 9.4 等价性证据分级（交付里必须标级）

| 级 | 手段 | 适用面 |
|---|---|---|
| **A 差分实测** | 旧实现与新实现喂同一组输入，比较输出 | 纯函数族（`pipeline/*`、`workspace/*`、`config/model/*`、`catalog/digest`） |
| **B 定向变异** | 改坏新实现的那一行，确认红的只有用到它的那条用例 | 抽出来的每个助手 |
| **C 读代码论证** | 只给得出 C 的地方要写明「升到 A 级还缺什么」 | 装配顺序、生命周期 |

**A 级差分只用于纯函数族**（`pipeline/*`、`workspace/*`、`config/model/*`、`catalog/digest`）；**整模块重写的面差分无效**，对下列四个文件只做**基线源码级逐条对账 + 定向变异**，不再叠加差分（两套最贵的手段叠在同一批是浪费）：`manager.ts`（1208 行）、`middleware.ts`（837）、`middleware-register.ts`（842）、`routes-controllers.ts`（400）。
ARCHITECTURE-METHOD §8 的实证：一次 1073 组 A 级差分全绿的按域重写，仍漏掉 4 项已实现能力被静默删除，两轮专家审计都没抓到——**重写面积越大，越不能只靠差分**。

### 9.5 探针与实验纪律

- 变异、差分实验、破坏性验证一律在**探针 worktree**（`/mnt/ssd/worktree/dsh-plugin-hub-<分支>`）做，共享工作区不做；
- 探针里要**同时**同步实现文件与测试文件——只同步前者会看到「改坏了居然是绿的」；
- 用完 `git worktree remove --force` + `git worktree prune`；
- 提交只 `add` 显式路径；越界改动（格式化、lint --fix 顺手改的）还原。

### 9.6 文档与注释收口（参照 notifier 重写后的形态）

**参照事实**：notifier 按域重写后，包内 `docs/` 只剩 `sound-playback-design.md`（一份仍有效的专项设计）+ `archive/`；架构文档搬去仓库级 `docs/architecture/dsh-notifier.md`，一次性产物（v2/v3 方案、阶段规格、评审全文）全部清掉。

#### 9.6.1 过时文档清理清单

| 文件 | 行数/体积 | 现状 | 去向 |
|---|---|---|---|
| `docs/architecture-redesign.md` | 211 行 | v3 目标架构，#664 阶段 0-8 已完成 | 被本文件取代 → **删除**（Git 历史即档案） |
| `docs/architecture-redesign-review.md` | 122 行 | v3 的两轮对抗评审全文 | 结论已吸收进 v4 → **删除** |
| `docs/refactor-phase0-spec.md` | 175 行 | #664 阶段 0 三件套主文档（一次性） | 阶段已完结、跟踪在 issues → **删除** |
| `docs/architecture-contract.md` | 257 行 | 其中 T1 定义与 ARCHITECTURE-METHOD §8 冲突；C-DIR / D10 / 阶段不变式（`apply-services.ts` 禁止移动）已作废 | **重写**：只留仍被机器强制的契约（导出面三层 / DTO / 安全面 / 线协议），其余删除 |
| `docs/requirements-and-tdd-plan.md` | 376 行 | 需求规格 + B/C 系列 bug 清单 | 未修项已归拢 #770（issue 是事实源）→ **删除** |
| `docs/diagrams/` | 1.5M / 8 文件 | archify 概览 HTML + 4 张视觉校验 PNG | 有效图搬仓库级 `docs/architecture/diagrams/`（notifier 同款：只留 html+svg）；校验 PNG **删除** |
| `docs/archive/` | 388K / 11 PNG | #664 期间的浏览器实测截图 | 属 PR 证据（已在对应 issue/PR 留档）→ **删除** |
| `README.md` / `README.en.md` | — | 含旧存储路径与旧结构描述 | **同步更新**（存储路径 + 安全模型 + 结构段落） |
| `shared/README.md`（仓库级） | — | `loopback`/`settings-namespace`/`client/i18n` 三处登记快照与实测漂移；`frontmatter` 零消费者未废弃 | **修正登记** + 新增 `file-io` 行 + 类型面门槛改为 ≥3（宪法 I5） |

**判据**：清理后包内 `docs/` 只剩「仍有效的专项设计 + 本文件（v4 归档版）」；`pnpm docs:check` 绿（文档内链不悬空）。

#### 9.6.2 注释收口口径（三类删、一类留）

| 类别 | 处置 | 实例（现状） |
|---|---|---|
| 阶段/批次标记 | **删**——历史在 commit 与 issue 里 | 各 `interface.ts` 头的「#664 阶段 6 落位」、`bootstrap/apply.ts` 的「#592 阶段二 Batch A」 |
| 结构复述 | **删** | `src/index.ts` 头的「结构：职责按模块拆分（store / transport / protocol / …）」、「下面开始做 X」式分步说明 |
| 指向已删除符号 / 已作废契约 | **删** | `connection/interface.ts` 的「为绕开 TDZ 环而直连 tool-names」特例说明（重写后主语消失） |
| **为什么**类（边界、取舍、失败语义、安全约束） | **保留**，并写得更准 | B17 唯一 tmp 名、`0o600` 落盘理由、fail-closed 判据、coalesce 语义、宿主 waterfall 必须调 `next()` |

**基准取参照包「重构之后」的密度，不取 mcp 现状，也不取清理后的机械计算结果**。

| 口径（脚本：/tmp/comment-stats.mjs 的启发式正则；粒度：文件；单位：注释行） | dsh-mcp-manager **现状** | dsh-notifier **重构后** |
|---|---|---|
| 注释行 / 总行 | 2355 / 11125 = **21.2%** | 2143 / 8512 = **25.2%** |
| 过程类（issue 号 / 阶段 / Batch 标记） | **227 行** | 5 行 |
| 结构复述类（落位 / 迁入 / re-export / 本文件…） | **69 行** | 20 行 |
| 两类合计（应删） | **296 行 = 注释的 12.6%** | 25 行 = **1.2%** |
| 为什么类（应留） | 197 行 = 8.4% | 211 行 = **9.8%** |

两条读数说明为什么不能只看总量：

1. **现状 21.2% 与参照包 25.2% 看起来接近，但成分完全不同**——把未清理样本与已清理样本对比，等于用未清理给未清理背书。mcp 那 21.2% 里每 8 行就有 1 行是过程话。
2. **「清理后估算 18.5%」也不是目标**——那是把 296 行过程话机械删掉的算术结果（(2355−296)/11125）。参照包删干净后是 25.2%，高于 mcp 的估算值，原因是它的**理由类占比更高**（9.8% vs 8.4%）。总量下降本身不是成绩。

**判据用两个数一起看**：

- ①**过程/结构类 → 对齐参照包的残差水平**（≤ 注释行 2%）；这是硬删除项。
- ②**理由类不得下降**：现状 197 行 / 8.4% 是**下限**，目标对齐参照包的 9.8% 量级。重写时若密度掉到 18% 且理由类只剩 5%，那是顺手把「为什么」也删了——属过度精简，退回。
- ③分域看：参照包同规模文件的量级是 17–26%（`config/impl/input` 21% / `channels/impl/system` 24% / `pipeline/impl/dispatch` 17% / `src/index.ts` 26%）。mcp 现状偏高的是 `workspace` 38.0% / `types` 37.1% / `pipeline` 30.4%（小文件多），偏低的是 `inject` 10.3% / `stats` 11.4%——重写后逐域对齐。**

refactor skill §8 的原文仍然是最终裁决：「精炼的判据是读者不再被误导，不是注释行数最少」——但**它不构成「总量随便」的许可**：参照包的实测给了这件事一个可比的量级基准。

**验收三条**：没有复述签名的注释、没有指向已删除符号的注释、没有整段注释掉的旧实现。

---

## 十、已知盲区与风险

| # | 风险 | 对冲 |
|---|---|---|
| R1 | **整模块重写静默丢能力**（§8 已实证） | 基线源码级逐条对账 + 组合根真实 Context 集成测试 + 能力清单随 PR 逐条勾 |
| R2 | **存储迁移的降级不兼容** | 写进 release notes；旧文件归档为 `.migrated.bak`（可人工改回）；迁移测试四态 |
| R3 | **`mode` 必填后，4 个现状 0644 的文件被无判据地定权限**（真实风险方向不是「降级」而是「凭空改动」） | 逐文件目标权限表（现状值 / 目标值 / 理由）+ 落盘权限断言；本轮原则上只允许 `config.json` = `0o600`，其余保持现状并由 P6 README 逐文件如实声明 |
| R4 | **覆盖率/变异基线回落** | 每日守 `covered ≥ baseline − 1pp`；迁移 PR 走 observe 夜间重建豁免（#664 §2.5 机制）；`uncoveredSrcFiles` 必须保持全空 |
| R5 | **复杂度热点搬家**（manager 拆开后可能出现新的高 CRAP 块） | 先接缝后抽函数（§8）；`pnpm crap` 观察期口径下记录热点；不为数字拆函数 |
| R6 | **`declare module` 的 mcp 特例**（现住 `integration/service.ts`，注释记录了 stryker sandbox 解析约束） | P4 重新解一次；判据用 `pack:check` 的「声明合并可达性」（`lib/index.d.ts` 相对 import 闭包内必须有它） |
| R7 | **客户端文案与 #769 交叉** | 本重构只改宿主侧路径知识（客户端从 DTO/路由取），文案改动与 #769 的客户端重构之间留接口 |
| R8 | **`interface.ts` 纳入变异面后覆盖率分母上升** | P0 重估排除面；`verify-coverage-scope` 守面完整性；宁可如实降分也不排除 |
| R9 | **子 Agent 评审结论需交叉复核**（§10 实证：一次评审 4 条「必须修」被否决或降级） | 每条结论附 `文件:行` 或命令输出；协调者一手复跑；只读 worktree 基线 |
| R10 | **测试导入面**（A11 已决：本轮不设门禁） | 风险从「判据上线判红一片」转为「**约束靠自觉、会随时间腐化**」。实测存量若将来补门禁：lan-proxy 2 个（`unit-proxy.test.ts:38`、`unit-apply.test.ts:38`）+ web-file-preview 1 个（`unit-present-open.test.ts:21`）+ 本包 13 个。对冲：写进 PR 评审清单 + 跟踪 issue 待建 |
| R11 | **包内多一份待迁出的 IO 设施**（A9 原决策的代价） | **已被第三方调研消解**：改用 `atomically` 后不再自写 file-io，也就不存在「待迁出」；若最终不引入依赖，则本包实现须以 notifier 包内版为唯一参照（`packages/dsh-notifier/src/server/shared/file-io.ts:15/25/40`：无 mode、pid-only tmp 名、无 remove），并逐条登记有意差异 |

---

---

## 附二：交接状态与续作指引（会话压缩用）

### 环境与基线

| 项 | 值 |
|---|---|
| 仓库（主 checkout，**未改动**） | `/mnt/ssd/dev/dsh-plugin-hub` |
| worktree（本方案所在） | `/mnt/ssd/worktree/dsh-plugin-hub-task-767-arch-v4`（分支 `task/767-arch-v4`，基于 `origin/main@2ca5f82`） |
| 交付物 | `packages/dsh-mcp-manager/docs/architecture-redesign-v4.md`（本文件） |
| **代码基线（所有行号与数字的口径）** | `b490e87`；若与最新 main 有偏差，**以符号名为准**（文中已写明此纪律） |
| 关联 issue | #767（本方案载体）、#773（0.2.5 排期与进度入口）、#770（13 项缺陷归拢）、#664（上一轮分层重构，已合并） |

### 已完成

1. **与维护者 5 轮逐决策对齐**（域划分 / 中枢解体 / 存储布局 / 测试面 / 批次 / 共享层准入 / 交付载体）。
2. **v4 全文**：10 章 + 两个附录——架构宪法 12 条（含 J1/J2 拆分）、11 域边界表 + 7 处易错点 + 开闭量化表、存储布局与 `upgrade` 六件套、测试面目标架构、**六条凭据出境面清单**、non-goals 13 条、六批次两段式 PR、成熟实现复用调研、**16 个裁决点**。
3. **两轮共 8 视角子 Agent 评审**（一轮：分层职责 / 跨端契约 / 安全凭据 / 迁移风险 / 开闭复杂度；二轮：决策自洽性 / A1 专项 / 实施可行性），全部结论经协调者**一手复跑复核**（读数见「协调者一手实测记录」表 D1–D8）。
4. **约 100 处修订**已落，其中 5 个 P0 级：`serverStorePath` 是不存在的键名、迁移清单漏第 5 个落盘文件、A1 出口是 6 条不是 4 条、「投影层值替换」会静默毁凭据、P0 导出面基线漏 faces 登记文件。

### 已决（维护者拍板）

| # | 决策 |
|---|---|
| 目标 | C：按域重写宿主端（notifier #733 路线）；先出宪法 + 边界表 |
| Q1–Q22 | 见正文各处（域清单 / 中枢解体 / 存储布局 / 测试面 / 批次 / 客户端排除 / 单 PR → 二轮改为**两段式 PR**） |
| **A1** | (a)：六条出口登记为已知缺陷，I10 拆 J1（可绿）/J2（pending #770），本轮不改行为 |
| **A9 + A16** | 引入 `atomically`（替换自写 IO）+ `fast-redact`（对象出口脱敏）；A9 的「自写包内 file-io」路径因此取消 |
| **A10** | 入口 = 安装/配置/契约面；内部符号移出；P0 用**重构前那棵树**冻结基线 + faces 登记；P5 逐符号基线变更说明 |
| **A11** | (b)：**测试导入暂不限制**——I8 降为 checklist，P0⑤ 取消，跟踪 issue 待建 |
| **A12** | 客户端不重构但允许最小文案改动（`locales.ts` 两行降为「全局（本机配置）」），前置到 P0 |
| **A14** | 增设 `src/shared/`（跨端层），`server/shared/` 只放宿主侧设施 |

### 未完成（续作清单）

1. **剩余裁决点**：A2 / A3 / A4 / A5 / A6 / A7 / A8 / A13 / A15（协调者均已给推荐，可批量「按推荐」）。
2. **#767 评论未发**：方案摘要 + 两轮评审结论 + 裁决结果尚未落到 issue。
3. **导出面基线未生成**：P0 硬前置（`scripts/data/dsh-mcp-manager-export-surface.json` + `-export-faces.json`，须用重构前那棵树）。
4. **代码一行未动**：按仓库红线流程，等 `approved` 后才开工。

### 建议的下一步顺序

1. 拍完剩余裁决点 → 2. 生成导出面基线 + faces 登记 → 3. 发 #767 评论（走 `needs-proposal-review`）→ 4. 维护者 `approved` → 5. 实施：**PR-1 = P0**（尺子与接线，必须早于第一个结构 commit）→ **PR-2 = P1–P6**。

### 复核要点（新会话最该先做的三件事）

1. **文档内部一致性**：`grep -n 'A[0-9]\{1,2\}'` 核对裁决点编号引用是否都存在；已决项是否都已标「已决」；有无指向不存在章节的引用（本轮修过 `R11` 悬空一处）。
2. **与代码事实的一致性（抽查，不要全信文档）**：`node scripts/gate/verify-dir-imports.mjs --package dsh-mcp-manager --graph`（应为 14 模块 / 4+4 环 / 1 directImpl）｜`grep -rn '0o600' packages/dsh-mcp-manager/src`（应只有 `store.ts:66` 一处）｜`ls scripts/data | grep dsh-mcp-manager`（应为空，即基线未生成）｜`grep -c 'new McpManager' packages/dsh-mcp-manager/test/e2e/smoke.test.ts`（应为 9）。
3. **待办与批次表一致**：§9.3 的 P0–P6 是否有互相矛盾的动作（本轮修过 `testFiles` 策展一处机制上不可执行的动作）。

## 附：本方案的评审与批准状态

- 形成方式：与维护者 5 轮逐决策对齐（域划分 / 中枢解体 / 存储布局 / 测试面 / 批次 / 共享层准入），关键事实由协调者一手实测（`verify-dir-imports --graph`、基线 JSON、规模分布、notifier 对照、shared 消费者统计）；
- 子 Agent 评审：**5 视角全部完成**（分层与职责 / 跨端与宿主契约 / 安全与凭据面 / 迁移与落地风险 / 开闭与复杂度），全程只读、每条结论附 `文件:行` 或命令输出。评审共提出 **3 条 P0 / 26 条 P1 / 20+ 条 P2 / 12 条「过度设计」**；协调者对每份报告的关键断言做了独立复跑（读数见下表 D1–D8 与各修订条目），**已落约 45 处修订**，剩余分歧收口为上面的 **A1–A13 裁决点**；
- 批准通道：按仓库红线流程，结论落 #767 方案评论 → 维护者 `approved` → 才动手实施。

### 待维护者裁决点（评审提出、协调者复核后无法单方决定）

> 每条都经过协调者一手复核（命令与读数见下一小节）；「建议」是我的判断，不是既成事实。

| # | 来源 | 分歧 | 选项 | 协调者建议 |
|---|---|---|---|---|
| A1 | 安全视角 P0（二轮已细化） | I10 把「HTTP body 与日志同口径脱敏」写成不变式 + 机器判据，但现状**六条**出口未脱敏、N12/§9.2 又禁止改可观察输出。**二轮评审纠正三点**：(1) 出口是 **6 条**不是 4 条（§7.4，新增 ⑤ POST/PATCH 响应体、⑥ stdio stderr 尾巴）；(2)「都在 loopback 围栏后」对 ② 为假（sdk 进程内通道无围栏）；(3) (b) 的两处调用点**都不是**「同层内、不涉域边界」——① 要脱敏就得给 `api/deps.ts` 加脱敏面（域边界改动），改成枚举文案则打红 `unit-routes-sse.test.ts:557-564`；② 的成本在跨端 DTO（破 N5） | **已决：(a)**——§7.2/§7.4 已拆行、I10 已拆 J1/J2 并标 pending；**剩余待办** = P0/P2 把 §7.4 的六条出口清单落成契约测试（`test/integration/redaction-exits.test.ts`），#770 第 1/7 项修复批次清空清单后才启用 J2 绝对值断言。若走 (b)，二轮评审建议拆 **(b1)** ①④⑥ 出口面收口（不动 DTO）与 **(b2)** ② 的跨端形状变更（破 N5、逐字段登记）两条独立裁决 |
| A2 | 安全视角 P1（二轮已推翻其前提） | 「`mode` 必填 vs 可选」。**二轮评审证明原论证前提失效**：A9 撤销仓库级 PR 后 notifier 不再被改，且 notifier 现存实现**根本没有 mode 参数**（`dsh-notifier/src/server/shared/file-io.ts:25/40`）→「必填会让 8 个调用点编译失败」的代价归零；同时 R3 以「mode 必填」为前提，与 A2(b) 方向相反 | **改判：权限不再由写函数的参数形状承载，而是存储布局的文件属性**——在 `server/shared/paths.ts` 的登记里写 `path + mode`（四个现状 0644 文件保持、`config.json` = `0o600`），写函数接该规格。若采纳 `atomically`（A16），其 `mode` 语义正好承载（**默认复制旧文件 mode**、显式传值则用之）。这样权限决策从 4 个调用点收敛到 1 处，满足 I3/I7 |
| A3 | 分层视角 P1 | 迁移期旧文件**解析失败**（JSON 坏）的语义 | (a) 抛错中止启动（notifier 口径）；(b) warn + 保留旧文件不迁移 + 按空形态继续（mcp 现状口径） | **(b)**：现状读面全容错（`store.ts:38` / `middleware-state.ts:36`），改成抛错是行为变更。**补一条决定性语义（二轮评审指出未写死）**：解析失败时**不推进 `version` 刻度、旧文件原样保留、每次启动重试并 warn**——若不推进，用户修好坏 JSON 后仍能迁移；若推进，旧文件成永久孤儿而新位置已写空形态。P1 验收的迁移测试随之从四态改**五态**（有旧文件 / 无旧文件 / 目标已存在 / IO 读失败 / 解析失败） |
| A4 | 分层视角 P1 | 5 个目录边界常量（`CATALOG_TTL_MS`/`LIST_*`/`MAX_*`）物理定义在 `connection/runtime/limits.ts`，被 `catalog` 与 `inject` 跨域取值 | (a) 归位 `catalog` + 跨域常量消费写进 `deps.ts` + 泄漏面统计纳入常量边；(b) 维持现状、只登记 | **(a)**：常量归语义所有者（目录边界常量 → `catalog/interface.ts`），否则意图图与事实图长期不一致。**落地子句要改（二轮评审指出不可执行）**：原写「跨域常量消费写进 `deps.ts`」——`deps.ts` 是**纯类型面**且值 import 硬判红，常量为值、无法经它传递。改为：常量归 `catalog` 的 `interface.ts`，跨域消费是**合法值边**，在常量边清单与泄漏面里显式登记 |
| A5 | 分层视角 P1 | I4 新门禁「门面每个导出必须有域外消费者」 | (a) 硬执行（存量登记 → P5 清零）；(b) 降级为改动前 checklist（方法论 §12 原位） | **(a)**，但需先定义「域外消费者」粒度（按域 / 按文件 / 含组合根汇聚点）；**口径先钉死**（二轮评审指出两处读数矛盾）：消费者 = **非本域文件**（组合根 `src/index.ts` 计入，同域 `impl` 与测试不计）。按该口径实测存量为 **3** 个（`api/interface.ts: queryParam`、`connection/interface.ts` 与 `connection/orchestrator/interface.ts: stripMcpPrefix`——正是 §1.2 描述的 TDZ 特例化产物）；初稿写的「192 导出 / 零消费者 0」是**宽松口径**（任意文本命中即算消费者），已作废。这 3 条随 P3 消除或进 baseline |
| A6 | 分层视角 P1 | 组合根现存三处业务判断的落点（`syncMiddlewareFromSettings` / `resolveMiddlewareMode` / D8 guard 分支） | 推荐：`resolveMiddlewareMode` + stats 配置解析 → `config`/`stats` 的装配入参；D8 分支 → `inject` 的 `installInjection(policy)` 内部 | 采纳推荐：组合根只做「收窄 / 按序装配 / 注册生命周期」。**但要写清与 §3.2 第一条纪律的边界**（二轮评审）：**初始值经装配入参，后续变更经能力**——即 mode 的初值可作为入参传入，而用户改设置后的热切换必须经 `setMiddlewareMode` / `uiUpdate` 能力，不得把装配期快照当常量交付 |
| A7 | 分层视角 P2 | `store`「唯一写面」的实际范围：`stats` 自写盘（自 import `node:fs` + 自建 tmp 名，`collector.ts:12/255-257`） | (a) stats 计算留在 `stats` 域、落盘经 `store`（需建 `stats/deps.ts`）；(b) stats 自写，「唯一写面」改为「除 stats 外」 | **(a)**：否则「唯一写面」不成立，重写后仍有第二处 `node:fs` 写盘 |
| A8 | 分层视角 P2 | 类型归属与 Q6 决策的张力：`server/shared/type.ts` 集中 vs 按所有者拆回各域（refactor skill 规则 4「类型的物理定义在 impl 块里」） | 调和：**跨端 DTO**（`ServerConfig`/`ClientUiConfig`，≥3 域消费）留 `server/shared`；**有单一所有者与领域语义**的（`MiddlewarePolicy`/`DisabledToolsMap` → `pipeline`；`ServerStatus`/`ProjectUnit` → `connection`）回各域 `interface.ts` | 采纳调和：共享层只放「无归属的公共语言」，不放「有主人的模型」 |
| A9 | **3 份评审一致提出**（开闭 / 跨端 / 迁移） | **挑战 Q20-A**：`shared/file-io` 仓库级前置 PR | (a) 维持前置 PR（shared 登记 + scripts/test 新用例 + notifier/provider-usage 同迁）；(b) mcp 先落**包内** `server/shared/file-io.ts`（同形态：`mode` 必填/判别式返回/pid+时间戳 tmp 名），仓库级提升另开 issue | **(b)**：provider-usage 的写盘面实测是 `rename 33 / readFile 31 / writeFile 16 / mkdir 16 / appendFile 9 / open 4`，提议的 3 函数面覆盖不了，迁移是 ~8 模块重写而非机械替换；且按 I5 计数新增共享文件时消费者恒为 0，属提前抽象。**代价**：mcp 包内多一份待迁出的设施 |
| A10 | 跨端 P1 + 迁移 P1 | **挑战 N2/N13**：`export-surface-snapshot` 零漂移 vs `McpManager` 彻底消失——`McpManager` 今天在包导出面上（`src/index.ts:76`），smoke 直接 `new McpManager()`（`smoke.test.ts:587/897/1928/2979/3568/3659`），删它则导出面必然漂移而没有任何门禁看得见 | (a) 入口 = 安装面/配置面/契约面，内部符号移出；P0 冻结基线，P5 的收缩作为**显式基线变更逐符号说明**；(b) 入口继续 re-export 测试专用内部符号（则 I4/§6.5 的收口永远达不成） | **(a)**：这才是把「测试从产物入口导入」这条反模式真正拔掉；代价是 P5 必须交一份逐符号的收缩说明 |
| A11 | 开闭 P1 + 迁移 P1 | 新增「测试导入面判据」与 N9/N10 互斥：实测执法点是 `contract-check.ts` spawn 各脚本，仓库现有工具都扫不到 `test/`（`verify-dir-imports` 只扫 `src`，`forbid-src-tests` 只管 `*.src.test.ts`）；按仓库级落地会立刻判红 lan-proxy 2 个 + web-file-preview 1 个 | (a) 授权**修改既有脚本**（不新增文件、不新增工作流），N9 措辞改为「不新增工作流与门禁工具」；(b) 放弃该判据 | **(a)**，且补三条约束（二轮评审）：① 新判据的包范围**显式登记在数据面**（不内嵌脚本常量）；② 3 个存量文件走 `gate-exemptions.json`（文件级 + `trackingIssue`），本包 13 个走单调基线、P5 清零；③ 判据**只对 `test/unit/**` 生效**（`client`/`e2e` 各有产物与浏览器语义）。二轮评审同时确认：**(b) 不是方案而是现状**——notifier 的「测试目录按域」确为约定（`$testLayers.layers.unit` 是扁平 glob、6 个门禁无一扫 test 导入面），选 (b) 就必须把 I8 从不变式降为 checklist 并写明补门禁的跟踪 issue，否则与 §二 I8 的判据句自相矛盾。**维护者已决：走 (b) 方向——测试导入暂不限制**；已按此把 I8 的判据句降级、删除 P0⑤、改写 R10，并把三条导入面纪律落在 §6.1 的 PR 评审清单里 |
| A12 | 跨端 P1 + 迁移 P1 | **N1/N5 与 P6 互斥**：`src/client/locales.ts:74/177` 硬编码 `~/.dsh/dsh-mcp.json`，P6 要求「客户端文案去硬编码」；但改 client 撞 N1，给 DTO 加字段撞 N5 | (a) 文案降为「全局（本机配置）」——**零 DTO 改动、零客户端改动**；(b) 新增 DTO 字段并显式列为本轮唯一例外、同步改 N1/N5 | **(a)**：迁移让这条文案变成错的，但显示路径本身对用户无价值 |
| A13 | 跨端 P1 | `sdk.getTools` 的前提是假的：现状只读 `manager.supervisors`（`apply-services.ts:41-55`），中间层接管时恒返回 `[]`；而 `summary()` 走中间层投影（`manager.ts:1122-1135`）。§4 写「getTools 与 summary 同源」= 一次未登记的跨插件 ABI 行为变更 | (a) 本轮原样搬移（仍只读 supervisors），同源改写另立批次；(b) 列入 §9.2 允许清单 + A 级差分 + release note | **(a)**：N3/N12 禁改服务面行为，diff 里要能区分「搬移」与「改行为」 |
| A14 | 跨端视角 P2 | **挑战 Q6**：跨端层放哪——参照包 notifier 有独立 `src/shared/`，而 mcp 把跨端 DTO 放 `server/shared/` 后**客户端无法合法引用**（N1 又把客户端推给 #769），跨端契约没有物理位置 | (a) 增设 `src/shared/`（与 notifier 对齐），`server/shared/` 只放宿主侧设施（paths / file-io / host-faces）；(b) 维持 `server/shared/`，跨端面等 #769 | **已决：(a)**——增设 `src/shared/`（跨端层），`server/shared/` 只放宿主侧设施。§4.3 的「六态表跨端共用」因此有了物理位置（但共用本身仍受 N5/A12 限制，本轮不可达，见该行标注） |
| A15 | 二轮决策自洽性 | §4.2 第 7 条的二选一**没有编号、也没进 P3 验收**：`connection` 的块级解耦**没有任何机器判据**（`verify-dir-imports` 的 `moduleOf` 取含 `interface.ts` 的最近祖先，`impl/<块>/` 同属一个叶子模块，块间引用恒不判红） | (a) 补一条块级 import 判据（同 A11，扩展既有脚本）；(b) 接受自觉纪律，但写进 P3 验收的「状态所有权」清单 | **(b)**：本轮范围已经很大，块级门禁留后续；但 **P3 验收必须逐块写清状态所有权**（谁改 supervisors 池、谁拥有 `registerQueue` 与 `syncChain` 的顺序） |
| A16 | 本轮第三方调研（新） | 是否引入 `atomically`（替换自写 IO）与 `fast-redact`（对象出口脱敏）——见附录《成熟实现复用调研》 | (a) 两者都引入；(b) 只引入 `atomically`；(c) 都不引入、保留自写 | **已决：(a)**——引入 `atomically`（替换自写 IO）+ `fast-redact`（对象出口脱敏）。两者均 MIT、构建期内联、license 归集进 `lib/THIRD-PARTY-LICENSES`。**落地点**：P1 用 `atomically` 承接 IO 原语（取消 A9 的「自写包内 file-io」路径）；`fast-redact` 用于 §7.4 出口 ②⑤ 的对象序列化，**配置读面仍须删键**（§4.2 第 5 条）。`atomically` 的 `fsync` 默认开启会拖慢写盘，用 `fsyncWait: false` 调 |

### 成熟实现复用调研（第三方库评估，2026-09 实测元数据）

> 仓库准则第四条是「复用优先，不重复造轮子」。本节对包内**每一处自写实现**做了候选库评估；判据含 license、维护活跃度、体积、以及"是否与本仓『零运行时依赖 + 构建期内联』模型相容"（本包 `dependencies` 为 `{}`，第三方一律 `devDependencies` + esbuild 内联 + license 归集进 `lib/THIRD-PARTY-LICENSES`）。
> **注意**：本仓红线「新增第三方依赖」需维护者评审，本节只做评估，不构成引入。

#### 已经在用成熟实现的（不是自造）

| 模块 | 现用 | 说明 |
|---|---|---|
| MCP 协议 / 传输 | `@modelcontextprotocol/sdk@1.30.0`（MIT） | `protocol.ts` 的 JSON-RPC 帧构造与 `transport.ts` 的 stdio / streamable-http 都是**薄适配官方 SDK**（`Client` / `StdioClientTransport` / `StreamableHTTPClientTransport`），已内联进 THIRD-PARTY-LICENSES |
| JSON Schema 校验 | `ajv@8.20.0`（MIT，已内联） | 工具 outputSchema 校验 |
| YAML 解析（notifier 侧） | `yaml` | 非本包 |
| 哈希 / 随机 | `node:crypto` | 目录缓存 key、tmp 名 |

#### 建议替换为成熟实现的

| 模块 | 自写现状 | 候选 | 元数据 | 建议 |
|---|---|---|---|---|
| **原子写 / 容错读** | file-io（mcp 内联 4 处 + notifier 1 份 + provider-usage 8 处，各写各的 tmp+rename） | **`atomically@2.1.1`** | MIT / 2026-02 / 28KB / **0 第三方依赖** / TS 写的 | **强烈建议替换**。它是 `write-file-atomic` 的重写且 drop-in，能力全面超出自写：同路径写入自动排队、读取超时重试、自动建父目录、自动解析符号链接、`ENOSYS/EINVAL/EPERM`（POSIX 非 root）与 `EMFILE/ENFILE/EAGAIN/EBUSY/EACCES` 重试、`ENAMETOOLONG` 路径截断规避、tmp 文件在进程崩溃时也清理、`mode` / `fsync` / `timeout` / `chown` 选项（`mode` 默认**复制旧文件 mode**，`false` → `0o666`，显式传值则用之——正好承载 A2 的权限语义） |
| **对象出口脱敏** | `pipeline/redact.ts` 的文本值替换 | **`fast-redact@3.5.0`** | MIT / 2024-03 / 92KB / 0 依赖 | **部分建议**：出口 ②⑤ 是**对象**（`summary().servers`、`POST/PATCH` 的 `server`），`fast-redact` 的 `paths`（`['*.env','*.headers','*.url']` + 通配符）能覆盖。**但必须区分两个读面**：**出口序列化**（HTTP 响应/日志，可掩码为 `[REDACTED]`）与**配置读面**（客户端编辑表单取数，**必须删键**——掩码会经 `update()` 的 merge 语义写回配置、静默毁凭据，见 §4.2 第 5 条） |
| **超时兜底** | `pipeline/timeout.ts` 41 行 `withTimeout` | **Node 内置 `AbortSignal.timeout()`** | 平台能力，v17.3+ | **优先平台内置**（平台 > 库 > 自写）。需核实"竞态清理"部分是否可完全替代；不可替代则保留薄包装 |

#### 评估后**不建议**替换的（附理由）

| 模块 | 自写现状 | 候选 | 不换的理由 |
|---|---|---|---|
| **文本出口脱敏**（error.message 里的**已知 secret 值**） | `pipeline/redact.ts` 64 行 | 无通用库：`fast-redact` 是对象路径、`redact-pii@3.4.0`（MIT/462KB）是**形态正则**（email/SSN/信用卡），都不是「已知值替换」 | 业界把这类叫 **known-secret redaction**，通常做在网关/DLP 层（GCP DLP、OTel redaction processor），Node 生态**没有标准库**——因为「secret 值是什么」是应用知识（本包要从 MCP 服务器配置的 `env`/`headers`/`url` 运行时收集）。**保留自写**，但可借鉴业界惯例做源头收窄（错误文案只带 host、不带 userinfo） |
| glob 匹配 | `globMatch` 17 行（只支持 `*`） | `picomatch@4.0.7`（MIT/94KB） | **语义变更**：`picomatch` 支持 `**`/?/{}/!`，而我们的策略配置（`allowTools/denyTools`）现有语义只有 `*`——替换会让既有配置的匹配结果变化，属行为变更，不该混进结构重构。登记为**后续单独评估** |
| 重连退避 | `resolveReconnect` 34 行（纯函数**算下次延迟**） | `p-retry@8.0.1`（MIT/26KB）、`backoff`（2022 年停更） | 我们不是「执行重试循环」，而是「解析退避参数供 supervisor 的定时器用」；用 `p-retry` 要把重连控制权交给库 = 架构级改动 + 行为变更 |
| LRU | 自写 `CATALOG_LRU_MAX` 淘汰 | `lru-cache@11.5.2` | license 是 **BlueOak-1.0.0**（非 MIT/ISC，需先确认 license 归集机制支持），未打包体积 2.7MB，而我们只需要「按 key 淘汰」几十行 |
| SSE 服务端 hub | `shared/sse-hub.js`（连接表 + 心跳 + 上限淘汰 + stalled/maxAge 回收） | 无 | 业界**没有服务端 SSE hub 标准库**（`eventsource-parser@4.1.0` 是客户端解析器）。保留自写 |
| 环境变量展开 | `expandEnv` 19 行（`${VAR}`） | `dotenv-expand@1000.0.0`（BSD-3/298KB） | 它语义更复杂（默认值、嵌套展开、转义），而我们只声明 `${VAR}`；替换是行为变更 |

#### 对已决事项的影响

- **A9 可以升级**：原决策是「mcp 包内先落 `file-io.ts`」。既然 `atomically` 是现成的 npm 包（0 依赖、MIT、能力全面超出），**自写 file-io 这件事本身就可以取消**——直接依赖 `atomically` 并内联。这同时消解了 A2 与 A9 的 `mode` 口径冲突（`atomically` 的 `mode` 语义已定义清楚），也**不再需要**「未来提升到仓库 shared」这条尾巴（npm 包天然跨包可用）。
- **A2 的形态改为**：`atomically` 的 `mode` 选项——**默认复制旧文件 mode**（对 4 个现状 0644 的文件这是「保持现状」，正好符合 R3 的要求），`config.json` 显式传 `0o600`。
- 代价：新增 1 个第三方依赖（走本仓红线评审）；`atomically` 的 `fsync` 默认开启会让写盘变慢（可用 `fsyncWait: false` 或 `fsync: false` 调，见其 README 的 10x 说明）。

**A16 已决：引入 `atomically` + `fast-redact`**（维护者批准）。落地约束：两者走 `devDependencies` + 构建期 esbuild 内联 + license 归集（`pack:check` 双向断言）；`fast-redact` 只用于**出口序列化**，配置读面仍按 §4.2 第 5 条删键。

### 协调者一手实测记录（独立于子 Agent 评审，§10「子 Agent 结论必须交叉复核」的基础）

| # | 实测项 | 证据 | 结论 |
|---|---|---|---|
| D1 | 落盘点完整性 | `grep -rn 'join(dshHome()' packages/dsh-mcp-manager/src` → 5 处 + `resolve(dshHome())` 1 处 | **初稿漏了 `dsh-mcp-catalog.json`**（`catalog/cache-view.ts:27`，写路径 `manager.ts:188-193`），已补入 §5.1 |
| D2 | 门禁对 `src/server/` 分组层的支持 | `scripts/gate/verify-dir-imports.mjs:429-445`（`collectModules` 递归取叶子）+ `:540`（`inClient` 只看顶层） | 天然支持，P0 该项降级为 fixture 正反断言 |
| D3 | 宪法 I1（域内无 `Context`）的可达成性 | `grep -rl 'Context' packages/dsh-notifier/src/server` → **0 个文件** | 参照包已达成，判据不激进 |
| D4 | 宪法 I4（门面导出必须有域外消费者）现状命中 | `node /tmp/i4-check.mjs packages/dsh-mcp-manager/src` → 门面 14 / 导出符号 192 / **零消费者 0** | 新判据上线不会一次判红一片，可直接硬执行 |
| D5 | 前置 PR 的迁移成本 | notifier：`file-io` 引用 **31 处 / 10 文件（其中 8 个调用点）**；provider-usage：8 文件 | **修正**：原结论「改 1 处 re-export」只在签名不变（`mode` 可选）时成立；`mode` 必填则 8 个调用点全要改（安全视角复核，协调者已实测） |
| D7 | 参照包 `upgrade` 域的机制完整度 | `packages/dsh-notifier/src/server/upgrade/`（interface/chain/version/steps/legacy/service） | 初稿只抄了 storage-layout；实际有**六件套**（步骤表/链驱动/刻度/失败即中止/对账/装配标记），已补 §5.4 |
| D8 | 注释成分（过程类 vs 理由类） | `/tmp/comment-stats.mjs`：mcp 21.2%（过程类 296 行 / 12.6%）vs notifier 重构后 25.2%（过程类 25 行 / 1.2%） | 「以重构后密度为基准」的口径已写入 §9.6.2（判据 = 过程类≤2% 且理由类不下滑） |
| D6 | 测试对中枢内部的耦合度 | `unit-manager2.test.ts` 中 `.supervisors` 45 处、`.middleware` 45 处、`.catalogCache` 24 处、`.runtimeRegistry` 7 处 | 中枢解体时该文件大量断言失锚；§6.2 需补「失锚断言的改写口径」（待评审汇总后补） |
