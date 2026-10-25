/**
 * dsh-notifier channels system tests — shared fake process facts and delivery fixtures.
 *
 * The system channel has three platform branches, but a test process can execute only one of
 * them. Every migrated system suite drives this domain-specific port instead of starting real
 * notification or audio commands. Real-process checks remain explicit in their own suites.
 */
import { join } from "node:path";
import { afterEach, vi } from "vitest";

import type {
  DeliverResult,
  NotifyMessage,
} from "../../../src/server/channels/impl/deliver/type.ts";
import { releaseSoundTemps } from "../../../src/server/channels/interface.ts";
import {
  installSystemDeps,
  releaseSystemDeps,
  systemDeps,
} from "../../../src/server/channels/impl/system/deps.ts";
import type {
  ChildHandle,
  ProcessExit,
  SpawnOptions,
  SystemDeps,
} from "../../../src/server/channels/impl/system/deps.ts";
import type {
  NotificationNameProbe,
  OsReleaseProbe,
  PlatformProbe,
  SystemCommandOptions,
  SystemTarget,
  ToneStage,
} from "../../../src/server/channels/impl/system/type.ts";
import { LINUX_PLAYERS } from "../../../src/server/channels/impl/system/players.ts";
import type { PlayerSpec } from "../../../src/server/channels/impl/system/players.ts";
import { sendSystem } from "../../../src/server/channels/impl/system/index.ts";
import { makeLogger } from "../../helpers.ts";

/** 表序 = 链序：链序类判据的期望值一律从表导出，播放器名与顺序都不许在用例里再抄一份。 */
export const CHAIN_BINS = LINUX_PLAYERS.map((player) => player.bin);
/** 表内第一条探测参数（`bin args` 形态）：探测类判据拿它拼期望，不重抄参数。 */
export const firstProbeOf = (player: PlayerSpec): string =>
  `${player.bin} ${player.probeArgs[0]!.join(" ")}`;
/** 表内全部探测参数（表序 × 每行的参数序）：一个候选都没命中时，它的每条参数都会被试到。 */
export const ALL_PROBES = LINUX_PLAYERS.flatMap((player) =>
  player.probeArgs.map((args) => `${player.bin} ${args.join(" ")}`),
);
/** 假端口落的临时文件所在目录（假实现不碰文件系统，路径只作身份）。 */
export const FAKE_TONE_DIR = "/tmp/dsh-notifier-fake";
/** 实测样本：成功路径上也会出现的 libasound 噪声（40 次里 3 次）。 */
export const ALSA_UNDERRUN = "ALSA lib pcm.c:8568:(snd_pcm_recover) underrun occurred\n";
/** 让探测/投递的 await 链走完（断言「探测已经发出几条」时比 pollUntil 更直接）。 */
export const flushTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function installSystemTestCleanup(): void {
  afterEach(() => {
    // 端口与探测缓存都是模块级单例：不复位就把平台事实漏给下一个用例（单跑绿、连跑红）。
    releaseSystemDeps();
    vi.useRealTimers();
    // 真端口建的临时音频目录：用例漏了释放就在这里兜底——残留会让下一个用例（与 smoke）看见别人
    // 的目录，而「临时目录有残留」正是本增量要判死的一件事。
    releaseSoundTemps();
  });
}

export function probeOf(over: Partial<PlatformProbe> = {}): PlatformProbe {
  return {
    platform: "linux",
    toastScriptAvailable: true,
    notifySendAvailable: true,
    players: ["pw-play"],
    ...over,
  };
}

export function optionsOf(over: Partial<SystemCommandOptions> = {}): SystemCommandOptions {
  return {
    sound: true,
    selfPlay: false,
    toastScript: "/tmp/notifier/toast.ps1",
    ...over,
  };
}

/** 取 PowerShell 命令里那段 base64 载荷：win32 的用户文本只在这里，不进 argv。 */
export function payloadOf(command: readonly string[]): Record<string, unknown> {
  const index = command.indexOf("-Payload");
  if (index < 0) throw new Error("命令里没有 -Payload");
  return JSON.parse(Buffer.from(command[index + 1]!, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** 解码 win32 自播命令，并从固定脚本的数据载荷中还原原路径。 */
export function soundPathOf(command: readonly string[]): string {
  const index = command.indexOf("-EncodedCommand");
  if (index < 0) throw new Error("命令里没有 -EncodedCommand");
  const script = Buffer.from(command[index + 1]!, "base64").toString("utf16le");
  const match = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/u);
  if (match === null) throw new Error("固定 PowerShell 脚本里没有声音路径数据");
  return Buffer.from(match[1]!, "base64").toString("utf8");
}

/** 假子进程：三个出口都由用例显式驱动，不依赖真实进程的调度。 */
export class FakeChild implements ChildHandle {
  /**
   * 兜底杀进程按序记下**信号**（`undefined` = 不带信号那一次）。
   *
   * 记信号而不是只记次数：先礼后兵的两段（SIGTERM / SIGKILL）在「发了几次」这一层完全同形，
   * 而「强杀那一段真的发过 SIGKILL」正是本组用例要守的东西。
   */
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  /** 结算后是否被 unref（孤儿既不挡进程退出、也不挡事件循环）。 */
  unrefCount = 0;

  private readonly exits: Array<(exit: ProcessExit) => void> = [];
  private readonly errors: Array<(cause: Error) => void> = [];
  private readonly stderrs: Array<(chunk: Buffer) => void> = [];

  /** 结局到达的回执：临时文件的删除必须晚于它（D3 判据靠这条时序）。 */
  constructor(private readonly onExitEmitted: (() => void) | undefined = undefined) {}

  /** 杀进程次数：只看「动过没有」的判据走它（信号序列本身走 `signals`）。 */
  get killCount(): number {
    return this.signals.length;
  }

  onStderr(handler: (chunk: Buffer) => void): void {
    this.stderrs.push(handler);
  }

  onExit(handler: (exit: ProcessExit) => void): void {
    this.exits.push(handler);
  }

  onError(handler: (cause: Error) => void): void {
    this.errors.push(handler);
  }

  kill(signal?: NodeJS.Signals): void {
    this.signals.push(signal);
  }

  unref(): void {
    this.unrefCount += 1;
  }

  emitStderr(text: string): void {
    for (const handler of this.stderrs) handler(Buffer.from(text, "utf8"));
  }

  emitExit(exit: ProcessExit): void {
    this.onExitEmitted?.();
    for (const handler of this.exits) handler(exit);
  }

  emitError(cause: Error): void {
    for (const handler of this.errors) handler(cause);
  }
}

/** 假端口的现场：用例只写关心的那几项，其余走 `fakeDeps()` 的缺省。 */
interface FakeConfig {
  platform: string;
  /** 探测得到回应的命令（该 bin 的任何参数都以退出码 0 结束）。 */
  available: readonly string[];
  /** `existsSync` 为真的路径。 */
  present: readonly string[];
  /** 逐条探测的可用性（`"ffplay -version"` 形态）：各播放器的版本参数不统一，探测判据要它。 */
  availableProbes?: readonly string[];
  /** 这些 bin 的**首条**探测被扣住（并发探测的判据要它：先发出全部探测，再放行）。 */
  holdProbes?: readonly string[];
  /** 通知守护进程名的探测结论。 */
  nameProbe?: NotificationNameProbe;
  /** `/etc/os-release` 的读取结论。 */
  osRelease?: OsReleaseProbe;
}

/** 起进程的记录：逐字 argv 与选项都要它。 */
export interface SpawnRecord {
  readonly command: readonly string[];
  readonly options: SpawnOptions;
}

/** 探测的记录：命令、参数与超时都要它。 */
export interface ProbeRecord {
  readonly bin: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

/** 假进程事实端口：记下每一次调用，子进程交回可由用例驱动的假句柄。 */
export class FakeDeps implements SystemDeps {
  readonly platform: string;
  readonly spawned: SpawnRecord[] = [];
  readonly children: FakeChild[] = [];
  readonly probed: ProbeRecord[] = [];
  readonly checked: string[] = [];
  /** 非空 = `spawn` 同步抛出这个消息（真机上对应 argv 非法、权限不足）。 */
  spawnFailure = "";
  /** 假 = 抛出的不是 `Error`（跨边界值仍要留下可读的原因）。 */
  spawnFailureIsError = true;
  /** 假 = 子进程的结局由用例驱动（超时、stderr 尾部、双出口竞争这些用例要它）。 */
  autoExit = true;
  /** 自动退出用的退出码。 */
  exitCode = 0;

  /** 用例关心的时序（探测/落盘/起进程/结局/删除）：只在这个数组里判「谁先谁后」。 */
  readonly events: string[] = [];
  /** 当前还在盘上的临时音频文件（路径 → 字节）：unstage 会把它删掉，故它判「活着没有」。 */
  readonly stagedFiles = new Map<string, Buffer>();
  /** 落过盘的东西（含已被 unstage 的）：素材字节的判据看它（投递结束时 live 表已经空了）。 */
  readonly stagedHistory = new Map<string, Buffer>();
  /** 被扣住的探测回调；`releaseProbes()` 放行（并发探测用例）。 */
  readonly pendingProbes: Array<() => void> = [];
  /** 已 unstage 的路径。 */
  readonly unstaged: string[] = [];
  /** 非空 = `stageToneAudio` 回这个原因（`/tmp` 只读挂载的等价物）。 */
  stageFailure = "";
  /** 临时目录是否被释放面收走：**按次投递**就删目录的实现在这里会红。 */
  toneDirReleased = false;

  private readonly available: readonly string[];
  private readonly present: readonly string[];
  private readonly availableProbes: readonly string[];
  private readonly holdProbes: readonly string[];
  private readonly nameProbe: NotificationNameProbe;
  private readonly osRelease: OsReleaseProbe;
  private stagedSeq = 0;

  constructor(config: FakeConfig) {
    this.platform = config.platform;
    this.available = config.available;
    this.present = config.present;
    this.availableProbes = config.availableProbes ?? [];
    this.holdProbes = config.holdProbes ?? [];
    this.nameProbe = config.nameProbe ?? { kind: "absent" };
    this.osRelease = config.osRelease ?? { ok: false };
  }

  spawn(command: readonly string[], options: SpawnOptions): ChildHandle {
    this.spawned.push({ command, options });
    this.events.push(`spawn:${command[0] ?? "unknown"}`);
    if (this.spawnFailure !== "") {
      throw this.spawnFailureIsError ? new Error(this.spawnFailure) : this.spawnFailure;
    }
    const child = new FakeChild(() => this.events.push(`exit:${command[0] ?? "unknown"}`));
    this.children.push(child);
    // 出口监听在同一个 tick 里挂上，故微任务里的自动退出不会漏事件
    if (this.autoExit) {
      queueMicrotask(() => child.emitExit({ exited: true, code: this.exitCode }));
    }
    return child;
  }

  execFile(
    bin: string,
    args: readonly string[],
    options: { readonly timeout: number },
    done: (failed: boolean) => void,
  ): void {
    this.probed.push({ bin, args, timeout: options.timeout });
    const failed =
      !this.available.includes(bin) && !this.availableProbes.includes(`${bin} ${args.join(" ")}`);
    // 只扣首条：表里第二条参数（ffplay 的 `-h`）是「首条失败才试」的那一条，扣住它会让放行后
    // 又立刻挂上一条新的，探测永远收不了尾
    const firstForBin = this.probed.filter((record) => record.bin === bin).length === 1;
    if (firstForBin && this.holdProbes.includes(bin)) {
      this.pendingProbes.push(() => done(failed));
      return;
    }
    done(failed);
  }

  /** 放行被扣住的探测回调（探测并发用例）。 */
  releaseProbes(): void {
    for (const call of this.pendingProbes.splice(0)) call();
  }

  stageToneAudio(bytes: Buffer): ToneStage {
    if (this.stageFailure !== "") return { ok: false, cause: this.stageFailure };
    this.stagedSeq += 1;
    const path = join(FAKE_TONE_DIR, `tone-${this.stagedSeq}.wav`);
    this.stagedFiles.set(path, bytes);
    this.stagedHistory.set(path, bytes);
    this.events.push(`stage:${path}`);
    return { ok: true, path };
  }

  unstageToneAudio(path: string): void {
    this.unstaged.push(path);
    this.events.push(`unstage:${path}`);
    this.stagedFiles.delete(path);
  }

  releaseToneTemps(): void {
    this.toneDirReleased = true;
    this.events.push("release");
    this.stagedFiles.clear();
  }

  existsSync(path: string): boolean {
    this.checked.push(path);
    return this.present.includes(path);
  }

  probeNotificationName(): Promise<NotificationNameProbe> {
    return Promise.resolve(this.nameProbe);
  }

  readOsRelease(): OsReleaseProbe {
    return this.osRelease;
  }
}

/** 造一份假端口；缺省是「linux 上什么都没有」。 */
export function fakeDeps(over: Partial<FakeConfig> = {}): FakeDeps {
  return new FakeDeps({
    platform: "linux",
    available: [],
    present: [],
    ...over,
  });
}

/** 通知脚本路径（内容无关，只作探测与 argv 的身份）。 */
export const TOAST_SCRIPT = "/tmp/notifier/toast.ps1";
/** Linux ding 的自播文件（freedesktop 基线包内的绝对路径）。 */
export const LINUX_DING_FILE = "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga";
/** 待投递消息：`ts` 写死不取 `Date.now()`，免得断言跟着运行时刻漂。 */
export const MESSAGE: NotifyMessage = {
  title: "标题",
  body: "正文",
  kind: "done",
  ts: 1_700_000_000_000,
};

/** 一次系统投递的现场：目标可覆盖，warn 文案收集在一处供断言。 */
export class SystemDelivery {
  private readonly logger = makeLogger();
  private readonly target: SystemTarget;

  constructor(over: Partial<SystemTarget> = {}) {
    this.target = {
      type: "system",
      popup: true,
      sound: false,
      toastScript: TOAST_SCRIPT,
      logger: this.logger,
      ...over,
    };
  }

  get warns(): readonly string[] {
    return this.logger.warns;
  }

  send(message: NotifyMessage = MESSAGE): Promise<DeliverResult> {
    return sendSystem(this.target, message);
  }
}

/** 等真实子进程的第一次退出事实。 */
export function exitOf(handle: ChildHandle): Promise<ProcessExit> {
  return new Promise((resolve) => {
    handle.onExit(resolve);
  });
}

/** 等真实子进程的第一段 stderr 文本。 */
export function stderrOf(handle: ChildHandle): Promise<string> {
  return new Promise((resolve) => {
    handle.onStderr((chunk) => {
      resolve(chunk.toString("utf8"));
    });
  });
}

/** 等真实子进程的启动失败事实。 */
export function errorOf(handle: ChildHandle): Promise<Error> {
  return new Promise((resolve) => {
    handle.onError(resolve);
  });
}

/** 真实端口探一次命令；`failed` 即命令不可用。 */
export function probeFailed(bin: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    systemDeps().execFile(bin, args, { timeout: 3000 }, resolve);
  });
}

export { installSystemDeps, releaseSystemDeps, systemDeps };
