# 下会话 prompt：dsh-provider-usage 分层架构重构讨论（交接物）

> 使用：把下面「交接 prompt」整段贴给新会话（或让新 agent 读取本文档 + 归档），
> 从**讨论方案**开始，未经确认不写代码。

---

## 交接 prompt

```
背景：上一会话完成了 dsh-provider-usage（packages/dsh-provider-usage/）两大功能域的
分层职责与上下游接口契约梳理，并经独立对抗评审（62 分）修订。全部成果已归档在
worktree 分支 task/usage-layer-arch（commit b86f159），主 checkout 干净未动。

本会话目标：**讨论并敲定「如何从现状架构重构为目标架构」的实施方案**，输出：
1) 每层职责与上下游契约的最终裁定（作为实施契约基线）；
2) 分阶段重构方案（含每阶段改动面、依赖、验证方式、门禁）；
3) 决策表 D1-D8 全部拍板。只讨论不改代码。

必读归档（worktree：/home/tangyi/dev/learn/dsh-plugin/github/dsh-hub-task-usage-layer）：
- packages/dsh-provider-usage/docs/layer-architecture.md —— 分层模型 + 接口契约（修订 R1-R5）
  + 隐藏共享 + 决策表。这是本会话的主输入。
- packages/dsh-provider-usage/docs/diagrams/usage-current-architecture.html —— 现状分层图
- packages/dsh-provider-usage/docs/diagrams/usage-target-architecture.html —— 目标架构图
  （含外部边界：浏览器客户端 / 用户自定义适配器 / 远端 API / dsh 宿主运行时）
- packages/dsh-provider-usage/docs/diagrams/*.json —— archify 规格快照（可改后重渲染）

讨论议程（每项结论进决策表，注明证据文件:行号）：
1. 【契约基线裁定】逐层确认 layer-architecture.md §2 的上下游契约是否作为实施基线；
   重点裁定评审遗留项：R4 StatsService 是否补「面板缓存 get/set/全清」方法以消除路由穿透
   （D7）？R9 executor 是否收敛 E4（D8）？C1 是否拆纯工具散层（R6）？
2. 【目标架构落地路径】从现状到目标，哪些是「代码重构」（需 TDD + 门禁）、哪些是
   「文档/建模修正」（R1-R3/R5 大部分是表述修正，只改文档）？分别列清单。
3. 【重构范围裁定】用户点名两大域分层——是否以「消除路由层直连服务对象内部
   （cache/panelCache/registry）」为首个重构切片？还是先做低风险文档/契约收敛？
   逐项给 S/M/L 工时与依赖。
4. 【外部边界契约】浏览器客户端/自定义适配器/远端 API/dsh 宿主 4 外部角色与宿主的
   接口契约是否需要在代码层固化（如客户端消费字段类型、适配器 v2 契约已固化）？
5. 【演进护栏】aggregator 四不变量（身份快照/防双计/聚合权威/残差归未识别）是否
   本轮固化为文档化断言？变异盲区 22 文件（trend/report/routes 零变异覆盖）是否
   纳入本轮门禁补强？

红线提醒：只在 worktree 内改代码/跑门禁；本会话只讨论不实施；全中文；方案经用户
认可后才动代码（方案优先于实现）。
```

---

## 供新会话参考的快速事实（免重读）

- 主 checkout：/home/tangyi/dev/learn/dsh-plugin/github/dsh-plugin-hub（main，勿改）
- 归档 worktree：/home/tangyi/dev/learn/dsh-plugin/github/dsh-hub-task-usage-layer（分支 task/usage-layer-arch）
- 包内关键行号锚点：见 layer-architecture.md 各契约表
- 架构图重渲染：archify skill（node bin/archify.mjs validate/deliver …）
- 门禁：pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck
