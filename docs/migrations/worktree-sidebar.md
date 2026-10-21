# dsh-worktree-sidebar 退役迁移（DSH 0.2.1-rc.2）

状态：`@wingsky-1/dsh-worktree-sidebar` 已从当前源码树和 `dsh-plugins-all` 聚合包移除，
不再随下一版聚合包分发；已发布版本仍可从 npm 安装。退役范围与进度见
[#1141](https://github.com/wingsky-1/dsh-plugin-hub/issues/1141)。

本页面向已安装该包、需要迁到官方能力的用户；迁移完成后可卸载旧包。

## 官方提供什么（0.2.1-rc.2）

DSH `0.2.1-rc.2` 提供**可选的实验性官方 Git Worktrees**：在「插件 → 官方 → Git 工作树」启用后可用：

- `create_worktree({ name?, from? })`：新建检出目录（默认 `.agents/worktrees/<name>`），并切换当前 Session 的工作目录；
- `working_directory({ cd: "/absolute/path" })`：切换到已有目录。

详见[官方文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/subsystems/worktrees.zh.md)。

## 语义差异（必须确认能接受）

官方工具**不等价于**本包。本包只改侧栏 Files 的视图根，官方改的是会话活动工作目录：

| 维度 | 旧包 `ws_worktree_*` | 官方 `create_worktree` / `working_directory` |
|---|---|---|
| 改什么 | 仅侧栏 Files 根 | 会话活动工作目录（cwd） |
| 命令执行 cwd | 仍是原目录 | 切到新目录 |
| `@` 引用、`present` 落点 | 仍锚 `session.header.cwd` | 跟随活动工作目录 |
| 原项目身份 / 沙箱写权限 | 不变（`workspace-write` 下写不进 worktree） | 原始项目身份与原有沙箱写权限仍不改变 |
| 未提交 / 未跟踪文件 | 不涉及 | 不会自动复制进新工作树 |
| 清理 | `ws_worktree_remove` 显式登记，仅显式参数才 `git worktree remove` | 检出目录和分支不会自动删除 |

一句话：旧包是“树换根、执行不换”，官方是“执行也换”；依赖“只看 worktree、不切执行 cwd”语义的工作流需要重新验证。

## 迁移步骤

1. 在旧环境记下需要保留的绑定路径，并运行 `git worktree list` 核对真实检出目录。
2. **先升级并验证** DSH `0.2.1-rc.2`：在官方插件管理器开启 Git 工作树，按目标目录使用
   `working_directory({ cd: "/absolute/path" })`，或为新工作树调用 `create_worktree`；
   核对当前目录、Files、`@`、命令与权限表现，确认能够接受上表差异。
3. 卸载旧包（见下节）。独立安装与聚合包安装的处理方式不同：
   - 旧插件是**单独安装**：由用户执行 `dsh plugin --profile web remove @wingsky-1/dsh-worktree-sidebar`；
   - 来自 `dsh-plugins-all`：升级到已移除该依赖的**新聚合包版本**；当前源码树已移除，
     发布后由用户更新聚合包。不能仅通过单独卸载让旧聚合包不再加载它。
4. 清理与核对（见「卸载后的残留」）。

仍在 DSH `0.2.0-rc.2` 或依赖“只看 worktree、不切执行 cwd”语义的用户，在完成迁移验证前
应继续使用已安装的已发布版本。
退役 PR 不会代表用户修改 profile 或执行卸载。

## 卸载命令

```sh
dsh plugin --profile web remove @wingsky-1/dsh-worktree-sidebar
```

安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

## 卸载后的残留

- 登记表仍在 `<DSH_HOME>/@wingsky-1/dsh-worktree-sidebar/bindings.json`，但不再有任何效果——
  插件不在了，就没有人接管文件根。可留作历史备查，也可自行删除。
- 官方工具**不会读取**旧绑定，迁移后不要指望旧登记继续生效。
- 真正建出来的 worktree 目录与分支**不会**因卸载本包自动删除：

```sh
git worktree list          # 看还有哪些
git worktree prune         # 清理已被手工删掉目录的登记项
```

不要在迁移中自动执行 `git worktree remove` / `prune`；先人工核对目录内容再决定。

## 相关

- 原包 README 与原架构文档已随包退役从活动树移除。
- 设计决策历史保留在 [设计方案](../proposals/worktree-sidebar.md)。
- 历史发布记录保留在 [发布说明](../release-notes/)。
