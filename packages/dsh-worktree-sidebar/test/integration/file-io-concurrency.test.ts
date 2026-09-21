/**
 * sidebar file-io 并发双写回归（经 `saveTable`）：同进程 20 路写同一绑定表文件。
 *
 * 与 notifier 同一竞态：固定临时名下并发双写共用同一个 tmp，终态可能半截混合。
 * 唯一临时名让每一路写各自的 tmp，终态必然精确等于其一路的完整表。
 * 用例不假设固定临时名单：只断言全 ok 与终态精确等于其一 payload；随机名下不断言残留。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BINDINGS_VERSION } from "../../src/server/binding/interface.ts";
import { saveTable } from "../../src/server/binding/impl/store/index.ts";
import type { BindingsFile } from "../../src/server/binding/impl/model/type.ts";
import { cleanup, tempDir } from "../helpers.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("saveTable 并发双写", () => {
  it("20 路同文件并发写全 ok、终态精确等于其一完整表（杜绝半截混合）", async () => {
    const dir = tempDir("fileio-concurrency");
    dirs.push(dir);
    const file = join(dir, "bindings.json");
    const tables: BindingsFile[] = Array.from({ length: 20 }, (_, i) => ({
      version: BINDINGS_VERSION,
      revision: i,
      bindings: {
        [`s${i}`]: {
          repoRoot: "/repo",
          worktreeRoot: `/wt-${i}`,
          branch: `feature-${i}`,
          createdAt: "2026-09-14T00:00:00.000Z",
          sessionCreatedAt: 1_700_000_000_000 + i,
        },
      },
    }));

    const results = await Promise.all(tables.map((table) => saveTable(file, table)));
    for (const result of results) expect(result).toEqual({ ok: true });

    const fin = JSON.parse(readFileSync(file, "utf8")) as BindingsFile;
    // 精确等于其一：半截混合要么解析失败、要么不在名单里；不假设临时文件名。
    expect(tables).toContainEqual(fin);
  });
});
