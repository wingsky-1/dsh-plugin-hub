/** upgrade 域对外契约：**存储形态的版本迁移**（把磁盘上的数据逐版本推到当前代码认识的形态），它不认识通知业务。
 * 它必须在各域装配**之前**跑——先装配就等于让各域读到旧形态并带着它继续跑。 */
import type { UpgradeDeps } from "./deps.ts";
import { upgradeRunner } from "./impl/service/index.ts";

/** 装配升级域。升级链**同步跑完**（存储布局归位 + 配置形态割接），任何一步失败即抛出、`apply` 随之失败
 * ——带半完成迁移的存储比不启动危险得多。存量配置的读取面由组合根以显式依赖注入（宿主保证服务就绪才装配），
 * 所以割接在同一趟装配里完成，没有等待回调。抛出的那一步不回写刻度，下次启动从同一步重跑。 */
export function installUpgrade(deps: UpgradeDeps): void {
  upgradeRunner.install(deps);
}

/** 卸载升级域。只复位装配标记：升级链没有留下需要释放的东西——它写的是文件。 */
export function releaseUpgrade(): void {
  upgradeRunner.release();
}
