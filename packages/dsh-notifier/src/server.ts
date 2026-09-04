/**
 * dsh-notifier — 服务器侧逻辑：SSE 推送、系统通知通道、HTTP 路由。
 *
 * 全部可变状态经工厂函数收口（createSseHub / createSystemNotifier），
 * 路由经 buildRoutes(deps) 纯组装——deps 由 index.ts 装配层注入，
 * 本模块自身不持有跨请求状态以外的生命周期职责。
 *
 * #515：SSE 连接管理（表/心跳/上限淘汰/stalled+maxAge 主动回收）收敛到
 * shared/sse-hub.js 单一实现（连接状态机）；本文件保留 notifier 业务包装
 * （seq + 滚动缓冲 + ?since 补拉）与对外接口不变。
 */
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { writeJson, readBody, errorMessage, sseData, guardLoopbackMethod } from "../../../shared/host-utils.js";
import { createSseHub as createSharedHub } from "../../../shared/sse-hub.js";
import type { NotifyConfig } from "./config.ts";
import { sanitizePatchSettings, validateSettings, redactConfigView, unmaskChannels } from "./config.ts";
import type { HistoryStore } from "./history.ts";
import { buildSystemCommand } from "./message.ts";

/** 与客户端共享的路由常量（smoke 断言两端一致）。 */
export const ROUTES = {
  config: "/api/dsh-notifier/config",
  events: "/api/dsh-notifier/events",
  health: "/api/dsh-notifier/health",
  test: "/api/dsh-notifier/test",
  history: "/api/dsh-notifier/history",
  status: "/api/dsh-notifier/status",
  kinds: "/api/dsh-notifier/kinds",
};

/** SSE 推送枢纽：连接表、滚动缓冲广播、心跳。
 *  #515：连接管理（表/心跳/上限淘汰/stalled+maxAge 回收）收敛到 shared/sse-hub.js，
 *  本接口保留 notifier 业务面（broadcast(payload) 带 seq+滚动缓冲、framesSince 补拉）。
 *  类型 = 共享 hub 核心面 + notifier 业务广播（对象负载）+ 滚动缓冲回放。
 */
import type { SseConnHealth, SseEvictStats } from "../../../shared/sse-hub.js";
export type { SseConnHealth, SseEvictStats };
export type { SseHubOptions } from "../../../shared/sse-hub.js";

/** notifier 视角的 SSE 枢纽：共享连接管理面 + 业务广播 + 断线补拉。
 *  注意不 extends 共享 SseHub：共享的 broadcast(text) 是「写现成帧」原语，
 *  本接口的 broadcast(payload) 是「对象负载 → 附加 seq → 广播」业务语义，
 *  两者签名不同，用组合而非继承（register/size/dispose 委托共享 hub）。 */
export interface SseHub {
  /** 注册一条 SSE 连接：入表 + 挂 close/error 监听 + 上限淘汰（委托共享 hub）。 */
  register(res: ServerResponse): void;
  /** 广播一帧业务通知：附加递增 seq、入滚动缓冲、推给所有连接。 */
  broadcast(payload: Record<string, unknown>): void;
  /** 断线补拉：滚动缓冲中 seq 更大的帧（独立于 /history 截断）。 */
  framesSince(since: number): Array<Record<string, unknown> & { seq: number }>;
  /** 当前连接数（语义 = 服务端未释放句柄数）。 */
  size(): number;
  /** evict 原因计数（health 观测）。 */
  evictStats(): SseEvictStats;
  /** 连接健康快照（health per-conn 观测）。 */
  connHealth(now?: number): SseConnHealth[];
  /** 停止心跳定时器。 */
  dispose(): void;
}

/**
 * 创建 SSE 枢纽（notifier 业务包装）。
 *
 * 连接管理（register/size/dispose/心跳/stalled+maxAge 回收）委托共享 hub
 * （shared/sse-hub.js，#515）；本包装在共享 hub 之上叠加 notifier 业务广播：
 * broadcast(payload) 附加递增 seq、入 600 条滚动缓冲（断线回放独立于 /history
 * 截断），framesSince(since) 供 events 路由 ?since 补拉。
 *
 * @param options.getMaxConnections 连接上限实时读取器（配置改动即时生效）。
 * @param options.heartbeatMs 心跳间隔（默认 30s；测试注入短值）。
 * @param options.stalledTimeoutMs stalled 回收窗口（默认 90s；测试注入短值）。
 * @param options.maxAgeMs maxAge 轮换上限（默认 120min；0 = 关闭轮换）。
 * @param options.idleTimeoutMs maxAge 轮换空闲门槛（默认 15min）。
 */
export function createSseHub(options: {
  getMaxConnections: () => number;
  heartbeatMs?: number;
  stalledTimeoutMs?: number;
  maxAgeMs?: number;
  idleTimeoutMs?: number;
}): SseHub {
  const { getMaxConnections } = options;
  // 共享 hub：连接表 + 心跳 + 上限淘汰 + stalled/maxAge 主动回收（单一实现）。
  const hub = createSharedHub({
    getMaxConnections,
    heartbeatMs: options.heartbeatMs,
    stalledTimeoutMs: options.stalledTimeoutMs,
    maxAgeMs: options.maxAgeMs,
    idleTimeoutMs: options.idleTimeoutMs,
  });

  /** SSE 已派发帧的滚动缓冲（断线回补用；上限 RECENT_LIMIT，独立于 /history 的
   *  200 条截断，避免补拉时尾部事件被截掉）。 */
  const RECENT_LIMIT = 600;
  let notifySeq = 0;
  const recentFrames: Array<Record<string, unknown> & { seq: number }> = [];

  return {
    register: hub.register,
    size: hub.size,
    dispose: hub.dispose,
    evictStats: hub.evictStats,
    connHealth: hub.connHealth,
    /** 业务广播：附加 seq → 入滚动缓冲 → 经共享 hub 写全部连接（判死收口在 hub）。 */
    broadcast(payload: Record<string, unknown>) {
      const frame: Record<string, unknown> & { seq: number } = Object.assign({}, payload, { seq: ++notifySeq });
      recentFrames.push(frame);
      if (recentFrames.length > RECENT_LIMIT) recentFrames.shift();
      hub.broadcast(sseData(frame));
    },
    /** 断线补拉：滚动缓冲中 seq 更大的帧（?since 语义不变）。 */
    framesSince(since: number) {
      return recentFrames.filter((frame) => frame.seq > since);
    },
  };
}

/** 系统通知通道：节流 + 子进程生命周期兜底。 */
export interface SystemNotifier {
  /** 发一条系统原生 toast（fire-and-forget；全部失败静默）。 */
  notify(title: string, message: string): void;
}

/**
 * 创建系统通知通道。
 * @param options.getSoundEnabled 提示音开关的实时读取器（PUT /config 后立即生效）。
 * @param options.toastScript toast.ps1 路径。
 * @param options.warn 日志出口（ctx.logger.warn）。
 */
export function createSystemNotifier(options: { getSoundEnabled: () => boolean; toastScript: string; warn: (message: string) => void }): SystemNotifier {
  const { getSoundEnabled, toastScript, warn } = options;

  /** 系统通知节流间隔：防连发（生产密集事件/连点测试按钮）造成 spawn 风暴。 */
  const SYSTEM_NOTIFY_THROTTLE_MS = 1000;
  let lastSystemNotifyAt = 0;

  /** notify-send 可用性探测（仅 Linux 需要；macOS 走 osascript，darwin 分支
   *  不依赖此探测，故不在 macOS 上无谓尝试缺失的 notify-send）。异步，只探一次。 */
  let notifySendAvailable: boolean | undefined = undefined;
  if (process.platform === "linux") {
    execFile("notify-send", ["--version"], { timeout: 3000 }, (error) => {
      notifySendAvailable = error === null;
    });
  }

  return {
    /**
     * 系统原生 toast（fire-and-forget + 30s 超时杀进程；全部失败静默）。
     * 命令构造走 message.ts 纯函数 buildSystemCommand（smoke 断言参数形态）：
     * Windows：PowerShell WinRT toast；macOS：osascript display notification；
     * 其他：notify-send（可用才调用）。
     */
    notify(title: string, message: string) {
      // 1s 节流：桌面通知连发只保留第一个，避免子进程风暴
      const now = Date.now();
      if (now - lastSystemNotifyAt < SYSTEM_NOTIFY_THROTTLE_MS) return;
      lastSystemNotifyAt = now;
      // 截断按码点而非 UTF-16 code unit：防 emoji 等代理对在边界被腰斩成
      // 孤立代理（经 JSON/base64 后变成 U+FFFD 替换符显示，issue #238 配套）。
      const truncateCodePoints = (s: string, max: number): string => {
        const chars = Array.from(s);
        return chars.length > max ? chars.slice(0, max).join("") : s;
      };
      const safeTitle = truncateCodePoints(String(title), 64);
      const safeMessage = truncateCodePoints(String(message), 256);
      let child: ChildProcess | undefined;
      let bin = "";
      try {
        const argv = buildSystemCommand(process.platform, safeTitle, safeMessage, {
          silent: getSoundEnabled() === false,
          notifySendAvailable,
          toastScript,
        });
        if (argv === null) return; // 通道不可用（如 Linux 探测到 notify-send 缺失）：静默跳过
        bin = argv[0];
        // 关键：原生二进制缺失/不可执行（ENOENT 等）必须被下方 error 事件接住，
        // 绝不能冒泡成 unhandled 'error' 把宿主进程打挂——历史版本在 macOS 上因
        // 直接 spawn powershell 失败且未挂 error 监听而崩溃（见 issue #1）。
        child = spawn(bin, argv.slice(1), process.platform === "win32" ? { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] } : { stdio: "ignore" });
      } catch (error) {
        warn(`dsh-notifier: 系统通知启动失败: ${errorMessage(error)}`);
        return;
      }
      if (!child) return; // 极端情况下 spawn 返回空（理论上不会），直接放弃，不碰 child
      // Windows 分支限长收集 stderr：PS 的诊断（param 绑定失败、WinRT 异常等）
      // 原先随 stdio ignore 全部丢弃，排查只能盲猜（issue #238）；只留尾部片段进日志。
      let stderrTail = "";
      if (process.platform === "win32" && child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrTail.length < 512) stderrTail += chunk.toString("utf8");
        });
      }
      const killer = setTimeout(() => {
        try {
          child!.kill();
        } catch {
          // 忽略
        }
      }, 30000);
      // 任何退出码都先清杀手定时器；非 0 且非被信号杀死（null）才记日志，
      // 避免把「我们主动 30s 超时杀掉子进程」也当成异常刷屏。
      child.on("exit", (code) => {
        clearTimeout(killer);
        if (code !== 0 && code !== null) {
          const tail = stderrTail.trim();
          warn(`dsh-notifier: 系统通知退出码异常（exit ${code}）${tail ? `：${tail.slice(-300)}` : ""}`);
        }
      });
      // 通道失败（二进制不在 PATH / 无桌面会话等）：非 Windows 记一次后置为不可用，
      // 后续通知走 null 分支静默跳过；Windows 不置位（powershell 偶发失败不代表
      // WinRT toast 通道整体失效）。无论如何只记日志、不抛、不崩。
      child.on("error", (error) => {
        clearTimeout(killer);
        if (process.platform !== "win32") notifySendAvailable = false;
        warn(`dsh-notifier: 系统通知不可用（${bin}）: ${errorMessage(error)}`);
      });
    },
  };
}

/** buildRoutes 的依赖注入面（全部由 index.ts 装配层提供）。 */
export interface RouteDeps {
  /** 当前生效配置（schemastery 解析值，含默认值兜底；GET /config 的 effective）。 */
  resolve(): NotifyConfig;
  /** settings user 层原始节与 revision（describe({redactSecrets:true}) 读取）。 */
  readUser(): { user: Record<string, unknown>; revision?: number };
  /** settings 服务是否可用（决定 PUT 是否可写：writable:false → 503）。 */
  writable(): boolean;
  /** 增量 merge patch 进 settings user 层（乐观并发经 expectedRevision）。 */
  update(patch: object, expectedRevision?: number): Promise<void>;
  /** 日志出口。 */
  logger: { warn: (message: string) => void; info: (message: string) => void };
  /** SSE 推送枢纽。 */
  sse: SseHub;
  /** 系统通知通道。 */
  system: SystemNotifier;
  /** 通知历史存储。 */
  history: HistoryStore;
  /** 测试通知（收敛到 service 管线；channelId 可选指定单频道——per-channel 测试）。 */
  sendTest(channelId?: string): Array<{ channelId: string; status: string; error?: string }>;
  /** 频道投递状态读取（GET /status；per-channel 最近投递终态）。 */
  statusReader(): Promise<Record<string, unknown>>;
  /** 动态 kind 清单（GET /kinds；含确认态）。 */
  listKinds(): Array<{ id: string; label: string; confirmed: boolean }>;
  /** 动态 kind 确认写入（POST /kinds；持久化到配置 allowKinds）。 */
  setConfirm(kind: string, confirmed: boolean): Promise<void>;
}

/** applyConfigPatch 的结果。 */
export type PatchResult =
  | { ok: true; value: { user: Record<string, unknown>; revision?: number } }
  | { ok: false; status: number; code: string; response: Record<string, unknown> };

/**
 * 配置保存纯函数（PUT /config 的主体，独立导出供 smoke 单测）：
 * channels[].deviceKey 掩码按 id 对齐回填 user 层原值（评审 P0-2：必须先于
 * 校验，掩码不是合法 key 语义）→ validateSettings 定位首个非法键（400 + hint）
 * → sanitizePatchSettings 净化（已知键校验 + 未知键透传保留、装配键剔除，
 * #470）→ 经 settings 服务 update 增量写入（expectedRevision
 * 可选做乐观并发）。错误映射（R3）：SETTINGS_CONFLICT → 409 固定文案；settings
 * 缺失 → 503 settings-unavailable；写入异常原文只进服务端日志（P2-2）。
 * 成功响应的 user 经 redactConfigView 统一脱敏（评审 P0-1 单一出口）。
 */
export async function applyConfigPatch(deps: RouteDeps, payload: unknown): Promise<PatchResult> {
  if (!deps.writable()) {
    return { ok: false, status: 503, code: "settings-unavailable", response: { error: "设置服务不可用", code: "settings-unavailable" } };
  }
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    patch?: unknown;
    expectedRevision?: unknown;
  };
  const expectedRevision =
    typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision) ? body.expectedRevision : undefined;
  const rawPatch = body.patch;
  // 掩码回填先于校验（评审 P0-2）：channels 实例的 deviceKey 整值等于掩码时按
  // id 对齐回填 user 层原值；新实例（user 层无同 id）带掩码 → 400 拒绝。
  let effectivePatch: unknown = rawPatch;
  if (typeof rawPatch === "object" && rawPatch !== null && Array.isArray((rawPatch as Record<string, unknown>).channels)) {
    const userChannels = (deps.readUser().user as Record<string, unknown> | undefined)?.channels;
    const unmasked = unmaskChannels((rawPatch as Record<string, unknown>).channels, userChannels);
    if (!unmasked.ok) {
      return {
        ok: false,
        status: 400,
        code: "invalid",
        response: { error: "配置校验失败: channels", hint: "新增实例的 deviceKey 不能为掩码占位（********），请填入真实 key" },
      };
    }
    effectivePatch = { ...(rawPatch as Record<string, unknown>), channels: unmasked.channels };
  }
  // 先定位首个非法键（H6）：错误文案指明字段与合法范围，不再静默丢弃回默认
  const invalid = validateSettings(effectivePatch);
  if (invalid !== null) {
    return { ok: false, status: 400, code: "invalid", response: { error: `配置校验失败: ${invalid.key}`, hint: invalid.hint } };
  }
  // #470 双通道拆分后 PUT 走透传净化（未知键保留、装配键剔除）：
  // 「至少一个有效配置键」判据改为「原始 patch 非空对象」——纯未知键 patch
  // （如 {futureKey:1}）→ 200 透传写入；仅空 patch {}（无任何键可写）→ 400。
  if (typeof rawPatch !== "object" || rawPatch === null || Object.keys(rawPatch).length === 0) {
    return { ok: false, status: 400, code: "invalid", response: { error: "配置校验失败: patch", hint: "需至少包含一个配置键（patch 不能为空）" } };
  }
  const sanitized = sanitizePatchSettings(effectivePatch);
  if (sanitized === null || Object.keys(sanitized).length === 0) {
    // null = 已知键非法（validateSettings 已拦，理论不可达兜底）；空对象 =
    // 原始 patch 仅含装配键（剔除后无任何可写键）→ 同空 patch 语义 400
    return { ok: false, status: 400, code: "invalid", response: { error: "配置校验失败: patch", hint: "需至少包含一个有效配置键" } };
  }
  try {
    await deps.update(sanitized as Record<string, unknown>, expectedRevision);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === "SETTINGS_CONFLICT") {
      return { ok: false, status: 409, code: "conflict", response: { error: "版本冲突", code: "SETTINGS_CONFLICT" } };
    }
    // P2-2：对外收敛固定文案，不把底层异常原文（可能含路径等内部信息）回给
    // 客户端；完整原因走服务端日志。
    deps.logger.warn(`dsh-notifier: 配置保存写入设置存储失败 — ${errorMessage(err)}`);
    return { ok: false, status: 500, code: "error", response: { error: "保存失败，请查看服务端日志" } };
  }
  // 单一脱敏出口（评审 P0-1）：readUser 的 user 含 channels 明文，掩码后返回
  const fresh = deps.readUser();
  return { ok: true, value: { user: redactConfigView(fresh.user), revision: fresh.revision } };
}

/**
 * 构造五条路由（loopback 围栏 + 方法白名单是每条路由的必项）。
 * @returns WebRoute 数组（调用方逐条 register，收集 disposer）。
 */
export function buildRoutes(deps: RouteDeps): WebRoute[] {
  const { resolve, readUser, writable, update, logger, sse, history, sendTest, statusReader, listKinds, setConfirm } = deps;

  const configRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.config,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET", "PUT"])) return;
      if (req.method === "GET") {
        const { user, revision } = readUser();
        // 凭据脱敏单一出口（评审 P0-1）：user 与 effective 双视图都经
        // redactConfigView 掩码 deviceKey——深度扫描契约测试锁死两出口。
        writeJson(res, 200, {
          ok: true,
          user: redactConfigView(user),
          revision,
          effective: redactConfigView(resolve()),
          writable: writable(),
        });
        return;
      }
      if (req.method === "PUT") {
        let body: unknown;
        try {
          body = await readBody(req, 16 * 1024);
        } catch (error) {
          const message = errorMessage(error);
          if (message.includes("invalid JSON body")) {
            // 非法 JSON：连接尚存，返回可读 400，避免请求「无响应挂起」
            writeJson(res, 400, { ok: false, error: { code: "invalid-json", details: `invalid JSON body: ${message}` } });
            return;
          }
          // 超限路径：readBody 已 reject 并 destroy 连接（防超大 body 占内存），
          // socket 已断开无法再写响应——记录日志即可（shared/host-utils.js 语义）
          logger.warn(`dsh-notifier: 配置请求体读取失败: ${message}`);
          return;
        }
        // #470 复核 P0-2 兜底：applyConfigPatch 内部异常（理论不可达——净化/
        // 校验/脱敏对任意输入均收敛为错误分支，此处防未来改动引入未捕获抛错）
        // 不得让 handler 冒泡成宿主 500/悬挂——收敛 500 固定文案 + 服务端日志
        let result: PatchResult;
        try {
          result = await applyConfigPatch(deps, body);
        } catch (error) {
          logger.warn(`dsh-notifier: 配置保存处理异常 — ${errorMessage(error)}`);
          writeJson(res, 500, { ok: false, error: { error: "保存失败，请查看服务端日志" } });
          return;
        }
        if (!result.ok) {
          writeJson(res, result.status, { ok: false, error: result.response });
          return;
        }
        writeJson(res, 200, { ok: true, user: result.value.user, revision: result.value.revision });
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };

  const eventsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      // ?since=<seq>：断线补拉——先回放滚动缓冲中 seq 更大的帧，再进入实时；
      // 补拉独立于 /history（200 条截断），不丢尾部事件。
      let since = 0;
      try {
        const raw = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("since");
        const parsed = raw === null ? 0 : Number(raw);
        since = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      } catch {
        since = 0;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // 预存在缺口随手修（#334 评审遗留 P2-9）：connected 锚点写失败（对端已断）
      // 直接返回、不再 register——已断连接入表只会成为靠心跳/广播兜底清理的残留。
      try {
        res.write(": connected\n\n");
      } catch {
        return;
      }
      if (since > 0) {
        for (const frame of sse.framesSince(since)) {
          try {
            res.write(sseData(frame));
          } catch {
            break; // 连接已断
          }
        }
      }
      // 入表 + 挂 close/error 监听 + 连接上限淘汰，全部收口在 sse.register
      sse.register(res);
    },
  };

  /** 健康检查：插件是否加载、配置摘要、SSE 连接数与回收观测。
   *  sseConnections 语义 = 服务端未释放的 SSE 句柄数，非「在线设备数」；上限见
   *  config.maxConnections。#515 起连接表由 shared/sse-hub 管理：stalled 超窗 /
   *  maxAge 轮换主动回收 + 上限淘汰，sseEvicts 暴露各回收路径计数（观测残留构成），
   *  sseConnHealth 暴露逐连接 age/lastWriteAgo/stalled（先量化再调参）。 */
  const healthRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const current = resolve();
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-notifier",
        config: {
          notifyAsk: current.notifyAsk,
          notifyQuestion: current.notifyQuestion,
          notifyTaskDone: current.notifyTaskDone,
          notifySubagentDone: current.notifySubagentDone,
          notifyTaskError: current.notifyTaskError,
          systemNotify: current.systemNotify,
          browserNotify: current.browserNotify,
          notifyWhenVisible: current.notifyWhenVisible,
          notifySound: current.notifySound,
          quietHours: current.quietHours,
          maxConnections: current.maxConnections,
        },
        sseConnections: sse.size(),
        sseEvicts: sse.evictStats(),
        sseConnHealth: sse.connHealth(),
      });
    },
  };

  /**
   * 测试通知：POST 触发一条测试通知（绕过免打扰，测试意图是验证通道本身）。
   * M2 收敛到 service 管线（sendKind('test')）：内置 browser/system 与配置驱动
   * 频道（bark）走同一分发路径——测试才有意义（验证真实投递链路），历史落盘
   * 与终态上报（status/sent 事件）同源。body 可选 {channelId}：指定单频道测试
   * （设置页频道卡「测试」按钮）。固定文案模板，不引入自由文本面（评审定案）。
   * 返回的 sseConnections 语义同 /health = 服务端未释放句柄数（非设备数）。
   */
  const testRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.test,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      let channelId: string | undefined;
      try {
        // body 可选：无 body / 测试桩无流 → channelId 保持 undefined（全频道测试）
        const parsed = (await readBody(req, 4 * 1024)) as { channelId?: unknown } | null;
        if (parsed && typeof parsed === "object" && typeof parsed.channelId === "string" && parsed.channelId.length > 0) {
          channelId = parsed.channelId;
        }
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes("invalid JSON body")) {
          writeJson(res, 400, { ok: false, error: { code: "invalid-json", details: `invalid JSON body: ${message}` } });
          return;
        }
        // 其余（无 body 流的桩请求 / 超限 destroy）：body 可选语义，按全频道测试继续
        logger.warn(`dsh-notifier: 测试通知请求体读取失败（按无 body 处理）: ${message}`);
      }
      const results = sendTest(channelId);
      writeJson(res, 200, { ok: true, sseConnections: sse.size(), results });
    },
  };

  /**
   * 频道投递状态：GET 返回 per-channel 最近投递终态（status 文件内存镜像）。
   * 设置页频道卡状态区消费（ok 灰 / failed 高亮 + 错误摘要——已脱敏）。
   */
  const statusRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.status,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const channels = await statusReader();
      writeJson(res, 200, { ok: true, channels });
    },
  };

  /**
   * 动态 kind 清单与确认：GET 返回注册表（含确认态，确认态持久化在配置
   * allowKinds）；POST {kind, confirmed} 写确认（仅注册表内已注册的动态 kind）。
   * 确认动作只发生在用户主动打开设置页时（终稿 §5.1：注册即弹窗打扰不允许）。
   */
  const kindsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.kinds,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
      if (req.method === "GET") {
        writeJson(res, 200, { ok: true, kinds: listKinds() });
        return;
      }
      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readBody(req, 4 * 1024);
        } catch (error) {
          const message = errorMessage(error);
          if (message.includes("invalid JSON body")) {
            writeJson(res, 400, { ok: false, error: { code: "invalid-json", details: `invalid JSON body: ${message}` } });
            return;
          }
          logger.warn(`dsh-notifier: kind 确认请求体读取失败: ${message}`);
          return;
        }
        const { kind, confirmed } = (typeof body === "object" && body !== null ? body : {}) as { kind?: unknown; confirmed?: unknown };
        if (typeof kind !== "string" || kind.length === 0 || typeof confirmed !== "boolean") {
          writeJson(res, 400, { ok: false, error: { code: "invalid", details: "需为 { kind: string, confirmed: boolean }" } });
          return;
        }
        const known = listKinds().some((k) => k.id === kind);
        if (!known) {
          writeJson(res, 404, { ok: false, error: { code: "not-found", details: `未注册的动态 kind: ${kind}` } });
          return;
        }
        // #405 PR3：setConfirm 现为 CAS 循环（可抛 SETTINGS_CONFLICT 耗尽 / 服务
        // 缺失 rejection）——handler 必须兜底（评审 P1-1），防 rejection 冒泡成
        // 宿主行为未定义；200 响应体带新 revision（向后兼容新增字段）供客户端
        // confirmOne 同步 meta——修「确认 kind 后同窗口保存必 409」的版本链断点。
        try {
          await setConfirm(kind, confirmed);
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          if (code === "SETTINGS_CONFLICT") {
            writeJson(res, 409, { ok: false, error: { code: "SETTINGS_CONFLICT", error: "版本冲突" } });
            return;
          }
          logger.warn(`dsh-notifier: kind 确认写入失败 — ${errorMessage(error)}`);
          writeJson(res, 500, { ok: false, error: { error: "确认失败，请查看服务端日志" } });
          return;
        }
        const { revision: freshRevision } = readUser();
        writeJson(res, 200, { ok: true, kinds: listKinds(), revision: freshRevision });
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };

  /** 通知历史：GET 返回最近记录（jsonl 尾部最多 HISTORY_LIMIT 条）。 */
  const historyRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET", "DELETE"])) return;
      if (req.method === "GET") {
        const records = await history.read();
        writeJson(res, 200, { ok: true, records });
        return;
      }
      if (req.method === "DELETE") {
        const removed = await history.clear();
        writeJson(res, 200, { ok: true, removed });
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };

  return [configRoute, eventsRoute, healthRoute, testRoute, historyRoute, statusRoute, kindsRoute];
}
