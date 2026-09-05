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
 * - GET/POST /api/dsh-provider-usage/report-config 报告配置（读/写，#503 M3）
 * - GET /api/dsh-provider-usage/reports  报告历史索引（index.jsonl 倒序）
 * - GET /api/dsh-provider-usage/reports/detail  报告详情（已净化 HTML + 元数据）
 * - POST /api/dsh-provider-usage/reports/generate  手动生成指定周期报告
 */

import { writeFile, rename, readFile, appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { guardLoopbackMethod, writeJson, readJsonBody, errorMessage, sseData } from "../../../shared/host-utils.js";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import { dshHome } from "../../../shared/dsh-home.js";
import { Mutex } from "async-mutex";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ServerResponse } from "node:http";
import type { UsageStatsAdapter } from "./contracts.ts";
import { describeUsageStatsAdapterShape, ADAPTER_CONTRACT_VERSION } from "./contracts.ts";
import { makeAdapterRegistry } from "./registry.ts";
// 内置适配器 #215 mjs 化：以 .mjs 为权威实现（配 .d.mts 类型声明，经 index re-export 供 TS 消费）
import { openCodeGoAdapter } from "./adapters/opencode-go.mjs";
import { deepSeekOfficialAdapter } from "./adapters/deepseek-official.mjs";
import { zaiCodingCnAdapter } from "./adapters/zai-coding-cn.mjs";
import { runV2Pipeline, runV2PanelPipeline, panelCacheKey, isPanelCacheStale, type V2PipelineResult, type PanelCacheEntry } from "./pipeline/v2.ts";
import { HistoryStore, migrateLegacyV3 } from "./core/history.ts";
import { resolveProviderConfig } from "./provider-config.ts";
import { HotReloadableAdapter } from "./hotreload.ts";
import { resolvePath } from "./path-resolve.ts";
import { Config, normalizeConfig } from "./config.ts";
import { normalizeUiConfig, readUiConfig, writeUiConfig } from "./ui-config.ts";
import { readAdapterStateResult, readUserAdapters, userAdaptersFile, writeAdapterState, resolveAddAdapterFile, type UserAdapterRecord } from "./user-adapters.ts";
import { escHtml, dayKey } from "./charts.ts";
import { sanitizeHtml } from "./sanitize.ts";
// #503 会话用量趋势（M1 数据层）：官方 session/event 契约事件为唯一事实源
import { TrendTracker } from "./trend/index.ts";
import { metricValue } from "./trend/aggregator.ts";
import { sumToken, type TrendCell } from "./trend/types.ts";
// #503 会话用量报告（M3 接线）：调度/生成/落盘/路由
import { candidateWindow, presetLastRunForNewlyEnabled, type DueReport } from "./report/schedule.ts";
import { normalizeReportConfig, promptFor, readReportConfig, writeReportConfig, DEFAULT_PROMPTS, type ReportConfig, type ReportPeriod } from "./report/config.ts";
import { ReportScheduler, readLastRun, writeLastRun } from "./report/scheduler.ts";
import { generateReport, buildStatsSnapshot, type ReportMeta, type ReportMetaSummary, type ReportStatsSnapshot } from "./report/generate.ts";
import { reportBodyToHtml } from "./report/format.ts";
// dsh-session 类型层（仅类型，编译期擦除）：加载 Events 声明合并 → ctx.on("session/*") 事件面
import type {} from "@deepseek-ai/dsh-session";

export const ROUTES: Record<string, string> = {
  stats: "/api/dsh-provider-usage/stats",
  history: "/api/dsh-provider-usage/history",
  trend: "/api/dsh-provider-usage/trend",
  adapters: "/api/dsh-provider-usage/adapters.json",
  select: "/api/dsh-provider-usage/adapters/select",
  inspect: "/api/dsh-provider-usage/adapters/inspect",
  add: "/api/dsh-provider-usage/adapters/add",
  health: "/api/dsh-provider-usage/health",
  uiConfig: "/api/dsh-provider-usage/ui-config",
  events: "/api/dsh-provider-usage/events",
  // #503 会话用量报告（M3）
  reportConfig: "/api/dsh-provider-usage/report-config",
  reportModels: "/api/dsh-provider-usage/report-models",
  reports: "/api/dsh-provider-usage/reports",
  reportDetail: "/api/dsh-provider-usage/reports/detail",
  reportGenerate: "/api/dsh-provider-usage/reports/generate",
};

export async function apply(ctx: Context, rawConfig: Record<string, unknown> = {}): Promise<void> {
  if (rawConfig.enabled === false) return; // 显式禁用：不注册任何路由
  const config = normalizeConfig(rawConfig);
  const sanitizeDiagnostic = (s: string): string =>
    // dsh-gate:allow-homedir #517 展示层脱敏：把诊断文本中的 home 前缀折叠为 ~，不产生读写面
    s.split(dshHome()).join("~/.dsh").split(homedir()).join("~");
  const registry = makeAdapterRegistry({
    sanitizePath: sanitizeDiagnostic,
  });
  const recordAdapterStateDiagnostic = (message: string): void => {
    // recordError 同时单次 console.warn 并写入 health 最近错误，避免双重日志。
    registry.recordError("adapter-state", "load", message);
  };

  // -------------------------------------------------------- 历史存储与持久化根
  const historyRoot = config.historyDir || join(dshHome(), "dsh-provider-usage");
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
  // #215：内置智谱 Coding Plan (CN) 适配器（provider zai-coding-cn，接口实测见 zai-coding-cn.mjs 头注释）
  registry.register(zaiCodingCnAdapter, "builtin");

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
  async function getStats(provider: string, signal?: AbortSignal): Promise<V2PipelineResult> {
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
    //
    // #308 断连感知：signal 仅在**已入锁**的取数段生效（safeFetchData 级联
    // abort → 锁内 fetch 真正中断、锁快速释放）。排队等待锁的任务不受 signal
    // 影响（async-mutex 排队不可取消）——但排队者入锁后经锁内二次 cacheFresh
    // 立即拿到刚刷新的数据返回，队列不会无限堆积。
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
        // #308：把请求级断连信号传进锁内取数——客户端断连/超时 abort 时
        // safeFetchData 级联中断 fetch，锁内取数立即退出，不再占锁至自然 5s 超时。
        signal,
        // 带值降级注入：取数失败时胶囊读最后一条成功历史渲染（数据来源状态由客户端圆点表达）
        history,
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

  // 6.5 会话用量趋势（#503 M1）：监听注册走 disposers 统一回收（热重载不双监听）；
  // session/flush 为 awaited parallel 官方排空点（flushNow 内部吞错，不拒绝排空）。
  // start 先于监听注册完成：重建/自愈窗口内不接事件，防半重建态记账。
  // 评审 P1-5：本块必须在「7. 路由注册」之前——/health 与 trendRoute 的 handler
  // 闭包引用 trend（trend.stats() / trend.seriesStacked 等），若 trend 晚于路由注册
  // effect 初始化，启动窗口内请求 /health 命中 const TDZ → ReferenceError → 500。
  // trend start 只做磁盘读，无依赖前置问题；pruneTimer 回调引用 trend 随之安全。
  const trend = await TrendTracker.start({
    root: join(historyRoot, "trend"),
    retentionDays: config.trendRetentionDays,
    warn: (msg) => console.warn(`[dsh-provider-usage] trend: ${sanitizeDiagnostic(msg)}`),
  });
  const trendDisposers: Array<() => void> = [];
  trendDisposers.push(ctx.on("session/event", (session, event) => trend.handleEvent(session, event)));
  trendDisposers.push(ctx.on("session/flush", () => trend.flushNow()));
  trendDisposers.push(ctx.on("session/disposed", (session) => trend.handleDisposed(session)));

  // 6.6 会话用量报告（#503 M3 接线）：落盘三件套（HTML/meta/index.jsonl）+ 调度器 +
  // 手动生成复用同一 runDue。落盘目录 = <historyRoot>/reports/（historyRoot 随
  // DSH_HOME/profile 走，多实例天然隔离）。生成不入统计（方案 §2.3）：generateReport
  // 只消费 ctx.llm.stream，不派发 session/event——本块仅从 trend.buckets() 只读快照取数。
  const reportsDir = join(historyRoot, "reports");
  const reportIndexFile = (): string => join(reportsDir, "index.jsonl");
  let reportCfg = await readReportConfig(historyRoot);

  /** 报告产物文件名（period-key 前缀；key 已由路由白名单正则校验，无穿越面）。 */
  const reportHtmlFile = (period: ReportPeriod, key: string): string => join(reportsDir, `${period}-${key}.html`);
  const reportMetaFile = (period: ReportPeriod, key: string): string => join(reportsDir, `${period}-${key}.meta.json`);

  /** 0600 原子写（tmp+rename；ui-config/writeUiConfig 同款模式）。 */
  async function writeReportFile(file: string, data: string): Promise<void> {
    await mkdir(reportsDir, { recursive: true });
    const tmp = `${file}.${Date.now()}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  }

  /**
   * 第一层净化（落盘形态即安全）：LLM 正文经 reportBodyToHtml 管线（#532
   * escape-then-transform：escHtml 先转义，仅引入无属性 h3/strong/ul/li/p 白名单
   * 标签）包入最小 HTML 文档骨架。文件本身无任何未转义插值——UI 读侧再经
   * sanitizeHtml 第二层净化兜底（黑名单对无属性白名单标签天然放行）。
   */
  function reportHtmlDocument(meta: ReportMeta, bodyText: string): string {
    const title = `${meta.period} ${meta.key} 用量报告`;
    return [
      "<!doctype html>",
      `<html lang="zh-CN"><head><meta charset="utf-8"><title>${escHtml(title)}</title></head>`,
      `<body><article class="dou-report-body">${reportBodyToHtml(bodyText)}</article></body></html>`,
    ].join("");
  }

  /** 落盘三件套：HTML + meta.json（均 0600 原子写）+ index.jsonl append 一行 meta。 */
  async function persistReport(meta: ReportMeta, bodyText: string): Promise<void> {
    await writeReportFile(reportHtmlFile(meta.period, meta.key), reportHtmlDocument(meta, bodyText));
    await writeReportFile(reportMetaFile(meta.period, meta.key), JSON.stringify(meta, null, 2));
    await mkdir(reportsDir, { recursive: true });
    await appendFile(reportIndexFile(), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  }

  /** day key 前移 n 天（本地逐日回退/推进，DST 安全；与 report/schedule.ts 同款语义）。 */
  function shiftDayKey(key: string, n: number): string {
    const [y, mo, d] = key.split("-").map(Number);
    const dt = new Date(y, mo - 1, d);
    dt.setDate(dt.getDate() + n);
    return dayKey(dt.getTime());
  }

  /** 窗口天数（ISO day key 按 UTC 解析差值 = 天数差，不受本地 DST 影响）。 */
  function windowDayCount(startDay: string, endDay: string): number {
    return Math.round((Date.parse(endDay) - Date.parse(startDay)) / 86400000) + 1;
  }

  /** 环比基准：同长度窗口整体前移（[startDay-len, startDay-1]）的 total 求和（null-aware）。 */
  function prevWindowTotal(
    buckets: Array<{ day: string; providers: Array<{ provider: string; model: string | null; cell: TrendCell }> }>,
    startDay: string,
    endDay: string,
  ): number | null {
    const len = windowDayCount(startDay, endDay);
    const prevStart = shiftDayKey(startDay, -len);
    const prevEnd = shiftDayKey(startDay, -1);
    let acc: number | null = null;
    for (const { day, providers } of buckets) {
      if (day < prevStart || day > prevEnd) continue;
      for (const { cell } of providers) acc = sumToken(acc, metricValue(cell, "total"));
    }
    return acc;
  }

  // 生成互斥：调度 tick 与手动生成共用一把锁，串行化生成全程（防同窗口双写产物竞态；
  // async-mutex 为既有依赖，零新增）。锁内不做等待 IO 之外的调度决策，无死锁面。
  const reportMutex = new Mutex();

  /**
   * 可选服务探测：'wingsky.notifier' 不在本插件 inject 声明面——cordis 的
   * inject 为硬依赖（声明而服务缺失会令插件整体 INACTIVE，见 Fiber._refresh），
   * 故推送能力必须经 get(name, false) 非严格探测（cordis 官方可选注入姿势，
   * 与 dsh-notifier 自身 getNotifierService 同形；service.d.ts 第 12 行写明）：
   * 服务在 →返回服务；不在 →返回 undefined → 返回 null（静默跳过推送，主流程
   * 零影响）。不能用 ctx["wingsky.notifier"] 属性访问——未声明 inject 时 cordis
   * get trap 无论服务是否已提供都抛 "cannot get property without inject"。
   * 每次发送/注册前现取、不缓存引用：与 notifier 插件的加载/热重载时序无关。
   * try/catch 保留：防御 ctx.get 在其 mixin accessor 链路理论抛错，静默降级
   * 而不是让 apply 整体启动失败（与 getNotifierService 逐字同形）。
   */
  function optionalNotifier(): {
    send: (req: { source: string; kind: string; severity: string; title: string; body: string }) => Promise<unknown>;
    registerKind?: (reg: { id: string; label: string }) => unknown;
  } | null {
    try {
      const n = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get?.("wingsky.notifier", false);
      if (n !== null && typeof n === "object" && typeof (n as { send?: unknown }).send === "function") {
        return n as { send: (req: { source: string; kind: string; severity: string; title: string; body: string }) => Promise<unknown>; registerKind?: (reg: { id: string; label: string }) => unknown };
      }
      return null;
    } catch {
      return null; // ctx.get 异常：服务不可达时静默降级（不阻断挂载/主流程）
    }
  }

  /** 可选 notifier 推送（cfg.push.enabled 才发；中心不在静默跳过，send 失败仅 warn）。 */
  function notifyReport(meta: ReportMeta, snapshot: ReportStatsSnapshot): void {
    if (!reportCfg.push.enabled) return;
    const notifier = optionalNotifier();
    if (notifier === null) return; // 中心不在：静默跳过
    const total = snapshot.totals.total;
    const body = `${meta.period} ${meta.key}（${meta.startDay} ~ ${meta.endDay}）：token 总量 ${
      total === null ? "无数据" : total.toLocaleString("en-US")
    }，调用 ${snapshot.totals.calls} 次。详情见 dsh 设置页用量报告。`; // 摘要只含数值与期间，不含任何路径
    notifier
      .send({ source: "@wingsky-1/dsh-provider-usage", kind: "provider-usage:report", severity: "info", title: "用量报告", body })
      .catch((e: unknown) => console.warn(`[dsh-provider-usage] report: 推送失败（不影响主流程）：${sanitizeDiagnostic(errorMessage(e))}`));
  }

  /** 快照 → hero 摘要（纯数值投影；#532 meta.summary 数据源）。 */
  function summaryOf(snapshot: ReportStatsSnapshot): ReportMetaSummary {
    return {
      total: snapshot.totals.total,
      calls: snapshot.totals.calls,
      activeDays: snapshot.activeDays,
      windowDays: snapshot.windowDays,
      longestStreak: snapshot.longestStreak,
      wowRatio: snapshot.wowRatio,
      peakDay: snapshot.peakDay,
    };
  }

  /**
   * 生成一个到期窗口（调度 tick 与手动生成路由复用）：
   * 统计快照（只读 buckets）→ generateReport → 成功才落盘三件套 + 可选推送；
   * 失败抛错（调度侧不推进 lastRun、同窗重试——scheduler 已有语义）。
   * #532：空窗口（calls=0）不调模型不落盘，返回 noData 元数据（调度侧正常推进
   * lastRun 防逐 tick 重试死循环；手动生成回显「当期无用量数据」）。
   */
  async function runDue(due: DueReport): Promise<ReportMeta> {
    const buckets = trend.buckets();
    const snapshot = buildStatsSnapshot({
      period: due.period,
      startDay: due.startDay,
      endDay: due.endDay,
      buckets,
      prevTotal: prevWindowTotal(buckets, due.startDay, due.endDay),
    });
    if (snapshot.totals.calls === 0) {
      return {
        period: due.period,
        key: due.key,
        startDay: due.startDay,
        endDay: due.endDay,
        provider: reportCfg.provider,
        model: reportCfg.model,
        generatedAt: Date.now(),
        durationMs: 0,
        ok: true,
        noData: true,
      };
    }
    const result = await generateReport({
      llm: ctx.llm,
      period: due.period,
      key: due.key,
      startDay: due.startDay,
      endDay: due.endDay,
      statsJson: JSON.stringify(snapshot, null, 2),
      promptTemplate: promptFor(reportCfg, due.period),
      provider: reportCfg.provider,
      model: reportCfg.model,
    });
    if (!result.meta.ok) throw new Error(result.meta.error ?? "报告生成失败");
    const meta: ReportMeta = { ...result.meta, summary: summaryOf(snapshot) };
    await persistReport(meta, result.body);
    notifyReport(meta, snapshot);
    return meta;
  }

  // 调度器（方案 §2.3 极简调度器）：tickMs 默认 60s；启动首轮 tick 即补跑检查；
  // onDue 抛错不推进 lastRun（同窗重试），dispose 停 tick（主 disposer 统一回收）。
  const reportScheduler = ReportScheduler.start({
    root: historyRoot,
    config: reportCfg,
    onDue: (due) => reportMutex.runExclusive(async () => { await runDue(due); }),
    warn: (msg) => console.warn(`[dsh-provider-usage] report: ${sanitizeDiagnostic(msg)}`),
  });

  // 可选推送 kind 动态注册（挂载直调 + internal/service 事件补注册）：
  // registerKind 幂等（notifier 侧 kindRegistry.set），重复调用无害。
  // - 挂载直调：notifier 已加载（profile 顺序在其后）时立即注册；
  // - internal/service 订阅：notifier 后加载/HMR 重建 kindRegistry（新建空表）
  //   时补注册（事件在服务 provide/unprovide/fiber 生命周期迁移时派发，
  //   { global: true } 与 dsh-notifier 对 userQuestions 的订阅先例一致）；
  // - 两者任一路成功即保证 kind 在清单中；中心不在/异常静默——不阻断挂载。
  function ensureReportKind(): void {
    const notifier = optionalNotifier();
    if (notifier !== null && typeof notifier.registerKind === "function") {
      try {
        notifier.registerKind({ id: "provider-usage:report", label: "用量报告" });
      } catch { /* 注册失败静默：推送为可选功能 */ }
    }
  }
  ensureReportKind();
  trendDisposers.push(ctx.on("internal/service", (name) => {
    if (name === "wingsky.notifier") ensureReportKind();
  }, { global: true }));

  // 7. 路由注册
  // #308 断连感知统一形态（stats/history 共用）：请求级 AbortController——客户端
  // 提前断连（fetch abort / 半开超时）时经 res close 触发 abort，取数链路级联
  // 中断、锁快速释放；settled 标志 + destroyed/writableEnded 双检查保证超时/
  // 断连与正常完成二选一写响应，杜绝双写竞态。
  const statsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.stats,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const prov = url.searchParams.get("provider") ?? config.provider;
      const controller = new AbortController();
      let settled = false;
      const finish = (status: number, body: unknown): void => {
        if (settled) return;
        settled = true;
        if (!res.destroyed && !res.writableEnded) writeJson(res, status, body);
      };
      // 客户端提前断连（writableEnded=false）→ 取消取数；正常完成时 close 无害跳过。
      // 守卫 typeof on：smoke 契约桩无 on 方法（仅断言响应形状），跳过断连监听。
      if (typeof res.on === "function") {
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
      }
      try {
        const result = await getStats(prov, controller.signal);
        finish(200, {
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
      } catch {
        // getStats 正常不抛（取数错误收敛为 error 帧）；此处兜底锁 cancel 等异常路径。
        finish(504, { error: "stats timeout" });
      }
    },
  };

  const historyRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
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
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
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
        trend: trend.stats(), // #503：会话用量趋势观测（天数/未落盘行/最近刷盘）
      });
    },
  };

  /**
   * 会话用量趋势（#503 M2，GET）：granularity=day|week|month（默认 day）×
   * metric=total|input|output|cacheRead|cacheWrite|calls（默认 total）×
   * provider 过滤（缺省全部）× byModel=1（适配器维度细到 model，默认 provider）。
   * 堆叠柱序列 + 窗口摘要 + 起算日（「统计自插件挂载时点起算」文案数据源）。
   */
  /**
   * 趋势窗口桶数（#503 M2.1）：默认与 M2 相同（day 30 / week 12 / month 12，兼容
   * 既有调用方），客户端可带 ?n= 覆写。上限按粒度 × 真实留存计算——留存按「天」裁
   * （prune cutoff = now − retentionDays 天），桶数与天数是两种口径：day ≤ retention、
   * week ≤ ⌈retention/7⌉、month ≤ ⌈retention/30⌉；n 非正整数时回退默认（防御）。
   */
  const TREND_WINDOW: Record<string, number> = { day: 30, week: 12, month: 12 };
  function clampTrendN(raw: string | null, gran: "day" | "week" | "month"): number {
    const retention = config.trendRetentionDays;
    const cap = gran === "day" ? retention : gran === "week" ? Math.ceil(retention / 7) : Math.ceil(retention / 30);
    const parsed = raw === null || raw === "" ? NaN : Number(raw);
    const n = Number.isInteger(parsed) && parsed > 0 ? parsed : TREND_WINDOW[gran] ?? 30;
    return Math.min(n, cap);
  }
  const TREND_METRICS = new Set(["total", "input", "output", "cacheRead", "cacheWrite", "calls"]);
  const trendRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.trend,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const g = url.searchParams.get("granularity") ?? "day";
      const granularity = g === "week" || g === "month" ? g : "day";
      const m = url.searchParams.get("metric") ?? "total";
      const metric = TREND_METRICS.has(m) ? (m as "total" | "input" | "output" | "cacheRead" | "cacheWrite" | "calls") : "total";
      const providerParam = url.searchParams.get("provider") ?? "";
      const provider = providerParam.length > 0 && providerParam.length <= 128 ? providerParam : undefined;
      const byModel = url.searchParams.get("byModel") === "1";
      const n = clampTrendN(url.searchParams.get("n"), granularity);
      const stack = trend.seriesStacked(n, granularity, metric, provider, byModel);
      // windowSummary 内部按 byModel=false 口径取 top 段——仅当堆叠同为 provider 级时才复用，
      // byModel=true 时传入会改变 top 口径（行为变化），退回内部自算（评审 P1-2 复用前提）
      const summary = trend.windowSummary(n, granularity, metric, provider, byModel ? undefined : stack.series);
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-provider-usage",
        version: ADAPTER_CONTRACT_VERSION,
        granularity,
        metric,
        provider: provider ?? null,
        byModel,
        n, // 实际返回桶数（clamp 后；客户端裁档位/提示的依据）
        retentionDays: config.trendRetentionDays, // 客户端按粒度生成范围档位的依据
        ...stack,
        summary,
        firstDay: trend.firstRecordedDay(),
        generatedAt: Date.now(),
      });
    },
  };

  /** 适配器元数据路由（设置页主列表同源）。 */
  const adaptersRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.adapters,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
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
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
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
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
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
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
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
      if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
      if (req.method === "GET") {
        writeJson(res, 200, { ok: true, ui: uiConfig });
        return;
      }
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
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
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

  // 7d. 用量报告路由（#503 M3）：配置读写 / 历史索引 / 详情回看 / 手动生成。
  // 全部 loopback 围栏 + guardLoopbackMethod；detail 的 key 白名单正则防路径穿越。

  /** 报告配置路由（GET 读 / POST 保存；保存即热更新调度器配置）。 */
  const reportConfigRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.reportConfig,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
      if (req.method === "GET") {
        const config = await readReportConfig(historyRoot);
        // provider 候选来自 dsh 已注册适配器路由（同 adaptersRoute 的 modelProviders 面，附展示名）
        let providers: Array<{ id: string; name?: string }> = [];
        try {
          const listed = ctx.llm.listProviders();
          if (Array.isArray(listed)) {
            providers = listed
              .map((i) => (i as { id?: unknown; name?: unknown } | null))
              .filter((i): i is { id: string; name?: string } => typeof (i as { id?: unknown })?.id === "string")
              .map((i) => ({ id: i.id as string, ...(typeof i.name === "string" ? { name: i.name } : {}) }));
          }
        } catch { /* 回落空数组 */ }
        return writeJson(res, 200, { ok: true, config, providers, promptDefaults: DEFAULT_PROMPTS });
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        return writeJson(res, 400, { error: "bad-json" });
      }
      const normalized = normalizeReportConfig(body);
      // #531：首次启用（disabled→enabled 且 lastRun 无记录）的周期预置 lastRun=当前
      // 候选键（当期视为已扣期）——防「保存即立即生成最近窗口」。先写 lastRun 再
      // 热更新调度器，下轮 tick 读到新 lastRun 即跳过当期；曾启用过的周期保持补跑语义。
      const preset = presetLastRunForNewlyEnabled(reportCfg, normalized, Date.now(), await readLastRun(historyRoot));
      if (preset.changed) await writeLastRun(historyRoot, preset.lastRun);
      try {
        await writeReportConfig(historyRoot, normalized);
      } catch {
        return writeJson(res, 500, { error: "persist-failed" });
      }
      reportCfg = normalized; // 接线层缓存同步（runDue 读 promptTemplate/provider/model/push 取此份）
      reportScheduler.updateConfig(normalized); // 调度器下轮 tick 生效
      writeJson(res, 200, { ok: true, config: normalized });
    },
  };

  /**
   * 报告模型候选路由（#532，GET ?provider=）：listProviders 校验存在 → listModels。
   * listModels 为 adapter 自主发现（可能走网络）：5s 竞速超时防悬挂，失败回
   * {ok:false,reason}（客户端降级手填）；不在 report-config GET 预拉全量——避免
   * 打开设置页即打多路发现请求。未知 provider 与发现失败分开报（unknown-provider）。
   */
  const reportModelsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.reportModels,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const provider = url.searchParams.get("provider") ?? "";
      const known = (() => {
        try {
          return ctx.llm.listProviders().some((i) => (i as { id?: unknown })?.id === provider);
        } catch {
          return false;
        }
      })();
      if (provider.length === 0 || !known) {
        return writeJson(res, 200, { ok: false, reason: "unknown-provider" });
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const pending = ctx.llm.listModels(provider);
        pending.catch(() => {}); // 超时竞速后底层悬挂 rejection 兜底（防 unhandled）
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("discover-timeout")), 5000);
        });
        const models = await Promise.race([pending, timeout]);
        const list = Array.isArray(models)
          ? (models as Array<{ id?: unknown; name?: unknown } | null>)
              .filter((m): m is { id: string; name?: string } =>
                typeof m?.id === "string" && (m.id as string).length > 0)
              .map((m) => ({ id: m.id, ...(typeof m.name === "string" && m.name.length > 0 ? { name: m.name as string } : {}) }))
          : [];
        writeJson(res, 200, { ok: true, models: list });
      } catch (e: unknown) {
        writeJson(res, 200, { ok: false, reason: e instanceof Error ? e.message : "discover-failed" });
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
  };

  /** 读 index.jsonl（逐行 JSON.parse 容错坏行；倒序 = 最新在前）。 */  async function readReportIndex(): Promise<ReportMeta[]> {
    let raw: string;
    try {
      raw = await readFile(reportIndexFile(), "utf8");
    } catch {
      return []; // 尚无任何报告
    }
    const out: ReportMeta[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (s.length === 0) continue;
      try {
        const obj = JSON.parse(s) as ReportMeta | null;
        // 最小形状防御：period/key 可辨识才收（坏行读侧跳过——落盘侧只 append 成功行）
        if (
          obj !== null && typeof obj === "object" &&
          typeof obj.key === "string" &&
          (obj.period === "daily" || obj.period === "weekly" || obj.period === "monthly")
        ) {
          out.push(obj);
        }
      } catch { /* 坏行跳过 */ }
    }
    return out.reverse();
  }

  /** 报告历史索引路由（GET；倒序数组）。 */
  const reportsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.reports,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      const list = await readReportIndex();
      writeJson(res, 200, { ok: true, reports: list });
    },
  };

  // detail 的 key 白名单：key 直接拼文件路径，必须防路径穿越（period 枚举 + key 正则双闸）
  const REPORT_KEY_RES: Record<ReportPeriod, RegExp> = {
    daily: /^\d{4}-\d{2}-\d{2}$/,
    weekly: /^\d{4}-\d{2}-\d{2}$/,
    monthly: /^\d{4}-\d{2}$/,
  };
  const REPORT_PERIODS = new Set<ReportPeriod>(["daily", "weekly", "monthly"]);

  /** 报告详情路由（GET ?period=&key=）：读盘 → sanitizeHtml 第二层净化 + meta。 */
  const reportDetailRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.reportDetail,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const period = url.searchParams.get("period") ?? "";
      const key = url.searchParams.get("key") ?? "";
      if (!REPORT_PERIODS.has(period as ReportPeriod)) {
        return writeJson(res, 400, { error: "invalid-period" });
      }
      if (!REPORT_KEY_RES[period as ReportPeriod].test(key)) {
        return writeJson(res, 400, { error: "invalid-key" });
      }
      let html: string;
      try {
        // 第二层净化：文件本身已 escHtml 包裹（第一层），读侧再过 sanitizeHtml 兜底
        html = sanitizeHtml(await readFile(reportHtmlFile(period as ReportPeriod, key), "utf8"));
      } catch {
        return writeJson(res, 404, { error: "report-not-found" });
      }
      let meta: ReportMeta;
      try {
        meta = JSON.parse(await readFile(reportMetaFile(period as ReportPeriod, key), "utf8")) as ReportMeta;
      } catch {
        return writeJson(res, 404, { error: "report-not-found" });
      }
      writeJson(res, 200, { ok: true, html, meta });
    },
  };

  /** 手动生成路由（POST {period}）：与调度复用 runDue（互斥锁内）；成功推进 lastRun。 */
  const reportGenerateRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.reportGenerate,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
      let body: Record<string, unknown>;
      try {
        const raw = await readJsonBody(req);
        if (typeof raw !== "object" || raw === null) return writeJson(res, 400, { error: "bad-json" });
        body = raw as Record<string, unknown>;
      } catch {
        return writeJson(res, 400, { error: "bad-json" });
      }
      const period = body.period;
      if (typeof period !== "string" || !REPORT_PERIODS.has(period as ReportPeriod)) {
        return writeJson(res, 400, { error: "invalid-period" });
      }
      // 候选窗口（不检查 enabled：手动生成为用户主动行为；UI 空态亦引导「立即手动生成」）
      const due = candidateWindow(period as ReportPeriod, reportCfg, Date.now());
      try {
        const meta = await reportMutex.runExclusive(() => runDue(due));
        // 成功推进 lastRun（读改写：调度器同窗不再重复生成——防 tick 双生成）
        const lastRun = await readLastRun(historyRoot);
        lastRun[due.period] = due.key;
        await writeLastRun(historyRoot, lastRun);
        writeJson(res, 200, { ok: true, meta });
      } catch (e: unknown) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  };

  const disposeRoutes = ctx.effect(
    () => {
      // #503 M3：报告四路由并入同一注册/回收面
      const routeDisposers = [statsRoute, historyRoute, healthRoute, trendRoute, adaptersRoute, selectRoute, inspectRoute, addRoute, uiConfigRoute, eventsRoute, reportConfigRoute, reportModelsRoute, reportsRoute, reportDetailRoute, reportGenerateRoute].map((route) =>
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
    // #503：trend 聚合分片留存清理同周期（trend 初始化已提前至 6.5，见评审 P1-5）
    void trend.prune().catch((err) => console.warn("[dsh-provider-usage] trend 留存清理失败:", err));
  }, PRUNE_INTERVAL_MS);
  (pruneTimer as { unref?: () => void }).unref?.();

  // 9. 设置面板命名空间（只读镜像；apiKey 不进 schema 避免回显）
  installSettingsNamespace(ctx, "dsh-provider-usage", Config, rawConfig, {
    setSource: () => {},
    onChange: () => {},
  });

  // 10. 卸载清理（async disposer：cordis stop await 完成后卸载才结束——
  // trend 最终刷盘 await 到位，防抖 timer 清理，热重载不丢已收事件、不双算）
  ctx.effect(
    () => async () => {
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
      // #503：trend 监听回收 + 最终排空（dispose await 刷盘）
      for (const dispose of trendDisposers) {
        try { dispose(); } catch { /* 忽略 */ }
      }
      await trend.dispose();
      // #503 M3：报告调度器停 tick（同步；进行中的一轮由 onDue 自身 await 语义收敛）
      reportScheduler.dispose();
    },
    "dsh-provider-usage",
  );
}
