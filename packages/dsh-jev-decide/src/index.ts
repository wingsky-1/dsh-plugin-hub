/**
 * 宿主端组合根：收窄宿主上下文、按依赖顺序装配各域、卸载逆序释放。
 *
 * 本文件是唯一认识 ctx 的地方：bindHost 把 ctx 收窄为窄面端口，各域只拿能力、
 * 不拿上下文（静态端口装配写法照 dsh-mcp-manager 入口：bind 结果进 assemble，
 * 域经 deps 注入，释放器进栈由 ctx.effect 统一摘）。
 * 配置每次现读磁盘（小文件，无缓存无过期）；状态住闭包，不住模块级变量。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ROUTES, frozenPresetOf } from "./shared/interface.ts";
import type { AutomationCap, CustomPreset } from "./shared/interface.ts";
import * as apiApi from "./server/api/interface.ts";
import type { ApiDeps } from "./server/api/interface.ts";
import * as configApi from "./server/config/interface.ts";
import type { ConfigDeps, LoadedState } from "./server/config/interface.ts";
import * as historyApi from "./server/history/interface.ts";
import type { HistoryDeps } from "./server/history/interface.ts";
import * as storeApi from "./server/store/interface.ts";
import * as toolsApi from "./server/tools/interface.ts";
import type { DecideDeps, FetchImpl } from "./server/tools/interface.ts";
import * as upgradeApi from "./server/upgrade/interface.ts";

/** 路由清单经这里出去，构建期注入客户端（bundle-host 只认入口的 ROUTES 导出）。 */
export { ROUTES };

/** 稳定的 cordis 插件名。 */
export const name = "jev-decide";

/** 依赖的宿主服务（路由 + 模型工具注册）。 */
export const inject = ["webServer", "tools"];

/** 组合层入口配置（挂载点传入；用户配置住自有三文件，不在此展开）。 */
export interface JevDecideApplyConfig {
  /** 总开关；false 时不注册工具与路由。 */
  enabled?: boolean;
  /** 落盘根覆盖（缺席即 DSH home；测试走 mkdtempSync 隔离目录）。 */
  home?: string;
  /** fetch 注入（缺席即全局 fetch；单测注入 mock）。 */
  fetchImpl?: FetchImpl;
  /** 环境注入（缺席即 process.env；单测传对象，消除真实环境读写）。 */
  env?: Record<string, string | undefined>;
}

/** 组合根用到的宿主面：域拿到的是能力，不是上下文。 */
interface HostPort {
  readonly logger: { readonly warn: (message: string) => void };
  readonly register: (route: WebRoute) => () => void;
  readonly registerTool: (tool: ToolDefinition) => () => void;
}

/** 收窄宿主上下文（本文件唯一触 ctx 处）。 */
function bindHost(ctx: Context): HostPort {
  return {
    logger: ctx.logger,
    register: (route) => ctx.webServer.register(route),
    registerTool: (tool) => ctx.tools.register(tool),
  };
}

/** 装配（返回释放函数；中途失败已装部分由调用方释放）。 */
function assemble(host: HostPort, options: JevDecideApplyConfig): (() => void)[] {
  const disposers: (() => void)[] = [];
  const home = options.home;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  // 0. 存储锚定最先（动磁盘者在先）：VERSION 缺席即播种默认值，已锚定即空转，未来版本直接拒绝启动。
  upgradeApi.installUpgrade({
    io: {
      readJsonSync: storeApi.readJsonSync,
      readTextSync: storeApi.readTextSync,
      atomicWrite0600Sync: storeApi.atomicWrite0600Sync,
      listFilesSync: storeApi.listFilesSync,
    },
    logger: host.logger,
    home,
    seedDefaults: () => {
      const defaults = configApi.buildDefaultConfig();
      return {
        configJson: JSON.stringify(defaults, null, 2) + "\n",
        presetsJson: JSON.stringify({ presets: defaults.presets }, null, 2) + "\n",
        secretsJson: JSON.stringify({}, null, 2) + "\n",
      };
    },
  });
  const storeIo = {
    readJsonSync: storeApi.readJsonSync,
    readTextSync: storeApi.readTextSync,
    atomicWrite0600Sync: storeApi.atomicWrite0600Sync,
  };
  const configDeps: ConfigDeps = { io: storeIo, logger: host.logger };
  const historyDeps: HistoryDeps = {
    io: {
      readTextSync: storeApi.readTextSync,
      atomicWrite0600Sync: storeApi.atomicWrite0600Sync,
      listFilesSync: storeApi.listFilesSync,
      mtimeMs: storeApi.mtimeMs,
      removeFileSync: storeApi.removeFileSync,
      ensureDir0700: storeApi.ensureDir0700,
    },
    logger: host.logger,
  };
  const live = (): LoadedState => configApi.loadState(home, configDeps);
  const customOf = (state: LoadedState, presetId: string) =>
    state.customPresets.find((entry) => entry.id === presetId);
  const enabledOf = (state: LoadedState, presetId: string): boolean =>
    state.config.presets.find((entry) => entry.id === presetId)?.enabled ??
    customOf(state, presetId)?.enabled ??
    false;
  const capOfState = (state: LoadedState, presetId: string): AutomationCap => {
    const cap =
      state.config.presets.find((entry) => entry.id === presetId)?.automationCap ??
      customOf(state, presetId)?.automationCap;
    return cap === 1 || cap === 2 ? cap : 0;
  };
  const customMapOf = (state: LoadedState): ReadonlyMap<string, CustomPreset> =>
    new Map(state.customPresets.map((entry) => [entry.id, entry]));
  const titleOf = (state: LoadedState, presetId: string): string =>
    state.config.presets.find((entry) => entry.id === presetId) !== undefined
      ? (frozenPresetOf(presetId)?.label ?? presetId)
      : (customOf(state, presetId)?.label ?? presetId);
  let gate = toolsApi.createSemaphore(live().config.connection.maxConcurrency);
  const gateFor = (maxConcurrency: number): (<T>(task: () => Promise<T>) => Promise<T>) => {
    gate = toolsApi.createSemaphore(maxConcurrency);
    return gate.run;
  };
  let lastConcurrency = live().config.connection.maxConcurrency;
  const depsFor = (exec: unknown): DecideDeps => {
    const state = live();
    const root = toolsApi.rootOf(exec);
    const sessionId = toolsApi.sessionOf(exec);
    if (state.config.connection.maxConcurrency !== lastConcurrency) {
      lastConcurrency = state.config.connection.maxConcurrency;
      gateFor(lastConcurrency);
    }
    return {
      logger: host.logger,
      connection: state.config.connection,
      isEnabled: (presetId) => enabledOf(state, presetId),
      capOf: (presetId) => capOfState(state, presetId),
      customPresets: customMapOf(state),
      resolveKey: () => configApi.resolveApiKey(state, env, configDeps),
      recordEvent: (event) => {
        const entry = historyApi.assembleEntry(root, event.sessionId, event, Date.now());
        historyApi.appendEntry(home, entry, state.config.history, historyDeps);
      },
      fetchImpl: options.fetchImpl,
      limit: gate.run,
      root,
      sessionId,
    };
  };
  const apiDeps: ApiDeps = {
    logger: host.logger,
    register: (route) => host.register(route as unknown as WebRoute),
    version: () => configApi.pluginVersion(),
    readConfig: () => configApi.toMaskedConfig(live()),
    writeConfig: (body) => {
      const flat = configApi.normalizePutEnvelope(body);
      if (!flat.ok) {
        throw new Error(
          JSON.stringify({
            status: 400,
            errorCode: flat.failure.errorCode,
            category: flat.failure.category,
            message: flat.failure.message,
          }),
        );
      }
      const checked = configApi.validatePutBody(flat.flat);
      if (!checked.ok) {
        throw new Error(
          JSON.stringify({
            status: 400,
            errorCode: checked.failure.errorCode,
            category: checked.failure.category,
            message: checked.failure.message,
          }),
        );
      }
      const current = live();
      const effectiveRef =
        checked.patch.apiKeyRef !== undefined
          ? checked.patch.apiKeyRef
          : current.config.connection.apiKeyRef;
      if (
        checked.patch.apiKeyPlaintext !== undefined &&
        effectiveRef !== undefined &&
        effectiveRef !== null
      ) {
        throw new Error(
          JSON.stringify({
            status: 400,
            errorCode: "MUTUALLY_EXCLUSIVE",
            category: "mutually-exclusive",
            message: "clear apiKeyRef (null) before setting plaintext",
          }),
        );
      }
      return configApi.toMaskedConfig(configApi.savePatch(home, checked.patch, configDeps));
    },
    readPresets: () => {
      const state = live();
      return toolsApi
        .listPresets({
          isEnabled: (id) => enabledOf(state, id),
          capOf: (id) => capOfState(state, id),
          customs: state.customPresets,
        })
        .map((item) => ({ ...item }));
    },
    readHistory: (query) => {
      const state = live();
      return historyApi
        .queryEntries(home, query, historyDeps)
        .map((entry) => ({ ...entry, presetTitle: titleOf(state, entry.presetId) }));
    },
    removeHistory: (query) => historyApi.deleteSession(home, query, historyDeps),
    probeConnection: async () => {
      const state = live();
      const resolved = configApi.resolveApiKey(state, env, configDeps);
      return toolsApi.probeConnection({
        key: resolved.key,
        timeoutMs: state.config.connection.timeoutMs,
        fetchImpl: options.fetchImpl,
      });
    },
  };
  for (const tool of toolsApi.buildToolDefinitions({
    depsFor,
    snapshot: () => {
      const state = live();
      return {
        isEnabled: (id) => enabledOf(state, id),
        capOf: (id) => capOfState(state, id),
        customs: state.customPresets,
      };
    },
  })) {
    disposers.push(host.registerTool(tool));
  }
  for (const dispose of apiApi.installApi(apiDeps)) disposers.push(dispose);
  return disposers;
}

/** 挂载 dsh-jev-decide。 */
export function apply(ctx: Context, config: JevDecideApplyConfig = {}): void {
  if (config.enabled === false) return;
  const host = bindHost(ctx);
  let disposers: (() => void)[] = [];
  try {
    disposers = assemble(host, config);
  } catch (cause) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // 回滚期二次失败不掩盖原始错误。
      }
    }
    throw cause;
  }
  ctx.effect(
    () => () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (cause) {
          host.logger.warn(
            "dsh-jev-decide: 卸载失败 —— " +
              (cause instanceof Error ? cause.message : String(cause)),
          );
        }
      }
    },
    "dsh-jev-decide",
  );
}

/** 配置快照类型（安装面/配置面导出； narrow 类型由各域门面承载）。 */
export type { ConfigV1 } from "./shared/interface.ts";
