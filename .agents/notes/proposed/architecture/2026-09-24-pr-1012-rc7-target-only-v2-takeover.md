# Agent Note: PR #1012 rc.7 target-only v2.1 接手计划

Status: proposed

## Problem

PR #1012 当前 head ddd3719a9e2da03c7b95f363441674f999aa2a44 的机械门禁已经全绿，但目标版本行为仍有确定性缺口。当前 PR 同时混合了 rc.7 适配、旧 runtime 兼容叙事、业务层升级读取和大量门禁基线同步，导致“门禁通过”与“目标功能可用”分离。

已核对基线：

- PR base: 54abf76bc9a1505937688bde7ed9292e286f5d95
- 上一轮评审 head: e4d7bf47d0c16f4d4b868918c57276c88c5e1f07
- 当前 head: ddd3719a9e2da03c7b95f363441674f999aa2a44
- 目标运行时: dsh 0.1.7-rc.1（catalog 锁定）
- 改动规模: 79 个文件，+3614/-1390
- 接手 worktree: /mnt/ssd/worktree/dsh-plugin-hub-pr-1012-v2

本轮已在隔离 worktree 实测：

- pnpm gate:pr: exit 0
- pnpm gate:full: exit 0（清理本轮临时 /tmp/node_modules 污染后重跑）
- gh pr checks 1012: exit 0
- pnpm --filter @wingsky-1/dsh-verify-isolated test: exit 0
- rc.7 SlotCore: settings.plugin.item 注册失败；plugins.bundle.config / plugins.row.config 可注册
- rc.7 V4 admission: kind: "plugin" 被拒绝；kind: "plugin:@wingsky-1/dsh-mcp-manager" 可通过
- notifier 当前 readLegacySettings: 只有 settings.yaml.imported 时返回空对象
- decision 排队取消: abort 后仍 pending，释放槽位后才返回 ABORTED
- worktree serial: listener 返回时工具数为 0，约 40ms 后为 3

## Execution progress (2026-09-24)

- Phase 1A lan：已完成 `plugins.row.config` + `configForms.whileServed()` 迁移、canonical `@wingsky-1/dsh-lan-proxy#ui-dsh-lan-proxy`、summary/page DOM 分支、disposer 生命周期与双恢复路径告警；主控独立验证 typecheck/build/test 均 exit 0（15 files / 1050 tests），`stryker:check` exit 0。
- Phase 1B mcp：已完成 client row/page 迁移；host 与 client 统一使用 `MCP_MANAGER_IDENTITY`，settings namespace 为 `ui-dsh-mcp-manager`，Config 仅 `ui` child volatile；主控独立验证 typecheck/build/test 均 exit 0（50 files / 1455 tests），修复后红队确认 namespace 阻断已解除。
- lan 行为测试已从 `test/client` 移入 `test/client-unit/client-entry.test.ts`，同步 `--min`、mutation topology 与派生配置；不新增 exemption。
- lan 用户可见旧路径 banner/error hint 已改为 Plugin Manager row detail，并保留 `settings.yaml` 与 `ssh -L` 旁路。
- mcp identity 测试硬化已完成：host facts 独立于 watched namespace，e2e 改为稳定 package/row/slot 片段，旧 hotspot fixture 改用 canonical identity；最终 mcp e2e 141/141、全包 1455/1455、lan 全包 1050/1050，diff-check exit 0。
- Phase 1 已收口：lan/mcp 双包与 mutation 分层红队均通过。
- Phase 2 已完成：notifier legacy-source + 整链单次 version commit、lan legacy-settings + apply 接入、MCP V4 catalog-writer + maintenance/reopen fixture；主控复验 notifier 79 files/1231 passed/1 skipped、lan 16 files/1073 passed、maintenance 14 tests/13 pass/1 skipped，typecheck/build/diff-check exit 0。
- Phase 3 已完成：decision semaphore 预取消/排队摘除且 guard 后副作用入槽，focused 23/23、typecheck/build、全包 23 files/291 tests；worktree agent/created serial Promise 全链，focused 77/77、typecheck/build、全包 21 files/333 tests；两包 diff-check exit 0。
- Phase 4 已完成：verify-isolated 删除 ui-onboarding fallback、目标 namespace/version 双事实缺失即不预置并由 browser-driver overlay 兜底；keep-mounted 测试迁至 client-unit、mcp/shared 真实行为断言与 derived configs 同步；mutation/dir-import 事实源收口；SECURITY/README/skill/manual 文档同步。主控复验 verify-isolated 333/333、worktree-sidebar 21 files/333 tests、stryker:check、verify-dir-imports、docs、diff-check 均 exit 0。
- Phase 5 已完成实现、红队修复与本地门禁：verify-isolated 强制显式精确 0.1.7-rc.1（344 tests）、worktree 同 tab/pre-abort 生命周期（338 tests）、lan 双迁移串行+canonical identity interface（1080 tests）、notifier 坏 version fail-closed（1244 tests）、MCP source=content、maintenance 完整 V3 wrapper 自检、host-contract 真实派生与 root-shared mutation 均已收口。`pnpm test:scripts` 1214 pass/1 官方 reopen skip exit 0；`pnpm gate:changed`、`pnpm gate:pr`、`pnpm gate:full` 均 exit 0；decision/lan/worktree/shared 实际 mutation 段均 exit 0（shared score 64.19 ≥ 60）。唯一合并阻塞仍是本机 dsh 0.1.5-rc.1、无精确 0.1.7-rc.1：官方 V0/V2→V3→V4 reopen 与 isolated browser smoke 未运行，未改用户 profile、未用旧 runtime 冒充。
- 远端 PR/issue 正文仍保留旧双基线方案；本轮只按用户直接授权在本地 worktree 实施，未修改 GitHub。

## Proposal

### 总体边界

只支持 catalog 锁定的 0.1.7-rc.1。不为其他 DSH runtime 增加业务兼容分支；旧配置、旧 profile 数据和历史会话格式的兼容读取统一放在 upgrade/maintenance 边界。业务代码只产生和消费目标版本当前形状。

不修改 DSH 源码，不新增不必要的第三方运行时依赖，不改包版本号，不推 v* tag，不自行 push。

### Canonical identity

单包和 all 聚合安装必须使用同一 patch row identity；聚合包只复制单包行，不另造 all 专用 id：

- lan: ui-dsh-lan-proxy
- mcp: ui-dsh-mcp-manager
- provider usage: ui-dsh-provider-usage

当前 mcp 单包行与 all 聚合行已核对相等，均为 ui-dsh-mcp-manager。需要修的是 host/client/settings consumer，不是更换 ui- 前缀。

### 阶段 0：冻结实施方案

在任何生产代码修改前，统一 PR body、issue 计划和测试口径：

- 删除双 runtime 编译要求和“旧版本也可运行”的叙述。
- 当前 MCP writer 固定为 producer-owned V4 source：kind: "plugin:@wingsky-1/dsh-mcp-manager"，不再写 kind: "plugin" 加 plugin 字段。
- 明确历史 V0/V2/V3 session source 的迁移责任和版本矩阵。
- 明确旧 settings 数据只由 upgrade 读取，业务目录不保留旧格式解析器。
- 明确目标版本的 Plugins row 配置入口是 plugins.row.config；settings.plugins.tab 是另一套内置插件清单分区，不能替代 bundle row 配置。
- 若实施方案发生实质变化，先更新提案载体再实施。

### 阶段 1：settings / identity 垂直闭环

范围：lan、mcp、shared、两包客户端契约和测试。

1. 为每个包建立 host/client/patch 可比对的 canonical 常量；YAML 不能成为第二份业务身份源。
2. mcp host 的 settings namespace、写入 sink、客户端 row key 全部改为 ui-dsh-mcp-manager。
3. mcp 只给 ui 子配置声明 volatile，不把根 Config 的所有内部键开放成表单。
4. lan/mcp 使用 plugins.row.config：
   - @wingsky-1/dsh-lan-proxy#ui-dsh-lan-proxy
   - @wingsky-1/dsh-mcp-manager#ui-dsh-mcp-manager
5. 通过 configForms.whileServed() 注册页面；Host 不服务对应 namespace 时不留下页面痕迹。
6. 补齐 client inject 元数据，使 configForms 和 plugin manager 页面在单包、all 两种组合都可用。
7. shared 接缝收敛为目标版本适配器：删除未使用 schema 占位、optional 写面、重复订阅和错误旧 slot 注释；保持单一来源/生成声明，不制造八份手写 d.ts。
8. provider usage 当前 apply.ts:552 的 no-op settings 接线是 base 已有存量，但应删除，而不是再增加一个旧 namespace。
9. rc.1 `PluginConfigViewProps.form` 是可选的，官方 fixture 允许插件提供自有 form；当前 lan/mcp 的领域配置卡保留各自 loopback API 作为唯一写面，不并存旧 namespace 或第二写面。ConfigForm/host schema 负责 canonical namespace、volatile metadata 与 row 生命周期；CA、host-trust 等非配置动作仍可保留专用 API。后续若迁移到 generic form，另立窄任务。

验收：单包和 all 分别安装，Plugins 页面可见、保存、重载、热更新均正确；host/client/patch/aggregate 四方 id 精确一致。

### 阶段 2：upgrade / migration 闭环

范围：notifier、lan、MCP catalog/session。

#### notifier 与 lan

- 不把 settings.documentPath 当作旧 settings 文档；它是当前 profile 文档路径。
- upgrade 同时检查 profile home 下的 settings.yaml 和 settings.yaml.imported。
- 多个来源按字段合并，不能因为当前 section 非空就丢弃 imported 中的其余字段。
- 迁移失败、不可读或内容未完整落盘时，不推进存储版本标记。
- lan 旧 settings section 与 notifier 一样进入 upgrade 边界；不能只处理 config.json/.bak。

#### MCP source/session

- 当前 writer 只产生 V4 producer-owned source。
- 旧 V3 kind: "plugin" 由官方 V3→V4 转换或明确的 upgrade 路径处理。
- 旧 V0/V2 mcp-catalog 的 repair 脚本先保留为显式 maintenance 工具，待 fixture 证明官方链路后再决定是否删除；不能把历史 parser 留在业务 writer。
- readCatalogEntries 等无生产调用的旧解析器移出业务域或删除。
- 建立 V0/V2/V3/V4 reopen fixture，验证 source、sections、entries 和内容不丢失。

### 阶段 3：异步语义

#### decision-gateway

- semaphore 接收 signal；取消时摘除 waiter 并立即映射 ABORTED。
- 预取消请求在 local-precheck、密钥解析、历史记录之前短路。
- 增加 max=1 阻塞首项测试：第二项 abort 后在释放首项前已经 settle，且 task 未执行。

#### worktree-sidebar

- consider、subscribe wrapper、ctx.on 全链返回并等待 Promise。
- serial agent/created 返回时，三项工具已经注册。
- 保留 abort/dispose/generation 语义，不用固定 sleep 充当判据。

### 阶段 4：verify-isolated、测试分层和文档

- 删除 ui-onboarding fallback；目标版本取不到 namespace 时不预置，交给 browser-driver。
- 重新评估 settings.yaml 预置：官方 importer 读取 profile home 文档，当前写 $DSH_HOME/settings.yaml 不足以证明有效；优先删除 legacy 预置而不是继续扩展 fallback。
- keep-mounted 测试迁移到合适的 client 测试层，删除本 PR 新增的两条 dir-import 豁免及对应 baseline/contract/mutation 登记。
- 用真实 SlotCore/ConfigForm 行为测试替换 bundle 字符串 includes() 断言。
- 修正 shared 同 namespace 值变化测试，当前测试标题与实际发出的 namespace 不一致。
- 更新 SECURITY.md 的 0.1.5 基线、lan/mcp README 的旧 settings.yaml/namespace/config 路径。
- 清理所有“双基线”注释，但不新增兼容散文。

### 阶段 5：验证与合并门

顺序固定为：

    focused package tests
    → pnpm gate:changed
    → pnpm gate:pr
    → pnpm gate:full
    → CI / mutation
    → rc.7 isolated browser smoke

必须通过的目标行为：

1. lan 单包 Plugins 页面打开、保存、重载。
2. mcp 单包 Plugins 页面打开、保存、重载。
3. all 聚合安装使用相同 row key，且不与单包混装。
4. notifier .imported 旧配置完整迁移，失败不推进版本。
5. MCP V0/V2/V3/V4 session 均可 reopen。
6. decision 排队取消立即结算且无副作用。
7. worktree serial 首轮工具立即可见。
8. verify-isolated 使用目标 profile 和目标 namespace，不写旧 fallback。

## Orchestration and expert review

主控 agent 负责范围、顺序、worktree、集成和最终结论；专家子代理只做被分配的独立阶段，不向下委派、不修改共享文件、不发 PR 评论、不 commit/push。

建议专家分工：

- settings/identity expert：阶段 1，审查 patch/client/host/ConfigForm 四方身份。
- migration expert：阶段 2，审查 notifier/lan 数据合并、版本刻度、MCP source/session 矩阵。
- async expert：阶段 3，审查 semaphore 取消和 serial Promise。
- verification/gates expert：阶段 4，审查隔离脚本、测试分层、门禁数据和弱断言。
- red-team reviewer：每个阶段完成后只读复核；最终再以 base→head 做一次全 PR 对抗审查。

并行规则：

1. 只读分析可以并行。
2. 同包生产文件写入串行；一个阶段完成并通过 focused gate 后再进入下一阶段。
3. 每个专家报告必须包含：结论、绝对文件路径、file:line 证据、实际命令及 exit code、未验证项、风险。
4. 阶段复核默认由非作者角色承担；主控不能用自己刚写的实现作为唯一验收依据。
5. 复核未收齐前不进入集成提交；不把 CI 绿色当作行为验收。
6. 每个阶段形成独立 commit 之前，先检查 worktree status 只含预期文件；测试产物必须进临时目录。

## Alternatives considered

- 原样执行 PR 评论中的 v2 R1–R5：保留 target-only 方向，但仍留下旧 settings slot、mcp namespace/Config 断裂、.imported 迁移缺口、异步问题和新增门禁豁免，不能整体收口。
- 业务层继续兼容 0.1.5 与 0.1.7 两套 API：短期降低迁移摩擦，但会制造双配置入口、双 source 形状和重复测试，违反 target-only 与 upgrade 分层。
- 直接把所有旧 source/session 解析器删除：表面最干净，但会丢失 V0/V2 历史数据；必须先用官方迁移或明确 maintenance 矩阵证明替代路径。
- 把社区插件配置注册到 settings.plugins.tab：该 slot 属于内置插件清单分区；bundle row 的官方配置槽位是 plugins.row.config，不能用错页面模型。
- 继续用字符串 bundle 测试和新增 dir-import 豁免：短期让门禁变绿，代价是测试层与门禁事实源失真；不采用。

## Acceptance criteria

- 当前 PR head 的 Standards 与 Spec 均通过独立复核。
- 业务代码只产生 catalog 锁定目标版本当前 API 形状。
- 单包/all 两种安装路径分别通过真实隔离验证。
- 历史配置和历史 session 的迁移均有精确往返、幂等和失败不推进刻度判据。
- 所有严重级修复都有目标版本运行时复现，不以 fake 形状替代。
- gate:pr、gate:full、CI/mutation、rc.7 isolated browser smoke 全部通过。
- 不新增 DSH 源码修改、运行时第三方依赖、包版本 bump 或 tag。

## Risks

- 官方 V4 source 的历史迁移链可能需要同时覆盖 V0/V2 repair 与 V3→V4 官方转换，必须用真实 fixture 定责，不能凭类型声明推断。
- ConfigForm 迁移会触及 lan/mcp 客户端组件和 API 路由，需保留 CA/host-trust 等非配置动作，不能简单删除整个设置卡。
- 聚合安装与单包安装必须保持同一 row id；双装仍按仓库现行策略 fail-loud，不新增静默去重。
- verify-isolated 当前存在大范围脚本改动；若不能证明行为等价，应收缩到目标版本真正需要的 onboarding 行为。
- 门禁基线、export surface、mutation topology 和测试层清单必须随测试移动同步，不能只改一个数据文件。

## 续接提示词

继续 PR #1012 的 rc.7 target-only v2.1 接手实施与复核。

基线：
- PR base: 54abf76bc9a1505937688bde7ed9292e286f5d95
- 当前 PR head: ddd3719a9e2da03c7b95f363441674f999aa2a44
- 目标运行时: dsh 0.1.7-rc.1（catalog 锁定）
- 计划 note: .agents/notes/proposed/architecture/2026-09-24-pr-1012-rc7-target-only-v2-takeover.md
- 接手 worktree: /mnt/ssd/worktree/dsh-plugin-hub-pr-1012-v2

先读取仓库 AGENTS.md、相关包级 AGENTS.md、上述 note，再检查 worktree status。不得修改主 checkout，不得向 GitHub 发评论，不得 push/tag。

按 note 的阶段串行推进：
0. 对齐 PR/issue 方案，删除双 runtime 和旧 source writer 要求。
1. settings/identity：统一 patch/client/host/config 身份；lan/mcp 使用 plugins.row.config + configForms.whileServed；mcp ui 子配置 volatile；单包和 all 分别验证。
2. upgrade：notifier/lan 读取 settings.yaml 与 settings.yaml.imported，失败不推进版本；MCP 当前 writer 改为 V4 producer-owned source，旧 source 只在 upgrade/maintenance。
3. async：修复 decision semaphore 取消和 worktree serial Promise。
4. verify/tests/docs：删除旧 namespace fallback，迁移 keep-mounted 测试，删除新增 dir-import 豁免，修正文档和弱断言。
5. focused tests → gate:changed → gate:pr → gate:full → CI/mutation → rc.7 隔离浏览器 smoke。

每个阶段派一个独立专家子代理做只读复核；子代理不得向下委派、不得修改共享文件、不得发外部评论。阶段报告必须给出绝对路径、file:line、实际命令和 exit code、未验证项与风险。主控负责串行集成和最终裁决。

重点复现：
- settings.plugin.item 在 rc.7 不可注册；
- V4 kind:"plugin" 被拒绝；
- notifier 只有 settings.yaml.imported 时不能迁移；
- decision abort 后排队任务不能等槽释放；
- agent/created serial 返回时工具已注册。

不要因为 gate:pr/gate:full/CI 全绿就宣称完成；最终必须有目标版本真实行为证据。
