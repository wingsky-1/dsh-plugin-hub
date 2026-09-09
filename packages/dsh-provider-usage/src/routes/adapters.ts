/**
 * dsh-provider-usage — 适配器管理路由（GET /adapters.json, POST /adapters/select, inspect, add）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { guardLoopbackMethod, readJsonBody, writeJson } from "../../../../shared/host-utils.js";
import { ADAPTER_CONTRACT_VERSION } from "../contracts.ts";
import type { StatsService } from "../stats-service.ts";
import { loadUserAdapterChecked } from "../user-adapter-loader.ts";
import { resolveAddAdapterFile, type UserAdapterRecord } from "../user-adapters.ts";

export interface AdapterRoutesContext {
  ctx: Context;
  statsService: StatsService;
  ensureHotReload: (file: string) => Promise<void>;
}

export function handleAdapters(
  req: IncomingMessage,
  res: ServerResponse,
  context: AdapterRoutesContext,
): void {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { ctx, statsService } = context;
  const snap = statsService.registry.snapshot();

  let modelProviders: string[] = [];
  try {
    const llm = (ctx as { llm?: { listProviders?: () => unknown } }).llm;
    if (typeof llm?.listProviders === "function") {
      const listed = llm.listProviders();
      if (Array.isArray(listed)) {
        modelProviders = listed
          .map((i) => (i as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === "string" && id !== "");
      }
    }
  } catch {
    // 回落空数组
  }

  writeJson(res, 200, {
    version: ADAPTER_CONTRACT_VERSION,
    host: snap.infos.map((i) => ({
      name: i.name,
      label: i.label,
      providers: i.providers,
      source: i.source,
      file: i.file !== undefined ? basename(i.file) : null,
      enabled: i.enabled,
    })),
    enabled: snap.enabled,
    errors: snap.errors.map((e) => ({ key: e.key, at: e.at, kind: e.kind, message: e.message })),
    modelProviders,
  });
}

export async function handleSelect(
  req: IncomingMessage,
  res: ServerResponse,
  context: AdapterRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["POST"])) return;
  const { statsService } = context;

  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(req);
    if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
    body = raw as Record<string, unknown>;
  } catch {
    return writeJson(res, 400, { error: "bad-json" });
  }

  const provider = typeof body.provider === "string" ? body.provider : "";
  const clearing = body.adapterName === null;
  const adapterName = typeof body.adapterName === "string" ? body.adapterName : "";
  if (!clearing && (provider.length === 0 || adapterName.length === 0 || provider.length > 128 || adapterName.length > 128)) {
    return writeJson(res, 400, { error: "invalid provider/adapterName" });
  }

  const ok = statsService.registry.select(provider, clearing ? null : adapterName);
  if (!ok) return writeJson(res, 404, { error: "adapter not found" });

  statsService.purgeAllCaches();
  if (!clearing) statsService.warmupProviders([provider]);

  if (clearing) statsService.scheduleWriteAdapterState({ [provider]: null });
  else statsService.scheduleWriteAdapterState();

  writeJson(res, 200, { ok: true, provider, adapterName: clearing ? null : adapterName });
}

export async function handleInspect(
  req: IncomingMessage,
  res: ServerResponse,
  context: AdapterRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["POST"])) return;
  const { statsService } = context;

  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(req);
    if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
    body = raw as Record<string, unknown>;
  } catch {
    return writeJson(res, 400, { error: "bad-json" });
  }

  const file = resolveAddAdapterFile(body.file);
  if (file === undefined) {
    return writeJson(res, 400, { error: "invalid-file", detail: "文件不存在/不可读，或路径未规整（禁穿越）" });
  }

  const loaded = await loadUserAdapterChecked(file, statsService.registry);
  if (!loaded.ok) {
    return writeJson(res, 422, { error: loaded.code, detail: loaded.detail });
  }

  const { adapter } = loaded;
  writeJson(res, 200, {
    ok: true,
    adapter: { name: adapter.name, label: adapter.label ?? adapter.name, providers: adapter.providers, version: adapter.version },
    file: basename(file),
  });
}

export async function handleAdd(
  req: IncomingMessage,
  res: ServerResponse,
  context: AdapterRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["POST"])) return;
  const { statsService, ensureHotReload } = context;

  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(req);
    if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
    body = raw as Record<string, unknown>;
  } catch {
    return writeJson(res, 400, { error: "bad-json" });
  }

  const file = resolveAddAdapterFile(body.file);
  if (file === undefined) {
    return writeJson(res, 400, { error: "invalid-file", detail: "文件不存在/不可读，或路径未规整（禁穿越）" });
  }

  const loaded = await loadUserAdapterChecked(file, statsService.registry);
  if (!loaded.ok) {
    return writeJson(res, 422, { error: loaded.code, detail: loaded.detail });
  }

  const { adapter } = loaded;
  if (statsService.registry.hasName(adapter.name)) {
    return writeJson(res, 409, { error: "duplicate-name", detail: `适配器 name 已存在：${adapter.name}` });
  }

  if (!statsService.registry.register(adapter, "user-file", file)) {
    return writeJson(res, 422, { error: "invalid-adapter", detail: "契约校验失败（version/name/providers/fetchData/formatCapsule/formatPanel）" });
  }

  const rec: UserAdapterRecord = {
    id: adapter.name,
    label: adapter.label ?? adapter.name,
    providers: adapter.providers,
    file,
  };
  await statsService.persistUserAdapter(rec);
  await ensureHotReload(file);

  statsService.purgeAllCaches();
  statsService.warmupProviders(adapter.providers);
  statsService.scheduleWriteAdapterState();

  writeJson(res, 200, {
    ok: true,
    adapter: { name: adapter.name, label: adapter.label ?? adapter.name, providers: adapter.providers, file: basename(file) },
    enabled: statsService.registry.snapshot().enabled,
  });
}

export function createAdapterRoutes(
  routes: { adapters: string; select: string; inspect: string; add: string },
  context: AdapterRoutesContext,
): WebRoute[] {
  return [
    {
      kind: "exact",
      path: routes.adapters,
      handler: (req, res) => handleAdapters(req, res, context),
    },
    {
      kind: "exact",
      path: routes.select,
      handler: (req, res) => handleSelect(req, res, context),
    },
    {
      kind: "exact",
      path: routes.inspect,
      handler: (req, res) => handleInspect(req, res, context),
    },
    {
      kind: "exact",
      path: routes.add,
      handler: (req, res) => handleAdd(req, res, context),
    },
  ];
}
