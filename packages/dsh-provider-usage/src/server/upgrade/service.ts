/**
 * dsh-provider-usage — upgrade 域生命周期：装配期跑完升级链。链动的是磁盘上的文件，
 * 落盘原语是 Promise 面，故装配是异步的。
 *
 * 装配器本体（重复装配即抛、链跑成功后才置标记、release 复位）归 shared 的
 * createUpgradeRunner：同一套语义在三个包里逐字重复过，本域不再留第二份实现。
 */
import { createUpgradeRunner } from "../../../../../shared/upgrade-chain.js";
import type { UpgradeDeps } from "./deps.ts";
import { runUpgradeChain } from "./chain/index.ts";

/** 本域唯一的装配实例：实现由共享层持有，外面 new 不出第二份升级流程。 */
export const upgradeRunner = createUpgradeRunner<UpgradeDeps>(
  "dsh-provider-usage",
  runUpgradeChain,
);
