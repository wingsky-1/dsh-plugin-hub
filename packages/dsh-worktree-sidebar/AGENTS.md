# AGENTS.md — dsh-worktree-sidebar 包规则

> 本文件是 `@wingsky-1/dsh-worktree-sidebar` 的包级规范（叠加层）。改动本包
> `src/`、`test/` 前必读。上层规则见仓库根 `AGENTS.md`（硬性）。
> 用户面（安装 / 配置 / 验证 / 安全 / 排障）见 [包 README](./README.md)，
> 原理与运行机制见 [架构文](../../docs/architecture/dsh-worktree-sidebar.md)，
> 各轮读数与遗留判据见 [提案长文](../../docs/proposals/worktree-sidebar.md)。

## 定位

把某个 git worktree 登记给当前会话，让该会话右侧栏的文件树根指向它——**会话 cwd 不变**。
过渡适配层，官方出原生能力即退役。组合根是全包唯一认识 `ctx` 的地方
（`src/index.ts:1-7`），五域按序装配、逆序释放；客户端是干净模块（`apply` + `inject`）。

## 改动前必守（本包特有）

1. **只换侧栏根，不换 cwd**：从不写 `session.header.cwd`；改写只动单个 entry 注入面的
   `byId[sessionId].cwd` 一个字段。`@` 引用、`present` 落点、执行 cwd 不动是刻意语义，不是待办。
2. **绑定最小暴露**：查询只回 `{ revision, worktreePath }`，不回 `repoRoot`
   （`src/shared/contract.ts:23-28`）；api 域只读，其能力面里没有 `put`/`drop`，
   浏览器侧不存在写绑定的授权路径。
3. **路由 loopback 围栏**：用仓库共享层，不复制；非回环 403 先于方法错 405
   （`src/server/api/impl/route/index.ts:41`）。`ROUTES` 改名即双端分叉
   （`src/shared/contract.ts:12-16`），增删路由同步双语 README 的「契约」节。

## 验证

> 口径以根 `AGENTS.md` 门禁矩阵为单一事实源，本节只作提交前自查。

- 改源码走 `pnpm gate:pr`；改本文档或包 README 走 `pnpm docs:check`。
- 路由改动必须带 403/405 围栏用例与两端路由一致性断言；落盘测试一律进 `mkdtempSync` 隔离目录。
- 四条界面语义进不了自动门禁，发布前走隔离真机验证（临时 `DSH_HOME` + 独立 profile + 独立端口）。
