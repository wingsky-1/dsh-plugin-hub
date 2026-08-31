# dsh 0.1.2 适配计划（0.2.0 分支）

> 分支：`0.2.0`（基点 `main` v0.1.14 收官版 `fdf8f94`）
> 适配基线：上游 `dsh-v0.1.2-alpha.2`（2026-08-31 确认：**最终目标即 alpha.2**，npm 已发布 `0.1.2-alpha.2`，官方依赖面全量 `^0.1.2-alpha.2`）
> 相关 issue：#323（适配主线）· #366（通知中心，暂缓）· #348（i18n）· #325（mcp-manager 观察）
> 更新规则：逐项完成打 `[x]`，勾选即视为已过对应验收。

> **维护者指示（2026-08-31）**：① 最终目标 = **完成 0.1.2-alpha.2 适配**（不设正式版前置）；② Phase 2（通知中心 M2/M3）暂缓，聚焦适配；③ Phase 5（发版）等维护者全量验证后执行。

---

## 评审结论（独立子 agent 对抗性评审，2026-08-31）

> **总体判定：需修订后实施。** 方向正确、基线事实大体属实；但 Phase 1.2 存在真实语义错误（modelSelection 投影字段 / modelCatalog 返回形态 / ctx.remote 依赖面），1.1 清理清单有遗漏，Phase 2/3 有重复造轮子与并行冲突风险。本文件已按 P0/P1 全部修订。

- **P0 修订**：
  1. 1.2 检测逻辑重写：per-session `modelSelection` 投影（`lastUsed`/`next`）为主判据、`modelCatalog().default` 仅兜底（`default` 属目录而非投影，见 api-session-controller `types.d.ts:79-126`）；上溯逻辑需适配「投影按会话取 / 目录全局取」两种数据面，不能只换函数名。
  2. 1.2 补 `ctx.remote` 依赖面：客户端取 `ctx.remote` 须 inject `@deepseek-ai/dsh-api-gateway/client`（其自身 inject typert-registry + client-connection）；`RemoteResult` 解包 + `isRemoteFailure` 错误判别（api-gateway `client/index.d.ts`）。
  3. 1.1 清单补全：**notifier、provider-usage 两包 inject 也含 `dsh-client-runtime`**（实测 6 包；#323 称 notifier `inject:[]` 与仓库实际不符）——逐包核对 package.json，不照抄 #323。
  4. 1.3 补降级机制：官方 `canOpenWorkspacePath()` 探测 + `openWorkspacePath` 的 RemoteError / signal 错误面处理（`types.d.ts:326-335`）。
  5. Phase 3 先核 t seat 真实机制：ui-slots `slots.register` 的 locale 参数 vs 官方 `ctx.slots.installLocale`，确认后再设计双通道，避免白做。
- **P1 修订**：
  - alpha.1→alpha.2 之间 locale 客户端面从无到有，正式 0.1.2 仍可能再破坏——1.2/1.3 **逻辑重设计先行**，函数名级改动等正式版再定。
  - M3 自建 webhook 与官方 `dsh-webhook`/`dsh-webhook-github` 重复——**先评估复用**再定自建（0.1.2-alpha.2 deps 已确认官方包存在）。
  - 性能：全量 `modelCatalog()` 数据面大于原 per-session 查询，**投影优先**。
  - M2/M3 与 i18n 同改 notifier 客户端，并行冲突放大——**串行或明确文件边界**。
  - alpha.2 框架版本变动（cordis ^4.0.2 / schemastery ^3.18.2）——计划补 **S1 框架稳定性核对**项。

---

## 基线事实

- 上游 dsh npm `latest` = `0.1.1-rc.2`（现 catalog 锁定基线）；`0.1.2` 尚未正式发 npm，alpha 线已到 `0.1.2-alpha.2`（tags：`dsh-v0.1.2-alpha.1` / `dsh-v0.1.2-alpha.2` 均已存在）。
- 破坏性变更核心（#323 复核 `dsh-v0.1.1-rc.2 → dsh-v0.1.2-alpha.1`，评审已对照上游源码确认）：
  - `@deepseek-ai/dsh-client-runtime` 包删除（`ClientContext`/`createScope`/`SessionRuntime` 等迁移至 `dsh-api-session-controller/client` / `dsh-client-store` / `dsh-client-ui-renderer`）；
  - `@deepseek-ai/dsh-host-apiproxy` 包删除（`IApiClient`/`SessionsApi`/`session.models` 移除，传输层改 Typert Remote 网关 `ctx.remote`）；
  - `ctx.connection.api` 移除；`ctx.workspaces.openPath` 移除（→ `ctx.remote.session.openWorkspacePath`）；`session.models` RPC 移除（→ `ctx.remote.session.modelCatalog()` / `modelSelection` 投影）。
- 本仓库结构：10 个包全部 `0.1.14`；catalog 类型层锁 `@deepseek-ai/*@0.1.1-rc.2`；`minimumReleaseAgeExclude` 同步维护。
- 兼容保留契约：cordis `apply(ctx)`/`inject`/`ctx.get`、插槽 `settings.section`/`settings.plugin.item`(keyed)/`shell.overlay`/`sidebar.footer.action`/`conversation.input.right`、host 面 `dsh-host-webserver`/`dsh-settings`/`dsh-skill`/`dsh-agent`/`dsh-tools`/`dsh-session`、`ctx.locale.register`。

---

## Phase 0 — 分支基建

- [x] 开 `0.2.0` 分支（独立 worktree `../dsh-hub-0.2.0`），基点 = main（v0.1.14 收官版）
- [x] 合入本地通知插件改动：`task/366-notify-center`（#366 通知中心化 M0/M1，5 提交，--no-ff，零冲突，+828/−93）
- [x] 验证基线：worktree 内 `pnpm install && pnpm build && pnpm test` 已跑——0.2.0 在 `0.1.1-rc.2` 下**全包构建成功、测试全绿**（含 dsh-notifier / dsh-idle-archive），作为后续适配对照基线

## Phase 1 — 上游契约对齐（适配主线，对应 #323）

### 1.1 死引用清理（**6 包**：lan-proxy / mcp-manager / web-file-preview / idle-archive / notifier / provider-usage）
> 评审 P0-3：逐包核对 package.json（实测 6 包 inject 均含 `dsh-client-runtime`，**不照抄 #323**——其称 notifier `inject:[]` 与仓库实际不符）。
- [x] 逐包核对并移除 `dsh.client.inject` 中 `@deepseek-ai/dsh-client-runtime` 死引用（实测 6 包：lan-proxy / mcp-manager / web-file-preview / idle-archive / notifier / provider-usage；各包 client 均无实际 import，属软忽略清理；已实证）
- [x] client 契约 smoke 断言核对——契约门禁仅断言 `dsh.client ⇒ exports["./client"]` 联动、不校验 inject 具体内容，清理后 6 包 build + smoke 全绿（2026-08-31）

### 1.2 dsh-provider-usage（软破坏 · 必改 · 逻辑重设计）
> 评审 P0-1/P0-2：`default` 属 `ModelCatalog` 而非投影；`modelCatalog()` 返回 `RemoteResult` 需解包、无参全量目录（per-session 语义已不存在）；`ctx.remote` 依赖面须补。
> 实施（2026-08-31）：上游 alpha.2 实测确认——**per-session `modelSelection` 投影就在 `ctx.sessions.list` 快照行**（`byId[sid].projections.values.modelSelection.lastUsed/next`），主判据无需 Remote；`modelCatalog().default` 仅在全链投影缺失时兜底。
- [x] **逻辑重设计**：`resolveProviderFromSession` 改为投影优先——沿 parentId 上溯链逐会话读 `modelSelection`（lastUsed 优先、next 次之），首个非空者胜；全链缺失兜底 `ctx.remote.session.modelCatalog()` 的 `default`（RemoteResult 解包）。上游实测：投影按会话取（lastUsed/next 字段，`model-selection-projection.ts`）、目录全局取（`ModelCatalog.default`，`types.ts:140-146`）
- [x] 依赖面：客户端 `connection` 体面废弃 → `remote = ctx.get("remote")`（上游 api-gateway `apply` 提供 `ctx.remote`，inject 面 `/client` 依赖 typert-protocol + client-connection）；`RemoteResult={ok,value}|{ok,error}`（`typert/protocol/src/types.ts:74-76`）
- [x] 单测适配：`unit-detect.test.ts` 的 `makeConnection`（`connection.api.sessions.models`）→ 行投影 fake + `makeRemote` modelCatalog 兜底；worker 剧本 `client-revalidate.worker.mjs` 改 `projectionBySession`；`currentProvideInfo` 分支移除（上游已无此服务）
- [x] 类型面实证：上游 `dsh-v0.1.2-alpha.2` 源码（`/tmp/dsh-harness-src`）逐项核对后实施
- [x] provider 检测恢复——unit-detect 投影面 10 组断言 + worker 场景 1-5 + smoke 全绿（0.1.2-alpha.2 语义）

### 1.3 dsh-web-file-preview（软破坏 · 必改 · 补降级）
> 评审 P0-4：`openWorkspacePath({path})→{opened:true}` 属实，但漏 `canOpenWorkspacePath()` 探测与 RemoteError/signal 错误面。
> 实施（2026-08-31）：上游 alpha.2 实测确认——对话 `openFile()` 统一经 `ctx.remote.session.openWorkspacePath({path})`（ui-chat `apply.ts:120-126`），调用方检查 `result.ok`。
- [x] `src/client/wrapper.ts` openPath 包装 → `ctx.remote.session.openWorkspacePath`（命中预览分组 → 返回 `{ok:true,value:{opened:false}}` 不触底原生；否则放行原方法）；**RemoteError/signal 面由调用方处理、原样透传**（上游调用方检查 `result.ok`，错误语义自然保留）
- [x] 降级说明：`openWorkspacePath` 缺失 → 包装整体跳过（防御式，与旧无 `workspaces.openPath` 时行为一致）；上游 `canOpenWorkspacePath()` 为宿主能力探测（types.d.ts:326-335 证实），客户端拦截不依赖它——已有能力探测由上游调用方使用
- [x] 清理 `dsh.client.inject` 中 `dsh-client-runtime` 死引用（已在 1.1 完成）
- [x] 对话内文件链接点击预览（intercept → /api/fwp/）回归不破坏（smoke 契约断言 + 全测试绿）

### 1.4 dsh-idle-archive（自查）
- [x] 核对 `src/client` import 面——**无任何 `@deepseek-ai` 运行时 import**（评审实证），仅需清理死引用
- [x] 清理 `dsh.client.inject` 中 `dsh-client-runtime` 死引用（已在 1.1 完成，2026-08-31）

### 1.5 dsh-lan-proxy（实测）
> 评审：token 鉴权交互只能实测，静态无法判定。
- [ ] 一次性 Token 鉴权 / webserver 原生 gzip 与独立端口 + 自签 TLS 转发交互实测（需隔离环境，归入 Phase 5 前检查）
- [x] 清理死引用（已在 1.1 完成）；`crypto.randomUUID` polyfill 可留可删（幂等）

### 1.6 dsh-subagent-model-inherit（评估结论）
> 评审：上游源码已 clone 但 `model-selection-settings` 未核，实施前补核官方 `dsh-subagent` 命名空间/卡片范式。
> 结论（2026-08-31，对照 dsh-v0.1.2-alpha.2 源码）：**官方已原生吸收本插件核心能力，本包在 0.2.0 线维持现状即可（不升级、不转聚合），标记「被上游 0.1.2 吸收」。**
- [x] 补核官方 `model-selection-settings`：`enabled + allowedModels` 白名单、默认关（`tool-subagent/src/model-selection-settings.ts`）——这是**独立的新能力**（受限模型路由控制），与「继承父模型」不同目标
- [x] **两处断裂点 alpha.2 已原生修复**（实证）：
  - `AgentOptions` 已含 `reasoningEffort`（`core/agent/src/runtime-types.ts:31`）；
  - 官方 `parentAgentOptionsForDelegation` + `resolveChildAgentOptions`（`subagent/src/child-agent.ts:68-119`）子创建即继承父 provider/model/reasoningEffort/maxTokens，真实接入 `continuation.ts:421` 与 `subagent-in-process-driver/index.ts:137`；官方 `installModelSelection`（`core/agent/src/model-selection.ts`）与本插件 `injectSelection` 的 waterfall 语义同构
- [x] **决策结论**：本包是 demo 演进包（README 已声明 standalone 观察期、不进聚合包）——0.2.0 线**维持现状、不升级能力、不转聚合**；与官方 `subagent-model-selection` 无冲突（目标不同），无需合并；README 增补「alpha.2 起官方已原生支持，本包为 0.1.x 线兼容保留」说明
- [x] 输出决策结论（见上；本包 host 面用 `dsh-agent`/`dsh-llm`/`dsh-session` 均保留，**0.1.2 兼容无需改码**）

## Phase 2 — 通知中心续期（#366）

> **维护者指示（2026-08-31）：本阶段暂缓，不做——当前聚焦适配**（Phase 1 契约对齐优先）。原 M2/M3 工作项保留待命，待适配完成后另行排期。
> 原备注（评审 P1）：M2/M3 与 i18n 同改 notifier 客户端，并行冲突放大——后续如重启建议串行或明确文件边界；M3 自建 webhook 与官方 `dsh-webhook`/`dsh-webhook-github` 重复——先评估官方包复用再定自建。

- [ ] M2：bark 频道 + severity→level 映射 + 投递状态面板（kindRoutes 例外行 UI）+ 凭据脱敏（**暂缓**）
- [ ] M3 前置：评估官方 `dsh-webhook`/`dsh-webhook-github`（0.1.2-alpha.2 deps 已确认存在）复用可行性 → 决策自建/复用（**暂缓**）
- [ ] M3：127.0.0.1 独立端口入口 + per-caller token + 受限模型工具（默认关）+ webhook（默认关，按上项决策）（**暂缓**）
- [ ] 收尾：关闭 #366 跟踪 issue（**暂缓**）

## Phase 3 — 插件集 i18n（#348，维护者已口头授权 2026-08-31，待补 approved 标签后动 catalog）

> 红线：catalog 新增官方类型依赖（`dsh-client-locale`），方案获批（approved）前不实施；approved 永不代打。
> 评审 P0-5：实施前**先核 t seat 真实机制**——ui-slots `slots.register` 的 locale 参数 vs 官方 `ctx.slots.installLocale`，确认后再定双通道设计，避免白做。

- [x] 前置：issue #348 由维护者亲手打 `approved`（**已留痕维护者口头授权** issue-comment-5474320874；approved 标签仍待补）
- [x] **机制核实（评审 P0-5，对照官方样板 `ui-settings-plugin-inventory`，2026-08-31）**：
  - 官方 t seat = **`slots.register({..., locale: NS}, Component)`** 注入类型化 `t`（`PluginInventorySettingsTabProps` 用 `PropsLocale<'settings.pluginInventory'>` + `{t}` 消费）——**非** `ctx.slots.installLocale`（alpha.2 无此独立 API），「双通道」设计成立；
  - `LocaleNamespaceMap` 在 `@deepseek-ai/dsh-client-ui-slots` 声明合并（样板 `index.ts:18-27`）；`ctx.effect(() => ctx.locale.register(NS, {zh,en}))`；
  - 原生 DOM 场景用 `ctx.locale.bind(NS)` 显式绑定（样板 `index.ts:46` `presetName` 用例）。
- [ ] 6 个客户端包落地（idle-archive / lan-proxy / mcp-manager / notifier / provider-usage / web-file-preview）：
  - `src/client/locales.ts`（zh 为 key 源 + `en satisfies keyof typeof zh` 锁双语平衡）
  - `declare module` 合并 `LocaleNamespaceMap`（每插件一 ns，于 `@deepseek-ai/dsh-client-ui-slots`）
  - `inject` 加 `'locale'`；`ctx.effect(() => ctx.locale.register(NS, {zh,en}))`
  - React slots 走 props `{t}` + `slots.register({locale: NS})` + label thunk；原生 DOM 走 `ctx.locale.bind(NS)` + subscribe 按 revision 重绘（机制已核实）
- [ ] notifier 边界：通知类型 kind 走客户端字典、动态数据原样；`toast.ps1` 固定文案保留并文档明示

## Phase 4 — 版本对齐与全量回归（目标：上游 0.1.2-alpha.2，已完成）

> 评审 P1：alpha.2 框架版本变动（cordis ^4.0.2 / schemastery ^3.18.2）——**先补 S1 框架稳定性核对**再全量 bump。
> 实施（2026-08-31）：catalog 全量 bump 到 **0.1.2-alpha.2**，全门禁通过。

- [x] **S1 框架稳定性核对**（npm pack lib diff 实证）：cordis 4.0.1→4.0.2 **lib 字节一致零破坏**；schemastery 3.18.0→3.18.2 lib 字节一致（注意：裸 `schemastery` npm 最新仍 3.18.0，`3.18.2` 是 `@deepseek-ai/schemastery` scoped 包——本仓库依赖裸包，保持 `^3.18.0` 不升）
- [x] 上游 0.1.2-alpha.2 发布后：catalog `@deepseek-ai/*` 全量 bump（cordis 4.0.2 + 9 类型层包 0.1.2-alpha.2）+ `minimumReleaseAgeExclude` 同步（pnpm install 自动补 8 条）
- [x] 全量门禁（alpha.2 类型层）：`pnpm build` 10 包全过、`pnpm test` 全绿、`pnpm contract` 客户端契约 6 包全过、`pnpm pack:check` 全过（2026-08-31）
- [ ] 隔离浏览器实测（dsh-verify-isolated）：全插件 + 窄屏 iPad/iOS 移动端（待维护者本地验证，归入 Phase 5 前检查）

## Phase 5 — 发版（v0.2.0）

> **维护者指示（2026-08-31）：本阶段等维护者全量验证完成后执行**，时间由维护者决定，不预设排期。

- [ ] 全包版本升 0.2.0（推 `v0.2.0` tag 触发发布管线，不绕过 tag 校验）（**待维护者全量验证后执行**）
- [ ] release-notes `docs/release-notes/v0.2.0.md`（中英分节 + 双锚补位）（**待维护者全量验证后执行**）
- [ ] 0.2.0 独立演进，Phase 1 适配改动不回灌 main（0.1.x 线冻结）

---

## 附：待观察 / 挂起项（非本计划阻塞）

- #325（mcp-manager 方案 B 观察，触发条件未满足）
- #213/#214（provider-usage，on-hold）
- #350（web-file-preview 评审遗留）、#246（subagent-model-inherit 评审遗留）
- #159（loop 工作流持续改进，长开）
