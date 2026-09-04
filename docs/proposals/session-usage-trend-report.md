# 提案：dsh 会话用量「日/周/月」趋势与定时报表

- 状态：待评审（头脑风暴定稿；经独立子 agent 对抗评审 + 两轮路线讨论，定稿为「事件为唯一事实来源」路线）
- 落点：扩展 `dsh-provider-usage` 包（用量入口统一；趋势逻辑独立为包内 `src/trend/` 模块，不与 v2 适配器契约耦合）
- 目标：
  1. 统计「日 / 周 / 月 × 各模型适配器（provider，细到 model 可选）」的 token 消耗与调用次数；
  2. 用量统计页面新增「使用趋势」tab 可视化；
  3. 新增「用量报告」独立 tab：定时生成日报 / 周报 / 月报（网易云年报式叙事），报告的**时间、提示词、所用模型均可配置**；
  4. 定时任务：官方无 cron，先做插件内极简调度器。

---

## 一、数据源

**事件为唯一事实来源（定稿决策）**：DSH 处于预览阶段，`~/.dsh/sessions` 的文件存储结构（逐行 zstd 帧编码、事件类型）属内部实现细节、可能随版本变更；解析文件等于耦合未承诺的实现细节。而 `ctx.on("session/event", ...)` + `SessionEventMap` 是 `@deepseek-ai/dsh-session` **官方类型层的公开契约**（dsh-notifier 已在生产使用），格式变更会在升级 typecheck 时暴露——符合本仓「宿主类型一律走官方类型层」的纪律。

| 数据源 | 内容 | 角色 |
|---|---|---|
| `ctx.on("session/event")` 宿主事件 | `assistant/chunk`（`chunk.type=="usage"`：输入/输出/缓存读/缓存写，主定稿信号）+ `request/header`（provider/model 归属主源）+ `assistant/message`（含 `interrupted:true`，副源补记/校正）+ `turn/end`/`step/end` + `tool/call` | **唯一事实来源**：实时记账 |
| `session_projcache.json`（只读、尽力而为） | 会话标题 / `cwd` / 累计 tokenUsage | 项目名显示映射、报告「最活跃会话」；可选的口径漂移诊断（try/catch，不进正确性路径） |
| session 文件（回填脚本，砍出本期） | 历史逐 step 明细 | 装前历史若确有需求，未来以**一次性独立脚本**「尽力回填」（格式不符自动跳过）；依赖私有格式，绝不作为正确性依赖 |

**记账口径（官方类型内完成，经两轮对抗评审定稿）**：
- **定稿信号**：usage 事件实测极稀少伴随 `assistant/message`（不能当主定稿信号）——主信号为 usage chunk 到达即定稿（块终 chunk 内嵌 usage 实测约 2.7 万处）；`assistant/message`（含 interrupted turn 的 `interrupted:true` 事件）到达且未定稿时补记、已定稿时仅校正不重记；fold 缓冲加 TTL（约 10min）强制定稿兜底；
- **fold 键含重试序号**：`(session, turn, step, retrySeq)`——retry 复用同一 (turn,step)，折叠会吞掉重试的真实消耗；每次定稿调用独立入账、各计一次调用；
- **缓冲 GC 三重保险**：`turn/end` 强制定稿/丢弃该 turn 全部缓冲（aborted turn 不保证有 step/end）；会话销毁清理 per-session 状态；TTL 扫描兜底；
- **provider/model 归属主链路**：usage 事件本身不含模型身份——逐会话折叠 `request/header`（EpochHeader.config 的 provider/model，含 mid-session 切换的 series 语义）为归属主源，`assistant/message.source` 为副源校验；归属缺失显式落入「未识别」桶（不静默丢弃），趋势序列才成立；
- **零 usage 语义**：类型层明确 "usage is absent when the adapter reported none"——调用次数独立计数，token 记 null 而非 0，防均值/占比失真；
- 指标：token 各项（输入/输出/缓存读/缓存写）+ LLM 调用次数（定稿调用数）+ 轮次（`turn/end`）+ 工具调用次数（`tool/call`，已核实为 SessionEventMap 成员）；
- 子 agent 会话（delegationDepth>0）同为 session 事件，天然计入；归属按会话 cwd（事件流不含项目路径，projcache 映射由优化升级为必需件）；
- 时间与日界：`event.time` 非单调（seq 才单调）——时钟回拨时旧日事件按其本地日追加进对应日分片（分片 append-only，查询容忍）；日界逐事件用本地时区 Date 计算，禁缓存时区偏移（DST 安全）。

**已知覆盖边界（文档化，不视作缺陷）**：统计自插件挂载时点起算（装插件前历史不计；dsh-provider-usage 的 DeepSeek 区间记账法同此先例）；仅覆盖挂载插件的 dsh web 进程内的会话（web 停机期间无 web 会话在跑，实际缺口仅剩监听异常——用 notifier 同款 try/catch 隔离兜住，单事件失败不连坐）。

## 二、核心架构

```
session/event（官方契约，唯一事实来源）
   │  request/header ──逐会话折叠──▶ provider/model 归属（含 mid-session 切换）
   │  assistant/chunk(usage) ──按 (session,turn,step,retrySeq) 折叠──▶ 定稿一次 LLM 调用
   │     （message/interrupted 补记校正 + turn/end 强制收尾 + TTL 兜底）
   ▼
内存聚合（day×provider×model 桶 + 当日 per-step 明细）
   │  3～5s 防抖 + session/flush 官方排空点 + dispose await
   ▼
按天分片 JSONL 落盘（0600）＝持久事实，启动时载入重建内存聚合
   │
   ├▶ GET /api/dsh-provider-usage/trend → 面板「使用趋势」tab（日 30 点/周 12 点/月 12 点）
   └▶ 报告调度器（nextRunAt 对齐 + 补跑 + lastRun 幂等标记，按 profile 隔离）
          └▶ 报告生成（聚合数据 + 提示词 → 所配模型直连 API）→ 报告 tab 落盘回看 + 可选 notifier 推送
```

### 2.1 采集与存储

- **单一路径、无双算**：事件即记账，无扫描、无指纹缓存、无增量续扫、无只增不回收语义——整层文件解析机械不复存在。落盘数据即持久事实，重启后从日分片载入重建内存聚合。
- **两级聚合**：当日保留 per-step 明细行（time/sessionId/project/provider/model/tokens，支撑今日按小时/按会话细分查询）；日切时压实为 day×provider(×model) 聚合行并丢弃明细——存储有界，过期只留聚合。**分片行 schema 带版本字段**，明细行/聚合行类型显式区分（重启重建遇日切瞬间无歧义）。
- **刷盘点（官方契约）**：类型层明示持久化契约 = "subscribe to session/event, drain on `session/flush` / dispose"——3～5s 防抖保留，**额外挂 `session/flush` 官方排空点**；`dispose` 刷盘为异步，须确认 cordis stop 会 await 完成、防抖 timer 清理（热重载用例覆盖）。kill -9 丢防抖窗口数据在文档明示（事件路线无重扫兜底，丢了即丢）。
- **健壮性**：监听器 try/catch 隔离（notifier 同款），单事件解析失败跳过并告警，不连坐；事件流为 token 级 firehose——handler 先按 `chunk.type` 廉价过滤再做深检查，热路径禁 JSON 深操作；事件形状防御性校验，dsh 升级引入变化时优雅降级（typecheck 第一道闸，运行时守卫第二道）；监听注册走 disposers 统一回收，热重载不双监听（smoke 断言重挂载不双算）。
- 落盘：按天分片 JSONL（0600，复用 HistoryStore 的「按天分片 + prune」模式；trend 以 day 为主键另建目录）；同日分片写入单飞串行防互吞。默认保留 180 天，可配置。
- **回填降级为一次性脚本（砍出本期交付）**：装前历史若确有需求，未来以独立脚本「尽力回填」实现（解析 session 文件、格式不符自动跳过）；因依赖私有格式且与事件主路线自相矛盾，不再作为插件功能与默认配置项。

### 2.2 查询与「使用趋势」tab

- 新路由 `GET /api/dsh-provider-usage/trend`（loopback 围栏内），宿主端聚合，输出日（30 点）/ 周（12 点）/ 月（12 点）× 指标（输入 / 输出 / 缓存读 / 缓存写 / 调用次数）× 适配器（provider，可细到 model）序列。
- 面板新增「使用趋势」tab：粒度 / 指标 / 适配器维度切换 + **堆叠柱状图**（charts.ts 现无堆叠柱状，需新增 SVG 渲染函数，风格对齐现有 `miniAreaSvg`）；适配器维度默认 provider，可切换细到 model；项目维度用 projcache 的 `cwd` 映射显示。
- 兼容：暗色 / 浅色与移动端对齐现有面板响应式与 CSS 变量；输出经既有 sanitize 双层净化。

### 2.3 「用量报告」独立 tab + 定时任务

- **独立 tab**：经 `slots.inject("settings.section")` 注册顶层 tab（与「用量统计」tab 同机制、不同 id），内容三块——报告配置、报告历史列表、报告详情渲染。
- **报告配置（全部可配）**：
  - 周期与时间：日 / 周 / 月各独立开关与时刻（如日报 22:00）、周起点（ISO 周一 / 周日）可配；
  - 模型：报告生成所用模型可配（endpoint + model + 凭据，凭据只在宿主端持有，沿用 v2 适配器的注入与 0600 落盘约定；默认可复用某个已配置适配器的凭据链）；
  - 提示词：模板可编辑，注入当期聚合统计 JSON（含脱敏开关）；
  - 推送：可选经 dsh-notifier 渠道推送摘要，**默认脱敏项目路径**（`/home/...` 属敏感面），亦可整体关闭外发仅落盘。
- **报告生成**：当期聚合数据（总量 / 环比 / 峰值日 / 最活跃项目与模型 / 调用次数等）+ 提示词模板 → 调用所配模型生成叙事化报告（网易云年报式卡片）；产物 HTML 落盘（0600），报告 tab 可回看历史；生成失败幂等重试，不重复扣期。**安全语义（红线）**：直连 API 属新增网络出口 + 凭据使用面——README `## 安全模型` 一节同步更新，smoke 一律 mock endpoint（无网络纪律）；产物 HTML 与内嵌统计 JSON（含路径 / 模型名）经既有 sanitize 双层净化后方可入 tab。
- **调度器细节**：nextRunAt 对齐按本地日界计算（DST 日漂移 / 不存在时刻安全；不缓存时区偏移）；lastRun 幂等标记防热重载双 tick 并发生成（单飞互斥）。
- **显式断言**：报告生成走所配模型直连 API，不经过 `session/event`，不计入本统计（实现处注释 + 测试断言该前提）；生成消耗 token 由报告元数据单独记录（报告页可见）。
- **极简调度器**（官方无 cron 的先行版）：插件内约 50 行——60s tick + `nextRunAt` 对齐 + 启动补跑（错过周期补生成）+ lastRun 幂等标记文件（**按 profile 隔离**，防 web / verify_* 多实例重复推送）。**不引入 croner**：仅 3 种固定周期，cron 表达式解析属过度设计；未来需任意表达式时再引入（croner 成熟、零依赖、ESM）。

## 三、对抗评审结论吸收清单（两轮三方：全量评审 ×2 + 增量复核 ×1）

**第一轮（文件路线）**:P0 两项（usage 载体、逐行 zstd 帧）实测证伪初稿 → 促成路线讨论；最终随「事件唯一事实源」决策消解，实测结论转为记账口径依据。

**第二轮（事件路线，全量 + 增量）——必须改，已全部吸收**：
1. fold 定稿信号：`assistant/message` 极稀少不可作主信号 → 改 usage chunk 到达即定稿为主、message（含 interrupted）补记/校正、TTL 兜底；
2. retry 双算/漏算：fold 键并入重试序号，重试消耗逐次入账；
3. 刷盘点错位：补挂官方 `session/flush` 排空点，dispose 异步 await 与 timer 清理入用例；
4. provider/model 归属主链路缺失：usage 事件不含模型身份 → 逐会话折叠 `request/header` 为归属主源、message.source 副源校验、缺失显式入「未识别」桶；
5. fold 缓冲泄漏：turn/end 强制定稿 + 会话销毁清理 + TTL 扫描三重保险；
6. 报告直连 API 触发安全红线：README 安全模型节 + 无网络 smoke（mock endpoint）+ HTML/JSON 双层净化；
7. 热路径：先按 chunk.type 廉价过滤，禁 JSON 深操作；热重载双监听用 disposers + smoke 断言。

**建议改（已吸收）**：分片行 schema 版本字段；event.time 非单调的回拨追加策略 + 日界禁缓存时区偏移；零 usage 记 null 非 0；cwd 映射升级为必需件；调度 DST/lastRun 双 tick 防护；堆叠柱状新写需在实现说明中引用 charts.ts 无堆叠能力的结论；inject 面在 contracts 层收敛；「报告不计入统计」显式断言。

**可不改 / 砍掉**：回填降级为一次性脚本并砍出本期；60s tick 自写调度、内存聚合 + 按天分片、180 天保留维持。

**两轮评审共同认可的取舍**：预览期以官方事件契约（firehose 即官方持久化通道）替代文件解析，是比文件格式更硬的承诺；代价（自挂载起算、kill -9 丢秒级窗口）在 UI 文案与文档明示「统计自挂载起算」，防误读为全量。

## 四、分期落地

| 期 | 内容 | 验收 |
|---|---|---|
| M1 数据层 | session/event 监听（try/catch 隔离 + 热路径廉价过滤 + disposers 回收）+ request/header 归属折叠 + usage chunk 定稿记账（retry 序号/interrupted/零 usage null 语义/TTL 兜底）+ 两级聚合落盘（schema 版本/日切压实）+ 官方 flush 点 + 防抖刷盘/dispose await + 重启重建 | smoke：合成事件流断言定稿与去重（chunk 主信号/message 校正/重试逐次计）、归属缺失入未识别桶、日切压实、时钟回拨追加、重启重建、热重载重挂载不双算、dispose await 刷盘 |
| M2 可视化 | `/trend` 路由 + 面板「使用趋势」tab（粒度/指标/适配器切换 + 堆叠柱状） | 浏览器隔离实测（dsh-verify-isolated），暗色/移动端截图证据 |
| M3 报表 | 「用量报告」独立 tab + 极简调度器 + 提示词/模型/时间配置 + 落盘回看 + notifier 可选脱敏推送 + README 安全模型节 | smoke：调度补跑/幂等/profile 隔离/双 tick 互斥；直连 API 全 mock（无网络）；产物净化断言；实测生成一份报告 |

流程：方案获认可后先建 issue 起草方案评论走 `needs-proposal-review`，维护者 approved 后开独立 worktree 实施（主 checkout 保持干净）。

## 五、已定决策记录

1. 落点：扩展 `dsh-provider-usage`（而非独立新插件）；
2. **事实来源：`session/event` 官方契约事件为唯一事实来源**（DSH 预览期文件格式不稳，不做文件解析依赖；统计自挂载时点起算，UI 文案明示）；回填降级为一次性脚本、砍出本期；
3. 记账口径：usage chunk 到达即定稿（主）、assistant/message（含 interrupted）补记/校正（副）、fold 键含重试序号、request/header 折叠为 provider/model 归属主源、缓冲 GC 三重保险、零 usage 记 null；
4. 适配器维度：provider 为主、可细到 model；
5. 报告：独立 tab；时间 / 提示词 / 模型均可配置；直连 API 生成（安全红线流程同步走）；
6. 保留时长：默认 180 天可配。

## 六、UI/UX 草图与图示资产

交互式资产（自包含 HTML，浅色 / 暗色双主题，浏览器直接打开）：

| 资产 | 内容 |
|---|---|
| [session-usage-trend-wireframes.html](assets/session-usage-trend-wireframes.html) | **UI/UX 设计草图（主）**：使用趋势 tab（三维切换 + 堆叠柱状 + 汇总卡 + 空态）、用量报告 tab（配置 / 历史 / 年报式详情卡片流）、暗色切换与响应式标注 |
| [session-usage-trend-architecture.html](assets/session-usage-trend-architecture.html) | 整体架构图（事件记账链 / 趋势查询 / 报告链路三视图） |
| [session-usage-trend-sequence.html](assets/session-usage-trend-sequence.html) | 时序图（记账 → 持久化 → 查询 → 报告生成） |
| [session-usage-trend-flow.html](assets/session-usage-trend-flow.html) | 流程图（事件 → 过滤 → 定稿 → 聚合落盘，含归属与兜底车道） |

趋势 tab 线框（ASCII 摘要，完整版见 wireframes）：

```text
┌ 概览 │ 历史明细 │【使用趋势】│ 适配器管理 │ 设置 ┐
│ [日·30天|周·12周|月·12月] [总token|输入|输出|缓存读|调用] [provider|细到model] │
│ ▂▃▅▇▆▄▇█▆▅▃▅▇… 30 根堆叠柱（按适配器配色，悬停逐日明细）      │
│ [本期总量 128.4M ▲18.2%] [调用 3,207 ▼4.6%] [峰值日 09-02] [Top 适配器] │
│ ⓘ 统计自插件挂载时点起算，早于该时点的会话不计入                    │
└──────────────────────────────────────────┘
```

## 七、设置面板 UI/UX 现代化（同 issue 一并跟踪）

范围：`dsh-provider-usage` 设置区既有「用量统计」tab 的原页面重构（v1 交互样式的现代化），与新 tab 一并统一设计语言。

设计原则（依 frontend-design 方法论，落地到 dsh 面板约束——宿主端渲染 HTML、复用宿主 CSS 变量、不引第三方字体/组件库）：

1. **签名元素**：面板顶部一条「用量仪表带」——把最高频信息（当前 provider 用量摘要）做成可扫读的仪表带作为开场，替代表单堆叠式开头；其余区域保持安静克制。
2. **层级靠排版而非装饰**：不引入字体文件，用字重 / 字号 / 字距三级角色（标题 600 / 正文 400 / 数据 700 等宽数字 tabular-nums）建立层级；数据一律等宽数字对齐。
3. **色彩零新增**：全部复用宿主 `--dsw-*` 语义变量（浅 / 暗自动跟随），最多补 2 个语义色（成功 / 警告），不自建调色板。
4. **结构即信息**：适配器管理从长表单改为卡片清单（状态徽标 + 关键指标前置 + 次要操作折叠），分组标题编码真实分类（内置 / 自定义），不做装饰性编号。
5. **用语规范**：按钮说「保存更改」不说「提交」；错误说明哪里错了与怎么修（「模型接口超时，已自动重试 2 次——检查 endpoint 后可手动重试」）；空态是行动邀请（「尚未配置适配器——检测可用 provider 后一键接入」）。
6. **动效一次编排**：适配器热插拔时的状态过渡做一次编排好的微交互（卡片态：检测中 → 就绪），其余静态；尊重 `prefers-reduced-motion`。
7. **质量底线**：键盘焦点可见、触控目标 ≥ 40px、<768px 单列折行、双主题等价（隔离环境截图证据归档，走 dsh-verify-isolated）。
