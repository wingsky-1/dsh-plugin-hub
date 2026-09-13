/** upgrade 域生命周期：装配期同步跑完升级链。链动的是磁盘上的文件（存储三个文件 + 配置文件的形态割接），
 * 存量配置的读取面由组合根以显式依赖注入，装配期即可同步读——不再有「等宿主服务就绪」那段回调。 */
import type { UpgradeDeps } from "../../deps.ts";
import { runUpgradeChain } from "../chain/index.ts";

/** 升级域：装配期一次，此后没有活要干。 */
class UpgradeRunner {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;

  /** 装配：先跑链。链在标记装配完成之前跑——它抛错时这次装配等于没发生，宿主重试装配才有机会重跑链（链是幂等的）。 */
  install(deps: UpgradeDeps): void {
    if (this.installed) throw new Error("dsh-notifier: upgrade 域只能装配一次");
    runUpgradeChain(deps);
    this.installed = true;
  }

  /** 卸载：本域没有需要释放的东西——它只写了文件。 */
  release(): void {
    this.installed = false;
  }
}

/** 本域唯一的装配实例：类不外放，外面 `new` 不出第二份升级流程。 */
export const upgradeRunner = new UpgradeRunner();
