// @ts-nocheck
/**
 * dsh-notifier — smoke 测试共享辅助（fake ctx / fake req/res / 轮询）。
 *
 * 无副作用模块：不创建临时目录、不触发 apply；work 目录由各测试文件
 * 自建自清（隔离文件路径，防 flake——见 docs/DEVELOPMENT.md §5）。
 */
import { join } from "node:path";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

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
 * fake cordis ctx：路由表 + 事件监听器表 + effect（真实语义：fn 立即同步
 * 执行，返回值收集为 disposer）。
 */
export function makeFakeCtx(overrides = {}) {
  const routes = [];
  const listeners = new Map();
  const ctx = {
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
      return typeof disposer === "function" ? disposer : () => {};
    },
    ...overrides,
  };
  return { ctx, routes, listeners };
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
 * apply 一份 notifier（默认 enabled + work 内独立配置/历史文件路径）。
 * @param workDir 该测试文件的临时目录。
 * @param config apply 配置覆盖（configFile/toastScript/historyFile 已给默认）。
 * @param ctxOverrides makeFakeCtx 覆盖（如注入 get / 自定义 logger）。
 */
export async function makeNotifier(workDir, config = {}, ctxOverrides = {}) {
  const { ctx, routes, listeners } = makeFakeCtx(ctxOverrides);
  await apply(ctx, {
    enabled: true,
    configFile: join(workDir, "config.json"),
    toastScript: join(workDir, "toast.ps1"),
    historyFile: join(workDir, "history.jsonl"),
    ...config,
  });
  return { ctx, routes, listeners };
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
