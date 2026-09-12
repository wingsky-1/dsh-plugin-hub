/**
 * api 域历史与频道状态端点。两者都是「读持久事实」：历史是通知的流水，状态是各频道最近一次投递
 * 终态；滚动、按天过滤、损坏行跳过都由 stores 域兜住，本域只做形状转换。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StorePort } from "../../deps.ts";
import { sendJson } from "../route/index.ts";
import type { RouteHandler } from "../route/type.ts";

/** 历史与状态端点。能力在装配期接上，此后每个请求只读实例字段。 */
export class JournalEndpoints {
  constructor(private readonly stores: StorePort) {}

  /** GET /history：最近记录（截断与倒序由客户端做，它要的条数由界面决定）。 */
  readonly read: RouteHandler = async (
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    sendJson(res, 200, { ok: true, records: await this.stores.readHistory() });
  };

  /** DELETE /history：清空，返回被清空条数（键名 `removed` 是客户端锁定的契约）。 */
  readonly clear: RouteHandler = async (
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    sendJson(res, 200, { ok: true, removed: await this.stores.clearHistory() });
  };

  /** GET /status：各频道最近一次投递终态。 */
  readonly readStatus: RouteHandler = async (
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    sendJson(res, 200, { ok: true, channels: await this.stores.readStatus() });
  };
}
