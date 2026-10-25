/**
 * dsh-notifier channels system temp — synthesized audio lifecycle and the real temporary port.
 *
 * Fake-port cases prove staging, command timing, deletion, concurrency, and platform boundaries.
 * Real-port cases prove permissions, directory reuse, symlink refusal, and release semantics.
 * Both original describe titles and their per-test resource ownership remain unchanged.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { releaseSoundTemps } from "../../../src/server/channels/interface.ts";
import { RealToneTemps } from "../../../src/server/channels/impl/system/deps.ts";
import { synthToneWav } from "../../../src/server/channels/impl/system/synth.ts";
import { toneFileCandidates } from "../../../src/server/channels/impl/system/tones.ts";
import { pollUntil } from "../../helpers.ts";
import {
  FAKE_TONE_DIR,
  LINUX_DING_FILE,
  TOAST_SCRIPT,
  SystemDelivery,
  fakeDeps,
  installSystemDeps,
  installSystemTestCleanup,
  releaseSystemDeps,
  systemDeps,
} from "./system-test-support.ts";

installSystemTestCleanup();

function registerSyntheticFallbackCases(): void {
  // E1：主题文件全缺 ⇒ 命令指向本次落的临时文件，且字节**逐字**等于 runtime 合成的那份
  // （指向一个别的文件、或落了一份空字节，听觉上都是「没声音」）。
  it("无主题文件 ⇒ argv 指向临时文件且字节等于 synthToneWav(tone)", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    const command = fake.spawned[0]!.command;
    const path = command[1]!;
    expect(dirname(path)).toBe(FAKE_TONE_DIR);
    expect(fake.stagedHistory.get(path)).toEqual(synthToneWav("ding"));
    // 通知脚本与主题候选都问过一遍（顺序与完整性由表决定），但主题候选一个都不存在
    expect(fake.checked).toEqual([TOAST_SCRIPT, ...toneFileCandidates("linux", "ding")]);
  });

  // E2：主题文件在 ⇒ 用主题文件、**不产生**临时文件（合成音只是兜底，不是替换品）。
  it("主题文件存在 ⇒ 不落临时文件，argv 直接指向主题文件", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.events.some((event) => event.startsWith("stage:"))).toBe(false);
    expect(fake.stagedFiles.size).toBe(0);
    expect(fake.spawned.map((record) => record.command)).toEqual([["pw-play", LINUX_DING_FILE]]);
  });
}

function registerDeletionCases(): void {
  // E3：无论成败最后都删 —— 失败路径漏删就是「每投递一次往 /tmp 攒一个 WAV」。
  it.each<[string, number]>([
    ["成功", 0],
    ["失败", 3],
  ])("合成音播完（%s）后临时文件一定被删（exit %i 也一样）", async (_label, code) => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"] });
    fake.exitCode = code;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    await delivery.send();
    expect(fake.stagedFiles.size).toBe(0);
    expect(fake.unstaged).toHaveLength(1);
  });

  // D3：unstage 必须晚于最后一次 run() 的 onExit。反过来（spawn 后立即 unlink）实测播放器报
  // 42B 的「打不开」；判据看时序，不看实现怎么写。
  it("删除晚于最后一次 onExit（stage → spawn → exit → unstage）", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"] });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.events.map((event) => event.split(":")[0])).toEqual([
      "stage",
      "spawn",
      "exit",
      "unstage",
    ]);
  });
}

function registerWriteFailureCase(): void {
  // D4：/tmp 只读挂载（注入 EROFS）。只响不弹时本次**没有可执行的动作** ⇒ skipped + 新 code +
  // 宿主原文进 detail；弹+响时弹窗已经出去，声音只算尽力而为 ⇒ ok + 一条 warn。
  it("临时目录写不进去：只响不弹 ⇒ skipped(reasonSystemToneUnwritable)+detail；弹+响 ⇒ ok + 一条 warn", async () => {
    const cause = "EROFS: read-only file system, open '/tmp/dsh-notifier-x/tone-1.wav'";

    const only = fakeDeps({ available: ["notify-send", "pw-play"] });
    only.stageFailure = cause;
    installSystemDeps(only);
    const soundOnly = new SystemDelivery({ popup: false, sound: "ding" });
    expect(await soundOnly.send()).toEqual({
      status: "skipped",
      reason: { code: "reasonSystemToneUnwritable", detail: cause },
    });
    expect(only.spawned).toEqual([]);
    expect(soundOnly.warns).toEqual([
      `dsh-notifier: 系统提示音临时文件写入失败，本次未发声：${cause}`,
    ]);

    const both = fakeDeps({ available: ["notify-send", "pw-play"] });
    both.stageFailure = cause;
    installSystemDeps(both);
    const withPopup = new SystemDelivery({ popup: true, sound: "ding" });
    expect(await withPopup.send()).toEqual({
      status: "ok",
      stage: "delivered",
      soundWarning: { code: "reasonSystemToneUnwritable", detail: cause },
    });
    expect(withPopup.warns).toEqual([
      `dsh-notifier: 系统提示音临时文件写入失败，本次未发声：${cause}`,
    ]);
    expect(both.spawned.map((record) => record.command[0])).toEqual(["notify-send"]);
  });
}

function registerConcurrencyCase(): void {
  // D7：并发两笔投递各落一份自己的文件。按次删目录的实现会在第一笔结束时把整目录收走，第二笔的
  // 文件随之消失（实测的失败形态是播放器报打不开），故判据同时看「另一笔的文件还在」与
  // 「释放面没被按次调用」。
  it("并发两笔投递：各自只删自己的文件，另一笔的文件与播放不受影响", async () => {
    const fake = fakeDeps({ available: ["notify-send", "pw-play"] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const first = new SystemDelivery({ popup: false, sound: "ding" });
    const second = new SystemDelivery({ popup: false, sound: "bell" });

    const firstSend = first.send();
    const secondSend = second.send();
    await pollUntil(() => fake.children.length === 2, "两笔投递各起一个播放进程");
    const paths = [...fake.stagedFiles.keys()];
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(fake.stagedHistory.get(paths[0]!)).toEqual(synthToneWav("ding"));
    expect(fake.stagedHistory.get(paths[1]!)).toEqual(synthToneWav("bell"));

    fake.children[0]!.emitExit({ exited: true, code: 0 });
    expect(await firstSend).toEqual({ status: "ok", stage: "delivered" });
    // 第一笔只删了自己的那一份：第二笔的文件还在（按次删目录的实现会在这里红）
    expect(fake.stagedFiles.has(paths[1]!)).toBe(true);
    expect(fake.unstaged).toEqual([paths[0]!]);

    fake.children[1]!.emitExit({ exited: true, code: 0 });
    expect(await secondSend).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.stagedFiles.size).toBe(0);
    expect(fake.toneDirReleased).toBe(false);
  });
}

function registerPlatformBoundaryCase(): void {
  // 素材合成只对 Linux 生效：darwin/win32 有系统素材与播放器，「合成兜底」不是它们的行为。
  it("darwin / win32 不合成：主题文件缺失时仍是空动作（不产生临时文件）", async () => {
    for (const platform of ["darwin", "win32"]) {
      const fake = fakeDeps({ platform, present: [] });
      installSystemDeps(fake);
      const delivery = new SystemDelivery({ popup: false, sound: "ding" });
      expect((await delivery.send()).status, platform).toBe("skipped");
      expect(fake.stagedFiles.size, platform).toBe(0);
      expect(fake.spawned, platform).toEqual([]);
    }
  });
}

describe("临时音频文件：合成兜底与生命周期", () => {
  registerSyntheticFallbackCases();
  registerDeletionCases();
  registerWriteFailureCase();
  registerConcurrencyCase();
  registerPlatformBoundaryCase();
});

function registerRealTempFileCases(): void {
  /** 本用例独占的基目录：真端口用它 mkdtemp，断言「基目录下一个残留都没有」才是确定的。 */
  let base = "";
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "dsh-notifier-case-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** 落一次盘并取出路径（失败即用例环境有问题，直接抛）。 */
  function stageOrThrow(temps: RealToneTemps, bytes: Buffer): string {
    const staged = temps.stage(bytes);
    if (!staged.ok) throw new Error(`落盘应当成功，实际：${staged.cause}`);
    return staged.path;
  }

  // D1：0600 文件 + 0700 目录；unstage 只 unlink 本次文件（**目录留着**），释放面才删目录。
  it("落盘 0600 文件 / 0700 目录；unstage 只删文件，释放面才删目录", () => {
    const temps = new RealToneTemps(base);
    const path = stageOrThrow(temps, Buffer.from("RIFF0000WAVE"));
    const dir = dirname(path);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path).toString()).toBe("RIFF0000WAVE");

    temps.unstage(path);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(true);

    temps.release();
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });

  // D2：目录复用（mkdtemp 只调一次 ⇒ 两次落盘的父目录相同、基目录下只有一个临时目录）；
  // 文件名带实例内序号，故正常路径永不撞名。
  it("两次落盘复用同一个目录，文件名带实例内序号", () => {
    const temps = new RealToneTemps(base);
    const first = stageOrThrow(temps, Buffer.from("一"));
    const second = stageOrThrow(temps, Buffer.from("二"));

    expect(dirname(first)).toBe(dirname(second));
    expect(first).not.toBe(second);
    expect(readdirSync(base)).toHaveLength(1);
    expect(readdirSync(dirname(first)).sort()).toEqual([basename(first), basename(second)].sort());
    temps.release();
  });

  // D5：`wx` 拒符号链接占位（实测预置符号链接时报 EEXIST 且目标文件未被改写）。序号让正常路径
  // 不会撞名，故这一条只能由占位构造出来——它是「不跟随符号链接」这条防御的判据。
  it("符号链接占位被 wx 拒绝：报原因（EEXIST）且目标文件未被改写", () => {
    const temps = new RealToneTemps(base);
    const first = stageOrThrow(temps, Buffer.from("先"));
    temps.unstage(first);
    const dir = dirname(first);

    const target = join(base, "target.txt");
    writeFileSync(target, "原样");
    symlinkSync(target, join(dir, "tone-2.wav"));

    const second = temps.stage(Buffer.from("后"));
    expect(second.ok).toBe(false);
    expect(second.ok ? "" : second.cause).toContain("EEXIST");
    expect(readFileSync(target, "utf8")).toBe("原样");
    temps.release();
  });

  // D6：释放面（域门面 channels/interface.ts）把真端口建的目录收走，且幂等、never-throw。
  it("释放面删掉真端口建的临时目录：幂等、never-throw、基目录无残留", () => {
    releaseSystemDeps();
    const staged = systemDeps().stageToneAudio(Buffer.from("RIFF"));
    if (!staged.ok) throw new Error(`真端口落盘失败：${staged.cause}`);
    const dir = dirname(staged.path);
    expect(existsSync(dir)).toBe(true);

    releaseSoundTemps();
    expect(existsSync(dir)).toBe(false);
    expect(() => releaseSoundTemps()).not.toThrow();
  });
}

describe("临时音频文件：真端口（权限位、目录复用、符号链接、释放面）", () => {
  registerRealTempFileCases();
});
