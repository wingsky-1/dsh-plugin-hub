/**
 * dsh-notifier channels 域 —— 系统出口：探测平台能力、构造命令、执行命令。
 * 命令一律 `[bin, ...args]` 参数数组（零 shell 拼接）。1 秒节流不在这里（归管线）。
 *
 * 终态判据分两条，不再用「零动作」当统一口径：**执行过动作而它失败了**就是失败（有失败证据）；
 * **一条命令都构造不出来**是空动作（没有可失败环节），成因经 `reason` 的 code 带出去。
 */
import { FOLLOW_SYSTEM_TONE, TONES } from "../../../../shared/interface.ts";
import type { LoggerPort, ReasonCode, ReasonParams } from "../../../shared/interface.ts";
import { reason } from "../../../shared/interface.ts";
import { displayCaps, truncateCodePoints } from "../deliver/caps.ts";
import type { DeliverResult, NotifyMessage, ToneSetting } from "../deliver/type.ts";
import { platformCapabilities, systemDeps } from "./deps.ts";
import type { ChildHandle } from "./deps.ts";
import { toneFileCandidates } from "./tones.ts";
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
    // 音色事实只有一份：未知音色与 `sound: true` 都落到「跟随系统默认音」那一档。
    const spec =
      typeof tone === "string" && Object.hasOwn(TONES, tone)
        ? TONES[tone]
        : TONES[FOLLOW_SYSTEM_TONE];
    // 声名缺失时不能给空串：`sound name ""` 在 osascript 里是静默不响，而不是退回默认音。
    const named = spec.darwinSound ?? "Glass";
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

/**
 * 弹窗与提示音是两个独立动作，但**终态只有一个**：执行过动作而它失败了就翻转终态，一条命令都
 * 构造不出来才是空动作。弹窗场景下自播失败不改终态——toast 已经出去了，声音是尽力而为。
 */
export async function sendSystem(
  target: SystemTarget,
  message: NotifyMessage,
): Promise<DeliverResult> {
  // 弹窗与提示音都关：投递发生过，但本次没有可执行的动作——「要不要投递」在管线（只看 `enabled`），
  // 这里是本出口对「发什么」的回答，所以不弹不响不该被记成一次投递成功。早退顺带省掉一次平台探测。
  // 不留 warn：这是用户显式写下的意图，不是环境没能力；成因经 code 带出去，别把日志刷成噪声。
  if (!target.popup && target.sound === false) {
    return { status: "skipped", reason: reason("reasonSkipConfig") };
  }
  const probe = await platformCapabilities.get(target.toastScript, probePlatform);
  const selfPlay = shouldSelfPlay(target.popup, target.sound, probe.platform);
  const play = selfPlay ? buildSoundCommand(probe, toneOf(target.sound)) : [];

  if (!target.popup) {
    // 只响不弹：声音是唯一动作。`!selfPlay` 只可能是枚举外的平台（三平台里 linux 恒自播，
    // darwin / win32 在 `!pop` 时都自播）；它和「放不出声」是同一件事：本次没有可执行的动作。
    if (!selfPlay || play.length === 0) return unexecutable(target, probe);
    return (await run(play, target.logger, probe.platform))
      ? delivered()
      : failed("reasonSystemSoundFailed", { bin: commandNameOf(play) });
  }

  const pop = buildSystemCommand(
    probe,
    truncateCodePoints(message.title, displayCaps.system.titleMax),
    truncateCodePoints(message.body, displayCaps.system.bodyMax),
    { sound: target.sound, selfPlay, toastScript: target.toastScript },
  );
  // 两条都跑：弹窗失败不该顺手把声音也丢掉（用户至少还能听见）。顺序是先弹后响。
  const popRan = pop.length > 0;
  const popOk = popRan ? await run(pop, target.logger, probe.platform) : true;
  const playRan = play.length > 0;
  const playOk = playRan ? await run(play, target.logger, probe.platform) : true;

  // 空动作优先判：一条命令都没构造出来时，下面两条「失败」都无从谈起。这一格旧实现在
  // linux / darwin 上是零输出、零状态、零日志——正是本次要修的静默。
  const nothingRan = !popRan && !playRan;
  if (nothingRan) return unexecutable(target, probe);
  // 弹窗没构造出来而声音还在跑：win32 的脚本缺失是**打包缺陷**，不能被「这次还有声音」盖掉
  // ——旧实现在这一格是无条件出声的。与上面的空动作互斥，故两者相加仍是恰好一条。
  if (!popRan && toastScriptMissing(probe)) target.logger.warn(toastScriptMissingWarn(target));
  // 弹窗命令非空说明工具确实在：它的非零退出是真失败，不再是「无桌面会话」那类常态环境
  // （后者走的是 `!notifySendAvailable`，命令根本构造不出来）。
  if (!popOk) return failed("reasonSystemPopupFailed", { bin: commandNameOf(pop) });
  // 声音只在它是本次唯一动作时才翻转终态；toast 已经出去时声音是尽力而为。
  if (!playOk && !popRan) return failed("reasonSystemSoundFailed", { bin: commandNameOf(play) });
  return delivered();
}

/**
 * 空动作的收口：本次没有可执行的动作，留**恰好一条** warn。旧实现把这条 warn 硬编码在 win32
 * 分支上，于是 linux / darwin 的同一格完全静默——「推成功却没声音」的最直接来源。
 */
function unexecutable(target: SystemTarget, probe: PlatformProbe): DeliverResult {
  target.logger.warn(
    toastScriptMissing(probe)
      ? toastScriptMissingWarn(target)
      : `dsh-notifier: 系统频道没有可执行的动作，通知未发出（平台 ${probe.platform}）`,
  );
  // 成因分两种：脚本缺失是插件自己的打包缺陷，其余是宿主环境没能力。两者都不该被当成
  // 「用户自己关的」，但让它们共用一个 code 会把打包缺陷说成环境问题，故分开。
  return {
    status: "skipped",
    reason: reason(
      toastScriptMissing(probe) ? "reasonSystemToastScriptMissing" : "reasonSkipEnvironment",
    ),
  };
}

/** win32 的 toast 脚本不在：命令根本构造不出来。它是打包缺陷，不是用户的桌面环境问题。 */
function toastScriptMissing(probe: PlatformProbe): boolean {
  return probe.platform === "win32" && !probe.toastScriptAvailable;
}

/** 打包缺陷的告警文案：要指向那个文件，否则「弹窗没出来」无从查起。 */
function toastScriptMissingWarn(target: SystemTarget): string {
  return `dsh-notifier: 系统通知脚本缺失，Windows 弹窗未发出：${target.toastScript}`;
}

/** 命令的 bin 名：失败理由带上它，设置页才看得出是哪条命令没跑成。 */
function commandNameOf(command: readonly string[]): string {
  return command[0] ?? "unknown";
}

/** 声音选择 → 自播目标音色（true = 各平台的跟随系统默认音）。 */
function toneOf(sound: ToneSetting): string {
  return typeof sound === "string" ? sound : FOLLOW_SYSTEM_TONE;
}

/** 成功结果：两个分支共用同一形状。 */
function delivered(): DeliverResult {
  return { status: "ok", stage: "delivered" };
}

/**
 * 失败结果：有失败证据就必须翻转终态。不可重试——平台能力与命令退出码不会因为重投而改变，
 * 换一次投递还是同样的结论。
 */
function failed(code: ReasonCode, params?: ReasonParams): DeliverResult {
  return {
    status: "failed",
    stage: "delivered",
    reason: reason(code, params === undefined ? undefined : { params }),
    retryable: false,
  };
}
