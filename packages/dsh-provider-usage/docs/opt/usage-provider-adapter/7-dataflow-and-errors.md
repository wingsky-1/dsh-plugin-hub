# 7. 数据流、状态机与错误/降级矩阵（子文件）

> 主文件：[dsh-provider-usage-provider-adapter-plan.md](dsh-provider-usage-provider-adapter-plan.md)（阶段总览）
> 本文件细化整体数据流时序（R2 语义分层后）、渲染状态机、错误码流转与降级矩阵。

---

## 7.1 数据流时序

### 前台（GUI 打开时）——胶囊轮询

```
[浏览器] 60s 定时器
    │
    ▼
GET /stats?provider=X  （单端点，响应内嵌 summary 子树）
    │
    ├─ 响应有 summary.hasAdapter === false
    │     ▼
    │   浮窗隐藏（不显示永久错误条），60s 重试
    │
    ├─ 响应有 summary.hasAdapter === true
    │     ▼
    ├─ 胶囊：取 summary.text / summary.level / summary.hint 渲染
    │     （渲染器可选 pill() 钩子覆盖）
    │
    └─ 缓存命中 → 仍 append 采样点（采样/取数解耦，保 60s 分辨率）
```

### 前台——展开面板

```
[浏览器] 用户点击胶囊展开面板
    │
    ├─ GET /stats?provider=X   （详情，同端点，不走额外 /summary 路由）
    │     ▼
    │    响应带 usage / adapterId / summary
    │
    ├─ GET /history?provider=X&adapterId=Y&days=N
    │     ▼
    │    响应带 samples + columns（由该适配器 samplePoint 声明）
    │
    ▼
    渲染器 render(ctx) 绘制面板（ctx.data = usage, ctx.history = history）
```

### 后台（浏览器关闭时也在）——多适配器连续采样

```
[宿主] 定时器（sampleIntervalMs，默认 5 分钟）
    │
    ▼
    遍历 registry 所有 provider 候选列表
    │
    ├─ 候选 enabled === true
    │     ▼
    │    collectStats(provider) — 走该 provider 的启用适配器
    │     │
    │     ├─ TTL 缓存命中 → 直接返回
    │     ├─ 并发复用 inflight（同一 provider 多请求合并）
    │     └─ 成功 → append 采样点到 (provider, adapterId) 历史桶
    │
    └─ 候选 enabled === false → 跳过（不取数、不采样）
```

### 切换启用适配器

```
[设置面板] 用户切换启用适配器
    │
    ▼
POST /adapters/select { provider, adapterId }
    │
    ▼
    宿主端：切换注册表 enabledId + 清该 provider 的 stats/summary/历史缓存
    │
    ▼
    客户端：下次 /stats 响应 adapterId 变化 → 清旧渲染器 → 重拉重渲染
```

---

## 7.2 并发与缓存

- **TTL 缓存**：按 `(provider, adapterId)` 维度缓存 `StatsResult`（多适配器各自独立）。
- **summary 与 stats 共享同源缓存**：`/stats` 响应内嵌 summary 子树，不设独立缓存键
  （评审 P1-2 硬约束：避免双缓存不一致）。
- **inflight 复用**：同一 provider 的并发请求（GUI 轮询 + 后台采样 + 手动刷新）只发
  一次真实请求，其余等待同一结果。
- **超时/取消**：`fetchUsage` 接 `AbortSignal`（`timeoutMs` 超时 + 插件卸载时取消）。
- **采样/取数解耦**（R2 引入）：缓存命中（含 /stats 轮询命中）也 append 采样点，
  保持 60s 采样分辨率，不依赖真实上游请求。

---

## 7.3 渲染状态机（客户端 per-provider）

```text
idle ──识别provider──▶ resolving(provider) ──▶ has-adapter / no-adapter
                          │                         │
                          │                    ┌─────┴──────┐
                          │                    ▼            ▼
                          │           has-enabled    no-enabled
                          │               │              │
                          │               ▼              ▼
                          │          拉summary   浮窗隐藏，60s探测
                          │               │
                          │               ▼
                          │          渲染胶囊
                          │               │
                          └── provider 切换/卸载 ──▶ 清渲染器 + 取消 inflight
```

- `has-enabled` → 显示胶囊（summary text/level）；面板展开时拉 stats + history。
- `no-enabled` → 浮窗隐藏，60s 轻量探测；收到 `hasAdapter: true` 后恢复。
- 每个 provider 切换带「渲染代 token」，保证快速切换只落最新一代。

---

## 7.4 错误状态机（客户端展示层）

| 状态 | 胶囊 | 浮窗面板 | 用户动作 |
| --- | --- | --- | --- |
| `no-provider` | 隐藏/占位 | 不触发 | 检查会话/等待识别 |
| `no-enabled-adapter` | 浮窗隐藏（不显示永久错误） | 设置面板引导可见 | 到设置面板启用适配器 |
| `no-adapter`（无候选） | 浮窗隐藏 | 设置面板引导：管理适配器 | 配置适配器 |
| `no-api-key` | label + off 点 | 显示「未找到 API Key」 | 配置 key / 适配器内自带鉴权 |
| `unauthorized` | label + err 点 | 显示「token 无效或过期」 | 换 key |
| `http-4xx/5xx` | label + err 点 | 显示「服务返回 xxx」 | 查中转站 |
| `timeout/network` | label + off 点 | 显示「超时/网络错误」+ 保留旧数据 | 重试（手动刷新） |
| `bad-data` | label + off 点 | 显示「数据格式异常」 | 检查适配器返回 |
| `adapter-load-failed` | 该候选不注册 | — | 修文件/路径 |
| `adapter-crash` | label + err 点 | 显示「适配器出错」+ 保留旧数据 | 查适配器日志 |

错误码由宿主归一化产出（`1-contracts.md` §1.5），客户端只呈现 + 引导。

---

## 7.5 降级矩阵（汇总）

- **无任何适配器候选**：内置 OpenCode Go 照常（默认启用）。
- **用户适配器部分失败**：其余候选/插件功能不受影响（`3-config-and-injection.md` §3.5 矩阵）。
- **settings 服务缺失**：独立 tab 不注册，浮窗照常（`5-settings-panel-tab.md` §5.4）。
- **多 provider 历史迁移失败**：保留 v1 备份，新数据写 v2（R3 升级为双键分桶）。
- **会话 provider 探针失败**：回落内置 opencode-go（M0 回落路径，`2-session-provider-detection.md`）。
- **无启用适配器**：浮窗隐藏，60s 探测恢复；设置面板引导适配器管理。