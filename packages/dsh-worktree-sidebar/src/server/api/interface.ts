/**
 * api 域对外契约：**浏览器出口**。把宿主端的事实经 HTTP 送到页面；本域不判业务，也不写任何状态。
 *
 * 它是本插件唯一的浏览器入口，所以围栏（回环判定、方法判定、异常收口）也只有一份实现，
 * 少写一处就是多开一个洞。
 */
import type { ApiDeps } from "./deps.ts";
import { bindingsEndpoint, healthEndpoint } from "./impl/handlers/index.ts";
import { registerEndpoints } from "./impl/route/index.ts";

/** 已装配的域状态。未装配为 null。 */
let installed: { readonly dispose: Array<() => void> } | null = null;

/** 装配浏览器出口（组合根在 apply 期调用一次）。 */
export function installApi(deps: ApiDeps): void {
  if (installed !== null) throw new Error("dsh-worktree-sidebar: api 域已装配");
  installed = {
    dispose: registerEndpoints(
      deps.register,
      [bindingsEndpoint(deps.binding), healthEndpoint(deps.binding)],
      deps.logger,
    ),
  };
}

/** 卸载浏览器出口，与 `installApi` 配对：摘路由由本域自己收口。幂等。 */
export function releaseApi(): void {
  const current = installed;
  installed = null;
  if (current === null) return;
  for (const dispose of current.dispose) {
    try {
      dispose();
    } catch {
      // 卸载阶段不做失败上报：一个端点的摘除失败不该阻断其余，也不该掩盖首个异常。
    }
  }
}
