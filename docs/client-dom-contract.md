# Hub 客户端 DOM 契约（client-dom-contract）

同一页面跑着宿主 + 自家插件 + 第三方插件。任何一个插件留下的“全局可观测状态”，都会被其它代码解读。本契约只约束一件事：**别留过期、别吞别人的事件、别抢不属于你的层**。

起因：MCP 弹窗关闭后只 hidden 不摘 `aria-modal`，第三方手势层的裸存在检查永久误判，左右滑手势全死（2.4.x 起潜伏，见 #947）。

> 证据分级：本包 `src` 内已实测；宿主与第三方行为标为未验证，验收靠隔离浏览器三动作闭环，不当事实引用。

---

## R1 状态同翻

**规则**：凡第三方可能解读为“我独占屏幕”的标记（`aria-modal`、`aria-expanded`、`documentElement` data、`body` class、滚动锁），**必须与 state 开关在同一函数同一同步块内翻转**，不经过动画定时器、样式回调、异步完成。

- 正例：`close()` 里 `state.open=false` 的下一行就 `removeAttribute("aria-modal")`；`showPanel()` 打开路径重加。`close→300ms` 内重开的竞态天然一致。
- 反例：只在 300ms 动画 `finish()` 里摘标记——动画被打断/定时器漂移时标记与状态永久错位。
- 单点写入：同一标记的 set/remove 各一处配对，两处写同一值会漂移（MCP 面板 `aria-modal` 只在 `showPanel()` 公共路径设、`close()` 同步摘，创建块内不写）。

## R2 常驻壳无标记

**规则**：hide 不卸载的常驻壳，关闭态不得带任何“活跃”语义标记。

- 理由：hidden 不等于不存在——`querySelector` 照命中。用 `removeAttribute` 而非置 `"false"`：裸 `[aria-modal]` 存在检查仍命中 `"false"`，且关闭态留 `"false"` 语义错误（注：`[aria-modal=true]` 精确匹配不命中 `"false"`，但本条守的是更严的存在检查）。
- 正例：notifier toast 用完即 `.remove()`；自家 overlay 关态三件套 opacity 0 + visibility hidden + pointer-events none，外加 `[hidden]{display:none!important}`（已防掉 UA-vs-author 特异性陷阱）。
- 反例：`panel.ts` 创建时一次性写入 `aria-modal`，`close()` 只 hidden。
- 允许保留：`role="dialog"`（静态语义；hidden 子树 AT-irrelevant）。残留风险：若第三方存在裸 `[role=dialog]` 存在检查则同类复现——本包内无此类消费者（已查本包 `src`），宿主与第三方全量未知，记为残留风险由上游防御兜底。

## R3 命名空间

**规则**：类/data-* 一律包前缀（dm- 已有，保持）；**不写裸宿主元素/哈希类选择器**，只走 slot API。

- 反例：靠 `[class*="_titleCluster"]` 这类哈希子串命中宿主 DOM——宿主一升级就漂移（第三方已踩坑，不要学）。

## R4 事件纪律

**规则**：document/window 监听只读不吞——不得对自身子树之外的目标 `stopPropagation`/`preventDefault`（本包 `src` 内实测零违规，保持）；具名函数 + disposer 配对摘除。

- 范本：panel C4（WeakMap 登记 + disposePanel）、float.ts 返还的 disposer（focusout/keydown/observer/rAF 全摘，index.ts 统一调用）、notifier 首击监听一次即自摘。
- float dispose 配对已证实存在，R4 无需“补”，只需保持。
- 新增：共享键（Esc）处理前检查 `event.defaultPrevented`，已被处理就让位，多弹窗可组合（#947 本 issue 内实施：panel 与 float 两处 Esc 均加前置）。

## R5 层叠预算

**规则**：fixed 层必须声明 z-index 并走可配置基准（mcp 默认 10 / usage 默认 40 已有）；**不可见即不可点**——opacity:0 必须配 pointer-events:none + visibility:hidden（opacity 0 照样命中点击测试）。

- 已知他方数值（待补来源：宿主版本 + 文件行或实测截图，未验证前不得当事实引用）：宿主抽屉列 1300、宿主菜单 1100、第三方删除卡 1400/1401。
- 待收敛（本次不动）：overlay/toast 的 9999/10000 硬编码收进“基准+偏移”（`DEVELOPMENT §7` 明确模态 overlay 不占 `zIndexBase` 预算，本次不改数值）。

## R6 焦点与 Esc

**规则**：**必须 = 关还焦**（把焦点还给打开者，便宜且安全）；**进焦 = 可选**，做了就聚焦非文本控件（关闭按钮），否则手机端唤起虚拟键盘+布局跳动。

- 实施（#947 本 issue 内，长期方案）：`showPanel()` 记录 `document.activeElement`（仅 HTMLElement），`close()` 同步恢复（`isConnected` 守卫 + `preventScroll` + try/catch 只 warn 不抛）；`panelOpener` 收进 `McpState` 随 `createState` 生命周期重置。进焦不做。
- Esc：只处理自己 open 时（已有 `state.open`/`state.floatOpen` 门控）+ 先查 defaultPrevented（见 R4）。

## R7 新 UI 检查单

提 PR 前全局搜：`aria-` / `role=` / `appendChild(document.body)` / `position:fixed` / `body.style` / `documentElement.setAttribute`，逐条回答“关掉后还剩什么”。

## R8 HMR/重复 apply 安全

**规则**：state 重置 + DOM 移除 + 监听摘除三件套必须配对，写进同一 disposer（index.ts 现实已做到：disposePanel + overlay.remove() + 重置 state，抄它）。

---

## 机审建议（可选后续，不阻塞本 issue）

参照 verify-coverage-scope.mjs 加小 gate：同包内原生 `setAttribute("aria-modal"` 字符串字面量必须有配对的 `removeAttribute`，否则判红。范围限定原生字面量（天然排除 React 受控 `aria-expanded`），先定 scope 再做。
