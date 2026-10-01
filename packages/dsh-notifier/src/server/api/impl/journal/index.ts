/**
 * api 域历史与频道状态端点。两者都是「读持久事实」：历史是通知的流水，状态是各频道最近一次投递
 * 终态；滚动、按天过滤、损坏行跳过都由 stores 域兜住，本域只做形状转换。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StorePort } from "../../deps.ts";
import { sendFailure, sendJson } from "../route/index.ts";
import type { RouteHandler } from "../route/type.ts";

/** 清空结果：不额外请 stores 域导出一个类型名，它的形状经能力面的签名可达。 */
type ClearOutcome = Awaited<ReturnType<StorePort["clearHistory"]>>;

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

  /**
   * DELETE /history：清空，返回被清空条数（键名 `removed` 是客户端锁定的契约）。
   *
   * 落盘失败回 503 而不是让它抛出去（#1016 残留 1）：抛错经 `route` 的失败出口转成 500，
   * 且 `error` 字段是 Node 错误原文（带 errno 与绝对路径），与 issue 验收「errno/路径不外送」
   * 直接冲突。端点层只回答「成没成 + 成了几条」。
   */
  readonly clear: RouteHandler = async (
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    respond(res, await this.stores.clearHistory());
  };

  /** GET /status：各频道最近一次投递终态。 */
  readonly readStatus: RouteHandler = async (
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    sendJson(res, 200, { ok: true, channels: await this.stores.readStatus() });
  };
}

/**
 * 清空结果 → 响应。成功体逐字不变（`ok` 与 `removed` 是客户端锁定的契约，改一个键名页面就整块空白）。
 *
 * 失败体是**固定文案**，不带 `written.reason`：那是 Node 的错误消息，形态是「EACCES: permission
 * denied, rename '/home/<用户>/.dsh/…' → '/home/<用户>/.dsh/…tmp'」，经端点外送即等于把宿主绝对
 * 路径交给浏览器——本仓只肯在日志出口说这句话。
 *
 * `code` 供**直接看响应体**的人与将来的客户端分流，**当前客户端并没有按它分流**：
 * `confirmClear` 的 DELETE 分支（`src/client/index.tsx:1508`）刻意不读响应体（理由见
 * `client/api-error.ts` 的 `markHttpFailure` 段：失败体未必是 JSON，解析它会把一条失败请求
 * 变成两条），于是用户实际看到的是「清空失败：HTTP 503」，`code` 到不了屏幕。改客户端去读
 * DELETE 的体是**另一个决策**，不在本次处置范围内。
 *
 * 它也不进 `refusal.ts`：那个闭集只管围栏拒答（回环 / 方法），把端点失败塞进去会被客户端的
 * `apiFailureOf` 误判成围栏拒绝、凭空弹出局域网引导。
 */
function respond(res: ServerResponse, result: ClearOutcome): void {
  if (result.ok) {
    sendJson(res, 200, { ok: true, removed: result.removed });
    return;
  }
  sendFailure(res, 503, { error: "历史记录服务不可用", code: "history-unavailable" });
}
