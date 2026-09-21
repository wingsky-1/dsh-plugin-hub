# @wingsky-1/dsh-notifier
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-notifier)](https://www.npmjs.com/package/@wingsky-1/dsh-notifier)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

审批/完成/错误事件通知：人不在浏览器前也能收到提醒。

**简体中文** | [English](README.en.md)

## 快速导航

[使用前须知](#使用前须知) · [部署与访问](#部署与访问方式重要) · [最短上手](#最短上手) · [常用配置](#常用配置) · [验证与排障](#验证与排障) · [详细参考](#详细参考) · [开发与架构](#开发与架构)

<a id="使用前须知"></a><a id="user-content-使用前须知"></a>
## 使用前须知

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

<a id="部署与访问方式重要"></a><a id="user-content-部署与访问方式重要"></a>
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

<a id="安全与边界"></a><a id="user-content-安全与边界"></a>
## 安全模型

- 通知文本只含任务标题/工具名/申请理由等元信息，**不含工具参数**（防敏感信息外泄）
- **通知正文与标题不再打码（#733 收敛）**：原 `sanitizeContent` 的规则表（路径 / PEM 私钥 / 连接串凭据 / 令牌 / 邮箱…）已删除——通知、历史落盘（含 suppressed 落史）与投递都是原文；正文不截断，长度由投递频道的展示上限截断。需要「日志里不出现某类文本」的部署，请自行在事件源侧处理
- **仅存的凭据掩码在设置页视图**：`GET /config` 的 `user` + `effective` 与 `PUT` 成功响应中的频道凭据（bark `deviceKey`、webhook `token` / `password` / `headerValue`）一律掩码 `********`，提交整值掩码 = 保持原值（按实例 id 对齐回填，防数组序变化串凭据），新实例带掩码提交 400（`CHANNEL_SECRET_FIELDS` 按频道类型单一事实源）
- **出口错误原因不再做凭据字面替换（实测风险，照实登记）**：Bark 4xx 响应体会回显 device key，webhook 的非 2xx 响应体也会回显收到的凭据——失败原因只做长度截断（webhook 响应体 200 字符；状态条目 300 字符），**不保证凭据不出现在错误文本里**。这些文本落在失败理由的 `detail` 字段里（0.2.4 起理由结构化，见「投递可靠性」），会进服务端日志、状态文件（`status.json`）与通知历史（`history.jsonl`），并随 `GET /status` 与 `GET /history` 出到设置页；对错误文本外泄敏感的部署请按上一条自行处置
- server 内部错误仍只回固定文案（底层原因只进服务端日志）；dry-run 的 500 同样固定文案且不记日志（禁写面含全部 logger）
- **草稿测试（dry-run）不落盘也不记日志**：只测 `draft.channels` 里的单条频道（掩码按 id 还原，跨类型残留掩码整体拒绝），结果同步返回且只进面板独立结果行（打标「草稿测试·未落盘」，通过不自动保存，改草稿即清、重载即丢、切 tab 保留）。回显反射残留（对端把请求体反射回来）与现行历史落盘同 exposure（原文截断后进 `reason.detail`），仅 loopback 可读，可接受
- **dry-run 出站安全**：bark / webhook 的 URL 必须可解析为 http(s) 且无 userinfo；主机名全量 DNS 解析逐条分类（回环 / 私网 / 链路本地（含云元数据）/ 未指定 / 组播 / 保留段一律拒绝，含十进制与十六进制等非点分写法），重定向手动逐跳复检（上限 5 跳），建连钉死核验过的 IP 并验 `remoteAddress` 熔断（关 TOCTOU），TLS 的 SNI 与证书校验仍走原始主机名
- 系统通知失败不再静默：出口**执行过动作而失败**会写状态行（`failed`）并进通知记录的逐出口明细；**一条命令都构造不出来**时收成 `skipped` 且留一条 warn（0.2.4 起 linux / darwin 也有这条日志，此前只有 win32 分支有）。原生二进制缺失/不可执行（ENOENT 等）
  会被 `error` 事件接住，**绝不冒泡成 unhandled error 把宿主进程打挂**（见 issue #1）
- **两个通道到达的机器不同（别混淆）**：
  - **浏览器通知**推到**你正在用的浏览器客户端**（Mac/手机都算），由浏览器 Notification API 弹出原生通知；需要授权、且默认页面隐藏时才弹（设置卡片可开「页面可见也弹」）。无论 dsh web 跑在哪台机器，只要浏览器通知允许，你都能在自己的 Mac 上收到。
  - **系统通知（宿主 toast）**弹在 **dsh web 运行的宿主机器**桌面：若 dsh web 跑在 Linux 服务器（headless，无桌面会话）或别的机器上，toast 会出现在**那台服务器**而不是你的 Mac——**系统通道可用性见 `/diagnostics`**（宿主端探测，带处置建议）；**浏览器通道可用性见设置卡片**（本端计算，换设备会不同）。想让系统 toast 也出现在你的 Mac 上，需把 dsh web 直接跑在你的 Mac 上（此时走 macOS 的 `osascript`）；macOS 无 `notify-send`，系统通知已用系统自带的 `osascript` 实现（无需安装）
- **iOS 差异**：Safari 普通标签页无 Web Notifications API（「添加到主屏幕」的 PWA
  才有）；iOS 上可用通道为「页面可见时横幅 + 提示音」及 HTTPS+A2HS 后的系统通知
- **能力自检面（0.2.4 起）暴露宿主软件栈的局部指纹，且经 `dsh-lan-proxy` 转发后对局域网可见**：`/diagnostics` 的 `capabilities.host.sound.players` 会列出探测命中的播放器可执行文件名（按回退链顺序给出**全部**命中者：`paplay` → `pw-play` → `aplay` → `ffplay`；darwin 恒 `afplay`），`popup`/`sound` 的 `checked` 会暴露装了 `notify-send` 与否；`/health` 只给**摘要**（verdict / unknownDimensions / popup.state / sound.state，无 players/checked 明细）。这是**有意的设计取舍**——用户要能看见「宿主放不出声」才谈得上处置——但请知悉它与 lan-proxy 的既有姿态叠加后的含义（该插件 README 已自述「经本插件转发的请求按设计视为受信」）。**收敛手段**：只出可执行文件名、音色只出布尔，**绝不出绝对路径**，`remediation` 的 `params` 只由内置数据表产生、不经输入透传（响应体里不会出现 `/etc/os-release` 或任何命令原文）
- **探测无副作用**：能力自检只向 `org.freedesktop.DBus` 发 `NameHasOwner` 与 `ListActivatableNames` 两个只读查询，**不触发任何服务激活**（不用 `busctl status`/`list`，不调 `StartServiceByName`）；`darwin`/`win32` 上连这个子进程都不起
- **临时音频文件（0.2.4 起）**：Linux 上主题事件音缺失时，自播会在系统临时目录下建一个 0700 的实例目录，写入 0600 且以 `wx` 打开的 WAV（`wx` 拒绝已存在的路径与符号链接）；播放结束立即删掉**本次**文件，并发的另一笔投递因此不受影响，目录留到进程退出 / 插件卸载时统一清理。`/tmp` 只读挂载时本次不落盘：只响不弹记为 `skipped`（`reasonSystemToneUnwritable`），弹+响仍算 `ok` 并留一条 warn（弹窗已经出去，声音属尽力而为）
- **D-Bus 通知的残余信任面**：Linux 上的通知正文会交给 `org.freedesktop.Notifications` 的**当前 owner**。同一 UID 的进程先占住这个名字即可收到通知内容（跨 UID 抢占不成立：session bus 是每用户一个 socket）。对同机同用户下的进程隔离有要求的部署，请自行评估系统通道
- **能力面契约演进**：`capabilities` 只增不删键；客户端**忽略不认识的组与不认识的 `verdict` 取值**（渲染为「未知」而不是报错）；旧服务端不带 `capabilities` 时设置页优雅降级。故升级服务端不需要同步升级客户端
- 浏览器通知需要**安全上下文**（HTTPS 或 localhost）；局域网 HTTP 访问自动走降级通道（横幅/提示音/标题提醒）
- 浏览器通知权限为手势内请求（设置 → 插件 → dsh-notifier 卡片的「请求通知权限」按钮）
- Windows 系统通知通过 PowerShell WinRT 脚本实现，命令以参数数组传递、标题/正文打包为 base64(UTF-8 JSON) 经单一 payload 参数传入（无 shell 拼接面，且规避 PS 5.1 命令行参数解析歧义，见 issue #238）；脚本启动时幂等注册 AppUserModelId `DSH.dsh-notifier`（HKCU，无需管理员权限）——未注册的 AUMID 在 Win10/11 上 toast 会被系统静默丢弃。AUMID 采用 `Company.Product` 形态，避免在公共命名空间（`HKCU\SOFTWARE\Classes\AppUserModelId`）与其他同名软件冲突互覆；历史版本注册的旧键 `DSH` 残留无害（仅一个空注册表条目，不影响新 toast），如需清理可手动执行 `Remove-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\DSH"`

<a id="最短上手"></a><a id="user-content-最短上手"></a>
## 最短上手

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 访问与验证

按上方部署形态访问，打开「设置 → 插件 → dsh-notifier」，点击「请求通知权限」，发送测试通知，并在通知记录中查看逐频道结果。浏览器默认仅在页面隐藏时弹窗，需要时开启「页面可见也弹」；系统 toast 出现在宿主机而非远程浏览器设备。

```sh
curl -s http://127.0.0.1:3080/api/dsh-notifier/health
```

<a id="常用配置"></a><a id="user-content-常用配置"></a>
## 常用配置

在「设置 → 插件 → dsh-notifier」卡片修改。配置由插件自持，落在 `<DSH_HOME>/@wingsky-1/dsh-notifier/config.json`；存储、迁移与未知键语义见详细参考。

配置项示例（默认值；`channels` / `kindRoutes` / `allowKinds` 为 M2 新增键）：

```json
{
  "notifyAsk": true,
  "notifyQuestion": true,
  "notifyTaskDone": true,
  "notifySubagentDone": false,
  "notifyTaskError": true,
  "notifyTurnEnd": false,
  "quietHours": { "enabled": false, "windows": [{ "start": "22:00", "end": "08:00" }], "allowKinds": [] },
  "historyMaxAgeDays": 0,
  "channels": [
    { "type": "browser", "id": "browser", "enabled": true, "popup": true, "sound": true, "whenVisible": false },
    { "type": "system", "id": "system", "enabled": true, "popup": true, "sound": true }
  ],
  "kindRoutes": {},
  "allowKinds": []
}
```

> 浏览器与系统通知就是 `channels` 里的两条**内置条目**：它们与 bark / webhook 实例同住一个数组、
> 同一套渲染与判据，唯一特殊之处是**不能删除**（写面收到缺内置条目的 `channels` 会 400）。
> 0.2.3 的 8 个顶层渠道键（`systemEnabled` / `browserEnabled` / `systemNotify` / `browserNotify` /
> `notifyWhenVisible` / `notifySound` / `browserSound` / `systemSound`）在升级时被**搬进这两条条目
> 并删除**——升级一次做完，不留「旧键还能读」的第二处表达。升级后再提交这些键会得到 400
> （页面停留在升级前时，刷新后重试即可）。

### 每通道三个开关（#640 / #641；0.2.4 起收进渠道条目）

浏览器与系统通知是 `channels` 数组里的两个**内置渠道条目**，与 bark / webhook 实例同一份形状、
同一套渲染与判据：

```json
{ "type": "browser", "id": "browser", "enabled": true, "popup": true, "sound": true, "whenVisible": false }
{ "type": "system",  "id": "system",  "enabled": true, "popup": true, "sound": true }
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `enabled` | boolean | **渠道开关（发不发）**：每个渠道唯一的投递闸门，关掉 = 完全不投递 |
| `popup` | boolean | **弹窗开关（弹不弹）**：关掉而声音开着 = 只响不弹 |
| `sound` | `boolean \| 音色 id` | 声音（响不响、用什么音色） |
| `whenVisible` | boolean | 页面可见时是否也弹（仅浏览器渠道；随帧下发给页面执行） |

**「发什么」由渠道自己决定**：裁决管线对每个渠道只判 `enabled`，弹窗与声音原样交给渠道，由它决定
这一次弹、响、只响不弹，还是什么都不发。所以「弹窗关 + 声音也关」的渠道**照样会被投递**——出口
判定这次没有可发的内容，历史里如实记一条 `skipped`（既不伪装成投递成功，也不在管线里替出口判形态）。

**旧顶层键在升级时被搬走并删除**：0.2.3 的 `systemEnabled` / `browserEnabled` / `systemNotify` /
`browserNotify` / `notifyWhenVisible` / `notifySound` / `browserSound` / `systemSound` 会在 0.2.4
的升级链里搬进上面两条内置条目，随后从配置文件里**删除**——渠道形态只有条目一处表达。升级后再提交
这些键会得到 400（提示刷新），而不是静默无效。

取值：`false` = 静音（弹窗仍可弹、不发声）；`true` = **跟随系统默认**；
音色 id = 显式内置音色（`ding` / `bell` / `chime` / `pop`——4 音色全平台语义一致，
在设置卡每通道的「音色」下拉中选择，可点 试听：试听为浏览器本地 Web Audio 合成，
仅作听感参考，**实际系统提示音随平台与系统设置**）。

投递组合（**启用关掉时不投递，与弹窗/声音无关**；启用开着时按弹窗 × 声音决定形态）：

| 启用 | 弹窗 | 声音 | 行为 |
|---|---|---|---|
| 关 | 任意 | 任意 | **完全不投递**（发不发只看启用） |
| 开 | 开 | `false` | 弹通知实体，静音 |
| 开 | 开 | `true` | 弹通知实体，发声交给系统默认 |
| 开 | 开 | 音色 id | 弹通知实体；应用自播对应音色（系统通知静音防双响） |
| 开 | 关 | `true`/音色 id | **只响不弹**：不弹实体、仅自播（页面存活 / 宿主自播） |
| 开 | 关 | `false` | 进池但**什么都不发**：历史记 `skipped`，设置卡给出提示 |

- **`notifySound`（旧全局键）随升级迁移**：它的值在 0.2.4 的升级里摊到两条内置条目的 `sound`
  上（按出口的 `browserSound`/`systemSound` 有值时以它们为准），随后旧键被删除——旧版关闭过
  提示音的存量用户在升级后**仍保持静音**，不会「突然有声」。设置页从 0.2.4 起只写条目，
  不再有全局声音开关。
- **浏览器声音解锁前提**：浏览器 `true`/音色自播需要页面音频已解锁——浏览器自动
  播放策略要求一次用户交互（打开通知中心 / 声音行任何交互都会解锁 AudioContext）；
  纯后台从未交互的页面，声音可能不可用（此时通知照常弹出、仅无声），属浏览器
  策略约束而非插件缺陷。
- **Linux `true` 特例（#640 修复）**：Linux 桌面守护进程对声音 hint 支持参差
  （GNOME 默认无声 / KDE 2025 才支持 / Xfce 依赖 libcanberra），系统渠道的 `sound: true`
  解释为「**默认事件音自播**」——宿主按 `paplay` → `pw-play` → `aplay` → `ffplay`
  的回退链依次尝试、**首个成功即停**（防双响），不依赖守护进程。freedesktop 事件音
  缺失时改用**运行时合成的提示音**（0.2.4 起），不再因缺声音主题而静默。
  **只探测到服务型播放器是一个已知降级**：`paplay`/`pw-play` 在**没有声音服务**的
  宿主上必失败，故能力面报 `degraded` 并给 `host-only-sound-server-players`——装一个
  直连 ALSA 的播放器即可（`alsa-utils` 提供 `aplay`、`ffmpeg` 提供 `ffplay`；
  dnf 系上 `ffmpeg` 来自 RPM Fusion）。宿主没有音频设备时仍然无声。
  **存量 Linux 升级行为变化**：之前系统通知无声（notify-send 无声音 hint），升级后
  声音开 = 自播事件音。
- **音色 × 平台映射（近似，尽力而为）**：

| 音色 | 浏览器（Web Audio 合成） | macOS | Linux（事件音，缺失时合成） | Windows |
|---|---|---|---|---|
| `ding` | 双短高音 | Glass（NSSound） | `message-new-instant.oga` | `C:\Windows\Media\Windows Ding.wav` |
| `bell` | 单中高音 | Tink | `bell.oga` | `Windows Chimes.wav` |
| `chime` | 三音上行 | Sosumi | `complete.oga` | `Windows Chord.wav` |
| `pop` | 短促低音 | Pop | `message.oga` | `Windows Balloon.wav` |
| `true`（跟随系统） | OS 默认（不 silent） | Glass（现状保留） | 默认事件音自播（缺失时合成） | toast 默认系统音；只响不弹时近似默认音 wav |

  macOS 发声受系统「允许通知声音」设置约束；Windows 音色经宿主 `SoundPlayer`
  播放系统内置 wav（白名单路径，缺失静默）；Linux 事件文件为
  `/usr/share/sounds/freedesktop/stereo/` 下基线包确定存在的 oga（多路径探测，
  **缺失时改用运行时合成的提示音**）。自播一律数组传参（无 shell 拼接面），文件走
  白名单路径。
- 宿主平台见 `/api/dsh-notifier/health` 的 `platform` 字段（设置页系统卡按它显示
  平台提示——浏览器 OS 与宿主 OS 可能不同机，别混淆）。

### 事件路由与已确认类型

`kindRoutes`：kind → channelId[] 稀疏路由（如 `{ "error": ["browser", "system", "bark:phone"] }`）；
未声明条目的 kind 广播全部启用频道；设置页事件区可双向编辑（与频道卡共享同一份配置）。
`allowKinds`：已确认的动态 kind 清单（其他插件注册的通知类型经你确认后持久化于此）。

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
投递终态落盘到本插件的状态文件（见下「存储布局」），设置页
频道卡状态行在卡片加载与发送测试后经 `GET /api/dsh-notifier/status` 刷新（无轮询，D20 口径）。

- **Bark 频道凭据与出站安全（M2）**：
  - **device key 不落 URL**：推送走 `POST {baseUrl}/push` + JSON body（`device_key` 字段）——反代 access log 默认只记 URL 与 header，正文不落日志
  - **响应掩码单一出口**：GET /config 的 user+effective 与 PUT 成功响应中的 `deviceKey` 一律掩码 `********`；提交整值掩码 = 保持原值（按实例 id 对齐回填，防止数组顺序变化串凭据）
  - **错误出口不做凭据替换（实测）**：Bark 4xx 响应体会回显 key 原文——失败原因按原文截断后进 logger 与 `status.json`，不再按 device key 字面替换，也不再有 `sent` 事件这一路出口（详见「安全模型」）
  - **SSRF 姿态**：`baseUrl` 限 http/https scheme、拒绝带凭据 URL（`user:pass@host`）、丢弃 query/hash。**不做域名白名单**——baseUrl 指向内网自建 bark-server 是合法场景；已知残余风险：局域网内可访问 dsh web 的调用方（经 lan-proxy 反代可穿透 loopback 围栏，见部署文档）可借 `/test` 触发一次对 `baseUrl` 的出站 POST（半盲，响应错误摘要仅回显一段截断后的原文）。对该风险敏感的部署可将插件 `enabled` 关闭或用独立端口方案（后续版本）

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
| `headerName` / `headerValue` | 自定义请求头认证（约束见下）。 |
| `preset` | 预设：`ntfy`（默认）/ `gotify` / `custom`（自建网关）；决定 `{{priority}}` 映射与默认模板 |
| `template` | JSON body 模板（≤8192 字符；留空 = 预设默认模板） |
| `timeoutSec` | 投递超时秒（1-60，默认 10；服务端权威 clamp） |

**自定义请求头约束**：自定义请求头认证（`headerValue` 为 secret：响应掩码）；头名限字母/数字/连字符（≤64 字符），禁 `content-type` / `content-length` / `host` / `cookie` / `authorization`

预设与 `{{priority}}` 频道感知映射（按 `preset` 选择映射表；`{{severity}}` 恒为 severity 原文）：

| preset | info | success | warning | failure |
|---|---|---|---|---|
| `ntfy` | `default` | `low` | `high` | `urgent` |
| `gotify` | 3 | 3 | 7 | 9 |

`custom` 不映射——`{{priority}}` 直出 severity 原文，由网关自行处理。

模板占位符清单：`{{title}}`、`{{message}}`、`{{kind}}`、`{{severity}}`、`{{priority}}`（映射见上表）、`{{source}}`（渲染为空串，预留位）、`{{ts}}`（毫秒时间戳取整，数字直出——唯一允许以裸值形态出现在模板中的占位符）。

渲染语义（JSON-aware 两步法）：先把 `{{ts}}` 替换为数字字面量 → 模板整体 `JSON.parse` → 树遍历仅对**字符串值**做占位符替换 → 重新 `JSON.stringify`。替换发生在已解析字符串内部、重新序列化时统一转义——通知内容含引号 / `"}}` 也无法逃逸出字符串注入额外字段（防注入收口）。模板不是合法 JSON = 该频道投递失败并落记录（不静默降级为文本，不影响其他频道）。`ntfy` 预设默认模板含 `"topic": "<topic>"` 占位，投递前改成你的主题名。

投递可靠性：超时 1-60s（默认 10）；**失败不自动重试**——4xx / 5xx / 网络错误 / 渲染失败统一为失败终态，落 status 文件与通知历史（宿主原文截断后进失败理由的 `detail`，见「安全模型」），可经「发送测试通知」重发验证。`kindRoutes` 中以 `webhook:<id>` 引用（与 `bark:<id>` 同款 `type:id` 形态）。

实例示例（与 Bark 实例同存于 `channels` 数组，id 跨类型去重）：

```json
{ "id": "droid", "type": "webhook", "url": "https://ntfy.sh/mytopic",
  "enabled": true, "auth": "bearer", "token": "…", "preset": "ntfy", "timeoutSec": 10 }
```

- **Webhook 频道凭据与出站安全（#508）**：
  - **默认停用**：`enabled` 默认 false——出站授权须显式开启（与 Bark 同姿态）
  - **凭据不落 URL**：凭据只走请求头（bearer→`Authorization: Bearer`、basic→`Authorization: Basic`（base64）、header→自定义头名+值），不拼 URL——反代 access log 默认只记 URL 与 header 名，凭据不落日志
  - **凭据掩码收口（`CHANNEL_SECRET_FIELDS` 泛化）**：掩码字段清单按频道类型单一事实源化（bark→`deviceKey`、webhook→`token`/`password`/`headerValue`）；GET /config 的 user+effective 与 PUT 成功响应一律掩码 `********`，提交整值掩码 = 保持原值（按实例 id 对齐回填，防数组序变化串凭据），新实例带掩码提交 400
  - **保留键防配置绕过（`WEBHOOK_RESERVED_KEYS`）**：`auth_token` / `access_token` / `bearer_token` / `api_key` / `apikey` / `client_secret` / `secret` / `password_hash` 等凭据别名键一律剔除/写拒——合法凭据只能走已知 secret 字段（经掩码收口）
  - **JSON 注入防护**：模板渲染 JSON-aware 两步法（值级替换 + 重新序列化统一转义），通知内容无法逃逸出字符串注入额外 JSON 字段
  - **错误出口不做凭据替换**：与 Bark 同款——非 2xx 响应体截断 200 字符后按原文进失败理由的 `detail`，不再按凭据字面替换、不过规则表（详见「安全模型」）
  - **URL SSRF 姿态（与 Bark 同款 normalize）**：scheme 限 http/https、拒绝带凭据 URL（`user:pass@host`）、去 query/hash；不做域名白名单——内网自建网关是合法场景；自定义头名禁端到端关键头（`content-type`/`content-length`/`host`/`cookie`/`authorization`）防请求走私/破坏 JSON body
  - **失败不重试**：投递失败即终态（4xx/5xx/网络错误/渲染失败），无自动重试带来的出站放大
  - webhook 为**增量频道类型**：不改变既有频道与通知出口（SSE 帧 / 系统通知 / 历史 jsonl）的语义与兼容承诺

<a id="验证与排障"></a><a id="user-content-验证与排障"></a>
## 验证与排障

从回环检查健康与宿主能力；逐条是否送达以通知记录 tab 的出口明细为准，不只看频道状态行。首次能力探测有 8s 总预算，此后读取共享缓存。

```sh
curl -s http://127.0.0.1:3080/api/dsh-notifier/health
curl -s http://127.0.0.1:3080/api/dsh-notifier/diagnostics
```

### 投递终态与理由

**终态有三种，判据不同（0.2.4）**：`ok` = 有出口真的执行了动作并成功；`failed` = 执行过动作
而它失败（有失败证据，写状态行）；`skipped` = 这次**没有任何可执行的动作**（弹窗与声音都被关，
或本机给不出命令）。系统频道的弹窗与提示音是两个独立动作：**弹窗已经出去之后，声音失败只算
尽力而为，不改终态**（此时声音不是本次唯一动作）；反过来弹窗失败仍然翻转终态。`skipped` **不写状态行**——出口这次什么都没做，没有「最后一次投递结论」
可言，写成功等于替它宣称成功。所以「状态行还是绿的」并不代表这一条送到了：**通知记录 tab**
里每条记录都带逐出口投递明细（哪个出口、什么结论、什么理由），那是唯一的逐条可见面。

**投递理由是结构化的（0.2.4）**：`{ code, params?, detail? }`——`code` 由客户端字典渲染成当前
语言，`detail` 存宿主原文（HTTP 响应体、stderr 尾部、JSON.parse 报错）且**不作主文案**，界面上
折叠展示并标注「来自宿主原文」。升级会把 `status.json` / `history.jsonl` 里升级前的散文理由
收编成 `code: "reasonLegacy"` + 原句进 `detail`（幂等；读面同时容错，手改过的文件不会让界面
显示 `undefined`）。

<a id="详细参考"></a><a id="user-content-详细参考"></a>
## 详细参考

### 配置存储与迁移

配置由本插件自持，落在**包私有存储目录**的 `config.json`
（`<DSH_HOME>/@wingsky-1/dsh-notifier/config.json`，默认 `~/.dsh`），经
「设置 → 插件 → dsh-notifier」卡片或 `GET/PUT /api/dsh-notifier/config` 读写。
升级时**装配期读一次旧位置，并顺手割接成新形态**：0.2.3 的官方 settings 命名空间
`dsh-notifier` 优先——它**直接从宿主 settings 文档文件读**（provider 自报的 `documentPath`，
取不到则按 `<DSH_HOME>/settings.yaml`、`settings.json` 兜底；`.yaml` / `.yml` 按 YAML 解析），
因为 `describe()` 只列**已注册**的命名空间、而 0.2.4 起本插件不再注册它；更早的自建
`dsh-notifier.json`（DSH_HOME 根目录，含此前迁移留下的 `.migrated.bak`）回退；读到的存量与
当前 `config.json` 合并（存量覆盖文件，与旧写面同序），再把 8 个顶层渠道键搬进 `channels`
的两条内置条目并**删除旧键**（见「每通道三个开关」）。此后只有 `config.json` 一个读写面。

**未知键语义（前向兼容，issue #470）**：dsh-notifier 对配置中**无法识别的键**
采取「透传保留」策略——读取与写入口径一致，未知键不会被丢弃，也不会被校验
或改写（仅组合层装配键名例外，见下）：

- **读取**：`GET /api/dsh-notifier/config` 的 `user`（用户层原始节）原样返回未知键，
  供未来版本/第三方键保持可见；`effective`（生效配置）是归一化后的**固定形状**，
  本就不含未知键（未知键只存在于文件与 `user` 视图里）；
- **写入**：`PUT /api/dsh-notifier/config` 为增量 patch——仅合并提交的已知键；
  存量 user 层中已有的未知键**不受已知键保存影响**，本次 patch 中携带的未知键
  **一并原样保留**（不会静默丢弃）。纯未知键 patch（如 `{"futureKey":1}`）返回
  **200** 并写入；仅空 patch `{}`（或无任何可写键，如只含装配键）返回 **400**
  「需至少包含一个配置键」；
- **升级路径**：某键在某版本还是未知键（已透传进 user 层）、下一版本成为已知键
  时——旧脏键**不会被自动清洗**（升级本身不覆盖用户已表态字段）；读取时
  normalize 对已知键非法值丢弃回默认（脏值不影响生效配置与其他键）；你**主动
  提交**该键且值非法时才返回 400 + hint。若想清除残留脏键，可在
  `config.json` 中手动删除；
- **存量迁移**：旧配置（0.2.3 settings 命名空间与更早的自建 json）的未知键在读取时
  **透传保留**——user 层缺失则补写、已存在不覆盖；纯未知键 legacy 不再被当作「无有效键」丢弃；
- **边界例外**：
  - `patch` **必须是对象**：数组、`null` 等非对象形态一律 400（数组不会按数字
    索引透传成脏键）；
  - 原型链/特殊成员键（`__proto__`、`constructor`、`prototype`、`toString`、
    `hasOwnProperty`、`valueOf` 等，JSON 文本可注入为自有键）在读取透传与写入
    通道中一律剔除，不参与校验也不写入；
  - 组合层装配键（`configFile` / `toastScript` / `historyFile` / `statusFile` /
    `enabled`）是 cordis 组合层/启动参数，**不进入用户层**——PUT 与
    迁移提交同名键一律剔除，entry 组合层走白名单过滤；
  - Bark 频道实例内 `device_key` / `device_keys` / `ciphertext` 与 webhook 频道实例内
    `WEBHOOK_RESERVED_KEYS`（`auth_token` / `access_token` / `bearer_token` / `api_key` /
    `apikey` / `client_secret` / `secret` / `password_hash`）保留键仍一律剔除/写拒，
    未知参数仅透传 string/number 值；
  - 未知键不参与合法性校验（已知键非法仍返回 400 + hint）。

后果提示：升级后若设置页未显示某字段但 `config.json` 中仍在，属预期保留
行为，不会因保存其他已知配置而丢失。

> **存储布局（#733 收敛）**：配置、通知历史、频道状态、SSE 序号与存储版本号统一放在
> `DSH_HOME/@wingsky-1/dsh-notifier/` 下——`config.json` / `history.jsonl` /
> `status.json` / `seq.json` / `version`（`version` 是升级链的刻度）。旧位置**只在启动
> 迁移时读一次**：DSH_HOME 根目录的 `dsh-notifier-history.jsonl` /
> `dsh-notifier-status.json` / `notifier-seq.json` 搬完改名 `.migrated.bak`；配置的两代
> 旧形态（0.2.3 的 settings 命名空间、更早的 `dsh-notifier.json`）只读不改名。
> 路径全部感知 `DSH_HOME`（#510）：未设置时为 `~/.dsh`，设置后随隔离 home 走
> ——隔离环境（多实例 / 测试沙箱 / dsh-verify-isolated）读写面不触碰真实 `~/.dsh`。

### SSE 生命周期与退役连接上限

> SSE 连接表（#515 起由 shared/sse-hub 管理）**不再设连接数上限**：0.2.5 起上限淘汰机制已整体
> 移除——它当年是为「连接泄露」兜底的权宜设置。现存两路回收互补：**stalled 回收**（写被拒连续
> 超 90s → 断开）、**maxAge 轮换**（存活超 120min 且无业务帧 → 主动断开，客户端自动重连 +
> `since` 补拉无感知）。连接回收路径计数见 `/api/dsh-notifier/health` 的 `sseEvicts`。
>
> 随之上限配置键 `maxConnections`（默认 16，范围 1~1024）也在 **0.2.5** 退役：设置页不再显示它，
> `effective` 里没有它。写面口径与上文那批 0.2.3 渠道键一致——提交即 **400** 拒收，但原因不同
> （本键没有后继键，是机制整体移除，故提示是它自己那句），提示同样给出出路：页面停留在升级前时，
> 刷新后重试。旧 `config.json` 里的残留值不会被自动清洗，也不进生效值；保存其它已知配置不会把它
> 抹掉，并原样出现在 GET /config 的 `user` 视图里——想清理就在 `config.json` 里手动删掉那一行。

### 路由（全部 loopback 围栏）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-notifier/config` | GET/PUT | 配置文件用户层（保留未知键、凭据掩码）；快照与增量更新。 |
| `/api/dsh-notifier/events` | GET | SSE 帧与断线补拉。 |
| `/api/dsh-notifier/test` | POST | 经服务管线发送测试通知。 |
| `/api/dsh-notifier/history` | GET / **DELETE** | 读取或清空通知历史。 |
| `/api/dsh-notifier/status` | GET | 频道最近终态与连续失败计数。 |
| `/api/dsh-notifier/kinds` | GET / POST | 读取并确认动态事件类型。 |
| `/api/dsh-notifier/health` | GET | 健康与能力摘要。 |
| `/api/dsh-notifier/diagnostics` | GET | 完整宿主能力探测。 |

#### `/config`

**GET** 返回 `{ok, user, revision, effective, writable}`（`user` 为配置文件用户层（存储原样、保留未知键，凭据字段掩码）、`revision` 供乐观并发、`effective` 为生效配置；**凭据字段（bark `deviceKey` / webhook `token`·`password`·`headerValue`）一律掩码**）；**PUT** 接收 `{patch, expectedRevision?}`（增量 patch，`expectedRevision` 可选做乐观并发），返回 `{ok, user, revision}`（同样掩码）

#### `/events`

SSE 通知帧（浏览器 EventSource 订阅；`?since=<seq>` 断线补拉）

#### `/test`

测试通知（收敛到 service 管线，绕过免打扰；body 可选 `{channelId}` 指定单频道测试）。请求体上限 16K（与 settings 端对齐）。

**草稿测试（dry-run）**：body 带 `draft` 即测眼前草稿——`{channelId, draft: {channels: [...]}}`（`draft` 只认 `channels`，须含目标频道的完整条目；顶层其它键与 `revision` 忽略；此时 `channelId` 必填）。逐项校验（跳过「内置必须在场」），掩码按 id 还原（新频道无源 / 改名带掩码 / 跨类型残留掩码一律 400）；直构单目标实测（跳过 enabled 门，不走裁决 / 路由 / 节奏 / 重试，单次尝试），同步返回 `{ok, channelId, status, reason?}`（`status` 为 `ok` / `failed` / `skipped`，`reason` 为截断后的结构化理由）。**全程零落盘**：不写历史与状态、不推进 `revision`、不记日志、不推浏览器真通知（browser 返回 ok 但不 emit，以面板结果为准）。出站安全：bark / webhook 走 SSRF 安全 fetch（仅 http(s)、拒 userinfo、全量 DNS 分类、重定向逐跳复检、建连钉死核验 IP、上限 5 跳、响应体至多读 16K、单跳超时复用出口 clamp 再压 15s 上限）；system 沿用出口原函数（平台能力读共享缓存，子进程靠 KILL 8s 回收）。服务端总预算 15s（超时 408，结果丢弃，在飞的投递无法撤回）；并发帽 2（超限 429 `dry-run-busy`，不排队，请手动重试）。

#### `/history`

GET 最近通知记录（最多 200 条，`historyMaxAgeDays` 过滤 / 被免打扰拦截的标记 `suppressed`；每条含逐出口投递明细 `channels[]`，其 `reason` 为结构化理由）；**DELETE 清空**

#### `/status`

频道投递状态（per-channel 最近投递终态 + 连续失败计数；失败理由为结构化对象 `{code, params?, detail?}`，`detail` 按原文截断 300 字符，不做凭据替换）

#### `/kinds`

GET 动态 kind 清单（含确认态）；POST `{kind, confirmed}` 写确认（持久化到 `allowKinds`），200 响应带 `revision`（供客户端同步乐观并发版本）

#### `/health`

健康检查（`{ok, plugin, platform, sseEvicts, capabilities}`；`capabilities.host` 是**摘要**：结论与两个维度的状态，常量大小）

#### `/diagnostics`

完整能力自检面（`capabilities.host` 含逐维度 `checked`、播放器清单、音色就位与 `remediation` 处置建议）。与 `/health` **共用同一次探测**（进程内只探一次，此后读缓存）；**首次**探测最多等 8s 总预算（`CAPABILITY_BUDGET_MS`），这是已知代价

错误映射（PUT /config）：非法配置键 → 400（`{ok:false, error:{error:"配置校验失败: <键>", hint}}`）；版本冲突（`expectedRevision` 过期）→ 409（`code:"SETTINGS_CONFLICT"`）；settings 服务缺失 → 503（`code:"settings-unavailable"`）；写入异常 → 500（底层原因只进服务端日志）。

错误映射（POST /kinds）：kind 确认内部 CAS 冲突重试（≤2 次）耗尽 → 409（`code:"SETTINGS_CONFLICT"`，罕见：确认期间持续并发写入）；settings 服务缺失 → 503（`code:"settings-unavailable"`，与 PUT /config 同语义）；写入异常 → 500（`error` 固定文案，底层原因只进服务端日志）。

### 配置格式附录：默认值、迁移与掩码规则

- 默认值以 `src/server/config/impl/model/index.ts` 的 `DEFAULT_CONFIG` 为准：事件开关 `notifyAsk` / `notifyQuestion` / `notifyTaskDone` / `notifyTaskError` 开、`notifySubagentDone` / `notifyTurnEnd` 关；`quietHours` 为 `{enabled:false, windows:[{start:"22:00", end:"08:00"}]}`；`channels` 恒带两条内置条目（browser 与 system，均 `enabled` / `popup` / `sound` 开，browser 另有 `whenVisible:false`）；`kindRoutes` 与 `allowKinds` 为空，`historyMaxAgeDays` 为 0。
- 0.2.3 → 0.2.4 迁移：8 个顶层渠道键（`systemEnabled` / `browserEnabled` / `systemNotify` / `browserNotify` / `notifyWhenVisible` / `notifySound` / `browserSound` / `systemSound`）在装配期搬进两条内置条目后删除（`src/server/upgrade/impl/steps/config-shape.ts`）；升级后再提交这些键一律 400 并提示刷新页面，旧键残留需手删 `config.json` 对应行。
- 0.2.5 → 0.2.6 迁移：免打扰旧 `start`/`end` 在装配期搬进 `windows[0]` 并删除旧键（`src/server/upgrade/impl/steps/quiet-windows.ts`）；升级后再提交旧形（无 `windows`）一律 400 并提示刷新页面。
- 掩码规则：凭据字段清单按频道类型收口于 `CHANNEL_SECRET_FIELDS`（bark 为 `deviceKey`，webhook 为 `token` / `password` / `headerValue`）；GET /config 的 `user` 与 `effective` 及 PUT 成功响应一律掩码 `********`，提交整值掩码视为保持原值（按实例 id 对齐回填）；新实例带掩码提交返回 400（`src/server/config/impl/service/index.ts` 的 `NEW_CHANNEL_MASK_HINT`）。

### 客户端契约：节流、手势解锁与帧通路

- 自播节流：`PLAY_THROTTLE_MS` 为 1500 毫秒，覆盖通知音与只响不弹两条自播路径，试听不受限（`src/client/notify/audio.ts` 的 `gate()`）。
- 手势解锁：浏览器自动播放策略要求一次用户交互，页面首次任意点击调用 `unlock()` 解锁 AudioContext；试听为显式解锁加绕过节流的手势内操作（`src/client/index.tsx`）。
- 帧通路：裁决管线经组合根的本地 `FrameBus` 发帧（`src/index.ts`），浏览器出口经 `onFrame` 订阅后由 SSE 路由 `/api/dsh-notifier/events` 下发；客户端用 EventSource 订阅，重连主动带 `?since=<seq>` 补拉并按 seq 去重（`src/client/notify/session.ts`）。
- 经 3443 转发语义只引用 `dsh-lan-proxy` 的架构节，不在此复述：见该包 README 的「安全模型」与「验证与排障」节。

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-notifier
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-notifier
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

<details>
<summary>低频安装变体：指定版本与 npx</summary>

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

</details>

### 功能

- **向你提问**（默认开）：`ask_user_question` / GUI 提问弹窗触发时通知
- **审批提醒**：真实审批路径 `approval/request` 触发时通知，含任务标题、工具中文名、申请理由与操作提示
- **完成提醒**：任务从运行到空闲（`agent/status` running → idle）时通知，含任务标题与耗时；完成判定为**单源 push + 快照兜底**——以 `session/event` 推送流记忆的最新 `turn/end` 为主证据（post-commit 同步派发、恒定新鲜），快照回读（`lastTurnEndOf`）仅在 push 缺失（插件中途挂载 / 重载窗口内已派发但新 fiber 未记忆）时兜底（issue #290 阶段二：快照一次性读滞后不再固化为永久静默，同一轮次只通知一次，判定被跳过时输出标识证据来源的可观测 warn 日志）；子代理完成走独立开关 `notifySubagentDone`（默认关；子代理含 `origin: subagent` 的 spawn 型与运行时归属成立的 fork 型委派——无归属的 fork 主线会话不受影响，仍报主任务完成）；用户停止生成/中断/任务失败/被阻塞时不通知完成（本轮 `turn/end` reason 为 `aborted`/`interrupted`/`error`/`blocked` 时固定静默——失败任务由错误提醒单独负责「任务出错」，避免同一轮既报错又误报完成）
- **错误提醒**：任务出错（`agent/error`）时通知，含任务标题、出错轮次/步骤、错误信息（前 300 字符）
- **轮次完成**（默认关）：`agent/turn-stopping` 时通知
- **双通道**：
  - 系统通知：Windows 原生 toast（内嵌 PowerShell WinRT 脚本）；macOS 用 `osascript`（display notification）；Linux 用 `notify-send`（存在才调用），均无需额外安装
  - 浏览器通知：SSE 推帧 + Notification API（仅在页面隐藏时弹出）
- **每通道三个开关：启用 / 弹窗 / 声音**：浏览器与系统各是 `channels` 里的一个**内置渠道条目**，
  带「启用（发不发）」「弹窗（弹不弹）」「声音（响不响、用什么音色）」三个字段——**启用关掉就是
  完全不投递**（声音也不发），这正是与旧行为的分界：旧版只有一个键同时充当弹窗开关与启用开关，
  于是「弹窗关 + 声音开」还能发出声音。声音取值：静音 / 跟随系统默认 / `ding`·`bell`·`chime`·`pop`
  内置音色 + 试听；Linux 系统通知声音经宿主自播 freedesktop 事件音修复（原 notify-send 无声音
  hint，DE 支持参差）；详见「配置 → 每通道三个开关」小节
- **非安全上下文降级**：局域网 HTTP 访问时浏览器禁止系统级弹窗——自动降级为「页面内横幅 + 提示音 + 标题提醒」
- **免打扰时段（0.2.6 起多段）**：最多 5 个时间窗（`quietHours.windows`），命中任一即压制（并集语义，重叠允许），空数组等于未命中；单窗口支持跨午夜（如 22:00 → 08:00）；可设**紧急例外**（`quietHours.allowKinds`：免打扰期间仍提醒的事件）。默认候选为高频阻塞型（审批/提问/出错），设置页支持勾选**全部 6 个内置事件**（含任务完成/子任务完成/轮次完成）并一键「跟随已启用事件」或「恢复默认」；豁免与事件开关正交——关闭的事件即使豁免也不会收到通知（事件不产生），豁免项照常保留；未启用事件在设置页以弱化（降低透明度）样式展示，仍可勾选豁免。设置页逐行增删时段并按本机时间回显当前是否命中（回显仅供参考，以服务端裁决与通知记录为准）。**升级提示（0.2.6）**：旧 `start`/`end` 在装配期搬进 `windows[0]` 并删除旧键，升级后再提交旧形一律 400 并提示刷新页面。**旧升级提示**：放开白名单后，旧配置中原本会被过滤掉的 kind（如手改的 `done`/`turn-end`）会在免打扰期间恢复提醒——行为变化；如不希望这样，可在设置页豁免区自行调整
- **设置卡片诊断**：设置 → 插件 → dsh-notifier 卡片显示浏览器通知授权状态与安全上下文提示，并含最近 10 条通知记录、发送测试通知与清理记录入口
- **宿主能力自检（0.2.4 起）**：**系统卡的卡体**里显示宿主通道结论（弹窗/发声各自能否用 + 无法判定的维度），不可用时逐条给出处置建议（装哪个包、或改用浏览器通道）；明细（探测了哪些维度、探测到哪些播放器）折叠展示，**系统卡头**不承载它（窄屏下卡头被收起，而手机恰是最需要它的地方）。**浏览器卡的卡体**里显示浏览器通道结论，那一半在**本端**计算，换设备结论会不同。两者数据源同为 `GET /diagnostics`

<a id="开发与架构"></a><a id="user-content-开发与架构"></a>
## 开发与架构

原理与运行机制见 [TOGAF 4A 架构文档](../../docs/architecture/dsh-notifier.md)（BA 业务 / AA 应用 / DA 数据 / TA 技术四视图）。

### 事件订阅与 scope 语义（{global:true} 取舍）

本插件监听宿主事件（`approval/request`、`user-questions/request`、`session/event`、
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

### 对外契约（其他插件可见面，#733 收敛）

服务面挂在宿主上下文 `ctx["wingsky.notifier"]` 上，当前 `apiVersion` 为 **2**。本次按域重写的对外收敛：

- **`wingsky-notify/sent` 事件退役**：投递终态改由两个查询面承担——`GET /api/dsh-notifier/status`（per-channel 最近终态 + 连续失败计数）与 `GET /api/dsh-notifier/history`（最近记录，含逐出口投递明细）；
- **`registerChannel` 退役**：它承诺了一个从未入库的频道贡献模型；频道类型以内置为准（系统 / 浏览器 / bark / webhook）；
- **`send` 不再返回受理数组**：改为返回 `Promise<void>`——原数组里的 `ok` 是「已受理」而不是「已送达」，读错方向比没有返回值更贵；
- **`registerKind` 与 `send` 本身不变**：只用这两个的消费方不受影响。

### 类型依赖

宿主端类型来自官方 `@deepseek-ai/*` 包（`dsh-agent` / `dsh-session` / `dsh-host-webserver`
等，版本统一锁在仓库 `pnpm-workspace.yaml` catalog，随 DSH 发布节奏升级）：
**仅 `import type` 编译期使用**，编译产物零官方运行时导入，运行时对象全部由 dsh
宿主注入。包以 optional peerDependencies 声明这一宿主耦合；对插件做类型检查的
消费者需可解析这些官方包（跳过类型检查则无影响）。

### 测试分层

测试按 `test/{unit,integration,e2e,client,client-dom,client-unit}/` 分层维护：宿主单元与集成、e2e 冒烟、客户端产物、DOM 与客户端单元用例。变异通过 lib→src hook 复用相关断言；这些层次不代表所有平台均已真机覆盖。

```sh
# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-notifier build
pnpm --filter @wingsky-1/dsh-notifier test
```

### 真机未覆盖（平台矩阵现状，issue #766）

本节如实登记「哪些平台行为只在单测 / 模拟层验过、哪些从未在真机上跑过」，既不声称已充分
验证，也不让缺口靠读者猜。现状以命令可核验：

- **CI 只有 Linux runner**：`.github/workflows/` 下 15 处 `runs-on` 全是 `ubuntu-latest`，
  `windows-latest` / `macos-latest` 命中 0 次：

  ```sh
  git grep -n "runs-on" origin/main -- .github/workflows                          # 15 行，全 ubuntu-latest
  git grep -n -E "windows-latest|macos-latest" origin/main -- .github/workflows   # 无输出，exit 1
  ```

- **`windowsHide` 只在实现里出现，测试面零命中**：整包唯一一处是
  `src/server/channels/impl/system/deps.ts:81` 的
  `{ windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }`；测试面（`packages/dsh-notifier/test`）
  无命中：

  ```sh
  git grep -n windowsHide origin/main -- packages/dsh-notifier/test   # 无输出，exit 1
  ```

  在 Linux 上它是一个**等价变异体**——改与不改测试都不变色，只有真机 Windows 才区分得出来。

| 面 | 验证层级 | 真机状态 |
|---|---|---|
| Linux 系统通知：桩 `notify-send` 收到逐字 argv | e2e（真实子进程，桩前置进 PATH） | 覆盖的是桩，不是真机 |
| Linux 系统通知：真实 `notify-send` 调用并断言退出码 | e2e，平台标记 | **条件覆盖**；前提见下。 |
| 三平台决策面（平台探测、命令构造、缺失 toast 脚本告警、SoundPlayer 白名单、stderr 管道） | 单测，注入的假进程事实端口 | 验的是分支逻辑；**不是**真机行为 |
| Windows 真机：`toast.ps1` + PowerShell base64 载荷是否真的弹窗 | 无 | **未覆盖**（无 `windows-latest` runner；e2e 里的 win32 用例尚未编写） |
| Windows 真机：`spawn({windowsHide:true, …})` 的真实行为 | 无 | **未覆盖**（同上） |
| macOS 真机：`osascript -e 'display notification …'` 弹窗 | 无 | **未覆盖**（无 `macos-latest` runner） |
| macOS 真机：`afplay` 自播与音色映射的听感 | 无 | **未覆盖**（同上；[sound-playback-design.md](./docs/sound-playback-design.md) 自述「听感等价未实测（无 mac 主机）」） |

**Linux 真机通知的条件覆盖前提**：**条件覆盖**：仅当跑测机器系统 PATH 里有真实 `notify-send`，**且** D-Bus 会话可用（`DBUS_SESSION_BUS_ADDRESS` 已设，或 `$XDG_RUNTIME_DIR/bus` 存在）时才真跑；否则带 reason 跳过。是否覆盖取决于运行环境，本登记不做推断

平台标记用例的写法与「待后续 CI 矩阵」的原始规划见
[test/e2e/smoke.test.ts](./test/e2e/smoke.test.ts) 文件头注释。

**触发条件（缺口何时才会被填上）**：需要在 `.github/workflows/` 增加 `windows-latest` /
`macos-latest` runner 跑 e2e 项目，并为这两个分支补平台标记用例——即 issue #766 的方案 1。
本轮采取方案 2（只登记，不改 workflow）：它需要 runner 额度，属另一条路径。在那之前，
真机行为只能在目标平台的机器上自行确认：

```sh
pnpm --filter @wingsky-1/dsh-notifier test
```

## License

MIT
