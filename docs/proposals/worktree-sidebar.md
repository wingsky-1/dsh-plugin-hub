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
- 订阅与健壮性 API：`ctx.slots.subscribe(key, fn)`（registry.d.ts:191-197）、`ctx.slots.entriesOfSlot(key)`（lib/client.js:1200-1202）、`ctx.slots.isLive(entry)`（ui-slots index.d.ts:605-612）、`ctx.slots.onEntryError`（registry.d.ts:171-184）。

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
| S2 | api 域：loopback 围栏 + 403/405 + health + 单会话绑定查询 | 待做 | |
| S3 | tools 域：三个 agent 工具（按 agent 作用域注册 + 执行期兜底） | 待做 | |
| S4 | scope 域：捕获委托 + 等价实现两路 fallback，再 configure | 待做 | |
| S5 | 客户端：先负向测试（抓不到官方 entry 则零注册），再接管 files kind | 待做 | |

**已知的切片顺序调整**：S0 只保留**宿主端** package.json（`exports["./client"]` 与 `dsh.client` 段在 S5 随客户端源码一起加回）。
原因是 pack-check 会断言 `exports["./client"].types` 指向包内真实文件——提前声明而源码未到，等于让门禁整个 S0–S4 期间判红；
而放一个空客户端占位又违反「不留半成品」。S5 的验收里必须包含「客户端导出与 `dsh.client` 段已恢复且 pack-check 仍 PASS」。

**S1 期间实测补充**（不在原计划，现已证实并写入代码注释）：

- `git worktree add -b <branch> -- <path>` 与 `git worktree remove [--force] -- <path>` 的 `--` 位置**被真实 git 接受**（集成用例覆盖），故「positional 前加 `--`」这一安全措施可落地。
- `git rev-parse --git-common-dir` 返回的是**相对路径**（实测 `.git`），必须 `resolve(dir, value)` 之后再比较；否则「同一仓库的两个 worktree」会被判成不同仓库，归属校验恒假。
