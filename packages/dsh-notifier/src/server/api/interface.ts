/**
 * dsh-notifier api 域 —— **对外契约**。
 *
 * ## 职责边界
 *
 * **浏览器出口**：把宿主端的事实经 HTTP 与 SSE 送到页面，并把页面提交的设置写回去。
 * 本域不判业务——要发什么由裁决管线决定，设置合不合法由设置域校验，它只负责把请求
 * 翻译成域动作、把结果翻译成响应。
 *
 * 它是**唯一**的浏览器入口：读设置、写设置、看历史、看频道状态、发测试通知全部经过
 * 这里。因此围栏也集中在这里——回环判定、方法判定、异常收口只有一份实现，少写一处
 * 就是多开一个洞。
 *
 * ## 为什么 SSE 的序号与补拉在本域
 *
 * 共享层的 SSE 枢纽只管连接表、心跳与上限淘汰，它的契约明写「?since 补拉（notifier
 * 路由层行为）不进 hub，广播负载生成留调用方」。序号是**本插件的**语义：客户端靠它
 * 去重与断线补拉，重启后还要接着数，所以它落在本域并持久化。
 *
 * ## 依赖方向
 *
 * 只引本域 `./impl/`（契约调实现）与 `./deps.ts`（依赖声明）；不引任何他域实现。
 */
import type { ApiDeps } from "./deps.ts";
import { apiService } from "./impl/service/index.ts";

/**
 * 装配浏览器出口（组合根在 `apply` 期调用一次）。
 */
export function installApi(deps: ApiDeps): void {
  apiService.install(deps);
}

/**
 * 卸载浏览器出口（组合根在卸载期调用）。
 *
 * 与 `installApi` 配对：摘路由、关连接、停心跳，全部由本域自己收口。
 */
export function releaseApi(): void {
  apiService.release();
}
