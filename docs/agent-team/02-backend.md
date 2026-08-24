# Agent Team 后端架构 —— 基于 DSH 的最小落地

> 配套：[01-overview.md](01-overview.md)、[03-frontend.md](03-frontend.md)
> 本文重点回答：**如何基于 DSH 已有能力，用最少的自建代码把整套机制落地**。

## 1. 设计目标

- **不写编排框架、不写常驻进程**。DSH 已提供执行器（subagent）、通讯（send_message）、会话存储（sessions 目录）；自建物只有"数据协议 + 少量辅助脚本 + 一个只读查询插件"。
- 一切协调状态是文件；一切 agent 行为是 DSH 原生 turn。
- 每个自建部件都可以独立验证、独立废弃。

## 2. DSH 能力映射表

| 需求 | DSH 原生能力 | 自建量 |
|---|---|---|
| issue 主控 / 职责人员执行器 | `subagent`（持久后台子会话，返回 durable subagent id） | 0 |
| 上下文继承型子代理（如需） | `subagent_fork` | 0 |
| 向成员投递消息（唤醒其下一轮） | `send_message`（仅限直接子代理 depth-1） | 0 |
| 中断失控成员 | `interrupt_agent` / `job_kill` | 0 |
| 房间树可观测性 | `list_agents(scope: descendants)`（含父指针） | 0 |
| 会话全文存档 | `~/.dsh/sessions/<ws-key>/<session-id>/session.jsonl.zstd` | 0 |
| 独立进程执行（v2 备选） | `dsh --profile headless "job"` | 0 |
| 房间数据协议 | — | **目录约定 + schema**（本文档即实现） |
| loop 驱动 | 当前 dsh 会话内的主控 agent（goal 工具维持长任务） | skill/规程文档 |
| GitHub 投影 | `gh` CLI（github-ops skill） | 评论格式约定 |
| 前端供数 API | dsh 插件宿主端只读路由 | 一个薄插件 |

结论：**自建面 = 数据协议（纯文档+schema）+ 辅助 CLI 脚本（可选）+ 只读查询插件（前端上线时才需要）**。

## 3. 运行形态：两种驱动方式

### 形态 A（推荐，v1 采用）：全 agent 化，零新进程

```
dsh web 会话（或专用 profile 会话）
 └─ 主控 agent（本会话角色，由 oss-pipeline 式 skill 规程约束）
     ├─ send_message / list_agents 管理
     ├─ subagent: issue 主控 #1 … #n        ← 每个 = 一个 issue 房间的负责人
     │    ├─ subagent: spec-writer
     │    ├─ subagent: coder
     │    ├─ subagent: hardener
     │    └─ subagent: qa (judge)
     └─ bash: gh 命令做 GitHub 投影；读写房间目录
```

- 主控就是当前 dsh 会话里的一个 agent 角色，靠 **skill 规程**（复用 `.dsh/skills/oss-pipeline` 方法论）约束其行为循环；
- 房间目录只是所有 agent 用文件工具读写的共享磁盘；
- 不存在任何"编排器进程"，重启 = 重新拉起主控会话并从房间目录恢复。

### 形态 B（v2 备选）：独立 Node 编排器

程序化调用 `dsh --profile headless` 起 issue 会话，自管生命周期。仅在单机并发成为瓶颈、或多机扩展时引入。因为房间状态全落盘（D1），从 A 切到 B 不需要迁移数据。

## 4. 房间目录布局（核心数据协议）

```text
$TEAM_HOME/                          ← 例：<repo>/../team-home/
├── batch.json                       ← 本轮批次事实源（主控维护）
│   { "loop_id": "20250611-0930", "issues": [
│       { "issue": 42, "room": "issue-42", "stage": "building",
│         "rounds": 1, "touched_paths": ["packages/dsh-x/src/**"],
│         "group": "g1", "state": "active|queued|done|blocked" } ] }
├── rooms/
│   ├── room.lock                    ← CAS 幂等锁（O_EXCL 创建）
│   ├── main/
│   │   └── events.jsonl             ← 主房间事件流（跨房间里程碑）
│   └── issue-42/
│       ├── events.jsonl             ← 协作事件流（append-only）
│       ├── state.json               ← 黑板（阶段/规格摘要/qa判据/worktree路径）
│       └── brief/                   ← 各角色的任务简报存档
│           └── coder.md
└── worktrees/                       ← 各 issue 独立 worktree（git worktree add）
    └── issue-42/
```

要点：

- `events.jsonl` 与 `state.json` 分离：前者只追加（历史），后者可覆写（当前快照）。v1 内 HANDOFF 是串行的，无并发写冲突；若未来同房间并行多角色，将 `state.json` 拆为 `state/<role>.json` 各写各的。
- 所有路径相对 `$TEAM_HOME`，`$TEAM_HOME` 在主控规程中配置一次。

## 5. 事件 schema

每行一个 JSON 对象，append-only：

```jsonc
{
  "ts": "2025-06-11T09:30:21Z",
  "room": "issue-42",            // main | issue-<n>
  "actor": "coder",              // master | issue-master | <role>
  "session_id": "017c7c72-…",    // DSH 原生 transcript 关联键（必填）
  "type": "handoff",             // 见下表枚举
  "payload": {                   // 按 type 定义
    "from_role": "coder", "to_role": "hardener",
    "summary": "修复完成，已跑 smoke",
    "github_url": "https://github.com/…/issue/42#issuecomment-…", // 可选
    "ref": 42                                                     // 可选
  }
}
```

事件类型枚举（收敛，禁止随意扩充）：

| type | 方向 | 含义 |
|---|---|---|
| `spawn` | → | 成员加入房间 |
| `handoff` | 双向 | 显式交接（含派单与回报凭据摘要） |
| `stage-change` | 上行 | 阶段跃迁：deciding/building/review/merged/blocked |
| `blocked` | 上行 | 阻塞升级（附原因，唯一需要人介入的信号） |
| `error` | 上行 | 异常上报 |
| `done` | 上行 | 房间闭环 |

## 6. HANDOFF 流水线协议

issue 房间内不做群聊，只有两种交互：

```
issue 主控 ──send_message(简报)──▶ 职责人员A
职责人员A ──写 state.json + append handoff 事件──▶ issue 主控（被完成通知唤醒）
issue 主控 ──读黑板判定下一步──▶ send_message 唤醒 职责人员B …
```

- 每个角色的输入 = `brief/<role>.md` 自包含简报；输出 = 压缩凭据（一行结论）写入事件 payload.summary，过程细节留在其 DSH transcript（按 session_id 回溯）。
- 阶段状态机沿用 hub 已有流转标签语义：`loop/deciding → loop/building → loop/review → merged`，异常态 `blocked-human`。
- 消息环防护：HANDOFF 只允许"成员→issue 主控→成员"星形流转，禁止成员互发；主控规程内限制单 issue 单圈最大 handoff 数（超限转 blocked）。

## 7. 主控 loop 规程（skill 形态）

主控行为循环（复用 oss-pipeline 方法论，新增房间层动作）：

1. **开圈**：生成 `loop_id`；CAS 创建 `rooms/room.lock`；搜索 GitHub 是否已有未关闭的同 `loop_id` loop issue——有则复用，无则新建（正文含批次清单表 + `[loop-id]` 标记）。
2. **计划门**：汇总 zone:auto issue，逐个声明 touched paths，重叠归组（同组串行/合并房间），产出批次清单，评论到 loop issue 等维护者放行。
3. **派单**：对放行且并发池有空位的 issue：`git worktree add` → 创建房间目录 → `subagent` 启动 issue 主控（简报含 issue 全文、touched paths、房间路径、安全声明）。
4. **巡场**：消费 issue 主控的上行事件（完成通知 / 轮询 `events.jsonl` since 游标）；更新 batch.json 与 loop issue 清单行（原地编辑）。
5. **熔断**：单 issue 计圈超阈值 → 打 `blocked-human`、loop issue 高亮、房间停机（interrupt 未完成员）。
6. **收圈**：全部房间 done 后，loop issue 追加轮次总结（对接 oss-report 两段式格式），关闭 loop issue，释放锁。

## 8. 幂等与恢复

| 故障 | 对策 |
|---|---|
| 主控崩溃重启 | 从 batch.json + 各房间 events.jsonl since 游标恢复；按 `loop_id` 找回 loop issue；不重开圈 |
| 重复派单 | 房间目录创建走幂等键 `issue-<n>`；`room.lock` CAS 已存在则跳过 |
| 成员中途死亡留残片 | 写事件前先在 `state.json` 置原子哨兵 `"status":"running"`，完成后清除；恢复时发现 running 即视为残片丢弃重做该步 |
| 子代理失联 | `list_agents` 巡检 + 心跳超时（batch.json 内记 last_seen）→ interrupt 后重派 |
| 半成品 worktree | 房间 state 记录 worktree 路径与基线 commit，重做前 `git worktree remove` 再重建 |

## 9. GitHub 投影（双写，方案 A）

- 事实源永远是本地文件；GitHub 更新失败仅记录 error 事件，不阻塞主流程，下轮巡场补投影。
- 更新纪律：loop issue 批次清单**原地编辑对应行**（`gh api -X PATCH`），里程碑事件追加评论；单 issue 细粒度状态仍走其自身 issue 的 `[loop] ts=…` 状态行。
- 权限边界照旧：agent 只代打流转标签；放行等待维护者在 loop issue 操作（计划门天然人工卡点）。

## 10. 前端供数 API（薄插件，随 web 视图交付）

hub 插件形态，宿主端仅三个只读路由（强制 loopback 围栏）：

| 路由 | 返回 |
|---|---|
| `GET team/overview` | 归约后的房间树 + current_activity（读 batch.json + 各 events.jsonl 折叠） |
| `GET team/events?room=&since=` | 事件增量 |
| `GET team/transcript?session_id=` | 解压读取 DSH sessions 下对应 `session.jsonl.zstd`（优先探测复用 DSH 自身会话读取设施，否则引 `@napi-rs/zstd` 构建期内联） |

## 11. 分期落地

| 阶段 | 交付物 | 验证标准 |
|---|---|---|
| M0 | 本目录布局 + 事件 schema + 主控/issue 主控 skill 规程（纯文档） | 单 issue 手工跑通 认领→worktree→spec→code→qa→PR 全链路 |
| M1 | 并发池 + touched paths 分组 + loop issue 双写 + 幂等恢复 | 多 issue 并行一轮；kill 主控后重启无损续跑 |
| M2 | 只读供数插件 + web team 视图（见 03 文档） | 浏览器实时看到协作过程与会话回放 |
