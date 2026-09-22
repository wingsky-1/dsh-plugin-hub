/**
 * dsh-notifier upgrade 域 0.2.3 → 0.2.4 的**投递理由形态割接**（#782 批 1）。
 *
 * 判据面：这一步把磁盘上的散文理由重写成结构化对象，而它动的是**用户数据**。写错的表现是
 * 「通知记录里理由变成 undefined」或「重跑把已经割接过的行又套一层」，用户只会看到历史页坏了。
 * 故逐条锁：旧形态被收编、新形态原样保留、坏内容不动那个文件、重跑幂等。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HISTORY_FILE_NAME,
  STATUS_FILE_NAME,
  notifierFile,
} from "../../../src/server/shared/interface.ts";
import * as fileIo from "../../../src/server/shared/file-io.ts";
import { migrateReasonShape } from "../../../src/server/upgrade/impl/steps/reason-shape.ts";
import { tempDshHome } from "../../helpers.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

function isolatedHome(): void {
  const home = tempDshHome();
  cleanups.push(home.dispose);
}

/** 写一份存储文件；先清掉同名目录（失败面用例会把目标位置占成目录）。 */
function write(file: string, text: string): void {
  rmSync(file, { recursive: true, force: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("status.json 的理由形态割接", () => {
  it("lastError 的散文收编成 reasonLegacy + detail，其余字段逐字保留", () => {
    isolatedHome();
    write(
      notifierFile(STATUS_FILE_NAME),
      `${JSON.stringify(
        {
          "bark:old": { lastTs: 9, lastStatus: "failed", lastError: "连接超时", failStreak: 3 },
          "bark:new": {
            lastTs: 10,
            lastStatus: "failed",
            lastError: { code: "reasonBarkHttp", params: { status: 401 } },
            failStreak: 1,
          },
          "bark:ok": { lastTs: 11, lastStatus: "ok", failStreak: 0 },
        },
        null,
        2,
      )}\n`,
    );

    migrateReasonShape();

    const stored = JSON.parse(read(notifierFile(STATUS_FILE_NAME))) as Record<
      string,
      Record<string, unknown>
    >;
    expect(stored["bark:old"]).toEqual({
      lastTs: 9,
      lastStatus: "failed",
      lastError: { code: "reasonLegacy", detail: "连接超时" },
      failStreak: 3,
    });
    // 已经是结构化对象的原样保留（重跑不叠加、不套壳）
    expect(stored["bark:new"].lastError).toEqual({
      code: "reasonBarkHttp",
      params: { status: 401 },
    });
    expect(stored["bark:ok"]).toEqual({ lastTs: 11, lastStatus: "ok", failStreak: 0 });
  });

  // 幂等不是「省一次 IO」：这条链每次升级都会重跑，重写一次的代价是用户的历史被第二次改形。
  it("重跑幂等：已经割接过的文件一个字都不动", () => {
    isolatedHome();
    const file = notifierFile(STATUS_FILE_NAME);
    write(
      file,
      `${JSON.stringify({ "bark:a": { lastTs: 1, lastStatus: "failed", lastError: "旧散文", failStreak: 1 } })}\n`,
    );
    migrateReasonShape();
    const once = read(file);

    migrateReasonShape();

    expect(read(file)).toBe(once);
  });

  // 等价判定含 params：只看 code+detail 的旧写法会把「已经割接好但带参数」的条目再写一次盘。
  it("带 params 的结构化条目不被改写（等价判据覆盖 params）", () => {
    isolatedHome();
    const file = notifierFile(STATUS_FILE_NAME);
    write(
      file,
      `${JSON.stringify({
        "bark:new": {
          lastTs: 1,
          lastStatus: "failed",
          lastError: { code: "reasonBarkHttp", params: { status: 401 }, detail: "nope" },
          failStreak: 1,
        },
      })}\n`,
    );
    const before = read(file);

    migrateReasonShape();

    expect(read(file)).toBe(before);
  });

  // 「内容没变」不等于「没写盘」：无条件重写会与并发 append 抢同一个文件，把那一行盖掉，而只比
  // 内容看不出来。判据不能用 inode（temp+rename 后 ext4 会复用刚释放的 inode 号，实测飘）也不
  // 能用 mtime（同一毫秒内不可分）——原来是**把写路径本身占死**，随机临时名下固定名占位不再生效，
  // 改成 mock 写面：第二次调用若真的落盘就必然触发 mock 并抛出，于是「不抛」就等价于「没碰盘」。
  it("无变化时连盘都不碰：写面 mock 后重跑不抛（真写一次就会触发 mock 并抛出）", () => {
    isolatedHome();
    const file = notifierFile(STATUS_FILE_NAME);
    write(
      file,
      `${JSON.stringify({ "bark:a": { lastTs: 1, lastStatus: "failed", lastError: "旧散文", failStreak: 1 } })}\n`,
    );
    migrateReasonShape();
    // 随机后缀下无法再用固定临时名占位：mock 写面让任何一次真写都抛（目录只读的 mock 等价物）。
    const spy = vi.spyOn(fileIo, "writeTextAtomicSync").mockImplementation(() => {
      throw new Error("unexpected write");
    });
    try {
      expect(() => migrateReasonShape()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  // 写失败必须抛：迁移没做完而启动照常，等于让各域按错误形态去读数据（与 storage-layout 同口径）。
  // 直接让写面回失败 —— 不依赖固定临时名（随机后缀下占位固定名不再生效），也不靠只读目录、不依赖 root。
  // 随机名下不断言残留：失败是否留 tmp 是错误模型的事实，本补丁不动它。
  it("割接写失败即抛出（写面失败时抛出）", () => {
    isolatedHome();
    const file = notifierFile(STATUS_FILE_NAME);
    write(
      file,
      `${JSON.stringify({ "bark:a": { lastTs: 1, lastStatus: "failed", lastError: "旧散文", failStreak: 1 } })}\n`,
    );
    // 等价方案：mock 写面回失败（目录只读的 mock 等价物），保持「写失败即抛」语义。
    const spy = vi
      .spyOn(fileIo, "writeTextAtomicSync")
      .mockReturnValue({ ok: false, reason: "mocked EISDIR" });
    try {
      expect(() => migrateReasonShape()).toThrow(/割接写入失败/u);
    } finally {
      spy.mockRestore();
    }
  });

  // 读不出的旧文件不该拦住启动：读面本来就容错（半截 JSON 从空表开始），为它抛错是更坏的结果。
  it("内容读不出（坏 JSON）时不动那个文件", () => {
    isolatedHome();
    const file = notifierFile(STATUS_FILE_NAME);
    write(file, "{ 半截");

    migrateReasonShape();

    expect(read(file)).toBe("{ 半截");
  });

  it("文件不存在时什么都不做（storage-layout 负责建出初始形态）", () => {
    isolatedHome();
    const file = notifierFile(STATUS_FILE_NAME);

    migrateReasonShape();

    expect(existsSync(file)).toBe(false);
  });
});

describe("history.jsonl 的理由形态割接", () => {
  it("逐行换掉 channels[].reason，行数与其它字段都不变", () => {
    isolatedHome();
    const file = notifierFile(HISTORY_FILE_NAME);
    const oldLine = {
      ts: 1,
      kind: "done",
      title: "旧",
      message: "正文",
      channels: [
        { channelId: "bark:phone", status: "failed", reason: "timeout" },
        { channelId: "browser", status: "ok" },
      ],
    };
    write(file, `${JSON.stringify(oldLine)}\n`);

    migrateReasonShape();

    const lines = read(file).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ...oldLine,
      channels: [
        {
          channelId: "bark:phone",
          status: "failed",
          reason: { code: "reasonLegacy", detail: "timeout" },
        },
        { channelId: "browser", status: "ok" },
      ],
    });
  });

  // 坏行是常态（手改、半截写入）：整份重写时把它们弄丢，等于用一次升级抹掉用户的记录。
  it("坏行原样保留，只有需要改的行被改写", () => {
    isolatedHome();
    const file = notifierFile(HISTORY_FILE_NAME);
    const legacy = {
      ts: 2,
      kind: "done",
      channels: [{ channelId: "a", status: "failed", reason: "x" }],
    };
    write(file, `{ 坏行\n${JSON.stringify(legacy)}\n`);

    migrateReasonShape();

    const lines = read(file).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("{ 坏行");
    expect(JSON.parse(lines[1]!).channels[0].reason).toEqual({
      code: "reasonLegacy",
      detail: "x",
    });
  });

  it("重跑幂等：全部已割接时文件逐字不变", () => {
    isolatedHome();
    const file = notifierFile(HISTORY_FILE_NAME);
    write(
      file,
      `${JSON.stringify({
        ts: 1,
        kind: "done",
        channels: [{ channelId: "a", status: "failed", reason: "旧散文" }],
      })}\n`,
    );
    migrateReasonShape();
    const once = read(file);

    migrateReasonShape();

    expect(read(file)).toBe(once);
  });
});
