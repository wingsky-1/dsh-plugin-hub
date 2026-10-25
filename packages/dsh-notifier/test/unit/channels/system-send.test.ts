/**
 * dsh-notifier channels system send — popup/self-play orchestration and sound warnings.
 *
 * These suites share one delivery result: whether a popup command runs, whether sound is
 * self-played, and which non-fatal sound warning survives a successful popup. The original
 * describe titles and file-level cleanup remain unchanged.
 */
import { describe, expect, it } from "vitest";

import {
  LINUX_DING_FILE,
  MESSAGE,
  TOAST_SCRIPT,
  SystemDelivery,
  fakeDeps,
  installSystemDeps,
  installSystemTestCleanup,
  payloadOf,
  probeOf,
  soundPathOf,
} from "./system-test-support.ts";
import { buildSoundCommands } from "../../../src/server/channels/impl/system/index.ts";
import { pollUntil } from "../../helpers.ts";

installSystemTestCleanup();

function registerLinuxSendCases(): void {
  // 顺序反了会先响后弹；自播的静音标志漏了则响两声。
  it("linux 弹窗 + 自播：先弹（恒静音）再响，两条命令都真的执行", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
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

  // 音色文件在、播放器一个都没有（探测全落空）：命令构造不出来就是空动作，而不是 spawn 一个
  // 空 argv，也不该报 failed（没有失败证据）。
  it("只响不弹且没有任何播放器：收成 skipped(environment)，不起空命令", async () => {
    const fake = fakeDeps({
      available: ["notify-send"],
      present: [LINUX_DING_FILE],
    });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSkipEnvironment" },
    });
    expect(fake.spawned).toEqual([]);
    expect(delivery.warns).toHaveLength(1);
  });
}

function registerDarwinAndEmptyCases(): void {
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

  // darwin 的弹窗自带声音，只响不弹时才轮到 afplay；这条命令错了就是彻底无声。
  it("darwin 只响不弹：afplay 自播，弹窗半边没有命令", async () => {
    const fake = fakeDeps({
      platform: "darwin",
      present: ["/System/Library/Sounds/Glass.aiff"],
    });
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
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
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
}

function registerWindowsPopupCases(): void {
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
    const command = fake.spawned[0]!.command;
    expect(command.slice(0, 6)).toEqual([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    expect(soundPathOf(command)).toBe(wav);
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
}

function registerWindowsSoundCases(): void {
  // PS 5.1 把 -Command 后的参数当脚本文本；解码 -EncodedCommand 并还原路径可守住「数据而非代码」。
  it.each([
    String.raw`C:\Windows\Media\Windows Ding.wav`,
    String.raw`C:\音频 文件\提示音.wav`,
    "C:\\音频\\O'Brien `tick` $env:PATH; exit 9.wav",
  ])("win32 自播：EncodedCommand 能无损还原安全传递的路径 %s", async (wav) => {
    const command = buildSoundCommands(probeOf({ platform: "win32" }), wav)[0]!.command;

    expect(command.slice(0, 6)).toEqual([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    expect(command).not.toContain(wav);
    const script = Buffer.from(command[6]!, "base64").toString("utf16le");
    expect(soundPathOf(command)).toBe(wav);
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("exit 1");
    expect(script).not.toContain(wav);
  });

  it("win32 只响不弹：PowerShell 播放失败收为 failed 且记录实际失败", async () => {
    const wav = String.raw`C:\Windows\Media\Windows Ding.wav`;
    const fake = fakeDeps({ platform: "win32", present: [wav] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length === 1, "win32 自播应启动 PowerShell");
    fake.children[0]!.emitStderr("audio device unavailable");
    fake.children[0]!.emitExit({ exited: true, code: 1 });

    expect(await pending).toEqual({
      status: "failed",
      stage: "delivered",
      reason: {
        code: "reasonSystemSoundFailed",
        params: { bin: "powershell" },
        detail: "powershell 退出码 1：audio device unavailable",
      },
      retryable: false,
    });
    expect(delivery.warns).toEqual([
      "dsh-notifier: 提示音播放失败：powershell 退出码 1：audio device unavailable",
    ]);
  });

  it("win32 弹窗成功但自播失败：保留 ok 并明确记录提示音失败", async () => {
    const wav = String.raw`C:\Windows\Media\Windows Ding.wav`;
    const fake = fakeDeps({ platform: "win32", present: [wav, TOAST_SCRIPT] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length === 1, "toast 应先启动");
    fake.children[0]!.emitExit({ exited: true, code: 0 });
    await pollUntil(() => fake.children.length === 2, "toast 成功后应启动自播");
    fake.children[1]!.emitStderr("audio device unavailable");
    fake.children[1]!.emitExit({ exited: true, code: 1 });

    expect(await pending).toEqual({
      status: "ok",
      stage: "delivered",
      soundWarning: {
        code: "reasonSystemSoundFailed",
        params: { bin: "powershell" },
        detail: "powershell 退出码 1：audio device unavailable",
      },
    });
    expect(delivery.warns).toEqual([
      "dsh-notifier: 提示音播放失败：powershell 退出码 1：audio device unavailable",
    ]);
  });
}

function registerDisplayLimitCase(): void {
  // 截断上限是出口之间的展示约定：漏截就是给命令行塞一条超长文本，截错档位会砍掉有效信息。
  it("弹窗文本按展示上限截断（标题 64、正文 256）后才进命令", async () => {
    const fake = fakeDeps({ available: ["notify-send"] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: false });

    expect(
      await delivery.send({
        ...MESSAGE,
        title: "标".repeat(70),
        body: "正".repeat(300),
      }),
    ).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.spawned.map((record) => record.command)).toEqual([
      ["notify-send", "-h", "boolean:suppress-sound:true", "标".repeat(64), "正".repeat(256)],
    ]);
  });
}

describe("sendSystem：弹窗与自播的编排", () => {
  registerLinuxSendCases();
  registerDarwinAndEmptyCases();
  registerWindowsPopupCases();
  registerWindowsSoundCases();
  registerDisplayLimitCase();
});

function registerNoWarningCases(): void {
  // 回退链中途失败但最终成功：没有声音事实可警告，ok 上不得带 soundWarning。
  it("链中途失败最终成功 ⇒ ok 无 soundWarning（warn 也不多一条）", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play", "ffplay"],
      present: [],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: true });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length === 1, "弹窗应先启动");
    fake.children[0]!.emitExit({ exited: true, code: 0 });
    await pollUntil(() => fake.children.length === 2, "自播首候选应启动");
    // 首候选失败（退出码非 0），链继续到次候选成功
    fake.children[1]!.emitExit({ exited: true, code: 3 });
    await pollUntil(() => fake.children.length === 3, "回退链应试次候选");
    fake.children[2]!.emitExit({ exited: true, code: 0 });

    const result = await pending;
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect("soundWarning" in result).toBe(false);
  });

  // 声音关闭：没有要求自播，无警告。
  it("声音关闭（sound:false）⇒ ok 无 soundWarning", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: false });

    const result = await delivery.send();
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect("soundWarning" in result).toBe(false);
    expect(delivery.warns).toEqual([]);
  });

  // toast 负责默认音（darwin 弹窗 + sound:true 不自播）：无警告。
  it("toast 负责默认音（darwin 弹窗 + 跟随系统）⇒ ok 无 soundWarning", async () => {
    const fake = fakeDeps({ platform: "darwin", present: [] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: true });

    const result = await delivery.send();
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect("soundWarning" in result).toBe(false);
  });
}

function registerWarningCases(): void {
  // 自播需要但无可执行声音（无播放器）：ok + skipEnvironment 警告。
  it("自播需要但一个播放器都没有 ⇒ ok + soundWarning(skipEnvironment)", async () => {
    const fake = fakeDeps({
      available: ["notify-send"],
      present: [LINUX_DING_FILE],
    });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: "ding" });

    expect(await delivery.send()).toEqual({
      status: "ok",
      stage: "delivered",
      soundWarning: { code: "reasonSkipEnvironment" },
    });
  });

  // 有界 detail：明确超长的 stderr 按码点精确截到 300（上限改小即红），且代理对不断半。
  it("链全失败的警告 detail 精确截到 300 码点（emoji 边界不断半）", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: true, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length === 1, "弹窗应先启动");
    fake.children[0]!.emitExit({ exited: true, code: 0 });
    await pollUntil(() => fake.children.length === 2, "自播应启动");
    // 明确超长（约 490 码点）：emoji 落在截断保留区内，断言 Pin 住精确长度与完整性。
    fake.children[1]!.emitStderr(`${"x".repeat(290)}🔔${"y".repeat(200)}`);
    fake.children[1]!.emitExit({ exited: true, code: 3 });

    const result = await pending;
    expect(result.status).toBe("ok");
    const warning = result.status === "ok" ? result.soundWarning : undefined;
    expect(warning?.code).toBe("reasonSystemSoundFailed");
    const detail = warning?.detail ?? "";
    // 输入明确超长：stderr 约 490 码点经尾部截断剩 299 码点（emoji 距尾 200 码点内，必保留），
    // 再加 14 码点前缀成 313 码点，上限 300 时此处精确 300，改成更小的值即红。
    // （x 取 270 与 290 结果一致：尾部截断从末尾取，emoji 保留只与距尾距离有关。）
    expect(Array.from(detail).length).toBe(300);
    expect(detail.startsWith("pw-play 退出码 3：")).toBe(true);
    expect(detail).toContain("🔔");
    // 按 UTF-16 切会把 emoji 代理对腰斩：末尾不得是孤立代理项
    expect(/[\uD800-\uDFFF]$/u.test(detail)).toBe(false);
    expect(() => encodeURIComponent(detail)).not.toThrow();
  });
}

describe("soundWarning：弹窗成功但提示音未出（总体仍 ok）", () => {
  registerNoWarningCases();
  registerWarningCases();
});
