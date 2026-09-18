/**
 * dsh-notifier channels 域 —— 系统出口：探测平台能力、构造命令、执行命令。
 * 命令一律 `[bin, ...args]` 参数数组（零 shell 拼接）。1 秒节流不在这里（归管线）。
 *
 * 终态判据分两条，不再用「零动作」当统一口径：**执行过动作而它失败了**就是失败（有失败证据）；
 * **一条命令都构造不出来**是空动作（没有可失败环节），成因经 `reason` 的 code 带出去。
 *
 * 自播从「取首个可用播放器」改成**按回退链逐条试、首个成功即停**，且失败要自证：判据是退出码加
 * 实测致命标记（**不是**「stderr 必须为空」，理由见 `players.ts`）。Linux 上主题文件缺失时用
 * 运行时合成的 WAV（`tone-file.ts`）——这正是 #783 的现场：宿主有播放设备却没装 freedesktop
 * 音色包。
 */
import { FOLLOW_SYSTEM_TONE, TONES } from "../../../../shared/interface.ts";
import type { LoggerPort, ReasonCode, ReasonParams } from "../../../shared/interface.ts";
import { reason } from "../../../shared/interface.ts";
import { displayCaps, truncateCodePoints } from "../deliver/caps.ts";
import type { DeliverResult, NotifyMessage, ToneSetting } from "../deliver/type.ts";
import { platformCapabilities, systemDeps } from "./deps.ts";
import type { ChildHandle } from "./deps.ts";
import {
  LINUX_PLAYERS,
  playerSpec,
  playFailure,
  playFailureSummary,
  warnWorthy,
} from "./players.ts";
import type { PlayerSpec, PlayFailure } from "./players.ts";
import { resolveToneSource, stageToneSource, unstageToneAudio } from "./tone-file.ts";
import type {
  CommandFacts,
  CommandOutcome,
  PlatformProbe,
  SystemCommandOptions,
  SystemTarget,
} from "./type.ts";

/** 探测超时（毫秒）：探测不许拖住第一次投递。 */
const PROBE_TIMEOUT_MS = 3000;
/** 子进程兜底杀进程时限：通知与音频进程都是短命任务。 */
const KILL_TIMEOUT_MS = 8000;
/** stderr 收集上限与进日志的尾部长度（字符）。 */
const STDERR_TAIL_MAX = 512;
const STDERR_LOG_MAX = 300;

/** 探测本平台能力（异步一次；不用 spawnSync 阻塞事件循环）。 */
export async function probePlatform(toastScript: string): Promise<PlatformProbe> {
  const deps = systemDeps();
  const platform = deps.platform;
  // macOS 走 osascript、Windows 走 PowerShell，都不依赖 notify-send，故不探测
  const notifySendAvailable =
    platform === "darwin" || platform === "win32"
      ? false
      : await probeCommand("notify-send", ["--version"]);
  const players =
    platform === "linux" ? await probePlayers() : platform === "darwin" ? ["afplay"] : [];
  return {
    platform,
    toastScriptAvailable: deps.existsSync(toastScript),
    notifySendAvailable,
    players,
  };
}

/**
 * 候选播放器**并行**探测，返回**全部**命中者（顺序 = 表序 = 回退链尝试序）。
 *
 * 并行是刻意的语义变更：命中即停那版最坏情况要串行等 4 次超时，而探测会挡住第一次投递；
 * 换来的是「最坏探测时延仍是一次超时」。代价是每次探测起 4 个子进程。
 */
async function probePlayers(): Promise<readonly string[]> {
  const probed = await Promise.all(
    LINUX_PLAYERS.map(async (player) => ((await probePlayer(player)) ? player.bin : undefined)),
  );
  return probed.filter((bin): bin is string => bin !== undefined);
}

/**
 * 该播放器是否**不依赖声音服务**（能力面据此把 linux 判成 `ok` / `degraded`）。
 *
 * 数据只有一处：`LINUX_PLAYERS` 那一行的 `needsServer`。表里没有的 bin 一律回 `false`——
 * 「不在表里」不等于「不需要声音服务」，而 `ok` 的语义恰恰是「命中的播放器里至少有一个**已知**
 * 能直连出声」；把不认识的算作 serverless，就是本增量要消灭的那种「把测不准的事写成 ok」。
 * linux 上这一分支结构上不可达（`probePlayers` 探的就是这张表），故它只是一条不制造假 ok 的兜底。
 */
export function isServerlessPlayer(bin: string): boolean {
  return playerSpec(bin)?.needsServer === false;
}

/** 一个候选的探测：表内参数按序试，任一跑得起来即命中（ffplay 的 `--version` 实测 exit 1）。 */
async function probePlayer(player: PlayerSpec): Promise<boolean> {
  for (const args of player.probeArgs) {
    if (await probeCommand(player.bin, args)) return true;
  }
  return false;
}

/** 探测一条命令是否可用：版本参数既不弹通知也不发声。 */
function probeCommand(bin: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    systemDeps().execFile(bin, args, { timeout: PROBE_TIMEOUT_MS }, (failed) => {
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

/** 一条自播命令：argv + 它的判据来源（Linux 播放器表上的那一行；darwin/win32 只看退出码）。 */
export interface ToneCommand {
  readonly command: readonly string[];
  readonly player?: PlayerSpec;
}

/**
 * 构造自播命令链：Linux 上链上每个命中候选各一条命令（argv 随播放器不同），darwin/win32 是平台
 * 播放器的一条。`file` 必须是**已存在**的绝对路径（主题文件或本次落的临时合成文件），
 * 「素材有没有」由 `prepareSound` 判，不在这里重判。
 */
export function buildSoundCommands(probe: PlatformProbe, file: string): readonly ToneCommand[] {
  if (probe.platform === "darwin") return [{ command: ["afplay", file] }];
  if (probe.platform === "win32") {
    // 路径不拼进命令串：固定骨架读 $args[0]，白名单 wav 绝对路径作为独立 argv 传入
    const play = "$p=$args[0]; (New-Object System.Media.SoundPlayer $p).PlaySync()";
    return [
      {
        command: [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          play,
          file,
        ],
      },
    ];
  }
  // 取不到表行说明名单漂了：宁可这一条不试，也不要就地拍一个 argv 出来
  return probe.players
    .map((bin) => playerSpec(bin))
    .filter((player): player is PlayerSpec => player !== undefined)
    .map((player) => ({ command: [player.bin, ...player.fileArgs(file)], player }));
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
 * 执行一条命令，把任何退出方式**原样收敛成事实**：不外抛、不做成败判定（判据归调用方）。
 * 必须挂 `error` 监听：原生二进制缺失时无人接住的 error 事件会把宿主进程打挂
 * （历史版本在 macOS 上直接 spawn 缺失的 powershell 崩过）。
 *
 * stderr 一律接管道：音频判据要读它（无头 Linux 上它是唯一的自证面），Windows 的 PS 诊断也只在它上面。
 */
function run(command: readonly string[]): Promise<CommandFacts> {
  const deps = systemDeps();
  return new Promise((resolve) => {
    let child: ChildHandle;
    try {
      child = deps.spawn(command, { collectStderr: true });
    } catch (cause) {
      resolve({
        outcome: {
          kind: "spawn-threw",
          cause: cause instanceof Error ? cause.message : String(cause),
        },
        stderr: "",
      });
      return;
    }
    // 限长收集 stderr 尾部：无上限收集会被一条长诊断撑爆
    let stderrTail = "";
    child.onStderr((chunk) => {
      if (stderrTail.length < STDERR_TAIL_MAX) stderrTail += chunk.toString("utf8");
    });
    let settled = false;
    const settle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ outcome, stderr: stderrTail });
    };
    // 结局先到就清掉定时器，别让已回收的进程再挨一刀
    const killer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 子进程可能已退出：杀不掉不影响结论
      }
      // 子进程忽略 SIGTERM 时 onExit 永远不到：在这里就地结算，否则 `await` 永久挂着（零日志零落盘）
      settle({ kind: "timeout" });
    }, KILL_TIMEOUT_MS);
    child.onExit((exit) =>
      settle(exit.exited ? { kind: "exit", code: exit.code } : { kind: "killed" }),
    );
    child.onError((cause) => settle({ kind: "spawn-error", cause: cause.message }));
  });
}

/**
 * 非音频命令（弹窗）的失败告警：只有退出码 0 是成功。ffplay 上量到的致命标记表**不是**它的成败语义
 * ——`notify-send` 与 PowerShell 的 stderr 内容与音频播放无关，套过来会把它们的正常输出判成失败。
 */
function popupFailureWarn(bin: string, facts: CommandFacts): string | undefined {
  const outcome = facts.outcome;
  const tail = facts.stderr.trim();
  const detail = tail === "" ? "" : `：${tail.slice(-STDERR_LOG_MAX)}`;
  if (outcome.kind === "exit") {
    return outcome.code === 0
      ? undefined
      : `dsh-notifier: 命令退出码异常（${bin} exit ${outcome.code}）${detail}`;
  }
  if (outcome.kind === "spawn-threw")
    return `dsh-notifier: 命令启动失败（${bin}）: ${outcome.cause}`;
  if (outcome.kind === "spawn-error") return `dsh-notifier: 命令不可用（${bin}）: ${outcome.cause}`;
  if (outcome.kind === "timeout") return `dsh-notifier: 命令超时未退出（${bin}），已按失败结算`;
  // 被信号杀死多数是我们自己的超时兜底：那是主动行为，按异常刷屏会淹掉真正的失败
  return undefined;
}

/** 跑一条非音频命令：日志与成败都在这里收口（原始事实来自 `run()`）。 */
async function runCommand(command: readonly string[], logger: LoggerPort): Promise<boolean> {
  const facts = await run(command);
  const warn = popupFailureWarn(commandNameOf(command), facts);
  if (warn !== undefined) logger.warn(warn);
  return facts.outcome.kind === "exit" && facts.outcome.code === 0;
}

/** 回退链的结论：成功与否 + 全失败时的成因摘要（进 `reason.detail`，可诊断）。 */
interface ChainOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * 按回退链逐条试播，**首个成功即停**（继续试就是第二声）。中间候选的失败一律不进日志——只有整条链
 * 都失败、且至少有一个候选的失败值得出声时才留**一条**，否则一次投递会刷出四条 warn。
 *
 * 例外是「被信号杀死」：那多数是我们自己的兜底（主动行为），按异常刷屏会淹掉真失败。
 */
async function runSoundChain(
  commands: readonly ToneCommand[],
  logger: LoggerPort,
): Promise<ChainOutcome> {
  const breakdowns: string[] = [];
  let worthy = false;
  for (const item of commands) {
    const facts = await run(item.command);
    const failure = playFailure(item.player, facts);
    if (failure === undefined) return { ok: true, detail: "" };
    breakdowns.push(summarize(item, failure, facts));
    worthy ||= warnWorthy(failure);
  }
  if (worthy) logger.warn(`dsh-notifier: 提示音播放失败：${breakdowns.join("；")}`);
  return { ok: false, detail: breakdowns.join("；") };
}

/** 一条候选失败的摘要：成因文字来自播放器判据，stderr 尾部在这里按日志上限截一次。 */
function summarize(item: ToneCommand, failure: PlayFailure, facts: CommandFacts): string {
  const tail = facts.stderr.trim();
  return playFailureSummary(
    commandNameOf(item.command),
    failure,
    tail === "" ? "" : tail.slice(-STDERR_LOG_MAX),
  );
}

/** 本次自播的准备结论：命令链就绪（可能带着临时文件）、放不出声、或临时目录写不进去。 */
type SoundPrep =
  | { readonly kind: "ready"; readonly commands: readonly ToneCommand[]; readonly staged?: string }
  | { readonly kind: "empty" }
  | { readonly kind: "unwritable"; readonly cause: string };

const NO_SOUND: SoundPrep = { kind: "empty" };

/**
 * 备好本次自播：主题文件优先，Linux 上候选全缺时才把合成音落到临时文件；再按回退链构造命令。
 * 一个候选播放器都没有时**不落盘**——命令根本构造不出来，落了也得马上删。
 */
function prepareSound(probe: PlatformProbe, tone: string): SoundPrep {
  if (probe.platform === "linux" && probe.players.length === 0) return NO_SOUND;
  const source = resolveToneSource(probe.platform, tone);
  if (source.kind === "none") return NO_SOUND;
  if (source.kind === "theme") {
    const commands = buildSoundCommands(probe, source.path);
    return commands.length === 0 ? NO_SOUND : { kind: "ready", commands };
  }
  const staged = stageToneSource(source.bytes);
  if (!staged.ok) return { kind: "unwritable", cause: staged.cause };
  const commands = buildSoundCommands(probe, staged.path);
  if (commands.length === 0) {
    unstageToneAudio(staged.path);
    return NO_SOUND;
  }
  return { kind: "ready", commands, staged: staged.path };
}

/**
 * 只响不弹分支（原 sendSystem 的 !popup 段）：声音是唯一动作。
 * 临时文件写不进去 = 一条命令都构造不出来——终态 skipped；放不出声同理。
 */
async function runSoundOnly(
  prep: SoundPrep,
  target: SystemTarget,
  probe: PlatformProbe,
): Promise<DeliverResult> {
  // 只响不弹：声音是唯一动作。临时文件写不进去 = 一条命令都构造不出来——本次没有可执行的动作，
  // 终态是 `skipped`（`failed` 的定义是「执行过动作而它失败了」），但成因要能查。
  if (prep.kind === "unwritable") return unwritableSound(target, prep.cause);
  // `!selfPlay` 只可能是枚举外的平台（三平台里 linux 恒自播，darwin / win32 在 `!pop` 时都自播）；
  // 它和「放不出声」是同一件事：本次没有可执行的动作。
  if (prep.kind !== "ready") return unexecutable(target, probe);
  const played = await playChain(prep, target);
  return played.ok
    ? delivered()
    : failed("reasonSystemSoundFailed", { bin: chainBin(prep.commands) }, played.detail);
}

/**
 * 弹窗路径下播放未就绪分支（原 sendSystem 的 prep !== ready 段，需弹窗已构造）。
 * 空动作优先判：一条命令都没构造出来时，「弹窗失败」与「声音失败」都无从谈起。
 * 弹窗已经出去了：声音是尽力而为，但成因仍要留**一条** warn。
 */
function handleUnreadyPrepWithPopup(
  prep: Exclude<SoundPrep, { readonly kind: "ready" }>,
  pop: readonly string[],
  popRan: boolean,
  popOk: boolean,
  target: SystemTarget,
  probe: PlatformProbe,
): DeliverResult {
  // 空动作优先判：一条命令都没构造出来时，「弹窗失败」与「声音失败」都无从谈起。这一格旧实现
  // 在 linux / darwin 上是零输出、零状态、零日志——正是本次要修的静默。
  if (!popRan) {
    return prep.kind === "unwritable"
      ? unwritableSound(target, prep.cause)
      : unexecutable(target, probe);
  }
  // 弹窗已经出去了：声音这一格是尽力而为，但成因仍要留**一条** warn。
  if (prep.kind === "unwritable") target.logger.warn(toneUnwritableWarn(prep.cause));
  return popOk ? delivered() : failed("reasonSystemPopupFailed", { bin: commandNameOf(pop) });
}

/**
 * 弹窗路径下播放就绪后的收尾（原 sendSystem 尾段：打包缺陷 warn + 双失败判定）。
 * 声音只在它是本次唯一动作时才翻转终态；toast 已经出去时声音是尽力而为。
 */
function finishPopupWithSound(
  prep: Extract<SoundPrep, { kind: "ready" }>,
  pop: readonly string[],
  popRan: boolean,
  popOk: boolean,
  played: ChainOutcome,
  target: SystemTarget,
  probe: PlatformProbe,
): DeliverResult {
  // 弹窗没构造出来而声音还在跑：win32 的脚本缺失是**打包缺陷**，不能被「这次还有声音」盖掉
  // ——旧实现在这一格是无条件出声的。
  if (!popRan && toastScriptMissing(probe)) target.logger.warn(toastScriptMissingWarn(target));
  // 弹窗命令非空说明工具确实在：它的非零退出是真失败，不再是「无桌面会话」那类常态环境
  // （后者走的是 `!notifySendAvailable`，命令根本构造不出来）。
  if (!popOk) return failed("reasonSystemPopupFailed", { bin: commandNameOf(pop) });
  // 声音只在它是本次唯一动作时才翻转终态；toast 已经出去时声音是尽力而为。
  if (!played.ok && !popRan) {
    return failed("reasonSystemSoundFailed", { bin: chainBin(prep.commands) }, played.detail);
  }
  return delivered();
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
  const prep = selfPlay ? prepareSound(probe, toneOf(target.sound)) : NO_SOUND;

  if (!target.popup) return runSoundOnly(prep, target, probe);

  const pop = buildSystemCommand(
    probe,
    truncateCodePoints(message.title, displayCaps.system.titleMax),
    truncateCodePoints(message.body, displayCaps.system.bodyMax),
    { sound: target.sound, selfPlay, toastScript: target.toastScript },
  );
  // 两条都跑：弹窗失败不该顺手把声音也丢掉（用户至少还能听见）。顺序是先弹后响。
  const popRan = pop.length > 0;
  const popOk = popRan ? await runCommand(pop, target.logger) : true;

  // 本次没有可执行的播放命令：临时目录写不进去，或素材 / 候选播放器一个都没有。
  if (prep.kind !== "ready") {
    return handleUnreadyPrepWithPopup(prep, pop, popRan, popOk, target, probe);
  }

  const played = await playChain(prep, target);
  return finishPopupWithSound(prep, pop, popRan, popOk, played, target, probe);
}

/** 跑回退链：素材一定就绪（`prep.kind === "ready"`），临时文件在链尾结算后交还给 `finally` 收走。 */
async function playChain(
  prep: Extract<SoundPrep, { kind: "ready" }>,
  target: SystemTarget,
): Promise<ChainOutcome> {
  try {
    return await runSoundChain(prep.commands, target.logger);
  } finally {
    // unstage 必须晚于最后一次 run() 的 onExit：链已经 await 完，播放器手里的 inode 也已经打开过；
    // 反过来（spawn 后立即 unlink）实测播放器会报 42B 的「打不开」。
    if (prep.staged !== undefined) unstageToneAudio(prep.staged);
  }
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

/** 临时文件写不进去的空动作收口：终态 `skipped`（没有任何可执行的动作），成因走新 code。 */
function unwritableSound(target: SystemTarget, cause: string): DeliverResult {
  target.logger.warn(toneUnwritableWarn(cause));
  return {
    status: "skipped",
    reason: reason("reasonSystemToneUnwritable", { detail: cause }),
  };
}

/** 临时目录写不进去的告警文案：原因（EROFS / EACCES 原文）要带上，否则只知道「没声音」。 */
function toneUnwritableWarn(cause: string): string {
  return `dsh-notifier: 系统提示音临时文件写入失败，本次未发声：${cause}`;
}

/** win32 的 toast 脚本不在：命令根本构造不出来。它是打包缺陷，不是用户的桌面环境问题。 */
function toastScriptMissing(probe: PlatformProbe): boolean {
  return probe.platform === "win32" && !probe.toastScriptAvailable;
}

/** 打包缺陷的告警文案：要指向那个文件，否则「弹窗没出来」无从查起。 */
function toastScriptMissingWarn(target: SystemTarget): string {
  return `dsh-notifier: 系统通知脚本缺失，Windows 弹窗未发出：${target.toastScript}`;
}

/** 全失败时的 `params.bin`：回退链上第一个候选（表序最靠前的命中者）。 */
function chainBin(commands: readonly ToneCommand[]): string {
  const first = commands[0];
  return first === undefined ? "unknown" : commandNameOf(first.command);
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
 * 换一次投递还是同样的结论。`detail` 放各候选的成因摘要（宿主原文口径），设置页折叠可查。
 */
function failed(code: ReasonCode, params?: ReasonParams, detail?: string): DeliverResult {
  const extra: { params?: ReasonParams; detail?: string } = {};
  if (params !== undefined) extra.params = params;
  if (detail !== undefined && detail !== "") extra.detail = detail;
  return {
    status: "failed",
    stage: "delivered",
    reason: reason(code, extra),
    retryable: false,
  };
}
