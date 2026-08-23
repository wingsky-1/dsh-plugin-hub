Feature: 通知流水线 — 状态机、完成、中断、错误与子代理
  > 状态：实验性（EXPLORATORY，issue #81 试点、PR 不合入）。
  > 试点 Gherkin/BDD 叙述层 — 仅描述业务行为，不替换现有断言。
  > 场景映射到 packages/dsh-notifier/test/ 中对应 smoke/unit 断言。
  > 本期不引入 cucumber/gherkin 运行时，.feature 仅作文档/规格。

  Background:
    插件已通过 apply(ctx, { enabled: true }) 加载，注册了 agent/status、agent/error、
    agent/disposed 事件监听器与 HTTP 路由。logger.info 为通知的观察面。

  # ── 完成通知状态机 ──────────────────────────────────────

  Scenario: 多会话完成通知互不干扰
    Given agent "session-A" 状态变更为 "running"
    And   agent "session-B" 状态变更为 "running"
    Then  logger.info 不应包含任何通知（running 不触发通知）
    When  agent "session-B" 完成一轮（turnEnd: 1, reason: completed）且状态变更为 "idle"
    Then  logger.info 应包含 1 条完成通知
    And   该通知应包含任务标题「并行评审代码」
    And   该通知应包含耗时信息
    And   该通知不应暴露会话 ID
    When  agent "session-A" 完成一轮（turnEnd: 1, reason: completed）且状态变更为 "idle"
    Then  logger.info 应包含 2 条完成通知，第二条为 session-A 的独立通知

  Scenario: 连续 idle 不重复通知
    Given agent "session-A" 已完成一轮（idle 已触发完成通知）
    When  agent "session-A" 再次收到 idle 事件但无新 turn/end
    Then  logger.info 不应增加完成通知
    And   agent "session-A" 无 running 记录后 idle 不触发通知

  Scenario: 清理后残留 idle 不误报
    Given agent "session-C" 状态为 "running"
    And   agent "session-C" 被 disposed 清理
    When  agent "session-C" 收到残留的 idle 事件
    Then  logger.info 不应增加任何通知

  # ── 完成风暴聚合 ─────────────────────────────────────────

  Scenario: 完成风暴聚合窗口
    Given 完成聚合窗口（doneMergeWindowMs）配置为 3000ms
    When  agent "storm-A" 完成（idle + turnEnd completed）
    Then  首条完成通知应即时发出
    When  agent "storm-B" 在窗口期内完成
    Then  第二条完成通知应挂起，不即时发出
    When  窗口过期（3 秒后）
    Then  应补发聚合通知，文案包含「另有 1 个任务已完成」
    And   聚合通知应包含最近完成的任务标题

  Scenario: 关闭聚合窗口后每条完成即时通知
    Given doneMergeWindowMs 配置为 0（关闭聚合）
    When  agent "s0-A" 完成
    And   agent "s0-B" 完成
    Then  logger.info 应包含 2 条独立的完成通知（均为即时）

  # ── 中断抑制 ────────────────────────────────────────────

  Scenario: 用户停止生成（aborted）不通知完成
    When agent "int-1" 的 turn/end reason 为 "aborted" 且状态变更为 "idle"
    Then logger.info 不应包含完成通知

  Scenario: 中断后新一轮完成正常恢复
    Given agent "int-2" 被中断（aborted，静默）
    When  agent "int-2" 完成新一轮（turn: 2, reason: completed）且 idle
    Then  logger.info 应包含 1 条完成通知

  Scenario: 任务失败（error）、阻塞（blocked）、截断（max-tokens）均不通知完成
    When  agent "err-1" 的 turn/end reason 为 "error" 且状态变更为 "idle"
    Then  logger.info 不应包含完成通知（失败由 agent/error 单独处理）
    When  agent "blk-1" 的 turn/end reason 为 "blocked" 且状态变更为 "idle"
    Then  logger.info 不应包含完成通知
    When  agent "mt-1" 的 turn/end reason 为 "max-tokens" 且状态变更为 "idle"
    Then  logger.info 不应包含完成通知
    When  agent "uk-1" 的 turn/end reason 为未知 kind 且状态变更为 "idle"
    Then  logger.info 不应包含完成通知（保守白名单语义）

  Scenario: 失败后新一轮完成正常恢复
    Given agent "err-2" 失败（error，静默）
    When  agent "err-2" 完成新一轮（turn: 2, reason: completed）且 idle
    Then  logger.info 应包含 1 条完成通知

  # ── 错误通知与合并 ───────────────────────────────────────

  Scenario: 错误通知携带任务上下文
    When  agent "session-1" 产生错误（turn: 1, step: 1, error: "测试错误信息"）
    Then  logger.info 应包含 1 条错误通知
    And   该通知应包含任务标题「优化 notifier 插件」
    And   该通知应包含「第 1 轮第 1 步」与错误信息
    And   该通知不应暴露会话 ID

  Scenario: 同类错误在窗口内合并
    Given 错误合并窗口（errorMergeWindowMs）配置为 60000ms
    When  agent "session-1" 产生第一个错误（turn: 1, step: 1）
    Then  logger.info 应增加 1 条错误通知
    When  agent "session-1" 在同一窗口内产生第二个错误（turn: 1, step: 2）
    Then  logger.info 不应增加通知（窗口内合并）
    When  agent "session-2" 产生错误
    Then  logger.info 应增加 1 条通知（不同会话独立合并窗口）

  Scenario: 窗口过期后错误通知恢复并携带合并计数
    Given 错误合并窗口配置为 20ms
    When  agent "session-1" 产生错误 e1（即时通知）
    And   agent "session-1" 在窗口内产生错误 e2（合并）
    When  窗口过期后 agent "session-1" 产生错误 e3
    Then  通知应包含「另有 1 条同类错误」
    And   通知应包含被合并错误 e1 的摘要

  Scenario: 关闭错误合并窗口后每条错误即时通知
    Given errorMergeWindowMs 配置为 0
    When  agent "s0-1" 连续产生两条不同步骤的错误
    Then  logger.info 应包含 2 条独立错误通知（均不合并）

  # ── 子代理完成 ───────────────────────────────────────────

  Scenario: 子代理完成默认不通知
    Given notifySubagentDone 默认关闭
    When  子代理 "sub-1"（header.origin === 'subagent'）完成（idle + turnEnd completed）
    Then  logger.info 不应包含任何通知
    When  主任务 "main-1" 完成
    Then  主任务仍正常通知，不受子代理开关影响

  Scenario: 开启 notifySubagentDone 后子代理完成使用独立事件类型
    Given notifySubagentDone 配置为 true
    When  子代理 "sub-2"（header.origin === 'subagent'）完成
    Then  logger.info 应包含 1 条通知
    And   通知类型为 "subagent-done"（非 "done"）
    And   通知文案带子任务标题「子任务B」与耗时
    And   通知不暴露子代理会话 ID

  Scenario: fork/派生会话（仅 parentSession 无 origin）走主任务完成
    Given 子代理 "fork-1" 仅携带 parentSession（无 origin 字段）
    When  "fork-1" 完成（idle + turnEnd completed）
    Then  通知类型为 "done"（不被静默，不走 subagent-done）
    And   主会话 "main-x" 完成同样走 "done" 类型

  Scenario: S2 回归 — notifyTaskDone=false 不拦截子代理完成
    Given notifyTaskDone 配置为 false，notifySubagentDone 配置为 true
    When  子代理 "sub-3" 完成
    Then  子代理完成仍通知（类型 subagent-done）
    When  主任务 "main-3" 完成
    Then  主任务不通知（notifyTaskDone=false）