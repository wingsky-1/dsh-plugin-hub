# dsh-mcp-manager 分阶段重构 · 阶段 0 三件套（规格决策 / 契约缺口 / 迁移门禁）

> 关联：`architecture-redesign.md`（v3 主方案）、`architecture-redesign-review.md`（两轮评审 62/100→78/100）、
> `requirements-and-tdd-plan.md`（需求规格/bug 清单/测试审计）。
> 本文件 = 阶段 0 交付物：把主方案 §三/§四/§六的「承诺」细化为「可评审、可执行、可验收」的规格。
> Bug 编号 B1–B20/C1–C15 见 requirements-and-tdd-plan.md（已含两轮纠偏）。

---

## A. 规格决策表（D1–D9，阶段 0 拍板项）

> 每项给出：问题 / 选项 / 推荐 / 技术依据（代码证据）/ 影响面 / 验证方式 / 阶段落位。

### D1 重连状态分级（B1+B4）
- 问题：supervisor 重连触发 `connect()` 时 `connectedAt` 已被 scheduleReconnect 置 undefined → 状态被覆盖为 `connecting`（supervisor.ts:337+L399）；中间层 ConnectionEntry.status 无 `reconnecting`（middleware-types.ts:46 注释明示四态），summarize 投影后客户端 counts.reconnecting 恒 0。
- 选项：① 补 `reconnecting` 状态机（supervisor 分支判定 + ConnectionEntry 补态 + summarize/counts + 客户端 C13 策略）；② 文档化回避。
- 推荐：**① 补状态机**（六态一致；service-contract 类型面已含 "reconnecting"，shared 面现成）。
- 影响面：ConnectionEntry 类型、supervisor.connect 分支、manager.summarize、客户端 servers.ts/float.ts 未知状态策略（C13）；现有单测中断言状态集的位置清单（阶段 3 输出）。
- 验证：B1 红测改状态机断言点（`failedAttempts>0` 分支断言，勿整窗口轮询）；B4 红测 ensureConnected 失败后 entry.status；C13 客户端策略与 B1/B4 同 PR 拍板、阶段 7 实现。
- 落位：阶段 3（宿主端）+ 阶段 7（客户端实现）。

### D2 B5 清理契约（start/connect 替换分支）
- 问题：manager.start L731-741 与 manager.connect L1011-1017 替换已连接 supervisor 时只置 `disposed=true`，旧 transport 不 close、旧 toolDisposers 不 dispose。
- 选项：① ~~start 变 async~~（涟漪失实，撤回）；② **保持同步 + 替换分支补调 `void existing.disconnect()`**。
- 推荐：**②**。依据：旧实例 disconnect 内部 `await this.syncChain` 后清 toolDisposers（supervisor.ts L508-512），新代际 syncTools 经 enqueueSync 排在**同一** syncChain（L323-327）——FIFO 天然保证旧清理先于新注册。
- 影响面：涟漪实为 manager 内部 5 处（setSession/refreshFromDisk/unregisterServer/startAll/connect）+ apply.ts L148/L150（routes-controllers 零处调 start/reconcileServers，grep 实证）。
- 验证：顺序不变式测试「替换后旧代际工具先注销、新代际后注册」；B5 红测（弱断言先行：替换后旧实例 disposed=true 且新代际建立）。
- 落位：阶段 3。

### D3 B6 getTools 查询面
- 问题：middleware 接管（project 项目级 / all 全局）的服务器不在 supervisor map → apply-services.getTools 返回 []（L41-55）。
- 选项：① 与 summary 同源（中间层接管的服务器也返回工具）；② 文档声明仅 supervisor 路径。
- 推荐：**① 与 summary 同源**（查询面一致），键形态见 D9。
- 影响面：apply-services.ts（受 service-contract 静态扫描路径约束）、shared 类型面注释；消费方（dsh-codegraph）键形态可能变化。
- 验证：阶段 3 单测（middleware 模式 getTools 返回工具列表）；D9 键形态决策。
- 落位：阶段 3（B6 修复落位）。

### D4 B8 脱敏口径（安全语义变更，走红线流程）
- 问题：createRedactor http 分支把整 URL 加入 secrets（middleware-utils.ts L146），错误消息中 URL 全量 [REDACTED]，可诊断性差；且 supervisor.ts:362、manager 十余处 logger.warn(String(error)) 不脱敏。
- 选项：① 整 URL（现状安全激进）；② 仅用户信息（username/password/searchParams）脱敏 + raw/decoded 双形态。
- 推荐：**②**，双形态注册（percent-encoding 防绕过，L149-150 现状只存 decoded）；**必须同步**：日志脱敏全覆盖（实施时列全量行号清单：manager.ts L190/L375/L421/L449/L611/L616/L705/L744/L781/L820/L987 等）+ API 层 redactor 注入面（见契约缺口 C2-1）+ README 安全模型更新 + 测试（createRedactor 现状零测试，先写现状回归基线再改）。
- 影响面：createRedactor、logger 调用面、routes handleError、安全模型文档。
- 验证：B8 红测（raw/decoded 双形态断言）+ 基线测试先行；安全语义变更经维护者批准（红线）。
- 落位：阶段 2（执行管道）+ 阶段 1（基线测试）。

### D5 B11 双下划线反解（公开名编码歧义）
- 问题：guard 从 `mcp__<server>__<tool>` 反解用第一个 `__` 分割（middleware-register.ts L604-609），server/tool 名含连续双下划线时错位 → 禁用表查错静默失效。
- 选项：① publicToolName 加分隔符转义（映射表）；② 规格化「含 `__` 名不可逆，guard 层按未知 server 处理（不禁用不误禁）」。
- 推荐：**②**，且**不改 publicToolName/INVALID_NAME_CHARS**（`__` 在 server 名规则内合法；改名冲击官方 dsh-mcp-client 同名契约与现有工具名）；映射表列入后续增强。
- 影响面：guard 判定逻辑（middleware-register.ts handleDirectMcpGuard）、README 声明、规格文档。
- 验证：B11 红测（含 `__` server 名 → 禁用裁决与 stripMcpPrefix 反解口径一致/按未知处理）；D5 实现路径选型进阶段 0。
- 落位：阶段 0 决策 + 阶段 4 落地。

### D6 B18 超时口径统一
- 问题：中间层 CALL_TIMEOUT 固定 30s 不读 server.toolCallTimeoutMs（middleware-const.ts:22、middleware.ts L581/556）；退避硬编码 500/30000/10 忽略 server.reconnect；middleware closeHandler 不递增 failedAttempts（连上断开抖动退避恒 500ms）。
- 选项：① toolCallTimeoutMs 生效 + 保留 CALL_TIMEOUT+2s 兜底；② 照 supervisor 抄（无兜底）。
- 推荐：**① 保留兜底**（防半开双保险；与 supervisor 15s 无兜底形成「两路径超时预算不同」的既定差异——写进两路径差异面签名，同构契约测试显式排除 timeout/redact/stale 三项差异面）。
- 影响面：middleware.callTool/connectInternal/scheduleReconnect、两路径同构测试范围、limits 常量归位。
- 验证：B18 红测三断言点（退避读 server.reconnect / callTool 用 toolCallTimeoutMs / closeHandler 递增 failedAttempts）。
- 落位：阶段 2 + 阶段 3。

### D7 迁移门禁判分与基线（已闭环，改机制决策）
- 事实：mutation-gate.mjs 判 **covered** 口径（`r.coveredScore < threshold`）；gauntlet dsh-mcp-manager `baselineCovered=74.66 ≥ 60` 已达标、`strict=true`；DEVELOPMENT.md §0 同口径。「迁移互相卡死」不成立。
- 决策项（二选一，机制）：① 迁移 PR 合入当日触发 observe 夜间重建基线 + covered 回落豁免标注（`covered < baselineCovered - 1pp` 隔夜必建工单，observe-check.mjs）；② 迁移前先提 covered 分再迁移。
- 推荐：**① 重建豁免**（迁移 PR 纯搬移不夹带行为变更，covered 不应降；incremental 缓存作废属预期，重建窗口标注豁免）。
- 影响面：observe 管线、迁移 PR 验收标准、夜间工单策略。
- 验证：迁移 PR 后 observe 首夜重建基线、covered 不回落断言。
- 落位：阶段 0 决策 + 阶段 6 执行。

### D8 off 模式工具级禁用守卫
- 问题：pre-execute guard 只在 `registerMiddlewareTools` 内注册（middleware-register.ts L625-652），apply.ts L139 仅 mode≠off 调用 → off 模式 mcp__ 直呼无拦截，「工具级禁用三入口」实际一入口。
- 选项：① 补挂载（guard 与中间层实例解耦，数据源直查 manager.disabledTools，独立注册路径）；② 文档化「off 仅一入口」。
- 推荐：**① 补挂载**（三模式一致；off 模式不 initMiddleware，无连接池副作用——guard 只读禁用表）。
- 影响面：apply 装配（guard 注册移出 registerMiddlewareTools 或增加独立注册）、guard 数据源。
- 验证：off 模式 guard 红测（mcp__ 直呼命中禁用表 → deny）。
- 落位：阶段 4。

### D9 getTools 键形态（B6 同源后）
- 问题：summary().tools 是裸名（manager.ts L1153 stripMcpPrefix），getTools 现状契约是注册名（apply-services.ts L42-44 注释「返回注册名 mcp__ 前缀，勿混用两套键」）——B6 同源后必须定键。
- 选项：① 注册名（mcp__ 前缀，与 ctx.tools 注册表一致）；② 裸名（与 summary().tools 一致）。
- 推荐：**① 注册名**（保持现状 getTools 契约不变，消费方零感知；文档化两套键口径）。
- 影响面：shared 类型面注释、消费方契约。
- 验证：阶段 3 单测（getTools 返回注册名断言）。
- 落位：阶段 0 决策 + 阶段 3 实现。

---

## B. 契约缺口清单（按层，阶段 0 落成 `docs/architecture-contract.md` 素材）

> 每项：现状 → 缺口 → 目标契约 → 验证。

### B1 错误契约（横切）
- 现状：HTTP `writeJson(res, 400, {error: message})`（routes-controllers 全篇）；L07/L08 throw Error；projectCallToolResult throw Error。handleError（routes.ts L100-102）直写 message → 错误消息可能含凭据明文。
- 缺口：无「HTTP body 与日志双轨脱敏」边界；无业务错误码。
- 目标契约：声明「无业务错误码，文案即契约」；HTTP 400 body 写入前经 redactor（机制见 C2-1）；日志脱敏覆盖点全量清单。
- 验证：B8 红测 + routes 层单测（伪造含 URL 凭据错误 → body 脱敏断言）。

### B2 事件契约（状态事件层，并入连接域 orchestrator）
- 现状：summary 帧经 `manager.emitStatus()`（无参 + listeners Set + coalesce setTimeout(0)）；ui-config-changed 帧由 settings onChange 直接 `sseHub.broadcast`（apply-config.ts L94-97），**不经 emitStatus、不 coalesce**——两帧不同链。
- 缺口：两帧触发源集合/coalesce 语义/负载未契约化。
- 目标契约：summary 帧源集合（manager/supervisor/middleware/热切换）；ui-config-changed 帧源（settings onChange）保持独立链；两帧均为**零负载帧**（客户端回拉 GET）；B20=makeMiddlewareHotSwitch 补 emitStatus。
- 验证：B20 红测（热切换发 summary 帧）；事件契约文档化。

### B3 配置演进兼容
- 现状：Config schema 默认 `middleware: "project"`（config-schema.ts L117）vs McpManager 构造默认 `"off"`（manager.ts L127），实际生效由 resolveMiddlewareMode（settings 持久化值优先）决定——默认值双源。
- 缺口：演进规则未显式化。
- 目标契约：schema 默认=第一启动形态；settings 持久化值=运行权威；normalizeUiConfig 三形态=读取兼容不迁移写回（迁移写回列为后续增强）。
- 验证：resolveMiddlewareMode 单测（settings 有值/无值/非法三态）。

### B4 AbortSignal 与超时面
- 现状：supervisor execute 透传 `exec.signal`（supervisor.ts L256-261）；middleware.callTool 收 signal + withTimeout abort 竞态处理（middleware-utils.ts L568-594）；supervisor 侧无 withTimeout 层（靠 SDK timeoutMs）。
- 缺口：L08 契约未标 callTool 选项面；「统一超时」到 SDK 层还是 withTimeout 层未拍（D6 已拍：保留双保险）。
- 目标契约：`callTool(tool, args, {signal?, timeoutMs?})`；withTimeout 兜底裕量（30s+2s）语义显式化；两路径超时来源写入差异面签名。
- 验证：withTimeout abort 竞态单测；两路径契约测试差异面排除范围。

### B5 客户端-宿主 DTO 稳定性
- 缺口：未知状态策略（C13）；204 状态码备忘（C14）；SSE 帧集合显式清单；tool-disable 全名形态与 projectRoot 缺失防御（C6/C7）；`src/client/index.ts` 保留 + style.css 相对引用。
- 目标契约：summary 六态计数键集合；客户端 API 封装仅消费 JSON body（204 追加处理备忘）；SSE 三帧语义（summary/ui-config-changed/ping + 60s watchdog）。
- 验证：C13 客户端单测/实测；构建契约断言（client 产物）。

### B6 目录/归位缺口（阶段 0 目录图补全）
- middleware-const.ts → `connection/runtime/limits.ts`（执行域语义常量）；
- middleware-types.ts → `types/middleware-types.ts`（类型收敛）；
- msgOf → `pipeline/msg.ts`；
- stryker exclude `!src/types.ts` → `!src/types/**`；
- 双 execution 目录改名：连接域子目录 `runtime/`、执行管道域 `pipeline/`；
- config-schema 跨域常量（DEFAULT_ANNOUNCE_CATALOG/DEFAULT_RESULT_TRUNCATE_BYTES）→ 类型化单向 import（config→catalog/supervisor 下游）；
- catalogViewFor 迁出含私有 diskCatalogSummaryCache（mtime 缓存）→ 宿主最小面设计；
- `routes.ts:21` 组合根类型环 → 改 `types/ui.ts`。
- 验证：目录图与迁移 PR 静态面同步；gen-stryker-conf --check 绿。

---

## C. 迁移门禁策略（集中式纯搬移 PR）

### C1 静态面清单（迁移 PR 必须同步，否则必红）
| 静态面 | 现状 | 迁移动作 |
|--------|------|---------|
| test/integration/service-contract.test.ts | `readFileSync("src/bootstrap/apply-services.ts")` + marker 扫描 | 同步扫描路径到新位置（bootstrap/apply-services.ts）；阶段 1–5 该文件禁止薄转发/移动 |
| stryker.conf.d/dsh-mcp-manager-{manager,entry,supervisor,middleware,routes,runtime}.json | mutate=显式 src 文件清单 | 按新域一次性重画六段；gen-stryker-conf --check 保持 topology 三方一致 |
| scripts/data/mutation-topology.json | 段模板数据源 + workflow-assert 锚定 | 同步段定义 |
| observe 基线 | src 口径夜间全量班重建；incremental 缓存覆盖 | 迁移后重建基线（covered 回落豁免，D7） |
| bundle-host client 入口 | 探测链 src/client.tsx→…→src/client/index.ts | src/client/index.ts 保留即无感 |
| smoke/unit | 全部 import ../lib/index.js | 不受影响（验证项） |
| ~~mutate-scope-guard~~ | **已退役（#276）** | 不列入（workflow-assert 锁定不得再调用） |

### C2 迁移专用验证三件套（阶段 6 PR 验收）
1. **基线快照**：迁移前 `pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck` 全绿 + service-contract 双层锁 + 关键 smoke 断言清单逐条记录；
2. **纯移动校验**：`git diff --stat` 只含 rename/移动（除 C1 静态面同步），无内容/行为变更；
3. **迁移后全绿 + 基线重建**：全量门禁绿 + observe 首夜重建基线、covered 不回落（D7 豁免标注）。

### C3 三条阶段不变式（阶段 1–5）
1. apply-services.ts 禁止移动/薄转发（service-contract 静态扫描路径）；
2. 每阶段末全绿硬门（build/test/contract/typecheck + gen-stryker-conf --check + 关键 smoke 断言）；
3. commit 切分：「修复 commit」与「收敛 commit」分离（每 commit 可独立验证）。

### C4 stryker 段管理（拍死方案 b）
- 阶段 1–5 新建文件（pipeline/*、catalog/search.ts、workspace/* 等）**不纳入 mutate 清单**（防空段断言只查正向条目、不查 src 全覆盖 → 明示接受的变异盲区，门禁以 covered 不回落为守）；
- 阶段 6 一次性重画六段清单 + topology 三方一致；gen-stryker-conf --check 为硬门。

---

## D. 分阶段执行（0–8，B/C 全量落位速览）

| 阶段 | 交付 | 关键门禁 |
|------|------|---------|
| 0 | 本三件套 + D1–D9 拍板 + 契约文档 | issue 方案评审（needs-proposal-review → approved） |
| 1 | 测试基建（fakeTransport/fakeMCPClient 桩、unit-call-stats 双登记、createRedactor 基线）+ 配置域逻辑归位 | B2/B7/B13/B14/B17 |
| 2 | pipeline 纯函数族+薄适配（变异盲区明示）；两路径契约测试；supervisor 埋点声明 | B8/B9/B10/B18/B14 |
| 3 | 连接域逻辑收敛；B5 补调 disconnect；六态单 PR（B1+B4，C13 拍板） | B1/B4/B5/B18/B19/B20 |
| 4 | workspace 域（薄转发+全切）；guard off 补挂载 | B3/B11/D8 |
| 5 | catalog 域（search.ts、catalogViewFor 迁出） | B10/B12 |
| 6 | 集中式纯搬移 PR（三件套验收） | 静态面全同步 + 全绿 |
| 7 | 客户端分层 + C 类修复 + 哑断言清理 + 文档同步 | C1–C15/B15/B16/B19 |
| 8 | 质量收口：covered 守 observe 回落；仅 stryker 面文件按价值选择性纳入 smoke | 变异不回落 |
