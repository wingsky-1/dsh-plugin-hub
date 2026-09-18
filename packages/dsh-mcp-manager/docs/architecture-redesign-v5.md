# dsh-mcp-manager 架构重构方案 v5（目标架构与迁移计划）

> 关联：issue #767（本方案落地载体）、#773（0.2.5 排期与进度入口）、#770（遗留缺陷归拢载体）、#664（上一轮分层重构，已合并）、docs/ARCHITECTURE-METHOD.md（方法论事实源）、.dsh/skills/dsh-plugin-hub-refactor/SKILL.md（执行清单）。
>
> **定位**：取代 `architecture-redesign-v4.md`。v4 是「结构搬移、行为冻结」立场下的方案（该立场派生出的一整类自相矛盾，见附录 C 的处置表）；v3 的成果（目录分层 + 每目录 `interface.ts` 门面 + 测试三层登记）保留，本文件定义其未完成部分并**重定立场**。
>
> **口径**：存量数字来自实测，四要素为「commit + 脚本 + 粒度 + 计数单位」。基线 commit = `b490e87`（v0.2.4 发布点）；与最新 main 有行号偏差时以符号名为准。
>
> **参照实现**：`packages/dsh-notifier`（#733 / PR #777，同仓唯一已完成「按域重写」的插件）。本方案凡遇形态取舍，**先问「notifier 怎么做的」**；依据与 commit 证据见附录 B。参照包本身的缺口与妥协（6 条）单列，不照搬。

---

> 状态注（#767 DOC-A）：本文是 #767 的方案稿；S1-5c、自研栈退役、换引擎、笔 1a/1b/2、S2 同构落地后部分内容已先于本文实现，正文冻结不再改真；现行事实以包实现与根架构文档为准。

## 零、v5 相对 v4 的立场变化（8 条决策）

v4 的问题不是写错，而是立场选错：**「只搬结构、不动行为、旧树冻结、分段收缩」**。每一次妥协都在后面长出一处自相矛盾。v5 改为**一次做到最终正确形态**，并把「行为变更」从禁忌改为**显式登记**。

| # | 决策 | v4 的做法 | v5 的做法 | 依据（notifier 实证） |
|---|---|---|---|---|
| D1 | 导出面基线 | P0 冻结旧树 → 全期零漂移 → P5 独立收缩阶段 | 基线由**重构前那棵树**生成（早于第一个结构 commit）；**删除到位的那一个提交里**用 `--snapshot` 重冻结并逐符号说明；不设独立收缩阶段 | #669 PR1 `2370774` 冻结（早 2 天）；#733 在分支第 31/102 个 commit `8df3950` 一次性重冻结（100 → 4） |
| D2 | 兼容 shim | P1–P4 保留 re-export shim，P5 统一删 | **零 shim / 零 deprecated 桶 / 零 TODO**，搬迁一次到位 | #733 首笔 commit `db1ce0f` 直接砍到 4 个导出；全包 grep shim/deprecated/compat/TODO 只命中 React 类型 shim 与真实迁移语义 |
| D3 | 凭据出境 | 登记为 6 条已知缺陷，留给 #770 | **本轮修完**：唯一投影出口 + **值域掩码（不删键）** + 掩码按**显式源身份**还原 + 掩码无原值 fail-closed + 出口×载体矩阵全覆盖契约测试；行为变更进登记 | notifier `config/impl/redact/index.ts` 是唯一脱敏器；字段清单唯一；`unmaskChannels` 经 `findById(existing, idOf(patch))`（`:110-113/128-138`）按**提交体自带的 id** 还原、无原值 `ok:false`——对照见 §6.1 纪律 3 |
| D4 | 服务面 ABI | A13(a)：`getTools` 原样搬移，同源改写另立批次 | **同期收敛**：`getTools` 与查询出口同源；服务面加 `apiVersion` 字面量；四件套锁住（导出面快照 + 消费方编译夹具 + 服务槽类型相等 + 运行时无夹带断言） | notifier `fdbdec0` 同期收敛 ABI；`sdk/impl/service/type.ts:21` `readonly apiVersion: 2`；release notes 第 6 节给开发者写退役清单 |
| D5 | 跨端契约 | A14 已决新增 `src/shared/`，但 DTO 仍散在 `server/shared` | **跨端全部进 `src/shared/` 单点**：六态键集合、SSE 帧名、DTO 形状、路由路径常量、placement-math；client 侧判据收窄为「**不得 import `src/server/**`**」（「只允许 src/shared」不可实现：全仓 client→仓库 `shared/` 有 21 条合法边） | notifier 的门面 + 纯数据形态可照搬；参照包此处的 client→server 两条边**无判据**，且其中一条是普通 import（非 type-only） |
| D6 | 测试导入面 | A11(b)：暂不限制，降为 checklist | **判据上线**：只对 `test/unit/**` 生效；包范围登记在数据面；其他包 3 处存量走 `gate-exemptions.json` + tracking issue；本包 13 处随搬迁清零 | 参照包此处**无判据**（约定），v5 是加强；加强的成本与收益见 §8.1 |
| D7 | 门禁与登记接线 | P0 只写 baseline + faces + 两处登记 | B0 一次接线：baseline（**先 build**，产物是 `lib/*.d.ts`）+ **手写** faces（无生成器）+ `gate-scope-registry.json`（export-surface 与 module-state 两处扩包）+ `ci-face-registry.json` + `ci.yml` 的 `scripts/data/dsh-mcp-manager-*.json` glob + `mutation-topology.json`（`src/server/**` + **`src/shared/**`** 超集、facade 重估、`deps.ts` 的 type-only 条）+ **`mutation-topology-coverage.test.ts` 的硬编码计数** + **重新生成 6 个段 conf** | notifier 的 `gate-scope-registry` 由重写 PR 新建、`ci-face-registry` 与 `ci.yml` 数据面 glob 晚一天（#791）——属**事后补面**，不照搬 |
| D8 | 行为变更交付 | N12「不改可观察输出」当总口径 | 保留项/不保留项分列（§10.1）；每条变更按两件形态登记：commit 正文【公共 API 行为变更登记】块（变更点 / 零变更面 / 回落策略 / 授权出处）+ release notes 编号节 | `8142b13` 的登记块是模板；v0.2.4 release notes 第 4 / 6 节是模板；`a748361`（恢复重写静默删掉的四项能力）是反面教训 |

### 0.1 第二轮复核修订（三视角，已并入本文件）

v5 初稿写完后经三个只读视角复核（机制可执行性 / 凭据单链闭合性 / 迁移与批次可行性），共 **4 条 P0 / 13 条 P1**，全部经协调者一手复跑确认。相对初稿的修正：

| # | 初稿的问题 | 修订 |
|---|---|---|
| 1 | D3 说「summary 不含凭据字段」——但客户端编辑表单与卡片端点今天就是从 summary 读 `env/headers/url`（`client/float/servers.ts:18`、`quick-add.ts:95-120`），删键会打穿编辑面 | 改为**值域掩码（不删键）**：键保留、值换掩码、`url` 去 userinfo（host-only）。客户端**数据源零改动**（`parseKV` 会把掩码当值解析并原样提交） |
| 2 | D3 的还原键写「name + scope」——但客户端改名走的是 **POST 新条目 + DELETE 旧条目**（`quick-add.ts:131-144`），payload 无源标识；project 级真实键是 (root, name) | 写请求携带**一个规范化地址**（复用协议已有的 `@@global/<name>` / `@<root>/<name>`，客户端 `core/api.ts:17-22` 已在构造），只在源对象上取原值（细则 §6.1 纪律 3）；**不新造三个平铺字段**（那是身份的第二个物理定义）；不可变 `id` 登记为后续演进（见附录 A 第 4 条） |
| 3 | D3 的六条出口漏了两类：**校验期回显请求体凭据**（`normalize.ts:43` → `routes.ts:60`，已实测复现）与 **supervisor 直呼路径的工具错误返回 + stats 埋点**（`supervisor.ts:330-332` 原始 message，而 `middleware.ts:782-784` 有 `hostRedact`） | 出口清单升为**出口 × 载体矩阵**（§6.2 现有 **8 类**，本行初稿误写「7 类」）；①的修法补「请求体凭据不入错误文案」，新增 ⑦⑧ 两条 |
| 4 | D3 说「类型即围栏」——实测 TS 对象展开携带额外字段赋给窄类型**不报错**（excess property check 不覆盖展开），`as unknown as` 更弱 | 删掉该论断；围栏改为**逐字段构造 + AST 断言（面 = 投影所在域）+ 禁 `as unknown as` + `NoCreds<T>` 排除类型** |
| 5 | I2①「域间不得出现值边」**没有任何执法点**（`leafValueEdges` 属可合法上升的结构型计数，`--graph` 只打印矩阵） | **已交付**（`58823bc`）：新增质量证据类 `crossDomainValueEdges` 与 `rootIndexImports`（I2④），正反 fixture 双向可证；存量基线 mcp 33 / provider-usage 26 / 其余 0，只许缩小 |
| 6 | §3.6「常量归语义所有者 + 跨域消费经 Pick」——**模块求值期常量无法 Pick**（`config-schema.ts:143/147/156` 的 `.default()` 在 import 求值期取值，`:10-11` 值引 catalog/connection） | 改为按**消费域数**判：被 ≥2 域消费的值常量归 `server/shared`；单域常量的跨域消费才经 `Pick`。原写法会与 I2② 构成 config↔catalog 值环 |
| 7 | §3.4「11 域全部建 deps.ts」——7 个域的「至少消费 logger」是设计意图不是实证（实测 logger 命中：connection 25 / stats 7，其余域含 `store` 全 0） | 表改为**预期对上依赖**，并写明「实测零依赖的域按判据不建，须在 PR 显式登记」（参照包 `channels` 先例） |
| 8 | §3.5 Port 表与实测消费系统性不符（pipeline 是 3 函数 + 1 常量、catalog 缺 WorkspacePort、connection 缺 3 个 catalog 能力、inject 缺 limits 常量、api 实际 22 个 `manager.*` 而表列 14） | **已反查完成**（第三轮只读测量）：§3.5 示意表作废、替换表落**附录 E**；同时暴露 §3.5 一批名字实测 0 命中、`types` 域去向未定、4 处死导入、`workspace` 的静态/运行入口径冲突 |
| 9 | B0⑤ 的 mutate 超集漏 `src/shared/**` → 新文件进 `uncoveredSrcFiles` 且 `--write-baseline` 拒绝接受新证据 → **硬挡 B1** | 超集改为 `src/server/**` + `src/shared/**`；并补 `mutation-topology-coverage.test.ts` 计数与 `gen-stryker-conf` 重生成 |
| 10 | B2 删 `bootstrap/`/`McpManager`，B3 才重冻结导出面 → B1–B2 全程 `contract` 判红 | **重冻结落到 B2 的删除那一笔**（`--snapshot` + faces 手改 + mutate 段重画同笔），B3 只留测试/文档/注释——与参照包 `8df3950` 同形 |
| 11 | §7.2 的 mtime 分支自称「照搬参照包」——参照包**无 mtime**（目标存在即无条件 `archive()`），且「不归档」会破坏幂等 | 归档一律执行（mtime 只影响 warn 文案）；并明确**迁移不解析内容**（纯字节搬移 → 迁移**四态**），坏文件交给各域容错读面 |
| 12 | `fast-redact` 声称「本轮即有消费者」——三条出口分别由掩码/已知值替换/字段清单循环覆盖，无调用点 | **撤回**（附录 A 第 2 条） |
| 13 | `atomically` 经 `when-exit` 在**宿主进程**装信号钩子（`import` 即 `process.once("exit", …)` + 逐信号 `once`，回调跑完还 `process.kill(pid, signal)` **重发信号**）——插件寄生在宿主进程内，改宿主退出语义是不可接受的长期风险，且消费方无法关闭 | **撤回该依赖**，改**自写 + 同路径 promise 队列**（现状 `store.ts:60` 的 `save()` 已是原子写 + 显式 mode，只缺串行，约 15 行）；四个候选的实测比较见 §7.5，决定见附录 A 第 6 条 |
| 14 | 掩码语义边界未定义（清空即删除、字面量 `********`、`{enabled}` 部分补丁） | §6.1 纪律 5 写死三条 |
| 15 | 脱敏器的**输入集**三处不同（`manager.ts:206-210` 缺 projectStore、`middleware.ts:787-793` 仅池内、`supervisor.ts:433` 仅自身）；且 ③ 的「运行时注册表」与 I9 冲突 | 输入集写成**能力** `credentialSecrets(): readonly string[]`（config 域从 global + 全部 projectStore + runtime 派生，含展开后真值），不得引入模块级可变注册表 |
| 16 | 第三轮复验新增两项 **B0 必决**：① `types` 是今日 14 个叶子模块之一，却不在 §3.4 的 11 域内（被 9 个域类型消费，`ServerConfig` 11 点）；② 「要不要建 `deps.ts`」的判据在 `workspace` 上自相矛盾——静态 import 面零对上依赖，运行时却经 `McpManager` 取 `middlewareMode`/`projectServersFor` | **① `types` 不设第 12 域，解体到三处**：域内数据形状 → 各域 `interface.ts`；跨端 DTO → `src/shared`；4 个宿主最小面（`ManagerLite`/`RoutesManager`/`MiddlewareHost`/`SupervisorLite`）→ 各域 `deps.ts` + `server/shared`。**② 判据以「运行时能力消费」为准**（静态 import 图 ∪ 附录 E.3 的经对象成员边），否则会留下「静态合规、运行时直取对象」的漏洞——正是本轮要消灭的形态 |

**红线授权路径（照搬 notifier 的正路）**：`.github/` 改动、新增第三方依赖、公共 API 行为变更，三条红线由**一次 #767 方案 `approved` 打包覆盖**（#733 的 7 笔 `.github/` 改动即由整包 approved 授权）。**不要引用 `yaml` 经 #781 合入的先例**（那次没有 approved，是维护者当次授权）。

### 0.2 第三轮：凭据单链现状的独立复验（只读，已并入）

v5 定稿后再派一个**只读**视角复验 §6 的**现状事实**（不给它方案结论、自行定位行号），结论由协调者一手复跑确认。要点：

| # | 复验结论 | 对方案的影响 |
|---|---|---|
| 1 | 出口实为 **8 类**（§6.2 现 8 行） | §0.1 第 3 条原写的「7 类」是笔误，已改 |
| 2 | `createRedactor` **4 个构造点**（`manager.ts:209` / `supervisor.ts:433` / `middleware.ts:452` / `middleware.ts:783`），**无一处**包含 `app` 展开后的真值；`projectStore` 只在 `middleware` 两处、且仅当该 root 单元已实例化；`manager.redactError` 完全看不到 `projectStore` | §0.1 第 15 条「输入集写成能力 `credentialSecrets()`」是**必需修正**而非优化 |
| 3 | 端到端实测（真实 `makeRoutes` + 真实 `McpManager` + 真实 `normalizeServer`，唯一 stub 是 manager 且 `manager.ts:906` 在 `store.upsert` 前调 `normalizeServer`）：⑦ 400 body 回显 `s3cr3t`；①②⑤⑥⑧ 的明文 / stderr 尾注 / 工具文案全部外发；③ 展开真值 `REAL-EXPANDED-6` **穿过** redactor（配置字面量 `${MY_TOKEN}` 才会被替换） | 8 类出口**现状全红**，D3「本轮修完」有了可复跑的红的基线 |
| 4 | 现状测试面 **1137 用例全绿，但零条**断言「出口不含明文」（`unit-manager2.test.ts:251-255` 只断言 `/invalid url/` 正则；`unit-middleware.test.ts:1714+` 只测 `createRedactor` 本体） | §6.2 验收的 `redaction-exits.test.ts` 不是补强，是**首次**建立该判据 |
| 5 | 落盘权限：**1 处**带 mode（`store.ts:66`），**6 处**不传（`middleware-state.ts:57/174`、`middleware.ts:497/535`、`manager.ts:192`、`collector.ts:256`）；**6 处 `mkdir` 全部不传 mode**（目录 = `0777 & ~umask`） | §7.1 的「五个写点」应为**六个**，并新增**目录 mode 行** |
| 6 | 行号漂移（§6 已按复验结果修正）：⑤ `:186`→**`:187`**；② `apply-services.ts:36`→**`:39`**；⑥ `this.error` 落点是 `435/461/467/482-487/494`（`469-472` 是退避判定）；⑧ `330-332` 的 catch **只有埋点**（`createRedactor([this.server])` 在 `:433` 的另一处 catch）；§6.1 纪律 5 的 `{enabled}` **不在** `routes-controllers.ts:175/211`（该文件无此分支；`{enabled}` 来自客户端 `float/float.ts:149/177`、`float/servers.ts:177/213`，宿主经 `:186-187` 的通用 `manager.update` 合并路径处理）；§6.3 `/health` 是 `routes.ts:168-209` | B2 引用行号以本节为准 |
| 7 | `docs/architecture-contract.md:28-30` 声称 `makeRoutes` 注入 `api/redactor-factory.ts` 构建的 redactor、`handleError` 写 body 前先脱敏——**该文件与行为都不存在** | B0② 的三分类打标必须把这段判「作废」 |

B2 必须补的探针（每条都要**正例 + 反例**，反例用于证明断言不是空转）：出口清单契约测试（8 类各一条）／`createRedactor` 构造点计数 == 1 且禁对 `ServerConfig` 展开出境的 AST 断言／400 明文探针／展开真值探针／stderr 尾注探针／`stats.json` 的 `lastError` 明文 + 文件 mode 断言／6 个落盘点 mode 显式化／掩码往返与缺源身份 400／两路径同构（`mcp__` 直呼与 `ws_mcp_call` 两侧文案都不含明文：现状 supervisor 侧红、middleware 侧绿）／防误伤负例（`/health`、三帧 SSE、`systemPrompt`、catalog 落盘）。

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
- **判据**（`verify-dir-imports --graph` 的依赖矩阵；粒度：叶子模块）：①矩阵中除指向 `server/shared` 与 `shared` 的边外**不得出现值边**；②叶子模块级值环 = 0、文件级值环 = 0；③`deps.ts` 值 import = 0、死声明 = 0；④**域内文件不得 import `src/index.ts`**（`fileValueEdges` 含根文件，域取组合根常量会立即产生文件级值环）。
- **判据①今天没有执法点（复核实证）**：`STRUCTURAL_METRICS` 里的 `leafValueEdges` 是「含指向 shared 的全部值边」且只判上升（`compareWithBaseline` 只在 `cur > base` 时判红），质量证据类里没有「域间值边」这一项，`--graph` 只打印矩阵。**故 B0 必须先给 I2① 造执法点**：新增一类质量证据「目标非 shared 的值边集合」并入 baseline；否则本条违反 §二 的立宪原则，应降级为报告项。
- **现状**：违反。33 条值边、4 + 4 条值环、1 条 `directImpl`（`connection/interface.ts → connection/orchestrator/tool-names.ts`）。
- **执法点已交付（`58823bc`）**：新增两类质量证据 `crossDomainValueEdges`（叶子模块级、目标非共享层的值边集合）与 `rootIndexImports`（域内文件**值引** `src/index.ts`；`import type` 不计）。基线现值 = **mcp 33 / provider-usage 26 / notifier 0 / lan-proxy 0 / web-file-preview 0 / verify-isolated 0**，语义是「只许缩小、终态为空」，B2 的验收面就是这份集合归零。**额外发现**：provider-usage 的集合含 `shared|domain1/adapters`——**共享层反向值引域**，比域间值边更重，已登记进 B2 对账清单。
- **参照实证**：notifier 的依赖矩阵里域间**全是类型边**，7 条值边全部指向 `shared/`（故其 `leafValueEdges = 7`，不能用「值边 = 0」直接读该计数）。**v4 的「纯函数直接值引对方是合法边」在参照终态里不存在**——本包 `pipeline` 对 `workspace` 的实测是 **3 个函数 + 1 个常量**（`pipeline/authorize.ts:11-16`），改经 `WorkspacePort` 注入。
- **装配面不需要例外**：`collectModules` 只递归子目录，根级 `src/index.ts` 不构成叶子模块、根目标放行，故组合根的 `installXxx` 值引不进矩阵。

### I3 同一判定只有一个物理定义

- **不变式**：脱敏、策略裁决、工具命名、状态投影、凭据字段清单，每一件事只有一个定义处；别处要用取能力，不抄规则。
- **判据**：投影/脱敏函数的构造点 = 1；凭据字段清单 = 1 处；策略拒绝文案单点；**脱敏器的输入集也是单点**——写成能力 `credentialSecrets(): readonly string[]`（由 `config` 域从 global store + **全部 projectStore** + runtime 注入并集 + `app` 展开后的真值派生），不得引入模块级可变注册表（违 I9）。现状三处输入集不同：`manager.ts:206-210`（**无 projectStore**）、`middleware.ts:787-793`（仅池内）、`supervisor.ts:433`（仅自身）。
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
- **判据**：`paths.ts` 是文件名与权限字面量的唯一出处（grep 断言）；`upgrade/impl/steps` 是旧路径字面量的唯一出处；迁移测试覆盖**四态**（有旧文件 / 无旧文件 / 目标已存在 / IO 读失败）。**迁移不解析内容**（纯字节搬移，见 §7.2），故没有「解析失败」这一态——坏文件由各域**容错读面**处理（现状 `store.ts:50` / `middleware-state.ts:35-37` / catalog 读面全 catch）。
- **现状**：违反。5 类文件散在 `DSH_HOME` 根（`dsh-mcp.json`、`dsh-mcp-user-state.json`、`dsh-mcp-catalog/<hash>.json`、`dsh-mcp-catalog.json`、`mcp-stats.json`）；无 `version` 刻度、无迁移机制；全包权限只有一处 `0o600`（`config/store/store.ts:66`）。

### I8 测试分层由导入面定义，不由文件名前缀定义（**本轮上线判据**）

- **不变式**：`test/unit/**` 白盒直连 `src/server/<域>/impl/<块>/`；`test/integration/**` 只 import 域 `interface.ts`/`deps.ts` 与跨端线协议；`test/e2e/**` 只经包产物入口 + `apply()`。
- **判据**：新增「测试导入面」判据，**扩展既有脚本**（不新增门禁工具、不新增 workflow）：①`test/unit/**` 不得出现 `src/index.ts` 与 `lib/`；②`test/e2e/**` 不得 import `src/`；③`test/integration/**` 不得 import `src/server/<域>/impl/`。**只对 `test/unit/**` 生效**（`client` / `e2e` 各有产物与浏览器语义）。包范围**登记在数据面**（不内嵌脚本常量）。
- **存量处置**：其他包 3 处（`dsh-lan-proxy` 的 `unit-proxy.test.ts:38`、`unit-apply.test.ts:38`；`dsh-web-file-preview` 的 `unit-present-open.test.ts:21`）走 `scripts/data/gate-exemptions.json`（文件级 + tracking issue，缺 issue 号判红）；本包 13 处走**单调基线**（只许降），随 §12 的批次清零。
- **成本与收益**：成本 = 一次脚本扩展 + 一条脚本自测 + 3 条豁免数据；收益 = 把「测试从产物入口导入」这条反模式从「约定」变成判据（v4 选 (b) 的代价是这条线交给时间腐化）。
- **现状**：违反（13 个单元测试经 `src/index.ts`；`architecture-contract.md` §3.1 把该形态写成 T1 契约）。
- **判据①已交付（`84a5941`/`8727cf0`）**：新增质量证据类 `unitImportFaceViolations`（扫 `test/unit/**`，命中 `src/index.(ts|tsx|mts|…)` / `lib/**` / `src/client/**` 即记 `测试文件|目标`）。存量两档：本包 **13** 条进单调基线，跨包 **3** 条（lan-proxy 2 + web-file-preview 1）进 `gate-exemptions.json`（`trackingIssue #767`、`reviewBy 2027-03-31`）。
- **本轮判据面的边界（实测收窄，勿当遗漏）**：**不变式**里的「`test/unit/**` 白盒直连本域 `impl/`」**不作为本轮硬判据**——判据①②③的正文只写 `src/index.ts`/`lib/` 与 e2e/integration，且 R10 的存量数（13 + 3）正好等于 `src/index.ts` 导入者集合。硬判「不得引他域 `impl`」的实测代价：notifier **11 个 test/unit 文件 / 16 条边**、provider-usage **14 个文件 / 25 条边**跨域取用底层域（如 `test/unit/api/stream.test.ts` → `src/server/config/impl/model`），且 provider-usage 的树是 `src/domain1|domain2|apply`、**没有** `src/server/<域>` 树，规则无法表达。**该规则与判据②③一并归 B1–B3**（已在脚本头注释、JSDoc、`docs/DEVELOPMENT.md`、`scripts/README.md` 四处写明，不留隐性口径）。

### I9 零模块级可变状态

- **不变式**：宿主端状态一律收进实例或闭包；模块级只允许常量表。
- **判据**：`scripts/gate/forbid-module-state-src.mjs`——**本轮把 `dsh-mcp-manager` 登记进 `scripts/data/gate-scope-registry.json` 的 `packages` 字段**（该闸 `scopeFrom=registry`，现为 `["dsh-notifier"]`，CI 无参调用 `ci.yml:783`，故本包今天**不在扫描面内**）。
- **存量（已实测，扩包前必读）**：本包在扫描面内**已有 1 处违规**——`src/client/float/panel.ts:19` 的模块级 `let inflight`（探针：把 registry 复制到临时文件并加入本包，`node scripts/gate/forbid-module-state-src.mjs --registry <tmp>` → **exit 1**）。该文件属 `src/client/**`（N1 本轮不重构结构），故扩包必须**同笔**在 `scripts/data/gate-exemptions.json` 登记文件级豁免（照 notifier #762 形态，`trackingIssue` 用 `#770`、`reviewBy` 与 notifier 条目一致），否则该闸扩包当天判红。
- **现状**：达标以登记进扫描面后的实测为准；登记前不得写「本包 0 命中」。

### I10 状态与错误出口单链

- **不变式**：状态变更只有一个出口（`emitStatus` → summary 帧，零负载 + 客户端回拉）；**错误与凭据也只有一条出境链**——所有出境对象由一个投影函数构造，凭据字段按唯一清单掩码，写回按稳定 id 还原，掩码无原值 fail-closed。
- **判据**：①契约测试登记**出口 × 载体矩阵**（§6.2 的 7 类）并全覆盖断言（新增出口判红）；②**投影函数逐字段构造**（禁止对 `ServerConfig` 做展开），AST 断言的**面 = 投影函数所在域**（现状在 `connection/orchestrator/manager.ts:1122-1188`，目标归 `pipeline`）+ 出境类型处**禁 `as unknown as`**；③投影/脱敏构造点 = 1、输入集单点（I3）；④给投影返回值加 `NoCreds<T>` 排除类型（`env?: never` 等）。
- **为什么靠断言而不是靠类型**（复核实证）：TS 的 excess property check **不覆盖对象展开**——`const a: S = { ...c, status: "ok" }`（`c` 含额外凭据字段）实测 **0 诊断**，`as unknown as` 更弱。所以「类型即围栏」不成立，围栏 = 逐字段构造 + AST 断言 + 排除类型。
- **现状**：违反。状态链已单点；**凭据有 7 条出口未脱敏**（§6.2），脱敏器 4 个构造点、输入集 3 种。

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
  index.ts                组合根：接各域（bindHost(ctx) → assemble(domains) →
                          ctx.effect(() => () => safeDisposeAll(disposers))）
                          + declare module 声明合并 + 包导出面（唯一汇聚点，目标 = 三面）
                          ——机制的物理落点在 server/shared/compose.ts，理由见 §十二 表后 ③
  server/
    shared/               包内共享层（叶子，无归属的宿主侧设施）
      interface.ts        门面：类型 ≥3 域消费 / 函数与值 ≥2 域消费才准入（I5）
      paths.ts            存储布局单一事实源：新路径 + legacyFile(旧路径) + 每文件 mode（I7）
      file-io.ts          原子写 / 容错读 / 同路径串行（自写，见 §7.5）
      host-faces.ts       宿主能力面类型（I1 白名单点名的能力类型定义处）
      compose.ts          组合根机制：bindHost 收窄 / assemble 成对装配 / safeDisposeAll 逆序释放
    upgrade/              { interface.ts, deps.ts, impl/{version, chain, steps} }   ← 无 `legacy/`：本包无旧**内容**语义要转换（§7.2 纯字节迁移），旧**路径**按 I7 归 `server/shared/paths.ts`（B1.3 已裁定，建空块会违反「impl/ 根只放聚合器与跨块值文件」）
    store/                { interface.ts, deps.ts, impl/{user-state, catalog-cache, stats-file} }
    stats/                { interface.ts, impl/collector.ts, impl/type.ts }   ← **无 `deps.ts`**：附录 E.4 + 决策⑥ 实测本域**零对上依赖**（`store`/`stats`/`integration` 三域同此，6 域建：pipeline/catalog/connection/inject/api/config）；B2.1 `0fb3bab` 已按此落地
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

> **本表是「预期对上依赖」，不是实测**：复核实证——当前代码里 `grep -rn logger <域>` 的命中是 connection 25 / stats 7 / bootstrap 5，其余域（含 `store`）**全 0**；`config/store/store.ts:8-12` 只 import `node:fs/path` + 仓库 `shared/dsh-home.js` + 类型，对其它域与宿主零依赖。故下表按**目标形态**给出预期，实施时以实测为准；**实测零对上依赖的域按判据不建 `deps.ts`**，但必须在 PR 里显式登记该裁量与理由（参照包 `channels` 先例）。

| 域 | 预期对上依赖 | deps.ts |
|---|---|---|
| `upgrade` | **`{storePath, statsFile}` 由组合根作普通入参传入**（它们是插件 apply 配置键 `config-schema.ts:119/137`，不是 config 域的数据；迁移跑在 config 装配之前，且参照包把 config 排除在 storage-layout 步骤之外，理由原文是「读取要等宿主服务就绪」）+ 宿主 logger | 有 |
| `store` | **当前实测 0 对上依赖**；目标形态若只经 `server/shared` 取路径与 IO，则不建（写失败告警需宿主 logger 时才建） | 待实测 |
| `stats` | `store`（落盘）+ 宿主 logger | 有 |
| `pipeline` | `workspace`（3 函数 + 1 常量经端口）+ 宿主 logger；**禁用表与 servers 集合是入参**（`authorize.ts:11-17` 只 import workspace + types），取数在 `connection` / `inject` | 有 |
| `config` | 宿主 settings（UI 配置命名空间）+ logger | 有 |
| `workspace` | `config`（项目级 servers 读面）+ 宿主 sessions / logger | 有 |
| `catalog` | `config` + `store` + `connection`（live 视图）+ logger | 有 |
| `connection` | `config` / `workspace` / `catalog` / `stats` / `pipeline` + logger | 有 |
| `inject` | `connection` / `pipeline` / `catalog` / `workspace` / `stats` + 宿主 tools / events / prompt / logger | 有 |
| `api` | `connection` / `config` / `store` / `workspace` + 宿主 register / settings / logger | 有 |
| `sdk` | `connection` / `config` + 宿主 expose | 有 |

**11 个域全部建 `deps.ts`。** 若实现时某域实测为零对上依赖（既不取他域能力也不取宿主能力），按判据**不建**，但必须在 PR 里显式登记该裁量与理由（参照包 `channels` 的做法：在 `interface.ts` 头注释写明「本域对其它域零依赖」）。

### 3.5 Port 面（开写前按实际消费反查）

> **状态：已反查完成（第三轮只读测量交付）。** 本节原来的示意表**作废**——复核实测其中一批名字在 src 内 **0 命中**（`serversFor` / `saveServers` / `writeCatalog` / `catalogPathFor` / `globalRoot` / `refreshFromDisk` / `announceCatalogMaxEntries`，以及 api 行里的 `start` / `stop` / `healthCounts` / `serversForEdit` / `redactError` / `readUserState`），属按意图臆写而非实测。**替换表见附录 E**（域间值能力 100 行 / 宿主能力面 / 经对象成员消费 / 「不该建 deps.ts」判定），实测口径：消费点 = 剔除 import-export 语句后的标识符出现次数，0 = 死导入。
>
> 反查同时纠正了 §3.4 的三处：①logger 实测**四域非零**（connection 25 行 / stats 7 / **bootstrap 5** / **types 2**），且四者语义不同（connection 是 `ctx.logger`、stats 是本地结构类型参数、types 是 `LoggerService` 类型字段、bootstrap 是 `manager.logger` 转发）——**不能合并成一个能力**；②`types` 是今日 14 个叶子模块之一却不在这 11 域内，被 9 个域类型消费（`ServerConfig` 11 点等），**B0 冻结必须先给定它的去向**；③发现 **4 处死导入**（`pipeline/authorize.ts:12` `fullServerName`、`catalog/search.ts:20` `bareServerName`、`connection/runtime/middleware.ts:45` `bareServerName`、`connection/runtime/supervisor.ts:14` `SCOPE_PROJECT`），属 I4 与「Pick 越窄越好」的直接可清理项。
>
> **另有一处口径冲突必须由 B0 裁决**：`workspace` 静态 import 面零对上依赖，但运行时经 `McpManager` 取 `middlewareMode` / `projectServersFor`（`workspace/root-resolution.ts:66/71`）。建议**以运行时能力消费为准**判定「要不要建 deps.ts」（否则会出现「静态图合规、运行时直取对象」的漏洞，正是本轮要消灭的形态）。

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

> **上表是示意，不是定稿**（复核实证：与实测消费系统性不符——`pipeline` 是 3 函数 + 1 常量；`catalog` 还值引 5 个 workspace 符号（`search.ts:17-23`）与 3 个（`cache-view.ts:17-21`）；`connection` 还要 catalog 的 `isCatalogFresh/boundCatalogTools/catalogCacheFile/summarizeToolDescriptions/makeCatalogViewFor`；`inject` 还值引 5 个 limits 常量（`middleware-register.ts:15-19`）与 `MIDDLEWARE_GLOBAL_ROOT`；`api` 实测唯一 `manager.` 成员是 **22** 个而表列 14）。**B0 冻结前必须用脚本从现状反查一张完整表**：被 ≥2 域消费的值 → `server/shared`（I5 门槛），单域的对上消费才进 `deps.ts`。

四条收窄纪律：**`Pick` 越窄越好**；**端口传能力不传算好的值**；**包内 `server/shared/*.ts` 一律经 `server/shared/interface.ts` 门面**（直引会新增 `directImpl` 并判红；参照包 45 处引用全走门面、零直引）；**裸对象不算契约**——`api` 现直取 `manager.store` / `projectStoreOrThrow`（`routes-controllers.ts:320/323`）与 `manager.supervisors/catalogCache/middleware/sseHub`（`routes.ts`），目标形态必须变成命名能力（`healthCounts()`、`serversForEdit()`、`redactError()`）。按实测：`routes-controllers.ts` 用到 **18** 个 `manager.*` 成员，全 `src/api` 共 **22** 个（v4 写的「24 个」不成立）。

### 3.6 七处易错点

1. `connection` 不拥有目录缓存；目录写归 `catalog`（经 `store`），两者之间只留一条「工具集变了」通知——**通知的载体必须在 B0 定义**：域间通知 = 组合根递入的**回调能力**（谁提供 `onToolsChanged(cb)`、谁在装配期递入），且 `catalog` 先于 `connection` 装配 → 需要晚绑定（装配期只登记回调，运行期才触发）。只写「留一条事件」不可执行。
2. `api` 与 `sdk` 共享**唯一查询出口**，各自 `Pick` 同一方法，不让两边各拿一个宽 Port。
3. 中间层宿主是「被注入」不是「被掏出」：`MiddlewareHostPort` 在 `connection/interface.ts` 有物理定义，由组合根在装配中间层块时递入。
4. **目录缓存的命名与落盘归属说死**：文件名与 hash 规则归 `server/shared/paths.ts`（I7）、`store` 执行写、`connection` 不再经 `MiddlewareHost` 拿路径。
5. **投影层不允许值替换占位符，只允许出真正构造的 DTO**：出境对象由投影函数**新建**（不是展开原对象），凭据值按唯一清单掩码；写回按稳定 id 还原；掩码无原值 → 400（详见 §6）。
6. 跨域常量**按消费域数判**（复核修正，原「归语义所有者」不可执行）：**值常量被 ≥2 域消费 → 归 `server/shared/constants.ts`**（I5 值面门槛正是 2）——`DEFAULT_ANNOUNCE_CATALOG` / `DEFAULT_CATALOG_MAX_ENTRIES` / `DEFAULT_RESULT_TRUNCATE_BYTES` / `MIDDLEWARE_GLOBAL_ROOT`（4 域）/ `SCOPE_PROJECT`（4 域）/ `SCOPE_GLOBAL`（2 域）全部落这里；**单域消费的常量**留本域 `interface.ts`，跨域消费经 `deps.ts` 的 `Pick`（静态图上是类型边）。**为什么不能「归语义所有者 + 经 Pick」**：`config/model/config-schema.ts:10-11` 值引 catalog/connection 的两个默认值并在 `:143/147/156` 的 `.default()` 里于 **import 求值期**取值，而 `Pick` 是 install 期注入，没有模块求值期的注入钩子；按原规则还会与 §3.5 的 catalog→config 构成值环，违 I2②。
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

- **判据（复核收窄）**：`src/client/**` **不得 import `src/server/**`**。
  初稿写的「只允许 `src/shared/**` 与 `src/client/**`」**不可实现**：全仓实测 client→仓库 `shared/` **21 条**（lan-proxy 3 / mcp 8 / notifier 1 / provider-usage 9，是既有合法共享层）、client→本包 src 其它文件 **3 条**（含 mcp 自己的 `client/core/state.ts:9` 与 `client/float/float.ts:23` → `src/placement-math.ts`）、client→`src/server` 仅 **2 条**（均在 dsh-notifier：`client/reason-text.ts:11` 的 `import type`、`client/capabilities.ts:24` 的普通 import）。
- **mcp 的落点**：`src/placement-math.ts` 两端共用 → 按 D5 归 **`src/shared/placement-math.ts`**，客户端与宿主都从那里引；仓库 `shared/**` 的引用**不在判据面内**（它是跨包共享层，不是宿主内部实现）。
- **实现**：扩展既有 `verify-dir-imports.mjs`——**新增独立一遍扫描**，保持现有三处硬排除（client 子树不进 `scannedSrcFiles/leafValueEdges/fileValueEdges/crossModuleRefs`）不动，否则 notifier 等包的基线全部位移；包范围登记在数据面。
- **存量处置（已落地，`d6795ec`）**：notifier 的 2 条**先**写 `gate-exemptions.json`（`gate=verify-dir-imports`、`path=dsh-notifier:src/client/<file>|src/server/<file>`（**包相对**路径）、`trackingIssue #769`、`reviewBy 2027-03-31`）**再**写基线；mcp 今天 0 条。
- **机制变更（须知，实测落地）**：`buildBaseline` 改为**两级首次登记**——基线里**整个 `quality` 段缺失** = 包级首次登记；**单个证据键缺失** = 证据**类**级首次登记（本次新增一类判据）。类级只在**键缺失的那一次**生效：键一旦存在，**类内新增证据仍一律不写入、判红、中止写基线**。为什么必须这么改：三个新证据类的存量是 mcp **33** 条 + provider-usage **26** 条，逐条开豁免等于把「存量登记」伪装成「放宽」（台账的语义是放宽通道，基线的语义才是存量）。**已知并接受的残余风险**：删掉基线里的某个键再跑 `--write-baseline` 可把该类当下事实洗成基线——但这与**手改基线 JSON** 等价（后者今天也拦不住），真正的护栏仍是 diff 审阅 + CI 的 `--check`；且类级首次登记在输出里逐条点名「须在 PR 内确认」。
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

**不删键，改值域掩码**（复核修正）：`GET /servers` 的载荷**保留** `env` / `headers` / `url` 三个键，但 `env` / `headers` 的**值**替换为掩码 `********`，`url` 去掉 userinfo（host-only）。理由：客户端编辑表单与卡片端点今天就是从这份载荷取这三样（`client/float/servers.ts:18`、`quick-add.ts:95-120`、`client/core/state.ts:15-32`），删键会连 `command/args/url/cwd` 一起打穿编辑面；掩码方案下客户端**数据源零改动**（`parseKV` 会把 `********` 当值解析并原样提交，宿主按源身份还原）。

六条纪律：

1. **出口唯一**：所有出境对象由 §6.1 的三个函数之一构造；投影与脱敏的执行点必须落在这三个函数内（AST 断言面 = 投影所在域）。
2. **凭据字段清单唯一**（`pipeline/impl/redact` 的一张 `Record<transport, readonly string[]>`，照 notifier 的 `CHANNEL_SECRET_FIELDS`）；未知传输给空清单而不是抛错（在脱敏处抛错会让整页 500）。
3. **掩码还原按「显式源身份」，且只在源对象上取原值**（复核修正）：`PATCH` 的源身份 = URL 的 `name` + `scope`（实测 PATCH **不能改名**：`manager.ts:928` 的 `{ ...existing, ...patch, name }` 末位 `name` 来自路由参数）；**改名/改归属走的是客户端「POST 新条目 + DELETE 旧条目」**（`quick-add.ts:131-144`），其 payload 不含源标识 → 改为携带**一个规范化地址字段**（形态复用协议里已有的 `@@global/<name>` 与 `@<root>/<name>`，即客户端 `core/api.ts:17-22` 已在构造、宿主 `parseFullServerName` 已唯一解析的那个地址）。**不新造 `sourceName`/`sourceScope`/`sourceRoot` 三个平铺字段**——那会成为「身份」的第二个物理定义（违 I3/I11），而客户端本来就持有 root 与 name，新字段是纯增熵；该字段仅用于取原值，不参与写入目标。**禁止跨对象 / 跨 scope / 跨 root 搜索原值**——那会把 A 的凭据回填到 B，正是参照包注释警告的事故（notifier 用提交体自带的**不可变 id**，见 `redact/index.ts:110-113/128-138`；mcp 无 id 字段，故用显式源身份替代）。掩码却无原值 = `ok:false` → 400。
4. **逐字段构造，不靠类型**（复核修正）：实测 TS 的对象展开**逃过** excess property check（`const a: S = { ...c, status: "ok" }` → 0 诊断），故「类型即围栏」不成立。围栏 = 投影函数**逐字段构造**（禁止对 `ServerConfig` 展开）+ AST 断言 + 返回值加 `NoCreds<T>` 排除类型（`env?: never` 等）+ 出境类型处禁 `as unknown as`。
5. **掩码语义三条写死**：①**仅当值等于掩码时**才还原（照 notifier `secretFieldsOf`）；②显式删除用「键缺失」表达、显式清空用空串（"未提交该字段" 与 "清空" 必须区分）；③`{enabled}` 这类部分补丁（来源是客户端 `float/float.ts:149/177` 与 `float/servers.ts:177/213`；宿主侧没有专门分支，走 `routes-controllers.ts:186-187` 的通用 `manager.update` 合并）不含凭据键，直接透传，不触发还原。注意现状：客户端清空文本框 = 缺键 → `{...existing, ...patch}` 保留旧值，即 **UI 无法删除凭据**（现状即如此，本轮不改，登记为已知限制）。
6. **400 的恢复路径必须给用户**：掩码无原值时返回可读文案（「凭据已变更，请重新输入」）而非裸 400；这是安全设计的可用性闭环，不是可选项。

### 6.2 出口 × 载体矩阵（全部本轮修完）

| # | 出口 | 代码点 | 处置 |
|---|---|---|---|
| ① | 4xx 错误响应体（**9 处**响应体复用 `summary()`：`routes-controllers.ts:148/165/179/187/215/234/262/339/394`，修在投影函数即一次覆盖） | `api/routes.ts:59-60` 直出 `error.message`；`src/api/` 零 `createRedactor` | 经 `redactError`（能力由 `api/deps.ts` 声明）；**并且**校验期错误文案不得回显原值（见 ⑦） |
| ② | `GET /servers` 响应体 + sdk 服务面 | `manager.ts:1143-1151`（`msgOf`）、`:1181-1184`（`supervisor.error.message`）；`apply-services.ts:39/56` 原样 `as unknown as McpServerSummary` | 改由 §6.1 的 `projectServerSummary` 构造 |
| ③ | env 展开后的真值 | `transport.ts:25-30` 连接时才展开，`redact.ts:23-27` 只收配置字面量 | 展开时把真值注册进唯一清单（或展开前先脱敏） |
| ④ | `stats.json` 的 `lastError` | `stats/collector.ts:165`（`slice(0,200)`）+ `:256` 落盘；两个 feeder：`inject/middleware-register.ts:323`、`connection/runtime/supervisor.ts:331` | 两个 feeder 一并收口（只改 collector 会改错层，它拿不到 server 配置） |
| ⑤ | `POST /servers` 201 与 `PATCH /servers` 200 响应体 | `api/routes-controllers.ts:165`（201）/ `:187`（200；`:186` 是 `manager.update` 调用）返回 `{ server, summary }`，`server` 来自 `manager.add/update` = 完整 `ServerConfig` | 响应体改为投影后的对象（结构性绕过消失） |
| ⑥ | stdio stderr 尾巴 | `transport.ts:153` `slice(-4000)` → `protocol.ts:49-53` 拼尾注 → `supervisor.ts:435/461/467/482-487/494` 存入 `this.error`（`:469-472` 是退避窗口判定，不存 error）→ 经 ② 直出。**注意 `new MCPClient(transport)`（`supervisor.ts:406`）不持有 `ServerConfig`** → 「过同一 redactor」没有落点 | **两档（不单纯截断）**：**默认**只出结构化摘要——`exitCode` + **首行** + 尾部若干行 + 行数 + 字节数 + `truncated` 标志（注意现状 `transport.ts:153` 是 `slice(-4000)`，保留的是**尾部**，而启动失败线索在**首行**，现状取错了那一档）；**另留一条显式取全文的通道**（本地 UI 展开 / 诊断端点），且**必须复用 §6 的唯一脱敏器**——否则就是第二条未脱敏通道，§6 单链当场破功。不做永久丢弃：stderr 是 stdio server 起不来时的唯一线索，丢掉会把「连不上」变成无据可查的长期支持负担。理由：`buildChildEnv` 会把父进程里**未命中凭据正则**的变量（`transport.ts:22` 只覆盖 KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL/AUTH，`GITHUB_PAT` 之类不命中）透传给子进程，stderr 回显这类值的通道**即使做了 ③ 也仍然漏**——只能靠收窄载体 |
| ⑦ | **校验期回显请求体凭据**（复核新增） | `config/model/normalize.ts:43` 的 `invalid url: <原值>` 文案（拼进 `src.url`）在 `store.upsert` **之前**抛出，`routes.ts:60` 原样写进 400 体（已实测复现 `invalid url: ht tp://user:s3cr3t@host/mcp`） | **结构化错误**：抛错时不回显原值（错误码 + 字段名，如 `invalid url: <redacted>`）；契约测试加正例「提交含明文凭据的非法配置 → 400 body 不含该值」。`redactError` 只认识**已存储**配置，结构上覆盖不到这条 |
| ⑧ | **supervisor 直呼路径的工具错误返回 + stats 埋点**（复核新增） | `supervisor.ts:330-332` `record(false, msgOf(error)); throw error;`——同一条 message 既进 stats.json 又作为失败文案交给模型；而 `middleware.ts:782-784` 同类路径已有 `hostRedact` | 在 supervisor 边界收口（**注意**：`330-332` 的 catch 只有埋点、**没有** redactor——`createRedactor([this.server])` 在 `:433` 的另一个 catch），并把 throw 出去的对象换成**已脱敏的 Error**；契约测试覆盖「off/project 模式下直呼失败不含明文」正反例 |

**验收**：`test/integration/redaction-exits.test.ts` 逐条断言 **8 类**出口不含明文（每条**正例 + 反例**，「伪造含 URL 凭据的错误」的反例用于证明断言不空转）；`createRedactor` 构造点计数 == 1 的 AST 断言；6 个落盘点的 mode 断言；I10 判据②（本方案 §二 I10）的文本/AST 断言判绿。探针全清单见 §0.2 末段。

### 6.3 行为变更

本轮**有意**改变了可观察输出（凭据值在响应体/日志/统计里变成掩码或消失、`url` 去 userinfo、stderr 尾巴收窄）。这不是「不改行为」的例外，而是**必须登记**的一项：commit 正文写【公共 API 行为变更登记】块（照 `8142b13`：变更点 / 零变更面 / 回落策略 / 授权出处）；release notes 新增一节。

**登记要点（复核实证补充）**：

- **载荷形状不变、值域变**：`env/headers/url` 三个键仍在（掩码 + host-only），故 §5.2 的「不改线协议**语义**」应限定为「不改帧名与状态键语义」；**值域变更单独登记**，否则与本节自相矛盾。
- **客户端回路必须写清**：读（GET /servers 的掩码视图）→ 提交（掩码原样回传 + 带上**规范化地址**）→ 还原（仅源对象）/ 400（重新输入）。客户端的改动仅限「改名/改归属时带上源地址」，**不改数据源、不改 DTO 形状**。
- **契约测试的负例清单（已核实干净，防止误伤）**：`GET /health` 纯计数无错误字段（`routes.ts:168-209`，响应体 `193-206`）；三个 SSE 帧零负载（`routes.ts:91/103/161`）；`systemPrompt` 是静态文案（`apply.ts:229-234`）；catalog 落盘只写 `tools.size > 0` 的条目，`unavailable` 原因不落盘（`middleware.ts:475-491`）。
- **stats.json 的披露字段**（除 `lastError` 外还有 `disclosure.searches/lists/details`，`collector.ts:176-210`）与 **runtime 注入条目**（`manager.ts:1084-1086` 并入 summary）各加一条正例，避免契约测试按「六条」逐条断言而漏放。

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

**mode 是本包新增决定（标注）**：参照包 `paths.ts` **没有 mode**、`file-io` 签名也没有 mode 参数，故这不是照搬。采纳理由：权限是**文件的属性**而不是写函数参数的属性，登记在 `paths.ts` 后权限决策从 5 个写点收敛到 1 处（满足 I3/I7）。落地约束与实测依据（复核补充）：

- **七个写点**现状（复核实测）：`config/store/store.ts:66` 是**唯一**带 mode 的（`0o600`）；`middleware-state.ts:57/174`、`middleware.ts:497/535`、`manager.ts:192`、`collector.ts:256` 六个都不传 mode。
- **目录也要显式 mode（本包新增决定）**：现状 **6 处 `mkdir`** （`store.ts:62`、`manager.ts:189`、`middleware.ts:495`、`middleware-state.ts:55/172`、`collector.ts:252`）全部不传 mode → 目录权限 = `0777 & ~umask`。目标：插件自有目录显式 `0o700`（与 `config.json` 的 `0o600` 同族），避免同机其它用户列举/读取。参照包无 mode 概念，故这条不是照搬，理由同下条。
- 写路径一律 tmp + rename（`store.ts:64-67` 等）→ **rename 会把目标 inode 换成 tmp inode，目标权限来自写调用，不继承旧目标权限**；不传 mode 时 = `0o666 & ~umask`。
- 因此：**写函数总是显式传入登记值**（写函数显式传 mode，不吃 umask；不依赖任何库的复制语义）；不依赖「默认复制旧文件 mode」语义。
- **适用范围**：mode 表只适用于**经写函数落盘**的文件。**目录型旧路径搬家也必须逐文件过写函数**（`readSource → writeTarget`），不得对目录走整目录 `rename`——否则权限由历史分支决定，R3 的对冲在目录路径上失效。
- 配逐文件权限断言（现状：`0o600` 仅 `config/store/store.ts:66` 一处，`user-state` / `catalog/*` / `catalog-summary` / `stats.json` 均未设 → 目标保持 0644）。

### 7.2 迁移语义（照搬参照包 `upgrade/impl/steps/storage-layout.ts`）

| 情形 | 动作 |
|---|---|
| 目标存在、旧文件也存在 | **归档一律执行**（`rename` 为 `*.migrated.bak`，固定名 = 幂等标记），**不覆盖目标**；mtime 只用于**告警文案**（旧文件更新 → 提示「检测到更旧的降级写入」），不改变动作 |
| 目标不存在、旧文件存在 | 读旧 → **原样文本**写目标 → 归档旧文件 |
| 两者都不存在 | 写**初始空形态**（`config.json` 为版本化空形，不是裸空对象） |
| **目录型旧路径**（`dsh-mcp-catalog/<hash>.json`） | **逐文件**经写函数搬（`readSource → writeTarget`，落 §7.1 的 mode），再归档源；**不走整目录 rename**（否则权限绕过 mode 表，见 §7.1 适用范围）。参照包的 `LAYOUT` 是扁平单文件表，表达不了目录搬家——本条是本包增量 |
| 旧文件 **IO 失败 / 权限问题** | **抛错**（搬不动，不该被当成「没有旧数据」） |
| 旧文件 **内容损坏（JSON 坏）** | **迁移不解析内容**（纯字节搬移）→ 坏字节原样搬到新位置，由各域**容错读面**处理（现状 `store.ts:50` / `middleware-state.ts:35-37` / catalog 读面全 catch，均保持「静默回落空、插件可用」）。**不得在此处引入 `JSON.parse` 校验**——那会把 `config/store` 的格式知识搬进 `upgrade` 域（与 §4 的数据边界不符），并让一个坏配置从「静默回落」变成「apply 失败」 |
| 目标已存在但旧文件不存在 | 什么都不做（重跑的常态） |

三条硬要求：**幂等**（归档名固定，重跑不累积）；**纯文本搬移，不得解析后重写**（`config.json` 里存的是 env 引用而非密钥字面量，解析重写会顺手丢未知键）。**失败语义分名（复核修正，原稿用同一个「失败」指两件事，必然导出错误实现）**：

| 失败类型 | 语义 |
|---|---|
| **IO / 权限失败**（读不出、写不进、改名失败） | **抛错 → `apply` 中止**（搬不动，不该被当成「没有旧数据」）。刻度**回写在 `run` 之后**，失败即不推进，下次从同一步重跑 |
| **内容损坏**（JSON 坏） | **不抛错**：字节原样搬移，坏文件交给容错读面；刻度照常推进（这一步的动作已完成） |
| **用户显式 `storePath` / `statsFile`** | 不动：不迁移、不改写、继续读用户那个文件 |

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

`server/shared/file-io.ts` **自写承接，不引入第三方依赖**（撤回初稿的 `atomically` 方案）：

- **写函数恒定四件事**：唯一临时名（pid + 时间戳 + 随机后缀）→ `writeFile(tmp, data, { mode })` **显式传 mode** → `rename(tmp, target)`（POSIX 原子替换）→ 失败时清理临时名并上抛原错误。
- **同路径串行**：模块内一张 `Map<path, Promise>` 串起同目标路径的写（前一次 settle 才发起下一次），这是现状 `store.ts:60` 的 `save()` **唯一缺的东西**（约 15 行）。没有它，两次并发写虽然临时名唯一，但两次 `rename` 的先后无保证，旧数据可能覆盖新数据。
- **不装进程级钩子**：不注册 `exit` / 信号监听，也不在退出时清理残留临时名——残留是惰性可清理的（临时名带 pid，启动时按 pid 判活清理），而改宿主退出路径是不可接受的代价。
- **mode 从 `server/shared/paths.ts` 的登记表取值**（§7.1），写函数不做默认值兜底；缺登记即抛错（I6：不写静默降级）。
- **撤回 `fast-redact`（复核）**：v5 初稿称「本轮即有消费者」不成立——§6.1 的三个出口分别由**掩码（唯一字段清单的一次循环）**、**已知 secret 值替换**、**逐字段构造**覆盖，没有一处需要「按 path 掩码嵌套对象再序列化」的能力。新增第三方依赖是红线，为一个不存在的调用点再走一次授权面不划算。若后续确有对象级掩码需求，另开裁决。
**为什么不用库（四个候选逐一实测后全部否决，决策见附录 A 第 6 条）**：

| 候选 | 有队列 | 能传 mode | 宿主副作用 | 结论 |
|---|---|---|---|---|
| `atomically@2.1.1`（MIT，+3 传递依赖） | 有 | 有 | `when-exit` 在**模块加载期**就装 `exit` + 逐信号 `once` 钩子，回调跑完还 `process.kill(pid, signal)` **重发信号**——`dsh web` 宿主进程里 import 它即改变宿主 SIGINT/SIGTERM 退出路径，且消费方无法关闭 | **否决**（代价是宿主语义，不是本包语义） |
| `write-file-atomic@8.0.0`（ISC，+1 依赖 `signal-exit`） | **无** | 有 | 仍装退出钩子（用于清理临时名） | **否决**（不满足同路径串行，相对现状净收益为零） |
| `steno@4.0.2`（MIT，**零依赖**、有队列） | 有 | **无**（API 只有 `new Writer(file)` + `writer.write(data)`） | 无 | **否决**（`0o600` 是 §10.1 保留项；且它会**合并写**，与 `store` 的 `mtimeMs` 基线语义冲突） |
| **自写** | 有（约 15 行） | 有 | 无 | **采纳** |

现状 `config/store/store.ts:60` 的 `save()` 已经是「唯一临时名 + 显式 `mode: 0o600`（`:66`）+ `rename` + 失败清理」，**离目标只差一个串行队列**。初稿写「不再自写临时名 + `rename`」是把已有的可用实现换成一个带宿主副作用的依赖，方向是反的。

**演进路径（与本仓 `#706` 对齐）**：本仓**没有**跟踪「全包读写能力统一」的 issue；`#706`（跨包共享机制演进——`core` 包评估）是它的天然载体，而其准入判据要求「≥3 个稳定消费者 + 已被 2 个以上包重复实现」——「落盘原语 + mode」恰是当前最接近该判据的候选。本包把落盘收口到 `server/shared/file-io.ts` **单点**，将来若 `#706` 产出仓库级原语，替换只发生在这一个文件（`#792` 定「跨端与跨包模块放哪」的载体，不涉及 IO 语义）。

---

## 八、测试面目标架构

### 8.1 三层定义与判据

| 层 | 目录 | 只允许 import | 测什么 |
|---|---|---|---|
| 单元 | `test/unit/<域>/<块>.test.ts` | `src/server/<域>/impl/<块>/` + 本域 `deps.ts` 的 Port fake（**目标形态**；本轮上线的判据只覆盖「不得引 `src/index.ts`/`lib/`/`src/client/**`」，这条「本域」规则归 B1–B3——实测理由见 §二 I8 末条） | 模块内函数与状态机 |
| 契约 | `test/integration/` | 域 `interface.ts` + `deps.ts` + 跨端线协议 | 接缝的形状与承诺 |
| 集成 | `test/e2e/` | 包产物入口 + `apply()` | 端到端 user case |
| 组合根 | `test/integration/real-context.test.ts` | `src/index.ts` + 真实 `Context` | 装配顺序、释放逆序、服务面、声明合并 |
| 客户端 | `test/client/` | `src/client/**` | UI 模块（归 #769） |

判据见 **I8**（本轮上线；执法点 = 扩展既有脚本）。**规则（A10 的必然推论）**：凡直接 `new` 内部类 / 取内部符号的 e2e 用例一律改为 `test/unit/<域>` 的白盒用例；e2e 只保留 `apply()` + 产物入口的 user case（现状 `smoke.test.ts` 有 **9 处** `new McpManager`，实测行号 `:604/907/1942/2030/2116/2993/3011/3582/3673`）。

### 8.2 存量搬迁（**#664 遗留** 16 个测试文件 / 14635 行；全包实测 **23 文件 / 16252 行**）

**口径订正（评审复核 + 主控逐文件实测）**：本节列的 16 个是 **#664 遗留**文件（14 个扁平 `unit-*` + `integration/service-contract` + `e2e/smoke`），**不是全包清单**——所以「另外 5 个文件没有迁移落点」的读法不成立。另 7 个测试文件由 B1 期新增且**已在目标位置**、不需要搬迁落点：`e2e/cross-end-lock`(239)、`integration/real-context`(352)、`unit-file-io`(186)、`unit-file-io-queue`(90)、`unit/upgrade/{service(228),storage-layout(370),version(112)}`。全包实测 **23 文件 / 16252 行 / 静态 `it(` 1169 处**（runner 报 1222 用例 = 含 `it.each` 展开）。

按域落到 `test/unit/<域>/`：`unit-manager2`(3142) → `{connection,catalog,config,sdk,workspace}`；`unit-middleware`(2107) → `{connection,inject}`；`unit-supervisor`(900) / `unit-transport`(356) / `unit-manager`(271) → `connection/`；`unit-catalog`(771) → `catalog/`；`unit-routes-sse`(705) → `api/`（帧契约下沉 `integration/`）；`unit-store`(501) → `{config,store}/`；`unit-apply`(412) → `integration/real-context.test.ts`；`unit-hotspot`(370) 按被测符号归域；`unit-shared`(338) 被测对象是仓库 `shared/settings-namespace` → 迁 `scripts/test/` 或保留并登记；`unit-call-stats`(296) → `stats/`；`unit-pipeline`(203) → `pipeline/`；`unit-workspace`(79) → `workspace/`；`integration/service-contract`(366) → **消费方编译夹具**（现为读源文本比对 marker，该文件在重写后消失）；`e2e/smoke`(3858 / 161 it) 按**导入面**分层；`test/helpers.ts`(161) 保留。

**失锚断言的改写口径**（必须在 B3 前写死）：`unit-manager2` 对内部字段的耦合（`.supervisors` 45 / `.middleware` 45 / `.catalogCache` 24 / `.runtimeRegistry` 7）逐条映射到新域的 `interface.ts` 能力或 `deps.ts` 端口；找不到落点的断言按 §10.3 标 C 级并进 B2 的「被删能力」对账清单，**不得静默删除**（判据强度零放宽）。

### 8.3 度量面同步（先修尺子）

| 面 | 现状 | 动作 |
|---|---|---|
| 变异段 | 6 段（entry/manager/middleware/routes/supervisor/runtime），测试面为包级一份 | 随域重画 mutate 清单：**事实源是 `scripts/data/mutation-topology.json`**（`stryker.conf.d/*` 由 `gen-stryker-conf` 派生，直接手改会被 `--check` 判红） |
| 变异面排除项 | `mutation-topology.json` → `packages["dsh-mcp-manager"].testLayers.coverageExcludes` 第 1 条：`!.../src/**/interface.ts`，`kind=facade` | 重估该条（落到 notifier 形态后 `interface.ts` 带 `installXxx/releaseXxx` 配对状态，是可变异逻辑）；**新增 `deps.ts` 的 `type-only` 条**（纯类型面文件；条数按 §3.4 的实测结果定）。注意：该条**不在** `coverage.config.json`（覆盖率面只有 5 条 exclude，无 facade 条）——**B0③ 原写「重估 coverage.config.json 的 facade 排除项」是错的，改指本行** |
| **连带必改的三处（复核补）** | — | ①`scripts/test/mutation-topology-coverage.test.ts:115` 硬编码 `{"dsh-mcp-manager":1}`、`:157-161` 断言总数 **12** → 加条后变 2 / 13，**必须同笔改**；②改 topology 后**必须重新生成 6 个段 conf**（`gen-stryker-conf`；`mutation-topology-coverage.test.ts:92-107` 断言每条 exclude 都落到盘上的段 conf）；③`test-surface.mjs:129` 断言 `testMutationExemptions` 指向的文件必须存在 → B3 删 `service-contract.test.ts` 必须同笔删登记 |
| 覆盖率面 | `coverage.config.json` 的 include/`exclude`（5 条 exclude，无 mcp 专属条） | 按新结构重估；`verify-coverage-scope` 守面完整性——**条目命中 0 文件即判红，故 B0 不得预先把空的覆盖条目写进去**（mcp 现在落在 include 面内，本轮大概率无需改） |
| 变异 src 超集 | 现有并集只到 `src/index.ts` / `workspace/**` / `config/**` / `connection/**` / `inject/**` / `pipeline/**` / `api/**` / `stats/**` / `bootstrap/**` | B0 把 `src/server/**/*.ts` **与 `src/shared/**/*.ts`** 一起以**超集**形式纳入（旧 glob 保留）。**漏 `src/shared/**` 会硬挡 B1**：新文件进 `uncoveredSrcFiles`（覆盖断言 `src ⊆ ∪mutate ∪ ∪excludes` 判红），而 `--write-baseline` **拒绝接受新证据**，只能逐文件写 `gate-exemptions.json` |
| 测试文件下限 | `--min 16` | 随新增文件上调（该下限是**文件数**棘轮，防 include 漂移；参照包 40） |
| `testLayers` 登记 | `unitExemptions` + `testMutationExemptions` 共 2 条 | 前者随搬迁重判，后者随源文本断言退役而删 |

**B0 实测落地（切片 2，`cd44c90`）**：

- **超集只挂一个段**（`runtime` 段追加 `src/server/**/*.ts` + `src/shared/**/*.ts`，旧 glob 全保留）：覆盖断言是**并集**属性（`mutation-topology.mjs:191-199` 汇总各段、`verify-dir-imports.mjs:521-531` 按文件判并集），单段即成立；6 段都挂会让 B1 新树的同一批文件被 6 段重复度量，与本仓「一个 src 文件只登记进一个段」的既有做法相悖（先例：notifier 的 `src/shared` 独立成段、provider-usage 的 `src/shared/*.ts` 各挂单一消费段）。B1 期间 `runtime` 段会承载全部新树变异体，B2 按域重画时收敛。
- **facade 条保留 pattern、只重写 reason**（不删）：目标形态的门面共 **13 个**（11 域 + `server/shared` + `src/shared`），只转调域内 service、自身不做裁决，与参照包 notifier 的同类条同形；删条还会与附录 D.3 的计数（1→2 / 12→13）矛盾。**适用期止于 B2**——按域重画时逐条复核，若裁决逻辑真的上移到门面则删除本条。
- **新增 `!.../src/server/*/deps.ts`（`kind=type-only`）**：只列 `server/<域>` 一层，按附录 E.4「6 域建（pipeline/catalog/connection/inject/api/config）、store/stats/integration 实测零对上依赖不建」；若某域 `deps.ts` 出现值实现（notifier `channels/impl/system/deps.ts` 先例），B2 须拆出单列 `not-mutated`。
- **`coverage.config.json` 不改（已实测评估）**：include `packages/*/src/**/*.{ts,tsx}` 已结构性覆盖目标树（本包现有 77 个 src `.ts` 全在 include 面内，不在 = 0）；5 条 exclude 里**没有** facade 条（本节前面的更正属实）；且 `verify-coverage-scope.mjs:220-230` 对「模式在覆盖率根内命中 0 文件」判红，故 B0 **不得**预置空条目。
- **`--min` 保持 16**：`gen-stryker-conf --sync-test-min` 实测输出「同步完成：0 个包」（本切片不新增测试文件，no-op）。

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
| 磁盘 | `config.json` / `user-state.json` / `catalog/<hash>.json` / `catalog-summary.json` / `stats.json` / `version`；项目级 `<项目根>/.dsh/mcp.json`；自定义 `storePath` / `statsFile` 以用户值为准 | 布局单源 + 迁移独占一域（I7）。**不新增 `status.json`**（内存态 + SSE 零负载回拉已闭环） |
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

**保留（用户可见 / 跨插件 / 磁盘）**：① 存储布局迁移语义（含降级不兼容的 release note）；② HTTP 路由集合与 loopback 围栏（403 先于 405）；③ SSE 帧集合与零负载回拉 + 60s watchdog；④ `ctx.mcpManager` 的方法名与签名（除 D4 显式登记项）；⑤ `config.json` 的 `0o600`；⑥ **`getTools` 的键口径 = 注册名 `mcp__<server>__<tool>`**（D4 只改**取数源**，不改键口径——「同源」= 与查询出口共用同一份投影数据，不是改成裸名）。

**不保留（内部，且现状是缺陷）**：① 凭据出境口径（§6）；② `getTools` 中间层接管时恒返回 `[]` 的行为（取数源修正的直接后果：返回**实际生效**的工具集）；③ 命名双份（`summary()` 与 `summarize()` 收敛为一个对外名，实现名可私有）；④ 内部符号的导出位置（I4）；⑤ 注释与文档形态（I12）；⑥ `summary` 载荷里 `env/headers` 的**值域**（改掩码）与 `url` 的 userinfo（去 userinfo，host-only）；⑦ stdio stderr 尾巴的全文**默认**外发（改为两档：默认结构化摘要含**首行**，全文走显式按需通道且过同一脱敏器）；⑧ 主入口公开导出的 19 个跨域常量（`src/index.ts:87-114` 的 limits / `DEFAULT_*` / `MIDDLEWARE_GLOBAL_ROOT` 等 → B3 逐符号收缩说明）。

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
| N4 | 不动仓库 `shared/` 其它模块与相对路径引用方式；不在本包内新增仓库级 `shared/file-io` | IO 原语由**自写**的 `server/shared/file-io.ts` 单点承接（§7.5）；仓级统一留给 `#706`（本仓暂无「全包读写能力统一」的 issue），届时替换只发生在这一个文件 |
| N5 | 不改线协议**语义**（帧集合、六态计数含义、403 先于 405）；物理位置移到 `src/shared` 属结构变更 | 契约冻结 |
| N6 | 不改 `.dsh/mcp.json`（项目级配置）的路径与格式 | 随项目走、可提交 git，是本插件唯一用户资产路径 |
| N7 | 不为数字拆函数、不做与插件无关的通用工具库、不发运行时依赖 | 仓规与 refactor skill |
| N8 | 不引入 `picomatch` / `p-retry` / `lru-cache` / `dotenv-expand` / SSE 服务端 hub；已知 secret 脱敏仍自写 | 语义变更或不符合分发模型（附录 B.3） |

---

## 十二、迁移批次（4 批）

> **PR 切分**：PR-1 = **B0**（契约冻结 + 门禁接线，必须早于第一个结构 commit）；PR-2 = **B1–B3**。硬约束：**每个 commit 只做一件事**（搬移或改行为），行为变更按 §10.2 登记。
>
> **登记面与结构同提交**（参照教训：notifier 的 76 个未覆盖文件红与导出面红各自悬了一整个窗口期）：每个批次的验收必须包含 `pnpm gate:pr` 全绿 + 该批涉及的**全部登记文件**同步（baseline / faces / `gate-scope-registry` / `ci-face-registry` / `mutation-topology` / `coverage.config` / `dir-imports-baseline`）。**B1.2 实测补两项**：`packages/<pkg>/package.json` 的 `test --min`（测试文件数下限）与 `vitest.stryker.d/<pkg>.config.ts` 的**显式测试文件清单**——新增测试文件就必须同笔抬 `--min` 并 `pnpm stryker:gen`，否则 `gen-stryker-conf --check` 与 test 下限会判红（`stryker.conf.d/**` 变异面本身**不需要**改，`src/server/**` 超集已覆盖新文件）。
>
> **B0 进度（2026-09-14）**：①③④⑤⑧⑨ 与 §5.3 的 client 判据**已完成**——③ `43229f6`/`d3a21d2`、④ `da83b36`/`660dd0a`/`f8ee6c5`、⑤ `cd44c90`/`8fe5119`、⑨ + client 判据 `58823bc`/`d6795ec`。**⑥ 的 I8 判据已完成**（`84a5941`/`8727cf0`/`1fb0af3`，含证据类文档同步；判据面边界见 §二 I8 末条）。**② 打标已完成**（`0ad5a02`/`3565687`）。**⑦ 已完成**（`fd2f82d`，含产物断言正反两面）。**⑩ 已按实测证据移入 B1**（见本表后）。**⑧ 评估为 no-op**（`--min` 已在上限）。**`pnpm gate:pr` 已两次实跑 = exit 0**（32 条门禁项逐条 exit=0 + `GATE_PR_EXIT=0`）。**B0 全部项已收口**；`docs/DEVELOPMENT.md` 与 `scripts/README.md` 的四类证据同步已完成（`1fb0af3`）。

| 批 | 内容 | 验收（每条都要 exit code） |
|---|---|---|
| **B0 契约与接线** | ①目标公共面清单（三面分类，逐符号）写进方案/文档；②`architecture-contract.md` 三分类打标；③**用重构前那棵树生成** `scripts/data/dsh-mcp-manager-export-surface.json` + 手写 `-export-faces.json`（`legacy` = 当前主入口导出全集）；④门禁接线：`contract-check.ts` 加 mcp、`gate-scope-registry.json`（`export-surface-snapshot` 扩 mcp + `forbid-module-state-src` 扩 mcp，后者**须同笔**在 `gate-exemptions.json` 登记 `src/client/float/panel.ts` 的模块级 `let inflight` 存量豁免——见 §二 I9）、`ci-face-registry.json` 两条数据文件条目、`ci.yml` 的 `dsh-mcp-manager` 面加 `scripts/data/dsh-mcp-manager-*.json` glob（**红线，随本方案 approved**）；⑤`mutation-topology.json`：`src/server/**` 超集段 + facade 重估 + `deps.ts` 的 `type-only` 条、`coverage.config.json` 重估；⑥I8 判据上线（脚本扩展 + 自测 + 数据面范围 + 3 条跨包豁免带 tracking issue）+ §5.3 的 client 判据（**先给 notifier 的 2 条存量写 `gate-exemptions.json` 再 `--write-baseline`**）；⑦`locales.ts` 两行文案降级 + 「客户端产物不含 `~/.dsh`」断言；⑧`--min` 上调；⑨**给 I2① 造执法点**（`verify-dir-imports` 新增质量证据类「目标非 shared 的值边集合」）；⑩~~`src/placement-math.ts` 迁 `src/shared/` + 客户端与宿主改引~~ **【实测移出 B0 → B1，证据见本表后】**；⑪baseline 走 `--snapshot` **前先 build**（判据读 `lib/*.d.ts`），faces **手写**（无生成器） | `pnpm gate:pr` 全绿；`export-surface-snapshot --package dsh-mcp-manager` **exit 0**；`--graph` 基线与当前一致；新判据正反 fixture 双向断言；`test:scripts` 绿（含 `gate-scope-registry.test.ts` / `ci-face-coverage.test.ts`） |
| **B1 骨架与迁移** | `src/server/` 目录 + 组合根（`bindHost` / `assemble` / 逆序释放 / 声明合并）——**原稿的「各域 `interface.ts`/`deps.ts` 空骨架」已裁掉**（裁定见本表后）+ `upgrade` 六件套 + `paths.ts` 单源（含 mode 表）+ `src/shared/` 五文件（**含 `interface.ts`**）+ **⑩ `src/placement-math.ts` 迁入（由 B0 移入，见下）** + IO 原语（**自写** `file-io.ts` + 同路径队列） | 探针证明链路通（apply → install → release 各域标记复位）；迁移测试**五态**；`version` 刻度推进与失败不推进；`pack:check` 对 mcp 判绿且 **`THIRD-PARTY-LICENSES` 相对基线无新增**（本轮不新增任何依赖） |
| **B2 域重写** | 叶子域（`store/stats/pipeline/config/workspace`）→ 中枢域（`connection/catalog/inject`）→ 出口域（`api/sdk`）；`McpManager` 逐块搬空；**同期完成** D3（凭据单链，含客户端改名带源身份）、D4（取数源同源 + `apiVersion`）、D5（跨端引用改 `src/shared`）；删除 `bootstrap/`；**在删除那一笔内**用 `--snapshot` 重冻结导出面 + **手改 faces**（`legacy` 收缩到三面）+ mutate 段重画 + 72 个未覆盖文件修正**同一笔**（与参照包 `8df3950` 同形） | ①`node scripts/gate/verify-dir-imports.mjs --package dsh-mcp-manager` **exit 0**（含新增的「域间值边」证据项）；②`export-surface-snapshot --package dsh-mcp-manager` **exit 0**（新树、重冻结后）；③投影/脱敏**构造点 = 1** 的源码扫描断言（附正反 fixture）；④基线源码级逐条对账表（`manager/middleware/middleware-register/routes-controllers` 四文件）+ 定向变异；⑤`pnpm cov && pnpm crap --diff <base-ref>`（先声明基准 ref 与判红处置；注意 `strict:false` 下不带 `--diff` 恒 exit 0，且重写后 git 可能认不出 rename → 移动的文件按新增函数判，拆出的高复杂度函数可能判红，需预判） |
| **B3 收口** | 测试按域落位 + I8 判据存量清零；**逐符号收缩说明**（收缩本身已在 B2 那笔完成，这里只补说明与 `legacy` 终态核对）；契约文档重写与包内 docs 清理（`docs/` 只留有效专项设计 + 归档）；README 中英 + release notes（存储迁移 + 凭据出境 + `apiVersion` + 常量收缩）；注释收口；同时删 `test-surface` 的 `testMutationExemptions` 登记 | `pnpm gate:full` 绿；`uncoveredSrcFiles` 全空；注释验收三条；`docs:check` 绿；导出面快照在**新树**上 exit 0 |

**⑩ 由 B0 移入 B1：实测证据（不可在 B0 做）**。把 `src/placement-math.ts` 挪到 `src/shared/` 后实跑：`node scripts/gate/verify-dir-imports.mjs --package dsh-mcp-manager` → **exit 1**，判词 `missingInterface: config/model/config-schema.ts|shared/placement-math.ts`——因为 `src/shared/` 还没有 `interface.ts`，它就不是叶子模块，**域内文件引用它即被判「缺门面」**；`--write-baseline` 同样 **exit 1** 拒绝写入（基线零位移）。唯一出路是建 `src/shared/interface.ts`（B1 的活）或写 `gate-exemptions.json`（**放宽，禁止**）。**结论：`src/shared/` 的门面与 `placement-math.ts` 的迁移必须同一笔完成**——这同时验证了门面判据在 B0 是**真的带电**的。

**B1 的连带面（切片 4 实跑补充，必须同一笔做）**：`mutation-topology.json` 六个段的 excludes 各有一条 `!packages/dsh-mcp-manager/src/placement-math.ts`（`:92/102/117/127/142/161`）。文件挪走后该 pattern **不再命中新路径**，而新路径落在 `runtime` 段的 `src/shared/**/*.ts` 超集里 → 这张薄 facade 会**进变异面**（与 provider-usage 对 `src/shared/placement-math.ts` 的 facade 排除先例相悖）。正确处置是**把该条 pattern 平移到新路径**（语义位移，不是新增证据），并重生成 6 份段 conf。

> **B1 进度（2026-09-14）**：**B1.1 已完成**（`f21d44d`，含 ⑩）：建 `src/shared/interface.ts` 门面 + `placement-math.ts` 迁入 + 消费点改经门面 + 六条 pattern 平移；`dir-imports-baseline.json` 登记 7 类**结构型**计数位移（`quality` 段逐字节不变），公共导出面零变化。**B1.0 判据加固已完成**（`4f94f65`，见附录 G·G1）：关掉 I8① 的裸包名自引用绕过路径。**B1.2（落盘面）进行中**。**B1.2 已完成**（`dfd6577`）：`server/shared/` 三文件（`paths.ts` 的 mode 表 + 自写 `file-io.ts` 原子写与同路径队列 + 门面）+ 17 条单测；`dir-imports-baseline` 仅 5 个数字（`quality` 段与其余 5 包 byte-identical）。**B1.3（`upgrade` 六件套）进行中**。**B1.3 已完成**（`4bd6af6`，15 文件 +1231）：`upgrade` 域六件套（步骤表/链驱动/刻度/失败语义/对账/装配标记）+ `storage-layout` 一步 + 43 条单测；**未接线**（被禁面 grep 0 命中）；`dir-imports-baseline` 仅 7 个数字、`quality` 段与其余 5 包 byte-identical。**B1.4 组合根已完成**（本刀）：机制 + 宿主能力面 + `declare module` 迁入 + 探针。新增 `src/server/shared/host-faces.ts`（宿主能力面的**类型定义处**，I1 第二白名单点：`HostContextPort = Pick<Context, …>` + 六条按 E.2 实测落定的能力面 `logger / register / tools / prompt / expose / events`；`settings` 是晚到服务、`sessions` 实测零命中，两条都**不预置**，理由就地写明）与 `src/server/shared/compose.ts`（组合根机制 `bindHost / assemble / safeDisposeAll`，经 `server/shared/interface.ts` 门面转出）；入口迁入声明合并（键引用 `MCP_MANAGER_SERVICE as const`，非导出常量）；`test/integration/real-context.test.ts` 9 条**真实 Context** 探针（装配顺序 / 释放严格逆序 / 标记复位 / 重复装配当场抛 / 能力面收窄 / 入口契约 + 编译期声明合并锁）。登记面：`test --min` 21→22、`vitest.stryker.d` 测试面 +1、`dir-imports-baseline` **仅 3 个数字**（`scannedSrcFiles` 75→77、`allSrcTsFiles` 90→92、`fileValueEdges` 127→128；`quality` 段与其余 5 包 byte-identical）、入口导出面**零 diff**、`pack:check` 声明合并可达性仍绿。**未完**：`src/shared` 另外五个文件。

> **两条显式收窄 + 一条落点裁量（B1.3/B1.4，主控裁定，理由在方案自身）**：
> ① **不建 10 个空域骨架**（`store/stats/pipeline/config/workspace/catalog/connection/inject/api/sdk` 的 `interface.ts`/`deps.ts`）。依据是**决策⑥**：`deps.ts` 的口径是「**运行时能力消费**」的**实测**产物（附录 E 已证 workspace 静态 0 边但运行期 2 条对象成员边），域代码不存在时写它只能是猜；10 个空门面只会往登记面加 10 个模块、零行为收益。**各域随 B2 重写时与其真实代码同笔生成**。
> ② **B1.4 不重写 `bootstrap/apply.ts` 的既有装配、不把既有装配路由进 `assemble`**：本刀只交付机制 + 宿主能力面 + `declare module` 迁入 + 探针，插件保持今天的行为可用；把真实域接进 `assemble` 是 **B2**（那时域才存在），否则就是二次重写。
> ③ **组合根机制的物理落点是 `server/shared/`，不是 §3.1 字面的 `src/index.ts`**（B1.4 落点裁量，两条硬要求不可兼得时的取舍）：入口加任何新导出都会让 `export-surface-snapshot --package dsh-mcp-manager` 判红（判词「入口 . 新增导出」），而写在入口又不导出的函数测试不可达——「入口导出面零 diff」与「夹具域驱动的探针」只能同时满足于「机制住在可 `import` 的内部模块」。**入口仍是组合根**：B2 由 `src/index.ts` 调 `bindHost(ctx)` → `assemble(host, domains)` → `ctx.effect(() => () => safeDisposeAll(disposers))` 接真实域；`Context` 的引用面因此仍只有两处（`host-faces.ts` 的类型 + 入口）。**连带收益**：`assemble` 对每个 `install` 一律 `await`，B1.3 记的「`installUpgrade` 返回 Promise、B2 必须 `await`」由机制兜住，接线方漏写不会有第二次机会。
> ④ **主控裁定（2026-09-14）：③ 接受**，并补一条子 agent 未提、但必须记账的**准入面事实**——`compose.ts` 落 `server/shared/` 与 **I5 的准入规则不符**（函数与值面要求 **≥2 域消费**，且 §二 I5 明文写「**单一消费者留包内**」），而它今天**只有组合根一个消费者**。接受的理由：另一条路要么**放宽入口导出面**（判据让步），要么**放弃探针**（机制不可测），两者都比「准入面记一笔」更差。**B2 复查项**：导出面在「删除那一笔」重冻结后，机制应回到入口（此时它可作为「4 符号组合根」的一部分被导出），或证明它确有 ≥2 消费者；否则 `server/shared` 的准入面等于被放宽过一次，须在 B3 的准入核对里如实记账。
> ⑤ **B2 的编排修正（2026-09-14，来自 B2.1 的实测拦截）**：把 `src/stats/` 搬到 `src/server/stats/` 后，`crossDomainValueEdges` 里同一条值边的 id 由 `connection/orchestrator|stats` 变成 `connection/orchestrator|server/stats`——门禁把「旧 id 消失」记为改善、把「新 id 出现」记为**新增未登记证据**并判红，`--write-baseline` 也拒绝写入（基线零改动）。**根因是证据 id 路径派生**（模块 id = 相对 `src` 的目录路径），不是违规。**处置是不制造这次位移**：B2a **就地**重构成 `src/stats/{interface.ts, deps.ts, impl/**}`（模块 id 仍是 `stats`，quality 段逐字节不变、零台账）；**`server/` 前缀并入 B2b 那一笔原子变更**（方案本来就有一笔「删除 `bootstrap/` + 导出面重冻结」）。**前提**：B2b 之前 `crossDomainValueEdges` 与两类环应收到 **0**（I2①/I2② 终态）——**0 条的集合做重命名不产生位移**；若未到 0，残余单独裁决。**明确不采纳**「逐域搬迁 + 逐条台账豁免」：那会让台账成为 B2 的常规放宽通道（见附录 G·G16）。**B2.1 已按此收口并给出最强证据**：全量 `--write-baseline` 前后基线 **sha256 相同**、`git diff` 零行、提交不含任何登记文件、**未新增台账条目**；对照证据是走 `server/` 前缀时同一命令 exit 1 且拒写。**后续每个叶子域都照这个模板做**（就地重构 + 逐符号对账 + 零位移证据），`server/` 前缀一律留到 B2b。**模板订正（B2.2 撞出）**：「零位移」的正确口径是 **quality 段逐字节不变** + **结构计数允许按新增文件线性上升并逐键归因**（`--write-baseline` 本就接受结构型上升）——「sha 完全相同」只是**纯重命名时的更强特例**，**不能**拿它挡住建 `deps.ts`（新增文件必然改三个结构计数；B2.2 因此把 `workspace` 欠的那份 `deps.ts` 推迟到 `install(deps)` 那一笔）。

> **接线顺序约束（B2 必须遵守，来自代码事实）**：`upgrade` 的 `storage-layout` 步骤会把旧文件 `rename` 成 `*.migrated.bak`；而各域今天仍读旧路径（`config/store/store.ts` 读 `<DSH_HOME>/dsh-mcp.json`、`catalog/cache-view.ts` 读 `dsh-mcp-catalog.json`、`middleware-state.ts` 读 `dsh-mcp-user-state.json`）。**先接线迁移、后改读者 = 归档旧文件而旧读者读空 = 静默丢用户配置**。故 `upgrade` 的启用与「读者改读新布局」必须**同一笔**（B2）；B1 只交付可直接调用并单测的域，不接线。

**commit 上限建议**：B0 ≤10、B1 ≤12、B2 ≤5/域、B3 ≤25；合计 ≤80。squash merge 下批次粒度只存在于分支，交付物（逐符号收缩表、对账表、exit code）必须落 PR 正文或持久文档。

---

## 十三、已知盲区与风险

| # | 风险 | 对冲 |
|---|---|---|
| R1 | **整模块重写静默丢能力**（§10.3 已实证） | 基线源码级逐条对账 + 组合根真实 Context 集成测试 + 能力清单随 PR 逐条勾 |
| R2 | 存储迁移的降级不兼容 | 写进 release notes；旧文件归档 `.migrated.bak`；迁移五态测试 |
| R3 | 权限被凭空改动 | §7.1 逐文件 mode 表 + **显式传值**（不依赖任何库的复制语义）+ 落盘权限断言 |
| R4 | 覆盖率 / 变异基线回落 | `covered >= baseline - 1pp`；迁移 PR 走夜间重建豁免；`uncoveredSrcFiles` 全空 |
| R5 | 复杂度热点搬家 | 先接缝后抽函数；`pnpm crap` 观察期记录；不为数字拆函数 |
| R6 | `declare module` 的 mcp 特例（现住 `integration/service.ts`，带 stryker sandbox 注释） | 移到包入口（参照包）；判据用 `pack:check` 声明合并可达性 |
| R7 | 客户端文案与 #769 交叉 | 本轮只做两行文案 + 取数路径引用 `src/shared`；结构改动留给 #769 |
| R8 | `interface.ts` 纳入变异面后分母上升 | B0 重估排除面；`verify-coverage-scope` 守面完整性；宁可如实降分 |
| R9 | 子 Agent 评审结论需交叉复核 | 每条结论附 `文件:行` 或命令输出；协调者一手复跑 |
| R10 | **I8 判据上线会碰其他包** | 存量 3 处走 `gate-exemptions.json` + tracking issue；本包 13 处单调基线 |
| R11 | **自写 IO 原语的队列正确性与残留临时名**（初稿的 `atomically` 依赖链与 `when-exit` 宿主钩子风险**已随撤回消失**，见 §7.5） | 同路径 promise 链配「两次并发 save，读回应为后写者」的并发用例；临时名带 pid，启动时按 pid 判活惰性清理；实现收口在 `file-io.ts` 单点，将来换 #706 的仓级原语只改此处 |
| R13 | **掩码往返在「改名/改归属」路径上必然 400**（客户端走 POST 新条目 + DELETE 旧条目，payload 无源标识） | §6.1 纪律 3 的**规范化地址**（复用 `parseFullServerName` 语法）+ B2 客户端最小改动 + 契约测试覆盖「改名含凭据的服务器」正例 |
| R14 | **I2① 今天没有执法点**，若 B0 忘了造，B2 的「域间值边 = 0」是空头验收 | B0⑨ 明确列为交付项；未落地则把 I2① 降级为报告项并同步改宪法 |
| R15 | **掩码语义边界**（清空文本框 = 缺键 → 合并语义保留旧凭据，UI 无法删除凭据） | 本轮登记为已知限制（不改）；§6.1 纪律 5 写死三条语义，契约测试覆盖「掩码值恰为 `********`」与部分补丁 `{enabled}` |
| R12 | 本包既决缺陷（#770 13 项）里有 5 项与边界同源 | §6 本轮修完凭据面；其余按 §10.2 逐条登记「本轮改 / 不改」 |
| R16 | **基线「两级首次登记」的洗白路径**（删键 + `--write-baseline` 可把该类现状洗成基线） | 已评估为**可接受**，但护栏描述经对抗复核**订正**（见附录 G）：**唯一护栏是人工 diff 审阅**——CI 只跑 plain check，**洗白后的基线在 check 模式按构造必然 PASS**（基线无 provenance，机器无法区分「刚被重写的键」与「原样保留的键」）。实测两条更宽的同族路径：删**整包**条目可一次洗 **10 类**且提示只报条数不报明细；**瞬态台账**（写基线时台账在、检查时不在）使被锁进基线的违规在仓内不留任何放宽记录。类级首次登记在输出里逐条点名「须在 PR 内确认」；类内新增仍判红中止 |

---

## 附录 A 决策记录

见 §零 的 D1–D8 表。补充三条口径：

1. **红线授权**：`.github/` 改动 + 公共 API 行为变更（§6 / §10.1）由一次 #767 `approved` 覆盖。**本轮不新增任何第三方依赖**——`fast-redact` 撤回（第 5 条）、`atomically` 也撤回（第 6 条），故红线由三条降为**两条**；不引用 `yaml`（#781）的无 approved 先例。
2. **不做 shim**：无过渡 re-export 层，故 B3 只做一次基线重冻结。
3. **API 版本位**：`ctx.mcpManager` 增 `apiVersion` 字面量（本包首个版本位），退役 / 变更项在 release notes 逐条列出。
4. **掩码还原用「一个规范化地址」，不引入不可变 `id`，也不加三个平铺字段**（本轮）：改名/改归属由客户端在 POST 里带上**协议已有的地址形态**（`@@global/<name>` / `@<root>/<name>`，即 `parseFullServerName` 的语法），服务端只在源对象上取原值。理由：`id` 会牵动存储迁移（新增一步）、`ServerConfig` 形态、DTO、导出面与 ABI，而它今天的**唯一**消费者就是掩码往返；显式源身份语义更直白（「这个掩码来自哪个对象」）。参照包的不可变 id 是更强的机制，登记为**后续演进项**（若出现同 scope 内复制、批量迁移等需求再做）。
5. **`fast-redact` 撤回**（复核）：本轮无调用点，不为不存在的消费者走一次依赖红线；若后续确有对象级掩码需求，另开裁决。
6. **`atomically` 撤回，改自写**（放弃「保留依赖 + B1 探针」的折中）：三个库候选逐一实测后全部否决——`atomically` 的 `when-exit` 在模块加载期就改宿主退出路径、`write-file-atomic` 无写队列、`steno` 不收 `mode` 且合并写（比较表见 §7.5）。自写只比现状多约 15 行串行队列，换来「不装进程级钩子 + 零依赖 + 显式 mode」。红线因此由三条降为两条。

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

**两轮复核合计**：v4 经四方复核（主控一手 + 三视角）= 3 条 P0 / 13 条 P1 / 约 20 条 P2；v5 初稿经三视角复核 = 4 条 P0 / 13 条 P1（见 §0.1 的 15 条修订）。按 v5 立场归位：

| 类别 | 条数 | 处置 |
|---|---|---|
| **因立场改变而在设计上消失** | 约 13 | P4 的 shim 与「导出面改口径」（D1 / D2 取消该动作）；P5 残留的 `testFiles` 策展与导入面清零（§8.3 / N2 重写）；`fast-redact` 无消费者（**已直接撤回，不再靠 D3 找消费者**）；A8 与 A14 互斥（D5 定死）；A13 原样搬移（D4 反转）；I10 的 J1 / J2 拆分（单链落地后是一条判据）；附录与 D 表口径不一致（v5 重写） |
| **v5 初稿被复核推翻并已修订** | 15 | §0.1 逐条列出：掩码不删键 / 显式源身份 / 出口矩阵 8 类 / 删「类型即围栏」/ I2① 造执法点 + 第三判据 / 常量按消费域数归 `server/shared` / deps.ts 表诚实化 / Port 表降级为示意 / mutate 超集含 `src/shared/**` / 重冻结落到 B2 删除那一笔 / 归档一律执行 + 迁移不解析（四态）/ 撤回 `fast-redact` / 登记 `when-exit` 宿主钩子 / 掩码语义三条 / 脱敏输入集写成能力 |
| **仍需修（已在 v5 内修）** | 3 | P0③ 指错文件 → §8.3 明确 `mutation-topology.json`；`ci.yml` 数据面 glob 与两处登记 → B0④；`deps.ts` 面登记漏项 → §8.3 |
| **数字与行号卫生（v5 已核）** | 约 10 | 14800 → 14635（+helpers 161）；`RoutesManager` 24 / 5 → 23 / 8；`routes-controllers` 24 → 18；`smoke` 6 行号 → 9 处；`summary` / `summarize` 命名；`config-schema` / `host-faces` / `constants` / `statsFile` 等陈旧行号；`C-*` 13 → 6；`deps.ts`「0 / 14 域」→ 11 域 |
| **流程项** | 2 | v5 文档入库；I8 与 `ci.yml` 属红线，随 #767 一次 approved |

## 附录 D 交接状态（会话压缩用）

### D.1 环境与基线

| 项 | 值 |
|---|---|
| 主 checkout（**只读，未改动**） | `/mnt/ssd/dev/dsh-plugin-hub`，HEAD `b490e87`（v0.2.4 发布点，与方案里的代码基线一致） |
| 方案 worktree | `/mnt/ssd/worktree/dsh-plugin-hub-task-767-arch-v4`，分支 `task/767-arch-v4`，领先 `origin/main` **54 个提交**（B0 + B1 全部 + B2a-structure 四刀；**W1+W2 在飞未提交**，见 D.2·38/40）|
| 提交（方案期） | `e356696` v5 定稿 / `4b1153e` 三视角复核修订 / `803b670``2ff9ff6` 交接状态 |
| 提交（B0 实施） | `43229f6` 导出面基线冻结 · `d3a21d2` faces + 准入自测双包遍历 · `da83b36` 门禁接线 · `660dd0a` mcp 豁免 + 连带自测 · `f8ee6c5` ci.yml 数据面 glob（红线 1）· `8235e32` 两轮复核并入 · `ec3004c` 维护者裁决落地 · `cd44c90` 变异面 · `8fe5119` facade 计数修正 + §8.3 实测 |
| 提交（B0 切片 3a/3b 与收口） | `58823bc`/`d6795ec` I2①/I2④/client 三判据 · `84a5941`/`8727cf0`/`1fb0af3` I8 判据与证据类文档同步 · `e35767d`/`edab5d0` 切片记录（含 I8 判据面按宪法原文收窄）· `0ad5a02`/`3565687` 契约三分类打标 · `6c5d150`/`9f7cc62`/`4dbf2a4` 附录 F 与交接状态 · `fd2f82d` B0⑦ 文案与产物断言 |
| 提交（B1） | `f21d44d` B1.1 建 `src/shared/` 门面 + `placement-math` 迁入 + 六条 facade 排除 pattern 平移 + 结构型基线登记 |
| 提交（B1 余下） | `4f94f65` B1.0 判据加固（关 I8① 裸包名绕过）· `dfd6577` B1.2 落盘面（paths+file-io）· `4bd6af6` B1.3 upgrade 六件套 · `b032294` B1.4 组合根机制 + declare module 迁入 · `a9e897c` B1.5a 三族常量进 src/shared · `fd908b1`/`ea298b0` B1.5b DTO 与服务类型进 src/shared + 仓库级声明退回包内 |
| 提交（B2a-structure） | `0fb3bab` stats · `8628110` workspace · `6bf9457` pipeline（含 deps.ts）· `6ecf57b` catalog（search.ts 因 fileCycles 留原位，见 D.3·22）|
| 提交（B2a-wire） | **在飞**：W1+W2 未提交（见 D.2·40）|
| 交付物 | `packages/dsh-mcp-manager/docs/architecture-redesign-v5.md`（含附录 A–G）+ `architecture-redesign-v4.md`（被取代，B3 归档时清理） |
| 工具链（**本会话实测，与旧交接说法相反**） | worktree **有** `node_modules`（`tsc` / `esbuild` / `vitest` / `stryker` 都在 `node_modules/.bin`），故依赖 build 的步骤（`export-surface-snapshot` / `forbid-module-state-src` / `test:scripts`）可在 worktree 内直接跑，无需安装 |
| 参照实现 | `packages/dsh-notifier`（#733 / PR #777）。关键 commit：`2370774` 冻结基线 / `db1ce0f` 首笔砍到 4 导出 / `8df3950` 一次性重冻结 / `4c79ba0` 重写落地 / `8142b13` 行为变更登记模板 / `a748361` 恢复被静默删掉的能力 |

### D.2 已完成

1. **v4 四方复核**（主控一手 + 三视角）：3 P0 / 13 P1 / 约 20 P2 → 已归位（本文件附录 C）。
2. **v5 重写**：按参照包实证把立场从「结构搬移、行为冻结」改为「一次做到最终形态 + 行为变更显式登记」，8 条决策见 §零。
3. **v5 三视角复核**：机制可执行性 / 凭据单链闭合性 / 迁移与批次可行性，4 P0 / 13 P1，关键断言经协调者一手复跑 → 15 条修订全部并入，逐条见 **§0.1**。
4. **维护者已拍**：跨端契约全量收进 `src/shared/`（D5 加强）；测试导入面判据上线（D6 加强，只限 `test/unit/**`）。
5. **维护者已按推荐方案裁决**（原文「按推荐方案走」）：①撤回 `fast-redact`；②**撤回 `atomically`**，改**自写 + 同路径队列**（四候选实测比较见 §7.5）——**红线由三条降为两条**；③掩码还原用**一个规范化地址**（复用 `@<root>/<name>` / `@@global/<name>`），不新造三个平铺字段，不可变 `id` 留后续；④stderr 改**两档**（默认摘要含首行 + 显式取全文过同一脱敏器）。另裁三项：⑤`types` 不设第 12 域、解体到三处；⑥「要不要建 `deps.ts`」以**运行时能力消费**为准；⑦4 处死导入不在 B0 清、B2 域重写时自然消失。
6. **B0 切片 1 已完成**（导出面基线冻结 + faces + 门禁接线 + 豁免登记 + ci.yml glob，5 笔提交 `43229f6`/`d3a21d2`/`da83b36`/`660dd0a`/`f8ee6c5`）；协调者独立复跑 `export-surface-snapshot` / `forbid-module-state-src` / `verify-dir-imports --graph` 与 `pnpm test:scripts`（628 pass / 0 fail）**全部 exit 0**。
7. **第三轮只读复验已并入**：凭据单链现状（§0.2，含端到端实测的红的基线 + 4 个脱敏器构造点 + 1137 用例零「出口不含明文」断言）与 Port 面实测表（附录 E，含 `types` 缺口、4 处死导入、静态/运行入口径冲突）。
8. **B0 切片 2 已完成**（`cd44c90` + `8fe5119`）：变异面超集（**单段**挂 `runtime`）+ facade 条重估 + `deps.ts` 的 type-only 条 + 自测计数 `1→2`/`12→13` + 段 conf 重生成；`coverage.config.json` 实测评估后**不改**；`--min` no-op。
9. **#767 提案评论已发**（核心思路 + 红线授权 + 更正评论：红线由三条降为两条）；**仓级落盘原语候选已登记**（#706 评论：实测 4 个包各自实现落盘，notifier 8 / mcp 8 / provider-usage 9 / lan-proxy 4 写点，权限语义不一致）。
10. **B0 切片 3a 已完成**（`58823bc`/`d6795ec`）：I2① 执法点（`crossDomainValueEdges`）+ I2④（`rootIndexImports`）+ §5.3 client 判据（`clientServerImports`），三个新证据类正反 fixture 双向可证；协调者复跑 5 个包全 exit 0、mcp 结构型计数逐字未变、基线只增 3 键无位移、`test:scripts` 634 pass。**机制变更**已记入 §5.3 与 R16：`buildBaseline` 两级首次登记（类级只在键缺失那一次生效，类内新增仍判红中止）。
11. **B0 切片 3b 已完成**（`84a5941`/`8727cf0`/`1fb0af3`）：I8 判据上线（`unitImportFaceViolations`）+ 三类新证据的文档同步；存量两档 = 本包 13 进基线、跨包 3 进台账；判据面**按宪法原文收窄**（「本域 impl」归 B1–B3，实测理由见 §二 I8）。
12. **B0 的 ⑥ 已完成**（I8 判据 + 三类新证据的文档同步）。
13. **B0② `architecture-contract.md` 三分类打标已完成**（`0ad5a02` + 笔误修正 `3565687`）：顶部加图例与 **16 节逐条裁定**（保留 / 作废 / 重述）+ 引用规则；就地纠正被证伪的 `api/redactor-factory.ts` 声明。四条重点：C-ERR 第 2 条**作废（已证伪）**、§3.1 的 T1「经 `lib/index.js` 断言」**正是 I8 禁的反模式**、§3.3「`interface.ts` 纳入 mutate」**与 B0 的 facade 排除条方向相反**、§2.5 的 `baselineCovered 74.66%`/`strict=true` **数字已过期**。
14. **`pnpm gate:pr` 全仓口径首次实跑 = exit 0**（`[local-gate] 结果：PASS`）。**项数订正**：真实门禁项是 **32 条**；日志里的 `[gate:pr exit=0]` 是封装脚本的退出标记、不是门禁项——两次运行逐项 diff 仅差这一行，**无项被静默丢弃**。注意：**本地 PASS ≠ CI 绿**——本地任何档都不跑变异，变异在 PR 上按命中切片强制跑。日志里的 `lan-proxy EADDRINUSE` 是端口占用的环境噪声，非判据问题。
15. **技术路线已定**（维护者问「全面删除重写 vs 模块搬迁」，裁决：**都不取极端**）：结构一次到位（零 shim）+ 实现逐块搬迁 + **只在必须换形的块重写**。依据：①「1073 组 A 级差分全绿的重写仍静默漏 4 项能力」已实证；②测试面 14796 行虽全绿但**零条**「出口不含明文」断言、且 13 个单测的断言面是旧形态私有字段，重写当天要么失红要么被迫删断言；③上一轮已做过纯搬迁，结果是把反模式写进了契约。分块判据：纯函数族 2074 行可重写（A 级差分有效）／四个巨型文件 3287 行（src 的 29.7%）必须搬迁 + 逐条对账（B 级）／旧形态即缺陷的面必须重写／目录门面导出面一次到位。**未采纳**「逐域删旧建新」的加固（与 D1 的一次性重冻结冲突，并存期只在 B2 内部且导出面在那笔之前一直红，属可见提醒）。
16. **B0 切片 4 已完成**（`fd2f82d`，⑦）：`locales.ts:74/177` 的 `scopeGlobalOpt` 中英两行去掉宿主路径承诺 + `test/e2e/smoke.test.ts` 加「客户端产物不含 `~/.dsh`」断言（含正反两向自证：注入后 **exit 1**、还原后命中 0）。协调者独立复核：`src/client` 与 `lib/client.js` 的 `~/.dsh` 命中**均为 0**，项目级 `<项目>/.dsh/mcp.json` **合法保留**（正控真实存在）。**⑩ 主动回退移入 B1**（机理与连带面见 D.3）。
17. **`pnpm gate:pr` 复跑 = exit 0**（`GATE_PR_EXIT=0`，日志 `/tmp/gate-pr.log`）：32 条门禁项**逐条 exit=0**，含 `stryker:check`、`pack:check`、`lint`（670/671 warning）、`test:scripts`、全包 build/test/typecheck。**本地 PASS ≠ CI 绿**：本地任何档都不跑变异。
19. **B1 第一刀（B1.1）已完成**（`f21d44d`）：建 `src/shared/interface.ts` 门面 + `git mv` `placement-math.ts` 迁入（仓库根 `shared` 的相对深度 `../../../`→`../../../../`）+ 4 处消费点改经门面 + `style.css` 路径注释同步 + `mutation-topology.json` 六条 facade 排除 pattern **平移**到新路径并重生成 6 份段 conf。`dir-imports-baseline.json` 登记 **7 类结构型计数位移**（`modules`/`interfaceFacades` 14→15、`scannedSrcFiles` 63→64、`allSrcTsFiles` 78→79、`leafValueEdges` 33→34、`fileValueEdges` 116→117、`crossModuleRefs` 134→141），**`quality` 段逐字节不变**。主控独立复验：判据 exit 0、基线 diff 仅这 7 个数字、`quality` 段 JSON 与 HEAD 相同、`export-surface-snapshot` 零 diff、提交后 `gate:pr` **exit 0**（32 项逐条 exit=0，`/tmp/gate-pr-767-b11-c.log`，与提交前那次的逐项完全一致）。**别名陷阱**：`panelAnchorForPosition` 不能与其它 12 个符号同链转出（见附录 G·G8），改为用真实源名直连仓库根单源 + 就地注释。
20. **B1.0 判据加固已完成**（`4f94f65`）：关掉 I8① 的裸包名自引用绕过路径（附录 G·G1）。`resolveCandidates`/`resolveTarget` 未动、存量 0、`dir-imports-baseline.json` **零位移**；`test:scripts` 641 pass（基线 637 + 新增 4）；`pnpm lint` 670 warning；`pnpm gate:pr` exit 0。主控独立复验：判据在 mcp/notifier 均 exit 0、基线零 diff、7 个包都有 `package.json`、我自测的 `test/unit/**` 裸自引用存量确为 0。
21. **B1.2 落盘面原语已完成**（`dfd6577`，8 文件 +549/−6）：`server/shared/` 三文件 —— `paths.ts`（目标布局 + `legacyFile` 同处声明 + §7.1 的 mode 表 + 目录 `0o700`，HOME 只经仓库 `shared/dsh-home.js`）、`file-io.ts`（唯一 tmp 名 → 显式 mode → `rename` → 失败清理并上抛；**同路径 promise 队列**；**不装进程级钩子**；未登记路径抛错不回落默认 mode）、`interface.ts` 门面；17 条单测（18 文件 / 1156 通过）。登记面：`dir-imports-baseline` **仅 5 个数字**（`modules` 15→16、`scannedSrcFiles` 64→67、`allSrcTsFiles` 79→82、`fileValueEdges` 117→120、`crossModuleRefs` 141→142；`interfaceFacades`/`leafValueEdges` **未位移**），**`quality` 段与其余 5 个包 byte-identical**（主控独立比对）；另新增两处此前未登记的登记面：`test --min` 16→18 与 `vitest.stryker.d` 测试面 +2 文件。**两条反例均「改前必红」**：去掉显式 mode → mode 断言红（0o600 实得 0o664）；去掉同路径队列 → 并发用例红（`expected 'first' to be 'second'`，即 R11 要防的「旧数据覆盖新数据」）。`pnpm gate:pr` exit 0（32 项逐条 exit=0，`/tmp/gate-pr-767-b12-final.log`，主控独立核验）。**命名发现**：新模块的 `userStateFile()` 与包入口既有导出**同名**（`src/index.ts:145` 仍导出旧实现）——会被 `export-surface-snapshot` 判成「入口 `.` 声明块新增」，且在迁移期造成「两个同名函数分别返回新旧两条路径」的不可判读；改名 `userStatePath()` 并就地注释，导出面保持零 diff。
22. **B1.3 `upgrade` 域已完成**（`4bd6af6`，15 文件 +1231）：六件套一次建齐（`impl/{version, chain, steps}` + `service` + `deps.ts` + `interface.ts`）+ `storage-layout` 一步（逐文件搬目录型旧路径、纯字节不解析、幂等归档 `*.migrated.bak`、IO 失败抛错、用户显式 `storePath`/`statsFile` 不动）+ 43 条单测（21 文件 / 1199 用例）。**未接线**（主控独立核：`src/index.ts`/`bootstrap/`/`coverage.config.json`/`mutation-topology.json` 零命中；`lib/index.js` 里 `upgradeRunner`/`LEGACY_LAYOUT` 命中 0）。基线**恰好 7 个数字**、键序仍 `$comment,version,packages`、`quality` 与其余 5 包不变（主控独立复验）。**三条反例均「改前必红」**：归档改覆盖 → 4 条红；刻度回写挪到 `run` 之前 → 失败不推进用例红；目录型走整目录 `rename` → mode 断言红（0o664 vs 0o644）+ `ENOTEMPTY`/`ENOENT`。**设计裁定**：`installUpgrade` **返回 Promise**（`file-io` 只有异步面）且在 B1.4/B2 接线时**必须 `await`**；签名故意写成非 `async` 的 `export function`（`analyzeInjectionFaces` 的正则漏 `async`，见附录 G·G12）；`STEPS` = `0.0.0 → 0.2.5`（存储形态代际，发版号若不是 0.2.5 须同步该表，否则对账持续 warn——**这是设计内信号，未放宽断言掩掉**）。
23. **B1.4 组合根已完成**（本刀）：`src/server/shared/host-faces.ts`（I1 第二白名单点：宿主能力面的**类型定义处**，六条按附录 E.2 实测落定）+ `compose.ts`（`bindHost` 收窄 / `assemble` 成对装配 / `safeDisposeAll` 逆序释放；每个 `install` 一律 `await`，把 B1.3 记的「接线必须 await」由机制兜住）+ 门面转出 + 入口迁入声明合并（键 `MCP_MANAGER_SERVICE as const`，`integration/service.ts` 的同名合并删除）+ `test/integration/real-context.test.ts`（9 条真实 Context 探针：装配顺序 / 释放严格逆序 / 每域标记复位 / 重复装配当场抛 / 同名域出现两次抛 / 单域释放失败不阻断 / 能力面逐条转发与「面里没有 ctx」/ `onPreStep` 摘除 / 入口契约 + 编译期声明合并锁）。**门禁**：入口导出面 **零 diff**（`export-surface-snapshot` exit 0）、`pack:check` 声明合并可达性 exit 0、`test --min` 21→22、`vitest.stryker.d` +1 文件、`dir-imports-baseline` **仅 3 个数字**（`scannedSrcFiles` 75→77、`allSrcTsFiles` 90→92、`fileValueEdges` 127→128；`quality` 段与其余 5 包 byte-identical）、`pnpm lint` 670 warning（余量 1 未动）。**三条反例均「改前必红」**：`safeDisposeAll` 改成正序 → 逆序断言红；夹具域去掉「只能装配一次」→ 重复装配用例红；去掉释放里的标记复位 → 复位/复用断言红（每条改完 `git diff --exit-code` = 0）。**未接线**（真实域接进 `assemble` 是 B2）；**落点裁量**见 §十二 表后 ③。**连带面（`gate:pr` 实测发现）**：R6 的迁入打破了 `scripts/test/dts-cordis-merge-lib.test.ts` 里一条以 mcp 为「**间接形态**现实反例」的自测（它断言产物入口**不含**合并）；迁入后仓内已无间接形态的真实主体，该条改为断言当下的直接形态（源面命中只落包入口 + 产物入口直接含合并），间接形态继续由合成 fixture 的合规/违规成对用例覆盖——判据面不变，`test:scripts` 641 条全绿。
24. **ABI 名仍是两处定义**（B1.4 登记，B1.5/B2 收口）：入口的 `MCP_MANAGER_SERVICE` 常量与 `bootstrap/apply-services.ts` 的 `provide("mcpManager", …)` 字面量各写一次。统一它要同笔改 `service-contract.test.ts` 的源文本 marker（既有断言的锚点，改锚要单独评审），且 `src/shared/service.ts` 属 B1.5——本刀不做。

25. **B1.5a 三族跨端常量进 `src/shared/` 单点已完成**（`a9e897c`，15 文件 +378/−95）：新建 `src/shared/{status,frames,routes}.ts`（六态键 + 投影兜底 + `ServerState` 联合 / `SSE_FRAMES` + 负载形状 / `ROUTES` + `ROUTE_FENCE`），两端改引同一份——宿主 `api/routes.ts`、`api/routes-controllers.ts`（controller 内路径字面量清零）、`bootstrap/apply-runtime.ts`、`connection/orchestrator/manager.ts`，客户端 `client/core/constants.ts`（API 表逐键取 `ROUTES`、状态表取六态键）、`client/core/state.ts`、`client/index.ts`。**值逐字节不变、入口导出面零 diff**（`ROUTES` 经 re-export 保住）。新增**永久**一致性锁 `test/e2e/cross-end-lock.test.ts`（10 用例：C 协议值冻结 3 / A 值一致 4 / B 单点定义 3，含「**锁不空转**」自检），**且锁读产物**（`lib/client.js` 内联帧名全集、宿主产物 `ROUTES` === shared）——这是旧锚点强度被真实承接的证据。基线**仅 5 个结构型数字**（`scannedSrcFiles` 77→80、`allSrcTsFiles` 92→95、`leafValueEdges` 35→38、`fileValueEdges` 128→135、`crossModuleRefs` 144→151），`modules`/`interfaceFacades` **零位移**（三个文件进已有 `src/shared` 模块）；`quality` 段与其余 5 包不变（主控独立复验），`clientServerImports` 仍 **0**。主控独立核验：基线 5 个数字与它报的一致、gate 日志 `/tmp/gatepr.log` 32 项逐条 exit=0。**三条反例均「改前必红」**：改 `shared` 一条路径 → 锁红（2 条）；删入口 `ROUTES` re-export → 快照红（判词「入口 . 缺失导出：ROUTES」）；客户端改回**等值**字面量 → 「规范字面量只允许出现在 `src/shared/**`」判红（**等值副本也抓得住**，只做值比较的锁在这里是绿的）。**派单前提被实施方纠正**：`src/types/status.ts` 只有 `ServerStatus` 接口、**没有**六态键集合——真正的落点是 `manager.ts` 的零填充投影与 supervisor/middleware 的状态机字面量；故「投影兜底」落 `manager.ts`、health 计数落 `api/routes.ts`。

26. **B1.5b DTO 与服务类型进 `src/shared/` 已完成**（`ea298b0` + 前置 `fd908b1`，15 文件 +211/−83，含**删除仓库级 `shared/mcp-manager-service.d.ts` 整文件 92 行**）：服务类型落 `src/shared/service.ts`、DTO 落 `src/shared/dto.ts`（`McpServerSummary` narrow / `McpServerListEntry` wide / `ClientUiConfig`），两端一律经门面引用；`shared/README.md` 登记行同步删除；`declare module` 仍在入口。基线**仅 3 个数字**（`scannedSrcFiles` 80→82、`allSrcTsFiles` 95→97、`crossModuleRefs` 151→154 三条 type-only 边），`modules`/`interfaceFacades`/`leafValueEdges`/`fileValueEdges` 不变、6 包 `quality` 不变（主控独立复验）；`--min` 与 `vitest.stryker.d` 实跑为 no-op（用例落进既有文件）；入口导出面零 diff；`pack:check`/`verify:npmlayout`/`aggregate:check`/`verify:scripts-index` 全绿。
27. **派单前提被实施方第二次纠正，且这次它拒绝了主控的要求**：主控写「`McpServerSummary` 是同一形状的两处副本、收成一份」——**不成立**。实测：宿主那份是 **7 键**（`name/transport/scope/status/error/tools/enabled`，且 `transport`/`scope`/`status` 是**联合类型**）的服务查询 ABI（被 `service-contract.test.ts` 逐键锁死）；客户端那份是 **17 键**（含 `command/args/env/cwd/url/headers/disabledTools/toolCallTimeoutMs/description`，且三者被放宽成 `string`）的面板列表/编辑载荷。**同名而不同形状本身就是隐患**。实施方**拒绝合并**（合并即改 ABI），改为「每个形状各一份物理定义 + 客户端零本地副本」：narrow 保名 `McpServerSummary`（ABI 名与既有契约锁零变更）、wide 改名 `McpServerListEntry`。**这是比主控要求更正确的处置**。
28. **主控复核：构建期 X1 机制修正**（`fd908b1`，超出派单字面授权，**全仓生效面**）。X1 的 2a 段把 `(?:\.\./)+shared/` 一律按文件在 `lib/` 下的深度归一，**分不开仓库级 `shared/` 与包内 `src/shared/`**（后者被 tsc emit 到 `lib/shared/`）。后果：产物 `lib/**/*.d.ts` 出现 `TS2307 Cannot find module '../../shared/interface.js'`，而仓库默认 `skipLibCheck: true` 把它**静默降级成 any**——服务 ABI 的类型面对消费方消失，且**既有闸零判据**（见附录 G·G15）。修法（新增 4 行）：`../` 层数 ≤ 文件深度 ⇒ 包内引用**原样保留**，否则仍按 `depth+1` 归一。**主控复核判定：成立且最小**——包内引用恰为 `depth` 个 `../`、仓库根引用为 `depth+3` 个，判据能正确分开两者；被改写的 `bundle-host-x1.test.ts` #3b **原断言锁的正是缺陷行为**，新断言把「包内保留」与「仓库根仍归一」**两个方向都锁住**（五组深度），属纠正而非放宽。实测：`--skipLibCheck false` 探针修复前 mcp 3 条 TS2307 → 修复后 0 条，`dsh-notifier` 同形受损面一并修复。**注意**：B1.5a 的交付态**曾经**带着这个静默降级（`src/api/routes.ts` 已踩到）——B1.5a 的验收绿**不覆盖**它，已登记 G15。

29. **B2.1 `stats` 域就地重构已完成**（`0fb3bab`，**仅 3 文件**）：`collector.ts→impl/collector.ts`（99%）、`types.ts→impl/type.ts`（100%，逐字节）、门面只改转出目标。**主控裁定「不制造位移」已落地并给出最强证据**：全量 `--write-baseline` 前后基线 **sha256 相同**（`157528aa…`）、`git diff` 零行、提交**不含任何登记文件**、**未新增任何台账条目**；**对照证据**是走 `server/` 前缀时同一命令 **exit 1 且拒写**（要求走台账）。5 处域外消费者与入口两段 re-export 的 specifier **一字未改**（门面路径没动）——这正是零位移的来源。`verify-dir-imports` 0、`export-surface` 零 diff、`stryker --check` 0、`pack-check` 0、`lint` 670、**`gate:pr` = 32 条逐项 exit=0**（它数出 32，与主控一致）。**对账证据**：两版「结构行」各抽 54 行做 diff **完全为空**，外加逐符号/逐分支表（11 项，含 `defaultStatsPath()` 运行时探针验证返回同一旧路径）。**三条反例**：①b 门面别名虚导出 → 规则 4 红；①c 门面改名 `facade.ts` → 5 条 `missingInterface`；② 域外直引 `impl/type.ts` → `implToOtherImpl`/`directImpl` 红；③（本域无 `deps.ts`，故临时建一份含**值 import** 的 `deps.ts`）→ **`deps.ts` 只能声明类型依赖**的硬闸红。
30. **一条判据边界事实（B2.1 反例①a 实测，值得留档）**：**只从门面删掉一个被外部引用的导出，`verify-dir-imports` 不红**——规则 4 只验「门面**已声明**的导出可沿链解析到实现」，**不验「消费方要的符号在不在」**。后者由 `tsc` 兜（实测 5 条 `TS2305`：`manager.ts:49`/`supervisor.ts:23`/`index.ts:213`/`middleware-register.ts:35`/`host-faces.ts:11`）。**这不是缺陷**（组合门禁含 typecheck），但要知道这个判据的边界，别把它当符号存在性的判据用。
31. **`deps.ts` 的「不建」名单已由实测确认三域**：`store` / `stats` / `integration` 实测零对上依赖，**按决策⑥不建**（§8.3 已引用附录 E.4；B0 也把该裁量写进了 `mutation-topology.json` 的排除理由条）。B2.1 据此**没有预置** `stats/deps.ts`——这是对的，**后续 B2 各刀也不要为「看起来完整」预置 `deps.ts`**（§3.1 的目标树按此修正，见该处注释）。

32. **B2.2 `workspace` 域就地重构已完成**（`8628110`，6 文件）：`interface.ts` + `impl/{root-resolution,full-name,scope,mode}/index.ts` + `impl/constants.ts`（跨块值文件留 impl 根，依据 §3.1 规则 1）。主控独立核验：提交**只动 `src/workspace/`**（域外文件数 0）、**不含任何登记文件**、基线 sha256 前后相同（`157528aa…`）、`gate:pr` 32 项全绿。对账证据：12/12 符号行号不变（仅 `impl/constants.ts` 因头注释 +3）、**结构行 diff 各文件为空（old=54/new=54）**、逐文件分支关键字多重集逐条相同。三条反例均改前必红（虚导出 / 直引 impl → `directImpl`+`implToOtherImpl` / 门面改名 → `missingInterface`）。**提交正文两处计数写错、未 amend（遵纪律）**：正文「7 处导入」实测应为 **11 个域外导入点**、「两段 re-export」实测应为 **3 条**（`src/index.ts:114-115/120-121/249`）——**以本条为准**。
33. **模板订正（主控，B2.2 撞出的张力）**：「零位移 = 基线 sha256 完全相同」这条主控口径**与「建 `deps.ts`」互斥**——新增任何文件都会改 `scannedSrcFiles`/`allSrcTsFiles`/`crossModuleRefs` 三个结构计数。**正确口径**：**quality 段逐字节不变**（位移会污染的是它）+ **结构计数允许按新增文件线性上升并逐键归因**（`--write-baseline` 本就接受结构型上升，见 B1.2/B1.3/B1.4 先例）。「sha 相同」是**纯重命名时的更强特例**，不是每条 B2a 刀的必要条件。
34. **`workspace` 欠一份 `deps.ts`（B2.2 诚实自报，未建）**：实测静态面零对上依赖，但**运行时非零**——`makeResolveRoot(manager)` 经入参对象取 `middlewareMode` + `projectServersFor`（附录 E.3），按决策⑥**本域欠**（`workspace` 不在「三域不建」名单里）。不建的两个理由成立：新增文件必破 sha 不变验收（见 33）；且无 `install(deps)` 装配面时该端口是 I2③ 死声明。**处置**：与「本域改成 `install(deps)`」的那一笔同笔落地（裁量已写进门面头注释）。

35. **B2.3 `pipeline` 域就地重构已完成**（`6bf9457`，9 文件 +49/−23，含**新建 `src/pipeline/deps.ts` 22 行**）：`interface.ts` + `impl/{args,msg,redact,timeout,authorize,project}/index.ts`；域外**源码**零改动（唯一域外路径是基线文件）；门面路径未动。**这是「模板订正」后第一条按新口径做的刀**：基线 diff **恰好 3 个数字**且**全部由新增 `deps.ts` 线性产生**（`scannedSrcFiles` 82→83、`allSrcTsFiles` 97→98、`crossModuleRefs` 154→155 = +1 条指向 `workspace/interface.ts` 的 type 边）；`modules`/`interfaceFacades`/`leafValueEdges`/`fileValueEdges` 零位移；**6 包 `quality` 段 JSON 逐字节相同**（主控复验 diff 与提交面）。对账：13 个导出符号行号+签名逐字相同、50 条声明一致、两版结构行各 **140 行 diff 为空**、6 块分支关键字多重集逐条相同（如 `authorize[]&&=8 =>=6 ?.=12 ??=1 if=13 new=1 return=6 ||=1`）。三条反例均改前必红（虚导出 / 直引 `impl` / 门面改名+跟改消费者），并**顺手复现了 G17**（只改名不跟改 → exit 0 + PASS + 「改善 4 条」）。**`deps.ts` 实测裁量**：只有一条 `WorkspacePort = Pick<typeof workspaceApi, "parseFullServerName" | "bareServerName" | "MIDDLEWARE_GLOBAL_ROOT">`，**纯 `import type`**；宿主能力实测 0 命中，故比 §3.4 预期窄；口径取附录 E.6 第 3 条「按实际使用」——`authorize` 对 `fullServerName` 的**死导入**（决策⑦）**不为它开口**，本刀不动该导入。**本刀未碰 D3**：`redact`/`authorize` 的构造点数、输入集、文案一字未改（主控确认）。
36. **mutation-topology 的两处漂移（B2.3 如实自报，主控已核代码）**：① `mutation-topology.json:111` 的 `middleware` 段字面量 `packages/dsh-mcp-manager/src/pipeline/authorize.ts` 现 **0 命中**（文件已到 `src/pipeline/impl/authorize/index.ts`），该文件改由 `runtime` 段的 `src/pipeline/**/*.ts` 覆盖——**覆盖不丢、`--check` 仍 0，但它的变异度量段从 `middleware` 漂到 `runtime`**；② 新建的 `src/pipeline/deps.ts` 落进 `runtime` 段的 mutate 面，因为 `:177` 的 type-only 排除条**只列** `!packages/dsh-mcp-manager/src/server/*/deps.ts`（B2b 的目标路径），未覆盖 B2a 的 `src/*/deps.ts`（纯类型面无变异体，无害）。**处置**：按方案「mutate 段重画属 B2b 那一笔」，本刀不改；两条一并进 B2b 的清单（重画段 + 清 0 命中字面量）。

37. **B2a-wire 的端口接线图已由只读 scout 产出**（自写脚本复算，与基线逐条一致；未写仓库）。要点：33 条值边的**消费者域只需 5 个建端口**（api / catalog / connection(orchestrator+runtime) / inject / pipeline）；`config/model` 的 3 个默认值常量**迁共享层后不需要 `deps.ts`**；**5 条靠同域改引**（`middleware.ts:33` 与 `supervisor.ts:22` 改引 `./reconnect.ts`、`manager.ts:52` 改引 `./tool-names.ts` = 唯一 `directImpl` 的修法、删 4 处死导入）；**8~9 个共享常量**迁 `src/server/shared/constants.ts`。切割序列（每刀实测）：**W1** 同域收口 `4/4/33 → 3/2/32`（叶子环 4→3、文件环 4→2、域间值边 33→32；scout 原记文件环 4→1，**实测订正为 4→2**，见 D.2·41）→ ~~**W2** 删复导 `→ 1/1/31`（`directImpl` 1→0）~~ **【已订正：该形态实测不可落地（G21 假新增），W2 并入 W4，见 D.2·41】**→ **W3** 共享常量 `→ 1/1/29` → **W4** catalog 端口 `→ 0/0/26`（**两类环全 0**）→ W5–W9 其余端口 → W10 门面收口 → **W11（B2b）** `bootstrap` 解体 `→ 0/0/0`。**主控裁定**：HB1 模块求值期常量**只能搬迁不能端口**（端口物理上必得 undefined）；`DEFAULT_TOOL_CALL_TIMEOUT_MS` 与 `SCOPE_GLOBAL` **也一并迁共享层**；HB2 **不为 `connection` 自己的子层造端口**（B2b 坍缩后边自动消失，提前造=固化要删的东西）；HB3/HB4/HB5 见附录 G·G19/G20 与 D.3·23。

38. **维护者已定：走路径 B（先 wire、后原子搬迁）**（原文「B 记录现状」）。**含义**：目标结构 `src/{client,server,shared,index.ts}` **最后一步**落地；`B2a-wire` 先把跨域值边与环消掉，再由 B2b 一笔原子搬迁。**为什么 B 是零成本**（scout 实测纠正了主控原先的前提）：残余的 8 条 `bootstrap|*` 边会在同一笔里**被删除**（`bootstrap` 解体 → `moduleOf` 返回 null，消失记为 improvements、不判红、不需台账），**不会被重签名**。
39. **B2a-wire 的切割序列（scout 已复算，每刀给实测数字）**：**W1** 连接域同域收口 `4/4/33 → 3/2/32`（叶子环 4→3、文件环 4→2、域间值边 33→32；scout 原记文件环 4→1，**实测订正为 4→2**，见 D.2·41）→ ~~**W2** 删 `connection/interface.ts:12` 值复导 `→ 1/1/31`（`directImpl` 1→0）~~ **【已实测不可落地：删该边会让改前就存在的子环首次被报出（G21 假新增），W2 并入 W4】**→ **W3** 8~9 个共享常量迁 `src/server/shared/constants.ts` `→ 1/1/29` → **W4** catalog 端口 `→ 0/0/26`（**两类环全 0**）→ **W5** pipeline 端口 → **W6** inject 端口（新建 `inject/deps.ts`）→ **W7** `connection/orchestrator/deps.ts` → **W8** `connection/runtime/deps.ts` → **W9** `api/deps.ts` → **W10** connection 门面 26 符号值面收口 → **W11（B2b）** `bootstrap` 解体 `→ 0/0/0`。（数字记法 = 叶子环/文件环/域间值边。）**注**：scout 的 33 条逐条接线表（含每个符号的**真实使用行**与精确 `Pick` 成员清单、8 条环的备选断点、5 条硬骨头）**未落盘**——它只在会话内消息里。新会话每一刀可由实施方按同法自测（`grep` 该域的跨域值 import + 逐符号找真实使用行 new/调用/取属性），或**重跑同一只读 scout 提示词**增量重建（约 1 轮，只读、不碰文件）。**已知的三条硬事实不要重推**：① `config/model` 的默认值常量在模块求值期被消费 → **只能搬迁不能端口**；② `connection` 自己的子层（orchestrator/runtime）**不要造端口**（B2b 坍缩后自动消失）；③ `api` 对 `manager` 的 44 处直取**没有 import 边**（G19）。
40. **W1+W2 在飞未提交（压缩时刻的关键事实）**：子 agent `7e4faae1-e6c7-4054-8b93-512488f7e141` 正在做 W1+W2，**工作区已有 5 个未提交文件**：`src/bootstrap/apply-config.ts`、`src/catalog/search.ts`、`src/connection/interface.ts`、`src/connection/runtime/middleware.ts`、`src/connection/runtime/supervisor.ts`。已落盘的改动可见 `middleware.ts:33` 已改引 `./reconnect.ts`、`connection/interface.ts` 的 `stripMcpPrefix` 复导已删。**新会话第一步**：`git log`/`git status` 看它有没有提交；有则复核（四组数字 33→31、环 4→1、`directImpl` 1→0、导出面零 diff + 两条反例必红），没有则读它的报告或接手把 W1+W2 收口（它已按派单要求做了这两处改动）。

41. **W1 已落地（`770859b`），W2 并入 W4（主控裁决）**：W1（连接域同域改引 `./reconnect.ts` + 删三处死导入）**单独实测 exit 0 / PASS / 零新增证据**，四文件 + 基线同笔提交。**实测**（`--package dsh-mcp-manager`）：叶子模块级值环 **4→3**、文件级值环 **4→2**、域间值边（I2①）**33→32**（消失的是 `connection/runtime|connection`）、模块级值边 **38→37**、文件级值边 **135→134**、`crossModuleRefs` **158→155**；`directImpl` 保持 1 条。**订正 D.2·37/39 与 scout 的两处**：① 「W1 后文件环 4→1」**不成立**，实测 **4→2**，差的那条 `connection/orchestrator/interface.ts ↔ manager.ts` W1/W2 都没碰（scout 漏算）；② **W2 单独落地判红**——删 `connection/interface.ts:12` 会让三色 DFS 换序、把**改前就存在**的子环 `catalog|connection|connection/runtime` 首次报出 → `leafModuleCycles` 判「新增未登记证据」+ `--write-baseline` 拒写；根因是判据的环枚举用三色 DFS + BLACK 全局标记（附录 G·G21），故 **W2 并入 W4**（catalog 端口那一笔，两类环归零后新身份随之消失、基线才可写），**不登记台账豁免**。③ **基线卫生**：W1 同笔用**不带 `--package` 的全量** `--write-baseline` 清理了 4 条已消失证据（1 环 + 2 文件环 + 1 值边）并下调 3 项结构计数——**残留不清会静默放宽**（回归时该 id 仍在基线里 → 不判红），登记为 **G22**；基线 diff 仅本包、其余 5 包零改动。

42. **只读 scout 的接线表已重建（本轮，32 条边 / 50 个接线点，全部带 `文件:行`）**，口径与门禁四数全中（17 模块 / 37 值边 / 32 条 I2① / 3+2 环）。**三条改计划的实测结论**：① **(a) 类「值 import 但只在类型位置」的收益为 0**——用 `typescript@6.0.3` 的编译器 API（只读 AST，不 build）逐条复核后，32 条边里**没有任何**符号只在类型位置被使用；一个朴素正则分类器给出的 5 个「疑似」全部是 `===` 的尾 `=` 与三元 `:` 被误判，原文 grep 逐条推翻。真正该删的只有 3 处**死导入**（2 处 W1 已删；余 `bootstrap/apply-config.ts` 的 `DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS` 与 `pipeline/impl/authorize/index.ts` 的 `fullServerName` 待后续刀）。② **W2 必须与 `manager.ts:52` 改引 `./tool-names.ts` 合并**才能复现计划的 `1/1/31`——只删复导会停在 **1 叶子环 / 2 文件环 / 31 边**，差额那条文件环是 `connection/orchestrator/interface.ts ↔ manager.ts`（F2；计划把它列在 W1 的「同域改引」里，但实际没落）。③ **W3 的真实最小集是 4 个常量**（见 D.3·29）——计划记的「8~9 个」里其余 4 类的消费方**在同一条 import 语句里还要取同域别的符号**，单独迁常量**边不退、收益 0**；且 `SCOPE_PROJECT`/`MIDDLEWARE_GLOBAL_ROOT` 已被**已落地**的 `catalog/deps.ts`/`pipeline/deps.ts` 的 Pick 引用，现在迁会连带改已冻结的端口面。**断环归属（scout 内存模拟，非推断；主控已核口径）**：三条叶子环 **L1/L2/L3 都含** `connection|connection/orchestrator` 这条边（断点在 W2，故三条一起引发 G21 的「4 条全消失 + 1 条新出现」）；文件环 **F1 断在 W4**（catalog 端口把 `catalog/search.ts` 的值引改成经 `ConnectionPort` 取数）、**F2 断在 `manager.ts:52` 同域改引**；**W3 不断任何文件环**。**新增 6 份 `deps.ts` 的成员清单已逐符号实测**（api / inject / connection-orchestrator / connection-runtime 四份新建；catalog / pipeline 两份已落并与实测逐符号一致），窄口径是**按真实使用取 Pick**、不为死导入开口。

43. **已合并 origin/main（维护者裁决 A：现在合并；共两刀）**：`df0c08d`（双亲 `4994afa` + `c988f32`，吸收 #822/#823/#824/#825/#827，**12 个冲突**）+ `3ff9cc5`（双亲 `df0c08d` + `dd36fa6`，吸收 #828/#829，**1 个冲突**）。全部逐处人工收敛、两侧语义并保留；结果 `gate:pr 32/32 exit 0`、`pnpm lint 508/508`、全量 `--write-baseline` **基线零 diff**。**基点自此冻结**，`HEAD..origin/main` = 1（`191cddf` #832，只改 3 个非本包文件，留最终推送/PR 前那一刀）。**判据携带分歧的权威审计**（`diff 上游 vs 合并后`）：合并后 `scripts/gate/verify-dir-imports.mjs` **1830 行 vs 上游 1533 行**，分歧**全部是本项目 B0 的成果**——4 个新质量证据类（`crossDomainValueEdges` / `rootIndexImports` / `clientServerImports` / `unitImportFaceViolations`）+ 裸包名自引用加固；**上游每包的 `quality` 只有 6 类，我们 10 类**（合并后 6 个包全部补齐 10 类，见 G23）。**判据取数层修复（#825）对本包证据零影响**：主控在合并前的树上用上游判据复跑，四组数字完全相同；唯一差异是结构计数 `crossModuleRefs` 预期 157 **实测 155**——上游 #822 同笔删掉了本包多处未用的跨模块 import 绑定（该计数定义是 `refs.filter(crossModule).length`），方向安全且已登记。**导出面 2 行最小重冻结**：上游 #822 把未用形参 `cwd` 改名 `_cwd`（`no-unused-vars` 已升为 error，`_` 前缀是唯一合法写法，回退会直接 lint error），故只改 `scripts/data/dsh-mcp-manager-export-surface.json` 那两行声明串（主控已核 `2247b6c` 的 diff 原文，且 `export-faces.json` 未动）。**新增硬约束：lint 余量归零**（见 D.3·32）。

44. **W4 已落地（`5ae082a`，主控独立复核通过）**：catalog 域装端口（`CatalogDeps = {store, connection, workspace}` + 新增 `catalog/impl/service/index.ts` 持有者，未装配即抛错、不回落默认值）+ 删 `connection/interface.ts` 的 `stripMcpPrefix` 值复导（唯一 `directImpl` 归零）+ `manager.ts` 改引 `./tool-names.ts` + 入口顶层字面量装配。**实测（主控复跑）**：叶子模块级值环 **2→0**、文件级值环 **2→0**（**两类环全零**）、I2① **30→26**（派单写 28，实测多消 `catalog|config/store` 与 `catalog|workspace`——它们正是本刀的接线目标）、`directImpl` **1→0**、模块值边 38→34、文件值边 136→134、`crossModuleRefs` 155→154；`export-surface-snapshot` **零 diff**（公开面未变）、`gate:pr` **32/32**、`lint` 508/508。基线同笔清理 9 条消失证据、其余 5 包零改动。**G12 的实测危险度比 G20 更高**（W4 反例 4）：把 `installCatalog` 签名加 `async` → 判据 **exit 0** 且输出里「注入面对账」整段**静默消失**；**async + 传变量**（本应命中「实参不是对象字面量」的必红形态）同样 **PASS** ——即 G12 会让 G20 的判据整体失效，故「install 签名不得带 `async`」必须写进每一刀的验收。另：新增的「重复装配抛错」分支**无测试覆盖**（归 B3）；W4 顺带订正了 `catalog/interface.ts` 头部的环成员失效断言。

45. **W3b 已落地（`d01d1a3`，主控独立复核通过）**：按**跨端性**收口四条「≥2 域消费的值常量」——`SCOPE_GLOBAL`/`SCOPE_PROJECT`/`MIDDLEWARE_GLOBAL_ROOT` → 新建 **`src/shared/constants.ts`**（跨端层：客户端以字面量重复实现这两条契约）；`LIST_DEFAULT_TOOLS_PER_SERVER` → `src/server/shared/constants.ts`。两个 Pick 变窄（`catalog/deps.ts` ConnectionPort 5→4、WorkspacePort 6→4；`pipeline/deps.ts` WorkspacePort 3→2）；`workspace/impl/constants.ts` 搬空后**删除**（文件消失 = 改善）；同笔订正 D.3·39 的两处失效注释。**实测（主控复跑）**：叶子环 **0→0**、文件环 **0→0**、I2① **26→26**、`directImpl` **0→0**、导出面 **零 diff**、`gate:pr` 32/32、lint 508/508；结构计数按预期上升且逐键归因（`leafValueEdges` 34→37 = 新增 `workspace|shared`/`catalog|shared`/`pipeline|shared` 三条**指向共享层**的值边、属 I2① 白名单；`fileValueEdges` 134→141、`crossModuleRefs` 154→164），**quality 段逐字节不变**。**两条各被独立复现两次的硬规则**：① **共享层转出必须经门面**——`constants.ts` 被直引会被判 `directImpl`/`implToOtherImpl`（W3 的 E0 与 W3b 的第一版各中一次）；② **共享层只出不进**——`src/shared/constants.ts` 反向引域会被判新增 `crossDomainValueEdges shared|workspace` + 环。**主控派单口径订正**：本刀我写「四组数字不变」是错的——`leafValueEdges` 物理上必涨（消费方改从共享层取常量）；实施方如实指出并逐键归因，未凑数。

46. **W5 已落地（`f1ad4f8`，主控独立复核通过）**：pipeline 域装端口（`PipelineDeps = {workspace: WorkspacePort}`，WorkspacePort 只列 `parseFullServerName`/`bareServerName`——`fullServerName` 本域从不引用、`MIDDLEWARE_GLOBAL_ROOT` 已在 W3b 迁共享层，故**不为它们开口**）+ 新增 `src/pipeline/impl/service/index.ts` 持有者 + 入口字面量 `installPipeline({ workspace: workspaceApi })`。**实测（主控复跑）**：I2① **26→25**（消失 `pipeline|workspace`）、叶子环 **0→0**、文件环 **0→0**、`directImpl` **0→0**、导出面 **零 diff**、`gate:pr` 32/32、lint 508/508；基线 quality 段**只有 1 条变化**（`pipeline|workspace` 消失），结构计数逐键归因（+1 文件；`leafValueEdges` 37→36；`fileValueEdges` 141→142；`crossModuleRefs` 164 不变 = −1 旧边 +1 入口 import）。**G12 再被复现一次**（W5 反例 4）：`installPipeline` 加 `async` → 注入面输出整段消失、连「async + 传变量」的必红形态也 PASS。W5 还订正了 `pipeline/deps.ts`/`interface.ts` 两处失效陈述（`fullServerName` 是上游 #822 清的未用 import，不是 W1；旧注释把账记错了对象）。

47. **W6（`d2d016e`）与 W7（`928e88b`）已落地，主控均独立复核通过**：
    - **W6 = inject 端口接线**（新建 `inject/deps.ts` + `inject/impl/service/index.ts`）：I2① **25→21**（消失 `inject|catalog`、`inject|connection/runtime`、`inject|pipeline`、`inject|workspace`），两类环 0/0、`directImpl` 0、导出面零 diff、`gate:pr` 32/32、lint 508/508。**W3b 的红利**：`LIST_DEFAULT_TOOLS_PER_SERVER` 与 `MIDDLEWARE_GLOBAL_ROOT` 已不在 Pick 里（改经共享层门面直取）。
    - **W7 = connection/orchestrator 端口接线**（新建 `orchestrator/deps.ts` 七个 Port + `impl/service/index.ts`）：I2① **21→14**（消失 orchestrator 的 7 条出边，主控实测改前正好 7 条），两类环 0/0、`directImpl` 0、导出面零 diff、`gate:pr` 32/32。**mutate 覆盖面实测 = 未覆盖 0 个**（`connection/orchestrator/**/*.ts` 落在 `manager` 段的 mutate glob 内，故本刀**无需**动 `mutation-topology.json`）——**这与 D.3·23 对 `connection/runtime/deps.ts` 的判断相反**，W8 必须自己先实测（见 D.3·41）。
    - 两刀都再次复现 **G12**：给 `installXxx` 加 `async` 会让注入面对账整段静默消失，且会**连同「多接一个键」这种必红形态一起放行** —— 至此「install 签名不得带 `async`」已是 W4/W5/W6/W7 **四次独立复现**的硬约束。
    - 累计（W1→W7 + W3b）：I2① **33 → 14**、叶子环 **4 → 0**、文件环 **4 → 0**、`directImpl` **1 → 0**；公开导出面始终**零 diff**。

48. **W8 已落地（`f0e4535`，主控独立复核通过）——本会话第一次改动「度量面机制」，已逐行审毕**：connection/runtime 装端口（新建 `runtime/deps.ts` + `impl/service/index.ts`，3 个 Port）。**实测**：I2① **14→11**（消失 `connection/runtime|catalog`/`|pipeline`/`|workspace`）、两类环 **0→0**、`directImpl` 0、`uncoveredSrcFiles` **0→0**、导出面零 diff、`gate:pr` 32/32、lint 508/508；基线质量段只删 3 条、结构计数逐键归因；TDZ 复核通过（无模块求值期读 deps）。
    - **本刀发现并处置了一处我们没预见的面**：`connection/runtime` 子层的 mutate glob **全是显式文件**（middleware/limits/supervisor/reconnect/transport/protocol），故不仅 `deps.ts`（D.3·23 已预见）**连新建的 `impl/service/index.ts` 也不在任何段内**（实测两处同时判红）。处置**只加面、不放宽**：① `deps.ts` → `coverageExcludes` 加 `!.../connection/runtime/deps.ts`（`kind: type-only`，照 B0 先例）；② holder **含真实运行时代码、不能按 type-only 排除** → 把 `connection/runtime/impl/**/*.ts` 精确追加进 `middleware` 段 mutate；③ 连带同笔：mcp `coverageExcludes` 2→3、总数 14→15（`mutation-topology-coverage.test.ts` 的计数断言**加严而非放宽**，附解释）、`gen-stryker-conf` 重生成 6 份 mcp 段 conf。反例 5 证明**两条登记都承重**（各自删掉即判红）。
    - **⚠️ 由此产生的一条 CI 风险（须写进 PR 描述）**：5 个端口持有者（catalog/pipeline/inject/orchestrator/runtime 的 `impl/service/index.ts`）的**装配错误分支无仓内测试覆盖**（只有主控侧探针），而它们现在**已进入变异面** → CI 的 `middleware` 切片**变异杀灭分可能下降**。本地任何档都不跑变异，只能在 PR 的 CI 上看到；处置选项（补 5 个持有者的最小单测 / 或观察 CI）留待维护者裁决，**不得**为了方便把含运行时代码的文件按 type-only 排除（那是放宽）。
    - **可推广的规则（D.3·41）**：新建 `impl/**` 文件时，**先实测它落在哪个 mutate 段**——子层的 glob 若是「显式文件枚举」而不是 `**` 通配，就必须同笔登记，否则 `uncoveredSrcFiles` 判红；登记时**含运行时代码的走 mutate 面、纯类型面才走 `type-only` 排除**。

49. **W9（`e252851`）与 W10（`ef9ee53`）已落地，主控均独立复核通过 —— B2a-wire 到此收口**：
    - **W9 = api 端口接线**（新建 `api/deps.ts` + `impl/service/index.ts`）：I2① **11→9**（消失 `api|config/model`/`api|workspace`），两类环 0/0、`directImpl` 0、`uncoveredSrcFiles` 0、导出面零 diff、`gate:pr` 32/32。**未碰 `manager` 能力面**（G19/D.3·37），并用 liveness 探针证明 `uncoveredSrcFiles` 判据非空转。**D.3·37 已被实测坐实**：api 只开 `{workspace, configModel}`，不许为 `manager` 开 Port。
    - **W10 = connection 门面对 runtime 的 26 符号值透传收口**：删掉 `connection/interface.ts` 的整块值透传（终态只剩 `McpManager` 与 `ReconnectPolicy` 两条类型出口），消费者全部改指 `connection/runtime/interface.ts`。**实测**：I2① **9→7**、环 0/0、`directImpl` 0、**导出面零 diff（坐实了「再导出来源路径不进快照判据」，本刀零重冻结）**、`gate:pr` 32/32。
    - **W10 的一处偏离与主控裁决（接受 7、不追 8）**：`bootstrap/apply.ts` 的 `DEFAULT_RESULT_TRUNCATE_BYTES` 改从 **`server/shared/interface.ts`** 取（该常量的物理单源）。若路由经 `connection/runtime/interface.ts`，会把 `bootstrap|connection` **重签名**为 `bootstrap|connection/runtime` —— 判「新增未登记证据」且拒写基线，**且不是 G21 假新增**（改前基线确有前者、没有后者），登记豁免又被纪律禁止。**裁决依据**：§3.6/I2① 明确「指向共享层的值边是允许的出口」，从常量的物理定义处取数更正确；「8 条残余」原为**预测**，实测 **7 条且全是 `bootstrap|*`**，B2b 的前提「残余边**被删除**而非重签名」因此更干净。
    - **B2a-wire 最终账面**（主控逐刀复核）：I2① **33 → 7**、叶子环 **4 → 0**、文件环 **4 → 0**、`directImpl` **1 → 0**、`uncoveredSrcFiles` 0；**公开导出面自始至终零 diff**；每刀 `gate:pr` 32/32、`lint` 508/508（余量 0）。六个域端口（catalog/pipeline/inject/orchestrator/runtime/api）全部落地，并在入口以**字面量**装配（G20）。

50. **W11（B2b）方案已由只读 agent 产出，主控拍板为三段执行**：
    - **关键实测（方案给出，决定了不必强求一笔原子）**：残余 7 条值边**只由 `src/bootstrap/{apply,apply-config,apply-runtime}.ts` 承载**（`apply-services.ts` 只有类型 import、`apply-guidance.ts` 无 import）；**bootstrap 一解体，7 条整体消失（改善）**。此后 10 类质量证据**全空** → 任何**纯重命名零位移**。
    - **拍板 ①：三段切法**。**W11a** = `bootstrap` 并入入口 + 路径切换 + 启用 `upgrade`（I2① 7→0）；**W11b** = 8 域加 `server/` 前缀 + `store` 提取（自 `config/store/`）+ `types`/`integration` 解体 + 14 处仓库根 `shared/*.js` 相对深度改写 + `plugins-manifest` + mutate 段重画；**W11c（块层重排）不在本轮**。依据：7 条是**删除**不是重签名；唯一耦合是「**先搬域后解体 bootstrap**」会重签名 → 故 bootstrap 必须先解体（或同笔）。
    - **拍板 ②：`sdk` 不建空骨架**（实测无目录、无 `installSdk`）；`provideMcpManagerService` 随 `apply` 落 `src/index.ts`，`server/sdk` 留 D4/G19 那一笔。
    - **拍板 ③：静态端口留模块求值期（D.3·30④），`assemble` 只驱动 `upgrade` 的生命周期**——把静态 `installXxx` 移进 `apply` 会撞持有者的「重复装配抛错」。
    - **拍板 ④：本轮不发 release notes**（版本号与发版归维护者），只在文档登记这处刻意省略。
    - **方案点名的三条最危险**：① `installUpgrade` 的 `storePath` 必须传**显式值**而非解析后的生效路径（生效路径会让 `takenOver` 恒真 → 迁移整段跳过、刻度推进 → **静默丢用户配置**）；② bootstrap 若「按域落位」而非并入入口，`bootstrap|api` 会重签名为 `server/*|server/*` → 新增未登记证据且拒写（G16 同族，**非 G21 假新增**）；③ 仓库根 `shared/*.js` 的相对深度必须同笔改对（14 文件），错则 `lib/**/*.d.ts` 出 TS2307 被 `skipLibCheck` 静默降级（G15，**既有闸全看不见**）——这是本方案唯一无法只读预验的面。
    - **方案新发现的连带必改**：`scripts/data/plugins-manifest.json`（4 条 module 指向 `src/config/model/config-schema.ts`，`config-matrix-gate.ts:268` 会 `req()` 它）、`test/integration/service-contract.test.ts:224` 与 `scripts/test/lint-toolchain.test.ts:190` 的硬编码 bootstrap 路径。
    - **已知代价**：入口并进 6 文件 690 行后约 **1005 行**（`src/` 顶层只允许四项 → 这是该约束的直接后果）；拆分的前置是各落点域端口化，留 W11c 或后续。

### D.3 未完成与遗留（含状态订正）

1. **B1 全部切片已完成**（B1.0–B1.5b，见 D.2·19–26）。**B1 收尾已完成**：主控实跑 `gate:pr` = **32 项逐条 exit=0 + PASS**（清单与上一轮逐项一致）、`THIRD-PARTY-LICENSES` 相对 `origin/main` **零改动**、依赖面零新增、44 笔。**未推送**（理由见 D.3·17）。**B2.1 已完成**（`0fb3bab`：零位移、零台账、`gate:pr` 32 条全绿）。**B2.2 已完成**（`8628110`）。**B2.3 已完成**（`6bf9457`，含建 `deps.ts` 后模板订正口径的首次落地）。**B2.4（`catalog` 域）进行中**。切法与验收见 D.4。**两条显式收窄 + 一条落点裁量**见 §十二 表后（不建 10 个空域骨架；B1.4 不路由既有装配；机制落 `server/shared/` 而非入口）。**接线顺序**：`upgrade` 的启用必须与「读者改读新布局」同一笔（B2），否则归档旧文件而旧读者读空 = 静默丢配置（见 §十二 表后）。
2. **B1.5b 已完成**（`dto.ts` / `service.ts` 类型面 + 仓库根 `shared/mcp-manager-service.d.ts` 退回包内 + 跨端 DTO 一致性锁；两处登记面 `--min` / stryker 测试面**无位移**，理由见提交正文）。**B1.5a 已完成**（`a9e897c`：状态键 / 帧名 / 路由路径三族进 `src/shared` 单点 + 永久跨端一致性锁）。**B1.4 已完成**（`b032294`：组合根机制 + `host-faces.ts` + `declare module` 迁入 + 9 条真实 Context 探针；机制落点裁量见 §十二 表后 ③，主控裁定与 I5 准入记录见 ④）。**B1.3 已完成**（`4bd6af6`，不接线）；**B1.2 已完成**（`dfd6577`）；**B1.0 已完成**（`4f94f65`，附录 G·G1），其遗留的两条 id 不一致见 **G1b**（登记不修）；I9 判据只覆盖顶层 `let/var` 的缺口见 **G11**。
3. **⑩ 已完结**（随 B1.1，`f21d44d`）：迁移与其连带面（6 条 mutation exclude pattern 平移 + 6 份段 conf 重生成）同笔完成。
4. **基线写入纪律（附录 G·G5，必须遵守）**：`--write-baseline` **必须在 build 之后的树上跑**——`lib/**` 的证据 id 会随 `lib/foo.d.ts` 在不在而变（只有 `src/index.ts` 做了归一），而 CI 是「先 build 再 contract」，两者错位就换号判红。
5. **已知放宽路径（登记，不修）**：R16 的三条同族路径（删键 / 删**整包**条目 / **瞬态台账**，见 §十三 R16 与附录 G·G2–G4）；豁免 `reviewBy` 无执法力、可静默删除转长期（G6）。
6. **判据面与宪法正文的文字差待订正**（G9）：I2④ 正文（doc:124）未写「值」而实现判值面；I8① 正文（doc:165）只列两面而实现含 `src/client/**`（§8.1 与脚本头写全三面）。
7. **「有文字无判据」清单**（G10，明细见附录 G）：I1 / I2③后半 / I2② 终态 / I3 / I4② / I5 / I6 / I7 **全靠人工**。其中最突出的是 **I2③ 后半「死声明 = 0」：只算不判、连默认输出都没有**。
8. **仓库根 `shared/` 两处过期注释**：① `shared/placement-math.d.ts:2`（「各包 `src/placement-math.ts` 薄 facade」——provider-usage 与本包都已在 `src/shared/`）：既存、非本次弄脏；② ~~`shared/mcp-manager-service.d.ts:4`~~：**B1.5b 已随「退回包内」整文件删除**（类型定义住 `src/shared/service.ts`，过时注释随之消失）。
9. **发版号依赖（待维护者知悉）**：`upgrade` 的步骤表是 `0.0.0 → 0.2.5`。接线（B2）后若 `package.json` 仍是 0.2.4，对账会报「步骤表与 `package.json` 不同步」——这是 §7.4 #5 的**设计内落差信号**（只 warn 不中止）。**代理不改版本号**：发版时若不是 0.2.5，须同步该步骤表。
10. **lint warning 余量**：**670 / 预算 671，余量 1**（不许抬 `gauntlet.config.json`）。
11. **测试面（B3 主体）未动**：16 个测试文件 / 14635 行尚未按域搬迁；`@ts-nocheck` 未清零。
12. **红线状态（两条均已获授权）**：① `ci.yml` 数据面 glob 已落地（`f8ee6c5`）；② 公共 API 行为变更已于 2026-09-14 获维护者授权。**本轮不新增任何第三方依赖**。`approved` / `api-approved` 按仓规**只能由维护者本人打**，代理不代打。
13. **B2 复查项（准入面）**：`server/shared/compose.ts` 今天**只有组合根一个消费者**，与 I5 的「单一消费者留包内」不符（接受理由与复查要求见 §十二 表后 ④）。B2 重冻结入口导出面后，机制要么回到入口、要么证明 ≥2 消费者。**同类第二例**（B1.5a 自报）：`src/shared/routes.ts` 的 `ROUTE_FENCE` 今天也只有 `api` 一个消费者（跨端判据只覆盖 11 条路径）。**建议 B3 做一次合并的共享层准入核对**（把 `server/shared` 与 `src/shared` 的每一条导出对一遍 I5 门槛），而不是逐例记账。**同类第三例**（B1.5b 自报）：`McpServerListEntry` 今天只有客户端一侧消费者。三例合起来说明这是**系统性**的面放宽——逐例记账会掩盖它。
14. **PR-1（B0）尚未开**：分支领先 `origin/main` **36 笔**、工作区干净、**未推送**——该分支 upstream 指向 `origin/main`，**裸 `git push` 会打到 main**，要推必须 `git push -u origin task/767-arch-v4`。**PR-1 的切分点 = B0 末笔 `aa02843`**，其后的 `f21d44d` 起属 PR-2（B1–B3）。**维护者已授权「继续实施，最后推」**：B1 收尾时用 `git push -u origin task/767-arch-v4`（裸 `git push` 会打到 main，禁止）。

15. **宿主状态机字面量未收口（B1.5a 的刻意残留）**：`supervisor.ts` / `middleware.ts` 里约 20 处状态机字面量仍是字面量（单端内部状态，不是跨端契约面），且 `src/types/status.ts` 的 `state: string` 未收紧成 `ServerState`——收紧属**公开类型变更**，与「机械抽取、值/ABI 不变」冲突。若要做「宿主六态字面量清零」，须单独立项（会牵动热路径与类型契约）。
16. **跨包帧名存在第三处物理定义**：仓库根 `shared/sse-hub.js:45` 的 `PING_FRAME`（本包禁改面）。本包 `SSE_FRAMES.ping` 与它值相同，但**跨包漂移无判据**（见附录 G·G14）。

17. **推送 / PR 待维护者决定（事实已查明）**：`.github/workflows/ci.yml` 只在 `pull_request`（与 push 到 `main`）触发 → **推一个特性分支不产生任何 CI 信号**。而**变异与覆盖率只在 CI 上跑**（本地任何档都不跑），是至今**唯一未被验证**的面。故：只推分支 = 零收益；要拿信号必须**开 PR**（方案原定 PR-1 = B0 切点 `aa02843`、PR-2 = B1–B3）。主控建议开 PR-1 + PR-2，但**开 PR 属维护者流程，代理不代开**。
18. **B2 的编排已按实测修正**（见 §十二 表后 ⑤ 与附录 G·G16）：域搬迁**分两段**——B2a 就地重构（模块 id 不变、零证据位移）、B2b 一笔原子变更（加 `server/` 前缀 + 路径切换 + 启用 `upgrade` + 导出面重冻结）。

19. **`workspace` 欠一份 `deps.ts`**（B2.2 自报，实测运行时非零消费 `middlewareMode`/`projectServersFor`）：与「本域改成 `install(deps)`」同笔落地（见 D.2·34）。**B2 后续各刀注意**：不要再拿「sha 相同」当验收（见 D.2·33 的模板订正）。

20. **改模块 id 的搬迁一律留 B2b（新识别的边界）**：B2a 只能**就地**重构。反例：把 `config/store/` 提取成独立 `store` 域会改模块 id → 若该模块有 incident 的质量证据（值边/环）就会判红且拒写。**判据**：一个搬迁安全 ⟺ 它**不改变任何带 incident 质量证据的模块 id**；删除模块（如 `types`/`bootstrap` 解体）只会让证据**消失**（=改善，可接受）。**B2b 清单**：11 域加 `server/` 前缀 + `store` 提取 + `types`/`bootstrap` 解体 + 路径切换 + 启用 `upgrade` + 导出面重冻结 + mutate 段重画（含清 0 命中字面量）+ release notes。

21. **B2 实为三段（B2.4 早期拦截暴露的划分问题）**：**(a) B2a-structure** 就地重构（域外不动，已做 stats/workspace/pipeline）→ **(b) B2a-wire** 给消费方建 `deps.ts` 端口、把值 import 改类型面 + 组合根注入（**这一步必须动域外消费者，是消值边/破环的唯一途径**）→ **(c) B2b** 原子搬迁（`server/` 前缀 + `store` 提取 + `types`/`bootstrap` 解体 + 路径切换 + 启用 `upgrade` + 导出面重冻结 + mutate 段重画 + release notes）。**为什么必须分**：破环要改域外，而 B2a 禁改域外；且环成员文件不动，其搬迁只能等破环之后。
   - **前提纠正（只读 scout 实测，主控原先写错）**：主控曾写「B2b 前值边与环收到 **0**」——**B2a-wire 内不可能**：33 条里有 **8 条是 `bootstrap|*`**，而 `bootstrap/` 含 `interface.ts` 故是叶子模块（它**就是组合根本体**）；这 8 条只有在文件落到 `src/` 根（`moduleOf 返回 null`）时才整体消失，即 B2b 删除 `bootstrap/` 那一笔。**B2a-wire 的真实终点是 33 → 8**。**正确的 B2b 前提**：残余边与环必须在**同一笔里被删除而非重签名**——`bootstrap` 解体使这 8 条整体消失（消失记为 improvements，verify-dir-imports.mjs:1149-1150，不判红、不需台账），故**搬迁那一笔仍然零放宽**。
22. **环成员文件不能动（B2.4 实测的新边界）**：`catalog/search.ts` 是 baseline `fileCycles` 里一条环的成员（环经 `connection/runtime/middleware.ts → catalog/interface.ts`、`catalog/search.ts → connection/interface.ts`），把它挪进 `impl/search/` 会让环签名由旧变新 → **新增未登记证据、`--write-baseline` 拒写**（与 G16 同族，作用在 `fileCycles` 而非 `crossDomainValueEdges`）。**受影响域**：由 4 条模块级环 + 4 条文件级环的成员看，**`catalog` / `config/model` / `connection(**)` 都只能部分重构**——它们的完整目标形态等 B2a-wire 破环之后。**处置口径**：与 G16 一致——**不制造位移**，把该文件留原位并在门面头注释写明原因，搬迁并入 B2b。

23. **W7/W8 的准入条件（scout 实测）**：`src/connection/deps.ts` 与 `src/connection/runtime/deps.ts` **不在任何 mutate glob 内**（UNCOVERED）——新增它们会立刻让 `uncoveredSrcFiles` 判红。故这两刀**必须同笔**把路径加进 `mutation-topology.json`（放进某段 mutate，或按 `src/server/*/deps.ts` 先例加 type-only 排除）。其余 `deps.ts` 路径（api/inject/config-model/workspace/orchestrator、`server/**`）实测均已覆盖。

24. **压缩时刻的状态快照**：B0 ✓ / B1 全部 ✓（含 B1.0 判据加固）/ B2a-structure 四刀 ✓（stats、workspace、pipeline、catalog）/ **B2a-wire W1+W2 在飞未提交**（D.2·40）/ B2b 未开始。**未推送**（`ci.yml` 只在 `pull_request` 触发 → 推分支零信号；变异与覆盖率至今 **0 次**验证，见 D.3·17）。**盲区台账 21 条**（G1–G20 + G1b），全部带 `文件:行` 或实测判词。**维护者已选路径 B**（D.2·38）。

25. **基线卫生：消失证据必须同笔清理（新识别，登记为 G22）**：`--write-baseline` 只在有人显式跑时才清「已消失证据」，而 CI 只跑 plain check（G2）——于是**未清理的陈旧证据会静默放宽判据**：该 id 仍留在基线里，将来回归时既不判「新增未登记证据」也不判「降级」。**纪律**：每一刀动到质量证据（新增/消失/降级）都必须**同笔**跑**全量** `--write-baseline`（G13 禁 `--package`；G5 要求先 build）并把基线 diff 逐字审过。W1（`770859b`）即如此：清理 4 条、结构计数 3 项下降、其余 5 包零改动。
26. **W1 的验收与派单补充**（数字见 D.2·41）：主控在 W1-only 树上独立复跑 `build 0 / typecheck 0 / test 0（23 文件 1222 用例）/ lint 0（warning 665，预算 671）/ verify-dir-imports 0 / export-surface-snapshot 0 / gen-stryker-conf --check 0`，且与实施方报告的 diff sha 逐字节一致。**后续每刀（W3–W10）派出时必带 G21 判据**：唯一红若是 `leafModuleCycles`/`fileCycles`，且报出的节点集合是改前基线某条环的**真子集**、且该环**每条边**在改前基线里都存在 → 判为假新增，**停下报告**并在同一笔或紧随的笔里一起消掉父环；只要有一条边在改前基线里不存在，就是真纠缠，须改代码。

27. **HB2 精确化裁决（主控，本轮）**：D.2·37 原话「不为 `connection` 自己的子层（orchestrator/runtime）造端口」**范围过宽**，与 D.2·39 列出的 W7/W8 直接冲突。**裁决**：HB2 禁的是**为「`connection` 门面 → 它的两个子层」的透传复导边**（`connection/interface.ts` 对 `connection/runtime/interface.ts` 的 26 符号透传、以及对 `orchestrator/tool-names.ts` 的 `stripMcpPrefix`）**造端口**——那是**同域**边，B2b 坍缩后自动消失；而 `connection/orchestrator` 与 `connection/runtime` 的**对外跨域出边**（7 条 + 3 条）**必须**由 W7/W8 的 `deps.ts` 承接。**判据**：B2b 的前提是「残余边**被删除**而非**重签名**」（D.2·38），若这些边留到 B2b，搬迁会把 `connection/orchestrator|pipeline` 变成 `server/connection|pipeline` → 判「新增未登记证据」+ 拒写；故**除 8 条 `bootstrap|*` 外，所有跨域值边都必须在 B2b 之前归零**。
28. **W4 的合并范围已定（主控，本轮）**：**W4 = catalog 端口接线 + W2（删 `connection/interface.ts` 的 `stripMcpPrefix` 值复导，消唯一 `directImpl`）+ `connection/orchestrator/manager.ts:52` 改引 `./tool-names.ts`（断 F2）**，一笔落地。**为什么必须合并**：W2 单独落会让三色 DFS 换序、把改前就存在的子环 `catalog|connection|connection/runtime` 首次报出（G21 假新增、`--write-baseline` 拒写）；把 catalog 的 `ConnectionPort` 一起接上后 `catalog|connection` 消失，该子环整条不存在，基线才可写。**验收目标**：叶子环 **0**、文件环 **0**、域间值边降到接完端口后的实测值（计划记 26，以实测为准）。**两条已知未知**：① W4 自己的删边也可能让另一个被遮蔽的子环首次现身（G21 的副作用面）——若发生，按 G21 判据判定，真纠缠就继续接端口（例如 W8 的 `connection/runtime|catalog`）直到两类环归零；② scout 提示的未验证风险：`connection/runtime` 从 `pipeline` 取的 `msgOf`/`createRedactor` 在运行时被当**回调**注入（`projectCallToolResult` 的 `errorText` 闭包），端口化后的初始化顺序（TDZ）须在 W8 内实测。
29. **W3 已按 scout 实测收窄并派出（主控，本轮）**：只迁 **4 个常量**（`DEFAULT_ANNOUNCE_CATALOG` / `DEFAULT_CATALOG_MAX_ENTRIES` / `DEFAULT_RESULT_TRUNCATE_BYTES` / `DEFAULT_TOOL_CALL_TIMEOUT_MS`）到 `src/server/shared/constants.ts`（**零 import 的纯字面量**；`isSharedLayerModule:561-568` 已含 `server/shared/**`，指向它的值边被 I2① 豁免）；`connection/interface.ts` 与 `catalog/interface.ts` **继续 re-export** 这 4 个（保 `src/index.ts` 导出面零 diff）；**不动 `bootstrap/**` 的消费点**（`bootstrap|connection` 这条边只剩 `DEFAULT_RESULT_TRUNCATE_BYTES` 一个符号，动了会多消一条边、偏离计划；它归 B2b 解体那一笔整体消失）。**不迁** `MIDDLEWARE_GLOBAL_ROOT`/`SCOPE_PROJECT`/`SCOPE_GLOBAL`/`LIST_DEFAULT_TOOLS_PER_SERVER`，理由见 D.2·42 ③。**期望终点**：叶子环 3→2、文件环 2→2、域间值边 32→30。
30. **W4–W9 的统一装配落点已定（主控裁定，本轮）**：`installXxx(deps)` 的**字面对象实参调用点必须写在 `src/index.ts`**（G20），但入口今天是**再导出门面**（`apply` 转发自 `bootstrap/interface.ts`）。**裁定：静态端口的装配写在 `src/index.ts` 的顶层**（模块求值期），证据与理由：① `analyzeInjectionFaces`（`verify-dir-imports.mjs:333-377`）是**纯文本扫描**——在入口文本里找 `installXxx(`、要求紧跟**可解析的对象字面量**、键集与 `deps.ts` 的 `export interface XxxDeps` 字段集**严格相等**；函数声明须落在某个 `interface.ts` 且签名为 `export function installXxx(`（**不能带 `async`**，见 G12）。② 这些 Port 全是**静态模块引用**（`import * as catalogApi from "./catalog/interface.ts"`），不需要 `ctx` 或配置，故入口**模块求值期**装配顺序安全（`import` 先于本模块语句求值）。③ **测试面实测支持该落点**：13 个 `test/unit/**` 与 e2e 全部经 `await import("../../src/index.ts")` 或裸包名（→ `lib/index.js`）加载入口，`test/**` 内**没有任何**直接 import 域模块的语句（实测 `src/{catalog,pipeline,inject,api,connection,workspace,stats,config}` 从测试侧导入数 = **0**），故模块求值期装配自动覆盖全部用例，**不需要改任何测试**。④ **例外**：`installUpgrade` 是 **async 且需要配置**（`storePath`/`statsFile`），它留在 `apply` 流程内、由 B2b 并入入口的有序装配序列；本裁定只覆盖**纯静态端口**的域（W4–W9）。⑤ **不要**把 `apply` 从再导出改成入口本地函数——那会改 `lib/index.d.ts` 的声明块形态，`export-surface-snapshot` 有判红风险（B1.4 的落点裁量已记过同款约束）。⑥ 端口持有者用 `upgrade` 域的 `upgradeRunner` 同款形态（`const` 对象 + `install/release`），**未装配即访问要明确抛错**（fail-closed），不要静默回落默认值。

31. **判据机制的携带分歧（主控审计，登记为 G23）**：合并后我们比上游多 4 个质量证据类与一条「**类级首登直写**」通道。该通道**是承重结构**：把一个新证据类并入既有包时，`quality` 段在、单个键缺——上游的包级台账门覆盖不到这条路径；若按「逐条过台账」处理，等于要给 mcp 的 33 条 I2① 存量逐条开豁免（B0 注释判定为「把存量登记误当放宽通道」）。**它同时是一个窄洞**：手工从基线里删掉某一个证据键 → 跑 `--write-baseline` → 该类当前证据被无条件写入（同族于 R16/G3 的「删条目洗白」，护栏仍是**人工 diff 审阅**）。**处置：保留**（已在输出里逐条点名「须在 PR 内确认」、且只在键缺失那一次生效），并记录：这条分歧随本分支合入 main 后会成为 main 的行为，维护者可决定是否上收。
32. **lint 预算余量归零（新硬约束）**：上游 #822 把 `lint.maxWarnings` 从 671 降到 **508**，而合并后我们实测就是 **508/508**（顶格、余量 0；合并期间一度 509，多出的唯一一条是本项目 B0 新增测试文件的 `// @ts-nocheck`，已**真修**——摘 pragma + 补 9 处类型标注，`tsc -p scripts/tsconfig.json` 0 error、13/13 用例仍绿）。**含义**：W4–W11 期间**任何**新增/改动文件都不许多出哪怕 1 条 warning；不许抬 `gauntlet.config.json`、不许 `eslint-disable`。每刀派单必须写明这条。**补（W11a 实测）**：`commitlint` 的 `body-max-line-length` 是 **100 字符**——提交信息**正文单行不得超过 100 字符**（W11a 第一版被拒，原因是几行拉丁路径超长）；每刀派单必须写明这条。

35. **W3b 裁决（主控，评审 A 建议 + 主控实测修正）**：在 **W4 之后、W5 之前**插入一刀，把「值常量被 ≥2 域消费」（§3.6 规则 6）的四条收口——但**落点按跨端性分开**：① `SCOPE_GLOBAL` / `SCOPE_PROJECT` / `MIDDLEWARE_GLOBAL_ROOT` → **`src/shared/`（跨端层）**，不是 `server/shared`。**主控实测依据**：客户端把这两个契约**以字面量重复实现**（`src/client/core/api.ts:18` 用 `"global"` 比较、并拼接 `"@@global/"` + 名字，即 `SCOPE_GLOBAL` 与 `"@" + MIDDLEWARE_GLOBAL_ROOT + "/"` 各写一份、无判据）——同族于 G14 的跨包字面量重复。评审 A 只按宿主消费域判（6 unit / 7 文件），漏了跨端这一面。② `LIST_DEFAULT_TOOLS_PER_SERVER`（纯宿主，catalog + inject 2 域）→ **`src/server/shared/constants.ts`**。③ 同笔收窄 `catalog/deps.ts` 的 `ConnectionPort`/`WorkspacePort` 与 `pipeline/deps.ts` 的 `WorkspacePort`（把已迁走的成员摘掉）；各域门面**继续 re-export** 以保导出面零 diff。④ **本刀只迁宿主侧**：客户端那两行字面量**先不改**（N1 明确本轮不重构客户端），登记为 #769 项——这样 `src/shared/` 成为唯一物理定义，客户端将来改引零成本。
36. **入口导出面 159 → ≤5（红线，待维护者裁决）**：评审 A 实测 `src/index.ts` 的 159 项里**只有 5 项**是宿主/ABI 契约必需（`name`/`inject`/`apply`/`Config` + `McpManagerService`，后者有 `scripts/lib/dts-cordis-merge-lib.ts:26-29` 的声明合并可达性判据背书）；**106 项零消费者**、48 项仅被本包测试引用 → **154 项可删可移**。它还把 8 个内部类（`McpManager` 单块 3213 字符 / 78 个成员）连同 **28 个 `private` 成员名**冻进 `scripts/data/dsh-mcp-manager-export-surface.json`（主入口 `blocks` 139 键 / 21231 字符）。**收益**：删掉这 8 个类的转出后，此后任何域内重构都不再触发 `export-surface-snapshot` diff。**代价**：破坏性公开 API 变更（须 release notes + 版本策略），且 48 项仅测试引用的导出要与 I8① 的 13 条清零同批。**主控未自行开工**（红线），建议单开 issue 与 #769、I8① 清零并排。
37. **`api/deps.ts` 的真实前置（评审 A 实测，订正 §3.5 示意表）**：§3.5 给 api 的 `ConnectionPort` **今天物理上开不出来**——`connection/interface.ts` 一个 manager 能力都没导出，api 与 connection 的耦合全在 `manager: RoutesManager` 的**结构参数类型**（22 成员、无 import 边，G19）；§3.5 表里那 30 个成员名在门面 grep **命中 0**。**故 W9 = `{ workspace, configModel }` 两份 Port（与只读 scout 结论一致），真实前置是 W10 把 22 个 `manager.*` 命名成能力对象**。§3.5 的表要标注为**示意**。
38. **I7「`paths.ts` 是文件名唯一出处」实测为假（评审 A + 主控复核）**：`config/store/store.ts:18`（`"dsh-mcp.json"`）、`stats/impl/collector.ts:23`（`"mcp-stats.json"`）、`catalog/impl/cache-view/index.ts:27`（`"dsh-mcp-catalog.json"`）各自硬编码 `dshHome() + 字面量`，与 `server/shared/paths.ts` 的旧路径表重复。归「合并前 follow-up」（顺带让运行期写面改经 `paths.ts`，会把 `server/shared` 的 12 个「单消费者」变成 2 消费者，方向是让 I5 达标）。
39. **两处失效注释（评审 A 实测，主控复核）**：`catalog/deps.ts` 头「search 对 `bareServerName` 是死导入」与 `pipeline/deps.ts` 头「authorize 对 `fullServerName` 是死导入」——**两个文件已完全不 import 这两个符号**（W1 已删），注释陈述的是不存在的状态（I12 违规 + G10 无判据）。W4 已顺带订正 `catalog/interface.ts` 的同类断言；这两处待订正。
40. **两份只读评审的完整台账见附录 H**（暴露面 + 测试面，含三桶优先级与主控复核订正）。
33. **覆盖退化（新识别，交测试面评审）**：本项目 B1.5b 按准入规则 7 退役 `shared/mcp-manager-service.d.ts` 后，`verify-shared-fanin` 的**类型面分支在本仓已无实例**（实测类型面 0 个模块），#824 新增的那条断言由「验证类型面下限（≥1 包）」退化为「验证该模块缺席」。合并时已如实改写断言（未弱化、未删除），但**该分支的判据覆盖已成空白**。
34. **基点冻结与待吸收**：合并后 `HEAD..origin/main` = 1 笔（`191cddf` #832，删死掉的 `mutation-segments-lib.mjs` + 拆 `plugins-manifest-lib.ts`，只动 3 个非本包文件），按冻结策略**不吸收**，留最终推送/PR 前那一刀统一处理（届时须重跑一轮 `gate:pr`）。

### D.4 下一步顺序

**B0 ✓ / B1 全部 ✓ / B2a-structure ✓ / B2a-wire ✓（W1·W3·W3b·W4–W10）/ W11a ✓ / W11b1 ✓（`f9acc28`）/ W11b2a ✓（`56d01ac`）/ W11b2b ✓（`09c82a3`）——B2b 已收口，与 `origin/main` 的落后两笔已于 `abaefc9` 吸收（落后 0）。下一步只剩「终态评审 → `gate:full` → 推送」。** 下面的 1–4 条是 B1 的历史切法（已完成，保留供回溯），5 条起是当前序列：

1. ~~**B1.1 `src/shared/` 门面 + ⑩ 迁移**~~ **已完成（`f21d44d`）**；下面保留原始切法供回溯：建 `src/shared/` 与 `interface.ts`；`git mv src/placement-math.ts src/shared/`；改 4 处引用（`src/index.ts` / `src/config/model/config-schema.ts` / `src/client/core/state.ts` / `src/client/float/float.ts`，其中 client 两处改引 `src/shared/interface.ts`）；被移文件内仓库 `shared/placement-math.js` 的相对深度从 `../../../` 改 `../../../../`；mutation-topology 的 6 条 exclude pattern 平移到新路径 + 重生成 6 份段 conf。**验收**：`verify-dir-imports.mjs --package dsh-mcp-manager` 从 **exit 1 → exit 0**（这就是 ⑩ 在 B0 唯一的红）、`gen-stryker-conf.mjs --check` exit 0、`export-surface-snapshot` exit 0（导出面不变，纯位移）。
2. ~~**B1.2 `server/shared/` 落盘面**~~ **已完成（`dfd6577`）**；下面保留原始切法供回溯：`paths.ts` 单源（新路径 + `legacyFile` + 每文件 mode 表 + 插件自有目录 `0o700`）+ 自写 `file-io.ts`（唯一 tmp 名 → 显式 mode → `rename` → 失败清理；同路径 promise 队列；**不装进程级钩子**）+ 权限断言（7 个写点收敛到这一处）。
3. ~~**B1.3 `upgrade` 域**~~ **已完成（`4bd6af6`）**；下面保留原始切法供回溯：六件套一次建齐（步骤表 / 链驱动 / 刻度 / 失败语义 / 对账 / 装配标记）+ 迁移**五态**测试（含目录型旧路径逐文件搬、用户显式 `storePath`/`statsFile` 不动）+ 刻度「推进与失败不推进」。
4. ~~**B1.4 组合根机制**~~ **已完成（本刀）**；下面保留原始切法供回溯：`bindHost`/`assemble`/逆序释放/`declare module` 迁入 + `host-faces.ts`；探针证明 apply → install → release 各域标记复位。**11 域空骨架已裁掉**（各域随 B2 重写与其真实代码同笔生成，理由见 §十二 表后）；**既有装配本刀不路由**（B2 接通）。**落点裁量与实测证据**：机制落 `src/server/shared/compose.ts` + 门面（不是 `src/index.ts`）——入口加导出会让 `export-surface-snapshot` 判红，而入口的非导出函数测试不可达；B2 在入口调 `bindHost` → `assemble` → `safeDisposeAll`。
5. **B1.5 已完成**（B1.5a `a9e897c` / B1.5b `ea298b0`+`fd908b1`）；**B2a-structure 已完成四刀**（B2.1 `0fb3bab` / B2.2 `8628110` / B2.3 `6bf9457` / B2.4 `6ecf57b`）。原切法：`src/shared/` 另外五个文件（`status` / `frames` / `dto` / `routes` / `service`）：必须与**两端改引同笔**——只建文件不接两端就是死代码，覆盖率面与变异面会先红。
6. **当前序列（路径 B：先 wire、后搬迁）**：**W1 连接域同域收口 ✓（`770859b`）** ~~+ W2 删 `directImpl`~~（**并入 W4**，G21）→ W3 **共享常量（收窄为 4 个，见 D.3·29）**迁 `src/server/shared/constants.ts`（起点实测 3/2/32 → 期望 2/2/30）→ **W4 = catalog 端口接线 + W2 删 `connection/interface.ts` 复导 + `manager.ts:52` 改引 `./tool-names.ts`**（一笔；两类环归零 → 基线才可写；见 D.3·28） → W4 catalog 端口（**两类环归零**）→ W5 pipeline → W6 inject（新建 `inject/deps.ts`）→ W7 `connection/orchestrator/deps.ts` → W8 `connection/runtime/deps.ts` → W9 `api/deps.ts` → W10 connection 门面 26 符号值面收口 → **W11 = B2b 原子变更**。每刀的实测数字见 D.2·39；**W7/W8 必须先登记 mutate 路径**（D.3·23）；**所有 `installXxx(deps)` 的字面调用点必须在 `src/index.ts`**（附录 G·G20）。
7. **W11（B2b）的清单**：11 域加 `server/` 前缀 + `store` 提取（自 `config/store/`）+ `types`/`bootstrap`/`integration` 解体 + 路径切换（各域改读 `paths.*`）+ **启用 `upgrade`**（与读者改引同笔，见 §十二 接线顺序约束）+ 导出面重冻结 + **mutate 段重画（含清 0 命中字面量 G18、补 `server/*/deps.ts` 排除条）** + 命名能力对象覆盖（G19）+ release notes。
8. 每批完成后回写本附录的 D.2/D.3；每批验收含真实 `exit code` + 该批**全部登记文件**同步（§12 开头已写死）。

### D.5 新会话最该先做的三件事

1. 读本文件 §零（立场与 8 条决策）与 **§0.1（第二轮复核修订台账）**——那 15 条是 v5 与初稿的差别所在，别按初稿口径理解。
2. 抽查代码事实（不要全信文档）：`node scripts/gate/verify-dir-imports.mjs --package dsh-mcp-manager --graph`（**W1 后应 17 叶子 / 37 值边 / 3 模块级环 + 2 文件级环 / 32 域间值边**；W1 前为 38 值边 / 4+4 环，见 D.2·41）、`grep -rn '0o600' packages/dsh-mcp-manager/src`（应只有 `config/store/store.ts:66`）、`grep -c 'new McpManager' packages/dsh-mcp-manager/test/e2e/smoke.test.ts`（应为 9）、`ls scripts/data | grep dsh-mcp-manager`（现应有 `-export-surface.json` 与 `-export-faces.json` 两个基线文件）。
3. 记住仍未实测的面：**掩码往返**、**B1 的自写 IO 队列与并发语义**、**CI 上的变异**（本地任何档都不跑）——凡涉及它们，先跑探针再下结论（`atomically` 已撤回，不再是风险项；`pnpm gate:pr` 已两次实跑 exit 0，不再是未实测项）。
4. 本会话已复跑的实测结果（可直接引用，不必重跑）：`verify-dir-imports --graph` **exit 0**（**W1 前**：14 叶子 / 33 值边 / 4 模块级环 + 4 文件级环；W1 后见 D.2·41）、`grep -rn '0o600' packages/dsh-mcp-manager/src` 只有 `config/store/store.ts:66`、`grep -c 'new McpManager' test/e2e/smoke.test.ts` = 9、`scripts/data` 无 mcp 基线且 `export-surface-snapshot --package dsh-mcp-manager` **exit 2**（「基线不存在」）、`forbid-module-state-src` 在 worktree 跑 notifier **exit 0**（21 处豁免）。
5. 已完成的同步（勿重做）：§二 I9 与 §十二 B0④ 已写「扩 `forbid-module-state-src` 必须同笔登记 `panel.ts` 豁免」；附录 A 第 1 条已去 `fast-redact`、红线更新为两条且均已获授权。
6. **压缩时刻（2026-09-14）的现状与下一步**：B0 ✓、B1 全部 ✓、B2a-structure 四刀 ✓（`stats/workspace/pipeline/catalog` 已就地重构为 `interface.ts + deps.ts + impl/<块>/`）；**B2a-wire 的 W1+W2 在飞未提交**（子 agent `7e4faae1`，5 个未提交文件，见 D.2·40）；**维护者已选路径 B**（先 wire、后原子搬迁，D.2·38）；**W3–W10 的完整接线表与切割序列在 D.2·39**；**B2b 清单在 D.4·7**。**未推送**——`ci.yml` 只在 `pull_request` 触发，推分支零信号，变异与覆盖率至今 0 次验证（这是**唯一**未验证的面）。**两条纪律别忘**：`--write-baseline` 必须先 build（G5）；B2a 不得改模块 id（D.3·20/22）。

7. **W1 落地后的最新快照**：HEAD `770859b`（领先 `origin/main` **56 笔**）、工作区干净；B2a-wire **W1 ✓**、**W2 并入 W4**（G21，见 D.2·41）。实测现状：**17 叶子模块 / 37 值边 / 3 模块级环 + 2 文件级环 / 32 域间值边 / 1 条 `directImpl`**（后者要等 W4 那一笔）。**未推送**（推分支零 CI 信号，D.3·17）。**盲区台账 23 条**（G1–G22 + G1b）。

8. **合并后的最新快照**：HEAD 见 `git log`（两刀合并 `df0c08d` + `3ff9cc5`），`origin/main..HEAD` = **62 笔**、`HEAD..origin/main` = **1**（`191cddf` 留 PR 前那一刀）。主控独立复跑实测：**17 叶子模块 / 38 值边 / 2 模块级环 + 2 文件级环 / I2① 30 条 / 1 条 `directImpl` / `crossModuleRefs` 155**；`gate:pr` **32/32**、`lint` **508/508（余量 0）**、`verify-shared-fanin` 0、`threshold-monotonic` 0。**盲区台账 24 条**（G1–G23 + G1b）。基点已冻结，下一刀 = **W4**。

9. **压缩快照（B2a-wire 全部收口 + W11a 已完成）**：HEAD = `48a4866`，领先 `origin/main` **80 笔**、落后 **1** 笔（`191cddf`，冻结到推送前那一刀）；工作区干净。
    - **已完成**：B2a-wire 全部（W1 连接域同域收口 / W3 四个默认常量上移共享层 / W3b 跨端常量与端口 Pick 收窄 / W4 catalog / W5 pipeline / W6 inject / W7 orchestrator / W8 runtime / W9 api / W10 connection 门面 26 符号透传收口）+ **W11a**（`bootstrap` 六文件并入 `src/index.ts`、5 处硬编码路径切到 `paths.ts`、启用 `upgrade` 并新增「只读显式键」解析器 `explicitConfigPaths`）。
    - **当前账面**：I2① **0**、叶子环 **0**、文件环 **0**、`directImpl` **0**、`uncoveredSrcFiles` **0**、**公开导出面自始至终零 diff**；16 叶子模块 / 15 模块值边；每刀 `gate:pr` 32/32、`lint` 508/508（余量 0）。
    - **在飞（压缩时刻）**：**W11b1**（子 agent `5789a71c`）= 8 域迁 `src/server/` + `config/model`→`server/config` + `store` 提取 + 全仓引用与相对深度改写 + `plugins-manifest`；**压缩时刻工作区干净、它尚未写过任何文件**（`src/` 顶层仍是 14 项）。
    - **待办**：**W11b2**（`types`/`integration` 解体 + mutate 段重画 + 段 conf 重生成）→ **最终收尾**（评审 agent 对终态复核 → `gate:full` → 吸收 `191cddf` → 推送）。
10. **新会话第一步（W11b1 的接手口径）**：先 `git log`/`git status` 看它有没有提交。① **已提交** → 独立复核（`verify-dir-imports --package` 应为 0 且 **I2① 仍 0**、四组数字、`export-surface` 零 diff、全量 `--write-baseline` **只消不增**、`gate:pr` 32/32、`ls packages/dsh-mcp-manager/src` 只剩四项）；② **未提交但工作区有改动** → **先验收再提交，不要回退重做**（W11a 的 agent 也曾中断且干完了大半，主控接手验收后提交，做法见 `48a4866`）；③ **未提交且工作区干净** → 它没开始，可重派或自己接。**本刀的硬判据**：预期「10 类质量证据全空、只许消失」——**一旦出现「新增未登记证据 → 中止写入」就是重签名，停下报告**。本刀唯一既有闸看不见的面是**仓库根 `shared/*.js` 的相对深度**（G15），故必须用 `tsc --skipLibCheck false` 探针自证产物 `lib/**/*.d.ts` 零 TS2307。

11. **W11b1 落地（`f9acc28`）与主控独立复核**：8 域迁 `src/server/`（api/catalog/connection/inject/pipeline/stats/workspace）+ `config/model`→`server/config` + `config/store`→`server/store`（含 `impl/` 两文件），58 文件 `git mv` 保历史，`src/config/` 搬空删除；**未建 `store/deps.ts`**（实测零对上依赖，与 D.3·31 判据一致）；引用改写 97 处 / 30 文件（含仓库根 `shared/*.js` 深度 +1 共 6 处 / 4 文件）、`plugins-manifest.json` 4 条 module 改指。
    - **主控实测（自己跑的，非转述）**：`pnpm gate:pr` **32/32 全 exit 0**；`verify-dir-imports --package` exit 0（叶子模块 16、值边 15、两类环 0/0、I2① 0、I8① 13）；**全量 `--write-baseline` 后 `dir-imports-baseline.json` 逐字节零 diff**——基线只存计数不存模块 id，纯重标号不产生位移，D.2·50 拍板①的前提再次成立；`export-surface` 零 diff；产物 `lib/**` + 包内 `shared/**` 的 **216 处相对说明符全部可解析**（G15 面的静态等价探针）。
    - **一处越界但必要的偏离（主控接受）**：搬迁后 6 个变异段里 **4 个正向 glob 全空**（manager/middleware/routes/supervisor），`test:scripts` 的 #342「每段正向条目至少命中 1 个现存文件」当场判红 → 实施方按「改写全仓字符串路径」把拓扑里 19 处被搬路径做了**前缀重指**并重生成 6 份段 conf。**未改任何阈值、段内文件集合与搬迁前等价**；这属 D.4·7 清单里「mutate 段重画」的前置半步，完整重画在 W11b2b。

12. **W11b2a 落地（`56d01ac`）：删 `src/integration/` + 解体 `src/types/`——`src/` 顶层收敛为四项，维护者的硬约束达成**。
    - **落点（主控裁定：不建 `server/shared/types.ts`，按 owner 域落位）**：类型物理定义进各域 `impl/<块>/type.ts`（config/impl/model、config/impl/ui、api/impl/health、workspace/impl/mode、pipeline/impl/authorize、catalog/impl/entries、catalog/impl/search、connection/runtime/impl/middleware），本域门面只转出、域外消费一律经门面；`DisabledToolsMap` 就近定义在 `store/impl/middleware-state.ts`；`ManagerLite`/`MiddlewareHost` 落 `connection/runtime/deps.ts`（I1 白名单、同模块消费）；`RoutesManager`/`SupervisorLite` 落 `connection/interface.ts`（无 `Context`；两者含可选成员，进 `deps.ts` 会违 I6）。`integration/` 两文件是纯类型转出，直接删除并把入口改指 `src/shared/interface.ts`。
    - **为什么不建 `server/shared/types.ts`**：§3.2 的 `server/shared/` 是「无归属的宿主侧设施」，而 `ServerConfig`（config 归一化产出）/`MiddlewareMode`（workspace 归一化）/`DisabledToolsMap`（store 三层解析）/`ProjectUnit`（connection 的 `McpMiddleware.units`）**都有明确 owner**；§3.1 规则 1 与文件清单也已把 `impl/{model,ui,mode,entries,search,authorize,health}` 逐条列出。§四「上游」表自陈是**预期、以实测为准**（doc:286），故它与本刀的张力按实测登记、不改目标树。
    - **主控实测**：build 0 / typecheck 0 / 包 test 0（23 文件 1222 用例）/ `lint` 508/508；`verify-dir-imports --package` exit 0（模块 **16→14**、值边 15 不变、两类环 0/0、I2① 0、I8① 13、`uncoveredSrcFiles` 0、`missingInterface`/`directImpl`/`implToOtherImpl` 全空）；`--write-baseline` 后基线 diff **仅 3 行**（`modules 16→14`、`interfaceFacades 16→14`、`crossModuleRefs 148→161`；`leafValueEdges`/`fileValueEdges`/`scannedSrcFiles`/`allSrcTsFiles` 不变，**quality 段逐字节不变**）；`export-surface` 零 diff。
    - **判据边界（本刀实证）**：`directImpl`/`implToOtherImpl` **不区分 type 与值**（判据 `:807-830`）——域外直引 `impl/<块>/type.ts` 同样判红；`connection/interface.ts` **不得**直接 re-export `runtime/impl/.../type.ts`（跨模块指向非门面），必须由 `runtime/interface.ts` 先转出（同模块）再门面→门面取用。三条反例自证（改前必红、还原后 sha256 逐字节相同）见该提交正文。

13. **W11b2b 落地（`09c82a3`）：六段变异面重画 + 清死条目——mcp 段级「0 命中 pattern」归零**。
    - 收敛掉 B0 的临时超集 `src/server/**/*.ts`，六段改为目标形态；删掉 12 条 `!src/types/**` + `!src/integration/**` 死排除（W11b2a 删目录后它们即腐烂）；把 0 命中字面量 `pipeline/authorize.ts` 换成 `pipeline/impl/authorize/**/*.ts`；第三条 `coverageExcludes` 由单文件改为 `server/*/*/deps.ts`（实测 2 个纯类型出口），**条数仍 3**（四包总数仍 15，未改测试计数）。
    - **主控实测**：`stryker:check` 0（32 份 conf 与拓扑严格一致）；`test:scripts` 665/665；`verify-dir-imports --package` 0 且 `uncoveredSrcFiles` **仍 0**（删超集后未上升）；基线**未被本刀改动**；`export-surface` 零 diff；`lint` 508/508；段命中数逐段与主控离线预演**逐项一致**（entry 13 / manager 5 / middleware 10 / routes 7 / supervisor 8 / runtime 45，进变异面 86、多段重叠恰为 authorize 的 `index.ts`+`type.ts`）。
    - **主控的全仓审计（本刀附带产出）**：用 `node:fs` 的 `globSync` 逐条 pattern 实测命中数——**清完 mcp 后全仓段级死条目恰为 26 处**（全部是 `!…/src/types.ts`：lan-proxy 4 / notifier 9 / provider-usage 12 / wfp 1），与 #836 的实测一致；mcp 自身 **0 命中 = 0 处**。

14. **G18 关闭 + 与 #836 / #837 的关系**：G18（「0 命中 pattern 没有判据」）的**实例面**随 W11b2b 清零；**判据面**归 **#837**（落点 = `gen-stryker-conf --check` 的逐份 conf 粒度；理由：#837 正文已写明——`collectMutationSpecs` 聚合同包各段，段级幽灵会被同名 pattern 掩盖）。本 PR **不实现**该判据（跨包，会同时判红另外 4 个包）。#836 的评论已由主控追加（含审计表与 todo 2/3/4 的建议），跨包部分转到 #837。
    - **交接前状态**：HEAD `abaefc9`（吸收 `origin/main` 的 #832/#833），领先 `origin/main` **85 笔、落后 0**；工作区干净；`src/` 顶层 = `client / index.ts / server / shared`（四项，维护者的硬约束达成）。

---

## 附录 E Port 面与逐域依赖的实测表（第三轮只读测量交付，供 B0 冻结使用）

来源：只读测量 agent 用一次性脚本（全在 `/tmp`，未入仓库）从 `src/**` 反查；方法 = 含 `interface.ts` 的最近祖先目录定义为域（与 §1.1 的「叶子模块 14」一致），消费点 = 剔除 import/export 语句与注释后的标识符出现次数，0 = 死导入。真实 exit code：主脚本 0 / 使用点统计 0 / 替换表 0（首版因域映射缺项 exit 1，补齐后 0）/ 宿主能力表 0；`git status --porcelain -- packages/dsh-mcp-manager/src` = 0 行（未写仓库）。

**与 §3.5 的关系**：§3.5 的示意表作废，以本附录为准。组合根桶 `(root)` 与不存在的 `sdk` 域已从域间表剔除，另在末段单列。

### E.1 域间值能力（100 行）
| 使用方域 | 被消费方 | 能力名 | 形态 | 消费点 | 代表 文件:行 |
|---|---|---|---|---|---|
| api | config | parseClaudeJson | 函数 | 1 | api/routes-controllers.ts:321 |
| api | workspace | MIDDLEWARE_GLOBAL_ROOT | 常量 | 1 | api/routes-controllers.ts:377 |
| api | workspace | normalizeMiddlewareMode | 函数 | 1 | api/routes-controllers.ts:107 |
| api | workspace | normalizeScope | 函数 | 2 | api/routes-controllers.ts:162 |
| api | workspace | normalizeToolName | 函数 | 1 | api/routes-controllers.ts:392 |
| api | workspace | parseFullServerName | 函数 | 1 | api/routes-controllers.ts:368 |
| api | workspace | SCOPE_PROJECT | 常量 | 1 | api/routes-controllers.ts:320 |
| catalog | connection | CATALOG_TTL_MS | 常量 | 3 | catalog/search.ts:113 |
| catalog | connection | LIST_DEFAULT_TOOLS_PER_SERVER | 常量 | 1 | catalog/search.ts:198 |
| catalog | connection | MAX_BYTES_PER_TOOL | 常量 | 2 | catalog/search.ts:374 |
| catalog | connection | MAX_TOOLS_PER_SERVER | 常量 | 1 | catalog/search.ts:367 |
| catalog | connection | MAX_TOTAL_CATALOG_BYTES | 常量 | 1 | catalog/search.ts:394 |
| catalog | store | readCatalogServerFromDisk | 函数 | 1 | catalog/cache-view.ts:101 |
| catalog | workspace | bareServerName | 函数 | 0（死导入） | catalog/search.ts:17 |
| catalog | workspace | fullServerName | 函数 | 4 | catalog/search.ts:110 |
| catalog | workspace | MIDDLEWARE_GLOBAL_ROOT | 常量 | 6 | catalog/cache-view.ts:130 |
| catalog | workspace | normalizedProjectRoot | 函数 | 1 | catalog/cache-view.ts:125 |
| catalog | workspace | normalizeToolName | 函数 | 1 | catalog/search.ts:330 |
| catalog | workspace | parseFullServerName | 函数 | 6 | catalog/search.ts:201 |
| catalog | workspace | SCOPE_PROJECT | 常量 | 1 | catalog/cache-view.ts:130 |
| config | catalog | DEFAULT_ANNOUNCE_CATALOG | 常量 | 1 | config/model/config-schema.ts:143 |
| config | catalog | DEFAULT_CATALOG_MAX_ENTRIES | 常量 | 1 | config/model/config-schema.ts:147 |
| config | connection | DEFAULT_RESULT_TRUNCATE_BYTES | 常量 | 1 | config/model/config-schema.ts:156 |
| config | connection | DEFAULT_TOOL_CALL_TIMEOUT_MS | 常量 | 1 | config/model/normalize.ts:58 |
| config | src/shared（现 root） | clampZIndexBase | 函数 | 1 | config/model/config-schema.ts:89 |
| config | src/shared（现 root） | DEFAULT_Z_INDEX_BASE | 常量 | 1 | config/model/config-schema.ts:22 |
| connection | catalog | boundCatalogTools | 函数 | 1 | connection/runtime/middleware.ts:416 |
| connection | catalog | catalogCacheFile | 函数 | 1 | connection/orchestrator/manager.ts:114 |
| connection | catalog | isCatalogFresh | 函数 | 1 | connection/runtime/middleware.ts:409 |
| connection | catalog | makeCatalogViewFor | 函数 | 1 | connection/orchestrator/manager.ts:117 |
| connection | catalog | summarizeToolDescriptions | 函数 | 1 | connection/orchestrator/manager.ts:183 |
| connection | config | buildConfigUiPatch | 函数 | 1 | connection/orchestrator/manager.ts:147 |
| connection | config | normalizeServer | 函数 | 3 | connection/orchestrator/manager.ts:849 |
| connection | config | normalizeUiConfig | 函数 | 1 | connection/orchestrator/manager.ts:134 |
| connection | pipeline | createRedactor | 函数 | 7 | connection/runtime/middleware.ts:452 |
| connection | pipeline | defaultCallResultFallbackText | 函数 | 4 | connection/runtime/middleware.ts:755 |
| connection | pipeline | isToolDenied | 函数 | 1 | connection/runtime/middleware.ts:647 |
| connection | pipeline | msgOf | 函数 | 15 | connection/runtime/middleware.ts:500 |
| connection | pipeline | normalizeArguments | 函数 | 1 | connection/runtime/middleware.ts:665 |
| connection | pipeline | policyAllows | 函数 | 1 | connection/runtime/middleware.ts:649 |
| connection | pipeline | policyDenialReason | 函数 | 1 | connection/runtime/middleware.ts:650 |
| connection | pipeline | projectCallToolResult | 函数 | 4 | connection/runtime/middleware.ts:745 |
| connection | pipeline | toolDisabledReason | 函数 | 1 | connection/runtime/middleware.ts:655 |
| connection | pipeline | withTimeout | 函数 | 5 | connection/runtime/middleware.ts:302 |
| connection | stats | McpStatsCollector | 类 | 2 | connection/orchestrator/manager.ts:87 |
| connection | store | catalogCacheFileFor | 函数 | 1 | connection/orchestrator/manager.ts:274 |
| connection | store | loadDisabledTools | 函数 | 1 | connection/orchestrator/manager.ts:307 |
| connection | store | loadUserState | 函数 | 1 | connection/orchestrator/manager.ts:304 |
| connection | store | McpStore | 类 | 7 | connection/orchestrator/manager.ts:60 |
| connection | store | saveDisabledTools | 函数 | 1 | connection/orchestrator/manager.ts:354 |
| connection | store | saveUserState | 函数 | 6 | connection/orchestrator/manager.ts:268 |
| connection | store | userStateFile | 函数 | 1 | connection/orchestrator/manager.ts:126 |
| connection | workspace | bareServerName | 函数 | 0（死导入） | connection/runtime/middleware.ts:41 |
| connection | workspace | findProjectRoot | 函数 | 2 | connection/orchestrator/manager.ts:406 |
| connection | workspace | fullServerName | 函数 | 1 | connection/runtime/middleware.ts:646 |
| connection | workspace | MIDDLEWARE_GLOBAL_ROOT | 常量 | 12 | connection/orchestrator/manager.ts:239 |
| connection | workspace | normalizedProjectRoot | 函数 | 2 | connection/orchestrator/manager.ts:290 |
| connection | workspace | normalizeScope | 函数 | 1 | connection/orchestrator/manager.ts:1020 |
| connection | workspace | normalizeToolName | 函数 | 1 | connection/runtime/middleware.ts:644 |
| connection | workspace | parseFullServerName | 函数 | 1 | connection/runtime/middleware.ts:602 |
| connection | workspace | SCOPE_GLOBAL | 常量 | 18 | connection/orchestrator/manager.ts:398 |
| connection | workspace | SCOPE_PROJECT | 常量 | 15 | connection/orchestrator/manager.ts:412 |
| inject | catalog | findToolDetail | 函数 | 1 | inject/middleware-register.ts:628 |
| inject | catalog | listCatalog | 函数 | 2 | inject/middleware-register.ts:476 |
| inject | catalog | searchCatalogMulti | 函数 | 1 | inject/middleware-register.ts:188 |
| inject | connection | CALL_TIMEOUT_MS | 常量 | 1 | inject/middleware-register.ts:368 |
| inject | connection | CONNECT_TIMEOUT_MS | 常量 | 1 | inject/middleware-register.ts:368 |
| inject | connection | DISCOVERY_TIMEOUT_MS | 常量 | 1 | inject/middleware-register.ts:368 |
| inject | connection | LIST_DEFAULT_TOOLS_PER_SERVER | 常量 | 2 | inject/middleware-register.ts:431 |
| inject | connection | LIST_MAX_TOOLS_PER_SERVER | 常量 | 2 | inject/middleware-register.ts:432 |
| inject | pipeline | isToolDenied | 函数 | 2 | inject/middleware-register.ts:681 |
| inject | pipeline | policyAllows | 函数 | 1 | inject/middleware-register.ts:682 |
| inject | pipeline | policyDenialReason | 函数 | 1 | inject/middleware-register.ts:685 |
| inject | pipeline | toolDisabledReason | 函数 | 3 | inject/middleware-register.ts:688 |
| inject | pipeline | withTimeout | 函数 | 1 | inject/middleware-register.ts:67 |
| inject | workspace | fullServerName | 函数 | 2 | inject/middleware-register.ts:680 |
| inject | workspace | MIDDLEWARE_GLOBAL_ROOT | 常量 | 5 | inject/middleware-register.ts:102 |
| inject | workspace | parseFullServerName | 函数 | 4 | inject/middleware-register.ts:98 |
| pipeline | workspace | bareServerName | 函数 | 3 | pipeline/authorize.ts:41 |
| pipeline | workspace | fullServerName | 函数 | 0（死导入） | pipeline/authorize.ts:11 |
| pipeline | workspace | MIDDLEWARE_GLOBAL_ROOT | 常量 | 2 | pipeline/authorize.ts:87 |
| pipeline | workspace | parseFullServerName | 函数 | 1 | pipeline/authorize.ts:82 |

### E.1b 组合根桶 `(root)` 的出境边（清单单列，不属任何域）

| 使用方 | 被消费方 | 能力名 | 形态 | 消费点 | 代表 文件:行 |
|---|---|---|---|---|---|
| index（组合根） | api | makeRoutes | 函数 | 1 | bootstrap/apply-runtime.ts:132 |
| index（组合根） | api | makeEventsRoute | 函数 | 1 | bootstrap/apply-runtime.ts:133 |
| index（组合根） | api | makeHealthRoute | 函数 | 1 | bootstrap/apply-runtime.ts:134 |
| index（组合根） | api | uiConfigChangedFrame | 函数 | 1 | bootstrap/apply-config.ts:106 |
| index（组合根） | catalog | DEFAULT_ANNOUNCE_CATALOG | 常量 | 1 | bootstrap/apply-config.ts:62 |
| index（组合根） | catalog | DEFAULT_CATALOG_MAX_ENTRIES | 常量 | 1 | bootstrap/apply-config.ts:66 |
| index（组合根） | catalog | resolveCatalogInjection | 函数 | 1 | bootstrap/apply-runtime.ts:114 |
| index（组合根） | config | Config | schema | 1 | bootstrap/apply-config.ts:108 |
| index（组合根） | config | DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS | 常量 | 0（死导入） | bootstrap/apply-config.ts:12 |
| index（组合根） | connection | DEFAULT_RESULT_TRUNCATE_BYTES | 常量 | 2 | bootstrap/apply.ts:250 |
| index（组合根） | connection | McpManager | 类 | 0（纯转发） | bootstrap/apply.ts:18 |
| index（组合根） | inject | registerMiddlewareTools | 函数 | 4 | bootstrap/apply-runtime.ts:70 |
| index（组合根） | inject | registerDirectMcpGuard | 函数 | 4 | bootstrap/apply-runtime.ts:76 |
| index（组合根） | store | defaultStorePath | 函数 | 1 | bootstrap/apply-config.ts:35 |
| index（组合根） | store | loadDisabledTools | 函数 | 1 | bootstrap/apply.ts:185 |
| index（组合根） | store | McpStore | 类 | 1 | bootstrap/apply.ts:75 |
| index（组合根） | workspace | makeResolveRoot | 函数 | 1 | bootstrap/apply.ts:172 |
| index（组合根） | workspace | normalizeMiddlewareMode | 函数 | 15 | bootstrap/apply-config.ts:82 |

注意：`stats` / `types` / `integration` 三域在**值**表上 **0 行**（stats 无跨域值边、types 与 integration 全是 type 边）——这正是 E.4 判它们「不该建 `deps.ts`」的依据；但这**不代表**它们可以省掉注入面：`types` 的 4 个宿主最小面必须在目标形态拆进各域 `deps.ts`。

### E.2 宿主能力面（替代 §3.5 的 HostPorts 块）

| 使用方域 | 宿主能力 | 命中行数 | 代表 文件:行 |
|---|---|---|---|
| catalog | HOME 来源 | 2 | catalog/cache-view.ts:13 |
| connection | ctx / Context | 11 | connection/orchestrator/manager.ts:16 |
| connection | logger | 25 | connection/orchestrator/manager.ts:63 |
| connection | 宿主 settings | 1 | connection/orchestrator/manager.ts:145 |
| connection | 宿主 tools | 6 | connection/orchestrator/manager.ts:18 |
| connection | dispose | 36 | connection/orchestrator/manager.ts:802 |
| index（组合根） | ctx / Context | 32 | bootstrap/apply-config.ts:9 |
| index（组合根） | logger | 5 | bootstrap/apply-runtime.ts:83 |
| index（组合根） | 宿主 agent 事件面 | 3 | bootstrap/apply-runtime.ts:16 |
| index（组合根） | 宿主 settings | 19 | bootstrap/apply-config.ts:10 |
| index（组合根） | 宿主 systemPrompt | 2 | index.ts:33 |
| index（组合根） | 宿主事件 ctx.on | 1 | bootstrap/apply-runtime.ts:102 |
| index（组合根） | 服务注册 provide | 4 | bootstrap/apply-services.ts:24 |
| index（组合根） | dispose | 39 | bootstrap/apply-runtime.ts:34 |
| index（组合根） | 路由注册 webServer | 2 | index.ts:33 |
| inject | ctx / Context | 10 | inject/middleware-register.ts:11 |
| inject | 宿主 agent 事件面 | 7 | inject/middleware-register.ts:12 |
| inject | 宿主 tools | 2 | inject/middleware-register.ts:12 |
| inject | 宿主事件 ctx.on | 2 | inject/middleware-register.ts:735 |
| inject | dispose | 4 | inject/middleware-register.ts:818 |
| stats | HOME 来源 | 2 | stats/collector.ts:14 |
| stats | logger（本地结构类型参数，非宿主 LoggerService） | 7 | stats/collector.ts:29 |
| stats | dispose | 1 | stats/collector.ts:265 |
| store | HOME 来源 | 5 | config/store/middleware-state.ts:10 |
| types | ctx / Context（type-only） | 4 | types/host-faces.ts:10 |
| types | logger（`LoggerService` 类型字段） | 2 | types/host-faces.ts:22 |
| types | 宿主 tools（type-only） | 1 | types/server.ts:9 |
| types | dispose（type-only） | 1 | types/middleware-types.ts:53 |
| workspace | HOME 来源 | 4 | workspace/root-resolution.ts:12 |

四个 `logger` 命中语义不同、**不得合并成一个能力**：`connection` 是 `ctx.logger`（唯一真正从宿主取 logger 的点：`manager.ts:102` 的 `this.logger = ctx.logger`）、`stats` 是本地结构类型参数（由 `manager.ts:127` 的 `new McpStatsCollector({ logger: ctx.logger })` 注入）、`types` 是 `LoggerService` 类型字段、组合根是 `manager.logger` 转发。

### E.3 经对象成员（非 import 符号）消费 —— 必须另立一类

| 使用方域 | 提供方（对象） | 能力 | 形态 | 消费点 | 代表 文件:行 |
|---|---|---|---|---|---|
| connection | McpStatsCollector | recordCall | 方法 | 1 | connection/runtime/supervisor.ts:309 |
| connection | McpStatsCollector | isEnabled | 方法 | 0（仅 Pick 类型） | types/host-faces.ts:30 / supervisor.ts:257 |
| inject | McpStatsCollector | isEnabled | 方法 | 5 | inject/middleware-register.ts:174 |
| inject | McpStatsCollector | recordCall | 方法 | 2 | inject/middleware-register.ts:312 |
| catalog | McpMiddleware | getMiddleware / getCatalogCache | 方法 | 经 CatalogViewHost | catalog/cache-view.ts:31-32 |
| workspace | McpManager | projectServersFor | 方法 | 1 | workspace/root-resolution.ts:71 |
| workspace | McpManager | middlewareMode | 属性 | 1 | workspace/root-resolution.ts:66 |
| api | McpManager / McpStore | 22 个成员（含 `uiUpdate` / `projectStoreOrThrow` / `store` / `sseHub` / `supervisors` / `middleware` / `catalogCache` 等裸对象直取） | 方法/属性 | 43 | api/routes-controllers.ts:148 等 |

§3.5 line 322 已点名「裸对象不算契约」（`api` 直取 `manager.*`）；本表把同一问题在 `workspace`（经 `McpManager` 取两个成员）与 `inject`（经 `McpStatsCollector`）上也点出来——**静态 import 图看不见这一类边**，故 B1 的 `deps.ts` 判据必须以运行时能力消费为准。

### E.4 「实测零对上依赖、因而不该建 `deps.ts`」的域

判据（§3.1 规则 2）：有对上依赖 = 取他域运行时能力或宿主能力才建；仅类型边不算。

| 域 | 他域值边 | 他域类型边 | 宿主包导入 | logger | 判定 |
|---|---|---|---|---|---|
| `store`（目标） | 0 | 1（types） | 0 | 0 | **不该建**。依赖 = `node:fs/path/crypto` + 仓库 `shared/dsh-home.ts`；无 `ctx`、无 logger、无他域值引 |
| `stats` | 0 | 0 | 0 | 7 行（本地结构类型） | **不该建**。自己用 `node:fs` 落盘（`collector.ts:12-14`），不依赖 `store`——§3.4 写的「store（落盘）」实测不成立 |
| `integration`（目标 `sdk` 的类型面） | 0 | 0 | 0 | 0 | **不该建**。仅 1 条仓库 `shared` 的 type-only 边 + `declare module`。注意 `sdk` 目标域还含服务注册面，今天不存在 |
| `workspace` | 0 | 2（types、connection） | 0 | 0 | **静态图不该建、运行时该建**（`root-resolution.ts:66/71` 经 `McpManager` 取两个成员）——这是 E.3 的口径冲突点，B0 须先裁决判定口径 |
| `types` | 0 | 3（stats、config/store、connection） | 3 条 type-only | 2 行 | 有宿主类型依赖；因 §3.4 的 11 域里没有 `types`，先不判，等 B0 定它的去向 |

反之，**必须建 `deps.ts`** 的域：`pipeline`（workspace 3 函数 + 1 常量）／`catalog`（store 1 + connection 5 常量 + workspace 7）／`connection`（config 3 + store 7 + catalog 5 + stats 1 + pipeline 10 + workspace 10 + 宿主 ctx/logger/tools）／`inject`（catalog 3 + connection 5 常量 + pipeline 5 + workspace 3 + 宿主 tools/events/prompt）／`api`（config 1 + workspace 6 + 宿主 `WebRoute` 类型；宿主运行时面实测 0）／`config`（catalog 2 常量 + connection 2 常量 + 仓库 shared 2 值）。`bootstrap` 是装配根，目标并入 `index.ts`。

### E.5 值面上无域外消费者的导出（I4 收口清单）

恰好 3 个，与 §二 I4 的实测一致：`api/interface.ts:10` `queryParam`、`connection/interface.ts:12` `stripMcpPrefix`、`connection/orchestrator/interface.ts:7` `stripMcpPrefix`。其余无消费者导出全在类型面（catalog 4 / config-store 1 / integration 4）。

### E.6 反查的不确定项（B0 需处理）

1. `upgrade` 与 `sdk` 两域今日不存在，两行 `deps` 只能等 B1 建域后重算。
2. 「消费点数量」用标识符出现次数（唯一可机器复算口径）；对纯 re-export 门面（`connection/interface.ts`）与组合根桶会大量计 0，故域间表已剔除组合根桶。
3. `pipeline/authorize.ts:11-16` 的 4 个符号按**导入**计是「3 函数 + 1 常量」，按**实际使用**计是 2 函数 + 1 常量（`fullServerName` 死导入）——B0 需选定一个口径（建议按实际使用计，与 E.3 的运行时口径一致）。
4. 域定义取「含 `interface.ts` 的最近祖先目录」，`client/**` 全程排除（14 个文件未统计）；如需 client 侧反查须另跑。
5. 逐域 logger 命中给了行数与词出现数两套，只有行数口径能复现复核的 connection 25 / stats 7；本附录统一用行数口径。
6. `types/host-faces.ts` 的 4 个宿主最小面（`ManagerLite` / `RoutesManager` / `MiddlewareHost` / `SupervisorLite`）是今日唯一把宿主能力写成类型的地方，目标形态要拆进各域 `deps.ts`——B0 冻结时应作为 `types` 域去向的输入。
---

## 附录 F 子 agent 派发与复核规程（主控视角，本轮实证）

本轮共派 **5 个实施子 agent + 3 个只读复核**，无一失败；后续以这个模式推进（维护者已定「后续主要派发子 agent 实施」）。

### F.1 派发

1. **一次只放一个写者**：同一 worktree 的 git index 是共享资源。实施与实施必须串行（本轮刻意把切片 3b 压到 3a 收口之后），只读复核可任意并行。主控自己写文档与实施并行时，**必须用 `git commit -F <msg> -- <path>` 显式路径提交**，否则会卷走对方的未提交改动。
2. **每个 prompt 必含**：worktree 绝对路径；**upstream 指向 `origin/main`、禁止裸 `git push`**；「先读文档哪几节」；逐项交付面；逐条验收命令与期望 exit code；纪律（显式列路径暂存、禁 `-A`、不碰哪些面、不向下委派、跑不动就报）。
3. **要求子 agent 自跑定位**，不要把自己的行号当事实给它。本轮两次验证：notifier 的 client→server 两条边、lan-proxy/web-file-preview 三处存量——它复跑后与我给的一致，但这正是「不采信转述」的价值所在。
4. 明确写「**宁可推迟也不要放宽判据**」。本轮两次触发：切片 2 的「glob 命中 0 文件」风险、切片 4 的 ⑩ 迁移。
5. **prompt 给「先读哪节」，不要给「我理解的口径」**——主控两次越界都被实施方按宪法原文纠正（把 §8.1 的目标形态表当成 I8 判据面；把「不得引他域 `impl`」当成本轮硬判据）。

### F.2 复核（主控必做）

1. **看它有没有删/改弱既有断言**：切片 3a/3b 各改了 2–3 处既有自测，逐条读 diff 原文，判「锚点选取方式改变、强度只增不减」。
2. **看基线的「位移 vs 新增」**：`--write-baseline` 后必须确认既有键零位移、只多新键。
3. **机制变更单独裁决**：切片 3a 把 `buildBaseline` 改成两级首次登记——这类改动不能只看「测试绿」，要看是否开出洗白路径（已登记为 R16）。
4. **不采信「未实测」**：`pnpm gate:pr` 由主控在所有实施落地后自己跑（**32 条门禁项**逐条 exit=0，两次实跑均 PASS；旧交接里的「33 项」把封装脚本的 `[gate:pr exit=0]` 标记误记为一条门禁项）；并且**本地 PASS ≠ CI 绿**（变异只在 PR 上跑）。

### F.3 已知会反复撞的坑

- `lint` warning 预算 **670/671，余量仅 1**（新增 `scripts/**` 测试即撞线；**不许擅自抬 `gauntlet.config.json`**）。
- ESLint 认知复杂度阈值 84：往 `verify-dir-imports.mjs` 里内联大段逻辑会撞线，需抽模块级函数（切片 3a 已因此抽过一次）。
- `--write-baseline` 在「证据类首次登记」时会按当前事实写入（R16）——新增判据类时必须看逐类提示，并确认该类**只在键缺失那一次**生效。
- 跨包 `trackingIssue` 的载体：仓库里**没有**覆盖 lan-proxy / web-file-preview 单元测试改动与 notifier client 边的独立 issue，本轮三条台账 + 两条豁免都挂 `#767`（`reviewBy 2027-03-31`）。若要独立跟踪需新开 issue。
- **裸包名自引用绕过 I8①**（B0 对抗复核 P0，见附录 G·G1）：`resolveCandidates` 只吃 `.` 开头，故 `import ... from "@wingsky-1/dsh-x"` 在 `test/unit/**` 记 **0 条**证据——而它经 `exports` 真的解析到产物面。新增判据/改判据面时必须同时问「有没有另一种写法能写出同一件违规」。
- **别名转出触发规则 4 假红**：`collectExports` 对 `export { A as B } from` 只登记源名 `A`，门面里对该别名再做**同名**转出会解析到空 → 必须用**真实源名**转出（见 `src/shared/interface.ts` 的就地注释）。

---

## 附录 G B0 门禁机制对抗复核（只读红队）的发现与处置

**复核方式**：只读（禁跑 `build` / `gate:pr` / `--write-baseline`），全部复现实验在 `/tmp` 隔离根（`VERIFY_DIR_IMPORTS_ROOT`）完成，未在 worktree 落任何文件；判据实现文件 sha 在复核前后未变。**主控逐条复验了 G1 与 G2–G4 的代码路径与真实存量**，未采信转述。

| # | 发现 | severity | 证据 | 处置 |
|---|---|---|---|---|
| **G1** | **裸包名自引用绕过 I8①**（零数据面改动就能造出等价违规） | **P0** | `resolveCandidates:187` 只吃 `.` 开头的 spec → 裸名返回空 → I8① 的 fallback 落到 `<pkg>/test/unit/@wingsky-1/dsh-x`，不匹配任一面 → **0 条证据**。但各包 `package.json` 的 `exports["."]` 指向 `./lib/index.js`、`tsconfig.base.json` 是 NodeNext，故该 import **真的解析到产物面**（可用 `import.meta.resolve` 亲验） | **修**（B1.0）：让 I8① 认识裸包名/子路径写法，且证据 id 与相对写法**规范化一致**。存量实测 **0**（`test/unit/**` 裸自引用 0 条；`src/**` 唯一命中在 JSDoc 内）→ 零基线位移。**已完成（`4f94f65`）**：新增 `selfReferenceLibTarget(pkgName, spec)` + `readPackageName(pkgDir)`，映射只落在 I8① 的采集函数内部，`resolveCandidates`/`resolveTarget` **一字未动**（主控已核：这两函数在 diff 里无任何 `+/-` 行，故 I2①/I2④/§5.3 判据面不变）；裸/相对 × `lib` 存在/不存在**四态落成同一条证据串**，且该映射与 Node 的包自引用解析实测一致（`import.meta.resolve` → `lib/index.js`） |
| **G1b** | **G1 遗留的两条 id 不一致**（都不构成绕过） | P2 | ① 子路径按字面前缀映射：`<pkg>/client` → `lib/client`，而其相对等价写法落 `lib/client.js` → **两者都判红但 id 不同**，少了「换写法换不掉证据」的强度；② `<pkg>/package.json` → `lib/package.json` 是**理论假阳性**（导入本包 package.json 本身合法，相对写法不会被判）。另 `readPackageName` 读不到 `package.json` 时**静默**不做映射（既有 fixture 的合成根没有 package.json，故未 fail-closed） | 当前仓存量 0、无实际影响，故**登记不修**。推荐的将来修法：按本包 `exports` map **反解**子路径到真实落点再走 `unitImportFaceTarget`（可一并消掉 ①②，并让「读不到 package.json」变成显式提示而非静默） |
| **G2** | **R16 的护栏描述不成立**：「CI 的 `--check`」不是护栏 | P1 | CI 只跑 plain check（`contract-check.ts:246-290`，无 `--write-baseline`）；洗白后的基线在 check 模式**按构造必然 PASS**；基线只有 `version`+`$comment`，无 provenance | **已订正 R16 文案**（§十三）：「唯一护栏是人工 diff 审阅」 |
| **G3** | **删整包条目可一次洗 10 类**，提示只报条数、不含逐条明细 | P1 | 删 `baseline.packages[pkg]` → `--write-baseline` exit 0，输出「10 类，共 2 条」 | 记入 R16；「提示须列逐条明细」列为改进候选 |
| **G4** | **瞬态台账**：台账只在写基线那一刻被读，无「基线证据→台账」对偶 | P1 | `:1329` 仅写入时查台账；`:1493-1504` 只有台账→证据单向。写入含证据的基线后清空 ledger → plain 仍 exit 0 | 记入 R16，登记为已知放宽路径 |
| **G5** | **`lib/**` 证据 id 不 canonical**（只有 `src/index.ts` 做了归一） | P1 | 同一句 `import "../../../lib/foo"`：无 `lib/` 时 id=`lib/foo`；出现 `lib/foo.d.ts` 后 plain 与 `--write-baseline` **均判红** | **纪律**：`--write-baseline` 必须在 **build 之后**的树上跑（B0⑪ 对导出面已有同款要求）。机制层归一登记为候选 |
| **G6** | **豁免到期无执法力**，`reviewBy` 可静默删除转长期 | P1 | `collect-exemptions.mjs:15` 明确「退出码恒为 0：它是报告不是门禁」；`verify-dir-imports` 从不读 `reviewBy`；删该字段即从到期台账消失 | 登记为已知限制（仓级豁免平台，超本包范围）。**粒度是单条证据**（`path=<包名>:<证据项>`），不存在「一条关整类」 |
| **G7** | **解析不到的相对导入被整体 skip**（门面被删时判据反而 exit 0） | P2 | B1.1 反面 B：移走 `interface.ts` → `verify-dir-imports` **exit 0**，同态 `tsc` 报 **6 条 TS2307** | **不改**（组合门禁含 typecheck 兜住），登记 |
| **G8** | **别名转出触发规则 4 假红** | P2 | `collectExports:411-417` 对 `export { A as B } from` **只登记源名 `A`**，门面里对该别名做同名转出即解析到空 | 已就地规避：`src/shared/interface.ts` 用**真实源名**直连仓库根单源 + 就地注释；并列入附录 F.3 撞坑清单 |
| **G9** | **判据面与宪法正文的文字差** | P2 | I2④ 实现判「**值**引 `src/index.ts`」（`!r.isType`），宪法正文（doc:124）未加「值」；I8① 实现含 `src/client/**`，正文（doc:165）只列两面，而 §8.1 与脚本头写全三面 | 待订正（文字向实现对齐） |
| **G10** | **「有文字无判据」清单** | P2 | 见下 | 登记（长期透明度） |
| **G11** | **I9 判据只覆盖顶层 `let/var`**：`const Map` + 就地 mutate 是**同一种**模块级可变状态却逃过判据 | P2 | B1.2 实测：`file-io.ts` 的同路径串行链必须是模块级 `const Map`（串行语义要跨调用点），而 `forbid-module-state-src` 只判顶层 `let/var`——B0④ 为 `client/float/panel.ts` 的 `let inflight` 写过豁免，说明该不变式的**意图**正是禁这类跨调用状态 | 当前为**显式例外**（已就地注释）；登记。扩判据会牵动全仓 module-level 缓存/Map（高连带），须单独裁决，不在 B1 范围 |
| **G12** | **`analyzeInjectionFaces` 的声明正则漏 `export async function`** | P2 | 实测正则（`verify-dir-imports.mjs:333` 起）：`/export\s+function\s+(install[A-Z]\w*)\s*\(/`——`export` 与 `function` 之间只允许空白，故带 `async` 修饰的 `installXxx` **对注入面对账完全不可见**（同族「等价写法逃过判据」，与 G1 同因） | B1.3 已就地规避（签名刻意写成非 `async` 的 `export function`，并注释理由）。**登记**：修法是把正则放开成 `export\s+(?:async\s+)?function`，属机制变更须单独裁决；应顺带扫其它基于正则的采集点是否有同样的修饰符盲区 |
| **G13** | **`--write-baseline --package X` 会把 X 的条目挪到 `packages` 首位** | P2 | B1.3 实测：生成器先写被分析包、再补旧基线其余包 → 产生 order-only churn（该包条目 31 行纯位移）。判据不受影响（JSON 解析不看键序），但会污染 diff | B1.3 按 HEAD 包序手工还原键序（语义零变化、plain check exit 0）。**推荐做法**：写基线一律用**不带 `--package` 的全量 `--write-baseline`**（B1.2 即如此，得到最小 5 行 diff）；生成器保持既有键序列为改进候选 |
| **G14** | **跨包帧名存在第三处物理定义且无判据**：本包 `src/shared/frames.ts` 与仓库根 `shared/sse-hub.js:45` 各写一份 `ping` 帧 | P2 | B1.5a 实测：hub 侧 `const PING_FRAME = 'data: {"type":"ping"}\n\n'`，与本包 `SSE_FRAMES.ping` 值逐字相同；一致性锁的判据面**刻意不含**仓库根 `shared/`（它是跨包共享层，不是本包内部实现） | 登记。**本轮不修**（仓库根 `shared/` 是 N4 禁改面）；跨包一致性属 `#706` 的仓级共享层议题，届时一并收口 |
| **G15** | **产物 `.d.ts` 的可解析性没有任何判据**：仓库默认 `skipLibCheck: true` 使 `.d.ts` 里的 `TS2307` **静默降级成 any**，消费方按包名引类型时拿到空类型而门禁全绿 | **P1** | B1.5b 实测：X1 修正**前**，`lib/{api/routes,integration/service,types/ui,client/core/state}.d.ts` 出现 `TS2307 Cannot find module '../../shared/interface.js'`；只有 `--skipLibCheck false` 探针看得见（修复后 0 条）。既有闸（`verify-dir-imports` / `export-surface-snapshot` / `pack-check`）当时**都看不见**；`pack-check` 只在「缺 shared 声明副本」的窗口偶然判红，跑一次 build 即回归绿 | 已由 `fd908b1` 修掉**触发源**，但**判据缺口仍在**（下一处同类缺陷照样静默）。**建议**：把「产物 `lib/**/*.d.ts` 在 `--skipLibCheck false` 下零诊断」纳入判据（`pack-check` 扩展或独立闸），否则「按包名引类型」这条对外契约永远只靠人工。属机制变更，须单独裁决 |
| **G16** | **质量证据 id 是路径派生的 → 纯结构搬迁会被判成「新增未登记证据」** | **P1（编排级）** | B2.1 实测：`src/stats/` → `src/server/stats/` 使 `crossDomainValueEdges` 由 `connection/orchestrator|stats` 变为 `connection/orchestrator|server/stats`；plain check **exit 1**（判词「新增未登记证据」）、`--write-baseline` 同样 **exit 1**（基线零改动）。规模实测：`crossDomainValueEdges` **33 条**、`leafModuleCycles`/`fileCycles` 各 **4 条**，全为路径派生；B2 要搬 **11 个域**，逐域搬迁会把以该域为端点的每条边都变成「旧消失 + 新出现」 | **不改判据**（把「一进一出」自动配成位移会削弱「新增即红」这条保守红线）。**处置靠排序**：就地重构（模块 id 不变）+ 把 `server/` 前缀并入 B2b 原子变更（前提是值边与环已到 0）。**明确不采纳**「逐条台账豁免」——那会让台账成为 B2 的常规放宽通道，与 R16/G2–G4/G6 同族。若 B2b 时仍有残余，再单独裁决。**同族第二例（作用在 `fileCycles`，B2.4 实测）**：`catalog/search.ts` 进 `impl/search/` 会让含它的那条环签名由旧变新 → 同样判红 + 拒写；处置同「不制造位移」（留原位 + 门面注释 + 并入 B2b）。**推论：4 条模块级环 + 4 条文件级环的成员文件在破环之前都不能动** |
| **G17** | **门面消失会被报成「质量证据改善」**（比 G7 的静默跳过更坏：它会主动误导复核者以为违规减少了） | **P1** | B2.2 实测：只把 `workspace/interface.ts` 改名成 `facade.ts` 而**不**改消费者 specifier → `verify-dir-imports` **exit 0**，且输出报「**质量证据改善 7 条**」（`api|workspace` 等被记为「已消除」）。机理（代码依据）：`collectModules` 只把「含 `interface.ts` 的目录」当模块，门面没了该目录就不是模块 → `moduleOf(target)` 返回 `null`、这些边被整体 skip → 在「只许缩小」的集合口径下**表现为缩小的改善**。只有 `tsc` 兜得住 | **不改判据**（这是保守口径的副作用），**登记**。**修法与 G7 同一处**：断言「每个相对 import 都能解析到文件」，可一并关掉 G7/G17 与「缺门面」三态；否则 B2 期间任何一次门面改名/搬迁都可能给出**反向信号** |
| **G18** | **mutation-topology 里 0 命中的 pattern 没有判据**（**已关闭**：#767 W11b2b 清零 mcp 的全部实例——12 条死排除 + 1 条 0 命中字面量；**判据面**归 #837） | P2 | B2.3 实测：`mutation-topology.json:111` 的 `middleware` 段字面量 `packages/dsh-mcp-manager/src/pipeline/authorize.ts` 在文件搬迁后 **0 命中**，而 `gen-stryker-conf --check` 仍 **exit 0**（它比的是「配置与拓扑一致」，不是「pattern 命中物理文件」）。后果：该文件的**变异度量段静默从 `middleware` 漂到 `runtime`**（覆盖不丢，但分段的基线不同）。对照：`coverage.config.json` 的 pattern **有**「命中 0 文件即判红」规则（`verify-coverage-scope.mjs:220-230`） | 登记。**处置**：并入 B2b 的 mutate 段重画那一笔（方案本就要求重画）。**建议**：把 coverage 那条 0 命中判据对称加到 mutation-topology 上（同一族「死配置无判据」）；否则每次搬迁都会留下指向不存在文件的字面量 |
| **G19** | **值边归零不等于耦合消失**：`api` 对 `manager` 的 **44 处直取 / 22 个成员**没有 import 边 | P1 | scout 实测 `grep -o manager\.[A-Za-z_]* src/api/*.ts` = **44 处 / 22 成员**（summary 9 / setSession 5 / middlewareMode 3 / …）。走完 W1–W11 后 `api 相关值边` = 0，但**运行期耦合原样保留** | 登记。**这是「判据面 = 值边」的固有盲区**：参数用结构类型时，耦合对静态图完全不可见。处置归 B2b（把 `manager` 换成 `connection/interface.ts` 的**命名能力对象**，由组合根构造路由时递入——§3.3 第 6 条 + §3.5 裸对象不算契约）。**B2b 验收不得只报值边 0**，必须同时报命名能力对象的覆盖面 |
| **G20** | **`analyzeInjectionFaces` 只扫 `src/index.ts`**：install 调用写在别处则注入面对账**静默空转** | P2 | scout 实测 `verify-dir-imports.mjs:333/335/357`——`indexFile` 只取入口、`callRe` 只在入口文本上跑。今天真实装配在 `bootstrap/apply.ts`（`new McpStore:75` / `new McpManager:77`）→ 若 wire 把 `installXxx` 留在那里，那条「实参键集 == deps 字段集」的对账**不报错也不报绿，只是没看见** | **主控裁定**：所有域的 `installXxx(deps)` **字面调用点必须落在 `src/index.ts`**（`assemble` 作为有序生命周期驱动，装配列表与 deps 对象字面量都在入口），判据才带电。**登记**：把采样面扩到装配处属门禁改动，须单独裁决 |
| **G21** | **环枚举用三色 DFS + BLACK 全局标记：先探到的长环会把子环遮蔽**，删掉一条无关边会把**改前就存在**的子环报成「新增未登记证据」（假红） | **P1（编排级）** | B2a-wire 实测（W2 只删 `connection/interface.ts:12` 一条值复导 = 唯一 `directImpl`）：`verify-dir-imports` **exit 1** + `--write-baseline` **拒写**，判词「`leafModuleCycles`: 新增未登记证据 `catalog\|connection\|connection/runtime`」。而该三环的三条边 `catalog\|connection`、`connection\|connection/runtime`、`connection/runtime\|catalog` 在**改前基线的 `crossDomainValueEdges` 里全部存在**（主控已核）。机理（`verify-dir-imports.mjs:517-542`）：`visit` 出栈即置 BLACK，`state === BLACK` **既不报环也不重入**——从 `catalog` 出发当 `connection → connection/orchestrator → connection/runtime` 先被探到时 `connection/runtime` 已变黑，**直接从 `connection → connection/runtime` 走的三环永不现身**；删掉 `connection\|connection/orchestrator` 后它首次被报出 → 「计数 4→1（降）」与「集合 4 条全消失 + 1 条新出现」并存。副作用面：环签名同时受 `edges.keys()` **插入序**影响，故 **W3–W9 每一刀都有此风险** | **不改判据**（完备化要换 Johnson 算法并在全仓重登记基线，属机制变更须单独裁决；且它把「保守」换成「更多证据」，成本与本笔不匹配）。**处置靠排序**（与 G16 同族）：W2 **并入 W4**（两类环归零后新身份消失、基线才可写），**不登记台账豁免**。**后续每刀的可判据**：唯一红若是 `leafModuleCycles`/`fileCycles`，且（a）报出节点集合是改前基线某条环的**真子集**、（b）该环**每条边**在改前基线里都存在 → 判假新增，**停下报告**并在同一笔或紧随的笔里把父环一起消掉；有一条边不存在即真纠缠 |
| **G22** | **消失证据不清理 = 静默放宽**：`--write-baseline` 不主动跑就永不清「已消失证据」，而 CI 只有 plain check（G2） | P2 | W1 实测：改前基线含 4 条本次消失的证据（1 `leafModuleCycles` + 2 `fileCycles` + 1 `crossDomainValueEdges`）+ 3 项偏高的结构计数；plain check 只把它们列成「改善」并 **exit 0**。后果：该 id 仍留在 `baselineById` 里，将来**回归时既不判「新增未登记证据」也不判「降级」**（上升判据是 `!baselineById.has(id)`） | **纪律**（D.3·25）：每一刀动到质量证据都**同笔**跑**全量** `--write-baseline`（G13）并逐字审基线 diff；W1（`770859b`）照此清理 4 条 + 3 项计数，diff 仅本包。生成器「自动清理或显式提示必须清理」列为改进候选 |
| **G23** | **本分支比上游多 4 个质量证据类 + 一条「类级首登直写」通道**（合并 origin/main 时暴露的机制分歧） | **P1（编排级）** | 权威审计：合并后 `scripts/gate/verify-dir-imports.mjs` **1830 行 vs 上游 1533 行**，`diff` 的分歧全部是本项目 B0 成果；基线实测**上游每包 `quality` 6 类、我们 10 类**。必要性：新证据类并入既有包时 `prevQuality` 在、单个键缺，上游的包级台账门覆盖不到 → 若按「逐条过台账」，要给 mcp 的 33 条 I2① 存量逐条开豁免。窄洞：手工删基线里某一证据键 → `--write-baseline` 无条件写入该类当前证据（同族 R16/G3） | **保留 + 登记**：输出里逐条点名「须在 PR 内确认」、只在键缺失那一次生效；护栏仍是人工 diff 审阅。**该分歧随本分支合入 main 后即成为 main 的行为**，维护者可决定是否上收（若上收，上游也获得「新证据类可登记存量」的能力；否则 main 只能靠逐条豁免引入新类） |

**G1 的裁决边界（只修 I8①）**：§5.3 禁的是 `src/server/**`、I2④ 禁的是 `src/index.ts`；裸包名解析到 `lib/index.js`，**不是同一件事的等价写法**，属另一条规则——悄悄扩大一个已冻结判据的范围就是自行扩大授权，故**只登记、不实现**。

**「有文字无判据」（只列有 grep/读码证据的）**：I1（无 Context 闸）、**I2③ 后半「死声明 = 0」**（计算在 `:823-847`，只在 `--graph` 打印，不进 metrics 也不进证据面 → 既不判红也不进基线，**连默认输出都没有**）、I2②（只判新增，存量 4+4 环仅棘轮，终态 0 未强制）、I3（脱敏/投影构造点 = 1、字段清单单点、拒绝文案单点）、I4②（每个 `interface.ts` 具名导出至少一个域外消费者）、I5（`shared/README` 登记与实测一致）、I6（`deps.ts` 无 `?:`、域内禁三种存在性守卫）、I7（`paths.ts` 是文件名/权限字面量唯一出处）。**结论：这些不变式今天全靠人工**；I8②③ 已在脚本头显式登记压后。

**同一次复核的正面结论（对照面）**：四条新判据**不是空转**——把每条分别改成恒空后跑 `verify-dir-imports-criteria.test.ts`：原始 9/9 pass，四个变异分别打红 **2 / 2 / 1 / 2** 条用例且互不串扰；`--graph` 输出与基线口径逐条一致（mcp 33/0/0/13；notifier 的 2 条 clientServerImports 与两条豁免逐字同形）。

**未构造出可达路径（不采信为结论）**：证据串被 `sort`/去重吞掉、`null` 与空数组判等、路径分隔符差异、台账跨类 key 碰撞——其中 `null` 反而 fail-closed。

---

## 附录 H B2a-wire 期的两份只读评审台账（主控复核后入档）

**评审方式**：两个只读 agent（一个查**服务端暴露面**、一个查**测试面**），钉提交 `936c952`，全部用 `git show 936c952:<path>` 读文件（不读工作区，避免读到并行写者的半改状态），**禁跑任何 build/test/tsc/门禁**，临时脚本只在 `/tmp`，仓库零写入。**主控逐条抽验了各自最值钱的主张，并订正了 3 处误报**（见 H.3）。

### H.1 服务端暴露面（A）

1. **门面这一层已经收干净**：域间直引非门面文件的边 **0 条**（全仓 14 条此类边全部 from = `test/**`）；全包**真死导入 0 条**；域门面零消费者导出 35 项。
2. **问题堆在两端**：入口 `src/index.ts`（见 D.3·36 的 159 项实测）与共享层。
3. **共享层是「预置的终态」而非「在用的共享」**：`server/shared/interface.ts` 41 项导出里，I5 达标（≥2 消费 unit）只有 4 个常量（就是 W3 迁过来的那 4 个）；**12 个真对外契约只有 `server/upgrade` 一个消费者**；**零消费者 13 个**（7 个宿主端口类型里 6 个 + 6 个文件名常量 + `HostContextPort` 经门面即 0）；`compose.ts` 系列**确认仍为单消费者放宽**。`src/shared` 则是真正达标的跨端单源（`ROUTES`/`SERVER_STATES`/`SSE_FRAMES` 三族 + DTO/service 类型）。
4. **端口面**：`catalog/deps.ts` 与 `pipeline/deps.ts` **逐成员 0 死项**；但 `MIDDLEWARE_GLOBAL_ROOT`/`SCOPE_PROJECT`/`LIST_DEFAULT_TOOLS_PER_SERVER` 被迫写进每个消费域的 Pick（→ D.3·35 的 W3b）；`CATALOG_LRU_MAX`/`createTransport`/`RECONNECT_DEFAULTS`/`resolveReconnect`/`ReconnectPolicy` 是**零消费者**，W7/W8 建端口时**不要为它们开口**。
5. **死形参全量 = 1 条**：74 个导出函数里只有 `makeRoutes(manager, _cwd = process.cwd())`（`_cwd` 声明处外零出现）；其余逐形参出现次数 ≥2。**本 PR 修不掉**（`_` 前缀是过 `no-unused-vars` 的唯一合法写法），且**没有判据**（导出面只比字符串）→ G10 类。
6. **类型/值面**：`HttpTransport`/`StdioTransport`/`MCPClient`/`McpMiddleware`/`McpManager` 的域外消费者**全是 `import type`**（域门面**可**降级为 `export type`），但它们在**入口是值导出**且 smoke 以值导入 → 降级 = 入口面变更（红线），两者必须一起改才有意义。两个默认常量是**单定义 + 5 跳 re-export 链**，非重复定义。

### H.2 测试面（B）

1. **形态**：B1 后新写的 8 个文件（file-io / queue / upgrade×3 / 契约 / 组合根）类型干净、判据密；13 个 #664 存量 unit 是「**经组合根取号 + `@ts-nocheck` + 大量 `toBeTruthy`/内部字段断言**」的老形态，I8① 那 13 条违规**正是这 13 个文件**，且**全部是动态 `await import("src/index.ts")`**。
2. **收窄路径的硬约束**：`McpManager` 在 `connection/interface.ts` 是 **type-only** 转出，故 7 个文件**不能**只引域门面，必须直连 `connection/orchestrator/interface.ts`；评审给出逐文件「符号数 / 需门面数 / 目标模块」表（13 文件共 116 符号 → 47 条 import），可直接当 B3 作业单。**主控裁决：推迟到 B3**（B2b 会给 11 域加 `server/` 前缀，现在改要改两遍）。
3. **`@ts-nocheck` 存量 18 个文件**（14 unit + `e2e/smoke` + `helpers.ts` + 2 个 integration——**评审漏了后两个，主控实测订正**）；掩盖两类：语句级无注解形参（可静态判定下界 **≥68** 条 TS7006）+ 假宿主/假 ctx 的结构不匹配。最省摘除顺序已给（workspace → call-stats → store → supervisor → apply → pipeline → hotspot → manager → catalog → routes-sse → manager2 → middleware → helpers → smoke）。
4. **两处判据/文档缺口**：① `test/tsconfig.json:12` 的 `exclude: ["e2e/**"]` 注释理由（「该文件不产生类型诊断」）只对带 pragma 的 smoke 成立，**无 pragma 的 `e2e/cross-end-lock.test.ts` 因此不在任何编译面**（`package.json` 的 `typecheck` 只跑 src；唯一编译 test 面的是 `scripts/test/service-contract-wiring.test.ts`）；② `service-contract-wiring.test.ts:24-25` 那句「契约与单元测试文件无 `@ts-nocheck`」**与事实相反且两头都错**（14 个 unit + 2 个 integration 都带）。后者属**本 PR 内可改**（纯文案，主控自己改）。
5. **断言强度**：`toBeTruthy()` **216**、`toBeUndefined()` **82**、快照式 **0**、`as any` 0、`ts-ignore` 0；`vi.mock` 全包唯一在 `unit-file-io-queue.test.ts`（是否纳入 skill 例外清单待裁决）。逐条弱断言与更强写法已列（manager2 内部字段直取 67 条、墙钟阈值 flake、只断「不抛」的 resolve 断言等）。
6. **无值锚常量清单**（改值不会红任何用例；**9 条「同源期望」**（期望值取同一个常量）另计）：最高优先 = limits 族 5 个（`MAX_TOOLS_PER_SERVER`/`MAX_TOTAL_CATALOG_BYTES`/`DISCOVERY_TIMEOUT_MS`/`CATALOG_LRU_MAX`/`LIST_DEFAULT_TOOLS_PER_SERVER`）+ `DEFAULT_RESULT_TRUNCATE_BYTES` + `DEFAULT_Z_INDEX_BASE`；反例：`cross-end-lock` 的 4 条是**双源互校**（本仓最强判据之一），不算同源期望。
7. **覆盖盲区**：最薄的是 `workspace`（仅 3 it / 79 行）与 `inject`/`config`（无独立文件）；`client` 侧 `float/*`/`settings/*`/`core/{api,dom,i18n,session}` **零测试文件**（归 #769）；`sdk` 域未落位故无测试（不是遗漏）。已落地机制的缺口：`file-io` 串行队列只有 2 条（缺「队列表清理守卫 / 不同路径不互阻 / 临时名唯一性」）、**掩码往返是「未落地」不是「未覆盖」**（`src/` 里 `mask` 零命中）、`upgrade` 四态齐但**装配接线零覆盖**（B2 落）、`compose.ts` 9 条驱动的是夹具域。
8. **判据覆盖退化清单**：`verify-shared-fanin` 的**类型面分支**（本仓 shared/ 8 模块全有配对 `.js` → type 恒 0）与**悬空引用分支**；`verify-dir-imports` 的**裸包名映射分支**（仓内无实例，只有 fixture 跑）；mutation-topology 的 **0 命中 pattern**（G18 的 mcp 实例已随 #767 W11b2b 清零；**判据本身仍缺**，全仓另有 26 处活体，归 #837）；本包基线里 **5 个恒空证据类**；`export-faces.json` 的 `faces` 为**空**（159 项全在 legacy，存量零分类）；I8②/I8③ 只有文字。
9. **B3 按域重排切法已给**（逐文件目标域 + 跨域 it 表：manager2 12 / middleware 34 / apply 3 / routes-sse 2 / store 1 / hotspot 1 / catalog 0；风险点：依赖组合根装配的用例必须整段搬、`makeHost` 这类文件内夹具留域内）。

### H.3 主控复核订正（3 处）

1. **`@ts-nocheck` 的 pragma 面 = 16 个文件**（14 个 `test/unit/**` + `test/e2e/smoke.test.ts` + `test/helpers.ts`）。**这一条是主控自己的口径错误，2026-09-15 终态复核订正**：主控当时用 `grep -rl "@ts-nocheck" test/` 得 18，把 `integration/real-context.test.ts:30` 与 `integration/service-contract.test.ts:21` 两处**散文提及**（「本文件不带 @ts-nocheck…」）算成了 pragma；**正确判据是首行精确匹配**。副作用仍在：`service-contract-wiring.test.ts` 那句「契约与单元测试文件无 pragma」两头都错——已随 `68167e8` 按实测值改写。
2. **§8.2 不是「遗漏 5 个测试文件」**：评审 B 把 #664 遗留清单读成了全包清单。真相是**标题口径误导**——另 7 个文件由 B1 期新增且**已在目标位置**（`unit/upgrade/` 本身就是目标形态）。主控已订正标题与行数（`278c4e8`：全包 23 文件 / 16252 行 / 静态 `it(` 1169；`unit-middleware` 2109→2107、`service-contract` 338→366、`smoke` 3844/159it→3858/161it + 9 处 `new McpManager` 行号）。
3. **跨端字面量重复（两份评审都没提，主控发现）**：`src/client/core/api.ts:18` 写死 scope 字面量与全局 root 前缀，即 `SCOPE_GLOBAL` 与 `MIDDLEWARE_GLOBAL_ROOT` 的重复实现，无判据 → 直接改变了 W3b 的落点裁定（D.3·35）。

### H.4 三桶（两份评审合并，主控裁决后）

**本 PR 内可改完**：① W3b 跨端常量收口（D.3·35）；② 两处失效注释订正（D.3·39）；③ ~~`server/shared/interface.ts` 删 6 个零消费者端口类型的转出~~ **未做，转 H.5 裁决**（终态复核实测这一族比原先估计大：另有 12 项只被测试消费、6 个 `releaseXxx` 死导出、`workspace/interface.ts:26/28` 三条重复转出、`ServerStatus` 完全死类型——合并成一笔更合适）；④ `service-contract-wiring.test.ts` 注释订正——**已随 `68167e8` 完成**，用的是终态实测值（14 个 unit 文件带 pragma；口径订正见 H.3·1）；⑤ `makeRoutes` 的 `_cwd` 在 PR 正文显式登记「公开签名不变、lint 靠 `_` 前缀」。
**合并前 follow-up**：⑥ 摘 `@ts-nocheck`（分两批，先 4 个低风险文件）；⑦ 给 limits 族 + 两个默认值补字面量值锚；⑧ 弱断言升级（最小集合 unit-apply 7 + unit-hotspot 1 + unit-manager 5）；⑨ `test/tsconfig.json` 的 exclude 收窄（先用一次 `tsc -p test/tsconfig.json` 探明 `TS2717` 是否同样命中 `cross-end-lock`）；⑩ I7 的 3 处 legacy 字面量重复收口（D.3·38）；⑪ `server/shared` 单消费者放宽显式登记（`paths.ts`/`file-io.ts`/`compose.ts` 三族）。
**遗留汇总（须单个 issue）**：⑫ **入口导出面 159 → ≤5**（D.3·36，红线，建议与 #769、I8① 清零并排）——**维护者尚未裁决，本 PR 按默认 C 只登记、不动手**；⑬ I4②/I5/I7 三条不变式的**机器判据**（今天只算不判——没有判据，本次所有收窄都会被下一个会话漂回去）；⑭ smoke 的 88 处 `clientSrc` 源文本断言分类（与 §8.4「仅一处」口径冲突）；⑮ ~~mutation-topology 的 0 命中 pattern 判据~~ **已单开 #837**（跨包：26 处 `!…/src/types.ts` 占位 + 逐份 conf 的「命中 ≥1 文件」腐烂判据 + `defaultSegmentExcludes` 退役 + `src/client/**` 按包显式登记；判据必须与清理**同笔**落地）；⑯ I8②/I8③ 执法点；⑰ `vi.mock("node:fs/promises")` 是否纳入 skill 例外清单；⑱ 测试导入面收窄（I8① 13→0，B3 作业单见 H.2·2）。

### H.5 终态评审（2026-09-15，两份；主控复核后入档）

**方法**：服务端暴露面与测试/变异面各由一名**只读** agent 执行；两者都未写任何仓库文件，都在 `git archive HEAD` 物化到 `/tmp` 的快照上自写解析器/脚本分析。服务端那份自证了解析器两处修正（行注释里的 `agent/*` 被误判为块注释起点、语句终结符少数 [[BT]}`——修正后与人工 `cat -n` 逐文件核对一致：catalog 47 / api 12 / inject 4 / 入口 155+4=159）。

**总判断（两份一致）**：W11 四刀把**值面**暴露收干净了——14 叶子模块 / 15 值边 / 两类环 0/0 / I2① 0 / `directImpl`·死声明·deps 值 import 全空；7 份 `deps.ts` 的 **66 条 Pick 引用零个「声明了不用」**。剩下的全是**类型面/转出面**问题。

**在本 PR 内落地的两条（`a0e170a`）**：

1. **6 个端口持有者的三条装配守卫补测**（`test/unit/ports/*.test.ts`，29 files / 1240 tests）。原先 `get()` 未装配抛错、`install()` 重复装配抛错、`release()` 复位三条路径**全仓零覆盖**，而 6 个 `impl/service/index.ts` **都在变异面内**（catalog/pipeline→runtime 段、inject 与 connection/runtime/impl→middleware 段、orchestrator→manager 段、api→routes 段）→ 评审推断约 **18 个存活变异体**。装配/卸载**走门面**（让 6 个 `installXxx`/`releaseXxx` 从死导出变成被覆盖），`get()` 白盒直连持有者（I8 允许 unit 直连 `src/server/<域>/impl/**`）；`--min` 23→29、`vitest.stryker.d` 测试面同步 +6。**反例自证 3 域**（catalog 重复装配 throw / inject 未装配 guard / runtime 的 release 复位）逐条「改前必红、还原后 sha256 一致」；**主控另独立复现了 catalog 一条**（1 failed / 2 passed，还原后 sha256 = 7a8befdc… 与改前逐字节相同）。
2. **`ManagerLite.stats` 转必填**（`connection/runtime/deps.ts`）：它曾是 7 份 `deps.ts` 里**唯一的成员级可选**，与 I6 正面冲突；生产侧唯一构造点 `orchestrator/manager.ts:69/:109` 恒有值，4 处测试假体补齐。**一处如实保留（评审的建议前提不成立）**：`supervisor.ts:311` 的 `opts.stats?.recordCall?.(…)` **未动**——该 `opts` 是导出工具函数 `buildToolDefinition` 的可选选项包，改必填直调后包 `typecheck` 报 **TS18048** 且包 `build` 失败（实测并还原），故它不是「已无效的守卫」。

**主控未采纳为「本 PR 内改」的三条（理由）**：

- **删 12 项零消费者转出**（6 个 `releaseXxx` + `server/shared/interface.ts` 的 6 个端口类型 + `workspace/interface.ts:26/28` 三条重复转出 + `api/interface.ts:36 queryParam`）：前 6 个 `releaseXxx` **已被上面的补测覆盖、不再是死导出**；其余 6 项是纯形态（类型面、无运行时），删它们要动 6 个门面 + 全量 `--write-baseline` 重写基线，与本 PR 主题（按域重构）无关 → 转 H.6。
- **`ServerStatus` 下线**：它是**完全死符号**（`api/impl/health/type.ts:8` 定义、`api/interface.ts:45` 与入口 `:922` 转出，**无生产者也无消费者**），但它在入口 159 面内 → 属公开 API 变更 → 归 H.4 ⑫ 那一笔。
- **`compose.ts` 的接线**：`bindHost`/`assemble`/`safeDisposeAll` 在 `src/` 里**零调用**，`upgrade` 也是 `src/index.ts:564/565/646` 直接 `releaseUpgrade()`/`await installUpgrade()` —— **D.2·50 拍板③「`assemble` 只驱动 `upgrade` 的生命周期」的字面要求未落地**。接线要动入口装配套路与释放语义（`assemble` 的 `DomainSpec` 形态与当前「静态 `installXxx(deps)` + 命名空间端口」是两套形态），属 B3 或单独立项；**本 PR 只把失实注释订正为事实**（`real-context.test.ts`，`68167e8`）。

### H.6 终态评审新登记（主控裁决：不在本 PR 动）

1. **`compose.ts` 是「已交付但未接线」的机制**（P1，需裁决）：三函数在 `src/` 零调用；唯一消费者是 `server/shared/interface.ts`（转出）与 `real-context.test.ts` 的**夹具域** → 变异分不丢，但「测的是产品不使用的机制」。处置二选一：**接线**（入口改走 `bindHost → assemble → ctx.effect(() => safeDisposeAll)`，需把各域 `installXxx(deps)` 收敛成 `DomainSpec` 形态）或**收窄/删除**（承认静态端口不需要这套机制）。**这一事实已写进 PR 正文**。
2. **静态端口的释放语义需要一句话**：组合根不释放静态端口（它们无活资源、只有装配标记），故 6 个 `releaseXxx` 在 `a0e170a` 之前是死导出、之后由单测覆盖。v5 §3.2 写的是「`installXxx`/`releaseXxx` 配对」——本 PR 按「保留配对、由单测覆盖」处理。
3. **`connection/interface.ts` 承载了 api/catalog 的两张主机面**（`RoutesManager`→api、`SupervisorLite`→catalog），该门面 4 条 `import type`（`:16 SseHub`、`:17 ClientUiConfig`、`:18 ServerConfig`、`:19 McpStore`）全部只服务这两张面 → **connection 域替 api 背下了对 `store`/`config` 的类型依赖**。裁决：**保持不动**（都在 I2 允许的类型边内），但**门面头注释要写明这一点**（B3 执行，本 PR 未改）。
4. **`ManagerLite`/`MiddlewareHost` 落 `connection/runtime/deps.ts` 打破了「`deps.ts` 只 import 上游门面」的单一语义**（`:29/30/31` 还 import 本子层 impl 的 `type.ts`）；评审建议迁到 `impl/middleware/type.ts`（与 `ProjectUnit`/`ConnectionEntry` 同址）后 `deps.ts` 回归纯 Port → 留 B3（迁移会再动一次该子层门面链）。
5. **`impl/<块>/type.ts` 的落点问题**：`api/impl/health/type.ts` 只为死类型 `ServerStatus` 而存在（随 H.4 ⑫ 下线）；`catalog/impl/entries/type.ts` 的 `CatalogServer`/`CatalogTool` 主消费者是 `search.ts` 而 `entries/index.ts` 自身零引用（建议随 `search` 进 `impl/search/`）。另有 **5 个 `impl/<块>/` 只有 `type.ts` 没有 `index.ts`**（`api/impl/health`、`catalog/impl/search`〔刻意偏差，有注释〕、`config/impl/{model,ui}`、`connection/runtime/impl/middleware`）——块目录语义不一致，属 G10（无判据）。
6. **共享层准入核对（I5）**：`server/shared` 10 项达标、**7 项 =1 域**（全是 upgrade 单消费者：`catalogDir`/`ensureDir`/`LEGACY_LAYOUT`/`legacyFile`/`readTextFile`/`versionFile`/`writeFileAtomic`）、**13 项零消费者**（6 个路径名常量 + 7 个宿主端口类型）、12 项只被测试消费；`src/shared` 9 项达标、9 项 =1 域（含已知放宽 `ROUTE_FENCE`）、**5 项全仓零消费者**（`FloatBreakpoint`/`RectLike`/`ViewportPoint`/`SseFrame`/`RouteFence`，后两者在入口面内）→ 与 D.3·13 的「三例」建议**合并做一次准入核对**，照 `compose.ts` 的写法显式登记放宽，而不是逐例记账。
7. **落盘原语仍未单源**（I7 残留变形）：`paths.ts` 已单源（store/stats/catalog 四个写面都改经门面），但 `server/shared/file-io.ts` 的 `writeFileAtomic`/`ensureDir`/`readJsonFile`/`readTextFile` 仍**只被 upgrade 消费**——`store.ts`/`middleware-state.ts`/`collector.ts` 各自 import `node:fs` 直写。
8. **测试面（B3 作业单，终态版）**：
   - I8① **13 条**：8 个文件共 **26 条 import** 可纯改 specifier 收窄；**5 个文件的用例必须整段搬 `test/integration`**（`apply`/`resolveDebugConfig`/`resolveMiddlewareMode`/`makeMiddlewareHotSwitch` 只存在于入口、无第二出口）。**收窄后只从入口传递可达的 src 文件有 79 个**（含全部域）→ 改写时必须逐域补回门面 import，否则变异段会失去加载者。
   - `@ts-nocheck`：**16 个 pragma 文件**（口径见 H.3·1）；最省摘除顺序已由评审给出（workspace/transport 下界 0 → call-stats/store/shared 各 1 → … → manager2/middleware 各 20 → helpers → smoke）。
   - 弱断言：`toBeTruthy()` **216** / `toBeUndefined()` **82** / `toBeDefined()` 2 / 快照 0；**装饰性用例点名 5 处**（`unit-apply.test.ts:270-272` 的「卸载不抛」是入口整条卸载链的唯一断言 → 应改成「7 个 disposer 各调用一次 + 顺序」；`unit-manager.test.ts:188/215/244/269`；`unit-manager2.test.ts:2175` 墙钟；`unit-catalog.test.ts:262` 恒真 id；`unit-hotspot.test.ts:368` + `unit-middleware.test.ts:449` 占位式）。
   - 无值锚常量 **11 条**（limits 族 + `DEFAULT_RESULT_TRUNCATE_BYTES` + `DEFAULT_Z_INDEX_BASE` + `MCP_GUIDANCE` + `EMPTY_STATUS_COUNTS` + `ROUTE_FENCE`）。
   - `test/tsconfig.json` 的 `exclude: ["e2e/**"]` 使 **`cross-end-lock.test.ts` 不在任何编译面**（它没有 pragma）；但**收窄 exclude 不是分钟级改动**——该文件同样静态 import `lib/index.js`，很可能同样触发 TS2717，**先探明再动**（H.4 ⑨ 的口径订正）。
   - `smoke` 的 `clientSrc` 源文本断言实测 **85 处**（此前口径写 88；`.includes(` 58 + `readFileSync` 25）。
9. **变异面剩余存活体（评审静态推断，未跑 stryker）**：入口卸载清单（`src/index.ts:637-646` 七条 disposer 只被「不抛」覆盖，约 6–8 个）；`ROUTES` 的 10/11 条路径字面量**在变异测试面内无锚**（唯一锚 `cross-end-lock` 不在变异面；runtime 段约 10 个 StringLiteral）；`SSE_FRAMES.summary` 同理；`compose.ts` 只被夹具驱动。**`a0e170a` 已消掉 6 个持有者的守卫类存活体**。
