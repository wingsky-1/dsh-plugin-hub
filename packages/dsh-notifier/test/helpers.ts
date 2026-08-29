// @ts-nocheck
/**
 * dsh-notifier — smoke 测试共享辅助（fake ctx / fake req/res / fake settings / 轮询）。
 *
 * issue #76 后配置走官方 settings 命名空间：makeNotifier 注入 fake settings 服务
 * （register/describe/update），apply 的组合层配置经 sanitizeSettings 过滤后作为
 * 命名空间 base 层；user 层可由测试经 ctxOverrides.settings 预置或 PUT 写入断言。
 *
 * 无副作用模块：不创建临时目录、不触发 apply；work 目录由各测试文件
 * 自建自清（隔离文件路径，防 flake——见 docs/DEVELOPMENT.md §5）。
 */
import { join } from "node:path";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { normalizeConfig, sanitizeSettings, SETTINGS_NS } from "../lib/index.js";

/** loopback 合法请求构造（remoteAddress 可覆盖）。 */
export function fakeReq(overrides = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    ...overrides,
  };
}

/** 响应收集器：rec.status / rec.headers / rec.text。 */
export function makeRes() {
  const rec = { status: 0, text: "" };
  return {
    rec,
    res: {
      writeHead(status, headers) {
        rec.status = status;
        rec.headers = headers;
      },
      write(text) {
        rec.text += text;
      },
      end(text) {
        if (text !== undefined) rec.text += text;
      },
      on() {},
    },
  };
}

/**
 * fake settings 服务（官方 SettingsServiceLike 最小面：register/describe/update）。
 * register 返回 owner scope（get/watch/update），解析值 = normalizeConfig(base+user)；
 * update 可选做 revision 乐观并发（expectedRevision 不匹配抛 SETTINGS_CONFLICT）。
 * @param options.base 组合层通知配置（apply entry，sanitize 后）。
 * @param options.user 预置 user 层（GET user 断言 / 迁移目标）。
 * @param options.log 可选记录 update 调用的钩子（断言「只提交变更键」）。
 */
export function makeFakeSettings(options = {}) {
  const base = options.base && typeof options.base === "object" ? options.base : {};
  let user = { ...((options.user && typeof options.user === "object") ? options.user : {}) };
  let revision = 0;
  const scopeWatchCbs = [];
  const updateCalls = [];
  const log = options.log || (() => {});

  const scope = {
    get() {
      return normalizeConfig({ ...base, ...user });
    },
    watch(cb) {
      scopeWatchCbs.push(cb);
      return () => {
        const i = scopeWatchCbs.indexOf(cb);
        if (i !== -1) scopeWatchCbs.splice(i, 1);
      };
    },
    update(patch) {
      const prev = normalizeConfig({ ...base, ...user });
      Object.assign(user, patch);
      revision += 1;
      updateCalls.push({ patch: JSON.parse(JSON.stringify(patch)), via: "scope" });
      log({ via: "scope", patch });
      fireWatch(prev);
    },
  };
  const service = {
    register(ns, schema, opts) {
      return scope;
    },
    describe(opts = {}) {
      return [{ ns: SETTINGS_NS, user: { ...user }, revision }];
    },
    async update(ns, patch, expectedRevision) {
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT", expected: expectedRevision, actual: revision });
      }
      const prev = normalizeConfig({ ...base, ...user });
      Object.assign(user, patch);
      revision += 1;
      updateCalls.push({ patch: JSON.parse(JSON.stringify(patch)), via: "service" });
      log({ via: "service", patch });
      fireWatch(prev);
    },
  };
  /** 提交后触发 scope.watch 回调（官方语义：异步串行；测试同步即可）。 */
  function fireWatch(prev) {
    for (const cb of [...scopeWatchCbs]) {
      try {
        cb(normalizeConfig({ ...base, ...user }), prev);
      } catch {
        // 回调异常不阻断（与官方 contained-watcher 语义一致）
      }
    }
  }
  return {
    scope,
    service,
    getUser: () => ({ ...user }),
    getRevision: () => revision,
    getUpdateCalls: () => updateCalls,
    setUser(next) { user = { ...next }; },
  };
}

/**
 * fake cordis ctx：路由表 + 事件监听器表 + effect（真实语义：fn 立即同步
 * 执行，返回值收集为 disposer）+ get/provide（服务读取面）+ inject（服务注入面，
 * 供 installNotifierSettings 挂 settings）。
 *
 * 未注入访问抛错镜像（issue #290 C-2）：Proxy 对未注入属性（如 ctx.agents）
 * 抛与真实 cordis 同构的错误 `cannot get property "<name>" without inject`
 * ——修复前形态（ctx.agents 直读）在 fake ctx 下同样红，杜绝根因 A 穿透
 * 门禁的测试盲区。`ctx.get(name, false)` 缺位安全返回 undefined（镜像
 * ReflectService.get 语义）；override 直接注入的「服务」属性（如 { agents }）
 * 也经 get 读取面可达，兼容按属性注入的既有用例。
 */
export function makeFakeCtx(overrides = {}) {
  const routes = [];
  const listeners = new Map();
  /** 服务读取面：provide 注册 + override 直接注入的服务属性。 */
  const services = new Map();
  /** effect 收集的 disposer（卸载面：sse.dispose / 定时器清理等，P2-5 用）。 */
  const effects = [];
  const base = {
    logger: { warn: () => {}, info: () => {} },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      const d = typeof disposer === "function" ? disposer : () => {};
      effects.push(d);
      return d;
    },
    get(name) {
      if (services.has(name)) return services.get(name);
      if (Object.prototype.hasOwnProperty.call(base, name)) return base[name];
      return undefined;
    },
    provide(name, value) {
      services.set(name, value);
      return () => services.delete(name);
    },
    inject(serviceNames, fn) {
      // 服务面注入（installNotifierSettings 经此挂 settings）：仅处理已注册服务
      if (Array.isArray(serviceNames) && serviceNames.includes("settings")) {
        const settings = services.get("settings");
        if (!settings) return;
        const sctx = {
          settings,
          effect(f2) {
            const d = f2();
            return typeof d === "function" ? d : () => {};
          },
        };
        fn(sctx);
      }
    },
    ...overrides,
  };
  // 未注入访问抛错镜像（真实 cordis 严格属性访问）：symbol/保留键（then/
  // prototype）按真实 proxy 语义直接放行，其余未注入键抛错。
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then" || prop === "prototype" || String(prop).startsWith("_")) {
        return Reflect.get(target, prop);
      }
      if (Reflect.has(target, prop)) return Reflect.get(target, prop);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
  });
  return { ctx, routes, listeners, effects };
}

/** 收集 logger.info 的 ctx（通知触发的观测面）。 */
export function makeLoggingCtx() {
  const infos = [];
  const { ctx, routes, listeners } = makeFakeCtx({
    logger: { warn: () => {}, info: (text) => infos.push(text) },
  });
  return { ctx, routes, listeners, infos };
}

/**
 * apply 一份 notifier。issue #76 后配置走 fake settings 命名空间：
 * @param workDir 该测试文件的临时目录。
 * @param config apply 配置覆盖（通知字段作为组合层 entry/base；enabled /
 *   configFile/toastScript/historyFile 为装配覆盖）。
 * @param ctxOverrides makeFakeCtx 覆盖（如注入 settings 服务 / 自定义 logger）。
 * @returns 附带 fake settings 句柄（getUser/getUpdateCalls 断言写入面）。
 */
export function makeNotifier(workDir, config = {}, ctxOverrides = {}) {
  const entry = (sanitizeSettings(config) ?? {}) || {};
  const settingsOpts = ctxOverrides.settings || {};
  const fakeSettings = makeFakeSettings({ base: entry, ...settingsOpts });
  const { ctx, routes, listeners, effects } = makeFakeCtx({
    ...ctxOverrides,
    settings: undefined, // 确保 override 的 settings 字段不污染服务读取面
  });
  ctx.provide("settings", fakeSettings.service);
  apply(ctx, {
    enabled: true,
    configFile: join(workDir, "config.json"),
    toastScript: join(workDir, "toast.ps1"),
    historyFile: join(workDir, "history.jsonl"),
    ...config,
  });
  return {
    ctx, routes, listeners, settings: fakeSettings,
    /** 卸载面：执行全部 effect disposer（sse.dispose / 定时器清理）。
     *  每个测试场景结束后调用，避免 30s unref 心跳在进程存活期内残留（P2-5）。 */
    dispose: () => {
      for (const d of effects) {
        try { d(); } catch { /* 忽略 */ }
      }
    },
  };
}

/**
 * 轮询 history 路由直到满足谓词（替代固定 sleep，消除 CI 时序竞态导致的 flake）。
 * 配合每实例独立 history 文件使用：写入来自同一 apply 单写链（串行），
 * 轮询仅兜底落盘时序，不依赖「等够固定毫秒」。
 */
export async function waitForHistory(historyRoute, predicate, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const { rec, res } = makeRes();
    await historyRoute.handler(fakeReq({}), res);
    let records = [];
    try { records = JSON.parse(rec.text).records || []; } catch { /* 解析失败则下一轮重试 */ }
    if (predicate(records)) return records;
    if (Date.now() - start > timeoutMs) return records;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * 带会话标题/子代理身份/turn/end 的 agent 辅助（模拟 dsh-session-title 与
 * dsh-agent-loop 写入的日志；真实宿主跑完一轮必有 turn/end 落盘）。
 * opts.turnEnd：turn 号（有则追加一条 turn/end 事件）；
 * opts.turnEndKind：reason.kind（默认 completed，aborted 模拟用户中断）；
 * opts.subagent：true 模拟子代理（写入 origin:'subagent'，与 DSH childSessionMeta 一致）；
 * opts.parentSession：模拟 fork/派生会话（只写 parentSession、不带 origin；
 *   是否委派 worker 由运行时归属面 fakeAgents 决定——issue #49）；
 * opts.seedLength：header.seedLength（fork 型委派持久化形态含该字段，
 *   完成判定不含它——仅用于构造注释宣称的完整 header 形态，issue #199 P2-5）；
 * opts.depth：header.delegationDepth（仅作附加，不作子代理判据）；
 * opts.cwd：header.cwd（模拟 headless CLI 会话「header 仅 {cwd}」形态）。
 */
export function agentWithTitle(id, title, opts = {}) {
  const events = [];
  if (opts.turnEnd !== undefined) {
    events.push({ type: "turn/end", data: { turn: opts.turnEnd, reason: { kind: opts.turnEndKind ?? "completed" } } });
  }
  if (title) events.push({ type: "session/title", data: { title } });
  const header = {};
  if (opts.subagent) header.origin = "subagent";
  if (opts.parentSession !== undefined) header.parentSession = opts.parentSession;
  if (opts.seedLength !== undefined) header.seedLength = opts.seedLength;
  if (opts.depth !== undefined) header.delegationDepth = opts.depth;
  if (opts.cwd !== undefined) header.cwd = opts.cwd;
  return {
    id,
    session: {
      header: Object.keys(header).length > 0 ? header : undefined,
      events,
    },
  };
}

/**
 * 完成轮两态时序构造（阶段二单源 push + 快照兜底收敛后必需，issue #290）：
 * 真实宿主中 agent/status running 派发于本轮 turn 开始——本轮 turn/end 尚未
 * post-commit 落盘，session.events 最新条目为上一轮（或空）；idle 派发于本轮
 * turn/end 落盘之后。单源收敛的 runningBaseline 冻结判据（idle 快照 ≤ running
 * 基线 = 本轮无新 closure = abort-early 陈旧快照，冻结不误报）依赖该时序——
 * 旧测试「running 与 idle 同一构造（events 已含本轮 closure）」在单源语义下会
 * 被正确识别为无新 closure 而静默（abort 早于本轮 turn/start 落盘的形态）。
 * 故所有「本轮完成」用例必须区分 running/idle 两态事件面：
 *   - running 态 = 上一轮 turn/end（prevTurn，可缺省 = 首轮无 closure）
 *   - idle 态 = 本轮 turn/end（thisTurn，lastTurnEndOf 只取最新一条，单条等价）
 * 每次调用返回全新 { running, idle } 两态（agent/status 事件不持有引用）。
 *
 * @param id agent/session id
 * @param title 任务标题（agentWithTitle 同款）
 * @param headerOpts agentWithTitle 的 header 选项（subagent/parentSession/seedLength/depth/cwd）
 * @param thisTurn 本轮 turn/end：{ turn, kind? }（写入 idle 态；kind 默认 completed）
 * @param prevTurn 上一轮 turn/end：{ turn, kind? }（写入 running 态；缺省 = 首轮）
 */
export function turnPair(id, title, headerOpts = {}, thisTurn, prevTurn) {
  const running = agentWithTitle(
    id,
    title,
    prevTurn !== undefined
      ? { ...headerOpts, turnEnd: prevTurn.turn, turnEndKind: prevTurn.kind ?? "completed" }
      : headerOpts
  );
  const idle = agentWithTitle(id, title, { ...headerOpts, turnEnd: thisTurn.turn, turnEndKind: thisTurn.kind ?? "completed" });
  return { running, idle };
}

/**
 * 运行时归属模拟面（issue #49）：ctx.agents 判定所需最小实现。
 * @param liveIds live registry 中存在的父/子 agent id 数组。
 * @param ownedPairs 归属关系对 [childId, ownerId]：isOwnedBy(childId, owner)
 *   仅当 owner 在 live 且存在对应关系对时返回 true。
 */
export function fakeAgents(liveIds = [], ownedPairs = []) {
  const live = new Map(liveIds.map((id) => [id, { id }]));
  return {
    get(id) {
      return live.get(id);
    },
    isOwnedBy(id, owner) {
      if (owner === undefined || !live.has(owner.id)) return false;
      return ownedPairs.some(([child, parent]) => child === id && parent === owner.id);
    },
  };
}

/** 等待聚合窗口（doneMergeWindowMs 默认 3s）过期。 */
export async function waitMergeWindow() {
  await new Promise((resolve) => setTimeout(resolve, 3200));
}

/**
 * session/event 回调的 turn/end 载荷构造（issue #272 双源测试用）。
 * 形态对齐官方 SessionEvent 信封的最小判定子集：{ type, data: { turn, reason } }。
 */
export function turnEndEvent(turn, kind = "completed") {
  return { type: "turn/end", data: { turn, reason: { kind } } };
}

export { assert };
