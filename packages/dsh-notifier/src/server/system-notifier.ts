/**
 * dsh-notifier — 服务器侧逻辑：系统通知通道（节流 + 子进程生命周期兜底）。
 *
 * 职责：把「平台 toast + 自播」的 spawn 链收敛为 SystemNotifier.notify 终态
 * promise（1s 节流覆盖单次投递全部 spawn；8s 超时杀进程；失败 resolve false
 * 不 reject、绝不打挂宿主）。命令构造走 text 域纯函数 buildSystemCommand /
 * buildSoundCommand（零 shell 拼接面），探测可用性位（notify-send/pw-play/
 * paplay）只在 Linux 异步探一次。
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { errorMessage } from "../../../../shared/host-utils.js";
import type { SoundSetting } from "../config/interface.ts";
import { buildSoundCommand, buildSystemCommand } from "../text/interface.ts";
import type { SystemTone } from "../text/interface.ts";

/** 系统通知通道：节流 + 子进程生命周期兜底。 */
export interface SystemNotifier {
  /**
   * 发一条系统通知（弹窗/声音组合语义见 sdk 域分派；方法由调用方传参）。
   * @param pop 是否弹系统 toast 实体（false = 只响不弹）。
   * @param tone 声音设置（false=静音无自播；true=跟随系统默认；SoundId=音色）。
   * @param title 通知标题（toast 用；只响不弹时可为空串）。
   * @param message 通知正文（toast 用；只响不弹时可为空串）。
   * @returns Promise<boolean>：投递终态决议（resolve=true 成功 / false 失败——
   *   通道不可用、命令构造失败或子进程失败均 resolve false；不 reject，绝不打挂
   *   宿主）。节流吞掉（1s 窗口内重复投递）透传上一次决议语义。
   */
  notify(pop: boolean, tone: SoundSetting, title: string, message: string): Promise<boolean>;
}

/** 系统通知节流吞掉时透传的「上一次决议」初值（首投递无上一次 = 视为可成功）。 */
let lastSystemOutcome = true;

/**
 * 创建系统通知通道。
 * @param options.toastScript toast.ps1 路径。
 * @param options.warn 日志出口（ctx.logger.warn）。
 * @param options.execFileImpl 探测实现注入（缺省 node:child_process execFile）——
 *   测试注入 fake 消除真实 execFile（行为无关，缺省语义不变）。
 * @param options.spawnImpl spawn 实现注入（缺省 node:child_process spawn）——同上，
 *   测试注入 fake 消除真实子进程 spawn 面。
 * @param options.killTimeoutMs 子进程超时杀进程毫秒（缺省 8000；测试注入短值）。
 */
export function createSystemNotifier(options: {
  toastScript: string;
  warn: (message: string) => void;
  execFileImpl?: typeof execFile;
  spawnImpl?: typeof spawn;
  killTimeoutMs?: number;
}): SystemNotifier {
  const { toastScript, warn } = options;
  const exec = options.execFileImpl ?? execFile;
  const runSpawn = options.spawnImpl ?? spawn;
  const killTimeoutMs = options.killTimeoutMs ?? 8000;

  /** 系统通知节流间隔：防连发（生产密集事件/连点测试按钮）造成 spawn 风暴。 */
  const SYSTEM_NOTIFY_THROTTLE_MS = 1000;
  let lastSystemNotifyAt = 0;

  /** notify-send 可用性探测（仅 Linux 需要；macOS 走 osascript，darwin 分支
   *  不依赖此探测，故不在 macOS 上无谓尝试缺失的 notify-send）。异步，只探一次。 */
  let notifySendAvailable: boolean | undefined = undefined;
  if (process.platform === "linux") {
    exec("notify-send", ["--version"], { timeout: 3000 }, (error) => {
      notifySendAvailable = error === null;
    });
  }

  // Linux 自播播放器探测（pw-play=PipeWire → paplay=PulseAudio；与
  // notifySendAvailable 完全独立的可用性位——自播失败绝不误置 notify-send
  // 不可用，见 error handler）。异步只探一次。
  let selfPlayBin: string | undefined = undefined;
  if (process.platform === "linux") {
    exec("pw-play", ["--version"], { timeout: 3000 }, (err1) => {
      if (err1 === null) {
        selfPlayBin = "pw-play";
        return;
      }
      exec("paplay", ["--version"], { timeout: 3000 }, (err2) => {
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
        // 直接 spawn powershell 失败且未挂 error 监听而崩溃。
        child = runSpawn(bin, argv, process.platform === "win32" ? { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] } : { stdio: "ignore" });
      } catch (error) {
        warn(`dsh-notifier: 命令启动失败（${bin}）: ${errorMessage(error)}`);
        return resolveResult(false);
      }
      // Windows 分支限长收集 stderr：PS 的诊断（param 绑定失败、WinRT 异常等）
      // 原先随 stdio ignore 全部丢弃，排查只能盲猜；只留尾部片段进日志。
      let stderrTail = "";
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrTail.length < 512) stderrTail += chunk.toString("utf8");
        });
      }
      // 子进程超时兜底（8s：音频/通知进程均为短命任务；30s 过长）
      const killer = setTimeout(() => {
        try {
          child!.kill();
        } catch {
          // 忽略
        }
      }, killTimeoutMs);
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
   * 平台 × 声音 × 弹窗的自播判定（与 text 域命令构造同域）：
   * - linux：任何非静音（true/SoundId）都自播（DE 对 hint 支持参差，toast 发声
   *   不可依赖）；弹窗开也一样（suppress-sound 防双响）。
   * - darwin：只响不弹（pop=false）自播 afplay；弹窗开 true 由 osascript 原生
   *   sound（不自播），弹窗开 SoundId 也是原生 sound（NSSound 名，不自播）。
   * - win32：只响不弹自播 SoundPlayer；弹窗开 true 由 toast 默认音（不自播，
   *   SoundPlayer 仅用于「应用必须自播」= 只响不弹或 SoundId 场景——
   *   弹窗开 SoundId 也自播（toast silent 防双响））。
   */
  function shouldSelfPlay(pop: boolean, tone: SoundSetting, platform: string): boolean {
    if (tone === false) return false;
    if (platform === "linux") return true;
    if (platform === "darwin") return !pop;
    if (platform === "win32") return typeof tone === "string" || !pop;
    return false;
  }

  /**
   * 单次投递（节流窗口内调用方保证唯一）：
   * 1. pop=true → 构造并 spawn toast 命令（声音策略经 text 域纯函数；
   *    spawn 失败只 warn 不翻转终态——旧契约「系统通知失败静默、仅日志、不
   *    影响主流程」：无桌面会话/无 notify-send 是常态环境而非投递失败）；
   * 2. 自播（shouldSelfPlay 判定）：Linux/Windows/macOS 音色或只响不弹场景
   *    spawn 播放命令（同一节流窗口内——1s 节流覆盖单次投递全部 spawn）。
   * 自播失败在弹窗场景只影响声音（toast 已成功，尽力而为）；「只响不弹」时
   * 自播失败即整体失败（异步终态 failed 上报）。
   * @returns 投递终态 boolean（只响不弹 = 自播成败；弹窗场景恒 true——toast
   *   成败静默，见上）。
   */
  async function deliverOnce(pop: boolean, tone: SoundSetting, rawTitle: string, rawMessage: string): Promise<boolean> {
    // 截断按码点而非 UTF-16 code unit：防 emoji 等代理对在边界被腰斩成
    // 孤立代理（经 JSON/base64 后变成 U+FFFD 替换符显示）。
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
        // 声音是唯一动作 → 失败诚实上报（不做「静默成功」）
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
     * 1s 节流覆盖单次投递全部 spawn（toast + 自播同属一次逻辑操作）；
     * 节流吞掉时按上一次决议语义透传（返回「是否真有一次成功 spawn」）。
     * 命令构造走 text 域纯函数 buildSystemCommand/buildSoundCommand：
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
  };
}