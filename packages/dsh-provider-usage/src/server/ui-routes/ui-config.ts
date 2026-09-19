/**
 * dsh-provider-usage — UI 配置读写路由（server/ui-routes 域 UI 配置块，
 * #768 D12 由 domain2/routes/ui.ts 迁入，零行为变更）。
 *
 * 本块回答「胶囊位置配置怎么读写」：GET 读内存权威，POST 归一化后串行写盘 +
 * 内存 + SSE 广播（广播扇出由组合根经 UiRoutesContext 注入，见 ./context.ts，
 * 本块只调用不实现）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  guardLoopbackMethod,
  readJsonBodyOutcome,
  writeJson,
} from "../../../../../shared/host-utils.js";
import { normalizeUiConfig, writeUiConfig } from "../../shared/interface.ts";
import type { UiRoutesContext } from "./context.ts";

export async function handleUiConfig(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
  const { statsService, uiConfig, broadcastUiConfigChanged } = context;

  if (req.method === "GET") {
    writeJson(res, 200, { ok: true, ui: uiConfig });
    return;
  }

  const outcome = await readJsonBodyOutcome(req);
  if (outcome.kind !== "json") return writeJson(res, 400, { error: "bad-json" });
  const body = outcome.value as Record<string, unknown>;

  const next = normalizeUiConfig(body);
  Object.assign(uiConfig, next);
  try {
    await writeUiConfig(statsService.historyRoot, uiConfig);
  } catch {
    return writeJson(res, 500, { error: "persist-failed" });
  }
  broadcastUiConfigChanged();
  writeJson(res, 200, { ok: true, ui: uiConfig });
}
