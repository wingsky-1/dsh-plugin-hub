# dsh-plugin-review — DSH 插件多 Agent 深度评审

一次调用，让多个独立评审 Agent 并行把插件从代码质量、功能体验、新功能方向、
多端适配、安装影响、安全专项六个默认面（另可选「开源/依赖复核」维）彻底过一遍，
再由协调者交叉验证后输出落地计划，最后对计划做对抗性评审——把「深审一个插件」
从碰运气变成可重复的流程。

## 为什么安装它

人工(或单个 agent)评审插件时，先入为主、只盯自己熟悉的部分、发现漏项是常态。
本 skill 把评审拆成**维度化 + 多独立评审员 + 交叉验证 + 红队对抗**的标准流水线：

- 每个子 Agent 独立读源码、独立下结论，互不污染（同一问题被 ≥2 个 Agent 独立
  指出即高可信）；
- 每条发现强制带「文件:行 + 代码证据」，不认臆测；
- 输出不是「一堆问题」，而是「总报告 + 落地计划 + 修正版计划」三段交付，
  直接可照单整改或派活。

## 你会得到什么

| 文件 | 作用 |
|---|---|
| [`SKILL.md`](SKILL.md) | 端到端执行清单（S0 准备 → S5 对抗评审 → S6 报告沉淀 → S7 实施交接），协调者照跑 |
| [`references/dimensions.md`](references/dimensions.md) | 6 个默认评审维度 + 可选 G（开源/依赖复核）的审查重点与证据要求（写子 Agent prompt 直接复制） |
| [`references/templates.md`](references/templates.md) | 子 Agent prompt 模板、发现条目、总报告、落地计划、评审交付物（REVIEW-AND-PLAN / TECH-DEBT）模板 |
| [`references/adversarial-review.md`](references/adversarial-review.md) | 对抗性评审手册（双视角派发 + 裁决纪律） |
| [`references/workflow-common.md`](references/workflow-common.md) | 跨 skill 共享纪律（阶段 commit / 文档同步 / commit-only / 交接指针 / 实施坑）——唯一事实源，被 review / hub-dev 共同引用 |
| [`references/verify-checklist.md`](references/verify-checklist.md) | 实测证据检核表（curl / 浏览器 MCP / smoke、运行时确认、fixture 约定）——P0/P1 断言必须实测 |

## 快速上手

1. 确认目标插件路径（本仓库 packages/dsh-* 或第三方 dsh 插件）。
2. 说：「对 <插件> 做多 Agent 深度评审（或只要某一维度，如只评多端适配）」。
3. 一次性并行启动各维后台子 Agent（deep 默认 5-7 维各 1 个 / quick 可 1-2 维；SKILL.md S2 给出自包含 prompt 规则）。
4. 全部回报后，协调者交叉验证并输出聚合总报告 + 落地计划 +（可选）对抗评审；重度评审可落成 `REVIEW-AND-PLAN.md` / `TECH-DEBT.md`。
5. 确认后按 S7 交接：变动环节转入 [`dsh-plugin-hub-dev`](../dsh-plugin-hub-dev/SKILL.md) 执行（commit-only / 阶段门禁 / 运行时确认见 [workflow-common.md](references/workflow-common.md)）。

## 何时使用

- 用户要求评审/深评/评估 dsh 插件（无论内外）；
- 要求梳理插件新功能方向、做安装影响分析、把评审结论排成实施计划；
- 要求对已有计划做对抗性评审。

**不适用**：修改/新增插件代码（用 dsh-plugin-hub-dev 开发 skill）。

## 要求

- 只读评审：不修改插件代码；改动需先经用户确认。
- 子 Agent 需要有文件读取权限（评审对象在本地工作空间）。
- 推荐：每维独立子 Agent 数量与维度数一致（deep 默认 6 维 = 6 个后台并行，加可选 G 则 7 个；quick 可 1-2 个）。