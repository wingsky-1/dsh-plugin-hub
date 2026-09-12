# dsh-notifier 全量梳理 · 规格章初稿（§1）

> 方法：任务前红线检查通过（只读梳理；主 checkout 零改动；未改代码/未跑实验；
> 证据全部来自 src/test/docs/scripts 源码与 git 历史 + 2 个独立子代理交叉验证）。
> 目标：作为 §2 分层讨论、§3 缺陷识别、§5 TDD 计划的输入。**等待人在环 G1 审阅确认。**

## 0. 包定位与边界

- 包：`packages/dsh-notifier/`（`@wingsky-1/dsh-notifier` v0.2.3，cordis 插件，npm 分发，仅适配 dsh rc）
- 定位：审批/完成/错误事件通知 + 通知中心（浏览器/系统双通道 + Bark/webhook 出站频道 + 免打扰 + 动态 kind 服务）
- 宿主端 src/ 16 个 TS/PS1 文件（共 ~4.3k 行）；客户端 src/client 4 文件（index.tsx 2525 行为主）；test/ 16 个测试文件 + helpers/smoke（~6.2k 行）
- 挂载：cordis.patch.yml insert（patch id `ui-dsh-notifier`，name 包名）；`inject: ["webServer"]`；客户端 `dsh.client.inject: ["@deepseek-ai/dsh-client-connection"]`、platform web
- 服务/事件对外契约：`provide("wingsky.notifier")` + `wingsky-notify/sent` 事件（~~service.d.ts~~ 已由 #733 M2a 删除，声明合并现写在 `src/index.ts`）；消费方：dsh-provider-usage（registerKind + send）
- 官方类型层：@deepseek-ai/{dsh-session,dsh-agent,dsh-user-approval,dsh-session-title,dsh-host-webserver} 0.1.2-rc.1，仅 import type

## 1. 域与功能特性清单（F 编号）

> 每条 = 行为描述 + 实现位置（文件:行）+ 需求来源（README / issue 号）。
> 行号锚点基于当前 main 源码快照（read 工具读取；产物 lib 与 src 同步）。

### 域 A：配置与持久化
- A1 配置模型/默认值/合法范围：config.ts:118-279（NotifyConfig/DEFAULT_CONFIG/SETTING_VALIDATORS 774-821 等）
- A2 组合层 entry 白名单净化：config.ts:858-869 sanitizeSettings；装配键剔出（ASSEMBLY_SETTING_KEYS 229）
- A3 增量 patch 透传（未知键保留、装配键剔除、原型键剔除）：config.ts:889-912 sanitizePatchSettings
- A4 写面严格校验（首个非法键 400 + hint）：config.ts:838-851 validateSettings
- A5 读面归一化（非法丢弃回默认 + 未知键透传 + 声音新旧键回落）：config.ts:524-597 normalizeConfig、203-209 resolveSoundSetting
- A6 凭据掩码单一出口与回填（bark deviceKey / webhook token/password/headerValue）：config.ts:930-999
- A7 settings 命名空间接线 + 迁移源路径：settings.ts:88-94 installNotifierSettings、config.ts:315-332 路径
- A8 存量自建 json 一次性迁移（rename-first + 逐字段补齐 + 回滚 + 幂等）：migrate.ts:158-268
- A9 历史 jsonl 滚动/按天清理/原子写：history.ts:40-127
- A10 频道投递状态 json 落盘 + debounce + 64 条上限：status.ts:48-122
- A11 DSH_HOME 感知落盘（#510/#517 shared/dsh-home）：config.ts:306-332、index.ts:156-162

### 域 B：运行时生命周期与装配
- B1 apply 装配面（settingsBridge/sse/system/historyStore/statusStore/outboundChannels/service/eventHandlers/routes/effect disposer）：index.ts:189-302
- B2 事件订阅集（7 处 ctx.on + internal/service + hookUserQuestions）：index.ts:256-266、event-handlers.ts:208-243
- B3 {global:true} 事件可达防御 + approval/request prepend 链头（#559）：index.ts:259-265、real-context.test.ts:55-120
- B4 路由注册（buildRoutes → webServer.register + effect disposer）：index.ts:268-301、server.ts:444-726
- B5 卸载清理（sse.dispose/eventHandlers.dispose/doneBatcher.dispose/disposers/routes）：index.ts:292-301
- B6 enabled=false 总开关（sendKind skipped）：service.ts:395-398、index.ts:215

### 域 C：事件源 → 通知状态机（宿主判定）
- C1 approval/request 审批通知（文案含工具名/标题/理由/行动建议 + askRemindMin 超时二次提醒 + next 不短路）：event-handlers.ts:168-206
- C2 userQuestions.ask 包装（热重载解包重包/this 绑定/notifyQuestion）：event-handlers.ts:208-243、internal/service 246
- C3 完成状态机（running→idle per-agent、runningBaseline 冻结、session/event push 单源 + lastTurnEndOf 快照兜底、reason 白名单 completed、子代理分流、disposed 清理）：event-handlers.ts:267-326、message.ts:367-451
- C4 错误通知 + 滚动窗口合并（errorMergeWindowMs、≥3 条 shift、suppressed:merged）：event-handlers.ts:328-348、103-151
- C5 turn-stopping 轮次完成通知（notifyTurnEnd + 去重）：event-handlers.ts:350-365
- C6 askRemind 定时器注册/清除（agent 生命周期 finally 清理）：event-handlers.ts:182-205
- C7 完成风暴聚合（首条即时 + 窗口补发聚合条 + 跨 kind flush + dispose）：aggregate.ts:38-83
- C8 会话标题提取（snapshotEvents 倒序 + 脱敏截断 40）：message.ts:336-354

### 域 D：通知中心 service（对外服务面）
- D1 消息模型 + 形状守卫（send 非法 → failed 不抛）：service.ts:472-504
- D2 severity 静态映射（内置 7 kind）：service.ts:122-130
- D3 内置 kind 文案模板渲染（NOTIFY_KINDS）：message.ts:459-536、service.ts:399-403
- D4 动态 kind 注册/确认/查询（registerKind 防冒认、confirmKind 持久化 allowKinds、listKinds 确认态）：service.ts:446-465
- D5 免打扰判定与豁免（quiet-hours.ts 半开区间/跨午夜/allowKinds）：service.ts:413-423
- D6 频道路由解析（缺省广播/稀疏命中/stale skipped/onlyChannel）：service.ts:250-267
- D7 fail-soft 逐频道投递 + 受理与终态解耦（铁律 1）+ status/sent 上报：service.ts:278-318
- D8 每通道声音 × 弹窗组合（browser/system 分派 dispatchBrowser/dispatchSystem + 只响不弹 + 帧级 sound）：service.ts:324-367、config.ts:190-209
- D9 SSE 帧契约（notify/ping、seq、sound、playOnly）：service.ts:329-353、server.ts:49-121
- D10 跨插件消费面（dsh-provider-usage registerKind/send、sent 事件旁观订阅）：~~service.d.ts~~（#733 M2a 删除，见 `src/index.ts` 的声明合并）、provider-usage apply.ts:349-358

### 域 E：HTTP 路由（对外接口面）
- E1 七路由注册 + loopback 围栏 + 方法白名单（403/405）：server.ts:444-726、shared/loopback
- E2 config GET 包装体 {ok,user,revision,effective,writable} + 掩码：server.ts:450-464
- E3 config PUT 增量 patch + 乐观并发 expectedRevision + 掩码回填 + 错误映射（400/409/503/500）：server.ts:379-438、465-497
- E4 events SSE（connected 锚点 + ?since 补拉 + 滚动缓冲 600）：server.ts:503-546
- E5 test POST（全频道/单频道 channelId + 绕过免打扰）：server.ts:596-621
- E6 history GET/DELETE（最近 200/按天/清空）：server.ts:706-723
- E7 status GET（per-channel 终态/连续失败/错误脱敏）：server.ts:627-636
- E8 kinds GET/POST（注册表/确认 CAS/404/409/503/500 + revision 回带）：server.ts:643-703
- E9 health GET（配置摘要/platform/sseConnections/sseEvicts/sseConnHealth）：server.ts:555-586

### 域 F：系统通知通道（平台原生）
- F1 Windows toast（PowerShell WinRT toast.ps1、base64 payload、AUMID 注册、silent 属性）：toast.ps1:1-65、message.ts:259-262
- F2 macOS osascript（display notification + sound name 映射）：message.ts:263-269、MAC_SOUND_NAMES 24-29
- F3 Linux notify-send + suppress-sound + 可用性探测：message.ts:270-274、server.ts:158-179
- F4 命令生命周期治理（spawn/超时杀进程/exit/error 不冒泡/8s 超时）：server.ts:186-235
- F5 声音自播（Linux pw-play/paplay freedesktop 事件音、Windows SoundPlayer、macOS afplay）：message.ts:94-127、server.ts:247-309
- F6 系统通知 1s 节流 + 只响不弹终态语义：server.ts:153-154、321-332

### 域 G：出站推送频道（配置驱动）
- G1 Bark 频道（POST {baseUrl}/push、device_key body、10s 超时、重试 ×2、限流门 ≤2、双查 code===200）：channel-bark.ts:69-169
- G2 Bark 配置契约（保留键/levels 矩阵/level 优先级/URL normalize）：config.ts:341-414、channel-bark.ts:153-154
- G3 Webhook 频道（POST url、认证头 none/bearer/basic/header、超时 1-60s、失败不重试）：channel-webhook.ts:122-190
- G4 Webhook JSON-aware 模板渲染（{{ts}} 数字直出、树遍历值替换、防注入、非法模板投递失败）：channel-webhook.ts:81-114
- G5 预设映射（ntfy/gotify/custom + {{priority}}）：channel-webhook.ts:32-65
- G6 出站解析器（type:id、enabled 过滤、bark gate 延续）：outbound.ts:10-33

### 域 H：客户端通知半区（浏览器）
- H1 SSE 订阅 + 心跳 + 60s 看门狗 + 重连 ?since 补拉 + onerror 重建：client/index.tsx:624-704
- H2 多标签主从租约（localStorage 15s）：client/index.tsx:377-398
- H3 浏览器 Notification 展示（tag 随机防合并、icon、silent、点击聚焦、最多 5 条）：client/index.tsx:554-598
- H4 可见性判定（hidden 才弹 / notifyWhenVisible / 只响不弹无视可见性）：client/index.tsx:603-615
- H5 非安全上下文降级（横幅/标题闪烁/声音）：client/index.tsx:523-545、589-597
- H6 音频手势解锁 + Web Audio 四音色 + 1.5s 播放节流 + 试听：client/index.tsx:412-483
- H7 页面可见重建 SSE + 标题恢复：client/index.tsx:2436-2442、2491-2496
- H8 帧级 sound 决策与旧帧回落：client/index.tsx:554-570

### 域 I：客户端设置卡片（UI 交互面）
- I1 settings.section 独立 tab「通知中心」（label thunk + locale NS）：client/index.tsx:2465-2486
- I2 三 tab（事件/频道/历史）与事件行（severity 色点/开关/路由 chips/动态 kind 确认徽标）：client/index.tsx:1990-2060、2291-2346
- I3 频道卡（browser/system/bark/webhook：开关/声音三态行/权限行/平台提示/状态点/测试/删除）：client/index.tsx:1480-1927
- I4 免打扰卡（时段/豁免 chips/跟随已启用/恢复默认/未启用置灰）：client/index.tsx:2125-2216
- I5 历史 tab（最近 10 条 + 清空两段确认 + 测试/刷新 + suppressed 徽标）：client/index.tsx:2246-2289
- I6 保存（基线 diff 只提变更键/串行 guard + trailing 补发/域保存 channels/409 双动作/15s 超时）：client/index.tsx:941-1112、56-190
- I7 频道实例编辑（chAdd/chPatch/空串剥除/secret 显隐/levels 矩阵/模板 chips/删除两段确认）：client/index.tsx:1138-1210、1602-1927
- I8 i18n 双语字典 + locale 订阅（NS 注册/t 重绑/unsub）：client/index.tsx:2405-2427、locales.ts:11-418
- I9 样式（ensureStyle 注入 + dn- 前缀 + --dsw-alias 主题变量 + 480px 响应式）：client/index.tsx:2406、style.css:1-863
- I10 运行配置镜像/宿主平台预取/403 引导文案：client/index.tsx:2444-2457、347-351

### 域 J：跨模块契约/共享层
- J1 共享 sse-hub（表/心跳/stalled/maxAge/上限淘汰/evictStats/connHealth）：shared/sse-hub.js（server.ts:80-121 包装）
- J2 shared 工具面（loopback/host-utils/ensure-style/settings-namespace/dsh-home）：shared/*.js、*.d.ts
- J3 wingsky.notifier 服务 + sent 事件声明合并：~~service.d.ts:19-28~~（#733 M2a 起写在 `src/index.ts`；产物面判据见 `test/integration/consumer-product-face.ts`）
- J4 平台命令/音色映射常量跨端同源复制（客户端 SOUND_IDS 与宿主 SOUND_IDS 分离）：client/index.tsx:207-210、config.ts:179-185

## 2. 需求规则矩阵（每域五行：happy / 边界 / 异常 / 并发竞态 / 安全）

> 供后续 TDD 用例矩阵直接展开；语义源 = README + 源码注释 + 测试头注。
> R = 可测试需求规则（编号按域）。

### 域 A（配置/持久化）
- H-A：默认配置各键合法；entry 白名单净化；patch 增量合并；非法值 400 + hint；掩码输出恒 ********
- B-A：数值边界（0 合法 / 超上限非法）；quietHours 24:00/25:00 非法；空 patch 400；纯未知键 patch 200；新实例掩码占位 400；未知键值 null 透传；原型键剔除
- E-A：settings 服务缺失 → 503；写入异常 → 500 固定文案；损坏 legacy → corrupted.bak 不写入；写失败 → 回滚 bak
- C-A：并发 PUT（expectedRevision 冲突 → 409 + 双动作恢复）；迁移与用户 PUT 并发 merge 不覆盖；确认 CAS 重试 ≤2
- S-A：配置视图与 PUT 响应 secret 全掩码；原型链键不写入；装配键不入 user 层；凭据只走请求头/body 不落 URL

### 域 B（生命周期/装配）
- H-B：apply 注册 7 事件 + 7 路由 + service + 迁移；卸载 disposer 全部执行
- B-B：settings 服务未 attach 时 degrade（writable=false/503）；slots 缺失时 tab 不挂载但半区照常
- E-B：事件处理器/路由 handler 抛错不冒泡宿主（catch + warn）；sse.dispose 幂等
- C-B：重复 apply（热更）不叠监听（unsubLocale/visibilitychange 具名 handler）；卸载后再 apply 重新注入
- S-B：loopback 围栏每路由强制执行；跨 scope 事件 payload 自校验后静默

### 域 C（事件状态机）
- H-C：running→idle 且证据 completed → 发 done；aborted/error/blocked/max-tokens/未知 kind 不误报；子代理分流；错误合并窗口；turn-end 去重
- B-C：连续 idle 不重复通知；disposed 清理后无残留；无标题降级；idle 无 runningSeen 静默；快照无新 closure 静默（abort-early）
- E-C：payload 畸形（缺 turn/reason 非对象/非有限 turn）跳过不毒化状态；agent 访问抛错 catch；userQuestions 服务缺失/抛错不崩
- C-C：多 agent 并发 running/idle 互不误报；事件流 push 与快照竞态 → 单源优先 + 冻结兜底；同 agent 并发 idle 只发一次
- S-C：通知文本不含工具参数/内部 session id；错误/审批理由/提问文本经脱敏截断；sessionTitle 单点脱敏

### 域 D（service/投递）
- H-D：sendKind/send 全链路（enabled→kind 确认→免打扰→路由→逐频道→历史/status/sent）；动态 kind 待确认 suppressed
- B-D：kindRoutes 无条目 = 广播；stale 路由 skipped；onlyChannel 单频道；弹窗/声音 2×2 组合；频道全关不投递；onlyChannel 指定不存在频道 → 空投递
- E-D：频道 send 抛错/拒收 → failed 且不牵连其他；system 只响不弹自播失败 → 异步 failed；免打扰拦截仍落史
- C-D：并发 send 多频道互不阻塞（bark 门 ≤2 排队）；受理同步返回与异步终态解耦；termination 上报 try/catch
- S-D：跨插件 send 形状守卫（failed 不抛）；动态 kind 防冒认（':' + 非内置前缀）；免打扰 allowKinds 语义与开关正交

### 域 E（路由）
- H-E：GET/PUT config、GET events、POST test、GET/DELETE history、GET status、GET/POST kinds、GET health 全 200 + 响应契约
- B-E：非 loopback 403（先于 405）；非白名单方法 405；?since 非法/超限回退 0；超大 body 不挂起；body 非法 JSON 400
- E-E：settings 503/409/500 映射固定；setConfirm 异常兜底 409/503/500；readBody 超限 destroy 不挂响应
- C-E：并发 PUT + 409 双动作；kinds CAS 重试；SSE 多连接 broadcast 不互相干扰
- S-E：loopback 围栏每路由；写面错误不回底层原文；凭据深度脱敏；referrer-policy

### 域 F（系统通知）
- H-F：win32/darwin/linux 各平台命令构造正确；弹窗/声音组合（toast silent / 自播）
- B-F：notify-send 缺失 → argv null 静默跳过；自播文件缺失 → 只响不弹失败、弹窗忽略；1s 节流吞掉透传上次决议
- E-F：spawn error/ENOENT/超时杀进程不冒泡；命令非 0 退出仅 warn；toast.ps1 解析失败 exit 1
- C-F：密集事件节流防 spawn 风暴；同一投递多次 spawn 归入同一节流窗口
- S-F：参数数组传参零 shell 拼接面；base64 payload 规避 PS 解析歧义；AUMID 注册 HKCU 幂等；白名单路径

### 域 G（出站频道）
- H-G：bark/webhook 成功投递（URL/header/body 契约）；webhook 渲染/优先级映射
- B-G：bark 4xx 不重试、5xx/网络重试 ×2；webhook 失败不重试；模板非法 → 该频道 failed；超时 1-60 clamp
- E-G：bark 2xx body code≠200 → failed；4xx 响应体脱敏；fetch 异常 → 可读错误
- C-G：bark 在途并发 ≤2（超限排队）；重试退避 1s/2s；队列唤醒
- S-G：device key/凭据不落 URL、错误出口字面替换脱敏；URL 限 http/https/拒凭据/去 query/hash；保留键剔除；webhook JSON 注入防护；header 禁关键头

### 域 H（客户端半区）
- H-H：SSE 收帧 → 可见性判定 → 通知/横幅/标题；test 无条件提醒；帧级 sound 生效
- B-H：多标签副标签静默（claimMaster）；notifyWhenVisible=false 且页面可见 → 不弹；playOnly 无视可见性
- E-H：Notification 抛错 → 降级横幅；EventSource 不可用/帧解析失败 → warn + 重建；AudioContext 不可用 → 静默
- C-H：60s 看门狗 / 5s 防抖重建 / 多标签租约竞争 / 断线补拉 since；onerror 密集重连限频
- S-H：通知文本展示不含工具参数；标题闪烁 40 字符截断；无凭据外泄面

### 域 I（客户端卡片）
- H-I：加载→编辑→基线 diff→保存（200/成功提示）；频道增删/启停/路由 chips 物化；免打扰豁免 chips；历史工具行
- B-I：dirtyCount 空 → 「未修改」；409 双动作（加载最新 / 覆盖重提）；域保存只提 channels；webhook secret 显隐；空串剥除防 400
- E-I：网络失败/超时 → 保存提示；403 → lanAccessHint；settings 不可用 → 提示；动态 kind 确认失败提示
- C-I：连点保存（guard + trailing 补发）；在途编辑与保存/基线推进竞态（ref 收口）；409 期间新编辑不丢；kind 确认后 revision 同步
- S-I：凭据输入不回显（掩码占位）；「显示」按钮仅作用于正在输入的新值；路由/豁免未启用项置灰禁点

### 域 J（跨模块）
- H-J：服务声明合并可编译；sent 事件契约字段齐备；客户端/宿主路由字面一致
- B-J：共享 hub 上限/心跳/stalled/maxAge 参数可注入；SSE ?since 滚动缓冲 600 独立于历史 200
- E-J：服务缺失消费方降级（optionalNotifier null）；sent 事件派发失败不影响投递语义
- C-J：多标签广播写并发；hub 心跳与广播同帧写互斥安全；增量 mutation 基线一致性
- S-J：loopback/host-utils 共享守卫单一事实源；凭据掩码字段表单一事实源；装配键编译期锁

## 3. 测试套件审计结论（覆盖全读 + 盲区交叉验证）

- 运行模型：非 node:test；顶层 assert + try/finally；`test/**/*.test.ts` 经自研 `run-tests.mjs`（#722 阶段五已退役，文件已从仓库删除；迁移前口径为逐文件 spawn `node --test --test-isolation=process --test-concurrency=1`，包内串行）执行（防 fetch mock 交错 #508；#690 S2 前由 smoke.ts 聚合入口承担）；测试主体 import `../lib/index.js` 产物；变异经 hook 重定向 src
- 补充（#722 阶段一）：运行器已由 vitest 取代——包内 `pnpm test` = `scripts/test/run-vitest.mjs --min 35`，
  用例结构为 describe/it，断言库为 vitest expect；上文 runner 描述为迁移前的审计快照。
- 断言强度：整体强（文案精确 match / 状态机中间态 / HTTP 逐字段 / 脱敏深等 / service.update 只收变更键）；哑断言仅 e2e-edge:210/224 两处 `assert.ok(true)`；无读私有字段；轮询为主（waitForHistory/pollUntil/pollStatus 20ms）
- 孤儿判定：**无孤儿**（16/16 在主入口）；7 个较新测试文件（unit-sse-hub/unit-webhook/real-context/service-contract/client-contract/client-style）**不在 stryker 9 文件清单**（登记裁剪，config _comment「测试全套跑」与事实不符）；被测 service.ts/event-handlers.ts/channel-*/aggregate/status/outbound/settings-bridge 亦不在 4 个 mutate 段（有意的段裁剪，但核心状态机无变异面）
- 类型面盲区：dsh-notifier/test/tsconfig.json 无任何消费方（service-contract-wiring 只接 mcp-manager/codegraph）；测试全 @ts-nocheck → 类型面零编译校验
- 工厂级直测缺失：history/status/settings-bridge/outbound/aggregate/event-handlers 均无直测文件（行为经 e2e/全链覆盖）；outbound.ts 真 resolver 从未执行；server.ts 系统命令真 spawn 链（runCommand/deliverOnce/探测/8s 杀进程）零断言（service-contract 用 fakeSystem 替换）
- flake 风险：7 处短固定 sleep（最紧 e2e-done:106 30ms vs 20ms 窗口；migration 30ms 负向观察窗；routes:1250 80ms）；waitMergeWindow 3.2s 固定等待慢机边际；每 makeNotifier 实例在 linux 触发真实 execFile 探测（notify-send/pw-play/paplay）
- 纪律符合：mkdtemp 隔离/轮询/事件驱动/无网络/零真实凭据/无真实 ~/.dsh 写入全部合规；偏差：未全局设 DSH_HOME（以显式路径替代隔离）、固定 sleep 数处、e2e-edge 两处空断言

## 4. 客户端独立评审交叉验证（子代理 × 本人复核）

- **P1-1**（已核实）：多标签副标签在 claimMaster() 之后仅对系统级 Notification 去重；banner/flashTitle/自播路径无二次判定 → 副标签在降级/只响不弹场景仍可能展示/发声（与「副标签静默」注释不一致）
- **P1-2**（已核实）：频道状态行只在卡片加载/测试后拉取（loadStatus 仅 865/900/1131），无轮询 → README「实时可见」口径弱于实现
- **P1-3**（已核实）：无 storage/broadcast/focus 跨窗口同步 → 另一窗口保存后本窗口 stale
- **P1-4**（已核实）：客户端断线补拉只回放滚动缓冲（600 帧）内的 seq；超出窗口的事件不补（历史 jsonl 有但不被半区消费）
- **P2-1**（已核实）：历史 tab 只展示 `suppressed === "quiet"` 徽标；`kind-pending`/`merged` 不展示
- **P2-2**（已核实）：locales 死键 13 个（含 chLevelsMap/chLevelsKind/chStatusTitle/secDnd/chEnabled/chDisabled/routeAllDefault/routeCustomize/routeFollowDefault/routeStaleHint/routePick/kindPending/kindAllowed），全部 0 处引用（zh/en 双语均死）；其中 client-contract.test.ts:88 断言 routePick 存在于 locales 文本（静态哨兵误锁死键）
- **P2-4**（已核实 + 修正）：顶层数值输入清空 → `Number("")=0` → 提交 0（服务端 0 合法）→ 实际是「清空变 0」而非 400；而输入 `Number("abc")=NaN` 直接提交会 400（无 UI 钳制/NaN 守卫，与 whTimeout 双钳制不一致）；子代理原文「清空→patch undefined→400」不成立，修正为「清空→0、非法字符→NaN→400」
- **P2-5**（已核实）：注释声称 playToneForce 绕过节流，函数不存在（435 行注释 vs 436/475 实现）；试听走 playPreview（unlockAudio + playTone 无 playGate），连点可叠播
- 未验证（诚实标注）：浏览器实测（音频解锁/多标签租约竞争/横幅视觉）、宿主插槽与 locale 服务真实签名、CSS 主题变量渲染、600 帧缓冲丢弃频率、`http://127.0.0.1:3080` 局域网 403 实机行为

## 5. 覆盖结论（G1 呈现用摘要）

- 已全读：宿主 src 全部 16 文件（index/config/quiet-hours/message/history/aggregate/status/event-handlers/service/settings/settings-bridge/migrate/server/channel-bark/channel-webhook/outbound/toast.ps1/service.d.ts（**该文件已由 #733 M2a 删除**））；客户端 index.tsx 全 2525 行 + locales/style；测试 16 文件 + helpers + smoke + 4 份 stryker conf + topology/gauntlet/ci/observe；共享层 sse-hub/host-utils/loopback/settings-namespace/dsh-home/ensure-style
- 交叉验证：测试审计子代理 + 客户端评审子代理独立交付；关键弱项（P1-1/P1-2/P1-3/P1-4/P2-1/P2-2/P2-4/P2-5）经本人二次核实，P2-4 结论已修正
- 已知盲区（本阶段诚实声明）：真实浏览器 UI 行为（明暗/响应式/多标签/音频）需 dsh-verify-isolated 隔离实测，不在本静态梳理范围；宿主官方 rc 事件语义以类型层为准（agent/session/user-approval 事件签名已核对）；Windows/macOS 真机系统通知链需目标平台实测

## 6. 结构定稿登记（v2 追加；依据 architecture-redesign.md v2 + 双视角结构评审 + 人在环 Q1-Q6 拍板）

### 6.1 L8 契约缺口缺陷登记表

> 来源：architecture-redesign.md v1 §3（评审采纳 L8）+ 结构评审实证；重构 PR 落地时逐项给修复 + TDD 用例。

| 编号 | 缺陷 | 证据 | 裁定/修复方向 |
|---|---|---|---|
| L8-1 | ChannelCapabilities.titleMaxLen<=0 注释「标题并入正文」vs 实现「放宽截断仍作独立标题」 | service.ts:73 vs :282 | v2 引入 `mergeTitleIntoBody` 显式声明（sdk/interface.ts），实现按注释本意走（框架拼入正文） |
| L8-2 | confirmKind 双语义（服务面 fire-and-forget vs 路由 CAS 重试） | service.ts:155 setConfirm 注入 vs settings-bridge.ts:96-119 | ConfigPort.confirmKind 统一为 CAS 重试 ≤2 语义；sdk 注入面引用同一实现 |
| L8-3 | NotifyRequest.data 字段未实现（透传字段悬空） | service.ts:46-48 定义无消费 | 保持声明但注明「MVP 未启用」；或随 registerChannel v-next 一并裁定（待 §3 决策） |
| L8-4 | registerChannel 悬空（只存表不投递） | service.ts:467-470 channelRegistry 无读取方 | **D11 用户裁定：registerChannel 是配置层的事情，只增加配置、不增加功能特性**——保留寄存器（SDK 面），投递集合不消费注册表；启用模型归 v-next |
| L8-5 | expectedRevision 非整数静默忽略 | server.ts:387-388 | v2 修复：非整数 expectedRevision 显式拒（400）或文档化静默语义（§3 TDD 补用例） |
| L8-6 | history DELETE / test POST 错误路径无错误映射 | server.ts:716-719（DELETE 恒 200） | v2 修复：DELETE 失败 → 5xx 固定文案；test 无 settings 降级路径登记（§3 TDD 补用例） |

### 6.2 行为变更登记表（重构引入/保持的语义变化，TDD 计划据其补用例）

| 编号 | 变更 | 方向 | 说明 |
|---|---|---|---|
| B-1 | 脱敏统一时点前移：渲染后、任何落史/投递前（覆盖裁决 suppressed + 事件层 merged + 投递） | 安全增强 | 现状靠事件层入口预清洗（event-handlers:336/:174/:231 + message:347）；统一入口后 suppressed/merged 历史同保；AdjudicateResult/AdjudicatedNotice 携带已脱敏文本 |
| B-2 | 投递决议快照化：browser/system 播放决议随 current() 单刻快照在裁决时解析 | 行为变更 | 现状 deliver 时实时读（service.ts:325/:357）；裁决→投递间配置变化不再影响本次投递——文档化 + 契约测试锁定（现状无该场景用例） |
| B-3 | 重试/并发门从 channel 内部上移框架（pipeline/deliver） | 行为对等 | bark 4xx 不重试/网络 5xx 重试 ×2/并发 ≤2 排队/门跨配置变更延续（channel-bark.ts:40-48/:110-139 + outbound.ts:13-22）；webhook 零重试（retry 缺省=关）；退避 1s/2s 线性；超时留 channel 侧 |
| B-4 | sanitizeContent 默认 true：SDK send 动态 kind body 从「调用方负责脱敏」变「中心兜底统一脱敏」 | 安全增强 | service.ts:44 注释 + :487-503 直通路径；`sanitizeContent=false` = 通知与历史均明文（README 安全模型明示） |
| B-5 | disabled（enabled=false）不落史保持 | 保持（D15） | service.ts:396-397 直接 skipped 不落史；「suppressed 统一落史」仅覆盖 kind-pending/quiet |
| B-6 | registerChannel 定位文档化：配置层注册面 + 登记后一次性 warn | 保持 ABI | D11：签名/返回值/登记语义不变（仍不接线投递），语义从「注册频道待启用」改述为「配置层注册面」。**#733 M2c R3a 已落地文档化；#733 M2c 后续 N1 已落地运行时面**（登记成功后按 `ch.name` 经 `logger.warn` 提示一次，同名不重复；非法入参逐字保持静默）：`src/sdk/interface.ts` 的 `registerChannel` JSDoc + `src/sdk/service.ts` 实现处；warn 文案由 `test/integration/service-contract.test.ts` 的 registerChannel 用例 `toBe` 全等锁定。注册表零读取点（只 `set` 无 `get`）仍是该口径的机器可核事实 |
| B-7 | KIND_SEVERITY 移 text/ 域 | 无运行时变化 | 导出面 re-export 保持（index.ts:131），仅文件归属迁移 |
| B-8 | 单刻快照行为（B2）的事件源级补充：错误合并窗口/聚合窗口不受快照影响 | 保持 | 事件层状态机（errorMerge/agentStates/batch）沿用现状语义，不随重构改动 |
| B-9 | send() 动态 kind 与 sendKind 统一过裁决（enabled→免打扰→路由） | 行为变更（D24） | 现状动态 kind 路径绕过 enabled/免打扰（sdk/service.ts:165-197）；统一后 enabled=false/免打扰期间动态 kind 从「照常投递」变「skipped」——先红测锁定现状再改，登记用例 N-25 |
| B-10 | expectedRevision 非整数从静默忽略 → 显式拒 400（D19 拍板） | 行为变更 | 现状 applyConfigPatch 对非整数 expectedRevision 静默置 undefined；D19 裁定显式拒 400（「配置校验失败: expectedRevision」，hint 注明须为非负整数或省略）；客户端现状不传非整数、实际零影响——L8-5 修复随 PR2 T2-4 落地，用例 N-16 锁定 |

### 6.3 迁移计划（三 PR，见 architecture-redesign.md §10）

- **PR1 机械搬家 + interface.ts 落地 + stryker 路径更新**：零行为变更；导出面快照（tsc --declaration 基线 diff）；全门禁（build/test/contract/pack:check/typecheck）。
- **PR2 行为重构**：adjudicate/deliver 拆分 + current() 快照 + 播放决议快照化；重试/并发门上移（B-3 对等清单）；脱敏统一时点 + sanitizeContent（B-1/B-4）；ConfigPort/RouteDeps 契约（L8-2/5/6）；每步对齐规则矩阵并补 §6.2 用例。
- **PR3 注释清理 + 门禁 lint 落地**：interface import 检查 + 环路检测；消费方类型编译用例（~~service.d.ts 改指 sdk/interface.ts~~ 已改为声明合并直接写进 `src/index.ts` + `consumer-product-face.ts` 产物面夹具，#733 M2a）。

### 6.4 mutation/stryker 冲击面（架构师实证，已核实）

- `scripts/data/mutation-topology.json` dsh-notifier 段 mutate 路径（config/migrate/settings/history/quiet-hours/message/index/server）随搬家全部更新；
- 「message.ts 单文件 145s 物理极限维持」注释因 message 拆三文件失效——text/ 段边界重定（message/sanitize/system-commands）；
- 新增文件（adjudicate/deliver/sanitize/sse-bus/system-notifier/browser/system + 各 interface.ts）入变异面决策：建议核心状态机 adjudicate/deliver/event-handlers 纳入，interface.ts 纯 re-export 不入；**PR1 决策落地 = 暂不入面**（PR1 纯机械搬动零行为变更）；**PR2 T2-7 决策落地 = 按域重划段（S3-30/N-24）时纳入核心状态机**——8 域段全量实现入面（config/text/pipeline/events/channels/stores/server/sdk + 根 index.ts 并入 sdk），interface.ts 一律不入；
- `mutation-lib-to-src-loader.mjs` 已支持 `lib/sub/module.js → src/sub/module.ts` 子目录映射（已核实）——搬家后变异 hook 零改动；
- **PR2 T2-7 变异分段重划（S3-30/N-24 落地）**：dsh-notifier mutate 4 段（config/history/message/server）→ 8 域段（config/text/pipeline/events/channels/stores/server/sdk）；核心状态机 pipeline（adjudicate/deliver）+ events（event-handlers/aggregate/agent-session）入面，settings-bridge/quiet-hours/status/outbound 等 PR1 盲区全部入面；index.ts 装配层并入 sdk 段（独立 assembly 段单文件且 re-export 过半可杀性低，并入均衡段规模）；excludes 统一 `!src/**/interface.ts` + `!src/client/**`；testFiles 15 → 24（补 e2e-outbound/unit-aggregate/unit-config-port/unit-event-handlers/unit-pipeline-contract/unit-server-sse-bus/unit-settings-bridge/unit-stores/unit-system-notifier，real-context 保持剔除）；
- 测试全量 import `../lib/index.js`（§3:196）——导出面不变时零改动；坏处是 9 个 interface.ts 无变异面（纯 re-export 合理）。

## 7. S3 缺陷总清单与测试分层映射（§3 交叉验证定稿）

> 依据：双独立子代理交叉验证（测试套件审计 + 客户端弱项）+ 主会话抽查复核；本节约收所有缺陷/盲区/行为变更，作为 §5 TDD 方案与分阶段 PR 的输入。

### 7.1 交叉验证修正记录（对 §3/§4 前序结论的修订）

| 原结论 | 修订 | 证据 |
|---|---|---|
| §3 固定 sleep 7 处 | **修正为 16 处**（漏 unit-sse-hub×4、service-contract×3、e2e-edge:179 1100ms、e2e-done:525 100ms）；最紧 e2e-done:106 30ms vs 20ms margin 10ms 确认 | 子代理全量 grep + 主会话抽查 |
| §3 stryker 清单外 6 个 | **修正为 7 个**（补 e2e-interrupt.test.ts） | mutation-topology:184-194 testFiles 9 个 vs smoke 16 个 |
| §3 outbound 真 resolver 从未执行 | 修正：**空跑、有效分支从未执行**（enabled:true bark 实例化/gate 复用零覆盖） | routes.test.ts:506 等 PUT 全 disabled；service-contract 注入 fakeOutbound |
| §3 类型面零编译校验 | **加重为双重空白**：test/tsconfig 无消费方（wiring 只接 mcp-manager/codegraph）+ 18 文件全 @ts-nocheck + 根 typecheck 不编译 test/ | service-contract-wiring.test.ts:35-46/:22 |
| §4 P1-1 副标签去重 | **推翻（误报）**：claimMaster() 是 showNotification 统一前置（:572），banner/flashTitle/自播全在其后，副标签所有路径静默 | client index.tsx:569-596 + handleNotifyFrame:606-614 唯一入口 |
| §4 P2-4 NaN→400 | 修正：type=number 下非法字符归一空串不可达；NaN 经 JSON 序列化为 null 走服务端**跳过语义**（config.ts:900）非 400；**maxConnections 清空→0→服务端 400（0 非法 config.ts:558）是真实 UX 缺陷** | index.tsx:2082-2120 onChange + config.ts:558/:792 |
| §4 P2-5 playToneForce | 定性修正：函数虚构为**注释债务**（playPreview 不过 gate 与注释意图一致）；playChime 死函数 | index.tsx:434-435/:475-488 |

### 7.2 S3 缺陷总清单（去重合并；落位 = PR1/PR2/PR3/基建/文档）

| 编号 | 缺陷 | 证据 | 落位 |
|---|---|---|---|
| S3-1 | L8-1 ChannelCapabilities titleMaxLen<=0 注释 vs 实现（标题并入正文缺失） | service.ts:73 vs :282 | PR2（mergeTitleIntoBody） |
| S3-2 | L8-2 confirmKind 双语义（fire-and-forget vs CAS 重试） | service.ts:155 / settings-bridge.ts:96-119 | PR2（ConfigPort.confirmKind） |
| S3-3 | L8-3 NotifyRequest.data 字段悬空 | service.ts:46-48 | PR2 注明「MVP 未启用」或 v-next |
| S3-4 | L8-4 registerChannel 悬空→**D11 已裁定配置层注册面** | `src/sdk/service.ts`（原引用 `service.ts:467-470` 随重构失效）；`src/sdk/interface.ts` 同名 JSDoc | **#733 M2c R3a 已落地文档化；#733 M2c 后续 N1 已落地运行时面**（登记 + 同一 name 一次性 warn；已获维护者 `approved`，R3b 授权） |
| S3-5 | L8-5 expectedRevision 非整数静默忽略 | server.ts:387-388 | PR2（显式拒 400 或文档化） |
| S3-6 | L8-6 history DELETE / test 无错误映射 | server.ts:716-719 | PR2 |
| S3-7 | P1-2 频道状态行无轮询（README:286「实时可见」口径弱于实现） | index.tsx:865-869/:900/:1131 | PR2（D20 已定改 README 口径，T2-6 落地） |
| S3-8 | P1-3 跨窗口无 storage/broadcast 同步（409 被动恢复） | index.tsx:985/:1025-1028 | PR2/PR3（中低） |
| S3-9 | P1-4 + C3-1（高）补拉 600 帧窗口有限；**服务端重启 seq 归零→已打开页面永久静默** | server.ts:99-121 / index.tsx:674-677 | **PR2 必做**：seq 回退检测或服务端 baseSeq + TDD「重启后重连不丢帧」 |
| S3-10 | P2-1 历史徽标缺 kind-pending/merged | index.tsx:2277-2279 | PR2/PR3 |
| S3-11 | P2-2 locales 13 死键 + client-contract.test.ts:88 routePick 哨兵误锁 | locales.ts:143-162/:343-360 + :88 | PR3（同步改哨兵） |
| S3-12 | P2-4 顶层 5 数值字段无钳制；maxConnections 清空→0→400 | index.tsx:2082-2120 + config.ts:558 | PR2（whTimeout 同款 clamp） |
| S3-13 | P2-5 playToneForce 注释虚构 + playChime 死函数 | index.tsx:434-435/:486-488 | PR3 |
| S3-14 | C3-2 放弃更改不清 409 横幅 | index.tsx:1117-1124 vs :2361-2374 | PR3 |
| S3-15 | C3-3 routeStaleTitle「保存后清理」文案无实现（stale 永久残留） | locales.ts:184/:380 + index.tsx:1963-1971 | PR3（D20 已定：改文案口径「stale 已跳过」，C3-3 归位改口径） |
| S3-16 | C3-4 fetchStatus 失败清空已加载状态行 | index.tsx:732-737/:865-869 | PR2（T2-6 顺手落地：拉取失败保留旧态） |
| S3-17 | C3-5 showBanner kind 未转义 CSS 选择器（异常 kind 致帧静默丢弃） | index.tsx:524 | PR2（T2-6 顺手落地：遍历比对 dataset，不构造选择器） |
| S3-18 | C3-6 writable=false 保存按钮未禁用 | index.tsx:2385 | PR2/PR3 |
| S3-19 | C3-7 saveFailConflict msg 空串 + 过时指引 | index.tsx:962 / locales.ts:57/:267 | PR3 |
| S3-20 | T3-1 固定 sleep 16 处（含 migration 4×30ms 负向观察窗、e2e-done 30ms、waitMergeWindow 3.2s） | 全清单见 §7.1 | 基建（PR1/PR2 替换轮询/注入短窗） |
| S3-21 | T3-3 投递路径真 spawn 零断言（e2e systemNotify=true → 真 runCommand；CI ENOENT→warn 静默） | service.ts:356-367 + server.ts:283-308/:186-235 | PR2 红测先行 1（spawn 注入 fake） |
| S3-22 | T3-4 server.ts createSseHub 业务包装（seq/600 帧缓冲/framesSince）零直测；shared/sse-hub.js 无变异面 | server.ts:80-121 + unit-sse-hub.test.ts:17 | PR2 红测先行 5（+600 帧 shift 边界用例） |
| S3-23 | T3-5 fetch mock 白名单外 fail-open 转真实网络 | unit-webhook.test.ts:105-106 / service-contract.test.ts:354/:415/:428 | PR2 加固（白名单外拒绝） |
| S3-24 | T3-6 类型面双重空白（tsconfig 无消费方 + 全 @ts-nocheck + 根 typecheck 不编译 test/） | service-contract-wiring.test.ts:35-46 | PR3 红测先行 7（去 @ts-nocheck + wiring 接线） |
| S3-25 | T3-7 real-context.test.ts:57-73 读 src/index.ts 静态正则（onCalls>=7/inject 形态/prepend）——重构触达即误红 | real-context.test.ts:57-73 | PR1/PR2 同步维护清单 |
| S3-26 | T3-8 client-contract banned/kept 符号表 + client-style dataset.version "640-1" 硬编码 | client-contract.test.ts:37-50 / client-style.test.ts:104 | PR2/PR3 同步维护 |
| S3-27 | T3-9 outbound 有效分支零覆盖（enabled:true bark 全链投递/gate 复用无基线） | outbound.ts:13-29 | PR2 红测先行 3 |
| S3-28 | T3-10 waitMergeWindow 3.2s×6≈19.2s 固定等待 | helpers.ts:374 | 基建（PR1/PR2 短窗注入） |
| S3-29 | 工厂级直测缺失：history/status/settings-bridge/outbound/aggregate/event-handlers 零直测 | §3 审计 + 子代理 grep | L1 补测（PR1/PR2） |
| S3-30 | 核心状态机无变异面（service/event-handlers/aggregate/channel-*/outbound/settings-bridge/status 不在 mutate 4 段） | mutation-topology:196-238 | ✅ 已修（PR2 T2-7 按域重划 8 段，核心状态机 pipeline/events 全量入面，盲区文件并入对应域段） |
| S3-31 | stryker testFiles 9 清单缺口（7 文件不在：含 e2e-interrupt/unit-sse-hub/unit-webhook 等） | mutation-topology:184-194 | PR1 变异配置更新 |
| S3-32 | message.ts 单文件变异段 145s「物理极限」（拆三文件后失效） | mutation-topology:219-227 | PR1 段边界重定 |

### 7.3 测试分层映射（与 architecture-redesign.md §11 对应）

| 层 | 现有测试归位 | 新增测试（编号 N-x，落位 PR） |
|---|---|---|
| L0 静态契约 | （无） | N-1 import 门禁脚本测试（PR1）；N-2 导出面快照 diff 测试（PR1）；N-3 wiring 接线 dsh-notifier/test/tsconfig.json（PR3） |
| L1 层内单元 | unit-config / unit-text / unit-sanitize / unit-sse-hub（shared 层）/ unit-webhook（渲染+scrub 面） | N-4 stores 直测（history/status 写队列原子写，PR1）；N-5 settings-bridge CAS 直测（PR1）；N-6 aggregate 直测（PR1）；N-7 event-handlers 判定直测（adjudicate 拆分时导出核心函数，PR2）；N-8 pipeline/adjudicate 裁决矩阵直测（PR2）；N-9 pipeline/deliver 截断·重试门·fail-soft 直测（deps fake，PR2）；N-10 outbound 装配直测（PR2）；N-11 server/system-notifier spawn 注入直测（节流/8s 杀进程/失败终态，PR2）；N-12 server/sse-bus 600 帧边界直测（PR2）；N-13 channels/bark 单次投递+retryable 标记直测（PR2） |
| L2 interface 契约 | service-contract（ABI 面）/ unit-webhook（SPI 面）/ client-contract（两端契约） | N-14 AdjudicateDeps 注入面契约（PR2）；N-15 DeliverDeps 注入面契约（PR2）；N-16 ConfigPort 降级语义契约（readUser 未 attach/writable=false，PR2） |
| L3 集成（user case） | e2e-approval / e2e-done / e2e-interrupt / e2e-question-turn / e2e-edge / routes / migration / real-context / client-style | N-17 B-1 脱敏全链路（suppressed/merged 落史也脱敏，PR2）；N-18 B-2 投递决议快照化（裁决→投递间改配置，PR2）；N-19 B-3 重试/门框架化全链（enabled:true bark，PR2）；N-20 B-4 sanitizeContent 开关链路（默认 true 脱敏 + false 明文，PR2）；N-21 B-5 disabled 不落史保持（PR2）；N-22 C3-1 seq 回退恢复（PR2）；N-23 S3-12 maxConnections 清空守卫（PR2） |
| 变异分层 | 8 域段已落地（配置/text/pipeline/events/channels/stores/server/sdk；PR2 T2-7） | N-24 pipeline/events 段纳入变异面 ✅ 已落地（PR2 T2-7）；message 段重定（PR1）；testFiles 补 7 文件（PR1）+ 再补 9 文件（PR2 T2-7，15→24） |

### 7.4 user case 集成场景矩阵（骨架；F 编号 → 场景 → 现有 → 新增）

| 场景（user case） | F/规则矩阵 | 现有覆盖 | 新增 |
|---|---|---|---|
| 审批通知（含免打扰豁免/askRemind 二次提醒） | C1/D5 | e2e-approval | B-1 脱敏断言 |
| 提问通知（userQuestions 包装/热重载） | C2 | e2e-question-turn | — |
| 完成状态机（running→idle 证据链/子代理分流/快照冻结） | C3 | e2e-done（强） | — |
| 错误合并滚动窗口（suppressed:merged 落史） | C4 | e2e-done/e2e-edge | B-1 落史脱敏断言 |
| 完成风暴聚合（首条即时+窗口补发） | C7 | e2e-done | — |
| 动态 kind 注册/确认/防冒认 | D4/D6 | service-contract | B-6 配置层注册面文档化 + registerChannel 登记/一次性 warn |
| 免打扰（跨午夜/allowKinds） | D5 | unit-config | — |
| 路由/onlyChannel/稀疏命中/stale | D6 | service-contract | N-19 全链 |
| fail-soft 逐频道 + 受理/终态解耦 | D7 | service-contract | N-9 |
| 渠道投递（bark 双查/重试/webhook 模板/scrub） | G | unit-webhook | N-13/N-19/N-20 |
| SSE 帧契约（sound.mode/tone/playOnly/seq 补拉） | D9 | client-contract/routes | N-22（seq 回退） |
| 系统通知（toast/自播/节流/超时杀进程） | F | **零断言** | N-11（spawn fake） |
| 配置 CRUD（掩码/CAS/迁移/409/503） | A/E | routes/migration/unit-config | N-16 |
| 客户端半区（可见性/多标签/降级/音频） | H/I | client-contract/style | dsh-verify-isolated 实测盲区 |

### 7.5 分阶段缺陷落位（路线 C 四 PR：PR0 测试先行 → PR1 搬家 → PR2 行为重构 → PR3 收尾）

| 阶段 | 任务 | 缺陷/盲区落位 | 门禁 |
|---|---|---|---|
| **PR0 测试基建 + 红测先行**（D17） | flake 修复（16 处固定 sleep → 轮询/短窗注入，含 migration 4×30ms 负向观察窗、waitMergeWindow 3.2s→注入短窗，S3-20/S3-28）；红测基线 8 条在现状代码建立（S3-21/22/27 + B-2 快照化基线 + event-handlers 判定直测 + sse-bus 600 帧 + 类型面接线前置 + 静态契约同步 S3-25/S3-26）；fetch mock 白名单外拒绝加固（S3-23） | S3-20/21/22/23/25/26/27/28 | 纯测试基建 + 轻微行为无关注入改造（spawn 依赖注入，理由在 PR 描述）；全门禁全绿；spawn 行为可注入直测（§7.8 实施记录） |
| **PR1 机械搬家+门面+变异更新** | 16 平铺→目录树；interface.ts 落地；导出面快照；stryker/mutation 路径更新 + testFiles 补 7 文件 + message 段重定（S3-31/S3-32）；L1 补测 N-4/N-5/N-6（stores/settings-bridge/aggregate 直测） | S3-29(部分)/31/32 | 零行为变更；导出面快照 diff = 基线；变异配置随行（D16）；build/test/contract/typecheck/pack:check 全绿 |
| **PR2 行为重构** | adjudicate/deliver 拆分 + current() 快照 + 播放决议快照化（B-2）；重试/门上移（B-3）；脱敏统一时点 + sanitizeContent（B-1/B-4）；ConfigPort/RouteDeps（S3-2/5/6）；SPI mergeTitleIntoBody（S3-1）；客户端 P1-2/P2-4/C3-1（S3-7/9/12）；变异分段（S3-30）；L1/L2 新增 N-7~N-16、L3 N-17~N-23 | S3-1/2/5/6/7/9/12/16/17/18/30 | 每步对齐规则矩阵；行为变更用例红测先行；全门禁全绿 |
| **PR3 注释清理+门禁+类型面** | 失真注释清单（§9/S3-13）；locales 13 死键（S3-11）；C3-2/C3-7（S3-14/19，D21）+ C3-3 改口径（D20）；类型面接线最终化（S3-24）；import 门禁+环路检测脚本（N-1）；消费方类型编译用例；stale 文案口径修正（D20） | S3-11/13/14/15/19/24 | lint 落地；wiring 接线后类型编译全绿 |

### 7.6 红测先行基线（PR0 主体，PR2 动工前必须补的测试基线）

1. 系统通知 spawn 链直测（fake exec/spawn）：1s 节流（server.ts:323-331）/8s 杀进程（:207-213）/toast 失败不翻转终态（:278-294）/只响不弹自播失败→failed（:262-263/:295-308）/探测不可用→argv null（message.ts:270）——现状零断言（S3-21）。
2. 投递决议快照化基线（B-2）：裁决时读配置→投递前改配置→本次投递仍按裁决快照（现为零，§6.2 点名）。
3. outbound 真 resolver 基线：enabled:true bark 经 apply 全链投递（fetch mock）+ gate 限流门跨配置复用（S3-27/B-3）。
4. event-handlers 核心判定导出+直测（resolveTurnEvidence 等，event-handlers.ts:67-87 未导出，现只能黑盒）。
5. server.ts createSseHub 业务包装直测 + RECENT_LIMIT=600 帧 shift 边界（S3-22）。
6. 测试基建修复：migration 4×30ms 负向观察窗改事件驱动/小窗轮询；waitMergeWindow 改注入短窗（S3-20/S3-28）。
7. 类型面接线：dsh-notifier/test 去 @ts-nocheck 并接入 wiring（S3-24）。
8. 静态契约同步维护清单：real-context onCalls>=7 与 ctx.on 形态正则、client-contract banned/kept 符号表、client-style CSS_VERSION "640-1"（S3-25/S3-26）。

### 7.8 PR0 实施记录（task/notifier-spec 分支）

| 项 | 产出 | 状态 |
|---|---|---|
| flake 修复 | waitMergeWindow 参数化（短窗 50ms）+ pollUntilQuiet（负向观察窗）+ migration/e2e-edge/routes/service-contract/unit-sse-hub 轮询化；套件 8.5s（原 ≥20s 等待 + 130-200 次 execFile） | ✅ |
| 红测先行 1 | unit-system-notifier.test.ts：createSystemNotifier 注入面（execFileImpl/spawnImpl/killTimeoutMs，行为无关）+ 节流/超时杀进程/toast 失败静默/只响不弹自播失败→failed/探测不可用静默 五用例 | ✅ |
| 红测先行 2 | service-contract B-2 快照化基线（current() 读取次数 ≥2 现状结构断言 + 热更即时生效；PR2 后更新为单刻快照） | ✅ |
| 红测先行 3 | e2e-outbound.test.ts：bark enabled:true 经 apply 全链投递（2xx 双查 + 4xx 不重试/终态 failed/脱敏）；fetch 白名单外拒绝（S3-23 加固） | ✅ |
| 红测先行 4 | unit-event-handlers.test.ts：resolveTurnEvidence 导出（行为无关）+ push/快照/stale/记忆/无证据五路矩阵 | ✅ |
| 红测先行 5 | unit-server-sse-bus.test.ts：createSseHub 业务包装（seq/600 帧 shift/framesSince/转发面） | ✅ |
| 红测先行 6/7/8 | 6=flake 已并入；7 类型面接线归 PR3；8 静态契约归 PR1/PR2（real-context/client 契约改 index.ts/client 前先跑） | 登记 |

**残余登记（诚实）**：e2e 的 makeNotifier→apply 链仍真实触发 createSystemNotifier 探测 execFile（notify-send/pw-play 探测，CI ENOENT→warn 静默无害）与投递路径真 spawn（T3-3 残余）——消除需 apply 注入面改造（扩装配契约，风险扩散），本 PR0 不做；spawn 行为已由红测先行 1 注入直测闭合，残余面登记待 PR2 评估。contract 门禁首次在 worktree 全仓 FAIL 为「其他包缺 lib 产物」（worktree 未构建），`pnpm -r --if-present build` 后全绿。

### 7.9 PR1 实施记录（机械搬家 + interface.ts + 变异更新 + 导出面快照；#669）

| 项 | 产出 | 状态 |
|---|---|---|
| 目录树搬家 | 16 平铺 → 8 域（**v2 时点计数**：42 个宿主 TS / 9 interface.ts——勿作现状引用）：config/10、text/4、channels/6、server/4、pipeline/3、sdk/2、events/4、stores/3 + 根 index.ts/~~service.d.ts~~（**#733 M2a 已删除该文件**；**当前实测**：`src/` 下 42 个 TS = 宿主端 38（含根 `index.ts` 与 8 个 `interface.ts`）+ `src/client` 4） | ✅ |
| interface.ts 门面 | 每域 interface.ts 收口（类型 + 工厂 re-export）；verify-dir-imports PASS（42 文件/8 目录，跨目录引用全走 interface.ts；contract 接入 --package dsh-notifier） | ✅ |
| 导出面快照 | scripts/gate/export-surface-snapshot.mjs（**逐入口**：各入口符号集 + 该入口导出面符号的定义块多重集，路径/语句组织免疫）；基线 scripts/data/dsh-notifier-export-surface.json 由 git archive 重构前 src 生成；**重构期零 diff，但该行不再是现状**——#733 M2c 后续 N0(B) 已重冻结为 v2 形态（`entries` 逐入口 + 兼容字段；declBlocks 96 → 105 = 4 条同名签名改写 + 9 条新增 + 0 丢失），故「重构后零 diff」只对重构期成立，此后以基线比对为准 | ✅ |
| service 拆分 | sdk/service.ts 编排（≈330 行）+ pipeline/adjudicate.ts（isBuiltinKind/isKindConfirmed/resolveRoutes）+ pipeline/deliver.ts（truncateCodePoints/deliverToChannel）；函数体逐行等价，行为由全套测试锁定（≤400 行纪律达标） | ✅ |
| 内置频道 | channels/browser.ts + channels/system.ts（PR1 时注入面 createBrowserChannel({sse,current})/createSystemChannel({system,current})——**#733 M1 F3 已收敛为无参工厂**；resolveSoundSetting 回落语义逐字保留）；sdk→channels 值边为 PR1 过渡（§4 图注），PR2 改注入消除 | ✅ |
| mutation 更新 | mutate 路径全改新树；testFiles 9→16（补 e2e-interrupt/unit-sse-hub/unit-webhook/real-context/service-contract/client-contract/client-style，S3-31）；message 段 → text 三文件重定（S3-32）；gen-stryker-conf 26 份重生成 --check 过 | ✅ |
| 新增文件入变异面决策 | 暂不入面（PR1 纯机械搬动零行为变更）；PR2 按域重划段（S3-30/N-24）纳入核心状态机 adjudicate/deliver/event-handlers；interface.ts 纯 re-export 一律不入 | 决策 |
| L1 补测 N-4/N-5/N-6 | unit-stores（写队列原子写/滚动/按天/debounce/64 上限/冷启动）、unit-settings-bridge（attach/降级/CAS 冲突重试 ≤2/耗尽 reject）、unit-aggregate（首条即时/窗口聚合/kind 切换/dispose）；均直测 src 域 interface.ts（§11.2-1；Node24 strip-types） | ✅ |
| 静态契约同步 | real-context/client-contract/client-style 不触达（apply 结构/client 目录未动）；config-matrix 提取器随 config.ts 拆三文件更新（config/validators/normalize + 豁免注解行号） | ✅ |
| 门禁 | 包 build/test/typecheck + 全仓 build + 根 contract（verify-dir-imports/export-surface/config-matrix 全过）+ pack:check 全绿 | ✅ |
| 测试改动 | 仅 3 个 PR0 红测测试的 src import 路径适配（resolveTurnEvidence/createSseHub/createSystemNotifier 不在包导出面，改指域 interface.ts）；lib/index.js 面测试零改动 | ✅ |

### 7.7 G3 决策记录（D16-D21）与隐患登记（R-x）

**决策**（用户 2026 拍板：路线 C + 子决策按推荐）：

- **D16**：变异配置随 PR1 搬家同步更新（testFiles 补 7 文件、message 段重定），不滞后。
- **D17**：采用路线 C 四 PR——PR0 测试基建+红测先行 → PR1 搬家 → PR2 行为重构 → PR3 收尾；红测基线与 flake 修复在现状代码上先建立。
- **D18**：L8-3 NotifyRequest.data 保留声明、注明「MVP 未启用」（ABI 零破坏）。
- **D19**：L8-5 expectedRevision 非整数显式拒绝（400），消除静默忽略（客户端现状不传非整数，实际零影响，登记行为变更）。
- **D20**：客户端口径诚实化——S3-7 频道状态行改 README 口径（「加载/测试后刷新」）；S3-15 stale 路由文案改「stale 已跳过」；均不做功能增强。
- **D21**：客户端低优先级修复取舍——PR3 只做 C3-2（409 横幅残留）与 C3-7（错误文案）；C3-3/4/5/6 登记 backlog 延迟。（**PR2 T2-6 复核**：C3-4（S3-16 fetchStatus 失败清空状态行）与 C3-5（S3-17 showBanner kind 未转义选择器）成本极低（≤5 行），随 T2-6 顺手落地——不推翻 D21 的 backlog 决定，属「有余量顺手做」；C3-3 由 D20 裁定改口径；C3-6（S3-18 writable=false 保存按钮未禁用）保持 backlog。）
- **D22（PR2 动工前，R-6 mini 决策，用户拍板）**：S3-9 seq 归零修复选**选项 A 服务端持久化**——seq 计数器持久化（复用 stores/status.ts 写队列+tmp+rename 原子写范式，500ms 防抖 + dispose 同步落盘）；客户端零改动、D9 帧契约/客户端 ABI 零破坏、旧客户端免升级同步受益。选项 B（客户端回退检测）结构性否决：重启后 k>lastSeq 时数值比较检测不到（情形 2）+ 多标签页丢帧不一致。备选 A'（epoch 广播）不采纳（需客户端+服务端同步升级）。TDD 5 用例 + N-22 锁定（见评审记录）。
- **D23（PR2 动工前，T2-1 播放决议消费链路，用户拍板）**：采纳**DeliverDeps 增 play(target, payload) 注入**（index.ts 装配：browser→sse.broadcast(buildBrowserFrame(payload,spec))、system→system.notify(spec.pop,spec.sound,…)）——spec 值传递、共享实例零状态、并发安全、ABI/导出面不动；内置频道工厂签名收敛为 createBrowserChannel({sse})/createSystemChannel({system})（去 current，消除 sdk→channels 值边）。（**#733 M1 F3 再进一步**：注入参数整体删除，现为 `createBrowserChannel()` / `createSystemChannel()`——F3 原文要求的是窄端口 `FrameSink`/`SystemSink`，实际以「直接删边」达成零边，偏差已回填 #733。）
- **D24（PR2 动工前，T2-1 send 动态 kind 统一，用户拍板）**：send() 动态 kind 路径与 sendKind 统一过裁决（enabled→免打扰→路由），登记行为变更 **B-9**；现状绕过 enabled/免打扰的行为（sdk/service.ts:165-197）先红测锁定再改。

**隐患登记表（R-x，重构全过程风险与缓解）**：

| 编号 | 隐患 | 影响 | 缓解 |
|---|---|---|---|
| R-1 | 重构期间变异面过期（PR1 前 stryker 段指向旧文件路径） | observe 夜检变异得分误报 | D16：PR1 随搬家同步更新；PR0 结束检查 mutation-topology 一致性 |
| R-2 | real-context 静态正则（onCalls>=7/ctx.on 形态/prepend）与 client 契约哨兵在 PR1/PR2 误红 | PR 门禁干扰红绿判断 | S3-25/S3-26 同步维护清单进 PR0 基建；PR1/PR2 改 index.ts/client 前先跑该用例 |
| R-3 | PR2 行为重构回归（8 项行为变更叠加） | 行为漂移难定位 | 红测先行基线（PR0）+ 每步对齐规则矩阵（B-G/C-G/D6/D7）；变更分 commit |
| R-4 | 类型面零校验期间导出面漂移无编译期捕获 | 消费方静默断裂 | PR0 接线前置 + PR3 去 @ts-nocheck 最终化；PR1 导出面快照 diff 兜底 |
| R-5 | 测试套件不自足（worktree 无 lib/，须先 pnpm build） | CI/本地跑测失败误判 | 每 PR 门禁首步 build；PR0 起在 worktree 常态构建 |
| R-6 | C3-1 seq 归零修复选型（服务端 baseSeq vs 客户端回退检测） | 选型不当引入新问题 | **D22 已拍板选项 A（服务端持久化）**；TDD 5 用例 + N-22 锁定（PR2 T2-6 落地全绿）；崩溃窗口锁定：kill -9 最多丢最近 **≤500ms 防抖窗口**内广播的帧（dispose 同步落盘，正常停止零丢失）；**600 帧窗口 shift 静默丢失**（不重启、离线超 600 帧才发生）**不在 R-6 覆盖**——PR2 内点名登记 backlog，防误判 S3-9 全修复 |
| R-7 | PR0 的 spawn 依赖注入改造属「为重构而做」的 src 改动 | 违背「PR0 纯测试」表述 | PR0 PR 描述明示理由 + 行为不变断言（现状行为逐项锁定） |
| R-8 | interface.ts 门面纪律腐化（域内互引/绕过门面） | 依赖图失真、重构目标落空 | PR3 落地 import 门禁脚本 + 环路检测；文档纪律 §3 |
| R-9 | fetch mock 白名单外 fail-open（T3-5） | 测试假网络面 | PR0/PR2 白名单外拒绝加固（S3-23） |
| R-10 | 客户端浏览器实测盲区（音频解锁/多标签租约竞争/横幅视觉/600 帧丢弃频率） | 静态梳理不可达的行为缺陷 | 重构完成后 dsh-verify-isolated 隔离实测一轮（并入「整体重构后审视」清单，用户 G 指令） |
| R-11 | issue #669 方案评审未加 approved 即动工 | 红线流程风险 | 本方案经用户在环批准实施；issue 评论更新状态邀请维护者评审（needs-proposal-review） |

### 7.10 PR3 实施记录（注释清理 + 门禁 + 类型面收尾；#669）

| 项 | 产出 | 状态 |
|---|---|---|
| §9 注释清理 | src 全量清除外部 issue 号与会话/阶段/决策/缺陷内部编号（PR0-PR3、T*-*、S3-*、B-*、D*、M*、N-*、R-*、L8-*、P*-*、G*/Q*/E*/H*/r* 等），保留 why 与领域不变量名（「铁律 1」）；§9 点名的三条失真注释复核：titleMaxLen 语义与重试口径已随 PR2 落地为准（deliver.ts 宽限截断 + channels 重试声明），两处残留失真（`NotifyRequest.body` 的「调用方负责脱敏」、`text/message.ts` 的「TITLES 双映射」）已改写 | ✅ |
| locales 死键（S3-11） | 13 个零引用键删除（zh/en 双删，`NotifierLocaleKey` 编译期锁平衡 173/173）；`routePick` 删除并同步 client-contract 哨兵 | ✅ |
| 客户端 C3-2（S3-14） | `discardChanges` 补 `setConflict(null)`：放弃更改即退出冲突语境，409 横幅不再指向已丢弃的草稿 | ✅ |
| 客户端 C3-7（S3-19） | 冲突恢复拉最新失败改用专键 `conflictReloadFail`（原复用 `saveFailConflict` 且传空 msg，文案错位）；「请关闭本卡片重新打开后重试」过时指引一并移除 | ✅ |
| stale 文案（D20/S3-15） | `routeStaleTitle` 中英改「投递时自动跳过（残留条目不会自动移除）」——原「保存后清理」无实现 | ✅ |
| S3-13 | `playChime` 死函数删除；`playToneForce` 虚构引用改为真实 `playPreview` | ✅ |
| import 门禁 + 环路检测（N-1/R-8） | verify-dir-imports 新增规则 5「域级值依赖图无环」（三色 DFS；type-only 边不入图——sdk⇄pipeline 的 type 边刻意保留）；两模式硬执行；新增 `VERIFY_DIR_IMPORTS_ROOT` 注入以支持隔离 fixture；`scripts/test/verify-dir-imports-cycle.test.ts` 正反两向断言（值环判红报路径 / type 环放行） | ✅ |
| 环修复（规则 5 落地即抓到的结构退化） | `BUILTIN_CHANNELS` 物理定义从 sdk/interface.ts 下沉到 config/config.ts（频道标识与 CHANNEL_KEYS 同族，config 为最底层域），sdk/channels/pipeline 三处改从 config 取，sdk/interface.ts 仅 re-export 保持包导出面。域级值边 12→10（channels→sdk、pipeline→sdk 两条值边消除），环 0 | ✅ |
| 类型面接线（S3-24/N-3） | test/tsconfig.json 加 `rewriteRelativeImportExtensions`（否则 src 侧 `.ts` 扩展名导入全量 TS5097）；service-contract-wiring 的 SUITES 接入 dsh-notifier；15 个契约/单元测试文件去 @ts-nocheck，契约面 502 个错误清零（全量基线 1104） | ✅（分层口径见 D25） |
| 消费方类型编译用例（L0-③） | 新增 `test/consumer-types.test.ts`：以外部消费方视角只 import 包导出面，用 `Equal/Expect` 类型级断言锁死 SDK ABI（7 方法签名）、ChannelCapabilities 5 字段、RouteDeps 结构化字面量、PatchResult 联合与常量面；含 2 条 `@ts-expect-error` 负向断言（指令本身受检）；运行时断言仅作「用例未被绕开」护栏 | ✅ |
| src 类型面修复（接线抓到） | `sanitizeNoticeContent` 的 `enabled` 由 `boolean` 放宽为 `boolean | undefined`——实现按 `enabled === false` 判定（缺省视同开启），原类型面无法表达该容错契约，测试曾被迫用 `undefined as unknown as boolean` 桥接 | ✅ |
| 文档 | 本记录 + §7.11 类型面债务登记 + §7.12 遗留 backlog | ✅ |

**决策**：

- **D25（PR3 类型面范围，用户拍板）**：类型面接线采**分层**口径——契约/单元测试（15 文件）去 @ts-nocheck 并真实参与 tsc 编译；e2e/集成面（12 文件，含 helpers/smoke）保留文件级 @ts-nocheck 并在首行注明技术债，全量去除按 §7.11 T-6 走 follow-up。理由：e2e 面桩对象密集（fake ctx/fetch/子进程/vm 沙箱），修复量占全量错误六成以上而类型收益低（真实信号由契约面承载）。
- **D26（注释清理口径，用户拍板）**：外部 issue 号与内部过程编号一并清理；保留领域不变量名（「铁律 1」）；断言消息等运行时字符串不动（改它属数据变更）。
- **D27（S3-8/S3-10 归属，用户拍板）**：跨窗口同步（S3-8）与历史徽标（S3-10）登记 backlog，不在 PR3 实施（见 §7.12）。

### 7.11 PR3 类型面债务登记（接线实证所得，未在本 PR 修）

| 编号 | 位置 | 现象 | 建议 |
|---|---|---|---|
| T-1 | src/config/normalize.ts（`normalizeConfig` 返回 `NotifyConfig`） | 声明为闭集类型，实现却透传未知键（含 null）——测试断言 `merged.bogus`/`futureRead`/`nullFuture` 被迫 10 处 cast | 返回 `NotifyConfig & Record<string, unknown>` 或独立归一化类型 |
| T-2 | src/config/validators.ts（`sanitizePatchSettings` 返回 `Partial<NotifyConfig> \| null`） | 契约是「未知键透传保留」，返回类型无法表达；src/server/routes.ts 自己回 cast | 返回 `Record<string, unknown> \| null` |
| T-3 | src/config/redact.ts（`redactConfigView<T>(value: T): T`） | 声称恒等 T→T，`undefined` 实返 null（潜伏型：assert.equal 接 unknown 故未报错） | 返回类型 `T \| null` 或显式重载 |
| T-4 | src/config/redact.ts（`unmaskChannels` 成功分支 `channels: unknown[]`） | 丢元素类型，每个消费者各写一份 cast（含 src 内部） | 补元素类型或泛型化 |
| T-5 | src/server/system-notifier.ts（`spawnImpl?: typeof spawn` / `execFileImpl?: typeof execFile`） | node 重载签名，fake 桩无法结构化满足，只能 `as unknown as` | 注入面放宽为最小函数签名 |
| T-6 | test/ 12 个 e2e/集成面文件 | 文件级 @ts-nocheck（D25 分层口径）；helpers.ts 是全量最大阻塞点（84 错误） | follow-up：helpers 先行类型化，再逐文件收口 |
| T-7 | src/config/interface.ts（`NotifyConfig.sanitizeContent` 为必填 boolean） | 消费点按 `!== false` 容错「缺键」（adjudicate/event-handlers 均如此），类型面无法表达缺省形态——契约测试只能 `as unknown as NotifyConfig` 构造 | 二选一：注释与契约改为「undefined 容错」措辞，或让类型可表达缺省 |
| T-8 | src/client/index.tsx（`apply` 的测试直测挂载面 `(apply as any).diffSettingsPayload = …`） | 客户端测试挂载面（diffSettingsPayload/createSaveGuard/assignChannelFields/stripChannelEmpties/clampMaxConnections）无类型声明，vm 直测文件只能各自复制 hook 类型，src 改签名时测试不报错 | 导出 ClientTestHooks interface 或给 apply 挂显式类型 |

T-1~T-5 涉及公共导出类型签名（T-1/T-2/T-4/T-5）或潜伏语义（T-3），按仓库红线「公共 API 行为变更先评审」的口径单列 follow-up，不在 PR3 内改动；T-7 属类型面与注释措辞的张力，同批处理。

### 7.12 遗留 backlog（非 PR3 范围）

| 编号 | 项 | 来源 | 处置 |
|---|---|---|---|
| S3-8 | P1-3 跨窗口无 storage/broadcast 同步（409 被动恢复） | §7.2 | 登记 backlog（D27） |
| S3-10 | P2-1 历史徽标缺 kind-pending/merged | §7.2 | 登记 backlog（D27） |
| S3-18 | C3-6 writable=false 保存按钮未禁用 | D21 | 保持 backlog |
| — | 600 帧窗口 shift 静默丢失（不重启、离线超 600 帧） | R-6 登记 | 保持 backlog |
