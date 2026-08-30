/**
 * dsh-notifier — 服务器侧逻辑：SSE 推送、系统通知通道、HTTP 路由。
 *
 * 全部可变状态经工厂函数收口（createSseHub / createSystemNotifier），
 * 路由经 buildRoutes(deps) 纯组装——deps 由 index.ts 装配层注入，
 * 本模块自身不持有跨请求状态以外的生命周期职责。
 */
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, readBody, errorMessage } from "../../../shared/host-utils.js";
import type { NotifyConfig } from "./config.ts";
import { sanitizeSettings, validateSettings } from "./config.ts";
import type { HistoryStore } from "./history.ts";
import { buildSystemCommand } from "./message.ts";

/** 与客户端共享的路由常量（smoke 断言两端一致）。 */
export const ROUTES = {
  config: "/api/dsh-notifier/config",
  events: "/api/dsh-notifier/events",
  health: "/api/dsh-notifier/health",
  test: "/api/dsh-notifier/test",
  history: "/api/dsh-notifier/history",
};

/** SSE 帧。 */
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 写失败判死阈值：连续 ≥3 次写不动即销毁（理论 throw 兜底路径）。
 *  注意：真实 ServerResponse 对已断对端 write() 几乎不抛错（数据静默入队），
 *  死连接主力清理是 close / error（register 收口）与 destroyed/writableEnded 兜底，
 *  failStreak 仅兜底「抛错」这一理论路径——阈值 3 对应约 3 个广播/心跳周期，
 *  非严格 90s。write 返回 false 一律视为背压（见 writeFrame）。 */
const MAX_WRITE_FAILS = 3;

/** SSE 推送枢纽：连接表、滚动缓冲广播、心跳。 */
export interface SseHub {
  /** 注册一条 SSE 连接：入表 + 挂 close/error 监听 + 连接上限淘汰最老。 */
  register(res: ServerResponse): void;
  /** 广播一帧：附加递增 seq、入滚动缓冲、推给所有连接。 */
  broadcast(payload: Record<string, unknown>): void;
  /** 断线补拉：滚动缓冲中 seq 更大的帧（独立于 /history 截断）。 */
  framesSince(since: number): Array<Record<string, unknown> & { seq: number }>;
  /** 当前连接数（/health 展示；语义=服务端未释放句柄数，含静默半开残留）。 */
  size(): number;
  /** 停止心跳定时器。 */
  dispose(): void;
}

/**
 * 创建 SSE 枢纽并启动心跳。
 * @param options.getMaxConnections 连接上限实时读取器（配置改动即时生效，无需重启；
 *   超限时淘汰最老连接，让连接表有界——静默半开连接只增不减的根治手段）。
 */
export function createSseHub(options: { getMaxConnections: () => number }): SseHub {
  const { getMaxConnections } = options;
  /** 连接表：Map<响应, 写状态>。Map 迭代序 = 插入序，超限淘汰时第一项即最老。 */
  const connState = new Map<ServerResponse, { failStreak: number }>();

  /** SSE 已派发帧的滚动缓冲（断线回补用；上限 RECENT_LIMIT，独立于 /history 的
   *  200 条截断，避免补拉时尾部事件被截掉）。 */
  const RECENT_LIMIT = 600;
  let notifySeq = 0;
  const recentFrames: Array<Record<string, unknown> & { seq: number }> = [];

  /** 移除一条连接（幂等）：先出表再 destroy，destroy 触发的 close 回调再次 evict 无害。 */
  function evict(res: ServerResponse) {
    if (connState.delete(res)) {
      try {
        res.destroy();
      } catch {
        // 忽略
      }
    }
  }

  /** 连接上限收缩：超限淘汰最老（注册序最早）的连接，直到表不超限。
   *  register 与心跳各调用一次——配置调小后无需新注册，30s 内即收敛。 */
  function enforceLimit() {
    // 防御非法上限：normalizeConfig 已保证 [1,1024]，此处仅兜底未来直接注入
    // 闭包传入 <1 值导致 while 条件恒真空转的问题（与 oldest===undefined break 双保险）。
    const limit = Math.max(1, getMaxConnections());
    while (connState.size > limit) {
      const oldest = connState.keys().next().value;
      if (oldest === undefined) break;
      evict(oldest);
    }
  }

  /** 注册一条 SSE 连接：入表 + close/error 监听 + 上限淘汰 + socket keepalive 兜底。 */
  function register(res: ServerResponse) {
    connState.set(res, { failStreak: 0 });
    // close 是正常断连路径；error 是补 close 的缺口（现有代码缺失：不监听 error，
    // 部分路径会抛 unhandled error，且连接残留）。两者都收口到 evict（幂等）。
    res.on("close", () => evict(res));
    res.on("error", () => evict(res));
    // TCP keepalive：仅对「空闲连接」生效探测；SSE 每 30s 心跳使连接从不空闲，
    // 故对活跃写连接不触发（真正探测死连接的是 TCP 重传，分钟级）——仅兜底长空闲。
    try {
      res.socket?.setKeepAlive(true, 60000);
    } catch {
      // 忽略
    }
    enforceLimit();
  }

  /**
   * 统一写帧：成功则刷新写状态；失败累计 failStreak，连续 ≥3 次判死销毁。
   * write 返回 false 一律视为背压（TCP 接收窗口关闭，对端暂停消费），**不是断连
   * 证据**——弱网/浏览器冻结后台 tab 等健康连接可能长时间不消费，误判会造成无谓
   * 重连。仅「抛错 / destroyed / writableEnded」才判死。
   * @returns 是否成功写出。
   */
  function writeFrame(res: ServerResponse, text: string): boolean {
    const entry = connState.get(res);
    if (entry === undefined) return false;
    if (res.destroyed || res.writableEnded) {
      // 已销毁/已结束的响应：close 事件可能漏发，这里兜底直接清理
      evict(res);
      return false;
    }
    try {
      res.write(text);
      entry.failStreak = 0;
      return true;
    } catch {
      entry.failStreak += 1;
      if (entry.failStreak >= MAX_WRITE_FAILS) evict(res);
      return false;
    }
  }

  function broadcast(payload: Record<string, unknown>) {
    const frame: Record<string, unknown> & { seq: number } = Object.assign({}, payload, { seq: ++notifySeq });
    recentFrames.push(frame);
    if (recentFrames.length > RECENT_LIMIT) recentFrames.shift();
    const text = sseData(frame);
    for (const res of connState.keys()) {
      // 迭代中 evict 当前项安全（JS Map 迭代器按访问序号推进，删除不影响后续项）
      writeFrame(res, text);
    }
  }

  function framesSince(since: number) {
    return recentFrames.filter((frame) => frame.seq > since);
  }

  /**
   * SSE 心跳：每 30s 发一条 data 型 ping 帧。必须用 data 而非注释帧——注释帧
   * 既不触发客户端 onmessage 也不触发 onerror，半开连接（断网/合盖/NAT 静默
   * 掐断）时客户端零事件，无法自愈；data 帧让客户端的 watchdog 能检测失活。
   * 顺带做连接上限收缩（配置调小即收敛）与写失败判死扫描。
   */
  const HEARTBEAT_MS = 30000;
  const heartbeatTimer = setInterval(() => {
    const frame = sseData({ type: "ping" });
    for (const res of connState.keys()) {
      writeFrame(res, frame);
    }
    enforceLimit();
  }, HEARTBEAT_MS);
  // unref：心跳不阻止进程退出（服务端有主循环；测试/无连接时不会被句柄吊死）
  heartbeatTimer.unref();

  return {
    register,
    broadcast,
    framesSince,
    size: () => connState.size,
    dispose: () => clearInterval(heartbeatTimer),
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
}

/** applyConfigPatch 的结果。 */
export type PatchResult =
  | { ok: true; value: { user: Record<string, unknown>; revision?: number } }
  | { ok: false; status: number; code: string; response: Record<string, unknown> };

/**
 * 配置保存纯函数（PUT /config 的主体，独立导出供 smoke 单测）：
 * validateSettings 定位首个非法键（400 + hint）→ sanitizeSettings 净化 →
 * 经 settings 服务 update 增量写入（expectedRevision 可选做乐观并发）。
 * 错误映射（R3）：SETTINGS_CONFLICT → 409 固定文案；settings 缺失 → 503
 * settings-unavailable；写入异常原文只进服务端日志（P2-2），响应收敛固定文案。
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
  // 先定位首个非法键（H6）：错误文案指明字段与合法范围，不再静默丢弃回默认
  const invalid = validateSettings(rawPatch);
  if (invalid !== null) {
    return { ok: false, status: 400, code: "invalid", response: { error: `配置校验失败: ${invalid.key}`, hint: invalid.hint } };
  }
  const sanitized = sanitizeSettings(rawPatch);
  if (sanitized === null || Object.keys(sanitized).length === 0) {
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
  return { ok: true, value: deps.readUser() };
}

/**
 * 构造五条路由（loopback 围栏 + 方法白名单是每条路由的必项）。
 * @returns WebRoute 数组（调用方逐条 register，收集 disposer）。
 */
export function buildRoutes(deps: RouteDeps): WebRoute[] {
  const { resolve, readUser, writable, update, logger, sse, system, history } = deps;

  const configRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.config,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method === "GET") {
        const { user, revision } = readUser();
        writeJson(res, 200, {
          ok: true,
          user,
          revision,
          effective: resolve(),
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
        const result = await applyConfigPatch(deps, body);
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
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
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

  /** 健康检查：插件是否加载、配置摘要、SSE 连接数。
   *  sseConnections 语义 = 服务端未释放的 SSE 句柄数（含静默半开残留，分钟级回收），
   *  非「在线设备数」；上限见 config.maxConnections（淘汰最老）。 */
  const healthRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
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
      });
    },
  };

  /**
   * 测试通知：POST 触发一条测试通知（绕过免打扰，测试意图是验证通道本身）。
   * 系统通知 + SSE 广播同时走一遍，客户端收到 kind=test 的帧无条件弹窗。
   * 返回的 sseConnections 语义同 /health = 服务端未释放句柄数（非设备数）。
   */
  const testRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.test,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const title = "DSH：测试通知";
      const message = "通知链路工作正常（此通知来自测试按钮）";
      const payload = { type: "notify", kind: "test", title, message, ts: Date.now() };
      if (resolve().systemNotify) system.notify(title, message);
      if (resolve().browserNotify) sse.broadcast(payload);
      logger.info("dsh-notifier: test 测试通知已发送");
      history.append({ ts: payload.ts, kind: "test", title, message });
      writeJson(res, 200, { ok: true, sseConnections: sse.size() });
    },
  };

  /** 通知历史：GET 返回最近记录（jsonl 尾部最多 HISTORY_LIMIT 条）。 */
  const historyRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
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

  return [configRoute, eventsRoute, healthRoute, testRoute, historyRoute];
}
