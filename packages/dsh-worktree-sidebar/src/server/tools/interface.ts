/**
 * tools 域对外契约：三个 agent 工具的注册与释放。
 *
 * 工具按 **agent 作用域**注册（每个 agent 自己的 `ctx.tools`），只在会话位于 git 仓库里时才装；
 * 会话不在仓库里就一个工具都不给——给了也只会每次都失败。
 */
import type { ToolsDeps } from "./deps.ts";
import { createToolsService } from "./impl/service/index.ts";
import type { ToolsInstance } from "./impl/service/index.ts";

/** 装配工具域（组合根在 apply 期调用一次）。 */
export function createTools(deps: ToolsDeps): ToolsInstance {
  return createToolsService(deps);
}

export type { ToolsInstance } from "./impl/service/index.ts";
