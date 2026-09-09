/**
 * dsh-notifier — pipeline/interface.ts：推送管线域唯一对外引用面。
 *
 * PR1 现状：本域承载从旧 createNotifierService 机械提炼的判定与投递纯函数
 * （行为与提炼前一致；current() 仍实时读取）。PR2 行为重构时在此引入
 * AdjudicateResult/AdjudicatedNotice/ResolvedTarget 等契约类型与
 * createAdjudicator/createDeliverer 工厂，并上移 current() 单刻快照与
 * 重试/并发门（B-2/B-3）——interface.ts 随之扩充（verify-dir-imports 静态强制）。
 */
export { isBuiltinKind, isKindConfirmed, resolveRoutes } from "./adjudicate.ts";
export { deliverToChannel, truncateCodePoints } from "./deliver.ts";