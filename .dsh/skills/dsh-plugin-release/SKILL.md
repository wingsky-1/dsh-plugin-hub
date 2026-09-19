---
name: dsh-plugin-release
description: >
  dsh-plugin-hub 的发版执行规程（项目级 skill）：推 tag 触发 release.yml 的完整链路、
  release notes 的中英分节与「双锚补位」跳转导航写法、版本一致性校验与回退。
  触发信号：用户要求发版/发布/打 tag、写或更新 docs/release-notes/vX.Y.Z.md、
  修订 release notes 的语言导航锚点、排查 release.yml 失败。
  Do NOT trigger for: 日常功能开发（用 dsh-plugin-hub-dev）、PR 评审（用 dsh-plugin-hub-pr-review）、
  纯版本号 bump 咨询。
---

# dsh-plugin-release — 发版执行规程

> 红线：**`v*` tag 只由维护者推送**，agent 不得推送 tag、不得为绕过校验而改包版本号。
> 发布产物与 GitHub Release 由 tag 触发，不可逆——推送前逐项核对本规程。

## 0. 发版链路

`.github/workflows/release.yml`：推 `vX.Y.Z` tag → ① 校验**全包**版本 == tag
（`scripts/release/verify-version.ts`）→ ② 全量门禁 → ③ `pnpm publish` →
④ 创建 GitHub Release（**优先引用 `docs/release-notes/vX.Y.Z.md`**，缺失则回退 GitHub 自动 notes）。

因此 release notes 必须在打 tag 前入库；版本号由发版提交统一 bump，**不要**在日常 PR 里
顺手改版本号绕过 tag 校验。

## 1. 发版步骤（维护者执行，agent 只做 1–3）

1. 全量门禁绿：`pnpm gate:pr`（全仓口径）+ `pnpm aggregate:check && pnpm verify:npmlayout`（发版涉及全部包）。
   > 旧写法 `pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck` 自审计 P0-1 起已更弱
   > （目录门面 / 导出面快照 / 跨包扇入三闸不再由 `pnpm contract` 执行）。
   > 该清单属根 [AGENTS.md 门禁矩阵](../../../AGENTS.md) 的**收尾（发版）档**（全仓口径）；
   > 完整收尾口径以该矩阵为准，本清单只作发版前逐项核对。
2. bump 全部包版本到目标 `vX.Y.Z`（含 peer 与 catalog 的锁步检查）。
   同笔处理 upgrade 链（`packages/<pkg>/src/server/upgrade/` 存在的包才有）：
   - 每个包在步骤表（`impl/steps/index.ts`）追加一步 `{ fromVersion: "旧版", targetVersion: "新版" }`——
     无形态变化也加空实现：链以步骤为刻度，漏版本会让存储刻度永久停旧值（`reportGap` 只 warn 不拦门）；
   - 步骤表按目标版本升序；最高目标版本必须等于新包版本，否则发版即落后；
   - mcp-manager 例外：home 级走版本化链，项目级（多 root）走 just-in-time 落定，不进步骤表；
     项目级形态割接看各文件自带的 `version` 字段，读时按文件版本逐档迁移；
   - 每新增一步配一条回归用例（种子旧刻度 → 断言新刻度 + 数据不动）。
3. 写 `docs/release-notes/vX.Y.Z.md`（见 §2–§3），随 `chore(release): vX.Y.Z` 提交。
4. 维护者推 tag：`git tag vX.Y.Z && git push origin vX.Y.Z`；随后核对 Release 页渲染。

## 2. release notes 结构（硬性）

- **每版入库**为 `docs/release-notes/vX.Y.Z.md`（入库起点 v0.1.8；v0.1.3–v0.1.7 为历史遗留，
  不再补录）。
- 内容来源：上一 tag 至今的**常规提交**（不含发版提交自身）。
- **中英各自成节分开呈现**，不逐条混排；**禁止 emoji**。

## 3. 语言跳转导航：双锚补位写法（已实测，勿"简化"）

各渲染器标题 slug 规则不一，中文锚点不可靠；且 GitHub sanitizer 会把 HTML `id`/`name`
一律改写为 `user-content-` 前缀，致 `href="#zh"` 落空，而 Release 页 heading 又无自动 id。
所以：**href 直写前缀形态，分节处双锚补位**——GitHub 命中被改写的首个锚，第三方渲染器
命中字面 id 的第二个锚，全场景可跳。

头部：

```markdown
> **[中文](#user-content-zh)** · **[English](#user-content-en)**
```

分节前（中英各一处）：

```html
<a id="zh"></a><a id="user-content-zh"></a>
<a id="en"></a><a id="user-content-en"></a>
```

样板见 `docs/release-notes/` 下任一近期版本（须双锚齐备；勿写死“最新一版”版本号，随发版腐烂；判据示例：`grep -l 'user-content-zh' docs/release-notes/v*.md | sort -V | tail -1`）。

## 4. 收尾核对

- `docs/release-notes/vX.Y.Z.md` 的相对链接与 `pnpm docs:check` 通过。
- Release 页两处跳转都实测可点（GitHub 页 + 本地/第三方预览各一次）。
- 版本适配声明（根 README「版本适配（只适配 rc）」）若本次调整了适配基线，同步更新；
  基线唯一事实源是 `pnpm-workspace.yaml` catalog。
- 失败回退：Release 未生成时不要重推同 tag，先查 release.yml 日志；已发布的 npm 版本
  不可撤回，用 `scripts/release/publish-if-missing.ts` 的幂等语义重新执行管线。
