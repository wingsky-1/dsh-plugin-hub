# 2. 会话 Provider 识别 + M0 烟测（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件细化「如何拿到当前选中会话的 provider」：M0 先验证，再定 slot 路径或回落
> DOM+订阅；以及 provider 变化时的重渲染。

---

## 2.1 数据来源（已核实源码）

- `SessionModels.current` = `{ provider, model, reasoningEffort? }`，是本会话下一
  step 所用模型选型的**权威来源**（`@deepseek-ai/dsh-host-apiproxy` `sessions.d.ts`
  L91–99、L146–162）。
- 该模型快照属**异步 catalog / 连接 API** 面，不在同步 props 上——客户端要拿它需经
  `ctx.sessions` 或 `ctx.connection.api` 的 model-catalog / session-model 查询，且
  **具体取到的形态在运行时未实测**（推断）。
- 设置面板 slot `SessionMaybeStandardProps.sessionId` 提供「当前会话 id」，同样
  hub 内无直接先例（dsh-idle-archive / dsh-lan-proxy 只用到 rpc 层面，未在 slot 组件
  里消费 sessionId）。

因此：**两条事实都必须在 M0 用最小探针验证，这是全案最大不确定性。**

---

## 2.2 M0 烟测方案（最小探针，不动正式代码）

**探针 ①：客户端拿 current.provider**
- 在 `src/client/index.ts` 临时（或独立分支）注入 `connection`/`sessions`，apply 里
  打印 `ctx.sessions` 的读面、以及 session 的 model catalog，抓取 `current.provider`。
- 验证点：能否拿到稳定 provider 名？provider 变化（切换会话/改模型）时有无通知事件
  （`ctx.on` 或 `useProjection`）？
- 通过标准：能拿到 provider 名 + 能订阅变化。

**探针 ②：settings.section 注册独立 tab**
- 用 build-client 的 React externals 路径注册一条 `settings.section`（id/label/order），
  看能否在设置面板顶部导航出现独立项。
- 通过标准：tab 出现且组件可渲染；`installSettingsNamespace` 命名空间被 serve。

**探针输出**：两份结论记录（成立 / 不符及替代取法）。

**若探针 ① 不符，回落方案**：宿主端提供「provider 白名单 + 推断」配置（用户显式
`provider: { name, file }`），客户端从会话标题/系统提示/正则兜底确认，仍接同一套
适配器注册表——核心框架不受影响。

---

## 2.3 选定路径：slot 会话识别（D1）

若 M0 通过，走 slot 标准重构：
- 悬浮框改 React 组件（`import * as React from "react"`，React externals 路径 +
  `react-shim.d.ts`，同 idle-archive/lan-proxy）。
- 用 `session-maybe` 会话 slot 注册，经 `SessionMaybeStandardProps.sessionId` 拿当前
  会话 id，据此解析 provider，让 framework 托管随会话切换的卸载/重建。
- **三处需重新适配**（现有纯 DOM 挂载逻辑）：① MutationObserver 迁移会话滚动容器；
  ② scroll/resize 定位 + 避让 MCP 浮窗；③ 三窗口 SVG / ResizeObserver 字号补偿。

**回落路径（探针失败用）**：保持现有 DOM 挂载，客户端另订阅 sessions 变化读 provider；
与 slot 路径共享同一套「适配器注册表 + 归一化 + 分派」核心，**仅「如何拿当前会话
provider」这一层不同**。核心不浪费，两路径可并存灰度。

---

## 2.4 重渲染与竞态

- provider 变化 → 取消上一次渲染（闭包 token / AbortController）+ 调上一次渲染器
  disposer → 查新 provider 的渲染器 → 渲染。
- 快速切换会话：用「渲染代 token」保证只有最新一代落地，旧代结果丢弃。
- 浮窗与设置 tab 共享同一 provider 解析，避免两处不一致（见 5-settings-panel-tab）。
