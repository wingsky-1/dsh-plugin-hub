# DEVELOPMENT — dsh-plugin-hub 开发规范

> 覆盖**宿主端 / 客户端**两类代码的写法与构建契约，以及我们统一后的客户端形态
> （干净模块 + 独立 CSS + `src/client/` 目录 + 第三方内联）。适用于本公开仓库
> `packages/dsh-*` 的开发与维护。构建/契约/发布脚本见 `scripts/`；仓库级硬性规则
> （全局约定 / 发布纪律）见根 [AGENTS.md](../AGENTS.md)。

## 0. 构建总览

每个插件包 = 独立 npm 包（`@wingsky-1/dsh-*`），发布物自包含（第三方依赖构建期内联）。

> **安装依赖**：本仓库是 pnpm workspace（`pnpm-workspace.yaml` + 包间 `workspace:*`
> 协议 + pnpm 严格 node_modules）。动手前必须 `pnpm install`（在仓库根执行）。
> **不要用 `npm install`**——它会因 `workspace:*` 协议与 pnpm 布局而失败，且无法
> 复现 CI 的依赖解析结果。

```sh
pnpm install       # 仓库根，pnpm workspace 依赖安装（必须先于一切构建）
pnpm build        # 全仓构建 = pnpm -r build（各包：clean-lib → tsc → bundle-host）
pnpm contract     # 客户端契约（node scripts/gate/contract-check.ts）
pnpm test         # 全量 smoke（Node ≥23.6 原生 type stripping 直跑）
pnpm cov          # 覆盖率采集（c8 包裹 smoke，测量对象 = lib 编译产物）
pnpm crap         # 单函数 CRAP 检查（先跑 cov；观察期只记录，--strict 为未来硬卡点）
node scripts/gate/self-cov.mjs
                  # self-written 覆盖率口径报告（先跑 cov；读 coverage/coverage-final.json，
                  # 去 esbuild 内联 vendor 段与 __ 运行时垫片后仅计自写函数/行/分支，
                  # 输出 coverage/self-coverage.json；函数计数与 crap-check 同一口径；
                  # --dry-run 预览不落盘；观察期只记录不判红）
pnpm pack:check   # tarball 完整性（含聚合包）
pnpm typecheck    # 全仓类型检查
```

> Node 版本：本地直跑 TS 需 **≥23.6**（type stripping 门槛）；CI 固定 Node 24。
> 阈值与 strict 开关见 `scripts/data/gauntlet.config.json`（唯一事实源）。其中
> `coverage.selfWrittenFunctions` 记录 self-written 函数覆盖基线：self-cov 口径
> （去 esbuild 内联 vendor 段与 `__` 运行时垫片后仅计自写函数），当前处于**观察期**
> （只记录不判红），`threshold` 为阶段二目标值，待基线校准（issue #42 二期）后再
> 接入 CI 硬卡点。

### 变异测试与增量链路（#178 / #187）

六包变异配置集中在 `stryker.conf.d/dsh-<pkg>.json`（mutate 区间、testFiles、
阈值口径与 `gauntlet.config.json` 三方一致，由 workflow-assert 自测锚定）。增量链路：

**全量分工总述**：PR 门管变更切片；夜间 observe 门管主干全量；发版前
release.yml tag 管线跑全量门禁——全量只在这三处语义中的后两处真实执行。

- **夜间全量落基线**（observe.yml）：刻意不 restore 任何缓存——无 incremental
  基线即天然全量；运行末尾把六份 `coverage/mutation/incremental-*.json` 收集到
  仓库内版本化目录 `scripts/gate/baseline/`（#204 方案 A：git 跨 ref 天然可见，
  替代按 ref 隔离、PR 永远 miss 的 actions/cache），有实质变化时经
  create-pull-request 自动开 PR 合入 main。逐包容错记账：单包失败记账继续
  跑完其余包，结尾统一非零退出。
- **PR 增量门禁**（ci.yml，#217 变异/覆盖解耦为三段式）：
  1. `coverage` job（全局单次）：单进程跑 `pnpm cov` + `self-cov.mjs`，产物
     `coverage/self-coverage.json` 经 artifact 下发——cov 从变异矩阵剥离后，
     矩阵多实例并行各自全仓 smoke 导致的 lan-proxy 固定端口 EADDRINUSE 与
     provider-usage K12 时序漂移（flake 根因）随之消除；mutate-scope-guard
     同步前移进本 job（PR 阶段即暴露 mutate 区间漂移，observe 夜间执行点保留）；
  2. `mutation-gate` 矩阵（仅基线 + stryker）：按 paths-filter 命中包切片
     （changes.hasMutations 显式布尔驱动 if），restore-only 读仓库内基线后对该包
     跑 Stryker——incremental 模式跳过未变 mutant，报告仍为全量口径（复用
     mutant 继承原状态）；needs coverage 连坐：coverage 失败/skip → 矩阵连带
     skipped（if 不含 always()，隐式 success() 前提生效）；
  3. `mutation-verdict`（聚合判分收尾）：下载 self-coverage 与各包 stryker 报告
     artifact 后逐包跑双指标判分（scripts/gate/mutation-gate.mjs）——测试覆盖率
     self-written 函数 ≥ threshold 恒硬；变异测试率 covered ≥ per-package
     threshold 受全局 `mutation.strict` 约束（false 期间仅标注，#150 达标翻转后
     自动变硬）。矩阵实例级 failure 时 verdict 仍聚合判分（缺报告的包 exit 2
     fail-closed）。

  成败并入 repo-gate 聚合闸（判定逻辑见 scripts/gate/repo-gate-assert.mjs，
  五维判定表「事件 × 切片(hasMutations) × coverage × 变异矩阵 × verdict」由
  单测全组合锁死），不新增分支保护 required check 名。基线缺失时天然降级为
  全量变异。coverage 失败连坐整体红属预期 fail-closed（coverage job 失败 ≈
  smoke 失败，同一 c8 包裹，build-test 同级硬信号）。
- **触发面收敛**（#187 / #217 扩展）：覆盖与变异三段 job 仅限 pull_request
  触发——push 到 main 时 diff 基准 `before` 不可用会使 paths-filter 走
  fail-closed 全量 fallback，变异随之退化全量且与当晚夜间全量完全重复；主干
  覆盖与变异覆盖由 observe.yml 夜间全量承接、发版前由 release.yml tag 管线
  承接，非 PR 事件下三段 job 整体 skipped（repo-gate 判定表显式放行）。
- 本地手动入口：`npx stryker run stryker.conf.d/dsh-<pkg>.json`（临时强制全量用
  官方 `--force` 参数，勿改配置文件）。

目录结构：

```text
packages/dsh-*/            # 每个插件 = 独立 npm 包（@wingsky-1/dsh-*）
  src/index.ts             # 宿主端入口（cordis service，export ROUTES 作客户端路由单一来源）
  src/client/index.ts      # 客户端干净模块入口（只 export apply/inject，无 load/IIFE 外壳）
  src/client/style.css     # 客户端样式（独立文件，构建期 text-loader 内联进 client.js）
  src/client/*.ts          # 客户端辅助模块（宿主用不到、仅浏览器侧）
  src/*.ts                 # 其余为宿主模块；宿主导出的 profile 依赖另见 cordis.patch.yml
packages/dsh-plugins-all/  # 聚合包（dependencies 引用全部子包，发布用 pnpm publish 替换版本号）
shared/                    # 宿主端共享层（loopback/host-utils/frontmatter），构建期内联进各包，不发布
scripts/                   # 仓库维护脚本（*.ts，Node 直跑；按职能分 build/ gate/ lib/ release/ test/ data/）
```

`scripts/build/bundle-host.ts` 编排单包构建：
1. esbuild 内联 `shared/*` 进 `lib/index.js`（宿主端自包含单文件）。
2. 客户端经 `scripts/build/build-client.ts`（唯一契约外壳/注入点）构建 `lib/client.js`。
3. d.ts X1：改写 `../../../shared` → 包内副本，`shared/*.d.ts` 随包。
   shared 层因此保持 **js + d.ts 双写**（tsc `rootDir` 硬约束，shared 不可 TS 化）。
4. 拷贝资源（非 TS 文件）+ LICENSE。
5. 第三方 license 归集：扫描产物中 esbuild 的 node_modules 模块注释，把真实被内联
   的第三方库（含传递依赖）license 文本写入 `lib/THIRD-PARTY-LICENSES`
   （`scripts/build/collect-licenses.ts`）。**运行时依赖 = 构建期内联**——内联在法律上
   等于分发该库副本，必须随发布物附其 license 文本与版权声明；`pack:check` 断言
   「有内联 ⇒ 清单存在、非空、含 MIT/BSD/Apache 字样且覆盖每个被内联的包名」。

宿主端类型一律用官方类型层（pnpm-workspace catalog 锁版：`@deepseek-ai/cordis`
的 `Context` + `@deepseek-ai/dsh-host-webserver` 的 `WebRoute`/ctx.webServer 增强 +
`@deepseek-ai/dsh-tools` 的 `ToolDefinition`/ctx.tools 增强等；仅 import type，
contract-check 禁止运行时值导入）。原自建类型层 `types/dsh.d.ts` 已删除（issue #48）。

## 1. 宿主端（`src/index.ts`）规范

- **单入口**：`src/index.ts` export 一个 cordis service；需要给客户端传路由时
  `export const ROUTES` 作为**单一事实源**——`bundle-host` 经 `__DSH_ROUTES__`
  define 注入给客户端（客户端不引用则零影响）。
- **依赖纪律**：只 import `../../shared/*`（loopback / host-utils / frontmatter，构建期
  内联）与 Node 内置模块；**任何第三方运行时依赖一律由 esbuild `--bundle` 内联**
  （如 web-file-preview 宿主用的 `untildify`/`marked`），发布物不以运行时 npm 依赖形式发布。
- **安全**：全部路由强制 loopback 围栏（非回环 403、方法错 405），`/health` 必项；
  RPC/端点做参数校验；密钥/凭据不入包。
- **挂载**：`cordis.patch.yml`，patch **id 用 `ui-<name>`**；声明 `dsh.client` 时必须有
  `exports["./client"]`（`contract-check` 联动断言，缺则整包拒载）。**独立包与聚合包
  禁双装**（同 id 双装 loader 报 duplicate）；改独立包 patch 后必须
  `node scripts/gate/aggregate.ts` 重新生成聚合 patch。
- **测试**：`test/smoke.ts` 直跑，必含 403/405 围栏用例 + 客户端契约断言
  （`assertClientSourceContract` / `assertClientProductContract`）。

## 2. 客户端（`src/client/index.ts`）规范 — 干净模块

**核心：源码只写干净模块，不写任何 loader 痕迹。**

```ts
import STYLE from "./style.css";          // 样式走独立 CSS（见 §3）

// ... 顶部模块体（函数、常量、DOM 渲染）...

export function apply(ctx: any): void {   // 挂载入口
  // ctx.get("connection"/"sessions"/"workspaces"/"slots") ...
  // 卸载清理必须写在 ctx.effect(() => () => { ... }) 返回的 disposer 里
  ctx.effect(() => () => { cleanup(); }, "dsh-<name>: ui");
}

export const inject: string[] = [];        // 声明 apply 用到的 ctx 服务（如 ["slots"]）
```

**禁止在源码里**：`window.__ModuleLoader__.load`、手拼 `__DSH_PLUGIN_ID__`、`require(`、
外层 IIFE `(function(){})()`、`declare var module` / `interface Window.__ModuleLoader__`。
这些（load 注册、IIFE 闭包工厂、`Symbol.toStringTag` 装配、`exports.apply/inject`、
**load id === 包名**）全部由 `scripts/build/build-client.ts` 构建期统一生成——是唯一事实源，
内建「load id === 包名」硬校验（构建即失败）。

### 2.1 三种客户端路径（build-client 自动选择，作者不用配置）

| 路径 | 触发 | 说明 |
|---|---|---|
| 纯净 wrapper | 干净模块、无 bare import | esbuild iife + 生成契约外壳；`apply/inject` 直出 |
| wrapper + externals | 干净模块 `import * as React from "react"` | 干净模块 cjs 内联进 `factory(require)`，React 由 loader 的 `require("react")` 注入（dsh web **无全局 React**）。需同目录 `react-shim.d.ts`（`declare module "react"`，不引 @types/react），`peerDependencies.react` + `optional` |
| 第三方内联 | `dsh.client.inlineBareImports: true` | 干净模块的 bare import（dompurify/diff2html/marked/highlight…）由 esbuild **内联进 client.js**，产物仍自包含。用于纯浏览器第三方库、无宿主注入 JS 模块的场景 |

> ⚠️ **互斥**：默认「bare import = 宿主注入 external（React）」；`inlineBareImports: true`
> 则全部内联。按包二选一，不要混用。

### 2.2 目录约定

- 客户端入口统一 `src/client/index.ts`（`src/client.ts` 已停用）。
- **拆 CSS 或带多模块/React shim 的包**：客户端专属模块（`md/code/renderer` 等）、
  `style.css`、`react-shim.d.ts`、`css.d.ts` 都归位 `src/client/`；宿主模块留 `src/` 根。
- **宿主 & 客户端共享**的模块（如 web-file-preview 的 `grouping.ts`）留 `src/` 根，
  客户端经 `../grouping.js` 引用——不要为"客户端专用"而把共享模块搬走。

### 2.3 客户端其它要点

- `inject` 语义：声明 `apply` 运行时用到的 ctx 服务；不需要则 `[]`。**这是运行时的
  服务注入声明**，与宿主的 cordis `inject`（插槽）是两码事，别混。
- 生命周期：所有卸载清理写进 `ctx.effect(() => () => {})` 的 disposer。
- 样式：带插件前缀隔离 + `CSS_VERSION`/`dataset.version` 失效（热更新重建 `<style>`）；
  颜色用 `--dsw-alias-*` / `--dsw-hljs-*` 主题变量 + 浅色回退，明暗自适应。
- 挂载失败 `console.warn` 不 throw，绝不让 GUI 启动失败。
- 路由引用用构建期注入的 `__DSH_ROUTES__`（或宿主 ROUTES 字面量），防两端漂移。

## 3. CSS 规范（独立文件，不写进 TS）

- 客户端样式放独立 `src/client/style.css`，源码 `import STYLE from "./style.css"`，
  `injectStyle` 里 `style.textContent = STYLE`。
- `.css` 经 `build-client` 的 **text-loader** 构建期**原样内联**成字符串打进
  `lib/client.js`——产物仍自包含单文件、无独立网络请求。
- `src/client/css.d.ts` 提供 `declare module "*.css"`（tsc 的 `verbatimModuleSyntax`
  需要类型；仅类型面无运行时）。
- 用**格式化多行**书写（区别于旧的字符串拼接）；前缀硬编码进 CSS 与 JS 常量保持一致。

## 4. 契约与门禁

- `pnpm contract`（contract-check）：load id === 包名、`dsh.client ⇒ exports["./client"]`、
  `src/client/index.ts ⇒ lib/client.js` 产物、arrive 可解析、`exports.apply/inject` 装配。
- `assertClientSourceContract`（smoke-lib）：兼容三种产物形态（纯净 wrapper /
  React externals / legacy），断言 `"use strict"`、契约外壳、Symbol.toStringTag、
  `factory: function(`、load 注册。
- **插件清单单一来源**（issue #36）：某插件是否参与聚合/发布校验，唯一事实源是
  `scripts/data/plugins-manifest.json`。四个脚本共用 `plugins-manifest-lib.ts` 的目录
  枚举（`isDirectory` 过滤 + 排除聚合包 + 稳定排序）；其中 `aggregate.ts` 与
  `pack-check.ts` 另做「packages/ 目录集 == manifest.active ∪ standalone 集」双向
  相等断言，以及聚合 deps 键集 / patch id 集对 active 的双向相等断言。
  - **新增插件**：建目录后必须同步把目录名加入 `active`（参与聚合的常规插件）
    或 `standalone`（独立发包、不进聚合包，如 demo 演进包），否则全部门禁红
    （opt-in fail-closed 设计：防止半成品目录被自动卷进聚合 patch 与发布管线）；
  - **独立发包插件**（`standalone`）：与 active 同样参与目录登记、pack tarball
    校验与发布管线，但不出现在聚合包 deps 与聚合 cordis.patch.yml 中；
    聚合 deps 误引 standalone 包会被 fail-loud；
  - **退役插件**：删除 packages/ 目录（git 历史保留），并在 `retired` 数组登记
    `{ name, reason, successor }` 档案；
  - `active`/`standalone` 刻意**不自动生成**：它们就是「当前有哪些插件」的人工确认点，
    自动枚举会退回「目录即事实源」的 fail-open 老路；
  - schema 加载/校验逻辑只有一份：`scripts/lib/plugins-manifest-lib.ts`（纯函数，
    入口脚本只喂数据），测试见 `scripts/test/plugins-manifest.test.ts`。
- **新增/修改客户端后**：`pnpm build && pnpm test && pnpm contract && pnpm pack:check`
  全绿再提交。

## 5. Smoke 测试防 flake 纪律

背景：notifier 的 history 路由测试曾因「多个 `apply()` 实例共享同一 `history.jsonl` +
`appendHistory` 为 fire-and-forget 异步写盘 + 固定 `setTimeout(50)` 后断言『最后一条
为 test』」而 CI 偶发失败（issue #17）。根因是**测试多实例共享全局默认持久化路径、且
依赖异步写盘时序**，与产品逻辑无关。以下纪律用于前置拦截此类 flake。

核心原则：**smoke 测试不得依赖「全局默认持久化路径 + 异步写盘的时序」**。

1. **显式隔离文件路径**：每个测试块必须显式传入 `historyFile` / `persistFile` /
   `storePath` 等，指向 `join(work, "<包>-<块名>.jsonl")` 之类的**唯一临时文件**；
   **禁止多个 `apply()` 实例共享同一文件路径**，尤其禁止依赖 `homedir()` / `DSH_HOME`
   下的默认文件（默认路径是全局单文件，多实例各起一条写链会互相 read-modify-write 竞态）。
2. **测试前置设置 `DSH_HOME` 等环境到临时目录**：所有测试开头
   `process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "<pkg>-"))`，结尾还原（delete 或
   复位原值）。这同时杜绝两件事：① 向真实 `~/.dsh` 写测试数据（污染 + 跨运行状态泄漏）；
   ② 多个测试块 / 运行间共享同一默认文件。**mcp-manager 已如此实践，作为强制基准。**
3. **异步落盘用轮询替代固定 sleep**：断言持久化状态前必须 `poll-until` 满足条件再断言，
   严禁 `setTimeout(resolve, 50 / 300)` 这类「等够毫秒」的时序假设。参考 notifier 的
   `waitForHistory(route, predicate)` 辅助（轮询 GET 直到谓词成立，超时兜底返回当前态）。
4. **fire-and-forget 写入禁止跨块断言顺序**：若写是 `void flush()` / 防抖定时器
   （如 opencode-usage 的 `schedulePersist`、notifier 的 `appendHistory`），绝不能依赖
   「最后一条是 X」「条数 === N」等顺序敏感断言；必须**隔离文件 + 轮询**。理想情况：
   被测插件暴露 `await flushPersist()` 之类的可等待落盘钩子，测试直接 `await` 比轮询更稳。
5. **CI 稳定性门槛**：新增 / 修改 `test/smoke.ts` 后，本地连续跑 **≥10 次**（如
   `for i in $(seq 1 10); do node packages/<pkg>/test/smoke.ts; done`）确认无 flake 再提交。

反例（notifier #17，已修）：多个 `apply(...)` 都传 `historyFile: join(work, "history.jsonl")`
（共享文件）；`await setTimeout(resolve, 50)` 后 `assert.equal(records.at(-1).kind, "test")`。
正例：路由块改用专属 `history-route.jsonl`；落盘用 `waitForHistory` 轮询。

正例（mcp-manager）：设 `DSH_HOME` 到临时目录、每块显式 `storePath: join(dir, "dsh-mcp.json")`、
写盘为 `await writeFile`（已等待）。

## 6. 多端兼容（三操作系统 + 三访问形态 + 明暗双主题）

dsh web 部署在 Linux 服务器，经局域网被多种设备 / 系统访问。插件（尤其客户端 UI 与
涉及文件 / 命令的宿主逻辑）必须同时满足以下三端兼容要求：

1. **三操作系统（mac / linux / windows）**：插件在三种 OS 下都能正确工作。
   - 路径 / 分隔符一律用 `node:path`（`join` / `sep`），禁止字符串拼接 `/` 或 `\`；
     行尾、大小写敏感路径按 OS 处理。
   - 不写死 OS 专属命令 / 二进制；若必须（如 notifier 的 Windows `toast.ps1`），按 OS
     分支并提供 mac / linux 等价实现或优雅降级，不抛错阻断。
   - 脚本 / 构建不得依赖 POSIX 专属行为（CI 目前仅 ubuntu-latest 单平台，跨 OS
     兼容由本地验证保障；后续可为 CI 增加三 OS matrix）。

2. **三访问形态（PC / pad / phone）**：界面响应式、触控友好、窄屏可用。
   - 布局用响应式（flex / grid + 媒体查询），不写死宽度；触控目标足够大、间距合理。
   - 窄屏（phone / pad 竖屏）下信息不溢出、可滚动、关键操作可达；pad / phone 经局域网
     访问是主要场景之一。

3. **明暗双主题（light / dark）**：**禁止硬编码单一配色**。
   - 颜色统一走 `--dsw-alias-*` / `--dsw-hljs-*` 等实时主题变量 + 浅色回退
     （见 §2.3 / §3），明暗自适应；不要在 CSS / TS 里写死 `#fff` / `rgb(...)` 固定色。
   - 挂载失败只 `console.warn`，绝不让 GUI 启动失败。

验证：客户端交互改动须真机 / 浏览器在**双主题 + 窄屏（pad / phone）**下实测 DOM
（浏览器 DevTools 或浏览器自动化 MCP 均可）；宿主端逻辑须在三 OS 下可运行。
构造的样例 fixture 放仓库外工作区，不纳入发布物。

## 7. 浮窗移动端适配约定（#128，dsh-mcp-manager / dsh-provider-usage）

带浮窗胶囊的插件共用以下跨包约定；判定与 clamp 逻辑以纯函数形式放在各包
`src/placement-math.ts`（零依赖单一事实源：宿主端 re-export 供 smoke 断言、
客户端直接内联），两包保持同构。

1. **断点档位**：判定基准 = conversationHost 的 rect 宽度（JS 判定 + data 属性
   `data-dm-bp` / `data-dou-bp` 切换样式），**不用窗口 @media**——防桌面窄窗 /
   iPad Slide Over 误触发。阈值：narrow ≤480 < tablet ≤834 < wide。
2. **z-index 基准**：单字段 `zIndexBase`（clamp 1–9000），面板派生基准 +30；
   默认 mcp-manager=10、provider-usage=40 与各自 CSS 默认一致。模态管理类
   overlay 不占用该预算。
3. **终坐标视口 clamp（safe-area 语义）**：对算好的 fixed 坐标统一过
   `clampPointToViewport`；宿主 viewport meta 无 `viewport-fit=cover`，
   `env(safe-area-inset-*)` 恒 0 → safeInset 缺省 0 自然退化为普通 clamp。
   禁止改宿主 viewport meta。
4. **软键盘 / 旋转**：`visualViewport` resize 监听跟随键盘弹出收起；
   `orientationchange` 后 rAF 一帧重算（切换瞬间 rect 未更新）。
5. **触控目标分层**：伪元素外扩热区保 WCAG 2.2 AA ≥24px 底线；narrow 档主操作
   min-height 36px + 外扩命中区 ≈44px。悬停态一律包 `@media(hover:hover)`。
6. **滚动性能**：scroll/resize/vv-resize/orientationchange 统一 rAF 合并调度；
   MutationObserver 回调去抖到帧。面板高度用 dvh 级联回退（先 vh 声明再 dvh 覆写）。
7. **offsetY=48 跨包避让契约（源自 issue #116，不可回退）**：mcp-manager 浮窗
   默认 top-right、距顶 8px、高约 26px；provider-usage 胶囊默认 offsetY=48 在其
   正下方让位。任一侧默认锚点 / 垂直偏移的变更都属跨包行为契约变更，两包 README
   与默认值必须联动评估调整。

---

> **隔离环境浏览器验证**：客户端 UI 改动（`packages/*/src/client/**` 等）的隔离环境
> 搭建、浏览器 MCP 核验方法、证据归档与流程契约，已独立为
> [ISOLATED-VERIFICATION.md](ISOLATED-VERIFICATION.md)，从本节切分并扩展。
