# 4. 多 Provider / 多适配器历史采样演进（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件处理一个**结构性缺口**：现有 `history.json` 是**单 provider、三窗口固定列**
> 结构；一台机器上会存在多个 provider、且同一 provider 可切换多个适配器（D6/D9）。
> 历史需按 `(provider, adapterId)` 双键分桶，且列语义由适配器 `samplePoint` 声明。

---

## 4.1 现状结构（问题所在）

- 现有采样点 = `[ts, rollingPct, weeklyPct, monthlyPct]`，落盘
  `~/.dsh/dsh-opencode-usage/history.json`（单文件单序列）。
- 已演进：M3a 按 provider 分桶 v2（`series[provider].samples`）。
- **新增缺口（D6/D9）**：同一 provider 可切换多个适配器（如官方 ↔ 用户增强版），
  两者的**列语义可能不同**；若混在同一 provider 桶，切换后历史图列错位。
  故需将桶键升级为 `(provider, adapterId)`，且每桶声明 `columns`。

---

## 4.2 目标结构：按 (provider, adapterId) 分桶（v3）

```jsonc
// ~/.dsh/dsh-opencode-usage/history.json  v3
{
  "version": 3,
  "series": {
    "opencode-go": {
      "opencode-go-builtin": {
        "columns": [ { "key": "rolling", "name": "5h 滚动", "limit": 12, "resetPeriodMs": 18000000 },
                     { "key": "weekly",  "name": "每周",    "limit": 30, "resetPeriodMs": 604800000 },
                     { "key": "monthly", "name": "每月",    "limit": 60, "resetPeriodMs": 2592000000 } ],
        "samples": [ [ts, 3, 1, 0], ... ]
      }
    },
    "my-relay": {
      "my-relay-v1": {
        "columns": [ { "key": "credit", "name": "余额", "limit": 100, "resetPeriodMs": 2592000000 } ],
        "samples": [ [ts, 42], ... ]
      }
    }
  }
}
```

- **键 = `provider / adapterId` 双层**，各自独立序列。
- **`columns` 由适配器 `samplePoint` 的结构化返回值提供**（见 `1-contracts.md` §1.1），
  宿主原样落盘，渲染器按当前适配器的 columns 对齐列语义。
- 切换适配器 → 该 provider 的新 adapterId 桶从零开始累积；切回旧 adapterId 还能看到
  旧桶历史（切走不丢）。

---

## 4.3 归属规则（这次采样属于谁）

后台定时器采样**不知道 GUI 选中会话**，这是设计的客观边界。归属策略：

1. **前台归属（默认）**：客户端把「当前 provider」随 `/stats?provider=<name>` 请求带
   给宿主，宿主据此把当次取回的归一化数据按 `(provider, adapterId)` 记入桶。
2. **后台归属（浏览器关闭时）**：宿主对**每个已启用适配器各取一份**并各自入桶
   （D10：遍历所有启用适配器，而非只看当前会话 provider），保证历史连续。代价是
   请求数 × 启用适配器数，限流由 `sampleIntervalMs` + TTL 覆盖。
3. 无法归属的旧数据（version 1/2）→ 迁移（见 4.4）。

---

## 4.4 迁移 v1 → v2 → v3

- 启动检测 `history.version`：
  - `version === 1`（单序列）→ 读旧 `samples` 写入 `series["opencode-go"]["opencode-go-builtin"]`，
    columns 用内置默认三窗口声明。
  - `version === 2`（按 provider 单桶）→ 每 provider 桶搬到
    `series[provider]["<该 provider 当前启用适配器 id>"]`；provider 无启用适配器时搬入
    内置 adapterId（若存在）。
  - 原子改写文件；失败保留旧文件做备份（`history.json.vN.bak`），新数据写 v3。
- 同分钟去重（按 `(provider, adapterId)` 双键）、超龄裁剪（`maxAgeDays`）按桶分别执行。
- 采样点形状 `[ts, ...cols]`，列数由该桶 `columns` 声明；`append` 校验「至少 2 元素 +
  ts 合法」+ **列数一致性**：桶首次写入记录列数，后续不一致 → warn + 跳过该点。

---

## 4.5 采样挂点与解耦（R2）

- **采样/取数解耦**：采样挂点从「只有权威 fetch 成功才 append」放宽为「任意数据到达
  点（含缓存命中）都 append」——`/stats` 轮询命中 TTL 缓存时也用缓存数据 append 采样点，
  保证 60s 采样分辨率，不依赖真实上游请求。同分钟去重逻辑不变（`floor(ts/60000)` 相同
  则替换）。
- `collectStats` 取回结果 → 按 `usage.provider` + 当前启用 `adapterId` 追加到对应桶。

---

## 4.6 路由与约定

- `/history` 支持 `?provider=<name>&adapterId=<id>` 过滤；响应带该桶的 `columns`。
- `/stats` 返回 `provider` + `adapterId`，客户端据此取对应历史。
- 各桶的「观察周期 / 重置线」语义由渲染器按 `columns`/`ProviderUsage.windows` 解释，
  宿主结构不感知具体窗口名（保持薄）。