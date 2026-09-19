/**
 * ca 域对外承诺：一键生成本地 CA 的三态判定与 POST 动作装配。
 *
 * 本域回答「托管 CA/叶子从无到有、从旧到新」，tls 域回答「证书字节怎么签」，
 * config 域回答「什么算合法配置」——三者经 apply 装配层组合，域间无运行时
 * 直接值引用（deps.ts 注入面）。包导出面不收本域（host-trust #856 先例：
 * 实现细节只被包内 apply 消费；单测直连 src）。
 */
export type { CaActionDeps, CaConfigPort, CaCryptoPort, CaFsPort, CaUserSnapshot } from "./deps.ts";
export type { CaState, CaStateInput } from "./impl/state.ts";
export { classifyCaState, isManagedPath } from "./impl/state.ts";
export { buildCaActionRoutes } from "./impl/actions.ts";
export type { CaActionResult, CaPostBody } from "./impl/actions.ts";
