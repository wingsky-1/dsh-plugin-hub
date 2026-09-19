/**
 * dsh-provider-usage — SSE 事件通道（server/ui-routes 域 SSE 块，
 * #768 D12 由 domain2/routes/ui.ts 迁入，零行为变更）。
 *
 * 本块回答「事件通道怎么开关」：连通帧 + 注册 + close 移除。通道是非可靠的——
 * 断线期间的广播帧直接丢失，重连只收新连通帧、无补帧（重连语义见 e2e
 * smoke「events 非可靠」用例；补帧出口不存在，由组合根测试的块出口清单锁定）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { guardLoopbackMethod } from "../../../../../shared/host-utils.js";
import type { UiRoutesContext } from "./context.ts";

export function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): void {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { sseClients } = context;

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  sseClients.add(res);
  res.on("close", () => {
    sseClients.delete(res);
  });
}
