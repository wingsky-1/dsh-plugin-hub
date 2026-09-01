---
name: dsh-upgrade
description: >
  评估 dsh 自身（CLI/运行时）升级的**影响**并产出**分阶段升级计划与落地命令**，覆盖四件事：
  (1) 当前版本与目标 rc 的差异与破坏性评估；(2) 已装/link/github-pin 插件的可升级性；
  (3) 升级 dsh 对 link 插件的运行时兼容性；(4) 用 `dsh plugin` 命令落地的升级、冒烟与回滚流程。
  触发信号：用户提到升级 dsh / 升 rc / dsh rc.N、评估升级影响、哪些插件能升级、升级对 link 插件的影响、
  dsh 升级计划/回滚/兼容性。
  Do NOT trigger for: 插件代码开发（用 dsh-plugin-hub-dev）、插件评审
  （用 dsh-plugin-review）、纯本地 git 操作。
  本 skill 是「影响分析 + 升级计划 + 落地命令」的方法论固化；纯分析不改任何配置，所有 profile 改动
  走 `dsh plugin` 命令（转发 pnpm），由用户自行执行。
---

# dsh-upgrade — dsh 自身升级的影响分析与落地方法论

把一次「评估 dsh rc 升级影响 + 插件可升级性 + link 插件兼容性 + 产出分阶段升级计划与落地命令」的完整流程固化。本 skill 是**只读分析 + 计划产出**：不手动改任何 profile 配置；所有落地改动通过 `dsh plugin` 命令（转发 pnpm）由用户执行，Agent 只给命令与判断。

## 0. 流程总览

```
S0 基线：当前版本 + 目标 rc 发现
 → S1 升级影响：rc 差异 / 破坏性 / 编译 lib 契约比对
 → S2 插件可升级性：link / 版本化 / github-pin 三类
 → S3 link 插件兼容：消费面映射 + 逐包 lib diff
 → S4 升级计划：分阶段目标 + dsh plugin 命令 + 回滚
 → S5 落地约定：红线与执行边界
```

用户只要其中一段（如「升级对 link 插件有啥影响」）时，直接从对应 S 段切入即可，不必重跑全段。

## S0 基线与目标发现（亲做，不委托）

1. **当前版本**：`dsh --version`；读 `~/.local/node/lib/node_modules/@deepseek-ai/dsh/package.json` 的 `version` 与 `dependencies`（重点 `@deepseek-ai/dsh-*` 与 cordis / schemastery / react）。
2. **目标 rc 发现**：`npm view @deepseek-ai/dsh versions --json` + `dist-tags`；注意 `latest` 可能滞后，升级常需**显式 pin** 目标 rc（如 `0.1.2-alpha.3`）。
3. **目标 rc 依赖清单**：`npm view @deepseek-ai/dsh@<target> dependencies --json` —— 记录所有 `@deepseek-ai/dsh-*` 是否从当前 rc 升到目标 rc（通常全量升），以及 cordis / cordis-plugin-* / schemastery / react 是否变动。
4. **profile 插件清单**：读 `$DSH_HOME/profiles/<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles`，区分三类：
   - **link 插件**：值为 `link:/abs/path/...`（符号链接，指向 `github/dsh-plugin-hub/packages/*`）。
   - **版本化插件**：`@scope/name@x.y.z` 或 `^x.y.z`（来自 npm）。
   - **github-pin 插件**：`github:owner/repo#tag`（非 npm，pnpm 直接 clone）。
5. **读红线**：本工作树 AGENTS.md 的「禁止 kill/重启 dsh web」「命令优先用 workdir」「方案先于实现」。

> 完整命令见 [references/upgrade-cookbook.md](references/upgrade-cookbook.md)（版本发现 / lib diff / git tag diff / github-pin 调查 / 备份与回滚）。

## S1 升级影响分析（dsh 自身）

**目标**：判断 rc 升级对宿主/插件运行时契约的破坏性。

1. **release 范围**：若本地有 `deepseek-harness` clone，先 `git fetch --tags origin` 取目标 tag（形如 `dsh-v0.1.0-rc.8`），再 `git diff --stat <rc.old> <rc.new>` 看文件/行数规模，区分「验证工具链 / 前端」与「运行时契约」改动。无 clone 时以 npm tarball 的 lib diff 为准（S1.2）。
2. **运行时契约（权威信号 = 编译产物 diff）**：对宿主/插件实际消费的每个 `@deepseek-ai/dsh-*` 包：
   - 已装：`~/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib`
   - 目标：`npm pack @deepseek-ai/<pkg>@<target>` 解包后 `lib/`
   - `diff -rq <installed>/lib <target>/lib` —— **完全一致=安全；仅追加导出/注释=安全；导出面删除/签名破坏=破坏性**。
3. **框架稳定性**：比对 cordis（`^4.0.1`）、schemastery、react（`^18.2.0`）在 rc.old/rc.new 的版本——版本未变即插件框架 API 稳定。
4. **破坏性说明**：查 commit 信息 / changelog 是否含 `breaking` / `migration`；rc 线内通常无显式破坏说明。
5. **结论分级**：运行时契约零破坏 → 升级低风险；有导出面删除 → 需对应插件同步发版。

> 关键认知：版本号全量升 rc **不等于**破坏性；**编译 lib 比对**才是兼容性的权威证据。不要只靠版本号下结论。

## S2 插件可升级性评估（三类）

| 类型 | 判定法 | 升级手段（用户执行） |
|---|---|---|
| **link 插件** | `<path>` 仓库 `git describe --tags` 看相对最新 tag 位置；`git log <tag>..HEAD` 是否超发；`npm view <pkg> dist-tags` 确认最新 tag | 通常已是最新 tag；仅当上游有新 commit 时 `git pull`（lib 已提交，无需重建） |
| **版本化插件** | `npm view <pkg> version dist-tags` 对比已装版本 | `dsh plugin --profile <p> add <pkg>@<latest>` |
| **github-pin 插件** | 从 `github:owner/repo#tag` 解析真实仓库；`gh api repos/owner/repo/tags` + `/releases` 看是否有更新 tag；`gh repo view` 看是否 fork（parent）与 peerDependencies 是否满足目标 rc | `dsh plugin --profile <p> add <pkg>@github:owner/repo#<newtag>` |

- **github-pin 特别处理**：`@dsh-external/xxx` 只是 pnpm 给 `github:` 依赖的命名空间别名，**不是 npm 包**；真实仓库要用 `gh` 查 tags / releases / peerDependencies。注意是否存在 fork（如 `wingsky-1/*` fork 自 `mexiaosqwq/*`），pin 时确认走上游还是 fork。
- **peerDependencies 校验**：github-pin 插件常声明 `@deepseek-ai/dsh-client-*@^0.1.0-rc.6` 之类；semver caret + prerelease 下 `^0.1.0-rc.6` **包含** rc.8（同 base 0.1.0），故目标 rc 满足。
- **输出**：一张表列出每个插件「当前 / 最新 / 可否升级 / 手段 / 影响」。

## S3 link 插件兼容性（核心关切）

**目标**：确认升级 dsh 不破坏 link 插件的运行时。

1. **消费面映射**：对全部 link 插件，grep 其 `src/`+`shared/`+`client/` 的 `from "@deepseek-ai/..."` / `import("@deepseek-ai/...")` 与 package.json 的 `dsh.client.inject` 数组，得到插件实际依赖的 dsh 包**全集**。
2. **逐包 lib diff**（同 S1 方法）：`dsh-settings` / `dsh-tools` 常字节一致；`dsh-client-runtime` / `connection` / `ui-slots` 多为仅追加/内部改动且**导出面保留**；cordis / schemastery / react 版本未变。
3. **inject 契约**：插件 `inject` 的包在目标 rc 仍存在且导出面不变 → 宿主注入机制兼容。
4. **结论**：运行时 API 零兼容性问题 = 可随 dsh 升目标 rc。
5. **唯一残留风险 = UI 渲染**：rc 若重写 web 前端（+数万行），插件 UI 挂在 shell 上（`cordis.patch.yml` 挂载 + client inject 进 dsh 客户端 slot + `--dsw-alias-*` 主题变量），DOM / 挂载点 / 主题变量结构性变化会导致渲染异常——**只能升级后浏览器实测**（见 S4 冒烟）。

> 认知：link 插件是独立工作树符号链接，升级 dsh **不改它们**；它们只是跑在新 dsh 运行时上。预构建 `lib/` 按旧 rc 编译，只要运行时契约不变即兼容。

## S4 升级计划与命令（分阶段，全交用户执行）

每阶段给「目标 + 命令」，模板见 [references/upgrade-cookbook.md](references/upgrade-cookbook.md)。

- **Phase 0 备份**：`cp package.json` / `settings.yaml` / `pnpm-lock.yaml` 到 `.bak-rcN`。
- **Phase 1 升 dsh CLI**：`npm i -g @deepseek-ai/dsh@<target>`（显式 pin）；`dsh --version` 验证。*只换磁盘文件，运行的 web 进程仍旧代码。*
- **Phase 2 对齐 profile + 改 pin**：`dsh plugin --profile web add <pkg>@<newspec>`（pin 变更，dsh plugin 改 package.json + 重装）；`dsh plugin --profile web install`；`dsh plugin --profile web list` 审阅。
- **Phase 3 重启 dsh web（⚠️ 用户本人执行）**：红线——Agent 不得 kill/重启 dsh web。
- **Phase 4 冒烟**：`dsh plugin --profile web list` + 浏览器 Console 无 client-runtime / connection 加载错误 + 各插件加载 + **窄屏（iPad / iOS）实测**移动端插件。
- **Phase 5 升版本化插件**：`dsh plugin --profile web add <pkg>@<latest>`（dsh 稳定后）。
- **回滚**：`npm i -g @deepseek-ai/dsh@<prev>` + 恢复备份 + `dsh plugin --profile web install` + 用户重启。

## S5 落地执行约定（红线）

- **绝不 kill/重启 dsh web**：无论原因，重启只能用户亲自做（会断连局域网 Windows / iPad / iOS 访问）。
- **不手动改配置**：profile 的 package.json / pin 改动一律走 `dsh plugin` 命令（转发 pnpm），不手编。
- **命令用 workdir**：bash 工具用 `workdir` 参数指定目录，禁止 `cd &&`。
- **方案先于实现**：结构性 / 多步升级先给计划（S0–S4）让用户确认，再落地。
- **证据落盘**：版本发现、lib diff、github-pin 调查结论写入计划文档，便于用户审核与自行执行。
