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
import type { SoundSetting } from "./config.ts";
import { sanitizePatchSettings, validateSettings, redactConfigView, unmaskChannels } from "./config.ts";
import type { HistoryStore } from "./history.ts";
import { buildSystemCommand, buildSoundCommand } from "./message.ts";
import type { SystemTone } from "./message.ts";

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
  /**
   * 发一条系统通知（弹窗/声音组合语义见 service.ts 分派；方法由调用方传参）。
   * @param pop 是否弹系统 toast 实体（false = 只响不弹）。
   * @param tone 声音设置（false=静音无自播；true=跟随系统默认；SoundId=音色）。
   * @param title 通知标题（toast 用；只响不弹时可为空串）。
   * @param message 通知正文（toast 用；只响不弹时可为空串）。
   * @returns Promise<boolean>：投递终态决议（resolve=true 成功 / false 失败——
   *   通道不可用、命令构造失败或子进程失败均 resolve false；不 reject，绝不打挂
   *   宿主）。节流吞掉（1s 窗口内重复投递）透传上一次决议语义。
   */
  notify(pop: boolean, tone: SoundSetting, title: string, message: string): Promise<boolean>;
  /** 当前是否有自播能力（音色播放器/文件探测结果；health/测试反馈用）。 */
  selfPlayAvailable(): boolean;
}

/** 系统通知节流吞掉时透传的「上一次决议」初值（首投递无上一次 = 视为可成功）。 */
let lastSystemOutcome = true;

/**
 * 创建系统通知通道。
 * @param options.resolveTone 每次投递时解析系统声音设置（PUT /config 后立即生效）。
 * @param options.toastScript toast.ps1 路径。
 * @param options.warn 日志出口（ctx.logger.warn）。
 */
export function createSystemNotifier(options: {
  resolveTone: () => SoundSetting;
  toastScript: string;
  warn: (message: string) => void;
}): SystemNotifier {
  const { resolveTone, toastScript, warn } = options;

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

  // #640 Linux 自播播放器探测（pw-play=PipeWire → paplay=PulseAudio；与
  // notifySendAvailable 完全独立的可用性位——自播失败绝不误置 notify-send
  // 不可用，见 error handler；P1-2 修订）。异步只探一次。
  let selfPlayBin: string | undefined = undefined;
  if (process.platform === "linux") {
    execFile("pw-play", ["--version"], { timeout: 3000 }, (err1) => {
      if (err1 === null) {
        selfPlayBin = "pw-play";
        return;
      }
      execFile("paplay", ["--version"], { timeout: 3000 }, (err2) => {
        if (err2 === null) selfPlayBin = "paplay";
      });
    });
  }

  /**
   * spawn 单个命令并治理生命周期（超时杀进程 + exit/error 不冒泡）。
   * @returns Promise<boolean>：exit 0 = 成功；非 0/超时/error/启动失败 = 失败。
   *   spawn 前同步抛错（命令构造）由调用方 try/catch 收敛。
   */
  function runCommand(bin: string, argv: string[]): Promise<boolean> {
    return new Promise((resolveResult) => {
      let child: ChildProcess;
      try {
        // 关键：原生二进制缺失/不可执行（ENOENT 等）必须被下方 error 事件接住，
        // 绝不能冒泡成 unhandled 'error' 把宿主进程打挂——历史版本在 macOS 上因
        // 直接 spawn powershell 失败且未挂 error 监听而崩溃（见 issue #1）。
        child = spawn(bin, argv, process.platform === "win32" ? { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] } : { stdio: "ignore" });
      } catch (error) {
        warn(`dsh-notifier: 命令启动失败（${bin}）: ${errorMessage(error)}`);
        return resolveResult(false);
      }
      // Windows 分支限长收集 stderr：PS 的诊断（param 绑定失败、WinRT 异常等）
      // 原先随 stdio ignore 全部丢弃，排查只能盲猜（issue #238）；只留尾部片段进日志。
      let stderrTail = "";
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrTail.length < 512) stderrTail += chunk.toString("utf8");
        });
      }
      // 子进程超时兜底（8s：音频/通知进程均为短命任务；对抗评审 P2 建议 30s 过长）
      const killer = setTimeout(() => {
        try {
          child!.kill();
        } catch {
          // 忽略
        }
      }, 8000);
      // 任何退出码都先清杀手定时器；非 0 且非被信号杀死（null）才记日志，
      // 避免把「我们主动 8s 超时杀掉子进程」也当成异常刷屏。
      let settled = false;
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        if (code !== 0 && code !== null) {
          const tail = stderrTail.trim();
          warn(`dsh-notifier: 命令退出码异常（${bin} exit ${code}）${tail ? `：${tail.slice(-300)}` : ""}`);
        }
        resolveResult(code === 0);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        warn(`dsh-notifier: 命令不可用（${bin}）: ${errorMessage(error)}`);
        resolveResult(false);
      });
    });
  }

  /**
   * 单次投递（节流窗口内调用方保证唯一）：
   * 1. 构造 toast 命令（声音策略经 message.ts 纯函数）——不可用/命令 null → 仅自播/静默；
   * 2. toast spawn（若有）；
   * 3. 自播：pop=false（只响不弹）或 Linux/Windows/macOS 音色映射需自播时
   *    spawn 播放命令（同一节流窗口内——1s 节流覆盖单次投递全部 spawn，B3）。
   * 自播失败只影响声音，不把 toast 的 ok 拖成 failed（P1-2：自播与 toast
   * 可用性分离）；「只响不弹」时自播失败即整体失败（异步终态 failed 上报）。
   */
  /**
   * 平台 × 声音 × 弹窗的自播判定（与 message.ts 命令构造同域）：
   * - linux：任何非静音（true/SoundId）都自播（DE 对 hint 支持参差，toast 发声
   *   不可依赖，#640 核心）；弹窗开也一样（suppress-sound 防双响）。
   * - darwin：只响不弹（pop=false）自播 afplay；弹窗开 true 由 osascript 原生
   *   sound（不自播），弹窗开 SoundId 也是原生 sound（NSSound 名，不自播）。
   * - win32：只响不弹自播 SoundPlayer；弹窗开 true 由 toast 默认音（不自播，
   *   P0-2：SoundPlayer 仅用于「应用必须自播」= 只响不弹或 SoundId 场景——
   *   弹窗开 SoundId 也自播（toast silent 防双响））。
   */
  function shouldSelfPlay(pop: boolean, tone: SoundSetting, platform: string): boolean {
    if (tone === false) return false;
    if (platform === "linux") return true;
    if (platform === "darwin") return !pop;
    if (platform === "win32") return typeof tone === "string" || !pop;
    return false;
  }

  async function deliverOnce(pop: boolean, tone: SoundSetting, rawTitle: string, rawMessage: string): Promise<boolean> {
    // 截断按码点而非 UTF-16 code unit：防 emoji 等代理对在边界被腰斩成
    // 孤立代理（经 JSON/base64 后变成 U+FFFD 替换符显示，issue #238 配套）。
    const truncateCodePoints = (s: string, max: number): string => {
      const chars = Array.from(s);
      return chars.length > max ? chars.slice(0, max).join("") : s;
    };
    const safeTitle = truncateCodePoints(String(rawTitle), 64);
    const safeMessage = truncateCodePoints(String(rawMessage), 256);
    const platform = process.platform;
    const selfPlay = shouldSelfPlay(pop, tone, platform);
    // toast 半边：不弹实体视为成功；spawn 失败只 warn 不翻转终态（旧契约
    // 「系统通知失败静默、仅日志、不影响主流程」——无桌面会话/无 notify-send
    // 是常态环境而非投递失败，保持 status ok；见 README）
    let soundOk = true;
    if (pop) {
      const argv = buildSystemCommand(platform, safeTitle, safeMessage, {
        sound: tone,
        selfPlay,
        notifySendAvailable,
        toastScript,
      });
      if (argv !== null) {
        // toast spawn 结果只记日志（runCommand 内 warn），不翻转终态
        await runCommand(argv[0], argv.slice(1));
      }
      // argv null（notify-send 探测不可用）：静默跳过（旧语义，通道不可用 ≠ 失败）
    }
    if (selfPlay) {
      const toneId: SystemTone = typeof tone === "string" ? tone : "default";
      const player = platform === "linux" ? selfPlayBin : undefined;
      const snd = buildSoundCommand(platform, toneId, player);
      if (snd === null) {
        // 无播放器 / 事件文件缺失：弹窗场景声音尽力而为（忽略）；只响不弹场景
        // 声音是唯一动作 → 失败诚实上报（B4/P1-2：不做「静默成功」）
        if (pop === false) soundOk = false;
      } else {
        const ok = await runCommand(snd[0], snd.slice(1));
        if (pop === false) soundOk = ok;
        // 弹窗场景：自播失败忽略（toast 已成功，声音尽力而为）
      }
    }
    return soundOk;
  }

  return {
    /**
     * 系统通知（节流 + 超时杀进程；失败 resolve false 不 reject）。
     * 1s 节流覆盖单次投递全部 spawn（toast + 自播同属一次逻辑操作，B3）；
     * 节流吞掉时按上一次决议语义透传（返回「是否真有一次成功 spawn」）。
     * 命令构造走 message.ts 纯函数 buildSystemCommand/buildSoundCommand：
     * Windows：PowerShell WinRT toast / SoundPlayer 自播；macOS：osascript /
     * afplay；Linux：notify-send + pw-play/paplay 自播（可用才调用）。
     */
    async notify(pop: boolean, tone: SoundSetting, title: string, message: string): Promise<boolean> {
      const now = Date.now();
      if (now - lastSystemNotifyAt < SYSTEM_NOTIFY_THROTTLE_MS) {
        // 节流吞掉：透传上一次决议语义（客户端 1.5s 播放节流下此窗口只拦服务端
        // 密集重投；上一次成功即视为本次成功，避免测试误报 failed）
        return lastSystemOutcome;
      }
      lastSystemNotifyAt = now;
      const ok = await deliverOnce(pop, tone, title, message);
      lastSystemOutcome = ok;
      return ok;
    },
    selfPlayAvailable() {
      if (process.platform === "darwin") return true; // afplay + /System/Library/Sounds 恒可探测
      if (process.platform === "win32") return true; // SoundPlayer + C:\Windows\Media 恒可探测
      return selfPlayBin !== undefined; // Linux：pw-play/paplay 任一可用
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
   *  sseConnHealth 暴露逐连接 age/lastWriteAgo/stalled（先量化再调参）。
   *  #640/#641：platform（宿主平台——客户端系统卡按它显示平台提示，防浏览器 OS
   *  与宿主 OS 混淆）+ 摘要键表补 browserSound/systemSound（D1，四同步）。 */
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
        platform: process.platform,
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
          browserSound: current.browserSound,
          systemSound: current.systemSound,
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
          if (code === "SETTINGS_UNAVAILABLE") {
            // 与 PUT /config 的服务缺失语义一致（#405 PR3 复核）：settings 服务未
            // attach → 503，而非笼统 500——保持跨通道错误映射一致。
            writeJson(res, 503, { ok: false, error: { code: "settings-unavailable", error: "设置服务不可用" } });
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
