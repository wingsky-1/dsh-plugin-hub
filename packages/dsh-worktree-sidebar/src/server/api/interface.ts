/**
 * api 域对外契约：**浏览器出口**。把宿主端的事实经 HTTP 送到页面。
 *
 * 本文件只做收口——单例与它的 `ApiInstance` 形状的物理定义都在 `impl/service`（形状不从门面转出：
 * 它是实现细节，转出就成了本域的第二张公开契约），围栏与端点注册在 `impl/route`，端点形状在 `impl/handlers`。
 * 本域不对外提供能力（端点就是它的产物），门面因此只有装配与释放。
 */
import type { ApiDeps } from "./deps.ts";
import { apiService } from "./impl/service/index.ts";

/** 装配浏览器出口（组合根在 `apply` 期调用一次）。重复装配是编程错误，当场抛错。 */
export function installApi(deps: ApiDeps): void {
  apiService.install(deps);
}

/** 摘掉全部路由，与 `installApi` 配对（重复调用无害）。 */
export function releaseApi(): void {
  apiService.release();
}
