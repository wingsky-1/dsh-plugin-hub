# 宿主契约面清单

本仓插件集依赖上游宿主（dsh）的契约面登记：`inject` 覆盖的是服务级存在性，
本清单登记 `inject` 覆盖不到的那一层（事件 / 字段与载荷 / slot / 路由与方法 / 复刻常量与版本锚 /
宿主服务面类型锚与豁免）。
表 1–7 的单元格由派生回填：事实源是 [派生脚本](../scripts/derive/host-contract.mjs) 的实时输出（只读打印，默认输出完整派生 JSON，`--sample` 只输出 sample 节）。
本文不手写任何事件名 / slot key / 路由 / 方法 / 常量值；单元格与派生输出不一致时以派生输出为准。
**表 8 例外**：类型锚与豁免是人工核对登记（证据 = 各包 src 的 `import type` 与 package.json 的
catalog devDep/peer），派生脚本不扫描类型面，故该表不由派生回填。

复核命令（仓库根执行）：

```sh
node scripts/derive/host-contract.mjs
node scripts/derive/host-contract.mjs --sample
pnpm docs:check
```

前两条为只读观察（默认输出完整派生 JSON，`--sample` 只输出 sample 节，不写文件、不接门禁）；
第三条校验本文的相对链接 / 锚点 / 命令引用。判据由结构门禁（实施中）与上游消解门禁（规格评审中，名称以落地为准）承担，命令与 exit code 见表 7。两套 R 编号含义不同，不可混读：结构门禁的 R1–R4 指事件 / 路由字面量 / slot / 复刻值分组，上游消解 warn 的 R1 / R2-cordis / R4-lite 指服务 / 事件 / 方法存在性。

rc 升级流程引用：升级 dsh rc 时按本清单逐条核对上游变更（事件删改 / slot 语义 / 路由与方法 / 常量重排），
并与 `dsh-verify-isolated` 的真实宿主 smoke 呼应。
`dsh-upgrade` skill 的 S1 / S3 接线（按本清单路径逐条核对）门禁接线为后续工作，不属本清单。

派生覆盖面（诚实声明）：派生的扫描文件清单见派生脚本内扫描常量（`eventFiles` / `slotFiles` / `routeFiles` / `domFiles`）。
未被扫描文件覆盖的包在各表内记“派生未覆盖”并给出全仓 grep 观察值与出处，不静默缺席；
也不把观察值写成派生值。`dsh-plugins-all` 为聚合包（无 `src/`），各表均写明不适用理由。

`inject` 面标注为已核实覆盖（表 3），口径差异：`peerDependencies` 是类型面（含 cordis 框架底座与仅经事件消费的包），
`export const inject` 是运行面（`apply` 实际经 `ctx` 取用的服务）。两者差集不是缺口，是口径不同。

跨端共享归属（§2.4 定稿）与本清单的关系：本清单只登记“依赖了上游什么”，共享分档见 [DEVELOPMENT §2.4](./DEVELOPMENT.md)。

## 目录

- [表 1 包一览](#hc-t1)
- [表 2 宿主事件](#hc-t2)
- [表 3 inject 值](#hc-t3)
- [表 4 slot key 与形态](#hc-t4)
- [表 5 路由与方法白名单](#hc-t5)
- [表 6 复刻常量与版本锚](#hc-t6)
- [表 7 来源与断言](#hc-t7)
- [表 8 宿主服务面类型锚与豁免](#hc-t8)

<a id="hc-t1"></a>
## 表 1 包一览

| 包 | 角色 | 宿主入口 | 客户端面 | 派生覆盖 |
| --- | --- | --- | --- | --- |
| dsh-lan-proxy | 宿主 + 客户端 | `src/index.ts` | `src/client/index.ts` | 事件 0 条（`ctx.on` 全包 0 命中）；slot 1 条；路由 4 条 |
| dsh-mcp-manager | 宿主 + 客户端 | `src/index.ts` | `src/client/index.ts` | 事件 6 条；slot 1 条；路由 11 条 |
| dsh-notifier | 宿主 + 客户端 | `src/index.ts` | `src/client/index.tsx` | 事件 7 条；slot 1 条；路由 8 条 |
| dsh-plugins-all | 聚合包 | 无 `src/`（仅 README / patch / package.json / build.ts） | 无 | 不适用：聚合包自身无运行时契约面，其契约面 = 被聚合包的并集 |
| dsh-provider-usage | 宿主 + 客户端 | `src/apply/index.ts`（组合根） | `src/client/index.tsx` | 事件 4 条；slot 1 条；路由 16 条 |
| dsh-verify-isolated | 隔离验证宿主（skill） | `src/index.ts`（仅此一个 `src` 文件） | 无 | 事件 / slot / 路由均为 0（无客户端面，无 inject 面） |

<a id="hc-t2"></a>
## 表 2 宿主事件

形态均为“事件”（`inject` 无法声明，fail-loud 审计覆盖不到）。出处为派生输出 `result.events[*].sites`。

| 包 | 事件名 | 出处 |
| --- | --- | --- |
| dsh-notifier | approval/request | packages/dsh-notifier/src/index.ts |
| dsh-notifier | user-questions/request | packages/dsh-notifier/src/index.ts |
| dsh-notifier | session/event | packages/dsh-notifier/src/index.ts |
| dsh-notifier | agent/status | packages/dsh-notifier/src/index.ts |
| dsh-notifier | agent/disposed | packages/dsh-notifier/src/index.ts |
| dsh-notifier | agent/turn-stopping | packages/dsh-notifier/src/index.ts |
| dsh-notifier | agent/error | packages/dsh-notifier/src/index.ts |
| dsh-mcp-manager | agent/pre-step | packages/dsh-mcp-manager/src/index.ts，packages/dsh-mcp-manager/src/server/shared/compose.ts（能力面转发） |
| dsh-mcp-manager | system-prompt/assemble | packages/dsh-mcp-manager/src/index.ts（能力面转发） |
| dsh-mcp-manager | tools/pre-execute | packages/dsh-mcp-manager/src/server/inject/middleware-register.ts |
| dsh-mcp-manager | agent/created | packages/dsh-mcp-manager/src/server/shared/compose.ts（能力面转发） |
| dsh-mcp-manager | agent/disposed | packages/dsh-mcp-manager/src/server/shared/compose.ts（能力面转发） |
| dsh-mcp-manager | tools/change | packages/dsh-mcp-manager/src/server/shared/compose.ts（能力面转发） |
| dsh-provider-usage | session/event | packages/dsh-provider-usage/src/apply/apply.ts（唯一目标 runtime `0.2.1-rc.2` 的结算事实源） |
| dsh-provider-usage | session/flush | packages/dsh-provider-usage/src/apply/apply.ts |
| dsh-provider-usage | session/disposed | packages/dsh-provider-usage/src/apply/apply.ts |
| dsh-provider-usage | internal/service | packages/dsh-provider-usage/src/apply/apply.ts |
| dsh-lan-proxy | （无，派生 0 条） | 全包 `ctx.on` 0 命中 |
| dsh-verify-isolated | （无，观察值：全包 `ctx.on` 0 命中） | `eventFiles` 未登记 |
| dsh-plugins-all | （不适用，聚合包） | 无 `src/` |

<a id="hc-t3"></a>
## 表 3 inject 值

形态均为“服务存在性”（fail-loud 审计覆盖面）。本表值取自各包 `export const inject` 字面量（运行面基线）；
peer 列为各包 `package.json` 的 `@deepseek-ai/*` peer（类型面）。差集为口径差异，非缺口：
peer 含 cordis 框架底座与仅经 `ctx.on` 事件消费的包（如 notifier 的 agent / session / session-title / settings / user-approval / user-questions），
运行面只登记 `apply` 实际取用的 `ctx` 服务。

| 包 | 端 | inject 值 | peer（@deepseek-ai/*） | 出处 |
| --- | --- | --- | --- | --- |
| dsh-lan-proxy | 宿主 | webServer | cordis， dsh-host-webserver， dsh-client-ui-slots， dsh-client-locale， dsh-client-ui-renderer， dsh-client-ui-settings， dsh-client-ui-plugin-manager | | packages/dsh-lan-proxy/src/index.ts:38 |
| dsh-lan-proxy | 客户端 | slots， configForms， locale， remote | （同上） | | packages/dsh-lan-proxy/src/client/index.ts |
| dsh-mcp-manager | 宿主 | tools， webServer， systemPrompt | cordis， dsh-host-webserver， dsh-agent， dsh-tools， dsh-system-prompt， dsh-client-ui-slots， dsh-llm， dsh-api-session-controller， dsh-client-ui-session， dsh-client-store， dsh-client-locale， dsh-client-ui-renderer， dsh-client-ui-settings， dsh-client-ui-plugin-manager | | packages/dsh-mcp-manager/src/index.ts |
| dsh-mcp-manager | 客户端 | sessions， slots， configForms， locale | （同上） | | packages/dsh-mcp-manager/src/client/index.ts |
| dsh-notifier | 宿主 | webServer， settings（经 `SETTINGS_SERVICE` 常量，`src/index.ts:35`） | cordis， dsh-agent， dsh-host-webserver， dsh-session， dsh-session-title， dsh-settings， dsh-user-approval， dsh-user-questions， dsh-client-ui-slots， dsh-client-locale， dsh-client-ui-renderer | | packages/dsh-notifier/src/index.ts:44 |
| dsh-notifier | 客户端 | slots， locale | （同上） | | packages/dsh-notifier/src/client/index.tsx:1849 |
| dsh-provider-usage | 宿主 | webServer， llm， sessions（`src/apply/index.ts:115`） | cordis， dsh-host-webserver， dsh-llm， dsh-session， dsh-client-ui-slots， dsh-api-session-controller， dsh-client-ui-session | | packages/dsh-provider-usage/src/apply/index.ts:115 |
| dsh-provider-usage | 客户端 | locale， sessions， remote， remote.session， slots | （同上） | | packages/dsh-provider-usage/src/client/index.tsx:828 |
| dsh-verify-isolated | 宿主 | （无服务访问） | dsh-skill-filesystem | | packages/dsh-verify-isolated/src 下无 `export const inject` |
| dsh-verify-isolated | 客户端 | （无客户端面） | （同上） | | （同上） |
| dsh-plugins-all | 宿主 | （不适用，聚合包） | （无 peer） | | 无 `src/` |
| dsh-plugins-all | 客户端 | （不适用，聚合包） | （无 peer） | | 无 `src/` |

<a id="hc-t4"></a>
## 表 4 slot key 与形态

形态为 slot。目标 runtime 的插件设置行统一注册 `plugins.row.config`：canonical row id
同时是 settings namespace，key 由 bundle package 与 row id 组成；独立设置页使用
`settings.section` 的 id / order。

| 包 | slot | id（插件行取 canonical row id） | key | order | 出处 |
| --- | --- | --- | --- | --- | --- |
| dsh-lan-proxy | plugins.row.config | dsh-lan-proxy | `@wingsky-1/dsh-lan-proxy#dsh-lan-proxy` | — | packages/dsh-lan-proxy/src/client/index.ts |
| dsh-mcp-manager | plugins.row.config | dsh-mcp-manager | `@wingsky-1/dsh-mcp-manager#dsh-mcp-manager` | — | packages/dsh-mcp-manager/src/client/index.ts；packages/dsh-mcp-manager/src/shared/constants.ts |
| dsh-notifier | settings.section | dsh-notifier | — | 70 | packages/dsh-notifier/src/client/index.tsx |
| dsh-provider-usage | settings.section | dsh-provider-usage | — | 90 | packages/dsh-provider-usage/src/client/index.tsx |
| dsh-verify-isolated | （无客户端面） | — | — | — | `slotFiles` 未登记 |
| dsh-plugins-all | （不适用，聚合包） | — | — | — | 无 `src/` |

<a id="hc-t5"></a>
## 表 5 路由与方法白名单

形态为路由（本仓暴露面）与方法白名单（`guardLoopbackMethod` / 端点 `methods` 表：非回环 403、白名单外 405，403 先于 405）。
路由出来自派生输出 `result.routes.paths`（39 条）；方法白名单为各路由处理函数处的字面量（mcp-manager 以 `src/shared/routes.ts` 的 `ROUTE_FENCE` 为准）。

| 路由 | 包 | 方法白名单 | 出处 |
| --- | --- | --- | --- |
| /api/dsh-lan-proxy/health | dsh-lan-proxy | GET | `src/server/apply.ts:527` |
| /api/dsh-lan-proxy/config | dsh-lan-proxy | GET， PUT | `src/server/config/impl/routes.ts:218` |
| /api/dsh-lan-proxy/ca-cert | dsh-lan-proxy | GET | `src/server/config/impl/routes.ts:313` |
| /api/dsh-lan-proxy/ca/generate | dsh-lan-proxy | POST | `src/server/ca/impl/actions.ts:202` |
| /api/dsh-mcp/servers | dsh-mcp-manager | GET， POST， PATCH， DELETE | `src/shared/routes.ts` `ROUTE_FENCE.servers` |
| /api/dsh-mcp/config | dsh-mcp-manager | POST（GET 为 loopback 豁免只读） | `src/shared/routes.ts` `ROUTE_FENCE.config` |
| /api/dsh-mcp/session | dsh-mcp-manager | POST | `src/shared/routes.ts` `ROUTE_FENCE.session` |
| /api/dsh-mcp/resume | dsh-mcp-manager | POST | `src/shared/routes.ts` `ROUTE_FENCE.resume` |
| /api/dsh-mcp/servers/connect | dsh-mcp-manager | POST | `src/shared/routes.ts` `ROUTE_FENCE.connect` |
| /api/dsh-mcp/servers/disconnect | dsh-mcp-manager | POST | `src/shared/routes.ts` `ROUTE_FENCE.disconnect` |
| /api/dsh-mcp/servers/reconnect | dsh-mcp-manager | POST | `src/shared/routes.ts` `ROUTE_FENCE.reconnect` |
| /api/dsh-mcp/import/json | dsh-mcp-manager | POST | `src/shared/routes.ts` `ROUTE_FENCE.importJson` |
| /api/dsh-mcp/events | dsh-mcp-manager | GET（SSE） | `src/shared/routes.ts` `ROUTE_FENCE.events` |
| /api/dsh-mcp/health | dsh-mcp-manager | GET | `src/shared/routes.ts` `ROUTE_FENCE.health` |
| /api/dsh-mcp/tool-disable | dsh-mcp-manager | PATCH | `src/shared/routes.ts` `ROUTE_FENCE.toolDisable` |
| /api/dsh-provider-usage/stats | dsh-provider-usage | GET | `src/server/data-routes/stats.ts:19` |
| /api/dsh-provider-usage/history | dsh-provider-usage | GET | `src/server/data-routes/stats.ts:64` |
| /api/dsh-provider-usage/trend | dsh-provider-usage | GET | `src/server/ui-routes/trend.ts:38` |
| /api/dsh-provider-usage/adapters.json | dsh-provider-usage | GET | `src/server/data-routes/adapters.ts:43` |
| /api/dsh-provider-usage/adapters/select | dsh-provider-usage | POST | `src/server/data-routes/adapters.ts:83` |
| /api/dsh-provider-usage/adapters/inspect | dsh-provider-usage | POST | `src/server/data-routes/adapters.ts:120` |
| /api/dsh-provider-usage/adapters/add | dsh-provider-usage | POST | `src/server/data-routes/adapters.ts:157` |
| /api/dsh-provider-usage/health | dsh-provider-usage | GET | `src/server/ui-routes/health.ts:19` |
| /api/dsh-provider-usage/ui-config | dsh-provider-usage | GET， POST | `src/server/ui-routes/ui-config.ts:23` |
| /api/dsh-provider-usage/events | dsh-provider-usage | GET（SSE） | `src/server/ui-routes/events.ts:18` |
| /api/dsh-provider-usage/report-config | dsh-provider-usage | GET， POST | `src/server/report-routes/reports.ts:111`（`handleReportConfig`，装配表 351 行） |
| /api/dsh-provider-usage/report-models | dsh-provider-usage | GET | `src/server/report-routes/reports.ts:186`（装配表 356 行） |
| /api/dsh-provider-usage/reports | dsh-provider-usage | GET | `src/server/report-routes/reports.ts:233`（装配表 361 行） |
| /api/dsh-provider-usage/reports/detail | dsh-provider-usage | GET | `src/server/report-routes/reports.ts:243`（装配表 366 行） |
| /api/dsh-provider-usage/reports/generate | dsh-provider-usage | POST | `src/server/report-routes/reports.ts:280`（装配表 371 行） |
| /api/dsh-provider-usage/reports/generate/status | dsh-provider-usage | GET | `src/server/report-routes/reports.ts:320`（装配表 376 行） |
| /api/dsh-notifier/config | dsh-notifier | GET， PUT | `src/server/api/impl/service/index.ts:39`（端点 `methods` 表） |
| /api/dsh-notifier/history | dsh-notifier | GET， DELETE | `src/server/api/impl/service/index.ts:40`（端点 `methods` 表） |
| /api/dsh-notifier/status | dsh-notifier | GET | `src/server/api/impl/service/index.ts:41`（端点 `methods` 表） |
| /api/dsh-notifier/kinds | dsh-notifier | GET， POST | `src/server/api/impl/service/index.ts:42`（端点 `methods` 表） |
| /api/dsh-notifier/test | dsh-notifier | POST | `src/server/api/impl/service/index.ts:43`（端点 `methods` 表） |
| /api/dsh-notifier/health | dsh-notifier | GET | `src/server/api/impl/service/index.ts:44`（端点 `methods` 表） |
| /api/dsh-notifier/diagnostics | dsh-notifier | GET | `src/server/api/impl/service/index.ts:45`（端点 `methods` 表） |
| /api/dsh-notifier/events | dsh-notifier | GET（SSE） | `src/server/api/impl/service/index.ts:48-50`（端点 `methods` 表，经 `streamHub`） |
| （dsh-verify-isolated 无路由） | dsh-verify-isolated | — | `routeFiles` 未登记，全包 `/api/dsh-` 0 命中 |
| （dsh-plugins-all 不适用） | dsh-plugins-all | — | 无 `src/` |

注册形态：lan-proxy 经 `ctx.webServer.register`（`src/server/apply.ts`）；mcp-manager 经 `ctx.webServer.register`（`src/index.ts`）；
provider-usage 经 `ctx.webServer.register`（`src/apply/apply.ts`）；notifier 经端点表 + `registerEndpoints`（组合根转交 `RegisterRoute`窄面，见各包 `route.ts` / `service/index.ts`）。前者即派生输出 `result.routes.registerSites`。

<a id="hc-t6"></a>
## 表 6 复刻常量与版本锚

形态为常量（本仓复刻或钉死的官方约定）与版本锚（升级比对基线）。值全部来自派生输出。

| 常量 / 锚 | 值 | 形态 | 出处与断言 |
| --- | --- | --- | --- |
| MCP_SECTION_ORDER | 160 | 常量 | `packages/dsh-mcp-manager/src/index.ts:562`；语义“紧随部署 persona 之后、计划策略之前（0 小于 160 小于 500）”，`sectionCall=true`（843 行经 `ctx.systemPrompt` 调用），`orderRangeOk=true`；区间由 smoke 锁定 |
| SESSION 结算口径 | 唯一目标 runtime `0.2.1-rc.2` 的事实源为 `ctx.on("session/event")`；`assistant/chunk` 已删，`assistant/message`（内嵌 stream）+ `assistant/attempt` 为结算信号 | 版本锚 | 派生自注释口径；`SESSION_FORMAT_VERSION` 无代码符号锚（仅存档文档提及 0→3），`collectorMentionsChunkRemoval=false` |
| 当前会话判据 | `retainedBy.mainView > 0`（rc.2 起会话列表快照**无** `current` 字段） | 常量（#1028） | 官方自用判据：写入方是 `dsh-client-ui-workspace` 的 `retain(target,{source:"mainView"})`，读取方遍布 `dsh-client-ui-session` / `ui-workspace` / `ui-layout` 等官方包；本仓经 `packages/dsh-mcp-manager/src/client/core/current-session.ts` 单一接缝消费，并以官方类型锚定：`SessionSummary.retainedBy.mainView` 走类型化访问（上游改名即 TS2339 判红，见该文件的副作用式类型导入）。**非承诺公开 API**：`mainView` 由 `dsh-client-ui-session` 声明合并注入 `SessionReferenceSourceMap`，退路＝跟随官方演进，必要时向上游提 issue 索取「当前会话」面 |
| catalog 锁版 | `dsh-*` 23 个均为 `0.2.1-rc.2`，`@deepseek-ai/cordis` 独立为 `4.0.5` | 版本锚 | [pnpm-workspace.yaml](../pnpm-workspace.yaml) 字面量派生（派生输出 `result.catalog`，24 项）；唯一目标 runtime 之外的版本不在支持范围 |
| 官方地址复刻 | （无现存复刻：全包 `dsh-resource://` / `fileAddressFor` 0 命中，已随 dsh-web-file-preview 退役消除） | 常量 | 全仓 grep 观察值 |
| DOM 锚（11 条） | `details.dm-float-tools`；`[data-conversation-scroll]`；`[data-pane="conversation"]`；`.pI_x6G_centerCol`；`[data-shell-overlay]`；`[data-composer-seat]`；`.${PILL_PREFIX}label`；`.${PILL_PREFIX}dot` | 版本锚（宿主 DOM 私有约定，无版本锚） | 派生输出 `result.domAnchors`：前 6 条出自 `packages/dsh-mcp-manager/src/client/float/float.ts`，后 5 条出自 `packages/dsh-provider-usage/src/client/index.tsx`（`[data-composer-seat]` 等 3 条两端共用）；宿主改壳即静默漂移 |

<a id="hc-t7"></a>
## 表 7 来源与断言

| # | 来源 / 断言 | 值 |
| --- | --- | --- |
| 1 | 派生脚本 | `scripts/derive/host-contract.mjs`（零依赖，仅 `node:fs` / `node:path`；只读打印，默认输出完整派生 JSON，`--sample` 只输出 sample 节） |
| 2 | 派生输出 | 派生脚本默认 stdout 的完整派生 JSON（`--sample` 只输出 sample 节）；不落盘，不接门禁 |
| 3 | 扫描文件清单 | 见派生脚本内扫描常量：`eventFiles` 4 包 8 文件；`slotFiles` 4 文件；`routeFiles` 6 文件；`domFiles` 2 文件；`catalogFile=pnpm-workspace.yaml`；SESSION 口径以当前实现为准 |
| 4 | 派生观察 | `node scripts/derive/host-contract.mjs` 与 `--sample` 均为只读打印（不写文件、不接门禁） |
| 5 | 文档门禁 | `pnpm docs:check` → exit 0（本 PR 内实跑） |
| 6 | 缺口 G1（方法语义） | MCP_SECTION_ORDER=160 为字面量（`orderRangeOk=true`，`sectionCall=true`）；官方 SECTION_ORDERS 在本仓无符号级锚，宿主重排只能靠 smoke 区间断言事后发现 |
| 7 | 缺口 G2（载荷版本） | SESSION_FORMAT_VERSION 无代码符号锚；`assistant/message` 内嵌 stream / attempt 的字段级载荷版本无类型快照可派生 |
| 8 | 缺口 G3（slot 协议） | `plugins.row.config` 的 canonical row id / bundle key 与 `settings.section` 的 label thunk 语义由当前实现和客户端产物断言；其它 runtime 不在本清单支持范围 |
| 9 | 缺口 G4（DOM 锚） | 11 条选择器均为宿主 DOM 私有约定，无版本锚；派生只能列出当前在用 |
| 10 | 缺口 G5（类型版本锚） | **已落地部分**：settings / llm / sessions / webServer / agents / configForms / slots / locale 八条服务面已按表 8 锚到官方 catalog 类型（settings 经 shared 的 `HostSettings*` 锚、lan-proxy / notifier / provider-usage 消费；llm / agents 由 provider-usage / mcp-manager 锚定）；**仍缺**：credentials / attachments / loader / sessionProjections 无对应官方 catalog 类型包（表 8 豁免），且锚只覆盖本仓实际消费的最小面——未消费的方法/字段上游改名仍不可见。历史破坏点（`Session.fromRestore` 第 5 参、`EpochHeader.system` 删除）仍只活在存档文档里 |
| 11 | 验证状态 | `pnpm gate:pr` exit 0；真实 DSH 0.1.7-rc.2 隔离 profile（本轮锁版 0.2.1-rc.2 后尚未重跑真机隔离验证）已加载 7 个插件，核验了 settings late-attach、LAN 端口热更新（39181/39182，`listening: true`）、MCP/用量入口、LAN health/root 与 390px 窄视口；隔离 profile 无 workspace/session，worktree Files 的会话级操作仍需有 workspace 的样本 |

<a id="hc-t8"></a>
## 表 8 宿主服务面类型锚与豁免

形态为**类型锚**：能被本仓 `import type` 的官方 catalog 类型就锚定（上游改字段/签名即在本仓
tsc 期判红）；官方没有 catalog 类型包的登记豁免，写明理由与出处，不把自持形状伪装成官方契约。
直接 `import type` 官方包的锚，要求该包在消费包 `package.json` 的 devDependencies 以
`catalog:` 登记、peer 与 `scripts/data/plugins-manifest.json` 合同一致（`#1164`）；
经 shared 再导出的锚（settings）由 shared 持有官方 devDep，消费包只依赖 shared。
豁免不改任何运行时语义。

| # | 服务面 | 端 | 类型锚（官方包 / 类型）或豁免 | 状态 | 出处与断言 |
| --- | --- | --- | --- | --- | --- |
| 1 | settings | 宿主 | anchor：`@deepseek-ai/dsh-settings` 的 `SettingsForms` / `SettingsDescriptor` / `SettingsDescribeOptions`；lan-proxy 经 shared 的 `HostSettingsService` / `HostSettingsDescriptor` / `HostSettingsDescribeOptions` 再导出，provider-usage 的 seam 直接 `import type SettingsForms`（内部类型，不进入公开面） | 已锚定（#1164 WP1 + WP3） | `shared/settings-namespace.ts`；`packages/dsh-provider-usage/src/server/registry/provider-config.ts`；`packages/dsh-lan-proxy/src/server/config/impl/namespace.ts`；`packages/dsh-notifier/src/server/upgrade/impl/legacy/type.ts:2`（官方 import type，既有） |
| 2 | credentials | 宿主 | exempt：catalog 无官方 credentials 包（0.2.1-rc.2 未发布类型层），只能经 settings seam 服务面注入 + 消费点自持最小形状 | 豁免（待上游发布官方类型包后改回锚定） | `pnpm-workspace.yaml` catalog 无 credentials 键；`packages/dsh-provider-usage/src/server/registry/provider-config.ts`（#1164 WP3：settings 面已从 `SettingsForms` 派生；credentials 保留 duck，方法存在性由 `seamDiagnosticOf` 运行时守） |
| 3 | llm | 宿主 | anchor：`@deepseek-ai/dsh-llm` 的 `LlmRuntime`（`Context["llm"]` 声明合并）；mcp-manager 的 `ModelInfoPort = Pick<Context["llm"], "resolveModelInfo">` | 已锚定（provider-usage 的目录面经 `Context["llm"]` 派生；mcp-manager 晚读 `ctx.get("llm")` 但形状以官方为唯一来源，#1164 WP3 + WP4） | `packages/dsh-provider-usage/src/apply/apply.ts:203`、`src/server/report-routes/reports.ts`；`packages/dsh-mcp-manager/src/server/shared/host-faces.ts:67-74` |
| 4 | sessions | 宿主 + 客户端 | anchor：宿主 `@deepseek-ai/dsh-session` 的 `SessionStore`（`Context["sessions"]`）；客户端 `@deepseek-ai/dsh-api-session-controller` 的 `ISessions`（`client` 入口） | 已锚定 | `packages/dsh-provider-usage/src/apply/apply.ts:454`、`src/client/index.tsx:26`；`packages/dsh-mcp-manager/src/client/core/state.ts:15` |
| 5 | webServer | 宿主 | anchor：`@deepseek-ai/dsh-host-webserver` 的 `WebServer`（`Context["webServer"]`） | 已锚定 | 四包 `export const inject`（表 3）；lan-proxy `src/server/apply.ts`；mcp-manager `src/server/shared/host-faces.ts:78` |
| 6 | agents | 宿主 | anchor：`@deepseek-ai/dsh-agent` 的 `AgentRegistry`（`Context["agents"]`）；mcp-manager 的 `AgentFace` 从 `ReturnType<Context["agents"]["list"]>[number]` 派生，只取 `id` + `Pick<Agent["ctx"]["tools"], "restrict">` | 已锚定（不把整服务递给域，#1164 WP4） | `packages/dsh-mcp-manager/src/server/shared/host-faces.ts:76-93`；`packages/dsh-notifier/src/server/events/interface.ts:14` |
| 7 | attachments | 宿主 | exempt：官方类型在 `@deepseek-ai/dsh-attachment`（提供方 `dsh-attachment-local`），该包不在 catalog、非本包直接依赖，pnpm 严格布局下 `import type` 不可解析；服务晚读（`ctx.get("attachments")`），自持 `AttachmentsPort` 只声明 `saveImages`。退出条件：进 catalog 后改回 `import type` | 豁免 | `packages/dsh-mcp-manager/src/server/shared/host-faces.ts:54-65`；`pnpm-workspace.yaml` catalog 无该键 |
| 8 | loader | 宿主 | exempt：服务面所有者是 `@deepseek-ai/cordis-plugin-loader`（`ctx.loader`），该包不在 catalog、不可解析（`Pick<Context, "loader">` 直接 tsc 红）；运行时经 `ctx.get("loader")` 现取，自持 `LoaderPort` 只保留 `load` / `mount`。退出条件：进 catalog 且服务面进 `Context` 后改回官方类型 | 豁免 | `packages/dsh-mcp-manager/src/server/shared/host-faces.ts:219-236`、`src/server/shared/compose.ts`（`ctx.get("loader")` 接线） |
| 9 | sessionProjections | 宿主 | exempt：官方 `@deepseek-ai/dsh-session-projection` / `@deepseek-ai/dsh-working-directory` 不在 catalog、实测不可解析（硬引判 tsc 红）；自持 `SessionProjectionsPort` 只收 `stateOf`——要**原始可空投影**，不用官方 `get()` 的 cwd 兜底。退出条件：锁版后改回 `import type` | 豁免 | `packages/dsh-mcp-manager/src/server/shared/host-faces.ts:238-259`、`src/server/shared/compose.ts`（`ctx.get("sessionProjections")` 接线） |
| 10 | configForms | 客户端 | anchor：`@deepseek-ai/dsh-client-ui-settings` 的 `ConfigForms`（客户端 `Context["configForms"]`） | 已锚定 | `packages/dsh-lan-proxy/src/client/index.ts:53`；`packages/dsh-mcp-manager/src/client/index.ts:58` |
| 11 | slots | 客户端 | anchor：`@deepseek-ai/dsh-client-ui-renderer` 的 `SlotRegistry`（客户端 `Context["slots"]`）——注意服务声明在 renderer 包，`dsh-client-ui-slots` 只提供 SlotMap / slot 契约原语 | 已锚定 | `packages/dsh-lan-proxy/src/client/index.ts:52`；`packages/dsh-notifier/src/client/index.tsx:112`；`packages/dsh-mcp-manager/src/client/core/state.ts:17` |
| 12 | locale | 客户端 | anchor：`@deepseek-ai/dsh-client-locale` 的 `LocaleRuntime`（客户端 `Context["locale"]`） | 已锚定 | lan-proxy `src/client/index.ts:54`；notifier `src/client/index.tsx:111`；mcp-manager `src/client/core/state.ts:16`；provider-usage `src/client/index.tsx:28` |

锚只覆盖本仓实际消费的最小面：未消费的方法/字段上游改名或改型仍不可见（同表 7 G5）。
豁免项一旦上游发布对应官方类型包，应先加 catalog 锁版、再改回 `import type` 锚定，并更新本表。

共享分档的规范正文见 [DEVELOPMENT §2.4](./DEVELOPMENT.md)；跨包共享准入见 [shared/README.md](../shared/README.md)。
