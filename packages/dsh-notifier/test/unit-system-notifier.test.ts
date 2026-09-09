// @ts-nocheck
/**
 * dsh-notifier — unit：system-notifier spawn 链直测（PR0 红测先行 1）。
 *
 * 现状 server.ts 系统通知真 spawn 链（runCommand/deliverOnce/8s 杀进程/1s 节流/
 * 只响不弹自播失败终态）零断言（T3-3：e2e 里真 spawn 在 CI 上 ENOENT→warn 静默，
 * service-contract 用 fakeSystem 整体替换绕过）。本文件经 createSystemNotifier 的
 * 注入面（execFileImpl/spawnImpl/killTimeoutMs——行为无关注入，缺省语义不变）
 * 锁定基线；PR2 渠道 SPI 化时是行为对等判别网。
 *
 * 假进程纪律：spawn 返回 fake child（EventEmitter + stderr.on + kill），测试手动
 * 触发 exit 决议；不产生任何真实子进程（消除 T3-3 的 130-200 次 execFile/次运行）。
 */
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { createSystemNotifier } from "../src/server.ts";

/** fake spawn：记录调用；child 挂起由测试手动 exit 决议；kill 触发微任务 exit(null)。 */
function makeFakeSpawn() {
  const calls = [];
  const children = [];
  function spawnImpl(bin, argv) {
    const child = new EventEmitter();
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

/** fake execFile 探测：同步回调（notify-send / pw-play / paplay 三路可配成败）。 */
function makeFakeExec({ notifySendErr = false, selfPlayErr = false } = {}) {
  return (bin, _argv, _opts, cb) => {
    if (bin === "notify-send") cb(notifySendErr ? new Error("ENOENT") : null);
    else if (bin === "pw-play") cb(selfPlayErr ? new Error("ENOENT") : null);
    else if (bin === "paplay") cb(selfPlayErr ? new Error("ENOENT") : null);
    else cb(new Error(`unexpected execFile: ${bin}`));
  };
}

function makeNotifier(opts = {}) {
  const spawn = makeFakeSpawn();
  const warns = [];
  const system = createSystemNotifier({
    toastScript: "/tmp/fake-toast.ps1",
    warn: (m) => warns.push(m),
    execFileImpl: makeFakeExec(opts.exec ?? {}),
    spawnImpl: spawn.spawnImpl,
    killTimeoutMs: opts.killTimeoutMs ?? 8000,
  });
  return { system, spawn, warns };
}

// ---- A：1s 节流吞掉重复投递（透传上次决议；不新增 spawn） ----
{
  const { system, spawn } = makeNotifier();
  // 第一次投递：toast spawn 同步发生（selfPlay spawn 在其后 await 处挂起）
  const p1 = system.notify(true, true, "t1", "m1");
  const after1 = spawn.calls.length;
  assert.ok(after1 >= 1, "A：首次投递同步 spawn toast");
  // 节流窗口内第二次：同步分支吞掉，透传上次决议，不新增 spawn
  const p2 = system.notify(true, true, "t2", "m2");
  assert.equal(spawn.calls.length, after1, "A：1s 节流窗口内第二次投递不 spawn");
  // 清理挂起子进程：toast exit 后 deliverOnce 微任务推进到自播 spawn，两轮补发
  for (const child of spawn.children) child.emit("exit", 0);
  await new Promise((r) => setTimeout(r, 0));
  for (const child of spawn.children) child.emit("exit", 0);
  await p1;
  await p2;
  console.log("A 系统通知 1s 节流: OK");
}

// ---- B：killTimeoutMs 超时杀进程（弹窗场景被杀不翻转终态） ----
{
  const { system, spawn } = makeNotifier({ killTimeoutMs: 40 });
  const p = system.notify(true, true, "t", "m");
  const toast = spawn.children[0];
  const deadline = Date.now() + 1500;
  while (!toast._killed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(toast._killed, "B：超时后 child.kill 被调用（8s 兜底可注入短值）");
  // toast 被 kill → exit(null) 决议；等 deliverOnce 推进到自播后补 exit 完成
  await new Promise((r) => setTimeout(r, 0));
  spawn.children[1]?.emit("exit", 0);
  const result = await p;
  assert.equal(result, true, "B：弹窗场景杀进程不翻转终态（toast 静默语义）");
  console.log("B 系统通知超时杀进程（不翻转终态）: OK");
}

// ---- C：toast 命令 exit 非 0 → 弹窗终态仍 true（失败静默、仅日志） ----
{
  const { system, spawn, warns } = makeNotifier();
  const p = system.notify(true, true, "t", "m");
  spawn.children[0].emit("exit", 1); // toast 失败
  await new Promise((r) => setTimeout(r, 0)); // deliverOnce 推进到自播 spawn
  spawn.children[1]?.emit("exit", 0); // 自播正常
  const result = await p;
  assert.equal(result, true, "C：toast spawn exit 1 不翻转弹窗终态（旧契约：失败静默仅日志）");
  assert.ok(warns.some((w) => w.includes("退出码异常")), "C：exit 1 记 warn 日志");
  console.log("C toast 失败静默不翻转终态: OK");
}

// ---- D：只响不弹自播失败 → 终态 failed（resolve false，诚实上报） ----
{
  const { system, spawn } = makeNotifier();
  const p = system.notify(false, "ding", "", "");
  spawn.children[0].emit("exit", 1); // 自播命令失败
  const result = await p;
  assert.equal(result, false, "D：只响不弹自播失败 → resolve false（终态 failed，B4/P1-2）");
  console.log("D 只响不弹自播失败 → failed 终态: OK");
}

// ---- E（linux-only）：notify-send 探测不可用 → 弹窗静默跳过（argv null，零 spawn） ----
if (process.platform === "linux") {
  const { system, spawn } = makeNotifier({ exec: { notifySendErr: true, selfPlayErr: true } });
  const result = await system.notify(true, true, "t", "m");
  assert.equal(result, true, "E：探测不可用 → 弹窗静默跳过仍成功（旧语义：通道不可用≠失败）");
  assert.equal(spawn.calls.length, 0, "E：探测不可用 → 零 spawn（argv null 路径）");
  console.log("E 探测不可用静默跳过（linux）: OK");
} else {
  console.log("E 探测不可用（非 linux 跳过）: SKIP");
}
