# ISSUE-WORKFLOW — issue 处理流程

> 覆盖本仓库 issue 的**提交 → 分诊 → 修复 → 关闭**全生命周期约定，供贡献者与
> 维护者参照。模板见 [.github/ISSUE_TEMPLATE/](../.github/ISSUE_TEMPLATE/)；
> 提交规范与开发流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)；写码规范见
> [DEVELOPMENT.md](DEVELOPMENT.md)；仓库级硬性规则见根 [AGENTS.md](../AGENTS.md)。

## 0. 提交 issue 之前

1. **先升级再报告**：很多缺陷在最新版已修（如 #2 记录的 notifier 0.1.8 SSE 泄漏，
   0.1.9 即已修复）。请先 `dsh plugin --profile web update @wingsky-1/<插件>` 升到
   latest 再确认问题仍在。
2. **搜索既有 issue**：同问题不重复开，在原 issue 下补充信息即可。
3. **选对模板**：
   - 缺陷（崩溃 / 功能异常 / 平台兼容）→ **Bug 报告** 表单（`[bug]` 前缀）
   - 新功能 / 改进建议 → **功能建议** 表单（`[feature]` 前缀）
4. **填全必填项**：插件版本号最关键（`dsh plugin --profile web list` 可查），报错贴
   全文不要截片段。

## 1. 分类与标题惯例

| 类型 | 标题形态 | 标签 | 真实样本 |
|---|---|---|---|
| 缺陷 | `fix(<scope>): <问题描述>` | `bug` | #17、#7 |
| 功能 / 演进 | `[feature] [<scope>] <主题>` | `enhancement` | #6、#4 |
| 长期跟踪（meta） | `<主题>（Meta）` 或「配套：…」 | `enhancement` | #8 及其子项 #9–#13 |
| 安全 / 升级公告 | `<影响面描述>，请升级到 x.y.z` | `bug` | #2 |

- scope 用包名短横线形（`dsh-notifier`）；跨包 / 仓库级用 `meta`。
- 一个 issue 只装一件事；多子项的长期目标拆成 Meta + 子 issue（见 §3）。

## 2. 处理流水线（维护者）

```text
提报 → 分诊(triage) → 定位 → 修复分支 → PR(关联 issue) → CI 全绿 squash merge → 自动关闭
```

1. **分诊**：确认复现信息完整（缺则向报告者追问）；打 `bug` / `enhancement` 标签；
   判断是否 Meta 子项，需要则挂到父 issue 并在父项清单登记。
2. **定位**：宿主端问题看 `src/index.ts` 与 dsh web 日志（`<插件>:` 前缀行）；
   客户端问题按 DEVELOPMENT.md §2 的干净模块契约排查；CI flake 类修复**必读**
   [DEVELOPMENT.md §5](DEVELOPMENT.md#5-smoke-测试防-flake-纪律)（隔离文件路径 /
   设 `DSH_HOME` / 轮询替代固定 sleep）。
3. **修复分支**：命名 `fix/<主题>` 或 `feat/<主题>`（与 CONTRIBUTING.md 开发流程一致）。
4. **PR 关联 issue**（二选一，推荐前者）：
   - PR 正文写 `Fixes #<编号>` —— merge 后 GitHub 自动关闭 issue；
   - 或 commit message 引用 `(#<编号>)`，merge 后 issue 上会留下 referenced 记录，
     手动关闭。
5. **合并即收尾**：CI 全绿后 squash merge（远端分支自动删除）；issue 若未自动关闭
   则手动关闭并在评论里给出「修复版本号」（发布后回填，如 #17 对应 0.1.9）。

## 3. 特殊类型

- **Meta 长期跟踪**（样本 #8「依赖现代化」）：父 issue 维护子项清单（如 #9–#13），
  每完成一个子项在父项勾销并链接对应 PR；父 issue 在全部子项完成后才关闭。
- **feature 演进跟踪**（样本 #4）：正文维护里程碑 / 方案文档链接，随阶段推进更新
  进度评论，issue 即该功能的唯一进度源。
- **安全 / 升级公告**（样本 #2）：标题直接给出结论性指引（受影响版本 + 目标版本），
  正文列影响面与升级命令；此类 issue 保持 open 至受影响版本从 registry 视角被
  完全替代。

## 4. 完整闭环样本

[#17](https://github.com/wingsky-1/dsh-plugin-hub/issues/17)（notifier history 测试
竞态 flake）走完了标准全周期：

```text
Bug 表单提报（[bug] 前缀，附日志）
→ 打 bug 标签
→ 定位：多 apply() 实例共享默认持久化路径 + fire-and-forget 写盘时序
→ 修复分支 fix/dsh-notifier-history-flake（隔离文件 + waitForHistory 轮询）
→ PR #20 正文 Fixes #17，纪律沉淀为 DEVELOPMENT.md §5
→ CI 全绿 squash merge → #17 自动关闭
```

## 参考文档

- 贡献规范（Conventional Commits、功能分支 + PR 流程）：[CONTRIBUTING.md](../CONTRIBUTING.md)
- 开发规范（宿主/客户端写法、构建契约、测试防 flake 纪律）：[DEVELOPMENT.md](DEVELOPMENT.md)
- 仓库规则（全局约定、发布纪律）：[AGENTS.md](../AGENTS.md)
- issue 表单模板：[.github/ISSUE_TEMPLATE/](../.github/ISSUE_TEMPLATE/)
