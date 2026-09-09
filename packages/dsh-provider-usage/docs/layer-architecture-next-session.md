# 下会话 prompt：dsh-provider-usage 分层重构实施（交接物 v2）

> 使用：把下面「交接 prompt」整段贴给新会话（或让新 agent 读取本文档 + 归档），
> 从**实施阶段零**开始；实施纪律：worktree 内改代码/跑门禁、方案已获用户认可、阶段 PR 关联跟踪 issue。

---

## 交接 prompt

```
背景：dsh-provider-usage（packages/dsh-provider-usage/）分层重构方案已定稿：
- 契约基线 v4：docs/layer-architecture.md（决策表 D1-D16 全部拍板，契约表符号锚化）
- 实施方案唯一事实源：docs/refactor-implementation-plan.md（阶段零→收尾、目录树、文件映射表）
- 归档分支：task/usage-layer-arch（commit 4a729d4 + e64f859 + 审定稿归档提交）
- 跟踪 issue：#670

本会话目标：**按 refactor-implementation-plan.md 从阶段零开始实施**。
阶段序列：零（变异网前置）→ 一（D7 面板缓存整体下沉）→ 二（D8 executor + 报告面收敛）
→ 三（R8 断言 + aggregator 拆分）→ 四（目录化）→ 收尾（死面清理）。每阶段独立 PR 关联跟踪 issue。

硬性纪律：
- 只在 worktree（/home/tangyi/dev/learn/dsh-plugin/github/dsh-hub-task-usage-layer）内改代码/跑门禁；主 checkout 不动
- 门禁：pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck + smoke
- 变异实现：阶段零先改 scripts/data/mutation-topology.json（补 testFiles：unit-trend/unit-report/unit-trend-view）+ 增段，
  再 node scripts/gate/gen-stryker-conf.mjs 生成 + --check（唯一事实源为 mutation-topology.json）
- D7 关键点：getPanelResult 整体下沉四段语义 + generation 失效（防在途旧结果污染）+ per-key 单飞；
  smoke 面板缓存专项（S1 扩展）为验收门；死面清理不在本阶段
- 注释只写 why；设计决策进提交信息（Suggested Commit Message 三部分）
- 主 checkout 禁改：/home/tangyi/dev/learn/dsh-plugin/github/dsh-plugin-hub
```

---

## 供新会话参考的快速事实（免重读）

- 主 checkout：/home/tangyi/dev/learn/dsh-plugin/github/dsh-plugin-hub（main，勿改）
- 归档 worktree：/home/tangyi/dev/learn/dsh-plugin/github/dsh-hub-task-usage-layer（分支 task/usage-layer-arch）
- 方案唯一事实源：packages/dsh-provider-usage/docs/refactor-implementation-plan.md（含 §2.1 测试分层 D17）
- 契约基线：packages/dsh-provider-usage/docs/layer-architecture.md（§2 符号锚契约表 + §4 决策表 D1-D17）
- **测试分层（D17）**：L1 层内单元（test/unit 镜像源码目录）+ L2 interface 契约（每目录 interface.test.ts，
  层间稳定性）+ L3 user-case 集成（test/integration/uc-1..6，全链路）+ L4 变异按层分段（per-layer testFiles，
  threshold 60）；每阶段 = 源码 + L1/L2 + L3 关联 UC + L4 段更新，缺一不可入 PR
- 变异拓扑唯一事实源：scripts/data/mutation-topology.json（provider-usage 段 testFiles 现缺
  unit-trend/unit-report/unit-trend-view——阶段零第一刀）
- 架构图重渲染：archify skill（node <archify-bin>/bin/archify.mjs validate/deliver/visual-check）
- 门禁：pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck
