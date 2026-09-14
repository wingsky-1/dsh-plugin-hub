/**
 * dsh-notifier channels 域 system 块 —— Linux 自播播放器的事实表与运行期判据。
 *
 * 为什么是表：链序（先试哪个播放器）不是散在 `sendSystem` 里的分支串，而是这张表的**行序**；
 * 新增播放器 = 加一行，改序 = 挪一行。探测参数、命令行、能力面判据（`needsServer`）与运行期
 * 判据（`fatalMarkers`）都从同一行读，不再有第二份名单。
 *
 * 运行期判据为什么不是「stderr 必须为空」：本机实测（Ubuntu 22.04 / ffplay 4.4.2-0ubuntu0.22.04.1 /
 * 2026-09-14）40 次成功播放里有 **3 次** stderr 非空——libasound 直写
 * `ALSA lib pcm.c:8568:(snd_pcm_recover) underrun occurred`，且不受 `-loglevel` 约束（换
 * `-loglevel quiet` 再跑 30 次仍有 2 次）。真成功会被判失败 ⇒ 链继续 ⇒ 双响，或终态 `failed`
 * 而声音其实已经出去了。判据因此是「退出码 + 实测致命标记」。
 */
import type { CommandFacts } from "./type.ts";

/** 播放器候选：一行数据就是它在链上的全部事实。 */
export interface PlayerSpec {
  readonly bin: string;
  /** 探测参数：**任一**成功即命中（各播放器的版本参数不统一，实测 ffplay 的 `--version` exit 1）。 */
  readonly probeArgs: readonly (readonly string[])[];
  /** 播放一条音频文件的参数（文件名由调用方接在最后，仍是参数数组，不经 shell）。 */
  readonly fileArgs: (file: string) => readonly string[];
  /** 无声音服务时必失败：能力面据此把「只命中服务型候选」判成 degraded 而不是 ok。 */
  readonly needsServer: boolean;
  /** 命中即判失败的 stderr 标记（判据用；只收实测样本，见下方常量）。 */
  readonly fatalMarkers: readonly string[];
}

/**
 * 实测致命标记表（每条都能指到本机样本，2026-09-14 / Ubuntu 22.04 / ffplay 4.4.2）：
 * `Failed to open file … or configure filtergraph`（输入打不开）、`audio open failed`
 * （`No more combinations to try, audio open failed`）、`Could not initialize SDL`
 * （`SDL_AUDIODRIVER=nonexistent`）、`Failed to create window or renderer`（缺 `-nodisp`）、
 * `No such file or directory`（文件不存在）、`Invalid data found when processing input`（空文件/
 * 随机字节）、`Is a directory`（目录当输入）。
 *
 * **不在表里**的是已知噪声：以 `ALSA lib ` 开头的行在成功路径上也会出现（3/40）。这一条正是
 * 「零输出」判据被推翻的地方——把输出本身当失败证据，就会把真成功判成失败。
 *
 * 表按行共享给链上每个候选：表里全是**失败文本**，命中它只可能把一次假成功翻成失败（本判据的
 * fail-open 残余要收的正是这个），不会反过来误杀成功；而 `aplay`/`paplay`/`pw-play` 的失败
 * 文本本机没有样本，按「未实测面结构性隔离」一条都不写——表里只有实测过的字符串。
 */
const FATAL_MARKERS: readonly string[] = [
  "Failed to open file",
  "audio open failed",
  "Could not initialize SDL",
  "Failed to create window or renderer",
  "No such file or directory",
  "Invalid data found when processing input",
  "Is a directory",
];

/**
 * Linux 自播回退链（维护者裁决的链序 = 本表行序）：
 * `paplay` → `pw-play` → `aplay` → `ffplay`（先服务型、再直接怼 ALSA 的轻量播放器、
 * 最后 ffplay——它最不挑环境但最重）。
 */
export const LINUX_PLAYERS: readonly PlayerSpec[] = [
  {
    bin: "paplay",
    // 未实测（本机无 paplay）：`--version` 是 PulseAudio 系 CLI 的通行参数
    probeArgs: [["--version"]],
    fileArgs: (file) => [file],
    needsServer: true,
    fatalMarkers: FATAL_MARKERS,
  },
  {
    bin: "pw-play",
    // 未实测（本机无 pw-play）：PipeWire 自带的 PA 兼容 CLI，版本参数与 paplay 同形
    probeArgs: [["--version"]],
    fileArgs: (file) => [file],
    needsServer: true,
    fatalMarkers: FATAL_MARKERS,
  },
  {
    bin: "aplay",
    // 未实测（本机无 aplay）：ALSA 自带 CLI，`--version` 是它的通行参数
    probeArgs: [["--version"]],
    fileArgs: (file) => [file],
    needsServer: false,
    fatalMarkers: FATAL_MARKERS,
  },
  {
    bin: "ffplay",
    // 实测：`ffplay --version` **exit 1**（它只认单横线的 `-version`），故两个参数都试
    probeArgs: [["-version"], ["-h"]],
    // 四个参数都必需：`-hide_banner`/`-loglevel error` 压噪声，`-nodisp` 禁开窗口
    // （缺它实测 exit 0 但只报 `Failed to create window or renderer`，根本不出声），
    // `-autoexit` 播完即退（缺它进程不退出，只能等 8 秒兜底杀）
    fileArgs: (file) => ["-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", file],
    needsServer: false,
    fatalMarkers: FATAL_MARKERS,
  },
];

/** 按 bin 取表行：命中的播放器名是探测产出，命令行与判据都要回到表上。 */
export function playerSpec(bin: string): PlayerSpec | undefined {
  return LINUX_PLAYERS.find((player) => player.bin === bin);
}

/** 判据结论：命令的原始结局，或「退出码 0 却命中了致命标记」——两者都是失败成因。 */
export type PlayFailure =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "killed" }
  | { readonly kind: "timeout" }
  | { readonly kind: "spawn-threw"; readonly cause: string }
  | { readonly kind: "spawn-error"; readonly cause: string }
  | { readonly kind: "marker"; readonly marker: string };

/**
 * 音频路径的具名判据：`exit≠0` / 被信号杀死 / 超时兜底 / 启动失败 / 命中实测致命标记 ⇒ 失败，
 * 其余 ⇒ 成功。`spec === undefined` 表示这条命令不在播放器表上（darwin 的 `afplay`、win32 的
 * PowerShell），此时**只判退出码**——ffplay 上量到的标记不是它们的成败语义。
 */
export function playFailure(
  spec: PlayerSpec | undefined,
  facts: CommandFacts,
): PlayFailure | undefined {
  const outcome = facts.outcome;
  if (outcome.kind !== "exit") return outcome;
  if (outcome.code !== 0) return outcome;
  if (spec === undefined) return undefined;
  const marker = spec.fatalMarkers.find((item) => facts.stderr.includes(item));
  return marker === undefined ? undefined : { kind: "marker", marker };
}

/**
 * 这次失败要不要在日志里出声：被信号杀死多数是我们自己的超时兜底（主动行为），按异常刷屏会淹掉
 * 真失败；超时兜底是例外——那一格旧实现零日志零结算，必须留痕（见 `run` 的兜底杀进程）。
 */
export function warnWorthy(failure: PlayFailure): boolean {
  return failure.kind !== "killed";
}

/** 一个候选失败的可读摘要（进 warn，也进 `reason.detail`）：`bin 成因`。 */
export function playFailureSummary(bin: string, failure: PlayFailure, tail: string): string {
  const suffix = tail === "" ? "" : `：${tail}`;
  switch (failure.kind) {
    case "exit":
      return `${bin} 退出码 ${failure.code}${suffix}`;
    case "killed":
      return `${bin} 被信号杀死${suffix}`;
    case "timeout":
      return `${bin} 超时未退出${suffix}`;
    case "spawn-threw":
      return `${bin} 启动失败：${failure.cause}`;
    case "spawn-error":
      return `${bin} 不可用：${failure.cause}`;
    case "marker":
      return `${bin} 命中致命标记「${failure.marker}」${suffix}`;
  }
}
