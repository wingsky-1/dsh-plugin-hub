/**
 * dsh-provider-usage — 用户适配器加载与校验纯函数。
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { UsageStatsAdapter } from "../../shared/interface.ts";
import { describeUsageStatsAdapterShape } from "../../shared/interface.ts";
import type { AdapterRegistry } from "./registry.ts";

export async function loadUserHostAdapterFile(file: string): Promise<unknown> {
  const url = pathToFileURL(file).href;
  const mod = (await import(url)) as Record<string, unknown>;
  return mod.default ?? mod;
}

/** 加载 + 契约校验（inspect / add / 启动加载共用）。 */
export async function loadUserAdapterChecked(
  file: string,
  registry?: AdapterRegistry,
): Promise<{ ok: true; adapter: UsageStatsAdapter } | { ok: false; code: string; detail: string }> {
  let mod: unknown;
  try {
    mod = await loadUserHostAdapterFile(file);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (registry) registry.recordError(`file:${basename(file)}`, "load", msg);
    return { ok: false, code: "adapter-load-failed", detail: msg };
  }
  const candidate = (mod ?? null) as unknown;
  const detail = describeUsageStatsAdapterShape(candidate);
  if (detail !== null) {
    if (registry) registry.recordError(`file:${basename(file)}`, "load", `契约校验失败（${detail}），已拒收`);
    return { ok: false, code: "invalid-adapter", detail: `契约校验失败（${detail}）` };
  }
  return { ok: true, adapter: candidate as UsageStatsAdapter };
}
