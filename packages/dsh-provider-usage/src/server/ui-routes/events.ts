/**
 * dsh-provider-usage — SSE 事件通道（server/ui-routes 域 SSE 块，
 * #768 D12 由 domain2/routes/ui.ts 迁入，零行为变更）。
 *
 * 本块回答「事件通道怎么开关」：连通帧 + 注册 + close 移除。通道是非可靠的——
 * 断线期间的广播帧直接丢失，重连只收新连通帧、无补帧（重连语义见 e2e
 * smoke「events 非可靠」用例；补帧出口不存在，由组合根测试的块出口清单锁定）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  admitLongLivedRequest,
  bindPeerLifecycle,
  writeJson,
} from "../../../../../shared/host-utils.js";
import type { UiRoutesContext } from "./context.ts";

export function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): void {
  const admission = admitLongLivedRequest(req, {
    remotePeerAdmission: context.remotePeerAdmission,
  });
  if ("rejection" in admission) {
    writeJson(res, admission.rejection, {
      error: admission.rejection === 401 ? "unauthorized" : "forbidden: loopback-only",
    });
    return;
  }
  if (req.method !== "GET") {
    writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    return;
  }
  const { sseClients } = context;

  let closed = false;
  let responseClosed = false;
  let peerEnded = false;
  let disposePeer: (() => void) | undefined;
  const removeStream = (): void => {
    if (closed) return;
    closed = true;
    sseClients.delete(res);
  };
  const closeForPeer = (): void => {
    removeStream();
    if (responseClosed) return;
    if (!res.writableEnded && !res.destroyed) res.destroy();
  };
  res.on("close", () => {
    responseClosed = true;
    removeStream();
    const dispose = disposePeer;
    disposePeer = undefined;
    if (!peerEnded) dispose?.();
  });
  if (admission.peer !== undefined) {
    try {
      disposePeer = bindPeerLifecycle(
        admission.peer,
        () => {
          peerEnded = true;
          closeForPeer();
        },
        "dsh-provider-usage: raw SSE bound to admitted Peer",
      );
    } catch {
      if (!res.headersSent) writeJson(res, 403, { error: "forbidden: peer-unavailable" });
      return;
    }
  }

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
