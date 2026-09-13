/**
 * dsh-notifier channels 域 —— 系统出口：探测平台能力、构造命令、执行命令。
 * 命令一律 `[bin, ...args]` 参数数组（零 shell 拼接）；弹窗半边的失败只记日志不翻转
 * 终态，「只响不弹」时自播失败才是这次投递失败。1 秒节流不在这里（归管线）。
 */
import type { LoggerPort } from "../../../shared/interface.ts";
import { FAILURE_REASON_MAX, displayCaps, truncateCodePoints } from "../deliver/caps.ts";
import type { DeliverResult, NotifyMessage, ToneSetting } from "../deliver/type.ts";
import { platformCapabilities, systemDeps } from "./deps.ts";
import type { ChildHandle } from "./deps.ts";
import { MAC_SOUND_NAMES, toneFileCandidates } from "./tones.ts";
import type { PlatformProbe, SystemCommandOptions, SystemTarget } from "./type.ts";

/** 探测超时（毫秒）：探测不许拖住第一次投递。 */
const PROBE_TIMEOUT_MS = 3000;
/** 子进程兜底杀进程时限：通知与音频进程都是短命任务。 */
const KILL_TIMEOUT_MS = 8000;
/** stderr 收集上限与进日志的尾部长度（字符）。 */
const STDERR_TAIL_MAX = 512;
const STDERR_LOG_MAX = 300;
/** Linux 自播播放器候选：PipeWire 优先，PulseAudio 兜底。 */
const LINUX_PLAYERS: readonly string[] = ["pw-play", "paplay"];

/** 探测本平台能力（异步一次；不用 spawnSync 阻塞事件循环）。 */
export async function probePlatform(toastScript: string): Promise<PlatformProbe> {
  const deps = systemDeps();
  const platform = deps.platform;
  // macOS 走 osascript、Windows 走 PowerShell，都不依赖 notify-send，故不探测
  const notifySendAvailable =
    platform === "darwin" || platform === "win32" ? false : await probeCommand("notify-send");
  const players =
    platform === "linux" ? await probePlayers() : platform === "darwin" ? ["afplay"] : [];
  return {
    platform,
    toastScriptAvailable: deps.existsSync(toastScript),
    notifySendAvailable,
    players,
  };
}

/** 候选播放器逐个探测，取第一个可用的。 */
async function probePlayers(): Promise<readonly string[]> {
  for (const player of LINUX_PLAYERS) {
    if (await probeCommand(player)) return [player];
  }
  return [];
}

/** 探测一条命令是否可用：`--version` 既不弹通知也不发声。 */
function probeCommand(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    systemDeps().execFile(bin, ["--version"], { timeout: PROBE_TIMEOUT_MS }, (failed) => {
      resolve(!failed);
    });
  });
}

/**
 * 构造弹窗命令；空数组 = 本平台给不出这条命令。
 * silent = 声音关闭或出口要自播（自播时不静音会响两声）。
 */
export function buildSystemCommand(
  probe: PlatformProbe,
  title: string,
  message: string,
  options: SystemCommandOptions,
): readonly string[] {
  const silent = options.sound === false || options.selfPlay;
  if (probe.platform === "win32") {
    if (!probe.toastScriptAvailable) return [];
    // PS 5.1 的 -File 对 `-Name=Value` 不做命名参数绑定，裸 dash token 又会被当成下一个
    // 参数名；base64 字母表无空格无引号，彻底脱离命令行 tokenizer 的歧义面
    const payload = Buffer.from(JSON.stringify({ title, message, silent }), "utf8").toString(
      "base64",
    );
    return [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      options.toastScript,
      "-Payload",
      payload,
    ];
  }
  if (probe.platform === "darwin") {
    // osascript 脚本串里转义 \ 与 "、换行换空格（脚本语法不接受裸换行）
    const escape = (text: string) =>
      text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, " ");
    const tone = options.sound;
    const named =
      typeof tone === "string" && Object.hasOwn(MAC_SOUND_NAMES, tone)
        ? MAC_SOUND_NAMES[tone]
        : "Glass";
    const soundName = silent ? "" : ` sound name "${named}"`;
    return [
      "osascript",
      "-e",
      `display notification "${escape(message)}" with title "${escape(title)}"${soundName}`,
    ];
  }
  if (!probe.notifySendAvailable) return [];
  // 恒带 suppress-sound：各 DE 对 sound hint 支持参差，发声一律由出口自播承担
  return ["notify-send", "-h", "boolean:suppress-sound:true", title, message];
}

/** 构造自播命令；空数组 = 本平台（或这个音色）放不出声。 */
export function buildSoundCommand(probe: PlatformProbe, tone: string): readonly string[] {
  const deps = systemDeps();
  const file = toneFileCandidates(probe.platform, tone).find((path) => deps.existsSync(path));
  if (file === undefined) return [];
  if (probe.platform === "darwin") return ["afplay", file];
  if (probe.platform === "win32") {
    // 路径不拼进命令串：固定骨架读 $args[0]，白名单 wav 绝对路径作为独立 argv 传入
    const play = "$p=$args[0]; (New-Object System.Media.SoundPlayer $p).PlaySync()";
    return [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      play,
      file,
    ];
  }
  const player = probe.players[0];
  return player === undefined ? [] : [player, file];
}

/**
 * 自播判定：linux 任何非静音都自播（DE 的 sound hint 不可依赖）；darwin 只在只响不弹
 * 时自播；win32 指定音色或只响不弹时自播。
 */
export function shouldSelfPlay(pop: boolean, tone: boolean | string, platform: string): boolean {
  if (tone === false) return false;
  if (platform === "linux") return true;
  if (platform === "darwin") return !pop;
  if (platform === "win32") return typeof tone === "string" || !pop;
  return false;
}

/**
 * 执行一条命令；任何退出方式都收敛成 boolean，不外抛。
 * 必须挂 `error` 监听：原生二进制缺失时无人接住的 error 事件会把宿主进程打挂
 * （历史版本在 macOS 上直接 spawn 缺失的 powershell 崩过）。
 */
function run(command: readonly string[], logger: LoggerPort, platform: string): Promise<boolean> {
  const deps = systemDeps();
  const bin = command[0];
  return new Promise((resolve) => {
    let child: ChildHandle;
    try {
      // Windows 的 PS 诊断只在 stderr 上，故只有它接管道
      child = deps.spawn(command, { collectStderr: platform === "win32" });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.warn(`dsh-notifier: 命令启动失败（${bin}）: ${reason}`);
      resolve(false);
      return;
    }
    // 限长收集 stderr 尾部：Windows 的 PS 诊断（参数绑定失败、WinRT 异常）否则全丢
    let stderrTail = "";
    child.onStderr((chunk) => {
      if (stderrTail.length < STDERR_TAIL_MAX) stderrTail += chunk.toString("utf8");
    });
    const killer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 子进程可能已退出：杀不掉不影响结论
      }
    }, KILL_TIMEOUT_MS);
    let settled = false;
    child.onExit((exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      // 被信号杀死多数是我们自己的超时兜底：那是主动行为，不当异常刷屏
      if (exit.exited && exit.code !== 0) {
        const tail = stderrTail.trim();
        const detail = tail ? `：${tail.slice(-STDERR_LOG_MAX)}` : "";
        logger.warn(`dsh-notifier: 命令退出码异常（${bin} exit ${exit.code}）${detail}`);
      }
      resolve(exit.exited && exit.code === 0);
    });
    child.onError((cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      logger.warn(`dsh-notifier: 命令不可用（${bin}）: ${cause.message}`);
      resolve(false);
    });
  });
}

/** 弹窗与提示音是两个独立动作：弹窗那半边的失败只记日志，「只响不弹」时自播失败才算这次失败。 */
export async function sendSystem(
  target: SystemTarget,
  message: NotifyMessage,
): Promise<DeliverResult> {
  // 弹窗与提示音都关：投递发生过，但本次没有可执行的动作——「要不要投递」在管线（只看 `enabled`），
  // 这里是本出口对「发什么」的回答，所以不弹不响不该被记成一次投递成功。早退顺带省掉一次平台探测。
  if (!target.popup && target.sound === false) {
    return { status: "skipped", reason: "系统频道：弹窗与声音都已关闭" };
  }
  const probe = await platformCapabilities.get(target.toastScript, probePlatform);
  const selfPlay = shouldSelfPlay(target.popup, target.sound, probe.platform);
  const play = selfPlay ? buildSoundCommand(probe, toneOf(target.sound)) : [];

  if (target.popup) {
    const pop = buildSystemCommand(
      probe,
      truncateCodePoints(message.title, displayCaps.system.titleMax),
      truncateCodePoints(message.body, displayCaps.system.bodyMax),
      { sound: target.sound, selfPlay, toastScript: target.toastScript },
    );
    // 弹窗半边的 spawn 结果只记日志（run 内 warn）：无桌面会话、无 notify-send 是常态
    // 环境，不是投递失败；弹窗场景下自播失败也忽略（toast 已出去，声音尽力而为）
    if (pop.length === 0 && probe.platform === "win32" && !probe.toastScriptAvailable) {
      // 脚本缺失是打包缺陷而非环境常态：命令都没构造出来，得留一条痕迹
      const reason = `dsh-notifier: 系统通知脚本缺失，Windows 弹窗未发出：${target.toastScript}`;
      target.logger.warn(reason);
    }
    if (pop.length > 0) await run(pop, target.logger, probe.platform);
    if (play.length > 0) await run(play, target.logger, probe.platform);
    return { status: "ok", stage: "delivered" };
  }
  if (!selfPlay) {
    // 既不弹也不响：上面那道早退之后这里已不可达，留作「没有可失败环节」的兜底
    return { status: "ok", stage: "delivered" };
  }
  // 只响不弹：声音是唯一动作，平台放不出声或播放失败都是这次投递的失败
  if (play.length === 0) return failed("本平台没有可用的系统通知通道");
  const played = await run(play, target.logger, probe.platform);
  return played ? { status: "ok", stage: "delivered" } : failed("系统命令执行失败");
}

/** 声音选择 → 自播目标音色（true = 各平台的跟随系统默认音）。 */
function toneOf(sound: ToneSetting): string {
  return typeof sound === "string" ? sound : "default";
}

/** 失败结果：原因按展示上限截断（截断是展示语义，不是脱敏）。 */
function failed(reason: string): DeliverResult {
  return {
    status: "failed",
    stage: "delivered",
    reason: truncateCodePoints(reason, FAILURE_REASON_MAX),
    // 平台能力与命令退出码不会因为重投而改变：换一次投递还是同样的结论
    retryable: false,
  };
}
