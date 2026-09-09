# dsh-mcp-manager 架构契约与迁移门禁（阶段 0 定稿）

> 关联：`refactor-phase0-spec.md`（阶段 0 三件套主文档）、`architecture-redesign.md`（v3 主方案）、
> `requirements-and-tdd-plan.md`（需求规格/B 系列与 C 系列 bug 清单，已两轮纠偏）、
> `architecture-redesign-review.md`（两轮对抗性评审全文 62/100 → 78/100）。
>
> **定位**：本文档把 `refactor-phase0-spec.md` §B 契约缺口清单与 §C 迁移门禁策略正式成文，
> 作为阶段 1–8 各 PR 的验收基准。凡「契约条款」与后续实现冲突，以本文档为裁决面，改动需
> 走 issue 评审（红线流程）。
>
> **行号口径**：文中行号引用来自现状 `src/*.ts`（main 基线 `9ed7e5f`），已经两轮独立
> 对抗性评审逐行核实；阶段 6 集中式纯搬移后行号作废，但契约条款与验收断言不变。

---

## 一、契约缺口清单（按层，C-<域> 编号）

> 每条：现状 → 缺口 → 目标契约 → 验证 → 落位阶段。现状稳定面引用代码，不做重复描述。

### C-ERR 错误契约（横切）

- **现状**：HTTP `writeJson(res, 400, {error: message})`（routes-controllers 全篇）；L07/L08
  `throw Error`；`projectCallToolResult` 对 `isError` 结果 throw Error；`handleError`
  （routes.ts L100-102）直写 message——错误消息可能含凭据明文；无业务错误码。
- **缺口**：无「HTTP body 与日志双轨脱敏」边界；无业务错误码。
- **目标契约**：
  1. **声明「无业务错误码，文案即契约」**——错误文案是稳定测试面，改动须同步测试；
  2. HTTP 400 body 写入前经 redactor：`makeRoutes` 构造时注入 redactor 实例
     （`api/redactor-factory.ts` 从 manager 服务器配置构建），`handleError` 写 body 前先
     redact——HTTP body 与日志同口径脱敏；
  3. 日志脱敏覆盖点全量清单：`supervisor.ts:362` 及 manager 十余处
     `logger.warn(String(error))`（manager.ts L190/L375/L421/L449/L611/L616/L705/L744/
     L781/L820/L987 等，实施时按 src 现状核验补全，不得只修抽样）。
- **验证**：B8 红测 + routes 层单测（伪造含 URL 凭据错误 → body 脱敏断言）。
- **落位**：阶段 2（执行管道）+ 阶段 1（createRedactor 基线测试先行）。

### C-EVT 事件契约（状态事件层，并入连接域 orchestrator）

- **现状**：summary 帧经 `manager.emitStatus()`（无参 + listeners Set + coalesce
  `setTimeout(0)`）；ui-config-changed 帧由 settings onChange 直接
  `sseHub.broadcast`（apply-config.ts L86-95，broadcast 在 L88）——**不经 emitStatus、
  不 coalesce**，两帧不同链。
- **缺口**：两帧触发源集合 / coalesce 语义 / 负载未契约化。
- **目标契约**：
  1. **summary 帧源集合** = {manager 状态变更（emitStatus 现有调用面）、supervisor
     setStatus、middleware 连接态变化、热切换}；B20 修复 = `makeMiddlewareHotSwitch`
     补 emitStatus（现状缺失，与客户端 C10 同根）；
  2. **ui-config-changed 帧源** = {settings onChange}，保持独立链（不经 emitStatus、
     不 coalesce）；
  3. **两帧均为零负载帧**——客户端收到后回拉 GET /servers（summary）或 GET /config
     （ui-config-changed），帧本身不携带负载。
- **验证**：B20 红测（热切换后收到 summary 帧）；事件契约本文件文档化。
- **落位**：阶段 3。

### C-CFG 配置演进兼容

- **现状**：Config schema 默认 `middleware: "project"`（config-schema.ts L117）vs
  McpManager 构造默认 `"off"`（manager.ts L127）；实际生效由 `resolveMiddlewareMode`
  （settings 持久化值优先）决定——默认值双源。
- **缺口**：演进规则未显式化。
- **目标契约**：
  1. schema 默认 = **第一启动形态**（新用户首启 project）；
  2. settings 持久化值 = **运行权威**（存在即覆盖 schema 默认）；
  3. `normalizeUiConfig` 三形态 = **读取兼容、不迁移写回**（迁移写回列为后续增强，
     不入本重构范围）；
  4. 双源并存是演进需要——任一单方改动必须同步本契约口径，禁止「改一处留一处」。
- **验证**：`resolveMiddlewareMode` 单测三态（settings 有值 / 无值 / 非法回落 off）。
- **落位**：阶段 1（配置域逻辑归位时，不动文件）。

### C-ABT AbortSignal 与超时面

- **现状**：supervisor execute 透传 `exec.signal`（supervisor.ts L256-261）；middleware
  `callTool` 收 signal + withTimeout abort 竞态处理（middleware-utils.ts L568-594）；
  supervisor 侧无 withTimeout 层（靠 SDK timeoutMs）。
- **缺口**：L08 契约未标 callTool 选项面；「统一超时」到 SDK 层还是 withTimeout 层未拍
  （D6 已拍：保留双保险）。
- **目标契约**：
  1. `callTool(tool, args, {signal?, timeoutMs?})` 选项面进入契约；
  2. withTimeout 兜底裕量语义显式化：中间层超时预算 =
     `server.toolCallTimeoutMs ?? CALL_TIMEOUT(30s)`，`+2s` 为半开双保险兜底；
  3. **两路径超时来源写入差异面签名**：supervisor = SDK timeoutMs（无兜底）vs
     middleware = withTimeout（有兜底）——同构契约测试显式排除
     timeout/redact/stale 三项差异面。
- **验证**：withTimeout abort 竞态单测；两路径契约测试差异面排除范围断言。
- **落位**：阶段 2（执行管道）+ 阶段 3（连接域）。

### C-DTO 客户端-宿主 DTO 稳定性

- **缺口**：未知状态策略（C13）；204 状态码备忘（C14）；SSE 帧集合显式清单；
  tool-disable 全名形态与 projectRoot 缺失防御（C6/C7）；`src/client/index.ts` 保留 +
  style.css 相对引用。
- **目标契约**：
  1. **summary 六态计数键集合** = {connected, connecting, reconnecting, disabled,
     stopped, failed}（`reconnecting` 由 D1 补入，service-contract 类型面已含；
     **客户端未知状态策略 C13：阶段 3 与 B1/B4 单 PR 拍板，实现留阶段 7**）；
  2. 客户端 API 封装**仅消费 JSON body**（204 追加处理备忘 C14，未来新增 204 路由时
     dom.ts api 不得静默 undefined）；
  3. **SSE 帧集合** = {summary, ui-config-changed, ping} + 客户端 60s watchdog 自愈三防线
     （语义见 requirements-and-tdd-plan.md F4-3）；
  4. tool-disable 全名形态 = `@@global/<name>` 或 `@<绝对路径>/<name>`，与宿主
     `parseFullServerName` 归一化一致；**projectRoot 缺失时防御性不提交非法 `@/name`**
     （C6），浮窗 connect/enable/disable 操作带 cwd（C7，与 servers.ts 对齐）；
  5. `src/client/index.ts` 保留为 build-client 契约锚点；style.css 相对引用路径随
     阶段 7 目录分层确定并同步。
- **验证**：C13 客户端单测/隔离浏览器实测；构建契约断言（client 产物）；C6/C7
  dsh-verify-isolated 实测。
- **落位**：阶段 3（拍板）+ 阶段 7（实现）。

### C-DIR 目录/归位缺口（阶段 6 集中迁移的静态面输入）

| 现状 | 目标位置 | 说明 |
|------|---------|------|
| middleware-const.ts | `connection/runtime/limits.ts` | 执行域语义常量 |
| middleware-types.ts | `types/middleware-types.ts` | 类型收敛（ProjectUnit/ConnectionEntry/CatalogTool 等） |
| msgOf | `pipeline/msg.ts` | 执行管道域归属 |
| stryker exclude 缺 | `!src/types/**` | host-faces/middleware-types 不收变异 |
| 双 execution 目录 | 连接域 `runtime/`、执行管道 `pipeline/` | 消除双 execution 歧义 |
| config-schema 跨域常量 | catalog/supervisor 域类型化单向 import | DEFAULT_ANNOUNCE_CATALOG / DEFAULT_RESULT_TRUNCATE_BYTES，保持 config→下游单向 |
| catalogViewFor 私有缓存 | catalog 域（宿主最小面） | diskCatalogSummaryCache（mtime 缓存）随迁，薄桥接或最小面 host（阶段 5 先行） |
| routes.ts:21 组合根类型环 | 改从 `types/ui.ts` 取 | 消除 `import type { ClientUiConfig } from "./index.ts"` 环 |

- **验证**：目录图与迁移 PR 静态面同步；`gen-stryker-conf --check` 绿。
- **落位**：阶段 6（集中搬移）；catalogViewFor 条目阶段 5 先行。

---

## 二、迁移门禁策略（定稿）

### 2.1 静态面清单（迁移 PR 必须同步，否则必红）

| 静态面 | 现状 | 迁移动作 |
|--------|------|---------|
| test/service-contract.test.ts | L146 `readFileSync("src/apply-services.ts")` + L149 marker 扫描 | 同步扫描路径到新位置（bootstrap/apply-services.ts）；**阶段 1–5 该文件禁止薄转发/移动** |
| stryker.conf.d/dsh-mcp-manager-{manager,entry,supervisor,middleware,routes,runtime}.json | mutate=显式 src 文件清单 | 按新域一次性重画六段；gen-stryker-conf --check 保持 topology 三方一致 |
| scripts/data/mutation-topology.json | 段模板数据源 + workflow-assert 锚定 | 同步段定义 |
| observe 基线 | src 口径四班次重建；incremental 缓存覆盖 | 迁移后重建基线（covered 回落豁免，见 2.5） |
| bundle-host client 入口 | 探测链 src/client.tsx→…→src/client/index.ts | src/client/index.ts 保留即无感 |
| smoke/unit | 全部 import ../lib/index.js | 不受影响（验证项） |
| ~~mutate-scope-guard~~ | **已退役（#276）** | 不列入（workflow-assert 锁定不得再调用） |

### 2.2 迁移专用验证三件套（阶段 6 PR 验收）

1. **基线快照**：迁移前 `pnpm build && pnpm test && pnpm contract && pnpm pack:check &&
   pnpm typecheck` 全绿 + service-contract 双层锁 + 关键 smoke 断言清单逐条记录；
2. **纯移动校验**：`git diff --stat` 只含 rename/移动（除 2.1 静态面同步），无内容/行为变更；
3. **迁移后全绿 + 基线重建**：全量门禁绿 + observe 首夜重建基线、covered 不回落（2.5 豁免标注）。

### 2.3 三条阶段不变式（阶段 1–5 全程）

1. **apply-services.ts 禁止移动/薄转发**（test/service-contract.test.ts:146 硬编码
   `src/apply-services.ts` 静态扫描，动了必红）；
2. **每阶段末全绿硬门**：`pnpm build && pnpm test && pnpm contract && pnpm pack:check &&
   pnpm typecheck` + `gen-stryker-conf --check` + 关键 smoke 断言清单；
3. **commit 切分**：「修复 commit」与「收敛 commit」分离，每 commit 可独立验证。

### 2.4 stryker 段管理（拍死方案 b）

- 阶段 1–5 新建文件（`pipeline/*`、`catalog/search.ts`、`workspace/*` 等）**一律不纳入
  既有六段 mutate 清单**——空段断言只查正向条目、不查 src 全覆盖，故该阶段属
  **明示接受的变异盲区**，门禁以 covered 不回落为守（防空段断言误红）；
- 阶段 6 集中迁移时一次性重画六段清单 + topology 三方一致；`gen-stryker-conf --check`
  为硬门。

### 2.5 covered 回落判据（D7 机制决策定稿）

- **基线**：gauntlet dsh-mcp-manager `baselineCovered = 74.66%`（≥60 达标、strict=true；
  mutation-gate.mjs 判 **covered** 口径）。
- **日常守则**：`covered < baselineCovered − 1pp`（即 < 73.66%）视为回落，隔夜
  observe-check.mjs 必建工单；修复后按新基线续守。
- **迁移 PR 豁免**：incremental 缓存作废属预期（缓存含旧路径），迁移 PR 合入当日触发
  observe 夜间重建基线并标注豁免——纯搬移零行为变更，covered 不应因路径变化而判降。

---

## 三、规格决策定稿表（D1–D9）

> 详解（问题/选项/技术依据/影响面/验证）见 `refactor-phase0-spec.md` §A；本表为定稿决议。

| # | 决策项 | 定稿结论 | 阶段落位 |
|---|--------|---------|---------|
| D1 | B1+B4 重连状态 | **补 `reconnecting` 状态机**（六态一致；B1+B4 宿主端 + C13 客户端策略拍板单 PR，C13 实现留阶段 7） | 3 + 7 |
| D2 | B5 清理契约 | **start 保持同步**；替换分支补调 `void existing.disconnect()`（syncChain FIFO 保证旧清理先于新注册）；manager.connect L1011-1017 同修 | 3 |
| D3 | B6 getTools 查询面 | **与 summary 同源**（中间层接管的服务器也返回工具）；键形态见 D9 | 3 |
| D4 | B8 脱敏口径（安全红线） | **仅用户信息脱敏** + raw/decoded 双形态注册（防 percent-encoding 绕过）+ 日志脱敏全覆盖 + API redactor 注入面 + README 安全模型更新 | 1（基线）+ 2 |
| D5 | B11 双下划线反解 | **规格化不可逆**：含 `__` 名按未知 server 处理（不禁用不误禁）；**不改 publicToolName/INVALID_NAME_CHARS**（防冲击官方 `mcp__` 契约）；映射表列入后续增强 | 0 决策 + 4 落地 |
| D6 | B18 超时口径 | **toolCallTimeoutMs 生效 + 保留 CALL_TIMEOUT+2s 兜底**（防半开双保险）；两路径差异面签名显式排除 timeout/redact/stale | 2 + 3 |
| D7 | 迁移门禁判分 | **机制决策**：covered 口径已达标（74.66≥60）；迁移 PR 走 observe 夜间重建豁免；日常守 `covered ≥ baseline−1pp`（见 2.5） | 0 决策 + 6 执行 |
| D8 | off 模式 guard | **补挂载**：guard 与中间层实例解耦、数据源直查 manager.disabledTools、独立注册路径（三模式一致；off 无连接池副作用，guard 只读禁用表） | 4 |
| D9 | getTools 键形态 | **注册名（`mcp__` 前缀，与 ctx.tools 注册表一致）**；文档化两套键口径（summary().tools=裸名） | 0 决策 + 3 实现 |

---

## 四、阶段 0 完成定义（验收标准）

1. 本文档成文，且与 `refactor-phase0-spec.md` / `architecture-redesign.md`（v3）无矛盾
   （契约条款为裁决面，冲突以本文档为准并回改规格）；
2. D1–D9 全部定稿，无 open 决策项（issue #664 已 `approved`，无维护者异议）；
3. 门禁全绿：`pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck`
   + `gen-stryker-conf --check`；
4. PR 关联 issue #664，CI 绿后请求合并（squash）。
