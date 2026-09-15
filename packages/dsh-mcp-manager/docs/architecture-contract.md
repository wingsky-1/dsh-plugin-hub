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

> ## 【B0 打标：三分类裁定】（#767 本轮追加，2026-09-14）
>
> **状态**：本文档是 **#664（上一轮 P0–P8 分阶段重构）** 的契约与门禁策略，**已被 `architecture-redesign-v5.md` 取代**为裁决面。本轮不改写正文，只按 §8.5 的三分类**逐节打标**；**正文的结构性合并与归档由 B2/B3 执行**。
>
> **B2b 落地后的订正（2026-09-15，#767）**：本句原先说的「B2 删除 `bootstrap/` 与 `McpManager` 时同步」**只完成了一半**——`src/bootstrap/` 六文件已并入入口（W11a `48a4866`），`src/` 顶层也已随 B2b 收敛为 `client / server / shared / index.ts`（W11b1 `f9acc28` + W11b2a `56d01ac`），但 **`McpManager` 未删**：它的去留与「入口导出面 159 → ≤5」是同一处公开 API 红线，**维护者尚未裁决，本轮按默认 C 只登记、不动手**（见 v5 附录 H·H.4 与 §十三 遗留 ⑫）。故**正文的结构性合并与归档仍未执行**，等该裁决与 B3 一并收口；在此之前引用本文档仍以第 16 行起的三分类表为准。
>
> **图例**：**保留** = 行为契约，仍有效、不作废；**作废** = 阶段划分/目录形态/已被取代的机制表述，随本轮批次映射失效；**重述** = 结论方向仍在，但**表述与现状或本轮口径不符，必须按 v5 重写**后才可继续引用。
>
> | # | 小节 | 裁定 | 依据 / 需要怎么改 |
> |---|---|---|---|
> | 1 | **一、C-ERR 错误契约** | **保留 + 局部作废** | 「错误文案即契约」「body 与日志同口径脱敏」「日志脱敏全量覆盖」**保留**（并入 v5 §6）；但第 2 条声称的实现点 `api/redactor-factory.ts` **不存在**（V1 端到端实测：`src/api/` 零 `createRedactor` 命中、`handleError` 直写 `error.message`）→ **该条作废**；「落位阶段 2+1」→ **B2** |
> | 2 | **一、C-EVT 事件契约** | **保留** | 两帧源集合 / `ui-config-changed` 独立链不 coalesce / **两帧零负载**——即 v5 §5.2 与 §10.1 保留项 ③；「落位阶段 3」→ **B2** |
> | 3 | **一、C-CFG 配置演进兼容** | **保留** | schema 默认 = 首启形态、settings 持久化值 = 运行权威、三形态**读取兼容不迁移写回**、双源并存纪律——并入 v5 `config` 域边界 |
> | 4 | **一、C-ABT AbortSignal 与超时面** | **保留** | `callTool` 选项面、`+2s` 半开兜底、「两路径差异面（timeout/redact/stale）显式排除」——并入 v5 §6.2 ⑧ 的两路径同构探针 |
> | 5 | **一、C-DTO 客户端-宿主 DTO** | **重述** | 六态键集合 / SSE 帧集合 / tool-disable 全名形态 `@@global/<name>`、`@<root>/<name>` **保留**（且 v5 §6.1 纪律 3 正是复用该地址形态）；但「DTO 集中 `types/`」**改**：跨端 DTO 归 `src/shared/`（D5）、域内形状归各域 `interface.ts`，`types` 域**解体**（v5 §0.1 第 16 条）。C13/C6/C7/C2 四条「实现回改」保留为事实记录 |
> | 6 | **一、C-DIR 目录/归位缺口表** | **整表作废** | 目标位置是上一轮形态，本轮目标树见 v5 §3.1；其中「每目录 `interface.ts`（D10）」这一**门禁**保留并加强（I2/I4），但门面清单改为 `server/<11 域>` + `server/shared` + `src/shared` = **13 个** |
> | 7 | **二 2.1 静态面清单** | **局部作废** | `service-contract.test.ts` 那条「阶段 1–5 禁止移动 `apply-services.ts`」**作废**（该文件与测试在 B2 一并重写/删除）；stryker 段与 `mutation-topology` 条目**保留**（B0 已按超集更新） |
> | 8 | **二 2.2 迁移专用验证三件套** | **保留** | 基线快照 / 纯移动校验（只有 rename）/ 迁移后全绿 + 基线重建——v5 §10.3 的 A/B/C 分级是它的加强版 |
> | 9 | **二 2.3 三条阶段不变式** | **第 1 条作废，第 2 条重述，第 3 条保留** | ① 随 `apply-services.ts` 消失而作废；② 验收命令改为 `pnpm gate:pr` 全仓口径（`pnpm contract` 已并入）；③「修复 commit 与收敛 commit 分离」保留 |
> | 10 | **二 2.4 stryker 段管理（拍死方案 b）** | **作废** | 该节的「阶段 1–5 新建文件不纳入 mutate = 明示接受的变异盲区」**已被 B0 取代**：新树路径已在 mutate 超集内（`cd44c90`），不再有盲区 |
> | 11 | **二 2.5 covered 回落判据** | **重述** | 方向（迁移 PR 走夜间重建豁免、日常守 `≥ baseline−1pp`）**保留**；但 `baselineCovered = 74.66%` / `strict=true` / 「`mutation-gate` 判 covered」这组表述**与现状不符**——覆盖率阈值事实源是 `scripts/data/coverage.config.json`（降线由 `threshold-monotonic` 拦），变异与 CRAP 阈值在 `gauntlet.config.json` |
> | 12 | **三 3.1 三层定义表（T1/T2/T3）** | **重述（重点）** | T1 那句「断言经 `lib/index.js` re-export 或目录 `interface.ts`」**正是 v5 §二 I8 判定为反模式的写法**，必须按 §8.1 重写：单元层**白盒直连 `src/server/<域>/impl/<块>/`**；契约层 = 域 `interface.ts` + `deps.ts` + 跨端线协议；集成层 = 包产物入口 + `apply()`；并补 v5 新增的**组合根层**与**客户端层** |
> | 13 | **三 3.2 各层纪律** | **重述 + 保留** | T1 纪律随上条重述；「运行面零登记 / 变异面需登记 `testFiles`」**重述**——本包 topology 现在用的是 `coverageExcludes` + `testMutationExemptions`，**没有 `testFiles` 清单**；`--min` 需随新增文件同步上调**保留** |
> | 14 | **三 3.3 变异分层** | **重述** | 「阶段 6 重画六段」的阶段语义作废（本轮 B0 超集 + B2 按域重画）；且本节「**interface.ts 纳入 mutate**」与 B0 落地的 facade 排除条**方向相反**——本轮裁定：门面**整体退出**变异面、B2 按域重画时逐条复核（理由见 v5 §8.3） |
> | 15 | **四、规格决策定稿表 D1–D10** | **保留（决策本身），阶段落位列作废** | D1/D2/D5/D6/D8 的行为决策保留；**D3 + D9**（`getTools` 与 summary 同源、键形态 = 注册名 `mcp__<server>__<tool>`）被 v5 **D4 / §10.1 保留项 ⑥ 原样继承**；**D4**（脱敏口径）被 v5 **§6 取代并加强**（8 类出口 × 载体矩阵 + 唯一投影出口）；**D7** 见上条 2.5；**D10** 保留并加强（I2/I4） |
> | 16 | **五、阶段 0 完成定义** | **作废** | 阶段 0 早已完成；验收命令口径已变（见 2.3） |
>
> **本轮不做的**：不改写上述正文（B3 合并归档时统一处理）；不删任何仍在被引用的门禁条款。**引用本文档时以本表裁定为准**：标「作废」的小节不得作为本轮验收依据，标「重述」的小节须先按 v5 改写再引用。

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
     redact——HTTP body 与日志同口径脱敏。
     **【B0 打标：作废——已证伪】**该实现不存在：实测 `src/api/` 零 `createRedactor` 命中（无 `api/redactor-factory.ts`），`handleError`（`routes.ts:59-60`）直写 `error.message`，400 body 会回显请求体里的凭据明文（端到端复现：`invalid url: ht tp://user:s3cr3t@host/mcp`）。本轮替代条款 = v5 §6.2 ①⑦（唯一投影出口 + 校验期不回显原值）；
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
- **实现回改（阶段 7 落地）**：C13 未知状态按 stopped 投影已实现（servers 列表与
  float 浮窗统一，见 src/client/float/servers.ts renderServers）；C6/C7
  toolDisableServerKey/cwdQueryOf helper 已实现（src/client/core/api.ts）；C14 204
  备忘注释随 core/api.ts；C2 轮询探测恢复已实现（startPolling 每 5 周期
  tryResumeEvents，README「状态推送自愈」同步）；C-DTO-1/2/3/4 与实现无差异。
- **目标契约**：
  1. **summary 六态计数键集合** = {connected, connecting, reconnecting, disabled,
     stopped, failed}（`reconnecting` 由 D1 补入，service-contract 类型面已含；
     **客户端未知状态策略 C13 已拍板（阶段 3，与 B1/B4 同 PR）：未知状态按
     `stopped` 投影、不丢卡**——servers 列表与 float 浮窗统一口径，消除
     servers.ts 静默丢卡 vs float.ts 塞 stopped 的两处不一致；实现留阶段 7）；
  2. 客户端 API 封装**仅消费 JSON body**（204 追加处理备忘 C14，未来新增 204 路由时
     dom.ts api 不得静默 undefined）；
  3. **SSE 帧集合** = {summary, ui-config-changed, ping} + 客户端 60s watchdog 自愈三防线
     （语义见 requirements-and-tdd-plan.md F4-3）；**C2 增强（阶段 7）：SSE 降级
     10s 轮询不是永久退役，每 5 个轮询周期（50s）探测重建 EventSource，成功即
     退出轮询——页面失联自愈**；
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
| 每目录 `interface.ts`（D10） | 各物理目录根 | 目录唯一对外引用面（re-export 对外类型+函数）；跨目录引用只能走 interface.ts、禁直引实现文件；DTO 仍集中 types/；`verify-dir-imports.mjs` 静态强制（已接入门禁，执行点在 ci.yml 的 repo-gate 直接步骤与本地档位计划）；阶段 2 起新目录即带、阶段 6 存量补齐 |

- **验证**：目录图与迁移 PR 静态面同步；`gen-stryker-conf --check` 绿。
- **落位**：阶段 6（集中搬移）；catalogViewFor 条目阶段 5 先行。

---

## 二、迁移门禁策略（定稿）

### 2.1 静态面清单（迁移 PR 必须同步，否则必红）

| 静态面 | 现状 | 迁移动作 |
|--------|------|---------|
| test/integration/service-contract.test.ts | `readFileSync("src/bootstrap/apply-services.ts")` + marker 扫描 | 同步扫描路径到新位置（bootstrap/apply-services.ts）；**阶段 1–5 该文件禁止薄转发/移动** |
| stryker.conf.d/dsh-mcp-manager-{manager,entry,supervisor,middleware,routes,runtime}.json | mutate=显式 src 文件清单 | 按新域一次性重画六段；gen-stryker-conf --check 保持 topology 三方一致 |
| scripts/data/mutation-topology.json | 段模板数据源 + workflow-assert 锚定 | 同步段定义 |
| observe 基线 | src 口径夜间全量班重建；incremental 缓存覆盖 | 迁移后重建基线（covered 回落豁免，见 2.5） |
| bundle-host client 入口 | 探测链 src/client.tsx→…→src/client/index.ts | src/client/index.ts 保留即无感 |
| smoke/unit | 全部 import ../lib/index.js | 不受影响（验证项） |
| ~~mutate-scope-guard~~ | **已退役（#276）** | 不列入（workflow-assert 锁定不得再调用） |

### 2.2 迁移专用验证三件套（阶段 6 PR 验收）

1. **基线快照**：迁移前 `pnpm build && pnpm test && pnpm contract && pnpm pack:check &&
   pnpm typecheck` 全绿 + service-contract 双层锁 + 关键 smoke 断言清单逐条记录；
2. **纯移动校验**：`git diff --stat` 只含 rename/移动（除 2.1 静态面同步），无内容/行为变更；
3. **迁移后全绿 + 基线重建**：全量门禁绿 + observe 首夜重建基线、covered 不回落（2.5 豁免标注）。

### 2.3 三条阶段不变式（阶段 1–5 全程）

1. **apply-services.ts 禁止移动/薄转发**（test/integration/service-contract.test.ts 硬编码
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

## 三、测试分层（T1 / T2 / T3 + 变异分层）

> 维护者决策（issue #664 评论 5602626656），阶段 3 起执行；本文档为裁决面。
> 分层的动机：单测断言一律落「契约面」而非「实现细节」——重构（阶段 3/4/5/6）只
> 搬文件不搬契约，测试不因纯移动而碎。

### 3.1 三层定义与归属

| 层 | 定义 | 断言面 | 现状归属（阶段 3 基线） | 示例 |
|----|------|--------|------------------------|------|
| **T1 层内单元** | 每目录内部逻辑自测，不跨目录直引 | 模块公开符号（经 lib/index.js re-export 或目录 interface.ts） | unit-* 各文件（normalize/store/transport/supervisor 内部逻辑、pipeline 纯函数族等） | resolveReconnect 全分支、truncateText 字节边界、withTimeout abort 竞态 |
| **T2 interface 层间** | 经目录 interface.ts 的跨层契约 | 目录门面（类型 + 函数签名与行为契约）；verify-dir-imports 静态强制 + 本层动态契约 | 两路径同构契约（supervisor 直呼 vs ws_mcp_call 同构断言）为首例 | B18 两路径退避/超时口径、两路径差异面（timeout/redact/stale）显式排除 |
| **T3 user-case 集成** | 按用户场景端到端 | HTTP 路由 + SSE 帧 + ctx 工具注册面（不 mock 宿主装配链） | routes/apply/SSE hub 用例、smoke SDK 端到端 | ws_mcp_call 全链路、SSE summary 推送、tool-disable 三入口一致、热切换补帧 |

分层不设硬比例门槛：T1 密度最高（纯函数红利），T2/T3 按契约风险投放；任何一层
不得因「已有低层测试」而省略其契约面断言。

### 3.2 各层纪律

- **T1**：不跨目录直引实现文件；断言只走目录 interface.ts 或 lib/index.js 的公共
  re-export 面。重构搬移文件时 T1 断言零改动（import 面不变）。
- **T2**：跨层契约经 interface.ts 落断言；静态（verify-dir-imports）与动态（行为
  契约测试）双轨。两路径同构契约的差异面签名（timeout 来源 / redact / stale）为
  显式排除项，不得移除差异面声明（C-ABT/D6）。
- **T3**：防 flake 纪律（DEVELOPMENT.md §5）全量生效——mkdtempSync 隔离落盘、
  pollUntil/assertNoGrowth 替代固定 sleep；SSE 帧断言按帧序轮询而非计时。
- **新测试文件登记**（#690 S2 起）：**运行面零登记**——测试入口是 `test/**/*.test.ts`
  glob，新文件放对目录即自动纳入 `pnpm test`（`smoke.ts` import 聚合入口已删除）。
  **变异面仍需登记** `mutation-topology.json` 的 `testFiles`：该清单是策展的单元级
  用例集，不随 glob 自动扩大——实测整包纳入 e2e/契约类会让 Stryker dry run 超时
  （dsh-mcp-manager 5 个段）或在沙箱内失败（`smoke.test.ts` 的 provide 方法面断言），
  见 #713（防三通道不对称扩大，requirements-and-tdd-plan.md 8.3-P0④）。
  各包 `package.json` 的 `--min <文件数下限>` 也须随新增文件同步上调：该下限只用于
  封堵零匹配/漏跑，不会自动跟随新增，忘记上调会让新文件落在保护面之外。

### 3.3 变异分层（阶段 6 重画 mutate 的依据）

- 阶段 6 一次性重画六段 mutate 清单时按层标注：T1 覆盖目录内部逻辑段、
  T2 覆盖 interface.ts 与跨层契约段、T3 覆盖装配/路由段；
- **interface.ts 纳入 mutate**：删除任一 re-export → T2 契约测试必红
  （门面即契约，门面断裂不得被变异存活掩盖）；
- 阶段 1–5 新建目录的变异盲区维持 2.4 过渡态（明示接受，covered 不回落为守），
  阶段 6 与 mutate 重画一并清零。

---

## 四、规格决策定稿表（D1–D9）

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
| D10 | 目录解耦形态（维护者追加） | **严格门面**：每物理目录一个 `interface.ts`（对外类型+函数唯一引用面）；跨目录引用只能走 interface.ts、禁直引实现文件；DTO 仍集中 `types/`；`verify-dir-imports.mjs` 静态强制接入门禁（已接入门禁，执行点在 ci.yml 的 repo-gate 直接步骤与本地档位计划）；阶段 2 起新目录即带、阶段 6 存量补齐（细则见 C-DIR） | 2 起生效 + 6 补齐 |

---

## 五、阶段 0 完成定义（验收标准）

1. 本文档成文，且与 `refactor-phase0-spec.md` / `architecture-redesign.md`（v3）无矛盾
   （契约条款为裁决面，冲突以本文档为准并回改规格）；
2. D1–D10 全部定稿，无 open 决策项（issue #664 已 `approved`；D10 由维护者现场拍板）；
3. 门禁全绿：`pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck`
   + `gen-stryker-conf --check`；
4. PR 关联 issue #664，CI 绿后请求合并（squash）。
