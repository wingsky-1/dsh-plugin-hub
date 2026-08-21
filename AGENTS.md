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

构建 / 测试 / 契约 / 打包命令见 [docs/DEVELOPMENT.md §0](docs/DEVELOPMENT.md#0-构建总览)。
改动提交前至少跑一遍 `pnpm build && pnpm test && pnpm contract && pnpm pack:check`
（CI 会全量跑所有门禁）。

## 全局约定

- **绝不修改 DSH 源码**：挂载只走 `cordis.patch.yml` + profile；类型自定义在
  `types/dsh.d.ts`；禁止 tsconfig 指向任何 DSH 源码 checkout。
- **新包一律 `dsh-` 前缀**；npm 包名 `@wingsky-1/dsh-*`；聚合包 `dsh-plugins-all`。
- **零运行时依赖**：所有插件发布物自包含，运行时零 npm 依赖（宿主注入模型）。
- **客户端为干净模块**：只 `export function apply(ctx)` + `export const inject`，
  样式独立 `src/client/style.css`，构建走 `scripts/build-client.ts`，路由强制 loopback
  围栏，patch id 用 `ui-<name>`。细则与禁止项见
  [DEVELOPMENT.md §1/§2/§3](docs/DEVELOPMENT.md#1-宿主端srcindexts规范)。
- **安全语义**：涉及密钥/凭据/远程执行/令牌的包修改安全语义时同步更新 README
  与测试；安全模型放包 README 的 `## 安全模型` 一节。

## 提交规范

Conventional Commits（`type(scope): subject`；type：`feat` / `fix` / `docs` / `refactor` /
`test` / `chore` / `ci` / `perf`；**禁止 emoji**）：见 [CONTRIBUTING.md](CONTRIBUTING.md) 提交信息。

## 提交前检查

见 [CONTRIBUTING.md](CONTRIBUTING.md) 提交前检查（敏感信息扫描 / 发布物边界 / 只推功能代码）。

## 发布纪律（Release notes）

- 发布由推 `vX.Y.Z` tag 触发（`.github/workflows/release.yml`）：管线校验全包版本 ==
  tag 后全量门禁，再 `pnpm publish`、创建 GitHub Release。**不要**直接改包版本号绕过
  tag 校验。
- GitHub Release 更新说明**每版入库**为 `docs/release-notes/vX.Y.Z.md`，由发版 agent
  从上一 tag 至今的常规提交生成、逐条译为 `EN / 中文`、随 `chore(release):` 提交；
  管线优先引用该文件，缺失则回退 GitHub 自动 notes。**禁止 emoji**（覆盖文档与提交信息）。
- 合并方式：CI 全绿后 squash merge（见 CONTRIBUTING.md 开发流程）。

## 测试纪律

smoke 全部无网络、无真实凭据，本地可直接运行；新功能/修复必须带 smoke 断言
（含路由 403/405 围栏用例、client 契约断言）。防 flake 纪律（隔离文件路径 / 设 DSH_HOME
到临时目录 / 轮询替代固定 sleep）见
[DEVELOPMENT.md §5](docs/DEVELOPMENT.md#5-smoke-测试防-flake-纪律)。

## 参考文档

- 开发规范（宿主/客户端写法、构建契约、多端兼容、测试防 flake 纪律）：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 贡献规范（Conventional Commits、功能分支 + PR 流程、提交前检查）：[CONTRIBUTING.md](CONTRIBUTING.md)
