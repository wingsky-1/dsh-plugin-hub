/**
 * dsh-provider-usage — 插件挂载主流程（apply）与路由表（单一事实源）。
 *
 * 路由（loopback 围栏）：
 * - GET /api/dsh-provider-usage/stats  用量统计 + 胶囊 HTML
 * - GET /api/dsh-provider-usage/history 历史数据 + 面板 HTML
 * - GET /api/dsh-provider-usage/trend  会话用量趋势统计
 * - GET /api/dsh-provider-usage/adapters.json 适配器候选元数据
 * - POST /api/dsh-provider-usage/adapters/select 切换/清空启用适配器
 * - POST /api/dsh-provider-usage/adapters/inspect 预览适配器文件
 * - POST /api/dsh-provider-usage/adapters/add 登记用户适配器文件
 * - GET /api/dsh-provider-usage/health  健康检查 + 适配器快照
 * - GET/POST /api/dsh-provider-usage/ui-config 胶囊位置配置
 * - GET /api/dsh-provider-usage/events  SSE 事件通道
 * - GET/POST /api/dsh-provider-usage/report-config 报告配置
 * - GET /api/dsh-provider-usage/report-models 报告模型候选
 * - GET /api/dsh-provider-usage/reports  报告历史索引
 * - GET /api/dsh-provider-usage/reports/detail  报告详情
 * - POST /api/dsh-provider-usage/reports/generate  手动生成报告（#625：立即返回 202+taskId）
 * - GET /api/dsh-provider-usage/reports/generate/status  生成任务状态轮询
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { sseData } from "../../../shared/host-utils.js";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import { dshHome } from "../../../shared/dsh-home.js";
import type { AdapterRegistry } from "./registry.ts";
import { makeAdapterRegistry } from "./registry.ts";
import { openCodeGoAdapter } from "./adapters/opencode-go.mjs";
import { deepSeekOfficialAdapter } from "./adapters/deepseek-official.mjs";
import { zaiCodingCnAdapter } from "./adapters/zai-coding-cn.mjs";
import { HistoryStore, migrateLegacyV3 } from "./core/history.ts";
import { HotReloadableAdapter } from "./hotreload.ts";
import { resolvePath } from "./path-resolve.ts";
import { Config, normalizeConfig, type NormalizedConfig } from "./config.ts";
import { readUiConfig } from "./ui-config.ts";
import { readAdapterStateResult, readUserAdapters } from "./user-adapters.ts";
import { loadUserAdapterChecked } from "./user-adapter-loader.ts";
import { StatsService } from "./stats-service.ts";
import { TrendTracker } from "./trend/index.ts";
import { readReportConfig, type ReportConfig } from "./report/config.ts";
import { ReportScheduler, readLastRun, writeLastRun } from "./report/scheduler.ts";
import { optionalNotifier, readReportIndex, runDueReport } from "./report/runner.ts";
import { ReportTaskQueue } from "./report/tasks.ts";
import { createStatsRoutes } from "./routes/stats.ts";
import { createAdapterRoutes } from "./routes/adapters.ts";
import { createUiRoutes } from "./routes/ui.ts";
import { createReportRoutes } from "./routes/reports.ts";
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
  reportConfig: "/api/dsh-provider-usage/report-config",
  reportModels: "/api/dsh-provider-usage/report-models",
  reports: "/api/dsh-provider-usage/reports",
  reportDetail: "/api/dsh-provider-usage/reports/detail",
  reportGenerate: "/api/dsh-provider-usage/reports/generate",
  reportGenerateStatus: "/api/dsh-provider-usage/reports/generate/status",
};

/** 恢复持久化的启用选择（adapter-state.json） */
async function restoreSavedEnabledState(
  historyRoot: string,
  registry: AdapterRegistry,
  recordDiagnostic: (msg: string) => void,
): Promise<void> {
  const savedEnabled = await readAdapterStateResult(historyRoot, {
    diagnostic: recordDiagnostic,
  });
  for (const [provider, name] of Object.entries(savedEnabled.state)) {
    const selected = registry.select(provider, name);
    if (!selected) {
      const safeProvider = JSON.stringify(provider.length > 128 ? `${provider.slice(0, 125)}...` : provider);
      const safeName = JSON.stringify(name === null || name.length <= 128 ? name : `${name.slice(0, 125)}...`);
      recordDiagnostic(
        `恢复启用选择失败：provider ${safeProvider} 保存的适配器 ${safeName} 不在当前候选中（可能文件缺失或加载失败），未改写当前启用关系`,
      );
    }
  }
}

/** 创建热更新管理器 */
function makeHotReloadManager(
  config: NormalizedConfig,
  registry: AdapterRegistry,
  statsService: StatsService,
  hotReloaders: HotReloadableAdapter[],
): (file: string) => Promise<void> {
  const watchedFiles = new Set<string>();

  return async (file: string): Promise<void> => {
    if (!config.autoReload) return;
    const resolved = resolvePath(file);
    if (resolved === undefined || watchedFiles.has(resolved)) return;
    watchedFiles.add(resolved);

    const hr = new HotReloadableAdapter(resolved, 2000, (info) => {
      const key = `file:${basename(resolved)}`;
      if (!info.ok) {
        registry.recordError(key, "load", `热更新失败：${info.error ?? "未知错误"}`);
        return;
      }
      if (hr.current !== null) {
        const oldProviders = registry.snapshot().infos
          .filter((i) => i.file === resolved)
          .flatMap((i) => i.providers);
        const replaced = registry.replaceByFile(resolved, hr.current);
        if (!replaced.ok) {
          registry.recordError(key, "load", `热更新失败：${replaced.detail}`);
          return;
        }
        const touchedProviders = new Set(oldProviders);
        for (const p of hr.current.providers) touchedProviders.add(p);
        statsService.purgeCachesForProviders(touchedProviders);
        statsService.warmupProviders(touchedProviders);
        statsService.scheduleWriteAdapterState();
        console.warn(`[dsh-provider-usage] 热更新成功：${replaced.name}（${basename(resolved)}）`);
      }
    });

    const started = await hr.start();
    if (!started.ok && started.error !== undefined) {
      registry.recordError(`file:${basename(resolved)}`, "load", `热更新启动失败：${started.error}`);
    }
    hotReloaders.push(hr);
  };
}

/** 注册并启动定时预热任务 */
function startWarmupTimer(
  config: NormalizedConfig,
  registry: AdapterRegistry,
  statsService: StatsService,
): ReturnType<typeof setInterval> | null {
  if (config.warmupIntervalMs <= 0) return null;
  const warmupFn = (): void => {
    for (const provider of registry.enabledProviders()) {
      void statsService.getStats(provider).catch(() => {});
    }
  };
  const timer = setInterval(warmupFn, config.warmupIntervalMs);
  (timer as { unref?: () => void }).unref?.();
  warmupFn();
  return timer;
}

/** 注册并启动定时历史清理任务 */
function startPruneTimer(
  history: HistoryStore,
  trend: TrendTracker,
): ReturnType<typeof setInterval> {
  const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
  const timer = setInterval(() => {
    void history.pruneAll().catch((err) => console.warn("[dsh-provider-usage] 历史留存清理失败:", err));
    void trend.prune().catch((err) => console.warn("[dsh-provider-usage] trend 留存清理失败:", err));
  }, PRUNE_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** 注册插件生命周期销毁逻辑 */
function registerLifecycleCleanup(
  ctx: Context,
  disposeRoutes: () => void,
  warmupTimer: ReturnType<typeof setInterval> | null,
  pruneTimer: ReturnType<typeof setInterval>,
  hotReloaders: HotReloadableAdapter[],
  sseClients: Set<ServerResponse>,
  statsService: StatsService,
  trendDisposers: Array<() => void>,
  trend: TrendTracker,
  reportScheduler: ReportScheduler,
): void {
  ctx.effect(
    () => async () => {
      disposeRoutes();
      if (warmupTimer !== null) clearInterval(warmupTimer);
      clearInterval(pruneTimer);
      for (const hr of hotReloaders) hr.stop();
      for (const res of sseClients) {
        try { res.end(); } catch { /* 忽略 */ }
      }
      sseClients.clear();
      statsService.dispose();
      for (const dispose of trendDisposers) {
        try { dispose(); } catch { /* 忽略 */ }
      }
      await trend.dispose();
      reportScheduler.dispose();
    },
    "dsh-provider-usage",
  );
}

export async function apply(ctx: Context, rawConfig: Record<string, unknown> = {}): Promise<void> {
  if (rawConfig.enabled === false) return;
  const config = normalizeConfig(rawConfig);
  const sanitizeDiagnostic = (s: string): string =>
    // dsh-gate:allow-homedir #517 展示层脱敏：把诊断文本中的 home 前缀折叠为 ~，不产生读写面
    s.split(dshHome()).join("~/.dsh").split(homedir()).join("~");

  const registry = makeAdapterRegistry({
    sanitizePath: sanitizeDiagnostic,
  });
  const recordAdapterStateDiagnostic = (message: string): void => {
    registry.recordError("adapter-state", "load", message);
  };

  const historyRoot = config.historyDir || join(dshHome(), "dsh-provider-usage");
  const history = new HistoryStore({
    root: historyRoot,
    maxAgeMs: config.maxAgeDays * 86400000,
    maxSizeBytes: config.maxSizeMB * 1024 * 1024,
  });

  try {
    const migrated = await migrateLegacyV3(historyRoot, history);
    if (migrated > 0) console.warn(`[dsh-provider-usage] 已迁移 ${migrated} 条旧 v3 历史采样到按天分片 JSONL`);
  } catch {
    /* 迁移失败不阻断启动 */
  }

  registry.register(openCodeGoAdapter, "builtin");
  registry.register(deepSeekOfficialAdapter, "builtin");
  registry.register(zaiCodingCnAdapter, "builtin");

  if (config.adapter !== "") {
    const resolved = resolvePath(config.adapter);
    if (resolved === undefined) {
      registry.recordError(`file:${basename(config.adapter)}`, "load", "文件不存在或不可读");
    } else {
      const loaded = await loadUserAdapterChecked(resolved, registry);
      if (loaded.ok) registry.register(loaded.adapter, "user-file", resolved);
    }
  }

  const userRecords = await readUserAdapters(historyRoot);
  for (const rec of userRecords) {
    const file = resolvePath(rec.file);
    if (file === undefined) {
      registry.recordError(`file:${basename(rec.file)}`, "load", "文件不存在或不可读");
      continue;
    }
    const loaded = await loadUserAdapterChecked(file, registry);
    if (loaded.ok) registry.register(loaded.adapter, "user-file", file);
  }

  const statsService = new StatsService({
    ctx,
    config,
    historyRoot,
    registry,
    history,
    sanitizeDiagnostic,
    recordAdapterStateDiagnostic,
  });

  const hotReloaders: HotReloadableAdapter[] = [];
  const ensureHotReload = makeHotReloadManager(config, registry, statsService, hotReloaders);

  await restoreSavedEnabledState(historyRoot, registry, recordAdapterStateDiagnostic);

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

  const trend = await TrendTracker.start({
    root: join(historyRoot, "trend"),
    retentionDays: config.trendRetentionDays,
    warn: (msg) => console.warn(`[dsh-provider-usage] trend: ${sanitizeDiagnostic(msg)}`),
  });
  const trendDisposers: Array<() => void> = [];
  trendDisposers.push(ctx.on("session/event", (session, event) => trend.handleEvent(session, event)));
  trendDisposers.push(ctx.on("session/flush", () => trend.flushNow()));
  trendDisposers.push(ctx.on("session/disposed", (session) => trend.handleDisposed(session)));

  let reportCfg: ReportConfig = await readReportConfig(historyRoot);

  // #625/#626：任务队列 = 定时 tick 与手动「立即生成」的单一执行入口。
  // 执行器职责：幂等下沉（执行前重查 index，已有成功记录且非 force → 复用，不调 LLM）、
  // 生成、lastRun 推进——全部在队列临界区内（串行单飞天然临界，修复原 routes 侧
  // lastRun 读改写位于 mutex 外的竞态）；失败不推进 lastRun（下轮按幂等重试/补跑）。
  const reportQueue = new ReportTaskQueue({
    executor: async (input) => {
      if (input.force !== true) {
        const existing = (await readReportIndex(historyRoot)).find(
          (m) => m.period === input.period && m.key === input.key && m.ok === true,
        );
        if (existing !== undefined) return { meta: existing, reused: true };
      }
      const meta = await runDueReport({ due: input, trend, ctx, reportCfg, historyRoot, sanitizeDiagnostic });
      const lastRun = await readLastRun(historyRoot);
      lastRun[meta.period] = meta.key;
      await writeLastRun(historyRoot, lastRun);
      return { meta };
    },
    warn: (msg) => console.warn(`[dsh-provider-usage] report: ${sanitizeDiagnostic(msg)}`),
  });

  const reportScheduler = ReportScheduler.start({
    root: historyRoot,
    config: reportCfg,
    // #625：tick 只提交任务（非阻塞，队列去重吸收同窗口堆积），不再等待生成
    onDue: (due) => {
      reportQueue.submit(due);
      return Promise.resolve();
    },
    warn: (msg) => console.warn(`[dsh-provider-usage] report: ${sanitizeDiagnostic(msg)}`),
  });

  function ensureReportKind(): void {
    const notifier = optionalNotifier(ctx);
    if (notifier !== null && typeof notifier.registerKind === "function") {
      try {
        notifier.registerKind({ id: "provider-usage:report", label: "用量报告" });
      } catch { /* 推送为可选功能 */ }
    }
  }
  ensureReportKind();
  trendDisposers.push(ctx.on("internal/service", (name) => {
    if (name === "wingsky.notifier") ensureReportKind();
  }, { global: true }));

  const uiConfig = await readUiConfig(historyRoot);
  const sseClients = new Set<ServerResponse>();
  const broadcastUiConfigChanged = (): void => {
    const payload = sseData({ type: "ui-config-changed" });
    for (const client of sseClients) {
      try {
        if (!client.destroyed && !client.writableEnded) client.write(payload);
      } catch {
        // 忽略写入故障
      }
    }
  };

  const routes = [
    ...createStatsRoutes({ stats: ROUTES.stats, history: ROUTES.history }, { statsService }),
    ...createAdapterRoutes(
      { adapters: ROUTES.adapters, select: ROUTES.select, inspect: ROUTES.inspect, add: ROUTES.add },
      { ctx, statsService, ensureHotReload },
    ),
    ...createUiRoutes(
      { health: ROUTES.health, trend: ROUTES.trend, uiConfig: ROUTES.uiConfig, events: ROUTES.events },
      { statsService, trend, uiConfig, sseClients, broadcastUiConfigChanged },
    ),
    ...createReportRoutes(
      {
        reportConfig: ROUTES.reportConfig,
        reportModels: ROUTES.reportModels,
        reports: ROUTES.reports,
        reportDetail: ROUTES.reportDetail,
        reportGenerate: ROUTES.reportGenerate,
        reportGenerateStatus: ROUTES.reportGenerateStatus,
      },
      {
        ctx,
        historyRoot,
        reportQueue,
        getReportCfg: () => reportCfg,
        setReportCfg: (c) => { reportCfg = c; },
        reportScheduler,
      },
    ),
  ];

  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = routes.map((r) => ctx.webServer.register(r));
      return () => {
        for (const dispose of routeDisposers) {
          try { dispose(); } catch { /* 忽略 */ }
        }
      };
    },
    "dsh-provider-usage: routes",
  );

  const warmupTimer = startWarmupTimer(config, registry, statsService);
  const pruneTimer = startPruneTimer(history, trend);

  installSettingsNamespace(ctx, "dsh-provider-usage", Config, rawConfig, {
    setSource: () => {},
    onChange: () => {},
  });

  registerLifecycleCleanup(
    ctx,
    disposeRoutes,
    warmupTimer,
    pruneTimer,
    hotReloaders,
    sseClients,
    statsService,
    trendDisposers,
    trend,
    reportScheduler,
  );
}
