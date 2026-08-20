# 4. 多 Provider 历史采样演进（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件处理一个**结构性缺口**：现有 `history.json` 是**单 provider、三窗口固定列**
> 结构，多 provider 并存后会**串厂商数据**。M3 需做数据结构演进与迁移。

---

## 4.1 现状结构（问题所在）

现有采样点 = `[ts, rollingPct, weeklyPct, monthlyPct]`（`src/index.ts`
`SamplePoint`），落盘 `~/.dsh/dsh-opencode-usage/history.json`（单文件单序列）。

**多 provider 后的问题**：
- provider A 与 B 的采样点混在**同一条列语义**（rolling/weekly/monthly 对每家含义
  都不同，百分比不可混比）。
- 采样是「宿主后台定时器」触发的，宿主并不知道当前 GUI 选中了哪个会话——多会话并存
  时「这次采样属于哪个 provider」没有归属。

---

## 4.2 目标结构：按 provider 分桶

```jsonc
// ~/.dsh/dsh-opencode-usage/history.json  v2
{
  "version": 2,
  "series": {
    "opencode-go": { "samples": [ [ts, r, w, m], ... ] },
    "my-relay":    { "samples": [ [ts, ...], ... ] }
  }
}
```

- **键 = provider 名**，各 provider 独立序列，语义自解释（列含义由该 provider 的渲染
  器/契约定义，宿主只存紧凑数值）。
- `windows` 列数不再固定 3——适配器在归一化 `ProviderUsage.windows` 里声明列数/
  列名，宿主按声明落盘。

---

## 4.3 归属规则（这次采样属于谁）

后台定时器采样**不知道 GUI 选中会话**，这是设计的客观边界。归属策略分层：

1. **前台归属（默认）**：客户端把「当前 provider」随任一路由请求带给宿主（如
   `/stats?provider=<name>`），宿主据此把**当次取回的归一化数据**记入该 provider 桶。
2. **后台归属（浏览器关闭时）**：宿主对**每个已配置/已见过的 provider 各取一份**并
   各自入桶（多 provider 轮询），保证历史连续——代价是请求数 × provider 数，需在
   文档与限流（`sampleIntervalMs` + TTL）里讲清。
3. 无法归属的旧数据（version 1）→ 归入 `opencode-go` 桶（向后兼容迁移）。

---

## 4.4 迁移 v1 → v2

- 启动检测 `history.version === 1` → 读取旧单序列，写入 `series["opencode-go"]`，
  原子改写文件；失败则保留旧文件做备份（`history.json.v1.bak`），新数据写 v2。
- 同分钟去重、超龄裁剪（`maxAgeDays`）逻辑保持，按桶分别执行。
- 采样点形状从固定 `[ts, r, w, m]` 放宽为 `[ts, ...cols]`，列数由桶的声明决定；
  `append` 校验改为「至少 2 元素 + ts 合法」。

---

## 4.5 采样挂点调整

现有逻辑「只有权威 fetch 成功才 append」（防失败污染波浪图）保留，但挂到**分派后
的归一化数据**上：`collectStats` 取回 `ProviderUsage` → 按 `usage.provider` 追加到对应
桶。采样驱动（GUI 轮询 / 后台定时器）与「如何归属」解耦，见 4.3。

---

## 4.6 路由与约定

- `/history` 增加 `?provider=<name>` 过滤（缺省返回全部桶或当前 provider，见
  `7-dataflow`）；`/stats` 返回 `provider` 字段，客户端据此取对应历史。
- 各 provider 桶的「观察周期 / 重置线」语义仍由渲染器按 `ProviderUsage.windows`
  声明解释，宿主结构不感知具体窗口名（保持薄）。
