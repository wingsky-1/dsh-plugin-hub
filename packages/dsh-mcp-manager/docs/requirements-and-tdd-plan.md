# dsh-mcp-manager 全量需求梳理、Bug 清单与 TDD 重构方案

> 来源：中文 README.md + src/*.ts（宿主端）全量通读 + src/client/* 客户端通读 + test/* 测试审计 + shared 共享层核验。

## 〇、架构分层总览（7 + 4 + 1 层模型）

> 用户给定 7 层（配置管理 / 连接管理 / 注入 dsh / 对外集成 / API / 设置页面 / 胶囊页面）；
> 补 4 层（工具执行/投影、组合根装配、共享基础设施、统计观测）；客户端支撑层依归并口径（胶囊页面若不含支撑则再 +1）。

### 0.1 分层表

| 层 | 归口模块 | 职责 |
|----|---------|------|
| ① 配置管理层 | store.ts / normalize.ts / import.ts / middleware-state.ts / config-schema.ts / apply-config.ts | 全局+项目两级 ServerConfig 持久化（版本化 / mtime 热重载 / 0600 原子写）；normalizeServer 归一化；mcpServers JSON 导入；userDisabled / disabledTools / 目录 last-good 持久化；插件 Config 与 UI 配置 schema |
| ② 连接管理层 | transport.ts / protocol.ts / supervisor.ts / middleware.ts / manager.ts / scope.ts | 传输（stdio/http + env 净化 + ${ENV} 展开）；SDK 适配；单服务器监督器（重连/工具同步/注册卸注册）；中间层连接池（工作空间单元 / in-flight / force / 退避 / LRU / 防双进程）；manager 双轨 reconcile 与生命周期 |
| ③ 注入 dsh 层 | supervisor.syncTools / middleware-register.ts / catalog.ts / apply-guidance.ts / call-stats(埋点) | ctx.tools 注册（mcp__ 前缀 + ws_mcp_* 四原子）；pre-execute guard（工具级禁用三入口）；能力目录 <available_mcp_servers> 注入；systemPrompt section |
| ④ 对外集成层 | apply-services.ts / service.ts / shared/mcp-manager-service.d.ts / settings-namespace / slots·sessions·locale | ctx.mcpManager 8 方法服务面（registerServer→runtimeRegistry 双轨）；其他插件注入/控制/查询；宿主插槽与命名空间接线 |
| ⑤ API 层 | routes.ts / routes-controllers.ts / routes-helpers.ts / sse-hub | 9+ 控制器（servers/config/session/resume/connect/disconnect/reconnect/import/tool-disable/events/health）；loopback 围栏；SSE 状态推送（summary/ui-config-changed/ping/淘汰回收） |
| ⑥ 设置页面层 | settings-card.tsx | 插件设置卡：锚点/偏移/zIndex/中间层模式热切换；POST /config |
| ⑦ 胶囊页面层 | float.ts / panel.ts / servers.ts / quick-add.ts | 浮窗胶囊（锚点/偏移/层级/断点 480/834/触控）；下拉面板（分组/状态/工具 checkbox）；模态管理面板（CRUD/连接控制/JSON 导入） |
| ⑧ 组合根装配层 | apply.ts / apply-config.ts / apply-runtime.ts / apply-services.ts / apply-guidance.ts | 启动顺序：读配置→建 manager→中间层 init→startAll→reconcile→catalog→路由→watchers→提示词→服务面；热切换闭包；卸载收口 |
| ⑨ 工具执行/投影层 | call-result.ts / supervisor(buildToolDefinition) / middleware(callTool) / middleware-utils(withTimeout/redactor) | #512 单一事实源：CallToolResult 白名单投影（isError/content/structuredContent）；文本提取/8KB 截断；schema 子集校验；调用超时；执行侧脱敏 |
| ⑩ 共享基础设施层 | shared/loopback / sse-hub / host-utils / settings-namespace / dsh-home / placement-math / mcp-manager-service / client ensure-style / i18n | 跨插件横向能力；本插件是消费者，非归属 |
| ⑪ 统计观测层 | call-stats.ts / call-stats-types.ts | 默认关闭；调用指标 + 渐进式披露漏斗；1s 防抖原子写盘；Metadata-Only |

### 0.2 依赖关系
- 装配自上而下（⑧→①②③⑤④），调用自下而上。
- ② 是中枢：受 ①（配置热加载 reconcile）、④（registerServer 双轨）、会话路由（cwd→root→连接池/目录）三方驱动。
- ③ 与 ⑨ 是「注册面 vs 执行面」：登记能力（命名/禁用/目录）与执行调用（投影/截断/超时/脱敏）分离，两条执行路径（supervisor 直呼、ws_mcp_call）共用 ⑨。
- ⑤ 是唯一对外边界（HTTP/SSE，loopback 围栏）；⑩ 被所有宿主层依赖；⑪ 横切观测。
- 浏览器端 ⑥⑦ 经 ⑤ 消费宿主能力；客户端支撑（state/session/dom/i18n）是 ⑥⑦ 的底座。

### 0.3 横切关注点（非独立层）
安全（loopback/redactor/env 净化/${ENV} 不落盘/防提示注入）、会话路由（cwd/scope/@root/server 全名一致性）、跨包契约（placement 默认值、sse-hub 共享）、观测（call-stats）。

### 0.4 遗漏层裁定（用户问「有没有漏的层」的结论）
| 层 | 是否遗漏 | 理由 |
|----|---------|------|
| ⑨ 工具执行/投影层 | **漏** | call-result.ts 是 #512 单一事实源，supervisor 与 middleware 两条执行路径共用；不单列则截断/超时/脱敏散落两处，无法对「执行契约」统一约束 |
| ⑧ 组合根装配层 | **漏** | apply 系列决定启动顺序与生命周期；「中间层未就绪窗口」「热切换闭包」都在这层，不单列时序不可见 |
| ⑩ 共享基础设施层 | **漏** | loopback/sse-hub/host-utils/settings-namespace 等为跨插件共享，本插件只是消费者，不单列会误以为归属本插件 |
| ⑪ 统计观测层 | 视口径 | 默认关闭、纯观测；可并入 ③ 的埋点，或独立小层（建议独立，与 Debug 配置耦合） |
| 客户端支撑层 | 视口径 | state/session/dom/i18n 是 ⑥⑦ 的底座；若「胶囊页面」已含支撑则已覆盖，否则需 +1 |
| 传输/协议层 | 已覆盖 | 归入 ② 连接管理（transport+protocol） |
| 持久化层 | 已覆盖 | 归入 ① 配置管理（store + user-state + 目录缓存） |

## 一、功能特性全量清单（宿主端）

### 1. 配置与持久化
- F1-1 全局配置 `<DSH_HOME>/dsh-mcp.json`（`dshHome()` 空串视同未设，#517）：`{version:1, servers:ServerConfig[]}`，0600 权限 + 临时文件 rename 原子写（store.ts）。
- F1-2 版本化存储：磁盘 mtime 基线 + `reloadIfChanged` 检测外部修改（git pull/手动编辑）热生效（store.ts）。
- F1-3 项目级配置 `<项目根>/.dsh/mcp.json`：项目根发现 = 从 cwd 向上找 `.git` / `.dsh`（排除 DSH 全局家目录）/ `.mcp.json` 标记，16 层深，无标记回落 cwd 本身（manager.findProjectRoot）。
- F1-4 项目 store 按 root 缓存（projectStores），缓存命中仍 reloadIfChanged（git checkout 生效）。
- F1-5 服务器配置归一化 normalizeServer：name 必须 `^[A-Za-z0-9_-]{1,32}$`；transport stdio/streamable-http；stdio 必须 command；http 必须 url 且 URL 可解析；enabled 缺省 true；toolCallTimeoutMs 正数取整否则默认 15000；args/env/headers 值转字符串；description trim。
- F1-6 mcpServers JSON 导入（import.ts）：`{serverName: config}` 对象；http/sse/url → streamable-http；command → stdio；env/headers 透传；http 的 env 仅记录 sourceEnv；解析失败/非对象抛错。
- F1-7 插件自身 Config（config-schema.ts）：enabled / announceToAgent / storePath / announceCatalog / catalogMaxEntries / enhanceEmptyDescriptions / resultTruncateBytes / middleware / middlewarePolicy / debug{callStats,statsFile} / ui{position,offset,zIndexBase}；settings 命名空间注册 + 热更新（onChange → SSE ui-config-changed 帧）。
- F1-8 UI 浮窗配置归一化：三种形态（嵌套 ui / 扁平 position+offset / 客户端扁平 offsetX/Y）；非法回退默认；offset 负数 clamp 0 四舍五入；zIndexBase clamp 1–9000；默认 top-right / (8,8,40) / 10。
- F1-9 用户状态持久化（middleware-state.ts）：
  - userDisabled root→Set<name>：`<DSH_HOME>/dsh-mcp-user-state.json` `{version:1, disabled}`，合并式写盘（先读旧文件→内存覆盖→保留已淘汰 root）。
  - disabledTools root→server→Set<tool>：`{version:1, disabledTools}` 三段式，合并写盘、@global 跨空间共享。
- F1-10 目录 last-good 缓存：连接成功时工具描述摘要持久化 `<DSH_HOME>/dsh-mcp-catalog.json`（摘要实质变化才写盘）；中间层 per-root `<DSH_HOME>/dsh-mcp-catalog/<sha256(root)前16>.json`（空采集不写盘、remove 显式清盘）。

### 2. 连接监督器（supervisor，off/project 全局路径）
- F2-1 生命周期：connect → transport.connect → client.initialize（SDK 版本协商）→ syncTools → status=connected；断开 → teardownGeneration → 有界指数退避重连。
- F2-2 重连策略（resolveReconnect）：enabled/initialDelayMs=500/maxDelayMs=30000/maxAttempts=10；已连接 ≥maxDelayMs 后断开重置计数；超预算给出 reason 停止（failed）。
- F2-3 工具注册：远端 tools/list 分页拉全量 → buildToolDefinition；注册失败整体回滚（startup 抛错/非 startup 留空）；工具显示名 publicToolName`mcp__<server>__<tool>`，非法字符替换 `_`，超 64 字符截断加 12 位 sha256 后缀。
- F2-4 工具定义特征：parameters 原样直传 inputSchema；空描述可拼接 `[server.description]`（enhanceEmptyDescriptions 默认 true）；文本渲染 extractText（text/image/audio/resource 占位符）+ truncateText 8KB 截断；execute 调用超时 server.toolCallTimeoutMs??15000；结果经 projectCallToolResult 白名单投影（isError→throw、仅 content/structuredContent）。
- F2-5 输出 schema 严格子集校验（assertSupportedOutputSchema）：type/oneOf/properties/required/additionalProperties(boolean)/items/enum/const/description/title/default/examples；深度 32；循环引用拒；未知键整体回退 {}
- F2-6 运行时注入 registerServer：内存态 runtimeRegistry、同名幂等（existing:true）、串行队列、注册即连接（config 直传）、toolDefinitions 封装路径（裸名→publicToolName、重复/无名抛错、execute 来自调用方）；unregisterServer 先删 registry 再拆连接、回落 store。
- F2-7 stdio 子进程环境净化：父环境剔除凭据形状（KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL/AUTH）与 `DSH_*`；显式 env 支持 `${ENV}` 展开（未设→空串）并合并覆盖；stderr 尾部 4KB 留存（启动失败诊断）。
- F2-8 streamable-http：SDK 传输 + headers `${ENV}` 展开（构造时一次性）；onClose 回调叠加；无独立连接态。
- F2-9 状态机：stopped/connecting/reconnecting/connected/failed/disabled；setStatus 触发 manager.emitStatus（coalesce 同 tick 合并广播）。

### 3. 中间层（middleware，project/all 模式核心）
- F3-1 模式：off（默认兼容直呼）/ project（项目级走中间层）/ all（全局 + runtime 也走中间层）；normalizeMiddlewareMode 非法回落 off；热切换（设置页/API）持久化。
- F3-2 工作空间单元 ProjectUnit：root（realpath）→ {connections, catalog, userDisabled, lastTouchedAt, inFlight}；projectUnitFor 惰性创建 + last-good 目录加载 + 后台惰性连接全部 enabled 服务器。
- F3-3 连接池：ensureConnected in-flight 去重；connectInternal 超时 10s（connect/initialize）；失败 failed + 有界退避（500ms 起 2 倍增、封顶 30s、10 次后停后台重试；用户 connect / ws_mcp_call 触发可再试）；force 受控重建（半开死连接）；abandonInFlight 拆除时废弃在途标记。
- F3-4 防双进程探测：ctx.tools.schemas() 发现同名 mcp__ 前缀注册 → 跳过连接 + 3s 单次 probeRetry；判定封装服务器（toolDefinitions 数组）→ 虚拟连接不 spawn。
- F3-5 目录发现：listToolsAll 分页 + withTimeout 10s；boundCatalogTools 限量（512 工具 / 单描述 4096 字节 / 总量 256KB）；失败 unavailable 段；TTL 24h isCatalogFresh 惰性重发现；内存目录 + 磁盘 last-good。
- F3-6 四个原子工具（middleware-register）：ws_mcp_list（完整盘点、perServerLimit 1–500 默认 50、toolsTruncated、server 全名/裸名过滤、root 路由一致性校验、空返回 message 归因）/ ws_mcp_detail（单工具完整 inputSchema、错误三分）/ ws_mcp_search（关键词检索 server/tool/description/参数名、中文子串匹配、limit 1–10 默认 5、truncated 标志、all 模式多单元合并）/ ws_mcp_call（@root/server 全名路由、先查禁用表再查策略、工具级禁用、CALL_TIMEOUT 30s+2s 兜底、封装直呼分支、stale 目录前置提示、结果白名单投影）。
- F3-7 路由一致性：checkMiddlewareRoot——目标 root 必须=当前会话 root 或 all 模式 @global；project 模式传全局服务器 → 引导 mcp__ 直呼；其余硬拒绝（防跨空间串台）。
- F3-8 模式可见范围：project → [项目root]；all → [项目root, @global]（root 自身为 @global 去重）；resolveRoot 从 agent.session.header.cwd 解析，all 模式空 cwd 且全局有配置时回落 @global。
- F3-9 策略 middlewarePolicy：denyTools 优先、allowTools 白名单（全名优先匹配、裸名回落）；glob 仅 `*` 通配；策略只约束 ws_mcp_call（list/search/detail 纯读不经 guard）。
- F3-10 工具级禁用三入口统一 isToolDenied：ws_mcp_call（callTool 先查禁用再查策略）/ pre-execute guard（mcp__ 直呼）/ 纪律裸名（dsh-codegraph 侧）；root 命中优先、非 @global 回落 @global 共享记录；只作用于 mcp__ 前缀（含 all 模式 runtime 封装工具）。
- F3-11 LRU 淘汰：单元上限 16（@global 豁免），淘汰 lastTouchedAt 最旧；teardownUnit 断开全部连接、保留目录缓存。
- F3-12 脱敏 redactor：stdio env 全值 + args 中 token/secret/pass/key/auth/cookie/credential 形参值；http headers 全值 + URL（含 username/password/searchParams）；错误消息替换 [REDACTED]（按长度降序）。
- F3-13 ws_mcp_call 参数归一化：arguments JSON 字符串最多 4 层解包；tool 名剥 mcp__<server>__ 前缀。

### 4. 路由与事件推送
- F4-1 路由全集（loopback-only 除 config GET）：/api/dsh-mcp/servers（GET 纯读快照/POST 添加/PATCH 更新/DELETE 删除，?name &scope）、/session（POST cwd）、/resume（POST）、/servers/connect|disconnect|reconnect（POST）、/import/json（POST）、/tool-disable（PATCH）、/config（GET 豁免 + POST 更新 UI 配置或热切换 middleware）、/events（SSE）、/health。
- F4-2 围栏语义：guardLoopbackMethod 403 先于 405；config 端点非白名单方法 405 先于 loopback（刻意例外）。
- F4-3 SSE（#515 共享 sse-hub）：30s data ping 心跳、上限默认 16（stalled 优先淘汰、其次最老）、stalled 90s 超窗回收、maxAge 120min+idle15min 轮换、写抛错 3 次判死；客户端 60s watchdog + visibilitychange/pageshow 强制重建 + resume；SSE 连续 CLOSED 3 次降级 10s 轮询。
- F4-4 变更点驱动（#111/#228）：GET /servers 纯读零副作用；磁盘变更经 fs.watch（防重入 busy/rerun）→ refreshFromDisk → 有变化才 reconcile + emitStatus。

### 5. 能力目录（L1 注入）
- F5-1 数据源：composeCatalogEntries 优先级 = 用户 description > 目录缓存摘要 > 仅服务器名；≤catalogMaxEntries(默认6)。
- F5-2 digest 只含服务器名集合（描述改变不重注入）；history-based 去重（session.snapshotEvents() 倒序找最后可见 mcp-catalog 消息）。
- F5-3 注入形态：首次 renderMcpCatalogMessage / 变更 renderMcpCatalogUpdate（声明替换旧目录）；compaction/resume 后不可见重新注入；从未发布且无服务器不注入。
- F5-4 引用安全：escapeCatalogText 转义 & < > 与换行；单条 180 字符、摘要 240 字符、单句 120 字符。
- F5-5 摘要稳定性：每工具首句（firstSentenceOf：句读后须空白+大写/汉字才算新句，防 1./URL/缩写误切）按工具名升序+去重拼接；重连相同描述不触发缓存更新。
- F5-6 注入端视图（#569）：supervisor 摘要缓存为基底，中间层 per-root 目录摘要覆盖（scope+模式解析，跨 scope 不混配），单元缺失读磁盘 last-good（mtime 缓存）。
- F5-7 引导文案：project 条目 → 强制 ws_mcp_*；global 条目 project 模式 → mcp__ 直呼；all 模式 → ws_mcp_*。

### 6. 服务面 / 统计
- F6-1 ctx.mcpManager（apply-services + shared/mcp-manager-service.d.ts）：registerServer/unregisterServer/connect/disconnect/reconnect/getStatus/getTools/list；类型声明合并。
- F6-2 调用统计（call-stats，默认关闭，settings.yaml debug.callStats 开启）：recordCall 的 total/success/failed + 每工具 calls/success/errors/totalDuration/avg/max/lastCalledAt/lastError(200字符)；渐进披露漏斗 searches/lists/details（键截断 100 字符）；1000ms 防抖原子写盘（tmp+rename）；Metadata-Only（不存 arguments/content）；退出 dispose flush。
- F6-3 健康检查 /health：supervisors + 中间层单元双计数。

### 7. 跨包契约
- F7-1 浮窗默认 top-right/8px/高约26px：dsh-provider-usage 依赖此默认（offsetY 48 让位）。
- F7-2 共享层单一事实源：placement-math.js / sse-hub.js / host-utils.js / loopback.js / settings-namespace.js / dsh-home.js / mcp-manager-service.d.ts / client ensure-style / i18n。

## 二、宿主端 Bug 候选清单（待客户端/测试子代理合并后定稿分级）

| # | 位置 | 现象 | 与规格偏差 | 严重度 |
|---|------|------|-----------|--------|
| B1 | supervisor.ts:337 + 390-419 | 重连触发 connect() 时 connectedAt 已被 scheduleReconnect 置 undefined → setStatus("connecting")，把 "reconnecting" 覆盖；LED/浮窗展示"连接中"而非"重连中" | README 分级含"重连中" | P1 |
| B2 | call-stats.ts configure():60-70 + flushSync():227 | `configure({enabled:false})` 先置 enabled=false 再调 flushSync，flushSync 首行 `!this.enabled` 短路 → 最后一批脏数据不刷盘即丢 | 注释承诺"关闭时 flush" | P1 |
| B3 | apply-runtime.ts makeResolveRoot:206-217 | all 模式空 cwd 回落 @global 只查 `globalServers()`（=store.data.servers），**不含 runtimeRegistry** → 仅 runtime 注入服务器（如 codegraph）时回落失败，"无法确定工作空间" | README：all 模式 runtime 也归 @global 单元 | P1 |
| B4 | middleware 全链路 | ConnectionEntry.status 无 "reconnecting"；连接失败即 failed，后台退避期间一直是 failed，summarize 永不输出 reconnecting → 中间层模式下分级"重连中"缺失（客户端 counts.reconnecting 恒 0） | README 分级含"重连中" | P1 |
| B5 | manager.ts start():692-750 | 替换**已连接** supervisor（directConfig 变更分支）只置 disposed=true，不调旧实例 disconnect → 旧 transport（stdio 子进程/socket）与旧工具注册残留 | disconnect 语义（关闭 transport+注销工具）未被复用 | P1 |
| B6 | apply-services.ts getTools:41-55 | 中间层接管（project 项目级 / all 全局）的服务器不在 supervisor map → getTools 返回 []，查询面失效 | service 契约"已注册工具列表" | P1/P2 |
| B7 | routes-controllers.ts buildConfigRoute:83-93 | POST /config 传非法 middleware（如 "xxx"）→ normalizeMiddlewareMode→"off" 且热切换+落盘 off——非法值把用户配置静默切成 off，应 400 拒绝 | 输入校验 | P2 |
| B8 | middleware-utils.ts createRedactor:143-155 | http 分支把**整个 URL** 加入 secrets（含无凭据的主机/路径），错误消息中 URL 全部 [REDACTED]，可诊断性差；env 全值同理由 | README："URL 用户信息等凭据形状"，非整 URL | P2 |
| B9 | middleware-utils.ts boundCatalogTools:553-557 | 描述截断 `description.slice(0, MAX_BYTES_PER_TOOL)` 按 JS 字符而非字节；totalBytes 计算用截断前字节数——UTF-8 中文场景超字节上限 | "字节上限" 规格 | P2 |
| B10 | middleware-register.ts executeSearch:181 | `truncated = results.length >= limit`——恰好命中 limit 条也被标 truncated（非截断误报） | "是否因 limit 截断" | P2 |
| B11 | middleware-register.ts handleDirectMcpGuard:604-609 | 从 `mcp__<server>__<tool>` 反解用第一个 `__` 分割——server 名或工具名**含连续双下划线**（`my__server`，允许字符）时反解错位 → 禁用表查错、静默失效 | 不可逆名仅声明"超长哈希"场景 | P2 |
| B12 | sse-hub.js dispose():213-216 + routes.ts:124 | dispose 注释称"destroy 全部连接"，实现只 clearInterval，连接残留在浏览器端直到客户端 watchdog 重建 | 注释/实现不符（低危） | P3 |
| B13 | normalize.ts:33-37 | streamable-http URL 只做 `new URL()` 可解析校验，`ftp://`/`file://` 等非 http(s) 协议被接受 | "streamable-http(远程)" 暗示 http(s) | P3 |
| B14 | middleware-utils.ts normalizeArguments:89-112 | JSON 解析出**数组**也返回（`typeof parsed === "object"`），数组作为 arguments 传给 callTool（MCP 规范 arguments 应为 object） | 参数归一化语义 | P3 |
| B15 | config-schema.ts:120 + middleware-types.ts:19-24 | middlewarePolicy 的描述/注释写"server 为裸名"，实现与 README 是全名优先+裸名回落 | 文档/注释滞后 | P3 |
| B16 | supervisor.ts publicToolName:63-69 | 非法字符替换 `_` 与超长哈希混用：同名归一化冲突（`a-b`/`a_b`）在 syncTools 抛"listed more than once"，README "冲突时哈希后缀"表述有歧义 | 文档/实现口径 | P3 |
| B17 | store.ts save():60-71 | tmp 文件 `${path}.tmp` 固定名；writeFile/rename 失败时 tmp 残留且异常上抛（无清理） | 原子写健壮性 | P3 |
| B18 | middleware.ts scheduleReconnect:294-312 | 中间层退避硬编码 500/30000/10，**忽略 server.reconnect 配置**（supervisor 用 resolveReconnect 解析）——同配置在两条路径行为不一致 | README：断线重连策略 | P2 |
| B19 | manager.ts summarize supervisor 分支:1154 | 禁用查询 `@global ?? projectRoot`（二者只取其一），中间层项目单元分支是"unit.root **或** @global 合并判定"——两分支口径不一致 | 口径统一 | P3 |
| B20 | apply-runtime.ts setupRoutesAndBroadcast:116-118 + manager.emitStatus | 状态广播只发 {type:"summary"}，客户端收到后 GET /servers；但 summarize 对中间层 failed/重连中状态变化可能被 coalesce 合并漏发（低频） | 推送可靠性 | P3 |

## 三、需求规则要点（供 TDD 测试用例反推）
- 服务器名/工具名命名空间、64 字符/哈希规则、超长不可逆语义。
- 重连：有界指数退避、预算耗尽停止后台重试、用户操作/调用可再试、已连接>maxDelay 后断开重置计数。
- 工具结果 8KB 截断、调用超时默认 15s（可按 server 覆盖）、中间层 30s 固定。
- 项目/全局两级、同名冲突（全局优先、runtime 优先）、cwd 会话路由、@root/server 全名一致性校验。
- 策略 deny 优先 & allowTools 白名单 & 工具级禁用三入口一致 & @global 跨空间共享。
- 安全：0600+原子写、${ENV} 引用不落盘明文、子进程 env 净化、loopback 围栏、redactor 脱敏、防提示注入转义。
- 状态：六态分级（connected/connecting/reconnecting/disabled/stopped/failed）、coalesce 广播、SSE 自愈三防线。
- 持久化：版本化 JSON、mtime 热重载、user-state 合并写盘、目录 last-good 不随连接抖动。
- 客户端 UI：浮窗四锚点/offset/zIndex clamp 1-9000/断点 480/834、底部锚点向上弹出、移动端触控 ≈44px、设置卡片热保存。
---

## 四、TDD 重构方案思路（草稿，待评审细化）

### 4.1 目标与约束
- 目标：以「需求规格→测试用例」全量矩阵驱动，先红后绿重构 dsh-mcp-manager，修掉已发现 bug 并补全覆盖，提升可测性与代码质量。
- 仓库约束（AGENTS.md / docs/DEVELOPMENT.md）：
  - 独立 worktree（git worktree add ../dsh-hub-task-N -b task/N）开发；主 checkout 不动。
  - 红线：先建/认领 issue + 方案评论（needs-proposal-review → approved）再动手。
  - 门禁：pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck；质量指标 cov + crap（scripts/data/gauntlet.config.json 阈值）。
  - 测试单份维护：test/*.test.ts 测 lib 产物；stryker 经 lib→src hook 复用（#423），不写 .src.test.ts 双份。
  - 防 flake：mkdtempSync 隔离落盘、pollUntil/事件驱动替代固定 sleep（helpers.ts 是单一事实源）。
  - 客户端契约门禁：assertClientProductContract / assertClientSourceContract（test/smoke-lib）。

### 4.2 测试分层策略（金字塔）
- L0 纯函数层（无副作用，红绿最快）：normalizeServer / publicToolName / truncateText / assertSupportedOutputSchema / extractText（内部，可通过 buildToolDefinition 或导出）/ expandEnv / parseSsePayload / globMatch / policyAllows / policyDenialReason / isToolDenied / toolDisabledReason / normalizeToolName / normalizeArguments / parseFullServerName / fullServerName / bareServerName / scoreTool / searchCatalog / searchCatalogMulti / listCatalog / findToolDetail / boundCatalogTools / isCatalogFresh / withTimeout / createRedactor / msgOf / summarizeToolDescriptions / firstSentenceOf / digestCatalogEntries / escapeCatalogText / composeCatalogEntries / resolveCatalogInjection / fromClaudeEntry / parseClaudeJson / normalizeUiConfig / buildConfigUiPatch / normalizeScope / normalizeMiddlewareMode / clampZIndexBase / panelTopForAnchor 等 placement 纯函数 / projectCallToolResult / defaultCallResultFallbackText / parseDisabledTools / readCatalogEntries / catalogHistory / stripMcpPrefix（视导出）。
- L1 状态机层（mock 协议/传输）：McpStore（load/save/reloadIfChanged/损坏容错/0600 权限）/ ConnectionSupervisor（连接成功/失败/重连退避/预算耗尽/工具同步/封装路径/代际清理）/ McpManager（reconcile/start/stop/add/update/remove/connect/disconnect/registerServer/unregisterServer/setSession/findProjectRoot/summarize/catalogServersFor/catalogViewFor/resumeReconnect）/ McpMiddleware（projectUnitFor/ensureConnected/connectInternal 超时/force/abandonInFlight/discover/persistCatalog/removeCatalogEntry/loadCatalogCache/callTool/封装直呼/evictIfNeeded/teardownUnit）。
- L2 契约/集成层：routes（loopback 403/405、各控制器、import、tool-disable 路由一致性）/ apply（装配、enabled:false、中间层热切换、watchers）/ SSE hub（心跳/淘汰/stalled/maxAge，短心跳注入）/ service 契约（静态扫描）/ 客户端契约（构建产物断言）。
- 客户端 UI（playwright/chrome-devtools 隔离实测，dsh-verify-isolated skill）——不并入单测门禁，走隔离浏览器验证。

### 4.3 测试用例生成方法论（需求规则→用例矩阵）
- 从本梳理的「需求规则要点」逐条展开：正常路径 + 边界 + 异常 + 幂等 + 并发/竞态 + 安全。
- 每个已确认 bug 先写「红测试」（精确复现：断言当前错误行为不存在/期望行为出现），再修复（绿），再防回归。
- 边界值表：64 字符名（65/63）、name 32 字符、zIndex 1/9000/9001/0/-1/NaN、limit 1/0/负/500/501、TTL 边界、字节截断边界（多字节字符/恰好/超）、JSON 解包 4 层/5 层、重连 attempt 10/11、withTimeout 超时/abort 竞态。
- 矩阵化：功能特性 F × 场景 S（happy/边界/异常/并发/安全）→ 用例 ID（可追踪到需求）。

### 4.4 分阶段计划（每阶段独立 PR）
- 阶段 0：规格与矩阵（本梳理产出 → docs/ 需求规格文档；issue 挂方案）。
- 阶段 1：测试基建重构——补 helpers 原语（如 fakeTransport/fakeMCPClient 协议桩、fakeHost 标准件）、用例组织（按模块分文件仍走 smoke 聚合）、stryker 配置核对；纯函数红测试先行（修复 B8/B9/B10/B13/B14/B15/B16/B17 等纯函数层 bug）。
- 阶段 2：状态机层——supervisor（B1/B5）、call-stats（B2）、manager（B3/B6）、middleware（B4/B11/B18）红测试 + 修复。
- 阶段 3：集成/契约层——routes（B7）、SSE hub（B12）红测试 + 修复；补齐覆盖缺口矩阵。
- 阶段 4：质量门禁闭环——pnpm cov/crap/mutation 达标；客户端隔离浏览器验证（UI 相关改动）；文档同步（README 修正 B15/B16 等文档滞后）。

### 4.5 风险与取舍
- 测试框架：保留自建 runner（smoke.test.ts 聚合 + node assert）vs 迁移 node:test/vitest——迁移成本高、stryker hook 依赖单份断言，倾向保留现状 + 规范化组织；如迁移需单独决策。
- 重构范围控制：以 bug 修复 + 覆盖补全为主线，不做大范围重写（避免回归）；纯函数先行，状态机次之。
- 与既有 gate 的兼容：新增测试必须能在 smoke 聚合内运行、stryker 可变异。

---


## 五、客户端功能特性与 Bug 候选（子代理完整报告要点，含行号证据）

### 5.1 客户端架构
- index.ts 装配层：createState + UiActions 注入（feature 模块不互相 import，跨模块动作经 actions 回调）；SSE 三防线（30s 心跳喂狗 / 60s watchdog / visibilitychange+pageshow 强制重建）；首刷 500ms/1s/2s 退避重试；maybeRecoverSession（SSE 建连核对宿主 projectRoot）；effect 卸载清理。
- state.ts 单一 McpState；float.ts 浮窗胶囊 + 下拉面板（锚点/偏移/层级 clamp/断点 480/834/移动端触控）；panel.ts 模态面板（→servers/quick-add/float 单向汇聚）；servers.ts 列表与操作；quick-add.ts 表单/JSON 导入/编辑回填；session.ts 会话跟随；settings-card.tsx 设置卡。
- 状态流转链路：SSE 帧 → scheduleRefresh(500ms 合并) → refresh(单飞) → doRefresh 全量重渲染；会话 sessions.subscribe → POST /session → refresh；设置卡保存 → POST /config → 宿主广播 ui-config-changed → GET /config 重定位。

### 5.2 客户端 Bug 候选（15 条）
| # | 级别 | 位置 | 现象 |
|---|------|------|------|
| C1 | P1 | quick-add.ts fillForm L85-100 | resetForm 强制 checked=true 后从不回填 fill.enabled；编辑 enabled:false 服务器保存 → PATCH enabled:true → 宿主 update 自动 start 连接（manager.ts L958-961）——未经用户勾选静默重新启用并连接。修复=fillForm 补 `formEnabled.checked = fill.enabled !== false` |
| C2 | P2 | index.ts L148-162/L247-253/L263-269 | esFailures≥3 → startPolling 永久置 eventsRetired，forceReconnect 永久 return；SSE 无恢复路径，实时性永久降级 10s 轮询直到整页刷新 |
| C3 | P2 | style.css L63/75/141-142 | 超长工具名（哈希后缀）/服务器名无溢出保护（仅 .dm-float-name L38 有 ellipsis），narrow 档横向撑破面板/卡片 |
| C4 | P2 | panel.ts L114-116 | Escape keydown 匿名监听器无 removeEventListener，HMR/重复 apply 累积泄漏 |
| C5 | P2 | settings-card.tsx L77 | 成功提示 setTimeout 无清理，组件卸载后仍 setState |
| C6 | P2 | servers.ts L45 / float.ts L55 | projectRoot 缺失（#412 宿主重启）时拼 `@/name`，宿主 parseFullServerName slash<=1 拒绝 400（触发窗口极窄但契约未防御） |
| C7 | P2 | float.ts L96/103/113/124 | 浮窗 connect/enable/disable 不带 cwd，与 servers.ts L107/114/124/129 不对称——#412 场景浮窗操作不自愈 |
| C8 | P2 | servers.ts L49 / float.ts L59 | checkbox 操作后 actions.refresh 全量重建，<details> 折叠态丢失，连续禁用 N 个工具需反复展开 |
| C9 | P2 | index.ts L247-253 | SSE CLOSED 未达 3 次时最长 65s 推送空窗（设计内：交 watchdog 兜底，但值得文档化） |
| C10 | P2 | panel.ts L73-74/L120 | 管理面板打开只刷新当 servers 为空；中间层热切换 reconcile 无变化不发 summary 帧时，面板旧数据与新 middlewareMode 短期错配 |
| C11 | P3 | quick-add.ts L106-112 | 编辑改 scope 后 PATCH 用新 scope 查旧 name → 400 not found 无引导 |
| C12 | P3 | settings-card.tsx L144 | offsetX/Y/blankY 客户端 max=2000，宿主 normalizeUiConfig 只 clamp≥0 无上限（clampPointToViewport 兜底不越界） |
| C13 | P3 | servers.ts L176-178 vs float.ts L168-170 | 未知 status：servers.ts 静默丢卡 vs float.ts 塞 stopped——两处策略不一致 |
| C14 | P3 | dom.ts api | 路由均返回 JSON body，未来加 204 路由会静默 undefined（备忘） |
| C15 | P3 | panel.ts L114-116 + float.ts L286-292 | 触屏 focus 语义弱，移动端点外部可能不自动收起（体验） |

### 5.3 客户端-宿主契约核对结论
- ✅ tool-disable 的 `@@global/<name>` 与 `@<绝对路径>/<name>` 形态与宿主 parseFullServerName 归一化 + 路由一致性校验（root ∈ {@global, sessionRoot}）完全匹配；裸 tool 与 normalizeToolName 剥前缀一致。
- ✅ SSE summary/ui-config-changed/ping 帧语义、config 扁平读写、connect 的 cwd 恢复（maybeSession）、session/resume 链路逐项一致。
- ⚠️ 风险：① tool-disable 依赖 projectRoot 非空（C6）；② 设置卡切 middleware 时 ui-config-changed 帧不拉 /servers，依赖 summary 帧补位（时序契约非硬保证）；③ disconnect 路由支持 cwd 但浮窗不带（C7 客户端不对称）；④ 客户端假定状态集合有限（6 种，宿主一致；未来扩展会丢卡/错归类）。

---

## 六、TDD 重构方案（详细版，待对抗性评审）

### 6.1 目标定义
- **主目标**：以「需求规格 × 场景」全量矩阵驱动，先红后绿修复已确认 bug（含客户端 P1），并系统补全测试覆盖，把 dsh-mcp-manager 的变异得分从基线 58.74% 提升过门禁 60%（观测期窗口内），同时把 covered 74.66% 提到 ≥80% 的合理目标。
- **质量杠杆（基线来自 gauntlet.config.json）**：存活变异体 389、无覆盖 416——修复一个「有测试但断言弱」或「无覆盖」的模块，对应一批变异体。按模块优先级：supervisor/manager/middleware 三块占大头。
- **不做什么**：不重写协议层与连接池核心语义；不迁移测试框架（保留 smoke 聚合 runner + node assert + helpers 原语）；不做与 bug 修复/覆盖补全无关的架构重构（避免回归面失控）。

### 6.2 测试分层与目标模块（金字塔）
- **L0 纯函数**（无副作用、红绿最快）：normalizeServer / publicToolName / truncateText / assertSupportedOutputSchema / extractText(经 buildToolDefinition) / expandEnv / parseSsePayload / globMatch / policyAllows / policyDenialReason / isToolDenied / toolDisabledReason / normalizeToolName / normalizeArguments / parseFullServerName / fullServerName / bareServerName / scoreTool / searchCatalog / searchCatalogMulti / listCatalog / findToolDetail / boundCatalogTools / isCatalogFresh / withTimeout / createRedactor / msgOf / summarizeToolDescriptions / firstSentenceOf / digestCatalogEntries / escapeCatalogText / composeCatalogEntries / resolveCatalogInjection / fromClaudeEntry / parseClaudeJson / normalizeUiConfig / buildConfigUiPatch / normalizeScope / normalizeMiddlewareMode / placement 纯函数族 / projectCallToolResult / defaultCallResultFallbackText / parseDisabledTools / readCatalogEntries / catalogHistory / stripMcpPrefix(导出或经 summarize 观测)。
- **L1 状态机**（mock 传输/协议桩）：McpStore / ConnectionSupervisor / McpManager / McpMiddleware / McpStatsCollector / sse-hub。
- **L2 契约/集成**：routes 控制器（403/405/方法分流/参数校验/路由一致性）/ apply 装配（enabled:false/热切换/watchers）/ service 契约静态扫描 / 客户端契约（build 产物断言）。
- **L3 客户端 UI**：隔离浏览器实测（dsh-verify-isolated skill），不并入单测门禁；本轮 bug 修复的 UI 项（C1/C3/C6/C7/C8）需实测佐证。

### 6.3 红测试清单（首轮，按 bug 分派）
| Bug | 红测试形态 | 期望修复行为 |
|-----|-----------|-------------|
| B1 | supervisor 重连：构造失败重连（小退避），轮询断言「重连期间 status==='reconnecting' 而非 'connecting'」贯穿整个重连窗口 | connect() 用 failedAttempts>0 判定中文档状态 |
| B2 | call-stats：recordCall 置脏 → configure({enabled:false}) → 断言文件已刷盘（或 isDirty 语义修正） | flushSync 在关闭路径先刷或不再以 enabled 短路 |
| B3 | middleware all 模式：空 cwd + 仅 runtimeRegistry 服务器 → resolveRoot 断言返回 @global | globalServers() 或 resolveRoot 并入 runtime 源 |
| B4 | middleware：连接失败后 entry.status 断言出现 reconnecting 与 failed 区分（重连窗口内屏显分类） | ConnectionEntry 状态机补 reconnecting 或明确规格化 |
| B5 | manager：start 替换已连接 supervisor → 断言旧 transport.close 被调、旧 toolDisposers 全部 dispose | 替换路径复用 disconnect 语义 |
| B6 | apply-services：middleware 接管服务器 → getTools 返回工具（或规格化声明返回 [] 并补文档） | 查询面与 summary 同源 |
| B7 | routes：POST /config middleware:"bogus" → 断言 400 且配置未被改写 | 非法 middleware 拒绝而非回落 off |
| B8 | redactor：错误消息含 "https://user:pass@host/path" → 断言 user/pass 脱敏但 host/path 保留（或按规格决策） | 按「URL 用户信息」口径脱敏 |
| B9 | boundCatalogTools：中文长描述 → 断言截断后字节 ≤ 上限；totalBytes 口径修正测试 | 字节截断（Buffer 感知）|
| B10 | executeSearch：恰好 limit 条命中 → 断言 truncated===false（未截断不误报） | 截断判定基于「存在更多且被裁」|
| B11 | guard：server/tool 含连续双下划线 → 断言禁用裁决与 stripMcpPrefix 反解一致 | 反解算法与 supervisor 同口径或规格化不可逆名 |
| B12 | sse-hub：dispose() → 断言连接被 destroy（或注释修正为语义文档化） | dispose 语义闭环 |
| B13 | normalizeServer：url "ftp://x" → 断言拒绝（或规格化放行并补文档） | 协议白名单 |
| B14 | normalizeArguments：数组 JSON → 断言拒绝或解包为对象（按规格） | 参数形态收敛 |
| C1 | 客户端 fillForm：编辑 enabled:false → 断言 formEnabled.checked===false | 回填 enabled |
| C2 | 客户端 SSE：eventsRetired 后宿主恢复 → 断言可重连（逻辑单测或实测） | 轮询探测恢复 |
| C6/C7 | 客户端 tool-disable/connect 拼参：projectRoot 缺失 → 断言不提交非法 `@/name`；float 操作带 cwd | 防御性拼参 |
| C4/C5 | 客户端清理：panel keydown / settings timeout → 断言卸载后无泄漏（实测/代码审查佐证） | 清理配对 |

### 6.4 需求规则 → 用例矩阵（示例行，完整矩阵随文档定稿）
| 需求规则 | happy | 边界 | 异常 | 并发/竞态 | 安全 |
|---------|-------|------|------|-----------|------|
| 服务器名 namespace | 合法名 | 32/33 字符、`-`/`_` | 空/含非法字符 | - | - |
| publicToolName | 短名直用 | 64/65 字符、非法字符替换 | - | - | - |
| 重连退避 | 重连成功 | 预算 10 次耗尽 | 重连禁用 | 断开风暴 | - |
| 结果截断 | 8KB 内直通 | 恰好 8KB/多字节边界 | 非字符串 | - | - |
| 调用超时 | 成功 fast | 15s/30s 边界 | 超时抛错带文案 | abort 竞态 | - |
| 策略 deny/allow | deny 命中 | 空数组/`*` | 未知 serverKey | - | 全名优先防串台 |
| 工具级禁用 | 三入口一致 | @global 共享/超长名 | 禁用在策略前 | 并发禁用写盘 | 只作用于 mcp__ |
| 路由围栏 | loopback 放行 | 非 loopback 403 | 跨站点 | - | 方法白名单 405 |
| ${ENV} 展开 | 命中展开 | 未设→空 | 非法名 | - | 不落盘明文 |
| 状态分级 | 六态准确 | 重连中（B1/B4） | - | coalesce 广播 | - |
| SSE 自愈 | 心跳/重建 | 半开 65s | ES 不可用 | 多页并发 | - |
| user-state 写盘 | 合并式 | 破损文件 | 空记录删除 | 并发写 | 0600 |

### 6.5 分阶段执行计划（每阶段独立 worktree + PR）
- **阶段 0 规格固化**：把本文档定稿为仓库 `packages/dsh-mcp-manager/docs/requirements-and-bugs.md`（或独立 issue 正文）；建 issue + 方案评论（needs-proposal-review → approved 后开工）。
- **阶段 1 纯函数红绿**（低风险先行）：B8/B9/B10/B13/B14/B16/B17 + L0 矩阵补全；门禁快速验证。
- **阶段 2 状态机红绿**：B1/B2/B4/B5/B6/B11/B18；引入 fakeTransport/fakeMCPClient 协议桩到 helpers.ts（统一 mock 面，防各测试自造桩漂移）。
- **阶段 3 集成与契约**：B3/B7/B12 + routes/apply 矩阵补全 + SSE hub 短心跳注入测试；客户端 C1–C10（含 dsh-verify-isolated 实测）。
- **阶段 4 收口**：mutation 达标（kill 存活变异 ≥40 个以过 60%，或按模块分批）、crap/cov 门槛、README 文档同步（B15/B16/客户端 C9/C10 等规格声明项）、release-notes。
- 每阶段 PR 关联同一 issue；细粒度状态走 issue 内 `[loop] ts=…` 状态行。

### 6.6 风险与决策点（需评审/用户拍板）
1. **测试框架**：保留自建 runner（推荐）vs 迁移 node:test/vitest——迁移会破坏 stryker lib→src hook 单份断言约定，成本高收益低，倾向保留。
2. **B8 脱敏口径**：整 URL 脱敏（现状，安全激进）vs 仅用户信息脱敏（可诊断性）——需用户拍板，改实现需同步安全模型文档。
3. **B4 中间层 reconnecting**：补状态机（改动面：ConnectionEntry/summarize/客户端）vs 规格化声明「中间层仅 failed+后台重试」（改动面：README/文案）——推荐补状态机保持六态一致。
4. **B6 getTools**：与 summary 同源返回（改动面 apply-services）vs 文档声明仅 supervisor 路径。
5. **C2 SSE 恢复**：轮询期探测重连（推荐）vs 永久轮询（简单）——推荐加恢复路径。
6. **B17 store tmp 清理**：失败时清理 tmp vs 保持现状（低危）。

---

## 七、现有测试审计（子代理报告要点）

### 7.1 运行模型与执行矩阵（关键不对称）
- `pnpm test` = 自研 `run-tests.mjs`（#722 阶段五已退役，文件已从仓库删除；以下为迁移前的运行口径）——逐文件 spawn `node --test --test-isolation=process --test-concurrency=1`，包内串行；smoke.test.ts 内联 check/checkAsync，其余 15 个单元/契约文件由 glob 直接执行（#690 S2 起不再由 smoke import 聚合）；断言 node:assert/strict（仅 unit-call-stats 用 node:test）。
- **#722 阶段一起运行器已由 vitest 取代**：包内 `pnpm test` = `scripts/test/run-vitest.mjs --min 16`
  （根 `vitest.config.ts` 四 project，用例结构为 describe/it）；本节的 runner 描述为迁移前的审计快照。
- 被测 lib/ 产物；stryker 经 `--import scripts/test/mutation-lib-to-src-hook.mjs` ESM resolve hook 把 lib→src 重定向，同一份断言复用（#423）。 **#722 阶段五：该 hook 与 lib 产物重定向已退役**（变异面测试直连 src，hook 随 cov.mjs 同批删除）。
- service-contract.test.ts 双层锁：编译期类型比对（tsc）+ 运行时静态扫描 apply-services 的 provide 方法面（手写括号配对，fail-loud）。
- **三通道不对称**：
  1. smoke 只跑 8 个 unit；
  2. stryker testFiles 是 10 个（多 unit-catalog / unit-store / unit-supervisor / unit-transport）——**这 4 个文件在本地 `pnpm test` 从不执行**，其断言只在 mutation 管线跑；
  3. **unit-call-stats.test.ts 零引用孤儿**——不在 smoke import、不在任何 stryker 配置、不在 mutation-topology.json，其断言（含聚合/重启恢复）**从未在任何门禁执行**（B2 bug 未被发现的直接原因之一）。
- 覆盖质量：store/normalize/transport/supervisor/manager/middleware/catalog/routes 真断言深覆盖（状态机 mock + 临时文件 I/O + smoke SDK 端到端真实子进程重连）；apply/config-schema/placement/catalog 注入决策覆盖全；service 契约双层锁到位。

### 7.2 覆盖缺口清单（待补测试）
- normalizeServer：超长 name(>32)、enabled 非布尔、toolCallTimeoutMs=Infinity。
- publicToolName：恰好 64/65 字符边界、非法字符短名的哈希分支。
- truncateText：极小 maxBytes（budget 下限 64 分支）、多字节边界。
- assertSupportedOutputSchema：深度>32、循环引用、const、items 递归。
- 中间层 scheduleReconnect >10 次 gave up；in-flight 去重返回同一 promise 与所有权校验（abandonInFlight）。
- policyAllows：allowTools 空数组语义（空=放行？规格化）。
- listCatalog：跨 root 排序、toolLimit 非法值回退。
- **createRedactor：凭据脱敏完全零测试**（test 目录 grep 零匹配——安全功能裸奔，与 B8 修复强相关）。
- call-stats：configure 关闭刷盘（B2）、debounce 落盘、100 字符键截断——全无断言且文件孤儿。
- SSE hub：stalled/maxAge/failStreak 包内无测试（共享层由 dsh-notifier 的 unit-sse-hub.test.ts 覆盖——跨包共享模块测试归属问题）。
- 客户端 UI：无运行时测试，仅构建产物/源码正则断言（assertClientProductContract/SourceContract）。

### 7.3 哑断言与脆弱点
- 哑断言：unit-apply.test.ts L79-127/L129-177/L209-247 三块纯哑（无任何 assert）；unit-hotspot L104-168/L262-296 哑；unit-manager2 L309 `X===false||true` 恒真、L323 `logWarnCount===undefined` 恒真空断言；unit-manager L167-251 三个 apply 块半哑。
- 脆弱点：① unit-supervisor L152 读 Node Timer 私有字段 `_idleTimeout`；② unit-middleware L708-726 封装超时用例真实等待 30s（CALL_TIMEOUT_MS，stryker 下放大）；③ unit-manager2 L727 裸固定 sleep 20ms 违反自身防 flake 纪律；④ smoke SDK 端到端 `process.kill(SIGTERM)` 平台差异（Windows）；⑤ schema 交叉校验依赖 dsh-tools 可解析性，失败仅 warning 跳过；⑥ 执行矩阵不对称 → 4 个 unit 断言失败存在漏检窗口；⑦ #218 红线合规（全部 mkdtempSync 隔离，无固定路径落盘）。
- 优先级建议（子代理）：接线 unit-call-stats（补 configure/debounce/截断断言）+ createRedactor 测试为最高；其次把 4 个仅 stryker 面文件纳入 smoke import；清理哑断言与恒真断言。

### 7.4 质量基线（gauntlet.config.json）
- 变异得分 58.74%（阈值 60，**当前不合格**）；covered 74.66%；killed 1141 / survived 389 / noCoverage 416 / total 1951；3m0s；stryker 6 段配置（manager/entry/supervisor/middleware/routes/runtime）。

---

## 八、对抗性评审纪要（子代理独立核验，结论：需修正后执行）

> 评审方式：独立子代理逐行核实 src/test/shared 代码后输出；以下为纠偏后的定稿口径。

### 8.1 Bug 清单纠偏表（B1–B20 / C1–C15）
| 条目 | 裁定 | 修正说明 |
|------|------|---------|
| B1 重连状态覆盖 | ✅成立 | supervisor.ts L337+L399：scheduleReconnect 置 connectedAt=undefined → connect() 覆盖为 connecting |
| B2 call-stats 关闭丢盘 | ✅成立 | call-stats.ts L62 先置 enabled=false，L228 flushSync 因 !enabled 短路 |
| B3 resolveRoot 漏 runtime | ✅成立 | globalServers()=store.data.servers（manager.ts L274）不含 runtimeRegistry；修复改查 projectServersFor("@global") |
| B4 中间层无 reconnecting | ✅成立 | 补状态机或规格化（决策点） |
| B5 替换 supervisor 不清理 | ✅成立 | manager.ts L731–741 替换分支只置 disposed=true；**manager.connect L1011–1017 同病**；修复复用 disconnect 语义（async，依赖 syncChain） |
| B6 getTools 查询面失效 | ✅成立 | 与 summary 同源或文档声明（决策点） |
| B7 非法 middleware→off | ✅成立 | routes-controllers buildConfigRoute：非法值落盘 off |
| B8 redactor 整 URL 脱敏 | ⚠️修正 | 现象成立（L146）；但「仅用户信息脱敏」必须同时注册 raw/decoded 双形态，否则 percent-encoding 绕过回归（L149–150 只存 decoded，错误消息中是 raw 形态，现状靠整 URL 兜住）；**另漏报：supervisor.ts L362 及 manager 各处 logger.warn(String(error)) 错误日志不脱敏**（安全语义变更须过红线流程） |
| B9 boundCatalogTools 字节口径 | ⚠️修正 | L555 字符截断超字节上限成立；文档「totalBytes 用截断前字节→超上限」方向说反（截断前字节更早 break 属保守）；真正低估是 JSON.stringify(inputSchema).length 按码元计 |
| B10 search truncated 误报 | ⚠️修正 | L181 `>=` 恰好 limit 误报成立，但 L179 注释表明是有意设计（P2-3）；精确修复需 searchCatalogMulti 改签名返回截断事实，属跨函数改动 |
| B11 guard 双下划线反解错位 | ✅成立 | 根因是 publicToolName 无分隔符拼接的编码歧义，需映射表或规格化不可逆名 |
| B12 sse-hub dispose 不 destroy | ✅成立 | 注释/实现不符 |
| B13 URL 协议白名单 | ✅成立 | 决策点（拒绝 vs 规格化放行） |
| B14 normalizeArguments 数组 | ✅成立 | 决策点 |
| B15 middlewarePolicy 注释滞后 | ✅成立 | 文档同步到阶段 1 |
| B16 publicToolName 文档口径 | ⚠️修正 | 「冲突时哈希后缀」表述不符成立；但示例 a-b/a_b 是误报（合法字符不归一化，含非法字符必走哈希） |
| B17 store tmp 清理 | ✅成立 | 唯一 tmp 名 + 失败清理 |
| B18 中间层退避/超时口径分裂 | ✅成立 | 中间层 scheduleReconnect 硬编码 500/30000/10 忽略 server.reconnect；CALL_TIMEOUT 固定 30s 不读 server.toolCallTimeoutMs（supervisor 15s）；**另漏报：middleware closeHandler 不递增 failedAttempts（连上断开抖动退避恒 500ms）** |
| B19 禁用查询口径不一致 | ✅成立 | 合并口径 |
| B20 coalesce 漏最终态 | ⚠️修正 | coalesce 不会漏最终态；真正缺口=makeMiddlewareHotSwitch 不 emitStatus（热切换缺 summary 帧，与 5.3 风险②、C10 同根） |
| C1 编辑保存链路 | ✅成立·升格 | 实为「编辑保存整体坏死」：fillForm→resetForm 清空 editingName（quick-add L64-65）→ saveForm 恒走 POST → 宿主抛 already exists；比 enabled 回填严重得多；**先修链路再补 enabled 回填** |
| C2 SSE 永久退役 | ✅成立 | 补轮询探测恢复 |
| C3 超长名溢出 | ✅成立 | CSS overflow-wrap/ellipsis |
| C4 keydown 泄漏 | ✅成立 | 配对 removeEventListener |
| C5 setTimeout 无清理 | ✅成立 | useEffect 清理 |
| C6 tool-disable @/name | ✅成立 | 防御性拼参 |
| C7 float 不带 cwd | ✅成立·修正 | servers.ts L110 disconnect、L136 disable 同样缺 cwd（不止 float） |
| C8 checkbox 折叠态丢失 | ✅成立 | 体验项 |
| C9 SSE 65s 空窗 | ✅成立 | 设计内，文档化 |
| C10 面板不主动刷新 | ✅成立 | showPanel 补 refresh |
| C11 编辑改 scope | ✅已修复（阶段 8） | 阶段 7 C1 修复后 PATCH 分支可达、现象恢复成立；阶段 8 落地为**客户端迁移式保存**：saveForm 检测 name/scope 变化 → 先 POST 新条目再 DELETE 旧条目（宿主 PATCH 按 (scope,name) 定位且强制沿用定位名，不支持改名/改 scope；任何失败即中止保留原条目，避免半迁移脏数据） |
| C12–C15 | ✅成立 | 按原文 |

### 8.2 测试审计补充（评审核实）
- 执行矩阵第四条不对称：service-contract/unit-shared 只在 smoke、catalog/store/supervisor/transport 只在 stryker、**交集仅 6 文件**。
- unit-middleware L718–726 封装超时用例真实等待 **32s（CALL_TIMEOUT_MS+2000，非文档所写 30s）**；smoke.test.ts 第 4 处固定 sleep 25ms。
- 质量基线：变异 58.74%（阈值 60）；「kill≥40 过 60%」经预算 **25 即够**（40 有安全余量）；「covered≥80%」非门禁（coverage 门禁是 selfWritten 60%），应注明「质量目标不卡 CI」。

### 8.3 TDD 方案修正（评审 P0/P1/P2）
- **P0**：① 先修 C1 编辑链路再补 enabled 回填；② B8 修复补 raw/decoded 双形态 + supervisor 日志脱敏 + 安全语义变更红线流程；③ 阶段 0 输出规格决策表清零 6.3 全部「或规格化声明」行（B4/B6/B13/B14）；④ 新测试文件双登记（原为 smoke.ts import + mutation-topology.json testFiles，防三通道不对称扩大）；#690 S2 起 smoke import 聚合已移除，运行面由 glob 自动纳入，仅余 mutation-topology.json testFiles 需登记。
- **P1**：⑤ B10 修复需 searchCatalog 改签名；⑥ B5 修复复用 disconnect 语义（async 依赖 syncChain）；⑦ CALL_TIMEOUT_MS 注入化消 32s stryker 放大；⑧ B1 红测试改状态机断言点（勿整窗口轮询）+ _idleTimeout 改 resolveReconnect 纯函数断言；⑨ B18 扩为口径统一（closeHandler 计数 + toolCallTimeoutMs）；⑩ B17 唯一 tmp 名 + 失败清理。
- **P2**：B19 合并口径、B12 dispose destroy、B20 热切换 emitStatus、B3 并入 runtime；哑断言清理（unit-apply/unit-hotspot/unit-manager2 L309/L323）；user-state 0600；客户端 C6/C7/C2/C8；B15/B16/README 文档同步提前到阶段 1。
