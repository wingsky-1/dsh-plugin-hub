# 5. 设置面板独立 tab「用量统计」（子文件）

> 主文件：[dsh-provider-usage-provider-adapter-plan.md](dsh-provider-usage-provider-adapter-plan.md)（阶段总览）
> 本文件细化设置面板独立顶层 tab 的双端接线与页面内容，并与浮窗胶囊共享核心层。

---

## 5.0 为什么是 `settings.section`（已核实）

DSH 设置面板 slot 体系（`dsh-client-ui-settings/contract/slots.d.ts`）四层：

| slot | 形态 | 用途 |
| --- | --- | --- |
| `settings.section` | `list/root` `{id,order,label}` | **设置面板顶层导航的独立页面**（本次目标） |
| `settings.plugins.tab` | `list/root` | 插件 section 内部子 tab |
| `settings.plugin.item` | `list/root` | 插件配置卡片（现有 lan-proxy/idle-archive 那层） |
| `settings.general.item` | `list/root` | 通用 section 单行偏好 |

现有插件只到 `plugin.item`。**「独立 tab」= `settings.section`，hub 内无先例**，须随
M0 探针② 验证。

---

## 5.1 双端接线

**宿主端**：`installSettingsNamespace(ctx, "dsh-provider-usage", schema, entry, {
setSource, onChange })`（复用本插件 `shared/settings-namespace.js`，能力已在包内
未启用）。作用：让该 tab 能读写本插件配置（含 `adapters`），并让配置变更经
`onChange` 触发宿主侧热生效。

**客户端**：`slots.inject("settings.section", …)` 注册一条
`{ id: "dsh-provider-usage", order: <靠后位置>, label: "用量统计" }`，渲染
**React 页面组件**（React externals 路径 + `react-shim.d.ts`）。组件内部经注入面 /
`host.call` 拉取数据、读写配置。

---

## 5.2 页面内容（四区，与浮窗分层）

| 区 | 内容 |
| --- | --- |
| 总览 | 当前会话 provider 识别结果 + 生效适配器（id/label）+ 说明（复用同一 provider 解析，与浮窗一致） |
| 用量可视化 | 三窗口/多窗口完整图表 + 明细表格（窗口/当前%/限额/重置/趋势）；比浮窗迷你图更完整 |
| **适配器管理** | 按 provider 分组展示**候选列表**（内置 + 用户注入）：每条显示 `id`、`label`、来源文件、加载状态、`enabled` 标记；单选「启用」切换（走 `POST /adapters/select`）；失败/无启用给配置引导。**是「用户自定义 js」的可视化配置落点** |
| 配置编辑 | 本插件可配置键（baseUrl / limits / adapters 路径（含 `enabled`）/ 采样间隔等），读写经 settings 命名空间 + `normalizeConfig` 净化，保存即生效 |

---

## 5.3 与浮窗的关系（共享核心层）

- 独立 tab =「全局/设置视角」完整统计页；浮窗胶囊 =「当前会话视角」轻量悬浮。
- **二者共享同一套「provider 识别 + 适配器注册表 + 归一化数据」核心**，只呈现载体
  （设置页 React 组件 vs 浮窗组件 / DOM）不同。
- 实现时把核心收敛为可复用层，双端各消费，避免各写一份（否则 provider 解析、历史
  取数会在两处漂移）。

---

## 5.4 边界与兼容

- 纯增量：不依赖它，浮窗与旧行为照常；settings 服务缺失时该 tab 不注册
  （`installSettingsNamespace` 已降级处理），不影响浮窗。
- `settings.section` 为 `scope:"root"` list 条目，注册/卸载随纤维生命周期（沿用
  `ctx.effect` 的 disposer 约定）。
- 若走 slot 会话识别（D1），该 tab 与会话 provider 解析的验证一并归入 M0 探针②。
