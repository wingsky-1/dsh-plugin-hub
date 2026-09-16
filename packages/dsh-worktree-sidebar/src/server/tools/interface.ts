/**
 * tools 域对外契约：三个 agent 工具的注册与释放。
 *
 * 工具按 **agent 作用域**注册（每个 agent 自己的 `ctx.tools`），只在会话位于 git 仓库里时才装；
 * 会话不在仓库里就一个工具都不给——给了也只会每次都失败。
 *
 * 本文件只做收口：门面的物理定义在 `impl/service`。本域不对外提供能力（工具就是它的产物），
 * 门面因此只有装配与释放。
 */
import type { ToolsDeps } from "./deps.ts";
import { toolsService } from "./impl/service/index.ts";

/** 装配工具域（组合根在 `apply` 期调用一次）。重复装配是编程错误，当场抛错。 */
export function installTools(deps: ToolsDeps): void {
  toolsService.install(deps);
}

/** 卸载工具域，与 `installTools` 配对：退订 + 摘掉每个 agent 的工具（重复调用无害）。 */
export function releaseTools(): void {
  toolsService.release();
}
