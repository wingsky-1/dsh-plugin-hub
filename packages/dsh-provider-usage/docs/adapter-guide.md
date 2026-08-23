# 用量统计适配器开发引导（v2 契约，面向 Agent 与用户）

> 适用插件：`@wingsky-1/dsh-provider-usage`（v2 契约重构版）。
> 本文是 Agent 自主引导用户接入自定义数据源的权威流程手册。
> 快速参考：契约细节见第 7 节；完整示例见 `examples/usage-adapter.example.mjs`。

---

## 1. 自主引导原则（先读）

1. **能自己做的绝不问**：接口地址、鉴权方式、字段含义、命名、保存路径……凡能从用户既有信息（模型配置、会话上下文）推断或查证的，一律自行完成。API 端点优先从模型配置的 baseUrl 读取，用量接口按同域惯例（`/v1/usage`、`/usage`、`/quota` 等）确认——不为此问用户；拿不到 baseUrl 且官方文档也没有用量接口说明时，才在审核卡里如实标「端点未知，需要用户提供」。

2. **决策必须交还审核**：自主做的一切实质决策（数据源选择、name/展示名、接口地址、保存路径），在动手生成前，用**决策审核卡**（2.3 节）一次性呈现给用户确认。用户确认后继续，用户改了就按改的来。

3. **只有确认无解才问**：穷尽所有可查手段（官方文档、配置、历史上下文）仍无法确定接口/鉴权时，才向用户提出**最小必要**问题（问数据源地址或鉴权方式，不重复问命名等可由 agent 决策的事）。

4. **类型决定策略**：执行前先判断 provider 属于哪一类——通用大平台走官方文档，非大平台走主动询问。不同类别的端点获取、鉴权确认方式截然不同（见 2.2 节分类执行表）。

---

## 2. 一句话指令 + 完整引导流程

### 2.1 一句话指令

用户从设置页「用量统计」→「接入自定义适配器」复制引导指令发到会话，即触发本流程。指令包含本文档的 **GitHub 链接**（任何工作目录下的 Agent 都能读取）：

> 请为提供商 `<provider>` 创建用量统计适配器（v2 契约）：以该提供商在模型配置中的 API 端点（baseUrl）为起点，自行确认用量接口与鉴权方式，自主设计适配器方案（name/展示名/接口路径），先给我审核方案（含 API 端点），确认后生成 .mjs 文件、告诉保存路径并引导我在 cordis.patch.yml 中声明。按用量统计适配器开发引导文档（https://github.com/wingsky-1/dsh-plugin-hub/blob/main/packages/dsh-provider-usage/docs/adapter-guide.md）执行引导流程。

收到后按以下流程执行（默认全程自主，只保留审核点）：

### 2.2 步骤 1-2：盘点已知 + 类型识别

**盘点已知**（0 提问）：从用户当前会话/模型配置收集：
- provider 名、baseUrl、apiKey 来源
- 是否有用量接口的已知信息（文档、历史对话）

**提供商类型识别**：根据下表判断 provider 类型，按对应分支执行。

| 类型 | 判定特征 | 执行策略 |
|------|---------|---------|
| **通用大平台** | Anthropic、OpenAI、DeepSeek、Google、Azure 等知名 API 提供商 | 自行查官方文档找用量/配额接口，确认端点路径与鉴权方式。baseUrl 从模型配置读，用量接口路径按官方文档确认 |
| **非大平台 / 自建中转** | 非上述知名平台，或用户称"自己的中转站" | 自行设计路径（`/v1/usage`、`/usage`、`/quota` 等常见路径探测），备选方案在审核卡里列出。确认不了的端点如实标注「待用户提供」 |
| **已知已有内置适配器** | opencode-go 等 | 跳过本流程，直接告知用户使用内置适配器（无需额外配置） |

### 2.3 步骤 3：决策审核卡（一次性呈现给用户）

在动手生成代码前，把以下决策整理为审核卡，**一次性**让用户确认：

```
## 适配器方案审核
- provider: `<名称>`
- baseUrl: `<模型配置中的 API 端点>`（或「待用户提供」）
- 用量接口路径: `<确认的路径>`（或备选方案列表）
- 鉴权方式: `<Bearer / 自定义 Header / 等>`
- 适配器 name: `<机器名: ^[A-Za-z0-9_-]{2,64}$>`
- 展示名: `<人类可读>`
- 数据结构: 简要说明 fetchData 返回的字段（用户可确认字段是否够用）
- 保存路径: `<建议路径，如 ~/.dsh/adapters/<name>.mjs>`
- 配置示例: 用户层 cordis.patch.yml 的片段

> 请确认以上方案，或告诉我需要修改的地方。
```

用户确认后进入步骤 4。

### 2.4 步骤 4：生成适配器文件

按 v2 契约生成 mjs 文件（见第 7 节契约规格），写入选定路径。确保：
- 密钥通过 `fetchData({ apiEndpoint, apiKey, ... })` 入参获取，**绝不写死在源码中**
- `fetchData` 只返回展示所需的最小数据集（不返回全量原始日志）
- 所有外部 API 数据拼入 HTML 模板前经 `esc()` 转义

### 2.5 步骤 5：引导用户接线

告知用户：

```
适配器文件已保存到 `<路径>`。请在用户层 cordis.patch.yml 添加以下配置：

```yml
plugins:
  '@wingsky-1/dsh-provider-usage':
    adapter: <路径>
    provider: <provider>
    staticPath: <用量接口路径>
    # autoReload: true    # 编辑 mjs 后自动热更新，无需重启
```

完成后重启 dsh web（或开启 autoReload 免重启），用量胶囊即出现在聊天界面右上角。
```

---

## 3. 契约规格速查（v2）

### 3.1 必填导出

```js
export const version = 2;                          // 固定 2
export const name = "my-stats";                    // ^[A-Za-z0-9_-]{2,64}$
export const providers = ["my-provider"];           // 非空字符串数组
export async function fetchData({ apiEndpoint, staticPath, apiKey, signal, timeoutMs }) {
  // 取原始数据，返回对象
}
export function formatCapsule({ time, data, status, error, esc }) {
  // 胶囊内容，返回 HTML
}
export function formatPanel({ entries, range, truncated, esc }) {
  // 面板内容，返回 HTML
}
```

### 3.2 可选导出

```js
export const label = "我的统计";                      // 展示名
export const retention = { maxAgeDays: 30, maxSizeMB: 20 };  // 留存策略
```

### 3.3 关键约束

| 约束 | 说明 |
|------|------|
| **密钥配置注入** | `apiKey`/`apiEndpoint` 由插件经配置链注入 `fetchData` 入参；**适配器源码中绝不写死密钥** |
| **HTML 转义义务** | 凡来自外部 API 的字符串拼入 HTML 模板，一律 `esc()` 转义（如 `esc(data.name)`） |
| **最小数据集** | `fetchData` 只返回展示所需字段（这些数据按天落盘） |
| **`name` 白名单** | `^[A-Za-z0-9_-]{2,64}$`：不能有空格/路径分隔符/中文 |
| **超时意识** | fetchData 被强制 2s 超时（可配置）。不要在 fetchData 里做串行多请求或长轮询 |

---

## 4. 安全模型速览

- 适配器 = **宿主进程完整 Node 权限**（等同用户自己写插件）——只加载信任的本地文件
- 密钥仅存宿主内存，浏览器端不可见（通过入参注入，不写死在源码）
- 历史按天分片 JSONL 落盘（0600 权限），30 天 / 20MB 自动清理
- 所有 HTTP 路由 loopback 围栏（仅本机可访问）
- 若需局域网访问：必须先加 token 鉴权再放开（V1 未提供，需自行扩展）

---

## 5. 排障

| 现象 | 排查 |
|------|------|
| 设置页「适配器」区显示 load 错误 | 违反 fail-fast 校验（缺导出/name 非法），按错误信息修复 |
| `/stats` 返回 `status:"stale"` + error | fetchData 抛错/超时：看 error 字段（no-api-key / unauthorized / http-xxx / network / timeout） |
| 胶囊不显示 | provider 未启用适配器或无数据：`/health` 看 adapters 列表 |
| 热更新不生效 | `autoReload` 未开 / 文件 mtime+size 未变化 / 新版本契约校验失败（保留旧版） |

---

## 6. v1 → v2 迁移对照

| v1（旧） | v2（新） |
|---------|---------|
| `export default { version:1, id, label, providers, fetchUsage }` | 具名导出 `version:2, name, providers, fetchData` |
| 客户端渲染器 `.js` + `window.__DSH_USAGE__` 桥接 | `formatCapsule`/`formatPanel` 返回 HTML（宿主端渲染） |
| `summarize`/`samplePoint`/windows 归一化 | 移除，胶囊/面板直接由 format 函数产出 |
| 设置页运行时 add/select 适配器 | `cordis.patch.yml` 声明 + 热更新 |
| 历史 v3 多文件 JSON 桶 | 按天分片 JSONL（旧数据启动时自动迁移） |