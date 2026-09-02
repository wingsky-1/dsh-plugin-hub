# Agent Team 业界案例研究

> 目的：为通用框架（[10](10-generic-model.md)/[11](11-generic-runtime.md)/[12](12-generic-console.md)）提供对照系——每个案例提炼机制要点与可借鉴点，标注已被 v2 吸收 / 候选待议。
> 讨论记录见 [DISCUSSION.md](DISCUSSION.md)。

## 案例总览

| 案例 | 拓扑 | 协调载体 | 层级 | 与本框架关系 |
|---|---|---|---|---|
| Claude Code Agent Teams | lead + teammates 扁平 | 共享任务列表 + 信箱 | 1 级+成员 | 同构参照 |
| omo team-mode | lead + members 扁平 | 12 个 team_* 工具 + 邮箱文件 | 1 级（明确禁嵌套） | 工具化形态主要来源 |
| AutoGen Magentic-One | Orchestrator + 执行组 | Task Ledger（事实账+进度账） | 1 级编排 | 熔断/停滞检测借鉴 |
| AutoGen GroupChat | 自由群聊轮转 | manager 选下一发言者 | 扁平 | **反面教材** |
| CrewAI hierarchical | manager + crew | task 分派 + role/goal/backstory | 1~2 级 | Role Spec 先例 |
| MetaGPT | SOP 流水线 | 结构化中间产物（PRD/设计文档） | 固定流水线 | brief/凭据结构化先例 |
| ChatDev | chat chain 双人阶段对话 | inception prompting | 链式 | HANDOFF 另一形态 |
| OpenAI Agents SDK | handoff 控制权转移 | handoff 原语 | 链式 | 与 HANDOFF 对照 |
| Anthropic 多 agent 研究系统 | orchestrator-worker | subtask 描述 + 引文核查 | 2 级 | 派单简报纪律、成本教训 |
| claude-squad | 进程级多实例 | tmux 会话 + worktree 绑定 | 无（管理面） | 形态 B 执行器参照 |
| Devin / Jules / Copilot agent | 单 agent + plan | session plan + timeline | 单体 | web 视图与单入口先例 |

## 分案例笔记

### 1. Claude Code Agent Teams
- lead 可派生 teammates；共享任务列表是事实源，teammate 空闲即被派活；信箱支持 teammate 间直接消息。
- 启示：任务列表承担"谁该干什么"的记忆，对话只承载协调——印证黑板优先于聊天。已被 v2 吸收（任务账本）。

### 2. omo team-mode（已深入分析）
- 12 个 `team_*` 工具承载全部协议；邮箱每消息原子文件（delivering/processed/TTL 收割）；边界全部内建配置（成员数/并行/wall clock/turns）；NOT-do 清单明确（无嵌套、无同步等待、fire-and-forget）。
- 已吸收：工具化形态、邮箱三态、资源内建、fire-and-forget 原则。
- 它没有的：多级主控（明确禁嵌套）——本框架差异点，代价是守夜人跨层唤醒。

### 3. AutoGen Magentic-One — 【候选待议 ★】
- Orchestrator 维护 **Task Ledger**：facts ledger（已确立事实）+ progress ledger（每步更新：是否完成、是否循环、stall 计数）；停滞超阈值触发 replan 甚至失败退出。
- ★ 候选借鉴：`stall counter` 进熔断设计——比我们"计圈 rounds"更细：连续 N 次 handoff 无实质进展（凭据重复/状态未迁移）即降速或转 blocked。v2 的 `task_max_rounds` 是粗粒度版，可加 `max_stalls` 字段。

### 4. AutoGen GroupChat — 反面教材
- 轮转发言 + manager 选择下一者：token 随人数平方增长、话题发散、难测试。
- 本框架从第一版就排除群聊（HANDOFF 星形），此案例作为决策依据存档。

### 5. CrewAI hierarchical
- process=hierarchical 时由 manager agent 动态分派；角色三元组 role/goal/backstory。
- 启示：role/goal ≈ 我们的 prompt 职责段 + DoD。已被吸收（Role Spec）。其"backstory"（人格背景）我们刻意不要——对工程任务是 token 噪音。

### 6. MetaGPT — 【候选待议 ★】
- SOP 编码进流水线：PM→架构师→工程师→QA，角色间接口是**标准化文档**而非自由文本。
- ★ 候选借鉴：把"brief 格式模板"做成 Role Spec 一等字段（`briefing: structured` 已有雏形），进一步规定必填小节，让下游角色的解析稳定。风险：过度结构化伤灵活性——仅对 coder/qa 等强接口角色启用。

### 7. ChatDev
- chat chain：每阶段固定双 agent 对话，inception prompting 给出"何时停止"判据。
- 启示：阶段化双人对话 = HANDOFF 的对话化变体。我们不采纳实时对话（发散风险），但其"停止判据前置声明"值得并入 dod。

### 8. OpenAI Agents SDK handoffs
- handoff = 控制权 + 上下文整体转移给下一个 agent，接收方成为新的当前执行者。
- 对照：我们的 HANDOFF 是"回报主控再派发"（星形），不是控制权直移。差异原因：我们需要审计锚点与 Gate 卡点都在主控视角内。结论：维持现状，但 handoff 原语提示了简化空间——若未来某模板不需要全程审计，可开放 explicit 模式下的链式移交（v2+ 议题，暂不做）。

### 9. Anthropic 多 agent 研究系统（orchestrator-worker 实证）
- 要点：lead 把任务拆给并行 worker 时必须**显式传递完整上下文**（worker 看不到 lead 的推理过程）；按任务复杂度分 effort 等级；token 消耗约为单 agent 对话的 15 倍；并行 tool call 提效。
- 已吸收：自包含简报原则（briefing）。
- ★ 候选借鉴：effort 分级——Tier-0 派单时给任务标 heavy/light，heavy 才允许开满职责链，light 走精简路径（省 token）。可作为 Role/tier 的可选字段 `effort_hint`。

### 10. claude-squad
- tmux 多实例管理 + 每 agent 绑定独立 worktree/分支，attach/detach 观察会话。
- 参照价值：形态 B（headless 多进程执行器）落地时的管理面长这样——实例表、attach 调试、worktree 生命周期。v1 不需要，留作 11 文档形态 B 的实现参考。

### 11. Devin / Jules / Copilot coding agent
- session plan（先出计划再执行）+ timeline 回放 UI + 人可中途在 plan 上留言转向。
- 已吸收：web 视图的 timeline 回放（L4）、计划门（Gate）。
- ★ 启示：plan 即 Gate 的可视化对象——Gate 待办里展示"等待放行的计划内容"而不只是元数据，人审效率更高。记入 12 文档候选增强。

## 借鉴清单汇总

| 来源 | 候选点 | 状态 |
|---|---|---|
| Magentic-One | stall counter 熔断（连续无进展检测） | 不实现（DISCUSSION Q1 裁决：仅记录演进方向） |
| Magentic-One | facts/progress 双账本 | 不采纳（我们的黑板+事件流已覆盖，避免双记账） |
| MetaGPT | 强接口角色的 briefing 必填小节模板 | 已吸收（11 文档 §7.1 Role Spec 已定义 briefing.sections_required） |
| Anthropic | effort 分级派单（heavy/light 精简路径） | 待议（有真实 token 收益后再上） |
| Anthropic | 自包含简报 / 15x token 成本警示 | 已吸收（并发池上限的依据之一） |
| Devin 等 | Gate 待办内嵌计划内容可视化 | 待议（G1 小改，体验收益明显） |
| omo | 工具化 / 邮箱三态 / 边界内建 / fire-and-forget | 已吸收 |
| CC Teams | 任务列表为事实源、空闲即派活 | 已吸收 |
| GroupChat | （反面）自由群聊 | 存档为决策依据 |

## 结论

业界收敛度很高：**共享任务列表 + 定向信箱 + 工具化协议 + 边界内建**已是事实标准；分歧只在拓扑（扁平 vs 树）与同步语义（fire-and-forget vs 轮转发言）。本框架选树形 + fire-and-forget + 显式交接，处于主流象限内；差异化在多级主控与守夜人唤醒，这两处没有现成抄——是后续实现期最需要实证打磨的部分。
