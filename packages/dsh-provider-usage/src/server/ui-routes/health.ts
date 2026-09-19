/**
 * dsh-provider-usage — 健康检查路由（server/ui-routes 域健康块，
 * #768 D12 由 domain2/routes/ui.ts 迁入，零行为变更）。
 *
 * 本块回答「系统健康吗」：适配器快照 + 域2每层错误面（aggregate/schedule/execute
 * 三层计数 + 最近 N 条，经 UiRoutesContext.layerErrors 注入读取，见 ./context.ts）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { guardLoopbackMethod, writeJson } from "../../../../../shared/host-utils.js";
import { ADAPTER_CONTRACT_VERSION } from "../../shared/interface.ts";
import type { UiRoutesContext } from "./context.ts";

export function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): void {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { statsService, trend } = context;
  const snap = statsService.registry.snapshot();

  writeJson(res, 200, {
    ok: true,
    plugin: "dsh-provider-usage",
    version: ADAPTER_CONTRACT_VERSION,
    provider: statsService.config.provider,
    cacheSize: statsService.cacheSize(),
    adapters: snap.infos.map((i) => ({
      name: i.name,
      label: i.label,
      providers: i.providers,
      source: i.source,
      enabled: i.enabled,
      file: i.file !== undefined ? basename(i.file) : undefined,
    })),
    enabled: snap.enabled,
    errors: snap.errors,
    historyDir: statsService.historyRoot,
    // 域2每层错误面：aggregate/schedule/execute 三层计数 + 最近 N 条；
    // 与 errors（域1 适配器最近一次登记）并列，字段风格一致（camelCase 平铺）。
    layerErrors: context.layerErrors.snapshot(),
    trend: trend.stats(),
  });
}
