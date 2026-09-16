/**
 * dsh-notifier channels 域 capabilities 块 —— 宿主能力自检面。
 *
 * 判据为什么是这些：能力面的全部价值在于「说出来的话与事实对得上」。三种失真都会直接坑到用户，
 * 且方向相反——把 `activatable` 当可达，会在无显示的机器上报「弹窗可用」（新假警报）；把
 * `unknown` 吞进组级 `verdict`，会让「弹窗那半边无法判定」永远说不出口；`checked` 越界（给 linux
 * 塞 win32 的词）则是一条**永远绿**的契约。
 *
 * 平台事实走 `impl/system/deps.ts` 的手写假端口：真机上三条平台分支只有一条可达，而真的发 D-Bus
 * 查询既依赖跑测机器又可能触发服务激活。真端口的解析与副作用面另在文件下半段用 PATH 桩判。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkedWithin,
  probeHostCapabilities,
} from "../../../src/server/channels/impl/capabilities/index.ts";
import { ALLOWED_CHECKED } from "../../../src/server/channels/impl/capabilities/table.ts";
import type {
  HostCapabilities,
  RemediationCode,
} from "../../../src/server/channels/impl/capabilities/type.ts";
import {
  installSystemDeps,
  readOsReleaseFile,
  releaseSystemDeps,
  systemDeps,
} from "../../../src/server/channels/impl/system/deps.ts";
import { isServerlessPlayer } from "../../../src/server/channels/impl/system/index.ts";
import type { ChildHandle, SystemDeps } from "../../../src/server/channels/impl/system/deps.ts";
import type {
  NotificationNameProbe,
  OsReleaseProbe,
} from "../../../src/server/channels/impl/system/type.ts";
import { toastScriptPath } from "../../../src/server/shared/interface.ts";
import { withEnv } from "../../helpers.ts";

/** linux「跟随系统默认」的自播文件（`tones.ts` 的基线包路径）。 */
const LINUX_TONE = "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga";
/** darwin 的同义文件。 */
const DARWIN_TONE = "/System/Library/Sounds/Glass.aiff";
/** win32 的同义文件（反斜杠是那条命令骨架的一部分，故按 win32 语义拼）。 */
const WIN_TONE = "C:\\Windows\\Media\\Windows Notify System Generic.wav";

interface PortConfig {
  platform?: string;
  /** `--version` 探测会成功的命令。 */
  available?: readonly string[];
  /** `existsSync` 为真的路径。 */
  present?: readonly string[];
  nameProbe?: NotificationNameProbe;
  osRelease?: OsReleaseProbe;
}

interface FakePort {
  readonly port: SystemDeps;
  /** 探测过的命令逐字 argv。 */
  readonly probed: string[][];
  /** `existsSync` 查过的路径。 */
  readonly checked: string[];
  /** `spawn` 次数：能力面是只读探测，一次都不该起**执行**类子进程。 */
  spawns(): number;
}

/**
 * 假进程事实端口。`spawn` 直接抛：能力自检只允许「问」，任何执行路径走到这里都是缺陷，
 * 而抛错比计数更能把缺陷钉在调用点上。
 */
function fakePort(config: PortConfig = {}): FakePort {
  const available = config.available ?? [];
  const present = config.present ?? [];
  const probed: string[][] = [];
  const checked: string[] = [];
  let spawns = 0;
  const port: SystemDeps = {
    platform: config.platform ?? "linux",
    spawn: (): ChildHandle => {
      spawns += 1;
      throw new Error("能力自检不该起命令进程");
    },
    execFile: (bin, args, _options, done) => {
      probed.push([bin, ...args]);
      done(!available.includes(bin));
    },
    existsSync: (path) => {
      checked.push(path);
      return present.includes(path);
    },
    probeNotificationName: () => Promise.resolve(config.nameProbe ?? { kind: "absent" }),
    readOsRelease: () => config.osRelease ?? { ok: false },
    // 音频临时文件与上面的 spawn 同一判据：能力自检只问不做，走到落盘/清理路径就是缺陷。
    // 不静默 no-op、也不回兜底值——那会把「探针只问不做」这条保证悄悄放宽。
    stageToneAudio: () => {
      throw new Error("能力自检不该落临时音频文件");
    },
    unstageToneAudio: () => {
      throw new Error("能力自检不该删临时音频文件");
    },
    releaseToneTemps: () => {
      throw new Error("能力自检不该释放临时音频目录");
    },
  };
  return { port, probed, checked, spawns: () => spawns };
}

/** 探一次能力面（每个用例自带一份端口，且吃端口换装会复位探测缓存）。 */
async function probeWith(config: PortConfig): Promise<{ host: HostCapabilities; fake: FakePort }> {
  const fake = fakePort(config);
  installSystemDeps(fake.port);
  return { host: await probeHostCapabilities(), fake };
}

afterEach(() => {
  releaseSystemDeps();
});

describe("平台 × 维度矩阵：结论与 checked 都要落在该格允许集内", () => {
  it("linux：owner + 非服务型播放器 + 音色文件都在 ⇒ popup ok、sound ok", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send", "ffplay"],
      present: [LINUX_TONE],
      nameProbe: { kind: "owner" },
    });
    expect(host.popup.state).toBe("ok");
    expect(host.sound.state).toBe("ok");
    expect(host.sound.players).toEqual(["ffplay"]);
    expect(host.verdict).toBe("ok");
    expect(host.unknownDimensions).toEqual([]);
    expect(host.popup.checked).toEqual(["notify-send", "dbus-name-owner", "session-bus"]);
    expect(host.sound.checked).toEqual(["players", "tone-file"]);
  });

  it("darwin：走系统自带 afplay，只验音色文件，checked 里没有 D-Bus 的词", async () => {
    const { host } = await probeWith({ platform: "darwin", present: [DARWIN_TONE] });
    expect(host.popup.state).toBe("ok");
    expect(host.sound.state).toBe("ok");
    expect(host.sound.players).toEqual(["afplay"]);
    expect(host.popup.checked).toEqual([]);
    expect(host.sound.checked).toEqual(["tone-file"]);
  });

  it("win32：toast 脚本在位 ⇒ ok；缺失 ⇒ unreachable（打包缺陷不许报成宿主没问题）", async () => {
    const present = await probeWith({
      platform: "win32",
      present: [WIN_TONE, toastScriptPath()],
    });
    expect(present.host.popup.state).toBe("ok");
    expect(present.host.sound.state).toBe("ok");

    // 随包脚本缺失 = 打包缺陷：报 ok 会让窗口期里的用户按「宿主没问题」去查，方向完全反了
    const absent = await probeWith({ platform: "win32", present: [WIN_TONE] });
    expect(absent.host.popup.state).toBe("unreachable");
  });

  it("实测产出必须落在「平台 × 维度」允许集内（越界的那一条是永远绿的假契约）", async () => {
    const cells: ReadonlyArray<readonly [string, PortConfig]> = [
      [
        "linux",
        {
          platform: "linux",
          available: ["notify-send", "pw-play"],
          present: [LINUX_TONE],
          nameProbe: { kind: "owner" },
        },
      ],
      ["linux", { platform: "linux", nameProbe: { kind: "no-session-bus" } }],
      ["darwin", { platform: "darwin", present: [DARWIN_TONE] }],
      ["win32", { platform: "win32", present: [WIN_TONE] }],
      [
        "freebsd",
        { platform: "freebsd", available: ["notify-send"], nameProbe: { kind: "owner" } },
      ],
    ];
    for (const [platform, config] of cells) {
      const { host } = await probeWith(config);
      expect(checkedWithin(platform, "popup", host.popup.checked), platform).toBe(true);
      expect(checkedWithin(platform, "sound", host.sound.checked), platform).toBe(true);
    }
  });

  // 只判「落在允许集内」是恒真的：实现里那层过滤一旦删掉，问过的集合照样等于允许集。故逐格钉死
  // 精确取值——darwin/win32 的允许集为空，过滤一删这两格立刻多出 POSIX 的词。
  it("逐格钉死 checked 的精确取值（去过滤层必须判红）", async () => {
    const owner = await probeWith({
      platform: "linux",
      available: ["notify-send", "pw-play"],
      present: [LINUX_TONE],
      nameProbe: { kind: "owner" },
    });
    expect(owner.host.popup.checked).toEqual(["notify-send", "dbus-name-owner", "session-bus"]);
    expect(owner.host.sound.checked).toEqual(["players", "tone-file"]);

    // 无会话总线：只问过总线这一件事；声音那半边播放器仍然探过（平台探测与总线无关）
    const noBus = await probeWith({ platform: "linux", nameProbe: { kind: "no-session-bus" } });
    expect(noBus.host.popup.checked).toEqual(["session-bus"]);
    expect(noBus.host.sound.checked).toEqual(["players", "tone-file"]);

    const darwin = await probeWith({ platform: "darwin", present: [DARWIN_TONE] });
    expect(darwin.host.popup.checked).toEqual([]);
    expect(darwin.host.sound.checked).toEqual(["tone-file"]);

    const win32 = await probeWith({
      platform: "win32",
      present: [WIN_TONE, toastScriptPath()],
    });
    expect(win32.host.popup.checked).toEqual([]);
    expect(win32.host.sound.checked).toEqual(["tone-file"]);
  });

  // `probePlatform` 只在 linux 上探播放器，别的 POSIX 平台 players 恒空——那是「没查」不是「没有」。
  // 报 unreachable 等于拿一次没做过的探测当结论；规格又明写 unknown 不得降级为 ok。
  it("认不出的平台（freebsd）：声音记 unknown（没探过），不得猜成 unreachable", async () => {
    const { host } = await probeWith({
      platform: "freebsd",
      available: ["notify-send"],
      nameProbe: { kind: "owner" },
    });
    expect(host.popup.state).toBe("ok");
    expect(host.sound.state).toBe("unknown");
    expect(host.sound.checked).toEqual([]);
    expect(host.unknownDimensions).toEqual(["sound"]);
    expect(host.verdict).toBe("unknown");
  });

  // 闭集之外的取值由类型系统在编译期拒绝（本文件根本写不出 `toast-script` —— 那比运行时判红更强），
  // 故这里判的是「合法取值放错格子」：跨维度与跨平台两种错法都必须判红。
  it("合法性子集本身判红：合法取值放错维度或放错平台都不行", () => {
    expect(checkedWithin("linux", "popup", ["notify-send"])).toBe(true);
    // 跨维度：`players` 是 sound 的词，出现在 popup 里必须红
    expect(checkedWithin("linux", "popup", ["players"])).toBe(false);
    // 跨平台：win32 的这两格为空，任何词都不合法
    expect(checkedWithin("darwin", "popup", ["notify-send"])).toBe(false);
    expect(checkedWithin("win32", "sound", ["players"])).toBe(false);
    // 认不出的平台退到 POSIX 一档：弹窗有话可说，声音一个字都不许说
    expect(checkedWithin("freebsd", "popup", ["notify-send"])).toBe(true);
    expect(checkedWithin("freebsd", "sound", ["tone-file"])).toBe(false);
    expect(ALLOWED_CHECKED["darwin"]!.popup).toEqual([]);
  });
});

/**
 * linux 的三态判据（#783 批 3 增量 2）：能力面必须区分「有播放器」与「播放器能出声」。只命中
 * paplay/pw-play 时它们在无声音服务的宿主上必失败，而「有没有声音服务」探测不到（本机 /run/user/1000/pulse
 * 存在但为空也会骗过任何存在性探针）——报 ok 就是把测不准的事写成事实。三条用例分别钉住三态，任一条
 * 退回旧语义都会红。
 */
describe("linux sound 三态：非服务型播放器才算 ok", () => {
  it("命中非服务型（ffplay）⇒ ok；音色文件缺失也不影响结论（主题缺失由合成兜底）", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send", "ffplay"],
      nameProbe: { kind: "owner" },
    });
    expect(host.sound.state).toBe("ok");
    expect(host.sound.players).toEqual(["ffplay"]);
    // 音色文件仍然被问过（保留为报告项），只是不再参与结论
    expect(host.sound.checked).toEqual(["players", "tone-file"]);
    expect(host.sound.toneFileAvailable).toBe(false);
    expect(host.remediation.map((item) => item.code)).not.toContain("host-no-tone-file");
  });

  it("非服务型与服务型混合 ⇒ ok（有一个能直连出声就够）", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send", "paplay", "aplay"],
      nameProbe: { kind: "owner" },
    });
    expect(host.sound.players).toEqual(["paplay", "aplay"]);
    expect(host.sound.state).toBe("ok");
  });

  it("只命中服务型（pw-play）⇒ degraded + 新 code（不得报 ok）", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send", "pw-play"],
      present: [LINUX_TONE],
      nameProbe: { kind: "owner" },
      osRelease: { ok: true, id: "ubuntu" },
    });
    expect(host.sound.state).toBe("degraded");
    expect(host.remediation).toContainEqual({
      code: "host-only-sound-server-players",
      params: { packagemanager: "apt", packages: ["alsa-utils", "ffmpeg"] },
    });
    // 音色文件在位也救不了：服务型播放器照样要声音服务
    expect(host.sound.toneFileAvailable).toBe(true);
    expect(host.remediation.map((item) => item.code)).not.toContain("host-no-tone-file");
  });

  it("一个都没命中 ⇒ unreachable（优先于音色文件在位）", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send"],
      present: [LINUX_TONE],
      nameProbe: { kind: "owner" },
    });
    expect(host.sound.state).toBe("unreachable");
  });

  // 谓词是 ok 的唯一凭据：只有表里明确登记 needsServer === false 的 bin 才算「不依赖声音服务」。
  // 表外的名字（含 darwin 的 afplay）没有这条事实，算进 ok 就是拿没验过的东西报可用。
  it("谓词只认表里登记过的非服务型播放器：表外的名字不制造 ok", () => {
    expect(isServerlessPlayer("aplay")).toBe(true);
    expect(isServerlessPlayer("ffplay")).toBe(true);
    expect(isServerlessPlayer("paplay")).toBe(false);
    expect(isServerlessPlayer("pw-play")).toBe(false);
    expect(isServerlessPlayer("afplay")).toBe(false);
    expect(isServerlessPlayer("mystery-player")).toBe(false);
  });
});

describe("popup 五态与优先级", () => {
  const linuxWith = (nameProbe: NotificationNameProbe) => ({
    platform: "linux",
    available: ["notify-send"],
    nameProbe,
  });

  it("owner ⇒ ok；activatable ⇒ unknown（不是 ok）", async () => {
    const owner = await probeWith(linuxWith({ kind: "owner" }));
    expect(owner.host.popup.state).toBe("ok");

    // 有服务文件、总线愿意拉起，不等于拉起来能用：无显示的机器上守护进程照样起不来
    const activatable = await probeWith(linuxWith({ kind: "activatable" }));
    expect(activatable.host.popup.state).toBe("unknown");
    expect(activatable.host.popup.checked).toContain("dbus-activatable");
  });

  it("absent ⇒ unreachable；no-session-bus ⇒ unreachable；probe-failed ⇒ unknown（不得升格）", async () => {
    const absent = await probeWith(linuxWith({ kind: "absent" }));
    expect(absent.host.popup.state).toBe("unreachable");

    const noBus = await probeWith(linuxWith({ kind: "no-session-bus" }));
    expect(noBus.host.popup.state).toBe("unreachable");
    // 无会话总线时只问过这一件事：没发生的探测不许出现在 checked 里
    expect(noBus.host.popup.checked).toEqual(["session-bus"]);

    const failed = await probeWith({
      platform: "linux",
      available: ["notify-send"],
      nameProbe: { kind: "probe-failed", detail: "gdbus/dbus-send/busctl 均不可用" },
    });
    expect(failed.host.popup.state).toBe("unknown");
  });

  it("有 notify-send 但守护进程不可达与没有 notify-send 是两回事：前者给装包之外的出路", async () => {
    const noDaemon = await probeWith(linuxWith({ kind: "absent" }));
    expect(noDaemon.host.remediation.map((item) => item.code)).toContain("host-popup-no-daemon");

    const noNotifySend = await probeWith({
      platform: "linux",
      nameProbe: { kind: "absent" },
    });
    expect(noNotifySend.host.remediation.map((item) => item.code)).not.toContain(
      "host-popup-no-daemon",
    );
    // 同理，「没有 notify-send」也不能零出路：它不是「装个守护进程」，但它有自己的该装之物。
    // 只判「不产出前一条」是缺口的来源——一条建议被正确排除不等于这一格有出路。
    expect(noNotifySend.host.remediation.map((item) => item.code)).toContain("host-no-notify-send");
  });

  // 平台护栏的判据：win32 的 popup 不可达只可能来自随包 toast 脚本缺失，与 notify-send 无关
  // （darwin/win32 从不探这个命令）。少了护栏，这条建议会被发给一台根本不使用 notify-send 的机器。
  it("win32 且 toast 脚本缺失 ⇒ popup unreachable，但不得建议安装 notify-send", async () => {
    const { host } = await probeWith({ platform: "win32", present: [WIN_TONE] });
    expect(host.popup.state).toBe("unreachable");
    expect(host.remediation.map((item) => item.code)).not.toContain("host-no-notify-send");
  });

  // 组级聚合最危险的错法不是「取错了最严重者」，而是把 unknown 当成 ok：那一格里弹窗其实无法判定，
  // 报 ok 会让用户以为通知能用。这条与下面那条方向相反，两条一起才把 SEVERITY 表钉住。
  it("popup 未知 + sound 正常 ⇒ 组级必须是 unknown，不得降级成 ok", async () => {
    const { host } = await probeWith({
      platform: "linux",
      // 非服务型播放器才让 sound 真的落在 ok 上：这一条判的是「unknown 不被吞成 ok」，
      // 半边必须是 ok 才有意义（服务型那条另有用例判 degraded）。
      available: ["notify-send", "ffplay"],
      present: [LINUX_TONE],
      nameProbe: { kind: "activatable" },
    });
    expect(host.popup.state).toBe("unknown");
    expect(host.sound.state).toBe("ok");
    expect(host.verdict).toBe("unknown");
    expect(host.unknownDimensions).toEqual(["popup"]);
  });

  // 规格 §4.2 定的序是 unreachable > unknown > degraded > ok：`unknown` 压在 `degraded` 之上。
  // 客户端有同序的对应判据，两端任一侧改序都会红（这一格曾经分叉过）。
  it("unknown 压在 degraded 之上：popup 未知 + sound 部分可用 ⇒ 组级 unknown", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send", "paplay"],
      nameProbe: { kind: "activatable" },
    });
    expect(host.popup.state).toBe("unknown");
    expect(host.sound.state).toBe("degraded");
    expect(host.verdict).toBe("unknown");
  });

  it("组级 verdict 取最严重者，且被吞掉的 unknown 维度必须出现在 unknownDimensions 里", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send"],
      nameProbe: { kind: "activatable" },
    });
    // popup=unknown + sound=unreachable ⇒ 组级 unreachable，但「弹窗那半边未知」不能被吞掉
    expect(host.popup.state).toBe("unknown");
    expect(host.sound.state).toBe("unreachable");
    expect(host.verdict).toBe("unreachable");
    expect(host.unknownDimensions).toEqual(["popup"]);
  });
});

describe("sound 维度", () => {
  it("无播放器 ⇒ unreachable 并给装包建议（alsa-utils 在前、ffmpeg 在后）", async () => {
    const noPlayer = await probeWith({
      platform: "linux",
      available: ["notify-send"],
      nameProbe: { kind: "owner" },
      osRelease: { ok: true, id: "ubuntu" },
    });
    expect(noPlayer.host.sound.state).toBe("unreachable");
    expect(noPlayer.host.remediation).toContainEqual({
      code: "host-no-sound-server-and-player",
      params: { packagemanager: "apt", packages: ["alsa-utils", "ffmpeg"] },
    });
  });

  // linux 的 degraded 现在只有「只命中服务型播放器」一个成因，故 host-no-tone-file 只剩 darwin/win32：
  // 这两条用例把两条路各自钉住，防止 linux 又回到「拿音色文件判 degraded」的旧语义。
  it("darwin 缺音色文件 ⇒ degraded + host-no-tone-file（linux 已不再走这条）", async () => {
    const noTone = await probeWith({ platform: "darwin" });
    expect(noTone.host.sound.state).toBe("degraded");
    expect(noTone.host.remediation.map((item) => item.code)).toContain("host-no-tone-file");
  });

  it("linux 只命中服务型且缺音色文件 ⇒ 装包建议而不是 host-no-tone-file", async () => {
    const serverOnly = await probeWith({
      platform: "linux",
      available: ["notify-send", "paplay"],
      nameProbe: { kind: "owner" },
      osRelease: { ok: true, id: "fedora" },
    });
    expect(serverOnly.host.sound.state).toBe("degraded");
    expect(serverOnly.host.remediation).toContainEqual({
      code: "host-only-sound-server-players",
      params: { packagemanager: "dnf", packages: ["alsa-utils", "ffmpeg"] },
    });
    expect(serverOnly.host.remediation.map((item) => item.code)).not.toContain("host-no-tone-file");
  });

  it("认不出包管理器族就不给包名：宁可少说一句，不给错的包名", async () => {
    const { host } = await probeWith({
      platform: "linux",
      osRelease: { ok: true, id: "gentoo" },
    });
    expect(host.remediation).toContainEqual({ code: "host-no-sound-server-and-player" });
    expect(JSON.stringify(host)).not.toContain("gentoo");
  });

  it("os-release 读不出来时同样不抛、也不给包名（端口的 never-throw 契约）", async () => {
    const missing = await probeWith({ platform: "linux", osRelease: { ok: false } });
    expect(missing.host.remediation).toContainEqual({
      code: "host-no-sound-server-and-player",
    });
  });

  it("弹窗与发声都不可达时额外给「换通道」出路（远程无头宿主上装包不是用户能做的事）", async () => {
    const { host } = await probeWith({
      platform: "linux",
      nameProbe: { kind: "no-session-bus" },
    });
    const codes = host.remediation.map((item) => item.code);
    expect(codes).toContain("host-no-dbus-session");
    expect(codes).toContain("host-managed-by-others");
  });
});

describe("响应体零原文", () => {
  it("注入敌意 ID 与畸形 os-release：响应里不出现任何宿主原文", async () => {
    const hostile = await probeWith({
      platform: "linux",
      osRelease: { ok: true, id: '"; rm -rf /' },
    });
    const text = JSON.stringify(hostile.host);
    expect(text).not.toContain("rm -rf");
    expect(text).not.toContain("ID=");
    expect(text).not.toContain("/etc/os-release");
  });

  it("播放器只出可执行文件名、音色只出布尔：绝对路径不进响应", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send", "pw-play"],
      present: [LINUX_TONE],
      nameProbe: { kind: "owner" },
    });
    const text = JSON.stringify(host);
    expect(text).not.toContain("/usr/share/sounds");
    expect(text).not.toContain(LINUX_TONE);
  });
});

describe("remediation code 闭集：客户端映射必须覆盖得了", () => {
  it("全部产出 code 都在闭集内（客户端 `satisfies Record<...>` 的同一份清单）", async () => {
    const closed: readonly RemediationCode[] = [
      "host-no-dbus-session",
      "host-popup-no-daemon",
      "host-no-notify-send",
      "host-no-sound-server-and-player",
      "host-only-sound-server-players",
      "host-no-player",
      "host-no-tone-file",
      "host-managed-by-others",
    ];
    const cells: readonly PortConfig[] = [
      { platform: "linux", nameProbe: { kind: "no-session-bus" } },
      { platform: "linux", available: ["notify-send"], nameProbe: { kind: "absent" } },
      // 缺 notify-send 那一格：闭集清单必须真的会被它命中，否则新 code 只在类型里存在
      { platform: "linux", nameProbe: { kind: "absent" } },
      { platform: "linux", available: ["notify-send", "paplay"], nameProbe: { kind: "owner" } },
      { platform: "linux", available: ["notify-send", "ffplay"], nameProbe: { kind: "owner" } },
      { platform: "darwin" },
      { platform: "win32" },
    ];
    const produced: string[] = [];
    for (const config of cells) {
      const { host } = await probeWith(config);
      for (const item of host.remediation) {
        expect(closed).toContain(item.code);
        produced.push(item.code);
      }
    }
    // 反空转下界：内层循环在「每一格都没产出 remediation」时一次都不执行，这条判据就成了空断言
    // （7 格全空也绿）。下界只保证「真的验过东西」，条数由数据表决定，不在这里钉。
    expect(produced.length).toBeGreaterThan(0);
  });

  it("params 只由数据表产生：packagemanager 落在闭集、packages 非空", async () => {
    const { host } = await probeWith({ platform: "linux", osRelease: { ok: true, id: "arch" } });
    const remedy = host.remediation.find((item) => item.code === "host-no-sound-server-and-player");
    expect(remedy?.params?.packagemanager).toBe("pacman");
    expect(remedy?.params?.packages).toEqual(["alsa-utils", "ffmpeg"]);
  });

  // 两条装包建议共用同一份清单：只命中服务型播放器那一格也要能给出装什么包（同一份 PLAYER_PACKAGES），
  // 否则客户端那条无包名文案就成了唯一可达的一条，带包名的反而永远不渲染。
  it("只命中服务型播放器那条建议也由数据表产生（同族同清单）", async () => {
    const { host } = await probeWith({
      platform: "linux",
      available: ["notify-send", "pw-play"],
      osRelease: { ok: true, id: "manjaro" },
    });
    const remedy = host.remediation.find((item) => item.code === "host-only-sound-server-players");
    expect(remedy?.params?.packagemanager).toBe("pacman");
    expect(remedy?.params?.packages).toEqual(["alsa-utils", "ffmpeg"]);
  });
});

/** 桩 CLI 的固定输出。 */
interface StubTool {
  readonly bin: string;
  readonly stdout: string;
  readonly code?: number;
}

/** 单引号包裹：内容里的引号按 POSIX 规则转义，否则 stdout 里的 `'` 会把脚本自己截断。 */
const shQuote = (text: string): string => `'${text.replace(/'/gu, "'\\''")}'`;

/**
 * 桩 CLI：记录「谁被调用 + 逐字 argv」，再回放固定 stdout。
 * 只用 shell 内建（`echo`、`printf`、POSIX 参数展开取命令名）：用例把 PATH 收窄成只有桩目录，任何外部命令
 * 都会找不到，那样失败原因就变成了「测试自己写坏了」。
 */
const stubScript = (log: string, stdout: string, code: number): string =>
  `#!/bin/sh\n{ echo call; printf 'bin\\t%s\\n' "\${0##*/}"; for arg in "$@"; do printf 'arg\\t%s\\n' "$arg"; done; } >> ${shQuote(log)}\nprintf '%s' ${shQuote(stdout)}\nexit ${code}\n`;

/**
 * 真端口 + PATH 桩：解析与「只读、不激活」这条副作用纪律只有真实现能判。
 * PATH 只留桩目录——留了系统路径就会探到本机真的 `gdbus`/`busctl`，「都不可用」那条立刻假绿。
 */
async function realProbe(config: {
  env: Record<string, string | undefined>;
  tools: readonly StubTool[];
}): Promise<{ calls: string[][]; result: NotificationNameProbe }> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-dbus-"));
  const log = join(dir, "calls.log");
  for (const tool of config.tools) {
    const path = join(dir, tool.bin);
    writeFileSync(path, stubScript(log, tool.stdout, tool.code ?? 0));
    chmodSync(path, 0o755);
  }
  const restore = withEnv({ ...config.env, PATH: dir });
  try {
    const result = await systemDepsOf().probeNotificationName();
    return { calls: readCalls(log), result };
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 真实端口：复位端口槽之后它就是生产默认值（`REAL_DEPS`）。 */
function systemDepsOf(): SystemDeps {
  releaseSystemDeps();
  return systemDeps();
}

/** 日志 → 逐次调用：`calls[i][0]` 是命令名，其余是逐字 argv。 */
function readCalls(log: string): string[][] {
  let text: string;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  const calls: string[][] = [];
  for (const line of text.split("\n")) {
    if (line === "call") calls.push([]);
    else if (line.startsWith("bin\t")) calls[calls.length - 1]!.push(line.slice(4));
    else if (line.startsWith("arg\t")) calls[calls.length - 1]!.push(line.slice(4));
  }
  return calls;
}

/** 桩产生的全部 argv（含命令名与子命令），供「不许触发服务激活」这类整体断言用。 */
const flatArgs = (calls: readonly string[][]): string[] => calls.flat();

const BUS = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" };

/**
 * 副作用纪律的公共判据：**三种 CLI 的每一条路径**都不得出现会触发服务激活的 argv。
 * 只在 gdbus 那条用例里断言是不够的——往 dbus-send/busctl 的骨架里塞 `list`/`status`，被测面上零红。
 */
function expectNoActivation(calls: readonly string[][]): void {
  const forbidden = flatArgs(calls).filter(
    (arg) => /^(status|list|--activate)$/u.test(arg) || arg.includes("StartServiceByName"),
  );
  expect(forbidden).toEqual([]);
}

describe("真端口：D-Bus 查询的解析与副作用纪律", () => {
  it("无会话总线时一次子进程都不起（起了必然失败，白等一次超时）", async () => {
    const { calls, result } = await realProbe({
      env: { DBUS_SESSION_BUS_ADDRESS: "" },
      tools: [
        { bin: "gdbus", stdout: "(true,)" },
        { bin: "dbus-send", stdout: "boolean true" },
        { bin: "busctl", stdout: "b true" },
      ],
    });
    expect(result.kind).toBe("no-session-bus");
    expect(calls).toEqual([]);
  });

  it("gdbus 命中 owner：只问 NameHasOwner，argv 里没有任何会触发服务激活的路径", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [{ bin: "gdbus", stdout: "(true,)" }],
    });
    expect(result.kind).toBe("owner");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("gdbus");
    expect(calls[0]!.some((arg) => arg.includes("NameHasOwner"))).toBe(true);
    expectNoActivation(calls);
  });

  it("gdbus 说没有 owner 时再问可激活清单，命中即 activatable（两种问法都要发出去）", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [
        {
          bin: "gdbus",
          stdout: "(['org.freedesktop.Notifications', 'org.freedesktop.systemd1'],)\n",
        },
      ],
    });
    expect(result.kind).toBe("activatable");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.some((arg) => arg.includes("ListActivatableNames"))).toBe(true);
    expectNoActivation(calls);
  });

  it("可激活清单里没有目标名 ⇒ absent", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [{ bin: "gdbus", stdout: "(['org.freedesktop.systemd1'],)\n" }],
    });
    expect(result.kind).toBe("absent");
    expectNoActivation(calls);
  });

  it("gdbus 问不出来时退到 dbus-send（`boolean true` 形态）", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [
        { bin: "gdbus", stdout: "", code: 1 },
        { bin: "dbus-send", stdout: "method return\n   boolean true\n" },
      ],
    });
    expect(result.kind).toBe("owner");
    expect(calls[0]![0]).toBe("gdbus");
    expect(calls[1]![0]).toBe("dbus-send");
    expectNoActivation(calls);
  });

  it("dbus-send 说没有 owner 时，它自己的可激活清单那条命令也受同一条纪律约束", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [
        { bin: "gdbus", stdout: "", code: 127 },
        {
          bin: "dbus-send",
          stdout:
            'method return\n   boolean false\n   array [\n      string "org.freedesktop.portal.Desktop"\n   ]\n',
        },
      ],
    });
    expect(result.kind).toBe("absent");
    // 第二条命令才是可激活清单：不走这一格，往 dbus-send 骨架里塞 `list` 就没有判据能红
    expect(calls.some((call) => call.some((arg) => arg.includes("ListActivatableNames")))).toBe(
      true,
    );
    expectNoActivation(calls);
  });

  it("busctl 形态（`b false` + `as` 列表）能判出 absent", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [
        { bin: "gdbus", stdout: "", code: 127 },
        { bin: "dbus-send", stdout: "", code: 127 },
        { bin: "busctl", stdout: 'b false\nas 1 "org.freedesktop.portal.Desktop"\n' },
      ],
    });
    expect(result.kind).toBe("absent");
    expect(calls[calls.length - 1]![0]).toBe("busctl");
    expectNoActivation(calls);
  });

  it("三种 CLI 都不可用时报 probe-failed（不许猜成 absent）", async () => {
    const missing = await realProbe({ env: BUS, tools: [] });
    expect(missing.result.kind).toBe("probe-failed");

    const failing = await realProbe({
      env: BUS,
      tools: [
        { bin: "gdbus", stdout: "", code: 1 },
        { bin: "dbus-send", stdout: "", code: 1 },
        { bin: "busctl", stdout: "", code: 1 },
      ],
    });
    expect(failing.result.kind).toBe("probe-failed");
    expectNoActivation(failing.calls);
    // detail 只提命令名，不回显宿主原文（它要进 HTTP 响应）
    expect(JSON.stringify(failing.result)).not.toContain("\n");
  });
});

describe("os-release 端口：never-throw 与「只取一行」都要有判据", () => {
  it("文件缺失 ⇒ {ok:false}；目录路径（readFileSync 抛 EISDIR）⇒ 同样兜住，不冒泡", () => {
    // 调用侧没有 try/catch：这里抛出去就是一次未捕获拒绝
    expect(readOsReleaseFile(join(tmpdir(), "dsh-notifier-不存在/os-release"))).toEqual({
      ok: false,
    });
    expect(readOsReleaseFile(tmpdir())).toEqual({ ok: false });
  });

  it("只取 ID 一行：其余行是宿主原文，一个字符都不外泄", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-osrelease-"));
    try {
      const file = join(dir, "os-release");
      writeFileSync(file, 'NAME="Secret Distro"\nID=ubuntu\nVERSION="24.04 LTS"\n');
      expect(readOsReleaseFile(file)).toEqual({ ok: true, id: "ubuntu" });
      expect(JSON.stringify(readOsReleaseFile(file))).not.toContain("Secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("没有 ID 行 ⇒ {ok:false}：认不出来就不给包管理器族，不猜一个发行版", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-osrelease-"));
    try {
      const file = join(dir, "os-release");
      writeFileSync(file, 'NAME="Whatever"\nID_LIKE=debian\n');
      expect(readOsReleaseFile(file)).toEqual({ ok: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
