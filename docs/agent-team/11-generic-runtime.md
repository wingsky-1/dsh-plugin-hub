# Agent Team 通用框架 —— 运行时（v2 修订：工具化 + 守夜人）

> 配套：[10-generic-model.md](10-generic-model.md)、[12-generic-console.md](12-generic-console.md)
> v2 核心变更：协作协议从"文档约定 LLM 自觉遵守"升级为 **team_* 内置工具强制执行**；补齐 P0 守夜人唤醒机制；launcher 二分钉死；分期收窄。

## 1. 运行形态

```
dsh 根会话（持 goal 长跑）
 └─ Tier-0 主控 = 守夜人 watchman
     │   原生工具: team_* 全集 + send_message(仅直接子)
     ├─ subagent: Tier-1 主控 A（prompt 来自模板 tiers[1]）
     │    ├─ subagent: role X …
     │    └─ subagent: role Y …
     ├─ subagent: Tier-1 主控 B …
     └─ bash: gh（归档投影）
插件（宿主进程内）── 注册 team_* 工具 + 持有运行时状态/文件锁/校验记账
宿主端插件路由 ── Console 供数 + Gate resolve 写入
```

**launcher 二分边界（G0 钉死，不再摇摆）：**

| 类别 | 承载物 | 内容 |
|---|---|---|
| 确定性操作 | 插件运行时（`team_*` 原生工具内部） | 模板校验、CAS 锁、目录创建、prompt 快照+hash、agents.json 登记、互斥断言 |
| 决策类 | 提示词规程 | 选任务、派单判断、协商裁决、巡场处置、熔断裁决 |

LLM 只做决策；一切"必须精确执行"的动作都在工具内部完成，杜绝幻觉跳步。
（开发期调试辅助 `team-cli` 直读目录排障用，不在关键路径。）

## 2. 产品载体定案：一个 dsh 插件，内置原生工具

**整个框架以 dsh 插件形态交付（npm 包 `@wingsky-1/dsh-agent-team`），team_* 是插件经 cordis `tools` 服务注册的原生会话工具——不引入 MCP server。**

```
@wingsky-1/dsh-agent-team
├── runtime/      平台无关纯库：模板校验 / 账本 / 信箱 / 黑板 / 事件记账 / 幂等
│                 （不依赖 harness API，为未来跨平台迁移预留）
├── src/index.ts  宿主端插件：
│                 · inject tools 服务 → 注册 team_* 原生会话工具
│                 · 只读供数路由 + Gate 写入路由（loopback 围栏）
└── src/client/   Team Console（干净模块，见 12 文档）
```

依据（已验证）：官方 `@deepseek-ai/dsh-tool-cordis` 就是普通插件经 inject `tools` 注册
model-facing 工具的实例；工具 schema 经 JSON 克隆规范化进入模型工具目录，与 bash/read 同级。

相对 MCP server 形态的红利：

- 无独立常驻进程，部署 = 装一个插件
- 工具 handler 与 Console 路由同进程，运行时状态可"宿主内存 + 落盘"混合，不必全走文件
- 跨平台迁移靠 runtime/ 纯库解耦预留：届时另写一层 MCP 绑定即可，核心零改动
  （MCP 是传输协议不是能力本身，等真有跨平台需求再上）

落地先例（G0 第一项 spike）：hub 已有先例——dsh-mcp-manager 注册 ws_mcp_search/call/list/detail
四个原生会话工具（middleware-register.ts 的 ctx.tools.register）；G0 直接复用注入方式。

### 2.1 内置工具集（协议唯一入口）

参照 omo team-mode 的 12 tools 形态裁剪：

| 工具 | 语义 | 强制行为（框架断言） |
|---|---|---|
| `team_init` | 实例化团队 | 校验模板/树/prompt 快照 → 建目录 → 写 agents.json 骨架 |
| `team_spawn` | 拉起子成员（subagent 封装） | 登记 durable id 入 agents.json；自动落 spawn 事件 |
| `team_send` | 定向信箱投递 | 校验可达性（auto 树边 / explicit 白名单）；写收件箱原子文件 |
| `team_task_create/update/list` | 共享任务账本 | update 强制状态机合法迁移；互斥组冲突即拒绝 |
| `team_negotiate/respond` | 跨房间结构化协商（yield/merge/file-order） | 提议与裁决入账本成为派发硬约束；无自由文本通道 |
| `team_state_get/set` | 黑板读写 | set 必须携带保留态三元组；per-role 分片写 |
| `team_handoff` | 显式交接（含 judge 回执模式） | dod 回执格式校验，非法拒绝 |
| `team_archive_write` | 归档绑定写入 | file 型 target 限位 TEAM_HOME 内 |
| `team_gate_open/resolve` | 闸口申请/裁决 | resolve 仅限 Console 写入路径 |
| ~~事件写~~ | 不存在 | 一切 team_* 调用由运行时自动落事件（副作用记账） |

注：插件工具运行在 DSH 进程内，但仍不能替父会话执行 `send_message`（那是 agent-loop 会话内部能力），
唤醒依旧由守夜人循环完成——工具只负责把"该唤醒了"的事实可靠地放进账本/信箱。

## 3. 工作区目录布局

```text
$TEAM_HOME/<instance-id>/
├── team.yaml                  # 快照：模板覆盖结果 + prompt 内联内容与 hash
├── agents.json                # id 注册表：{member → durable subagent id, parent, status, last_seen}
├── room.lock                  # CAS 幂等锁
├── ledger/tasks/*.json        # 共享任务账本（每任务一文件，原子）
├── rooms/
│   ├── root/events.jsonl      # 事件流（仅运行时写入，无 agent 写路径）
│   ├── <room>/events.jsonl
│   ├── <room>/state/<role>.json   # 黑板按角色分片
│   └── <room>/brief/
├── mailbox/                   # 信箱（omo 式原子文件）
│   ├── <member>/<uuid>.json            # 待读
│   ├── <member>/.delivering-<uuid>.json # 投递中
│   └── <member>/processed/<uuid>.json   # 已确认
├── gates/<id>.json            # pending → approved/denied（Console 唯一写点）
└── archive/                   # file 型绑定落点
```

信箱恢复纪律借鉴 omo：`.delivering-*` 崩溃残留按 TTL 收割重投；`processed/` 防 double-inject。

## 4. 巡场循环（watch loop，原"守夜人"，P0 修复）

**定位澄清：不存在独立的守夜人组件。持续驱动力 = DSH goal 机制（原生），巡场动作 = tiers[0] prompt 中的一段循环规程。**

- goal 回答"谁保证 Tier-0 反复醒来"：目标未完成自动开新一轮 turn，complete/blocked 管理生命周期
- 巡场规程回答"醒来后做什么"：纯提示词 + 账本/信箱数据结构，零新增框架机制

**问题**：subagent 无法自发开新 turn。Gate 挂起后谁唤醒？父死后子树谁来管？

```
人启动团队（根会话发指令 + create_goal("完成本团队目标")）
  → Tier-0 巡场循环（goal 自动续轮驱动）：
     ① 收割各子完成通知 / 读 mailbox 未读
     ② 巡检 gates/ 是否有已 resolve 的闸口 → send_message 唤醒挂起的直接子
     ③ 处理 blocked 上行 → 计圈/熔断/转人工
     ④ 派发排队任务（并发池内）
     ⑤ 全部 done → goal complete，收圈归档
```

- Gate 链路闭环：Console 批准写 `gates/<id>.json` → Tier-0 下一轮巡检读到 → `send_message` 唤醒挂起子。
- **轮次驱动而非事件驱动**：批准到唤醒的延迟 = 续轮节奏（分钟级），对本场景够用，非实时系统。
- **goal 生命周期映射（规程必须显式定义）**：单任务 blocked-human ≠ 团队整体 blocked（还有任务推进就不许置 blocked，否则续轮停摆误伤其他房间）；max_goal_rounds 按批次规模预估设够。
- **agents.json 是"父死子活"的解药**：根会话崩溃后重启，从 agents.json 读回整棵树的 durable id，`list_agents` 核对存活者 reattach，仅对确死者重派——不丢弃全部上下文。

## 5. 幂等与恢复（泛化修订版）

| 故障 | 对策 |
|---|---|
| 根会话崩溃 | goal 重启 + agents.json reattach 存活分支（新增） |
| 重复实例化 | room.lock CAS；instance-id 幂等键 |
| 成员死亡残片 | state/<role>.json 的 `"status":"running"` 原子哨兵，恢复时丢弃重做 |
| 投递中崩溃 | 信箱 .delivering TTL 收割（omo 模式） |
| 任务半成品 | 任务账本记录基线与产物指针；重做前清理（git worktree 等**属 oss-maintenance 模板层约定，不入框架协议**） |
| 并发写 | 黑板 per-role 分片；账本每任务单文件；事件流仅运行时单写者 |

## 6. 关键协调动作的框架断言清单（验收口径）

不再声称"100% 提示词可表达"，以下动作有框架级保证：

1. touched paths 分组互斥：`team_task_update` 校验同组互斥才允许 active
2. dod 核验回执：`team_handoff` judge 模式校验逐条结论格式
3. 可达性：`team_send` 按 auto/explicit 校验
4. 资源边界：并发池/hop/round 由账本计数强制，超限拒绝或转 blocked
5. 审计完整：事件 = 工具副作用，无旁路写路径

## 7. Team Template schema（v2 变更处标注 ★）

```yaml
name: oss-maintenance
version: 2
tiers:                          # 锁定 2~3 层
  - { id: master, prompt: ./prompts/master.md }
  - { id: issue-master, prompt: ./prompts/issue-master.md }
roles:
  - { id: spec-writer, prompt: ./prompts/spec-writer.md, briefing: structured }
  - { id: coder,       prompt: ./prompts/coder.md,
      dod: ["lint/build 通过", "附验证凭据"] }          # ★ 注入式核验（§3.3）
  - { id: qa, prompt: ./prompts/qa.md, as_judge: true }
comm_mode: auto                 # ★ auto | explicit（explicit 附白名单）
archives:                       # ★ file/url 硬编码两型
  - { id: tracking, type: url }
  - { id: run-log, type: file, target: archive/run-${INSTANCE_ID}.md }
gates:
  - { id: plan-approval, at: master, on: stage-enter:queued }
resources:
  max_tiers: 3                   # ★ 层级上限可配（默认 3；"几级主控可配"以资源上限表达）
  max_active_rooms: 3
  max_handoffs_per_task: 12
  task_max_rounds: 3
stages_ext: [deciding, building, review]   # 业务子状态，仅展示
```

（原 selector 字段已删——任务选择策略并入 tiers[0] prompt。）

### 7.1 角色文件格式（Role Spec 正式定义，Q7 裁决落地）

角色以独立文件定义（模板内 `roles/*.role.yaml`），team.yaml 只写引用与覆盖。格式：

```yaml
# roles/coder.role.yaml
id: coder
title: 实现工程师                # 展示用
prompt: ./coder.md              # 领域知识；实例化时内联快照+hash
briefing:                        # 简报契约：spawn 时按此校验简报缺项
  format: structured             # structured | freeform
  sections_required:             # 必填小节（MetaGPT 式强接口，仅对需要者启用）
    - background                 # 背景：任务上下文与目标
    - boundary                   # 边界：允许/禁止触碰的范围
    - acceptance                 # 验收：本次任务的 dod 引用或补充
    - forbidden                  # 禁止事项（安全声明等）
dod:                             # 完成判据清单；judge 核验时强制注入并要求逐条回执
  - 改动通过 lint/build
  - 附验证凭据（命令+结果摘要）
max_hops: 3                      # 单次任务内该角色的往返上限
as_judge: false                  # judge 角色：handoff 走回执核验模式
```

校验规则（工具层强制）：`dod` 与 `acceptance` 至少一处非空；`as_judge: true` 的角色必须存在且唯一（每团队一个）；`sections_required` 仅允许枚举值；实例化时 prompt 内联进 team.yaml 快照。

设计意图：简报质量从"取决于模板作者写 prompt 的水平"变为结构保证；`briefing.sections_required` 是可选约束——简单角色可用 `freeform` 不设小节。

## 8. oss-maintenance 还原对照（不变式复核）

原流程每个概念仍落在模板+提示词+结构化协商：计划门=Gate、双写=url 绑定用法、并行分组=touched paths 断言+并发池、交叉沟通=negotiation 工具（yield/merge/file-order，Tier-0 裁决）、熔断=resources 计数、状态行=归档内容格式约定。

## 9. 分期

| 阶段 | 交付 | 出口判据 |
|---|---|---|
| G0 | 插件骨架：原生工具注册（tools 注入/schema/权限，dsh 已支持、按文档直接实现）→ init/spawn/task/state/send/handoff 工具 + 运行时库 + 目录协议 + Tier-0 巡场规程 + agents.json | 单任务全链路跑通（agent 原生调用 team_* 工具）；kill 根会话后 reattach 续跑 |
| G1 | 宿主端只读路由 + Console 运行视图 + **Gate 待办接入 dsh 原生 todo/任务展示**（含批准入口）+ negotiation + touched paths/dod 断言 + 角色文件格式校验 | 多任务并行一轮含一次协商；Gate 批准经 web 实际解除挂起 |
| G2 | 建团向导（auto 模式先行）、explicit 编辑器、Archive 渲染增强 | **第二个异构模板真实需求出现时启动**（成本收益纪律） |

演进方向记录（不排期，见 DISCUSSION Q 队列）：stall counter 熔断（观察模式起步）、effort 分级派单、explicit 链式移交、headless 常驻形态。
