# 7. 数据流、状态机与错误/降级矩阵（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件细化整体数据流时序、渲染状态机、错误码流转与降级矩阵。

---

## 7.1 数据流时序（一次「展示当前 provider 用量」）

```text
[浏览器] 激活会话变化
   │  SessionModels.current.provider (M0 探针①验证取法)
   ▼
[客户端] 识别 provider → RendererRegistry 查表
   │  · 有内置/用户渲染器 → 选之
   │  · 无 → 显示 no-adapter 引导
   ▼
[宿主端] GET /stats?provider=<name>   (loopback)
   │  collectStats():
   │    · TTL 缓存命中 → 直接返回
   │    · 命中失败 / 并发复用 inflight
   │    · 解析 API Key → 分派到 HostAdapterRegistry[provider].fetchUsage()
   │         ├ 内置 opencode-go / 用户宿主适配器
   │         ├ 归一化 ProviderUsage（stripSecrets 护栏 → 记录历史采样分桶）
   │         └ 失败 → 归一化错误码
   ▼
[宿主端] 响应 { provider, usage, history(按需) }
   ▼
[客户端] 渲染器 render(ctx) 渲染卡片；provider 切换时处置旧渲染器
```

---

## 7.2 并发与缓存（沿用优化）

- **TTL 缓存**：按 `(provider, baseUrl)` 维度缓存 `ProviderUsage`（多 provider 各自
  独立缓存，避免互相污染）。
- **inflight 复用**：同一 provider 的并发请求（GUI 轮询 + 后台采样 + 手动刷新）只发
  一次真实请求，其余等待同一结果（沿用现有 `inflightStats` 模式，改按 provider 键控）。
- **超时/取消**：`fetchUsage` 接 `AbortSignal`（`timeoutMs` 超时 + 插件卸载时取消），
  失败归一化 `timeout` / 对应错误码。
- 后台采样与前台归属见 `4-usage-history-multiprovider.md` §4.3。

---

## 7.3 渲染状态机（客户端 per-provider）

```text
idle ──识别provider──▶ resolving(provider) ──拉数──▶ has-data / has-error
                          │                                │
                          └─ provider 切换/卸载 ─────────────┘
                               ▲  调旧渲染器 disposer + 取消 inflight
                               └── 回 idle（或直接进入新 provider resolving）
```

- `has-error` 时**保留上一次成功数据** + 显示错误条（降级体验），除非是首次失败。
- 每个 provider 切换带「渲染代 token」，保证快速切换只落最新一代。

---

## 7.4 错误状态机（客户端展示层）

| 状态 | 显示 | 用户动作 |
| --- | --- | --- |
| `no-provider` | 「未识别当前会话提供商」 | 检查会话/等待识别 |
| `no-adapter` | 「该提供商未配置适配器」+ 文档链接（可配置） | 到设置 tab 配置适配器 |
| `no-api-key` | 「未找到 API Key」 | 配置 key / 适配器内自带鉴权 |
| `unauthorized` | 「token 无效或过期」 | 换 key |
| `http-4xx/5xx` | 「服务返回 xxx」 | 查中转站 |
| `timeout/network` | 「超时/网络错误」+ 保留旧数据 | 重试（手动刷新） |
| `bad-data` | 「数据格式异常」 | 检查适配器返回 |
| `adapter-load-failed` | 「自定义适配器加载失败」+ 文件诊断 | 修文件/路径 |
| `adapter-crash` | 「适配器出错」+ 保留旧数据 | 查适配器日志 |

错误码由宿主归一化产出（`1-contracts.md` §1.4），客户端只呈现 + 引导。

---

## 7.5 降级矩阵（汇总）

- **无任何适配器**：内置 OpenCode Go 照常；未知 provider 显示 no-adapter 引导。
- **用户适配器部分失败**：其余 provider / 插件功能不受影响（3.5 矩阵）。
- **settings 服务缺失**：独立 tab 不注册，浮窗照常（5.4）。
- **多 provider 历史迁移失败**：保留 v1 备份，新数据写 v2（4.4）。
- **会话 provider 探针失败（M0）**：回落 providerHint 白名单 + 标题/系统提示兜底
  （2.2），核心框架不变。
