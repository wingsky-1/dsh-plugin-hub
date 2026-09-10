# dsh 0.1.5-rc.1 适配计划（#695）

> 关联 issue：[#695](https://github.com/wingsky-1/dsh-plugin-hub/issues/695)
> 适配基线：上游 `dsh-v0.1.5-rc.1`（`npm view @deepseek-ai/dsh dist-tags` 的 `latest` 与 `next` 同指；本机 CLI 已为该版本）
> 起始 commit：`4d961ea`
> 更新规则：逐项完成打 `[x]`。**发版（版本号对齐 + release-notes）属仓库红线，由维护者确认后另开 `chore(release):` PR**，不在本计划内。

---

## 一、背景

`pnpm-workspace.yaml` 的 catalog 与各包 `peerDependencies` 长期锁 `0.1.2-rc.1`，而运行中的 `dsh` CLI 已是 `0.1.5-rc.1`——**发布物与宿主运行时已不匹配，落后三个 rc**。本计划把适配基线收敛到 `0.1.5-rc.1`。

## 二、上游破坏性变更（实测 `lib/` 逐包 diff + 官方 release notes）

| 包 | 变更 | 触达本仓 |
|---|---|---|
| `dsh-session` | **删除 `assistant/chunk` 事件**；新增 `assistant/attempt`；`assistant/message` 增内嵌 `stream`；`SESSION_FORMAT_VERSION` 0→3；删 `chunk-rows` 子路径导出；`Session.fromRestore` 增第 5 参；`EpochHeader.system` 删除 | **provider-usage**（采集主信号） |
| `dsh-system-prompt` | `SECTION_ORDERS` 重排（`HARNESS_SOURCE` -900→10000、`WEB_SURFACE` -800→10100、`PERSONA` 拆 PREFIX 0 / SUFFIX 10200）；`PERSONA_SECTION`→`PERSONA_PREFIX_SECTION`；Config `persona`→`personaPrefix` | **mcp-manager**（分节 order 语义复核） |
| `dsh-tools` | `tool/code-dispatch(-start)` → `tool/ptc-dispatch(-start)` | 无 |
| `dsh-agent` | 删 `ctx.agent`、`InboxNotifications`；`AgentSetup` 加参；`Inbox` 变 type-only；新增 `agent/assistant-stream` | 无 |
| `dsh-llm` | 纯追加（`assistant-stream`、`FileBlock` 等） | 无 |
| `dsh-client-connection` | 删 `FetchHandler`；`ConnectionConfig`→`ConnectionRecoveryConfig`；`ConnectionFetchRoute` 增必填 `requestBody` | 无（`authenticatedUrl` 两版一致） |
| `dsh-host-webserver` / `dsh-session-title` / `dsh-user-approval` / `dsh-settings` / `dsh-client-store` / `dsh-skill-filesystem` | **lib 零差异** | 安全 |

**不适用项**：官方 `conversation` Slot 迁移为 `main` 的 key——本仓插件只注册 `settings.plugin.item` / `settings.section`，两者在新版仍有定义与消费者；会话日志 V3 迁移——本仓插件读写的是**自建** jsonl，不读 DSH 会话日志。

## 三、记账口径决策（维护者已拍板）

provider-usage 迁移后 `calls`/token 口径**与 0.1.2 零变化**（无损迁移）：

- **Q1** 有 usage 的失败/重试 attempt → **计入**（0.1.2 本来就计入；实测 42 份真实会话日志中 2 条 attempt 有 1 条带 usage，丢弃即丢真实计费 token）
- **Q2** 无 usage 的 attempt → **不计入**（无调用证据，避免 calls 虚高）
- **Q3** `TREND_ROW_VERSION` → **不递增**（递增会在载入时静默丢弃全部历史，且无迁移路径）

## 四、实施批次

### PR-A 机制前置（commit `323bdcf`）

- [x] catalog 补 3 个缺口包：`dsh-settings` / `dsh-skill-filesystem` / `dsh-client-connection`
- [x] 20 处官方 peer 字面版本 → `catalog:`（版本事实源收敛为 catalog 一处；`pnpm pack` 自动替换回具体版本，已实测发布物字节等价）
- [x] 新增 `scripts/lib/catalog-peers-lib.ts` 一致性门禁（peer/devDeps 必须 `catalog:`、`catalog:` 引用必须有条目、catalog 键必须登记豁免清单）+ 6 条单测 + 接入 `contract-check`
- [x] 全量门禁通过（build / test / contract / pack:check / typecheck）

### PR-B 版本跃迁 + 插件适配（本 PR）

- [x] catalog 15 键 → `0.1.5-rc.1`（cordis `4.0.2` 不动）+ `minimumReleaseAgeExclude` 同步 + lock 重生成
- [x] **provider-usage**：`assistant/chunk` → 结算事件（`assistant/message.usage ?? stream 内裸 usage chunk`，`assistant/attempt` 兜底）；`retry` 改为同 `(turn, step)` 的**结算序数**；删除 `fold`/`headerSeen`/`TREND_FOLD_TTL_MS`（发布导出面变更）
- [x] provider-usage 测试改造：unit-trend / unit-trend-ledger / unit-report / smoke 全部随迁（含语义反转用例重设计 + Q1/Q2 新增用例）
- [x] **mcp-manager**：`section({ order })` 具名常量化 + 分节顺序断言（`order` 在官方 `DEPLOYMENT_PERSONA_PREFIX(0)` 与 `PLAN_POLICY(500)` 之间，该相对位置两版一致）
- [x] 文档锚定 4 处（`README.md` / `README.en.md` / `AGENTS.md` / `docs/DEVELOPMENT.md`）
- [x] 全量门禁通过

## 五、复核发现与处置

| 发现 | 处置 |
|---|---|
| `dsh-llm` 的 `.d.ts` 引用 `@deepseek-ai/dsh-attachment`，但该包未列入 `dsh-llm` 自身 `dependencies`（上游漏声明） | **不 workaround**：当前被 `skipLibCheck: true` 掩盖且本仓不使用相关 API；加 devDep 会在上游修复后变僵尸依赖 |
| `docs:check` 不校验版本一致性（catalog 已 0.1.5 而 README 仍 0.1.2 时仍 PASS） | 记为改进项，纳入 #690 的文档漂移门禁讨论 |
| `data-pane="conversation"` 为**两版均失效**的死降级分支 | 记为清理项（非升级回归） |
| 官方新增 rightbar 布局，浮动胶囊按 `[data-conversation-scroll].rect.right` 定位 | 需隔离环境视觉复核（见验收） |

## 六、验收

- [x] `pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck` 全绿
- [ ] 隔离环境（`dsh-verify-isolated`）真实会话实测：用量记账数值与旧版对拍（calls / retry / token 三元组）、MCP 目录注入、通知链路
- [ ] 浏览器实测 5 个客户端插件渲染 + 窄屏/双主题 + 新 rightbar 布局下浮动胶囊落点
- [ ] 发版 PR（版本号对齐 + `docs/release-notes/`）——维护者确认版本号后另开

## 七、本轮不做

- #690 四阶段（`deps.ts` / `--graph` / ESLint zones）
- 「插件 ↔ 官方契约」对外防腐层（已作为 #690 增量补充记录，待 notifier 重构后统一承载）
- `sidebar.panellist` / `main` 新面板 API 迁移
