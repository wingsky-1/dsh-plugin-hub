# @wingsky-1/dsh-plugins-all

DSH 插件全家桶**聚合包**：安装本包 = 一键装齐全部功能插件。

```sh
dsh plugin --profile web add @wingsky-1/dsh-plugins-all
```

装完重启一次 `dsh web`。已发布到 npm（v0.1.2）。

## 包含的插件

| 包 | 功能 |
|---|---|
| `@wingsky-1/dsh-notifier` | 审批/完成/错误事件通知（浏览器 Notification + 系统 toast） |
| `@wingsky-1/dsh-skill-explorer` | 技能中心：只读展示已加载 skill |
| `@wingsky-1/dsh-opencode-usage` | OpenCode Go 套餐用量悬浮框 |
| `@wingsky-1/dsh-lan-proxy` | 局域网访问 dsh web UI（HTTP/HTTPS/WS + TLS） |
| `@wingsky-1/dsh-mcp-manager` | MCP 服务器管理器（stdio/HTTP，工具注册给模型） |
| `@wingsky-1/dsh-idle-archive` | 会话闲置提醒归档 |
| `@wingsky-1/dsh-gzip` | /api 响应 gzip 压缩 |

> dsh-memory（项目长期记忆）未包含在本聚合包内。

## 单独安装

只想用某个插件时单独安装（见各插件 README）：

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

## 安全提示

- `lan-proxy` 会在 0.0.0.0:<port> 监听端口并提供 HTTPS，使用前阅读其 README 安全说明。
- `mcp-manager` 会启动 MCP 服务器子进程（stdio）并执行其命令，仅配置可信服务器。
- `notifier` 在 Windows 通过 PowerShell WinRT 弹系统通知。
