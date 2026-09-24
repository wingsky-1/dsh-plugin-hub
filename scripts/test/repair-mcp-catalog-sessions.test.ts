#!/usr/bin/env node
"use strict";

/**
 * repair-mcp-catalog-sessions（#723）：历史会话 source 形态与官方 reopen fixture。
 *
 * 全部产物都在 mkdtemp 隔离目录内。V0/V1/V2 的静态判据证明 repair 只写 V3 wrapper；
 * 官方 0.1.7-rc.1 迁移链只有在精确版本和依赖都存在时才运行，否则带原因 skipped。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyRepair,
  decodeLines,
  encodeFrames,
  isLegacyCatalogSource,
  migrationCandidate,
  parseArgs,
  planSession,
  rewriteRow,
  scanContainer,
  scanFrames,
  verifyRepaired,
} from "../maintenance/repair-mcp-catalog-sessions.mjs";

const TARGET_DSH_VERSION = "0.1.7-rc.1";
const CATALOG_SOURCE_PLUGIN = "@wingsky-1/dsh-mcp-manager";
const CATALOG_SECTION_NAME = "mcp-catalog";
const V3_SOURCE_KIND = "plugin";
const V4_SOURCE_KIND = "plugin:@wingsky-1/dsh-mcp-manager";
const CATALOG_TEXT = [
  "<system-reminder>",
  "<available_mcp_servers>",
  "- `playwright`: browser automation",
  "- `files`: read &amp; write",
  "</available_mcp_servers>",
  "</system-reminder>",
].join("\n");
const FALLBACK_SOURCE = {
  kind: "mcp-catalog",
  form: "catalog",
  entries: [{ name: "alpha", text: "a < b" }, { name: "beta" }],
};
const FALLBACK_CATALOG_TEXT = [
  "<system-reminder>",
  "<available_mcp_servers>",
  "- `alpha`: a &lt; b",
  "- `beta`",
  "</available_mcp_servers>",
  "</system-reminder>",
].join("\n");
const LEGACY_SOURCE = {
  kind: "mcp-catalog",
  form: "catalog",
  entries: [
    { name: "playwright", text: "browser automation" },
    { name: "files", text: "read & write" },
  ],
};
const V3_SOURCE = {
  kind: V3_SOURCE_KIND,
  plugin: CATALOG_SOURCE_PLUGIN,
  form: "snapshot",
  sections: [{ name: CATALOG_SECTION_NAME, text: CATALOG_TEXT }],
};
const V4_SOURCE = {
  kind: V4_SOURCE_KIND,
  form: "snapshot",
  sections: [{ name: CATALOG_SECTION_NAME, text: CATALOG_TEXT }],
};
const SCRIPT_PATH = fileURLToPath(
  new URL("../maintenance/repair-mcp-catalog-sessions.mjs", import.meta.url),
);

type Row = Record<string, unknown>;
type BodyMode = "present" | "empty" | "missing";

type RestoreReader = {
  decodeRow: (row: unknown) => void;
  finish: () => { header: { version: number }; events: unknown[] };
};
type RestoreFactory = (children: unknown[]) => {
  createRestore: (header: unknown, options: unknown) => RestoreReader;
};
type TargetChain = {
  createSessionFormatCatalogWithChildren: RestoreFactory;
  versions: Record<string, string>;
};

function asRecord(value: unknown): Row {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Row;
}

function makeMessage(id: string, source: Row, body: BodyMode): Row {
  const content =
    body === "missing" ? [] : [{ type: "text", text: body === "empty" ? "" : CATALOG_TEXT }];
  return { id, role: "user", content, source };
}

function writeVersionLog(
  dir: string,
  version: 0 | 1 | 2 | 3 | 4,
  {
    source = LEGACY_SOURCE,
    body = "present",
    includeSpliced = true,
  }: { source?: Row; body?: BodyMode; includeSpliced?: boolean } = {},
): { path: string; rows: Row[] } {
  const header: Row = {
    type: "session",
    version,
    id: "session-v" + version,
    createdAt: 1789101518091,
    delegationDepth: 0,
    cwd: "/tmp",
  };
  if (version > 1) header.isSeeded = false;
  const rows: Row[] = [
    header,
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: "user/message",
      seq: 2,
      time: 3,
      data: makeMessage("msg-user", source, body),
      surfaceOp: "append",
    },
    {
      type: "request/header",
      seq: 3,
      time: 4,
      data: {
        header: { config: { provider: "mock", model: "mock" } },
        reason: "initial",
      },
    },
    { type: "step/end", seq: 4, time: 5, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: 5,
      time: 6,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
  if (includeSpliced) {
    rows.push({
      type: "agent/inbox/spliced",
      seq: 6,
      time: 7,
      data: {
        target: "next-turn",
        start: 0,
        inserted: [makeMessage("msg-spliced", source, body)],
      },
    });
  }
  const fileName = version === 0 ? "session.jsonl.zstd" : "session.v" + version + ".jsonl.zstd";
  const path = join(dir, fileName);
  writeFileSync(path, encodeFrames(rows.map((row) => JSON.stringify(row))));
  return { path, rows };
}

function readRows(path: string): Row[] {
  return decodeLines(readFileSync(path)).map((line) => asRecord(JSON.parse(line)));
}

function rowSource(row: Row): Row {
  return asRecord(asRecord(row.data).source);
}

function splicedSource(row: Row): Row {
  const inserted = asRecord(row.data).inserted;
  assert.ok(Array.isArray(inserted));
  return asRecord(asRecord(inserted[0]).source);
}

function assertV3Source(source: Row, text = CATALOG_TEXT): void {
  assert.deepEqual(source, {
    kind: "plugin",
    plugin: CATALOG_SOURCE_PLUGIN,
    form: "snapshot",
    sections: [{ name: CATALOG_SECTION_NAME, text }],
  });
  assert.equal(Object.hasOwn(source, "entries"), false);
  assert.notEqual(source.kind, V4_SOURCE_KIND);
}

function assertV4Source(source: Row, text = CATALOG_TEXT): void {
  assert.deepEqual(source, {
    kind: V4_SOURCE_KIND,
    form: "snapshot",
    sections: [{ name: CATALOG_SECTION_NAME, text }],
  });
  assert.equal(Object.hasOwn(source, "plugin"), false);
}

function withSession(run: (ctx: { root: string; sessionDir: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "repair-mcp-catalog-"));
  try {
    const sessionDir = join(root, "sessions", "--tmp-proj--", "session-test");
    mkdirSync(sessionDir, { recursive: true });
    run({ root, sessionDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function packageInfo(candidate: string, name: string): { version: string; scope: string } {
  const require = createRequire(join(candidate, "anchor.js"));
  const roots = [candidate];
  try {
    const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");
    roots.push(join(dirname(dshPackage), "node_modules"));
  } catch {
    // dsh may be absent when a test points directly at a runtime package tree.
  }
  const paths = [
    ...roots.map((root) => join(root, "@deepseek-ai", name, "package.json")),
    ...roots.map((root) => join(root, name, "package.json")),
  ];
  let packagePath: string | undefined;
  try {
    packagePath = require.resolve(name + "/package.json");
  } catch {
    packagePath = paths.find((candidatePath) => existsSync(candidatePath));
  }
  if (packagePath === undefined) throw new Error(name + " is not installed");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error(name + " has no version");
  return { version: manifest.version, scope: dirname(dirname(packagePath)) };
}

async function loadTargetHostChain(): Promise<{ chain?: TargetChain; reason: string }> {
  const names = [
    "dsh-session-format",
    "dsh-session-format-v0-to-v1",
    "dsh-session-format-v1-to-v2",
    "dsh-session-format-v2-to-v3",
    "dsh-session-format-v3-to-v4",
    "dsh-session-format-catalog",
  ];
  const candidates = [
    process.env.DSH_HOST_NODE_MODULES,
    join(dirname(dirname(process.execPath)), "lib", "node_modules"),
    join(process.cwd(), "node_modules"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const infos = new Map<string, { version: string; scope: string }>();
      for (const name of names) infos.set(name, packageInfo(candidate, name));
      const mismatched = names.filter((name) => infos.get(name)!.version !== TARGET_DSH_VERSION);
      if (mismatched.length > 0) {
        failures.push(
          candidate +
            ": " +
            mismatched.map((name) => name + "=" + infos.get(name)!.version).join(", "),
        );
        continue;
      }
      const scope = infos.get(names[0])!.scope;
      const load = (name: string) =>
        import(pathToFileURL(join(scope, name, "lib", "index.js")).href);
      await Promise.all(names.map(load));
      const catalogModule = (await load("dsh-session-format-catalog")) as {
        createSessionFormatCatalogWithChildren?: RestoreFactory;
      };
      if (typeof catalogModule.createSessionFormatCatalogWithChildren !== "function") {
        throw new Error("official catalog has no createSessionFormatCatalogWithChildren export");
      }
      return {
        chain: {
          createSessionFormatCatalogWithChildren:
            catalogModule.createSessionFormatCatalogWithChildren,
          versions: Object.fromEntries(names.map((name) => [name, infos.get(name)!.version])),
        },
        reason: "",
      };
    } catch (error) {
      failures.push(candidate + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return {
    reason:
      "目标 dsh " +
      TARGET_DSH_VERSION +
      " 官方 session migration 依赖不可达；未运行动态 reopen。" +
      (failures.length === 0 ? "" : " " + failures.join(" | ")),
  };
}

function reopenWithOfficialCatalog(
  chain: TargetChain,
  rows: Row[],
): {
  header: { version: number };
  events: unknown[];
} {
  const [header, ...events] = rows;
  const restore = chain
    .createSessionFormatCatalogWithChildren([])
    .createRestore(header, { recovery: "strict", validation: "current" });
  for (const event of events) restore.decodeRow(event);
  return restore.finish();
}

function collectSources(value: unknown, found: Row[] = []): Row[] {
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, found);
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  const object = value as Row;
  if (object.source !== null && typeof object.source === "object") {
    found.push(asRecord(object.source));
  }
  for (const child of Object.values(object)) collectSources(child, found);
  return found;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("scanFrames/encodeFrames：多帧容器往返，损坏输入判红", () => {
  const buffer = encodeFrames(['{"type":"session"}', '{"seq":1}']);
  assert.equal(scanFrames(buffer).length, 2);
  assert.deepEqual(decodeLines(buffer), ['{"type":"session"}', '{"seq":1}']);
  assert.throws(() => scanFrames(Buffer.from([1, 2, 3, 4, 5])), /invalid frame magic/);
});

test("rewriteRow：user/message 路径改写为 V3 wrapper，正文照抄原消息正文", () => {
  const { row, changed } = rewriteRow({
    type: "user/message",
    data: {
      source: LEGACY_SOURCE,
      content: [
        { type: "text", text: "" },
        { type: "text", text: CATALOG_TEXT },
      ],
    },
  });
  assert.equal(changed, true);
  assertV3Source(rowSource(asRecord(row)), CATALOG_TEXT);
});

test("rewriteRow：agent/inbox/spliced 的 inserted source 改写为 V3 wrapper", () => {
  const { row, changed } = rewriteRow({
    type: "agent/inbox/spliced",
    data: {
      target: "next-turn",
      start: 0,
      inserted: [
        { id: "m", content: [{ type: "text", text: CATALOG_TEXT }], source: LEGACY_SOURCE },
      ],
    },
  });
  assert.equal(changed, true);
  const result = asRecord(row);
  assertV3Source(splicedSource(result), CATALOG_TEXT);
});

test("正文缺失：按 snapshot 语法合成，旧 entries 全部保留", () => {
  for (const row of [
    {
      type: "user/message",
      data: { source: FALLBACK_SOURCE, content: [] },
    },
    {
      type: "agent/inbox/spliced",
      data: {
        target: "next-turn",
        start: 0,
        inserted: [{ id: "m", content: [], source: FALLBACK_SOURCE }],
      },
    },
  ]) {
    const result = rewriteRow(row);
    assert.equal(result.changed, true);
    const source =
      result.row.type === "user/message"
        ? rowSource(asRecord(result.row))
        : splicedSource(asRecord(result.row));
    assertV3Source(source, FALLBACK_CATALOG_TEXT);
  }
});

test("非目录与 V3/V4 source 零改动，V4 不被 maintenance 误写", () => {
  assert.equal(
    rewriteRow({ type: "user/message", data: { source: { kind: "user" } } }).changed,
    false,
  );
  assert.equal(rewriteRow({ type: "user/message", data: { source: V3_SOURCE } }).changed, false);
  assert.equal(rewriteRow({ type: "user/message", data: { source: V4_SOURCE } }).changed, false);
  assert.equal(isLegacyCatalogSource(V3_SOURCE), false);
  assert.equal(isLegacyCatalogSource(V4_SOURCE), false);
  assert.equal(isLegacyCatalogSource(LEGACY_SOURCE), true);
});

test("migrationCandidate：V0/V1/V2 取最高历史代，V3/V4 不进入 repair", () => {
  assert.deepEqual(
    migrationCandidate(["session.jsonl.zstd", "session.v2.jsonl.zstd", "session.lock"]),
    { file: "session.v2.jsonl.zstd", version: 2 },
  );
  assert.deepEqual(migrationCandidate(["session.v0.jsonl.zstd"]), {
    file: "session.v0.jsonl.zstd",
    version: 0,
  });
  assert.deepEqual(migrationCandidate(["session.v1.jsonl.zstd"]), {
    file: "session.v1.jsonl.zstd",
    version: 1,
  });
  assert.equal(migrationCandidate(["session.v3.jsonl.zstd"]), undefined);
  assert.equal(migrationCandidate(["session.v4.jsonl.zstd"]), undefined);
});

test("V0/V1/V2 repair fixture：两类落点均输出 V3 wrapper，绝不直接写 V4", () => {
  for (const version of [0, 1, 2] as const) {
    withSession(({ sessionDir }) => {
      const { path } = writeVersionLog(sessionDir, version, { source: LEGACY_SOURCE });
      const before = readFileSync(path);
      const plan = planSession(sessionDir);
      assert.equal(plan.status, "needs-repair");
      assert.equal(plan.sources, 2);
      assert.equal(
        plan.file,
        version === 0 ? "session.jsonl.zstd" : "session.v" + version + ".jsonl.zstd",
      );
      const plannedRows = plan.rows as Row[];
      const user = plannedRows.find((row) => row.type === "user/message");
      const spliced = plannedRows.find((row) => row.type === "agent/inbox/spliced");
      assert.ok(user !== undefined);
      assert.ok(spliced !== undefined);
      assertV3Source(rowSource(user));
      assertV3Source(splicedSource(spliced));
      assert.deepEqual(readFileSync(path), before, "规划阶段不得动盘");
      applyRepair(sessionDir, plan.file!, plannedRows);
      const after = readFileSync(path);
      assert.notDeepEqual(after, before);
      const appliedRows = readRows(path);
      const appliedUser = appliedRows.find((row) => row.type === "user/message");
      const appliedSpliced = appliedRows.find((row) => row.type === "agent/inbox/spliced");
      assert.ok(appliedUser !== undefined);
      assert.ok(appliedSpliced !== undefined);
      assertV3Source(rowSource(appliedUser));
      assertV3Source(splicedSource(appliedSpliced));
      assert.equal(
        decodeLines(after).filter((line) => line.includes('"kind":"mcp-catalog"')).length,
        0,
      );
      assert.equal(planSession(sessionDir).status, "clean");
      assert.deepEqual(readFileSync(path), after, "重复规划不得再改写");
    });
  }
});

test("V3 wrapper 与 V4 native fixture：maintenance 只读不写", () => {
  withSession(({ sessionDir }) => {
    const v3 = writeVersionLog(sessionDir, 3, { source: V3_SOURCE });
    const v3Before = readFileSync(v3.path);
    const v3Plan = planSession(sessionDir);
    assert.equal(v3Plan.status, "clean");
    assert.equal(v3Plan.sources, 0);
    assert.deepEqual(readFileSync(v3.path), v3Before);
    const v3Rows = readRows(v3.path);
    const v3User = v3Rows.find((row) => row.type === "user/message");
    const v3Spliced = v3Rows.find((row) => row.type === "agent/inbox/spliced");
    assert.ok(v3User !== undefined);
    assert.ok(v3Spliced !== undefined);
    assertV3Source(rowSource(v3User));
    assertV3Source(splicedSource(v3Spliced));
  });
  withSession(({ sessionDir }) => {
    const v4 = writeVersionLog(sessionDir, 4, { source: V4_SOURCE });
    const v4Before = readFileSync(v4.path);
    const v4Plan = planSession(sessionDir);
    assert.equal(v4Plan.status, "already-v4");
    assert.equal(v4Plan.sources, 0);
    assert.deepEqual(readFileSync(v4.path), v4Before);
    const v4Rows = readRows(v4.path);
    const v4User = v4Rows.find((row) => row.type === "user/message");
    const v4Spliced = v4Rows.find((row) => row.type === "agent/inbox/spliced");
    assert.ok(v4User !== undefined);
    assert.ok(v4Spliced !== undefined);
    assertV4Source(rowSource(v4User));
    assertV4Source(splicedSource(v4Spliced));
  });
});

test("v3 旧 kind 默认修为 wrapper；--legacy-only 不碰 v3", () => {
  withSession(({ sessionDir }) => {
    const { path } = writeVersionLog(sessionDir, 3, { source: LEGACY_SOURCE });
    const before = readFileSync(path);
    const legacyPlan = planSession(sessionDir, { legacyOnly: true });
    assert.equal(legacyPlan.status, "already-v3");
    assert.equal(legacyPlan.sources, 0);
    assert.deepEqual(readFileSync(path), before);
    const plan = planSession(sessionDir);
    assert.equal(plan.status, "needs-repair");
    assert.equal(plan.sources, 2);
    const plannedRows = plan.rows as Row[];
    const plannedUser = plannedRows.find((row) => row.type === "user/message");
    const plannedSpliced = plannedRows.find((row) => row.type === "agent/inbox/spliced");
    assert.ok(plannedUser !== undefined);
    assert.ok(plannedSpliced !== undefined);
    assertV3Source(rowSource(plannedUser));
    assertV3Source(splicedSource(plannedSpliced));
    assert.deepEqual(readFileSync(path), before, "规划阶段不得动盘");

    applyRepair(sessionDir, plan.file!, plannedRows);
    const repairedRows = readRows(path);
    const repairedUser = repairedRows.find((row) => row.type === "user/message");
    const repairedSpliced = repairedRows.find((row) => row.type === "agent/inbox/spliced");
    assert.equal(repairedRows[0]?.version, 3, "修复不得把 V3 写成 V4");
    assert.ok(repairedUser !== undefined);
    assert.ok(repairedSpliced !== undefined);
    assertV3Source(rowSource(repairedUser));
    assertV3Source(splicedSource(repairedSpliced));
    assert.equal(planSession(sessionDir).status, "clean");
  });
});

test("CLI dry-run/apply/重复 apply：干跑不动盘，落盘留备份，重复运行幂等", () => {
  withSession(({ root, sessionDir }) => {
    const { path } = writeVersionLog(sessionDir, 0, { source: LEGACY_SOURCE });
    const before = readFileSync(path);
    const dry = runCli(["--home", root]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry-run/);
    assert.deepEqual(readFileSync(path), before);

    const applied = runCli(["--home", root, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    const after = readFileSync(path);
    assert.notDeepEqual(after, before);
    const backups = readdirSync(sessionDir).filter((name) =>
      name.startsWith("session.jsonl.zstd.bak-"),
    );
    assert.equal(backups.length, 1);
    assert.deepEqual(readFileSync(join(sessionDir, backups[0])), before);

    const repeated = runCli(["--home", root, "--apply"]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(readFileSync(path), after);
    assert.equal(
      readdirSync(sessionDir).filter((name) => name.startsWith("session.jsonl.zstd.bak-")).length,
      1,
    );
  });
});

test("torn frame：末尾不完整帧按宿主恢复语义前缀解码，不抛错", () => {
  const whole = encodeFrames(['{"type":"session"}', '{"seq":1,"source":{"kind":"mcp-catalog"}}']);
  const scanned = scanContainer(whole);
  assert.equal(scanned.tornStart, undefined);
  const torn = whole.subarray(0, whole.length - 3);
  const decoded = decodeLines(torn);
  assert.equal(decoded[0], '{"type":"session"}');
  assert.equal(decoded.length, 2, "torn 帧解出已落盘前缀（末行被截断则丢弃）");
  assert.throws(() => scanFrames(torn), /incomplete final frame/);
});

test("verifyRepaired：拒绝畸形 target，完整 V3 wrapper 通过", () => {
  assert.throws(
    () => verifyRepaired(encodeFrames(['{"type":"session"}', '{"source":{"kind":"mcp-catalog"}}'])),
    /still carries 1 legacy catalog source/,
  );

  const malformed: Array<{ field: string; source: Row }> = [
    { field: "source.kind", source: { ...V3_SOURCE, kind: "catalog" } },
    { field: "source.plugin", source: { kind: "plugin" } },
    { field: "source.plugin", source: { ...V3_SOURCE, plugin: "@example/other-plugin" } },
    { field: "source.form", source: { ...V3_SOURCE, form: "catalog" } },
    { field: "source.sections", source: { ...V3_SOURCE, sections: {} } },
    {
      field: "source.sections[].name",
      source: { ...V3_SOURCE, sections: [{ name: "other", text: CATALOG_TEXT }] },
    },
    {
      field: "source.sections[mcp-catalog].text",
      source: {
        ...V3_SOURCE,
        sections: [{ name: CATALOG_SECTION_NAME, text: "not a catalog snapshot" }],
      },
    },
  ];
  for (const candidate of malformed) {
    let error: unknown;
    try {
      verifyRepaired(
        encodeFrames([
          '{"type":"session"}',
          JSON.stringify({ type: "user/message", data: { source: candidate.source } }),
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error, `expected ${candidate.field} to be rejected`);
    assert.match(error.message, /\/1\/data\/source/);
    assert.ok(error.message.includes(candidate.field), error.message);
  }

  const withExtraSection = {
    ...V3_SOURCE,
    sections: [{ name: "other", text: "other snapshot" }, ...V3_SOURCE.sections],
  };
  assert.equal(
    verifyRepaired(
      encodeFrames([
        '{"type":"session"}',
        JSON.stringify({ type: "user/message", data: { source: withExtraSection } }),
      ]),
    ).rows,
    2,
  );

  const otherPlugin = {
    kind: "plugin",
    plugin: "@example/other-plugin",
    form: "snapshot",
    sections: [{ name: "other", text: "other snapshot" }],
  };
  assert.equal(
    verifyRepaired(
      encodeFrames([
        '{"type":"session"}',
        JSON.stringify({ type: "user/message", data: { source: V3_SOURCE } }),
        JSON.stringify({ type: "user/message", data: { source: otherPlugin } }),
      ]),
      ["/1/data/source"],
    ).rows,
    3,
  );
});

test("parseArgs：默认 dry-run，支持 --apply/--legacy-only/--session/--home", () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(["--apply"]).apply, true);
  assert.equal(parseArgs(["--legacy-only"]).legacyOnly, true);
  assert.equal(parseArgs(["--session", "session-x"]).session, "session-x");
  assert.equal(parseArgs(["--home=/tmp/h"]).home, "/tmp/h");
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("官方 0.1.7 reopen：V0/V1/V2 修成 V3 wrapper 后迁移，V3 wrapper 转 V4，V4 原生 reopen", async (t) => {
  const loaded = await loadTargetHostChain();
  if (loaded.chain === undefined) {
    return t.skip(loaded.reason);
  }
  const chain = loaded.chain;
  t.diagnostic("official target versions: " + JSON.stringify(chain.versions));
  for (const version of [0, 1, 2, 3, 4] as const) {
    const root = mkdtempSync(join(tmpdir(), "repair-target-reopen-"));
    try {
      const source = version === 3 ? V3_SOURCE : version === 4 ? V4_SOURCE : LEGACY_SOURCE;
      const sessionDir = join(root, "sessions", "--tmp-proj--", "session-test");
      mkdirSync(sessionDir, { recursive: true });
      const { path } = writeVersionLog(sessionDir, version, {
        source,
        includeSpliced: false,
      });
      if (version < 3) {
        const before = readRows(path);
        assert.throws(
          () => reopenWithOfficialCatalog(chain, before),
          /unclassified message source/,
        );
        const plan = planSession(sessionDir);
        assert.equal(plan.status, "needs-repair");
        applyRepair(sessionDir, plan.file!, plan.rows as Row[]);
      }
      const rows = readRows(path);
      const beforeReopen = readFileSync(path);
      const artifact = reopenWithOfficialCatalog(chain, rows);
      assert.equal(artifact.header.version, 4);
      const sources = collectSources(artifact.events).filter(
        (candidate) => candidate.kind === V4_SOURCE_KIND,
      );
      assert.ok(sources.length > 0, "V0/V1/V2/V3 必须经官方链得到 V4 source");
      for (const candidate of sources) {
        assertV4Source(candidate, CATALOG_TEXT);
      }
      assert.deepEqual(readFileSync(path), beforeReopen, "reopen 不得改写源文件");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
