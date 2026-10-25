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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LINUX_PLAYERS } from "../../../src/server/channels/impl/system/players.ts";
import {
  buildSoundCommands,
  buildSystemCommand,
  probePlatform,
  shouldSelfPlay,
} from "../../../src/server/channels/impl/system/index.ts";
import { toneFileCandidates } from "../../../src/server/channels/impl/system/tones.ts";
import { SOUND_IDS, TONES } from "../../../src/shared/interface.ts";
import {
  ALL_PROBES,
  CHAIN_BINS,
  TOAST_SCRIPT,
  SystemDelivery,
  errorOf,
  exitOf,
  fakeDeps,
  firstProbeOf,
  flushTasks,
  installSystemDeps,
  installSystemTestCleanup,
  optionsOf,
  payloadOf,
  probeFailed,
  probeOf,
  releaseSystemDeps,
  stderrOf,
  systemDeps,
} from "./system-test-support.ts";

installSystemTestCleanup();

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
    expect(payloadOf(command)).toEqual({
      title: "标题",
      message: "正文",
      silent: true,
    });

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
    const probe = probeOf({
      platform: "darwin",
      notifySendAvailable: false,
      players: ["afplay"],
    });
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
  it("链上一个候选都没有（枚举外平台）⇒ 空命令：调用方据此判空动作，而不是 spawn 一个空 argv", () => {
    expect(
      buildSoundCommands(probeOf({ platform: "freebsd", players: [] }), "/tmp/tone.wav"),
    ).toEqual([]);
  });

  // 链序是表的行序：每个命中候选各一条命令、argv 从表行取，「素材在不在」由调用方判（不在这里
  // 重判，否则同一件事有两个判据）。
  it("linux：链上每个命中候选各一条命令，顺序 = 表序，argv 由表行决定", () => {
    const probe = probeOf({ platform: "linux", players: CHAIN_BINS });
    const commands = buildSoundCommands(probe, "/tmp/tone.wav");
    expect(commands.map((item) => item.command)).toEqual(
      LINUX_PLAYERS.map((player) => [player.bin, ...player.fileArgs("/tmp/tone.wav")]),
    );
    expect(commands.map((item) => item.player)).toEqual([...LINUX_PLAYERS]);
  });

  // 名单漂了就宁可这一条不试：就地拍一个 argv 出来等于让播放器收到它不认识的参数。
  it("探测命中的名字不在表上 ⇒ 那一条被丢掉，不拍 argv", () => {
    const probe = probeOf({
      platform: "linux",
      players: ["pw-play", "不存在的播放器"],
    });
    expect(buildSoundCommands(probe, "/tmp/tone.wav").map((item) => item.command[0])).toEqual([
      "pw-play",
    ]);
  });
});

describe("probePlatform：平台分支与探测", () => {
  // A2：并行探全部候选，返回**全部**命中者且顺序 = 表序。命中即停那版会把回退链砍成一条
  // （只留第一个命中者），「首个成功即停」也就无从谈起；顺序反了则会优先用排在后面的播放器。
  it("linux：notify-send 命中后并行探全部候选，players 是全部命中者且顺序 = 表序（参数与超时逐字）", async () => {
    const available = ["notify-send", "pw-play", "paplay"];
    const fake = fakeDeps({ available, present: [TOAST_SCRIPT] });
    installSystemDeps(fake);

    expect(await probePlatform(TOAST_SCRIPT)).toEqual({
      platform: "linux",
      toastScriptAvailable: true,
      notifySendAvailable: true,
      players: CHAIN_BINS.filter((bin) => available.includes(bin)),
    });
    // 探测参数从表导出；超时逐字 3000（探测不许拖住第一次投递）
    expect(fake.probed.map((record) => `${record.bin} ${record.args.join(" ")}`)).toEqual([
      "notify-send --version",
      ...ALL_PROBES,
    ]);
    expect(fake.probed.every((record) => record.timeout === 3000)).toBe(true);
    expect(fake.checked).toEqual([TOAST_SCRIPT]);
  });

  // A1：播放器的版本参数不统一——实测 ffplay 的 `--version` exit 1（它只认单横线的 `-version`），
  // 故表内参数要按序试、任一成功即命中。只试 `--version` 的实现会把本机可用的 ffplay 判成没有。
  it("linux：ffplay 按表内参数逐个试（-version 或 -h 任一成功即命中，-h 只在 -version 失败后才试）", async () => {
    const version = fakeDeps({ availableProbes: ["ffplay -version"] });
    installSystemDeps(version);
    expect((await probePlatform(TOAST_SCRIPT)).players).toEqual(["ffplay"]);
    expect(version.probed.map((record) => `${record.bin} ${record.args.join(" ")}`)).toEqual([
      "notify-send --version",
      ...LINUX_PLAYERS.map(firstProbeOf),
    ]);

    const help = fakeDeps({ availableProbes: ["ffplay -h"] });
    installSystemDeps(help);
    expect((await probePlatform(TOAST_SCRIPT)).players).toEqual(["ffplay"]);
    expect(help.probed.map((record) => `${record.bin} ${record.args.join(" ")}`)).toEqual([
      "notify-send --version",
      ...ALL_PROBES,
    ]);
  });

  // A3：探测**并行**。串行探测最坏要串行等 4 次超时，而探测会挡住第一次投递；判据是「全部候选的
  // 探测都先发出去，再收到任何一个结论」——串行实现里第二个候选的探测要等第一个的回调。
  it("linux：全部候选的探测同时在飞（最坏时延是一次超时上界，不是 4 倍）", async () => {
    const fake = fakeDeps({
      available: ["notify-send"],
      holdProbes: CHAIN_BINS,
    });
    installSystemDeps(fake);

    const pending = probePlatform(TOAST_SCRIPT);
    await flushTasks();
    expect(fake.probed.map((record) => record.bin)).toEqual(["notify-send", ...CHAIN_BINS]);
    expect(fake.pendingProbes).toHaveLength(CHAIN_BINS.length);

    fake.releaseProbes();
    expect((await pending).players).toEqual([]);
  });

  // 一个都没命中 ⇒ 空链 ⇒ 空动作。半探（只探前几个）会让「有播放器但没命中」与「没探过」混为一谈。
  it("linux：一个候选都没命中 ⇒ players 为空（探测收尾没有提前 return）", async () => {
    const none = fakeDeps({ available: ["notify-send"] });
    installSystemDeps(none);
    const probe = await probePlatform(TOAST_SCRIPT);
    expect(probe.players).toEqual([]);
    expect(probe.toastScriptAvailable).toBe(false);
    expect(none.probed.map((record) => record.bin)).toEqual([
      "notify-send",
      ...LINUX_PLAYERS.flatMap((player) => player.probeArgs.map(() => player.bin)),
    ]);
  });

  // notify-send 探测不到时 linux 弹窗命令为空：这条结论错了会变成每次投递白起一个必败的进程。
  it("linux：notify-send 探测不到 → notifySendAvailable 为假", async () => {
    const fake = fakeDeps({ available: [] });
    installSystemDeps(fake);
    expect((await probePlatform(TOAST_SCRIPT)).notifySendAvailable).toBe(false);
  });

  // darwin 的弹窗走 osascript、发声走 afplay，都不依赖 notify-send：探测它是白起进程。
  it("darwin：afplay 直给、不探 notify-send（探测一次都不该发生）", async () => {
    const fake = fakeDeps({
      platform: "darwin",
      available: ["notify-send", "pw-play"],
    });
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
    const fake = fakeDeps({
      platform: "win32",
      available: ["notify-send", "pw-play"],
    });
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
    expect(fake.probed.length).toBe(1 + ALL_PROBES.length);
    expect(fake.checked.length).toBe(1);

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.probed.length).toBe(1 + ALL_PROBES.length);
    expect(fake.checked.length).toBe(1);
    // 复用的是探测结论，不是投递：弹窗两次都真的起了进程。
    expect(fake.spawned.length).toBe(2);
  });

  // 缓存不清，第二个用例拿到上一个用例的平台结论——症状是单跑绿、连跑红。
  it("换端口后重探：上一个端口的平台结论不会漏进下一次投递", async () => {
    const linux = fakeDeps({
      available: ["notify-send"],
      present: [TOAST_SCRIPT],
    });
    installSystemDeps(linux);
    expect(await new SystemDelivery().send()).toEqual({
      status: "ok",
      stage: "delivered",
    });
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

describe("旧账与结构性判据", () => {
  // G2：配置白名单 ⊆ 音色表，且每个白名单音色都有音符。缺口是「新增配置音色而漏 TONES」：
  // 只看 TONES 的旧断言在那种改法下是绿的，而用户会选到一个没有音符、放不出声的音色。
  it("SOUND_IDS ⊆ Object.keys(TONES)，且每个音色的 notes 非空", () => {
    for (const id of SOUND_IDS) {
      expect(Object.hasOwn(TONES, id), `TONES 缺 ${id}`).toBe(true);
      expect(TONES[id]?.notes.length, `${id} 没有音符`).toBeGreaterThan(0);
    }
    // 反向不要求相等：TONES 还含「跟随系统默认音」这类不在设置白名单里的键
    expect(SOUND_IDS.length).toBeGreaterThan(0);
  });

  // G3：探测与执行不许阻塞事件循环（spawnSync 会把第一次投递连同宿主一起卡住）。
  it("system 块里没有 spawnSync（探测挡住第一次投递 = 同步等待）", () => {
    const dir = fileURLToPath(
      new URL("../../../src/server/channels/impl/system/", import.meta.url),
    );
    // 匹配调用形态而不是裸词：注释里提到「不用 spawnSync」不算命中，但真调用（含 import 后调用）
    // 一定带括号
    const hits = readdirSync(dir).filter((file) =>
      /spawnSync\s*\(/u.test(readFileSync(join(dir, file), "utf8")),
    );
    expect(hits).toEqual([]);
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
    const child = systemDeps().spawn(["__dsh_notifier_absent__"], {
      collectStderr: false,
    });

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
