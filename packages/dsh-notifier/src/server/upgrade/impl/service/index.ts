/**
 * upgrade 域生命周期：装配期跑完升级链。链动的是磁盘上的文件（存储三个文件 + 配置文件的形态割接），
 * 存量配置的读取面由组合根以显式依赖注入，装配期即可读——不再有「等宿主服务就绪」那段回调。
 *
 * 装配器本身在共享层（重复装配抛错、链抛错时不置标记、卸载复位三件事同构），本域只提供 label 与链。
 */
import { createUpgradeRunner } from "../../../../../../../shared/upgrade-chain.js";
import type { UpgradeDeps } from "../../deps.ts";
import { runUpgradeChain } from "../chain/index.ts";

/** 本域唯一的装配实例：闭包持有「已装配」标记，外面拿不到第二份升级流程。 */
export const upgradeRunner = createUpgradeRunner<UpgradeDeps>("dsh-notifier", runUpgradeChain);
