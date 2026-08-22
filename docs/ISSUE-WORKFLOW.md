# ISSUE-WORKFLOW — issue 处理流程

> 覆盖本仓库 issue 的**提交 → 分诊 → 修复 → 关闭**全生命周期约定，供贡献者与
> 维护者参照。模板见 [.github/ISSUE_TEMPLATE/](../.github/ISSUE_TEMPLATE/)；
> 提交规范与开发流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)；写码规范见
> [DEVELOPMENT.md](DEVELOPMENT.md)；仓库级硬性规则见根 [AGENTS.md](../AGENTS.md)。

## 0. 提交 issue 之前

1. **先升级再报告**：很多缺陷在最新版已修。请先
   `dsh plugin --profile web update @wingsky-1/<插件>` 升到 latest 再确认问题仍在。
2. **搜索既有 issue**：同问题不重复开，在原 issue 下补充信息即可。
3. **选对模板**：
   - 缺陷（崩溃 / 功能异常 / 平台兼容）→ **Bug 报告** 表单（`[bug]` 前缀）
   - 新功能 / 改进建议 → **功能建议** 表单（`[feature]` 前缀）
4. **填全必填项**：插件版本号最关键（`dsh plugin --profile web list` 可查），报错贴
   全文不要截片段。

## 1. 分类与标题惯例

| 类型 | 标题形态 | 标签 |
|---|---|---|
| 缺陷 | `fix(<scope>): <问题描述>` | `bug` |
| 功能 / 演进 | `[feature] [<scope>] <主题>` | `enhancement` |
| 长期跟踪（meta） | `<主题>（Meta）` 或「配套：…」 | `enhancement` |
| 安全 / 升级公告 | `<影响面描述>，请升级到 x.y.z` | `bug` |

- scope 用包名短横线形（`dsh-notifier`）；跨包 / 仓库级用 `meta`。
- 一个 issue 只装一件事；多子项的长期目标拆成 Meta + 子 issue（见 §3）。
- `[bug]` / `[feature]` 是表单预填的标题前缀；分诊时由维护者按上表规范化为
  最终标题形态（如缺陷类改为 `fix(<scope>): …`）。

## 2. 处理流水线（维护者）

```text
提报 → 分诊(triage) → 定位 → 修复分支 → 验证证据 → PR(关联 issue) → CI 全绿 squash merge → 自动关闭
```

1. **分诊**：确认复现信息完整（缺则向报告者追问）；打 `bug` / `enhancement` 标签；
   判断是否 Meta 子项，需要则挂到父 issue 并在父项清单登记。
2. **定位**：宿主端问题看 `src/index.ts` 与 dsh web 日志（`<插件>:` 前缀行）；
   客户端问题按 DEVELOPMENT.md §2 的干净模块契约排查；CI flake 类修复**必读**
   [DEVELOPMENT.md §5](DEVELOPMENT.md#5-smoke-测试防-flake-纪律)（隔离文件路径 /
   设 `DSH_HOME` / 轮询替代固定 sleep）。
3. **修复分支**：命名 `fix/<主题>` 或 `feat/<主题>`（与 CONTRIBUTING.md 开发流程一致）。
4. **验证证据**（涉及界面行为的改动——overlay / URL 重写 / Modal 内跳转 / 双主题 /
   窄屏等）：在隔离环境实测后截图归档至
   `packages/dsh-<name>/docs/archive/<issue号>-<行为描述>.png`（如
   `37-basename-fallback-overlay.png`）；截图只截插件 UI 本身（headless element
   screenshot），不带浏览器整窗，避免泄露本机环境。归档后双向引用：PR 正文贴图并
   引用文件路径，issue 评论回链 PR。发布边界已核实安全：各包 files 白名单不含
   `docs/`，截图不入 tarball，不破坏「发布物不含内部文档」约定。纯宿主端 /
   文档改动可跳过本步。
5. **PR 关联 issue**（二选一，推荐前者）：
   - PR 正文写 `Fixes #<编号>` —— merge 后 GitHub 自动关闭 issue；
   - 或 commit message 引用 `(#<编号>)`，merge 后 issue 上会留下 referenced 记录，
     手动关闭。
6. **收敛与冲突处理**：先查合并状态再看 CI——`gh pr view --json mergeStateStatus`：
   - `CLEAN` → 等 CI 全绿即可；
   - checks 未触发/缺失 → 先确认 mergeState 不是 `BLOCKED(CONFLICTING)`，再考虑等待
     或手动 dispatch（最多一次）；
   - `CONFLICTING` / `DIRTY` → 立即转冲突处理，不要在 CI 上空转：
     ① `git fetch && git rebase origin/main`；② 解决冲突（保留双方语义，不丢任一方改动）；
     ③ 本地重跑全量门禁；④ `git push --force-with-lease` 回推 PR。
     冲突多源于并行合入的 docs/skill 改动，属正常演进代价，一次 rebase 消化。
7. **合并即收尾**：CI 全绿后 squash merge（远端分支自动删除）；issue 若未自动关闭
   则手动关闭并在评论里给出「修复版本号」（发布后回填）。

## 3. 特殊类型

- **Meta 长期跟踪**：多子项的长期目标拆成一个父 issue + 多个子 issue；父 issue
  维护子项清单，每完成一个子项在父项勾销并链接对应 PR，全部子项完成后才关闭。
- **feature 演进跟踪**：正文维护里程碑 / 方案文档链接，随阶段推进更新进度评论，
  issue 即该功能的唯一进度源。
- **安全 / 升级公告**：标题直接给出结论性指引（受影响版本 + 目标版本），正文列
  影响面与升级命令；此类 issue 保持 open 至受影响版本从 registry 视角被完全替代。

## 参考文档

- 贡献规范（Conventional Commits、功能分支 + PR 流程）：[CONTRIBUTING.md](../CONTRIBUTING.md)
- 开发规范（宿主/客户端写法、构建契约、测试防 flake 纪律）：[DEVELOPMENT.md](DEVELOPMENT.md)
- 仓库规则（全局约定、发布纪律）：[AGENTS.md](../AGENTS.md)
- issue 表单模板：[.github/ISSUE_TEMPLATE/](../.github/ISSUE_TEMPLATE/)
