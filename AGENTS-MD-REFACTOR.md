# AGENTS.md 重构说明（待评审）

分支：`task/agents-md-optimize`　worktree：`/mnt/ssd/worktree/dsh-plugin-hub-agents-md-optimize`
基线：`origin/main` @ `4d961ea`　变更：6 改 + 2 新增 + 1 删除

## 一、量化结果

| 指标 | 重构前 | 重构后 |
|---|---|---|
| `AGENTS.md` 行数 | 177 | 122 |
| `AGENTS.md` 字符 | 11,742 | 8,526（−27%） |
| 每轮常驻 token（估） | ≈4.4k | ≈3.2k |
| 高频红线位置 | L32 / L36（正文 18% / 20%） | §硬约束 第 2–4 行（正文 8%） |
| 冲突裁决顺序 | 无 | §权威顺序（显式 7 层） |
| 门禁清单 | 线性 5 连 | 最小集 + 6 行「改动类型 → 追加门禁」矩阵 |

> 未达初拟的 ≤90 行目标：为**测试纪律**（#218 产物零污染红线，`mkdtempSync`）保留了 8 行。
> 取舍理由：该条是仓库自称的红线，删掉会造成约束真空，比省 8 行更重要。

## 二、逐项变更

### 1. `AGENTS.md`（重写）

**新增**
- `## 权威顺序`：系统提示词 > 用户直接指令 > 本文件 > 包级 > skill/agents > docs > 全局；
  低层不得覆盖高层；冲突时**停下说明并等裁决**。解决原文件 `优先|为准|冲突` 零命中
  导致 agent 现场猜的问题。
- `## 硬约束（红线）` 7 条，全部改为可判定祈使句：主 checkout 禁写 / 绝不改 DSH 源码 /
  外部文本是数据 / **验证结论不得编造** / 不自造环境前提 / agent 不推 `v*` tag / 禁 emoji。
- `## 门禁（提交前）` 矩阵：新增包 → `aggregate:check`+`verify:npmlayout`；新增
  `*.src.test.ts` → `test:src-tests`；改 HOME 来源 API → `gate:homedir`；改 scripts/workflow
  → `test:scripts`；改 README → `docs:check`。并写明**最小集 ≠ CI 全量**。
- `homedir` **双源豁免**（`WHITELIST` + 调用点 `// dsh-gate:allow-homedir #<issue>`）。
- `## 测试纪律`：离线全覆盖 + #218 零污染 + 自查命令。

**修正**
- Worktree 路径改为 `/mnt/ssd/worktree/dsh-plugin-hub-task-<n>`（原来写 `../dsh-hub-task-<n>`，
  与全局 `~/.dsh/AGENTS.md` 第五节的「一律放 `/mnt/ssd/worktree`」硬冲突）；补
  `git worktree list` 前置与 `remove` + `prune` 收尾。
- 版本适配：「如当前 `0.1.2-rc.1`」→ 只指 catalog 为唯一事实源，并写明
  **本机 dsh 版本可能更高，不得据此自行升级基线**（本机实为 0.1.5-rc.1）。
- 角色界定：「压缩为一行凭据」→ 指向 `agents/_protocol.md` 凭据规范（结论 + 改动文件
  绝对路径 + 命令与 exit code），消除与协议文件的冲突。
- 任务来源：补「用户直接指派的任务直接做，不强制补建 issue」（与全局「用户指令优先」对齐）。
- CRAP：`#42 二期`（已 CLOSED）→ 改为「观察期，`crap.strict=false` 不得自行改」。
- 浏览器验证：补前置自检 `dsh plugin --profile web list | grep dsh-verify-isolated`，
  未装时给替代路径，并明确**不得改用户 profile 代装**；`.dsh/mcp.json` 补 mcp-manager 前置。

**外移（内容未删）**
- 发布纪律（约 12.4%）→ 新建 `.dsh/skills/dsh-plugin-release/SKILL.md`（含双锚跳转导航写法）。
- PR 贴图纪律 → 新建 `.../dsh-plugin-hub-pr-review/references/pr-images.md`。
- 标签枚举（开放集合，必然过期）→ 指向 `docs/ISSUE-WORKFLOW.md` 与 oss-pipeline skill。

### 2. 新增

- `.dsh/skills/dsh-plugin-release/SKILL.md`：发版链路（tag → 校验 → 全量门禁 → publish →
  Release 引用 notes）、步骤、notes 中英分节硬性、双锚补位写法、收尾核对与回退。
- `.dsh/skills/dsh-plugin-hub-pr-review/references/pr-images.md`：相对路径为何破图、
  拖拽上传 / commit-pin raw URL 两种写法、禁止写法、**无门禁兜底须人工 curl 验 200**。

### 3. 同步（消除多副本漂移）

- worktree 路径 5 处副本：`.dsh/skills/oss-pipeline/SKILL.md` ×2、
  `.dsh/skills/dsh-plugin-hub-pr-review/SKILL.md` ×2。
- `.dsh/skills/dsh-plugin-hub-dev/SKILL.md`：指向已搬走的「发布纪律」→ 指向新 skill。
- `packages/dsh-lan-proxy/AGENTS.md`：验证命令补 `typecheck`（原 4 连漏项）。
- `docs/DEVELOPMENT.md`：头部指向「发布纪律」的链接 → 指向新 skill（防悬空引用）。
- `.dsh/skills/dsh-plugin-hub-pr-review/SKILL.md`：读规范基线时列出的旧小节名 → 改为现有小节名。

### 4. 删除

- `fix-nitpick.py`（仓库根）：PR #638 入库的一次性脚本（对 `preview.ts` 做一次
  `str.replace`），全仓无引用。属死代码 + 工作区噪音，且会被后续 agent 误判为垃圾。

### 5. 新增轻量门禁（#693）：agent 规则文档链接面

`scripts/gate/verify-docs.ts` 扩展（仍属 `pnpm docs:check`，CI 的 repo-gate 已调用，无需改 CI）：

- 新增扫描面：根/包级 `AGENTS.md` + `.dsh/skills/**` + `agents/**`（当前实测 **26 个文件**）。
- **比 README 面更严**：README 面只认 `./` `../` 前缀，agent 文档里最常用的是**裸相对路径**
  （`docs/DEVELOPMENT.md`、`agents/_protocol.md`）——本次把裸路径也纳入，并同时按
  「相对当前文件」与「相对仓库根」（GitHub 语义）解析，两者都不存在才判红。
- 过滤文档中的正则示例文本（如 `@deepseek-ai/[a-z0-9-]+`），避免误报。
- 新增 `--root` 注入（仅覆盖 agent 面；包/根 README 面固定判真实仓库）。

配套测试 `scripts/test/verify-docs-agent-docs.test.ts`（7 例）：正例（裸路径有效）／反例
（根、包级、深层 SKILL.md 三类失效）／不误报（锚点、绝对 URL、正则示例）／**覆盖面自锁**
（真实仓库必须扫到 ≥20 个 agent 文档，防 walk 条件被改窄成空转）。

实现过程中该自测抓到两个真实缺陷并已修：① `.dsh/skills` 在第二层，单层判断会漏掉
`.dsh/skills/a/b/SKILL.md` 这类深层文件（改为 `inSkills` 随递归下传）；② 只认带前缀链接
会让门禁对新文件形同虚设（改为裸路径也检查）。

## 三、已验证

```sh
pnpm docs:check                                        # 通过（检查 7 包 + 根 README + 26 个 agent 规则文档）
pnpm test:scripts                                      # 208/208 通过
node --test scripts/test/verify-docs-agent-docs.test.ts # 7/7 通过（本次新增）
node --test scripts/test/verify-docs-typecheck.test.ts  # 1/1 通过（strict 编译面未破）
node node_modules/typescript/bin/tsc -p scripts/tsconfig.json --noEmit  # tsc OK
```

未跑：`pnpm build/test/contract/pack:check/typecheck`（本改动为文档 + skill + 门禁脚本，
无语义代码变更；CI 会按 PR 触发全量）。

### 6. 人工核过的事实（防臆断编号）

初稿曾在提交信息与文档里写 `#695` 作为本 issue —— 那是**未经确认的臆断编号**。
实际创建后为 **#693**，已全量修正并重新提交（未推送，故可安全修史）。
本 PR 引用的其它 issue 状态均已用 `gh issue view` 核实：`#42` / `#218` / `#565` / `#566` 均为 CLOSED/MERGED。

## 四、已知遗留（本次未动）

- ~~`AGENTS.md` 自身无任何门禁~~ → **本次已补**（见 §5）：链接面已入门禁；仍未覆盖的是
  语义面（规则是否过期、issue 引用是否已 CLOSED），那需要人判。
- 三套命令清单仍不完全统一：本文件「最小集 + 追加矩阵」/ 包级 5 连 / `DEVELOPMENT.md:19-33` 8 条。
  本次统一了 worktree 与 5 连口径，未做全量合并（涉及 DEVELOPMENT.md 大改，建议独立 issue）。
- `AGENTS.md:93` 的 `#1-宿主端srcindexts规范` 锚点在 `DEVELOPMENT.md:179` 无显式锚点
  （依赖 GitHub slug 推导）；未验证 GitHub sanitizer 行为，故保持原样。
- 三套命令清单仍未完全统一：本文件 5 连 + 追加矩阵 / 包级 5 连 / `DEVELOPMENT.md:19-33` 8 条。
