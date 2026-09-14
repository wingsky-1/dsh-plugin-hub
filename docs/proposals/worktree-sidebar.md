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

1. binding：原子写、损坏文件当空表、revision 单调、按会话索引。
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
  src/index.ts                       组合根：收窄宿主上下文 + assemble + 逆序 dispose，零业务
  src/contract.ts                    双端共享契约：ROUTES（客户端经构建期 __DSH_ROUTES__ 取）/ 响应字段名
  src/host/agents.ts                 宿主适配：agent 事件面（subscribe / list / publish）收窄
  src/host/typert.ts                 宿主适配：typert lookups 收窄
  src/host/defaults.ts               宿主适配：sandboxPolicy / sessionPersistence / liveSession 收窄
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
  src/server/scope/deps.ts           注入 typert、binding、git、defaults、logger
  src/server/scope/impl/resolve/     命中绑定 to worktree，否则委托捕获的官方默认
  src/server/scope/impl/fallback/    官方默认策略等价实现（provider 晚注册时）
  src/server/scope/impl/service/     单例：捕获 / 委托 / 释放 + installed 守卫
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
  src/client/index.ts                干净模块：apply/inject + ctx.effect，装配窄面 + 逐会话剪枝
  src/client/takeover.ts             探测官方 files entry to 注册 body/title/kind + teardown/evaluate/订阅；失败即 dispose（inject 面的改写见 inject.ts）
  src/client/inject.ts               官方 entry inject 面的改写：给定官方 inject 面与会话 id，产出 hooks.sessions 指向改写源的新面
  src/client/source.ts               本 entry 的 sessions 快照源（改写 cwd，getSnapshot/subscribe 引用稳定）
  src/client/bindings.ts             拉绑定与 revision
  src/client/ports.ts                客户端窄端口类型面（运行时真实面为准；未规定成 interface.ts）
  test/unit/**  test/integration/**
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

### 9.1 现状对照（第四轮收尾重测；历史偏离已消失）

| 文件类型 | review 提问线 | 实测（第四轮收尾，`wc -l`） | 结论 |
|---|---|---|---|
| 组合根 src/index.ts | 300 | 160（S3 拆出 `src/host/` 三个适配器后 260 到 160） | 合规 |
| 域 impl 单文件 | 250 | 最大 154（git/impl/service） | 合规 |
| 纯逻辑模块 | 120 | 最大 110（scope/impl/resolve） | 合规 |
| 客户端单文件 | 250 | 最大 186（client/index；B7 第 2 条拆出 `inject.ts` 后 takeover 212 到 182、inject 38） | 合规 |
| 域 interface/deps | 80 | interface 19/45/24/21/59（api/binding/scope/tools/git）、deps 32/12/18/55/78 | 合规（C1 后门面 = install/release + 能力转发，不再是 8–11 行的纯转出） |
| 全包 src | —（已撤销） | 45 文件 / 3002 行（均值 67；B7 拆出 `inject.ts` 后重测） | 指标不存在 |

**历史偏离已消失，不再有「偏离」可议**：

- **interface/deps 的 3 处历史偏离**（git/interface 140、binding/interface 102、scope/interface 82）在
  「类型与装配的物理定义下移 `impl/service`」之后消失——五个域现在同形：门面出 `install/release` 成对动作 + 能力转发
  （19–59 行，C1 之前只是 8–11 行的纯转出；能力面从 `impl` 搬到门面是本轮的反转，见 §18），
  `deps.ts` 是纯类型面（最大 `scope/deps.ts` 78 行，是端口与形状字段的逐条声明，只有一个修改理由）。
  当时提的两种修法（接受 150 / 再拆一层）都不必执行。
- **全包合计**这个指标本身已撤销（见 §9），`2800` / `3000` 一类建议值一并作废，不要再出现在任何判据里。
  当前实测 **45 文件 / 3002 行、均值 67**（旧表的 `2535` 是 `src/host/` 拆分前的读数，已过期；`44/2978` 是 B7 拆出 `inject.ts` 之前的读数）。

## 10. 债务清单与最小化

| 债务 | 最小化做法 |
|---|---|
| 借用 inspection 面（StoredEntry.component） | 探测收敛在 src/client/takeover.ts（inject.ts 只负责 inject 面改写）；用 get("files")?.id 定位而非内联 id；结构不符即零注册；加负向契约测试 |
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
| 已推送提交 | `0c36a1a`（S0+S1）、`5e6b4df`、`54ac2e6`（S2–S5）、`c762c66`（第二轮复核四项必修）、`6611f25`（状态记录）、`d490245`（真机 P0-3 + 导出面收口 + 实现下移 `impl/service`）、`13da7ca`（复用 notifier 同套门禁扫描） |
| 测试 | 159 例 / 11 文件；含真 git 仓库上的 创建→绑定→摘除 端到端。其中 `client-contribute`（4 例）随 17.3-B1 的取舍可能删除 |
| 门禁 | `pnpm gate:pr` **36 阶段全 exit 0**（在 `13da7ca` 上实测）；`test:scripts` 624 pass / 0 fail |
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
（detached @54ac2e6，本会话已按仓库规矩清理）；其复现脚本与截图在 `/tmp/pr819-verify/`（临时目录，可能已被清理）。

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
| A1 | 做：更正「props 里塞 hooks 不被读」的错误表述（源码注释四处） | 官方 `bindInjectSources` 把 entry inject 面里的 `hooks.<name>` 经 `standardHookPropName` 变成 `use<Name>` props（`dsh-client-ui-renderer/lib/client.js:342-357`）；展开序 `{...kit, ...injected, ...}` 在 `:644-650`（ContextualEntry）与 `:653-658`（renderEntry）两处，`injected` 在 `kit` 之后 ⇒ 覆盖 | S1a 落地（`244586b`）：`takeover.ts` 头、`ports.ts` 段、`client-takeover.test.ts` 原 `:302-304`；`contribute.ts` 随删除消失 |
| A2 | 做：为 P0 修复行 `ctx.sessions.list` 补判据 | 探针实测边界：把该行改回 `ctx.sessions`，**构造期不抛**、`typeof getSnapshot === "function"` 为 true，只有**调用** `getSnapshot()` 才 `TypeError: real.getSnapshot is not a function` ⇒「只驱动到注入对象生成」的写法是恒真断言 | S1b 落地（`a79ee3a` 新增 `test/unit/client-index.test.ts`，与逐会话剪枝同一片——比原排期提前一片）；`8be40cb` 随 B2 改到 `typeof __DSH_ROUTES__` 注入形态；S4/S5 又补一条路由字面量哨兵（见 §18.5） |
| A3 | 做：补 `shared/README.md` 消费方登记 | `src/server/api/impl/route/index.ts:9`、`api/impl/handlers/index.ts:11` 取 `guardLoopbackMethod/writeJson`；`src/server/shared/paths.ts:6` 取 `dshHome` | S4/S5 落地（本片）：`shared/README.md:15`（`host-utils.js`）与 `:18`（`dsh-home.js`）两行消费方登记各补 `worktree-sidebar`。**判据：无**（该表无门禁读），按 testing skill §7 显式登记为「靠自查」，靠在 PR 正文写明 |
| A4 | 做（与 B7(b) 合并）：消除静默空实现 | `src/index.ts:92-94` 对未知 agent 回 `() => undefined`；但 `publish` 的唯一调用点 `tools/impl/service/index.ts:43` 拿到的 face 恒来自 `bindAgents` 先 `live.set` 过的同一条（`:84` list / `:85` subscribe）⇒ **该分支不可达**，`bindAgents` 又未导出（`src/index.ts:73`）⇒ 判据无处驱动 | S3 落地（`c3fb83d`）：拆 `src/host/{agents,typert,defaults}.ts` + 窄端口（87/47/53 行），`test/unit/host-agents.test.ts` 白盒断言「`publish(未知 id)` → 抛错」，`src/index.ts` 260 到 160。先例与例外：refactor §4 要求「未装配即抛错」，notifier 有相反先例（挂宿主事件链的出口可静默），我们的 `publish` 是自家 tools 域**同步调用**，不属该例外 |

### 18.2 B 档裁决（逐条）

| # | 裁决 | 依据 | 状态 |
|---|---|---|---|
| B1 | 做：接缝回退到 **entry 级** `hooks.sessions` | 计划 §4.2 `:110` 指定的形态；§6 `:143`「伪造只作用于本 entry」是**显式非目标**；§8 `:190-192` 的客户端文件清单里没有 `contribute.ts`。两条接缝都有效（`renderer:333-356` / `:640-650`），差别只在作用域与降级语义；保留全 session 作用域会让工具描述对模型的承诺（`tools/impl/register/index.ts:19-24`「Only the Files tab follows the binding」）变成假话 | S1a 落地（`244586b`）：恢复 `wrapInject` + `TakeoverDeps.sourceFor`；删 `contribute.ts` 与 `client-contribute.test.ts`；`inject` 去掉 `uiSession`（`--min` 11→10 + `stryker:gen`）；改写原 `:301-325` 那条必红断言 |
| B2 | 做：契约单一事实源（三段） | ① 存储形状 `BINDINGS_VERSION/BindingRecord/BindingsFile`（`contract.ts:19-38`）消费者是 binding 域 3 文件 + `tools/impl/bind` + 测试，**客户端零消费者** ⇒ 移进 binding 域；② 响应体 `{revision, worktreePath}` 由单点定义、两端真实 import（宿主 `api/impl/handlers/index.ts:34`、客户端 `client/index.ts:35`），删掉客户端那行手写的第二份形状；③ 判据方向更正：能红的是「**把某一端改回旧字面量 → 该端 `pnpm typecheck` 报错**」，且只在**类型层**成立（做成值常量连类型层都不红）；④ `__DSH_ROUTES__` 兜底实测失效（`node` 直接 import → `ReferenceError`；`?? "/literal"` 永不可达），正解是 `typeof __DSH_ROUTES__ !== "undefined" ? __DSH_ROUTES__ : ROUTES` | S3 落地（`8be40cb`）：① 存储形状移进 `binding/impl/model/type.ts`（`contract.ts` 只留 `ROUTES` + 响应类型单点）；② 两端各一处真实 import；④ 改成 `typeof __DSH_ROUTES__ !== "undefined" ? __DSH_ROUTES__ : ROUTES`（不修会让 A2 的测试在收集期整文件失败）。③ 的边界与哨兵采纳见 §18.5 |
| B3 | 做：api 端口按提供方拆 | `api/deps.ts:15-20` 的 `BindingPort` 一半来自 binding（`revision`）、一半来自 scope（`effectiveWorktree`），逼组合根手拼匿名对象（`index.ts:232-236`），违 refactor §3「一行一个提供方」 | S2 落地（`012655e`，与 C1 同批）：`api/deps.ts` 拆成 `RevisionPort`（`Pick<typeof bindingApi, "revision">`）与 `EffectiveWorktreePort`（`Pick<typeof scopeApi, "effectiveWorktree">`），组合根一行一个提供方递门面命名空间对象，不再手拼匿名对象 |
| B4 | **已裁决 = 删** `BindingApi.prune` | 生产零消费者，只有 `binding-model.test.ts:139-147` 与 `binding-store.test.ts:121-126` 两组测试 | S4 落地（`be033d9`）：删 `prune` / `pruneTable` 与两组测试；`entries` 的测试消费者改用 `get()` / `revision()`。`§7.1` 与 `§8` 已同步（S0 改 `§7.1`，S4/S5 改 `§8`） |
| B5 | 做：导出面收窄批（口径更正） | v1 的「5 处仅同文件消费者」**复测为 0 处**；正确口径 = 值导出 ∧ 定义文件之外零导入者 ∧ 非包入口面 ∧ 不含 `test/`。`branchLabel` 生产零消费者、只剩 4 条测试（`git-inspect.test.ts:127-146`）；测试专用的 `FILES_KIND` 等是 ABI 面或同源期望锚点，**不动** | S4/S5 落地（本片）：删 `branchLabel`（+`test/unit/git-inspect.test.ts` 的 4 条断言）、`client/bindings.ts` 的 `lastRevision`、三处类型转出（`ApiInstance` / `ScopeApi` / `GitExecPort`）；按口径重跑机械审计，非豁免命中 **0**。判据只对「生产零消费者」这一条有效：审计 + `typecheck` + 测试改写。C1 让门面值导出**增加**（install/release + 能力转发），与收窄不矛盾（增的是能力、减的是工厂）。清单与口径见 §18.5 |
| B6 | 做：由 C1 的 `install` 守卫解决双装配 + 更正 6 处注释 | 同 fiber 内 cordis 先卸后装（`cordis/src/fiber.ts:675-696` 的 `_unload` 先 `await` 全部 disposer，再 `:692` `_reload`）；**并发双 fiber** 才可能两份实例。notifier 的守卫在 `pipeline/impl/service/index.ts:50`（`private installed = false`）与 `:55-57`（throw）。旧 repro（直接调两次 `createBinding`）**不是真机可达路径** | S2 落地（`012655e`）：五域 `install` 守卫 + 6 处注释更正；`7dad567` 补「工具注册失败要出声」判据；S4/S5 把「第二次装配显式抛错」写进中英 README。正确红绿实验是「删掉 `if (installed) throw` 那一行 → 只有该用例红」，「旧形态下是红的」不构成实验（旧形态没有 `installGit`，用例编译不过） |
| B7 | **已裁决 = 撤销「全包 src 合计」指标**；逐文件数字改称 review 提问线 | 实测（第四轮收尾重测）**44 文件 / 2978 行**（均值 68）；门面 `interface.ts` = 19/45/24/21/59（api/binding/scope/tools/git），`deps.ts` = 32/12/18/55/**78**（最大 `scope/deps.ts`）。该指标无出处（§9 只给了**单文件**分位数）、且拆分不改合计 ⇒ 指向不了动作。机器强制的质量面交给既有度量：ESLint `complexity`（78/84）+ CRAP 16（观察期）+ 变异 | S0 已改 §9/§9.1/§16（`ec42113`）；B7(b) 拆 `src/host/` 与 A4 合并落在 S3（`c3fb83d`），S4/S5 按实测重写 §9.1 数字 |
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

（`c2178ef`：符号集仍是 4 个、`-export-faces.json` 未动、**未新增任何豁免**。）结论分两半，必须一起读：

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

**B7 结构动作表的执行状态（如实登记）**：§18.2-B7 那张「具体结构动作」表里，第 1 条（拆
`src/host/{agents,typert,defaults}.ts`）已落地（`c3fb83d`），第 4 条（删掉全包合计指标）已落地（`ec42113`），
第 3 条是「**不拆**」。**第 2 条（B1 之后拆 `client/inject.ts`）已落地（`ae8983c`）**：`wrapInject`
从 `client/takeover.ts` 移进新块 `client/inject.ts`（`createInjectWrapper(sourceFor)`，只回答「给定官方
inject 面与会话 id，产出 `hooks.sessions` 指向改写源的新面」），`takeover.ts` 212 到 182 行，只留探测、
三步注册、teardown/evaluate、订阅与退订、`findEntry`。两块零互引：跨块形状（`InjectFactory` /
`SourceFor` / `WrapInject`）落在纯类型面 `ports.ts`，装配根 `index.ts` 把改写器接进 `TakeoverDeps.wrapInject`；
ESLint 的 `no-restricted-imports` 块间规则同步纳入 `inject.ts`。§8 的客户端清单因此是 6 个文件
（`index` / `takeover` / `inject` / `source` / `bindings` / `ports`）。行为不变：13 文件 / 174 用例全绿，
打红实验（拿掉 `hooks.sessions` 那一项）只红在 inject 面判据上，还原后 sha256 一致。
