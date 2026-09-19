# skills 总览（11+1）

本仓 skill 共 12 个：`.dsh/skills/` 11 个 + 随包分发 1 个（`packages/dsh-verify-isolated/skills/dsh-verify-isolated/`，浏览器隔离验证，可复用于任意 dsh 插件仓库）。
本文件只做索引与分流，不复述各 SKILL 正文；触发词与否定触发以各 SKILL 头部 `description` / `Do NOT trigger` 为准。

| 你要… | 去哪 | 不去哪 |
|---|---|---|
| 改/加 hub 插件源码（宿主/客户端/CSS/构建） | `dsh-plugin-hub-dev` | 第三方插件、纯文档 |
| 深评整插件（多维 + 落地计划 + 对抗） | `dsh-plugin-review` | 单个 PR diff（用 pr-review）、改代码 |
| 评审单个 hub PR（门禁实证 + 复现 + 两桶分诊） | `dsh-plugin-hub-pr-review` | 整插件深评、改代码 |
| 按功能域重写宿主端 | `dsh-plugin-hub-refactor` | 日常修 bug（用 hub-dev） |
| 写/审测试（改坏试验 + 变异分） | `dsh-plugin-hub-testing` | 改产品代码、只跑门禁 |
| 发版/打 tag/release notes | `dsh-plugin-release` | 日常开发、纯 bump 咨询 |
| 升 dsh rc（影响 + 兼容 + 回滚） | `dsh-upgrade` | 插件代码开发 |
| 单个 issue 精细处理（规格→PR→收敛→合并） | `oss-pipeline` | 外部贡献者 PR、纯咨询 |
| 批量清 zone:auto 队列 | `oss-triage` | 单个精细处理（用 pipeline）、红线 |
| 处理 PR 未读评论转向 | `oss-steering` | issue 初分诊、无关评论 |
| 健康巡检两段式报告 | `oss-report` | 单个 issue 状态、CI 排查 |
| 客户端 UI 浏览器实测（隔离 DSH_HOME） | `dsh-verify-isolated`（随包） | 纯宿主逻辑、纯文档 |

跨仓指针说明：`workflow-common.md` 提及的 `dev（主仓）` / `opensource-contributions（外部发布流程）`不在本仓，等价物见 `CONTRIBUTING.md` + `docs/ISSUE-WORKFLOW.md`。
严重度标尺映射见 `dsh-plugin-review/references/workflow-common.md` §6（P0-P3 vs 严重/中等/轻微唯一映射）。
