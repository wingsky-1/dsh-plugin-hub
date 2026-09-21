/** api 域实现：装配（端点表 + 围栏注册；无状态，释放器由调用方持有）。 */
import type { ApiDeps } from "../deps.ts";
import { buildEndpoints } from "./handlers.ts";
import type { RegisterRoute } from "./route.ts";
import { registerEndpoints } from "./route.ts";

/** 装配浏览器出口（组合根在 apply 期调用一次；返回摘除器）。 */
export function installApi(deps: ApiDeps): (() => void)[] {
  return registerEndpoints(
    deps.register as unknown as RegisterRoute,
    buildEndpoints(deps),
    deps.logger,
  );
}
