---
name: oss-triage
description: >
  批量认领并推进 zone:auto issue 队列。触发信号："清空队列"、"批量处理"、
  "把所有 auto issue 跑完"。
  Do NOT trigger for: 单个 issue 的精细处理（用 oss-pipeline）、
  红线任务、外部贡献者 PR。
---

# oss-triage — 批量维护编排

## 前置检查
同 oss-pipeline：确认 gh 凭据身份正常、zone 系 label 已就位。

## 编排规则
1. 拉取队列：`gh issue list --label zone/auto --state open --json number,title,author`
2. 来源校验逐个过（author 或 labeling actor 为维护者），不合格的跳过并在报告中列出
3. 用 dsh workflow 工具编排：items = 合格 issue 列表，
   每个 item 走 oss-pipeline 状态机（③-⑧ 可委派 subagent 并行；
   委派时按 oss-pipeline 纪律附带对应 `agents/<role>.md` 规程路径）
4. **并行度 ≤3**，且节流跟随 CI 完成节奏（等 checks 再推下一个），
   禁止无脑 fan-out 造成排队雪崩
5. 每个 worktree 独立（`git worktree`），禁止共享 checkout

## 升级与熔断
- 任一 issue 触发熔断（2 圈未绿）：由 pipeline 状态机负责打
  `blocked-human` label 并置 goal blocked（单一职责，不重复落盘）；本 skill 只记录并继续其余任务，最后统一报告
- 发现红线任务（依赖/API/CI 文件变更）：跳过，列入"待人工决策"清单
- 全部完成后输出批次总结：merged / blocked / skipped 三张清单 + 关键指标

## 边界
- 本 skill 不做架构决策、不批红线、不改 .github/ 与依赖清单
- objective 中写明遇 blocked 即停——真正的防护是凭据最小权限 + merge 仅 --auto 开关形态
