# dsh-worktree-sidebar 设计方案与调研结论

> 状态：**已实施**（包未发布）。方案已过三轮独立评审，逐轮实现与复核台账都在本文；当前处置见 §24，本地门禁与 CI 读数见 PR #819 的回复评论。
>
> 架构速览（TOGAF 4A 四视图）见 [docs/architecture/dsh-worktree-sidebar.md](../architecture/dsh-worktree-sidebar.md)；面向使用者的包文档见 [packages/dsh-worktree-sidebar/README.md](../../packages/dsh-worktree-sidebar/README.md)。

**怎么读这份文档**（多轮实施 + 多轮复核沉淀，全文 1600 余行）：

| 区 | 节 | 性质 |
|---|---|---|
| 设计与决策 | §0–§14 | **现行**：调研结论、决策记录、降级预案、验收标准、目录与行数约定、门禁口径、退役条件 |
| 过程台账 | §15–§24 | **按轮追加**：每轮写明触发 / 做了什么 / 偏差 / 读数 / 遗留，不覆盖之前结论 |
| 现场速览 | §17、§21 | **交接快照**：会话压缩后接手用，数字不回改 |
| 当前处置 | §24 | **最新**：维护者第十轮五条反馈的逐条处置 |

历史轮次台账**刻意留在本文件内**：每轮的编号（§19.3、§20.7.5、§21.6 等）是评审与实现之间的事实语言，搬运会切断引用。已归入 archive 的是被本文替代的旧材料（见 §19.0 的指向）。

## 0. 元信息与版本绑定

| 项 | 值 |
|---|---|
| 调研时间 | 2026-09-14 13:10 CST |
| 适配基线 | @deepseek-ai/dsh **0.1.5-rc.1** |
| 证据根 | /home/tangyi/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/* |
| dsh-client-ui-slots 副本 | /tmp/782-probe2/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-slots@0.1.5-rc.1_.../（该包未随 npm 分发） |
| 仓库起点 | origin/main **114d0bd**（2026-09-14；本轮施工分支基于 origin/main **34957b6**） |
| 最后更新 | 2026-09-15（第十轮：维护者复核五条处置，见 §24） |
| 架构图解 | [docs/architecture/dsh-worktree-sidebar.md](../architecture/dsh-worktree-sidebar.md) |
| 工具链 | node v24.19.0 / pnpm 11.21.0 |
| catalog 相关锁版 | cordis 4.0.2；dsh-tools、dsh-system-prompt、dsh-client-ui-slots、dsh-session 等 0.1.5-rc.1 |

**警示：本文所有行号引用基于 dsh 0.1.5-rc.1。升级 rc 后必须重新核对行号与契约，再动手实施。**

## 1. 目标与定位

过渡适配层。给 agent 三个工具，把某个 git worktree **登记给当前会话**，使该会话的官方右侧栏文件树（Files tab）根指向该 worktree 的内容。**会话 cwd 不变**。官方若推出原生 worktree 会话能力即退役。

不做：不替官方实现 worktree 会话 / Workspace（R3 已否决，官方明确不做再评估）。

## 2. 决策记录（用户拍板）

| # | 决策 |
|---|---|
| D1 | 定位为过渡适配层，不替官方实现 worktree 会话能力 |
| D2 | 入口只给 agent 工具，不做 UI 主动探测 |
| D3 | 只换目录根：会话 cwd / workspace 一律不变 |
| D4 | 复用官方组件，不重写树 UI |
| D5 | worktree 路径与命名由运行时 agent 决定，插件不设目录约定 |
| D6 | 工具名用全称带前缀：ws_worktree_register / ws_worktree_create / ws_worktree_remove |
| D7 | 清理用独立工具；默认只摘登记，删目录需显式参数；只允许 git worktree remove |
| D8 | MVP 只做换根；git 状态标记、提示词 section 留第二切片 |
| D9 | 绑定存储自建 bindings.json，位置参考 notifier 包私有目录 |
| D10 | 客户端接口只提供单会话 GET，不提供列表 |
| D11 | 暂不进 dsh-plugins-all 聚合包 |
| D12 | 接受新增 catalog 条目 @deepseek-ai/dsh-api-workspace-files |
| D13 | 客户端形态取 (d)：接管 files kind，并要求降级预案 |
| D14 | 工具按 agent 作用域注册（只对 git 仓库会话暴露）+ 执行期兜底校验 |
| D15 | MVP 不注入系统提示词；关键信息由工具 description 与返回文本承载 |
| D16 | 计划归档到 docs/proposals/worktree-sidebar.md |
| D17 | 实施参考 notifier 分层；单文件行数受控；不新增技术债务；客户端同样审视架构 |
| D18 | 方案文档必须写清调研时间与版本 |

## 3. 可行性调研结论（关键事实 + 证据）

### 3.1 为什么不能只靠配置换根

- 原生文件树根 = `useSessions(s => s.byId[sessionId]?.cwd)`，无配置面（dsh-client-ui-sidebar-files/lib/client.js:421-441）。
- Host 的 `list` 用 **Session header.cwd** 作 root 并 confine，越界抛 `workspace-file/outside-workspace`（dsh-api-workspace-files/lib/index.js:499-512、566-573）。
- `SessionHeader.cwd` 创建后不可变：`Session.header` readonly、persistence 无 header 更新接口；workspace attach 要求 realpath 相等；显式 id 收养不同 cwd 抛 `ApiSessionCwdConflict`（dsh-workspace/lib/types/types.d.ts:51-69；dsh-api-session-controller 的 agent/session 命令面）。

### 3.2 换根的两个可编程切入点

- **宿主**：`ctx.typert.lookups.configure("workspaceFileScope", resolver)` 可整体替换 sessionId to workspaceRoot 的解析（dsh-typert-protocol/lib/types/types.d.ts:375-383；实现 dsh-typert-registry/lib/index.js:176-213）。官方自用先例：dsh-api-session-controller。
  - 同一个 scope 被 `read`/`stat`/`list`/`changes` 共用（dsh-api-workspace-files/lib/index.js:399、488、499、522），且相对路径以 `workspaceFileScope.workspaceRoot` 作 cwd 解析（:579-586）——**改一处，四个方法一起跟随**。
  - **fail 语义（重要）**：resolver 抛异常 → `gateway/lookup-failed`；返回 undefined → `gateway/lookup-not-found`。两者都是**调用失败**，不是回退（dsh-api-gateway/lib/index.js:863-877）。catch 必须写在 resolver 内部。
  - configure 生效期间 `get()` 返回我们的包装 resolver；**disposer 之后官方默认原样恢复**（dsh-typert-registry/lib/index.js:189-213）。二次 configure 抛 `already configured`。
- **客户端**：接管 `files` kind（`priority: "extension"`，官方为 builtin），并搬运官方 entry 的 `component/inject/store/locale` 到自己 key 的 entry 上（tab 注册表 tab-registry.d.ts:18-22、144-151；StoredEntry 形状 ui-slots index.d.ts:464-485）。

### 3.3 客户端接管的关键契约（评审修正后）

- body 座位按**当值类型的 id** 分发：`types.find(d => d.kind === tab.kind)` 后取 `definition?.id` 作 entryKey（dsh-client-ui-sidebar-right/lib/client.js:718、736-737）。
- 官方 id 可运行期读出：`ctx.sidebarRightTabs.get("files")?.id`（tab-registry.d.ts:170-175）。**无需内联 FILES_ID 字面量，消除了原以为必然存在的漂移债务。**
- 注册顺序**必须先 body/title、后 kind**；否则座位无当值 entry，每个 files 页签显示 fallback——`ui-sidebar-right` 给该 seat 的 fallback 是 `t("tab.unavailable")`（sidebar-right/lib/client.js:755-759；renderer 决策点 lib/client.js:826-829）。
- `options.inject` 是**工厂函数**：`inject: (...args) => I`（ui-slots index.d.ts:602-604；renderer 直接 `inject(...args)` lib/client.js:333-339）。写成对象会在首次渲染抛 TypeError。
- 注入必须写成 `{...officialInject(sessionId, actions), hooks: {sessions: src}}`（renderer 的 bindInjectSources 只认 hooks/keyedHooks，lib/client.js:342-357）。
- entry 级 hooks 的展开顺序 `{...kit, ...injected, ...slotInjected.props, ...ownerProps}` 使得 injected 覆盖框架注入（renderer lib/client.js:644-650）——这是覆盖 `useSessions` 的机制。
- hooks 源契约 = uSES `{getSnapshot(), subscribe(fn)}`（ui-slots renderer.d.ts:32-33）；**getSnapshot 必须返回引用稳定的缓存快照**，否则每次渲染都触发更新。
- root hook `sessions` 受 `copyUnique` 保护、全局唯一（renderer lib/client.js:1379-1387）⇒ 伪造**只作用于本 entry**，预览/命令面板/@ 等其它 useSessions 消费方仍拿真实 cwd。
- 订阅与健壮性 API：`ctx.slots.subscribe(key, fn)`（dsh-client-ui-renderer/lib/types/client/registry.d.ts:197）、`ctx.slots.entriesOfSlot(key)`（同文件 :164）、`ctx.slots.onEntryError`（同文件 :182）。
  **本文原先在这里写的 `ctx.slots.isLive(entry)`（引 `dsh-client-ui-slots` 的 index.d.ts:605-612）是错的**：运行时的 `ctx.slots` 是 `dsh-client-ui-renderer` 的 `SlotRegistry`（同文件 :46 `class SlotRegistry extends Service`、:84 `register = SlotCore['register']`），公开面**没有 isLive**。照那个类型包写出来的客户端在真机上第一次求值就 `TypeError: slots.isLive is not a function`。存活性判据就是 `entriesOfSlot` 的返回集合本身——它给的是「每个 cell 当前生效（非 abdicated）的那一条」。

### 3.4 工具与可见性

- `ctx.tools.register(definition)` 是公开 API；`ToolDefinition` **没有** enabled/visible/hidden/when 字段（dsh-tools/lib/types/index.d.ts:106-172），但装配按 **agent 作用域**解析 schema（dsh-tools/lib/index.js:2609；scope=agent，dsh-agent/lib/types/dispatch.js:92-93）。
- 官方先例：监听 `agent/created`、过滤 `ctx.agents.roots()`、把工具注册进 `agent.ctx`（dsh-schedule/lib/index.js:1450-1464，注释明确 "only for root agents published after this plugin loads"）。
- `ToolDefinition.output` 必备；`exec.agent` 是可选字段（dsh-tools/lib/types/index.d.ts:208），必须 `exec.agent?.session`，缺失时明确失败。
- `tools/pre-execute` 只能 allow/deny/ask，deny 的 reason 成为模型看到的错误文案（dsh-tools/lib/index.js:3127-3138）；**不改变模型可见的工具集**。
- systemPrompt.section 的 text 可为 `(context) => string`，每次装配重求值、可读 scope；空串被丢弃（dsh-system-prompt/lib/types/index.d.ts:47-68、233；官方条件渲染先例 dsh-tool-web/lib/index.js:259）。MVP 不使用（D15），留作第二切片。

### 3.5 dsh 无 git 能力

全量检索无 simple-git/isomorphic-git/nodegit，无 git 服务或工具；git 只能由本插件通过 shell 调用（用 execFile + argv）。

## 4. 方案设计

### 4.1 宿主端（五个域 + 组合根）

| 域 | 职责 |
|---|---|
| binding | bindings.json 的读写与校验；revision 单调递增；按会话索引 |
| git | 查询 worktree 真实状态（注入 exec 面，不在域内起子进程） |
| scope | 接管 workspaceFileScope：命中绑定则返回 worktree，否则委托官方默认 |
| tools | 三个 agent 工具的注册与执行期兜底（agent/created 触发） |
| api | loopback 只读路由：单会话绑定查询 + health |

存储：`<DSH_HOME>/@wingsky-1/dsh-worktree-sidebar/bindings.json`，结构 `{version, revision, bindings: {[sessionId]: {repoRoot, worktreeRoot, branch, createdAt}}}`；临时文件 + rename 原子写（参考 notifier 的 file-io 模式）；损坏当空表。

路由：`GET /api/dsh-worktree-sidebar/bindings?session=<id>` 返回 `{revision, worktreePath|null}`（**不回 repoRoot**，最小暴露）；`GET /api/dsh-worktree-sidebar/health`；path 走构建期 `__DSH_ROUTES__`；复用 `shared/loopback.js` 围栏与 `guardLoopbackMethod`（403 先于 405）。

### 4.2 客户端

1. 探测官方 files 类型与 entry：`ctx.sidebarRightTabs.get("files")?.id` + `entriesOfSlot` 找该 id 的 entry，取 `component/inject/store/locale`。
2. 未就绪 → 订阅等待；**任一步失败即零注册**。
3. 先注册 body/title entry（key = 我们的 id），再注册 kind（接管 files）。
4. 注入 `{...officialInject(...), hooks:{sessions: 我们的稳定快照源}}`，快照源按会话把 `byId[id].cwd` 改写为绑定路径、其余字段透传。
5. 绑定经路由拉取，按 revision 缓存；不一致时按 G7 处理。
6. 官方 entry 变化时**重捕**（不是退场）；官方包确实缺失才退场。

## 5. 降级预案 G1–G9（含评审修正）

| # | 触发 | 动作 |
|---|---|---|
| G1 | 抓不到官方 entry/component（未就绪、结构变化、超时） | **零注册**：不注册 body、不注册 kind |
| G2 | body 注册失败 | 立即 dispose 已注册部分；kind 绝不注册 |
| G3 | 接管成功后官方 entry 变化（卸载/重载/HMR） | **重捕** component/inject/store/locale（从 slots.entries 读），仅在官方包确实缺失时退场；加去抖/两次确认避免 HMR 窗口误退；用 `ctx.slots.isLive` + `subscribe` |
| G4 | resolver 内部任何异常 | catch 在内部，**永不抛出**、返回与官方默认**同形**的值（官方在 header 缺失时确实返回 `undefined`，等价实现必须照抄）。**接管资格判定改为 try/catch `configure`**：实测 `lookups.get()` 无法区分「只有官方 register」与「已有别人 configure」——两种情形下它都返回带 `resolve` 的对象（dsh-typert-registry/lib/index.js:176-188），只能靠 `configure` 自身在已配置时抛 `already configured`（:191）来判定，捕获即放弃接管并 warn |
| G5 | worktree 目录消失或已非该 repo 的 worktree | 按未绑定处理；revision++；客户端改回真实 cwd |
| G6 | 客户端拉不到绑定 | 保持上次成功态并显示明确错误态（不是静默不改 root） |
| G7 | 双端 revision 不一致 | 宿主 resolver 与 bindings 路由**读同一内存快照**；客户端 revision 不符时不改 root 且显示明确错误态 |
| G8 | 我们的 hook 源异常 | getSnapshot 内 try/catch 返回真实快照；**自建 `ctx.slots.onEntryError` 订阅作为降级信号**（静态组合下 owner 索引为空，崩溃只进 console，不会归因到本包） |
| G9 | 第二家 extension 抢 kind | tab 注册表抛错则 catch + warn，不做任何事；**slot 侧行为不同**（同 key 同 priority 才抛错，否则静默按 priority 决胜），需显式指定 priority |

补充的硬约束：

- **撤 kind 与撤 entry 必须写进同一个 ctx.effect 的返回 disposer**：cordis `fiber._unload` 用 `clear().map(async…) + Promise.all` **并行发起**，只保证 LIFO 发起、不保证完成顺序（cordis/lib/index.js:1371-1382）。
- **半成品态必须自愈**：kind 已注册而 entry 未注册 → 主动 dispose kind；反向 → dispose entry。注意 renderer 的变更路径是 catch 后 `queueMicrotask(() => { throw })`，**catch 抓不到延迟失败**（lib/client.js:1047-1060）。
- **store 共享语义**：同一 handle 同 scope 允许多 entry、跨 scope 抛错（ui-slots index.d.ts）⇒ 只能共享官方 handle，两个 entry 交替 winner 时会看到对方残留 state。
- **disposer 幂等**：stale disposer 安全 no-op（ui-slots:146-151）。

## 6. 显式非目标与已知不一致清单

必须写进 README 与验收标准：

- `@` 文件引用、`present` 落点、skill catalog 仍锚 `session.header.cwd`，不随视图根走。
- `workspace-write` 文件策略下 **agent 写不进 worktree**（写围栏 `sandboxPolicy.workspaceRoot` 同样取 header.cwd，且该服务不可被第三方替换）。
- 主 checkout 与 worktree 的同名文件在预览里**没有差异标记**。
- 树根 = worktree、执行 cwd = 原目录：这是本方案的语义前提，不是缺陷。
- 伪造 sessions 只作用于本 entry：其它 useSessions 消费方（预览、命令面板、@）仍显示真实 cwd。
- **没有自动跟随**：客户端不再轮询宿主，右侧栏页签只在「打开 / 点官方刷新 / 窗口重新可见或获得焦点」
  三种时机重读登记。因此「登记完树就自动变」不成立——工具文案与 README 一律写「打开或刷新 Files 页签」。

## 7. 验收标准

**可自动打红（宿主与契约层）**：

1. binding：原子写、损坏文件当空表、revision 单调、按会话索引。
2. scope resolver：命中绑定返回 worktree；目录消失按未绑定；内部异常仍返回官方同形值；dispose 后官方默认恢复；二次 configure 场景放弃接管；provider 未注册时**等待而不自造默认语义**；子 agent 会话在本会话无登记时继承父链上的生效根（到顶即停、防环、父登记失效即回退 cwd）。
3. git 域：worktree 归属查询（注入 exec 面，可断言 argv）。
4. tools：schema 形状（output 必备）、agent 缺失时明确失败、argv 构造（branch 过 check-ref-format、positional 前加 --）、path 校验。
5. api：403（非回环）/405（方法错）/health；只回单会话且不回 repoRoot。
6. client 契约：抓不到官方 entry 时**零注册**的负向断言；以官方 id + 更低 priority 遮蔽正文（当值自检：不当值当场退位）。

**只能靠隔离真机（dsh-verify-isolated，不在任何 gate:*，标为发布前人工证据）**：

1. 文件树列 worktree 内容（打开或刷新 Files 页签之后）。
2. 点开文件预览读的是 worktree 里的文件。
3. 未登记会话与未装插件时行为一致。
4. 子 agent 会话的树根跟随父会话的登记。

## 8. 目录树与模块职责

```
packages/dsh-worktree-sidebar/
  AGENTS.md  cordis.patch.yml  package.json  tsconfig.json  README.md  README.en.md
  src/index.ts                       组合根：收窄宿主上下文 + assemble + 逆序 dispose，零业务
  src/shared/interface.ts            双端共享的收口面（门禁要求：目录被引用必须有 interface.ts，见 §19.3）
  src/shared/contract.ts             双端共享契约：ROUTES（客户端经构建期 __DSH_ROUTES__ 取）/ 响应字段名
  src/server/host/agents.ts          宿主适配：agent 事件面（subscribe / list / publish）收窄
  src/server/host/typert.ts          宿主适配：typert lookups 收窄（读 / 配置 / 订阅）
  src/server/host/sessions.ts        宿主适配：会话父链（只读「父会话是谁」，子 agent 继承要用）
  src/server/binding/interface.ts    绑定域入口：install/release 成对 + revision/get/put/drop
  src/server/binding/deps.ts         依赖声明（LoggerPort、文件路径、时钟）
  src/server/binding/impl/model/     纯逻辑与存储形状：校验、revision 递增、按会话索引
  src/server/binding/impl/store/     bindings.json 原子写 + 容错读
  src/server/binding/impl/service/   单例：内存快照 + 串行写盘 + installed 守卫
  src/server/git/interface.ts        git 域入口：install/release 成对 + 能力转发（commonDir / belongsTo / headBranch / checkRefFormat / addWorktree / removeWorktree / listWorktrees）+ gitExec
  src/server/git/deps.ts             注入 exec 面（GitExecPort）
  src/server/git/impl/inspect/       argv 构造与 porcelain 解析（纯函数）
  src/server/git/impl/exec/          真实 execFile 实现
  src/server/git/impl/service/       单例：归属缓存 + installed 守卫
  src/server/scope/interface.ts      scope 域入口：install/release 成对 + effectiveWorktree
  src/server/scope/deps.ts           注入 typert、binding、git、sessions、logger
  src/server/scope/impl/own/         本会话自己的登记是否仍有效（目录没了 / 不是该仓库的 worktree 即摘掉）
  src/server/scope/impl/inherit/     子 agent 自己没登记时沿父链继承（到顶即停 / 防环 / 父摘除即回退）
  src/server/scope/impl/resolve/     合成生效根 + 委托捕获的官方默认 + 承诺永不抛出
  src/server/scope/impl/service/     单例：等 provider / 捕获 / 委托 / 释放 + 状态守卫（S8 起没有 fallback）
  src/server/tools/interface.ts      工具域入口：installTools/releaseTools
  src/server/tools/deps.ts           注入 binding、git、agents、logger、时钟
  src/server/tools/impl/session/     执行期兜底：从 exec 取 sessionId/agent
  src/server/tools/impl/register|create|remove/  三个工具各一文件
  src/server/tools/impl/protocol/    工具输出 schema 与渲染
  src/server/api/interface.ts        路由域入口：installApi/releaseApi
  src/server/api/deps.ts             注入 binding（revision）、scope（effectiveWorktree）、register、logger
  src/server/api/impl/route/         单路由装配（host-utils 的 guardLoopbackMethod）
  src/server/api/impl/handlers/      GET bindings / GET health 两个端点的形状
  src/server/api/impl/service/       单例：已挂路由 disposer 链 + installed 守卫
  src/server/shared/{interface,type,paths,file-io}.ts  共享层门面 / 窄类型 / DSH_HOME 路径 / 原子写
  src/client/index.ts                干净模块：apply/inject + ctx.effect，装配窄面 + 每会话一个 SessionView
  src/client/takeover.ts             探测官方 files entry to 注册 body/title/kind + teardown/evaluate/订阅；失败即 dispose（inject 面的改写见 inject.ts）
  src/client/inject.ts               官方 entry inject 面的改写：给定官方 inject 面与会话 id，产出 hooks.sessions 指向改写源的新面
  src/client/source.ts               本 entry 的 sessions 快照源（改写 cwd，getSnapshot/subscribe 引用稳定）
  src/client/bindings.ts             拉绑定与 revision
  src/client/shared/ports.ts         客户端块间窄端口类型面（运行时真实面为准；client/ 整目录门禁豁免）
  test/unit/**  test/integration/**
```

分层纪律（参考 notifier 与 docs/ARCHITECTURE-METHOD.md:22-40）：

- 组合根唯一：`bindHost` 收窄 ctx 能力 + `assemble` 按依赖序装域并收集 disposer + `safeDisposeAll` 逆序 try/catch。
- 域三件套：`interface.ts`（唯一对外引用面，install/release 成对）+ `deps.ts`（只类型）+ `impl/**`。
- 跨域只注入窄能力（用 Pick / 派生类型），域间禁止直引实现。
- `server/shared/` 叶子化：不依赖任何域。
- 三个同名 `shared` 不同层，别互相搬：`src/shared/` = **双端**共享（宿主与浏览器都必须一致）、
  `src/server/shared/` = 宿主内部叶子、`src/client/shared/` = 客户端块间类型面。
- disposer 归域：域导出 releaseXxx，组合根只收集与逆序调用。

客户端架构纪律（同样按域审视，不是只写一个文件）：

- 干净模块：`src/client/index.ts` 只 export `apply(ctx)` 与 `inject`，卸载写进 `ctx.effect`；禁止 loader 痕迹（DEVELOPMENT.md:352-376）。
- inject 双声明：`package.json` 的 `dsh.client.inject` 列官方客户端包；源码 `export const inject` 列 `slots` / `sidebarRightTabs` / `locale` / `remote`，漏声明会抛 without inject（DEVELOPMENT.md:399-400）。
- `style.css` 非必需：本形态不自绘 UI，官方组件样式随官方产物。
- 幂等与卸载：全部注册走 `ctx.effect`；重复 apply 不得摘除别人的包装。
- 崩溃与失败归因：registrant 会指向本包，必须订阅 `ctx.slots.onEntryError` 辨识是否自己的 entry 并 warn；注册失败一律 catch+warn，dispose 即恢复 builtin，绝不 replace。

## 9. 行数控制约定（**review 提问线**，不是上限）

本仓**没有 max-lines 门禁**（`grep -rn 'max-lines' tools/lint scripts` 零命中，实测 2026-09-14），
下表因此不是判红线，而是**review 时的提问线**：一行超线只触发一个问题——
「这个文件里有几个修改理由？」依据是本仓成文的
`.dsh/skills/dsh-plugin-hub-refactor/SKILL.md:53`「块按『回答不同问题』切，不按代码长度切……
为了行数均衡把两个问题塞进一块，等于让它们共享一个修改理由」。
**可判定的是「几个修改理由」，行数只是它的粗糙代理**。

| 文件类型 | review 提问线 |
|---|---|
| 组合根 src/index.ts | 300 |
| 域 interface/deps | 80 |
| 域 impl 单文件 | 250 |
| 纯逻辑模块 | 120 |
| 客户端单文件 | 250 |

机器强制的质量面交给本仓既有度量，不自造第二把尺子：`scripts/data/gauntlet.config.json` 的
ESLint `complexity`（cyclomatic 78 / cognitive 84，起步值锚定当前最坏函数，收紧路线见 #732）、
CRAP 阈值 16（观察期）、以及变异。本包当前无越界。

**已撤销的指标：「全包 src 合计 1200」。** 它没有出处——只是本节当初拍的估算，参照系里
notifier / mcp-manager 给的都只是**单文件**分位数（中位 44/58、p90 186/373、max 3229/1208），
没有任何「全包合计」的先例或推导。它的性质是**功能数量的线性函数**（第四轮收尾实测 44 文件 x 均值 68），
拿它当上限等于「功能不许长」；而拆分只把行数从 A 搬到 B，**合计不变**，所以它指向不了任何
可执行动作。维护者裁定删除，本文件照办。

参照：notifier src 中位数 44 / p90 186 / max 3229（客户端单文件，属反例）；mcp-manager p50 58 / p90 373 / max 1208。

### 9.1 现状对照（第五轮 S6 后重测；历史偏离已消失）

| 文件类型 | review 提问线 | 实测（S6 后，`wc -l`） | 结论 |
|---|---|---|---|
| 组合根 src/index.ts | 300 | 149 | 合规 |
| 域 impl 单文件 | 250 | 最大 164（server/scope/impl/service；S8 的等待式接管换了原先的 fallback） | 合规 |
| 纯逻辑模块 | 120 | 最大 117（tools/impl/remove）；S9 拆开后 scope 域三块 own 70 / inherit 29 / resolve 53 | 合规 |
| 客户端单文件 | 250 | 最大 182（takeover；inject 150、shared/ports 145、index 117、source 76、bindings 46） | 合规 |
| 域 interface/deps | 80 | interface 19/45/34/21/60（api/binding/scope/tools/git）+ `shared/interface` 8、`server/shared/interface` 11；deps 38/12/18/76/55 | 合规（C1 后门面 = install/release + 能力转发，不再是 8–11 行的纯转出；scope/deps 76 是端口与形状的逐条声明） |
| 全包 src | —（已撤销） | 47 文件 / 3151 行（均值 67；S6 加 `shared/interface.ts`、S8 删两块、S9 加 host/sessions 与 scope/impl 两块） | 指标不存在 |

**历史偏离已消失，不再有「偏离」可议**：

- **interface/deps 的 3 处历史偏离**（git/interface 140、binding/interface 102、scope/interface 82）在
  「类型与装配的物理定义下移 `impl/service`」之后消失——五个域现在同形：门面出 `install/release` 成对动作 + 能力转发
  （19–59 行，C1 之前只是 8–11 行的纯转出；能力面从 `impl` 搬到门面是本轮的反转，见 §18），
  `deps.ts` 是纯类型面（最大 `scope/deps.ts` 78 行，是端口与形状字段的逐条声明，只有一个修改理由）。
  当时提的两种修法（接受 150 / 再拆一层）都不必执行。
- **全包合计**这个指标本身已撤销（见 §9），`2800` / `3000` 一类建议值一并作废，不要再出现在任何判据里。
  当前实测 **47 文件 / 3151 行、均值 67**（旧表的 `2535` 是 `src/host/` 拆分前、`44/2978` 是 B7 拆出 `inject.ts` 之前、`45/3002` 是 S6 之前、`46/3081` 是 S8 之前、`44/3068` 是 S9 之前，均已过期）。

## 10. 债务清单与最小化

| 债务 | 最小化做法 |
|---|---|
| 借用 inspection 面（StoredEntry.component） | 探测收敛在 src/client/takeover.ts（inject.ts 只负责 inject 面改写）；用 get("files")?.id 定位而非内联 id；结构不符即零注册；加负向契约测试 |
| configure 是全局替换 | **实测：官方用 `lookups.register`（providers 表），我们 `configure` 写的是另一张 resolvers 表（dsh-typert-registry/lib/index.js:158-160），两者不冲突**。`configure` 前捕获 `lookups.get("workspaceFileScope")?.resolve` 并委托（此时它正是官方 resolve），**捕获必须在 configure 之前**——configure 之后 `get()` 只回我们的包装，官方 resolve 不再可达。若安装时 provider 尚未注册（`get()` 为 undefined）则**不自造等价实现**：订阅查找表等它出现（先订阅、再重读一次），等待期不接管（S8 决定；原 fallback 已删）。类型层亦确认「配置可先于 provider 注册，dispose 时恢复 provider 默认解析器」（dsh-typert-protocol/lib/types/types.d.ts:381、412） |
| 伪造 sessions 源 | 只改写 byId[id].cwd 一个字段、其余透传；按 entry×binding 缓存，保证引用稳定 |
| 双端 revision 契约 | src/contract.ts 单点定义；GET 回 {revision, worktreePath|null} |
| 绑定与 git 漂移 | resolver 命中前做廉价校验（目录存在 + common dir 相同）带 mtime 缓存；失效即按未绑定、revision++ |
| 遮蔽正文的作用域 | 只作用于 `files` 这一个页签（官方那条仍在账上，其余 kind 与未绑定会话原样走默认）；总开关；失败或不当值一律撤销自己那条 |
| 工具双登记 | binding 域为唯一事实源、register 幂等（先例 mcp-manager middleware-register.ts:806-832） |

## 11. 实施顺序

0. 立尺子：把新包登记进 `scripts/data/gate-scope-registry.json`（verify-dir-imports 段）与 `contract-check.ts` 的 --package 调用点；未登记包 fail-closed 判红，正好以「零违规」作验收。
1. 宿主纯逻辑：contract / shared / binding / git（注入 exec），全部单测、不依赖 cordis。
2. api 域：loopback 围栏 + 403/405 + health。
3. tools 域：三个工具（复用 mcp-manager 的注册与执行期解析先例）。
4. scope 域：先落「捕获委托 + 等价实现」两路 fallback 与对照测试，再 configure；补降级注入用例（provider 缺失、二次 configure 抛错、resolver 抛错、目录消失）。（**已过期**：S8 把「等价实现兜底」换成「订阅等待 provider」，见 §19.6。）
5. 客户端倒着写：先写「抓不到官方 entry 则零注册」的负向测试，再写接管；最后用 @wingsky-1/dsh-verify-isolated 实测。

每片独立跑门禁 + 阶段 commit。

## 12. 测试与门禁

- 单测：`test/unit/**`（纯逻辑，无 cordis）、`test/integration/**`（域装配）。
- 客户端契约：`test/client/**` 断言构建产物（`assertClientSourceContract` / `assertClientProductContract`）。
- 路由必含 403/405 围栏用例与两端路由一致性断言。
- git fixture 用 mkdtempSync + 临时 DSH_HOME；禁用固定 sleep 等 git；端口 listen(0) 且 finally 回收。
- 产物零污染：`git status --porcelain` 不得出现 `undefined/`、`*.jsonl`。
- 新增包 + 新增 catalog 条目 → 走 `pnpm gate:full`。

## 13. 未确认项（实施前需实测钉死）

**已实测钉死（2026-09-14，dsh 0.1.5-rc.1 只读核验）：**

1. **恢复的历史会话会重发 `agent/created`** —— 已证实。链路：web 打开历史会话 →
   `dsh-api-session-controller/lib/index.js:202-230` resolveOrResume → `ctx.agents.resume({resumeSessionId})`
   （:402）→ `dsh-agent/lib/index.js:430-435` resume() → `dsh-agent-loop/lib/index.js:1882-1933`
   resumeWith() → `setupAndPublish(..., "resume", ...)`（:1925）→ `prepared.publish("resume")`（:1858）
   → 发布体 :1712-1726 内 `loopCtx.agents.announce(agent)` → `dsh-agent/lib/index.js:535-557` 发
   `agent/created`。create 与 resume **共用同一 emit 点**。
   **余量**：插件加载**之前**已 live 的 agent 不会补发（dev HMR / 动态装插件存在该窗口），
   故 install 时必须补一次 `ctx.agents.list()` / `roots()` 枚举（dsh-agent/lib/index.js:581-592）。
2. **官方默认 `workspaceFileScope` resolve 已逐行确认**（dsh-api-workspace-files/lib/index.js:372-389）：
   `live = sessions.get(id)?.header`；
   `stored = live === undefined ? await ctx.get("sessionPersistence")?.stat(id) : undefined`；
   `header = live ?? stored?.header`；`header === undefined` → 返回 **undefined**；
   否则 `{sessionId, workspaceRoot: header.cwd ?? sandboxPolicy.workspaceRoot}`。
   `sessionPersistence` 缺省时是**可选链**、不抛错，只是非 live 会话返回 undefined —— 等价实现必须照抄这一点，
   而不是「永不 undefined」。依赖面：`static inject = ["fs","sandboxPolicy","sessions","typert"]`（:351-356）。

**仍未确认（实施 / 真机验证期钉死）：**

3. `hooks.sessions` 的类型面取交是否需要断言（两个 useSessions 类型是否兼容）。
4. 主 checkout 被 `git worktree remove` 时的实际行为。
5. 官方 HMR 重载后重捕的实际时序（需真机）。

## 14. 退役条件

官方提供原生 worktree 会话能力、或「按会话切换文件根」的受支持能力时，本插件退役；README 需写明退役触发与卸载后的 `git worktree prune` 提示。

## 15. 实施进展（逐片更新）

| 片 | 内容 | 状态 | 证据 |
|---|---|---|---|
| S0 | 立尺子：登记 plugins-manifest(standalone) / gate-scope-registry / contract-check --package / ci.yml paths-filter / mutation-topology / gauntlet / ci-face-registry；并修正三处随新包过期的既有断言（stryker 段数哨兵 32 to 33、ci-matrix 的「standalone 为空」、collect-exemptions 的 reviewBy 7 to 8） | 完成 | pack-check PASS；test:scripts 624 pass / 0 fail；pnpm stryker:check 通过；verify-dir-imports 对新包零违规（无基线，fail-closed 模式） |
| S1 | 宿主纯逻辑：contract（双端路由与存储形状单一事实源）/ shared（原子写 `file-io`、容错读、DSH_HOME 路径）/ binding（bindings.json + revision 规则 + 串行写盘防丢更新）/ git（argv 构造与解析纯函数 + 注入 exec 面 + 真实 execFile 实现） | 完成 | test 55 例（unit 34 / integration 21）全绿；其中集成用例在真 git 仓库上验证了 `--` 位置 git 确实接受 |
| S2 | api 域：loopback 围栏 + 403/405 + health + 单会话绑定查询 | 完成 | 单测 17 例；403 先于 405、缺 session 判 400、响应不含 repoRoot 均有断言 |
| S3 | tools 域：三个 agent 工具（按 agent 作用域注册 + 执行期兜底） | 完成 | 单测 21 例 + 集成 9 例（真 git 仓库上走完 创建 to 绑定 to 摘除，并校验 bindings.json 落盘内容） |
| S4 | scope 域：捕获委托 + 等价实现两路 fallback，再 configure | 完成 | 单测 28 例；含「header 存在但 cwd 缺失 to 沙箱根」与「header 缺失 to undefined」两支、失效绑定摘除、configure 已被占用即放弃、resolver 永不抛出 |
| S5 | 客户端：先负向测试（抓不到官方 entry 则零注册），再接管 files kind | 完成（**界面语义未经真机验证**） | 单测 25 例（负向零注册、注册顺序、半成品自愈、重捕、快照引用稳定）；构建产物 lib/client.js 8551 字节，contract 与 pack-check 通过。**三条界面语义仍需隔离真机验证** |

**已知的切片顺序调整**：S0 只保留**宿主端** package.json（`exports["./client"]` 与 `dsh.client` 段在 S5 随客户端源码一起加回）。
原因是 pack-check 会断言 `exports["./client"].types` 指向包内真实文件——提前声明而源码未到，等于让门禁整个 S0–S4 期间判红；
而放一个空客户端占位又违反「不留半成品」。S5 的验收里必须包含「客户端导出与 `dsh.client` 段已恢复且 pack-check 仍 PASS」。

**S1 期间实测补充**（不在原计划，现已证实并写入代码注释）：

- `git worktree add -b <branch> -- <path>` 与 `git worktree remove [--force] -- <path>` 的 `--` 位置**被真实 git 接受**（集成用例覆盖），故「positional 前加 `--`」这一安全措施可落地。
- `git rev-parse --git-common-dir` 返回的是**相对路径**（实测 `.git`），必须 `resolve(dir, value)` 之后再比较；否则「同一仓库的两个 worktree」会被判成不同仓库，归属校验恒假。

**S2–S5 期间实测补充**（不在原计划，现已证实并写入代码注释）：

- **api 域改为依赖 scope 的「生效值」，而不是直接读绑定表**。计划 §4.1 写的是「api 域注入 binding」。
  实施时发现这会在失效绑定上分叉：解析器按未绑定处理（回 cwd），而路由仍回 worktree 路径，
  客户端于是把文件根指向 worktree、宿主按 cwd 解析——表现是每次列目录都得到 `outside-workspace`，
  且没有任何东西会自愈。现在两边读同一个 `effectiveWorktree()`，分叉在结构上不可能。
  这同时把 G5 的「revision++」落成了「摘掉绑定」：摘掉才真的让客户端缓存失效。
- **scope 域的宿主面原来是有损的**。最初的 `DefaultScopePort` 把「活会话存在但其 header 无 cwd」与
  「没有该会话」都压成 `undefined`，而官方这两支的答案不同（前者回落 `sandboxPolicy.workspaceRoot`，后者返回 `undefined`）。
  单测第一次跑就把这条打红了。现在端口传的是 `HeaderFace = { cwd: string | undefined }`，与官方逐行同形。
- **官方客户端座位的真实注册形状**（读 `dsh-client-ui-sidebar-files/lib/client.js:692-711` 得到，已写入测试）：
  正文注册在座位 `sidebar.right.pane.tab`、键是 `FILES_ID`（定义自己的 id，**不是** kind）；
  标题是**另一个座位** `sidebar.right.pane.tab.title`、同一个键；类型定义走 `ctx.sidebarRightTabs.register`。
  因此接管必须注册**三条**（我们的正文 + 我们的标题 + 我们的类型），少注册标题就会让 chip 上没有文案——
  这一点计划 §3.3 只提到了正文与 kind。
- **客户端刷新策略**：每会话一条绑定状态，创建时拉一次，之后每 5 秒拉一次，失败保持上次成功态（G6）。
  没有做 SSE 推送——绑定的变更源只有 agent 工具，5 秒足以在用户下一次用到树之前传到。
  这是 MVP 取舍，若要更低延迟应改成事件推送。
- **存在性判定做成可注入的**（`ScopeDeps.existsDirectory`）：它的两条分支（目录消失 / 读不了）
  在真实权限下无法稳定构造，而「读不了不等于不存在」直接决定用户会不会被永久摘掉绑定。
  默认实现仍是直连 fs，注入点只为让这条语义可被单测打红。

## 16. 独立复核与修复（2026-09-14 第二轮）

复核由一个独立子 agent 执行：自建 worktree（detached @6b5059c）、自跑全部门禁、真机隔离环境实测。
结论：**门禁逐条属实**（含 lint 669/671、155 用例、624 pass、fail-closed 模式；另补跑 `pnpm gate:pr` 为 PASS），
但**不可合并**，发现 4 项必修：

| # | 发现 | 根因 | 修复 |
|---|---|---|---|
| P0-1 | 客户端在真机 dsh 0.1.5-rc.1 上 `TypeError: deps.slots.isLive is not a function`，**零注册、S5 完全不生效** | 端口对着 `dsh-client-ui-slots` 的**类型包**写，而运行时 `ctx.slots` 是 `dsh-client-ui-renderer` 的 `SlotRegistry`（无 isLive）；假端口测试只证明「代码与假设一致」 | 删掉 `isLive`，改用 `entriesOfSlot` 的返回集合判存活；端口注释写明「必须对着运行时面写，不是对着类型包写」 |
| P0-2 | 接管后官方 guide 条目归零：**所有会话**（含从未登记的）默认页签从 Files 变成空的 Guide | 注册的类型定义只写了 4 个字段，丢掉官方定义里的 `guide`，而官方注册表 refresh 后用**在册定义**重算 guide | 改为整份搬运 `{...官方定义, id, priority}`；补「guide 被原样搬运」与「撤销后 builtin 复位且 guide 回来」两条断言 |
| P1-1 | G3「官方 entry 变化即重捕」在真实注册表语义下**恒不触发**（复用旧组件与旧 inject 闭包） | `tabs.get(kind).id` 在接管成功后返回的是**我们自己的** id，于是「官方条目还在不在」变成了问自己 | 首次发现时记下官方 key 并一直用它；测试的假注册表改为真实语义（extension 顶掉后 get 返回我们的 id） |
| P1-3 | 新增 5 处模块级可变单例，且落在 module-state 门禁扫描面之外 | 四域 + tools service 各有一个 `let installed` | ~~五处全部改为工厂~~ **第四轮反转**：改为门面 `install/release` + 能力转发（见下） |

**第四轮对 P1-3 的反转（2026-09-14）**：工厂是**当轮**为避免模块级可变单例而选的形态，本轮按仓库 skill 与
维护者裁决改掉，理由与代价都记账在此：

- **依据一（明文形态）**：`.dsh/skills/dsh-plugin-hub-refactor/SKILL.md:112-115`「**有状态的才用 `class`**，配一个
  导出单例（类不外放，外面 `new` 不出第二份）。无状态的用纯模块函数」「**不用闭包工厂**：能力经构造签名摊开，
  而不是藏进词法环境」；`:215` 自检清单同样列着「宿主端没有……闭包工厂」。
- **依据二（维护者裁决）**：「最小化暴露，不能暴露工厂，只暴露能力」。
- **改成什么**：每个域的门面（`interface.ts`）出 `install<Domain>/release<Domain>` 成对动作 + 能力转发；
  `class` 与其单例留在 `impl/service` 内部，不外放。参照 notifier：`config/interface.ts:7` 的单例只 import
  不 re-export，门面出 `installConfig/releaseConfig` + 读写能力。
- **代价（显式登记，SKILL §7.5）**：C1 作废「同进程两份实例互相独立」的三条既有用例及其语义，
  生产语义由「互不污染」变为「**第二份挂不上并抛错**」。替代判据见 §5「被删除的保证与替代」，
  完整分档见 §18。

**验证**：把本包加进 `forbid-module-state-src` 范围后实跑探针 → exit 0、本包零条目（P1-3 修掉）。
修复后 11 项门禁全 exit 0，测试 156 例（10 文件）。

**复核者独立实测成立的主张**（作者原先只在纸面上断言）：
`--` 位置真被 git 接受；`--git-common-dir` 在仓库根返回相对路径、在 linked worktree 返回绝对；
`git check-ref-format --branch` 拒绝 `-` 开头且非仓库 cwd 可用；创建→绑定→摘除端到端与 bindings.json 内容一致；
**写盘失败时 ok:false、revision 仍 0、get() 为 undefined**（内存不前移成立）；
S0 的三处既有断言修改均为**必需同步、非放宽**（ci-matrix 的真实不变量由 `plugins-manifest-lib.ts:110/120/169/236` 分守）。

**行数预算（§9.1）——第四轮裁决（推翻本条原建议）**：原建议「接受 `interface/deps ≤150`，不拆 `impl/service`」
与「全包合计登记 3000 作观察阈值」**均已作废**：

- **不拆 `impl/service` 这半句仍然成立，但前提变了**：`interface/deps ≤150` 这个放宽不再需要——历史偏离
  随「类型与装配下移 `impl/service`」一起消失，五个门面实测 8/8/8/11/11 行，`deps.ts` 最大 78 行。
  也就是说，当时的判断（各文件只含 1 个决定 + 若干转发）**已被现状证明**，不需要靠放宽上限来容纳。
- **「全包合计 3000 作观察阈值」整条撤销**：该指标已从 §9 删除（无出处、拆分修不掉、指向不了动作），
  观察阈值一并作废，`2800`/`3000` 这类数字不要再出现在任何判据里。

**仍未验证**：三条界面语义（第 1、2 条因 P0-1 当时不生效而无法验证；第 3 条之所以成立是因为插件整个没跑，
而 P0-2 表明它当时本来就会失败）；真机 HMR 时序；agent 工具在真机会话里的 LLM 回路端到端。
修复后需要**重跑一次隔离真机验证**才能给 S5 结论。

### 16.1 第三轮：真机验证暴露的 P0-3（会话快照源接错了面）

隔离真机验证（临时 `DSH_HOME` + 独立 profile + 独立浏览器，dsh 0.1.5-rc.1）第一次把 S5 跑起来就红了：
console 报 `TypeError: real.getSnapshot is not a function`（栈顶是本包的 client.js），右栏文件树空白。

**运行时的真实事实**（探针取自运行中的页面，不是读类型包）：

- `ctx.sessions` 是 `ISessions`（客户端会话服务），**没有** `getSnapshot`。快照数据在 `ctx.sessions.list` 上
  （`ObservableSnapshot<SessionListState>`）：实测有 `getSnapshot` / `subscribe` / `update` / `set`，
  且 `getSnapshot()` 回的确实是 `{ids, byId, current, phase, ...}`。
- 官方 files 正文读的是 `const cwd = useSessions((s) => s.byId[sessionId]?.cwd)`
  （`dsh-client-ui-sidebar-files/lib/client.js:421`）。`useSessions` 由渲染器按 **session 作用域的
  `hooks.sessions` 源**合成（`dsh-client-ui-renderer` 的 `standardKit`：每个 `hooks.<name>` 源 → `use<Name>`
  选择器 hook，且会话作用域覆盖 root 的同名项）；注册口是 `ctx.uiSession.provide`（实测存在）。
- entry 的 inject face 里塞 `hooks.sessions` **是有效接缝**（渲染器的 `bindInjectSources` 会把它合成为
  `useSessions`，且 `injected` 在 `kit` 之后展开因而覆盖它）；`ctx.uiSession.provide({hooks:["sessions"]})` 是
  **作用域更宽**的另一条接缝（整个 session 作用域）。两条都可用，选哪条是设计取舍——见 16.1.1 与 17.3-B1。

**修复（两件事，性质不同）**：

1. **真正修对的那一行**：真实源由 `ctx.sessions` 改用 `ctx.sessions.list`。P0 的根因只有这一个。
2. **多余的接缝替换**：注入点从 entry 的 inject face（本文档 §4.2 第 4 条指定的形态）换成
   `ctx.uiSession.provide` 的全 session 作用域贡献（新模块 `src/client/contribute.ts`），并因此删掉了
   `wrapInject` 与 `TakeoverDeps.sourceFor`。这次替换**不是修 P0 所必需**，且与 §6 的非目标、
   工具描述对模型的承诺、§4.2 第 2 条的降级语义三处冲突。是否回退：17.3-B1。
3. 测试侧：`test/unit/client-contribute.test.ts` 随第 2 件而来（若回退则一并删除）；而
   `src/client/index.ts` 里那一行**没有任何判据覆盖**——把它改回 `ctx.sessions`，全量 159 用例仍全绿
   （探针实测），见 17.3-A2。

**真机验证结果**（截图证据 `packages/dsh-worktree-sidebar/docs/archive/819-{bound,unbound}-*.png`）：

| 语义 | 结果 | 实测 |
|---|---|---|
| 已登记会话的树列 worktree 内容 | 成立 | 树根 `/tmp/pr819-verify/fixture/wt`，含 `WORKTREE-ONLY.txt` |
| 点开预览读 worktree 里的那一份 | 成立 | `SAME.txt` 预览内容为 `content-from-worktree`（同名的 cwd 副本写的是 `content-from-cwd`） |
| 未登记会话与未装插件行为一致 | 成立 | **同一实例内**未登记会话的根仍是 `/tmp/pr819-verify/fixture/repo`（cwd），无 `WORKTREE-ONLY.txt` |
| 挂载无异常 | 成立 | 页面重载后 console 捕获 0 条（修复前同一次重载必然出 TypeError） |

**仍未验证**：真机 HMR 重捕时序——官方客户端包住在 dsh 安装目录内，不写 DSH 源就无法触发官方包重载，
本环境没有安全的触发手段。agent 工具的 LLM 回路端到端需要真实模型凭据，隔离环境没有，且不得借用用户凭据。

### 16.1.1 更正：接缝论证被独立复核推翻（第三轮复核，2026-09-14）

本节初版把「props 里塞 `hooks` 不被读」写成事实，并据此认为必须换接缝。**这是错的**。第三轮派了两个
上下文独立的子 agent 做只读复核，其中「客户端修复与证据」那一路指出并被我逐条复现：

- `dsh-client-ui-renderer/lib/client.js:333-339` `runInject` → `:341-356` `bindInjectSources`：
  **entry 的 inject face 里 `hooks.<name>` 会被合成为 `use<Name>` 属性**（`standardHookPropName`）；
- 同文件 `:640-650` `renderEntry`：`{...kit, ...injected, ...slotInjected.props, ...ownerProps}`，
  `injected` 在 `kit` **之后**展开 ⇒ 覆盖；
- 本文档 §3（本文件 `:73`）与 §4.2 第 4 条（`:110`）早就写对了这条机制，§6（`:143`）还把
  「伪造只作用于本 entry」列为**显式非目标**。也就是说：设计文档没有错，是我读错了它，并擅自替换了
  它指定的机制。

**结论**：P0 的唯一根因是源对象用错（`ctx.sessions` 是 `ISessions`、没有 `getSnapshot`，数据在 `.list` 上）；
接缝替换是多余动作，且扩大了改写面——session 作用域内的 `chat` / `conversation` / `deliverables` /
`open-in-app` 等 `useSessions` 消费方都会看到 worktree cwd（读代码判断，C 级证据；`sidebar.right.pane.tab`
是 session 作用域为实测）。

**截图证据的因果归属同时降级**：`docs/archive/819-{bound,unbound}-*.png` 只能证明「右栏树根分别指向
`fixture/wt` 与 `fixture/repo`，且 wt 那张多一个 worktree 专有文件」；**不能**证明会话身份/同一实例、
**不能**区分「插件改写了 cwd」与「该会话真实 cwd 就是 wt」、**不能**证明 `TypeError` 消失。
下面表格里「成立」一列只应读作「界面观察成立」，不等于「由本插件造成」。

**另一条被独立复核指出的判据缺口**：把 `src/client/index.ts` 的 `ctx.sessions.list` 改回 `ctx.sessions`，
全量 159 用例仍 exit 0——P0 的修复行零覆盖（见 17.3-A2）。

## 17. 当前状态与交接（2026-09-14）

### 17.1 代码现状

| 项 | 值 |
|---|---|
| 分支 / PR | `task/worktree-sidebar` / [#819](https://github.com/wingsky-1/dsh-plugin-hub/pull/819)（**draft，未合入**） |
| 已推送提交 | `ddb1f44`（S0+S1）、`4ace52a`、`6b5059c`（S2–S5）、`462300a`（第二轮复核四项必修）、`7d92266`（状态记录）、`4c4f70a`（真机 P0-3 + 导出面收口 + 实现下移 `impl/service`）、`e79822a`（复用 notifier 同套门禁扫描） |
| 测试 | 159 例 / 11 文件；含真 git 仓库上的 创建→绑定→摘除 端到端。其中 `client-contribute`（4 例）随 17.3-B1 的取舍可能删除 |
| 门禁 | `pnpm gate:pr` **36 阶段全 exit 0**（在 `e79822a` 上实测）；`test:scripts` 624 pass / 0 fail |
| 导出面门禁 | 本包已接入 `export-surface-snapshot`（基线 + 分类登记入库，`contract-check` 逐包跑）；导出面 124 个符号全部有仓内消费者 |
| 模块级状态门 | 本包**已登记进扫描面**（原先只有 `dsh-notifier`，一次性探针的时代结束）：扫描 144 文件、exit 0、本包零条目零豁免 |

### 17.2 已完成

S0–S5 全部落地；独立复核（第二轮）的四项必修 P0-1 / P0-2 / P1-1 / P1-3 已修并推送，见 §16。

第三轮（本会话）：

1. **导出面收口**。删掉零消费者符号 `describeWorktree` 与 `BindingQueryResponse`，删掉死代码 `writeTextAtomicSync`；
   收掉 6 个无消费者的导出（`SessionsSource` / `TakeoverDeps` / `RequestHandler` / `StatLike` / 两个域的 `GitPort`）
   与 3 处冗余转出（`FileScope`、`LoggerPort`×3）；审计脚本按「符号 × 消费者」逐条核对，现无仓内无消费者的导出。
2. **类型与装配的物理定义下移到 `impl/service`**。四个域（git / binding / scope / api）各自新增 `impl/service/index.ts`，
   门面收敛成 10–20 行的纯转出；tools 域删掉多余的转发函数（`createToolsService` → `createTools`）。
   五个域现在是同一形状：门面只收口，`impl/service` 持有服务面与工厂。
3. **接入导出面门禁**：`scripts/data/dsh-worktree-sidebar-export-surface.json`（基线，已按生成器形态从
   `format:check` 面排除）、`-export-faces.json`（4 个主入口值导出全部登记为安装面）、`contract-check.ts` 逐包调用、
   `ci-face-registry.json` 登记两个新数据文件。
4. **真机 P0 的源对象修对、接缝换错**：`ctx.sessions` → `ctx.sessions.list` 是 P0 的唯一根因（正确）；
   但同批把注入点从 §4.2 指定的 entry 级换成了全 session 作用域（多余，且与 §6 的非目标冲突）。
   真机三条界面语义的**观察**成立，但因果归属降级——见 §16.1 与 §16.1.1。
5. 顺带修掉一处历史写入事故：`scope/impl/resolve/index.ts` 与本文档里残留的 `%BT%` 占位符（构建产物 `.d.ts` 里也有），
   以及本 PR 自建的 `test/tsconfig.json` 编译不过（46 处类型错误，测试目录不在包 typecheck 面内所以一直没暴露）。
6. **门禁复用面收口（复用 notifier 同套扫描）**：`forbid-module-state-src` 的扫描面此前只有 `dsh-notifier`，
   本包根本不在那条**常驻**判据里（P1-3 那 5 处模块级单例当初只被一次性手工探针发现，正是这个代价）。
   现登记为 `["dsh-notifier", "dsh-worktree-sidebar"]`；实测扫描 103 → 144 文件、exit 0、本包零条目、无需任何豁免。
7. **本包数据资产进 CI 包面**：`.github/workflows/ci.yml` 的 `dsh-worktree-sidebar` filters 补
   `scripts/data/dsh-worktree-sidebar-*.json`（与 notifier 的 `scripts/data/dsh-notifier-*.json` 同型），
   同时把 `ci-face-registry.json` 里那条从「豁免」改为本包面——此后改导出面基线会触发本包切片，
   与常驻的 `contract` 产物闸不冲突。实测：`gate-scope-registry` 5/5、`ci-face-coverage` 8/8、
   `workflow-assert` 43/43 全过。
8. **第三轮独立复核（两个上下文独立的子 agent，只读）已完成**：一路审架构边界与导出面，一路复核客户端修复
   与真机证据。对账结果、我的错误记录与分档见 §16.1.1 与 §17.3。两路都如实登记了「复核期间工作区出现
   非其所做的未提交改动」——那是我按维护者授权在改门禁面（见 17.3-B7）。

### 17.3 待办分档（A 建议本 PR 内做 / B 待裁决 / C 建议不做）

**A. 无取舍，建议本 PR 内做**

1. **A1 记录更正**：三处源码注释（`client/ports.ts` 的 `UiSessionPort` 段、`client/contribute.ts` 头、
   `client/takeover.ts` 头）里「props 里塞 hooks 不被读」的表述改成事实版本；本文档 §16.1.1 已记更正结果。
2. **A2 补判据缺口**：`src/client/index.ts` 是 P0 修复行（`ctx.sessions.list`）所在处，**零覆盖**——
   探针实测把该行改回 `ctx.sessions`，全量 159 用例仍 exit 0。要补一条驱动 `apply(ctx)` 的单测，
   假 ctx 必须复刻真机面（`sessions = {list: {getSnapshot, subscribe}}`，服务对象**没有** `getSnapshot`）。
3. **A3 补登记**：`shared/README.md:15` / `:18` 的消费方登记表补上本包（我们 import 了 `host-utils.js` 与
   `dsh-home.js`，登记表只列了 4 个包；目前无门禁读它，但登记表失真会误导后来人）。
4. **A4 消除静默空实现**：`src/index.ts:92-94` 的 `publish` 对未知 agent 回 `() => undefined`（refactor §4
   要求未装配即抛错/出声）。当前调用路径不可达，属纪律项，2 行。

**B. 待裁决（压缩会话后讨论）**

1. **B1 接缝回退**（最重要）：回退到本文档 §4.2 第 4 条指定的 **entry 级** `hooks.sessions` 注入
   （恢复 `wrapInject` / `TakeoverDeps.sourceFor`、删 `contribute.ts` 与 `client-contribute.test.ts`、
   `inject` 去掉 `uiSession`、`--min` 回 10 并重生成 stryker 面），还是保留现在的**全 session 作用域**接缝，
   并相应改写 §6 与工具描述？实测依据：两条接缝**都有效**（renderer `:333-356` / `:640-650`），
   差别只在作用域与降级语义。背景与证据见 §16.1.1。
2. **B2 contract.ts 拆法 + 双端响应体单一事实源 + 路由字面量兜底**：三方（我 + 两个独立复核）同指。
   存储形状移进 binding 域、`ROUTES` 留根；`{revision, worktreePath}` 提为被两端真实消费的契约，并补
   「改一侧就红」的判据；`client/index.ts:23` 的字面量兜底要么删、要么补构建期断言。
3. **B3 api 域端口按提供方拆**：`api/deps.ts:15-20` 的 `BindingPort` 一半来自 binding（`revision`）、
   一半来自 scope（`effectiveWorktree`），逼组合根手工拼匿名对象（`index.ts:233-236`），
   违 refactor §3「一行一个提供方」。拆成两项即可。
4. **B4 BindingApi.prune 的处置（已裁决 = 删）**：本文档 §7.1（`:149`）**声明了** binding 域有「剪枝」能力，
   但全仓**没有任何调用点**（生产零消费者，只有 `test/unit/binding-model.test.ts:139-147` 与
   `test/integration/binding-store.test.ts:121-126` 两组测试）。维护者裁决**删掉这个能力**，不再补触发
   （补一个「会话释放时剪枝」会引入新的会话生命周期耦合，而当前没有任何消费者需要它）。
   连带动作：删 `prune`（`binding/impl/service/index.ts:31,70`）与 `pruneTable`（`binding/impl/model/index.ts:86`）
   及上述两组测试；同期已改 §7.1 的验收标准与 §8 的文件职责。
5. **B5 导出面收窄落实（已复测，口径与性质更正）**：v1 写的「5 处仅同文件消费者」**复测为 0 处**。
   消费口径必须写全：**值导出 ∧ 定义文件之外零导入者 ∧ 非包入口面 ∧ 不含 `test/`**。
   原来的「仅同文件消费者」把两件事混在一句话里，所以得出的数量没有意义。逐条现状：

   | 符号 | 定义处 | 性质 | 生产消费者 | 测试消费者 |
   |---|---|---|---|---|
   | `branchLabel` | `src/server/git/impl/inspect/index.ts:83` | 值导出 | 0 | `test/unit/git-inspect.test.ts:127-146`（4 例） |
   | `BindingApi.entries` | `binding/impl/service/index.ts` | interface 成员 | 0 | `binding-store.test.ts:58,127,134` |
   | `lastRevision` | `src/client/bindings.ts:15,26` | interface 成员 | 0 | 无 |
   | `ApiInstance` / `ScopeApi` | 门面 `export type` 转出 | 转出 | 0 | 有（改直引 `impl/service`） |
   | `GitExecPort` | `git/interface.ts` 转出 | 转出 | 0 | 组合根从 `git/deps.ts` 取（门禁规则 2 允许「入口或出口」） |

   `branchLabel` 是上一轮删 `describeWorktree` 时留下的孤儿：生产零消费者、只剩测试在调它。
   **另列（不动）**：测试专用的 `FILES_KIND` / `BODY_SLOT` / `TITLE_SLOT` / `OUR_TYPE_ID` / `emptyTable` /
   `validateRecord` / `directoryExists` 是模块 ABI 面或同源期望锚点，不机械收窄。
6. **B6 两次装配的修法**：P1 已实测（同进程两个 `createBinding` 写同一文件 → 先写的绑定被静默丢弃、
   两侧都报 revision=1；独立复现脚本见 §17.5）。选 (a) 进程内登记「同一 file 只能一个实例」并抛错
   （先例 notifier `pipeline/impl/service/index.ts:56`，约 10 行），还是 (b) commit 前重读文件（约 20 行）？
   无论选哪个，`index.ts:189-191` 与 `binding/impl/service:8-10` 的「两次装配不会互相污染」自述都要改。
7. **B7 行数预算裁决（已裁决 = 删除全包合计指标）**（§9 / §9.1 / §16）：
   `interface/deps ≤80` 的 3 处历史偏离已随「类型与装配下移 `impl/service`」消失——**数字更正为实测值**
   （2026-09-14，`wc -l`）：门面 `interface.ts` = api 8 / binding 8 / scope 8 / tools 11 / git 11；
   `deps.ts` = api 30 / binding 12 / git 18 / tools 55 / **scope 78**。v1 与本条旧文写的「最大 `api/deps.ts` 30 行」
   不成立：最大的是 `scope/deps.ts` 78，离 80 只差 2 行。
   **全包 src 合计**：实测 **41 文件 / 2535 行**（均值 62），旧文写的「2533 行」是过期读数。
   该指标本身已撤销（无出处、拆分修不掉合计、指向不了任何动作，见 §9），逐文件数字改称
   **review 提问线**；「超限先问这文件里有几个决定」这条语义已写进 §9，不再需要观察阈值。
8. **B8 .github/workflows/ci.yml 的可审计记录（维护者裁决：不发评论、不新开 issue）**：
   复用 notifier 同套扫描已落地（见 17.2 第 6、7 条），仓库规则要求的可审计记录
   （issue 内方案评论 + `needs-proposal-review` / `approved` 标签）**确认为缺失，但不再补**——
   本次授权是维护者会话内直接授权。**记录落点 = PR #819 正文的「红线声明」段**：写明改了 `ci.yml` 的
   paths-filter 键、依据哪条仓库规则、由谁在何时授权。仓库规则「不单开决策 issue」因此已满足，
   不额外制造待办；本文件即该记账的第二处副本。

**C. 建议不做（附理由）**

1. ~~为「闭包工厂 vs class + 导出单例」重写五个域：建议不做~~ → **第四轮改判：本轮做**。
   改判依据两条：① `.dsh/skills/dsh-plugin-hub-refactor/SKILL.md:112-115` **明文形态**是「有状态的才用
   `class`，配一个导出单例（类不外放）」+「**不用闭包工厂**」，`:215` 自检清单同样列着闭包工厂；
   ② 维护者裁决「最小化暴露，不能暴露工厂，只暴露能力」。
   原判断（「形态差异的收益小于重写成本」）不成立的地方在于：收益不是形态美学，而是**暴露面**——
   工厂被门面转出后，调用方可以 `new` 出第二份、可以持有它，而这两件事正是 P1-3 当初要消灭的
   「跨装配共享状态」的另一条路径；本轮把 `class` 与单例留在 `impl/service`，门面只出
   `install/release` + 能力转发。
2. 把 `shared/file-io.ts` 搬回 binding 域：它只有 binding 一个消费者，但内容是领域无关的 fs 语义
   （原子写 + 同步读）且被同域两个文件共用；`shared/paths.ts` 同理（单一消费者，但「路径只有一个事实源」
   的收窄更有价值）。
3. 把 `tools/impl/bind` 再切块（现 98 行装「解析校验 / 仓库查询 / 写绑定」三件事）：切开会把
   「知道绑定表」的领域知识与其消费者拆开，跨块跳转从 1 跳变 2 跳。

**仍未验证（不属 A/B/C，需换环境或凭据）**

- 真机 HMR 重捕时序（计划 §13 第 5 项）：触发它必须让官方客户端包重载，而官方包住在 dsh 安装目录内
  （写它是红线）。现设计是「官方正文消失即撤销、出现即重捕」，无去抖。
- agent 工具在真机会话里的 LLM 回路端到端：需要真实模型凭证，隔离环境没有，且不得借用用户凭据。
- 两次装配在生产是否真会发生：未读 dsh 的 profile / 插件装载模型（B6 的触发前提）。

### 17.4 方法论缺口（本轮明确暴露）

实施全程**只加载了 `dsh-plugin-hub-dev`**，**未加载** `dsh-plugin-hub-refactor`（`docs/ARCHITECTURE-METHOD.md` 的执行清单）
与 `dsh-plugin-hub-testing`。这不是形式问题——两份清单里各有条目直接命中本轮的实际缺陷：

- refactor §1/§5/§9：「`interface.ts` 只 re-export」「导出面里没有无消费者的符号」「最小导出」→ 对应 17.3 第 1、2 条。
- refactor §9 自检清单还要求跑 `export-surface-snapshot`；本包**没有该门的基线**（现行范围只有 `dsh-notifier`），
  所以导出面漂移从来没有被机器拦过。
- testing §3「夹具：假件要**真**、要窄、要露怯」→ 直接对应 P0-1：我的假 slots 端口对着错误的类型包造，
  假件与运行时不一致，于是 155 个全绿的用例没有一个能发现真机 `TypeError`。

第三轮的 P0-3 是**同一个教训的第二次**，而这次两份清单都已经加载了：端口的形状最终是**真机探针**定的
（把 `ctx.sessions` / `ctx.uiSession` / `ctx.sessions.list` 的键与 `typeof` 打出来），不是读类型声明推的。
可推广的判据：**凡「我假定某个运行时对象长什么样」的地方，都要有一条真机取值证据**；
类型声明只能证明编译期，假件只能证明「代码与假设一致」。

**第四轮的教训（同一天内同型错误第三次，值得单独记）**：第三轮的两个独立复核推翻了我上一轮的**核心论证**
（见 §16.1.1）。问题不是「不懂机制」，而是：**设计文档 §3 / §4.2 / §6 早已把机制与取舍写对，我没照它做，
反而凭一次真机现象替换了它指定的接缝**。可推广的判据有两条：

- 真机现象只能证明「某个假设不成立」，**不能**证明「我换上去的替代方案是设计意图」；改一个已被文档指定的
  机制之前，先回去读那份文档的原文（本轮 §4.2 第 4 条与 §6 的非目标里就写着答案）。
- **修一个 P0 时，至少要有一条判据落在「修对的那一行」上**：本轮 P0 的修复行（`ctx.sessions.list`）零覆盖，
  把原回归改回去仍能让全部 159 个用例变绿（§17.3-A2）。

### 17.5 证据位置

**第二轮复核者留下**：隔离 worktree `/mnt/ssd/worktree/dsh-plugin-hub-task-worktree-sidebar-review2`
（detached @6b5059c，本会话已按仓库规矩清理）；其复现脚本与截图在 `/tmp/pr819-verify/`（临时目录，可能已被清理）。

**第三轮（本会话）**：

- 真机截图（已入档）：`packages/dsh-worktree-sidebar/docs/archive/819-bound-session-worktree-tree.png`、
  `819-unbound-session-cwd-tree.png`。
- 隔离环境与复现脚本：`/tmp/pr819-verify/`（`cdp.mjs` 真机 CDP 小工具、`probe-reload.mjs` 运行时探针、
  `export-audit.mjs` 导出面消费者审计、`dsh2.log` 隔离实例日志）；临时 `DSH_HOME` `/tmp/dsh-verify-VQUvbs`。
- 三条界面语义的实测结论与判据见 §16.1；运行时探针输出的原始 JSON 在同批 `/tmp/pr819-verify/` 文件里。

**第三轮两个独立复核子 agent 的证据**（上下文独立、只读、未改任何仓库文件）：

- 「架构边界与导出面」那一路：`/tmp/export-audit/{audit.mjs,audit-v2.mjs,export-audit-v2.txt,gate-outputs.txt,probe-double-assembly.mjs}`。
- 「客户端修复与证据」那一路：自建探针 worktree `dsh-worktree-sidebar-probe-b`（已按规矩清理），实测表 M1–M10；
  其中 **M9/M10 是两条「全绿」证据**——`index.ts` 的 per-id 源缓存与 `ctx.sessions.list` 那一行都没有判据（§17.3-A2 的来源）。

**我对复核结论的独立复现**：

- `/tmp/pr819-verify/repro-double.mjs`：同进程两个 `createBinding` 写同一 `bindings.json` → 先写的绑定被静默丢弃、
  磁盘只剩后写的、两侧都报 revision=1（B6 的依据）。
- 探针 worktree `dsh-worktree-sidebar-probe-e`（已清理）：复现 M10（改回 `ctx.sessions` → 159 用例全绿）；
  并验证 B5 的 5 处 `export` 全部去掉后 `tsc -p tsconfig.json` 声明发射 exit 0、159 用例全绿。
- 清理状态：`-probe-b` / `-probe-e` 及前几轮探针均已 `git worktree remove --force` + `prune`；
  主 checkout `git status --porcelain` = 0 行（全程只读）。

## 18. 第四轮（门面只出能力 + 客户端接缝回退 + 判据补齐）

第四轮的输入是三个上下文独立的复核子 agent（架构合规 / 判据可打红 / 客户端对抗）与一个调研子 agent 的结论，
加上维护者的 A/B/C 授权与三条裁决（C1 做、B4 删、B7 撤销合计指标）。执行方案（工作稿）不在仓库内；
本节的数字与 `file:line` 全部在 `task/worktree-sidebar` 上重测过，不照抄方案稿。

### 18.1 A 档裁决（无取舍，本轮做）

| # | 裁决 | 依据（复核后的事实） | 状态 |
|---|---|---|---|
| A1 | 做：更正「props 里塞 hooks 不被读」的错误表述（源码注释四处） | 官方 `bindInjectSources` 把 entry inject 面里的 `hooks.<name>` 经 `standardHookPropName` 变成 `use<Name>` props（`dsh-client-ui-renderer/lib/client.js:342-357`）；展开序 `{...kit, ...injected, ...}` 在 `:644-650`（ContextualEntry）与 `:653-658`（renderEntry）两处，`injected` 在 `kit` 之后 ⇒ 覆盖 | S1a 落地（`d62f775`）：`takeover.ts` 头、`ports.ts` 段、`client-takeover.test.ts` 原 `:302-304`；`contribute.ts` 随删除消失 |
| A2 | 做：为 P0 修复行 `ctx.sessions.list` 补判据 | 探针实测边界：把该行改回 `ctx.sessions`，**构造期不抛**、`typeof getSnapshot === "function"` 为 true，只有**调用** `getSnapshot()` 才 `TypeError: real.getSnapshot is not a function` ⇒「只驱动到注入对象生成」的写法是恒真断言 | S1b 落地（`03038d7` 新增 `test/unit/client-index.test.ts`，与逐会话剪枝同一片——比原排期提前一片）；`d7e852b` 随 B2 改到 `typeof __DSH_ROUTES__` 注入形态；S4/S5 又补一条路由字面量哨兵（见 §18.5） |
| A3 | 做：补 `shared/README.md` 消费方登记 | `src/server/api/impl/route/index.ts:9`、`api/impl/handlers/index.ts:11` 取 `guardLoopbackMethod/writeJson`；`src/server/shared/paths.ts:6` 取 `dshHome` | S4/S5 落地（本片）：`shared/README.md:15`（`host-utils.js`）与 `:18`（`dsh-home.js`）两行消费方登记各补 `worktree-sidebar`。**判据：无**（该表无门禁读），按 testing skill §7 显式登记为「靠自查」，靠在 PR 正文写明 |
| A4 | 做（与 B7(b) 合并）：消除静默空实现 | `src/index.ts:92-94` 对未知 agent 回 `() => undefined`；但 `publish` 的唯一调用点 `tools/impl/service/index.ts:43` 拿到的 face 恒来自 `bindAgents` 先 `live.set` 过的同一条（`:84` list / `:85` subscribe）⇒ **该分支不可达**，`bindAgents` 又未导出（`src/index.ts:73`）⇒ 判据无处驱动 | S3 落地（`141a11e`）：拆 `src/host/{agents,typert,defaults}.ts` + 窄端口（87/47/53 行），`test/unit/host-agents.test.ts` 白盒断言「`publish(未知 id)` → 抛错」，`src/index.ts` 260 到 160。先例与例外：refactor §4 要求「未装配即抛错」，notifier 有相反先例（挂宿主事件链的出口可静默），我们的 `publish` 是自家 tools 域**同步调用**，不属该例外 |

### 18.2 B 档裁决（逐条）

| # | 裁决 | 依据 | 状态 |
|---|---|---|---|
| B1 | 做：接缝回退到 **entry 级** `hooks.sessions` | 计划 §4.2 `:110` 指定的形态；§6 `:143`「伪造只作用于本 entry」是**显式非目标**；§8 `:190-192` 的客户端文件清单里没有 `contribute.ts`。两条接缝都有效（`renderer:333-356` / `:640-650`），差别只在作用域与降级语义；保留全 session 作用域会让工具描述对模型的承诺（`tools/impl/register/index.ts:19-24`「Only the Files tab follows the binding」）变成假话 | S1a 落地（`d62f775`）：恢复 `wrapInject` + `TakeoverDeps.sourceFor`；删 `contribute.ts` 与 `client-contribute.test.ts`；`inject` 去掉 `uiSession`（`--min` 11→10 + `stryker:gen`）；改写原 `:301-325` 那条必红断言 |
| B2 | 做：契约单一事实源（三段） | ① 存储形状 `BINDINGS_VERSION/BindingRecord/BindingsFile`（`contract.ts:19-38`）消费者是 binding 域 3 文件 + `tools/impl/bind` + 测试，**客户端零消费者** ⇒ 移进 binding 域；② 响应体 `{revision, worktreePath}` 由单点定义、两端真实 import（宿主 `api/impl/handlers/index.ts:34`、客户端 `client/index.ts:35`），删掉客户端那行手写的第二份形状；③ 判据方向更正：能红的是「**把某一端改回旧字面量 → 该端 `pnpm typecheck` 报错**」，且只在**类型层**成立（做成值常量连类型层都不红）；④ `__DSH_ROUTES__` 兜底实测失效（`node` 直接 import → `ReferenceError`；`?? "/literal"` 永不可达），正解是 `typeof __DSH_ROUTES__ !== "undefined" ? __DSH_ROUTES__ : ROUTES` | S3 落地（`d7e852b`）：① 存储形状移进 `binding/impl/model/type.ts`（`contract.ts` 只留 `ROUTES` + 响应类型单点）；② 两端各一处真实 import；④ 改成 `typeof __DSH_ROUTES__ !== "undefined" ? __DSH_ROUTES__ : ROUTES`（不修会让 A2 的测试在收集期整文件失败）。③ 的边界与哨兵采纳见 §18.5 |
| B3 | 做：api 端口按提供方拆 | `api/deps.ts:15-20` 的 `BindingPort` 一半来自 binding（`revision`）、一半来自 scope（`effectiveWorktree`），逼组合根手拼匿名对象（`index.ts:232-236`），违 refactor §3「一行一个提供方」 | S2 落地（`3ef0623`，与 C1 同批）：`api/deps.ts` 拆成 `RevisionPort`（`Pick<typeof bindingApi, "revision">`）与 `EffectiveWorktreePort`（`Pick<typeof scopeApi, "effectiveWorktree">`），组合根一行一个提供方递门面命名空间对象，不再手拼匿名对象 |
| B4 | **已裁决 = 删** `BindingApi.prune` | 生产零消费者，只有 `binding-model.test.ts:139-147` 与 `binding-store.test.ts:121-126` 两组测试 | S4 落地（`55d401e`）：删 `prune` / `pruneTable` 与两组测试；`entries` 的测试消费者改用 `get()` / `revision()`。`§7.1` 与 `§8` 已同步（S0 改 `§7.1`，S4/S5 改 `§8`） |
| B5 | 做：导出面收窄批（口径更正） | v1 的「5 处仅同文件消费者」**复测为 0 处**；正确口径 = 值导出 ∧ 定义文件之外零导入者 ∧ 非包入口面 ∧ 不含 `test/`。`branchLabel` 生产零消费者、只剩 4 条测试（`git-inspect.test.ts:127-146`）；测试专用的 `FILES_KIND` 等是 ABI 面或同源期望锚点，**不动** | S4/S5 落地（本片）：删 `branchLabel`（+`test/unit/git-inspect.test.ts` 的 4 条断言）、`client/bindings.ts` 的 `lastRevision`、三处类型转出（`ApiInstance` / `ScopeApi` / `GitExecPort`）；按口径重跑机械审计，非豁免命中 **0**。判据只对「生产零消费者」这一条有效：审计 + `typecheck` + 测试改写。C1 让门面值导出**增加**（install/release + 能力转发），与收窄不矛盾（增的是能力、减的是工厂）。清单与口径见 §18.5 |
| B6 | 做：由 C1 的 `install` 守卫解决双装配 + 更正 6 处注释 | 同 fiber 内 cordis 先卸后装（`cordis/src/fiber.ts:675-696` 的 `_unload` 先 `await` 全部 disposer，再 `:692` `_reload`）；**并发双 fiber** 才可能两份实例。notifier 的守卫在 `pipeline/impl/service/index.ts:50`（`private installed = false`）与 `:55-57`（throw）。旧 repro（直接调两次 `createBinding`）**不是真机可达路径** | S2 落地（`3ef0623`）：五域 `install` 守卫 + 6 处注释更正；`51ee450` 补「工具注册失败要出声」判据；S4/S5 把「第二次装配显式抛错」写进中英 README。正确红绿实验是「删掉 `if (installed) throw` 那一行 → 只有该用例红」，「旧形态下是红的」不构成实验（旧形态没有 `installGit`，用例编译不过） |
| B7 | **已裁决 = 撤销「全包 src 合计」指标**；逐文件数字改称 review 提问线 | 实测（第四轮收尾重测）**44 文件 / 2978 行**（均值 68）；门面 `interface.ts` = 19/45/24/21/59（api/binding/scope/tools/git），`deps.ts` = 32/12/18/55/**78**（最大 `scope/deps.ts`）。该指标无出处（§9 只给了**单文件**分位数）、且拆分不改合计 ⇒ 指向不了动作。机器强制的质量面交给既有度量：ESLint `complexity`（78/84）+ CRAP 16（观察期）+ 变异 | S0 已改 §9/§9.1/§16（`a01c135`）；B7(b) 拆 `src/host/` 与 A4 合并落在 S3（`141a11e`），S4/S5 按实测重写 §9.1 数字 |
| B8 | **裁决：不发评论、不新开 issue**，记录 = PR 正文红线声明段 | 仓库规则要求的可审计痕迹确认为缺失，但维护者裁定以 PR 正文的「红线声明」段承载（写明改了 `ci.yml` 的 paths-filter 键、依据哪条规则、由谁授权）；「不单开决策 issue」因此已满足 | S0 已改 §17.3-B8 |

### 18.3 被删除的保证与替代（SKILL §7.5；C1 的代价显式登记）

C1 把门面从「转出工厂」改成「出 `install/release` + 能力转发」后，**同进程第二份实例**不再可能，
于是三条既有用例锁定的语义消失。替代判据必须**先写、后删**，否则这批改动净减少判据：

| 删除的用例 | 原语义 | 替代判据 |
|---|---|---|
| `test/integration/binding-store.test.ts:61-72` | 两份实例互不干扰 | ① 同一 file 第二次 `install` 抛错（断言**完整消息**）② `await release()` → 再 `install` 后读到磁盘现状 |
| `test/unit/scope.test.ts:358-368` | 两份都拿到自己的 configure，「不存在第二次装配抛已装配」 | ① release 后 depsA 的 disposer 被调 ② 再次 install 必须成功且 `isInstalled()=true` |
| `test/integration/git-real.test.ts:112-120` | 缓存不共享 | ① install→install 抛错 ② release 后旧 exec 的缓存答案不再返回 |

另有 `binding-store.test.ts:91-94` 的注释「新实例 = 重新读盘」要改成 `await release(); install();` 并同步改注释。

**生产语义变化（要写进 README）**：同进程第二次装配由「互不污染」变为「**第二份挂不上并抛错**」。
这正是 P1-3 当初要消灭的共享状态，在 C1 之后有了明确的、会出声的失败形态。

**风险登记**：`forbid-module-state-src` 只认顶层 `let`/`var`，`export const gitService = new GitService()`
**不会**被判红（复核用真脚本 fixture 实测）⇒「门禁绿」证明不了没有重新引入跨 apply 共享状态；
这正是 C1 必须自带上面那些 release 判据的原因。

### 18.4 两条仓库级门禁盲区（早于本包存在；本包不依赖、不新增豁免）

1. **`readonly` 让注入面对账闸恒不生效**：`scripts/gate/verify-dir-imports.mjs` 的「注入面对账」
   （为 notifier 的 install/release 形态专写的）对本包**恒不生效**——字段提取 `objectLiteralKeys` 对
   `readonly logger: LoggerPort` 这类成员返回 `null`（key 文本 `"readonly logger"` 过不了标识符正则），
   随后静默 `continue`。本包 5 个 `deps.ts` 全用 `readonly`。盲区早于本包存在（notifier 同样中招），
   修它属 `scripts/` 改动（走 `gate:pr` + 正反 fixture），不在本轮、不承诺、不跟踪。
2. **`verify-dir-imports` 硬编码豁免 client 子树**：`src/client/**` 双向豁免、无任何收紧通道
   （5 处特判：模块表、目录名判据、from 侧、target 侧、历史口径；旋钮只许放宽）⇒ 客户端目录里的
   跨块直引**不会被这道闸拦到**。同样是仓库级治理问题（要动 5 处特判并同时决定变异面与覆盖率面对
   client 的口径），不在本轮。

**本包的正确处置是三条**：① **不依赖**这两道闸（用运行期「未装配即抛错」+ 测试兜住）；
② **不新增任何门禁豁免**——`scripts/data/gate-exemptions.json` 保持**本包零条目**
（实测：全文件 1 条豁免，且是 `dsh-notifier/src/client/index.tsx`）；③ 在 PR #819 正文用一两句登记
「已知盲区 + 我们的替代判据」，免得后来人以为这两道闸在守本包。

**客户端侧另有两条口径登记**：变异面与覆盖率面**整个排除** `src/client/**`
（`mutation-topology.json:506-507`、`coverage.config.json:31-37`，后者是 `pending-project` + reviewBy 2027-03-31）
⇒ 客户端改动只能靠改坏实验留证，任何覆盖率/变异数字都不覆盖它。

### 18.5 第四轮收尾（S4/S5）的实测更正与边界登记

**① `src/index.ts` 260 到 160（S3 拆 `src/host/` 之后）**：三个宿主适配器实测 **87 / 47 / 53 行**
（`src/host/agents.ts` 87、`src/host/typert.ts` 47、`src/host/defaults.ts` 53，`wc -l` 复核）。
工作稿记的 87/48/53 与实测差 1 行，以实测为准。§9.1 的表已按本轮读数整体重写
（组合根 160、客户端单文件最大 212、全包 44 文件 / 2978 行）。行数本身只是 review 提问线，不是判据。
§17.1 表里的行数、用例数与导出面符号数都是**第三轮交接时的快照**，第四轮读数以 §9.1 与本节为准。

**② 导出面门禁对「主入口符号」的声明块参与比对（推翻旧表述）**：`export-surface-snapshot.mjs` 的论域是
**包入口**（`package.json` 里带 `types` 的子路径，本包是 `.` 与 `./client`）的导出面。`apply` 是主入口 `.`
的导出符号，C1 把它从 `void` 改成 `Promise<void>` 后，`gate:pr` 的 `contract` 阶段**确实判红**
（1 丢失 + 1 新增），已按门禁自述重冻结：

```sh
node scripts/gate/export-surface-snapshot.mjs --package dsh-worktree-sidebar --snapshot
```

（`45e2eb0`：符号集仍是 4 个、`-export-faces.json` 未动、**未新增任何豁免**。）结论分两半，必须一起读：

- **成立的一半**：域内符号不进任何判据。B5 删的 `GitExecPort` / `ApiInstance` / `ScopeApi` / `lastRevision`、
  B4 删的 `entries`、S4 删的 `branchLabel` 都不会让任何门禁判红——它们的替代判据是 `pnpm typecheck` +
  下一条的消费者审计。
- **被推翻的一半**：「导出面基线不需要重生成」只对域内符号成立。**凡改主入口导出符号的签名都要重冻结**，
  这条是真实判据、不是盲区。另外**不要**为可见性给包加 `./server` 子路径——那会变成第三个独立入口，
  把域内符号一起拖进比对面。

**B2 ③ 的边界（如实登记）**：B2 的单点化让「把某一端改回**旧字段名**」在该端 `pnpm typecheck` 报错；
但**把客户端逐字还原成删掉的那行同形 cast**（`as { revision?: unknown; worktreePath?: unknown }`）
在类型层是**绿的**——同形断言不改变类型。所以单点化真正挡住的是**单端形状 / 字段名漂移**，
挡不住「重新手写一份同形断言」。这条边界不靠判据兜，改用一条**可选哨兵**：

- **已采纳**：「`src/client/**` 里不存在硬编码的 `/api/` 路由字面量」。它守的是与字段名同一类的单端漂移
  （路由串只经 `src/contract.ts` 的 `ROUTES` 与构建期 `__DSH_ROUTES__`），符合 `DEVELOPMENT.md:419`
  「路由引用用构建期注入的 `__DSH_ROUTES__`（或宿主 ROUTES 字面量），防两端漂移」。
- **落点**：写进**已有**的 `test/unit/client-index.test.ts`（一条 `it`），**不新增测试文件**——
  因此 `--min` 与 `pnpm stryker:gen` 的登记一次都不用再同步（只有增删测试文件才要动它们）。
- **红绿实验**：把 `src/client/index.ts` 的 `const BINDINGS_URL = ROUTES_INJECTED.bindings;` 换成字面量
  `"/api/dsh-worktree-sidebar/bindings"` → 单跑该文件 **1 failed | 3 passed**（只有哨兵那条红，
  断言输出 `+ ["index.ts"]`）→ 用备份还原后 `sha256` 与改坏前逐字节相同、**4 passed**。
  `src/client/**` 在覆盖率面与变异面之外（见 §18.4 末），所以这条判据也不进任何度量，只能靠改坏实验留证。

**B5 的机械审计（口径与结果）**：脚本按 AST 取「值导出 ∧ 定义文件之外零导入者 ∧ 非包入口面 ∧ 不含 `test/`」；
消费者口径必须含 `Pick<typeof ns, "a" | "b">` 这类类型层成员引用（否则 C1 加在门面上的能力转发
会被误判成死代码）。删掉 `branchLabel` 后命中 **6 个符号，全部落在「不动」清单里**：
`FILES_KIND` / `BODY_SLOT` / `TITLE_SLOT` / `OUR_TYPE_ID`（客户端 ABI 锚点与同源期望锚点）、
`validateRecord`、`directoryExists`。**非豁免命中 0 处**，与工作稿的预期一致。

**测试净变化**：本轮只**删**断言（`branchLabel` 的 4 条），另加 1 条哨兵断言；测试文件数保持 13，
`--min` 与 `pnpm stryker:gen` 面均未变动。删除项的替代判据逐条登记在 §18.3 与本节。

## 19. 第五轮：去轮询换根、目录重排与已批准实施清单（2026-09-14）

### 19.0 本轮性质与结论

- 触发：维护者质疑「实现太复杂、对官方侵入太多」。派了两个上下文独立的子 agent 做**宿主轴 / 客户端轴**
  对抗调研（各自只读、自带证据纪律），本人逐条复核其关键论断。三类归档（真弯 / 被迫 / 记账）落在
  `packages/dsh-worktree-sidebar/docs/archive/review-round5.md`（第六轮起被后续轮次取代，故移入 archive），**不替代本文**。
- 结论两条，必须一起读：
  1. **深侵入可以从 2 处降到 1 处**——客户端不必顶官方类型表，用「同 key + 更低 priority」遮蔽正文 entry 即可
     （官方 ui-slots 文案就写着 `register at a different priority to shadow it (lowest renders)`）。
  2. **宿主那处 `typert.configure` 在「任意路径」硬约束下是唯一接缝**，删不掉（否决依据见 §19.4）。

### 19.1 已落地（工作树内，未提交）

| 项 | 内容 | 证据 |
|---|---|---|
| ① 归属缓存解耦 | `git/impl/service` 的 `BELONGS_TTL_MS` 5s 到 30s（旧值与客户端轮询同值，导致每轮轮询必 miss）；新增判据「TTL 内不重复起 git，过期后才重算」 | 13 文件 / 175 用例；两突变（TTL=0、永不过期）各自打红一条；备份 + sha256 还原一致 |
| ② 树根按绑定播种、去掉轮询与剪枝 | `client/inject.ts` 覆盖官方 face 的 `start`/`load`；`client/index.ts` 删 `REFRESH_MS`/`pruneGone`/`isGone`/`LiveSource`，改为每会话一个 `SessionView{source, root}` | 13 文件 / **179 用例**；三突变（播种不读生效根 / 刷新不重读 / 不记 abort）各自打红一条；lint 0 error 且 warning 回 669/671；typecheck、test tsconfig、prettier 全 0 |

**②的官方依据（本人复核，行号基于 dsh 0.1.5-rc.1）**：

- 树根只在 `state === undefined` 时由 `start(tabId, cwd)` 播一次
  （`dsh-client-ui-sidebar-files/lib/client.js:426-428`）；此后 `cwd` 再变也不重设根。
- 刷新按钮 = `actions.reset(tab.id)` + 按 `expanded` 重新 `load`（同文件 `:455-458`），而 `reset` **只清 levels**
  （`:659-661`）⇒ **刷新按钮改不了根**；只有 `forget`（abort 路径，`:667-669`）才会删掉整棵 tab 状态。
- `load`/`start`/`toggle` 都来自 entry 的 inject 面（`renderer/lib/client.js:341-357` 把 face 展开成 props）
  ⇒ 覆盖它们就是"树根播种"的合法落点。

**②的语义后果（必须与文档一起改）**：客户端**不再有任何定时轮询**，请求只由三个用户可感知时机触发
（打开页签 / 点官方刷新 / 窗口重新可见或获得焦点）。因此"登记完树就自动变"不再成立，工具文案与 README
必须改成「打开或刷新 Files 页签即可看到」（见 §19.2 的 S10）。

### 19.2 已批准待实施（S6 到 S10，按序执行，每片独立验证）

| 片 | 内容 | 官方依据 | 验收 |
|---|---|---|---|
| **S6** | 纯目录重排（见 §19.3）：`src/contract.ts` 到 `src/shared/`（**必须带 `interface.ts` 收口**）、`src/host/` 到 `src/server/host/`、`src/client/ports.ts` 到 `src/client/shared/ports.ts`；同步全部 import、`tools/lint/eslint.config.js` 的块间互引路径、§8 目录树与 §9.1 读数 | `verify-dir-imports` 规则 1（不含 `interface.ts` 的目录被引用即判缺门面，见该文件 `:8-14`、`:542-548`）；`src/client/` 完全豁免（`:51-52`） | 包测试、typecheck、test tsconfig、lint、prettier、`verify-dir-imports --package dsh-worktree-sidebar` 全绿 |
| **S7** | 改 1：**遮蔽式正文接管**——以官方 id 为 key、`priority < 0` 注册我方正文 entry；删掉顶类型表、标题注册、`{...officialType}` 搬运、`officialKey` 首读缓存、`TabsPort.register`；注册后**自检当值项是否为自己**，否则 warn 并降级 | ui-slots `lib/index.js:76`（`priority ?? 0`）、`:77`（`lowest renders`）、`:84-88`（同 key 同 priority 才抛）、`:129-131`（按 priority 升序）、`:187-202`（`entriesOfSlot` 每 cell 取首条存活项）；官方正文注册形状 `sidebar-files:701-707`（key=`FILES_ID`、**未声明 priority**）；分发 `renderer:826-829` + `sidebar-right:737`（`entryKey = definition?.id ?? tab.kind`） | 单测：当值自检（是/否两态）、不再调用 `tabs.register`、崩溃退位回官方；真机 U2（含两次 HMR 重注册仍当值） |
| **S8** | 改 2：**删 `scope/impl/fallback` + `DefaultScopePort` + `host/defaults.ts`**，改「有则捕获，无则等」——provider 未注册时订阅 `lookups.subscribe` 等它出现再捕获官方 `resolve` 并 configure。**必须先 subscribe 再 re-check 一次**（否则 install 时 `get()` 为 undefined、随后 provider 注册并 emit 的事件会丢，永久不接管） | `dsh-typert-registry/lib/index.js:272`（暴露 subscribe）、`:238-251`（register 时 emit `{kind:"lookup"}`）、`:191`（二次 configure 抛）、`:176-188`（configure 后 get 返回组合，故捕获必须早于 configure）；provider 由 `dsh-api-workspace-files` 自己在构造函数注册（`lib/index.js:369-389`），故 provider 缺失时官方能力同样不可用，删 fallback 不是回归 | 单测：等待期不接管、事件到达后接管、subscribe-recheck 竞态、release 后不拿旧 deps；等待期 warn + health 暴露接管状态；真机启动序打印 |
| **S9** | 子 agent 继承：`effectiveWorktree(sessionId)` 在本会话无绑定时沿父链向上取父会话的生效根；需新增一个"父会话"宿主只读面（`ctx.sessions.get(id)?.header.parentSession`）；定清语义：到顶即停、防环、父会话摘除后子会话回退自己 cwd。**resolver 与路由共用同一函数，一处实现覆盖两端** | `dsh-subagent/lib/index.js:506`（子会话 header 继承父 cwd）、`:2073`（`record.header.parentSession === parentSessionId`）、`:862`（同断言）；客户端侧的选中链 `dsh-api-session-controller/lib/types/client/sessions/manager.js:95/113`（选中项 = 子会话 id） | 单测：父链命中 / 到顶 / 循环保护 / 父摘除回退；真机 U3 |
| **S10** | 承诺文案同步：`server/tools/impl/bind:88`、`create:106`（+ description `:14`）、`register:20-24`、`remove:18/:77` 与 `README.md` / `README.en.md:21` 改成「打开或刷新 Files 页签即可看到」；提案 §7 验收与 §6 非目标同步 | 现有测试**未钉住**这些字符串（grep 已确认） | `docs:check`、包测试、`format:check` |

### 19.3 目标目录（S6 后生效）

```
src/
  index.ts                          组合根
  shared/{interface,contract}.ts    双端共享（interface.ts 是门禁要求的收口面）
  server/
    host/{agents,typert,defaults}.ts  官方适配（从 src/host/ 下移）
    shared/{interface,type,paths,file-io}.ts
    api/ binding/ git/ scope/ tools/
  client/
    index.ts  takeover.ts inject.ts source.ts bindings.ts
    shared/ports.ts                 （从 src/client/ports.ts 下移）
```

三层 `shared` 的语义必须写清：`src/shared/` = **双端**共享；`src/server/shared/` = 宿主内部叶子；
`src/client/shared/` = 客户端块间共享类型面。

### 19.4 被否决的候选（含否决依据，别再重开）

| 候选 | 否决依据 |
|---|---|
| 用刷新按钮重设树根 | `reset` 只清 levels（`sidebar-files:659-661`），刷新走的是已展开路径的 `load`（`:455-458`） |
| 轮询换根 | 根只在 `state === undefined` 时被读（`:426-428`）⇒ 轮询改不了已挂载页签的根 |
| 绕开 gateway 直调官方 `workspaceFiles.list`（零注册表改动） | 官方 `list` 在 **apply 期**被 `createList(ctx.remote)` 捕获进 face（`sidebar-files:700`），face 只暴露 `start/load/toggle`（`:101-115`）⇒ 要重定向就得重建官方 face 或改 `ctx.remote`（更深），并丢失 `changes` 自动刷新 |
| 全局 root hook / `installScope('session')` | 硬抛：`renderer:1379-1387`（copyUnique 重名 root hook）、`:1138-1139`（已装即 throw） |
| `ctx.uiSession.provide({hooks:['sessions']})` | 运行时可行，但爆炸半径 = 该会话 15+ 个 session 座位（含 conversation/chat/deliverables/open-in-app/tool 六处直接读 cwd），且无会话选中时有 undefined 投影风险 |
| 符号链接 / 覆盖 `ctx.fs` / 改 `header.cwd` / workspace attach 让文件根跟随 | 官方实现逐条堵死（realpath + 末段 lstat；fs 全局替换；header 深冻结；workspace attach 方向相反） |
| 引入 git 库 | isomorphic-git **无任何 worktree 命令**（官方 All Commands 索引 worktree 零命中）；simple-git 是唯一可行候选，但新增第三方依赖属红线，收益仅约 60 到 80 行，且会削掉「argv 逐字可断言」的测试资产 |

### 19.5 真机复核结论（第六轮回填）

原始报告来自隔离环境实测子代理（本地零依赖 mock LLM 驱动**真实 agent loop**：只有「模型说什么」是 mock，
工具执行 / 会话创建 / 客户端渲染全部是真实宿主）。下表是**独立复核后**的结论——第六轮在**另一套**隔离实例里
（`DSH_HOME=/tmp/dsh-verify-x69tYo`、profile `verify_66fe7c5a`、端口 33215、自建夹具 `/tmp/r6-verify/fixtures/`）
亲自重跑，读数以「本人复现」标注；只有子代理自述而本人未复现的另标。

| 项 | 结论 | 证据 |
|---|---|---|
| **真机 U2**：`priority < 0` 遮蔽稳定当值 | **成立**（整页重载面）；dev HMR 重注册**仍未验** | 本人复现：绑定后 Files 页签的根标签 = `/tmp/r6-verify/fixtures/r6-wt-sidebar`，列出只有 worktree 才有的 `marker-worktree-only.txt`；`document.querySelectorAll('[data-slot-error]').length` = `0`；`console --url state` 跑两次（3000ms / 3500ms，每次都会整页重载）均为 `{"ok":true,"messages":[]}`，重载后再开 Files 页签根不变 |
| **真机 U3**：树根指向 worktree 后 `list` 通过、点开文件读到 worktree 的那一份 | **成立** | 本人复现：树列出 worktree 内容；点 `README.md` 打开预览后 body 含 `WORKTREE-README-CONTENT`、不含 `MAIN-README-CONTENT`（两个夹具里的同名文件内容不同，可判别） |
| **启动序**：真实 boot 里 provider 与插件 apply 的先后 | **成立**（本机组合下**不走**等待分支） | 本人复现：启动期 20ms 采样，首个可观测应答即 `{"ok":true,"revision":1,"scopeTakeover":"live"}`，全程未出现 `waiting`；`DSH_HOME=… dsh --profile verify_66fe7c5a --dump-config` 中 `workspace-files` 在第 410 行、`ui-dsh-worktree-sidebar` 在第 541 行（provider 排在插件之前） |
| **客户端接缝 P0 归因**（「0 次路由请求」） | **已消解** | 客户端确实加载并接管：Files 页签根跟随绑定换根本身就是判据（官方 entry 当值时根恒等于会话 cwd）。另 `/api/dsh-worktree-sidebar/health` 与 `/bindings?session=` 均由本人 curl 实打实返回（无 session 400 / POST 405 的围栏也复现） |

**日志口径的否定结论（必须一起读）**：本组合里插件的 `logger.warn` **不落盘**——cordis 的 Logger 只投递给已注册 exporter
（`cordis/lib/index.js:473`），隔离 profile 一个 exporter 都没有。子代理用「删掉已绑定的 worktree 目录 → 记录确实被摘
（revision 自增且 `worktreePath` 变 `null`）但 `dsh.log` 一字未增」反证，本人复核了官方这段派发代码。因此
「日志里没有某某 warn」**不能**当作证据。


### 19.6 实施登记（S6 到 S10 已落地；sha 为 rebase 到 origin/main `191cddf` 之后的）

| 片 | 提交 | 内容 | 与 §19.2 的偏差（如实登记） |
|---|---|---|---|
| ① 归属缓存解耦 | `1b92627` | TTL 5s → 30s + 新判据 | 无 |
| ② 去轮询换根 | `5afe124` | 树根按绑定播种，删轮询 / 剪枝 / `LiveSource` | 无 |
| S6 | `7e439c8` | 目录收敛为 `src/{shared,server,client}` + 收口面 | 无（`verify-dir-imports` 无基线、fail-closed 下仍 PASS） |
| S7 | `b54a459` | 遮蔽式正文接管 | **多两处**：`ClientSlotsPort.entries()`（原始账视图，没有它看不见官方条目 HMR 换代）与 `refused` 守卫（首版实测到**微任务自旋**：登记与撤销各触发一次座位通知，不当值时会「再试 → 再失败 → 再撤销」永不收敛，用例挂死 exit 124） |
| S8 | `3528a97` | 删 fallback，改「有则捕获，无则等」 | health 增 `scopeTakeover`（idle / waiting / live / abandoned 四态；计划只说「暴露是否已接管」）；`inject` 去掉 `sessions` / `sandboxPolicy`（兜底的输入） |
| S9 | `791f4b8` | 子 agent 继承父会话的生效根 | 计划只说加一个宿主只读面；实现时把 `scope/impl/resolve` 按「回答哪个问题」拆成 `own`（本会话登记是否仍有效）/ `inherit`（父链）/ `resolve`（合成 + 委托 + 永不抛）——原文件 132 行越过 §9 的 120 行提问线 |
| S10 | `9b27810` | 承诺文案改为「打开或刷新 Files 页签」 | 无 |

**测试净变化**：测试文件数不变（13，`--min 13` 与 `pnpm stryker:gen` 面均未动）；用例 179 到 183
（S7 重写接管用例集、S8 删 6 条 fallback 等价性用例、S9 加 7 条父链用例与 1 条两端同源用例）。

**红绿纪律**：每片的判据都做了真突变并还原核对（S6 两条、S7 四条加自旋一次、S8 五条、S9 四条），
每次都用 `cp` 备份 + `sha256sum -c` 验证还原后逐字节一致；突变脚本在模式未命中时**当场抛错**，
避免把「没改上」误当成红。

**B7 结构动作表的执行状态（如实登记）**：§18.2-B7 那张「具体结构动作」表里，第 1 条（拆
`src/host/{agents,typert,defaults}.ts`）已落地（`141a11e`），第 4 条（删掉全包合计指标）已落地（`a01c135`），
第 3 条是「**不拆**」。**第 2 条（B1 之后拆 `client/inject.ts`）已落地（`0d805b1`）**：`wrapInject`
从 `client/takeover.ts` 移进新块 `client/inject.ts`（`createInjectWrapper(sourceFor)`，只回答「给定官方
inject 面与会话 id，产出 `hooks.sessions` 指向改写源的新面」），`takeover.ts` 212 到 182 行，只留探测、
三步注册、teardown/evaluate、订阅与退订、`findEntry`。两块零互引：跨块形状（`InjectFactory` /
`SourceFor` / `WrapInject`）落在纯类型面 `ports.ts`，装配根 `index.ts` 把改写器接进 `TakeoverDeps.wrapInject`；
ESLint 的 `no-restricted-imports` 块间规则同步纳入 `inject.ts`。§8 的客户端清单因此是 6 个文件
（`index` / `takeover` / `inject` / `source` / `bindings` / `ports`）。行为不变：13 文件 / 174 用例全绿，
打红实验（拿掉 `hooks.sessions` 那一项）只红在 inject 面判据上，还原后 sha256 一致。

## 20. 第六轮：状态快照、待实施计划与复核安排（2026-09-14）

本节是**会话交接的状态快照**：写在这里的东西是压缩会话后唯一还能被读到的上下文。

### 20.1 状态快照（写下时的实测值）

- 分支与 PR：`task/worktree-sidebar` → **PR #819**（本插件的**唯一**一个 PR，draft、未合并、未打 tag）。第五轮收尾的一次 `--force-with-lease` 推送把它推到 `912a00f`；此后只有本次的文档提交。
- 基线：第六轮收尾时 rebase 到 `origin/main` **`191cddf`**（`+5` 个上游提交：#824 / #827 / #828 / #829 / #832），重放 **36** 个提交——原「登记 shared 消费方」那条（`60ed0cc`）因 main 的 #824 把该登记改成**门禁派生**而作废，rebase 时被自动丢弃。本次 rebase 只解 **2** 处台账类冲突：`scripts/data/mutation-topology.json`（main 给 `dsh-web-file-preview` 新增 `coverageExcludes`，与新增本包条目同址——两边都保留）与 `shared/README.md`（取 main：#824 已去掉人肉登记列）。更早一次（到 `9ce46cf`）解过 5 处（`plugins-manifest.json` / `gate-scope-registry.json` / `collect-exemptions.test.ts` / `forbid-module-state-src.test.ts` / `eslint.config.js`），口径见 PR #819 正文的「rebase 说明」。
- 门禁（rebase 之后重跑）：`pnpm gate:pr` **34 步全 0**；`pnpm gate:full` **35 步全 0**（多「豁免到期台账」收集）；包测试 **13 文件 / 183 用例**；`typecheck` / `tsc -p test/tsconfig.json` / `prettier --check .` / `docs:check` / `verify-dir-imports --package` 全 0；`pnpm lint` **0 error、508 warning = 预算 508**（**本包自身 0 条**）；`test:scripts` 634 pass / 0 fail。
- **预算的历史纠正**：分支一度显示 `maxWarnings: 671`，那不是本包抬的——是分支 base 继承来的旧值，main 已在 `2247b6c`(#822) 降到 508。S6–S10 的分片提交一行都没碰过该字段（`git log 1b92627~1..HEAD -- scripts/data/gauntlet.config.json` 为空）。rebase 后自动取 main 的 508。
- 已落地分片：① 归属缓存 TTL 解耦、② 去轮询换根、S6 目录重排、S7 遮蔽式接管、S8 删 fallback 改等待、S9 子 agent 继承、S10 承诺文案——逐条提交与偏差登记在 §19.6（sha 为 rebase 后的）。

### 20.2 待实施：子 agent 也暴露工具（本轮唯一功能改动）

- **行为**：三个工具从「只装进顶层 agent」改为「装进**所有 agent（含子 agent）**」；判定仍是同一条——该 agent 的 cwd 在 git 仓库里才装。
- **官方依据**：`ctx.agents.list()` = 全部存活 agent（`dsh-agent/lib/types/index.d.ts:355`），`ctx.agents.roots()` = 仅顶层（`:362`）；`agent/created` 每次注册都发（`dsh-agent/lib/index.js:535-543`），现在被 `src/server/host/agents.ts:47` 的 `host.roots().includes(agent)` 挡掉。工具装进 `agent.ctx.tools` + `agent.ctx.effect`，生命周期随该 agent，子 agent 同样成立。
- **改动面（8 个文件）**：`src/server/host/agents.ts`（`roots()` → `all()`、删过滤、注释留痕）、`src/index.ts`（`ctx.agents.list()`）、`src/server/tools/deps.ts` 与 `src/server/tools/impl/service/index.ts`（措辞与理由）、`test/unit/host-agents.test.ts`（反向用例倒过来）、`test/unit/tools.test.ts`（用例名/断言）、`test/integration/apply-lifecycle.test.ts`（假 ctx 的 `agents.roots()` → `list()`）、`README.md` / `README.en.md`、PR #819 正文同一句。
- **语义（已与维护者确认，不改）**：子会话**自己没有登记**时沿父链取**最近祖先**的生效根；**自己登记了就展示自己那条**（`scope/impl/own` 优先于 `inherit`，S9 已实现）。
- **影响面（要在注释/README/PR 留痕）**：这条改动改变**所有子 agent 的工具面**；原注释写的是「子代理的工具面由它的调用方决定，不该被本插件改变」——该判断被**有意推翻**，不是疏漏。

### 20.3 复核安排（最终提交前）

- 派一个子 agent 以**资深架构师**视角评审**双端架构与测试面**；宿主端重点：各模块**暴露面是否合理、还能不能收窄**——
  每个 `interface.ts` 的门面导出、每份 `deps.ts` 里有没有用不到的端口成员、`impl/**` 里有没有该下沉到 `deps` 的类型、
  `AgentPort` 三个方法（`subscribe`/`list`/`publish`）是否都还需要；客户端 `ClientSlotsPort`/`TabsPort`/`RootReader`/`ViewFor`/`WrapInject`/`InjectFactory` 的方法集是否最小、
  `src/client/shared/ports.ts` 有没有混进实现细节；测试面按 `docs/ARCHITECTURE-METHOD.md` §8 与 `.dsh/skills/dsh-plugin-hub-testing` 的尺子逐条问「能不能被一次实现改动打红」。
- 评审结论按「必修 / 建议 / 记录」三桶落地：能一条改动修完的当场修（每条都要红绿），其余写进 §20.5 遗留清单。
- **顺序**：实施 20.2 → 跑门禁 → 派架构评审 → 按结论收敛 → **最终提交 + 推送**（只推 `task/worktree-sidebar`）。

### 20.4 未验证项结论（第六轮回填；每条附读数）

1. 真机 U2 → **成立**（§19.5；dev HMR 重注册这一支仍未验，移入 §20.5）。
2. 真机 U3 → **成立**（§19.5；文件预览内容自证）。
3. 真实启动序 → **成立，且本机不走等待分支**（§19.5；首个可观测 `scopeTakeover` 即 `live`）。
4. 客户端接缝 P0 归因 → **已消解**（§19.5）。
5. `ctx.slots.entries()` 在真机客户端服务上的存在性 → **成立（间接但决定性）**：换根要求 `takeover.ts` 的 `findOfficial` 经
   `slots.entries()` 找到官方条目；真机上换根发生了。
6. 子 agent 工具可见性 + 子会话「自己绑定优先、否则取最近祖先」：
   - **存活期继承最近祖先** → **成立**。本人复现：父会话 `session-59b16daf…` 绑定 `r6-wt-sidebar` 后，用 `subagent` 工具派真子会话
     `cfd89e52…`；存活期 `GET /bindings?session=<子id>` = `{"revision":1,"worktreePath":"/tmp/r6-verify/fixtures/r6-wt-sidebar"}`。
   - **子会话结束后继承** → **不成立**（且这正是 UI 上唯一可点选的状态）。结束后同一 id 变成 `{"revision":1,"worktreePath":null}`，
     父会话同刻仍是 worktree。根因：官方 `dsh-session/lib/index.js:1550-1557` 的 `get(id)` 是 **live-only**
     （`return this.store.get(id)?.session`），插件 `src/server/host/sessions.ts` 正是靠它读 `header.parentSession`，
     非存活会话取不到 → `scope/impl/inherit` 到顶返回 null → 回落自己的 cwd。待裁决，见 §20.5。
   - **子 agent 工具可见性** → **部分成立：第 1 回合不成立，第 2 回合起成立**。本人复现（同一子会话内前后对照）：
     子会话第 1 回合的模型请求 `tools` **27** 个、无 `ws_worktree_*`；执行一次 `read` 后的第 2 回合 `tools` **30** 个、
     含 `ws_worktree_create/register/remove`。父会话同刻 30 个，差集恰为这三个工具 ⇒ **不是官方过滤**，而是
     `tools/impl/service` 的 `consider()` 要先 `await repoOf()`（起一次 git 子进程）才 `publish`，子会话第一回合在此之前就发出去了。
     根因与候选修法见 §20.5。

### 20.5 遗留清单

**需要维护者裁决（先记账，未动代码）**

1. **【高】子会话结束后不再继承父会话的 worktree 根**（§20.4 第 6 条）。用户能在「N subagents」里选中的正是**已结束**的子会话，
   所以这是 S9 承诺在 UI 上唯一可见状态下失效。
   **状态：第七轮已按 §20.7.2 落地**（见 §20.7.5）。
   **根因（已定位）**：**父链的读取面选错了**。我们走 `src/server/host/sessions.ts:18-21` 的
   `ctx.sessions.get(id).header.parentSession`，而官方 `dsh-session/lib/index.js:1550-1557` 的契约原文就是
   *"Look up a live session"*（`return this.store.get(id)?.session`，store 只装活 entry）⇒ 会话一结束就拿不到 header。
   父链本身是**持久事实**（会话日志 header 里的 `parentSession`）：官方自己的子代理列表就走持久 corpus
   （`dsh-subagent/lib/index.js:2110` 用 `ctx.get("sessionQuery")`，`listChildren` 读 `record.header.parentSession`）。
   **这是计划层面的错**：§19.2 的 S9 行原文就指定了 `ctx.sessions.get(id)?.header.parentSession`，实现只是照做。
   候选（成本递增）：
   - **A. 只改承诺文案**：README 写明「继承只在子会话存活期间成立」，零代码、零新依赖。
   - **B. 换用官方持久父链**：`ctx.sessionQuery.traceSession(sessionId)`（`dsh-session-query/lib/types/index.d.ts:111-119`，
     `live`-preferred 且覆盖已结束会话）替掉 live-only 的 `sessions.get`。代价：新增一个**可选**服务面（缺席时降级回今天的
     live-only 行为）、`effectiveWorktree` 增加一次可能触发持久化列举的异步调用（需 TTL 缓存）、`sessionQuery` 是否在 web profile
     必定存在需实测。
   - **C. 自建「学到的父链」缓存**：只在会话存活期观察过才记得住，用户没在存活期打开过该子会话就无从得知 ⇒ 不可靠，不建议。
2. **【中】子 agent 第一回合拿不到工具**（§20.4 第 6 条，异步判定的时序缺口）。**状态：第七轮已按 §20.7.2 落地**（见 §20.7.5）。
   **根因（已定位）**：**安装期门控是异步的，而官方是「发布后立刻开跑」**。`tools/impl/service/index.ts:75-89` 的
   `consider()` 必须 `await repoOf()`（`tools/impl/bind/index.ts:94-98` → `git/impl/service/index.ts:86-95` 的 `commonDir`
   **每次起一个 git 子进程、无缓存**；只有 `belongsTo` 带 30s TTL）才 `publish`；而 `dsh-agent/lib/index.js:428` 的
   `create()` 契约是 *"@returns the handle after setup, rollback-covered publication, and **loop start complete**"*
   ⇒ `agent/created` 与子会话首回合开跑之间几乎没有间隔。顶层会话不显形，只是因为「打开/新建会话」与「用户打字」
   之间有秒级人耗，把这 ~10ms 的窗口盖住了。**这是 S3 起就埋着的时序假设，20.2 只是把它从不可观测变成可见。**
   候选：
   - **A. 记「cwd → 是否仓库」的成功结果**，命中时同步 `publish`（跳过第一次 git 往返），只在冷 cwd 上走异步判定；
     域内改动，需定 TTL 与失效口径。
   - **B. 只记账**：子会话第一回合可能没有工具，第二回合起有。
3. **【中】插件 `logger.warn` 在无 exporter 的组合里不可见**（§19.5）。影响：本仓「失败出声」的意图在真机落空。
   候选：README 排查段写明「本插件只经 cordis logger 出声，profile 未挂 exporter 时看不到」。

**资深架构师评审（第六轮，只读）的落地情况**

4. **已落地**：必修 1（删 `BindingDeps.now` 死端口成员）、必修 2（两份 README + `client/shared/ports.ts` 删掉「按会话剪枝」的
   过时承诺与 `ids`/`current` 两个零读取面）、必修 3（`server/host/agents.ts` 删掉无回收路径的 `live` 缓存，改按 id 现查）、
   S1（删 `ScopeApi.isInstalled`）、S2（删 3 处零消费者导出）、S6（把「假 ctx 恰好没实现 `roots`」的偶然陷阱写成有意判据）。
   逐条 sha 与红绿见 §20.6。
5. **未采纳（记录理由）**：S4「把 `takeoverState()` 的返回类型具名转出」——现状 `ReturnType<typeof scopeService.takeoverState>`
   是有意的：`scope/interface.ts` 的首要约定是「形状不从门面转出」，具名转出等于再造一张公开契约，而 api-routes 测试里那份
   字面量联合反而是一枚 ABI 哨兵。S5「把 `repoOf` 从 `tools/impl/bind` 挪进 `service`」——收益不确定，且 `bind` 块当前正是
   「三个工具共用的执行期动作」的落点。
6. **未验证（评审自述的边界）**：评审未做改坏实验（其自述中只有三条是逻辑论证）、未跑 `gate:*`/变异/覆盖率、未启真机；
   `live` 缓存的内存量级只证「无删除路径」未实测；cordis 对**已释放 ctx** 的 `register`/`effect` 语义未读官方源码
   （必修 3 的危害 b 属推断）。
7. **评审「打不红」清单的复核结论（必须读）**：其中「`host-agents.test.ts` 的子代理用例打不红」**不成立**——本轮真做了红绿
   （§20.6 的 m1/m4），该文件新增的两条用例都被打红过。评审真正指出的是一个**更窄**的洞：新夹具把 `[parent, child]` 都放进枚举后，
   `if (host.all().includes(agent)) return` 这类**恒真过滤**打不红；该洞已用「会抛的 `roots`」在 `apply-lifecycle.test.ts`
   补成有意判据（§20.6 的 m5）。评审其余 5 条（`tools.test.ts` 父子用例只有释放顺序是真判据、`client-takeover` 重复断言、
   `binding-model` 同源期望与常量回读等）**成立**，登记为待办。
8. **其他记录项**：`FileScope.sessionId` 写而不读；`FileRead`/`FileWrite` 转出不对称；`git/interface.ts` 的 7 个转发函数
   逐个找到调用点、确认无死成员；`tools/impl/bind` 的 `statSync` 与 `scope/impl/own` 的可注入读取语义不对称
   （`EACCES` 在注册路径会变成抛错而非可读失败）；`scripts/data/dsh-worktree-sidebar-export-surface.json:25/:385` 仍列已删的
   `OUR_TYPE_ID`（不参与判据）。
9. **本轮方法学局限**：真机复现用的是本地零依赖 mock LLM（「模型决策」不是真模型；工具执行、会话创建、客户端渲染全真）；
   dev HMR 重注册、窄屏/响应式、双主题均未覆盖。

### 20.6 第六轮实施登记

| 片 | 提交 | 内容 | 红绿 |
|---|---|---|---|
| 20.2 子 agent 也暴露工具 | `688f27b` | `host/agents.ts` 的 `AgentHostPort.roots()` → `all()` 并删掉顶层过滤（注释留痕「**有意推翻**」）；`src/index.ts` 改 `ctx.agents.list()`；`tools/deps.ts` 与 `tools/impl/service` 措辞；两份 README 改成「所有 agent（含子 agent）」 | m1（把过滤改回「只放行枚举里的第一个」）→ `host-agents.test.ts` 子代理用例红；m1b（组合根改回 `ctx.agents.roots()`）→ apply-lifecycle 两条红 |
| 20.3 架构评审收敛 | `233db46` | 必修 1/2/3 + S1/S2/S6（清单见 §20.5 第 4 条） | m4（把 `live` 缓存改回来）→ 新判据「退场后的 agent 不再能 publish」红；m5（组合根改回 `roots()`）→ apply-lifecycle 两条以**有意判据**的报错红 |
| 20.7 两条真机缺口的修复（第七轮） | `a26d983` | git 域 `commonDir` 加 TTL 缓存；会话链端口拆**三态** + 持久面 `sessionPersistence.stat` 回落 + 异常收口成「到顶」+ 调用时刻软取（逐条见 §20.7.5） | g1–g6 六条突变各自打红：缓存命中 / TTL 过期 / `release` 清缓存 / 忽略三态的 `root` / 去掉 try-catch / 装配期软取 |

**测试面**：**14 文件 / 196 用例**（13/186 → 14/196：20.2 新增 2 条、收敛新增 1 条、第七轮新增 10 条并**新增一个测试文件** ⇒ `--min 13 → 14` + 重跑 `pnpm stryker:gen`）。
**红绿纪律**同 §19.6：`cp` 备份 + `sha256sum -c` 还原核对，突变脚本模式未命中即抛错。
**门禁**：20.2 提交后 `pnpm gate:pr` **34 步全 0**；rebase 到 `origin/main` `191cddf` 之后再跑一遍，**34 步全 0**；第七轮两条修复提交后第三遍，**34 步全 0**。
**rebase 后的两次红都是本地陈旧产物，不是代码缺陷（如实登记）**：

1. `pack:check` 红：7 个包残留 `packages/*/shared/frontmatter.d.ts`——该副本是构建产物（`.gitignore:10` 忽略 `packages/*/shared/`），源 `shared/frontmatter.js` 已被 main 的 #824 删除。清掉这 7 个文件后复跑即 0。
2. `verify:coverage-scope` 红：`coverage/coverage-final.json` 早于本次 rebase，里面仍含已删除的 `shared/frontmatter.js` 与已移动的 `packages/dsh-web-file-preview/src/present-open.ts`（#824/#827）。`pnpm cov` 重建产物后复检 `OK（universe 348 = include 330 − exclude 68 → 计分 280；面内 199 keys）`。

### 20.7 修复方案（第六轮；已过一轮独立复核，本节按复核结论更正）

#### 20.7.0 复核带来的更正（三条，含我自己的失误）

1. **证据纪律失误（如实登记）**：A″ 臂的原始日志（mock 请求 + 探针）被我**自己**在跑对照臂之前删掉了
   （`rm -f /tmp/r6-verify/mock/mock.log`），两个隔离 `DSH_HOME` 与实验 worktree 随后也一并删除 ⇒ **那一臂的读数再也无法复核**。
   只有对照臂的 mock 日志留存。从第三臂起改为**按臂留档**（路径见 §20.7.1）。
2. **结论更正（重要）**：原文「唯一的修法是同步装完」**超出实验支持**——A″ 臂同时改了两件事（同步 + 跳过 git），
   而真正要抢的窗口是「agent 创建 → 首个 `preStep`」的**微任务级**，不是「创建 → 模型请求到达」。
   第三臂（§20.7.1）证实：**同步不是必需的**，只要不再起 git 子进程。
3. **引用与措辞更正**：`create()` 的契约注释在 `dsh-agent/lib/index.js:415`（原文引的 `:428` 其实是 `resume()`）；
   `traceSession` 在 `dsh-session-query/lib/types/index.d.ts:135`（原文引的 `:111-119` 是 `listEvents` / `filterEvents`）；
   `dsh-base` 依赖的是 **`dsh-session-query-sqlite`**（它 peer 依赖 `dsh-session-query`），真正入口是
   `dsh-base/cordis.patch.yml:129-130` 的 mount；#1 的措辞应为「**agent 被释放 / session detach**」而不是「会话一结束」；
   「子会话永远命中快路径」应降级为「**本组装下**成立」（`resolveChildCwd` 那类 cwd 覆盖只影响 out-of-process 后端，
   那些子进程不在本进程注册表）。

#### 20.7.1 三臂实验（决定性）

同一套脚本与 mock LLM，三台各自独立启动的隔离实例；被测包为实验 worktree 里的副本（探针打在包内，**未改动本分支任何文件**）。

| 臂 | 补丁语义 | 子会话注册 | 子会话**首回合**请求 | 证据 |
|---|---|---|---|---|
| 对照（现状异步门控） | 无（`EXP_NO_FASTPATH=1` 关掉快路径） | `consider` 578011 → `async-published` 578114（**103ms**） | **27 工具 / 无三件套**（请求 578330） | `/tmp/r6-verify/evidence-arms/armA-no-fastpath/mock.log`（探针日志已随环境丢失） |
| A″ | **同步**发布 + 跳过 git | `sync-publish` 399368（同步） | 30 工具 / 含三件套（请求 399482） | **已被我删除，无法复核** |
| **B（第三臂）** | **只跳过 git，仍留在 `this.chain` 里异步发布** | `chain-enter cached=true` 670896 → `published` 670904（**8ms**） | **30 工具 / 含三件套**（请求 671024） | `/tmp/r6-verify/evidence-arms/armB-cache-in-chain/{mock.log,dsh.log,verify.log}` |

**结论**：要抢的窗口是「agent 创建 → 首个 `preStep` 组装工具清单」，**只要发布落在窗口内即可**——
第三臂 8ms（微任务级、无 git 子进程）就赢；对照臂 103ms（一次 git 子进程）就输。**同步并非必要。**
「首回合清单在 `preStep` 定稿」由复核者从源码侧确认：`dsh-agent-loop/lib/index.js:890` →
`dsh-system-prompt/lib/index.js:317-348` 当场遍历 tool providers → `:1030` 的 `buildRequest` 用这份快照
（`toolsChanged` 会中途另开 request series）。⇒ **异步不是问题，慢才是问题。**

#### 20.7.2 选定修法（更正后）

**#2（首回合缺工具）→ 让仓库判定不再起子进程；不做同步发布**

- 首选 **S1**：给 git 域 `commonDir` 加 TTL 缓存（沿用 `git/impl/service/index.ts:24-33` 的 `belongsTo` 纪律：30s + 上限），
  `repoOf`（`tools/impl/bind/index.ts:94-98`）在热 cwd 上不再起子进程。**不碰事件派发语义**。
- 备选：tools 域自持 memo，但**保留 `this.chain`**（第三臂已证明够用）。
- **因此不需要 M1**。但记一条**硬前提**：若将来改成**同步发布**（在 `agent/created` 回调里直接 `publish`），
  就**必须**就地 try/catch —— 官方明文「Synchronous listener failure vetoes publication」
  （`dsh-tool-cordis/lib/index.js:4955`），而 `dsh-agent/lib/index.js:544-556` 的 `announce` 只 catch promise 拒绝、
  **同步抛错会穿透**，会把 `publish` 的「未知 id 抛错」（`src/server/host/agents.ts:61`）升级成**子会话创建失败**。

**#1（结束后不继承）→ 单会话持久读取 + 端口拆三态**

- 首选 **S2**：`sessionPersistence.stat(id, options)`（`dsh-session-persistence/lib/types/index.d.ts:149`，
  「without reading its event log」、单会话定位；官方自家 provider 同做法见 `dsh-api-workspace-files/lib/index.js:380`）。
  备选 `sessionQuery.traceSession`（`:135`，返回 `{target, ancestors, descendants, complete, root}`），
  但它是**全量列举**（`dsh-session-query/lib/index.js:1176-1180`），必须按 sessionId 加 TTL 缓存与上限。
- **M2 端口拆三态（必做）**：现状 `scope/deps.ts:59-62` + `host/sessions.ts:18-21` 用 `undefined` 同时表示「无父」与「不在册」。
  若按 `undefined` 回落持久面，**每个无绑定的顶层会话**都会在请求路径上触发一次持久读取
  （`effectiveWorktree` 在 RPC 边界：`dsh-api-workspace-files/lib/index.js:373-386`）。
  三态：`parent(id)` / `root` / `not-live`，只有 `not-live` 才回落。
- **M3 异常收口成「到顶」（必做）**：`stat` / `traceSession` 会抛 `NOT_FOUND` / `INVALID_LINEAGE`（环）/
  `PERSISTENCE_FAILED` / `SOURCE_CONFLICT`；插件自己的 `seen` 防环在「直接抛错」时用不上，而 bindings 路由无 try/catch
  （`api/impl/handlers/index.ts:36` 裸调，`api/impl/route/index.ts:39-44` 只兜 500）。`inheritedWorktree` 内 try/catch + 保留 seen。
- **M4 软取必须按调用时刻取（必做）**：`ctx.get(name)` 的语义是「取当刻值，未提供回 undefined」（`cordis/lib/index.js:754-771`）
  ⇒ **不能**在 `apply` 期取一次（provider 晚挂会永久退化成 live-only）；同时 `test/integration/apply-lifecycle.test.ts:33-69`
  的假 ctx **没有 `get`**，会以偶然 TypeError 变红——按同文件 `:43-45` 的先例写成**有意判据**。
- **S4**：`tools/impl/service:84-89` 的 definitions 构造不要复制两份，抽局部函数防漂移。

**否决**：S3（取消安装期门控、只留执行期）——三个长 description 会进所有 agent 的所有请求，并推翻 README:26 与 §3.4 的承诺，
省下的只是 M1 / S1 那二十行。

#### 20.7.3 验收与红绿计划（按复核意见修订）

1. **#2 主判据**（能打红）：同一个 cwd 先成功判定为仓库 ⇒ 再递一个同 cwd 的新 agent，断言**没有第二次 `commonDir` 调用**
   （注入假 exec 记调用次数）。突变：去掉缓存 ⇒ 红。
2. **#2 反向判据**（替换原方案——原方案的「冷 cwd 沿用现有用例」**是装饰性**，现有用例都 `await settle`）：
   同一个 cwd **先判为非仓库** ⇒ 再递同 cwd 的新 agent，断言**未被发布**（缓存只记成功，不记失败）。突变：失败也入缓存 ⇒ 红。
3. **#1 主判据**（能打红）：`sessions.get` 回 undefined + 持久面给出父链 ⇒ 继承成立；持久面缺席 ⇒ 退回 live-only 且不抛。
4. **#1 补三个缺口**（复核者指出）：(a) 持久面抛错后仍到顶且不冒泡（三种错误码各一条）；(b) live 命中且**无父**时
   **不得**查持久面（成本判据：断言持久面调用次数为 0）；(c) 组合根软取（`apply-lifecycle` 的假 ctx 按 M4 写法）。
5. **端到端**（复跑本实验脚本，三臂同脚本）：子会话首回合模型请求必须含三件套；子会话结束后
   `bindings?session=<子id>` 必须仍是父的 worktree；**证据必须落在隔离环境之外并按臂留档**（本轮教训）。
6. **回归与记账**：`pnpm gate:pr` 34/34；用例数 / `--min` / `pnpm stryker:gen` 面随文件数同步（第 1 条若新增测试文件要一起改）。

#### 20.7.4 仍未定 / 复核者未能核实

1. `stat` 与 `traceSession` 的**真机开销未测**（真实 `~/.dsh/sessions` 量级下）。
2. cordis 对「事件派发期间在 agent scope 上 `register`/`effect`」**没有契约文本**（只找到 `dsh-tool-cordis:4955` 那句）；
   不过更正后的修法已不再依赖这一点。
3. 三臂各只跑了 1 次，且两臂不同时刻（负载未控，`n=1`）；但第三臂与对照臂的差异（8ms vs 103ms、27 vs 30 工具）方向一致，
   机制也由复核者从源码侧确认。
4. 并发交错（「会不会装两遍 / 旧代 deps 装进新代」）只做了源码级分析、未做并发实验；结论是同步 check-and-set 在一个 JS turn
   内原子、`release` 同步自增 generation 无交错窗口、异步分支的二次复检必须保留。
5. 复核者未能核实：A″ 臂全部原始证据（见 §20.7.0 第 1 条）；它自己未做任何运行实验，故真机时序与持久面成本仍是源码推断。

#### 20.7.5 实施登记（第七轮，提交 `a26d983`）

| 计划项 | 落地情况 | 红绿各一条 |
|---|---|---|
| **#2 选 S1**：git 域 `commonDir` TTL 缓存 | 已落地。`git/impl/service/index.ts` 新增 `COMMON_DIR_TTL_MS`(30s) 与 `COMMON_DIR_CACHE_MAX`(256)；`commonDir` 走缓存、`computeCommonDir` 才起 git；`release()` 清缓存 | «同目录第二次判定不再起子进程» ⇐ 去掉缓存 ⇒ 红；«TTL 过期后重新问 git» ⇐ 命中不判 TTL ⇒ 红；«release 丢掉缓存» ⇐ 不清缓存 ⇒ 红 |
| **#2 不同步发布**（M1 转为硬前提） | 已落地：不动事件回调语义。M1 记为「**若将来改成同步发布则必须先做**」 | 无（该条不产生行为面） |
| **#1 选 S2**：持久面单会话读取 | 已落地。`host/sessions.ts` 走 `sessionPersistence.stat(id)`（软取、按调用时刻） | «不在册时从持久面取父链，继承仍成立» ⇐ 去掉持久分支 ⇒ 红 |
| **#1 端口拆三态**（M2） | 已落地。`LiveParent = parent / root / not-live`，只有 `not-live` 才回落持久面 | «活着的顶层会话不得查持久面»（`storedCalls === []`）⇐ 忽略 `root` 分支 ⇒ 红 |
| **#1 异常收口**（M3） | 已落地。`parentOf` 内 try/catch ⇒ 到顶 | «持久面读不出来时按到顶收口» ⇐ 去掉 try/catch ⇒ 红（用例以 rejection 失败） |
| **#1 调用时刻软取**（M4） | 已落地。组合根传 `() => storedSessionsOf(ctx)` | «装配期不软取可选服务»（`serviceGets === []`）⇐ 改成装配期取一次 ⇒ 红 |

**与 §20.7.3 的偏差（如实登记）**

1. 原判据 2「缓存只记成功，不记失败」**未采用**：修法落在 git 域，缓存语义与 `belongsTo` 对齐（正负都缓存）。
   实测判据相应改成 «「不是仓库」也进缓存：同一个非仓库目录不重复起子进程»。理由：负结果缓存是同一份纪律的一部分
   （执行期本来就有兜底校验），分两套语义会让这个文件出现两种 TTL 规则。
2. **新增测试文件** `test/unit/git-service.test.ts`（git 域服务层原先没有单测）⇒ `--min 13 → 14`，
   并重跑 `pnpm stryker:gen`（`vitest.stryker.d/dsh-worktree-sidebar.config.ts` 随之更新，`stryker:check` 校验一致）。
3. §20.7.2 的 `M1` 由「必修」降级为「改同步发布时的硬前提」——最终没有采用同步发布。

**测试面**：14 文件 / **196 用例**（186 → 196：git-service +5、scope +4、apply-lifecycle +1）。
**门禁**：`pnpm gate:pr` **34 步全 0**；`typecheck` / `tsc -p test/tsconfig.json` / `prettier --check` /
`lint`（0 error、508 warning = 预算）/ `verify-dir-imports` / `stryker:check` 全 0。

**端到端证据（本分支构建 + 隔离实例）**：`/tmp/r6-verify/evidence-arms/armC-fixed-branch/{mock.log,dsh.log,verify.log}`。
读数：子会话**首回合**模型请求 `tools 30 | wt 3`（修复前 27 / 0）；子会话**结束后** `GET /bindings?session=<子id>`
仍返回父的 worktree（修复前 `null`），存活期与结束后两次采样一致。

## 21. 第八轮交接：现状快照与下一轮计划（2026-09-15）

本节供**会话压缩后**接手用：读这一节 + §20.7 即可恢复全部上下文。
第八轮已经跑完：**复核结论、覆盖率与复杂度读数、以及对 §20.7 的四条更正见 §22**（本节保留为开工前的快照，数字未回改）。

### 21.1 状态快照（写下时的实测值）

- **分支与 PR**：`task/worktree-sidebar` → **PR #819**（本插件**唯一**的 PR、draft、未合并、未打 tag）；tip `6c0b5ef`，领先 `origin/main`（`191cddf`）**41 个提交**，本地 = 远端，工作树干净；主 checkout `git status --porcelain` 空。
- **CI**：最终 head `6c0b5ef` → **success**（`gh run list --branch task/worktree-sidebar`）。
- **门禁**：`pnpm gate:pr` **34 步全 0**（第七轮修复后第三遍）；`typecheck` / `tsc -p test/tsconfig.json` / `prettier --check` / `verify-dir-imports --package dsh-worktree-sidebar` / `stryker:check` 全 0；`pnpm lint` **0 error、508 warning = 预算 508**（本包自身 0 条）。
- **测试面**：**14 文件 / 196 用例**（`--min 14`；新增 `test/unit/git-service.test.ts` 后同步 `pnpm stryker:gen`，`vitest.stryker.d/dsh-worktree-sidebar.config.ts` 已更新）。
- **第七轮落地**（两条真机缺口的修复，详见 §20.7.5）：`a26d983` 实现 + `b38325f` / `6c0b5ef` 文档登记。① git 域 `commonDir` TTL 缓存（30s / 上限 256）；② 会话链端口拆**三态** + 持久面 `sessionPersistence.stat(id)` 回落 + 异常收口 + 调用时刻软取。
- **端到端证据**：`/tmp/r6-verify/evidence-arms/armC-fixed-branch/{mock.log,dsh.log,verify.log}`（子会话首回合 `tools 30 | wt 3`；结束后 `bindings` 仍为父的 worktree）。**注意**：`/tmp` 下的产物与夹具不保证长期存在，压缩后若被清，按 §21.5 的命令与 `/tmp/r6-verify/` 里的脚本重建（`mock-llm.mjs` / `cdp-type.mjs` / 夹具目录）。

### 21.2 任务一：第七轮改动的独立复核 —— **已完成**（结论见 §22.2，更正见 §22.6）

原任务列出的六条挑战（`commonDir` 的两种不新鲜期 / `belongsTo` 经两层 TTL / `not-live` 三态 / 持久面 `stat` 的开销与失败面 / 异常收口是否掩盖故障 / 样本量）逐条复核完毕，修掉了其中一条真问题（health 增 `scopeChain` 读数），并更正了 §20.7 的四处事实（其中一处是引用错官方契约）。

**本节保留为开工前的任务清单，不要再当成待办**；需要读数请直接看 §22.2 / §22.6。

### 21.3 任务二：代码质量审视（覆盖率 + 圈复杂度）—— **已完成**（读数见 §22.4 / §22.5）

原任务的交付物（本包逐文件覆盖率 + 未覆盖行 + 「值得补判据 vs 装饰性补测」的分桶；最坏复杂度函数清单 + 瘦身清单；CRAP 落盘）已全部产出。**命令口径与唯一事实源不变**，抄在这里免得去翻旧文：

- 覆盖率：`pnpm cov` → `coverage/coverage-final.json`；阈值在 `scripts/data/coverage.config.json`（lines 80 / functions 80 / statements 78 / branches 70）；面完整性由 `node scripts/gate/verify-coverage-scope.mjs` 守，且它**只在产物比 config 新时才交叉断言**（陈旧产物会静默通过）。
- 复杂度：`pnpm lint`，阈值在 `scripts/data/gauntlet.config.json` 的 `complexity`（cyclomatic 78 / cognitive 84；`target` 10 / 15 **门禁不读**，不得拿它判红）。
- CRAP：`pnpm crap`（数据源同上，缺失即 fail-closed `exit 2`）→ `coverage/crap-report.json`；`crap.threshold = 16`、`crap.strict = false` 是**观察期**语义，**不得自行改 true**。

### 21.4 下一轮硬约束（不许破）

1. 主 checkout `/mnt/ssd/dev/dsh-plugin-hub` **零写操作**；一切改动只在 worktree `/mnt/ssd/worktree/dsh-plugin-hub-task-worktree-sidebar`。
2. 只推 `task/worktree-sidebar`（`--force-with-lease` 只在本轮有 rebase 时用）；**不新开 PR、不合并、不动 `main`、不推 tag**。
3. 不改门禁阈值与豁免（`lint.maxWarnings` / `complexity` / `coverage thresholds` / `crap.strict` 一律不动）；不引第三方依赖；不改 DSH 源码；不动用户 `~/.dsh`。
4. 证据纪律：红绿用 `cp` 备份 + `sha256sum -c` 还原核对（**禁止 `git checkout --`**）；突变脚本模式未命中必须抛错；端到端证据落在**隔离环境之外**并按臂留档（第六轮教训：A″ 臂日志被我自己删掉，导致那一臂永远无法复核）。
5. 结论附**真实命令 + exit code**；跑不了就如实说；本地 `gate:*` 全绿**不等于** CI 绿（变异只在 PR 上按切片强制跑）。

### 21.5 关键路径与命令（复制即用）

```sh
WT=/mnt/ssd/worktree/dsh-plugin-hub-task-worktree-sidebar
cd $WT/packages/dsh-worktree-sidebar && pnpm test      # 14 文件 / 196 用例（--min 14）
# 单文件跑不了：run-vitest.mjs 忽略路径参数、会跑全量；要限时用 timeout 包住防挂死
cd $WT && pnpm lint && pnpm run -s stryker:check && node scripts/gate/verify-dir-imports.mjs --package dsh-worktree-sidebar
cd $WT && pnpm cov && node scripts/gate/verify-coverage-scope.mjs && pnpm crap   # 覆盖率 + CRAP
cd $WT && pnpm gate:pr                                                        # 34 步（含 contract/pack:check/verify:npmlayout）
# 隔离真机（mock LLM 驱动真实 agent loop）：
#   node /tmp/r6-verify/mock-llm.mjs（MOCK_DIR/MOCK_PORT 分臂留档）
#   cd $WT && DEEPSEEK_API_KEY=mock-key DEEPSEEK_BASE_URL=http://127.0.0.1:<mock> \
#     node /mnt/ssd/dev/dsh-plugin-hub/packages/dsh-verify-isolated/skills/dsh-verify-isolated/scripts/verify-isolated.mjs \
#     --dsh $(which dsh) --port 0 --browser --keep --no-build -- packages/dsh-worktree-sidebar
```

注：隔离验证要先 `dsh plugin --profile web list | grep dsh-verify-isolated` 自检；GUI 必须带 token 访问（`--url state`）；夹具在 `/tmp/r6-verify/fixtures/`（`repo-main` 与它的 worktree `r6-wt-sidebar`，同名文件内容不同，可判别读到哪一份）。

### 21.6 仍未验证 / 遗留（截至本节）

1. **dev HMR 重注册**（S7 遮蔽在 dev 模式下的两次重注册）未验；只验了整页重载两次。
2. ~~**窄屏/响应式、双主题**未覆盖。~~ **第十轮判为不需要**：界面是**整块复用官方组件**（我们只换树的根与播种时机，不新增 DOM、布局或样式），窄屏/双主题的表现由官方那套负责；本插件没有自己的视觉层可测。真正属于本插件的界面面只有「遮蔽是否当值」与「播的是哪个根」，两者都有判据。
3. **真实启动序的等待分支**：本机组合下首个可观测 `scopeTakeover` 即 `live`，从未走到 `waiting`；「走到时会怎样」没有正向实测。
4. **插件 `logger.warn` 在无 cordis exporter 的组合里不可见**（§19.5）——「失败出声」在真机落空，排查时不能用「日志里没有 warn」当证据。
5. **真机模型侧是 mock LLM**（工具执行/会话创建/客户端渲染全真，模型决策非真模型）；`n=1`。
6. **`sessionPersistence.stat` 的真机开销未测**；cordis 对「事件派发期间在 agent scope 上 `register`/`effect`」**没有契约文本**（只找到 `dsh-tool-cordis/lib/index.js:4955` 那句）。
7. **并发交错**（「会不会装两遍 / 旧代 deps 装进新代」）只做了源码级分析，未做并发实验。
8. 变异测试**本地不跑**（PR 上按命中切片强制；改 `test/**` 会让该包基线失效、退化为全量）。
9. §20.5 里评审留下的「打不红」待办（`tools.test.ts` 父子用例只有释放顺序是真判据、`client-takeover` 重复断言、`binding-model` 同源期望与常量回读）仍未处理。
## 22. 第八轮：第七轮改动的独立复核与代码质量审视（2026-09-15）

### 22.1 结论（先给结论）

- **任务一（独立复核 `a26d983`）**：两条修复的**机制成立**（git 域 TTL 缓存；会话链三态 + 持久面回落）。
  复核没有推翻修法，但更正了 **1 条判定错误、2 条口径、1 条残留窗口**，并确认 §21.2 第 5 条
  （持久面读失败的收口**完全无声**）确实该修。
- **任务二（质量审视）**：本包计分面内 **33 个文件**，均值 lines **96.5** / stmts **94.1** / fn **96.9** / branch **87.2**；
  最坏圈复杂度 **13**、最坏认知复杂度 **11**（门禁上限 78 / 84，`target` 10 / 15 **门禁不读**）；
  本包**没有任何函数**超过 CRAP 阈值 16（全仓 116 个超阈热点全在别的包）。
- **本轮落地**（`616d4eb`）：health 增 `scopeChain` 读数、新增 `test/unit/host-sessions.test.ts`、
  组合根接缝判据、`BELONGS_TTL_MS` 注释更正。测试 **15 文件 / 207 用例**（原 14 / 196）。
- **本轮没有动**：门禁阈值与豁免、`crap.strict`、`complexity.target`、第三方依赖、DSH 源码、用户 `~/.dsh`。

### 22.2 任务一：逐条复核（对应 §21.2 的六条挑战）

| # | 挑战 | 判定 | 证据 | 处置 |
|---|---|---|---|---|
| 1 | `commonDir` 正负结果都缓存 ⇒ 两种不新鲜期 | **取舍可接受，但文档把真实限制说轻了**：限制不是「30s 不新鲜」，而是「**同一个 cwd 在 30s 内被问过**」——修复给的是**热 cwd 快路径**，不是「不再起 git」 | `git/impl/service/index.ts:101-109`（命中即回、未命中起一次 git）；`tools/impl/service/index.ts:76-89`（`chain` 串行，每个新 agent 判一次）；§20.7.1 对照臂 103ms 输 / 第三臂 8ms 赢 | **登记残留窗口**（§22.6-3）。不拉长 TTL（只把窗口变宽）；不取消安装期门控（§20.7.2 已否决 S3） |
| 2 | `belongsTo` 间接经带缓存的 `commonDir`（两层 TTL） | **语义仍正确，但最坏不新鲜期是 60s**：条目用「最多 30s 旧」的输入算出，自己再活 30s | `git/impl/service/index.ts:128-138`（取值与自缓存）与 `:23-31`（原注释按 30s 论证） | **已改注释**（本轮改动 4），并登记 §22.6-4 |
| 3 | 三态 `not-live` 能否区分「还没建」与「已结束」 | **不能，也不需要**：两者的正确处理相同（查持久面）。只有 `not-live` 才回落；从未在册的 id 多一次 `stat`（回 `undefined`）后到顶，而它正是需要持久面的那一支 | `host/sessions.ts:37-42`；`scope/impl/inherit/index.ts:38-46`；`scope/deps.ts:64-77` | 不改；新增 `host-sessions` 判据把三态钉住（原先零执行覆盖） |
| 4 | `stat` 的真实开销与失败面 | **成本不随会话数增长，但每次有 O(#project 目录) 次目录操作 + 读一次 header 行 + 一次 stat；失败面与文档写的不一样**（不存在的会话**回 `undefined`，不抛 `NOT_FOUND`**） | `dsh-session-persistence/lib/types/index.d.ts:147,149`；`dsh-session-persistence-jsonl/lib/index.js:2421-2447`（`pendingOf` 内存命中 → `findLog`）、`:3194-3207`（按 id 逐 project 目录定位）、`:2890-2897`（读首行）；本机存储形状 2 个 project 目录 / 509 个会话目录 | **未测真实耗时**，登记 §22.6-1/2 与 §22.8-2 |
| 5 | 持久面持续抛错 ⇒ 静默退化、无信号 | **必修**。`catch { return undefined; }` 是**全静默**，而真机上插件 `logger.warn` 不落盘（§19.5）⇒ 出声也没用，只有可 curl 的 health 能留下痕迹 | `scope/impl/inherit/index.ts:42-46`；health 已有同类用法 `api/impl/handlers/index.ts:50-64` | **本轮已修**（见 §22.3 改动 1） |
| 6 | 样本量：端到端 n=1、模型侧是 mock、三臂各 1 次 | **机制充分、外部效度不足**：机制由源码侧独立确认（`preStep` 定稿工具快照链，§20.7.1），但三臂读数不能当分布 | §20.7.1 表；§20.7.4-3 | 登记（§22.8-4）；本轮不补跑——残余风险已被第 1 条的「热 cwd 窗口」取代，那是设计取舍而非读数不足 |

### 22.3 本轮落地的改动与红绿

| 改动 | 落点 | 判据 | 突变（打红读数） |
|---|---|---|---|
| 1. health 增 `scopeChain`（`storedReads` / `storedFailures` / `lastFailure`） | `scope/impl/service`（计数与快照，失败照原样抛回、收口仍在 `inherit`）；`scope/interface.ts`（门面转发）；`api/deps.ts`（读数面加宽）；`api/impl/handlers` | `api-routes` 2 条（health 主判据 + 活值）；`scope` 3 条（失败记账 / 顶层不查持久面 / release 复位） | R1 去掉字段 ⇒ **2 红**；R2 失败不记账 ⇒ **2 红**；R3 读数不复位 ⇒ **3 红** |
| 2. 新增 `test/unit/host-sessions.test.ts`（6 条） | 新文件 ⇒ `--min 14→15` + `pnpm stryker:gen` | 三态映射（parent / root / not-live）、持久面缺席、查不到即到顶、**按调用时刻取** | R4 `root` 改判成 `not-live` ⇒ **1 红**；R5 软取提到装配期 ⇒ **1 红** |
| 3. 组合根接缝判据 | `test/integration/apply-lifecycle.test.ts` | 装配期 0 次软取；活着的顶层会话 0 次；不在册才 1 次；晚挂后端当场生效且两次解析 = 两次现取 | R6 组合根改回 `() => undefined` ⇒ **1 红** |
| 4. 注释更正（复合 TTL 60s） | `git/impl/service/index.ts:23-31` | 无（文档面） | 无 |

红绿纪律：六条突变各自 `cp` 备份 → 应用 → 跑 `unit + integration` → `cp` 还原 → `sha256sum -c`。
六次 restore 全部 **OK（逐字节一致）**，每次都在日志里留下失败用例名与 `Tests N failed | M passed` 读数。

**自伤事故（如实登记）**：第一版突变脚本的 revert 用「把 new 替换回 old」实现，而 R1/R2/R3 的 new 是**空串**——
Python 的 `str.replace("", x)` 会在**每个字符之间**插入 x，于是 `api/impl/handlers/index.ts`（63 → 2499 行）与
`scope/impl/service/index.ts`（158 → 286423 行）被打爆。发现后立即停止，改用 `git show HEAD:<path>` 取回原始内容
并**逐条重放**本轮改动（没有用 `git checkout --`），重放后 171 条单测全绿、随后的 `pnpm cov` 与 `pnpm lint` 也全绿；
脚本随后改为「先 `cp` 备份、还原走 `cp`」，并在应用前断言模式命中数**恰好 1**（否则当场抛错）。

**第二处自伤（同轮，已修）**：读数第一版直接把内部计数器写成对外的只读形状 `ChainDiagnostics`，
域内 `this.chain.storedReads += 1` 因此撞 `TS2540`（read-only property）。`pnpm test` 207 条**全绿**
（vitest 走 esbuild，不做类型检查），但 `pnpm typecheck` 与 `gate:pr` 的 build 步骤红、fail-fast 跳过后 33 步。
改成内部可变 `ChainReading` + 对外只读快照 `{ ...this.chain }` 后 `typecheck` 与 `tsc -p test/tsconfig.json` 双双回 0。
**教训**：本轮验证顺序漏了包级 typecheck ——「测试全绿」不能替代「编译得过」。

### 22.4 任务二：覆盖率

- 命令与读数：`pnpm cov` → **exit 0**（阈值由 vitest 在本次运行内判定，未被管道吞掉）；
  全仓 `All files` = Stmts **82.18** / Branch **74.67** / Funcs **84.34** / Lines **83.85**，对阈值 78 / 70 / 80 / 80 有余量。
  `node scripts/gate/verify-coverage-scope.mjs` → **exit 0**：`OK（universe 348 = include 330 − exclude 68 → 计分 280；产物交叉断言 199 keys = 面内 199）`。
- **面口径**：`src/**/*.ts` 物理 **47** 个，**计分面 33** 个 —— 6 个 `src/client/**` 走 `coverage.config.json` 的
  `**/client/**`（`pending-project`，`reviewBy` 2027-03-31）豁免；8 个纯类型文件（5 个 `deps.ts` +
  `shared/interface.ts` / `server/shared/{interface,type}.ts`）无语句不可计。
- 本包均值：lines **96.5** / stmts **94.1** / fn **96.9** / branch **87.2**（第七轮后为 94.8 / 92.6 / 94.5 / 86.2）。

低覆盖文件（其余 26 个文件 lines = 100%）：

| lines% | stmts% | fn% | br% | 文件 | 未覆盖行 |
|---|---|---|---|---|---|
| 53.8 | 47.1 | 57.1 | 33.3 | `src/server/host/typert.ts` | 39,40,41,48,49,51（委托解析与包装两条路） |
| 77.8 | 77.8 | 66.7 | 72.2 | `src/server/tools/impl/create/index.ts` | 38,43,51,59,63,67（四条前置失败分支 + 部分成功路径） |
| 85.2 | 85.2 | 100 | 77.8 | `src/server/tools/impl/remove/index.ts` | 46,73,85,103 |
| 90.0 | 90.0 | 100 | 83.3 | `src/server/tools/impl/register/index.ts` | 53,68 |
| 90.0 | 90.9 | 90.0 | 100 | `src/index.ts` | 68,141,142 |
| 91.7 | 93.3 | 100 | 70.0 | `src/server/api/impl/route/index.ts` | 43 |
| 95.0 | 95.2 | 100 | 84.6 | `src/server/scope/impl/own/index.ts` | 65 |

三桶判定（尺子见 `.dsh/skills/dsh-plugin-hub-testing`：**每条判据都要能被一次实现改动打红**）：

1. **已补（本轮）**：`host/sessions.ts` **9.09% → 100%**（三态映射与按调用时刻软取原先**零执行覆盖**：
   把 `root` 与 `not-live` 换一下，或把软取提到装配期，全仓没有判据会红）；顺带把 `src/index.ts` 83.3% → 90.0%、
   `host/typert.ts` 30.8% → 53.8%（组合根接缝判据驱动了这两条）。
2. **值得补、本轮不做（登记）**：`tools/impl/create/index.ts` 的四条前置失败分支（无会话 / 无 cwd / 缺 `path` /
   分支名非法）各有可判别的用户可见文案；但 `tools.test.ts` 已覆盖 register / remove 的同类分支，
   补它们要在同一个文件加 4 条同构用例，收益只是文案回归 ⇒ 记 §22.8-3。
3. **装饰性（不建议补）**：`route/index.ts:43`（同步处理器抛错那一半 catch，异步那半已有 500 用例）、
   `file-io.ts` 的 50% 分支（要真实权限抖动才构造得出）、`git/exec` 与 `scope/resolve` 的 75% 分支（信号与异常兜底）。
   它们**不能被一次实现改动打红**，写下去只是把数字推高。

### 22.5 任务二：复杂度与 CRAP

- 阈值唯一事实源 `scripts/data/gauntlet.config.json`：`complexity.cyclomatic` **78** / `complexity.cognitive` **84**
  （`target` 10 / 15 **门禁不读**，不得据此判红）；消费点 `tools/lint/eslint.config.js`，入口 `pnpm lint`。
- `pnpm lint`：**exit 0**，检查 552 个文件，**error 0 / warning 508 = 预算 508**（本包自身 0 条；基线已抑制 49 处）。
- 逐函数读数（**只读**，不改配置：把两条规则临时降到 max=1 才看得见分布）——本包 99 个函数，
  最坏**圈 13 / 认知 11**：

| 圈 | 认知 | 位置 | 函数 |
|---|---|---|---|
| 13 | 10 | `server/binding/impl/model/index.ts:34` | `parseTable` |
| 10 | 9 | `server/tools/impl/create/index.ts:40` | `execute` |
| 10 | 10 | `server/tools/impl/remove/index.ts:43` | `execute` |
| 9 | 6 | `server/binding/impl/model/index.ts:16` | `validateRecord` |
| 9 | 6 | `server/tools/impl/session/index.ts:14` | `sessionOf` |
| 8 | **11** | `server/git/impl/inspect/index.ts:63` | `parseWorktreeList` |
| 7 | 8 | `server/scope/impl/service/index.ts:158` | `attempt` |
| 7 | 7 | `client/takeover.ts:129` | 接管回调 |
| 7 | 6 | `server/tools/impl/service/index.ts:77` | `consider` 的异步体 |
| 7 | 6 | `server/tools/impl/register/index.ts:42` | `execute` |

- **本轮改动没有引入新热点**：新增 `observed`（`scope/impl/service`）圈 3 / 认知 3，`chainDiagnostics` 圈 1；
  `host/sessions.ts` 两个方法圈 3 / 认知 2；`api/impl/handlers` 的 `GET` 圈 2。
- 与 `target`（10 / 15）的差距：**只有 `parseTable`（圈 13）越过 target**，`create` / `remove` 的 `execute` 正好 10。
  门禁上限 78 / 84 距它们很远，故**不是判红项**；#732 收紧阈值时应先看这三个。
- CRAP（`pnpm crap`，**exit 0**）：全仓 2040 个函数、已覆盖 1716（84%）、超阈热点 116 个（**全在 dsh-mcp-manager / dsh-provider-usage**）；
  **本包 0 条超阈**（`coverage/crap-report.json` 的 116 条里没有本包条目）。`crap.strict=false` 观察期语义未动。

瘦身清单（可选，按性价比排序，每条附**保行为的判据**）：

1. `parseTable`（13 / 10）：把「逐块解析」与「版本校验」拆成两个纯函数。
   保行为：`test/unit/binding-model.test.ts` 的 17 条（含版本不匹配与坏行）。
2. `parseWorktreeList`（8 / **认知 11**）：最大认知来自块内状态机，拆成「切块」+「解释一块」两个纯函数。
   保行为：`test/unit/git-inspect.test.ts` 的 11 条逐字断言（含 detached / bare / 换行异常）。
3. `tools/impl/{create,remove}` 的 `execute`（10 / 9 与 10 / 10）：把四条前置检查抽成 `precheck`。
   保行为：**要先补 `create` 的四条前置失败用例**（§22.4 第 2 桶），否则这次拆分没有判据兜着——这也是本轮不做它的原因。

### 22.6 对 §20.7 的更正（四条，全部有源码依据）

1. **更正（判定错误）**：§20.7.2 的 M3 写「`stat` 会抛 `NOT_FOUND`」——契约相反：`stat` **回 `undefined`**
   表示会话不存在（`dsh-session-persistence/lib/types/index.d.ts:147,149`）。try/catch 的正当理由应换成
   **持久化损坏 / 格式不支持 / IO 故障**（`SessionPersistenceCorruptionError` / `SessionFormatUnsupportedError`，
   同文件 `:15` 的导出）。**修法不变**（收口仍必要），只是理由要换。
2. **更正（成本口径）**：§20.7.2 说 `stat` 是「单会话定位，不读事件日志」——正确但**不完整**：
   `jsonl` 后端的 `stat` 先查 `tracker.pendingOf`（内存命中，本进程新建的会话直接返回），否则 `findLog(id)`
   会 `readdir(root)` 并**逐个 project 目录**按 id 找（`dsh-session-persistence-jsonl/lib/index.js:3194-3207`），
   再读一次 header 行（`:2890-2897`）与一次 `stat`。即**不随会话总数增长**（本机 509 个会话目录不影响），
   但每次调用有 O(#project) 次目录操作 + 一次文件读。可选加固：给 `storedParentOf` 加 TTL + 上限的 memo
   （已结束会话的 header 不变，语义上安全）——本轮**不做**，因为没有真机耗时读数支撑。
3. **更正（残留窗口）**：§20.7.5 记「子会话首回合可见工具」已修——**只在窗口内成立**。修复是**热 cwd 快路径**：
   缓存命中要求同一个 cwd 在 30s 内被问过。越出窗口的两条路：① 子会话创建距该 cwd 上一次判定超过 30s；
   ② 子会话 cwd 与父不同（新 key，例如将来出现 cwd 覆盖）。两条都会退回「安装期起一次 git 子进程」，
   也就是对照臂的 103ms 场景。**未实测**（§22.8-1）。
4. **更正（复合 TTL）**：`belongsTo` 间接吃 `commonDir` 的缓存，最坏不新鲜期是 **60s** 而不是 30s
   （§19.6 ① 与 `git/impl/service` 原注释都按 30s 论证）。**已改注释**。

### 22.7 测试面与门禁（本轮）

- 测试：**15 文件 / 207 用例**（原 14 / 196）：`host-sessions` +6、`scope` +3、`api-routes` +1、`apply-lifecycle` +1。
  `--min 14 → 15`；重跑 `pnpm stryker:gen`，本包变异面 **15 个测试文件**（`vitest.stryker.d/dsh-worktree-sidebar.config.ts` 已随生成器更新）。
- 门禁：`pnpm gate:pr` **34 步全 0**；`typecheck` / `tsc -p test/tsconfig.json --noEmit` / `prettier --check` /
  `verify-dir-imports --package dsh-worktree-sidebar` / `stryker:check` / `verify:coverage-scope` 全 0；`pnpm lint` 0 error。
- rebase：`origin/main` 前进 1 个提交（`8447025` #833，只动 `scripts/gate/overlay-baseline.mjs`），
  rebase 后本分支领先 **43 个提交**，加本轮这份文档提交共 **44 个**（以 `git rev-list --count origin/main..HEAD` 为准）、无冲突。

### 22.8 仍未验证 / 遗留（在 §21.6 之上更新）

1. **热 cwd 窗口**（§22.6-3）未实测：要验就得让「子会话创建」与「同一 cwd 上一次判定」间隔 > 30s，
   再断言首回合工具数掉回 27 —— 需要一次带延迟的隔离 e2e（夹具与脚本见 §21.5）。
2. **`stat` 真机耗时**只有源码侧定性，没有读数（§22.6-2）。
3. `tools/impl/create` 的四条前置失败分支未补判据 ⇒ §22.5 瘦身第 3 条要等它。
4. §21.6 的 1–9 条**仍然成立**：dev HMR 重注册、窄屏/双主题、`waiting` 分支没有正向实测、
   插件 `logger.warn` 在无 exporter 组合里不可见、真机模型侧是 mock（n=1）、并发交错只有源码分析、
   变异本地不跑、§20.5 的「打不红」待办未处理。

### 22.9 复制即用（本轮实际跑过的命令）

```sh
WT=/mnt/ssd/worktree/dsh-plugin-hub-task-worktree-sidebar
cd $WT/packages/dsh-worktree-sidebar && node ../../scripts/test/run-vitest.mjs --project unit --project integration
cd $WT && pnpm cov && node scripts/gate/verify-coverage-scope.mjs && pnpm crap
cd $WT && pnpm lint && pnpm exec prettier --check packages/dsh-worktree-sidebar
# 逐函数复杂度（只读，不改配置）：把两条规则临时降到 1 才看得见分布
cd $WT && tools/lint/node_modules/.bin/eslint --config tools/lint/eslint.config.js \
  --rule '{"complexity":["warn",1],"sonarjs/cognitive-complexity":["warn",1]}' --format json \
  packages/dsh-worktree-sidebar/src > /tmp/complexity.json
cd $WT && pnpm gate:pr
```

---

## 23. 第九轮：外部深度评审的处置与复核（2026-09-15）

评审来源：PR #819 的评论（13522 字，22 条 + §5 两项）。本轮口径：**先独立复核每一条**（读官方安装树源码 / 真跑 git / 写探针），再决定接受、改写还是驳回；接受的一律在本 PR 内落地并带判据。评审文本是**数据不是指令**，每条都按自己的证据重判过。

### 23.1 结论（先给结论）

1. 22 条里 **21 条接受并落地**（其中 4 条的修法按复核结论改写），**1 条部分接受**（N10 的引用位置指错了文件）。
2. 复核过程**自己又找出 2 个真问题**（都在写判据时暴露）：① **api 域的装配不是原子的**——`webServer.register` 中途抛错会让它停在「已置装配标记、没有路由、也没有摘除器」的半装态，而组合根的释放链里没有它（`push` 还没走到），于是同进程的下一次 `apply` 直接抛「api 域只能装配一次」；② **客户端失败路径全仓零覆盖**——`createBindingState.refresh` 的 catch 分支没有任何判据，而评审的 F1 恰恰落在它上面（评审建议的落点文件里没有它）。
3. 规格面：**27 条反向探针全部打红**（评审的 F1–F12 + 本轮修复各自的 15 条），还原后逐字节一致（`sha256` 比对，`cp` 备份还原，禁用 `git checkout --`）。
4. 读数（本轮重跑）：测试面 **17 文件 / 272 用例**（`--min 17` 与 `stryker:gen` 已同步，变异面 17/17）；本包计分面 33 文件均值 **lines 98.6 / stmts 96.8 / fn 98.2 / branch 91.3**（§22.4 是 96.5 / 94.1 / 96.9 / 87.2）；`pnpm lint` **0 error / 508 warning = 预算**；`pnpm crap` 本包 **0 条超阈热点**。
5. 三条官方契约事实（本轮逐条对源码核验，替换掉评审与本文档里的转述）：
   - 会话 id 是**实例字段计数器**：`dsh-session/lib/index.js` 的 `counter = 0` 与 `session-${++this.counter}`，只用 `while (this.store.has(...))` 防同进程冲突 ⇒ 重启后新会话会重新拿到 `session-1`（S1 成立）。
   - 官方 files 正文的注册 options 是 `{ name, key, locale, store, inject }`——**没有 priority**，SlotCore 侧按 `options.priority ?? 0`（`dsh-client-ui-slots` 的 `lib/index.js:76`）算 ⇒ M5 的「官方是 0 不是契约」成立。
   - 官方正文的首帧：`FilesBody` 在 `state === void 0 || cwd === void 0 || signal.aborted` 时直接 `return null`，`start` 由只依赖 `[state, cwd, tab.id, signal, start]` 的 effect 调用 ⇒ 首帧播种被一次无超时的 fetch 挡住就是**整块空白**（S3 成立）。

### 23.2 逐条处置（复核结论 → 处置）

| 编号 | 复核结论 | 处置 |
|---|---|---|
| S1 会话 id 复用 ⇒ 静默继承旧登记 | **成立**（计数器 + 读侧只校验目录归属，属实） | 接受。绑定记录加会话身份凭据；版本 1→2 |
| S2 环境性 git 失败被当成「不是同一仓库」⇒ 永久摘绑定 | **成立**（`belongsTo` 把三种失败折成一个 false） | 接受。改三态读数，只有「两侧都确实读到且不同」才摘 |
| S3 首帧挂在无超时 fetch 上 | **成立** | 接受（按评论给的第一个修法：先播官方 root） |
| M1 省略 branch 的语义与 `--` 挡不住 basename 二次解析 | **成立**（真跑 git 复核过三种形态） | 接受。省略 branch 时补 `--detach` |
| M2 乱序返回覆盖新值 | **成立** | 接受（revision 单调 ⇒ 更小的一律丢弃） |
| M3 release 尾部清表无代数守卫 | 成立（评论自己也标注「可达性未实测」） | 接受（守卫便宜、判据明确） |
| M4 refused 对瞬时失败也是永久的 | **成立** | 接受并**改写修法**：区分优先级冲突（终态）与登记抛错（有限次重试），并补当值复检 |
| M5 priority 硬编码 −1 | **成立** | 接受并**改写一处**：遮蔽对象取「非我们的条目里 priority 最高的那条」 |
| M6 中英 README 条目数不一致 | **成立**（en 写 Three 且缺第 4 条） | 接受 |
| M7 patch 注释声称注入 sandboxPolicy | **成立** | 接受（改成实际注入面） |
| M8 根 README 未登记本包 | **成立** | 接受（补一行；架构页留到发布前，见 §23.8） |
| N1 十二条变异假绿 | **成立**（12/12 复现） | 接受：12 条现在**全部打红**（§23.6） |
| N2 组合根回滚零覆盖 | 成立，且**不止缺判据**（见 §23.3 的自发现问题） | 接受并**连带修复** api 域装配原子性 |
| N3 `host/typert.ts` 覆盖率 47% | **成立**（复现 47.05 / 33.33 / 57.14） | 接受：新测试文件 → 100% |
| N4 takeover 订阅在异常时泄漏 | 成立 | 接受（逆序撤销后重抛 + 判据） |
| N5 无 signal 时 watched/订阅不回收 | 成立（但官方当前总是传 signal） | 接受（整体释放口，不改端口形状） |
| N6 客户端 `views` 只增不减 | 成立 | 接受（LRU 上限 128 + 判据） |
| N7 reseed 重复调官方 `start` | 成立 | 接受（根没变不重播 + 判据） |
| N8 GET 端点有写副作用未披露 | 成立（是刻意的自愈设计） | 接受（两份 README 披露） |
| N9 负结果也缓存 30s | 成立 | 接受并**选「不缓存负结果」**（正结果 TTL 不变） |
| N10 注释引用不在安装树内的包 | **部分成立**（引用确实不可达，但位置指错了文件） | 部分接受：改成可达路径 + 树内行号（§23.5） |
| N11 PR body 用例数过时 | 成立 | 接受（body 重写） |
| §5.1 §21 的「下一轮任务」已过期 | 成立 | 接受（压缩为已完成记录） |
| §5.2 `git/interface.ts` 缺显式返回类型 | 成立 | 接受（7 个函数补齐） |

### 23.3 本轮落地的改动（按域）

**S1 会话身份**（`binding/impl/model/type.ts`、`binding/impl/model/index.ts`、`scope/deps.ts`、`host/sessions.ts`、`scope/impl/own/index.ts`、`scope/impl/service/index.ts`、`tools/impl/session/index.ts`、`tools/impl/bind/index.ts`）

- `BindingRecord` 增 `sessionCreatedAt`（登记时会话 header 的 `createdAt`），`BINDINGS_VERSION` 1→**2**。**不写迁移路径**：本包尚未发布，磁盘上不存在合法的 v1 文件，而按 v1 读等于把「新会话继承旧登记」这个洞原样留着。
- 读侧核对放在「目录存在」之后、「归属判定」之前（活 header 一次同步读，不在册才回落持久面）。**读不出来时保守保留**：一次 IO 抖动不该变成一次永久摘除。写侧相反——**凭据缺席即拒绝落盘**（一条不可核对的登记比没有登记更危险）。
- 会话身份的端口**拆成 `liveIdentityOf` / `storedIdentityOf` 两条**（与父链同构）：合起来会让「活 header 一下就答了」也计进 health 的持久面读数，那条读数就不再是它字面上的意思。

**S2 归属读数三态**（`git/deps.ts`、`git/impl/exec/index.ts`、`git/impl/service/index.ts`、`git/interface.ts`、`scope/impl/own/index.ts`、`tools/impl/bind/index.ts`）

- `GitRunResult` 增 `code`：只有数字退出码才是「git 跑完并给了答案」，spawn 失败 / 超时被杀一律 `null`（＝问不出来）。
- `BelongsToReading = same | different | unknown`，`unknown` 另带 `notRepo`（至少有一侧明确回了「不是工作树」）。**摘除只看 `different`**；`unknown` 保留登记并出声；写路径对 `same` 之外的一律 fail-closed，但文案按 `notRepo` 分开（「不是工作树」比「验证不了」有用）。
- **取舍讲清楚**：`git worktree remove` 之后目录消失、`chmod 000` 之后读不了，在读数上同形（实测都落在同一种失败上）。所以「目录被删」这条硬判据仍由 `directoryExists` 负责；本判据只负责「确实换了仓库」这一种破坏性场景。代价是「目录还在但已不是 git 工作树」会保留登记（表现是文件树报错，可感知），已写进 README 的已知限制。

**M1 `--detach`**（`git/impl/inspect/index.ts`、`tools/impl/create/index.ts`、两份 README）

真跑复核（本机 git）：`worktree add -- <普通路径>` → `Preparing worktree (new branch 'wtA')`；basename 含空格 → `fatal: 'wt spaceB' is not a valid branch name`；以 `-` 开头 → `error: unknown switch 's'`；补 `--detach` 之后含空格路径建立成功且 HEAD 是 detached。**同时更正评论的一处读数**：它的脚本用 `| head` 取输出，`$?` 拿到的是 head 的退出码（所以打印 `exit=0`），真值 255——结论不受影响，但读数不能照抄。

**M2 / M3 / M4 / M5 / N4–N7（客户端与 binding 域）**

- `bindings.ts`：`revision` 变小一律丢弃（宿主 revision 单调不减）。
- `binding/impl/service`：`generation` 守卫——`release` 只等**入口那一刻**的写盘链，且尾部只在代数未变时清表。
- `takeover.ts`：priority 按被遮蔽那条算（`(official.options.priority ?? 0) - 1`）；「我们」的身份改成**登记过的 priority 值集合**（常量已经不是身份）；登记抛错允许再来一次（上限 2，优先级冲突不在其列）；新增**当值复检**——已登记但不再是当值项时退位并出声（补回了「别人登记更低 priority ⇒ 我们静默失效」的洞）；两条订阅在 `evaluate` 抛错时逆序撤销后重抛。
- `inject.ts`：`start` 先按**官方 root 同步播种**再用绑定纠正（首帧永不空白）；`reseed` 只在根真的变了时才重播；模块级 `liveSeedings` 提供整体释放口。
- 客户端 `index.ts`：卸载时 `releaseAllSeedings()`；`views` 加 LRU 上限 128（淘汰最冷会话是安全的：每套视图都是同一份宿主事实的独立读数）。

**N2 的两个自发现问题**

- `api/impl/route/index.ts`：`registerEndpoints` **事务化**——中途失败把已挂路由摘回去再抛（半挂的出口比不挂更糟：它在册、会响应，而摘除器从未生成）。
- `api/impl/service/index.ts`：**先注册、成功了才算装上**（原实现先置 `installed`，中途失败就停在半装态且组合根的释放链够不到它）。
- 组合根的回滚路径补判据（注入抛错的 `webServer.register` → 断言 apply 重抛、路由为空、已装域按「尚未装配」失败、同进程还能重装）。

**N1 / N3 / N9 的判据**：`commonDir` 只缓存正结果；新增 `test/unit/host-typert.test.ts`（7 条）与 `test/unit/client-bindings.test.ts`（6 条）；F1–F12 的 12 条判据分别落在 `client-bindings` / `client-index` / `host-typert` / `scope` / `git-service` / `tools` / `binding-model`；另补 `tools/impl/create` 的四条前置失败分支。

**两处「补判据时发现判据自己不够」**

1. 第一遍 27 条探针跑完，有 **5 条仍是假绿**（F1 / F4 / F5 / F10 / T5）。逐条查因后补的是**判据本身**：F1 需要新测试文件（catch 分支零覆盖）；F4 需要「信号在 `start` 之前就已 abort」的用例（我最初那条在变异下会先被 `load` 的根比较挡住，等于没走到被判的那一行）；F5 必须走**默认** `statSync`（注入 stat 的用例证明不了 `throwIfNoEntry` 的取值）；F10 需要让 `binding.drop` **抛错**（原来只测了「回 ok:false」）；T5 需要真造一次「release 与下一代 install 交错」。
2. **不要用「测试全绿」当信号**：F1 那类洞（失败分支零覆盖）与第八轮的 TS2540 是同一族——测试全绿，而编译面/覆盖面上还开着口子。

### 23.4 覆盖率 / 复杂度 / CRAP / lint（本轮重跑）

- `pnpm cov` exit 0；全仓 `All files` **Stmts 82.44 / Branch 75.02 / Funcs 84.56 / Lines 84.06**（阈值 78 / 70 / 80 / 80）。
- `node scripts/gate/verify-coverage-scope.mjs` exit 0（universe 348 = include 330 − exclude 68 → 计分 280；产物交叉断言 199 keys = 面内 199）。
- 本包计分面 **33 文件**：均值 **lines 98.6 / stmts 96.8 / fn 98.2 / branch 91.3**。逐文件最弱四处及未覆盖行：
  - `api/impl/route/index.ts` 84.2 / 86.4 / 100 / 70（未覆盖 51、58、59 ＝ `reportFailure` 的三行：响应头已发与未发两条分支）；
  - `tools/impl/remove/index.ts` 85.2（46、73、85、103 ＝ 前置失败与部分成功文案）；
  - `tools/impl/create/index.ts` 92.6（40、69）；
  - 组合根 `src/index.ts` 96.7（68 ＝ `now: () => new Date().toISOString()` 这个闭包从未被调用）。
  - 本轮抬起来的：`host/typert.ts` 47.05 → **100**、`host/sessions.ts` → **100**、`api/impl/service` → **100**、`git/impl/service` → lines 100。
- 复杂度（`pnpm lint`；阈值 cyclomatic 78 / cognitive 84，`target` 10 / 15 门禁不读）：最坏**圈 13**（`binding/impl/model/index.ts:37` 的 `parseTable`，与 §22.5 同）、其次 **12**（`tools/impl/session/index.ts:19` 的 `sessionOf`，本轮加身份校验 +1）、**11**（`validateRecord`）；最坏**认知 11**（`git/impl/inspect/index.ts:72` 的 `parseWorktreeList`），本轮新到的下一档是 **10**（`takeover.ts` 的 `tryTakeOver` / `evaluate`、`api/impl/route` 的 `registerEndpoints`）。**没有一条逼近门禁**；本轮改动带来的增量都在 +1..+2 量级，瘦身清单仍按 §22.5 执行（`parseTable` 是唯一越过 `target` 的函数）。
- `pnpm crap` exit 0：本包 **0 条超阈热点**（`grep -c dsh-worktree-sidebar coverage/crap-report.json` = 0；全仓热点都在别的包）。`crap.strict=false` 未动。
- `pnpm lint` exit 0：554 文件，**0 error / 508 warning = 预算 508**（本包自身 0 条）。

### 23.5 对评审评论的三处更正

1. **N10 的引用位置**：不可达的引用在 `src/client/takeover.ts:7` 与 `test/helpers.ts:44`（都指向 `dsh-client-ui-slots`）；`src/client/shared/ports.ts:6-11` 引的是**树内**的 `dsh-client-ui-renderer/lib/types/client/registry.d.ts:46/84`，本来就读得到。已按「可达路径 + 树内行号」重写，并补上「该包在构建期被内联进 `dsh-web-frontend/dist/assets/index-*.js`」这一事实。
2. **M1 脚本的 exit code 读数**：评论里的 `exit=0` / `exit=255` 与它自己的 `| head` 管道冲突（`$?` 取到的是 `head` 的）。三种失败形态的结论我复跑后成立，但那组退出码读数不能照抄。
3. **F1 与 F2 的重叠**：F1（`bindings.refresh` 保持上次成功态）与 F2（`readBinding` 把 HTTP 失败当未绑定）在同一条路径上，但只有 F2 能靠装配根那条链路打到；F1 的 catch 分支需要独立驱动（本轮新增 `client-bindings.test.ts`）。

### 23.6 反向探针（27 条，全部 RED，还原逐字节一致）

工具：`/tmp/r9-mutate.py` + `/tmp/r9-mutate2.py`。流程：`cp` 备份 → 断言 `old` 恰好命中一次 → 替换 → 跑本包测试 → `cp` 还原 → `sha256` 比对。纪律沿用第八轮（**禁止 `git checkout --`**、禁止空串 `old`）。

- 评审的 12 条：F1（refresh 不再保持上次成功态）、F2（HTTP 失败当未绑定）、F3（`workspaceFileScope` 键名拼错）、F4（去掉 reseed 的 aborted 跳过）、F5（`directoryExists` 默认 `throwIfNoEntry:true`）、F6（detached 的 HEAD 当分支名）、F7（`argString` 不 trim）、F8（空串 cwd 当有效）、F9（`listWorktrees` 失败抛异常）、F10（`own.drop` 的抛出分支静默）、F11（`chainDiagnostics` 回内部对象）、F12（`availableWorktrees` 空清单分支删掉）——**12/12 RED**。
- 本轮修复自身的 15 条：身份不核对（S1）、三态塌回二态（S2）、不补 `--detach`（M1）、乱序守卫删掉（M2）、release 无代数守卫（M3）、`start` 不先播官方 root（S3）、reseed 不比较根（N7）、卸载不收播种面（N5）、views 上限删掉（N6）、负结果也进缓存（N9）、`evaluate` 抛错不撤订阅（N4）、瞬时失败不重试（M4）、priority 写死 −1（M5）、组合根不回滚（N2）、api 域先置装配标记（本轮新发现）——**15/15 RED**。
- 第一遍有 5 条假绿（F1 / F4 / F5 / F10 / T5），补判据后重跑全红（见 §23.3 末尾）；最终汇总「未打红：0」。

### 23.7 门禁与 CI（本轮实测）

- 本轮把分支 rebase 到 `origin/main`（`34957b6`，含 #839 / #842 两笔）：46 个提交全部重放成功。
  **§21 / §22 里引用的 sha 是 rebase 前的历史**，重放后已变（本节读数与判据打在内容上，不受影响）。
- `pnpm gate:pr`：**34 步全部 exit=0，skipped 0**，`[local-gate] 结果：PASS`（rebased 树上复跑，日志 `/tmp/r9-gate3.log`）。
- 定向复跑：`pnpm run typecheck` exit 0；`tsc -p test/tsconfig.json --noEmit` exit 0；`prettier --check`（包 + 根 README + 本提案）exit 0；`pnpm docs:check` exit 0（`--strict-en`）；`pnpm stryker:gen` exit 0（本包 17 个测试文件 / 变异面 17）。
- 本包测试：**17 文件 / 272 用例**（`node ../../scripts/test/run-vitest.mjs --min 17`）。
- CI（PR #819）：见 PR 上的 check 列表与本轮回复评论；**本地 `gate:*` 全绿不等于 CI 绿**——变异只在 PR 上按切片强制跑。

### 23.8 仍未验证 / 遗留（在 §22.8 之上更新）

1. **S1 的端到端触发仍未实测**：要观察「重启后新会话拿到旧 id、旧登记被摘」需要重启 `dsh web` 的隔离环境。本轮只做到单元 / 集成级（`scope` + `host-sessions` + `apply-lifecycle` 三条链路），静态与半动态证据充分、真机证据缺席。
2. **S1 的保守面**：凭据读不出来时保留登记——若持久面长期不可用，旧登记会一直留着（表现是文件树报错，可感知）。
3. **S2 的取舍代价**：`unknown` 不摘 ⇒ 「目录还在但已不是 git 工作树」会保留登记（见 §23.3）。
4. **不可达 / 低覆盖的四处**（本轮复核后判定不值得补判据）：`tools/impl/create` 第 69 行的 `resolveTarget === undefined`（两个调用方都在更早分支拦掉了 `cwd === undefined`，留着是共享 helper 的类型面需要）、`api/impl/route` 的 `reportFailure` 三行、`tools/impl/remove` 的四行、组合根第 68 行的 `now` 闭包（测试注入自己的时钟）。
5. `tools/impl/session` 的 `sessionOf` 圈复杂度到 12（本轮 +1）：它现在是「形状校验 + cwd 非空 + 身份有限数」三件事，若要瘦身应拆出 `readIdentity(header)`；属清理不属修复。
6. §21.6 的 1–9 条**部分已闭合**（第十轮重判，见 §24）：窄屏/双主题**判为不需要**（整块复用官方组件与样式）；dev HMR 重注册在单元级已有判据（`client-takeover` 的「官方组件换了 → 重捕到新组件」），缺的只是 dev 模式真机；`waiting` 分支在 `scope.test.ts` 有正/反向判据，缺的只是真机启动序。仍成立的是：插件 `logger.warn` 在无 exporter 组合里不可见（已用 health 读数兜）、真机模型侧是 mock（n=1）、并发交错只有源码分析、§20.5 的「打不红」待办。
7. `docs/architecture/dsh-worktree-sidebar.md` 尚未补（M8 只补了根 README 的行；先例 `fc9b67e` 同样只动 README 一行）。

### 23.9 复制即用（本轮实际跑过的命令）

```sh
WT=/mnt/ssd/worktree/dsh-plugin-hub-task-worktree-sidebar
# 单条用例（run-vitest.mjs 忽略路径参数，直接问 vitest）
cd $WT && pnpm exec vitest run --project unit -t "<用例名片段>"
cd $WT/packages/dsh-worktree-sidebar && pnpm test          # 17 文件 / 272 用例
cd $WT && pnpm cov && node scripts/gate/verify-coverage-scope.mjs && pnpm crap
cd $WT && pnpm lint && pnpm exec prettier --check packages/dsh-worktree-sidebar README.md docs
cd $WT && pnpm stryker:gen                                  # 新增测试文件后必跑
python3 /tmp/r9-mutate.py && python3 /tmp/r9-mutate2.py      # 27 条反向探针
cd $WT && pnpm gate:pr
```

---

## 24. 第十轮：维护者复核的五条处置（2026-09-15）

### 24.1 逐条

| # | 维护者 | 处置 |
|---|---|---|
| 1 | 「绑定关系不是持久化的吗」 | 持久化一直在工作；要修的是「同一个 id 是不是同一个会话」。补了两条端到端判据（§24.2） |
| 2 | 「不要有 any unknown」 | 接受：清掉本轮新增的 `unknown` 类型与 `as unknown as` 断言（第三态 `unknown` 是**读数的种类**、不是 TS 类型，保留） |
| 3 | 「（那四处）为什么（不补判据）」 | 接受：三处当场补上，第四处是不可达代码、直接删掉（§24.3） |
| 4 | 「4 5 为什么不改」 | 接受：补 rebase 前后的 sha 映射表，补 `docs/architecture/dsh-worktree-sidebar.md` 并挂链（§24.4） |
| 5 | 「窄屏/双主题 我们是复用的界面不需要做这个吧」 | **同意**：判为不需要，已把 §21.6 第 2 条划掉并写明理由；其余遗留按覆盖情况重判（§24.5） |

### 24.2 第 1 条：持久化与「会话身份」是两件事

- **持久化一直在工作**：`bindings.json` 原子写、重启后按会话 id 读回来；`binding-store` 的用例逐条打它（损坏回落空表、写盘失败内存不前移、`release` 等在飞的写、与下一代装配交错不丢表）。「重启后登记还在」这句没错。
- **要修的是「同一个 id 是不是同一个会话」**：官方会话 id 是**进程内计数器**（`session-1`、`session-2`…，`dsh-session/lib/index.js` 的 `counter = 0` 与 `session-${++this.counter}`），重启后新会话会重新拿到 `session-1`。**持久化在这里恰恰是风险来源**：上一进程为 `session-1` 登记的 worktree，会被新进程里那个全新的 `session-1` 读到——正是本插件最想避免的「看错地方」。
- 于是登记里多存了会话 header 的 `createdAt` 作身份凭据：**不同就摘掉**（新会话不继承）、**相同就保留**（真恢复的会话照常继承）、**读不出来则保守保留**。
- **上下文事实**（源码级核验）：本机 dsh 安装树里没有任何启动期把历史会话预载回活存储的路径（`ctx.sessions.get` 是 live-only，`Session.fromRestore` 只在显式带 id 的 `prepare` 分支上用）——也就是说这个碰撞在真机上会发生，不是理论情形。
- **第十轮补的判据**：`apply-lifecycle.test.ts` 两条端到端用例——同一份磁盘 `bindings.json`，先「装配 → 登记 → 释放」，再装配：① 凭据不同 ⇒ `effectiveWorktree` 为 null 且记录被摘；② 凭据相同 ⇒ 仍拿回那个根。三件事（持久化 + 重启 + id 复用）第一次合到**真文件 + 真组合根**上验过，不再只靠 scope 域的假端口。

### 24.3 第 2/3 条：类型面清理与覆盖率补齐

**`unknown` 清理**（只清本轮新增的那几处）：

- `sessionOf` 的身份校验改用精确类型（`{ createdAt?: number }`）；
- 测试里 **3 处** `as unknown as` 改为不再需要断言：`mount` 接受 `Response | Promise<Response>`；typert 假件按官方 `TypertLookupProvider` 的**完整形状**写（四个业务字段一个不少）、`TypertDisposer` 是 `() => Promise<void>`、监听器吃 `TypertRegistryChange`（第十一轮复核指出原文写「4 处」不准，此处更正）；
- 另两处不是 `as unknown as` 而是等价的宽面，一并记下口径：`Set<unknown>` → 官方的 `InjectFactory`；typert 假件里 `configure` 的泛型参数用 `as never` 过桥（官方那一面的入参是「所有 lookup 键的 wire 联合」，本域只用到其中一个键的 wire）。`as never` 保留，理由写在测试注释里；
- `Set<unknown>` → 官方的 `InjectFactory`。

**这轮清理本身抓出一个真问题**：旧的 `as unknown as TypertLookupsPort` 掩盖了假件与官方契约的漂移——少了 `parameter/wire/hostTypeSymbol/wireTypeSymbol` 四个字段，且 disposer 写成了同步的。也就是说那条断言让「假件与官方不同形」永远测不出来。边界校验函数的入参（`validateRecord` / `argString` / `sessionOf` / `readObject`）保留 `unknown`：那是「外部输入不可信」的类型，是本仓既有的边界纪律，不是本轮引入的。

**覆盖率补齐**（原 §23.4 的四处）：

| 位置 | 补的判据 | 结果 |
|---|---|---|
| `api/impl/route/index.ts` | 同步处理器抛异常也回 500；注册中途失败时**已挂的那条被摘回去**、域不留半装态 | lines 100（原 84.2） |
| `tools/impl/remove/index.ts` | 缺 exec.agent / 只摘登记时落盘失败 / 删目录前登记消失（竞态）/ 目录删掉但摘登记失败 | 100（原 85.2） |
| `tools/impl/create/index.ts` | `output.render` 那条闭包 | 100（原 92.6） |
| 组合根 `src/index.ts` | 真执行一次工具，覆盖组合根那个 `now` 闭包（断言时间戳的 ISO 形状；精确等值断言在 `tools.test.ts` 的时针用例里） | 100（原 96.7） |
| `resolveTarget` 的 `cwd === undefined` 分支 | 两个调用方都在更早的分支拦掉了 ⇒ **不可达代码**，删掉并把参数收成 `string` | 连带删掉两处 `target === undefined` 失败块 |

### 24.4 第 4 条：sha 映射与架构页

rebase 会重写 sha，§21/§22 里引用的那些因此指向已不可达的对象。映射如下（按提交主题配对，`git show -s --format=%s` 双向核验）：

| §21/§22 里的 sha | 重放后 |
|---|---|
| `6c0b5ef`（第七轮文档登记） | `84f1033c` |
| `a26d983`（第七轮两条修复） | `3acfc6c0` |
| `b38325f`（第七轮实施登记） | `2007746a` |
| `616d4eb`（第八轮 health 读数） | `e6e06514` |
| `191cddf` / `8447025` / `34957b6` | 上游 `origin/main` 的提交，不在本分支重放范围 |

新增 `docs/architecture/dsh-worktree-sidebar.md`（职责边界 / 五域与依赖方向 / 宿主链路 / 客户端链路 / 失效与自愈 / 兼容性耦合点 / 命门清单），并挂链到根 README 的插件表与本包 README。

### 24.5 第 5 条：遗留重判

- **窄屏/响应式、双主题：不需要**（维护者原话：我们是复用的界面）。本插件没有自己的视觉层——组件、样式、布局全是官方的，我们只改文件根与播种时机；§21.6 第 2 条已划掉并写明理由。
- **dev HMR 重注册**：单元级已有判据（`client-takeover`：官方组件换对象后重捕到新组件 + 遮蔽当值复检）；缺的只是 dev server 真机那一次观察，属发布前人工证据。
- **`waiting` 分支**：`scope.test.ts` 有「provider 未注册 → 不 configure，只出声等」与「provider 随后出现 → 当场接管」两条正反判据；缺的只是真机启动序的观察。
- 其余仍成立者见 §24.7。

### 24.6 本轮读数

- 测试面：**17 文件 / 282 用例**（第九轮 272；本轮 +10：S1 端到端 2、组合根时钟 1、api 同步抛错与注册回滚 2、remove 四条、create 渲染 1）。
- 覆盖率：本包计分面 **33 文件均值 lines 100 / stmts 98.2 / fn 99.5 / branch 92.5**（第九轮 98.6 / 96.8 / 98.2 / 91.3）——**逐文件 lines 全 100、未覆盖行 0 条**；全仓 `All files` 84.15 / 82.54 / 84.65 / 75.1。
- `pnpm crap` exit 0（本包 0 条超阈热点）；`pnpm lint` exit 0（554 文件，0 error / 508 warning = 预算）；参数收窄后 `tools/impl/bind` 的圈/认知复杂度各降 1。
- **本地 `gate:pr` 与 CI 的读数见 PR #819 的回复评论**：本节写定后门禁在**最终树**上复跑过一次，CI 则在推送后跑——两边都贴真实 exit code / run 号，不在这里写「预计」。

### 24.7 更新后的遗留清单

1. **S1 的真机观察**（重启 `dsh web`、新会话拿到旧 id）仍未做；本轮把判据补到「真文件 + 真组合根」级。
2. **S2 的取舍代价**：归属读不出来时保留登记（目录还在但已不是工作树 ⇒ 文件树报错，可感知）。
3. **装饰性未覆盖分支**：`file-io` 的 `String(cause)`（fs 不会以非 Error 拒绝）等防御分支；补它们要伪造非法拒绝，收益为零。
4. §21.6 其余项：真机模型侧是 mock（n=1）、插件 `logger.warn` 在无 exporter 组合里不可见（已用 health 读数兜）、并发交错只有源码分析、§20.5 的「打不红」待办。






---

## 25. 第十一轮：最终复核、隔离真机实测与 4A 架构文档（2026-09-15）

### 25.1 触发与本轮范围

维护者三点要求：①复核最终改动并做子代理隔离实测；②派子代理画当前模块的 4A 架构；③归档 / 更新 / 优化相关文档。
本轮不动功能语义，只做四件事：核验事实 → 修被证伪的判断 → 补真机证据 → 收文档。

### 25.2 复核（本人 + 一个只读的对抗子代理）

- 本人核过的硬事实：`install()` 每次重读磁盘、`release()` 清内存快照（`binding/impl/service/index.ts:56-57`、`:76`）⇒ 两条端到端用例确实跨「释放 → 重装」读**真文件**（`DSH_HOME` 在 `test/integration/apply-lifecycle.test.ts` 里被指到临时目录）；`create/index.ts:52`、`register/index.ts:52` 的更早守卫 ⇒ `resolveTarget` 收窄为 `string` 成立；官方 typert 契约逐字段核对（`.../dsh-typert-protocol/lib/types/types.d.ts:255-272`、`:140`、`:315-320`）；抽查 16 处文档引用行号逐条命中；§24.4 的 sha 映射表双向核验。
- 独立对抗复核（上下文独立的只读子代理）：**无 P0**，P1 两处、P2 九处。它「复核通过」的面：三态归属判定与调用方处置、会话身份链路（含官方契约源码核验）、不可达分支删除、scope 与 binding 的生命周期、api 注册回滚、注释与 `--detach` 四条真 git 复现、类型面、覆盖率读数（复跑与 §24.6 逐位一致）、sha 映射表、`docs:check`。

### 25.3 复核发现的逐条处置

| # | 发现 | 处置 |
|---|---|---|
| P1-1 | `belongsTo` 把 `unknown` 也缓存 30s，而写路径的失败文案让调用方「等目录可读后重试」——重试被必然挡回 | **修**：只缓存已定读数（`same` / `different`）；新增判据「unknown 不进缓存，状态变了下一次必须重新问」；探针 G1 打红（exit 1） |
| P1-2 | 两处装饰性断言（`api-routes.test.ts` 的死变量 `custom` 与恒真断言；`tools.test.ts` 的恒真 `table.has`） | **修**：删掉；注释指向真正承载该性质的 `binding-store.test.ts` 的「目标路径不可写时回传原因、内存不前移、并出声」 |
| P2-1 | 用例标题与 §24.3 声称「断言登记时间戳来自组合根的 `now`」，实际只断言 ISO 形状 | **改口径**：标题与本节改成「覆盖 `now` 闭包」；精确等值断言在 `tools.test.ts` 的时针用例里 |
| P2-2 | typert 假件填的是 `session` 键的描述符，不是 `workspaceFileScope` 的 | **修**：四个字段改用真实值（取自 `dsh-api-workspace-files/lib/index.js:373-378`） |
| P2-3 | 架构页称「官方类型只在组合根与适配层出现」，不实 | **改文档**：各域的 `deps.ts` 就是官方类型依赖面（`tools/deps.ts`、`api/deps.ts`），措辞改成「宿主上下文 / 服务类型只在组合根与 host 适配层」 |
| P2-4 | 适配层把 `header.createdAt` 原样当凭据，畸形值会被读成「另一个会话」并摘掉绑定 | **修**：新增 `identityFrom()`，用 `Number.isFinite` 在边界拦一道（与 `sessionOf` / `validateRecord` 同级）；新增判据（NaN 与 Infinity、live 与持久面两个来源）；探针 G2 打红 |
| P2-5 | `client/shared/ports.ts` 的注释说「我们注册的是顶掉官方类型的那一份」 | **修**：改成「类型表用官方那份，本插件只遮蔽正文」 |
| P2-6 | `unknown && notRepo` 的失败文案把第三态说成否定 | **驳回**：`notRepo` 的语义就是「git 回了否定」，文案的确定性正是它存在的意义（读侧摘除判定并不看它）；权限不可读在读数上与之同形这一点已在代码注释与架构页写明 |
| P2-7 | 客户端 revision 单调守卫的前提没写 | **修**：注释写明前提与已知反例（宿主重启 + `bindings.json` 损坏 ⇒ revision 回 0，SPA 存活时旧根会被留住） |
| P2-8 | `as never` 是本轮新引入的等价宽断言；§24.3 的「4 处 `as unknown as`」计数不准 | **改口径**：§24.3 更正为 3 处并点明另两处（`Set<unknown>` → `InjectFactory`、`configure` 的 `as never`）；`as never` 保留并写明理由 |

### 25.4 隔离真机实测（子代理，四重隔离）

环境：临时 `DSH_HOME` + 独立 profile + 独立端口 + 独立浏览器实例，走官方 `dsh-verify-isolated` 一键脚本；未安装 / 未改动用户 profile；主 checkout 全程只读。完整报告与截图已归档到 `packages/dsh-worktree-sidebar/docs/archive/`（`819-isolated-verify-report.md`、`819-isolated-bound-worktree-tree.png`、`819-isolated-identity-mismatch-fallback.png`）。

| 判据 | 结果 | 证据 |
|---|---|---|
| 隔离实例装上并加载 | 通过 | 构建 exit 0；`GET /api/dsh-worktree-sidebar/health` → `200`、`revision=0`、`scopeTakeover=live`；无报错行 |
| 侧边栏展示绑定 worktree 的文件（**核心目标 2 首次真机证据**） | 通过 | Files 页签根 = worktree 目录，列出 `.git` / `alpha.txt` / `beta.txt` / `gamma.txt`；会话 cwd 是另一个目录（只有 `base-only.txt`），前后对照成立 |
| worktree 落仓库外同样成立（**硬约束「任意路径」真机证据**） | 通过 | 真 git 仓库 + 真 worktree，worktree 在主仓库之外、也在 `/mnt/ssd/worktree` 之外 |
| 身份凭据不一致 ⇒ 摘除并回落（**自愈首次真机闭环**） | 通过 | 端点 `revision 1→2`、`bindings.json` 落盘变空表、`worktreePath:null`、UI 回落 cwd |
| 侧边栏「入口」表述 | 需更正 | 本插件只注册 **1 条**遮蔽条目（`src/client/takeover.ts:137`，同 key、priority = 官方 − 1），不新增可见入口；README 的「四条界面语义」指四条**需要人工验证的行为** |

实测得到的两条操作约束（已写进架构页 §4.7）：

1. `patchReload: live` **不会重装本插件**（改 `cordis.patch.yml` 后 revision 仍为 0）⇒ 绑定必须在 `dsh web` 启动前落盘；可行路径是「先起实例取会话 id 与 createdAt → 写 `$DSH_HOME/@wingsky-1/dsh-worktree-sidebar/bindings.json` → 重启同 DSH_HOME」（会话身份跨重启稳定）。
2. 一键脚本 `--keep` 场景下 SIGTERM 不会带走 dsh 子进程，会占住端口使下次启动静默失败——隔离验证收尾要显式确认端口已释放。

仍未覆盖（如实登记）：Tools 域三个工具在隔离实例里没有 provider、无法驱动 agent ⇒「agent 建 worktree 时自动绑定」这条主链路目前只验了**读侧**（预置记录）；子会话继承父登记、worktree 目录被删后的摘除、`repoRoot` 不匹配（`different`）的摘除、文件预览内容、双主题与窄屏几何也都还没有真机证据。

### 25.5 4A 架构文档与归档

- 新增 `docs/architecture/dsh-worktree-sidebar.md`：按 TOGAF 四视图（BA 业务 / AA 应用 / DA 数据 / TA 技术）讲原理与运行机制，每节一张 mermaid + 一张独立图源，事实全部带 `文件:行号`。
- 四张独立图源（自包含 HTML + 由仓内 `scripts/lib/export-diagram-svg.py` 真实导出的 SVG）登记进 `docs/architecture/README.md` 的图源归档表；该页「全景：插件如何挂载进 dsh web」的 mermaid 补上本插件节点。
- 归档：`packages/dsh-worktree-sidebar/docs/review-round5.md` → 包 `docs/archive/`（被后续轮次取代）；隔离实测的截图与报告一并入包 `docs/archive/`。
- 更新：根 README 插件表与本包 README 中英都挂上架构页链接；本文顶部加「怎么读这份文档」导航，§0 元信息补「最后更新」与架构页链接，状态由「待实施」改为「已实施（包未发布）」。

### 25.6 本轮读数

- 测试面：**17 文件 / 284 用例**（第十轮 282；本轮 +2：`belongsTo` 的 `unknown` 不进缓存、适配层的畸形 `createdAt`）。**未新增测试文件**，故 `--min 17` 与 `stryker:gen` 面不变。
- 类型面：`tsc -p tsconfig.json --noEmit` 与 `tsc -p test/tsconfig.json --noEmit` 均 exit 0。
- 打红探针：G1（把 `unknown` 重新缓存）exit 1 RED、G2（去掉 `Number.isFinite` 守卫）exit 1 RED；两次都做了 `sha256` 还原核对（还原后与备份逐字节一致）。
- 门禁与 CI：见 PR #819 的回复评论——本轮在最终树上复跑 `pnpm gate:pr`，CI 在推送后跑，两边都贴真实 exit code / run 号。

---

## 26. 第十二轮：#847 评论三条新发现的修复（2026-09-16）

### 26.1 触发与范围

#847 的真机写侧复核（2026-09-16T13:39:53Z 评论）报告三条新发现：① fork 会话的继承是「显示级」的，tools 域不认，导致 fork 里无法解绑；② `ws_worktree_create` 缺基点参数，默认取会话仓库 HEAD，与本仓「从 `origin/main` 起」的规则冲突；③ 工具描述与本仓文档互不知情。本轮只做这三条——issue 里的 R2-M-1（导出面基线接线/删基线）、发布登记、变异基线回填与真机四项**不属本轮**。

### 26.2 方案与裁决

把「绑定解析」收敛为唯一事实源：scope 域新增判别联合 `WorktreeOrigin`（`none` / `own` / `inherited`，含 `ownerSessionId`）与 `worktreeOrigin` 读取面，`effectiveWorktree` 改为它的派生（行为等价）；tools 域经 `deps.scope` 读同一份解析，继承来源说明收口到唯一信封出口 `resultOf`。`create` 新增可选 `base`：形态 guard（拒绝 `-` 开头）+ `git rev-parse --verify --quiet "<base>^{commit}"` 归一化成 SHA 后再进 argv。继承态 `remove` 只说明来源与出路，不摘父记录、不删目录。

维护者裁决五条：① 保留 fork 继承（不引入 `delegationDepth` / `origin` 过滤）；② 不做否定登记（`bindings.json` 形状不变）；③ 工具 `bound` 不并入 `scopeTakeover` 读数（只写注释与 README）；④ `base` = guard + rev-parse 归一化；⑤ 继承态 `remove` 给三条出路（含 `ws_worktree_register({ worktree: <session cwd> })`）。

`base` 的 argv 形态有一个实测命门：`<path>` 之后 git **重新开始选项解析**，`--` 与 `--end-of-options` 都挡不住 base 位置的 `-` 开头值——`-f` / `--force` 会 rc=0 却从 HEAD 建（静默产出过期基线），`-badref` 会被解析成 `git branch` 的选项。归一化成 SHA 是唯一彻底的堵法。

### 26.3 评审来源

两位独立子代理评审（架构/最佳实践/长期可维护性、对抗性机制风险）。两评审在「base 位置是否被当选项」上结论相反，主控以实测裁决：以 `-f` / `--force` 的 rc=0 + 起点变成仓库 HEAD 为准，采纳对抗评审。架构评审的三项加固全部落地：判别联合（`root` 由 `record.worktreeRoot` 派生）、`resultOf` 收口继承说明、集成层「工具面与浏览器面同源」不变量断言；另采纳删薄封装与内部类型不用空串哨兵。

### 26.4 逐条处置

| 评论条目 | 处置 | 判据 |
|---|---|---|
| 新发现 1：fork 继承只看得到、工具不认 | 修复 | `tools/impl/bind/index.ts` 改走 `originOf`（真 scope 域）；`remove` 继承态 `ok:false` + `bound:true` + 说明来源与三条出路；集成层不变量 `rootOf(worktreeOrigin(id)) === effectiveWorktree(id)` 对 own / inherited / none 三态各断一次 |
| 新发现 2：`create` 缺基点 | 修复 | `base` 参数 + 形态 guard + rev-parse 归一化；集成层真 git 断言「base = SHA ⇒ 新 worktree HEAD 等于该 SHA」「缺省 ⇒ 等于仓库 HEAD」 |
| 新发现 3：描述与仓规互不知情 | 修复 | 三条工具描述补规范路径与 `/health` 指路；根 `AGENTS.md` 的 worktree 段补工具与 `base` 用法；README 中英补 fork 语义、base 语义与已知限制三条 |

### 26.5 本轮读数

- 测试面：17 文件 / 310 用例（本轮 +5：同源不变量、双跳链 owner、base 起点、缺省起点、继承态真磁盘）。
- 门禁：每个阶段 `pnpm gate:changed` exit 0；开 PR 前 `pnpm gate:pr` 的真实 exit code 见 PR 正文。
- 未覆盖（如实登记）：真机 fork 会话的解绑行为需重启 `dsh web` 后实测，由维护者执行。
