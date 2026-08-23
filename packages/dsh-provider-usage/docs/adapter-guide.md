# 用量统计适配器开发引导（v2 契约，面向 Agent 与用户）

> 适用插件：`@wingsky-1/dsh-provider-usage`（v2 契约重构版）。
> 本文是接入自定义数据源的权威指南。读完本文 + `examples/usage-adapter.example.mjs`
> 即可接入任意 API。

## 1. 契约总览（用户交付物：单个 .mjs 文件）

```js
export const version = 2;              // 必填：契约版本，固定 2
export const name = "my-stats";        // 必填：^[A-Za-z0-9_-]{2,64}，唯一
export const label = "我的统计";        // 可选：展示名
export const providers = ["my-relay"]; // 必填：认领的 provider 列表
export const retention = { maxAgeDays: 30, maxSizeMB: 20 }; // 可选

export async function fetchData({ apiEndpoint, staticPath, apiKey, signal, timeoutMs }) {
  // 必填 1/3：取原始数据（宿主端 Node 执行）。返回对象 = 历史落盘 data。
}

export function formatCapsule({ time, data, status, error, esc }) {
  // 必填 2/3：胶囊内容（宿主端执行）。返回 HTML 字符串。
}

export function formatPanel({ entries, range, truncated, esc }) {
  // 必填 3/3：面板内容（宿主端执行）。返回 HTML 字符串。
}
```

**三个导出一个都不能少**——缺失任一 → fail-fast 拒载（设置页「适配器」区可见错误）。

## 2. 接入步骤（用户视角）

1. 按示例编写 `.mjs`（参考 `examples/usage-adapter.example.mjs`）
2. 用户层 `cordis.patch.yml` 声明路径：

```yml
plugins:
  '@wingsky-1/dsh-provider-usage':
    adapter: ~/.dsh/adapters/my-stats.mjs
    provider: my-relay
    staticPath: /api/usage
    autoReload: true       # 可选：编辑后自动热更新
```

3. 重启 `dsh web`（或开启 autoReload 免重启）

## 3. 关键设计约束（必须遵守）

| 约束 | 说明 |
|------|------|
| **密钥配置注入** | `apiKey`/`apiEndpoint` 由插件经配置链注入 `fetchData` 入参；**适配器源码中绝不写死密钥**（文件会被静态暴露给浏览器，写死 = 泄露） |
| **HTML 转义义务** | 凡来自外部 API 的字符串拼入 HTML 模板，一律 `esc()` 转义（如 `esc(data.name)`）。插件有净化兜底，但那是最后防线，不是随意的理由 |
| **最小数据集** | `fetchData` 只返回展示所需字段（这些数据按天落盘）。返回全量日志/凭据 = 历史文件敏感面扩大 |
| **`name` 白名单** | `^[A-Za-z0-9_-]{2,64}$`：不能有空格/路径分隔符/中文 |
| **超时意识** | fetchData 被强制 2s 超时（可配置）。不要在 fetchData 里做串行多请求或长轮询 |

## 4. 安全模型速览

- 适配器 = **宿主进程完整 Node 权限**（等同用户自己写插件）——只加载信任的本地文件
- 密钥仅存宿主内存，浏览器端不可见
- 历史按天分片 JSONL 落盘（0600 权限），30 天 / 20MB 自动清理
- 所有 HTTP 路由 loopback 围栏（仅本机可访问）
- 若需局域网访问：必须先加 token 鉴权再放开（V1 未提供，需自行扩展）

## 5. 排障

| 现象 | 排查 |
|------|------|
| 设置页「适配器」区显示 load 错误 | 违反 fail-fast 校验（缺导出/name 非法），按错误信息修复 |
| `/stats` 返回 `status:"stale"` + error | fetchData 抛错/超时：看 error 字段（no-api-key / unauthorized / http-xxx / network / timeout） |
| 胶囊不显示 | provider 未启用适配器或无数据：`/health` 看 adapters 列表 |
| 热更新不生效 | `autoReload` 未开 / 文件 mtime+size 未变化 / 新版本契约校验失败（保留旧版） |

## 6. v1 → v2 迁移对照

| v1（旧） | v2（新） |
|---------|---------|
| `export default { version:1, id, label, providers, fetchUsage }` | 具名导出 `version:2, name, providers, fetchData` |
| 客户端渲染器 `.js` + `window.__DSH_USAGE__` 桥接 | `formatCapsule`/`formatPanel` 返回 HTML（宿主端渲染） |
| `summarize`/`samplePoint`/windows 归一化 | 移除，胶囊/面板直接由 format 函数产出 |
| 设置页运行时 add/select 适配器 | `cordis.patch.yml` 声明 + 热更新 |
| 历史 v3 多文件 JSON 桶 | 按天分片 JSONL（旧数据启动时自动迁移） |