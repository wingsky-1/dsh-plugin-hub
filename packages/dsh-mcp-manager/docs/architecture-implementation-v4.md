# dsh-mcp-manager 架构实施规范（目标态）

> **定位**：本文是 `@wingsky-1/dsh-mcp-manager` **架构重构的验收面**——模块职责、层间边界、上下游契约的唯一仓内事实源。实施期的每个 PR 以本文 + `architecture-contract.md` 为验收基准。
>
> **载体**：issue #744（`approved`）。**本文是 #744 的仓内落地**；#744 正文保留评审过程与全部实测证据，两者冲突时以 #744 为准并在 PR 内记录。
>
> **与既有文档的关系**：
> - [architecture-redesign.md](architecture-redesign.md)（v3）：解决「十域结构重整」，已由 #664 阶段 0–8 执行完毕，**保持其作为已落地结构的历史记录**；
> - [architecture-contract.md](architecture-contract.md)：**契约条款与验证方式**的事实源，本文不重复其条款；
> - [refactor-phase0-spec.md](refactor-phase0-spec.md) / [requirements-and-tdd-plan.md](requirements-and-tdd-plan.md)：阶段 0 三件套与需求规格；
> - 本文：**目标态结构 + 边界判据 + 分阶段迁移**；三者不重复描述。
> - 仓库级原理图解：[docs/architecture/dsh-mcp-manager.md](../../../docs/architecture/dsh-mcp-manager.md)。
> **基线**：`origin/main` `dedfe48`。**方法**：6 个独立视角评审 + 2 轮对抗评审 + 协调者一手实测。全部量化带口径。
>
> **硬约束**：**本重构不改功能。** 判据唯一——对所有合法输入，改前改后**可观测输出逐字相同**。输出不同者属行为修复，登记于 issue #745，不在本重构范围。

---

## 一、设计目标（可测）

| # | 目标 | 度量 | 基线 | 目标值 |
|---|---|---|---|---|
| **G1** | 同一判断只有一处实现 | 「判断实现点」计数 | 释放 4 个独立实现 + 2 个语义不同的 per-entry 块；脱敏 7 调用点 3 形态；身份反解 2 族分歧；裁决 2 块 | 各 **1** |
| **G2** | 层边界可机器判定 | 四条层禁令的可判定率 | **0 / 4** | **4 / 4**，各配负向 fixture |
| **G3** | 单点认知半径可控 | 单文件行数 | 6 个文件 > 250 行（`manager.ts` **1098**、`middleware-register.ts` **730**、`middleware.ts` **694**、`supervisor.ts` **523**、`entries.ts` **352**、`search.ts` **344**） | 全部 **≤ 250 行** |
| **G4** | 度量面完整 | 变异面盲区 | 净变异面 42 / 78 = 54%（盲区 36 文件，目录级 glob 排除） | 盲区**逐条显式豁免并带理由** |

**G3 的来源**（变更频率实测，`git log -n 100 --name-only -- packages/dsh-mcp-manager`）：

```
126  src 根文件      |  93  client      |  30 index.ts    |  20 manager.ts  |  17 routes.ts
 16  middleware.ts   |  16 connection   |  15 apply.ts    |  14 catalog     |  11 pipeline
 11  middleware-utils.ts  |  11 middleware-register.ts  |  9 workspace
```

**高频变更的文件恰好就是最大的文件**——这是本重构以「拆文件」为首要收益、而非以「目录对称」为目标的依据。

---

## 二、模块职责与边界

### 2.1 层与职责

```
消费侧：模型（工具面）│ 用户（Web GUI）│ 其他插件（SDK 面）
──────────────────────────────────────────────────────────
model-face/   模型面形态策略：直呼轨注册 · 四原子 · 目录注入 · 提示词分节
gateway/      per-workspace 池 · 目录 · 检索
──────────────────────────────────────────────────────────
x/            横切四单点：唯一实现，其他任何地方不得再出现第二份
              sanitize（出站管道）· session（释放/代际）· identity（身份表）
──────────────────────────────────────────────────────────
adapter/      transport · model · http · client
port/         依赖倒置点（5 个）
bootstrap/    装配 · 热切换 · 生命周期
──────────────────────────────────────────────────────────
core/         薄核心：零 IO / 零官方包 / 零第三方 / 零 process.env
依赖方向恒为：adapter → port → core（x 可被任意层依赖）
```

### 2.2 模块清单（职责 / 边界 / 现状来源）

每个模块 = **含 `interface.ts` 的目录**（门禁的模块定义，不得用平铺 `.ts`）。

| 模块 | 职责 | 不得做 | 现状来源 |
|---|---|---|---|
| `core/spec/` | `ServerConfig`（自有最小 `ToolDefinition`）/ `ServerStatus` 六态 / `Scope` / 品牌类型 `ProjectRoot` / 全名解析 / 纯工具（`normalizeArguments` / `msgOf` / `withTimeout`） | 不得 import MCP SDK、`@deepseek-ai/*`、第三方；不得 `fs`；不得取 `process.env`；不得依赖 `types/**` | `types/{server,status}.ts` + `workspace/{full-name,scope,middleware-mode,root-resolution}.ts` + `pipeline/{args,msg,timeout}.ts` |
| `core/policy/` | `globMatch` / `policyAllows` / `policyDenialReason` / `isToolDenied` / `toolDisabledReason` / `checkRoot` / `verdict()`（唯一裁决出口） | 同上；**不得做身份解析**（由 `x/identity` 在调用前归一到三元组） | `pipeline/authorize.ts`（去掉对 `workspace` 的值依赖）+ `inject/middleware-register.ts:80-109` 的 `checkMiddlewareRoot` |
| `core/catalog/` | 条目组装 / 摘要 / 打分 / 装箱 / fresh 判定（纯函数族） | 同上；**时间由调用者传入**，不读 `fs`、不 `Date.now()` | `catalog/{entries,search}.ts` 的纯函数部分 |
| `port/host/` | 宿主能力唯一收窄面：`Context` / `LoggerService` 收窄 + `HostErrorPort`（唯一错误成形点）+ 事件 / 提示词子面 | 不得含业务分支；不得 import 具体 adapter | **官方类型 12 处**（`cordis` 9 + `dsh-agent` 2 + `dsh-system-prompt` 1）/ 15 文件 |
| `port/mcp/` | 传输注册表 + `clientIdentity()` | 同上 | `connection/runtime/protocol.ts` |
| `port/persist/` | 原子写 / 权限 / 锁 / 容错唯一面 | 同上 | **7 个调用点 / 5 文件的 tmp+rename**（含 `stats/collector.ts:243` 的 `renameSync`） |
| `port/credential/` | `resolve(template) → {value, secrets}`；`expandEnv` 唯一导出者 | 同上；**本轮只建接口与登记点，不改展开语义** | `connection/runtime/transport.ts` 的 `expandEnv` + `pipeline/redact.ts` 的登记 |
| `port/model-face/` | 模型可见面**注册契约**（含 `dsh-tools` 官方面） | 同上；**实现不在本模块**（在 `model-face/`） | **官方类型 6 处** |
| `x/sanitize/` | 出站文本管道：脱敏 → 截断 → 投影（**唯一出口**） | 其他任何模块不得再做脱敏/截断/投影 | `pipeline/{redact,project}.ts` + `supervisor.ts` 的 `truncateText` + `middleware.ts` 的 `redact`/`hostRedact` |
| `x/session/` | 释放注册表：**释放的唯一遍历者** | 其他任何模块不得直接 `transport.close()` | 4 个独立释放实现 + 2 个 per-entry 块（见 §三.1） |
| `x/identity/` | 双向身份表 `(scope, server, bare) ↔ publicName` | **本轮只新增旁路表，不改现有反解规则** | `workspace/full-name.ts`（正向）+ `inject/middleware-register.ts:595-599` + `supervisor.ts:41-46` |
| `gateway/pool/` | per-workspace 池：unit 生命周期 + LRU + 建连窗口状态广播 | 不得做持久化 / 脱敏 / 释放 | `connection/runtime/middleware.ts` 的池部分（694 行中约 330 行） |
| `gateway/catalog/` | 目录条目缓存视图 | 落盘经 `port/persist` | `catalog/cache-view.ts` + `middleware.ts` 的目录方法 |
| `gateway/search/` | 检索族（多 root 合并） | — | `catalog/search.ts` |
| `model-face/direct/` | 直呼轨注册（`mcp__<server>__<tool>`） | 不得自行脱敏/截断 | `supervisor.ts` 的工具定义派生 |
| `model-face/atoms/` | `ws_mcp_*` 四原子定义 | 同上 | `inject/middleware-register.ts` 的四原子部分 |
| `model-face/inject/` | `<available_mcp_servers>` 目录注入 | — | `catalog/injection.ts` |
| `model-face/guidance/` | 系统提示词分节（`order=160`） | — | `bootstrap/apply-guidance.ts` |
| `adapter/transport/` | MCP SDK（stdio / streamable-http）+ 子进程环境 | 不得被 `core`/`port` import | `connection/runtime/{transport,protocol}.ts` |
| `adapter/model/` | `ctx.tools` 适配 | 同上 | `supervisor.ts:482` + `middleware-register.ts:719` |
| `adapter/http/` | 路由 + SSE（loopback 围栏） | 同上 | `api/**`（4 文件 610 行） |
| `adapter/client/` | 浏览器端（**本轮不动行为**） | 同上 | `src/client/**`（15 文件 2192 行 + `style.css` 155 行） |
| `bootstrap/` | 装配 / 热切换 / 生命周期 / 导出面 | 不得含业务判断 | `bootstrap/**`（6 文件 619 行，原样保留） |
| `sdk/` | 包 ABI（原 `integration/`） | **不新增 `exports` 子路径** | `integration/**`（2 文件 43 行） |
| `types/` | 只剩客户端面类型（`ui.ts`） | 其余类型已按 §2.2 归属迁出 | `types/**` 原 6 文件 335 行 |
| `placement-math.ts` | 浮窗定位纯函数（宿主端与客户端 bundle 共用） | **保持原位**（跨面共享，零依赖单一事实源） | `src/placement-math.ts` |

### 2.3 与 `architecture-redesign.md`（v3 十域）的对应

v3 的 14 个门禁模块 → 目标态的迁移去向：

| v3 模块 | 去向 |
|---|---|
| `types` | 拆解：`server`/`status` → `core/spec`；`middleware-types` 按类型分入 `core/{policy,catalog}` 与 `gateway/pool`；`host-faces` → `port/*`；`ui` 留原地 |
| `pipeline` | 解体：`authorize` → `core/policy`；`redact`/`project` → `x/sanitize`；`args`/`msg`/`timeout` → `core/spec` |
| `workspace` | 并入 `core/spec`（纯字典与纯函数）；需 `dshHome()` 的部分经 `port/host` 注入 |
| `catalog` | 纯函数 → `core/catalog`；缓存视图 → `gateway/catalog`；检索 → `gateway/search`；注入 → `model-face/inject` |
| `connection/orchestrator` | 释放/代际 → `x/session`；工具定义 → `model-face/direct`；运行时注册表 → `port/model-face`；状态投影 → `core/stats` 纯函数部分 |
| `connection/runtime` | `middleware.ts` 5 类职责按 §2.2 拆散；`supervisor.ts` 拆散；`transport`/`protocol` → `adapter/transport` + `port/mcp` |
| `inject` | 四原子 → `model-face/atoms`；guard → `model-face/direct`；投影 → `x/sanitize`；身份 → `x/identity` |
| `api` | `adapter/http` |
| `bootstrap` | 原样 |
| `stats` | 纯函数部分 → `core/stats`；落盘经 `port/persist` |
| `config/model` | 纯函数 → `core/spec`；schema 校验保留 |
| `config/store` | 经 `port/persist` |
| `integration` | `sdk` |
| `client` | 原样（行为冻结） |

---

## 三、边界判据（G2 落地）

### 3.1 四条层禁令 + 依赖方向

| 禁令 | 判据 | 必须覆盖的场景 |
|---|---|---|
| **`core/*` 零外部依赖** | **闭包分析**（非 grep）：断言无 `node:*`（白名单外）/ `@deepseek-ai/*` / 第三方 / `process.env`，且**把 `shared/**` 纳入 target 侧解析** | `shared/dsh-home.js:34-39` 的 `userHome()` 直读 `process.env.USERPROFILE ?? process.env.HOME`；4 个 core 候选文件经它违规，而 **grep 命中 0** |
| **`port/*` 不含业务分支** | AST 断言 `IfStatement` 计数 = 0；`ConditionalExpression` 仅允许类型收窄模式（白名单需显式定义） | — |
| **`x/*` 唯一实现** | 目标符号（`\.close\(\)` / `\.dispose\(\)` / `teardown`）只允许出现在 `src/x/session/` + **站点清单**（`file:line:name` 成员判定） | ① `bootstrap/apply-runtime.ts:178/198` 的 `watcher.close()` 是 `fs.FSWatcher`，**按资源类型白名单排除**（不是 transport）② 白名单**不得用条目数**——计数型可被「违规站点搬家、计数不变」绕过（实测） |
| **`adapter/*` 互不 import** | 层表 + 同层目录互引断言 | — |
| **依赖方向 `adapter → port → core`** | **含类型边**：`if (RANK[toLayer] < RANK[fromLayer]) fail()`。`x` 可被任意层依赖 | 现状**类型面方向完全不设防**（`import type` 反向环实测全绿）；且该恒等式**不在 v4 的 12 条不变式内** |

```
RANK = { core: 0, port: 1, x: 1.5, 'model-face': 2, gateway: 2, adapter: 3, bootstrap: 4, sdk: 4 }
```

### 3.2 判据自身的两个已实测缺陷（实施前必修）

1. **新质量型键首次登记会吸收存量违规**：`scripts/gate/verify-dir-imports.mjs:765-778` 对质量型键的分支为 `if (typeof prev?.[key] === 'number') { entry[key] = prev[key] } else { entry[key] = m[key]; qualityFirst.push(...) }`——**基线中不存在的键按当前实测值写入**。现有 8 个质量型键在 mcp-manager 基线中有值、不受影响；但**新判据的计数键必然是「不存在的键」** ⇒ 新键**不得走 `--write-baseline`**，须显式给期望值。
2. **结构型计数可被单向压低**：实测把一条真实跨模块 import 改成解析不到的路径 ⇒ `exit 0 PASS`（`raLegacy` 91→90），`--write-baseline` 固化下调基线后，**恢复真实引用反而判红**（`crossModuleRefs: 134 > 基线 133`）⇒ 须加下界保护或禁写。

### 3.3 现有门禁的真实能力边界

`verify-dir-imports.mjs` 的能力面是**相对 import 的目录拓扑**（门面完整性 + 值环）。其 `resolveCandidates` 对**非相对 specifier 直接 `return []`**——`node:fs` / `@modelcontextprotocol/sdk` / 任意第三条裸包**连 refs 都不进**。

实测（同时违反四条禁令 + 两条反向边 + adapter 互引 + 第二份释放实现）：

```
verify-dir-imports | PASS（跨模块引用全部走 interface.ts/deps.ts，符号存在性校验通过，基线未上升）
[exit code: 0]
```

⇒ **新判据是「新增一门门禁」，不是扩展现有配置**；且**「门禁绿」不得单独作为搬迁正确的证据**，每阶段必须同时有负向 fixture。

`scripts/gate/contract-check.ts:112-152` **已有**裸包值导入扫描，但口径**只覆盖 `@deepseek-ai/*` 与 `@wingsky-1/*`** ⇒ 新判据须与之**分工，不得形成第二份同类实现**。

### 3.4 已实测的现状边界口子（新判据需覆盖）

| 口子 | 实测 | 影响 |
|---|---|---|
| 不成环的反向边全绿 | `core → port` 单向值边 `exit 0` | 门禁判「环」不判「方向」 |
| 类型面方向完全不设防 | 纯 `import type` 反向环 / `core ⇄ adapter` 互引 → `exit 0` | 与 §3.1 的类型环分析叠加 |
| `shared/**` 是盲区 | 真实包内已用约 20 次 | 解释 §3.1 的传递 `process.env` 为何抓不到 |
| 计数型白名单可换位绕过 | 违规站点搬家、15 个计数不变 → 放行 | I-1 白名单必须用站点清单 |
| 基线文件可手改 | 手改 `leafModuleCycles` 1→5 其余计数不变 → 放行 | 质量型 `--write-baseline` 不放宽（正面结论），但手改无门禁会红 |

**已封堵的向量（不得误判为缺口）**：`.js` 后缀映射实拦（`resolveCandidates:121-124`）；`await import()` 判值边实拦；`import type` **直引他域实现文件**实拦（`:416` 不看 `isType`）；质量型计数不可被 `--write-baseline` 放宽。
**可复用的正确范式**：`uncoveredSrcFiles` 已是「显式清单 + 成员判定 + 质量型 + 不自动写」（`:648-654`、`:785-792`）——`x/*` 唯一实现的白名单应复用它。

---

## 四、三方契约

### 4.1 上游（DSH 宿主）

**耦合面**：`@deepseek-ai/*` **21 处 / 15 文件**（全部 `import type`，非 type 导入 0 条）；排除被豁免的 `src/client/**` 为 20 处 / 14 文件。分布：

```
9  @deepseek-ai/cordis          6  @deepseek-ai/dsh-tools
2  @deepseek-ai/dsh-host-webserver   2  @deepseek-ai/dsh-agent
1  @deepseek-ai/dsh-system-prompt    1  @deepseek-ai/dsh-client-ui-slots
```

**收敛目标**：按**面**分片到 5 个 port（不是塞进一个 `port/host.ts`——收益是「改动面 = 1 个目录」而非「= 1 个文件」）：

| 官方包 | 归属 port |
|---|---|
| `dsh-tools`（6 处） | `port/model-face/` |
| `cordis`（9 处） | `port/host/` |
| `dsh-agent`（2 处）+ `dsh-system-prompt`（1 处） | `port/host/` 的事件 / 提示词子面 |
| `dsh-host-webserver`（2 处） | `adapter/http/` |
| `dsh-client-ui-slots`（1 处） | `adapter/client/`（豁免面） |

**无法收敛项（须登记，不得假装收敛为零）**：

| 项 | 位置 | 理由 |
|---|---|---|
| `name` / `inject` 导出 | `src/index.ts:30/33` | 插件自身的挂载契约，必须在包入口 |
| `declare module` 合并落点 | `src/integration/service.ts:24` | 必须落在**每个 `exports` 类型入口的 `.d.ts` 闭包内**；且该落点决定消费方可达性（见 §4.3） |
| 客户端 `declare module` | `src/client/index.ts:41` | 与自有 `declare module` 同文件绑定；`verify-dir-imports` 对 `src/client/**` 整体豁免 |
| 官方包可解析性前提 | 构建/发布层 | `port` 自身也要 import 官方类型 |

**官方包只能对齐语义、不能复用实现**：`contract-check.ts:110-151` 禁 `@deepseek-ai/*` 运行时值导入（口径见 `pnpm-workspace.yaml` 的 catalog 注释），且 `dsh-subprocess` / `dsh-session-format` **不在 catalog**。故 `scrubbedParentEnv()` 只能照语义重实现——**代价是必然漂移**（实测与官方 drift 6 处，见 #745）。

### 4.2 宿主词表

| 词表 | 现状 | 约束手段 |
|---|---|---|
| `source.kind` | 宿主侧是**运行期 `Set`（15 值）**，所在包 `dsh-session-format-v2-to-v3` **不在 catalog**，且**严格大于**类型层联合（12 值，`team-message` / `coordinator` / `subagent-report` 三值类型层零声明） | **不得**用「typed 常量表」手抄第二份事实源（与 `types/host-faces.ts` 同病灶）。正解：锚定 catalog 内可解析的官方联合类型（`MessageSource`，来自 `@deepseek-ai/dsh-llm`）——代价 +1 依赖 +1 耦合，属依赖声明变更，需 `approved` |
| `section.name` | **不是词表**：迁移器全文 `grep -n sections` = 0，零校验 | 保持现状；#723 的教训（自定义 kind 致历史会话永久无法加载）针对的是 `source.kind` |
| `inject: string[]` | `src/index.ts:33`，**无类型收窄** | 与 `source.kind` 同源的无锚词表；收窄需先确认宿主是否导出可对齐的联合类型 |

**#723 事故的复现判据**（供新判据使用）：`"mcp-catalog" as const satisfies MessageSource["kind"]` 应被 tsc 判红——这是可执行的负向断言。

### 4.3 下游（模型面 + 客户端）

**两条披露轨**：直呼 `mcp__<server>__<tool>`（`model-face/direct`）与 `ws_mcp_*` 四原子（`model-face/atoms`）。

| 契约面 | 现状 | 本重构 |
|---|---|---|
| 工具名规则 | 与官方**逐字同构**（`mcp__${serverName}__${rawName}`、`/[^A-Za-z0-9_-]/g` 替换、64 上限、12 位 sha256、`\0` 分隔） | 不变 |
| 同名冲突 | `manager.ts:786-806` 返回 `{existing:true}`（静默吞并），官方与 Docker gateway 均 fail-loud | **不改**（语义选择，属 #745） |
| 两轨差异面 | 实测 **≥8 类**；其中 3 类语义必须（调用形态 / 超时来源 / 授权入口），6 类为缺陷 | 只收敛「同一语义族」内的重复；差异面**不强制降到 1** |
| `summary` 六态 | 键集合四处一致（`manager.ts:999` / `client/core/state.ts:33-40` / `constants.ts:27-44` / `architecture-contract.md:98-99`），真问题是**零绑定**（`counts: any`、`servers: any[]`） | 新增 DTO 单一事实源；客户端**只加类型不改 wire 字段** |
| 目录注入 | `catalog/entries.ts:204` 只对 `entry.text` 走 `escapeCatalogText`，`entry.name` 裸插 | **不改**（属 #745） |
| 截断上限 | `supervisor.ts:86-95`：`budget = Math.max(maxBytes - suffixBytes, 64)` ⇒ `maxBytes=8` 返回 **127 字节** | 只统一到单点，**公式不改**（属 #745） |

**客户端边界（实测后的精确判定）**：客户端**零宿主类型依赖**（只 import `./core/*`、`./float/*`、`./settings/*`、`style.css`、`../../placement-math.ts`（宿主侧**值**）、`shared/client/*.js`、`react`、`import type {…} from "@deepseek-ai/dsh-client-ui-slots"`）。
⇒ 「客户端不动」在纯架构重构下**能守住**，但它是**行为冻结的副产品**而非架构属性 ⇒ 必须写成显式护栏：

1. **HTTP DTO 字段集冻结**（反例：`client/float/quick-add.ts:88-102` 的 `fillForm` 直接回填 `fill.env` / `fill.headers` 明文；`readForm:52-58` 在 `env` 为空时不提交 env ⇒ 任何 DTO 白名单化都会让编辑页凭据栏空白并静默丢 env）；
2. **`placement-math.ts` 与 `shared/**` 路径冻结**（客户端用相对深度 import，搬家即强制改客户端）。

### 4.4 侧向（插件 SDK 面）

| 项 | 现状 | 本重构 |
|---|---|---|
| `ctx.mcpManager` | **包外零消费者**（全仓跨插件 `src` import = **0**；唯一 workspace 跨包依赖是聚合包 `dsh-plugins-all` 的 `workspace:*`，无 `src` import）；门禁 `--graph` 实测 `integration` 扇入 / 扇出 **0/0** | 归消费侧（`sdk/`），**不升格为适配面** |
| `exports["./sdk"]` | 不存在 | **不新增**：类型可达性经根入口闭包**已成立**（见 §4.5），子路径解决的是不存在的问题 |
| 护栏 | `test/integration/service-contract.test.ts` 锁**提供侧源码文本**；实测 6 个变异体：纯注释改动即判红、`if (false) ctx.provide(...)` / 删唯一调用点 / 方法体全换 `throw` / 追加第二处 `provide` 全部**绿** | 归正为「**调真工厂观测产物** + **真 cordis Context 消费侧解析（含不 provide 的反证）**」双轨；仓内已有同构先例 `packages/dsh-notifier/test/integration/consumer-types.test.ts` |

### 4.5 `declare module` 可达性（易误判项）

**可达性成立**，链路：`lib/index.d.ts:42` → `lib/integration/interface.d.ts` → `lib/integration/service.d.ts:24` 的 `declare module "@deepseek-ai/cordis"`。

三组**隔离编译**实测（必须逐文件隔离，否则互相污染得假绿）：

```
consumer-a（import 本包类型，不碰 ctx.mcpManager）        → exit 0
consumer-b（import 本包类型 + 使用 ctx.mcpManager）        → exit 0
consumer-c（不 import 本包，只使用 ctx.mcpManager，反证组） → TS2339，exit 1
```

**约束（迁移 `sdk/` 时必须守住）**：该 `declare module` 必须保持在**每个 `exports` 类型入口的 `.d.ts` 闭包内**。v4 §五 提议的 `exports["./sdk"]` 会让**同一份包的不同入口结果相反**（子路径消费方红 / 包根消费方绿），而本包自己的 `pnpm typecheck` **永远发现不了**（编译本包时增强必在场）⇒ 需要**按 `exports` 入口参数化的可达性门禁**。

---

## 五、分阶段迁移（详见 issue #744 §四）

```
M0 判据地基（零产品代码改动）
   M0a 裁决落库（层归属 SSOT = docs/architecture-v4-layers.json）
   M0b 新增层判据门禁 + 15 条负向 fixture（先修 §3.2 两个缺陷）
   M0c 导出面冻结（159 符号 / 182 声明块）+ 变异面盲区显式化
   M0d 构建契约修复（exports["./client"].types 悬空）
   M0e 差分测试框架
M1 判据驱动的现状度量  ← 决策点：由数据决定 M2 范围
M2 横切收敛（x/session · x/sanitize · x/identity · core/policy.verdict · types 拆解 · 门面闭包）
M3 认知半径收敛（拆 6 个大文件到 ≤250 行；值环 4 → 0）
M4 变异切片与基线重整（6 段全部重设计，每段冷跑 ≤15 分钟）
M5 收口（sdk 定位终裁；index.ts:25-27 死声明删除）
```

**M2a 的接口形状**（由真子进程实测穷举得出，是行为保持的关键）：

```ts
interface ReleasePolicy {
  closeMode: 'none' | 'fireAndForget' | 'await'   // 'none' 正是 manager.dispose 的现取值
  outcome: 'stop' | 'reconnect' | 'failed' | 'none'
  clearToolDisposers: 'sync' | 'after-sync-chain'
  detachFromContainer: boolean
}
release(target: Releasable, policy: ReleasePolicy): Promise<void>
```

现状取值（逐实现保留）：

| 路径 | `closeMode` | 工具注销 | `outcome` |
|---|---|---|---|
| `manager.dispose()` | `none` | 调用，不清 Map/tools | `none` |
| `teardownGeneration(err,true)` | `fireAndForget` | 调用 + 清空 | `reconnect` |
| `teardownGeneration(err,false)` | `fireAndForget` | 调用 + 清空 | `failed` |
| `supervisor.disconnect()` | `await` | 调用 + 清空 | `stop` |
| `middleware.teardownUnit/dispose` | `fireAndForget` | 无 | `stop` |

**两条不得误动的现状细节**：

1. `connection/orchestrator/manager.ts:1090` 的 `toolDisposers` 显式循环**不是空操作**：`manager.dispose` 先置 `supervisor.disposed = true`（`:1087`）再 `await supervisor.syncChain`（`:1089`），而 `teardownGeneration` 的 `enqueueSync` 回调带 `if (this.disposed) return;` 守卫（`supervisor.ts:382`）⇒ 排队的清理被吞（实测：注销数 0、`toolDisposers.size = 2`）；且 `test/unit/unit-manager2.test.ts:2106-2111` 已断言 `disposedNames === ["t"]`。**收敛时只能让它改经注册表调用，不得删除。**
2. `connection/runtime/middleware.ts:153-161` 的 `force` 重建让位**不是释放**（不置 `disposed`、不清 timer、复用 entry；`#412` 依赖它）⇒ **不动它**。

---

## 六、本轮**不做**的事

| 不做 | 理由 |
|---|---|
| 改任何可观测输出（日志文案 / 错误消息 / HTTP 响应字段 / 工具描述 / 状态投影） | 硬约束 |
| 修行为缺陷（14 项清单见 issue #745） | 单开跟踪，重构完成后分诊 |
| 收缩导出面（159 → ~25） | 公共 API 变更，需 `api-approved` |
| 新增 `exports` 子路径（含 `./sdk`） | 公共 API 面 |
| 改 `src/client/**` 的**行为**（仅允许加类型） | 行为冻结护栏（§4.3） |
| 改依赖声明（含把 `dsh-timeout` / `dsh-llm` 加入 catalog） | 仓库红线，需 `approved` |
| 变更多 server 语义（fail-loud / policy 覆盖直呼轨 / fail-closed） | 均为行为变更，属 #745 |
| 改 `.github/` workflow | 仓库红线 |

---

## 七、未验证项

1. 本文全部结论基于**静态分析 + 定向探针**；**未跑 e2e `smoke.test.ts`（约 328s）与全量 `pnpm test`**。
2. **M0e 的差分测试框架尚未建立**——「行为保持」目前是**设计意图**，不是已验证事实。
3. **M3 的拆文件方案未实测**：6 个超限文件能否各自拆到 ≤250 行且行为不变，未验证。
4. **M4 的新切片耗时未实测**（需冷跑一轮 observe，属 CI 资源）；现状 `runtime` 段 20 文件 / 2361 行 / **21.2 分钟**是夜班关键路径。
5. `port/*` 的「无业务分支」判据未实现（§3.1 给了表达式，白名单待定义）。
6. `architecture-redesign.md`（v3）§七 的「3 行 import 改动 4→1」未复核。
7. `dsh-http-proxy` 的代理继承漂移未端到端实测（无代理策略时 `proxyEnvironmentForChild()` 返回 `{}`）。

**本文的证伪条件**：若 M1 报告显示层违规**弥散**（>30 文件跨所有层），或维护者确认路线图上会出现第二个 transport 后端 / 多实例部署 / 远程 gateway ⇒ 应改走完整重排，本文的层结构需重新推导。

---

<sub>实施规范载体：issue #744（`approved`）。全部量化口径与实测证据见 #744。行为缺陷登记：issue #745（14 项，重构完成后分诊）。</sub>
