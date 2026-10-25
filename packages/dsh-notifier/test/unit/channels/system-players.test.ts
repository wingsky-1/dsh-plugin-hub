/**
 * dsh-notifier channels system players — failure predicates and the self-play fallback chain.
 *
 * The predicate suite classifies command outcomes; the fallback suite proves how those outcomes
 * advance or stop the player chain. Both retain their original describe titles and assertions.
 */
import { describe, expect, it } from "vitest";

import type {
  CommandFacts,
  CommandOutcome,
} from "../../../src/server/channels/impl/system/type.ts";
import {
  playerSpec,
  playFailure,
  playFailureSummary,
} from "../../../src/server/channels/impl/system/players.ts";
import type { PlayerSpec } from "../../../src/server/channels/impl/system/players.ts";
import { pollUntil } from "../../helpers.ts";
import {
  ALSA_UNDERRUN,
  CHAIN_BINS,
  LINUX_DING_FILE,
  SystemDelivery,
  fakeDeps,
  installSystemDeps,
  installSystemTestCleanup,
} from "./system-test-support.ts";

installSystemTestCleanup();

function registerFailurePredicateCases(): void {
  /** 表里唯一有实测样本的那一行：标记表、播放参数都挂在它身上。 */
  const FFPLAY = playerSpec("ffplay")!;
  /** 实测样本：ffplay 报「打不开」的那种文本（输入文件不存在 / 是目录 / 是随机字节）。 */
  const OPEN_FAILED = "Failed to open file /tmp/x.wav or configure filtergraph\n";
  const facts = (outcome: CommandOutcome, stderr = ""): CommandFacts => ({
    outcome,
    stderr,
  });

  // 判据是五条具名规则的合取，不是「stderr 必须为空」：后者会被成功路径上的 ALSA 噪声打穿。
  it("五种失败成因各判一次：命中标记 / 退出码非 0 / 被信号杀死 / 超时兜底 / 启动失败", () => {
    expect(playFailure(FFPLAY, facts({ kind: "exit", code: 0 }, OPEN_FAILED))).toEqual({
      kind: "marker",
      marker: "Failed to open file",
    });
    expect(playFailure(FFPLAY, facts({ kind: "exit", code: 3 }, "随便什么诊断"))).toEqual({
      kind: "exit",
      code: 3,
    });
    expect(playFailure(FFPLAY, facts({ kind: "killed" }))).toEqual({
      kind: "killed",
    });
    expect(playFailure(FFPLAY, facts({ kind: "timeout" }))).toEqual({
      kind: "timeout",
    });
    expect(playFailure(FFPLAY, facts({ kind: "spawn-error", cause: "ENOENT" }))).toEqual({
      kind: "spawn-error",
      cause: "ENOENT",
    });
    expect(playFailure(FFPLAY, facts({ kind: "spawn-threw", cause: "argv 非法" }))).toEqual({
      kind: "spawn-threw",
      cause: "argv 非法",
    });
  });

  // B5：标记表被清空后判定不变 —— 成功样本仍成功、退出码失败仍失败。这条钉死「标记表不是
  // 『有输出即失败』的伪装」：把判据写成「stderr 非空即失败」的实现，在第一条断言上就红。
  it("清空标记表：成功样本仍成功、退出码非 0 仍失败（判据不是「有输出即失败」）", () => {
    const noMarkers: PlayerSpec = { ...FFPLAY, fatalMarkers: [] };
    expect(playFailure(noMarkers, facts({ kind: "exit", code: 0 }, ALSA_UNDERRUN))).toBeUndefined();
    expect(playFailure(noMarkers, facts({ kind: "exit", code: 0 }, OPEN_FAILED))).toBeUndefined();
    expect(playFailure(noMarkers, facts({ kind: "exit", code: 3 }, ""))).toEqual({
      kind: "exit",
      code: 3,
    });
  });

  // B0-d 的谓词侧：exit 0 + 实测噪声 ⇒ 成功。40 次成功播放里 3 次 stderr 是这个 underrun，
  // 「零输出」判据会把它们全判成失败（链继续 ⇒ 双响，或终态 failed 而声音已经出去了）。
  it("exit 0 且 stderr 是登记为噪声的 ALSA underrun ⇒ 成功", () => {
    expect(playFailure(FFPLAY, facts({ kind: "exit", code: 0 }, ALSA_UNDERRUN))).toBeUndefined();
  });

  // 标记表是**唯一**能把这一格判死的实体：exit 0 本身是成功的（方案 §3.2 的致命标记判据）。
  it("exit 0 却命中致命标记 ⇒ 失败，且带上命中哪一条（可诊断）", () => {
    const failure = playFailure(FFPLAY, facts({ kind: "exit", code: 0 }, OPEN_FAILED));
    expect(failure).toEqual({ kind: "marker", marker: "Failed to open file" });
    expect(playFailureSummary("ffplay", failure!, "Failed to open file")).toContain(
      "命中致命标记「Failed to open file」",
    );
  });

  // 未实测的失败文本不在表里（表只收实测样本）：残余是 fail-open，登记在方案 §3.2 与 §11。
  it("不在表里的失败文本不参与判定（残余 fail-open，登记在方案 §3.2）", () => {
    expect(
      playFailure(
        FFPLAY,
        facts({ kind: "exit", code: 0 }, "Connection failure: Connection refused"),
      ),
    ).toBeUndefined();
  });

  // F4 边界：判据只归**音频路径的表行**。darwin 的 afplay 与 win32 的 PowerShell 没有表行，
  // 只看退出码 —— 把 ffplay 上量到的文本规则套过去会把它们的正常输出判成失败。
  it("没有表行的命令只判退出码（标记表不推广给 afplay / PowerShell）", () => {
    expect(playFailure(undefined, facts({ kind: "exit", code: 0 }, OPEN_FAILED))).toBeUndefined();
    expect(
      playFailure(undefined, facts({ kind: "exit", code: 0 }, "Is a directory")),
    ).toBeUndefined();
    expect(playFailure(undefined, facts({ kind: "exit", code: 1 }, ""))).toEqual({
      kind: "exit",
      code: 1,
    });
  });
}

describe("players.ts：音频路径的判据谓词（具名、可单测）", () => {
  registerFailurePredicateCases();
});

const CHILD_STATES: Array<{
  readonly name: string;
  readonly failed: boolean;
  readonly spawnFailure?: string;
  readonly drive?: (child: import("./system-test-support.ts").FakeChild) => void;
}> = [
  {
    name: "退出码 0",
    failed: false,
    drive: (child) => child.emitExit({ exited: true, code: 0 }),
  },
  {
    name: "退出码非 0",
    failed: true,
    drive: (child) => child.emitExit({ exited: true, code: 3 }),
  },
  {
    name: "被信号杀死",
    failed: true,
    drive: (child) => child.emitExit({ exited: false }),
  },
  {
    name: "error 事件（二进制缺失）",
    failed: true,
    drive: (child) => child.emitError(new Error("spawn pw-play ENOENT")),
  },
  { name: "spawn 同步抛错", failed: true, spawnFailure: "argv 非法" },
];

function registerFallbackSelectionCases(): void {
  /** 候选 1 的真实身份（表序第一个）：`params.bin` 的期望值从表导出，不重抄播放器名。 */
  const FIRST_BIN = CHAIN_BINS[0]!;

  // C3：中间候选失败不刷日志（LoggerPort 只有 warn，按候选各刷一条会把日志淹掉）；首个成功即停。
  it("候选 1 退出码非 0、候选 2 成功 ⇒ ok，且整条链零 warn（中间回退不出声）", async () => {
    const fake = fakeDeps({
      available: ["notify-send", ...CHAIN_BINS],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length === 1, "候选 1 应已起进程");
    fake.children[0]!.emitExit({ exited: true, code: 1 });
    await pollUntil(() => fake.children.length === 2, "候选 2 应已起进程");
    fake.children[1]!.emitExit({ exited: true, code: 0 });

    expect(await pending).toEqual({ status: "ok", stage: "delivered" });
    expect(delivery.warns).toEqual([]);
    // 首个成功即停：候选 3 起一个进程都没起（防双响）
    expect(fake.spawned.map((record) => record.command[0])).toEqual(CHAIN_BINS.slice(0, 2));
  });

  // C1：致命标记是「退出码 0 但没出声」这一格的唯一判据。命中它的候选必须失败并让链继续，
  // 否则「播放器在 PATH 里但没出声」又被判成 ok（#782/#783 的病本身）。
  it("候选 1 命中致命标记（exit 0）失败、候选 2 成功 ⇒ ok，候选 3 起零 spawn", async () => {
    const fake = fakeDeps({
      available: ["notify-send", ...CHAIN_BINS],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length === 1, "候选 1 应已起进程");
    fake.children[0]!.emitStderr("Failed to open file /tmp/x.wav or configure filtergraph\n");
    fake.children[0]!.emitExit({ exited: true, code: 0 });
    await pollUntil(() => fake.children.length === 2, "候选 2 应已起进程");
    fake.children[1]!.emitExit({ exited: true, code: 0 });

    expect(await pending).toEqual({ status: "ok", stage: "delivered" });
    expect(delivery.warns).toEqual([]);
    expect(fake.spawned.map((record) => record.command[0])).toEqual(CHAIN_BINS.slice(0, 2));
  });

  // C2：全失败 ⇒ failed（不是 skipped：「执行过动作而它失败了」），bin = 表序第一个，
  // detail 带每个候选的成因（设置页折叠可查），日志里**恰好一条**。
  it("全部候选都失败 ⇒ failed + bin = 表序第一个 + detail 含每个候选的成因 + 恰好一条 warn", async () => {
    const fake = fakeDeps({
      available: ["notify-send", ...CHAIN_BINS],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    const codes = [1, 2, 3, 4];
    for (const [index, code] of codes.entries()) {
      await pollUntil(() => fake.children.length > index, `第 ${index + 1} 个候选应已起进程`);
      fake.children[index]!.emitExit({ exited: true, code });
    }

    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      stage: "delivered",
      retryable: false,
      reason: { code: "reasonSystemSoundFailed", params: { bin: FIRST_BIN } },
    });
    const detail = (result as { reason: { detail?: string } }).reason.detail ?? "";
    for (const code of codes) expect(detail).toContain(`退出码 ${code}`);
    expect(fake.spawned.map((record) => record.command[0])).toEqual(CHAIN_BINS);
    expect(delivery.warns).toHaveLength(1);
    expect(delivery.warns[0]).toContain("提示音播放失败：");
  });
}

function registerChildStateCases(): void {
  // B0-b：子进程的五种结局各判一条 —— 少一种，那一种就会被当成成功（旧实现只有「退出码 === 0」
  // 一条判据，另外四种连退出码都没有）。
  it.each(CHILD_STATES)("只响不弹：子进程结局「$name」⇒ 失败 = $failed", async (state) => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    if (state.spawnFailure !== undefined) fake.spawnFailure = state.spawnFailure;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    if (state.drive !== undefined) {
      await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
      state.drive(fake.children[0]!);
    }

    expect((await pending).status).toBe(state.failed ? "failed" : "ok");
  });

  // B0-d：「零输出」判据的杀手。它走完整条出口（不是直接调谓词）：实测 40 次成功播放里 3 次 stderr
  // 是这个 underrun，把它当失败证据的实现会把这次真成功判成失败，进而继续往链下试（双响）。
  it("exit 0 且 stderr 是实测噪声（ALSA underrun）⇒ ok、零 warn、只起一个播放进程", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitStderr(ALSA_UNDERRUN);
    fake.children[0]!.emitExit({ exited: true, code: 0 });

    expect(await pending).toEqual({ status: "ok", stage: "delivered" });
    expect(delivery.warns).toEqual([]);
    expect(fake.spawned).toHaveLength(1);
  });
}

function registerFfplayArgvCase(): void {
  // B4：argv 逐字快照。四个参数缺一不可（缺 -nodisp 实测 exit 0 却只报 Failed to create window
  // or renderer，根本不出声；缺 -autoexit 进程不退出，只能等 9 秒硬结算），而端到端结果断言
  // 发现不了这两件事——只有逐字快照能。
  it("ffplay 的 argv 逐字快照：四个必需参数 + 文件在最后", async () => {
    const fake = fakeDeps({
      available: ["ffplay"],
      present: [LINUX_DING_FILE],
    });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(fake.spawned.map((record) => record.command)).toEqual([
      ["ffplay", "-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", LINUX_DING_FILE],
    ]);
  });
}

describe("自播回退链：首个成功即停、全失败才翻转终态", () => {
  registerFallbackSelectionCases();
  registerChildStateCases();
  registerFfplayArgvCase();
});
