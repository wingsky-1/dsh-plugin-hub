/**
 * dsh-notifier api 域 —— 自检端点：发测试通知、报宿主平台。
 *
 * 测试通知走的是**同一条**裁决管线（`submit`），不另开旁路——否则「测试能响、真实事件
 * 不响」这类问题会被测试本身掩盖掉。
 *
 * 依赖方向：只引用本目录与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../route/index.ts";

/**
 * POST /test：造一条 `test` 通知交给裁决管线。
 *
 * 未实现。待填：读 `{channelId?}` → 组装请求 → `submit` → 回
 * `{ ok: true, sseConnections, results }`（客户端用 `sseConnections` 提示「服务端未
 * 释放句柄几条」，`results` 是逐频道受理结果）。带 channelId 时是「只发给这个频道」
 * 的定向测试，而 `NotifyRequest` 目前没有承载它的字段——定向属于裁决输入而不是事件
 * 陈述，落点待定，实现时再定。
 */
export async function sendTest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  void res;
  throw new Error("not implemented: api 测试通知");
}

/** GET /health：宿主平台。客户端据此写系统通道的平台提示——不能拿浏览器 OS 猜。 */
export function reportHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { ok: true, plugin: "dsh-notifier", platform: process.platform });
}
