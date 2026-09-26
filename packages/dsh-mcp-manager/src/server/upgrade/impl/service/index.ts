/** upgrade 域生命周期：装配期跑完升级链。链动的是磁盘上的文件，落盘原语是 Promise 面，故装配是异步的。 */
import type { UpgradeDeps } from "../../deps.ts";
import {
  createUpgradeRunner,
  type UpgradeRunner,
} from "../../../../../../../shared/upgrade-chain.js";
import { runUpgradeChain } from "../chain/index.ts";

/**
 * 本域唯一的装配实例：类不外放，外面 `new` 不出第二份升级流程。标记（只能装配一次 / 卸载复位）
 * 由共享 runner 持有，它在**链跑成功之后**才置位——链抛错时这次装配等于没发生，宿主重试装配才有
 * 机会重跑链（链是幂等的，重跑不会累积归档名、也不会拿旧文件盖回目标）。
 */
export const upgradeRunner: UpgradeRunner<UpgradeDeps> = createUpgradeRunner(
  "dsh-mcp-manager",
  runUpgradeChain,
);
