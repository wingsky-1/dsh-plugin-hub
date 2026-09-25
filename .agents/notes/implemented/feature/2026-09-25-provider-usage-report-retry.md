# Agent Note: #1010 报告级有界重试与成本观测

Status: implemented

## Problem

推理型模型可能只返回 reasoning 而没有正文；旧执行边界把该情况与普通空输出混在一起，调度器又会在每分钟重新提交同一窗口，形成无界失败、延迟和费用放大。只记录最终成功报告的 token 还会隐藏失败 attempt 的真实成本，使用户无法判断额度消耗、退避进度或终止原因。

本篇记录 #1010 已批准方案在 B3a/B3b 与最终 integration 的已落地边界：exact-model reasoning effort、报告级 retry ledger、逐 attempt 成本、状态 UI、双语文档、current-cycle fence、force reservation、index cycle 投影与 unsupported block policy 均已纳入本分支，并由对应测试覆盖。

## Decision

### 推理等级与流协议

- `reasoningEffort` 是 DSH 为当前 exact model 发现的 opaque ID。客户端与宿主保持 DSH 返回的顺序、名称、description 和 default 语义；未配置时省略字段并沿用 DSH 默认，绝不映射 `low/off`、不取数组末档、不按 provider 名分支。
- 报告流只消费 text/reasoning 与明确终态。终态 error/aborted 优先于正文存在性；reasoning-only 与双空是不同稳定 code；未知 chunk、未知/缺失终态与官方非文本 block 均按 unsupported/unknown fail closed。报告没有工具或图像能力，tool-call、image、file 及其他非文本 block 不得被静默忽略后仍返回成功。
- abort（含预取消、流中取消与 finish(aborted)）永不自动 retry。thrown/stream error 只有结构化 allowlist 中的 transient 与空输出类进入 retry；认证、额度、非法请求、content-filter、未知错误和 capability mismatch 均不自动 retry。

### 报告级 retry ledger

- 初次报告调用之外最多自动 retry 5 次，wire `attempts=0..5`、`maxAttempts=5`；第 1 至第 5 次 retry 前退避严格为 1/2/4/8/16 分钟。逻辑身份是 `period + report key`，初次配置在 cycle 开始时快照，cycle 内不随全局配置漂移。
- ledger 读取时先在内存中按 `period → key → RetryEntry` 规范化：所有非终态 entry 保留在 `records`，每个 period 只保留按 key 排序后的最后一条 terminal entry；写盘序列化时再次裁剪，并把被裁剪的 terminal key 写入全量 `terminalKeys`（`period → key → terminal code`，按 key 排序且不按数量淘汰）。墓碑只保存终态 code，不保存 attempts、observations 或 usage，所有已知 terminal key 都保留墓碑，避免历史 key 被自动重开。`flatten` 以及 `list`/`listDue`/`get` 只投影 `records`，不会把墓碑展开成完整 entry。
- 没有 entry 且没有墓碑的 key，自动 `beginAttempt` 才会创建 initial entry；已有 entry 时必须带匹配的 `cycleId`，waiting 还必须已到 `nextRetryAt`，in-flight 或 terminal 返回 `null`；若 `records` 没有该 key 但 `terminalKeys` 有墓碑，也返回 `null`。对这个只剩墓碑的 key，手动 `beginForce` 才会清除墓碑并创建新 cycle、重置 attempts/terminal/nextRetryAt，读取当前配置并 durable prepare；force 失败不推进 lastRun。
- 例如 `daily` 的 `2026-09-21` 与 `2026-09-23` 都 terminal 时，`records.daily` 只保留 `2026-09-23` 的完整 entry，`terminalKeys.daily` 记录 `2026-09-21: "auth-failed"`；对被裁剪的 `2026-09-21` 调用 `beginAttempt` 返回 `null`，只有 `beginForce` 才会移除墓碑并开始新 cycle。
- ledger 是 retry 状态与成本的事实源，使用 0600 临时文件、完整写入、文件 fsync、原子 rename 与支持平台上的目录 fsync。损坏文件先 no-clobber 隔离取证并 fail closed，不能当空状态重置预算。启动 recovery 在 timer/首轮 tick 前完成；in-flight 恢复为当前可重试状态，terminal 不自动复活。
- storage failure 是 terminal 类别，不映射为 transient，不重新调用模型。terminal marker 必须 durable 写成功才可返回；写失败保留可识别 storage fail-closed 状态。现有 report/index/lastRun 写链尚未全链 fsync，因此只声明 ledger 自身耐久与进程崩溃/重启恢复，不声明掉电下全链原子性。

### Attempt 观测、状态与客户端

- 每个实际报告 outer attempt 记录 input/output/reasoning/total/cacheRead/cacheWrite token 与 durationMs。`ReportTokenUsage.reasoningTokens` 为 `number | null`；周期累计按字段独立聚合，任一 attempt 缺失某字段时该字段保持 null，不伪装成 0。
- status/POST 响应可选携带 `retry`。客户端严格投影 attempts/maxAttempts/nextRetryAt/terminal/terminalReason/usage，显示当前 outer attempt（`attempts + 1`）、累计成本、下次重试、busy/deferred 或 terminal 原因；null 显示“未提供/not reported”。旧响应没有 retry 时清空 retry 面板并保持原生成 UI，manual force、reused、done/failed/error 既有文案不改变。
- attempt 日志只含 attempt/result/stable code、opaque effort ID、token 数字与 durationMs；不记录 prompt、reasoning 原文、API key/凭据或 path。reasoning 只以数值 token 观测。

### 事务与 DSH retry 边界

- 最终成功事务顺序固定为：coordinator current-cycle reservation/fence → attempt observation → report/index → monotonic lastRun → ledger clear。reservation 必须先于任何报告文件写入；旧 cycle 的 observation、文件写入、notify、lastRun 与 clear 在 CAS 失败后全部丢弃。index reconciliation 只能完成同一 cycle 的成功事实，不能清除更新的 force cycle。
- 报告直接消费 `ctx.llm.stream`，不经过 DSH agent request retry waterfall，也不新增 DSH retry layering。初次 + 5 retry 只定义最多 6 个报告级 outer attempts；它不等于、不保证底层 HTTP 请求恰好 6 次。
- storage terminal 与 cycle fence 是不同不变量：前者防模型调用放大，后者防旧 cycle 污染新 cycle；实现和测试均不得用其中一项替代另一项。

## Alternatives considered

### 取 reasoning efforts 末档作为最低 effort

最强理由是实现简单，且许多 adapter 恰好把低档放在末位。拒绝，因为数组顺序是当前发现结果而非跨 provider 语义契约；模型增删档位时会静默选错，也把展示顺序误当优先级。

### DeepSeek 专用 low/off 或 provider 专用 retry

最强理由是能快速绕开本次 DeepSeek 漂移。拒绝，因为报告执行器是 generic，provider 分支无法覆盖其他模型，还会绕过 DSH opaque effort/default 策略，使同一配置在不同 provider 下含义漂移。

### 无限 scheduler retry

最强理由是最终成功机会最大，且无需设计 terminal。拒绝，因为成本、延迟与重复副作用无上界；每分钟重提同一窗口正是本 issue 的放大器。ledger、固定退避和 terminal 给预算一个可解释上界。

### 只记录最终赢家 token

最强理由是实现最简单，成功报告只需要一次 usage。拒绝，因为失败与空输出 attempt 同样消耗额度；只记赢家会隐藏真实成本，也无法解释重试与终止。逐 attempt 记录、逐字段累计且缺失保持 null 才能表达真实不确定性。

### 叠加官方 dsh-llm-retry 并宣称 HTTP 恰好 6 次

最强理由是复用官方 retry 能力，减少自定义调度。拒绝，因为本报告路径不经过 agent open-turn waterfall，叠加后预算与观测无法归因；官方/底层动态重试也不受插件 ledger 控制。插件只声明报告级 outer-attempt 上限，不断言 HTTP 次数。

## Consequences

- 收益：reasoning-only 与其它失败可分诊；自动恢复有固定成本上界；force、terminal 与重启恢复语义可解释；用户能看到每个报告周期的真实累计 token/duration，而非只看到赢家。
- 代价：每个实际 attempt 都要 durable 记录 observation；状态 API、客户端与双语词典增加跨文件契约；force、reconciliation 与事务 hardener 必须共同维护 cycle fence，任何后续写入面都要先证明 current-cycle ownership。
- 已知上限：ledger 自身耐久不等于 report/index/lastRun 全链 power-loss durability；报告级 attempt 上限不等于 HTTP 精确次数。若未来需要统一全链掉电事务或统计 wire HTTP 数，必须另立决策并接入可观测 request ID，不能从本篇推导。

## Verification

- TDD 红灯：retry helper 缺失时 client unit 新增 4 条用例红、既有用例绿；retry UI 缺失时 client DOM 新增 2 条状态用例红、7 条既有/兼容用例绿。
- 绿灯：`pnpm exec vitest run packages/dsh-provider-usage/test/client/unit-report-p0.test.ts --project contract` 为 54/54；`pnpm exec vitest run packages/dsh-provider-usage/test/client-dom/report-section.test.ts --project client-dom` 为 11/11。
- 类型：`pnpm --filter @wingsky-1/dsh-provider-usage typecheck` 通过。
- 完整 package build/test、scripts、stryker 登记、gate:changed 与 gate:pr 的最终 exit code 由交付记录给出；本地门禁通过不替代 CI。
