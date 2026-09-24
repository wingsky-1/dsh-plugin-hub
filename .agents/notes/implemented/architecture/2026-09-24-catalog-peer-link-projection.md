# Agent Note: catalog peer 投影与本地 link 兼容边界

Status: implemented

## Problem

DSH 0.1.7-rc.1 的插件兼容层直接读取 link 目标包的原始 `package.json`，只把
`workspace:^`、`workspace:~`、`workspace:*` 解释为当前 runtime；pnpm workspace 的
`catalog:` 是 pnpm 协议，直接传给 SemVer 校验会得到无效 range，导致本地源码 link 在
安装或启动阶段被拒绝。发布 tarball 由 pnpm pack 物化，因此 registry 安装路径不会暴露
同一个问题。

## Decision

版本事实源与成员事实源分层：

- `pnpm-workspace.yaml` 的 `catalog:` 是官方 peer 版本的权威事实源；值必须是
  canonical exact SemVer。`minimumReleaseAgeExclude` 是 catalog 的供应链校验镜像，必须
  保持同一 `name@version`，但不是第二个版本事实源。
- `scripts/data/plugins-manifest.json` 的 `dshPeerContracts` 是每个 active/standalone
  包必须声明哪些官方 peer 的唯一成员事实源；不记录版本。
- 各包 `peerDependencies` 是由 `pnpm catalog:sync-peers` 生成的精确 SemVer 投影，写入
  源 `package.json`，让普通 `dsh plugin add link:<绝对路径>` 保持严格 rc 校验。
  `devDependencies` / `dependencies` 继续使用 `catalog:`，包版本和其它字段不变。

生成器只更新合同成员的版本值，不自动增删成员；catalog range、成员增删、坏字段、已有
生成锁、写前内容变化都整批零写入。单文件使用同目录临时文件 + rename，跨文件失败只
回滚仍等于本次写入内容的文件。已有锁（包括疑似陈旧锁）一律 fail-closed，维护者确认无
生成进程后手动删除 `.catalog-peers.lock`，不做有竞态的自动回收。

`pnpm contract` 校验源 peer、成员合同、聚合包边界和精确版本；`pnpm pack:check` 与
`pnpm verify:npmlayout` 在 pnpm pack 解包后再次校验源/产物官方 peer 名单、字段形状和
精确版本。聚合包不得声明 DSH 官方 peer。

## Alternatives considered

- **`workspace:*` / `workspace:^` 直接写源 peer**：DSH 会把它当作“当前运行时即可”，
  绕过本仓唯一 rc 约束；还要求 pnpm 能解析 workspace 协议，不能表达 catalog 的精确
  版本边界。拒绝。
- **只在临时目录物化 tarball 后 link**：能保持源文件不变，但会分裂开发者工作流，
  让源码 link、发布物和验证物不是同一条路径；作为隔离验证工具可用，不作为默认 link
  契约。拒绝。
- **profile `allow-version`**：这是用户明确接受崩溃/数据丢失风险的 policy bypass，
  不是依赖解析修复；还会形成随插件/DSH 版本漂移的维护负担。仅保留为人工逃生口。
- **手写每包版本**：能工作，但 29 处 peer 会复制版本事实，升级时容易漏改。拒绝；
  采用生成投影 + 漂移门禁。

## Consequences

- 收益：成员关系由 manifest 合同、版本由 catalog、package.json 由生成投影，三层边界
  清晰；本地 link 和发布 tarball 都使用标准、可校验的精确 SemVer。
- 代价：每次 rc 升级会产生 active/standalone 包 peer 的机械 diff；升级顺序必须是：确定目标 rc →
  更新 catalog 与 `minimumReleaseAgeExclude` 同一精确版本 → `pnpm install` 刷新 lockfile →
  `pnpm catalog:sync-peers` → 定向/全量门禁 → 先发布并安装匹配插件 → 再升 DSH。
  生成器必须显式运行，普通门禁不得隐式写回。
- 边界：非官方 peer（例如 `react`）不参与本投影；聚合包没有 DSH peer，不生成运行时
  依赖。DSH 对聚合包的安装前 preflight 只读取聚合包顶层 manifest，因此**不能**发现子包
  peer 不匹配；聚合安装后必须依赖 web 启动时逐 row preflight/health 检查确认所有子插件。
  隔离验证仍需临时 `DSH_HOME`、独立 profile/端口，禁止操作现有 profile 或豁免。

## Testing

- 脚本单测覆盖：catalog 精确投影、非官方字段保留、幂等、缺 catalog 零写入、range/删成员/
  malformed peer/豁免版本漂移拒绝、锁占用与陈旧锁 fail-closed、发布物漂移拒绝。
- 真实 0.1.7-rc.1 隔离验证覆盖：多 active 插件一次 link 安装零兼容警告、profile symlink
  realpath、启动日志、health 与 client 资源；不使用 `allow-version`。
