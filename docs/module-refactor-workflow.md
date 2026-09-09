# 模块架构梳理·讨论·决策·TDD 重构工作流（可复用 Agent Prompt）

> 用途：对 dsh-plugin-hub 仓库内任一插件模块（{MODULE}，如 dsh-notifier / dsh-lan-proxy /
> dsh-provider-usage / dsh-web-file-preview / dsh-codegraph / dsh-verify-isolated / dsh-mem0）
> 执行一次「全量功能特性与需求规格梳理 → 分层架构讨论与层边界裁定 → 决策拍板 →
> 对抗性评审收敛 → TDD 重构方案」的完整闭环。
> 来源：dsh-mcp-manager 同款实践（两轮对抗评审 62→78→90+，产出物清单见 §7）。
> 使用方式：把本节作为任务 Prompt 交给 agent（可放入 issue 正文或子代理），替换全部
> `{占位符}`；按 §0 红线检查后执行。

---

## 0. 任务前红线检查（不满足不开始）

- [ ] 任务从仓库 issue 派生（无 issue 先建/认领；方案性改动按仓库红线先在原 issue 起草
      `needs-proposal-review` 方案评论，获维护者 `approved` 后动手）。
- [ ] 主 checkout 保持干净：**只在独立 worktree**（`git worktree add ../dsh-hub-task-<n> -b task/<n>`）
      内改代码/构建/测试/归档；禁止在主 checkout 切分支、改代码、跑实验。
- [ ] 绝不动 DSH 源码、绝不重启/杀 dsh web 进程。
- [ ] 全中文表达（代码/专有名词/协议名保留原文）；安全语义变更（凭据/执行/令牌/外部可达面）
      必须在 README 安全模型与方案中显式声明，走红线流程。
- [ ] 定位 {PKG_DIR}=packages/{MODULE}/；先通读该包 README（中英）、package.json、
      cordis.patch.yml、docs/。

## 1. 全量功能特性与需求规格梳理（产出 requirements-and-tdd-plan.md 的规格章）

1. **特性清单化**：按域枚举功能特性，编号 `F<域>-<序>`（如 F1-1 配置持久化、F2-1 连接生命周期、
   F3-1 中间层…），每条含：行为描述 + 实现位置（文件:行号）+ 需求来源（README 原文/issue 号）。
2. **规则化**：把 README/代码语义转成「可测试的需求规则」，每域给「happy / 边界 / 异常 / 并发竞态 /
   安全」五行矩阵——这是后续 TDD 用例矩阵的输入。
3. **覆盖全读**：宿主端 `src/` 全量（含 index.ts 导出面、apply 装配、路由、存储、协议）→
   客户端 `src/client/` 全量 → 共享层 `shared/` 中本包消费面（loopback/sse-hub/host-utils/
   settings-namespace/dsh-home/placement/服务类型面）→ `test/` 全量（运行模型、断言强度、
   执行矩阵）→ `git log -- packages/`（近期修复/已知遗留线索）。
4. **归档**：`docs/requirements-and-tdd-plan.md`（规格章 + 后续各章累积于同一文件）。

## 2. 分层架构梳理与层边界裁定（产出架构分层章节）

1. 若用户给出层清单（如 mcp-manager 的「配置管理/连接管理/注入 dsh/对外集成/API/设置页/胶囊页」），
   先把模块精确映射进每层；**再裁定补齐**：
   - 可拆层（混合编排 vs 执行的连接域类，看单文件行数/职责混叠/同类 bug 是否跨子域）
   - 可合并层（纯函数与 IO 已分文件却仍算两层的「贴标签」类）
   - 新增横切层（路由解析、状态事件、执行管道等被多处消费且有真实 bug 的单一事实源候选）
   - 维持层（边界已清晰的：API/UI/服务面/统计等）
   裁定要落到代码证据（行数、依赖、bug 归因），不做文档主义分层。
2. **每层契约**：成功签名 + 错误契约 + 事件契约 + 依赖方向（上层依赖下层，禁止反向；
   下层暴露最小面接口如 ManagerLite/MiddlewareHost）。
3. **目标目录结构**：9±2 个域目录 + 客户端子目录；`index.ts` 保持聚合 re-export（导出面
   = smoke/契约门禁锚点）；标注「旧文件→新文件」映射与跨域常量/类型的归位。
4. **可视化作图**（可选但推荐）：用 archify skill 出架构图（见 §6.4 经验）。

## 3. Bug 全量识别与测试盲区交叉验证（产出 bug 清单章）

1. **特性-实现对照**：逐条规格 vs 实现找偏差；对照 README 承诺（分级状态、超时、截断、脱敏、
   重连预算等数值与语义）。
2. **客户端-宿主契约核对**：客户端 HTTP/SSE 交互面与宿主路由逐项核对（形态、帧协议、幂等性、
   参数是否带全——参考 mcp-manager 的 cwd 不对称、tool-disable 拼参缺陷）。
3. **测试盲区交叉验证**：对每个嫌疑 bug 用 grep 验证「现有测试是否真的覆盖」——很多 bug 藏
   在测试只断言状态机末端、没断言中间过渡态（如重连中状态被覆盖），或测试文件本身是执行矩阵
   孤儿（不在 smoke import、不在 stryker testFiles、不在 mutation-topology 三处任一）。
   输出：严重度分级 P0/P1/P2/P3 + 位置 + 与规格偏差 + 是否已有测试覆盖（% 盲区）。
4. **防伪证**：对「没有发现的 bug」结论给 grep/行号证据，不靠印象。

## 4. 决策拍板（产出规格决策表，供 §5 前清零）

- 每个「或规格化声明」项、涉及公共面（工具命名/公开 API/安全语义/门禁）的修复方向，必须
  进决策表：编号 D1..Dn，每项 = 选项 + 推荐 + 技术依据（引代码行）。
- 决策前先做事实核验，**防止伪决策**（本会话教训：误以为 start 变 async 会波及 routes×9，
  grep 后零处调用——大改面是假的）。
- 涉及门禁/基线的决策（变异判分口径、迁移豁免机制）先读 `scripts/gate/*` 与
  `scripts/data/gauntlet.config.json` 实际判分逻辑，不要停留在「需澄清」。

## 5. TDD 重构方案（产出 TDD 计划章）

1. **红测清单**：每个已确认 bug 一条红测，标注：可测性（纯函数/状态机 mock/集成桩）+
   前置依赖（如某测试文件需先双登记接线、某修复需先定契约）+ 断言点建议（避免整窗口轮询、
   避免读私有字段——优先纯函数断言）。
2. **需求规则矩阵**：把 §1 矩阵展开为用例清单，先纯函数层（无副作用，红绿最快）→ 状态机层
   （mock 协议/传输桩进 helpers.ts 统一提供）→ 集成/契约层（路由 403/405、SSE、服务契约静态
   扫描、客户端契约）→ 客户端 UI（隔离浏览器实测，不入单测门禁）。
3. **分阶段**：阶段 0 契约冻结/规格决策 → 纯函数 → 状态机 → 集成 → 集中式纯搬移（如需要）→
   客户端 → 质量收口。每阶段独立 PR 关联同一 issue。
4. **静态面约束**（搬迁/目录化前必须普查，否则必红）：
   - 测试「源文本路径」静态扫描（如 service-contract 对 src/apply-services.ts 的 readFileSync）——
     被扫描文件在集中迁移前**禁止移动/薄转发**；
   - stryker 各段 `mutate` 是显式 src 文件清单 + `scripts/data/mutation-topology.json` +
     workflow-assert 三方一致；observe 基线为 src 口径；
   - 新建文件若不挂入任何段 = 变异盲区（防空段断言不查全覆盖），拍死「逐阶段挂段 vs 集中重画」
     后明示；
   - 客户端 `src/client/index.ts` 是 build-client 入口锚点，保留；style.css 相对引用路径随迁移变。
   - 迁移 PR 验收三件套：迁移前基线快照全绿 / `git diff --stat` 纯移动零行为变更 /
     迁移后全绿 + observe 基线重建豁免机制。
5. **测试纪律**：mkdtempSync 隔离落盘；pollUntil/事件驱动替代固定 sleep；测试单份维护
   （test/*.test.ts 测 lib 产物，stryker 经 lib→src hook 复用）；新测试文件必须 smoke +
   mutation-topology 双登记。

## 6. 对抗性评审（多轮收敛，硬门禁）

1. **独立子代理**（后台，prompt 自包含：给文档路径 + 代码事实源 + 仓库约束 + 评审维度），
   评审维度：正确性/边界、性能与资源、安全、可维护性、兼容性（明暗主题/移动端/Windows）、
   与仓库既有约定冲突、过度设计。
2. **评分制**：<70 需重大修正；70–85 机制空洞需补（方向对、机制缺）；≥90 可进 issue 方案评审。
3. **每一轮评审后**：归档评审纪要（含总评、逐维度发现、裁定表、缺口清单、P0/P1/P2 修正），
   修订方案版本（v1→v2→…），**逐条核对 A 表**（上轮 P0/P1/P2 → 本轮落实状态 ✅/⚠️/❌）。
4. **评审的评审（C 复核）**：倾向上轮评审自身的误判（过时事实、失实涟漪、过强后果），
   撤回/修正要落到新的代码证据。
5. 收敛标准：连续两轮无新 P0 + 评分 ≥90 或评审明确「可执行」。
6. **archify 排查经验**（若绘图）：validate（showcase 9/9 零错零警）→ deliver（冻结 spec）→
   visual-check（四视口 1440/1600/1920/2048 无纵向溢出）；标签重叠用 validate suggested 的
   labelAt；纵向溢出优先压缩行距/节点高/卡片文本，不要显式超大 viewBox；子代理在后台时，
   prompt 要求「第一条回复即完整报告正文」（否则常只回摘要，需 send_message 追全文）。

## 7. 归档与产出物清单（进 worktree 分支提交）

- `docs/requirements-and-tdd-plan.md`：需求规格（F 编号+规则矩阵）+ bug 清单（分级+证据+
  测试盲区）+ 测试审计（执行矩阵/哑断言/脆弱点）+ 分层架构 + TDD 计划 + 评审纪要（可拆多文件）。
- `docs/architecture-redesign.md`（v<N>）：目标分层/契约/目录/迁移策略/阶段计划/决策表 D1..Dn。
- `docs/architecture-redesign-review.md`：各轮对抗评审纪要（评分、A 核验表、B 新问题、C 复核）。
- `docs/diagrams/`：archify JSON + HTML + visual-check 证据（可选）。
- 评审通过后：建 issue 方案评论（含决策表 + 契约缺口清单 + 迁移门禁策略三件套）→
  worktree 开发 → 分阶段 PR → 门禁全绿 → squash merge。

## 8. 完成定义（Definition of Done）

- [ ] 规格/契约/决策三件文档齐全且评审 ≥90（或评审明确可执行）
- [ ] 全部 P0 bug 有红测且修复后变绿；P1 按阶段计划排期
- [ ] `pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck` 全绿；
      covered/mutation 守 observe 判据；无新增哑断言/固定 sleep
- [ ] 涉及公共面/安全语义的变更已过红线并同步 README
- [ ] 产出物全部归档在 worktree 分支，主 checkout 零改动

<!-- 参数占位：{MODULE} 包名；{PKG_DIR} packages/<MODULE>；{ISSUE_NUM} issue 号 -->