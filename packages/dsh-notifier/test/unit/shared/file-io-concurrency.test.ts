/**
 * file-io 落盘真值回归（#1016）：同路径并发写必须 FIFO、失败不留临时名、权限不随 umask 漂移。
 *
 * 三条判据各自钉一个「测试全绿仍会发生」的真缺陷：
 *  1. **FIFO**：唯一临时名（pid+时间戳+随机后缀）只保证「读到的是某一路的完整 payload」，不保证**是哪一路**——
 *     `rename` 的先后在并发下由调度决定。实测同路径 2000 路并发写，20 轮里 16 轮把旧值覆盖回盘上（最低落到第 1983 路），
 *     而每一次都返回 `ok`：静默丢数据。落到序号文件上就是 seq 回退，客户端按 `seq <= lastSeq` 静默丢帧。
 *     故异步写按目标路径串行，终态必然精确等于**最后提交值**。串行本身还不够：链条 settle 后要**只在表项仍是自己时**
 *     删它，否则前一路落定时的 finally 会把已经排上后继的链摘掉，下一路就此与后继并发开跑（FIFO 静默漏）。
 *  2. **失败清临时名**：临时名带随机后缀，残留不会被下一次写覆盖，攒起来就是目录垃圾；且**原错误**交回调用方，
 *     不被清理的失败或固定兜底串顶替。
 *  3. **显式 mode**：`config.json` 内含 bark deviceKey 与 webhook 凭据，落盘权限不该跟着 umask 走。
 *     目录同理，且既存目录走的是掩码口径 `mode & 0o700`：只保留 owner 三位，group/other（连同 setuid/setgid/
 *     sticky 特殊位）清零（旧安装的 0755 被追溯收紧；运维刻意只读的目录不会被反向打开可写）。
 *
 * 拦的只有 `node:fs/promises` 的 `writeFile` / `rename` 两拍（挂起一拍 / 注入失败），`mkdir`、`rm`、读与
 * 同步 API 全走真实文件系统：并发与失败的判据必须落在真盘上，mock 只用来**制造**那个窗口，不用来替代落盘。
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeTextAtomic, writeTextAtomicSync } from "../../../src/server/shared/file-io.ts";

/** 落盘闸门：默认全放行，按用例单独开一个窗口（挂起 / 注入失败）。 */
const gate = vi.hoisted(() => ({
  state: {
    /** 已进入的 `writeFile` 次数：等「第一路已经卡在写里」的凭据。 */
    writeCalls: 0,
    /** 下一次 `writeFile` 抛错。 */
    failNextWrite: false,
    /** 下一次 `rename` 抛错（制造「写成功、改名失败」——临时名已存在的那个窗口）。 */
    failNextRename: false,
    /**
     * 按**序号**（`writeCalls` 递增后的值，1 起）拦 `writeFile`。
     *
     * 按序号而不是「下一次」：判 FIFO 时需要同时挂起两路，且必须确定**哪一路**挂在第几个上——
     * 「拦下一次」在两路几乎同时落进 `writeFile` 时由调度决定谁消费掉闸门，判据就成了掷骰子。
     */
    holds: new Map<number, { promise: Promise<void>; release: () => void }>(),
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      gate.state.writeCalls += 1;
      if (gate.state.failNextWrite) {
        gate.state.failNextWrite = false;
        throw new Error("注入：写失败");
      }
      const held = gate.state.holds.get(gate.state.writeCalls);
      if (held !== undefined) await held.promise;
      return actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (gate.state.failNextRename) {
        gate.state.failNextRename = false;
        throw new Error("注入：改名失败");
      }
      return actual.rename(...args);
    },
  };
});

/** 拦下**第 ordinal 次**（1 起）`writeFile`，返回它的放行函数：制造「某一路卡在写里」的窗口。 */
function holdWrite(ordinal: number): () => void {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.state.holds.set(ordinal, { promise, release });
  return release;
}

/** 轮询直到谓词为真；用于等「第一路的 `writeFile` 已被调用」。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待 writeFile 调用超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** 谁先到算谁：写已完成，或等待窗口耗尽。 */
async function settleOrWait(pending: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([
    pending.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

const dirs: string[] = [];

/** 新建隔离目录：落盘产物一律进 `mkdtemp`，绝不写进仓库或真实 `~/.dsh`。 */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-fileio-"));
  dirs.push(dir);
  return dir;
}

/** 目录里剩下的临时名（实现约定：`<目标>.tmp-<pid>.<时间戳>.<随机>`）。 */
function temporaryLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

beforeEach(() => {
  gate.state.writeCalls = 0;
  gate.state.failNextWrite = false;
  gate.state.failNextRename = false;
  gate.state.holds.clear();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeTextAtomic 并发双写", () => {
  it("20 路同文件并发写全 ok、终态精确等于最后提交值（同路径 FIFO）", async () => {
    const dir = scratch();
    const file = join(dir, "concurrent.json");
    const payloads = Array.from({ length: 20 }, (_, i) => `${JSON.stringify({ i })}\n`);

    const results = await Promise.all(payloads.map((text) => writeTextAtomic(file, text)));
    for (const result of results) expect(result).toEqual({ ok: true });

    // 端到端镜像，判别力在下面两条挂起用例（20 路自身对 FIFO 无判别力：实测完全不打串行时也有绿有红）；
    // 顺带排掉半截混合（半截内容不在任何一个 payload 里）。
    expect(readFileSync(file, "utf8")).toBe(payloads[payloads.length - 1]);
  });

  it("挂起第一路的写再放行：两路同路径并发写，盘上留下的是后写者", async () => {
    const dir = scratch();
    const file = join(dir, "fifo.json");

    const release = holdWrite(1);
    const first = writeTextAtomic(file, "first");
    await waitFor(() => gate.state.writeCalls === 1);
    const second = writeTextAtomic(file, "second");
    // 有队列：second 排在 first 之后，窗口内写不完；无队列：second 当场写完并 rename 到目标。
    await settleOrWait(second, 200);
    release();

    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(readFileSync(file, "utf8")).toBe("second");
  });

  /**
   * settle 守卫 `if (writeChains.get(file) === next)`（file-io.ts 的 finally）是 FIFO 的**承重件**。
   *
   * 漏掉它的那条时序：写 A 挂起 → 写 B 登记（表项已是 B）→ A 落定，finally 若无条件 `delete` 就把 B 的表项抹掉
   * → 此刻才到的写 C 看不到 B，与 B 并发开跑；两次 `rename` 的先后由调度决定，FIFO 静默漏。
   * 无条件 delete 时前两条用例照样全绿（它们不制造「A 落定那一刻已有 B 在等」），所以只能另起一条钉它。
   *
   * 构造：挂起第 1 次写（A）与第 2 次写（B），先放行 A，等 B 确实卡在写里（A 的 finally 此时早已跑完，
   * B 的表项该被守卫保住的正是这一刻），再发起第 3 路 C。判据是 B 挂着期间 C **一次都没被放行过**，
   * 以及盘上终态精确是 C 的。
   */
  it("前一路落定时已有后继在等：第三路仍排在第二路之后（settle 守卫不摘掉后继的表项）", async () => {
    const dir = scratch();
    const file = join(dir, "settle-guard.json");

    const releaseFirst = holdWrite(1);
    const first = writeTextAtomic(file, "first");
    await waitFor(() => gate.state.writeCalls === 1);
    const releaseSecond = holdWrite(2);
    const second = writeTextAtomic(file, "second");

    releaseFirst();
    // 此刻起 B 是唯一的写方（第三路还没发起），故 writeCalls 必然停在 2：B 卡在写里，
    // 且 A 的 finally 早已跑完——B 的表项该被守卫保住的正是这一刻。断言取在这里，两种实现下都确定。
    await waitFor(() => gate.state.writeCalls === 2);
    const third = writeTextAtomic(file, "third");
    // B 还没落定，C 必须继续排在它后面。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const writesWhileHeld = gate.state.writeCalls;
    releaseSecond();

    expect(await Promise.all([first, second, third])).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    // 终态精确等于第三路：守卫漏掉时 C 与 B 并发开写，B 的 rename 落在 C 之后就把 B 的值盖回去了。
    expect(readFileSync(file, "utf8")).toBe("third");
    // 并发本身的可观测：B 挂着期间 C 一次都没自己开写过（writeCalls 只数到 B 自己那一次）。
    expect(writesWhileHeld).toBe(2);
  });

  it("同路径前一次写失败不毒化后继：后一次仍落盘成功", async () => {
    const dir = scratch();
    const file = join(dir, "poison.json");

    gate.state.failNextWrite = true;
    const failed = writeTextAtomic(file, "first");
    const recovered = writeTextAtomic(file, "second");
    const [first, second] = await Promise.all([failed, recovered]);

    // 一次失败只让**那一次**返回 ok:false：链若被毒化，序号与历史文件会在一次 EACCES/ENOSPC 之后永远写不进去。
    expect(first.ok).toBe(false);
    expect(second).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe("second");
  });

  it("改名失败时清掉临时名（目录里不留 *.tmp-*）", async () => {
    const dir = scratch();
    const file = join(dir, "cleanup.json");

    gate.state.failNextRename = true;
    const result = await writeTextAtomic(file, "payload");

    expect(result.ok).toBe(false);
    expect(temporaryLeftovers(dir)).toEqual([]);
    // 原错误交回调用方：reason 必须是 rename 自己的文案，不是清理失败或固定兜底串顶替的。
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("注入：改名失败") });
  });

  // POSIX 权限位语义在 win32 上不存在（NTFS 无 mode），故整条跳过而非放宽断言。
  it.skipIf(process.platform === "win32")(
    "新建文件 0600、插件自有目录 0700，父目录保持 umask 语义",
    async () => {
      const root = scratch();
      // 对照目录：与被建出的父目录同处一次 mkdir 递归、同一个 umask，权限相同即证明没被本包改过。
      const control = join(root, "control");
      mkdirSync(control);
      const own = join(root, "@wingsky-1", "dsh-notifier");

      expect(await writeTextAtomic(join(own, "config.json"), "{}\n")).toEqual({ ok: true });
      expect(statSync(join(own, "config.json")).mode & 0o777).toBe(0o600);
      expect(statSync(own).mode & 0o777).toBe(0o700);
      // DSH home 根与 @wingsky-1/ 是宿主与其它插件的共享面：只管自己那一级。
      expect(statSync(join(root, "@wingsky-1")).mode & 0o777).toBe(statSync(control).mode & 0o777);
    },
  );

  // 既存目录的权限口径是 `mode & 0o700`：**只保留 owner 三位，group/other 与特殊位清零**。
  // 这条断言钉的是「不被改成可写」这个不变式，而不是逐位不变——逐位不变是错的命题：
  // 旧安装的 0755/0777 目录正需要被追溯收紧，不收紧才是缺口。
  // 只读目录收成 0500 后**仍然只读**（掩码只做减法，永不新增权限位），所以「写不进去」这条判据不受影响。
  it.skipIf(process.platform === "win32")(
    "既存的只读目录不被改成可写：group/other 被清掉，owner 的写位不新增",
    async () => {
      const root = scratch();
      const own = join(root, "locked");
      mkdirSync(own, { mode: 0o555 });
      // umask 会从 mkdir 的 mode 里再抠一遍，先落成实际值再断言。
      const before = 0o555;
      chmodSync(own, before);

      const result = await writeTextAtomic(join(own, "config.json"), "{}\n");

      // 仍然只读：只读目录被收不紧成可写，运维排故障时才能拿它制造写失败。
      expect(result.ok).toBe(false);
      const mode = statSync(own).mode & 0o777;
      // group/other 被清掉：目录里躺着带凭据的 config.json，不该还有别人的读面。
      expect(mode & 0o077).toBe(0);
      // owner 位原样保留，且没有新增：before 的 owner 位一位不多、一位不少。
      expect(mode & 0o700).toBe(before & 0o700);
      expect(temporaryLeftovers(own)).toEqual([]);
    },
  );

  // 「既存目录完全不 chmod」留下的缺口：旧安装里躺着 0755（甚至 0777）的目录，里面是带凭据的 config.json。
  // 走一次写即被追溯收紧到 0700——masking 只保留 owner 三位，owner 的可写性原样保留，写本身照常成功。
  it.skipIf(process.platform === "win32")(
    "既存的 0755 目录走一次写即被追溯收紧到 0700（异步与同步两条路径同口径）",
    async () => {
      const root = scratch();
      const asyncOwn = join(root, "legacy-async");
      const syncOwn = join(root, "legacy-sync");
      for (const dir of [asyncOwn, syncOwn]) {
        mkdirSync(dir, { mode: 0o755 });
        chmodSync(dir, 0o755);
        expect(statSync(dir).mode & 0o777).toBe(0o755);
      }

      expect(await writeTextAtomic(join(asyncOwn, "config.json"), "{}\n")).toEqual({ ok: true });
      expect(writeTextAtomicSync(join(syncOwn, "version"), "0.2.7\n")).toEqual({ ok: true });

      expect(statSync(asyncOwn).mode & 0o777).toBe(0o700);
      expect(statSync(syncOwn).mode & 0o777).toBe(0o700);
    },
  );

  // sync 版不断言并发（同步函数进不了写链），只保同函数复用：单写往返 + 权限可用即证明同步路径同样走
  // 唯一临时名与显式 mode；它的「无并发」前提记在实现的函数注释里。
  it("同步版单写往返可用（与异步版同走 temporaryNameFor）", () => {
    const dir = scratch();
    const file = join(dir, "sync.json");
    const text = `${JSON.stringify({ hello: "world" })}\n`;

    expect(writeTextAtomicSync(file, text)).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(temporaryLeftovers(dir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("同步版落盘同样是文件 0600、目录 0700", () => {
    const root = scratch();
    const own = join(root, "sync-own");

    expect(writeTextAtomicSync(join(own, "version"), "0.2.7\n")).toEqual({ ok: true });
    expect(statSync(join(own, "version")).mode & 0o777).toBe(0o600);
    expect(statSync(own).mode & 0o777).toBe(0o700);
  });
});
