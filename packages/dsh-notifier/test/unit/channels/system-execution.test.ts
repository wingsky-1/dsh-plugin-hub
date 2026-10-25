/**
 * dsh-notifier channels system execution — process outcomes, timeout fallback, real defaults.
 *
 * These suites share the child-process lifecycle: spawn failures, exit/error races, the
 * SIGTERM-to-SIGKILL fallback, and the production default port. They are separate from command
 * construction and platform probing, while retaining the original describe titles and cleanup.
 */
import { describe, expect, it, vi } from "vitest";

import {
  LINUX_DING_FILE,
  TOAST_SCRIPT,
  SystemDelivery,
  exitOf,
  fakeDeps,
  installSystemDeps,
  installSystemTestCleanup,
  systemDeps,
} from "./system-test-support.ts";
import { pollUntil } from "../../helpers.ts";

installSystemTestCleanup();

function registerSpawnOutcomeCases(): void {
  // spawn 抛错时没人接住就是宿主进程崩。命令构造出来了就说明那个工具确实在，它的启动失败是
  // 真失败——旧实现把弹窗半边只记进日志，于是「推成功却没弹也没响」；bin 名进参数，设置页才指
  // 得出是哪条命令没跑成。
  it("spawn 同步抛错：弹窗命令失败判投递失败，只响不弹时同样判失败且带 bin 名", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    fake.spawnFailure = "argv 非法";
    installSystemDeps(fake);

    const pop = new SystemDelivery();
    expect(await pop.send()).toEqual({
      status: "failed",
      stage: "delivered",
      reason: {
        code: "reasonSystemPopupFailed",
        params: { bin: "notify-send" },
      },
      retryable: false,
    });
    expect(pop.warns).toEqual(["dsh-notifier: 命令启动失败（notify-send）: argv 非法"]);

    const soundOnly = new SystemDelivery({ popup: false, sound: "ding" });
    expect(await soundOnly.send()).toEqual({
      status: "failed",
      stage: "delivered",
      reason: {
        code: "reasonSystemSoundFailed",
        params: { bin: "pw-play" },
        detail: "pw-play 启动失败：argv 非法",
      },
      retryable: false,
    });
    // 声音这一侧走回退链：整条链都失败时留**一条** warn，成因摘要里带 bin
    expect(soundOnly.warns).toEqual(["dsh-notifier: 提示音播放失败：pw-play 启动失败：argv 非法"]);
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
      reason: {
        code: "reasonSystemPopupFailed",
        params: { bin: "notify-send" },
      },
      retryable: false,
    });
    expect(delivery.warns).toEqual(["dsh-notifier: 命令启动失败（notify-send）: argv 非法"]);
  });

  // 退出码 0 是唯一成功判据：把「起来了」当成功会让只响不弹在播放失败时也报 ok。
  it("退出码 0：投递成功，且不留任何日志", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    expect(await delivery.send()).toEqual({ status: "ok", stage: "delivered" });
    expect(delivery.warns).toEqual([]);
    expect(fake.spawned.map((record) => record.command)).toEqual([["pw-play", LINUX_DING_FILE]]);
  });
  registerSpawnOutputCases();
}

function registerSpawnOutputCases(): void {
  // stderr 尾部是 Windows PS 诊断的唯一载体；无上限收集会被一条长诊断撑爆，全量进日志会刷屏。
  it("退出码非 0：warn 带 stderr 尾部（收集封顶 512、进日志截到 300）", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
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
      reason: {
        code: "reasonSystemSoundFailed",
        params: { bin: "pw-play" },
        // 收集封顶 512 之后，进 reason.detail 与日志的都是截到 300 字的那一段
        detail: `pw-play 退出码 3：${"前".repeat(300)}`,
      },
      retryable: false,
    });
    // 600 字的尾部已越过收集上限，第二段不再进缓冲；进日志的是截到 300 字的那一段。
    expect(delivery.warns).toEqual([
      `dsh-notifier: 提示音播放失败：pw-play 退出码 3：${"前".repeat(300)}`,
    ]);
  });

  // 没有 stderr 时不该留一个空的冒号尾巴（读日志的人会以为诊断被吞了）。
  it("退出码非 0 但没有 stderr：warn 只报退出码", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitExit({ exited: true, code: 3 });

    expect((await pending).status).toBe("failed");
    expect(delivery.warns).toEqual(["dsh-notifier: 提示音播放失败：pw-play 退出码 3"]);
  });

  // 原生二进制缺失走的是 error 事件而不是退出码：不接住它宿主进程会直接被打挂。
  it("error 事件：判失败且成因摘要写「不可用」，不外抛", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitError(new Error("spawn pw-play ENOENT"));

    expect(await pending).toEqual({
      status: "failed",
      stage: "delivered",
      reason: {
        code: "reasonSystemSoundFailed",
        params: { bin: "pw-play" },
        detail: "pw-play 不可用：spawn pw-play ENOENT",
      },
      retryable: false,
    });
    expect(delivery.warns).toEqual([
      "dsh-notifier: 提示音播放失败：pw-play 不可用：spawn pw-play ENOENT",
    ]);
  });

  // 被杀多数是我们自己的超时兜底：那是主动行为，按异常刷屏会淹掉真正的失败。
  it("被信号杀死：不刷 warn，但「只响不弹」仍按失败收敛", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    await pollUntil(() => fake.children.length > 0, "假端口应起出子进程");
    fake.children[0]!.emitExit({ exited: false });

    expect((await pending).status).toBe("failed");
    expect(delivery.warns).toEqual([]);
  });
}

function registerChildOutcomeRaceCases(): void {
  // 两个出口都到达时先到的那个说了算：后到的若再结算一次，结论会被反转。
  it("exit 与 error 都到达：只结算先到的那个", async () => {
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
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
    expect(late.warns).toEqual(["dsh-notifier: 提示音播放失败：pw-play 不可用：先到的 error"]);
  });

  // 起进程一律接 stderr 管道（B0）：音频判据要读它（无头 Linux 上它是唯一的自证面），Windows 的
  // PS 诊断也只在它上面。旧实现只对 win32 接管道 ⇒ Linux 上 `child.stderr` 是 null，判据恒真。
  it("起进程一律接 stderr 管道（win32 与 linux 同一条口径）", async () => {
    const linux = fakeDeps({ available: ["notify-send"] });
    installSystemDeps(linux);
    expect(await new SystemDelivery().send()).toEqual({
      status: "ok",
      stage: "delivered",
    });
    expect(linux.spawned.map((record) => record.options)).toEqual([{ collectStderr: true }]);

    const win = fakeDeps({ platform: "win32", present: [TOAST_SCRIPT] });
    installSystemDeps(win);
    expect(await new SystemDelivery().send()).toEqual({
      status: "ok",
      stage: "delivered",
    });
    expect(win.spawned.map((record) => record.options)).toEqual([{ collectStderr: true }]);
  });
}

describe("命令执行：任何结局都收敛成投递结果", () => {
  registerSpawnOutcomeCases();
  registerChildOutcomeRaceCases();
  // The named registrations are flattened by the static v2 AST comparison below.
});

describe("兜底杀进程（假时钟，不真等 9 秒）", () => {
  // 卡住的子进程会一直占着投递。旧实现在 8000ms 只发一个裸 SIGTERM 就**就地结算**：忽略 SIGTERM
  // 的进程照活（实测 8006ms 后接口已返回 failed 而进程仍在跑），而 `await run()` 也只因为就地结算
  // 才没有永久挂着——于是一个「杀不掉」的事实被写成了「已按失败结算」。
  // 新契约是三段，且每一段各守一条：7s 只发信号**不结算**（还在跑就是还在跑）、8.5s 补 SIGKILL、
  // 9s 才硬结算并 unref 孤儿。时刻取自客户端的测试按钮预算（7 × 1500ms + 500ms debounce）。
  it("三段兜底：7999ms 不动、7000ms 发 SIGTERM 且不结算、8500ms 发 SIGKILL、9000ms 硬结算失败", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = fakeDeps({ available: ["notify-send"] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery();

    const pending = delivery.send();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.children.length).toBe(1);
    const child = fake.children[0]!;

    await vi.advanceTimersByTimeAsync(6999);
    expect(child.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // 第一段只发信号：就地结算等于把一次还在跑的投递提前判死。
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(delivery.warns).toEqual([]);

    await vi.advanceTimersByTimeAsync(1500);
    // 忽略 SIGTERM 的进程在第二段才被真正收掉（旧实现在这里已经结算并把它留在后台）。
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(delivery.warns).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({
      status: "failed",
      stage: "delivered",
      reason: {
        code: "reasonSystemPopupFailed",
        params: { bin: "notify-send" },
      },
      retryable: false,
    });
    expect(delivery.warns).toEqual(["dsh-notifier: 命令超时未退出（notify-send），已按失败结算"]);
    // 结算之后它已经是孤儿：既不挡进程退出，也不让它自己的管道吊住事件循环。
    expect(child.unrefCount).toBe(1);
  });

  // 连 SIGKILL 都不理的进程（内核态 D 状态、被冻结的容器）永远不回调 onExit。硬结算这一段就是
  // 为它存在的：缺了它 `await run()` 永久挂着，正是本次要消灭的那个失败面。
  it("硬结算之后晚到的退出不再改结论（settled 幂等闸对在途回调仍然有效）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = fakeDeps({ available: ["notify-send"] });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery();

    const pending = delivery.send();
    await vi.advanceTimersByTimeAsync(9000);
    expect((await pending).status).toBe("failed");
    const child = fake.children[0]!;
    expect(child.unrefCount).toBe(1);

    // 结算之后进程才真的退出（真机上就是「先硬结算、稍后被 SIGKILL 收掉」那一刻）。
    child.emitExit({ exited: true, code: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(delivery.warns).toHaveLength(1);
  });

  // 超时兜底在**声音**这一侧同样要结算：整条链都超时 ⇒ 终态 failed + 一条 warn（成因摘要带候选名）。
  it("只响不弹：候选超时兜底 ⇒ failed + 一条 warn（成因摘要写「超时未退出」）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = fakeDeps({
      available: ["notify-send", "pw-play"],
      present: [LINUX_DING_FILE],
    });
    fake.autoExit = false;
    installSystemDeps(fake);
    const delivery = new SystemDelivery({ popup: false, sound: "ding" });

    const pending = delivery.send();
    // 走到硬结算那一格（8s 只发了 SIGTERM，还没有结论）。
    await vi.advanceTimersByTimeAsync(9000);

    expect((await pending).status).toBe("failed");
    expect(delivery.warns).toEqual(["dsh-notifier: 提示音播放失败：pw-play 超时未退出"]);
  });

  // 结局已到的子进程不该在 9 秒后再被「杀」一次：三个定时器都要清，进程早已回收而回调照样打进来。
  it("结局先到（退出或 error）：三个定时器都被清掉，不再有杀进程动作", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const exited = fakeDeps({ available: ["notify-send"] });
    exited.autoExit = false;
    installSystemDeps(exited);
    const first = new SystemDelivery().send();
    await vi.advanceTimersByTimeAsync(0);
    exited.children[0]!.emitExit({ exited: true, code: 0 });
    expect(await first).toEqual({ status: "ok", stage: "delivered" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exited.children[0]!.signals).toEqual([]);
    // 正常退出路径不该 unref：进程已经没了，它不是孤儿。
    expect(exited.children[0]!.unrefCount).toBe(0);

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
    expect(errored.children[0]!.signals).toEqual([]);
  });

  // 真进程那一档：上面的假端口只能证明「发过 SIGKILL」，证明不了「SIGKILL 真能把一个忽略
  // SIGTERM 的进程收掉」。这一条把那半边前提钉在真信号语义上（posix 才有信号语义）。
  it("真子进程忽略 SIGTERM：SIGKILL 确实能把它收掉（Windows 无信号语义，跳过）", async (ctx) => {
    ctx.skip(process.platform === "win32", "Windows 的 kill 不给信号语义（本用例守 posix 那一支）");
    const child = systemDeps().spawn(
      [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); process.stderr.write('ready\\n'); setTimeout(() => {}, 60_000)",
      ],
      { collectStderr: true },
    );
    const exit = exitOf(child);
    let gone = false;
    void exit.then(() => {
      gone = true;
    });
    // 必须等它真的装上 SIGTERM 监听：早发会在 node 启动途中到达，走的是默认动作（直接死），
    // 那样这条用例就退化成「SIGTERM 也杀得掉」，守不到要守的那半边前提。
    let ready = false;
    child.onStderr((chunk) => {
      if (chunk.toString("utf8").includes("ready")) ready = true;
    });
    await pollUntil(() => ready, "子进程装上 SIGTERM 监听");

    child.kill("SIGTERM");
    // SIGTERM 被吞：进程照活（这正是需要第二段强杀的原因）。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gone).toBe(false);

    child.kill("SIGKILL");
    expect(await exit).toEqual({ exited: false });
  });
});
