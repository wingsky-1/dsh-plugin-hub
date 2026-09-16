# 结构复核（第五轮）：真弯 / 被迫 / 记账 + git 选型与能力收敛评估

> 对象：`packages/dsh-worktree-sidebar` @ 分支 `task/worktree-sidebar`（PR #819）。
> 基线：dsh **0.1.5-rc.1**。官方证据根：`<dsh>/node_modules/@deepseek-ai/*`；
> `dsh-client-ui-slots` 不在该目录，取自本仓 catalog 锁版 `.pnpm/@deepseek-ai+dsh-client-ui-slots@0.1.5-rc.1`（432 行）。
> 纪律：本文引用的行号**均由本人读过实现**；子 agent 提出而本人未复核者单列于 §6。

## 1. 现状评估：三类代码，必须分开看

包内共 45 文件 / 3002 行。按目录实测：`client` 651、`server/tools` 689、`server/git` 342、
`server/scope` 343、`server/binding` 306、`server/api` 221、`host` 187、`index.ts` 160、
`contract.ts` 28、`server/shared` 75。

结论：**结构合格，但有 4 处自造的"弯"；另有约 17% 的行数是边界纪律的记账（不是错）。**

### 1.1 真弯（自造，建议改）

| # | 位置 | 行数 | 为什么是弯 | 建议 | 依据 |
|---|---|---|---|---|---|
| 1 | `client/takeover.ts` 接管状态机 | 182 → 约 60 | 为让分发器把 entryKey 指到我们：注册自己 id 的正文+标题，再顶掉类型表，再用 `officialKey` 首读缓存（:55）+ `live.component` 比对（:138）+ 三份 disposer 逆序维护一致性。**4 步流程被写成状态机**，且当值条件依赖类型表（一有竞态就静默失效——这正是当前 P0 的形态） | 以**官方 id 为 key、`priority < 0`** 注册正文 entry，不碰类型表：1 次 register + 1 次当值自检 + 1 个 disposer | ui-slots `index.js:76/77/84-88/129-131/187-202`；官方正文注册 `sidebar-files/lib/client.js:701-707`；分发 `renderer:826-829`；entryKey `sidebar-right:737` |
| 2 | `scope/impl/fallback` + `DefaultScopePort` + `host/defaults.ts` | 23+9+53 ≈ 85 → 0 | **复刻官方默认解析语义**（含"无 header → undefined、有 header 无 cwd → 回落沙箱根"两态），官方一改就要跟 | provider 未注册时不复刻，改订阅等待其出现后再捕获 | `dsh-typert-registry/lib/index.js:272`（暴露 subscribe）、`:238-251`（register 时 emit `kind:"lookup"`） |
| 3 | `tools/impl/register` 与 `create` 的重复前置检查 | 约 15 | 「会话有无 cwd」「是否在 git 仓库里」两段判断各抄一遍（register:51-60 / create:49-59） | 抽公共 `precheck(deps, session)` | 直接对比两处 |
| 4 | `client/index.ts` 的 `prune` + `isGone` | 约 40 | 为"宿主快照里消失的会话"做回收，但**宿主是否真会把已关闭会话移出快照从未验证**——防御代码叠未验证前提 | 先补真机观察钉死；不成立即整块删（`index.ts:65-158`、`isGone:70-80`） | 待验证项 |

### 1.2 被迫（看着弯，实际是官方接缝 / 事故成本，不要动）

| 位置 | 为什么删不得 |
|---|---|
| `scope` 三条硬纪律：capture 必须早于 configure / 同键被占即放弃 / 解析器永不抛 | `configure` 排他且全局（`typert-registry:191` 二次 configure 抛错）；resolver 抛异常会被 gateway 翻成硬失败而非回退 |
| 组合根"装一个推一个 disposer + 失败逆序回滚 + 逆序逐个 await" | 半装配比不装更差；binding 释放要等在飞写盘落定 |
| binding 的串行写盘链、写盘失败内存不前移、`installed` 守卫抛错 | 并发写会静默吞掉前一次绑定；"内存说有磁盘说没有"重启后即静默换根失败 |
| tools 的 `generation` + 串行链 + 两入口（事件 + 存量扫描） | 防同一 agent 装两遍、防跨 release 串味、防漏掉插件加载前已存在的会话 |
| api 域围栏单点（`shared/host-utils` 的 loopback/405/500 收口） | 安全边界的修复必须传播到所有插件，复制一份就是让它不再传播 |
| 客户端三条硬约束：快照引用稳定 / 只改一个字段 / 失败保持上次成功态 | 每次违反都对应一次真机事故（`client/shared/ports.ts:1-16` 记录了其中两次） |
| git 域把 argv 构造与 exec 分离 | 参数注入与越界是两半，分开写才能逐条断言 |

### 1.3 记账（约 17%，观感来源，不建议动）

| 项 | 行数 |
|---|---|
| 5 个 `interface.ts`（install/release + 能力转发） | 169 |
| 5 个 `deps.ts`（端口声明） | 195 |
| `client/shared/ports.ts`（官方形状镜像 + 类型面） | 123 |
| `server/shared/interface.ts` + `type.ts` | 18 |
| 合计 | **约 505 / 3002 ≈ 17%** |

买到三件事：跨域只能 `Pick` 窄端口（依赖方向可被门禁校验）、官方形状只出现在 `host/` 与 `ports.ts`（域可脱离 cordis 单测）、rc 演进时改动点收敛。
消掉它的唯一办法是放弃这三项收益，**不建议**。把 `ports.ts` 的官方形状换成 `import type` 亦不可行：
catalog 内只有 `dsh-client-ui-slots` 可引且其发布物有 TS2664 问题（`packages/dsh-lan-proxy/src/client/index.ts:30-33` 用 `declare module` 绕过），
renderer / sidebar-right **不在 catalog**。

## 2. 两处"深侵入官方"的现状

| 官方面 | 现状 | 是否可去 |
|---|---|---|
| `typert.lookups.configure("workspaceFileScope")` | 全局、排他地接管官方四个文件 API 的根解析 | **不可去**（见 §2.1） |
| `sidebarRightTabs.register({...官方定义, id: 我们, priority:"extension"})` | 顶掉全局 tab 类型表 | **可去**（见 §1.1 第 1 项） |

### 2.1 宿主那处为什么砍不掉

产品三条硬约束：任意绝对路径 worktree + 树根指向它 + 会话 cwd 不变。

- 官方目录列举的围栏只有 `list`（`dsh-api-workspace-files/lib/index.js:505` → `:566-573` 的 `confine`）；`read/stat/locateFile` 全程无 contains（`:579-599`）⇒ 真正卡住的只有"列目录"。
- 绕开 gateway 直调官方服务（`ctx.workspaceFiles.list({sessionId, workspaceRoot: worktree}, …)`）**在纸面上更浅**，但落地不成立：官方在 apply 期就把 list 闭包捕获进 face——

  ```js
  // dsh-client-ui-sidebar-files/lib/client.js:700
  const inject = filesFace(createList(ctx.remote));
  ```

  而 face 只暴露 `start/load/toggle`（`:101-115`），**不暴露 list**。要改指到我方路由就得重建整个官方 face（复刻分页/世代/abort，官方一改即坏）或去改 `ctx.remote`（比 configure 更深的内部面），并丢掉 `changes` 变更订阅（worktree 内已打开文件不再自动刷新）。
- ⇒ **在"任意路径"约束下，`configure` 是唯一接缝。**

## 3. git 选型评估（是否可引入成熟库）

先澄清一件事：本包**没有重实现 git 语义**。`git/impl/exec`（32 行）= `execFile` + argv + 超时/缓冲上限；
`git/impl/inspect`（78 行）= argv 构造 + porcelain 解析；`git/impl/service`（154 行）= 归属缓存 + 能力翻译。
全部是在 `git` 二进制之上的薄封装，共 7 条命令（5 查询 + 2 变更）。

| 库 | 版本 | 许可 | unpacked | 依赖数 | 能否覆盖 | 结论 |
|---|---|---|---|---|---|---|
| simple-git | 3.36.0 | MIT | 951 KB | 5 | 能（`raw(['worktree', …])`）；仍是包 git 二进制，只替我们做 spawn + 解析 | **唯一可行候选** |
| isomorphic-git | 1.42.2 | MIT | 4.9 MB | 11 | **不能**：其官方 All Commands 索引中 `worktree` 零命中，`worktree add/remove/list` 恰是本插件核心动作 | 否决（能力缺口） |
| dugite | 3.2.3 | MIT | 69 KB（JS 层）+ 安装期下载 git 二进制 | 2 | 能 | 否决：自带 git 二进制，与"发布物自包含 / 体积"冲突，且触发 vendored-binaries 面 |
| nodegit | 0.27.0 | MIT | 23.8 MB | 9 | 能（libgit2 支持 worktree） | 否决：原生绑定 + 体量 + 维护停滞 |
| @napi-rs/simple-git | 1.1.0 | MIT | 158 KB + 各平台原生二进制 | 0 | 能 | 否决：原生跨平台预编译成本与体积 |

**建议：不引入。** 理由：

1. 引入第三方依赖属**仓库红线**（`AGENTS.md`「红线须先评审：…新增第三方依赖」），须走提案 + 维护者 `approved`；
2. 收益只有 `exec` + 部分 `inspect`（约 60–80 行），而代价是 951 KB 内联进发布物、许可证归集、CI 归属与依赖面变更；
3. 会削掉"argv 逐字可断言"这一现有测试资产（`git/impl/inspect` 的价值正于此）；
4. 7 条命令的接入成本低于任何库的引入成本，且 `execFile` + argv 数组已成安全边界（不经 shell）。

若维护者仍要求引入，simple-git 是唯一候选，且必须先过依赖评审。

## 4. 能力收敛提案：git 域对外 7+1 → 4，校验内部化

### 4.1 现状消费者（实测）

| 能力 | 消费者 |
|---|---|
| `commonDir` | tools 域 3 处（register:58 / create:57 / bind:96） |
| `belongsTo` | scope 域 1 处（resolve:57）、tools 域 1 处（bind:67） |
| `listWorktrees` | tools 域 1 处（bind:50） |
| `headBranch` | tools 域 1 处（bind:77） |
| `checkRefFormat` | tools 域 1 处（create:73） |
| `addWorktree` / `removeWorktree` | tools 域各 1 处 |
| `gitExec` | 组合根 1 处（`index.ts:109`，且是唯一消费者） |

### 4.2 收敛后的四个能力（校验进内部）

```ts
export interface GitApi {
  /** 仓库上下文：不在仓库里返回 undefined；含可用 worktree 清单（失败提示用）。 */
  context(dir: string): Promise<{ repoRoot: string; worktrees: readonly WorktreeEntry[] } | undefined>;
  /** worktree 事实：存在性 + 是否同一仓库 + 当前分支。**只给事实，不给结论**。 */
  examine(target: string, repoRoot: string): Promise<{
    present: boolean; sameRepo: boolean; branch: string | undefined;
  }>;
  /** 新建：分支名在内部过 check-ref-format，非法即返回 { ok:false, reason }。 */
  create(repoRoot: string, path: string, branch: string | undefined): Promise<Ok | Err>;
  /** 删除。 */
  remove(repoRoot: string, path: string, force: boolean): Promise<Ok | Err>;
}
```

内部化映射：

| 原先外露的感知 | 收敛后归属 |
|---|---|
| `checkRefFormat` | `create` 内部（调用方不再感知"分支名校验"这件事） |
| `commonDir` / `listWorktrees` | `context` 内部 |
| `belongsTo` / `headBranch` / 目录存在性 | `examine` 内部（顺序仍是先本地 stat、后起 git） |
| `gitExec` 常量 | 不再外露：门面 `installGit(deps?: Partial<GitDeps>)` 内部补默认 `exec`，测试仍可注入假实现 |

### 4.3 关键点：现在的"两条校验"不是重复，是两种反应

写时（`tools/bind:67`）严格拒绝；读时（`scope/resolve:57`）容错并**摘除失效绑定**。
统一方式不是把结论也统一，而是**域只给事实（`examine`），反应留在调用方**：

- tools：`!present` → "No such directory"；`!sameRepo` → 提示可用 worktree 清单；
- scope：`!present || !sameRepo` → `drop` + warn + 回 cwd（且"读不了 ≠ 不存在"的容错语义留在域内）。

### 4.4 反向选项（否决）

"统一成一个 `run(args)` 透传"是**反方向**：它把 argv 与 git 语义推回调用方，等于让校验扩散——与"职责更清晰"相反。

## 5. 待裁决与验证清单

| # | 事项 | 状态 |
|---|---|---|
| 1 | 遮蔽式正文接管（官方 id + `priority<0`），去掉顶类型 | 待裁决；依据见 §1.1 第 1 项 |
| 2 | 删 `fallback` + `DefaultScopePort` + `host/defaults`，改 subscribe 等待式 | 待裁决 |
| 3 | git 能力收敛 7+1 → 4 + `gitExec` 不外露 | 待裁决（属公共接口变更，须评审） |
| 4 | `prune`/`isGone` 存废 | 待真机证据 |

动手前必须先跑的隔离实验（临时 `DSH_HOME` + 独立 profile + 独立端口）：

- **U2**：同 key + `priority=-1` 是否稳定当值（含两次 HMR 重注册），断言 `data-files-root` 与不出现 `data-slot-error`；
- **U3**：树根指向 worktree 后 `list` 通过、且点开文件确实读到 worktree 里那一份；
- **启动序**：真实 boot 打印 `lookups.get("workspaceFileScope")` 是否存在、`subscribe` 是否还能收到该键事件（决定"有则捕获，无则等"是否安全）。

## 6. 未由本人复核的证据（子 agent 提出）

以下行号来自两个上下文独立的子 agent 报告，本人**未逐条复核**，引用前需自行核对：
`dsh-api-session-controller` 自身使用 `configure`（185/190）、`dsh-fs-local` 的 realpath 与 lstat 细节、
`dsh-workspace` 的 attach 前置（111-123）、`dsh-client-ui-session` 的 `uiSession.provide`（133-152）、
`dsh-session` header 冻结（types.d.ts:55-69、lib/index.js:795）、以及会话作用域方案的 20 处 `useSessions` 消费方清单。

## 7. 与既有文档的关系

- `docs/proposals/worktree-sidebar.md` §16/§17/§18 是第二/三/四轮台账；**本文是第五轮的复核台账**，不替代它。
- 本文件不进入 npm 发布物（`package.json` 的 `files` 未含 `docs`）。
