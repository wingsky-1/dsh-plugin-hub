# @wingsky-1/dsh-notifier
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-notifier)](https://www.npmjs.com/package/@wingsky-1/dsh-notifier)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

审批/完成/错误事件通知：人不在浏览器前也能收到提醒。

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-notifier
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-notifier
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-notifier
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-notifier
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-notifier
```

## 部署与访问方式（重要）

插件所有接口都受 **loopback 围栏**保护：仅接受本机回环（`127.0.0.1` /
`localhost`）调用。因此**从局域网浏览器直连 `http://<服务器IP>:3080` 时，
`/api/dsh-notifier/*` 一律返回 403，通知通道不工作**——这是安全护栏的预期行为，
不是插件故障；此时页面内会给出引导提示。

请选用下列任一形态访问（均在设置卡片与 README 中给出提示）：

| 形态 | 访问方式 | 说明 |
|---|---|---|
| 本机桌面 | `http://127.0.0.1:3080` | 安全上下文：浏览器通知 + 系统通知均可用 |
| 局域网 HTTPS（推荐） | `https://<服务器IP>:3443`（dsh-lan-proxy） | 经代理满足回环校验 + 安全上下文；移动端「添加到主屏幕」后可获 PWA 级通知 |
| 隧道 | `ssh -L 3080:127.0.0.1:3080 <服务器>` 后访问本机地址 | 回环 + 安全上下文，效果同本机 |

> 已验证（2026-08）：`https://<IP>:3443/api/dsh-notifier/health` 返回 200，
> SSE 长连接（`/api/dsh-notifier/events`）经 3443 首帧正常。

## 功能

- **向你提问**（默认开）：`ask_user_question` / GUI 提问弹窗触发时通知
- **审批提醒**：真实审批路径 `approval/request` 触发时通知，含任务标题、工具中文名、申请理由与操作提示
- **完成提醒**：任务从运行到空闲（`agent/status` running → idle）时通知，含任务标题与耗时；完成判定为**单源 push + 快照兜底**——以 `session/event` 推送流记忆的最新 `turn/end` 为主证据（post-commit 同步派发、恒定新鲜），快照回读（`lastTurnEndOf`）仅在 push 缺失（插件中途挂载 / 重载窗口内已派发但新 fiber 未记忆）时兜底（issue #290 阶段二：快照一次性读滞后不再固化为永久静默，同一轮次只通知一次，判定被跳过时输出标识证据来源的可观测 warn 日志）；子代理完成走独立开关 `notifySubagentDone`（默认关；子代理含 `origin: subagent` 的 spawn 型与运行时归属成立的 fork 型委派——无归属的 fork 主线会话不受影响，仍报主任务完成）；用户停止生成/中断/任务失败/被阻塞时不通知完成（本轮 `turn/end` reason 为 `aborted`/`interrupted`/`error`/`blocked` 时固定静默——失败任务由错误提醒单独负责「任务出错」，避免同一轮既报错又误报完成）
- **错误提醒**：任务出错（`agent/error`）时通知，含任务标题、出错轮次/步骤、错误信息（前 300 字符）；同类错误 60 秒窗口内自动合并
- **轮次完成**（默认关）：`agent/turn-stopping` 时通知
- **双通道**：
  - 系统通知：Windows 原生 toast（内嵌 PowerShell WinRT 脚本）；macOS 用 `osascript`（display notification）；Linux 用 `notify-send`（存在才调用），均无需额外安装
  - 浏览器通知：SSE 推帧 + Notification API（仅在页面隐藏时弹出）
- **非安全上下文降级**：局域网 HTTP 访问时浏览器禁止系统级弹窗——自动降级为「页面内横幅 + 提示音 + 标题提醒」
- **免打扰时段**：支持跨午夜（如 22:00 → 08:00）；可设**紧急例外**（`quietHours.allowKinds`：免打扰期间仍提醒的事件）。默认候选为高频阻塞型（审批/提问/出错），设置页支持勾选**全部 6 个内置事件**（含任务完成/子任务完成/轮次完成）并一键「跟随已启用事件」或「恢复默认」；豁免与事件开关正交——关闭的事件即使豁免也不会收到通知（事件不产生），豁免项照常保留；未启用事件在设置页以弱化（降低透明度）样式展示，仍可勾选豁免。**升级提示**：放开白名单后，旧配置中原本会被过滤掉的 kind（如手改的 `done`/`turn-end`）会在免打扰期间恢复提醒——行为变化；如不希望这样，可在设置页豁免区自行调整
- **审批超时二次提醒**：审批等待超 `askRemindMin` 分钟（默认 5，0 关闭）未处理时再次提醒
- **完成风暴聚合**：多任务/子代理同时收尾自动聚合为「另有 N 个任务已完成」，避免刷屏
- **设置卡片诊断**：设置 → 插件 → dsh-notifier 卡片显示浏览器通知授权状态与安全上下文提示，并含最近 10 条通知记录、发送测试通知与清理记录入口

## 事件订阅与 scope 语义（{global:true} 取舍）

本插件监听宿主事件（`approval/request`、`internal/service`、`session/event`、
`agent/status`、`agent/disposed`、`agent/error`、`agent/turn-stopping`）时统一
注册 `{ global: true }`（cordis `EventOptions`「Receive the event regardless of
context filter checks」）。取舍如下（issue #290）：

- **untagged 平铺挂载下事件默认可达**：经 `cordis.patch.yml` 平铺 insert 挂载
  的插件 ctx 无 scope 标签，宿主 dsh-scope 事件分发对无 scope 标签的 listener
  ctx 直接放行——即便不加 `{ global: true }` 也能收到 agent 作用域事件；
- **`{ global: true }` 是消费端防御**：把事件到达与宿主 scope 分发语义解耦——
  若未来以 private-scoped 挂载形态运行（listener ctx 带 scope 标签且与事件
  carrier 的 scope 不一致），`hook.global` 在 dispatch 过滤中无条件放行，
  通知不因 scope 过滤哑火（本插件所有 `ctx.on` 注册处均带该参数）；
- **代价（取舍）**：`global` 会收到**跨 scope** 的事件——极端多插件多 scope
  部署形态下可能收到不属于当前 ctx 作用域的事件。本插件全部 listener 以
  「payload 自校验 + per-agent/事件内容过滤」消费（事件载荷跨宿主边界不受信，
  逐字段运行时校验，非有限 turn 直接 skip），跨 scope 到达只会被过滤后静默，
  不产生错误通知；本阶段**不新增配置键**控制该行为。

## 配置（官方 settings 存储：设置 → 插件 → dsh-notifier 卡片可改）

配置保存在**官方 settings 存储**（`<DSH_HOME>/settings.yaml`，命名空间 `dsh-notifier`），
经「设置 → 插件 → dsh-notifier」卡片读写（issue #76）；旧版自建
`dsh-notifier.json`（位于 DSH_HOME，默认 `~/.dsh`）在升级后**启动时一次性迁移**
进官方存储，原文件改名
`dsh-notifier.json.migrated.bak`（损坏则改名 `.corrupted.bak`，不写入），
自建读写链路已废弃。

**未知键语义（前向兼容，issue #470）**：dsh-notifier 对配置中**无法识别的键**
采取「透传保留」策略——读取与写入口径一致，未知键不会被丢弃，也不会被校验
或改写（仅组合层装配键名例外，见下）：

- **读取**：`GET /api/dsh-notifier/config` 的 `user`（settings 用户层原始节）与
  `effective`（生效配置）均原样返回未知键，供未来版本/第三方键保持可见；
- **写入**：`PUT /api/dsh-notifier/config` 为增量 patch——仅合并提交的已知键；
  存量 user 层中已有的未知键**不受已知键保存影响**，本次 patch 中携带的未知键
  **一并原样保留**（不会静默丢弃）。纯未知键 patch（如 `{"futureKey":1}`）返回
  **200** 并写入；仅空 patch `{}`（或无任何可写键，如只含装配键）返回 **400**
  「需至少包含一个配置键」；
- **升级路径**：某键在某版本还是未知键（已透传进 user 层）、下一版本成为已知键
  时——旧脏键**不会被自动清洗**（升级本身不覆盖用户已表态字段）；读取时
  normalize 对已知键非法值丢弃回默认（脏值不影响生效配置与其他键）；你**主动
  提交**该键且值非法时才返回 400 + hint。若想清除残留脏键，可在
  `settings.yaml` 中手动删除；
- **存量迁移**：旧 `dsh-notifier.json` 的未知键在迁移时**透传保留**——user 层
  缺失则补写、已存在不覆盖；纯未知键 legacy 不再被当作「无有效键」丢弃；
- **边界例外**：
  - `patch` **必须是对象**：数组、`null` 等非对象形态一律 400（数组不会按数字
    索引透传成脏键）；
  - 原型链/特殊成员键（`__proto__`、`constructor`、`prototype`、`toString`、
    `hasOwnProperty`、`valueOf` 等，JSON 文本可注入为自有键）在读取透传与写入
    通道中一律剔除，不参与校验也不写入；
  - 组合层装配键（`configFile` / `toastScript` / `historyFile` / `statusFile` /
    `enabled`）是 cordis 组合层/启动参数，**不进入 settings 用户层**——PUT 与
    迁移提交同名键一律剔除，entry 组合层走白名单过滤；
  - Bark 频道实例内 `device_key` / `device_keys` / `ciphertext` 与 webhook 频道实例内
    `WEBHOOK_RESERVED_KEYS`（`auth_token` / `access_token` / `bearer_token` / `api_key` /
    `apikey` / `client_secret` / `secret` / `password_hash`）保留键仍一律剔除/写拒，
    未知参数仅透传 string/number 值；
  - 未知键不参与合法性校验（已知键非法仍返回 400 + hint）。

后果提示：升级后若设置页未显示某字段但 `settings.yaml` 中仍在，属预期保留
行为，不会因保存其他已知配置而丢失。

配置项示例（默认值；`channels` / `kindRoutes` / `allowKinds` 为 M2 新增键）：

```json
{
  "notifyAsk": true,
  "notifyQuestion": true,
  "notifyTaskDone": true,
  "notifySubagentDone": false,
  "notifyTaskError": true,
  "notifyTurnEnd": false,
  "systemNotify": true,
  "browserNotify": true,
  "notifyWhenVisible": false,
  "notifySound": true,
  "quietHours": { "enabled": false, "start": "22:00", "end": "08:00", "allowKinds": [] },
  "errorMergeWindowMs": 60000,
  "askRemindMin": 5,
  "doneMergeWindowMs": 3000,
  "historyMaxAgeDays": 0,
  "maxConnections": 16,
  "channels": [],
  "kindRoutes": {},
  "allowKinds": []
}
```

> `maxConnections`：SSE 连接表上限（默认 16，范围 1~1024）。含义为**服务端未释放句柄数**，
> 非「在线设备数」——半开连接（设备息屏/切网/NAT 静默掐断）不发 FIN，close/error 不触发。
> #515 起连接表由 shared/sse-hub 管理，三路回收互补：**stalled 回收**（写被拒连续超 90s
> → 断开）、**maxAge 轮换**（存活超 120min 且无业务帧 → 主动断开，客户端自动重连 +
> since 补拉无感知）、**上限淘汰**（超出淘汰最老）。上限保证表有界；若**长期持续超限**
> （淘汰后客户端重连、再次被淘汰的 churn 循环），说明该值低于峰值并发连接数，应调大
> 到不小于峰值再观察。连接回收路径计数见 `/api/dsh-notifier/health` 的 `sseEvicts`。

### Bark 推送频道（M2，issue #366）

设置 tab「通知中心 → 投递频道 → 添加 Bark 推送」配置（也可直接编辑上述配置 JSON）。
每实例字段：`id`（自动生成后锁定）、`name`（显示名）、`baseUrl`（Bark 服务器地址，
http/https）、`deviceKey`（Bark App 内查看；响应中一律掩码 `********`，提交掩码 =
保持原值）、`enabled`（默认 **false**——出站授权须显式开启）。

可选参数（全部缺省不发送；未知 string/number 键原样透传，Bark 未来参数前向兼容；
`device_key`/`device_keys`/`ciphertext` 为保留键不可透传）：

| 字段 | 说明 |
|---|---|
| `sound` | 铃声名（Bark Sounds 列表） |
| `group` | 分组（同组在手机上折叠） |
| `icon` | 图标 URL（**需手机网络可达**，非服务器可达；SVG 需 iOS 17+；留空用 Bark 默认） |
| `url` | 点击通知跳转 URL |
| `badge` | App 角标数字 |
| `level` | 实例级紧急度覆盖；缺省按事件 severity 自动映射：`failure→timeSensitive`、`warning/success→active`、`info→passive` |
| `levels` | 按事件（kind）紧急度稀疏映射（见下） |

`levels`（kind→level 稀疏映射矩阵）：为具体事件类型指定 Bark 紧急度，
**优先于实例级 `level` 与 severity 自动映射**；未配置的类型走默认。适合「提问必响、
子任务完成静音」这类按事件差异化诉求：

```json
{ "id": "phone", "type": "bark", "baseUrl": "https://api.day.app", "deviceKey": "…",
  "enabled": true, "levels": { "question": "timeSensitive", "subagent-done": "passive" } }
```

- 键为事件 kind（内置 `ask/question/done/subagent-done/error/turn-end/test` 或动态 kind，任意字符串）；
  值限 `active` / `timeSensitive` / `passive` / `critical`；至多 64 项、每键至多 64 字符。
- 完整优先级：`levels[kind]` > `level` > severity 映射 > 不携带。
- 注意：`critical` 需苹果特殊授权（普通 App 无法申请），未获授权时 Bark 可能降级/拒绝。
- 与 `kindRoutes`（kind→channelId[] 路由）正交：路由决定「投给哪些频道」，`levels` 决定「在本实例上多响」。

投递可靠性：10s 硬超时、网络错误/5xx 重试 ×2（4xx 不重试）、实例级在途并发 ≤2
（内置频道不受限）；成功判定双查 HTTP 2xx + 响应体 `code===200`。
投递终态（成功/失败 + 脱敏错误摘要）落盘 DSH_HOME 下的 `dsh-notifier-status.json`
（默认 `~/.dsh`）并经
`wingsky-notify/sent` 事件广播（cordis Events），设置页频道卡状态行实时可见。

> 通知历史 jsonl、频道投递状态 json 与旧版迁移源 json 的落盘/读取路径均感知
> `DSH_HOME`（#510）：未设置时为 `~/.dsh`，设置后随隔离 home 走——隔离环境
> （多实例 / 测试沙箱 / dsh-verify-isolated）读写面不触碰真实 `~/.dsh`。

`kindRoutes`：kind → channelId[] 稀疏路由（如 `{ "error": ["browser", "system", "bark:phone"] }`）；
未声明条目的 kind 广播全部启用频道；设置页事件区可双向编辑（与频道卡共享同一份配置）。
`allowKinds`：已确认的动态 kind 清单（其他插件注册的通知类型经你确认后持久化于此）。

### Webhook 推送频道（#508）

设置 tab「通知中心 → 投递频道 → 添加 Webhook 推送」配置（也可直接编辑上述配置 JSON）。
用途：安卓经 ntfy / Gotify / 自建推送网关接收通知，补齐 Bark（iOS）未覆盖的推送
通道——每次投递向 `url` POST 一份 JSON body。

每实例字段（`type` 固定为 `"webhook"`）：

| 字段 | 说明 |
|---|---|
| `id` | 实例 id（2-32 位小写字母/数字/连字符，创建后锁定；`kindRoutes` 对齐键与掩码回填对齐键） |
| `name` | 显示名（缺省回退 id） |
| `url` | 目标地址（http/https；normalize 规范化为 origin+path——去 query/hash、拒绝带凭据 URL） |
| `enabled` | 是否启用（默认 **false**——出站授权须显式开启） |
| `auth` | 认证方式：`none`（默认）/ `bearer` / `basic` / `header` |
| `token` | bearer 认证令牌（secret：响应一律掩码 `********`） |
| `username` | Basic 认证用户名（非 secret） |
| `password` | Basic 认证密码（secret：响应一律掩码） |
| `headerName` / `headerValue` | 自定义请求头认证（`headerValue` 为 secret：响应掩码）；头名限字母/数字/连字符（≤64 字符），禁 `content-type` / `content-length` / `host` / `cookie` / `authorization` |
| `preset` | 预设：`ntfy`（默认）/ `gotify` / `custom`（自建网关）；决定 `{{priority}}` 映射与默认模板 |
| `template` | JSON body 模板（≤8192 字符；留空 = 预设默认模板） |
| `timeoutSec` | 投递超时秒（1-60，默认 10；服务端权威 clamp） |

预设与 `{{priority}}` 频道感知映射（按 `preset` 选择映射表；`{{severity}}` 恒为 severity 原文）：

| preset | info | success | warning | failure |
|---|---|---|---|---|
| `ntfy` | `default` | `low` | `high` | `urgent` |
| `gotify` | 3 | 3 | 7 | 9 |

`custom` 不映射——`{{priority}}` 直出 severity 原文，由网关自行处理。

模板占位符清单：`{{title}}`、`{{message}}`、`{{kind}}`、`{{severity}}`、`{{priority}}`（映射见上表）、`{{source}}`（渲染为空串，预留位）、`{{ts}}`（毫秒时间戳取整，数字直出——唯一允许以裸值形态出现在模板中的占位符）。

渲染语义（JSON-aware 两步法）：先把 `{{ts}}` 替换为数字字面量 → 模板整体 `JSON.parse` → 树遍历仅对**字符串值**做占位符替换 → 重新 `JSON.stringify`。替换发生在已解析字符串内部、重新序列化时统一转义——通知内容含引号 / `"}}` 也无法逃逸出字符串注入额外字段（防注入收口）。模板不是合法 JSON = 该频道投递失败并落记录（不静默降级为文本，不影响其他频道）。`ntfy` 预设默认模板含 `"topic": "<topic>"` 占位，投递前改成你的主题名。

投递可靠性：超时 1-60s（默认 10）；**失败不自动重试**——4xx / 5xx / 网络错误 / 渲染失败统一为失败终态，落 status 文件与通知历史（错误摘要已脱敏），可经「发送测试通知」重发验证。`kindRoutes` 中以 `webhook:<id>` 引用（与 `bark:<id>` 同款 `type:id` 形态）。

实例示例（与 Bark 实例同存于 `channels` 数组，id 跨类型去重）：

```json
{ "id": "droid", "type": "webhook", "url": "https://ntfy.sh/mytopic",
  "enabled": true, "auth": "bearer", "token": "…", "preset": "ntfy", "timeoutSec": 10 }
```

## 路由（全部 loopback 围栏）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-notifier/config` | GET/PUT | **GET** 返回 `{ok, user, revision, effective, writable}`（`user` 为官方 settings 用户层、`revision` 供乐观并发、`effective` 为生效配置；**凭据字段（bark `deviceKey` / webhook `token`·`password`·`headerValue`）一律掩码**）；**PUT** 接收 `{patch, expectedRevision?}`（增量 patch，`expectedRevision` 可选做乐观并发），返回 `{ok, user, revision}`（同样掩码） |
| `/api/dsh-notifier/events` | GET | SSE 通知帧（浏览器 EventSource 订阅；`?since=<seq>` 断线补拉） |
| `/api/dsh-notifier/test` | POST | 测试通知（收敛到 service 管线，绕过免打扰；body 可选 `{channelId}` 指定单频道测试） |
| `/api/dsh-notifier/history` | GET / **DELETE** | GET 最近通知记录（最多 200 条，`historyMaxAgeDays` 过滤 / 被免打扰拦截的标记 `suppressed`）；**DELETE 清空** |
| `/api/dsh-notifier/status` | GET | 频道投递状态（per-channel 最近投递终态 + 连续失败计数，错误摘要已脱敏） |
| `/api/dsh-notifier/kinds` | GET / POST | GET 动态 kind 清单（含确认态）；POST `{kind, confirmed}` 写确认（持久化到 `allowKinds`） |
| `/api/dsh-notifier/health` | GET | 健康检查 |

错误映射（PUT /config）：非法配置键 → 400（`{ok:false, error:{error:"配置校验失败: <键>", hint}}`）；版本冲突（`expectedRevision` 过期）→ 409（`code:"SETTINGS_CONFLICT"`）；settings 服务缺失 → 503（`code:"settings-unavailable"`）；写入异常 → 500（底层原因只进服务端日志）。

## 类型依赖

宿主端类型来自官方 `@deepseek-ai/*` 包（`dsh-agent` / `dsh-session` / `dsh-host-webserver`
等，版本统一锁在仓库 `pnpm-workspace.yaml` catalog，随 DSH 发布节奏升级）：
**仅 `import type` 编译期使用**，编译产物零官方运行时导入，运行时对象全部由 dsh
宿主注入。包以 optional peerDependencies 声明这一宿主耦合；对插件做类型检查的
消费者需可解析这些官方包（跳过类型检查则无影响）。

## 安全与边界

- 通知文本只含任务标题/工具名/申请理由等元信息，**不含工具参数**（防敏感信息外泄）
- **错误通知文本经脱敏**：进入通知与历史前按有序规则表打码再截断 300 字符，降低错误消息内嵌命令回显、路径与凭据片段的外泄面。覆盖类别与占位符：
  - 用户路径（`/home` `/Users` `/root` `/etc` `C:\Users`）→ `<path>`
  - PEM 私钥块（含只有 BEGIN 头的截断形态）→ `<private-key>`
  - 数据库/消息队列连接串凭据（postgres/mysql/mongodb/redis/amqps 等，scheme 保留；密码含 `<>`/引号等 URL 应编码字符时不脱敏，属已知局限）→ `scheme://<redacted>@host`
  - 各类令牌：JWT、AWS AKIA、GitHub PAT（classic 与 fine-grained）、≥24 位 hex / ≥32 位 base64 长串 → `<token>`
  - 密钥字段赋值（`password=`/`token=`/`api_key=`…，须带显式 `=`/`:` 分隔符）→ `键名=<redacted>`
  - 邮箱 → `<email>`
  - **审批理由与提问文本**同样经脱敏（120 字符截断）——这两类文本最常内嵌命令回显与凭据片段
  - **已知取舍（不修正则）**：40 位 git commit SHA 与「≥24 位 hex 密钥」同形不可区分，会被通用长串规则打码为 `<token>`（如 `HEAD detached at abc0123…` → `HEAD detached at <token>`），损失错误消息的可查性。接受误伤换取密钥覆盖面：SHA 场景白名单不可靠（40 hex 与真密钥无法凭形态区分），故仅在此记录为已知行为
  - 已证伪不收录（高频误伤）：IPv4（UA 版本号同形）、手机号（订单号同形）、信用卡（13 位毫秒时间戳 100% 命中）
- 系统通知失败静默（仅日志），不影响主流程；原生二进制缺失/不可执行（ENOENT 等）
  会被 `error` 事件接住，**绝不冒泡成 unhandled error 把宿主进程打挂**（见 issue #1）
- **两个通道到达的机器不同（别混淆）**：
  - **浏览器通知**推到**你正在用的浏览器客户端**（Mac/手机都算），由浏览器 Notification API 弹出原生通知；需要授权、且默认页面隐藏时才弹（设置卡片可开「页面可见也弹」）。无论 dsh web 跑在哪台机器，只要浏览器通知允许，你都能在自己的 Mac 上收到。
  - **系统通知（宿主 toast）**弹在 **dsh web 运行的宿主机器**桌面：若 dsh web 跑在 Linux 服务器（headless，无桌面会话）或别的机器上，toast 会出现在**那台服务器**而不是你的 Mac——设置卡片/health 会体现该通道是否可用。想让系统 toast 也出现在你的 Mac 上，需把 dsh web 直接跑在你的 Mac 上（此时走 macOS 的 `osascript`）；macOS 无 `notify-send`，系统通知已用系统自带的 `osascript` 实现（无需安装）
- **iOS 差异**：Safari 普通标签页无 Web Notifications API（「添加到主屏幕」的 PWA
  才有）；iOS 上可用通道为「页面可见时横幅 + 提示音」及 HTTPS+A2HS 后的系统通知
- 浏览器通知需要**安全上下文**（HTTPS 或 localhost）；局域网 HTTP 访问自动走降级通道（横幅/提示音/标题提醒）
- 浏览器通知权限为手势内请求（设置 → 插件 → dsh-notifier 卡片的「请求通知权限」按钮）
- Windows 系统通知通过 PowerShell WinRT 脚本实现，命令以参数数组传递、标题/正文打包为 base64(UTF-8 JSON) 经单一 payload 参数传入（无 shell 拼接面，且规避 PS 5.1 命令行参数解析歧义，见 issue #238）；脚本启动时幂等注册 AppUserModelId `DSH.dsh-notifier`（HKCU，无需管理员权限）——未注册的 AUMID 在 Win10/11 上 toast 会被系统静默丢弃。AUMID 采用 `Company.Product` 形态，避免在公共命名空间（`HKCU\SOFTWARE\Classes\AppUserModelId`）与其他同名软件冲突互覆；历史版本注册的旧键 `DSH` 残留无害（仅一个空注册表条目，不影响新 toast），如需清理可手动执行 `Remove-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\DSH"`
- **Bark 频道凭据与出站安全（M2）**：
  - **device key 不落 URL**：推送走 `POST {baseUrl}/push` + JSON body（`device_key` 字段）——反代 access log 默认只记 URL 与 header，正文不落日志
  - **响应掩码单一出口**：GET /config 的 user+effective 与 PUT 成功响应中的 `deviceKey` 一律掩码 `********`；提交整值掩码 = 保持原值（按实例 id 对齐回填，防止数组顺序变化串凭据）
  - **错误出口统一脱敏**：Bark 4xx 响应体会回显 key 原文（实测）——错误文本先按 device key 字面替换再过通用脱敏表，logger / `NotifyResult.error` / status 文件 / sent 事件四路出口全部覆盖
  - **SSRF 姿态**：`baseUrl` 限 http/https scheme、拒绝带凭据 URL（`user:pass@host`）、丢弃 query/hash。**不做域名白名单**——baseUrl 指向内网自建 bark-server 是合法场景；已知残余风险：局域网内可访问 dsh web 的调用方（经 lan-proxy 反代可穿透 loopback 围栏，见部署文档）可借 `/test` 触发一次对 `baseUrl` 的出站 POST（半盲，响应错误摘要仅回显脱敏后片段）。对该风险敏感的部署可将插件 `enabled` 关闭或用独立端口方案（后续版本）
- **Webhook 频道凭据与出站安全（#508）**：
  - **默认停用**：`enabled` 默认 false——出站授权须显式开启（与 Bark 同姿态）
  - **凭据不落 URL**：凭据只走请求头（bearer→`Authorization: Bearer`、basic→`Authorization: Basic`（base64）、header→自定义头名+值），不拼 URL——反代 access log 默认只记 URL 与 header 名，凭据不落日志
  - **凭据掩码收口（`CHANNEL_SECRET_FIELDS` 泛化）**：掩码字段清单按频道类型单一事实源化（bark→`deviceKey`、webhook→`token`/`password`/`headerValue`）；GET /config 的 user+effective 与 PUT 成功响应一律掩码 `********`，提交整值掩码 = 保持原值（按实例 id 对齐回填，防数组序变化串凭据），新实例带掩码提交 400
  - **保留键防配置绕过（`WEBHOOK_RESERVED_KEYS`）**：`auth_token` / `access_token` / `bearer_token` / `api_key` / `apikey` / `client_secret` / `secret` / `password_hash` 等凭据别名键一律剔除/写拒——合法凭据只能走已知 secret 字段（经掩码收口）
  - **JSON 注入防护**：模板渲染 JSON-aware 两步法（值级替换 + 重新序列化统一转义），通知内容无法逃逸出字符串注入额外 JSON 字段
  - **错误出口统一脱敏**：错误文本先按凭据字面替换再过通用脱敏表（同 Bark）；非 2xx 响应体截断 200 字符后脱敏再进错误摘要
  - **URL SSRF 姿态（与 Bark 同款 normalize）**：scheme 限 http/https、拒绝带凭据 URL（`user:pass@host`）、去 query/hash；不做域名白名单——内网自建网关是合法场景；自定义头名禁端到端关键头（`content-type`/`content-length`/`host`/`cookie`/`authorization`）防请求走私/破坏 JSON body
  - **失败不重试**：投递失败即终态（4xx/5xx/网络错误/渲染失败），无自动重试带来的出站放大
  - webhook 为**增量频道类型**：不改变既有频道与通知出口（SSE 帧 / 系统通知 / 历史 jsonl）的语义与兼容承诺

## 验证

测试单份维护、变异自动覆盖：单元测试只维护 `test/*.test.ts`（`import "../lib/index.js"` 测产物）；stryker 经 lib→src hook 复用同一份断言，无需手工同步副本。

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-notifier/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-notifier build
node test/smoke.ts
```

## License

MIT
