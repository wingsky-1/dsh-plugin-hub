# @wingsky-1/dsh-worktree-sidebar
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-worktree-sidebar)](https://www.npmjs.com/package/@wingsky-1/dsh-worktree-sidebar)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

给 agent 三个工具，把某个 **git worktree** 登记给当前会话，让该会话右侧栏的文件树根指向那个 worktree —— **会话 cwd 不变**。

这是一个**过渡适配层**：官方若推出原生 worktree 会话能力，本插件即退役。
原理与运行机制（五域装配、宿主/客户端链路、自愈判据、命门清单）见 [架构图解](../../docs/architecture/dsh-worktree-sidebar.md)。

## 它做什么

dsh 的右侧栏文件树根固定取 `session.header.cwd`，且该字段创建后不可变（显式收养不同 cwd 的会话会抛 `ApiSessionCwdConflict`）。于是在「会话开在主 checkout、实际改动在 worktree」这一常见工作方式下，树看的是主 checkout，看错了地方。

本插件给 agent 三个工具：

| 工具 | 作用 |
|---|---|
| `ws_worktree_register` | 把一个**已存在**的 worktree 登记给当前会话 |
| `ws_worktree_create` | 先 `git worktree add` 建出来，再登记（路径与分支由调用方给出，插件不设目录约定） |
| `ws_worktree_remove` | 摘掉登记；只有显式给出参数才连带 `git worktree remove` 删目录 |

登记之后**打开或刷新**右侧栏的 Files 页签，列的就是该 worktree 的内容，点开的文件预览读的也是 worktree 里的那一份。
页签**不会自动跟随**：插件不轮询宿主，只在「打开页签 / 点官方刷新 / 窗口重新可见或获得焦点」这三种时机重读登记。

子 agent 的会话继承父会话的登记：子会话自己没有登记时，它右侧栏的 Files 页签指向父会话登记的那个 worktree（父链到顶、父会话摘除即回退到自己的 cwd）。

工具对 **git 仓库内的所有 agent（含子 agent）**暴露：每个 agent 注册时按其会话目录判断，不在 git 仓库里就不注册。执行期还有一次兜底校验，环境在两次之间变了也不会按错误前提动作。

三个工具同时带一个可见的返回文本，写明当前指向哪个 worktree、分支是什么 —— 让模型不必额外调一次工具就能确认状态。

## 显式非目标（已知不一致清单）

这些是**刻意的**取舍，不是待办；它们源于「只换视图根」这一决定：

- `@` 文件引用、`present` 交付物落点、skill 目录**仍锚 `session.header.cwd`**，不随视图根走。树指 worktree 而 `@` 列主 checkout，这是本插件最容易被误解的一处。
- **`workspace-write` 文件策略下 agent 写不进 worktree**：写围栏的 `sandboxPolicy.workspaceRoot` 同样取自 `header.cwd`，该服务不可被第三方插件替换。要写 worktree 请改用 `danger-full-access`，或把会话开在 worktree 里。
- 主 checkout 与 worktree 里的**同名文件在预览里没有差异标记** —— 树换了根，文件内容就按 worktree 那一份显示。
- 「树根 = worktree、执行 cwd = 原目录」是本方案的语义前提。agent 的命令仍在原 cwd 下执行。
- 被改写的会话视图**只作用于本插件注册的那一个 entry**：客户端把改写挂在官方 entry inject 面的 `hooks.sessions` 上，只影响这一个 entry 的注入面；其它 `useSessions` 消费方（预览、命令面板、`@` 等）仍读到会话真实 cwd。这是「只换视图根」的直接后果，不是待办。

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-worktree-sidebar
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-worktree-sidebar
```

卸载后登记表仍留在 `<DSH_HOME>/@wingsky-1/dsh-worktree-sidebar/bindings.json`，但不再有任何效果 —— 插件不在了，就没有人接管文件根。真正建出来的 worktree 目录**不会**被删除，需要时自行处理：

```sh
git worktree list          # 看还有哪些
git worktree prune         # 清理已被手工删掉目录的登记项
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-worktree-sidebar
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-worktree-sidebar@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-worktree-sidebar
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-worktree-sidebar
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-worktree-sidebar
```

## 验证

```sh
pnpm build && pnpm test      # 仓库内：构建 + 单测/集成（含真 git 仓库与真 worktree 的增删）
pnpm gate:pr                 # 开 PR 前；新增包与 catalog 条目另需 pnpm gate:full
```

四条**界面语义**进不了任何自动门禁（`gate:*` 里没有浏览器），只能靠隔离真机验证，属发布前人工证据：

1. 打开或刷新 Files 页签后，文件树列的是 worktree 内容；
2. 点开文件预览读的是 worktree 里的文件；
3. 未登记会话、以及未安装本插件时的行为一致（无回归）；
4. 子 agent 会话的树根跟随父会话的登记。

## 兼容性（只读耦合点）

插件不改官方源码，但**读取**以下官方契约（基线 `@deepseek-ai/dsh 0.1.5-rc.1`）；官方改版时这些点是唯一的失效面：

- 宿主 `typert` 的 `workspaceFileScope` 查表：本插件用 `lookups.configure` 注册自己的解析器，并在 miss 时委托**配置前捕获到的官方 resolve**；
- 客户端 `sidebarRightTabs` 类型注册表与键控座位 `sidebar.right.pane.tab`（含 `StoredEntry` 的 `component/inject/store/locale` 形状）；
- 会话 hook 源契约 `{ getSnapshot(), subscribe(fn) }`，且 `getSnapshot` 必须返回**引用稳定**的快照；
- 官方客户端包 `@deepseek-ai/dsh-client-ui-sidebar-right` 必须存在（它提供 `sidebarRightTabs`）。

任一点失效时的行为是**零注册 / 退回官方**：抓不到官方页签实现就一个页签都不注册，树按官方原样显示 cwd。**可感知地什么都不做，好过静默显示错的地方。**

## 安全模型

- **路由只回环**：`/api/dsh-worktree-sidebar/*` 非回环请求一律 403，方法不在表里 405（403 先于 405）。插件不向浏览器暴露任何文件读取面。
- **查询端点带自愈副作用**：`GET /api/dsh-worktree-sidebar/bindings` 在解析生效根时会顺带摘除**已确认失效**的登记（写 `bindings.json` 并让 revision 自增）。这是刻意的：客户端以 revision 判定缓存有效性，只忽略不摘的话 revision 不变、树会一直指向已经不成立的根。
- **不回主仓库路径**：绑定查询只回 `{ revision, worktreePath | null }`，不回 `repoRoot` —— 客户端只需要目录根。
- **git 只经 `execFile` + argv**：不经 shell，路径与分支名里的空白、`;`、`$()` 不会被重新解释。
- **分支名交给 git 自己校验**（`git check-ref-format --branch`）；所有位置参数前加 `--`，形如 `--force` 的路径不会被当成标志。
- **省略分支时显式 `--detach`**：`git worktree add <path>` 的默认行为是**新建一个以目录 basename 命名的分支**，basename 含空格（macOS 家目录常见）会被 git 拒为非法分支名，以 `-` 开头则会被它当成开关二次解析——而 `--` 只挡得住 worktree add 自己的选项解析。补上 `--detach` 之后「省略分支」才真的是「checkout 仓库 HEAD（detached）」。
- **删除是显式的**：`ws_worktree_remove` 默认只摘登记，只有显式参数才执行 `git worktree remove`，且 `--force` 需要再单独显式给出（默认不丢未提交改动）。插件只做 `git worktree remove`，不 `rm -rf`。
- **落盘在 `DSH_HOME` 下**：`bindings.json` 以临时文件 + `rename` 原子写；文件损坏、版本不符一律当空表，不猜着读。
- **工具不下发权限**：工具只写自己的登记表并调用 git；不读凭据、不联网。

## 已知限制

- **会话 id 会被重启后的新会话复用，登记不跟着走**：官方会话 id 是**进程内计数器**（`session-1`、`session-2`…），重启后新会话会重新拿到同一个 id。所以登记表里额外存了该会话 header 的 `createdAt` 作为身份凭据：凭据对不上（＝这是另一个会话）就摘掉那条登记、按未登记处理；真正的会话恢复读到的凭据一致，登记照常生效（只读受阻时保守保留，不会因一次 IO 抖动摘掉用户的登记）。
- **worktree 目录被外部删掉**时按「未登记」处理并让树回到真实 cwd（可感知，不会指向不存在的目录）；但**归属读不出来**（权限、git 执行失败）时保留登记并出声——只有两侧都确实读到了公共 git 目录、且值不同，才判定「已不是该仓库的 worktree」。
- **一次一个 worktree**：一个会话同时只指向一个 worktree，再次登记会覆盖前一次。
- **不注入系统提示词**：模型不会被告知「你有这个工具」，只从工具清单与返回文本了解。这是刻意的（避免常驻提示词开销），代价是模型发现该工具依赖它主动查看工具列表。
- **`workspace-write` 下写不进 worktree**（见「显式非目标」）。
- **安装 / 升级后需重启一次** `dsh web`。
- **每会话状态随插件卸载一起释放**：客户端不再做存活性推断（按会话剪枝已在去轮询换根时删除），快照只用来改写 `byId[sessionId].cwd` 这一个字段；视图与订阅在本插件卸载时被收掉（`ctx.effect` 里 `releaseAllSeedings()` + `views.clear()`），视图缓存另有 128 条上限（淘汰最冷的会话；每个视图都是同一份宿主事实的独立读数，淘汰不会让树读到另一个地方）。
- **同进程第二次装配会显式抛错**：五个域都是进程内单例（`install` / `release` 成对 + `installed` 守卫），第二份实例挂不上并在第二次 `install` 时抛错，而不是静默共享状态。若某个 profile 把本包挂了两次，表现是启动期一条明确的报错；旧的「两份实例互不干扰」语义已不存在。

## 落幕判据

以下任一条件满足时，本插件即可退役：

- 官方提供原生的 worktree 会话能力（会话自带工作区切换）；
- 官方提供受支持的「按会话切换文件根」能力；
- 官方让 `SessionHeader.cwd` 可变，或让 `workspaceFileScope` 有受支持的第三方扩展点。

退役后建议从使用者的仓库里清理遗留 worktree：`git worktree list` 查看、`git worktree prune` 清登记。
