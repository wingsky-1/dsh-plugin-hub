/**
 * dsh-provider-usage — upgrade 域对外契约：**存储形态的版本迁移**（把磁盘上的数据逐版本推到
 * 当前代码认识的形态），它不认识报告业务。它必须在各域装配**之前**跑——先装配就等于让各域读到
 * 旧形态并带着它继续跑。
 *
 * 本域是纯搬移 + 形态割接：旧路径的字面量归 storage-layout.ts、迁移语义归三步
 *（storage-layout/config-morph/last-run-morph），门面只做收口。
 */
import type { UpgradeDeps } from "./deps.ts";
import { upgradeRunner } from "./service.ts";

/**
 * 装配升级域。升级链**异步跑完**（落盘原语是 Promise 面），任何一步失败即抛出、apply 随之失败
 *——带半完成迁移的存储比不启动危险得多。调用方必须 await：不等待就等于让各域在迁移跑完之前
 * 去读存储。抛出的那一步不回写刻度，下次启动从同一步重跑。
 *
 * 为什么不是 export async function：注入面对账（verify-dir-imports 的 analyzeInjectionFaces）
 * 按 export function installXxx( 采点，async 前缀会让这条对账静默失明——签名保持同步形态、
 * 返回值是 Promise，判据面与调用方语义都不受影响。
 */
export function installUpgrade(deps: UpgradeDeps): Promise<void> {
  return upgradeRunner.install(deps);
}

/** 卸载升级域。只复位装配标记：升级链没有留下需要释放的东西——它写的是文件。 */
export function releaseUpgrade(): void {
  upgradeRunner.release();
}
