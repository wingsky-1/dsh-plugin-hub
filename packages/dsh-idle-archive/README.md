# @wingsky/dsh-idle-archive

会话闲置归档提醒：自动扫描「超过 X 小时没进行对话」的会话，弹窗询问是否归档；
选择「暂不归档」后，该会话 Y 小时内不再重复提示。

> 定位：会话卫生助手。只**提醒 + 一键执行官方归档**，不自动归档、不删除任何会话记录。

## 安装

```sh
dsh plugin --profile web add @wingsky/dsh-idle-archive
```

安装后**重启一次** `dsh web`。

## 行为

1. 周期性扫描会话列表（默认每 60 分钟一次，挂载与列表变化时也会重扫）；
2. 命中候选（见过滤规则）且页面可见、无其他弹窗时，弹出归档确认框；
3. 每个候选会话可单独选择：
   - **归档** —— 调用官方 `workspace.archiveSession`（会话从分组列表隐藏，
     会话记录与工作区账目保留）；
   - **暂不归档** —— 该会话进入静默期，Y 小时内不再提醒；
4. 弹窗操作（× / Esc = 关闭并短静默 1 小时；「全部暂不归档」= 全部静默 Y 小时）。

## 过滤规则（不打扰原则）

以下会话不会进入提醒：从未对话（blank）、正在运行、子代理会话、已归档、
当前正打开、静默期内的会话，以及无有效时间戳的会话。

## 配置

| 键 | 默认 | 含义 | 范围 |
|---|---|---|---|
| `enabled` | `true` | 总开关 | boolean |
| `idleHours` | `72` | 闲置阈值：超过该小时数未对话才提醒 | 1 ~ 8760 |
| `snoozeHours` | `24` | 拒绝后静默时长 | 1 ~ 720 |
| `scanMinutes` | `60` | 自动扫描间隔 | 5 ~ 1440 |
| `maxRows` | `50` | 单次弹窗最多列出候选数 | 1 ~ 200 |

GUI 修改入口：设置 → 插件 → 「会话闲置提醒」卡片（保存后生效，宿主持久化）。
配置文件：`~/.dsh/dsh-idle-archive.json`（含 settings 与 snoozed 静默表）。

## 安全与边界

- 宿主端仅提供配置/静默期持久化 + RPC 通道（authority loopback 围栏，
  非回环 403）+ health 路由；**归档动作由客户端调用官方
  `workspace.archiveSession` 执行**，宿主不重复实现领域逻辑。
- 归档是单向的：官方 `dsh-workspace` 尚无 unarchive API——弹窗只提醒、
  绝不自动归档。
- 弹窗是浏览器端 DOM 实现：仅当 Web GUI 页面打开时才会提醒。
- 静默表随会话累积少量条目，过期条目读取时自动清理。

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-idle-archive/health

# 源码在 src/，改后必须 build（dsh 直接 import lib 产物）
pnpm --filter @wingsky/dsh-idle-archive build
node test/smoke.mjs && node test/client-shim.mjs
```

## License

MIT
