# @wingsky-1/dsh-provider-usage
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-provider-usage)](https://www.npmjs.com/package/@wingsky-1/dsh-provider-usage)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH（DeepSeek Harness）Web GUI 插件：**多 provider 通用用量统计框架**（v2 适配器契约）。

聊天界面右上角常驻悬浮胶囊，展示当前模型 provider 的用量信息；点击展开详情面板。
内置两套适配器开箱即用——**DeepSeek 官方**（余额 + 峰谷倒计时徽标 + 每日用量推算）与
**OpenCode Go**（官方 `/v1/usage` 三窗口用量）；其他任意数据源只需按 v2 契约写一个
mjs 适配器文件即可接入（设置页检测/添加/切换热插拔，见「适配器开发指南」）。
渲染在**宿主端**完成——适配器返回 HTML、客户端只做注入，密钥不进浏览器。

## 核心优势

- **通用框架 + 开箱即用**：一套 v2 适配器契约承载任意 provider；DeepSeek 官方与
  OpenCode Go 两套适配器内置，装完即显示用量
- **接入任意数据源只需一个 mjs 文件**：`fetchData` / `formatCapsule` / `formatPanel`
  三个导出即完成接入；设置页检测/添加/切换热插拔，改文件自动热更新
- **官方没有用量接口也能算**：DeepSeek 内置适配器以余额差守恒式推算每日用量
  （充值/赠款扰动自动抵消、异常区间不计），附峰谷倒计时徽标与 15 日用量柱形面板
- **密钥不出宿主**：取数在宿主端执行，密钥只在宿主端持有与使用、不下发浏览器
  （推荐凭据链 / env 注入；显式 `apiKey` 配置会随宿主配置落盘并以 0600 保护）；
  渲染输出双层净化（`esc()` 转义义务 + 结构化净化兜底），XSS 双重防线
- **历史可回溯、性能有兜底**：按天分片 JSONL 落盘（0600）、超龄超量自动清理；
  面板渲染进程内缓存 + stats 缓存 + 后台预热，数据未变时重复请求零重算

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-provider-usage
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-provider-usage
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

## 工作原理（v2）

```
宿主端（Node）                                客户端（浏览器）
─────────────────────────────                ─────────────────────
预热定时器(5min) ─┐
                  ├→ getStats()               60s 轮询 /stats（取数前先复检
客户端轮询 ───────┘   │ Mutex 互斥锁              会话当前 provider，#71 自愈）
                      │ 60s 缓存              胶囊框架 ← capsuleHtml
                      │ 5s 取数超时           面板框架 ← panelHtml(/history，90s 兜底缓存)
                      ↓
                adapter.fetchData(ctx)   ← 用户 mjs（apiEndpoint/staticPath/apiKey 注入）
                      ↓
                按天分片 JSONL 历史落盘 ──→ 面板渲染缓存全清（主失效）
                      ↓
                adapter.formatCapsule/Panel() → 净化 → HTML 下发
```

内置适配器 `opencode-go-builtin`（OpenCode Go 官方 `/v1/usage` 三窗口用量）与
`deepseek-official-builtin`（DeepSeek 官方余额 + 峰谷倒计时徽标，见下节）开箱即用。

> provider 跟随语义：切换会话即时刷新；会话内切模型/provider 无宿主推送信号，
> 由每次取数前的复检兜底自愈——最长一个轮询周期内跟随（#71）。

> **图解文档**：完整的流程图 / 时序图（启动装配、`/stats` 取数全链路、`/history` 面板、自定义适配器注入三条路径与热更新、客户端交互、密钥解析链）见 [docs/architecture.md](docs/architecture.md)。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 插件开关 |
| `adapter` | 无 | 用户适配器 mjs 路径（缺省用内置 opencode-go） |
| `provider` | `opencode-go` | 关联的模型 provider 名 |
| `staticPath` | 无 | API 路径（注入 fetchData 入参，与 apiEndpoint 拼接） |
| `apiEndpoint` | 无 | API 基础地址（可选；显式配置优先于凭据链） |
| `apiKey` | 无 | 显式密钥（可选；缺省走凭据解析链，不进设置面板回显） |
| `historyDir` | `<DSH_HOME>/dsh-provider-usage/` | 历史存储根目录 |
| `warmupIntervalMs` | `300000` | 后台预热间隔（无客户端访问时保持历史连续） |
| `cacheDurationMs` | `30000` | 缓存新鲜度（毫秒，下限 5000；#198 由 60000 下调——峰谷徽标跨时段边界端到端翻转延迟 ≤95s = 宿主缓存 30s + 客户端轮询 60s + 渲染余量） |
| `fetchTimeoutMs` | `5000` | fetchData 强制超时（**固定值，不可配置**；#208 起 2s→5s，用户配置不生效） |
| `autoReload` | `true` | 热更新开关（编辑适配器文件后自动加载；默认开启，可显式 `false` 关闭） |
| `maxAgeDays` | `30` | 历史保留天数 |
| `maxSizeMB` | `20` | 历史大小上限（MB，超限从最旧日文件删） |

## 胶囊位置配置

用量胶囊（会话右上角悬浮球）与面板的位置支持自定义：打开设置 → 插件 →「用量统计」→「胶囊位置」区，选择锚点（右上 / 左上 / 右下 / 左下）与偏移（水平 / 垂直 / 面板间距 / 层级基准）后点「保存」——**立即生效且跨设备同步**（宿主落盘 `ui.json` 并经 SSE 广播，无需重启）。默认值：右上 / 0 / 48 / 10 / 40——胶囊采用**固定定位**，不随会话滚动内容滑动位移（无避让抖动，滚动时位置稳定）；水平偏移 0 使胶囊右缘贴近容器右缘（右侧对齐）；垂直偏移 48 让胶囊默认位于 MCP 管理器浮窗（同为右上角、距顶 8px）正下方，两胶囊默认互不重叠；面板间距 10px；层级基准 40 对应 CSS 默认 `z-index: 40`，面板自动取基准 +30。胶囊与 MCP 浮窗互不探测、互不避让，各自位置只由本插件配置决定。

| 键 | 值域 | 默认 |
| --- | --- | --- |
| `placement` | `top-right` / `top-left` / `bottom-right` / `bottom-left` | `top-right` |
| `offsetX` / `offsetY` / `panelOffsetY` | 非负整数，clamp 到 0–2000（单位 px） | `0` / `48` / `10` |
| `zIndexBase` | 整数，clamp 到 1–9000（胶囊层级基准；面板派生基准 +30） | `40` |

**移动端 / 平板端适配**（issue #128）：断点判定基准是会话容器（conversationHost）
的视口宽度而非窗口媒体查询——窄屏（≤480px，手机竖屏 / 极窄分栏）下面板近全屏宽、
卡片重排、按钮触控目标加大到 ≈44px；平板档（≤834px）过渡；桌面维持现状。
胶囊最终坐标经 JS 视口 clamp（safe-area 语义：宿主无 `viewport-fit=cover`，
`env(safe-area-inset-*)` 恒 0 时自然退化为普通 clamp）；软键盘弹出经
`visualViewport` resize 跟随，横竖屏切换后下一帧重算。

**跨包避让契约（源自 issue #116，不可回退）**：本插件默认 `offsetY: 48` 依赖
dsh-mcp-manager 浮窗的默认位置（`top-right`、距顶 8px、高约 26px）在其正下方
让位；修改该默认值前须同步评估 mcp-manager 默认锚点 / 偏移，回退属跨包行为
契约变更，两包须联动调整。

## DeepSeek 官方内置适配器（deepseek-official-builtin）

认领 provider `deepseek-official`，对接 DeepSeek 官方「查询余额」接口
`GET https://api.deepseek.com/user/balance`（来源：
[api-docs.deepseek.com/api/get-user-balance](https://api-docs.deepseek.com/api/get-user-balance)）。

### 数据口径

- **仅保留 CNY 币种**：官方 `balance_infos[]` 含多币种条目时只取 `currency === "CNY"` 一条，
  其余（如 USD）全量忽略；金额自官方字符串字段严格解析（非法/缺失 → `null`，杜绝 NaN 落盘）。
- 无 CNY 条目（仅 USD 或空数组）时产出 `balance/toppedUp/grantedBalance = null` 的正常帧
  （不抛错），胶囊显示「DeepSeek 余额 --」占位。
- `is_available=false` 表示账号不可用：该帧仍记录与展示余额，但**不作为每日用量的守恒端点**
  ——相邻区间的用量推算跳过并在面板标注「服务不可用区间不计」，避免把封禁/清零误计为消耗。

### 每日用量推算（余额差守恒式）

官方 API 无任何用量接口，每日用量由相邻采样点的余额差推算：

```
usage = (totalPrev − totalCur) + ΔtoppedUp + Δgranted
```

充值 +X 入账（total −X、toppedUp +X）与赠款过期/退款 −G 出账（total −G、granted −G）
两类非消耗扰动被公式自动抵消。分量缺失时**逐项独立退化**：缺 granted 只跳过该项继续做
toppedUp 修正（反之亦然）；两者都缺退化为纯余额差（旧历史分片兼容），面板汇总行会提示
「部分日期按净变动口径估算」。跨度过大（>27h，采样中断）的区间不计柱不计入汇总，防畸形巨柱。

### 双卡面板与峰谷徽标

- 卡1：CNY 余额大头 + 近 24h 波动折线（统一时间锚、趋势箭头容差 ±0.005、降采样 ≤300 点）。
- 卡2：近 15 个自然日每日用量柱形图（闭环基线口径；消耗蓝柱向上、净增绿柱向下、异常仅标注）。
- 胶囊常驻**峰谷倒计时徽标**（纯本地时间计算，不依赖远端数据——取数失败时同样显示）：
  - 时段定义为 **UTC 工作日固定窗口** `01:00–04:00 / 06:00–10:00`（半开区间），
    来源 [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing)，
    核实日期 **2026-08-26**；硬编码常量无配置项，周末全天低谷。
  - 谷态显示距下次开峰倒计时（如 `⚡谷 · 距峰 02:41`），峰态显示距切谷倒计时；
    tooltip 注明 UTC 时段定义与服务器时区对照。

## 密钥解析顺序（V1 配置链）

1. 插件配置 `apiKey`（显式指定）
2. 环境变量 `{PROVIDER}_API_KEY`（大写，连字符换下划线）
3. opencode-go 兼容旧环境变量 `OPENCODE_GO_API_KEY`
4. `<DSH_HOME>/.credentials.yaml` 的 `{PROVIDER}_API_KEY`
   （opencode-go 在标准 key 未命中时再查旧名 `OPENCODE_GO_API_KEY`）
5. opencode-go 兼容：`~/.local/share/opencode/auth.json` 的
   `opencode-go`（或 `opencode`）条目

> **DeepSeek 官方适配器三级密钥链**：插件配置 `apiKey` 注入 → 凭据链推导 env
> （provider `deepseek-official` → `DEEPSEEK_OFFICIAL_API_KEY`）→ 适配器内自查
> `DEEPSEEK_API_KEY` 兜底（与 llm 层共用，覆盖「llm 能跑、余额接口 401」场景；
> 该兜底属适配器实现细节，不在共享 provider-config 层特判）。三级全空时取数报
> `no-api-key` 并降级 stale 帧（峰谷徽标仍渲染）。

## 路由（全部 loopback 围栏）

| 路由 | 说明 |
| --- | --- |
| `GET /api/dsh-provider-usage/stats?provider=X` | 用量统计 + `capsuleHtml`（胶囊内容）+ `status`/`adapterVersion` |
| `GET /api/dsh-provider-usage/history?provider=X&days=N` | 历史查询 + `panelHtml`（面板内容）+ 查询 `range`（进程内渲染缓存，见下节） |
| `GET /api/dsh-provider-usage/health` | 健康检查 + 适配器快照 + 错误登记 |
| `GET /api/dsh-provider-usage/adapters.json` | 适配器候选元数据（设置页主列表同源，含 `modelProviders`） |
| `POST /api/dsh-provider-usage/adapters/select` | 切换/清空启用适配器 |
| `POST /api/dsh-provider-usage/adapters/inspect` | 预览适配器文件（回显导出信息，不注册） |
| `POST /api/dsh-provider-usage/adapters/add` | 登记用户适配器文件（设置页承载） |

## /history 渲染缓存

`/history` 的 `panelHtml` 在宿主进程内缓存（issue #105 子项①），数据未变时重复请求零重算：

- **命中条件**：同进程内 `(provider, 启用适配器, 归一化查询窗口)` 三者均未变。窗口按
  **自然日粒度**归一化——`end=Date.now()` 的请求间漂移不参与 key，同一自然日内的重复
  请求命中同一条目；不同 `days` 参数归一化为不同条目、互不串数据。命中回放只复用返回值
  字符串层快照（`{panelHtml, error, at}`），绝不缓存 entries 中间层；响应中的 `range`
  仍回显本次请求的真实 start/end。
- **失效时机（四处）**：主失效 = 历史采样**落盘成功时全清**（新数据已入库，所有面板条目
  一次性失效）；此外 **select**（切换/清空启用适配器）、**add**（登记新适配器）、
  **热更新**（适配器文件变更加载成功）三处挂点同步全清。
- **兜底 TTL**：编译期常量 `90000`ms（90 秒，定界 [60s, 120s] 区间取中值），非配置键；
  仅作兜底而非主失效机制——生产命中率由 warmup 周期（5min）与 stats 缓存 TTL（60s）
  复合门控：两次落盘之间的客户端轮询全部命中。
- **不缓存边界**：管道错误响应与无适配器/无启用适配器的结构化响应一律不入缓存——条件
  消除后下一次请求立即重算，不会在剩余 TTL 内复读旧错误或旧占位结构。
- **无条件请求协商**：响应不含 ETag / Last-Modified，不做 304 短路；客户端维持
  `cache: "no-store"`，本缓存为纯服务端行为、客户端零改动。

## 适配器开发指南（v2 契约）

写一个 mjs 文件即可接入任意数据源（完整示例见 `examples/usage-adapter.example.mjs`）：

```js
// my-stats.mjs
export const version = 2;                    // 必填：契约版本（固定 2）
export const name = "my-stats";              // 必填：唯一名（^[A-Za-z0-9_-]{2,64}$）
export const label = "我的统计";              // 可选：展示名
export const providers = ["my-relay"];       // 必填：认领的 provider 列表
export const retention = { maxAgeDays: 30 }; // 可选：留存策略

/** 必填：获取原始数据（宿主端执行；入参由插件注入） */
export async function fetchData({ apiEndpoint, staticPath, apiKey, signal, timeoutMs }) {
  const res = await fetch(apiEndpoint + staticPath, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json(); // 只返回展示所需的最小数据集
}

/** 必填：胶囊内容（宿主端执行，返回 HTML 字符串） */
export function formatCapsule({ data, status, esc }) {
  return `<span style="font-weight:600">${esc(data.visits ?? 0)} 次</span>`;
}

/** 必填：面板内容（宿主端执行，返回 HTML 字符串） */
export function formatPanel({ entries, range, truncated, esc }) {
  const rows = entries.slice(-60).map((e) =>
    `<tr><td>${esc(new Date(e.time).toLocaleString("zh-CN"))}</td><td>${esc(e.data.visits)}</td></tr>`).join("");
  return `<table>${rows}</table>`;
}
```

**接线配置**（推荐设置页承载，无需手改配置文件）：

1. 打开 dsh 设置 → 插件 →「用量统计」
2. 在目标 provider 下点「+ 添加适配器」，输入 mjs 文件路径（支持 `~` 展开 / 绝对路径）
3. 点「检测文件」回显导出信息 → 确认添加（自动持久化 + 热注册为该 provider 启用者）
4. 切换启用 / 停用：候选行开关实时生效并持久化

也兼容 cordis.patch.yml 声明（可选，配置态叠加）：

```yml
plugins:
  '@wingsky-1/dsh-provider-usage':
    adapter: ~/dsh/my-stats.mjs
    provider: my-relay
    staticPath: /api/usage
    # autoReload 默认开启；如需关闭（安全/稳定性顾虑）显式声明：
    # autoReload: false
```

加载失败 fail-fast 拒收并登记错误（设置面板可见），不影响插件其余功能。路径安全：相对路径只允许落在 `DSH_HOME` 或插件 home 内，未规整形态（`../` 穿越）一律 400 拒绝。

### v1 → v2 迁移

| v1（旧） | v2（新） |
| --- | --- |
| `fetchUsage(ctx)` 返回归一化 ProviderUsage | `fetchData(ctx)` 返回原始对象（只包装 `{time,data}` 入库） |
| 客户端渲染器 `.js` + 全局桥接注册 | `formatCapsule`/`formatPanel` 返回 HTML（宿主端渲染） |
| `id` 字段 | `name` 字段（白名单校验更严） |
| `summarize`/`samplePoint`/windows | 移除——胶囊/面板直接由 format 函数产出 |
| 设置页运行时添加/切换适配器（v1 既有） | **保留**：设置页「用量统计」承载（检测/添加/切换/停用，自动持久化）；cordis.patch.yml 声明仅为可选叠加 |

## 安全模型

- **适配器代码 = 宿主完整 Node 权限**（网络/文件/环境变量），等同用户自己写的进程内插件；
  仅加载你信任的本地文件，插件绝不从网络拉取执行代码
- **密钥不进浏览器端**：apiKey 仅存于宿主进程内存，经入参注入 fetchData；
  适配器文件即使被静态服务暴露也不含密钥值（DeepSeek 官方内置适配器同样成立：
  三级密钥链见上文，stats/history/adapters 响应体与胶囊/面板 HTML 均无密钥子串）
- **XSS 双层防护**：外部 API 数据流入 HTML 前必须经 `esc()` 助手转义（文档义务）；
  插件在宿主端对所有 format 输出做结构化净化兜底（script/iframe/on* 属性/javascript: 协议移除），
  且兜底净化封闭 HTML 实体编码变体——具名 / 十进制 / 十六进制、有无分号均解出后匹配，
  协议型载体再按 WHATWG URL 语义剥除 Tab/LF/CR 后定位（jav&#9;ascript: 族同封）；
  净化只删不改并在宽松轮数上限内迭代收敛，超限 fail-closed 丢弃输出（约束最坏 CPU 成本）：
  解码副本仅用于定位、绝不回写输出，合法转义文本零损伤
- **热更新安全**：默认开启（`autoReload`，可显式关闭）；开启后以 mtime+size 轮询检测变化，新版校验通过才原子切换，
  失败保留旧版并登记错误
- **超时纪律**：fetchData 强制 5s 超时（固定值，不可配置）；宿主超时会**主动 abort 真实 fetch**——
  下发给 fetchData 入参的 `signal` 是合并信号（超时兜底 × 外部取消经手动级联监听合成，
  node>=20 全系兼容），适配器应把它透传给底层 fetch 的 `RequestInit.signal`，
  超时/取消时真正中断请求、不悬挂 socket；不透传时超时仅放弃等待，请求可能仍在后台完成。
  0 参声明的 fetchData 不读入参，完全兼容；取数锁为 per-provider 粒度，同 provider 并发请求
  排队并复用首次取数结果——任何情况下不阻塞页面其他请求
- **fail-fast 加载**：适配器缺导出/类型错/name 不合白名单 → 拒绝加载并登记可排障错误
- **历史数据**：按天分片 JSONL 落盘（`0600` 权限），超龄/超量自动清理；
  原始 data 在落盘前经过序列化校验（不可序列化对象拒收）
- 所有路由 loopback 围栏（非回环 403 / 方法错 405）；管理端点信息面最小披露
  （用户文件只显示 basename）；请求频率受控（轮询 ≤1 次/60s + 预热 ≤1 次/5min + 60s TTL 缓存）

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-provider-usage/health

# 源码在 src/，改后必须 build
pnpm --filter @wingsky-1/dsh-provider-usage build
node test/smoke.ts
```

## License

MIT