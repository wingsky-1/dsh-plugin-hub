# dsh-opencode-usage 演进方案（主文件）：按 Provider 适配 + 用户自定义 JS 注入

> 状态：**方案定稿（按源码核实 + 对抗性自查），只评审、未实施**
> 涉及插件：`github/dsh-plugin-hub/packages/dsh-opencode-usage`（@wingsky-1/dsh-opencode-usage）
>
> **文档结构（总分）**：本文是主文件，只记录「分阶段做什么 + 大概方案」+ 决策 +
> 结论；具体契约 / 数据流 / 配置 / 错误矩阵 / 里程碑验收的细化实现路径，见
> `docs/opt/usage-provider-adapter/` 下的子文件（见文末「子文件索引」）。
>
> 评审说明：本轮多次尝试调用独立子 agent 做对抗性评审，但本会话子 agent /
> dev_mode_subagent 通道异常（未返回实质结果）。对抗性评审改由作者在逐条核实真实
> 源码（会话→provider 类型、客户端 connection/sessions 契约、tapIndex 注入先例、
> 宿主端 import 能力、干净模块构建规范、settings.section 插槽）基础上自行完成，
> 结论见文末「结论」。

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

## 2. 阶段总览（每阶段：目标 / 大概方案 / 产出 / 验收）

### M0 — 技术可行性烟测（先于一切）
- **目标**：验证两个决定架构方向的运行时事实，消除主方案最大不确定性。
- **方案**：写最小探针代码确认——① 客户端能否拿到当前会话的
  `SessionModels.current.provider`（或 session slot 注入的 `sessionId`）；②
  `settings.section` 是否能注册设置面板独立 tab。二者 hub 内均**无运行时先例**。
- **产出**：M0 结论记录；据结果确定 M1 走 slot 路径还是回落 DOM 订阅。
- **验收**：两项事实各给出「成立 / 不符及替代取法」的明确结论。
- 细化见子文件 `2-session-provider-detection.md`。

### M1 — 适配器框架 + 内置 OpenCode Go 迁移（不改变现有行为）
- **目标**：建立「宿主适配器（取数）+ 客户端渲染器（呈现）按 provider 注册」框架；
  把现有硬编码逻辑迁入内置适配器，**行为不退化**。
- **方案**：定义契约本（见 `1-contracts.md`）；宿主端建注册表 + 分派 `fetchUsage`；
  客户端建渲染分派；内置 OpenCode Go 双端适配器。
- **产出**：可用的适配器注册表 + 内置适配器；旧悬浮框行为等价。
- **验收**：旧配置无感升级；路径与 CHART 渲染结果与现状一致。
- 细化见子文件 `1-contracts.md`。

### M2 — 用户自定义 JS 注入（本项目核心诉求）
- **目标**：让用户注入「宿主 .mjs 取数 + 客户端 .js 渲染」，适配任意中转站。
- **方案**：宿主端动态加载用户宿主 js；serve + tapIndex 注入用户客户端 js；配置文件
  路径（见 `3-config-and-injection.md`）。
- **产出**：配置入口 + 一份完整中转站示例模板；未命中 provider 时给引导。
- **验收**：用示例中转站能端到端跑通（识别 provider → 拉数 → 渲染卡片）。
- 细化见子文件 `3-config-and-injection.md`。

### M3 — 设置面板独立 tab「用量统计」+ 多 provider 历史采样
- **目标**：设置面板独立顶层 tab；多 provider 并存时历史采样不串厂商。
- **方案**：宿主 `installSettingsNamespace` + 客户端 `settings.section`（见
  `5-settings-panel-tab.md`）；history 按 provider 分桶演进（见
  `4-usage-history-multiprovider.md`）。
- **产出**：独立 tab 页面（总览/用量可视化/适配器管理/配置编辑）；多 provider 采样。
- **验收**：tab 与管理区可用；两个 provider 会话各自的历史/图表不混淆。
- 细化见子文件 `4-usage-history-multiprovider.md`、`5-settings-panel-tab.md`。

贯穿各阶段的**安全与数据流、错误/降级、测试门禁**见子文件 `6-security.md`、
`7-dataflow-and-errors.md`、`8-milestones-and-tests.md`。

---

## 3. 关键决策（已定）

| # | 决策 | 说明 |
| --- | --- | --- |
| D1 | 会话识别走 **DSH slot 系统**（用户已选） | 标准重构；但无先例，受 M0 烟测约束，失败可回落 DOM+订阅 |
| D2 | 用户注入 js 交付形态 = **本地文件路径** | 不做 npm 包 / inline 字符串 |
| D3 | 设置面板独立 tab 用 **`settings.section`**（不是 plugin.item） | 已核实 slot 体系，见 `5-settings-panel-tab.md` |
| D4 | 客户端注入走 **「插件主动拉取用户 js」+ 契约版本化** | 消除 tapIndex 加载时序与全局命名空间脆弱性 |
| D5 | 归一化数据模型**压薄** | 强制最小公约数 `{ok, provider, label, fetchedAt}`，windows 可选 |
| D6 | 本轮**只评审，不实施** | 实施需另获确认 |

---

## 4. 架构总览（大概形态）

```text
┌─────────────────────────────────────────────────────────────┐
│ dsh-opencode-usage（插件本体：编排）                          │
│  客户端：识别当前会话 provider → 查适配器表 → 分派渲染         │
│    · 浮窗胶囊（当前会话视角，轻量）                            │
│    · 设置面板独立 tab（全局视角，完整统计 + 适配器管理）        │
│  宿主端：按 provider 分派取数（内置或用户宿主适配器）           │
│    · 历史采样按 provider 分桶落盘                              │
└─────────────────────────────────────────────────────────────┘
```

- 当前会话 + provider **识别放客户端**（浏览器持有激活态）。
- provider 取数（中转站对接、密钥）**放宿主端用户 js**。
- 卡片渲染**放客户端用户 js**。
- 浮窗与独立 tab **共享同一核心层**（识别 + 注册表 + 归一化），只载体不同。

---

## 5. 配置入口（概要）

```yml
plugins:
  ui-dsh-opencode-usage:
    adapters:
      host:   [{ provider: my-relay, file: /abs/or/~/relay-host.mjs }]
      client: [{ file: /abs/or/~/relay-client.js }]
```

- 宿主端动态 `import` 用户宿主 js；serve + tapIndex 注入用户客户端 js。
- 路径支持绝对 / 相对 DSH_HOME / `~` 展开；加载失败只 warn + 该 provider 回落，
  不阻断插件。
- 完整 schema、解析规则、加载降级矩阵见 `3-config-and-injection.md`。

---

## 6. 安全与数据流（概要）

- 宿主端用户 js = 完整 Node 权限（等同用户自己写插件），文档明示信任边界。
- 「token 不进浏览器端」默认边界**不替用户适配器兜底**，提供可选护栏（剔除疑似密钥
  字段）+ 文档化。
- 全部新路由 loopback 围栏 + 方法校验。
- 数据流时序（拉数/缓存/采样/渲染）+ 错误/降级矩阵见 `7-dataflow-and-errors.md`；
  信任域安全模型见 `6-security.md`。

---

## 7. 兼容性与回归

- 旧配置无 `adapters` 键 → 走内置 OpenCode Go，行为不退化。
- 新增路由 / `settings.section` / 聚合包 patch 需补门禁用例。
- 多 provider 历史采样需**数据结构迁移**（现有 history.json 为单 provider），见
  `4-usage-history-multiprovider.md`。

---

## 8. 结论（有保留可行）

- 方向正确、分层合理；核心论断「provider 来自 SessionModels」成立；新增独立 tab 为
  纯增量，与浮窗共享核心层，不抬高主体风险。
- **三件先动之事**：
  1. **M0 烟测**：会话 provider 取值 + `settings.section` 注册形态（二者无运行时先例）。
  2. **客户端注入改为「插件主动加载用户 js」+ 契约版本化**（消除时序/脆弱性）。
  3. **归一化模型压薄 + 安全边界文档化**。
- 保留：单主仓先做 OpenCode Go 迁移 + 一套完整中转站样例，验证链路后再外扩。

---

## 9. 子文件索引（细化实现路径）

| 子文件 | 覆盖 |
| --- | --- |
| `1-contracts.md` | 宿主/客户端适配器契约、归一化模型、版本、错误码、注册表运行时 |
| `2-session-provider-detection.md` | 会话 provider 识别（slot vs DOM 订阅）、M0 烟测方案 |
| `3-config-and-injection.md` | 配置 schema、路径解析、用户 js 注入通道、加载降级矩阵 |
| `4-usage-history-multiprovider.md` | 多 provider 历史采样演进与数据结构迁移 |
| `5-settings-panel-tab.md` | 设置面板独立 tab 双端接线与页面内容 |
| `6-security.md` | 信任域安全模型、护栏、密钥边界 |
| `7-dataflow-and-errors.md` | 数据流时序、错误/状态机、降级矩阵 |
| `8-milestones-and-tests.md` | 里程碑验收、测试矩阵、兼容性矩阵、风险登记 |

> 路径：`github/dsh-plugin-hub/packages/dsh-opencode-usage/docs/opt/usage-provider-adapter/`
> （与仓库 docs/DEVELOPMENT.md 分开，属本插件演进设计文档）。
