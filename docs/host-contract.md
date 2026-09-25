# 宿主契约面清单

本仓插件集依赖上游宿主（dsh）的契约面登记：`inject` 覆盖的是服务级存在性，
本清单登记 `inject` 覆盖不到的那一层（事件 / 字段与载荷 / slot / 路由与方法 / 复刻常量与版本锚）。
全部单元格由派生回填：事实源是 [派生脚本](../scripts/derive/host-contract.mjs) 的实时输出（只读打印，默认输出完整派生 JSON，`--sample` 只输出 sample 节）。
本文不手写任何事件名 / slot key / 路由 / 方法 / 常量值；单元格与派生输出不一致时以派生输出为准。

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

<a id="hc-t1"></a>
## 表 1 包一览

| 包 | 角色 | 宿主入口 | 客户端面 | 派生覆盖 |
| --- | --- | --- | --- | --- |
| dsh-decision-gateway | 宿主 + 客户端 | `src/index.ts` | `src/client/index.ts` | 事件 0 条（`eventFiles` 未登记；全仓 `ctx.on` 字面量 0 命中）；路由 5 条在 `src/shared/contract.ts`（`routeFiles` 未登记，见表 5 未覆盖行） |
| dsh-lan-proxy | 宿主 + 客户端 | `src/index.ts` | `src/client/index.ts` | 事件 0 条（`ctx.on` 全包 0 命中）；slot 1 条；路由 4 条 |
| dsh-mcp-manager | 宿主 + 客户端 | `src/index.ts` | `src/client/index.ts` | 事件 6 条；slot 1 条；路由 11 条 |
| dsh-notifier | 宿主 + 客户端 | `src/index.ts` | `src/client/index.tsx` | 事件 7 条；slot 1 条；路由 8 条 |
| dsh-plugins-all | 聚合包 | 无 `src/`（仅 README / patch / package.json / build.ts） | 无 | 不适用：聚合包自身无运行时契约面，其契约面 = 被聚合包的并集 |
| dsh-provider-usage | 宿主 + 客户端 | `src/apply/index.ts`（组合根） | `src/client/index.tsx` | 事件 4 条；slot 1 条；路由 16 条 |
| dsh-verify-isolated | 隔离验证宿主（skill） | `src/index.ts`（仅此一个 `src` 文件） | 无 | 事件 / slot / 路由均为 0（无客户端面，无 inject 面） |
| dsh-worktree-sidebar | 宿主 + 客户端 | `src/index.ts` | `src/client/index.ts` | 事件字面量 0 条（仅 `src/index.ts:63` 转发放行 `ctx.on(event, handler)`，无字面量事件名）；路由 2 条在 `src/shared/contract.ts`（`routeFiles` 未登记，见表 5 未覆盖行） |

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
| dsh-provider-usage | session/event | packages/dsh-provider-usage/src/apply/apply.ts（唯一目标 runtime `0.1.7-rc.2` 的结算事实源） |
| dsh-provider-usage | session/flush | packages/dsh-provider-usage/src/apply/apply.ts |
| dsh-provider-usage | session/disposed | packages/dsh-provider-usage/src/apply/apply.ts |
| dsh-provider-usage | internal/service | packages/dsh-provider-usage/src/apply/apply.ts |
| dsh-lan-proxy | （无，派生 0 条） | 全包 `ctx.on` 0 命中 |
| dsh-decision-gateway | （派生未覆盖，观察值：全包 `ctx.on` 0 命中） | `eventFiles` 未登记 |
| dsh-worktree-sidebar | （派生未覆盖，观察值：仅转发放行，无字面量事件名） | packages/dsh-worktree-sidebar/src/index.ts:63 |
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
| dsh-decision-gateway | 宿主 | webServer， tools | cordis， dsh-host-webserver， dsh-tools | | packages/dsh-decision-gateway/src/index.ts:32 |
| dsh-decision-gateway | 客户端 | slots | （同上） | | packages/dsh-decision-gateway/src/client/index.ts:210 |
| dsh-lan-proxy | 宿主 | webServer | cordis， dsh-host-webserver | | packages/dsh-lan-proxy/src/index.ts:38 |
| dsh-lan-proxy | 客户端 | slots， configForms， locale， remote | （同上） | | packages/dsh-lan-proxy/src/client/index.ts |
| dsh-mcp-manager | 宿主 | tools， webServer， systemPrompt | cordis， dsh-host-webserver， dsh-agent， dsh-tools， dsh-system-prompt | | packages/dsh-mcp-manager/src/index.ts |
| dsh-mcp-manager | 客户端 | sessions， slots， configForms， locale | （同上） | | packages/dsh-mcp-manager/src/client/index.ts |
| dsh-notifier | 宿主 | webServer， settings（经 `SETTINGS_SERVICE` 常量，`src/index.ts:35`） | cordis， dsh-agent， dsh-host-webserver， dsh-session， dsh-session-title， dsh-settings， dsh-user-approval， dsh-user-questions | | packages/dsh-notifier/src/index.ts:44 |
| dsh-notifier | 客户端 | slots， locale | （同上） | | packages/dsh-notifier/src/client/index.tsx:1849 |
| dsh-provider-usage | 宿主 | webServer， llm， sessions（`src/apply/index.ts:115`） | cordis， dsh-host-webserver， dsh-llm， dsh-session | | packages/dsh-provider-usage/src/apply/index.ts:115 |
| dsh-provider-usage | 客户端 | locale， sessions， remote， remote.session， slots | （同上） | | packages/dsh-provider-usage/src/client/index.tsx:828 |
| dsh-worktree-sidebar | 宿主 | webServer， agents， typert， sessions | cordis， dsh-agent， dsh-api-workspace-files， dsh-host-webserver， dsh-tools， dsh-typert-protocol | | packages/dsh-worktree-sidebar/src/index.ts:39 |
| dsh-worktree-sidebar | 客户端 | slots， sidebarRightTabs， sessions， locale | （同上） | | packages/dsh-worktree-sidebar/src/client/index.ts:133 |
| dsh-verify-isolated | 宿主 | （无服务访问） | dsh-skill-filesystem（类型面） | | packages/dsh-verify-isolated/src 下无 `export const inject` |
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
| dsh-lan-proxy | plugins.row.config | ui-dsh-lan-proxy | `@wingsky-1/dsh-lan-proxy#ui-dsh-lan-proxy` | — | packages/dsh-lan-proxy/src/client/index.ts |
| dsh-mcp-manager | plugins.row.config | ui-dsh-mcp-manager | `@wingsky-1/dsh-mcp-manager#ui-dsh-mcp-manager` | — | packages/dsh-mcp-manager/src/client/index.ts；packages/dsh-mcp-manager/src/shared/constants.ts |
| dsh-notifier | settings.section | dsh-notifier | — | 70 | packages/dsh-notifier/src/client/index.tsx |
| dsh-provider-usage | settings.section | dsh-provider-usage | — | 90 | packages/dsh-provider-usage/src/client/index.tsx |
| dsh-decision-gateway | （派生未覆盖，观察值：客户端未注册 settings slot） | — | — | — | `slotFiles` 未登记 |
| dsh-worktree-sidebar | （派生未覆盖，观察值：客户端消费 slots 与 sidebarRightTabs，未注册 settings slot） | — | — | — | `slotFiles` 未登记 |
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
| /api/dsh-notifier/config | dsh-notifier | GET， PUT | `src/server/api/impl/service/index.ts:32`（端点 `methods` 表） |
| /api/dsh-notifier/history | dsh-notifier | GET， DELETE | `src/server/api/impl/service/index.ts:33`（端点 `methods` 表） |
| /api/dsh-notifier/status | dsh-notifier | GET | `src/server/api/impl/service/index.ts:34`（端点 `methods` 表） |
| /api/dsh-notifier/kinds | dsh-notifier | GET， POST | `src/server/api/impl/service/index.ts:35`（端点 `methods` 表） |
| /api/dsh-notifier/test | dsh-notifier | POST | `src/server/api/impl/service/index.ts:36`（端点 `methods` 表） |
| /api/dsh-notifier/health | dsh-notifier | GET | `src/server/api/impl/service/index.ts:37`（端点 `methods` 表） |
| /api/dsh-notifier/diagnostics | dsh-notifier | GET | `src/server/api/impl/service/index.ts:38`（端点 `methods` 表） |
| /api/dsh-notifier/events | dsh-notifier | GET（SSE） | `src/server/api/impl/service/index.ts:41-42`（端点 `methods` 表，经 `streamHub`） |
| /api/dsh-decision-gateway/health | dsh-decision-gateway | GET | （派生未覆盖）`src/server/api/impl/handlers.ts:69`，路由定义 `src/shared/contract.ts:33` |
| /api/dsh-decision-gateway/config | dsh-decision-gateway | GET， PUT | （派生未覆盖）`src/server/api/impl/handlers.ts:81`，路由定义 `src/shared/contract.ts:34` |
| /api/dsh-decision-gateway/presets | dsh-decision-gateway | GET | （派生未覆盖）`src/server/api/impl/handlers.ts:111`，路由定义 `src/shared/contract.ts:35` |
| /api/dsh-decision-gateway/history | dsh-decision-gateway | GET， DELETE | （派生未覆盖）`src/server/api/impl/handlers.ts:119`，路由定义 `src/shared/contract.ts:36` |
| /api/dsh-decision-gateway/test-connection | dsh-decision-gateway | POST | （派生未覆盖）`src/server/api/impl/handlers.ts:151`，路由定义 `src/shared/contract.ts:37` |
| /api/dsh-worktree-sidebar/bindings | dsh-worktree-sidebar | GET（只读，查询带自愈副作用） | （派生未覆盖）路由定义 `src/shared/contract.ts:14`，围栏 `src/server/api/impl/route/index.ts:41`（`Object.keys(endpoint.methods)`） |
| /api/dsh-worktree-sidebar/health | dsh-worktree-sidebar | GET | （派生未覆盖）路由定义 `src/shared/contract.ts:15`，围栏同上 |
| （dsh-verify-isolated 无路由） | dsh-verify-isolated | — | `routeFiles` 未登记，全包 `/api/dsh-` 0 命中 |
| （dsh-plugins-all 不适用） | dsh-plugins-all | — | 无 `src/` |

注册形态：lan-proxy 经 `ctx.webServer.register`（`src/server/apply.ts`）；mcp-manager 经 `ctx.webServer.register`（`src/index.ts`）；
provider-usage 经 `ctx.webServer.register`（`src/apply/apply.ts`）；notifier / decision-gateway / worktree-sidebar 经端点表 + `registerEndpoints`（组合根转交 `RegisterRoute`窄面，见各包 `route.ts` / `service/index.ts`）。前三者即派生输出 `result.routes.registerSites`。

<a id="hc-t6"></a>
## 表 6 复刻常量与版本锚

形态为常量（本仓复刻或钉死的官方约定）与版本锚（升级比对基线）。值全部来自派生输出。

| 常量 / 锚 | 值 | 形态 | 出处与断言 |
| --- | --- | --- | --- |
| MCP_SECTION_ORDER | 160 | 常量 | `packages/dsh-mcp-manager/src/index.ts:562`；语义“紧随部署 persona 之后、计划策略之前（0 小于 160 小于 500）”，`sectionCall=true`（843 行经 `ctx.systemPrompt` 调用），`orderRangeOk=true`；区间由 smoke 锁定 |
| SESSION 结算口径 | 唯一目标 runtime `0.1.7-rc.2` 的事实源为 `ctx.on("session/event")`；`assistant/chunk` 已删，`assistant/message`（内嵌 stream）+ `assistant/attempt` 为结算信号 | 版本锚 | 派生自注释口径；`SESSION_FORMAT_VERSION` 无代码符号锚（仅存档文档提及 0→3），`collectorMentionsChunkRemoval=false` |
| catalog 锁版 | `dsh-*` 17 个均为 `0.1.7-rc.2`，`@deepseek-ai/cordis` 独立为 `4.0.4` | 版本锚 | [pnpm-workspace.yaml](../pnpm-workspace.yaml) 字面量派生（派生输出 `result.catalog`，18 项）；唯一目标 runtime 之外的版本不在支持范围 |
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
| 10 | 缺口 G5（类型版本锚） | 锁版只是期望版本；`Session.fromRestore` 第 5 参与 `EpochHeader.system` 删除等破坏点只活在存档文档里 |
| 11 | 验证状态 | `pnpm gate:pr` exit 0；真实 DSH 0.1.7-rc.2 隔离 profile 已加载 7 个插件，核验了 settings late-attach、LAN 端口热更新（39181/39182，`listening: true`）、MCP/用量入口、LAN health/root 与 390px 窄视口；隔离 profile 无 workspace/session，worktree Files 的会话级操作仍需有 workspace 的样本 |

共享分档的规范正文见 [DEVELOPMENT §2.4](./DEVELOPMENT.md)；跨包共享准入见 [shared/README.md](../shared/README.md)。
