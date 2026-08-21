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

请选用下列任一形态访问（均在面板与 README 中给出提示）：

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
- **完成提醒**：任务从运行到空闲（`agent/status` running → idle）时通知，含任务标题与耗时；子代理完成走独立开关 `notifySubagentDone`（默认关）；用户停止生成/中断/任务失败/被阻塞时不通知完成（本轮 `turn/end` reason 为 `aborted`/`interrupted`/`error`/`blocked` 时固定静默——失败任务由错误提醒单独负责「任务出错」，避免同一轮既报错又误报完成）
- **错误提醒**：任务出错（`agent/error`）时通知，含任务标题、出错轮次/步骤、错误信息（前 300 字符）；同类错误 60 秒窗口内自动合并
- **轮次完成**（默认关）：`agent/turn-stopping` 时通知
- **双通道**：
  - 系统通知：Windows 原生 toast（内嵌 PowerShell WinRT 脚本，零依赖）；macOS 用 `osascript`（display notification，零依赖）；Linux 用 `notify-send`（存在才调用）
  - 浏览器通知：SSE 推帧 + Notification API（仅在页面隐藏时弹出）
- **非安全上下文降级**：局域网 HTTP 访问时浏览器禁止系统级弹窗——自动降级为「页面内横幅 + 提示音 + 标题提醒」
- **免打扰时段**：支持跨午夜（如 22:00 → 08:00）；可设**紧急例外**（`allowKinds`：免打扰期间仍提醒审批/提问/出错）
- **审批超时二次提醒**：审批等待超 `askRemindMin` 分钟（默认 5，0 关闭）未处理时再次提醒
- **完成风暴聚合**：多任务/子代理同时收尾自动聚合为「另有 N 个任务已完成」，避免刷屏
- **面板诊断**：配置面板显示浏览器通知授权状态与安全上下文提示
- **未读角标**：有通知未查看时侧边栏「通知」入口显示红点计数，打开面板即清零

## 配置（~/.dsh/dsh-notifier.json，GUI「通知」面板可改）

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
  "historyMaxAgeDays": 0
}
```

## 路由（全部 loopback 围栏）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-notifier/config` | GET/PUT | 读取/保存配置 |
| `/api/dsh-notifier/events` | GET | SSE 通知帧（浏览器 EventSource 订阅） |
| `/api/dsh-notifier/test` | POST | 测试通知（绕过免打扰） |
| `/api/dsh-notifier/history` | GET / **DELETE** | GET 最近通知记录（最多 200 条，`historyMaxAgeDays` 过滤 / 被免打扰拦截的标记 `suppressed`）；**DELETE 清空** |
| `/api/dsh-notifier/health` | GET | 健康检查 |

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
  - 已证伪不收录（高频误伤）：IPv4（UA 版本号同形）、手机号（订单号同形）、信用卡（13 位毫秒时间戳 100% 命中）
- 系统通知失败静默（仅日志），不影响主流程；原生二进制缺失/不可执行（ENOENT 等）
  会被 `error` 事件接住，**绝不冒泡成 unhandled error 把宿主进程打挂**（见 issue #1）
- **两个通道到达的机器不同（别混淆）**：
  - **浏览器通知**推到**你正在用的浏览器客户端**（Mac/手机都算），由浏览器 Notification API 弹出原生通知；需要授权、且默认页面隐藏时才弹（面板可开「页面可见也弹」）。无论 dsh web 跑在哪台机器，只要浏览器通知允许，你都能在自己的 Mac 上收到。
  - **系统通知（宿主 toast）**弹在 **dsh web 运行的宿主机器**桌面：若 dsh web 跑在 Linux 服务器（headless，无桌面会话）或别的机器上，toast 会出现在**那台服务器**而不是你的 Mac——面板/health 会体现该通道是否可用。想让系统 toast 也出现在你的 Mac 上，需把 dsh web 直接跑在你的 Mac 上（此时走 macOS 的 `osascript`）；macOS 无 `notify-send`，系统通知已用 `osascript` 实现（零依赖，无需安装）
- **iOS 差异**：Safari 普通标签页无 Web Notifications API（「添加到主屏幕」的 PWA
  才有）；iOS 上可用通道为「页面可见时横幅 + 提示音」及 HTTPS+A2HS 后的系统通知
- 浏览器通知需要**安全上下文**（HTTPS 或 localhost）；局域网 HTTP 访问自动走降级通道（横幅/提示音/标题提醒）
- 浏览器通知权限为手势内请求（点击侧边栏「通知」入口或面板按钮时）
- Windows 系统通知通过 PowerShell WinRT 脚本实现，命令以参数数组传递（无 shell 拼接面）；脚本启动时幂等注册 AppUserModelId（HKCU，无需管理员权限）——未注册的 AUMID 在 Win10/11 上 toast 会被系统静默丢弃

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-notifier/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-notifier build
node test/smoke.ts
```

## License

MIT
