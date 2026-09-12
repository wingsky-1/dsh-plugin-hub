/**
 * dsh-notifier — unit：system-notifier spawn 链直测（红测先行）。
 *
 * 现状 server.ts 系统通知真 spawn 链（runCommand/deliverOnce/8s 杀进程/1s 节流/
 * 只响不弹自播失败终态）零断言（e2e 里真 spawn 在 CI 上 ENOENT→warn 静默，
 * service-contract 用 fakeSystem 整体替换绕过）。本文件经 createSystemNotifier 的
 * 注入面（execFileImpl/spawnImpl/killTimeoutMs——行为无关注入，缺省语义不变）
 * 锁定基线；渠道 SPI 化时是行为对等判别网。
 *
 * 假进程纪律：spawn 返回 fake child（EventEmitter + stderr.on + kill），测试手动
 * 触发 exit 决议；不产生任何真实子进程（消除 e2e 真 spawn 的 130-200 次 execFile/次运行）。
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import { createSystemNotifier } from "../../src/server/interface.ts";

/** 注入面真实类型（与 src 的 options 签名同源，避免各写一份重复声明）。 */
type SpawnImpl = NonNullable<Parameters<typeof createSystemNotifier>[0]["spawnImpl"]>;
type ExecFileImpl = NonNullable<Parameters<typeof createSystemNotifier>[0]["execFileImpl"]>;

/** fake child：EventEmitter + stderr 订阅捕获 + kill 记录（测试手动 emit exit 决议）。 */
interface FakeChild extends EventEmitter {
  stderr: { on(event: string, cb: (chunk: Buffer) => void): void };
  kill(): void;
  _bin: string;
  _argv: string[];
  _killed: boolean;
  _stderrCb?: (chunk: Buffer) => void;
}

/** fake spawn：记录调用；child 挂起由测试手动 exit 决议；kill 触发微任务 exit(null)。 */
function makeFakeSpawn() {
  const calls: Array<{ bin: string; argv: string[] }> = [];
  const children: FakeChild[] = [];
  function spawnImpl(bin: string, argv: string[]): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stderr = { on: (_ev, cb) => { child._stderrCb = cb; } };
    child.kill = () => {
      child._killed = true;
      queueMicrotask(() => child.emit("exit", null));
    };
    child._bin = bin;
    child._argv = argv;
    child._killed = false;
    children.push(child);
    calls.push({ bin, argv });
    return child;
  }
  return { spawnImpl, calls, children };
}

/** fake execFile 探测签名（探测回调只关心 error）。 */
type FakeExecImpl = (bin: string, argv: string[], opts: { timeout?: number }, cb: (error: Error | null) => void) => void;

/** fake execFile 探测：同步回调（notify-send / pw-play / paplay 三路可配成败）。 */
function makeFakeExec({ notifySendErr = false, selfPlayErr = false }: { notifySendErr?: boolean; selfPlayErr?: boolean } = {}): FakeExecImpl {
  return (bin, _argv, _opts, cb) => {
    if (bin === "notify-send") cb(notifySendErr ? new Error("ENOENT") : null);
    else if (bin === "pw-play") cb(selfPlayErr ? new Error("ENOENT") : null);
    else if (bin === "paplay") cb(selfPlayErr ? new Error("ENOENT") : null);
    else cb(new Error(`unexpected execFile: ${bin}`));
  };
}

/** makeNotifier 注入选项（exec 三路探测成败 + kill 超时）。 */
interface FakeNotifierOptions {
  killTimeoutMs?: number;
  exec?: { notifySendErr?: boolean; selfPlayErr?: boolean };
}

function makeNotifier(opts: FakeNotifierOptions = {}) {
  const spawn = makeFakeSpawn();
  const warns: string[] = [];
  const system = createSystemNotifier({
    toastScript: "/tmp/fake-toast.ps1",
    warn: (m) => warns.push(m),
    execFileImpl: makeFakeExec(opts.exec ?? {}) as unknown as ExecFileImpl,
    spawnImpl: spawn.spawnImpl as unknown as SpawnImpl,
    killTimeoutMs: opts.killTimeoutMs ?? 8000,
  });
  return { system, spawn, warns };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("A：1s 节流吞掉重复投递（透传上次决议；不新增 spawn）", () => {
  let after1: number;
  let afterSecond: number;

  beforeEach(async () => {
    const { system, spawn } = makeNotifier();
    // 第一次投递：toast spawn 同步发生（selfPlay spawn 在其后 await 处挂起）
    const p1 = system.notify(true, true, "t1", "m1");
    after1 = spawn.calls.length;
    // 节流窗口内第二次：同步分支吞掉，透传上次决议，不新增 spawn
    const p2 = system.notify(true, true, "t2", "m2");
    afterSecond = spawn.calls.length;
    // 清理挂起子进程：toast exit 后 deliverOnce 微任务推进到自播 spawn，两轮补发
    for (const child of spawn.children) child.emit("exit", 0);
    await tick();
    for (const child of spawn.children) child.emit("exit", 0);
    await p1;
    await p2;
  });

  it("A：首次投递同步 spawn toast", () => {
    expect(after1 >= 1).toBeTruthy();
  });

  it("A：1s 节流窗口内第二次投递不 spawn", () => {
    expect(afterSecond).toBe(after1);
  });
});

describe("B：killTimeoutMs 超时杀进程（弹窗场景被杀不翻转终态）", () => {
  it("B：超时后 child.kill 被调用（8s 兜底可注入短值）", async () => {
    const { system, spawn } = makeNotifier({ killTimeoutMs: 40 });
    const p = system.notify(true, true, "t", "m");
    const toast = spawn.children[0];
    const deadline = Date.now() + 1500;
    while (!toast._killed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // toast 被 kill → exit(null) 决议；等 deliverOnce 推进到自播后补 exit 完成
    await tick();
    spawn.children[1]?.emit("exit", 0);
    await p;
    expect(toast._killed).toBeTruthy();
  });

  it("B：弹窗场景杀进程不翻转终态（toast 静默语义）", async () => {
    const { system, spawn } = makeNotifier({ killTimeoutMs: 40 });
    const p = system.notify(true, true, "t", "m");
    const toast = spawn.children[0];
    const deadline = Date.now() + 1500;
    while (!toast._killed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await tick();
    spawn.children[1]?.emit("exit", 0);
    expect(await p).toBe(true);
  });
});

describe("C：toast 命令 exit 非 0 → 弹窗终态仍 true（失败静默、仅日志）", () => {
  let result: boolean;
  let warns: string[];

  beforeEach(async () => {
    const made = makeNotifier();
    warns = made.warns;
    const p = made.system.notify(true, true, "t", "m");
    made.spawn.children[0].emit("exit", 1); // toast 失败
    await tick(); // deliverOnce 推进到自播 spawn
    made.spawn.children[1]?.emit("exit", 0); // 自播正常
    result = await p;
  });

  it("C：toast spawn exit 1 不翻转弹窗终态（旧契约：失败静默仅日志）", () => {
    expect(result).toBe(true);
  });

  it("C：exit 1 记 warn 日志", () => {
    expect(warns.some((w) => w.includes("退出码异常"))).toBeTruthy();
  });
});

describe("D：只响不弹自播失败 → 终态 failed（resolve false，诚实上报）", () => {
  it("D：只响不弹自播失败 → resolve false（终态 failed，B4/P1-2）", async () => {
    const { system, spawn } = makeNotifier();
    const p = system.notify(false, "ding", "", "");
    spawn.children[0].emit("exit", 1); // 自播命令失败
    expect(await p).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("E（linux-only）：notify-send 探测不可用 → 弹窗静默跳过（argv null，零 spawn）", () => {
  let result: boolean;
  let spawn: ReturnType<typeof makeFakeSpawn>;

  beforeEach(async () => {
    const made = makeNotifier({ exec: { notifySendErr: true, selfPlayErr: true } });
    spawn = made.spawn;
    result = await made.system.notify(true, true, "t", "m");
  });

  it("E：探测不可用 → 弹窗静默跳过仍成功（旧语义：通道不可用≠失败）", () => {
    expect(result).toBe(true);
  });

  it("E：探测不可用 → 零 spawn（argv null 路径）", () => {
    expect(spawn.calls.length).toBe(0);
  });
});

describe("F：节流状态是实例内的（#733 宪法 1 / #733 M2c 后续 N2）", () => {
  it("F：实例 A 投递失败后，实例 B 的节流吞掉返回 B 自己的初值 true（模块级 let 版为 false）", async () => {
    // 为什么需要这条新用例：模块级 `let lastSystemOutcome` 改成实例内状态是**行为变更**
    // （跨实例共享 → 每实例独立），而既有 1790 条测试在两版下都全绿（实测）——即「既有
    // 测试锁定」对这次改动是恒真的。判据只能落在新用例上。
    //
    // 前置 1：A 投递失败（只响不弹 → 自播 exit 1 → false），旧的模块级实现会把它写成 false
    const a = makeNotifier();
    const pa = a.system.notify(false, "ding", "", "");
    expect(a.spawn.calls.length).toBe(1);
    a.spawn.children[0].emit("exit", 1);
    expect(await pa).toBe(false);

    // 前置 2：B 是独立实例，第一次投递的 spawn 仍挂起（未决议）→ 此时没有任何实例内的
    // 「上一次决议」，节流窗口内的第二次必被吞掉且必须透传 B 自己的初值
    const b = makeNotifier();
    const first = b.system.notify(false, "ding", "", "");
    expect(b.spawn.calls.length).toBe(1);
    const second = b.system.notify(false, "ding", "", "");
    expect(b.spawn.calls.length).toBe(1); // 第二次确实被节流吞掉（零新增 spawn）

    // 判据：实例级状态 → true（B 的初值）；模块级 let → false（读到 A 写的结论）
    expect(await second).toBe(true);

    b.spawn.children[0].emit("exit", 0);
    expect(await first).toBe(true);
  });
});
