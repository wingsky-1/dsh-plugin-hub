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
同 oss-pipeline：确认 gh 凭据身份正常、zone 系与 loop 系 label 已就位；
批量执行以第 0 圈计划门获批（维护者「按此执行」）为前提，本 skill 不自行拉起。

## 编排规则
1. 拉取队列：`gh issue list --label zone/auto --state open --json number,title,author`
2. 来源校验逐个过（author 或 labeling actor 为维护者），不合格的跳过并在报告中列出
3. **认领原子化逐个过**：先写独占认领评论 `[claim] agent=<id> ts=<unix>` 并只读读回
   验证（oss-pipeline 实施段①），验证失败即弃权跳过并在报告中列出——
   `gh issue edit --add-label` 非原子，禁止以标签写入作为认领依据
4. 用 dsh workflow 工具编排：items = 合格 issue 列表，
   每个 item 走 oss-pipeline 实施段状态机（③-⑨ 可委派 subagent 并行；
   委派时按 oss-pipeline 纪律附带对应 `agents/<role>.md` 规程路径与
   [agents/_protocol.md](../../../agents/_protocol.md) 公共协议）
5. **并行度 ≤3**，且节流跟随 CI 完成节奏（等 checks 再推下一个），
   禁止无脑 fan-out 造成排队雪崩
6. 每个 worktree 独立（`git worktree`），禁止共享 checkout
7. **dep-touching 批次强制串行**：凡改根依赖清单（package.json）或 lockfile
   （pnpm-lock.yaml）的批次标记 `dep-touching`，脱离并行车道、强制进串行车道执行；
   解冲突后必须重跑全量门禁（五连）再推送，禁止只跑局部测试就推

## 铁律
- 写后读回验证：任何 gh/git 远端写操作（打标签 / 评论 / 认领 / push 等）完成后，
  立即以只读调用确认并展示回读证据（如 `gh issue view --json labels`），不确认
  不推进下一个 item；禁止 `>/dev/null`、`tail` 截断输出、`|| true` 吞错误码——
  反例：批量打标签写成 `gh issue edit $n --add-label zone/auto >/dev/null 2>&1 || true`
  会把限流 / 权限失败静默吞掉，批次总结全是假阳性，事后无法定位哪个 item 实际漏打

## 升级与熔断
- 任一 issue 触发熔断：由 pipeline 收敛环负责打 `blocked-human` label、记状态行并置
  goal blocked（单一职责，不重复落盘）；本 skill 只记录并继续其余任务，最后统一报告；
  恢复按 oss-pipeline 熔断恢复协议（resume 信号 + actor 校验 + 从 suspended_at 续跑）
- 发现红线任务（依赖/API/CI 文件变更）：跳过，列入"待人工决策"清单
- 全部完成后输出批次总结：merged / blocked / skipped 三张清单 + 关键指标

## 边界
- 本 skill 不做架构决策、不批红线、不改 .github/ 与依赖清单
- objective 中写明遇 blocked 即停——真正的防护是凭据最小权限 + merge 仅 --auto 开关形态
