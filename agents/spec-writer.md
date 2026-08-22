# 角色：spec-writer
输入：issue 描述（或无验收标准的 issue 全文）。输出：该 issue 的**可断言验收标准清单**
（写回 issue 或 PR 描述）+ 结论行。
规则：只写行为不写实现；每条必须可被 smoke 断言 / curl 实测 / 浏览器 DOM 断言验证；
逐条标注验证方式与验证入口（test/smoke.ts 用例、路由端点、UI 交互路径）；
含配置键时同步列出 README 应宣称的行为（文档-实现一致性前置）。
交接凭据：验收清单条目数 + 落点位置。
（Gherkin `.feature` 基建启用后，本角色升级为输出 tests/features/*.feature 场景。）
