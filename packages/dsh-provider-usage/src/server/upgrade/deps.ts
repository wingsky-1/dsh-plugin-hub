/**
 * dsh-provider-usage — upgrade 域依赖声明（#768 S2 窄面冻结，先行于 S3 三步实现）。
 *
 * S2 只冻结「upgrade 需要外部什么」，不实现迁移步骤（S3 经本注入面实现：
 * 存储归位 + 配置形态割接 + last-run 迁移；任一步失败即抛，失败不回写刻度）。
 *
 * 窄面 = 三项（目标文档 §2 upgrade 定义 + 计划表 rev2 S2 行），无业务实例：
 * - logger：诊断出口（版本落差与迁移动作在此出声）；
 * - resolveRoot：存储根解析能力（historyRoot 的解析，不是算好的快照值——
 *   用户改配置后快照会失效，而它看起来与实时读取一模一样）；
 * - readOldFile：旧文件显式读面（有名字的两态判别式，显式注入，不直连 fs）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - server/schedule 的 LAST_RUN_SCHEMA / deriveLastRun / alignLastRun 经
 *   server/schedule/interface.ts 以 type + pure 复用（零 node 依赖的纯函数；D2 前在 domain2/schedule）；
 * - LEGACY_* 旧词锁表（LEGACY_PROMPT_TEMPLATE / LEGACY_*_V1–V4）经
 *   server/config/interface.ts 以纯数据值导入复用（D1 起物理定义在 config 域；仅 === 比较与展开，零行为复用；迁移判定基准，文本勿改）；
 * - per-root 临界区链（updateLastRun）留 schedule（METHOD §3 Q1 有主即止：
 *   有明确领域所有者的是依赖不是共享），S3 经 schedule deps 注入，
 *   本域不自建临界区，不新建 file-io 叶（S2 禁令）。
 *
 * 本文件是纯类型面（无 import、无运行时代码）：转译后无可杀灭变异体，
 * 变异面按 type-only 口径排除（见 mutation-topology.json）。
 */

/** 升级链的诊断出口（本域只用到 warn：版本落差与迁移动作在此出声）。 */
export interface UpgradeLogger {
  warn(message: string): void;
}

/** 旧文件读取结果：有名字的两态判别式（缺失/不可读/是目录/损坏一律后者）。 */
export type OldFileRead = { ok: true; text: string } | { ok: false };

/** 旧文件显式读面（由迁移步按既有语义回落空值）。 */
export type ReadOldFile = (file: string) => Promise<OldFileRead>;

/** 装配入参：upgrade 域依赖的全部外部（窄面三项，无业务实例）。 */
export interface UpgradeDeps {
  /** 升级链的诊断出口。 */
  readonly logger: UpgradeLogger;
  /** 存储根解析能力（historyRoot 解析；组合根装配前解析，失败即抛不启动）。 */
  readonly resolveRoot: () => string;
  /** 旧文件显式读面（组合根注入，迁移步只经此读旧文件）。 */
  readonly readOldFile: ReadOldFile;
}
