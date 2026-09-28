#!/usr/bin/env node
/**
 * exemption-kind — 豁免/排除条目的**结构化分桶**判别器（kind 派生；临时字段只作无 kind 面的兜底）。
 *
 * 为什么需要它：收口台账此前用「节点带 reviewBy 或 exitCriteria」认一条待办，于是**删掉那两个
 * 字段就能把一条待办洗成「设计事实」**——台账计数减 1、exit 0、无任何判词。分桶改为按对象特征
 * （kind）识别后这条通道关闭：结构性 kind 的条目按设计不计入待办，暂缺类 kind 的条目无论带不带
 * 临时字段都计入。处置律的终态形态：真不适用 → 规则按对象特征自动识别，不登记。
 *
 * ## 判据落在**形状**上，不落在键名 kind 上（这一点是实测逼出来的）
 *
 * `kind` 这个键在 scripts/data 里被三个面重载：排除面（coverage.config 的
 * type-only / not-source / pending-project；mutation-topology 的 coverageExcludes 的
 * type-only / facade / not-source / not-mutated）、CI 面登记（ci-face-registry 的
 * indirect / external / none）、阈值声明面（threshold-registry 的 value / boolean /
 * existence / baseline）。实测按「节点带 kind」发现条目会误收 26 + 12 = 38 条与豁免无关的登记
 * （两种都被本判据归进暂缺类，台账凭空多出 38 条）。故发现谓词用**排除条目的结构**
 * （pattern + reason 两个字符串），而不是键名——判断落在形状/结构上，不落在词表上。
 *
 * ## 结构性 kind 集合会不会成为新的漂移源
 *
 * 会，但方向被钉死为**多算不少算**：
 *   · 集合里多一个名字 → 那些条目被误算成待办，台账多出一条**可见**噪声（逐条打印，作者当场
 *     看得见），下次顺手删掉即可；
 *   · 集合里少一个名字（新增 kind 未登记）→ 落进「未识别 kind ⇒ 暂缺类」的兜底，不会静默逃逸。
 * 即漂移的最坏后果是台账虚高且必然可见，而不是漏计。另一侧兜底：排除面自身已有值域判据
 * （verify-coverage-scope 的 KINDS、mutation-topology 的 COVERAGE_EXCLUDE_KINDS）会把新 kind
 * 判红，故「新 kind 合法入库」必然先经过一次人工裁决，而那正是把名字补进本集合的时机。
 *
 * ## 无 kind 的条目（gate-exemptions.json / gauntlet.config.json）
 *
 * 那两个面的条目本就没有 kind 字段，形状谓词也不认（它们用 gate/path、threshold 标识）。
 * 规则：带 reviewBy 或 exitCriteria ⇒ 仍是待办（保留既有语义作兜底，删字段即降级的问题在这两个
 * 面上由各自的判据与裁决负责）；两个字段都没有 ⇒ 按设计事实处理，与 gate-exemptions.json 头部
 * 「reviewBy 可选：有 = 临时豁免，无 = 长期条目（设计事实）」明文一致。
 * 不一致之处如实声明：排除面的分桶**以 kind 为准**（字段缺失时 kind 兜底），无 kind 的两个面
 * **以字段为准**——它们没有 kind 可依据，而那条语义是它们自己写明的。
 */

/** 两个分桶；台账与判据共用，判词里逐条打印。 */
export const BUCKET = { byDesign: "by-design", deferral: "deferral" } as const;

/** 分桶取值域。 */
export type Bucket = (typeof BUCKET)[keyof typeof BUCKET];

/** 分桶结果：basis 说明判据依据（kind / unknown-kind / deferral-field / no-signal）。 */
export interface LedgerBucket {
  bucket: Bucket;
  basis: "kind" | "unknown-kind" | "deferral-field" | "no-signal";
  kind: string | null;
}

/** 结构性 kind：条目描述「这个东西按设计就不进度量面」，不是「等某个 project / 等判据落地」。 */
export const BY_DESIGN_EXCLUDE_KINDS = new Set([
  // 覆盖率面（scripts/data/coverage.config.json 的 KINDS 同值域）
  "type-only",
  "not-source",
  // 变异面 coverageExcludes 的自有增补值（语义见 scripts/gate/mutation-topology.mjs 的注释）
  "facade",
  "not-mutated",
]);

/** 数据节点收窄成可读字段的字典（非对象一律给 null，调用方按「无此字段」处理）。 */
function asRecord(node: unknown): Record<string, unknown> | null {
  return node !== null && typeof node === "object" ? (node as Record<string, unknown>) : null;
}

/** 排除条目的结构：两个标识字段。ci-face-registry / threshold-registry 的节点不带 pattern，
 *  故不会被本谓词收进豁免面——实测它们共 38 个 kind 节点，按键名发现会全部误收。 */
export function isExclusionShape(node: unknown): boolean {
  const record = asRecord(node);
  return record !== null && typeof record.pattern === "string" && typeof record.reason === "string";
}

/** 待办信号（暂缺字段）；无 kind 的两个面（gate-exemptions / gauntlet）靠它兜底。 */
export function hasDeferralFields(node: unknown): boolean {
  const record = asRecord(node);
  return (
    record !== null &&
    (typeof record.reviewBy === "string" || typeof record.exitCriteria === "string")
  );
}

/** 本节点是否进入台账的面：排除形状，或带待办信号（无 kind 的面靠后者）。 */
export function isLedgerNode(node: unknown): boolean {
  return isExclusionShape(node) || hasDeferralFields(node);
}

/**
 * 分桶：按对象特征识别该条目是「设计事实」还是「待办」。
 *
 * @param {unknown} node 数据节点
 * @returns {{bucket: string, basis: string, kind: string|null}} basis 说明判据依据
 *   （kind / unknown-kind / deferral-field / no-signal），台账逐条打印——判据的判据不是黑箱。
 */
export function classifyLedgerNode(node: unknown): LedgerBucket {
  const record =
    node !== null && typeof node === "object" ? (node as Record<string, unknown>) : null;
  const kind = record !== null && record.kind !== undefined ? String(record.kind) : null;
  if (kind === null) {
    return hasDeferralFields(node)
      ? { bucket: BUCKET.deferral, basis: "deferral-field", kind: null }
      : { bucket: BUCKET.byDesign, basis: "no-signal", kind: null };
  }
  if (BY_DESIGN_EXCLUDE_KINDS.has(kind)) {
    return { bucket: BUCKET.byDesign, basis: "kind", kind };
  }
  // 未识别 kind 落暂缺类：多算一条可见噪声，优于漏计一条待办（见文件头「漂移方向」）。
  return {
    bucket: BUCKET.deferral,
    basis: kind === "pending-project" ? "kind" : "unknown-kind",
    kind,
  };
}
