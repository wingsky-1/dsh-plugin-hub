# @wingsky-1/dsh-notifier

审批/完成/错误事件通知：人不在浏览器前也能收到提醒。

## 安装

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

安装后**重启一次** `dsh web`。

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
  - 系统通知：Windows 原生 toast（内嵌 PowerShell WinRT 脚本，零依赖）；Linux/macOS 用 `notify-send`
  - 浏览器通知：SSE 推帧 + Notification API（仅在页面隐藏时弹出）
- **非安全上下文降级**：局域网 HTTP 访问时浏览器禁止系统级弹窗——自动降级为「页面内横幅 + 提示音 + 标题提醒」
- **免打扰时段**：支持跨午夜（如 22:00 → 08:00）
- **面板诊断**：配置面板显示浏览器通知授权状态与安全上下文提示

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
  "quietHours": { "enabled": false, "start": "22:00", "end": "08:00" },
  "errorMergeWindowMs": 60000
}
```

## 路由（全部 loopback 围栏）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-notifier/config` | GET/PUT | 读取/保存配置 |
| `/api/dsh-notifier/events` | GET | SSE 通知帧（浏览器 EventSource 订阅） |
| `/api/dsh-notifier/test` | POST | 测试通知（绕过免打扰） |
| `/api/dsh-notifier/history` | GET | 最近通知记录（最多 200 条） |
| `/api/dsh-notifier/health` | GET | 健康检查 |

## 安全与边界

- 通知文本只含任务标题/工具名/申请理由等元信息，**不含工具参数**（防敏感信息外泄）
- **错误通知文本经脱敏**：用户路径/长令牌/密钥赋值会先打码（`<path>`/`<token>`/`<redacted>`）再截断 300 字符，降低错误消息内嵌命令回显、路径与凭据片段的外泄面
- 系统通知失败静默（仅日志），不影响主流程
- **系统通知发往 DSH 所在机器的桌面**：若服务器无桌面会话（headless），该通道不
  可用（面板/health 会体现）；macOS 默认无 `notify-send`，系统通知通道待后续版本
  以 `osascript` 补齐
- **iOS 差异**：Safari 普通标签页无 Web Notifications API（「添加到主屏幕」的 PWA
  才有）；iOS 上可用通道为「页面可见时横幅 + 提示音」及 HTTPS+A2HS 后的系统通知
- 浏览器通知需要**安全上下文**（HTTPS 或 localhost）；局域网 HTTP 访问自动走降级通道（横幅/提示音/标题提醒）
- 浏览器通知权限为手势内请求（点击侧边栏「通知」入口或面板按钮时）
- Windows 系统通知通过 PowerShell WinRT 脚本实现，命令以参数数组传递（无 shell 拼接面）

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
