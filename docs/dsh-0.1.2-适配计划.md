# dsh 0.1.2 适配计划（0.2.0 分支）

> 分支：`0.2.0`（基点 `main` v0.1.14 收官版 `fdf8f94`）
> 适配基线：上游 `dsh-v0.1.2-alpha.1`（2026-08-27，pre-release，未发 npm）→ 正式 `0.1.2`
> 相关 issue：#323（适配主线）· #366（通知中心）· #348（i18n）· #325（mcp-manager 观察）
> 更新规则：逐项完成打 `[x]`，勾选即视为已过对应验收。

---

## 基线事实

- 上游 dsh npm `latest` = `0.1.1-rc.2`（现 catalog 锁定基线）；`0.1.2` 尚未正式发 npm，alpha 线已到 `0.1.2-alpha.2`。
- 破坏性变更核心（#323 复核 `dsh-v0.1.1-rc.2 → dsh-v0.1.2-alpha.1`）：
  - `@deepseek-ai/dsh-client-runtime` 包删除（`ClientContext`/`createScope`/`SessionRuntime` 等迁移至 `dsh-api-session-controller/client` / `dsh-client-store` / `dsh-client-ui-renderer`）；
  - `@deepseek-ai/dsh-host-apiproxy` 包删除（`IApiClient`/`SessionsApi`/`session.models` 移除，传输层改 Typert Remote 网关 `ctx.remote`）；
  - `ctx.connection.api` 移除；`ctx.workspaces.openPath` 移除（→ `ctx.remote.session.openWorkspacePath`）；`session.models` RPC 移除（→ `ctx.remote.session.modelCatalog()` / `selectModel` / `modelSelection` 投影）。
- 本仓库结构：10 个包全部 `0.1.14`；catalog 类型层锁 `@deepseek-ai/*@0.1.1-rc.2`；`minimumReleaseAgeExclude` 同步维护。
- 兼容保留契约：cordis `apply(ctx)`/`inject`/`ctx.get`、插槽 `settings.section`/`settings.plugin.item`(keyed)/`shell.overlay`/`sidebar.footer.action`/`conversation.input.right`、host 面 `dsh-host-webserver`/`dsh-settings`/`dsh-skill`/`dsh-agent`/`dsh-tools`/`dsh-session`、`ctx.locale.register`。

---

## Phase 0 — 分支基建

- [x] 开 `0.2.0` 分支（独立 worktree `../dsh-hub-0.2.0`），基点 = main（v0.1.14 收官版）
- [x] 合入本地通知插件改动：`task/366-notify-center`（#366 通知中心化 M0/M1，5 提交，--no-ff，零冲突，+828/−93）
- [ ] 验证基线：worktree 内 `pnpm install && pnpm build && pnpm test`（重点 dsh-notifier / dsh-idle-archive）——确认 0.2.0 在 `0.1.1-rc.2` 下全绿，作为后续适配对照基线

## Phase 1 — 上游契约对齐（适配主线，对应 #323）

### 1.1 死引用清理（lan-proxy / mcp-manager / web-file-preview / idle-archive）
- [ ] 移除各包 `dsh.client.inject` 中 `@deepseek-ai/dsh-client-runtime` 死引用（软忽略但应清理）
- [ ] client 契约 smoke 断言补充/更新，确认注入意图失效已清

### 1.2 dsh-provider-usage（软破坏 · 必改）
- [ ] `src/client/core.ts` `connection?.api?.sessions?.models` → `ctx.remote.session`（`modelCatalog()` / `modelSelection` 投影 `lastUsed`/`next`/`default`），会话上溯（子代理 parentId）逻辑保留
- [ ] 类型面以 npm tarball lib diff 实证 `ctx.remote` 形态后再动手
- [ ] provider 检测恢复——胶囊不再回落「未识别/默认」；smoke 断言

### 1.3 dsh-web-file-preview（软破坏 · 必改）
- [ ] `src/client/wrapper.ts` openPath 包装 → `ctx.remote.session.openWorkspacePath`（`{path}` → `{opened}`），或确认接受降级
- [ ] 清理 `dsh.client.inject` 中 `dsh-client-runtime` 死引用
- [ ] 对话内文件链接点击预览（intercept → /api/fwp/）回归不破坏

### 1.4 dsh-idle-archive（自查）
- [ ] 核对 `src/client` import 面是否硬引用已删包（无则仅清理死引用）
- [ ] 若硬引用：迁移到 `dsh-client-store` / `dsh-client-ui-renderer` 等价面

### 1.5 dsh-lan-proxy（实测）
- [ ] 一次性 Token 鉴权 / webserver 原生 gzip 与独立端口 + 自签 TLS 转发交互实测
- [ ] 清理死引用；`crypto.randomUUID` polyfill 可留可删（幂等）

### 1.6 dsh-subagent-model-inherit（可选增强）
- [ ] 对照官方 `subagent-model-selection` 命名空间/卡片范式（`dsh-subagent` 的 `model-selection-settings`）评估合并/共存/维持（关联 #246）
- [ ] 输出决策结论

## Phase 2 — 通知中心续期（#366，可与 Phase 1 并行）

- [ ] M2：bark 频道 + severity→level 映射 + 投递状态面板（kindRoutes 例外行 UI）+ 凭据脱敏
- [ ] M3：127.0.0.1 独立端口入口 + per-caller token + 受限模型工具（默认关）+ webhook（默认关）
- [ ] 收尾：关闭 #366 跟踪 issue

## Phase 3 — 插件集 i18n（#348，需 approved 后启动）

> 红线：catalog 新增官方类型依赖（`dsh-client-locale`），方案获批（approved）前不实施；approved 永不代打。

- [ ] 前置：issue #348 由维护者亲手打 `approved`
- [ ] 6 个客户端包落地（idle-archive / lan-proxy / mcp-manager / notifier / provider-usage / web-file-preview）：
  - `src/client/locales.ts`（zh 为 key 源 + `en satisfies keyof typeof zh` 锁双语平衡）
  - `declare module` 合并 `LocaleNamespaceMap`（每插件一 ns）
  - `inject` 加 `'locale'`；`ctx.effect(() => ctx.locale.register(NS, {zh,en}))`
  - React slots 走 props `{t}` + `locale: NS` + label thunk；原生 DOM 走 `ctx.locale.bind(NS)` + subscribe 按 revision 重绘
- [ ] notifier 边界：通知类型 kind 走客户端字典、动态数据原样；`toast.ps1` 固定文案保留并文档明示

## Phase 4 — 版本对齐与全量回归（硬依赖：上游 0.1.2 正式发 npm）

- [ ] 上游 0.1.2 发布后：catalog `@deepseek-ai/*` 全量 bump + `minimumReleaseAgeExclude` 同步
- [ ] 全量门禁：`pnpm build && pnpm test && pnpm contract && pnpm pack:check` + cov/crap 观察
- [ ] 隔离浏览器实测（dsh-verify-isolated）：全插件 + 窄屏 iPad/iOS 移动端

## Phase 5 — 发版（v0.2.0）

- [ ] 全包版本升 0.2.0（推 `v0.2.0` tag 触发发布管线，不绕过 tag 校验）
- [ ] release-notes `docs/release-notes/v0.2.0.md`（中英分节 + 双锚补位）
- [ ] 0.2.0 独立演进，Phase 1/2 改动不回灌 main（0.1.x 线冻结）

---

## 附：待观察 / 挂起项（非本计划阻塞）

- #325（mcp-manager 方案 B 观察，触发条件未满足）
- #213/#214（provider-usage，on-hold）
- #350（web-file-preview 评审遗留）、#246（subagent-model-inherit 评审遗留）
- #159（loop 工作流持续改进，长开）
