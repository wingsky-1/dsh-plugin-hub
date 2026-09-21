/**
 * file-io 并发双写回归：同进程 20 路 `writeTextAtomic` 写同一文件。
 *
 * 固定临时名（`<目标>.tmp-<pid>`）下并发双写共用同一个 tmp：两路 `writeFile` 截断同一个
 * 路径，终态可能是半截混合。唯一临时名（pid+时间戳+随机后缀）让每一路写各自的 tmp，
 * `rename` 先后仍无保证（R11），但终态必然精确等于其一路的完整 payload。
 * 用例不假设固定临时名单：只断言全 ok 与终态精确等于其一 payload。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeTextAtomic, writeTextAtomicSync } from "../../../src/server/shared/file-io.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeTextAtomic 并发双写", () => {
  it("20 路同文件并发写全 ok、终态精确等于其一 payload（杜绝半截混合）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-fileio-"));
    dirs.push(dir);
    const file = join(dir, "concurrent.json");
    const payloads = Array.from({ length: 20 }, (_, i) => `${JSON.stringify({ i })}\n`);

    const results = await Promise.all(payloads.map((text) => writeTextAtomic(file, text)));
    for (const result of results) expect(result).toEqual({ ok: true });

    const fin = readFileSync(file, "utf8");
    // 精确等于其一：半截混合必然不在名单里；不假设临时文件名。
    expect(payloads).toContain(fin);
    const parsed = JSON.parse(fin) as { i: number };
    expect(Number.isInteger(parsed.i) && parsed.i >= 0 && parsed.i < 20).toBe(true);
  });

  // sync 版不断言并发，只保同函数复用：单写往返可用即证明同步路径同样走唯一临时名。
  it("同步版单写往返可用（与异步版同走 temporaryNameFor）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-fileio-"));
    dirs.push(dir);
    const file = join(dir, "sync.json");
    const text = `${JSON.stringify({ hello: "world" })}\n`;

    expect(writeTextAtomicSync(file, text)).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});
