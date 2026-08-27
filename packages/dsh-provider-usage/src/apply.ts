/**
 * dsh-provider-usage — 插件挂载主流程（apply）与路由表（单一事实源）。
 *
 * #276 方案 A 阶段 3 拆分：自 index.ts 抽离，index.ts 仅 re-export（插件契约转发），
 * apply.ts 不 import index.ts（防循环）。导出面由 index.ts 转发保持不变
 * （外部消费者仍从 lib/index.js 导入）。
 *
 * 路由（loopback 围栏）：
 * - GET /api/dsh-provider-usage/stats  用量统计 + 胶囊 HTML
 * - GET /api/dsh-provider-usage/history 历史数据 + 面板 HTML
 * - GET /api/dsh-provider-usage/adapters.json 适配器候选元数据（设置页主列表同源）
 * - POST /api/dsh-provider-usage/adapters/select 切换/清空启用适配器
 * - POST /api/dsh-provider-usage/adapters/inspect 预览适配器文件（回显导出信息，不注册）
 * - POST /api/dsh-provider-usage/adapters/add 登记用户适配器文件（设置页承载，免手改配置）
 * - GET /api/dsh-provider-usage/health  健康检查 + 适配器快照
 * - GET/POST /api/dsh-provider-usage/ui-config 胶囊位置配置（读取/保存，保存后 SSE 广播）
 * - GET /api/dsh-provider-usage/events  SSE 事件通道（ui-config-changed 等，客户端即时热更新）
 */

import { writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, readJsonBody, errorMessage } from "../../../shared/host-utils.js";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import { Mutex } from "async-mutex";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ServerResponse } from "node:http";
import type { UsageStatsAdapter } from "./contracts.ts";
import { describeUsageStatsAdapterShape, ADAPTER_CONTRACT_VERSION } from "./contracts.ts";
import { makeAdapterRegistry } from "./registry.ts";
import { openCodeGoAdapter } from "./adapters/opencode-go.ts";
import { deepSeekOfficialAdapter } from "./adapters/deepseek-official.ts";
import { runV2Pipeline, runV2PanelPipeline, panelCacheKey, isPanelCacheStale, type V2PipelineResult, type PanelCacheEntry } from "./pipeline/v2.ts";
import { HistoryStore, migrateLegacyV3 } from "./core/history.ts";
import { resolveProviderConfig } from "./provider-config.ts";
import { HotReloadableAdapter } from "./hotreload.ts";
import { resolvePath } from "./path-resolve.ts";
import { Config, normalizeConfig } from "./config.ts";
import { normalizeUiConfig, readUiConfig, writeUiConfig, sseData } from "./ui-config.ts";
import { readAdapterStateResult, readUserAdapters, userAdaptersFile, writeAdapterState, resolveAddAdapterFile, type UserAdapterRecord } from "./user-adapters.ts";

export const ROUTES: Record<string, string> = {
  stats: "/api/dsh-provider-usage/stats",
  history: "/api/dsh-provider-usage/history",
  adapters: "/api/dsh-provider-usage/adapters.json",
  select: "/api/dsh-provider-usage/adapters/select",
  inspect: "/api/dsh-provider-usage/adapters/inspect",
  add: "/api/dsh-provider-usage/adapters/add",
  health: "/api/dsh-provider-usage/health",
  uiConfig: "/api/dsh-provider-usage/ui-config",
  events: "/api/dsh-provider-usage/events",
};

export async function apply(ctx: Context, rawConfig: Record<string, unknown> = {}): Promise<void> {
  if (rawConfig.enabled === false) return; // 显式禁用：不注册任何路由
  const config = normalizeConfig(rawConfig);
  const sanitizeDiagnostic = (s: string): string =>
    s.split(process.env.DSH_HOME ?? join(homedir(), ".dsh")).join("~/.dsh").split(homedir()).join("~");
  const registry = makeAdapterRegistry({
    sanitizePath: sanitizeDiagnostic,
  });
  const recordAdapterStateDiagnostic = (message: string): void => {
    // recordError 同时单次 console.warn 并写入 health 最近错误，避免双重日志。
    registry.recordError("adapter-state", "load", message);
  };

  // -------------------------------------------------------- 历史存储与持久化根
  const historyRoot = config.historyDir || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-provider-usage");
  const history = new HistoryStore({
    root: historyRoot,
    maxAgeMs: config.maxAgeDays * 86400000,
    maxSizeBytes: config.maxSizeMB * 1024 * 1024,
  });

  // 旧 v3 多文件桶 → 按天分片 JSONL 迁移（幂等；只迁移一次，旧文件 .bak 保留）
  try {
    const migrated = await migrateLegacyV3(historyRoot, history);
    if (migrated > 0) console.warn(`[dsh-provider-usage] 已迁移 ${migrated} 条旧 v3 历史采样到按天分片 JSONL`);
  } catch {
    /* 迁移失败不阻断启动（下次启动重试） */
  }

  // 1. 注册内置适配器（builtin 先注册、默认启用；user-file 清单后注册覆盖启用者）
  registry.register(openCodeGoAdapter, "builtin");
  // #198：内置 DeepSeek 官方余额适配器（name=deepseek-official-builtin，与用户已装
  // user-file 原型 deepseek-official 可共存，注册顺序覆盖语义见 F 组验收）
  registry.register(deepSeekOfficialAdapter, "builtin");

  // 2. 加载用户适配器（两来源：config.adapter 兼容声明 + 设置页登记的清单）
  async function loadUserHostAdapterFile(file: string): Promise<unknown> {
    const url = pathToFileURL(file).href;
    const mod = (await import(url)) as Record<string, unknown>;
    return mod.default ?? mod;
  }

  /** 加载 + 契约校验 + 注册（inspect / add / 启动加载共用）。 */
  async function loadUserAdapterChecked(
    file: string,
  ): Promise<{ ok: true; adapter: UsageStatsAdapter } | { ok: false; code: string; detail: string }> {
    let mod: unknown;
    try {
      mod = await loadUserHostAdapterFile(file);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      registry.recordError(`file:${basename(file)}`, "load", msg);
      return { ok: false, code: "adapter-load-failed", detail: msg };
    }
    const candidate = (mod ?? null) as unknown;
    const detail = describeUsageStatsAdapterShape(candidate);
    if (detail !== null) {
      registry.recordError(`file:${basename(file)}`, "load", `契约校验失败（${detail}），已拒收`);
      return { ok: false, code: "invalid-adapter", detail: `契约校验失败（${detail}）` };
    }
    return { ok: true, adapter: candidate as UsageStatsAdapter };
  }

  // config.adapter 兼容声明（可选）
  if (config.adapter !== "") {
    const resolved = resolvePath(config.adapter);
    if (resolved === undefined) {
      registry.recordError(`file:${basename(config.adapter)}`, "load", "文件不存在或不可读");
    } else {
      const loaded = await loadUserAdapterChecked(resolved);
      if (loaded.ok) registry.register(loaded.adapter, "user-file", resolved);
    }
  }

  // 设置页登记的清单（user-adapters.json）
  const userRecords = await readUserAdapters(historyRoot);
  for (const rec of userRecords) {
    const file = resolvePath(rec.file);
    if (file === undefined) {
      registry.recordError(`file:${basename(rec.file)}`, "load", "文件不存在或不可读");
      continue;
    }
    const loaded = await loadUserAdapterChecked(file);
    if (loaded.ok) registry.register(loaded.adapter, "user-file", file);
  }

  // 缓存（声明提前：热更新 onReload 回调依赖 cache，须在热更新块前就绪）
  const cache = new Map<string, V2PipelineResult>();

  // #105① /history 面板渲染缓存：key=provider+adapterName+自然日粒度归一化 range，
  // 值为 runV2PanelPipeline 返回值字符串层快照 {panelHtml,error,at}（绝不缓存 entries 中间层）。
  // 主失效 = append 落盘全清；select/add/热更新三挂点同清；PANEL_CACHE_TTL_MS 仅兜底。
  // 声明提前：与 cache 同理，热更新回调须可及。
  const panelCache = new Map<string, PanelCacheEntry>();

  // 胶囊位置 UI 配置（设置页读写；SSE 广播变更）
  const uiConfig = await readUiConfig(historyRoot);
  const sseClients = new Set<ServerResponse>();
  const broadcastUiConfigChanged = (): void => {
    const frame = sseData({ type: "ui-config-changed" });
    for (const res of sseClients) {
      try { res.write(frame); } catch { /* 忽略掉线连接 */ }
    }
  };

  // 启用选择落盘串行链 + 清单落盘串行链（连续写的完成顺序不依赖 IO 时序）
  // #212：声明提前至热更新块之前——hr.start() 的初始同步回调在 apply 尚未走完时即可触发，
  // 回调内 scheduleWriteAdapterState 必须已可及（let TDZ 防御，同 cache/panelCache 先例）。
  let stateChain: Promise<void> = Promise.resolve();
  /**
   * 启用关系落盘（串行链）。#212：以磁盘现状为基线合并——历史显式 null 停用标记得以保留，
   * 运行期有启用者的 provider 以运行期为准；override 仅 select 清空时用于显式写 null。
   * （此前直接落 snapshot().enabled 会把磁盘上的 null 停用标记抹掉，热更/登记挂点均受累。）
   */
  function scheduleWriteAdapterState(override?: Record<string, string | null>): void {
    stateChain = stateChain
      // persistUserAdapter 的失败会由其自身登记；这里先恢复串行链，保证后续状态写仍可重试。
      .catch(() => {})
      .then(async () => {
        const saved = await readAdapterStateResult(historyRoot, {
          diagnostic: recordAdapterStateDiagnostic,
        });
        if (saved.status === "unreadable") {
          throw new Error(`读取旧 adapter-state.json 失败（${saved.detail ?? "未知错误"}），为避免覆盖旧状态已取消写入`);
        }
        const merged: Record<string, string | null> = { ...saved.state };
        for (const [provider, name] of Object.entries(registry.snapshot().enabled)) merged[provider] = name;
        if (override !== undefined) Object.assign(merged, override);
        await writeAdapterState(
          historyRoot,
          merged,
          (message) => recordAdapterStateDiagnostic(sanitizeDiagnostic(message)),
        );
      })
      .catch((error: unknown) => {
        const detail = sanitizeDiagnostic(errorMessage(error));
        console.error(`[dsh-provider-usage] 启用选择落盘失败：${detail}`);
        registry.recordError("adapter-state", "load", `启用选择落盘失败：${detail}`);
      });
  }

  // 3. 热更新（config.adapter 声明 + 设置页登记的文件；autoReload=true 时生效）
  // 运行时经设置页 add 的适配器也纳入监视（issue #206）：ensureHotReload 供启动与
  // add 路由共用，watchedFiles 去重防同一文件重复监视。
  const hotReloaders: HotReloadableAdapter[] = [];
  const watchedFiles = new Set<string>();

  /** 为文件建立热更新监视（幂等：已监视/autoReload 关闭/路径不可解析则跳过）。 */
  async function ensureHotReload(file: string): Promise<void> {
    if (!config.autoReload) return;
    const resolved = resolvePath(file);
    if (resolved === undefined) return; // 文件不可读：add 已校验过，此处仅防御
    if (watchedFiles.has(resolved)) return; // 已监视，幂等跳过
    watchedFiles.add(resolved);
    const hr = new HotReloadableAdapter(resolved, 2000, (info) => {
      const key = `file:${basename(resolved)}`;
      if (!info.ok) {
        registry.recordError(key, "load", `热更新失败：${info.error ?? "未知错误"}`);
        return;
      }
      if (hr.current !== null) {
        // #120 缓存精准清前置：替换前先收集旧条目认领的 providers
        // （替换后旧条目即从注册表消失；snapshot().infos 已按 name/provider 去重）
        const oldProviders = registry.snapshot().infos
          .filter((i) => i.file === resolved)
          .flatMap((i) => i.providers);
        // #212：原子替换（冲突预检先行，撞名时旧条目保留并返回失败）；
        // 替换只更新代码不改写启用关系（enabled 保持语义在 registry.replaceByFile 内实现）
        const replaced = registry.replaceByFile(resolved, hr.current);
        if (!replaced.ok) {
          registry.recordError(key, "load", `热更新失败：${replaced.detail}`);
          return;
        }
        // #120 缓存精准清 + 预热：范围 = 旧条目 ∪ 新条目认领 providers 的并集
        // （覆盖改名/认领增减两种漂移），其余 provider 的缓存保持可用——
        // 消除「一次热更、全部 provider 首拉必冷」的全局冷取诱因；
        // 清后立即后台预热仍启用的 provider（fire-and-forget，不阻塞回调）。
        const touchedProviders = new Set(oldProviders);
        for (const p of hr.current.providers) touchedProviders.add(p);
        purgeCachesForProviders(touchedProviders);
        warmupProviders(touchedProviders);
        // #212：热更新结果持久化（合并语义落盘，保持后的启用关系写入 adapter-state.json）
        scheduleWriteAdapterState();
        console.warn(`[dsh-provider-usage] 热更新成功：${replaced.name}（${basename(resolved)}）`);
      }
    });
    const started = await hr.start();
    if (!started.ok && started.error !== undefined) {
      registry.recordError(`file:${basename(resolved)}`, "load", `热更新启动失败：${started.error}`);
    }
    hotReloaders.push(hr);
  }

  // #212：热更新监视初始化移至「adapter-state 恢复」之后——hr.start() 的初始同步回调
  // 会经 replaceByFile → scheduleWriteAdapterState 落盘，若先于恢复执行，会把「默认启用、
  // 尚未按持久化状态纠正」的中间态写进 adapter-state.json，与恢复逻辑产生竞态。

  // 4. 恢复持久化的启用选择（adapter-state.json；null = 显式清空）
  const savedEnabled = await readAdapterStateResult(historyRoot, {
    diagnostic: recordAdapterStateDiagnostic,
  });
  for (const [provider, name] of Object.entries(savedEnabled.state)) {
    const selected = registry.select(provider, name);
    if (!selected) {
      const safeProvider = JSON.stringify(provider.length > 128 ? `${provider.slice(0, 125)}...` : provider);
      const safeName = JSON.stringify(name === null || name.length <= 128 ? name : `${name.slice(0, 125)}...`);
      recordAdapterStateDiagnostic(
        `恢复启用选择失败：provider ${safeProvider} 保存的适配器 ${safeName} 不在当前候选中（可能文件缺失或加载失败），未改写当前启用关系`,
      );
    }
  }

  if (config.autoReload) {
    if (config.adapter !== "") {
      const cfgFile = resolvePath(config.adapter);
      if (cfgFile !== undefined) await ensureHotReload(cfgFile);
    }
    for (const rec of userRecords) {
      const f = resolvePath(rec.file);
      if (f !== undefined) await ensureHotReload(f);
    }
  }

  // 5. 互斥锁（缓存已在上方声明）——per-provider 粒度（issue #120）：
  // 消除全局单锁的跨 provider 队头阻塞，慢 provider 取数不再拖累其它 provider 的
  // /stats。锁按需惰性创建；卸载时逐锁 cancel 并清空 Map（见 effect 清理段）。
  const providerLocks = new Map<string, Mutex>();

  /** 取某 provider 的专用锁（不存在则建；Map 只增不减，量级 = 启用过的 provider 数）。 */
  function lockOf(provider: string): Mutex {
    let m = providerLocks.get(provider);
    if (m === undefined) {
      m = new Mutex();
      providerLocks.set(provider, m);
    }
    return m;
  }

  function cacheFresh(provider: string): V2PipelineResult | undefined {
    const entry = cache.get(provider);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.fetchedAt > config.cacheDurationMs) {
      cache.delete(provider);
      return undefined;
    }
    return entry;
  }

  /**
   * 按 provider 精准清除面板渲染缓存（#105① 主失效的精准化，issue #120）：
   * panelCache key 前缀 = `${provider}\u0000`（panelCacheKey 分隔符），前缀匹配即删。
   * 其余 provider 的面板缓存保持可用——消除「一处取数、全局清空」的首拉必冷诱因；
   * 主失效语义不变：仍是 append 落盘成功才清，TTL 仅兜底。
   */
  function purgePanelCacheForProvider(provider: string): void {
    const prefix = `${provider}\u0000`;
    for (const key of panelCache.keys()) {
      if (key.startsWith(prefix)) panelCache.delete(key);
    }
  }

  /**
   * 按 providers 并集精准清除 stats 缓存与面板渲染缓存（issue #120）。
   * 热更新挂点用：范围 = 新旧条目认领 providers 的并集（覆盖改名/认领变化），
   * 其余 provider 的缓存保持可用。
   */
  function purgeCachesForProviders(providers: Iterable<string>): void {
    for (const p of providers) {
      cache.delete(p);
      purgePanelCacheForProvider(p);
    }
  }

  /**
   * 后台预热指定 providers（fire-and-forget 铁律，issue #120）：一律 void 发起，
   * 绝不 await 进调用方关键路径，更不得在持锁临界区内 await 预热
   * （async-mutex 非可重入，违者自死锁）。仅预热当前有启用者的 provider，
   * 未启用者由 getStats 自身的 no-adapter/no-enabled-adapter 帧语义兜底，无需打扰。
   */
  function warmupProviders(providers: Iterable<string>): void {
    for (const p of providers) {
      if (registry.getEntry(p) !== undefined) void getStats(p).catch(() => {});
    }
  }

  /** 当前 provider 的启用适配器静态路径（config.staticPath 兜底）。 */
  function staticPathOf(provider: string): string {
    return config.staticPath;
  }

  // 5. 数据获取核心
  async function getStats(provider: string): Promise<V2PipelineResult> {
    const cached = cacheFresh(provider);
    if (cached !== undefined) return { ...cached, status: 'cached' };

    // issue #120 选型说明：per-provider 锁 + **锁内二次 cacheFresh 校验**
    // （而非 isLocked busy 短路），理由：
    // 1. 双重冷取防护等价——首个持锁者完成取数写缓存后，排队后继者在本校验点
    //    即命中返回，check-then-act 窗口被关闭；
    // 2. 数据质量更优——并发客户端拿到刚刷新的真数据帧而非 stale 占位帧，
    //    reason='busy' 语义随之废除（客户端按 stale 处理的特判不再需要）；
    // 3. 排队收敛在单 provider 内部——最坏 n×5s 仅限同一 provider 的并发请求，
    //    跨 provider 完全并行（全局锁队头阻塞已消除）。
    return lockOf(provider).runExclusive(async () => {
      const cachedInLock = cacheFresh(provider);
      if (cachedInLock !== undefined) return { ...cachedInLock, status: 'cached' };

      const entry = registry.getEntry(provider);
      if (entry === undefined) {
        const code = registry.hasCandidates(provider) ? "no-enabled-adapter" : "no-adapter";
        const result: V2PipelineResult = {
          ok: false, configured: false, reason: code, error: null,
          fetchedAt: Date.now(), provider, adapterName: provider, status: 'stale',
        };
        cache.set(provider, result);
        return result;
      }

      const providerConfig = await resolveProviderConfig(provider, ctx, {
        apiEndpoint: config.apiEndpoint || undefined,
        apiKey: config.apiKey || undefined,
      });

      const result = await runV2Pipeline({
        adapter: entry.adapter,
        provider,
        config: { apiEndpoint: providerConfig.apiEndpoint, apiKey: providerConfig.apiKey },
        staticPath: staticPathOf(provider),
        timeoutMs: config.fetchTimeoutMs,
      });

      // 落盘历史（成功时）
      if (result.ok && result.status === 'fresh' && result.rawData !== undefined) {
        const historyEntry = { time: result.fetchedAt, data: result.rawData };
        await history.append(provider, entry.name, historyEntry).catch(() => {});
        // #105① 主失效（#120 精准化）：新数据已落盘，该 provider 的 /history
        // 面板渲染缓存清除（其余 provider 不受牵连；TTL 仅兜底）。
        // 注意 stats 自身 TTL 命中期间不重跑本路径，故主失效实际由
        // warmup 周期 × stats TTL 复合门控（命中率按复合周期评估）。
        purgePanelCacheForProvider(provider);
      }

      cache.set(provider, result);
      return result;
    });
  }

  // 6. 清单落盘串行链（stateChain 声明提前至热更新块前，见 #212 注释）
  async function persistUserAdapter(rec: UserAdapterRecord): Promise<void> {
    const write = async (): Promise<void> => {
      const list = await readUserAdapters(historyRoot);
      if (list.some((r) => r.id === rec.id)) return; // 幂等：已登记不再追加
      list.push(rec);
      const tmp = `${userAdaptersFile(historyRoot)}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, adapters: list }), { mode: 0o600 });
      await rename(tmp, userAdaptersFile(historyRoot));
    };
    try {
      await (stateChain = stateChain.then(write));
    } catch (e: unknown) {
      registry.recordError("user-adapters", "load", `清单落盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 7. 路由注册
  const statsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.stats,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const prov = url.searchParams.get("provider") ?? config.provider;
      const result = await getStats(prov);
      writeJson(res, 200, {
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        provider: result.provider,
        adapterName: result.adapterName,
        status: result.status,
        capsuleHtml: result.capsuleHtml,
        ok: result.ok,
        configured: result.configured,
        reason: result.reason,
        error: result.error,
        fetchedAt: result.fetchedAt,
        adapterVersion: 0,
      });
    },
  };

  const historyRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const prov = url.searchParams.get("provider") ?? config.provider;
      const entry = registry.getEntry(prov);
      if (entry === undefined) {
        // 无启用适配器：返回结构化 reason（不带占位 HTML），客户端据此展示引导 + 复制按钮
        const code = registry.hasCandidates(prov) ? "no-enabled-adapter" : "no-adapter";
        return writeJson(res, 200, {
          ok: false, plugin: "dsh-provider-usage", version: ADAPTER_CONTRACT_VERSION,
          provider: prov, adapterName: null, panelHtml: null, error: null, reason: code,
          range: { start: 0, end: 0 },
        });
      }
      const days = Number(url.searchParams.get("days"));
      const end = Date.now();
      const start = Number.isFinite(days) && days > 0
        ? end - Math.min(Math.round(days), config.maxAgeDays) * 86400000
        : end - 86400000;
      // #105① 渲染缓存命中检查：key 不含漂移时间戳（自然日粒度归一化），
      // 同一自然日窗口内重复请求直接回放缓存快照，响应 range 仍回显真实 start/end
      const cacheKey = panelCacheKey(prov, entry.name, { start, end });
      const hitEntry = panelCache.get(cacheKey);
      if (hitEntry !== undefined && !isPanelCacheStale(hitEntry, Date.now())) {
        return writeJson(res, 200, {
          ok: hitEntry.error === undefined,
          plugin: "dsh-provider-usage",
          version: ADAPTER_CONTRACT_VERSION,
          provider: prov,
          adapterName: entry.name,
          panelHtml: hitEntry.panelHtml,
          error: hitEntry.error ?? null,
          range: { start, end },
        });
      }
      panelCache.delete(cacheKey); // TTL 过期条目顺手清除（防御性，与 stats cacheFresh 同款）
      const result = await runV2PanelPipeline({
        adapter: entry.adapter,
        provider: prov,
        history,
        range: { start, end },
        timeoutMs: config.fetchTimeoutMs,
      });
      // #105① 只缓存成功结果：错误响应不入缓存（条件消除后下一次立即重算）；
      // 无适配器分支在上方提前返回、同样不入缓存；缓存值仅为返回值字符串层
      if (result.error === undefined) {
        panelCache.set(cacheKey, { panelHtml: result.panelHtml, error: result.error, at: Date.now() });
      }
      writeJson(res, 200, {
        ok: result.error === undefined,
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        provider: prov,
        adapterName: entry.name,
        panelHtml: result.panelHtml,
        error: result.error ?? null,
        range: { start, end },
      });
    },
  };

  const healthRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const snap = registry.snapshot();
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        provider: config.provider,
        cacheSize: cache.size,
        adapters: snap.infos.map((i) => ({ name: i.name, label: i.label, providers: i.providers, source: i.source, enabled: i.enabled, file: i.file !== undefined ? basename(i.file) : undefined })),
        enabled: snap.enabled,
        errors: snap.errors,
        historyDir: historyRoot,
      });
    },
  };

  /** 适配器元数据路由（设置页主列表同源）。 */
  const adaptersRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.adapters,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const snap = registry.snapshot();
      // 模型配置页提供商路由（设置页主列表同源）
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
      } catch { /* 回落空数组 */ }
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
    },
  };

  /** 切换启用适配器（POST）。adapterName 显式 null = 清空该 provider 启用项。 */
  const selectRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.select,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
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
      const ok = registry.select(provider, clearing ? null : adapterName);
      if (!ok) return writeJson(res, 404, { error: "adapter not found" });
      cache.clear();
      panelCache.clear(); // #105①：启用关系已变，面板渲染缓存同清（切换/清空后一律重算）
      // #120：清后立即后台预热该 provider 的启用适配器（fire-and-forget），
      // 运行中才启用的 provider 不必等下一次 warmup 周期才热身；清空（clearing）不预热
      if (!clearing) warmupProviders([provider]);
      // #212：清空用 override 显式落 null（合并语义会保留磁盘旧值，无法表达显式停用）
      if (clearing) scheduleWriteAdapterState({ [provider]: null });
      else scheduleWriteAdapterState();
      writeJson(res, 200, { ok: true, provider, adapterName: clearing ? null : adapterName });
    },
  };

  /** 预览适配器文件（POST）：加载 + 契约校验，回显导出信息（name/label/providers），不注册。 */
  const inspectRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.inspect,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
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
      const loaded = await loadUserAdapterChecked(file);
      if (!loaded.ok) {
        return writeJson(res, 422, { error: loaded.code, detail: loaded.detail });
      }
      const { adapter } = loaded;
      writeJson(res, 200, {
        ok: true,
        adapter: { name: adapter.name, label: adapter.label ?? adapter.name, providers: adapter.providers, version: adapter.version },
        file: basename(file),
      });
    },
  };

  /** 登记用户适配器（POST）：设置为页承载，免手改配置文件。 */
  const addRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.add,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
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
      const loaded = await loadUserAdapterChecked(file);
      if (!loaded.ok) {
        return writeJson(res, 422, { error: loaded.code, detail: loaded.detail });
      }
      const { adapter } = loaded;
      if (registry.hasName(adapter.name)) {
        return writeJson(res, 409, { error: "duplicate-name", detail: `适配器 name 已存在：${adapter.name}` });
      }
      if (!registry.register(adapter, "user-file", file)) {
        return writeJson(res, 422, { error: "invalid-adapter", detail: "契约校验失败（version/name/providers/fetchData/formatCapsule/formatPanel）" });
      }
      // 持久化清单 + 热注册默认成为该 provider 启用者
      const rec: UserAdapterRecord = {
        id: adapter.name,
        label: adapter.label ?? adapter.name,
        providers: adapter.providers,
        file,
      };
      await persistUserAdapter(rec);
      // issue #206：运行时 add 的适配器也纳入热更新监视（autoReload 开启时）
      await ensureHotReload(file);
      cache.clear();
      panelCache.clear(); // #105①：候选/启用面已变，面板渲染缓存同清
      // #120：清后立即后台预热新适配器认领的 providers（fire-and-forget；
      // warmupProviders 内部只预热当前有启用者的 provider，未启用者自动跳过）
      warmupProviders(adapter.providers);
      scheduleWriteAdapterState(); // #212：合并语义落盘（保留磁盘 null 停用标记）
      writeJson(res, 200, {
        ok: true,
        adapter: { name: adapter.name, label: adapter.label ?? adapter.name, providers: adapter.providers, file: basename(file) },
        enabled: registry.snapshot().enabled,
      });
    },
  };

  // 7b. 胶囊位置配置（GET 读取 / POST 保存，保存后 SSE 广播即时热更新）
  const uiConfigRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.uiConfig,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method === "GET") {
        writeJson(res, 200, { ok: true, ui: uiConfig });
        return;
      }
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      let body: Record<string, unknown>;
      try {
        const raw = await readJsonBody(req);
        if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
        body = raw as Record<string, unknown>;
      } catch {
        return writeJson(res, 400, { error: "bad-json" });
      }
      const next = normalizeUiConfig(body);
      Object.assign(uiConfig, next);
      try {
        await writeUiConfig(historyRoot, uiConfig);
      } catch {
        return writeJson(res, 500, { error: "persist-failed" });
      }
      broadcastUiConfigChanged();
      writeJson(res, 200, { ok: true, ui: uiConfig });
    },
  };

  // 7c. SSE 事件通道（客户端 EventSource 订阅；配置变更广播 ui-config-changed，内容不随帧传输）
  const eventsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
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
    },
  };

  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = [statsRoute, historyRoute, healthRoute, adaptersRoute, selectRoute, inspectRoute, addRoute, uiConfigRoute, eventsRoute].map((route) =>
        ctx.webServer.register(route),
      );
      return () => {
        for (const dispose of routeDisposers) {
          try { dispose(); } catch { /* 忽略 */ }
        }
      };
    },
    "dsh-provider-usage: routes",
  );

  // 8. 后台预热定时器（保持历史连续；无客户端访问时兜底）
  let warmupTimer: ReturnType<typeof setInterval> | null = null;
  if (config.warmupIntervalMs > 0) {
    // #156 重评估（issue #120 per-provider 锁落地后）：原「必须串行 await」的
    // 前提已消失——各 provider 持各自专用互斥锁，并行发起既不会互相 busy 短路，
    // 也不会队头阻塞；串行循环反而让慢 provider 拖延后续 provider 的采样起点。
    // 预热铁律（issue #120）：一律 void fire-and-forget，禁止持锁临界区内 await
    // 预热（async-mutex 非可重入，违者自死锁）；单 provider 失败静默——错误帧
    // 已写入 stats 缓存，客户端按 stale 呈现，无需额外处理。
    const warmupFn = (): void => {
      for (const provider of registry.enabledProviders()) {
        void getStats(provider).catch(() => {});
      }
    };
    warmupTimer = setInterval(warmupFn, config.warmupIntervalMs);
    (warmupTimer as { unref?: () => void }).unref?.();
    // 启动时立即预热一次（所有启用 provider）
    warmupFn();
  }

  // 8.5 历史留存清理定时器（#105②：prune 移出 append 热路径，独立周期扫描全树）
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  const PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分钟一次全树扫描（写入有界、定期收敛）
  pruneTimer = setInterval(() => {
    void history.pruneAll().catch((err) => console.warn("[dsh-provider-usage] 历史留存清理失败:", err));
  }, PRUNE_INTERVAL_MS);
  (pruneTimer as { unref?: () => void }).unref?.();

  // 9. 设置面板命名空间（只读镜像；apiKey 不进 schema 避免回显）
  installSettingsNamespace(ctx, "dsh-provider-usage", Config, rawConfig, {
    setSource: () => {},
    onChange: () => {},
  });

  // 10. 卸载清理
  ctx.effect(
    () => () => {
      disposeRoutes();
      if (warmupTimer !== null) clearInterval(warmupTimer);
      if (pruneTimer !== null) clearInterval(pruneTimer);
      for (const hr of hotReloaders) hr.stop();
      for (const res of sseClients) {
        try { res.end(); } catch { /* 忽略 */ }
      }
      sseClients.clear();
      cache.clear();
      panelCache.clear(); // #105①：卸载时面板渲染缓存一并释放
      // #120：per-provider 锁逐个 cancel（排队中的 runExclusive 以 cancelled 拒绝；
      // HTTP handler 直调 await getStats 无 catch，rejection 由宿主路由层兜底，
      // 预热/后台调用点自带 .catch 吞掉）并清空 Map，避免卸载后残留锁对象
      for (const lock of providerLocks.values()) lock.cancel();
      providerLocks.clear();
    },
    "dsh-provider-usage",
  );
}
