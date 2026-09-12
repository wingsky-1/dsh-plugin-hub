/**
 * dsh-notifier api 域 —— 历史与频道状态端点。
 *
 * 两者都是「读持久事实」：历史是通知的流水，状态是各频道最近一次投递终态。滚动、
 * 按天过滤、损坏行跳过都由 stores 域兜住，本域只做形状转换。
 *
 * 依赖方向：只引用本目录与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { clearHistory, readHistory, readStatus } from "../../deps.ts";
import { sendJson } from "../route/index.ts";

/** GET /history：最近记录（截断与倒序由客户端做，它要的条数由界面决定）。 */
export async function readJournal(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { records: await readHistory() });
}

/** DELETE /history：清空，返回被清空条数。 */
export async function clearJournal(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { cleared: await clearHistory() });
}

/** GET /status：各频道最近一次投递终态。 */
export async function readChannelStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { channels: await readStatus() });
}
