# 4. 多 Provider / 多适配器历史采样演进（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件处理历史采样的**结构性问题**：
> 1. 单 provider、三窗口固定列结构 → 一台机器多 provider、同 provider 可切换多适配器
>    （D6/D9），列语义随适配器走，需按 `(provider, adapterId)` 分桶；
> 2. **历史不单文件存储，改多文件**（用户复核），避免并发写互相覆盖。
>
> 设计约束：每个 `(provider, adapterId)` 桶独立文件，独立原子落盘，天然隔离
> 并发；列语义由适配器 `samplePoint` 声明并随桶落盘。

---

## 4.1 现状结构与问题

- 现有采样点 `[ts, rollingPct, weeklyPct, monthlyPct]`，单文件 `history.json`。
- 已演进：M3a 单文件内按 provider 分桶（v2）。
- **新问题（本文件解决）**：
  - 同一 provider 切换多适配器，列语义可能不同 → 需按 `(provider, adapterId)` 分桶；
  - **单文件并发写风险**：所有桶塞进一个 `history.json`，任意桶落盘即整体原子覆写；
    多 provider/多适配器频繁采样时，不同桶的 flush 会互相竞争同一文件路径，
    tmp+rename 虽防半截文件，但并发覆写可能丢失其它桶刚写入的数据。
    → **改多文件，每桶独立文件独立落盘**。

---

## 4.2 目标结构：多文件，按 (provider, adapterId) 一桶一文件

```
~/.dsh/dsh-opencode-usage/
  history/
    opencode-go/
      opencode-go-builtin.json
    my-relay/
      my-relay-v1.json
```

每文件 = 一个桶，格式：

```jsonc
// history/opencode-go/opencode-go-builtin.json  v3
{
  "version": 3,
  "provider": "opencode-go",
  "adapterId": "opencode-go-builtin",
  "columns": [
    { "key": "rolling", "name": "5h 滚动", "limit": 12, "resetPeriodMs": 18000000 },
    { "key": "weekly",  "name": "每周",    "limit": 30, "resetPeriodMs": 604800000 },
    { "key": "monthly", "name": "每月",    "limit": 60, "resetPeriodMs": 2592000000 }
  ],
  "samples": [ [ts, 3, 1, 0], ... ]
}
```

- **键 = `provider / adapterId` 双层目录 + 文件名**。
- **`columns` 由适配器 `samplePoint` 的结构化返回值提供**（见 `1-contracts.md` §1.1），
  随桶落盘，渲染器按当前启用适配器的 columns 对齐列语义。
- 切换适配器 → 新 adapterId 的新文件从零累积；切回旧 adapterId 仍读旧文件（不丢）。

---

## 4.3 并发与落盘策略

- **跨桶隔离**：每桶独立文件、独立 `tmp + rename` 原子落盘——不同桶 flush 各写各的，
  互不竞争。目录：`history/<provider>/<adapterId>.json`。
- **同桶串行化**：单进程内同桶 flush 用防抖 + 串行队列（上一次完成才放行下一次），
  避免同桶 tmp 文件名碰撞与乱序。`tmp` 命名用随机后缀（如 `Date.now()` + 随机），
  减少极端碰撞。
- **多进程/多节点**：各宿主独立写各自目录（沿用现状，不承诺跨机合并）；同机多进程
  由 tmp+rename 原子性 + 采样点同分钟去重兜底（后写覆盖同分钟旧点，不产生脏序列）。
- **失败不阻断**：单桶落盘失败仅 warn，继续内存序列，下次采样重试（沿用现状语义）。

---

## 4.4 归属性与迁移

### 归属规则（这次采样属于谁）

1. **前台归属（默认）**：客户端把 `provider` 随 `/stats?provider=` 带宿主，宿主按
   `(provider, 当前启用 adapterId)` 入桶。
2. **后台归属（浏览器关闭）**：遍历所有启用适配器（D10）各取一份各自入桶，保证历史
   连续；限流由 `sampleIntervalMs` + TTL 覆盖。
3. **旧数据迁移**：启动时若发现旧单 `history.json`（v1/v2）→ 迁移到多文件。

### 迁移 v1 → v2 → v3（多文件）

- 启动扫描：若存在旧 `history.json`（在 `dsh-opencode-usage/` 目录）：
  - `version === 1`（单序列）→ 写入 `history/opencode-go/opencode-go-builtin.json`
    （columns 用内置默认三窗口）。
  - `version === 2`（单文件 provider 分桶）→ 每 provider 桶搬至
    `history/<provider>/<该 provider 当前启用 adapterId>.json`；无启用适配器时搬入
    内置 adapterId（若存在）。
  - 迁移成功后旧 `history.json` 备份为 `history.json.vN.bak` 并移除。
- 加载：启动扫描 `history/` 下所有 `*.json`，逐个读入内存 `Map<"provider/adapterId", bucket>`。
- 采样点形状 `[ts, ...cols]`，列数由桶 `columns` 声明；`append` 校验「至少 2 元素 + ts
  合法」+ 列数一致性（桶首次写入记录列数，后续不一致 → warn + 跳过）。
- 超龄裁剪（`maxAgeDays`）按桶执行，落盘时剔除非当前会话相关超龄点。

---

## 4.5 采样挂点与解耦（R2）

- **采样/取数解耦**：采样挂点放宽为「任意数据到达点（含缓存命中）都 append」——
  `/stats` 轮询命中 TTL 缓存时也用缓存数据 append 采样点，保证 60s 采样分辨率，不依赖
  真实上游请求。同分钟去重逻辑不变（`floor(ts/60000)` 相同则替换）。
- `collectStats` 取回结果 → 按 `usage.provider` + 当前启用 `adapterId` 追加到对应桶。

---

## 4.6 路由与约定

- `/history` 支持 `?provider=<name>&adapterId=<id>` 过滤；响应带该桶的 `columns`。
- `/stats` 返回 `provider` + `adapterId`，客户端据此取对应历史。
- 各桶的「观察周期 / 重置线」语义由渲染器按 `columns`/`ProviderUsage.windows` 解释，
  宿主结构不感知具体窗口名（保持薄）。