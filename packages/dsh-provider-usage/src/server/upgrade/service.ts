/**
 * dsh-provider-usage — upgrade 域生命周期：装配期跑完升级链。链动的是磁盘上的文件，
 * 落盘原语是 Promise 面，故装配是异步的。
 */
import type { UpgradeDeps } from "./deps.ts";
import { runUpgradeChain } from "./chain/index.ts";

class UpgradeRunner {
  private installed = false;

  /** 装配：先跑链。链在标记装配完成之前跑——它抛错时这次装配等于没发生，宿主重试装配才有机会重跑链。 */
  async install(deps: UpgradeDeps): Promise<void> {
    if (this.installed) throw new Error("dsh-provider-usage: upgrade 域只能装配一次");
    await runUpgradeChain(deps);
    this.installed = true;
  }

  /** 卸载：本域没有需要释放的东西——它只写了文件。 */
  release(): void {
    this.installed = false;
  }
}

/** 本域唯一的装配实例：类不外放，外面 new 不出第二份升级流程。 */
export const upgradeRunner = new UpgradeRunner();
