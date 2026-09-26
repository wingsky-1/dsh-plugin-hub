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
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
// 副作用式类型导入：把 `sessionTitle` 经声明合并注入 Context，使 `Context["sessionTitle"]`
// 即官方 `SessionTitleService`（与 provider-usage 认 `retainedBy.mainView` 的那行同款机制）。
// 实测：删掉这行则 `Context["sessionTitle"]` 报 TS2339。verbatimModuleSyntax 下完全擦除，
// 不产生运行时导入，故不影响零依赖分发物。
import type {} from "@deepseek-ai/dsh-session-title";
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
export const name = "decision-gateway";

/** 依赖的宿主服务（路由 + 模型工具注册 + 会话目录/标题解析）。sessions/sessionTitle 缺席即降级（用法见 provider-usage 同款接线）。 */
export const inject = ["webServer", "tools", "sessions", "sessionTitle"];

/** 组合层入口配置（挂载点传入；用户配置住自有三文件，不在此展开）。 */
export interface DecisionGatewayApplyConfig {
  /** 总开关；false 时不注册工具与路由。 */
  enabled?: boolean;
  /** 落盘根覆盖（缺席即 DSH home；测试走 mkdtempSync 隔离目录）。 */
  home?: string;
  /** fetch 注入（缺席即全局 fetch；单测注入 mock）。 */
  fetchImpl?: FetchImpl;
  /** 环境注入（缺席即 process.env；单测传对象，消除真实环境读写）。 */
  env?: Record<string, string | undefined>;
}

/**
 * 官方 `ctx.sessions`（`SessionStore`）的只读窄面——**不手写镜像**。
 *
 * 类型直接取自官方 `Context`：`@deepseek-ai/dsh-tools` 的类型闭包已把
 * `@deepseek-ai/dsh-session` 的声明合并带进本包编译单元，故 `Context["sessions"]`
 * 就是官方 `SessionStore`。此前这里手写了一份 `{get(id: string) => {header:{cwd}}}` 镜像，
 * 再用 `ctx as unknown as {...}` 双重断言把真实服务塞进去——镜像与官方签名一旦漂移，
 * 编译器无从报警（provider-usage 的 `current` 事故就是这类镜像的代价）。
 *
 * 窄到 `Pick<…, "get">` 是刻意取舍：本插件只读会话目录（解析 cwd / 找活会话），
 * 不写、不订阅、不开作用域，`SessionStore` 其余能力不该出现在域端口上。
 * 品牌化的 `SessionId` 只在边界有意义，故用 `Parameters<>` 取回它做参数位桥接，域内仍是 string。
 */
type HostSessions = Pick<Context["sessions"], "get">;

/**
 * 官方品牌化的 `SessionId`（`string & BRAND`）——裸 string 经它桥接进官方签名。
 * 与 provider-usage 宿主端 apply.ts:454 的 `Parameters<typeof ctx.sessions.get>[0]` 同款。
 */
type HostSessionId = Parameters<HostSessions["get"]>[0];

/**
 * 官方 `ctx.sessionTitle`（`SessionTitleService`）的只读窄面——与 `HostSessions` 同款官方派生。
 *
 * 类型同样取自官方 `Context`：`@deepseek-ai/dsh-session-title` 的声明合并把 `sessionTitle`
 * 注入了 `Context`（本包已在 devDependencies/peerDependencies 声明该依赖，故类型可达），
 * 于是 `Context["sessionTitle"]` 就是官方 `SessionTitleService`。
 *
 * 窄到 `Pick<…, "get">` 的取舍与上面同源：本插件只读标题快照（enrich 历史条目），
 * 不改名、不刷新、不注册 provider——`SessionTitleService` 其余能力不该上域端口。
 * 两个端口的「同一会话」由官方签名本身保证：`SessionTitleService.get` 的参数就是
 * `SessionStore.get` 的返回类型，目录口与标题口在类型层天然对齐，不可能各自漂移。
 */
type HostSessionTitle = Pick<Context["sessionTitle"], "get">;

/** 组合根用到的宿主面：域拿到的是能力，不是上下文。sessions/sessionTitle 为可选（旧运行时/单测 fake ctx 缺席即降级，绝不抛）。 */
interface HostPort {
  readonly logger: { readonly warn: (message: string) => void };
  readonly register: (route: WebRoute) => () => void;
  readonly registerTool: (tool: ToolDefinition) => () => void;
  /** 官方 `SessionStore` 的只读窄面（见 `HostSessions`）。 */
  readonly sessions?: HostSessions;
  /** 官方 `SessionTitleService` 的只读窄面（见 `HostSessionTitle`）。 */
  readonly sessionTitle?: HostSessionTitle;
}

/** 收窄宿主上下文（本文件唯一触 ctx 处）。 */
function bindHost(ctx: Context): HostPort {
  return {
    logger: ctx.logger,
    register: (route) => ctx.webServer.register(route),
    registerTool: (tool) => ctx.tools.register(tool),
    // 官方类型直取，零断言：`ctx.sessions` / `ctx.sessionTitle` 已是官方 SessionStore 与
    // SessionTitleService，窄化只发生在上面两个 Pick 的声明上。运行时缺席（单测 fake ctx /
    // 旧运行时）由 HostPort 的可选属性 + 域侧 `?.` 承接，一律降级不抛——不需要在接线处
    // 再为「可能不在」写断言。
    sessions: ctx.sessions,
    sessionTitle: ctx.sessionTitle,
  };
}

/** 装配（返回释放函数；中途失败已装部分由调用方释放）。 */
function assemble(host: HostPort, options: DecisionGatewayApplyConfig): (() => void)[] {
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
  /** 会话标题读取时 enrich（只读活会话快照，永不落盘；缺席/抛错/无标题即回落短 id）。 */
  const sessionTitleOf = (sessionId: string): { readonly sessionTitle?: string } => {
    try {
      // 裸 string → 官方品牌化 SessionId 的参数位桥接（品牌只在边界有意义）。
      const session = host.sessions?.get(sessionId as HostSessionId);
      if (session === undefined) return {};
      const snapshot = host.sessionTitle?.get(session);
      const title = snapshot?.title;
      if (typeof title !== "string" || title.length === 0) return {};
      return { sessionTitle: title };
    } catch {
      return {};
    }
  };
  let gate = toolsApi.createSemaphore(live().config.connection.maxConcurrency);
  const gateFor = (maxConcurrency: number): (<T>(task: () => Promise<T>) => Promise<T>) => {
    gate = toolsApi.createSemaphore(maxConcurrency);
    return gate.run;
  };
  let lastConcurrency = live().config.connection.maxConcurrency;
  /** 工作目录解析（sessions store 优先，exec 字段次之，进程 cwd 兜底；store 缺席/抛错即降级）。 */
  const resolveRoot = (exec: ToolRunContext, sessionId: string): string => {
    try {
      // 裸 string → 官方品牌化 SessionId 的参数位桥接（品牌只在边界有意义）。
      const cwd = host.sessions?.get(sessionId as HostSessionId)?.header.cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
      /* 降级到 exec 派生，见下 */
    }
    return toolsApi.rootOf(exec);
  };
  const depsFor = (exec: ToolRunContext): DecideDeps => {
    const state = live();
    const sessionId = toolsApi.sessionOf(exec);
    const root = resolveRoot(exec, sessionId);
    if (state.config.connection.maxConcurrency !== lastConcurrency) {
      lastConcurrency = state.config.connection.maxConcurrency;
      gateFor(lastConcurrency);
    }
    return {
      logger: host.logger,
      signal: exec.signal,
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
      return historyApi.queryEntries(home, query, historyDeps).map((entry) => ({
        ...entry,
        presetTitle: titleOf(state, entry.presetId),
        ...sessionTitleOf(entry.sessionId),
      }));
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

/** 挂载 dsh-decision-gateway。 */
export function apply(ctx: Context, config: DecisionGatewayApplyConfig = {}): void {
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
            "dsh-decision-gateway: 卸载失败 —— " +
              (cause instanceof Error ? cause.message : String(cause)),
          );
        }
      }
    },
    "dsh-decision-gateway",
  );
}

/** 配置快照类型（安装面/配置面导出； narrow 类型由各域门面承载）。 */
export type { ConfigV1 } from "./shared/interface.ts";
