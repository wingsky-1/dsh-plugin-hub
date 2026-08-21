# dsh-plugin-hub — 仓库规则

DeepSeek Harness 的插件集 monorepo（npm 分发）。每个插件都是独立的 cordis bundle
包，经 `cordis.patch.yml` + profile 机制挂载到 `dsh web`，绝不修改 DSH 源码。

## 仓库布局

```text
packages/
  dsh-<name>/       功能插件包（每个都是独立 npm 包 @wingsky-1/dsh-*）
  dsh-plugins-all/  聚合包（一键装全家桶；cordis.patch.yml 由 scripts/aggregate.ts 生成）
shared/
  loopback.js/.d.ts      loopback 围栏（单一事实源）
  host-utils.js/.d.ts    宿主端辅助（writeJson/readBody/errorMessage 等)
  frontmatter.js/.d.ts   frontmatter 解析
  host/                   宿主侧共享（plugin-skeleton 骨架、mount-once 防重）
scripts/              仓库维护脚本（构建/契约/打包/聚合/发布/脚手架）
test/                 共享测试工具（smoke-lib）
types/dsh.d.ts        宿主端类型层
```

## 常用命令

```sh
pnpm install
pnpm build            # 全仓构建（clean-lib → tsc → bundle-host）
pnpm test             # 全量 smoke（Node ≥23.6 原生直跑 TS）
pnpm contract         # 客户端契约（执行产物断言）
pnpm pack:check       # tarball 完整性（含聚合包专项）
pnpm verify:npmlayout # npm 布局：解包后可加载
pnpm aggregate:check  # 聚合 patch 不漂移
pnpm typecheck        # 全仓类型检查
node scripts/dsh-plugin-new <name>   # 脚手架（F 阶段提供）
```

改动提交前至少跑一遍 `pnpm build && pnpm test && pnpm contract && pnpm pack:check`
（CI 会全量跑所有门禁）。

## 全局约定

- **绝不修改 DSH 源码**：挂载只走 `cordis.patch.yml` + profile；类型自定义在
  `types/dsh.d.ts`；禁止 tsconfig 指向任何 DSH 源码 checkout。
- **新包一律 `dsh-` 前缀**；npm 包名 `@wingsky-1/dsh-*`；聚合包 `dsh-plugins-all`。
- **零运行时依赖**：所有插件发布物自包含，运行时零 npm 依赖（宿主注入模型）。
- **构建预设只用 `scripts/build-client.ts`**（客户端契约外壳生成 + load id 注入 +
  内建校验），禁止在包内复制参数。
- **客户端源码是「干净模块」**：只 `export function apply(ctx)` + `export const inject`，
  源码**禁止**写 `window.__ModuleLoader__.load`、IIFE、手拼 `__DSH_PLUGIN_ID__`、
  `declare var module`/`interface Window.__ModuleLoader__`——这些契约外壳（load 注册、
  IIFE 闭包工厂 + factory + `Symbol.toStringTag` 装配 + load id === 包名）由
  build-client 构建期统一生成。客户端入口统一 `src/client/index.ts`。
- **客户端样式**：独立 `src/client/style.css`（`.css` text-loader 构建期内联），
  源码 `import STYLE from "./style.css"`；不把 CSS 写进 ts。颜色用 `--dsw-alias-*` 等
  实时主题变量 + 浅色回退，明暗自适应；挂载失败只 console.warn。
- **客户端路径二选一**：默认「bare import = 宿主注入 external（React，需
  `react-shim.d.ts`）」；纯浏览器第三方库用 `dsh.client.inlineBareImports: true`
  内联（互斥）。契约：load id === 包名（arrive 校验） + `exports.apply/inject` 装配 +
  自包含零依赖。
- **全部路由强制 loopback 围栏**（非回环 403，方法不匹配 405）；health 路由必项。
- **patch id 规范**：独立包 `ui-<name>`；聚合行由 aggregate.ts 生成（同 id，无
  config）。**独立包与聚合包禁双装**（同 id 双装 loader 报 duplicate）。改独立包
  patch 后必须 `node scripts/aggregate.ts` 重新生成聚合 patch。
- **共享层 js + d.ts 双写**（tsc rootDir 硬约束，shared 不可 TS 化）。
- **安全语义**：涉及密钥/凭据/远程执行/令牌的包修改安全语义时同步更新 README
  与测试；安全模型放包 README 的 `## 安全模型` 一节。

## 提交规范（Conventional Commits）

```
type(scope): subject
```

- type：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ci` / `perf`
- scope：包名或主题（如 `dsh-gzip`、`scripts`、`release`）
- 禁止 emoji（代码、注释、文档、UI、提交信息全覆盖）

## 提交前检查

- 敏感信息：不提交本机路径/用户名/IP/凭据（提交前扫描）。
- 发布物：`pnpm pack` 后 tarball 不含 `src/`、`test/`、内部文档。
- 只推功能代码与对外文档，不推内部治理/讨论细节。

## 发布纪律（Release notes）

- 发布由推 `vX.Y.Z` tag 触发（`.github/workflows/release.yml`）：管线校验全包版本 ==
  tag 后全量门禁，再 `pnpm publish`、创建 GitHub Release。**不要**直接改包版本号绕过
  tag 校验。
- GitHub Release 更新说明**每版入库**为 `docs/release-notes/vX.Y.Z.md`，由发版 agent
  从上一 tag 至今的常规提交生成、逐条译为 `EN / 中文`、随 `chore(release):` 提交；
  管线优先引用该文件，缺失则回退 GitHub 自动 notes。**禁止 emoji**（覆盖文档与提交信息）。

## 测试纪律

- smoke 全部无网络、无真实凭据，本地可直接运行。
- 新功能/修复必须带 smoke 断言（含路由 403/405 围栏用例、client 契约断言）。
- 新包自带 README（`README.md` 中文 + `README.en.md` 英文，中英配对）。

## 参考文档

- 开发规范（宿主/客户端写法、构建契约、测试防 flake 纪律）：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 贡献规范（Conventional Commits、功能分支 + PR 流程、提交前检查）：[CONTRIBUTING.md](CONTRIBUTING.md)