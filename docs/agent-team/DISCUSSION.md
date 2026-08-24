# Agent Team 设计讨论日志

> 本文件记录从场景方案到通用框架的完整讨论演进、决策与开放问题。设计正文见同目录 01/02/03（场景方案 v1）与 10/11/12（通用框架 v2）、20（案例研究）。
> 讨论阵地：worktree `discussion/agent-team`（主 checkout 不承载设计迭代）。

## 0. 背景与目标

基于 dsh harness 构建多 agent team，处理开源仓库 issue/PR；随后抽象为**有限任务闭环型**通用协作框架，issue 处理退化为内置模板 `oss-maintenance`。

## 1. 讨论演进时间线

### 第一阶段：场景方案（01/02/03）
- 确立四层：执行树（subagent）/ 协调协议（黑板+信箱+HANDOFF）/ 单一事实源（事件日志 + DSH 原生 transcript 按 session_id 关联）/ 双投影（GitHub loop issue + web 视图）。
- 关键事实锚定：DSH `send_message` 仅父→直接子（depth-1）；会话全文落盘 `sessions/<ws>/<id>/session.jsonl.zstd`，零自建存储。
- 决策 D1~D8：房间=数据抽象、树形中继、拒绝群聊、冲突静态前移、本地事实源+GitHub 投影、transcript 关联、dsh 插件载体、知识广播推迟。

### 第二阶段：抽象为通用框架（第一轮用户抽象）
- 用户六点：场景知识→提示词；双写→外部归档关联；角色自定义；创建时勾选各级主控/提示词/角色；层级可配；对话关系创建时定义。
- 评审产出 A1~A12：5 采纳、1 修正（通讯矩阵受 depth-1 物理约束，逻辑声明+树校验）、4 补充（Human Gate 通用化、DoD 一等化、保留态三元组、Trigger 接口位）。

### 第三阶段：对抗评审（独立子 agent）
核心发现：
- 【P0】Gate 唤醒链路断裂——subagent 无法自发开 turn，无人执行"批准后唤醒"；修复=守夜人（Tier-0 根会话持 goal 长跑巡场）+ agents.json id 注册表（顺带解"父死子活"）。
- launcher 在 skill 规程 / 薄 CLI 间摇摆 → 二分钉死：确定性走 CLI、决策走规程。
- "100% 提示词可表达"偷换概念 → 验收改为"行为等价 + 关键协调动作有框架断言"。
- 过度设计点名：通讯矩阵恒冗余、Archive 注册表预支、selector 业务词泄漏、任意层级无消费者、成本收益双标（40% 增量服务于零证据第二场景）。

### 第四阶段：v2 形态定稿（第二轮用户决策）
- **整体形态 = 提示词（策略）+ 内置工具（动作）+ 守夜人（驱动）**，参照 omo team-mode 与 Claude Code Agent Teams。
- 通讯矩阵 auto/explicit 双模：auto 默认（树边即拓扑），explicit 为权限收窄开关（极客模式）。
- 单入口原则：人只与 Tier-0 对话 + Gate 待办。
- DoD 赋实义：注入 judge 简报 + 结构化逐条回执校验。
- 事件 = 工具副作用（无事件写工具），审计完整性靠构造保证。
- 分期收窄：向导等 G2，触发条件 = 第二个异构模板真实跑通。

### 第五阶段：核心思路保全审计 + 插件定案（v2.1）
- 用户工作方式约定确立：**讨论优化不得丢失原始核心思路；有冲突必须说明原因与更优选择**。
- 保全审计结果（三处弱化，两处修正、一处按用户裁决维持）：
  - ❌→✅ "交叉需要沟通"曾被弱化为纯串行化 → 恢复为**结构化协商** `team_negotiate`（yield/merge/file-order，Tier-0 裁决入账本成硬约束），不开自由聊天通道。
  - ⚠️→✅ "几级主控可配置"曾被锁死 2~3 层 → 改为默认 3 层 + `resources.max_tiers` 可配上限（可配性优先，性能担忧用上限兜底）。
  - ✅ "issue 分阶段反馈回 loop issue"降为归档绑定用法——系用户本人裁决的抽象，维持。
- **产品形态定案（A14/D16）**：整个框架 = 一个 dsh 插件 `@wingsky-1/dsh-agent-team`：
  - MCP server 承载 `team_*` 工具（进程常驻持有运行时状态；agent 会话内原生调用）；
  - 宿主端插件承载只读路由 + Gate 写入 + Team Console；
  - team-cli 降级为调试辅助。取消"CLI 先行"过渡期。
- 新增工具：`team_negotiate/respond`（协商）；新增资源字段：`max_tiers`。

## 2. 决策记录（累计）

| # | 决策 | 理由 | 被否备选 |
|---|---|---|---|
| D1 | 房间=目录数据协议，非框架实体 | 可恢复、可审计、执行器可替换 | 常驻 broker |
| D2 | depth-1 树形中继 | DSH 物理约束即 narrow waist | 扁平群聊/跨层直连 |
| D3 | HANDOFF 星形，禁群聊 | token 与发散可控（GroupChat 反例） | 轮转发言 |
| D4 | 冲突消解派单时静态判定 | 运行时协商不可靠 | 运行时锁为主 |
| D5 | 本地事实源 + GitHub 归档投影 | 无 rate limit、离线可恢复 | GitHub 为事实源 |
| D6 | transcript 用 DSH 原生按 session_id | 零自建存储 | 事件日志记全过程 |
| D7 | Console=dsh 插件面板 | 复用围栏与构建契约 | 独立服务 |
| D8 | 知识广播推迟 | 无重复踩坑证据不建 | — |
| D9 | 工具化协议（team_*） | 协议强制执行、审计构造保证（omo/CC 先例） | 提示词约定 |
| D10 | 守夜人=Tier-0 持 goal | subagent 无法自发开 turn 的唯一闭环解 | 外部 watch 进程（无法产生 dsh turn） |
| D11 | comm auto/explicit 双模 | auto 是成熟度；explicit 收窄是极客能力 | 强制配置矩阵（伪需求） |
| D12 | 单入口原则 | team 自治为目标，人是例外路径 | 人可直达任意成员 |
| D13 | 层级锁 2~3 | 信息衰减/token 失控无消费者买单 | 任意层级 |
| D14 | launcher 二分 | LLM 只决策，精确动作走 CLI | 全规程（幻觉跳步风险） |
| D15 | prompt 快照内联+hash | 防运行期漂移、保重放审计 | 引用裸路径 |
| D16 | 产品形态=dsh 插件单包（MCP server 工具面 + 宿主端路由/UI 面） | 用户定案；工具化一步到位，无 CLI 过渡期 | team-cli 先行过渡 |
| D17 | 交叉沟通恢复为结构化协商 negotiation | 保全原始需求；结构化事件+裁决不破坏架构 | 纯串行化（弱化了沟通）/ 自由聊天（不可靠） |
| D18 | 层级默认 3 + max_tiers 可配上限 | 可配性优先，性能担忧用资源上限兜底 | 硬锁 2~3 层 |

## 3. 开放问题（待后续讨论）

| # | 问题 | 当前倾向 |
|---|---|---|
| Q1 | stall counter 熔断是否并入 resources | 倾向 G1 采纳（Magentic-One 实证，成本低） |
| Q2 | Gate 待办内嵌计划内容可视化 | 倾向 G1 小改（Devin plan 面板先例） |
| Q3 | effort 分级派单（heavy/light） | 等 token 数据说话 |
| Q4 | explicit 模式下链式移交（免全程审计） | 暂不做，留 v2+ |
| Q5 | team-cli 升级为插件/MCP 真工具的时机 | 接口已按真工具设计，等 G0 实跑痛点 |
| Q6 | 形态 B（headless 多进程）管理面 | 参照 claude-squad（tmux+worktree 表） |
| Q7 | briefing 必填小节模板（MetaGPT 式强接口） | 随 G2 向导评估 |
