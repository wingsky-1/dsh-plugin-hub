# 验证完整性规格（3.8：先立后破的前置契约）

> 本片性质：纯规格片。把验证完整性的准入与裁决口径写成文档，不新增门禁脚本、
> 不改比较器逻辑、不改阈值数值、不碰公共接口与配置格式，本片零源码改动。
> 推荐方案为只改数据加自测加文档，复用现有库。
>
> 证据基线：origin/main 11d4b15d。行号会随提交漂移，下文引用一律以符号名
> （文件名、守卫标识、字段名、包名、段名）为准，可用符号搜索复核；行号只在注明处作基线快照。
>
> 门禁语义的唯一出处是门禁代码与数据文件本身；本文档是现状记录与准入说明，
> 语义分歧以它们为准。
>
> 快速上手见各包 README；架构总览见同目录各包文档与包内配置行为规格。
> 本文只记录验证完整性的术语、准入、裁决与撤除口径，不重复架构文档的内容。

## 1. 定位与范围

- 3.8 是先立后破的前置契约：新锚立项、自动裁决生效、豁免撤销三者的前置先行。
- 前置结论（主控已独立核验，本规格直接采用）：1.6 最小双向闭环已满足；
  下游 2.1 与 4.d 等 3.8 立项，不在本片回填正式锚或撤销豁免。
- 条件性测量发表不受阻断：读取、测量或发表带边界事实不受本片阻断，
  只有晋升正式锚、自动判红、删除豁免受门禁。
- 判据沿用现有六维自动裁决加四项撤除口径（见第 5 节与第 6 节），
  由既有门禁执行，不在本片新增执行点。

## 2. 术语：候选测量与正式锚

- 候选测量指单次实测数值，未经第 4 节准入，不得当作回落锚点引用。
  例：dsh-worktree-sidebar 的 baselineCovered 80.3 是 2026-09-18 本地全量冷跑，
  面为零排除新面，旧面历史锚已作废，当前无 fixedCovered，语义是候选锚。
- 正式锚指经第 4 节准入后写入 gauntlet 的回落锚点，
  事实源是 [gauntlet.config.json](../../scripts/data/gauntlet.config.json)
  的 mutation.packages 下各包条目。
- 机器校验绿不等于正式锚：存在性守卫只校验生效值大于 0（单锚即过），
  双全由流程保证，详见第 7 节。
- 口径声明缺一不可：每次引用锚点须同时给出所属 run、所属面、所属分母，
  旧锚作废须同步说明，不把历史跨面计数差写成质量涨跌。

## 3. 唯一事实源与读取语义

- 阈值声明表是 [threshold-registry.json](../../scripts/data/threshold-registry.json)，
  比较器是 [threshold-registry.mjs](../../scripts/lib/threshold-registry.mjs)，
  入口是 [threshold-monotonic.mjs](../../scripts/gate/threshold-monotonic.mjs)。
- 正式锚语义说明字段是文档性字段：顶层 formalAnchorSemantics 与
  mutation.packageSet 及 mutation.packageAnchor 的 formalAnchorDoc 只作说明，
  比较器不消费；语义分歧以比较器与入口代码为准。
- 变异段实测台账是 [mutation-segment-ledger.json](../../scripts/data/mutation-segment-ledger.json)，
  解析与对账纯函数是 [mutation-ledger-lib.mjs](../../scripts/lib/mutation-ledger-lib.mjs)，
  入口是 [mutation-ledger.mjs](../../scripts/gate/mutation-ledger.mjs)。
  不变量为测量值并集 unmeasured 等于当前段集合，历史段须登记取代关系。
- 变异面登记是 [mutation-topology.json](../../scripts/data/mutation-topology.json)，
  派生校验是 [gen-stryker-conf.mjs](../../scripts/gate/gen-stryker-conf.mjs)。
- 豁免台账是 [gate-exemptions.json](../../scripts/data/gate-exemptions.json)，
  收集器是 [collect-exemptions.mjs](../../scripts/gate/collect-exemptions.mjs)，
  机制实现是 [exemption-gate.ts](../../scripts/lib/exemption-gate.ts)。
- 出口语义统一经 [gate-exit.mjs](../../scripts/lib/gate-exit.mjs) 的 failClosed，
  门禁故障一律走退出码 2，不可读成结论。

## 4. 新锚准入 A1 至 A6

- A1 夜间全量班出处：来源须为夜间全量班全量冷跑，
  非人工触发班冒充自然班；证据为台账的 run 标识、测量时间与日志来源，
  结论非 success 的分片先排除，未闭合段宁缺勿造。
- A2 面冻结：变异面并集与当前段面一致，判据无收缩；
  段之间挪动合法，并集收缩须走豁免通道；面扩大后分母不同不可比。
- A3 报告齐备：判分输入段齐备，缺段按门禁故障处理；
  错误状态不得静默从可信结论中消失，复用既有报告聚合口径。
- A4 双锚写入：各包同时含 fixedCovered 与 baselineCovered 且生效值大于 0，
  生效值按 fixedCovered 优先、缺失时取 baselineCovered；
  声明见 threshold-registry 的 mutation.packageSet 的 requireFields
  与 mutation.packageAnchor 的 anchorFields。
- A5 台账登记：按判据分开登记 membership 与 anchor 与 removal，
  带复核人与解除条件，两通道都做反向腐烂校验。
- A6 口径声明：同时声明所属 run、所属面、所属分母，旧锚作废同步；
  计分口径与分母变化如实记录，不借完整性修复改动 covered 公式。

## 5. 自动裁决 V1 至 V6

- V1 切片判分：沿用 mutation-gate 的阈值对比，入口是
  [mutation-gate.mjs](../../scripts/gate/mutation-gate.mjs)。
- V2 夜间判分：沿用 observe-check 的阈值加回落检测，入口是
  [observe-check.mjs](../../scripts/gate/observe-check.mjs)。
- V3 规则治理：沿用 threshold-monotonic 的未登记即红与影子源判红，
  声明表自身被同一套语义守住，入口是
  [threshold-monotonic.mjs](../../scripts/gate/threshold-monotonic.mjs)。
- V4 终局裁决：沿用 repo-gate-assert 的证据齐备判定，
  缺段与未判定错误不得放行，入口是
  [repo-gate-assert.mjs](../../scripts/gate/repo-gate-assert.mjs)。
- V5 红线授权：沿用 red-line-approval 的红线路径审批，入口是
  [red-line-approval.mjs](../../scripts/gate/red-line-approval.mjs)。
- V6 退出码语义：门禁故障一律退出码 2，不可读成判红或通过；
  普通返回值语义保持不变，只收口真实门禁出口。

## 6. 撤豁免 R1 至 R4

- R1 按通道分片：按算子整类、个例、整包、锚点拆分子序列，
  导出面按包拆分，每通道独立可回滚。
- R2 映射先行：每切片写清旧保护到新责任层到行为反例到删除条件到防复活判据，
  对应保护验证通过后，在同一改动或紧邻依赖改动中撤销旧入口。
- R3 反向腐烂：台账里无对应缺口的键一律判红，不被静默忽略；
  豁免按判据分开登记，一条豁免不得顺带关闭另一条判据。
- R4 不自动冻结：收集只报告不判红，到期不冻结改动，人工处理；
  目标是零豁免，台账只是过渡期手段。

## 7. 正式锚的双全与例外登记

- 正式锚要求 fixedCovered 与 baselineCovered 双全且生效值大于 0。
- 当前比较器对 existence 只校验生效值大于 0，单锚即过；
  对 baseline 逐字段只许抬不许降；双全由夜间全量班回填流程保证。
- 双全形状的例外走 contractApprovals 登记标识加字段加跟踪 issue 加理由；
  单包缺锚的临时状态走豁免台账的 membership 或 anchor，
  按判据分开登记并带复核人与解除条件。
- 本节是对声明表文档性字段的复述，比较器行为以代码为准。

## 8. 条件性测量发表不受阻断声明

- 只读测量、现成报告核验、无关替代保护设计可并行，不等本片关闭。
- 带边界的事实发表不受阻断，但须同时发表边界：所属 run、所属面、所属分母、
  旧锚是否作废、是否为候选测量。
- 通用完整性保护是正式锚采用和相关豁免撤除的前置，
  不是读取、测量或发表带边界事实的前置。
- 未经准入的数值不得写入正式锚字段，不得删除豁免，不得作为自动判红依据。

## 9. 否决的替代方案

- 否决新增完整性闸：扩红线面无额外判力，复用现有六维已覆盖。
- 否决本地冷跑直升正式锚：与门禁故障关闭原则冲突，本地值只作候选测量。
- 否决豁免到期自动判红：与豁免台账只报告不判红的裁决冲突，
  到期由人工复核处理。

## 10. 已知缺口与非目标

- sidebar 正式锚待一次夜间全量班回填 fixed 系列字段，
  在那之前保持候选语义，不人工触发班次冒充自然班。
- 历史跨面计数的旧锚只作历史参考，不直接比较质量涨跌；
  历史调查设停止条件，仍无证据则保留不可验证，不得用作可信锚点。
- 不在本片提高阈值、开启严格开关、回填正式锚、撤销豁免、改平台保护或发布。
- 不新增统一治理平台、重复登记表或通用数据流框架。

## 11. 证据与复核方法

- 只读复核命令示例（均不写工作区）：
  node scripts/gate/threshold-monotonic.mjs origin/main，
  node scripts/gate/mutation-ledger.mjs --check，
  node scripts/gate/collect-exemptions.mjs，
  node scripts/gate/verify-docs.ts --strict-en。
- 配置与锚点复核用符号搜索（如搜索 fixedCovered 与 baselineCovered），
  不以行号为长期依据。
- 包内配置行为规格见 [pkg-config-behavior.md](pkg-config-behavior.md)；
  门禁分层与阈值治理见仓库门禁文档与阈值声明表注记。
