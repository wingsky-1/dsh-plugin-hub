/**
 * dsh-notifier channels 域 system 出口 —— 命令构造与自播判定。
 *
 * 只测**构造与判定**这两层纯函数，不测 `sendSystem`：它先探平台能力（`execFile` 探测
 * notify-send / pw-play），再 `spawn` 真命令，且音色文件是否存在由 `existsSync` 决定——在本机
 * 跑它会真的弹通知或放声音，在 CI 上又会因环境不同给出不同结论。缺的是「注入探测结果与
 * spawn」的接缝，本文件不替它造一个（报告里登记为未覆盖面）。
 *
 * 判据为什么是这些：命令一律 `[bin, ...args]` 且用户文本只经 base64 载荷进 PowerShell——这条
 * 一旦退化成拼命令串，通知标题里的一个引号就是本机命令执行；自播判定错了则要么响两声、要么
 * 「只响不弹」静默变成一次无声的失败。
 */
import { describe, expect, it } from "vitest";

import {
  buildSoundCommand,
  buildSystemCommand,
  shouldSelfPlay,
} from "../../../src/server/channels/impl/system/index.ts";
import { toneFileCandidates } from "../../../src/server/channels/impl/system/tones.ts";
import type {
  PlatformProbe,
  SystemCommandOptions,
} from "../../../src/server/channels/impl/system/type.ts";

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
  // 候选路径拼错或顺序反了，本机明明有声音文件也放不出来。
  it("平台 × 音色 → 绝对路径候选（首存在者胜）：win32 用反斜杠拼，未知音色不猜默认音", () => {
    const table: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ["win32", "ding", [String.raw`C:\Windows\Media\Windows Ding.wav`]],
      [
        "win32",
        "default",
        [
          String.raw`C:\Windows\Media\Windows Notify System Generic.wav`,
          String.raw`C:\Windows\Media\Windows Ding.wav`,
        ],
      ],
      ["linux", "ding", ["/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"]],
      [
        "linux",
        "chime",
        [
          "/usr/share/sounds/freedesktop/stereo/complete.oga",
          "/usr/share/sounds/freedesktop/stereo/dialog-information.oga",
        ],
      ],
      ["darwin", "chime", ["/System/Library/Sounds/Sosumi.aiff"]],
      ["darwin", "default", ["/System/Library/Sounds/Glass.aiff"]],
      ["linux", "不存在的音色", []],
      ["freebsd", "ding", []],
    ];
    for (const [platform, tone, expected] of table) {
      expect(toneFileCandidates(platform, tone), `${platform}/${tone}`).toEqual(expected);
    }
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
