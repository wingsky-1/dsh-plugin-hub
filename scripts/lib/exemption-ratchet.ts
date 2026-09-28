/**
 * exemption-ratchet — 豁免/待办台账的**分桶只减棘轮**（维护者裁决：#765「目标是零豁免」不落硬判红，
 * 改落「新增一条即红、收口一条同 PR 下调一格」）。
 *
 * ## 为什么是分桶，不是单一总数
 *
 * 台账跨三个事实源：coverage.config.json（14 条 pending-project）、gate-exemptions.json（1 条，
 * 阻塞于 #769）、gauntlet.config.json 的 crap（1 条，阻塞于 T5 复杂度 116→0）。钉单一总数 16 时，
 * 「A 桶新增 1 条 + B 桶删掉 1 条」总数持平、门禁全绿——那正是「诚实收口 = 指标持平」与「走台账
 * = 指标好看」之间那条可玩路径。分桶后新桶涨 1 即红，别的桶怎么动都救不回来。
 *
 * ## 两条判据，缺一不可
 *
 *   1. **常量 == 当下计数**（`actual === ceiling`）：新增一条而不动常量 → 判红；收口一条而不下调
 *      常量 → 判红。「收紧必须与数据删除同 PR」因此是**机器检查**的，不靠人记得改常量；桶收到 0
 *      时常量随之为 0，此后任何新增条目 = 实际 1 > 上限 0，自动成为该桶的硬判红，无需另设守卫。
 *   2. **不得比基准多**（`actual <= baselineActual`，基准默认 `origin/main`）：这条专治「新增一条
 *      + 同时上调常量」——等式仍成立，只能靠基准比。**唯一合法方向是收紧**。
 *
 * ## 计数为什么用「暂缺字段」而不是 kind（自验证的隔离）
 *
 * 本模块刻意**不 import** `lib/exemption-kind.ts` 的分桶：台账报告按 kind 识别待办，门禁按
 * 「节点带 reviewBy / exitCriteria」计数，两条不同信号互相兜底——削弱任一侧，另一侧仍看得见。
 * 对覆盖率面这个替代是**可靠**的：判据 verify-coverage-scope ② 已强制 pending-project 必带
 * reviewBy + exitCriteria，且其它 kind 携带这两个字段即判红，故「带暂缺字段的条目数」恰好等于
 * 「pending-project 条目数」；字段被删（洗白）时该计数下降，判据 ① 立即判红。
 *
 * ## 残余风险（如实声明，勿读成「通道已封」）
 *
 * 判据无法保护自己不被改：同时改「本模块的计数实现」与「本模块的常量」两条代码，可让某桶读数
 * 下降而数据一行未删（等式与基准比都仍成立）。这是**比较器自我验证**的固有上限，与
 * `data/threshold-registry.json` note 自承的「自授权通道在类上并未消除」同型。现有防线只有两层：
 * 真值快照用例（`test/exemption-ratchet.test.ts` 内**独立重数**，不调本模块）与 PR 评审可见性；
 * 真对抗需要仓库外的锚（required check / 规则集），属维护者动作。
 */

/** 一个桶 = 一个事实源文件（仓库根相对 posix 路径，判词里直接点名）。 */
export interface RatchetBucket {
  /** 事实源路径；桶的粒度就是文件——台账跨三个文件，跨文件抵消正是要封掉的那条路径。 */
  readonly file: string;
  /** 上限常量：必须**等于**该文件当下「带暂缺字段的条目数」（ceiling 不是目标值，见判据 ①）。 */
  readonly ceiling: number;
  /** 桶说明（判词里说清这个桶在等什么收口）。 */
  readonly note: string;
}

/**
 * 三个桶的上限常量。**留在代码里**：放进被约束的数据文件等于让被约束方改约束（先例：
 * `lib/config-matrix-gate.ts` 的 `UI_EXEMPT_MAX`）。值 = 本仓 origin/main 的实际计数，随收口下调，
 * 只许收紧（判据 ② 与基准比）。
 */
export const RATCHET_BUCKETS: readonly RatchetBucket[] = [
  {
    file: "scripts/data/coverage.config.json",
    // 13 → 12：删掉 mcp-manager 客户端 core/i18n.ts 那条 pending-project 豁免。
    // 该文件此前**零判据**（唯一导出 tStatus 从未被执行，量化日 lines 0% / branches 0%），
    // 本轮以 test/client-unit/client-core-i18n.test.ts 直连补齐：字面量键锚表 + 恒等绑定
    // 两支，六态逐态可求值。变异探针（把 tStatus 三元的两支对调）实测 exit 1，
    // 判词为 tStatus 断言的 Expected/Received 反向，证明判据落在实现上。
    // 12 → 11：删掉 client/locales.ts 那条 pending-project 豁免。该文件此前**零直接判据**——
    // 水位 100%/100% 是被 index.ts 顶层 import「加载即满」的假达标（量化日把 4 个字典值
    // 改成乱码后全量 1520 个测试仍全绿，exit 0）。本轮以 test/client-unit/client-locales.test.ts
    // 补真判据：91 条键 × zh/en 的全量字面量镜像（期望值一行不从被测实现 import）+ 键平衡 /
    // 占位符配对 / 非空三条机械判据。变异探针（即量化日那个「4 个字典值改乱码」）现 exit 1。
    // 11 → 10：删掉 core/dom.ts 那条。该文件此前是台账里点名的**第二个假达标**——量化日水位
    // 94.44%/76.92% 看似达标，但**变异探针实测零断言信号**（把 pangu 恒等化、把 el 的 class
    // 通道改走 setAttribute 后，dsh-mcp-manager 全部 1520 个测试仍全绿，exit 0）；那 94.44% 全是
    // float/panel/quick-add 渲染路径的顺带执行。本轮以 test/client-dom/core-dom.test.ts 补真判据
    // （25 例：pangu 四向 + 连字符不撕开、七条属性通道归属、子节点两种传法）。同一手法下
    // pangu 恒等化现 exit 1。
    // 10 → 9：删掉 core/constants.ts 那条。量化日本文件 lines 60% / functions 0% / branches 0%——
    // statusDot 被 float.ts:259 真实调用，但三个导出常量（API / STATUS_ORDER / STATUS_TEXT）无任何
    // 直接断言，且 statusDot 的表外回落分支从未被走到。本轮以
    // test/client-unit/client-core-constants.test.ts 补齐（11 例）：statusDot 六态配色用字面量表钉、
    // 表外回落中性灰、回落色与 stopped/disabled 同串；STATUS_ORDER 展示次序与 titleKey 字面量钉；
    // STATUS_TEXT 六态字典键字面量钉；API 11 条路由键面 + 绝对路径形态。
    // 探针两处 exit 1：改 failed 档色值、改 statusDot 表外回落色。
    // 9 → 8：删掉 core/api.ts 那条。量化日 lines 66.66% / functions 25% / branches 43.47%——
    // 三个导出纯函数（toolDisableServerKey / cwdQueryOf / api）**零直接断言**，水位全是被调用路径
    // 顺带执行的。本轮以 test/client-unit/client-core-api.test.ts 补齐（23 例）：
    // toolDisableServerKey 的 @@global/<name> 与 @<root>/<name> 两形态 + projectRoot 缺失/空串/非字符串
    // 三种 undefined 回落；cwdQueryOf 的非空编码与空串/非字符串空回落；api() 的 2xx/非 2xx error/无 error
    // 兜底 HTTP <status>/body 解析失败两支、调用方自带 signal 时不装超时兜底且推钟后仍不 abort、
    // 抛错路径定时器同样被清掉。探针四处 exit 1。
    // 8 → 7：删掉 float/servers.ts 那条。量化日 lines 23.84% / functions 35.71% / branches 18.82%——
    // 已有 client-float-pure.test.ts / smoke.test.ts 的直连判据只覆盖纯函数层（4 个纯函数），
    // 18 个渲染/动作函数（renderServer / renderServers / serverToolsDetails / statusActions /
    // disableAction / deleteAction / actionButton / serverCardHeader …）**全部未覆盖**，DOM 装配面
    // 零判据。本轮以 test/client-dom/float-servers-render.test.ts 补齐（49 例）：端点摘要两形态、
    // 状态动作三档的 URL/query 逐条钉、禁用/删除动作的 method+body、delete 的 confirm 闸（未确认
    // 零请求）、编辑中才 resetForm、actionButton 失败 alert、单卡结构与 busy 态禁用删除、列表页
    // 空态/需关注置顶/project+global 分组/组内排序/details 折叠态跨重渲染恢复。探针六处 exit 1。
    // 7 → 6：删掉 float/quick-add.ts 那条。量化日 lines 43.78% / functions 35.71% / branches 43.47%——
    // client-float-pure.test.ts 与 unit-summary-a3-guard.test.ts 只覆盖 5 个 guard 纯函数，
    // buildQuickAdd（10 个表单控件 + transport 显隐切换 + 粘贴 JSON 导入）、saveForm /
    // performSaveRequest 三种落点、fillForm 回填、resetForm、beginEdit 全部无判据。本轮以
    // test/client-dom/float-quick-add-form.test.ts 补齐（76 例）：parseKV 两种分隔与空值落空串、
    // stdio/http 两侧字段的空值不落键、fillKvField 投影省略时清零、isMigratedEdit 三判、
    // performSaveRequest 三落点与「原条目有凭据时无条件中止」、saveForm 的占位符中止/整表清空删键、
    // buildQuickAdd 的 10 控件与显隐切换、JSON 导入三态结果文案。探针见提交记录。
    // 两条删除条件同时成立：① lines/branches 达 thresholds 同名键（见 pnpm cov 产物）；
    // ② 已登记进 mutation-topology 的 client-panel 段 mutate（持续执法面）。
    // 按维护者裁定「一条豁免一次落地」，每条豁免自成一次可独立回退的提交。
    ceiling: 6,
    note: "覆盖率排除面的 pending-project 暂缺豁免（水位与变异面同时成立才可删）",
  },
  {
    file: "scripts/data/gate-exemptions.json",
    ceiling: 1,
    // 桶说明曾写「#770 mcp panel 单飞句柄」——#770 已于 2026-09-19 关闭且与本条无关（见 #1066）。
    // 顺带记一条实测约束：往本面**新增**任何一条待办（如拟增设的 gate=crap 面）会被本桶两条判据
    // 同时判红（超上限 + 比基准多），且下调常量解决不了——那要求先收口本桶现有的 panel.ts，
    // 而它阻塞于 #769。**新增面因此被硬串行化在 #769 之后。**
    note: "路径受限门禁台账（mcp panel 单飞句柄，阻塞于 #769）",
  },
  {
    file: "scripts/data/gauntlet.config.json",
    ceiling: 1,
    note: "crap 复杂度预算的观察期待办（等超阈热点 116 → 0 后 strict 置 true）",
  },
];

/**
 * 计数：带 reviewBy 或 exitCriteria 的对象数（递归，与台账发现谓词的「无 kind 面兜底」同形）。
 *
 * 刻意不用 kind：见文件头「自验证的隔离」。父与子都算时两条都算（与 collect-exemptions 的收集
 * 语义一致），故本函数与台账的**发现面**同源、只是**分桶信号**不同。
 */
export function countDeferralNodes(node: unknown): number {
  if (Array.isArray(node))
    return node.reduce<number>((sum, item) => sum + countDeferralNodes(item), 0);
  if (node === null || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  const self =
    typeof record.reviewBy === "string" || typeof record.exitCriteria === "string" ? 1 : 0;
  return (
    self + Object.values(record).reduce<number>((sum, value) => sum + countDeferralNodes(value), 0)
  );
}

/**
 * 桶事实源在两侧的存在状态（纯函数，便于逐态反证）。
 *
 * - `apply`：工作区有 → 判据对它求值（基准没有则按基准 0 计，见文件头判据 ②）。
 * - `vacuous`：两侧都没有 → 本仓没有这个面（单测 fixture 即此种），桶空转。
 * - `deleted`：基准有、工作区没有 → **事实源被删除**，调用方须 fail-closed。
 *   删掉整个文件不等于「这个桶已收口」——否则删除就成了绕过棘轮最省事的一招。
 */
export type BucketSourceState = "apply" | "vacuous" | "deleted";

/** 桶事实源的存在状态（见 BucketSourceState）。 */
export function bucketSourceState(inWorkspace: boolean, inBaseline: boolean): BucketSourceState {
  if (inWorkspace) return "apply";
  return inBaseline ? "deleted" : "vacuous";
}

/**
 * 单桶判据（纯函数）。返回 problems（空数组 = 合法）。
 *
 * @param bucket 桶定义（file / ceiling / note）
 * @param actual 工作区侧该文件的待办计数
 * @param baseline 基准 ref 侧同一文件的待办计数（基准上没有该文件时按 0 计，见判据 ②）
 */
export function ratchetProblems(bucket: RatchetBucket, actual: number, baseline: number): string[] {
  const { file, ceiling, note } = bucket;
  const problems: string[] = [];
  if (actual > ceiling) {
    problems.push(
      `豁免台账 ${file}：待办 ${actual} 条 > 上限常量 ${ceiling}（${note}）——新登记一条待办必须同时收口别的桶并在本 PR 下调本常量：上限只许收紧，「多一条」不能靠上调常量合法化`,
    );
  } else if (actual < ceiling) {
    problems.push(
      `豁免台账 ${file}：待办 ${actual} 条 < 上限常量 ${ceiling}（${note}）——已收口却没下调上限：棘轮要求常量恒等于当下计数，请在本 PR 把常量下调到 ${actual}`,
    );
  }
  if (actual > baseline) {
    problems.push(
      `豁免台账 ${file}：本 PR 让该桶比基准（${baseline} 条）多了 ${actual - baseline} 条（${note}）——待办只许收口不许新增；本常量相对基准只许下调`,
    );
  }
  return problems;
}
