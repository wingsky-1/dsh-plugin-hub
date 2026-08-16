# @wingsky-1/dsh-notifier

审批/完成/错误事件通知：人不在浏览器前也能收到提醒。

## 安装

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

安装后**重启一次** `dsh web`。

## 功能

- **向你提问**（默认开）：`ask_user_question` / GUI 提问弹窗触发时通知
- **审批提醒**：真实审批路径 `approval/request` 触发时通知，含任务标题、工具中文名、申请理由与操作提示
- **完成提醒**：任务从运行到空闲（`agent/status` running → idle）时通知，含任务标题与耗时；子代理完成走独立开关 `notifySubagentDone`（默认关）；用户停止生成/中断任务时不通知完成
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
- 系统通知失败静默（仅日志），不影响主流程
- 浏览器通知需要**安全上下文**（HTTPS 或 localhost）；局域网 HTTP 访问自动走降级通道（横幅/提示音/标题提醒）
- 浏览器通知权限为手势内请求（点击侧边栏「通知」入口或面板按钮时）
- Windows 系统通知通过 PowerShell WinRT 脚本实现，命令以参数数组传递（无 shell 拼接面）

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-notifier/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-notifier build
node test/smoke.mjs
```

## License

MIT
