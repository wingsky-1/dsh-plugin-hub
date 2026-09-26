/**
 * dsh-provider-usage — 适配器管理路由（GET /adapters.json, POST /adapters/select, inspect, add）。
 *
 * 加载校验与路径准入经 AdapterRoutesContext 注入（#768 B2：不直引 registry 门面值边；
 * 组合根已绑定 registry 实例，类型经门面以 type 复用）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import {
  guardLoopbackMethod,
  readJsonBodyOutcome,
  writeJson,
} from "../../../../../shared/host-utils.js";
import { ADAPTER_CONTRACT_VERSION, type UsageStatsAdapter } from "../../shared/interface.ts";
import type { StatsService } from "../pipeline/interface.ts";
import type { UserAdapterRecord } from "../registry/interface.ts";

export interface AdapterRoutesContext {
  ctx: Context;
  statsService: StatsService;
  ensureHotReload: (file: string) => Promise<void>;
  /**
   * 路径准入注入（#768 B2：不直引 registry 门面值边；组合根供给，禁穿越口径留 registry 域）。
   */
  resolveAdapterFile: (input: unknown) => string | undefined;
  /**
   * 加载校验注入（#768 B2：不直引 registry 门面值边；组合根已绑定 registry 实例）。
   */
  loadAdapterChecked: (
    file: string,
  ) => Promise<
    { ok: true; adapter: UsageStatsAdapter } | { ok: false; code: string; detail: string }
  >;
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

/** 选择请求的规范化结果（清空面与切换面共用同一形状；清空时 adapterName 为 null）。 */
interface SelectRequest {
  provider: string;
  adapterName: string | null;
  clearing: boolean;
}

/** provider/adapterName 长度上限（与 UI 契约同口径；超长即非法，不截断）。 */
const NAME_MAX = 128;

/**
 * 选择请求体解析与准入（纯函数）：adapterName 显式 null = 清空该 provider 的启用选择；
 * 切换面要求 provider 与 adapterName 双非空且双不超长，否则回落 400。
 */
export function parseSelectRequest(body: Record<string, unknown>): SelectRequest | null {
  const provider = typeof body.provider === "string" ? body.provider : "";
  const clearing = body.adapterName === null;
  const adapterName = typeof body.adapterName === "string" ? body.adapterName : "";
  if (clearing) return { provider, adapterName: null, clearing };
  if (provider.length === 0 || adapterName.length === 0) return null;
  if (provider.length > NAME_MAX || adapterName.length > NAME_MAX) return null;
  return { provider, adapterName, clearing };
}

/**
 * 落一次选择变更的副作用面（顺序即语义）：切换 → 清缓存 → 预热（清空面无 provider 可预热）
 * → 落盘启用选择（清空面写 null 键，其余写当前快照）。
 * 返回 false = 候选里没有该适配器（404），此时副作用一步都不执行。
 */
function applySelectRequest(statsService: StatsService, request: SelectRequest): boolean {
  const ok = statsService.registry.select(request.provider, request.adapterName);
  if (!ok) return false;

  statsService.purgeAllCaches();
  if (!request.clearing) statsService.warmupProviders([request.provider]);
  statsService.scheduleWriteAdapterState(
    request.clearing ? { [request.provider]: null } : undefined,
  );
  return true;
}

export async function handleSelect(
  req: IncomingMessage,
  res: ServerResponse,
  context: AdapterRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["POST"])) return;
  const { statsService } = context;

  const outcome = await readJsonBodyOutcome(req);
  if (outcome.kind !== "json") return writeJson(res, 400, { error: "bad-json" });
  const body = outcome.value as Record<string, unknown>;

  const request = parseSelectRequest(body);
  if (request === null) return writeJson(res, 400, { error: "invalid provider/adapterName" });

  if (!applySelectRequest(statsService, request)) {
    return writeJson(res, 404, { error: "adapter not found" });
  }

  writeJson(res, 200, { ok: true, provider: request.provider, adapterName: request.adapterName });
}

export async function handleInspect(
  req: IncomingMessage,
  res: ServerResponse,
  context: AdapterRoutesContext,
): Promise<void> {
  if (!guardLoopbackMethod(req, res, ["POST"])) return;

  const outcome = await readJsonBodyOutcome(req);
  if (outcome.kind !== "json") return writeJson(res, 400, { error: "bad-json" });
  const body = outcome.value as Record<string, unknown>;

  const file = context.resolveAdapterFile(body.file);
  if (file === undefined) {
    return writeJson(res, 400, {
      error: "invalid-file",
      detail: "文件不存在/不可读，或路径未规整（禁穿越）",
    });
  }

  const loaded = await context.loadAdapterChecked(file);
  if (!loaded.ok) {
    return writeJson(res, 422, { error: loaded.code, detail: loaded.detail });
  }

  const { adapter } = loaded;
  writeJson(res, 200, {
    ok: true,
    adapter: {
      name: adapter.name,
      label: adapter.label ?? adapter.name,
      providers: adapter.providers,
      version: adapter.version,
    },
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

  const outcome = await readJsonBodyOutcome(req);
  if (outcome.kind !== "json") return writeJson(res, 400, { error: "bad-json" });
  const body = outcome.value as Record<string, unknown>;

  const file = context.resolveAdapterFile(body.file);
  if (file === undefined) {
    return writeJson(res, 400, {
      error: "invalid-file",
      detail: "文件不存在/不可读，或路径未规整（禁穿越）",
    });
  }

  const loaded = await context.loadAdapterChecked(file);
  if (!loaded.ok) {
    return writeJson(res, 422, { error: loaded.code, detail: loaded.detail });
  }

  const { adapter } = loaded;
  if (statsService.registry.hasName(adapter.name)) {
    return writeJson(res, 409, {
      error: "duplicate-name",
      detail: `适配器 name 已存在：${adapter.name}`,
    });
  }

  if (!statsService.registry.register(adapter, "user-file", file)) {
    return writeJson(res, 422, {
      error: "invalid-adapter",
      detail: "契约校验失败（version/name/providers/fetchData/formatCapsule/formatPanel）",
    });
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
    adapter: {
      name: adapter.name,
      label: adapter.label ?? adapter.name,
      providers: adapter.providers,
      file: basename(file),
    },
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
