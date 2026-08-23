Feature: 路由围栏与免打扰（quiet hours）
  > 状态：实验性（EXPLORATORY，issue #81 试点、PR 不合入）。
  > 试点 Gherkin/BDD 叙述层 — 仅描述业务行为，不替换现有断言。
  > 场景映射到 packages/dsh-notifier/test/ 中对应 smoke/unit 断言。
  > 本期不引入 cucumber/gherkin 运行时，.feature 仅作文档/规格。

  Background:
    插件已通过 apply(ctx, { enabled: true }) 加载，注册 config / events /
    health / test / history 五条 HTTP 路由。

  # ── loopback 围栏（403） ────────────────────────────────

  Scenario: 非本机来源一律 403 拒绝
    Given 请求来自非本机地址（remoteAddress: "10.0.0.2"）
    When  请求到达任一已注册路由（config / events / health / test / history）
    Then  响应状态码应为 403
    And   本机来源（127.0.0.1）不受影响

  # ── 方法白名单（405） ───────────────────────────────────

  Scenario: 路由方法白名单之外一律 405
    Given test 路由仅允许 POST，history 路由仅允许 GET，health 路由仅允许 GET
    When  对本机来源使用白名单外的方法（test 用 GET、history 用 POST、health 用 DELETE）
    Then  响应状态码应为 405

  # ── health 与配置路由 ───────────────────────────────────

  Scenario: health 路由返回配置摘要与 SSE 连接数
    When  本机来源请求 health 路由
    Then  响应状态码为 200
    And   响应体 ok 为 true、plugin 为 "dsh-notifier"
    And   响应体携带配置摘要（notifyAsk 布尔值）与 sseConnections 数值

  Scenario: config GET 返回当前可通知配置，PUT 持久化并内存生效
    Given config 路由已注册
    When  本机来源 GET config
    Then  响应状态码为 200，默认 notifyAsk 为 true
    When  本机来源 PUT 非法 JSON
    Then  响应状态码为 400（容错不挂起）

  # ── 免打扰（quiet hours） ───────────────────────────────

  Scenario: 跨午夜免打扰时段判定
    Given 免打扰启用（enabled: true, start: "22:00", end: "08:00"）
    When  当前时间为 23:00（晚间）
    Then  判定为免打扰时段内
    When  当前时间为 07:00（凌晨）
    Then  判定为免打扰时段内
    When  当前时间为 12:00（中午）
    Then  判定为免打扰时段外

  Scenario: 同日内免打扰时段判定
    Given 免打扰启用（enabled: true, start: "09:00", end: "17:00"）
    When  当前时间为 09:00
    Then  判定为免打扰时段内
    When  当前时间为 08:00
    Then  判定为免打扰时段外

  Scenario: 免打扰禁用时任意时间判定为时段外
    Given 免打扰禁用（enabled: false, start: "22:00", end: "08:00"）
    When  当前时间为 23:00
    Then  判定为免打扰时段外

  Scenario: quietHours 配置归一化 — allowKinds 白名单过滤
    Given quietHours.allowKinds 配置为 ["ask", "bogus", "error"]
    Then  归一化后仅保留白名单内 kind（["ask", "error"]），非法项被过滤

  Scenario: 非法配置值被丢弃回默认
    When  配置 quietHours.start 为 "25:00"（非法 HH:MM）
    Then  归一化后回退默认 "22:00"
    When  配置 quietHours.start 为 "9:30"（非两位 HH:MM）
    Then  归一化后同样回退默认 "22:00"
    When  配置 notifyAsk 为 "yes" 或 notifyWhenVisible 为 "x"（非布尔）
    Then  归一化后丢弃非法值（回退对应默认）
    And   未知键透传保留（防降级丢键）

  Scenario: 数值范围配置归一化
    When  配置 errorMergeWindowMs: -1 / "x"、doneMergeWindowMs: "x"、askRemindMin: "x"
    Then  归一化后非法值回退默认（errorMergeWindowMs 默认、doneMergeWindowMs 默认、askRemindMin 默认 5）
    When  配置 errorMergeWindowMs: 0 或 doneMergeWindowMs: 0
    Then  0 保留（0=关闭对应合并）
    When  配置 askRemindMin: 0
    Then  0 保留（0=关闭审批提醒）