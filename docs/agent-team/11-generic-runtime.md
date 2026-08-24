# Agent Team 通用框架 —— 运行时（v2 修订：工具化 + 守夜人）

> 配套：[10-generic-model.md](10-generic-model.md)、[12-generic-console.md](12-generic-console.md)
> v2 核心变更：协作协议从"文档约定 LLM 自觉遵守"升级为 **team_* 内置工具强制执行**；补齐 P0 守夜人唤醒机制；launcher 二分钉死；分期收窄。

## 1. 运行形态

```
dsh 根会话（持 goal 长跑）
 └─ Tier-0 主控 = 守夜人 watchman
     │   工具: mcp__team__* 全集 + send_message(仅直接子)
     ├─ subagent: Tier-1 主控 A（prompt 来自模板 tiers[1]）
     │    ├─ subagent: role X …
     │    └─ subagent: role Y …
     ├─ subagent: Tier-1 主控 B …
     └─ gh（归档投影，bash）
MCP server（插件附带，进程常驻）── 持有运行时状态、文件锁、校验与记账
宿主端插件路由 ── Console 供数 + Gate resolve 写入
```

**launcher 二分边界（G0 钉死，不再摇摆）：**

| 类别 | 承载物 | 内容 |
|---|---|---|
| 确定性操作 | MCP server 运行时（`mcp__team__*` 工具内部） | 模板校验、CAS 锁、目录创建、prompt 快照+hash、agents.json 登记、互斥断言 |
| 决策类 | 提示词规程 | 选任务、派单判断、协商裁决、巡场处置、熔断裁决 |

LLM 只做决策；一切"必须精确执行"的动作都在工具内部完成，杜绝幻觉跳步。
（开发期调试辅助 `team-cli` 直读目录排障用，不在关键路径。）

## 2. 产品载体定案：一个 dsh 插件，两个面

**整个框架以 dsh 插件形态交付（npm 包 `@wingsky-1/dsh-agent-team`），不再有"CLI 先行、插件后置"的过渡期：**

```
@wingsky-1/dsh-agent-team
├── mcp/          MCP server —— team_* 工具的提供方
│                 （经 .dsh/mcp.json / dsh-mcp-manager 注册；进程常驻，
│                  天然持有运行时状态与文件锁；工具内做校验/记账/原子性）
├── src/index.ts  宿主端插件（hub 标准形态）—— 只读供数路由 + Gate 写入路由 + loopback 围栏
└── src/client/   Team Console（干净模块，见 12 文档）
```

- agent 会话内原生调用 `mcp__team__send` 等真工具——"提示词 + 内置工具"形态一步到位
- `team-cli` 降级为开发期调试辅助（直接操作目录排障），不在关键路径上
- 宿主端路由与 MCP server 共享同一套运行时库（同一份校验/记账代码），Console 的写路径（Gate resolve）也经它落账

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

注：MCP 工具无法替父会话执行 `send_message`（那是 DSH 会话内部能力），所以唤醒仍由守夜人循环完成——工具只负责把"该唤醒了"的事实可靠地放进账本/信箱。

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

## 4. 守夜人机制（P0 修复）

**问题**：subagent 无法自发开新 turn。Gate 挂起后谁唤醒？父死后子树谁来管？

**答案：守夜人 = Tier-0 所在根会话本身，靠 DSH goal 机制长跑。**

```
人启动团队（根会话发指令 + create_goal("完成本团队目标")）
  → Tier-0 规程循环（goal 自动续轮驱动）：
     ① 收割各子完成通知 / 读 mailbox 未读
     ② 巡检 gates/ 是否有已 resolve 的闸口 → send_message 唤醒挂起的直接子
     ③ 处理 blocked 上行 → 计圈/熔断/转人工
     ④ 派发排队任务（并发池内）
     ⑤ 全部 done → goal complete，收圈归档
```

- Gate 链路闭环：Console 批准写 `gates/<id>.json` → Tier-0 下一次续轮读到 → `send_message` 唤醒挂起子。
- 中层挂起同理：Tier-1 的 turn 结束即停，其唤醒者是 Tier-0（父）；Tier-1 自己的子由 Tier-1 在被唤醒后的 turn 里继续管理。
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

## 8. oss-maintenance 还原对照（不变式复核）

原流程每个概念仍落在模板+提示词+结构化协商：计划门=Gate、双写=url 绑定用法、并行分组=touched paths 断言+并发池、交叉沟通=negotiation 工具（yield/merge/file-order，Tier-0 裁决）、熔断=resources 计数、状态行=归档内容格式约定。

## 9. 分期

| 阶段 | 交付 | 出口判据 |
|---|---|---|
| G0 | 插件骨架：MCP server（init/spawn/task/state/send/handoff）+ 运行时库 + 目录协议 + Tier-0 规程 + agents.json + 守夜人循环 | 单任务全链路跑通（agent 经 MCP 调工具）；kill 根会话后 reattach 续跑 |
| G1 | 宿主端只读路由 + Console 运行视图 + Gate 路由与唤醒闭环 + negotiation + touched paths/dod 断言 | 多任务并行一轮含一次协商；Gate 批准实际解除挂起 |
| G2 | 建团向导（auto 模式先行）、explicit 编辑器、Archive 渲染增强、stall counter | **第二个异构模板真实需求出现时启动**（成本收益纪律） |
