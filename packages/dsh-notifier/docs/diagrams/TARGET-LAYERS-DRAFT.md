# dsh-notifier 目标分层 · 职责与契约草案（v2，含层边界证据）

> 依据：源码证据（行号见各节）+ 用户四问（依赖方/被依赖方/前后端/后端主链）+ 用户三点细化。

## 层清单与职责

| 层 | 职责（做什么 / 不做什么） | 现状代码映射 | 关键证据 |
|---|---|---|---|
| SDK 契约层 | 对外插件稳定 API：registerKind/confirmKind/listKinds/send；sent 订阅 | service.ts:440-505 + ~~service.d.ts~~（**已由 #733 M2a 删除**，声明合并现写在 `src/index.ts`）+ index.ts:230-232（**本表行号为 v2 草案时点，重构后已整体失效；以 #733 与现状源码为准**） | registerKind 防冒认（':' 前缀且非内置）service.ts:446-453 |
| API 层 | 前端 REST/SSE：config/history/status/test/kinds/events/health；loopback 围栏 | server.ts:444-726 + shared/loopback | 7 路由注册 server.ts:725；guardLoopbackMethod 每路由 |
| 配置存储层 | 配置模型/校验/掩码/迁移/DSH_HOME；被 SDK 扩展可用 kind 范围；供 API/判定经接口读取 | config.ts + settings-bridge.ts + settings.ts + migrate.ts | settings-bridge 状态镜像/读写通道 settings-bridge.ts:24-119 |
| ① 事件监听层 | 订阅宿主事件 → 提取详情/状态机/聚合 → 生成通知请求 | event-handlers.ts + aggregate.ts + index.ts ctx.on | 7 ctx.on global index.ts:256-266 |
| ② 推送判定层 | enabled → kind 确认 → 免打扰 → 合并/去重 → 决定是否推送 | service.ts:395-423（sendKind 前半） | enabled=skipped service.ts:396；kind-pending/quiet suppressed 落史 405-423 |
| ③ 推送执行层（含归档） | 路由解析 → 逐频道投递 → history/status 落盘 → 脱敏收口 → sent 广播 | service.ts:250-318/425-437 + history.ts + status.ts | deliver 截断+终态 service.ts:278-318 |
| ④ 渠道适配层 | browser(SSE)/system(原生)/bark/webhook 具体实现；NotifyChannel SPI | channel-bark.ts + channel-webhook.ts + outbound.ts + server.ts(system/sse) | SPI 契约 service.ts:71-89 |
| 本地文件 | settings.yaml · history jsonl · status json · toast.ps1 | config/history/status 落盘 | DSH_HOME 感知 config.ts:306-332 |

## 上下游契约要点（含争议标注）

1. **SDK → 配置层**：registerKind 仅内存注册；confirmKind → CAS 写 allowKinds（settings-bridge.ts:96-119）。**争议 A**：配置层 isConfirmedKinds（config.ts:767-771）只做形状校验，不校验 kind 是否已注册——「注册扩展可用范围」目前不构成配置层合法范围约束，仅确认态为 send 门槛（service.ts:210-215）。
2. **API → 配置层**：GET/PUT {patch, expectedRevision} + 掩码回填 + 错误映射（server.ts:379-438）。
3. **API → 执行层（测试）**：sendTest → sendKind('test', {bypassQuiet, onlyChannel})（index.ts:277-278）。
4. **判定 → 执行**：现状同函数顺序耦合（sendKind 一段到底 service.ts:395-437）；目标建议内部结构 ResolvedDelivery{kind,severity,title,message,ts,targets}。
5. **执行 → 适配层**：NotifyChannel SPI（name/capabilities/send；deliver 统一截断 service.ts:282-283）。
6. **争议 B（合并归属）**：错误合并（errorMergeWindowMs）在事件层 event-handlers.ts:127-151；done 聚合在 aggregate.ts（经 notify 回调）；免打扰/kind 抑制在判定层 service.ts:405-423——「合并/去重」到底属事件层还是判定层需裁定。
7. **脱敏归属**：事件层做文本预清洗（sanitizeErrorText message.ts:226-232）；执行层失败错误统一 scrub（service.ts:280）。目标建议脱敏收口执行层（统一出口单一事实源）。
8. **配置/归档 → 本地文件**：settings 命名空间 + history/status 落盘（DSH_HOME 感知 #510）。
