# Agent Note: 配置与契约文档以代码为单一事实源

Status: implemented

## Problem

插件配置默认值与 wire 契约存在双源：README 示例 vs 代码模型（如 notifier 的 `DEFAULT_CONFIG`、sidebar 的 `bindings.json` 结构）。行号引用随重构腐烂，转发语义在 lan-proxy 与 notifier 两边各说一遍，迟早矛盾。

## Decision

代码模型是唯一事实源，README 附录只是镜像：每节标注来源符号（模块名、类型名、键名），弱化行号；转发语义只在 lan-proxy README 写全，notifier 侧只引用不复述；契约只暴露最小面（如 sidebar `BindingResponse` 不回 `repoRoot`）。

实例：notifier 配置附录见 [notifier README](../../../../packages/dsh-notifier/README.md)，sidebar 契约节见 [sidebar README](../../../../packages/dsh-worktree-sidebar/README.md)。

结构约定见[三插件 README 统一结构](./2026-09-18-unified-plugin-readme-structure.md)。

## Alternatives considered

- 文档为主、代码跟随文档改：违背“代码即行为”现实， reviewers 无法以文档判代码对错，被否。
- 建双向同步工具链（由代码生成文档表）：无现成链路，为三个附录造生成器属过度设计，被否；若附录超过五个再议。

## Consequences

- 收益：改默认值只需改代码 + 镜像附录，评审有明确核对点（符号名）。
- 代价：附录与代码的同步靠人工 + 评审抽查兜底，无机械门禁；行号引用残留会继续漂，见到即改为符号引用。
