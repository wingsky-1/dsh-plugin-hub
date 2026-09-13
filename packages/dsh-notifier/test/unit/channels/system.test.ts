/**
 * dsh-notifier channels 域 system 出口 —— 命令构造、平台探测、自播判定与执行编排。
 *
 * 判据为什么是这些：命令一律 `[bin, ...args]` 且用户文本只经 base64 载荷进 PowerShell——这条
 * 一旦退化成拼命令串，通知标题里的一个引号就是本机命令执行；自播判定错了则要么响两声、要么
 * 「只响不弹」静默变成一次无声的失败；探测与执行错了则平台分支、探测失败、杀进程超时、退出码
 * 异常这些出口在真机上全都不可复现。
 *
 * 平台事实与子进程经 `impl/system/deps.ts` 的手写假端口驱动：真机上三条平台分支只有一条可达，
 * 而在本机真的起 `notify-send` / `afplay` 既弹窗又发声，且结论随环境而变。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DeliverResult,
  NotifyMessage,
} from "../../../src/server/channels/impl/deliver/type.ts";
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
} from "../../../src/server/channels/impl/system/type.ts";
import {
  buildSoundCommand,
  buildSystemCommand,
  probePlatform,
  sendSystem,
  shouldSelfPlay,
} from "../../../src/server/channels/impl/system/index.ts";
import { synthToneWav } from "../../../src/server/channels/impl/system/synth.ts";
import { toneFileCandidates } from "../../../src/server/channels/impl/system/tones.ts";
import { TONES } from "../../../src/shared/interface.ts";
import type {
  PlatformProbe,
  SystemCommandOptions,
  SystemTarget,
} from "../../../src/server/channels/impl/system/type.ts";
import { makeLogger, pollUntil } from "../../helpers.ts";

afterEach(() => {
  // 端口与探测缓存都是模块级单例：不复位就把平台事实漏给下一个用例（单跑绿、连跑红）。
  releaseSystemDeps();
  vi.useRealTimers();
});

function probeOf(over: Partial<PlatformProbe> = {}): PlatformProbe {
  return {
    platform: "linux",
    toastScriptAvailable: true,
    notifySendAvailable: true,
    players: ["pw-play"],
    ...over,
  };
}

function optionsOf(over: Partial<SystemCommandOptions> = {}): SystemCommandOptions {
  return { sound: true, selfPlay: false, toastScript: "/tmp/notifier/toast.ps1", ...over };
}

/** 取 PowerShell 命令里那段 base64 载荷：win32 的用户文本只在这里，不进 argv。 */
function payloadOf(command: readonly string[]): Record<string, unknown> {
  const index = command.indexOf("-Payload");
  if (index < 0) throw new Error("命令里没有 -Payload");
  return JSON.parse(Buffer.from(command[index + 1]!, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------- 假进程事实端口

/** 假子进程：三个出口都由用例显式驱动，不依赖真实进程的调度。 */
class FakeChild implements ChildHandle {
  /** 兜底杀进程的次数（超时用例断言它）。 */
  killCount = 0;

  private readonly exits: Array<(exit: ProcessExit) => void> = [];
  private readonly errors: Array<(cause: Error) => void> = [];
  private readonly stderrs: Array<(chunk: Buffer) => void> = [];

  onStderr(handler: (chunk: Buffer) => void): void {
    this.stderrs.push(handler);
  }

  onExit(handler: (exit: ProcessExit) => void): void {
    this.exits.push(handler);
  }

  onError(handler: (cause: Error) => void): void {
    this.errors.push(handler);
  }

  kill(): void {
    this.killCount += 1;
  }

  emitStderr(text: string): void {
    for (const handler of this.stderrs) handler(Buffer.from(text, "utf8"));
  }

  emitExit(exit: ProcessExit): void {
    for (const handler of this.exits) handler(exit);
  }

  emitError(cause: Error): void {
    for (const handler of this.errors) handler(cause);
  }
}

/** 假端口的现场：用例只写关心的那几项，其余走 `fakeDeps()` 的缺省。 */
interface FakeConfig {
  platform: string;
  /** 探测得到回应的命令（`--version` 以退出码 0 结束）。 */
  available: readonly string[];
  /** `existsSync` 为真的路径。 */
  present: readonly string[];
  /** 通知守护进程名的探测结论。 */
  nameProbe?: NotificationNameProbe;
  /** `/etc/os-release` 的读取结论。 */
  osRelease?: OsReleaseProbe;
}

/** 起进程的记录：逐字 argv 与选项都要它。 */
interface SpawnRecord {
  readonly command: readonly string[];
  readonly options: SpawnOptions;
}

/** 探测的记录：命令、参数与超时都要它。 */
interface ProbeRecord {
  readonly bin: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

/** 假进程事实端口：记下每一次调用，子进程交回可由用例驱动的假句柄。 */
class FakeDeps implements SystemDeps {
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

  private readonly available: readonly string[];
  private readonly present: readonly string[];
  private readonly nameProbe: NotificationNameProbe;
  private readonly osRelease: OsReleaseProbe;

  constructor(config: FakeConfig) {
    this.platform = config.platform;
    this.available = config.available;
    this.present = config.present;
    this.nameProbe = config.nameProbe ?? { kind: "absent" };
    this.osRelease = config.osRelease ?? { ok: false };
  }

  spawn(command: readonly string[], options: SpawnOptions): ChildHandle {
    this.spawned.push({ command, options });
    if (this.spawnFailure !== "") {
      throw this.spawnFailureIsError ? new Error(this.spawnFailure) : this.spawnFailure;
    }
    const child = new FakeChild();
    this.children.push(child);
    // 出口监听在同一个 tick 里挂上，故微任务里的自动退出不会漏事件
    if (this.autoExit) queueMicrotask(() => child.emitExit({ exited: true, code: this.exitCode }));
    return child;
  }

  execFile(
    bin: string,
    args: readonly string[],
    options: { readonly timeout: number },
    done: (failed: boolean) => void,
  ): void {
    this.probed.push({ bin, args, timeout: options.timeout });
    done(!this.available.includes(bin));
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
function fakeDeps(over: Partial<FakeConfig> = {}): FakeDeps {
  return new FakeDeps({ platform: "linux", available: [], present: [], ...over });
}

/** 通知脚本路径（内容无关，只作探测与 argv 的身份）。 */
const TOAST_SCRIPT = "/tmp/notifier/toast.ps1";
/** Linux ding 的自播文件（freedesktop 基线包内的绝对路径）。 */
const LINUX_DING_FILE = "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga";
/** 待投递消息：`ts` 写死不取 `Date.now()`，免得断言跟着运行时刻漂。 */
const MESSAGE: NotifyMessage = { title: "标题", body: "正文", kind: "done", ts: 1_700_000_000_000 };

/** 一次系统投递的现场：目标可覆盖，warn 文案收集在一处供断言。 */
class SystemDelivery {
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
function exitOf(handle: ChildHandle): Promise<ProcessExit> {
  return new Promise((resolve) => {
    handle.onExit(resolve);
  });
}

/** 等真实子进程的第一段 stderr 文本。 */
function stderrOf(handle: ChildHandle): Promise<string> {
  return new Promise((resolve) => {
    handle.onStderr((chunk) => {
      resolve(chunk.toString("utf8"));
    });
  });
}

/** 等真实子进程的启动失败事实。 */
function errorOf(handle: ChildHandle): Promise<Error> {
  return new Promise((resolve) => {
    handle.onError(resolve);
  });
}

/** 真实端口探一次命令；`failed` 即命令不可用。 */
function probeFailed(bin: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    systemDeps().execFile(bin, args, { timeout: 3000 }, resolve);
  });
}

describe("buildSystemCommand", () => {
  // 用户文本进 argv 就是命令注入面，base64 载荷是这条命令唯一的安全通道。
  it("win32：用户文本只走 base64 载荷，argv 里没有它（命令 tokenizer 的歧义面被彻底绕开）", () => {
    const command = buildSystemCommand(
      probeOf({ platform: "win32" }),
      "标题",
      "正文",
      optionsOf({ sound: false }),
    );
    expect(command.slice(0, 7)).toEqual([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "/tmp/notifier/toast.ps1",
    ]);
    expect(command[7]).toBe("-Payload");
    expect(command.join(" ")).not.toContain("标题");
    expect(payloadOf(command)).toEqual({ title: "标题", message: "正文", silent: true });

    // silent 的判据：不发声，或出口要自播（自播时弹窗不静音就会响两声）。
    const loud = buildSystemCommand(probeOf({ platform: "win32" }), "标", "正", optionsOf());
    expect(payloadOf(loud).silent).toBe(false);
    const selfPlayed = buildSystemCommand(
      probeOf({ platform: "win32" }),
      "标",
      "正",
      optionsOf({ selfPlay: true }),
    );
    expect(payloadOf(selfPlayed).silent).toBe(true);
  });

  // 脚本缺失是打包缺陷，命令都没构造出来时调用方需要一条可查的痕迹。
  it("win32 缺 toast 脚本 → 空命令（打包缺陷不该被当成一次普通的发送失败闷掉）", () => {
    expect(
      buildSystemCommand(
        probeOf({ platform: "win32", toastScriptAvailable: false }),
        "标题",
        "正文",
        optionsOf(),
      ),
    ).toEqual([]);
  });

  // 裸引号或裸换行会让 osascript 脚本语法错误、通知直接不发；音色写错则静默无声。
  it("darwin：转义引号与反斜杠、换行换空格；音色查表并回落 Glass，静音时不写 sound name", () => {
    const probe = probeOf({ platform: "darwin", notifySendAvailable: false, players: ["afplay"] });
    const command = buildSystemCommand(
      probe,
      '他说 "你好"\\路径',
      "第一行\n第二行",
      optionsOf({ sound: "bell" }),
    );
    expect(command[0]).toBe("osascript");
    expect(command[1]).toBe("-e");
    expect(command[2]).toBe(
      'display notification "第一行 第二行" with title "他说 \\"你好\\"\\\\路径" sound name "Tink"',
    );
    expect(command[2]).not.toContain("\n");

    const fallback = buildSystemCommand(probe, "标", "正", optionsOf({ sound: "不存在的音色" }));
    expect(fallback[2]).toContain('sound name "Glass"');
    const silent = buildSystemCommand(probe, "标", "正", optionsOf({ sound: false }));
    expect(silent[2]).not.toContain("sound name");
    const selfPlayed = buildSystemCommand(probe, "标", "正", optionsOf({ selfPlay: true }));
    expect(selfPlayed[2]).not.toContain("sound name");
  });

  // 各 DE 对 sound hint 支持参差，探测不到却硬发会把失败推给运行时。
  it("linux：恒带 suppress-sound hint（发声一律由自播承担）；探测不到 notify-send 就不给命令", () => {
    expect(buildSystemCommand(probeOf(), "标题", "正文", optionsOf())).toEqual([
      "notify-send",
      "-h",
      "boolean:suppress-sound:true",
      "标题",
      "正文",
    ]);
    expect(
      buildSystemCommand(probeOf({ notifySendAvailable: false }), "标题", "正文", optionsOf()),
    ).toEqual([]);
  });
});

describe("shouldSelfPlay：静音优先，其余按平台分叉", () => {
  // 自播时弹窗不静音就会响两声；该自播却不自播则「只响不弹」变成什么都不做。
  it.each<[boolean, boolean | string, string, boolean]>([
    [true, true, "linux", true],
    [true, "ding", "linux", true],
    [true, false, "linux", false],
    [true, true, "darwin", false],
    [true, "bell", "darwin", false],
    [false, true, "darwin", true],
    [true, true, "win32", false],
    [true, "chime", "win32", true],
    [false, true, "win32", true],
    [true, true, "freebsd", false],
  ])("shouldSelfPlay(pop=%s, tone=%s, platform=%s) = %s", (pop, tone, platform, expected) => {
    expect(shouldSelfPlay(pop, tone, platform)).toBe(expected);
  });
});

describe("音色与文件候选", () => {
  // 候选路径拼错或顺序反了，本机明明有声音文件也放不出来；而「某个音色在某个平台的素材决定
  // 漏了或写错」更难发现——把 `bell.linuxFile` 换成别的 oga、把 `ding.darwinSound` 换成
  // "Pop"，听觉上只是放错音，或让有主题文件的宿主干脆不响（正是 #783 的现场）。所以这张表
  // 按「每个音色 × 三个平台」逐行手写字面量期望，`[]` 也是显式一行（确实无素材），
  // 覆盖断言再把「漏一行」变成红。
  const PLATFORM_TONE_EXPECTATIONS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["linux", "default", ["/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"]],
    ["linux", "ding", ["/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"]],
    ["linux", "bell", ["/usr/share/sounds/freedesktop/stereo/bell.oga"]],
    [
      "linux",
      "chime",
      [
        "/usr/share/sounds/freedesktop/stereo/complete.oga",
        "/usr/share/sounds/freedesktop/stereo/dialog-information.oga",
      ],
    ],
    [
      "linux",
      "pop",
      [
        "/usr/share/sounds/freedesktop/stereo/message.oga",
        "/usr/share/sounds/freedesktop/stereo/dialog-information.oga",
      ],
    ],
    ["darwin", "default", ["/System/Library/Sounds/Glass.aiff"]],
    ["darwin", "ding", ["/System/Library/Sounds/Glass.aiff"]],
    ["darwin", "bell", ["/System/Library/Sounds/Tink.aiff"]],
    ["darwin", "chime", ["/System/Library/Sounds/Sosumi.aiff"]],
    ["darwin", "pop", ["/System/Library/Sounds/Pop.aiff"]],
    [
      "win32",
      "default",
      [
        String.raw`C:\Windows\Media\Windows Notify System Generic.wav`,
        String.raw`C:\Windows\Media\Windows Ding.wav`,
      ],
    ],
    ["win32", "ding", [String.raw`C:\Windows\Media\Windows Ding.wav`]],
    ["win32", "bell", [String.raw`C:\Windows\Media\Windows Chimes.wav`]],
    [
      "win32",
      "chime",
      [
        String.raw`C:\Windows\Media\Windows Chord.wav`,
        String.raw`C:\Windows\Media\Windows Notify System Generic.wav`,
      ],
    ],
    [
      "win32",
      "pop",
      [
        String.raw`C:\Windows\Media\Windows Balloon.wav`,
        String.raw`C:\Windows\Media\Windows Notify System Generic.wav`,
      ],
    ],
  ];

  it("平台 × 音色 → 绝对路径候选（首存在者胜）：win32 用反斜杠拼", () => {
    for (const [platform, tone, expected] of PLATFORM_TONE_EXPECTATIONS) {
      expect(toneFileCandidates(platform, tone), `${platform}/${tone}`).toEqual(expected);
    }
  });

  // 「音色有而素材没写」与「素材写了但是空」必须是两种可见状态：这条同时接管了被删掉的
  // synthToneGaps 所守的那件事（每个可选音色在三平台都有明确的素材决定），且不退回现算期望。
  it("每个音色在三平台都有显式素材决定：表漏一行、或 TONES 新增音色没跟上，即红", () => {
    const covered = PLATFORM_TONE_EXPECTATIONS.map(
      ([platform, tone]) => `${platform}/${tone}`,
    ).sort();
    const required = ["linux", "darwin", "win32"]
      .flatMap((platform) => Object.keys(TONES).map((tone) => `${platform}/${tone}`))
      .sort();
    expect(covered).toEqual(required);
  });

  it("未知音色与未知平台给不出候选：不猜一个默认音顶替", () => {
    expect(toneFileCandidates("linux", "不存在的音色")).toEqual([]);
    expect(toneFileCandidates("freebsd", "ding")).toEqual([]);
    expect(toneFileCandidates("freebsd", "default")).toEqual([]);
  });

  // spawn 一个空 argv 会抛错，调用方就拿不到「本平台放不出声」这个可判断的结论。
  it("无候选时给出空命令：调用方据此判失败，而不是 spawn 一个空 argv", () => {
    // 播放器必须给一个：`players: []` 会让「没有候选文件」与「没有播放器」两条出口都给空数组，
    // 「无候选即空命令」那道守卫被后者遮住，判据就落不到它身上。
    expect(
      buildSoundCommand(probeOf({ platform: "freebsd", players: ["pw-play"] }), "ding"),
    ).toEqual([]);
  });
});

describe("probePlatform：平台分支与探测", () => {
  // linux 的播放器顺序反了会优先用老的 PulseAudio；多探一个则是白起一个进程。
  it("linux：notify-send 命中、pw-play 优先（只探到首个可用者为止，探测参数与超时逐字）", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play", "paplay"],
      present: [TOAST_SCRIPT],
    });
    installSystemDeps(fake);

    expect(await probePlatform(TOAST_SCRIPT)).toEqual({
      platform: "linux",
      toastScriptAvailable: true,
      notifySendAvailable: true,
      players: ["pw-play"],
    });
    expect(fake.probed).toEqual([
      { bin: "notify-send", args: ["--version"], timeout: 3000 },
      { bin: "pw-play", args: ["--version"], timeout: 3000 },
    ]);
    expect(fake.checked).toEqual([TOAST_SCRIPT]);
  });

  // PipeWire 缺失的主力发行版只有 paplay；两个都缺时自播必须判成「放不出声」而不是硬发一条命令。
  it("linux：pw-play 缺失回落 paplay，两个都缺则播放器列表为空", async () => {
    const pulseOnly = fakeDeps({ available: ["notify-send", "paplay"] });
    installSystemDeps(pulseOnly);
    expect((await probePlatform(TOAST_SCRIPT)).players).toEqual(["paplay"]);
    expect(pulseOnly.probed.map((record) => record.bin)).toEqual([
      "notify-send",
      "pw-play",
      "paplay",
    ]);

    const none = fakeDeps({ available: ["notify-send"] });
    installSystemDeps(none);
    const probe = await probePlatform(TOAST_SCRIPT);
    expect(probe.players).toEqual([]);
    expect(probe.toastScriptAvailable).toBe(false);
  });

  // notify-send 探测不到时 linux 弹窗命令为空：这条结论错了会变成每次投递白起一个必败的进程。
  it("linux：notify-send 探测不到 → notifySendAvailable 为假", async () => {
    const fake = fakeDeps({ available: [] });
    installSystemDeps(fake);
    expect((await probePlatform(TOAST_SCRIPT)).notifySendAvailable).toBe(false);
  });

  // darwin 的弹窗走 osascript、发声走 afplay，都不依赖 notify-send：探测它是白起进程。
  it("darwin：afplay 直给、不探 notify-send（探测一次都不该发生）", async () => {
    const fake = fakeDeps({ platform: "darwin", available: ["notify-send", "pw-play"] });
    installSystemDeps(fake);

    expect(await probePlatform(TOAST_SCRIPT)).toEqual({
      platform: "darwin",
      toastScriptAvailable: false,
      notifySendAvailable: false,
      players: ["afplay"],
    });
    expect(fake.probed).toEqual([]);
  });

  // win32 经 PowerShell 播放，播放器列表为空；它真正要问的是 toast 脚本在不在（打包缺陷的判据）。
  it("win32：播放器列表为空、不探 notify-send，只问脚本在不在", async () => {
    const fake = fakeDeps({ platform: "win32", available: ["notify-send", "pw-play"] });
    installSystemDeps(fake);

    expect(await probePlatform(TOAST_SCRIPT)).toEqual({
      platform: "win32",
      toastScriptAvailable: false,
      notifySendAvailable: false,
      players: [],
    });
    expect(fake.probed).toEqual([]);

    const packed = fakeDeps({ platform: "win32", present: [TOAST_SCRIPT] });
    installSystemDeps(packed);
    expect((await probePlatform(TOAST_SCRIPT)).toastScriptAvailable).toBe(true);
  });

  // 未知平台不给候选播放器（猜一个就是替别的平台决定怎么发声），但 notify-send 仍按 linux 那支探。
  it("未知平台：播放器列表为空，notify-send 仍要探", async () => {
    const fake = fakeDeps({ platform: "freebsd", available: ["notify-send"] });
    installSystemDeps(fake);

    expect(await probePlatform(TOAST_SCRIPT)).toEqual({
      platform: "freebsd",
      toastScriptAvailable: false,
      notifySendAvailable: true,
      players: [],
    });
    expect(fake.probed.map((record) => record.bin)).toEqual(["notify-send"]);
  });
});

describe("探测缓存：同端口只探一次，换端口必复位", () => {
  // 探测结论是进程级事实，每次投递重探等于给每条通知加三个子进程。
  it("同一端口的第二次投递复用探测结果：探测与文件存在性判断都不重来", async () => {
    const fake = fakeDeps({ available: ["notify-send"] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery();

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.probed.length).toBe(3);
    expect(fake.checked.length).toBe(1);

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.probed.length).toBe(3);
    expect(fake.checked.length).toBe(1);
    // 复用的是探测结论，不是投递：弹窗两次都真的起了进程。
    expect(fake.spawned.length).toBe(2);
  });

  // 缓存不清，第二个用例拿到上一个用例的平台结论——症状是单跑绿、连跑红。
  it("换端口后重探：上一个端口的平台结论不会漏进下一次投递", async () => {
    const linux = fakeDeps({ available: ["notify-send"], present: [TOAST_SCRIPT] });
    installSystemDeps(linux);
    expect(await new SystemDelivery().send()).toEqual({ status: "ok", stage: "delivered" });
    expect(linux.spawned.length).toBe(1);

    const win = fakeDeps({ platform: "win32", present: [] });
    installSystemDeps(win);
    const second = new SystemDelivery();
    expect(await second.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSystemToastScriptMissing" },
    });
    expect(second.warns).toEqual([
      `dsh-notifier: 系统通知脚本缺失，Windows 弹窗未发出：${TOAST_SCRIPT}`,
    ]);
    expect(win.spawned.length).toBe(0);
  });

  // 卸下端口必须把真实进程事实还回来，否则同一个进程里的后续投递会继续用假件。
  it("releaseSystemDeps：端口还给真实进程事实", () => {
    installSystemDeps(fakeDeps({ platform: "win32" }));
    expect(systemDeps().platform).toBe("win32");

    releaseSystemDeps();
    expect(systemDeps().platform).toBe(process.platform);
  });
});

describe("命令执行：任何结局都收敛成投递结果", () => {
  // spawn 抛错时没人接住就是宿主进程崩。命令构造出来了就说明那个工具确实在，它的启动失败是
  // 真失败——旧实现把弹窗半边只记进日志，于是「推成功却没弹也没响」；bin 名进参数，设置页才指
  // 得出是哪条命令没跑成。
  it("spawn 同步抛错：弹窗命令失败判投递失败，只响不弹时同样判失败且带 bin 名", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    fake.spawnFailure = "argv 非法";
    installSystemDeps(fake);

    const pop = new SystemDelivery();
    expect(await pop.send()).toEqual({
      status: "failed",
      stage: "delivered",
      reason: { code: "reasonSystemPopupFailed", params: { bin: "notify-send" } },
      retryable: false,
    });
    expect(pop.warns).toEqual(["dsh-notifier: 命令启动失败（notify-send）: argv 非法"]);

    const soundOnly = new SystemDelivery({ popup: false, sound: "ding" });
    expect(await soundOnly.send()).toEqual({
      status: "failed",
      stage: "delivered",
      reason: { code: "reasonSystemSoundFailed", params: { bin: "pw-play" } },
      retryable: false,
    });
    expect(soundOnly.warns).toEqual(["dsh-notifier: 命令启动失败（pw-play）: argv 非法"]);
  });

  // 抛出物不一定是 Error（跨边界值）：原因若印成 undefined，日志里就只剩「启动失败」四个字。
  it("spawn 抛出非 Error：启动失败的原因仍然可读", async () => {
    const fake = fakeDeps({ available: ["notify-send"] });
    fake.spawnFailure = "argv 非法";
    fake.spawnFailureIsError = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery();

    expect(await delivery.send()).toEqual({
      status: "failed",
      stage: "delivered",
      reason: { code: "reasonSystemPopupFailed", params: { bin: "notify-send" } },
      retryable: false,
    });
    expect(delivery.warns).toEqual(["dsh-notifier: 命令启动失败（notify-send）: argv 非法"]);
  });

  // 退出码 0 是唯一成功判据：把「起来了」当成功会让只响不弹在播放失败时也报 ok。
  it("退出码 0：投递成功，且不留任何日志", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(delivery.warns).toEqual([]);
    expect(fake.spawned.map((record) => record.command)).toEqual([["pw-play", LINUX_DING_FILE]]);
  });

  // stderr 尾部是 Windows PS 诊断的唯一载体；无上限收集会被一条长诊断撑爆，全量进日志会刷屏。
  it("退出码非 0：warn 带 stderr 尾部（收集封顶 512、进日志截到 300）", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitStderr("前".repeat(600));
    fake.children[0]!.emitStderr("后".repeat(100));
    fake.children[0]!.emitExit({ exited: true, code: 3 });

    expect(await pending).toEqual({
      status: "failed",
      stage: "delivered",
      reason: { code: "reasonSystemSoundFailed", params: { bin: "pw-play" } },
      retryable: false,
    });
    // 600 字的尾部已越过收集上限，第二段不再进缓冲；进日志的是截到 300 字的那一段。
    expect(delivery.warns).toEqual([
      `dsh-notifier: 命令退出码异常（pw-play exit 3）：${"前".repeat(300)}`,
    ]);
  });

  // 没有 stderr 时不该留一个空的冒号尾巴（读日志的人会以为诊断被吞了）。
  it("退出码非 0 但没有 stderr：warn 只报退出码", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitExit({ exited: true, code: 3 });

    expect((await pending).status).toBe("failed");
    expect(delivery.warns).toEqual(["dsh-notifier: 命令退出码异常（pw-play exit 3）"]);
  });

  // 原生二进制缺失走的是 error 事件而不是退出码：不接住它宿主进程会直接被打挂。
  it("error 事件：warn「命令不可用」并判失败，不外抛", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitError(new Error("spawn pw-play ENOENT"));

    expect(await pending).toEqual({
      status: "failed",
      stage: "delivered",
      reason: { code: "reasonSystemSoundFailed", params: { bin: "pw-play" } },
      retryable: false,
    });
    expect(delivery.warns).toEqual(["dsh-notifier: 命令不可用（pw-play）: spawn pw-play ENOENT"]);
  });

  // 被杀多数是我们自己的超时兜底：那是主动行为，按异常刷屏会淹掉真正的失败。
  it("被信号杀死：不刷 warn，但「只响不弹」仍按失败收敛", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitExit({ exited: false });

    expect((await pending).status).toBe("failed");
    expect(delivery.warns).toEqual([]);
  });

  // 两个出口都到达时先到的那个说了算：后到的若再结算一次，结论会被反转。
  it("exit 与 error 都到达：只结算先到的那个", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitExit({ exited: false });
    fake.children[0]!.emitError(new Error("迟到的 error"));

    expect((await pending).status).toBe("failed");
    expect(delivery.warns).toEqual([]);

    // 反过来的顺序同样只结算一次：晚到的退出码不该再补一条异常日志
    const reversed = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    reversed.autoExit = false;
    installSystemDeps(reversed);
    const late = new SystemDelivery({ popup: false, sound: "ding" });
    const lateExit = late.send();
    await pollUntil(() => reversed.children.length > 0, "假端口应起出子进程");
    reversed.children[0]!.emitError(new Error("先到的 error"));
    reversed.children[0]!.emitExit({ exited: true, code: 3 });

    expect((await lateExit).status).toBe("failed");
    expect(late.warns).toEqual(["dsh-notifier: 命令不可用（pw-play）: 先到的 error"]);
  });

  // Windows 的 PS 诊断只在 stderr 上，故只有它接管道；探测与执行必须给同一条平台的选项。
  it("win32 起进程接 stderr 管道，其它平台不接", async () => {
    const linux = fakeDeps({ available: ["notify-send"] });
    installSystemDeps(linux);
    expect(await new SystemDelivery().send()).toEqual({ status: "ok", stage: "delivered" });
    expect(linux.spawned.map((record) => record.options)).toEqual([{ collectStderr: false }]);

    const win = fakeDeps({ platform: "win32", present: [TOAST_SCRIPT] });
    installSystemDeps(win);
    expect(await new SystemDelivery().send()).toEqual({ status: "ok", stage: "delivered" });
    expect(win.spawned.map((record) => record.options)).toEqual([{ collectStderr: true }]);
  });
});

describe("兜底杀进程（假时钟，不真等 8 秒）", () => {
  // 卡住的子进程会一直占着投递：超时兜底不生效就是通知链路被一个死进程拖住。
  it("卡满 8 秒即杀：7999ms 不杀、8000ms 杀且只杀一次", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = fakeDeps({ available: ["notify-send"] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery();

    const pending = delivery.send();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.children.length).toBe(1);

    await vi.advanceTimersByTimeAsync(7999);
    expect(fake.children[0]!.killCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.children[0]!.killCount).toBe(1);

    fake.children[0]!.emitExit({ exited: true, code: 0 });
    expect(await pending).toEqual({ status: "ok", stage: "delivered" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.children[0]!.killCount).toBe(1);
  });

  // 结局已到的子进程不该在 8 秒后再被「杀」一次：定时器不清，进程早已回收而回调照样打进来。
  it("结局先到（退出或 error）：定时器被清掉，不再有杀进程动作", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const exited = fakeDeps({ available: ["notify-send"] });
    exited.autoExit = false;
    installSystemDeps(exited);
    const first = new SystemDelivery().send();
    await vi.advanceTimersByTimeAsync(0);
    exited.children[0]!.emitExit({ exited: true, code: 0 });
    expect(await first).toEqual({ status: "ok", stage: "delivered" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exited.children[0]!.killCount).toBe(0);

    const errored = fakeDeps({ available: ["notify-send"] });
    errored.autoExit = false;
    installSystemDeps(errored);
    const second = new SystemDelivery().send();
    await vi.advanceTimersByTimeAsync(0);
    errored.children[0]!.emitError(new Error("ENOENT"));
    // 本用例守的是定时器：error 先到即清掉兜底杀进程。终态本身按新规则是失败
    // （弹窗命令非空 ⇒ 工具在，error 事件就是它的真失败）。
    expect((await second).status).toBe("failed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errored.children[0]!.killCount).toBe(0);
  });
});

describe("sendSystem：弹窗与自播的编排", () => {
  // 顺序反了会先响后弹；自播的静音标志漏了则响两声。
  it("linux 弹窗 + 自播：先弹（恒静音）再响，两条命令都真的执行", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.spawned.map((record) => record.command)).toEqual([
      ["notify-send", "-h", "boolean:suppress-sound:true", "标题", "正文"],
      ["pw-play", LINUX_DING_FILE],
    ]);
    expect(delivery.warns).toEqual([]);
  });

  // 无桌面会话、无 notify-send 是常态环境：不是投递失败，但也**不是成功**——本次一条命令都没
  // 构造出来。旧实现既报 ok 又零日志，「推成功却没声音」由此完全不可查。
  it("linux 探测不到 notify-send：收成 skipped(environment) 并留恰好一条 warn，不起进程", async () => {
    const fake = fakeDeps({ available: [] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: false });

    expect(await delivery.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSkipEnvironment" },
    });
    expect(fake.spawned).toEqual([]);
    expect(delivery.warns).toEqual([
      "dsh-notifier: 系统频道没有可执行的动作，通知未发出（平台 linux）",
    ]);
  });

  // darwin 无桌面会话时 osascript 仍在但音色文件不在，同样是「一条命令都构造不出来」。
  // warn 去平台硬编码之前，这一格在 darwin 上是**零输出**——与 linux 那格同一个成因。
  it("darwin 只响不弹但音色文件缺失：同样收成 skipped 且留一条 warn（不再是零日志）", async () => {
    const fake = fakeDeps({ platform: "darwin", present: [] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: true });

    expect(await delivery.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSkipEnvironment" },
    });
    expect(fake.spawned).toEqual([]);
    expect(delivery.warns).toEqual([
      "dsh-notifier: 系统频道没有可执行的动作，通知未发出（平台 darwin）",
    ]);
  });

  // 脚本缺失是打包缺陷而非环境常态：命令都没构造出来，得留一条能查的痕迹。
  it("win32 脚本缺失：留一条 warn 说明弹窗未发出", async () => {
    const fake = fakeDeps({ platform: "win32", present: [] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: false });

    expect(await delivery.send()).toEqual({
      status: "skipped",
      // 打包缺陷有自己的 code：与「宿主环境没能力」共用一个会把插件的问题说成用户桌面环境的问题
      reason: { code: "reasonSystemToastScriptMissing" },
    });
    // 恰好一条：这条平台专属文案与通用的「没有可执行的动作」互斥，同一个成因不许出两条日志
    expect(delivery.warns).toEqual([
      `dsh-notifier: 系统通知脚本缺失，Windows 弹窗未发出：${TOAST_SCRIPT}`,
    ]);
    expect(fake.spawned).toEqual([]);
  });

  // 回归保护：打包缺陷的 warn 不能被「这次还有声音可放」盖掉。旧实现在弹窗分支无条件出声，
  // 改成「只在一条命令都没有时出声」后，这一格会退化成零日志——弹窗没出现而用户查不到原因。
  it("win32 脚本缺失但指定音色能播：投递仍成功，脚本缺失的 warn 不得消失（恰好一条）", async () => {
    const wav = String.raw`C:\Windows\Media\Windows Ding.wav`;
    const fake = fakeDeps({ platform: "win32", present: [wav] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(delivery.warns).toEqual([
      `dsh-notifier: 系统通知脚本缺失，Windows 弹窗未发出：${TOAST_SCRIPT}`,
    ]);
    // 只有声音那条命令真的起了进程：弹窗命令根本没构造出来
    expect(fake.spawned.map((record) => record.command[0])).toEqual(["powershell"]);
    expect(fake.spawned.map((record) => record.command)).toEqual([
      [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$p=$args[0]; (New-Object System.Media.SoundPlayer $p).PlaySync()",
        wav,
      ],
    ]);
  });

  // 用户文本一旦进 argv 就是命令注入面；stderr 管道漏接则 PS 的诊断全丢。
  it("win32 脚本存在：弹窗走 PowerShell base64 载荷并接 stderr", async () => {
    const fake = fakeDeps({ platform: "win32", present: [TOAST_SCRIPT] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: false });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.spawned.map((record) => record.command.slice(0, 7))).toEqual([
      [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        TOAST_SCRIPT,
      ],
    ]);
    expect(payloadOf(fake.spawned[0]!.command)).toEqual({
      title: "标题",
      message: "正文",
      silent: true,
    });
    expect(fake.spawned.map((record) => record.options)).toEqual([{ collectStderr: true }]);
  });

  // darwin 的弹窗自带声音，只响不弹时才轮到 afplay；这条命令错了就是彻底无声。
  it("darwin 只响不弹：afplay 自播，弹窗半边没有命令", async () => {
    const fake = fakeDeps({ platform: "darwin", present: ["/System/Library/Sounds/Glass.aiff"] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: true });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.spawned.map((record) => record.command)).toEqual([
      ["afplay", "/System/Library/Sounds/Glass.aiff"],
    ]);
    expect(delivery.warns).toEqual([]);
  });

  // 管线的唯一判据是 `enabled`，所以「弹窗与声音都关」的目标确实会到达出口；出口的回答是
  // 「这一次没有可发的内容」——记成 ok 会让历史里多出一条没发生过的成功，而顺手做一次平台探测
  // 等于给一个空动作白起子进程。
  it("popup=false 且静音：不起进程、不做探测，收成 skipped 而不是一次投递成功", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"], present: [LINUX_DING_FILE] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: false });

    expect(await delivery.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSkipConfig" },
    });
    expect(fake.spawned).toEqual([]);
    expect(fake.probed).toEqual([]);
    expect(fake.checked).toEqual([]);
    // config 成因不留 warn：那是用户写下的意图，不是环境没能力；留日志只会把日志刷成噪声。
    // 它与 environment 的区分全在 code 上（两个成因必须分得开，见下一条断言）。
    expect(delivery.warns).toEqual([]);
  });

  // 只响不弹但放不出声：本次**没有可执行的动作**（不是「执行过而失败」），故收成 skipped 而不是
  // failed——终态判据是「有没有失败证据」，不是「用户期望落空」。成因写明是环境缺能力。
  it("只响不弹但平台放不出声：收成 skipped(environment)，不起进程并留一条 warn", async () => {
    const fake = fakeDeps({ available: ["notify-send"] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: true });

    expect(await delivery.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSkipEnvironment" },
    });
    expect(fake.spawned).toEqual([]);
    expect(delivery.warns).toEqual([
      "dsh-notifier: 系统频道没有可执行的动作，通知未发出（平台 linux）",
    ]);
  });

  // 枚举外的平台：`shouldSelfPlay` 在兜底行返回 false，popup 又是关的——一条动作都没有。
  // 这一格旧实现走的是「既不弹也不响 → ok」，正是本次要修的那类假成功。
  it("枚举外平台（freebsd）且只响不弹：走无人可执行的兜底，收成 skipped 而不是 ok", async () => {
    const fake = fakeDeps({ platform: "freebsd", available: ["notify-send"] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: true });

    expect(await delivery.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSkipEnvironment" },
    });
    expect(fake.spawned).toEqual([]);
    expect(delivery.warns).toEqual([
      "dsh-notifier: 系统频道没有可执行的动作，通知未发出（平台 freebsd）",
    ]);
  });

  // 音色文件在、播放器一个都没有（探测全落空）：命令构造不出来就是空动作，而不是 spawn 一个
  // 空 argv，也不该报 failed（没有失败证据）。
  it("只响不弹且没有任何播放器：收成 skipped(environment)，不起空命令", async () => {
    const fake = fakeDeps({ available: ["notify-send"], present: [LINUX_DING_FILE] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSkipEnvironment" },
    });
    expect(fake.spawned).toEqual([]);
    expect(delivery.warns).toHaveLength(1);
  });

  // win32 的播放骨架读 $args[0]：路径若拼进命令串，白名单就形同虚设。
  it("win32 只响不弹：PowerShell SoundPlayer 播白名单 wav（路径作独立 argv）", async () => {
    const wav = String.raw`C:\Windows\Media\Windows Ding.wav`;
    const fake = fakeDeps({ platform: "win32", present: [wav] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.spawned.map((record) => record.command)).toEqual([
      [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$p=$args[0]; (New-Object System.Media.SoundPlayer $p).PlaySync()",
        wav,
      ],
    ]);
  });

  // 截断上限是出口之间的展示约定：漏截就是给命令行塞一条超长文本，截错档位会砍掉有效信息。
  it("弹窗文本按展示上限截断（标题 64、正文 256）后才进命令", async () => {
    const fake = fakeDeps({ available: ["notify-send"] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: false });

    expect(
      await delivery.send({ ...MESSAGE, title: "标".repeat(70), body: "正".repeat(300) }),
    ).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.spawned.map((record) => record.command)).toEqual([
      ["notify-send", "-h", "boolean:suppress-sound:true", "标".repeat(64), "正".repeat(256)],
    ]);
  });
});

describe("默认真实端口：生产路径逐字不变", () => {
  // 默认值接错（比如写死一个平台）在生产里只有真机才看得出来，故直接对进程事实。
  it("platform 与 existsSync 直取进程事实", () => {
    expect(systemDeps().platform).toBe(process.platform);
    expect(systemDeps().existsSync(process.execPath)).toBe(true);
    expect(systemDeps().existsSync("/__dsh_notifier_absent__")).toBe(false);
  });

  // 探测的成败判据反了会把「命令可用」读成不可用：投影到出口就是「本平台放不出声」。
  it("execFile 探测：跑得起来的命令可用，缺失的命令不可用", async () => {
    expect(await probeFailed(process.execPath, ["--version"])).toBe(false);
    expect(await probeFailed("__dsh_notifier_absent__", [])).toBe(true);
  });

  // 真子进程这一层要接住三件事：argv 传对、stderr 接上、退出码如实上报。
  it("spawn 起真实子进程：退出码与 stderr 都落到真进程上", async () => {
    const child = systemDeps().spawn(
      [process.execPath, "-e", "process.stderr.write('诊断标记'); process.exit(5)"],
      { collectStderr: true },
    );
    const stderr = stderrOf(child);
    const exit = exitOf(child);

    expect(await stderr).toContain("诊断标记");
    expect(await exit).toEqual({ exited: true, code: 5 });
  });

  // 没人接住的 error 事件会把宿主进程打挂（历史版本在 macOS 上直接 spawn 缺失的 powershell 崩过）。
  it("spawn 起不存在的命令：error 事件到达而不是打挂宿主", async () => {
    const child = systemDeps().spawn(["__dsh_notifier_absent__"], { collectStderr: false });

    expect((await errorOf(child)).message).toContain("ENOENT");
  });

  // 被信号杀死与「退出码非 0」是两种事实：混成一种就会给超时兜底刷一条假异常。
  it("spawn 被 kill：收到的是「被信号杀死」而不是退出码", async (ctx) => {
    ctx.skip(
      process.platform === "win32",
      "Windows 的 kill 不给信号退出语义（本用例守 posix 那一支）",
    );
    const child = systemDeps().spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], {
      collectStderr: false,
    });
    const exit = exitOf(child);

    child.kill();
    expect(await exit).toEqual({ exited: false });
  });
});

describe("synth.ts：主题文件缺失时的自包含合成音（#783）", () => {
  /** 极简 WAV 头解析：不引依赖，判据只认字节事实。 */
  function parseWav(wav: Buffer) {
    return {
      riff: wav.toString("ascii", 0, 4),
      wave: wav.toString("ascii", 8, 12),
      fmtChunk: wav.toString("ascii", 12, 16),
      audioFormat: wav.readUInt16LE(20),
      channels: wav.readUInt16LE(22),
      sampleRate: wav.readUInt32LE(24),
      byteRate: wav.readUInt32LE(28),
      fmtSize: wav.readUInt32LE(16),
      blockAlign: wav.readUInt16LE(32),
      bitsPerSample: wav.readUInt16LE(34),
      dataChunk: wav.toString("ascii", 36, 40),
      dataBytes: wav.readUInt32LE(40),
      declared: wav.readUInt32LE(4),
      total: wav.length,
      samples: (() => {
        const out: number[] = [];
        for (let i = 44; i + 1 < wav.length; i += 2) out.push(wav.readInt16LE(i));
        return out;
      })(),
    };
  }

  const SAMPLE_RATE = 44100;
  /** 8ms × 44.1kHz 与 0.45 × 0x7fff 的手写字面量：从实现里现算这两个数等于让实现自己
   *  判自己——改坏 AMPLITUDE / FADE_MS 都仍然绿（复核实测这两个变异体存活）。 */
  const FADE_SAMPLES = 353;
  const FULL_SCALE = 14745;
  /** chime 重叠区（0.15s–0.3s）里两分量精确反相的样本下标：660Hz 音（起始 0）与 880Hz 音
   *  （起始 0.15s）在此处相位相反，正确实现相加后相消为 0；只把其中一个分量反相（或让后一
   *  个音覆盖前一个）时该点会升到满幅量级。 */
  const OPPOSITE_PHASE_SAMPLE = 9135;

  /**
   * 每个音色的手写事实：总时长、估计窗口与其中测得的主频、有声段数。**不从 TONES 现算**：
   * 期望值同源时改坏实现里任何一个数字都仍然绿（复核实测 M02/M05/M06 存活）。
   *
   * `segments` 是「被真静音隔开的连续有声段」：default 的第二音 at 恰等于第一音 dur，
   * 首尾相接故只有一段；只有 ding 的 at > dur 才留出可听见的间隙。
   */
  const TONE_FACTS: Readonly<
    Record<
      string,
      {
        readonly totalMs: number;
        readonly leadMs: number;
        readonly leadHz: number;
        readonly segments: number;
      }
    >
  > = {
    default: { totalMs: 380, leadMs: 160, leadHz: 880, segments: 1 },
    ding: { totalMs: 380, leadMs: 140, leadHz: 1318, segments: 2 },
    bell: { totalMs: 500, leadMs: 500, leadHz: 880, segments: 1 },
    chime: { totalMs: 800, leadMs: 150, leadHz: 660, segments: 1 },
    pop: { totalMs: 120, leadMs: 120, leadHz: 392, segments: 1 },
  };

  /** 零穿越估频：正弦/三角波每周期穿越两次；窗口取没有后续音符叠加的区间。 */
  function dominantHz(samples: readonly number[], ms: number): number {
    const end = Math.round((ms / 1000) * SAMPLE_RATE);
    let crossings = 0;
    for (let i = 1; i < end; i += 1) {
      if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) {
        crossings += 1;
      }
    }
    return (crossings * SAMPLE_RATE) / (2 * end);
  }

  /**
   * 有声段数。静音要连续 `SILENCE_GAP` 个样本低于阈值才算断开：正弦每个半周期都会短暂
   * 低于阈值，不设最小静音长度会把每个半周期都算成一段（实测 880Hz 的 bell 会算成 96 段）。
   */
  function soundSegments(samples: readonly number[]): number {
    const threshold = 100;
    const silenceGap = 50;
    let segments = 0;
    let quiet = silenceGap;
    for (const value of samples) {
      if (Math.abs(value) > threshold) {
        if (quiet >= silenceGap) segments += 1;
        quiet = 0;
      } else quiet += 1;
    }
    return segments;
  }

  /** 中段二阶差分的中位数：三角波分段线性（除峰值点外恒 0），正弦恒不为 0。 */
  function medianAbsSecondDiff(samples: readonly number[]): number {
    const values: number[] = [];
    for (let i = FADE_SAMPLES; i < samples.length - FADE_SAMPLES; i += 1) {
      values.push(Math.abs(samples[i + 1] - 2 * samples[i] + samples[i - 1]));
    }
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 0;
  }

  function samplesOf(tone: string): readonly number[] {
    return parseWav(synthToneWav(tone) as Buffer).samples;
  }

  it("每个音色都产出参数自洽的 16-bit 单声道 WAV", () => {
    // 键集与手写事实表对齐：音色表多一个键或事实表漏一个音色，都必须红
    expect(Object.keys(TONES).sort()).toEqual(Object.keys(TONE_FACTS).sort());
    for (const tone of Object.keys(TONE_FACTS)) {
      const wav = synthToneWav(tone);
      expect(wav, `${tone} 应能合成`).not.toBeNull();
      const p = parseWav(wav as Buffer);
      expect(p.riff).toBe("RIFF");
      expect(p.wave).toBe("WAVE");
      expect(p.fmtChunk).toBe("fmt ");
      expect(p.audioFormat).toBe(1); // 1 = PCM 未压缩
      expect(p.channels).toBe(1);
      expect(p.sampleRate).toBe(SAMPLE_RATE);
      expect(p.bitsPerSample).toBe(16);
      expect(p.byteRate).toBe(p.sampleRate * 2);
      // fmt 块长度写成 0 时解码器不认这段头；块对齐写成 0/32 会按错步长读样本——
      // 两者都不会被 declared/dataBytes 那两条长度断言发现（aplay/ffplay 静默失败）
      expect(p.fmtSize).toBe(16);
      expect(p.blockAlign).toBe(2);
      expect(p.dataChunk).toBe("data");
      // 头里声明的长度必须与真实字节一致：长度字段写错时 aplay/ffplay 会当成截断文件
      expect(p.declared).toBe(p.total - 8);
      expect(p.dataBytes).toBe(p.total - 44);
    }
  });

  it("段数、总时长与首音主频与手写字面量一致（改一个频率或时长就必须红）", () => {
    for (const [tone, fact] of Object.entries(TONE_FACTS)) {
      const samples = samplesOf(tone);
      expect(samples.length, `${tone} 总时长`).toBe(
        Math.round((fact.totalMs / 1000) * SAMPLE_RATE),
      );
      expect(soundSegments(samples), `${tone} 有声段数`).toBe(fact.segments);
      // 穿越计数取整带来约 ±3Hz 量化误差，容差 6Hz 仍能钉住「1318 改成 88」这类改错
      const measured = dominantHz(samples, fact.leadMs);
      expect(Math.abs(measured - fact.leadHz), `${tone} 首音主频（实测 ${measured}）`).toBeLessThan(
        6,
      );
    }
  });

  it("未知音色与原型链键名都返回 null —— 不拿默认音顶替", () => {
    // `constructor` / `__proto__` 这类键名在原型链上真实存在：`in` 或直接取值会拿到
    // Object.prototype 的成员，实测抛 `segments.reduce is not a function`
    for (const tone of ["nope", "", "constructor", "__proto__", "hasOwnProperty", "toString"]) {
      expect(synthToneWav(tone), tone).toBeNull();
    }
  });

  it("音符之间的 at 是真静音：ding 的两音之间 20ms 全为 0", () => {
    // 6174 = 0.14s、7056 = 0.16s（44.1kHz 下）：把 at 当摆设（首尾相接）时这段会被第二音
    // 填满；而「段边界回到 0」那种断言在正弦自相位 0 起时结构性恒真，发现不了这件事
    expect(
      samplesOf("ding")
        .slice(6174, 7056)
        .every((v) => v === 0),
    ).toBe(true);
  });

  it("时间上重叠的音符按采样相加：峰值高于单音区，且反相样本相消", () => {
    // 客户端 Web Audio 是多个振荡器同时响；服务端若让后一个音覆盖前一个，同一份 notes
    // 会在两端听出两种旋律
    const samples = samplesOf("chime");
    const single = Math.max(...samples.slice(0, 6615).map((v) => Math.abs(v)));
    const overlap = Math.max(...samples.slice(6615, 13230).map((v) => Math.abs(v)));
    expect(single).toBeGreaterThan(FULL_SCALE * 0.9);
    expect(overlap).toBeGreaterThan(single * 1.5);
    // 上面那条峰值判据对「相加」与「相减」同时成立（相消干涉的峰值同样接近两倍单音），
    // 反相点才分得开：9135 由两分量正弦的离线公式求得（不调用被测实现），660Hz 音（起始 0）
    // 与 880Hz 音（起始 0.15s）在该下标处精确反相，只把其中一个分量反相就会变成约
    // 2×0.975×满幅（实测：这条判据单独红的形态）。
    //
    // 登记（等价变异体，不可杀，勿再为它加断言）：synth.ts 的 `mix[start + i] += …` 被
    // Stryker 换成一元的 `-=` 时**不是缺陷**——写入点只有一处且初值为 0，实测两者产出的
    // 样本序列逐样本精确相反（5 个音色全部 a[i]+b[i]==0），即整段波形反相 180°：听觉不变，
    // 幅度类/零穿越类判据都不变，两分量之间的相对相位也没变（相消点仍是 0）。
    const opposite = Math.abs(samples[OPPOSITE_PHASE_SAMPLE] ?? Number.NaN);
    expect(opposite, `K=${OPPOSITE_PHASE_SAMPLE} 应相消`).toBeLessThan(FULL_SCALE * 0.2);
  });

  it("首尾淡入淡出：样本上界由线性包络决定，而不是「首样本为 0」这种恒真断言", () => {
    // 正弦自相位 0 起，首样本必为 0；淡出的末样本也必为 0。真正的判据是包络把首尾压在
    // 线性斜坡之下：去掉淡入淡出后第 63 个样本就能接近满幅
    for (const tone of ["pop", "ding", "bell"]) {
      const samples = samplesOf(tone);
      for (let i = 1; i < 64; i += 1) {
        const head = samples[i] ?? Number.NaN;
        expect(Math.abs(head), `${tone} 淡入 i=${i}`).toBeLessThanOrEqual(
          FULL_SCALE * (i / FADE_SAMPLES) + 1,
        );
        const tail = samples[samples.length - 1 - i] ?? Number.NaN;
        expect(Math.abs(tail), `${tone} 淡出 i=${i}`).toBeLessThanOrEqual(
          FULL_SCALE * ((i + 1) / FADE_SAMPLES) + 1,
        );
      }
    }
  });

  it("pop 是三角波而不是正弦：中段二阶差分中位数为 0（正弦恒不为 0）", () => {
    // 三角波在峰值之间严格线性，二阶差分只剩量化噪声；正弦的二阶差分与其自身成比例
    // （约 46×|sin|），中位数在 30 上下。把 type 改回缺省的正弦后这条必须红
    expect(medianAbsSecondDiff(samplesOf("pop"))).toBeLessThanOrEqual(2);
  });
});
