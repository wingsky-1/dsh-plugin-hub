# AGENTS.md — dsh-verify-isolated 包规则

> 本文件是 `@wingsky-1/dsh-verify-isolated` 的**包级规范**（叠加层，skill 分发包，
> 宿主零逻辑）。改动本包 `src/`、`skills/`、`cordis.patch.yml`、`package.json`
> 前必读。上层规则见仓库根 `AGENTS.md`（硬性）。

## 定位

隔离验证 skill 的分发包：宿主端仅注册 skill（空装配），验证逻辑全在脚本与 SKILL 文档。

## 改动前必守（本包特有）

1. **不加宿主逻辑**：不得新增宿主路由、客户端与配置面；skill 注册只走
   `cordis.patch.yml` 复用的官方 provider（`bundledSkillDir`），不拼接猜测路径。
2. **恒回环＋令牌隔离**：脚本恒绑回环地址；令牌只进受限状态文件（0600），
    verdict 与回显去令牌。
3. **退出必清理**：临时环境（DSH_HOME / profile / 端口 / 浏览器）用后即清，
   不得在仓库内外残留。
4. **改脚本先读契约**：脚本选项以 `--help` 为唯一事实源，不臆测参数。

## 验证（提交前全跑）

> 完成定义以根 [AGENTS.md 门禁矩阵](../../AGENTS.md) 为**单一事实源**。

```sh
pnpm build && pnpm test
```

包 `test` 为 `run-vitest.mjs --min 1`；另需手工空闲端口浏览器冒烟一次。

## 提交

Conventional Commits（如 `fix(dsh-verify-isolated): ...`），中文 subject，禁 emoji。
