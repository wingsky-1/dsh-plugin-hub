# dsh-opencode-usage 演进方案（主文件）：按 Provider 适配 + 用户自定义 JS 注入

> 状态：**M1 适配器框架 + M2 用户 JS 注入已实施（分支 `feature/provider-adapter`），
> 本文件为剩余阶段 R1~R3+M3b 的设计定稿与跟进跟踪**
> 涉及插件：`github/dsh-plugin-hub/packages/dsh-opencode-usage`（@wingsky-1/dsh-opencode-usage）
>
> **文档结构（总分）**：本文是主文件，只记录「阶段做什么 + 方案」+ 决策 +
> 结论；具体契约 / 数据流 / 配置 / 错误矩阵 / 里程碑验收的细化，见
> `docs/opt/usage-provider-adapter/` 下的子文件（见文末「子文件索引」）。

---

## 1. 目标

当前插件是「OpenCode Go 单 provider 用量悬浮框」：写死 `baseUrl`、写死
`CHART_SERIES`（rolling/weekly/monthly 三窗口）。只适配官方一家。

演进目标：
1. **识别用户选中会话** → 拿到该会话当前所用 provider。
2. **按 provider 展示不同信息与点击卡片** → 各提供商渲染各自含义的卡片。
3. **核心难点**：用户大多走**中转站/聚合服务**（provider 无统一格式），无法内置全部
   适配 → 提供**配置入口，让用户注入自己实现的宿主端 + 客户端 JS 文件**。
4. **设置面板独立 tab「用量统计」**：把浮窗浓缩信息升级为设置页完整统计视图，同时
   充当该插件配置 + 自定义适配器的集中管理入口。

**关键判断**：这不是给某个中转站写死适配，而是建立一套「按 provider 名注册适配器」
的通用框架。

---

## 2. 阶段总览（R1~R3+M3b）

### M0 — 技术可行性烟测（已实施，结论：两探针全部成立）
- **结论**：
  - 探针① 成立：客户端经 `session.models` RPC 取 `SessionModels.current.provider`。
  - 探针② 成立：`settings.section` 可注册独立 tab。
- 细化见子文件 `2-session-provider-detection.md`。

### M1 — 适配器框架 + 内置 OpenCode Go 迁移（已实施，分支 `feature/provider-adapter`）
- **交付**：契约本（HostProviderAdapter / ClientProviderRenderer / ProviderUsage）、
  HostAdapterRegistry、内置 opencode-go 适配器、RendererRegistry、内置客户端渲染器、
  `/stats?provider=` 分派、`/adapters.json` 路由、`/user/<n>.js` 静态服务、`stripSecrets`
  护栏、历史 v1 向后兼容、provider 检测（session.models RPC 路径）。
- **验收**：旧配置无感升级；全门禁绿。

### M2 — 用户自定义 JS 注入（已实施，分支 `feature/provider-adapter`）
- **交付**：路径解析（`~/`/绝对/相对 DSH_HOME）、用户宿主适配器动态加载（`import()`）、
  用户客户端渲染器 blob import 加载、`window.__DSH_USAGE__` 桥接（D4 契约版本化）、
  示例模板文档。
- **验收**：端到端跑通用户适配器加载链路。

### M3a — 多 Provider 历史采样 v2（已实施，分支 `feature/provider-adapter`）
- **交付**：历史按 provider 分桶 (`series[provider].samples`)、v1→v2 迁移、
  `/history?provider=` 过滤、后台定时器遍历所有注册 provider。
- **验收**：多 provider 采样不串厂商。

### R1 — 契约 + 注册表 v2（候选 + 启用机制）
- **目标**：适配器从「一对一硬覆盖」升级为「候选 + 唯一启用 + 热切换」。
- **方案**：
  - 注册表改为 `provider → 有序候选列表`，每条带 `{ id, label, enabled, source, file, status }`；
    每 provider 一个 `enabledId`，`get(provider)` 只返回启用条目。
  - `ProviderSummary` 接口（轻量按钮内容）；`HostProviderAdapter` 加 `id`/`label`/可选
    `summarize`/`samplePoint`；`samplePoint` 结构化列声明（`{ cols, values }`）。
  - `defineUsageAdapter` 工厂：典型用量型只需写 `fetchUsage`，自动派生 summarize/samplePoint。
  - `stripSecrets` 护栏扩展：覆盖 ProviderSummary 全部字符串字段 + 值模式匹配
    （`sk-`/`Bearer ` → `<redacted>`）。
  - 默认启用策略：内置 opencode-go 默认启；配置显式列出的用户适配器默认启；
    `enabled: false` 可显式关闭。
- **产出**：可用候选注册表 + 启用切换准备 + 护栏扩展。
- **验收**：同 provider 多候选注册/snapshot 返回候选详情；启用切换后 get 返回新条目；
  smoke 绿。

### R2 — 切换机制 + 语义分层 + 多会话后台
- **目标**：
  1. 物理切换接口 + 缓存失效；
  2. **两个语义面**（按钮内容 vs 浮框内容）分离为**单端点内嵌**（`/stats` 响应内嵌
     `summary` 子树 + 渲染器 `pill` 钩子，不新增路由）；
  3. 后台定时器遍历**所有已启用适配器**（跨 provider、跨会话）；
  4. 当前会话无启用适配器 → 浮窗隐藏 + 60s 轻量探测恢复。
- **方案**：
  - **切换**：`POST /api/dsh-opencode-usage/adapters/select`（body `{ provider, adapterId }`，
    loopback 围栏）→ 清该 provider 的 stats/summary/历史缓存 → 下一个请求走新适配器。
  - **语义分层**：`/stats` 响应内嵌 `summary` 子树 `{ text, level, hint, derived? }`；
    胶囊读 summary 子树、面板读 `windows`/`data`。`ClientProviderRenderer` 加可选
    `pill?(summary): { text, level, hint? }` 钩子（完全自定义按钮文案）。
    **不新增物理路由**（评审 P1-1/P1-2 硬约束：避免双缓存不一致）。
  - **后台**：定时器遍历 `registry.snapshot().infos` 中 `status === "active"` 且
    `enabled === true` 的条目，各自 `collectStats` + 采样（`(provider, adapterId)` 双键桶）。
  - **无适配器隐藏**：`/summary` 接口带 `hasAdapter` 标志；客户端收到 `hasAdapter: false`
    → 浮窗隐藏，60s 轻量轮询 `/summary` 直到 `hasAdapter: true` 恢复。
  - **采样/取数解耦**：缓存命中（含 `/summary` 轮询）也 append 采样点，保持 60s 分辨率。
- **产出**：切换可用 + 胶囊/面板语义分离 + 多会话后台 + 无适配器隐藏。
- **验收**：切换后数据/页面/历史全部跟随新启用者；无启用的 provider 前台隐藏、后台跳过；
  capsule 文案走 `pill` 钩子或通用推导；smoke 绿。

### R3 — 文档 + 示例
- **目标**：契约本文档、完整接入清单、示例中转站模板补 `summarize/samplePoint`。
- **方案**：更新本文档及子文件 1~8；模板与 README 安全模型。
- **验收**：文档与代码一致。

### M3b — 设置面板独立 tab「用量统计」
- **目标**：设置面板独立顶层 tab，四区页面（总览/可视化/适配器候选单选启用/配置编辑）。
- **方案**：宿主 `installSettingsNamespace` + 客户端 `settings.section`（见
  `5-settings-panel-tab.md`）；`settings` 持久化 enabled 选择（重启保留）。
- **验收**：tab 可用；无启用适配器的引导入口可见；切换热生效且重启保留。

---

## 3. 关键决策（已定）

| # | 决策 | 说明 |
| --- | --- | --- |
| D1 | 会话识别走 **DSH slot 系统**（用户已选） | M0 结论成立，采用 `session.models` RPC 路径 |
| D2 | 用户注入 js 交付形态 = **本地文件路径** | 不做 npm 包 / inline 字符串 |
| D3 | 设置面板独立 tab 用 **`settings.section`**（不是 plugin.item） | 已核实 slot 体系，见 `5-settings-panel-tab.md` |
| D4 | 客户端注入走 **「插件主动拉取用户 js」+ 契约版本化** | 消除 tapIndex 加载时序与全局命名空间脆弱性 |
| D5 | 归一化数据模型**压薄** | 强制最小公约数 `{ok, provider, label, fetchedAt}`，windows 可选；编排层不解读 `data`/`meta` |
| D6 | 适配器注册表改为 **候选 + 唯一启用** | 同 provider 允许多候选，任一时刻一启用（R1） |
| D7 | 切换启用适配器链接口 `POST /adapters/select` | 切换后清缓存，下一个请求走新适配器（R2） |
| D8 | **按钮内容与浮框内容不分物理路由** | 单端点 `/stats` 内嵌 `summary` 子树 + 渲染器 `pill` 钩子（评审 P1-1/P1-2 硬约束，避免双缓存不一致与采样驱动断裂） |
| D9 | 历史按 `(provider, adapterId)` 双键分桶，**多文件存储**（每桶一文件） | 一桶一文件独立目录 `history/<provider>/<adapterId>.json`，各桶独立原子落盘，避免并发写互相覆盖；切走保留旧桶、切回可见；`samplePoint` 结构化列声明随桶落盘 |
| D10 | 后台定时器遍历**所有已启用适配器** | 跨 provider 跨会话，各自独立 `(provider, adapterId)` 历史桶；采样/取数解耦（缓存命中也可采样） |
| D11 | 无启用适配器 → 浮窗隐藏 + 60s 轻量探测 | 不显示永久错误条；引导入设置面板 |
| D12 | `stripSecrets` 扩展扫 summary 全部字段 + 值模式匹配 | 键名（`secret/token/key/apikey`）+ 值模式（`sk-`/`Bearer `）双重脱敏 |

---

## 4. 架构总览

```text
┌──────────────────────────────────────────────────────────────────┐
│ dsh-opencode-usage（插件本体：编排）                               │
│                                                                  │
│  客户端（当前会话视角）：                                          │
│    · 识别会话 provider → 查该 provider 的启用适配器                 │
│    · 有启用适配器 → 浮窗显示（胶囊=summary 子树、面板=stats+历史）  │
│    · 无启用适配器 → 浮窗隐藏，60s 轻量探测恢复条件                  │
│    · 设置面板独立 tab（全局视角，完整统计 + 适配器候选管理）         │
│                                                                  │
│  宿主端：                                                         │
│    · /stats → 内嵌 summary 子树 + 带 adapterId/hasAdapter          │
│    · /adapters/select → 切换启用适配器 + 清缓存                    │
│    · /adapters.json → 候选列表（含 id/label/enabled/source/status）│
│    · 后台定时器 → 遍历所有已启用适配器，各自取数 + 采样             │
│    · 历史 → (provider, adapterId) 双键分桶，多文件每桶一文件        │
└──────────────────────────────────────────────────────────────────┘
```

- 当前会话 + provider **识别放客户端**（浏览器持有激活态）。
- provider 取数（中转站对接、密钥）**放宿主端用户 js**。
- 胶囊/按钮文案走宿主 `/stats` 内嵌 summary 子树或渲染器 `pill` 钩子；面板内容走渲染器 `render`。
- 浮窗与独立 tab **共享同一核心层**（识别 + 注册表 + 归一化），只载体不同。

---

## 5. 配置入口（概要）

```yml
plugins:
  ui-dsh-opencode-usage:
    # —— 既有键（不变） ——
    enabled: true
    baseUrl: https://opencode.ai/zen/go/v1/usage
    # —— 适配器候选（支持多个，每个可独立启停） ——
    adapters:
      host:
        - provider: my-relay
          file: ~/.dsh/my-relay-host.mjs
          enabled: false          # 可选：显式关闭，缺省 true
        - provider: opencode-go
          file: /abs/path/custom-opencode-go.mjs  # 与内置同 provider，覆盖内置
      client:
        - file: ~/.dsh/my-relay-client.js
```

- 宿主端动态 `import` 用户宿主 js；serve + blob import 用户客户端 js。
- 路径支持绝对 / 相对 DSH_HOME / `~` 展开；加载失败只 warn + 该候选不注册，不阻断插件。
- 完整 schema、解析规则、加载降级矩阵见 `3-config-and-injection.md`。

---

## 6. 安全与数据流（概要）

- 宿主端用户 js = 完整 Node 权限（等同用户自己写插件），文档明示信任边界。
- `stripSecrets` 护栏扩展：覆盖 ProviderSummary 全部字符串字段 + 值模式匹配
  （`sk-`/`Bearer `脱敏），与现有键名扫描互补。
- 全部路由 loopback 围栏 + 方法校验。
- 数据流时序（summary 轮询 / stats 面板 / 后台多适配器采样 / 切换失效）+
  错误/降级矩阵见 `7-dataflow-and-errors.md`；信任域安全模型见 `6-security.md`。

---

## 7. 兼容性与回归

- 旧配置无 `adapters` 键 → 走内置 OpenCode Go（默认启用），行为不退化。
- 单端点内嵌 summary 子树：旧客户端不读该字段，只读 windows，零影响。
- `POST /adapters/select` 新路由：旧客户端不调用，无影响。
- 历史数据结构迁移：v1 → v2（按 provider 分桶，已实施）→ **多文件 v3**（`(provider, adapterId)` 每桶一文件）。
- **历史 opencode-usage 数据割接**：旧版（main 0.1.9 单文件 v1 / M3a 单文件 v2）升级时，
  已有 opencode-go 历史平滑迁移到多文件 v3（归内置 `opencode-go-builtin` 桶，三窗口列
  语义延续、不丢失、幂等）；旧文件重命名 `.bak` **保留不删除（由用户清理）**，
  割接矩阵见 `4-usage-history-multiprovider.md`。
- 新增路由 / `settings.section` / 聚合包 patch 需补门禁用例。

---

## 8. 结论（方向确认，分阶段实施）

- M0-M3a 已实施验证（分支 `feature/provider-adapter`），全门禁绿。
- 剩余 R1~R3+M3b 方向正确，决策已定（D6~D12）。
- 实施按 R1→R2→R3→M3b 顺序推进，每阶段独立门禁绿 + 提交。

---

## 9. 子文件索引（细化实现路径）

| 子文件 | 覆盖 |
| --- | --- |
| `1-contracts.md` | 宿主/客户端适配器完整契约、归一化模型、版本、错误码、注册表候选+启用、工厂 |
| `2-session-provider-detection.md` | 会话 provider 识别（M0 结论）、slot vs DOM 订阅 |
| `3-config-and-injection.md` | 配置 schema（含 enabled 字段）、路径解析、用户 js 注入、加载降级矩阵 |
| `4-usage-history-multiprovider.md` | `(provider, adapterId)` 双键历史分桶、采样列声明、v2→v3 迁移 |
| `5-settings-panel-tab.md` | 设置面板独立 tab 双端接线与页面内容（含适配器候选管理） |
| `6-security.md` | 信任域安全模型、stripSecrets 扩展、密钥边界 |
| `7-dataflow-and-errors.md` | 数据流时序（summary 轮询/stats 面板/后台多适配器采样/切换失效）、错误/状态机、降级矩阵 |
| `8-milestones-and-tests.md` | 里程碑验收、测试矩阵、兼容性矩阵、风险登记 |

> 路径：`github/dsh-plugin-hub/packages/dsh-opencode-usage/docs/opt/usage-provider-adapter/`
> （与仓库 docs/DEVELOPMENT.md 分开，属本插件演进设计文档）。