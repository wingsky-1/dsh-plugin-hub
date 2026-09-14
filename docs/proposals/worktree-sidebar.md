# dsh-worktree-sidebar 设计方案与调研结论

> 状态：待实施。方案已过三轮独立评审（技术核验 / 对抗评审 / 降级预案评审），结论已全部吸收。

## 0. 元信息与版本绑定

| 项 | 值 |
|---|---|
| 调研时间 | 2026-09-14 13:10 CST |
| 适配基线 | @deepseek-ai/dsh **0.1.5-rc.1** |
| 证据根 | /home/tangyi/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/* |
| dsh-client-ui-slots 副本 | /tmp/782-probe2/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-slots@0.1.5-rc.1_.../（该包未随 npm 分发） |
| 仓库起点 | origin/main **114d0bd**（2026-09-14） |
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

### 4.1 宿主端（四个域 + 组合根）

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

## 7. 验收标准

**可自动打红（宿主与契约层）**：

1. binding：原子写、损坏文件当空表、revision 单调、按会话索引、剪枝。
2. scope resolver：命中绑定返回 worktree；目录消失按未绑定；内部异常仍返回官方同形值；dispose 后官方默认恢复；二次 configure 场景放弃接管。
3. git 域：worktree 归属查询（注入 exec 面，可断言 argv）。
4. tools：schema 形状（output 必备）、agent 缺失时明确失败、argv 构造（branch 过 check-ref-format、positional 前加 --）、path 校验。
5. api：403（非回环）/405（方法错）/health；只回单会话且不回 repoRoot。
6. client 契约：抓不到官方 entry 时**零注册**的负向断言；注册顺序（先 body 后 kind）。

**只能靠隔离真机（dsh-verify-isolated，不在任何 gate:*，标为发布前人工证据）**：

1. 文件树列 worktree 内容。
2. 点开文件预览读的是 worktree 里的文件。
3. 未登记会话与未装插件时行为一致。

## 8. 目录树与模块职责

```
packages/dsh-worktree-sidebar/
  AGENTS.md  cordis.patch.yml  package.json  tsconfig.json  README.md  README.en.md
  src/index.ts                       组合根：bindHost + assemble + 逆序 dispose，零业务
  src/contract.ts                    双端共享常量 / 字段名 / revision 契约
  src/server/binding/interface.ts    绑定域入口：install/release + read/write/remove
  src/server/binding/deps.ts         依赖声明（LoggerPort、dshHome 路径）
  src/server/binding/impl/store/     bindings.json 原子写 + 记录形状
  src/server/binding/impl/model/     纯逻辑：校验、revision 递增、按会话索引
  src/server/git/interface.ts        git 域入口：isWorktreeOf / listWorktrees
  src/server/git/deps.ts             注入 exec 面
  src/server/git/impl/inspect/       真实状态查询（rev-parse --git-common-dir 等）
  src/server/scope/interface.ts      scope 域入口：install/release
  src/server/scope/deps.ts           注入 typert、binding、git、logger
  src/server/scope/impl/resolve/     命中绑定 to worktree，否则委托捕获的官方默认
  src/server/scope/impl/fallback/    官方默认策略等价实现（provider 晚注册时）
  src/server/tools/interface.ts      工具域入口：installTools/releaseTools
  src/server/tools/deps.ts           注入 binding、git、scope、会话解析面
  src/server/tools/impl/session/     执行期兜底：从 exec 取 sessionId/agent
  src/server/tools/impl/register|create|remove/  三个工具各一文件
  src/server/api/interface.ts        路由域入口：installApi/releaseApi
  src/server/api/deps.ts             注入 binding、logger
  src/server/api/impl/route/         单路由装配（host-utils 的 guardLoopbackMethod）
  src/server/api/impl/bindings/      GET /api/dsh-worktree-sidebar/bindings
  src/server/shared/{interface,type,paths}.ts  共享层门面 / 窄类型 / DSH_HOME 路径
  src/client/index.ts                干净模块：apply/inject + ctx.effect，仅装配
  src/client/takeover.ts             探测官方 files entry to 注册 body/title/kind，失败即 dispose
  src/client/inject.ts               官方 entry 的 component/store/inject/locale 探测
  src/client/source.ts               伪造 sessions 快照源（getSnapshot/subscribe，稳定引用）
  src/client/bindings.ts             拉绑定与 revision
  test/unit/**  test/integration/**  test/client/client-contract.test.ts
```

分层纪律（参考 notifier 与 docs/ARCHITECTURE-METHOD.md:22-40）：

- 组合根唯一：`bindHost` 收窄 ctx 能力 + `assemble` 按依赖序装域并收集 disposer + `safeDisposeAll` 逆序 try/catch。
- 域三件套：`interface.ts`（唯一对外引用面，install/release 成对）+ `deps.ts`（只类型）+ `impl/**`。
- 跨域只注入窄能力（用 Pick / 派生类型），域间禁止直引实现。
- `server/shared/` 叶子化：不依赖任何域。
- disposer 归域：域导出 releaseXxx，组合根只收集与逆序调用。

客户端架构纪律（同样按域审视，不是只写一个文件）：

- 干净模块：`src/client/index.ts` 只 export `apply(ctx)` 与 `inject`，卸载写进 `ctx.effect`；禁止 loader 痕迹（DEVELOPMENT.md:352-376）。
- inject 双声明：`package.json` 的 `dsh.client.inject` 列官方客户端包；源码 `export const inject` 列 `slots` / `sidebarRightTabs` / `locale` / `remote`，漏声明会抛 without inject（DEVELOPMENT.md:399-400）。
- `style.css` 非必需：本形态不自绘 UI，官方组件样式随官方产物。
- 幂等与卸载：全部注册走 `ctx.effect`；重复 apply 不得摘除别人的包装。
- 崩溃与失败归因：registrant 会指向本包，必须订阅 `ctx.slots.onEntryError` 辨识是否自己的 entry 并 warn；注册失败一律 catch+warn，dispose 即恢复 builtin，绝不 replace。

## 9. 行数控制约定（本仓无 max-lines 门禁，靠 review 守）

| 文件类型 | 上限 |
|---|---|
| 组合根 src/index.ts | 300 |
| 域 interface/deps | 80 |
| 域 impl 单文件 | 250 |
| 纯逻辑模块 | 120 |
| 客户端单文件 | 250 |
| 全包 src 合计 | 1200 |

参照：notifier src 中位数 44 / p90 186 / max 3229（客户端单文件，属反例）；mcp-manager p50 58 / p90 373 / max 1208。

### 9.1 实施后的实测与两处偏离（待统一复核裁决）

实施完成后的实测（`find src -name '*.ts'` 合计）：

| 文件类型 | 上限 | 实测 | 结论 |
|---|---|---|---|
| 组合根 src/index.ts | 300 | 255 | 合规 |
| 域 impl 单文件 | 250 | 最大 117（tools/impl/remove） | 合规 |
| 纯逻辑模块 | 120 | 最大 110（scope/impl/resolve） | 合规 |
| 客户端单文件 | 250 | 最大 184（client/takeover） | 合规 |
| 域 interface/deps | 80 | git/interface **140**、binding/interface **102**、scope/interface **82** | **偏离 3 处** |
| 全包 src 合计 | 1200 | **2527** | **偏离（2.1 倍）** |

两处偏离的性质不同，分开说：

- **interface/deps 的 3 处偏离**：根因是这三个门面同时承担「对外引用面」与「install/release 的实现体」。
  `git/interface.ts` 另外还持有 `GitApi` 的实现与归属校验的 TTL 缓存；`binding/interface.ts` 持有写盘串行链。
  与计划 §8「域三件套：interface.ts（唯一对外引用面，install/release 成对）+ deps.ts + impl/**」并不冲突
  （install/release 确实从门面出去），但它与本节的行数上限冲突。
  可选修法是把三者各自再拆出一个 `impl/service`（notifier 的 api 域就是这个形状），门面变成 20–30 行的转发；
  代价是三个域的间接层各多一层，而 `git` 的 140 行本身是一个内聚模块（类型 + 实现 + 缓存）。
  **建议交统一复核裁决**：要么接受「小型域的 interface 允许到 150」，要么按上述拆法改造。
- **全包合计 2527 vs 预算 1200**：这是预算本身定得不准，不是代码失控——四个宿主域 + 三个工具 + 两条路由 + 客户端接管，
  在「每个非显然决定都写为什么」的注释口径下，2527 行对应 36 个源文件（均值 70 行）。
  其中客户端 488 行、宿主 2039 行。**建议把合计上限改为 2800**，依据是本次实测而不是估计。
  该数字同样**待统一复核裁决**，本文件不擅自把它当成已批准的新预算。

## 10. 债务清单与最小化

| 债务 | 最小化做法 |
|---|---|
| 借用 inspection 面（StoredEntry.component） | 探测收敛在 src/client/inject.ts；用 get("files")?.id 定位而非内联 id；结构不符即零注册；加负向契约测试 |
| configure 是全局替换 | **实测：官方用 `lookups.register`（providers 表），我们 `configure` 写的是另一张 resolvers 表（dsh-typert-registry/lib/index.js:158-160），两者不冲突**。`configure` 前捕获 `lookups.get("workspaceFileScope")?.resolve` 并委托（此时它正是官方 resolve），**捕获必须在 configure 之前**——configure 之后 `get()` 只回我们的包装，官方 resolve 不再可达。若安装时 provider 尚未注册（`get()` 为 undefined）则用等价实现兜底（只依赖 sessions.header / sessionPersistence.stat / header.cwd ?? sandboxPolicy.workspaceRoot）。类型层亦确认「配置可先于 provider 注册，dispose 时恢复 provider 默认解析器」（dsh-typert-protocol/lib/types/types.d.ts:381、412） |
| 伪造 sessions 源 | 只改写 byId[id].cwd 一个字段、其余透传；按 entry×binding 缓存，保证引用稳定 |
| 双端 revision 契约 | src/contract.ts 单点定义；GET 回 {revision, worktreePath|null} |
| 绑定与 git 漂移 | resolver 命中前做廉价校验（目录存在 + common dir 相同）带 mtime 缓存；失效即按未绑定、revision++ |
| kind 接管全会话生效 | 未绑定原样走默认；总开关；失败一律 dispose 回 builtin |
| 工具双登记 | binding 域为唯一事实源、register 幂等（先例 mcp-manager middleware-register.ts:806-832） |

## 11. 实施顺序

0. 立尺子：把新包登记进 `scripts/data/gate-scope-registry.json`（verify-dir-imports 段）与 `contract-check.ts` 的 --package 调用点；未登记包 fail-closed 判红，正好以「零违规」作验收。
1. 宿主纯逻辑：contract / shared / binding / git（注入 exec），全部单测、不依赖 cordis。
2. api 域：loopback 围栏 + 403/405 + health。
3. tools 域：三个工具（复用 mcp-manager 的注册与执行期解析先例）。
4. scope 域：先落「捕获委托 + 等价实现」两路 fallback 与对照测试，再 configure；补降级注入用例（provider 缺失、二次 configure 抛错、resolver 抛错、目录消失）。
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

复核由一个独立子 agent 执行：自建 worktree（detached @54ac2e6）、自跑全部门禁、真机隔离环境实测。
结论：**门禁逐条属实**（含 lint 669/671、155 用例、624 pass、fail-closed 模式；另补跑 `pnpm gate:pr` 为 PASS），
但**不可合并**，发现 4 项必修：

| # | 发现 | 根因 | 修复 |
|---|---|---|---|
| P0-1 | 客户端在真机 dsh 0.1.5-rc.1 上 `TypeError: deps.slots.isLive is not a function`，**零注册、S5 完全不生效** | 端口对着 `dsh-client-ui-slots` 的**类型包**写，而运行时 `ctx.slots` 是 `dsh-client-ui-renderer` 的 `SlotRegistry`（无 isLive）；假端口测试只证明「代码与假设一致」 | 删掉 `isLive`，改用 `entriesOfSlot` 的返回集合判存活；端口注释写明「必须对着运行时面写，不是对着类型包写」 |
| P0-2 | 接管后官方 guide 条目归零：**所有会话**（含从未登记的）默认页签从 Files 变成空的 Guide | 注册的类型定义只写了 4 个字段，丢掉官方定义里的 `guide`，而官方注册表 refresh 后用**在册定义**重算 guide | 改为整份搬运 `{...官方定义, id, priority}`；补「guide 被原样搬运」与「撤销后 builtin 复位且 guide 回来」两条断言 |
| P1-1 | G3「官方 entry 变化即重捕」在真实注册表语义下**恒不触发**（复用旧组件与旧 inject 闭包） | `tabs.get(kind).id` 在接管成功后返回的是**我们自己的** id，于是「官方条目还在不在」变成了问自己 | 首次发现时记下官方 key 并一直用它；测试的假注册表改为真实语义（extension 顶掉后 get 返回我们的 id） |
| P1-3 | 新增 5 处模块级可变单例，且落在 module-state 门禁扫描面之外 | 四域 + tools service 各有一个 `let installed` | 五处全部改为工厂（`createBinding` / `createGit` / `createScope` / `createApi` / `createTools`），状态收进闭包或实例；组合根持有实例 |

**验证**：把本包加进 `forbid-module-state-src` 范围后实跑探针 → exit 0、本包零条目（P1-3 修掉）。
修复后 11 项门禁全 exit 0，测试 156 例（10 文件）。

**复核者独立实测成立的主张**（作者原先只在纸面上断言）：
`--` 位置真被 git 接受；`--git-common-dir` 在仓库根返回相对路径、在 linked worktree 返回绝对；
`git check-ref-format --branch` 拒绝 `-` 开头且非仓库 cwd 可用；创建→绑定→摘除端到端与 bindings.json 内容一致；
**写盘失败时 ok:false、revision 仍 0、get() 为 undefined**（内存不前移成立）；
S0 的三处既有断言修改均为**必需同步、非放宽**（ci-matrix 的真实不变量由 `plugins-manifest-lib.ts:110/120/169/236` 分守）。

**行数预算（§9.1）复核裁决建议**：接受 `interface/deps ≤150`，不拆 `impl/service`——理由是评审成本的真实代理量是
「一个文件里要同时理解几个决定」，而这三个文件各只含 1 个决定 + 若干转发；拆开只增加跨文件跳转。
全包合计建议登记 **3000 作观察阈值**（而非改写预算），并把 §9 的语义改成
「超限时先问『这文件里有几个决定』，再决定拆不拆」。**此裁决仍待用户确认，本文不擅自改写 §9 的既有上限。**

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
- 因此原来的做法——「往正文 inject face 里塞一个 `hooks.sessions`」——**必然无效**：渲染器的合成顺序是
  `{...kit, ...injected, ...}`，官方正文只读框架注入的 `useSessions`，props 里多一个 `hooks` 键它根本不看。
  这条与 P0-1 同型：接缝照假设写，而假件只证明「代码与假设一致」，不证明「假设与运行时一致」。

**修复**：

- 真实源改用 `ctx.sessions.list`；每会话的改写源经 `ctx.uiSession.provide({hooks: ["sessions"], resolve})`
  贡献为 session 作用域的 `hooks.sessions`（新模块 `src/client/contribute.ts`）。
- 接管的 `inject` 面**原样搬运**（删掉 `wrapInject` 与 `TakeoverDeps.sourceFor`），接管逻辑不再碰组件 props。
- `inject` 增加 `uiSession`；未绑定会话仍由源自己原样透传（回的就是真实快照对象本身）。
- 测试：新增 `test/unit/client-contribute.test.ts`（假 `uiSession` 复刻渲染器契约：名册静态、resolve 对**每个**
  绑定都必须给出源）；`client-takeover.test.ts` 改为断言 inject 按**同一引用**透传。

**真机验证结果**（截图证据 `packages/dsh-worktree-sidebar/docs/archive/819-{bound,unbound}-*.png`）：

| 语义 | 结果 | 实测 |
|---|---|---|
| 已登记会话的树列 worktree 内容 | 成立 | 树根 `/tmp/pr819-verify/fixture/wt`，含 `WORKTREE-ONLY.txt` |
| 点开预览读 worktree 里的那一份 | 成立 | `SAME.txt` 预览内容为 `content-from-worktree`（同名的 cwd 副本写的是 `content-from-cwd`） |
| 未登记会话与未装插件行为一致 | 成立 | **同一实例内**未登记会话的根仍是 `/tmp/pr819-verify/fixture/repo`（cwd），无 `WORKTREE-ONLY.txt` |
| 挂载无异常 | 成立 | 页面重载后 console 捕获 0 条（修复前同一次重载必然出 TypeError） |

**仍未验证**：真机 HMR 重捕时序——官方客户端包住在 dsh 安装目录内，不写 DSH 源就无法触发官方包重载，
本环境没有安全的触发手段。agent 工具的 LLM 回路端到端需要真实模型凭据，隔离环境没有，且不得借用用户凭据。
## 17. 当前状态与交接（2026-09-14）

### 17.1 代码现状

| 项 | 值 |
|---|---|
| 分支 / PR | `task/worktree-sidebar` / [#819](https://github.com/wingsky-1/dsh-plugin-hub/pull/819)（**draft，未合入**） |
| 已推送提交 | `0c36a1a`（S0+S1）、`5e6b4df`（摘除未落地客户端导出）、`54ac2e6`（S2–S5）、`c762c66`（复核四项必修）、`6611f25`（状态记录） |
| 测试 | 159 例 / 11 文件；含真 git 仓库上的 创建→绑定→摘除 端到端 |
| 门禁 | `pnpm gate:pr`：全仓 build/test/typecheck 与产物闸全 exit 0，唯一非 0 项为 `format:check`（已修，见 17.2）；包级 11 项复跑全 exit 0 |
| 导出面门禁 | 本包已接入 `export-surface-snapshot`（基线 + 分类登记入库，`contract-check` 逐包跑）；导出面 124 个符号全部有仓内消费者 |
| 额外探针 | 把本包加进 `forbid-module-state-src` 范围 → exit 0、本包零条目（P1-3 已修） |

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
4. **修掉 P0-3**（真机验证暴露的会话快照源接错面），三条界面语义在隔离真机上全部成立，见 §16.1。
5. 顺带修掉一处历史写入事故：`scope/impl/resolve/index.ts` 与本文档里残留的 `%BT%` 占位符（构建产物 `.d.ts` 里也有），
   以及本 PR 自建的 `test/tsconfig.json` 编译不过（46 处类型错误，测试目录不在包 typecheck 面内所以一直没暴露）。

### 17.3 未完成（下一会话的待办，按建议顺序）

1. **真机 HMR 重捕时序**（计划 §13 第 5 项）：现为「官方正文消失即撤销、出现即重捕」，无去抖，窗口内有可见的撤销/重建。
   **本环境实测不了**：触发它必须让官方客户端包重载，而官方包住在 dsh 安装目录内（写它是红线），
   本环境没有安全的触发手段。要验它得先把官方包从安装目录里挪出去（换一个验证环境），不是本 PR 能附带完成的。
2. **agent 工具在真机会话里的 LLM 回路端到端**：需要一次真实模型调用。隔离环境没有 provider 凭据，
   且不得借用用户凭据，故未跑；现有的等价端到端是真 git 上直调插件实现。
3. **行数预算裁决**（§9.1 / §16）：`interface/deps ≤80` 的 3 处偏离**已随「类型与装配下移 `impl/service`」消失**
   （五个门面现在各 11–20 行，最大的是 `api/deps.ts` 30 行）。**仍未裁决的是全包 src 合计**：
   实测 2533 行 vs 既有上限 1200（2.1 倍）。复核建议把合计登记为观察阈值、并把 §9 语义改为
   「超限先问这文件里有几个决定」。**本文件未擅自改写 §9 的既有上限，等用户裁决。**
4. **`.github/workflows/ci.yml` 的授权记录**：复核者指出该授权只存在于 PR 正文陈述，无法独立核实；
   按仓库规则 `.github/` 属红线。本会话**没有新增任何 `.github/` 改动**（导出面门禁的接入点改在
   `scripts/gate/contract-check.ts`，属 `scripts/gate/**` 的全局面），授权记录仍待补。

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

### 17.5 证据位置

**第二轮复核者留下**：隔离 worktree `/mnt/ssd/worktree/dsh-plugin-hub-task-worktree-sidebar-review2`
（detached @54ac2e6，本会话已按仓库规矩清理）；其复现脚本与截图在 `/tmp/pr819-verify/`（临时目录，可能已被清理）。

**第三轮（本会话）**：

- 真机截图（已入档）：`packages/dsh-worktree-sidebar/docs/archive/819-bound-session-worktree-tree.png`、
  `819-unbound-session-cwd-tree.png`。
- 隔离环境与复现脚本：`/tmp/pr819-verify/`（`cdp.mjs` 真机 CDP 小工具、`probe-reload.mjs` 运行时探针、
  `export-audit.mjs` 导出面消费者审计、`dsh2.log` 隔离实例日志）；临时 `DSH_HOME` `/tmp/dsh-verify-VQUvbs`。
- 三条界面语义的实测结论与判据见 §16.1；运行时探针输出的原始 JSON 在同批 `/tmp/pr819-verify/` 文件里。
