#!/usr/bin/env node
/**
 * forbid-session-snapshot-src 自测（#1028 防复发门禁）。
 *
 * 形态与同族一致：mkdtemp 隔离副本跑真实 CLI（--root / --registry / --exemptions 三个注入点），
 * 测试产物不落仓库。用例分三族：
 *   A 判红（快照上的 .current）——正例是 #1028 的三处历史写法，反例必须覆盖「同形但不是快照」
 *     （React ref、对象字面量、字符串里的 .current）与「换一个作用域的同名局部变量」；
 *   B warn（自建镜像）——正例是本轮被删掉的两个镜像形状，反例是官方派生写法
 *     （Pick<> / extends / 与官方无关的形状）与交集不足的形状；
 *   三态——范围/豁免机制失效、扫描面为空、源码不可判一律 exit 2。
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "gate", "forbid-session-snapshot-src.mjs");

/** 造一个只含本闸所需数据的最小仓库副本（包面 = registry 显式数组，不读 packages/ 目录树）。 */
function fixture(t: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "forbid-session-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages", "dsh-probe", "src", "client"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, "packages", "dsh-probe", "src", "client", rel, ".."), { recursive: true });
    writeFileSync(join(root, "packages", "dsh-probe", "src", "client", rel), text);
  }
  writeFileSync(
    join(root, "registry.json"),
    JSON.stringify({
      version: 1,
      gates: [
        {
          gate: "forbid-session-snapshot-src",
          script: "scripts/gate/forbid-session-snapshot-src.mjs",
          scopeFrom: "registry",
          packages: ["dsh-probe"],
          why: "fixture：显式包面，避免通配读 packages/ 目录树",
        },
      ],
    }),
  );
  writeFileSync(join(root, "exemptions.json"), JSON.stringify({ exemptions: [] }));
  return root;
}

function run(root: string) {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--root",
      root,
      "--registry",
      join(root, "registry.json"),
      "--exemptions",
      join(root, "exemptions.json"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test("A 正例：#1028 的三处历史写法都被判红（判据真能抓到事故本身）", (t) => {
  const root = fixture(t, {
    "a.ts": [
      'import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";',
      "export function follow(ctx: { sessions?: ISessions }): string | undefined {",
      "  const list = ctx.sessions?.list;",
      "  const snapshot = list.getSnapshot();",
      "  const sessionId = snapshot?.current;",
      "  return sessionId;",
      "}",
    ].join("\n"),
    "b.ts": [
      "export function isBlank(ctx: { sessions?: { list?: { getSnapshot?: () => any } } }): boolean {",
      "  const snap = ctx?.sessions?.list?.getSnapshot?.();",
      "  const current = snap?.current;",
      "  return snap?.byId?.[current]?.blank === true;",
      "}",
    ].join("\n"),
    "c.ts": [
      "export function direct(list: { getSnapshot(): { current?: string } }): string | undefined {",
      "  return list.getSnapshot()?.current;",
      "}",
    ].join("\n"),
  });
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /发现 3 处会话快照上的 \.current 读取/);
  for (const file of ["a.ts", "b.ts", "c.ts"]) {
    assert.ok(result.stderr.includes(file), `${file} 应在判词里`);
  }
  assert.doesNotMatch(result.stdout, /forbid-session-snapshot-src: OK/);
});

test("A 反例：同形但与快照无关的 .current 一律不命中（零误报优先）", (t) => {
  const root = fixture(t, {
    "ref.tsx": [
      "export function Row({ alive }: { alive: { current: boolean } }) {",
      "  alive.current = true;",
      "  if (!alive.current) return null;",
      "  return <div>ok</div>;",
      "}",
    ].join("\n"),
    "literal.ts": [
      'const spec = { current: "1.0.0", ids: [] };',
      "export const read = () => spec.current;",
      'const text = "snapshot.current";',
      "export const echo = () => text;",
    ].join("\n"),
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /forbid-session-snapshot-src: OK/);
});

test("A 反例：另一个作用域的同名局部变量不算快照（污点不跨作用域）", (t) => {
  const root = fixture(t, {
    "scoped.ts": [
      "export function withSnap(list: { getSnapshot(): { current?: string } }): string | undefined {",
      "  const snap = list.getSnapshot();",
      "  return snap.current;",
      "}",
      "export function withoutSnap(): string | undefined {",
      "  const snap = { current: undefined } as { current?: string };",
      "  return snap.current;",
      "}",
    ].join("\n"),
  });
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /发现 1 处会话快照上的 \.current 读取/);
  assert.match(result.stderr, /scoped\.ts:3/);
});

test("B warn：自建镜像形状出 warn（先校准存量，不判红）", (t) => {
  const root = fixture(t, {
    "mirror.ts": [
      "/** sessions.list 快照形态（{current, ids, byId}，与宿主一致）。 */",
      "export interface SessionListSnapshotLike {",
      "  current?: string;",
      "  ids?: string[];",
      "  byId?: Record<string, { cwd?: string; blank?: boolean }>;",
      "}",
    ].join("\n"),
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /warn forbid-session-snapshot-src \| .*SessionListSnapshotLike/);
  assert.match(result.stdout, /自建镜像 warn 1 处/);
});

test("B 反例：官方派生写法与无关形状都不出 warn", (t) => {
  const root = fixture(t, {
    "derived.ts": [
      'import type { ISessions, SessionSummary } from "@deepseek-ai/dsh-api-session-controller/client";',
      "export type Face = Pick<ISessions['list'], 'getSnapshot' | 'subscribe'>;",
      "export type Rows = { [K in keyof SessionSummary]?: SessionSummary[K] };",
      "export interface Pane {",
      "  current: number;",
      "  label?: string;",
      "}",
    ].join("\n"),
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /warn forbid-session-snapshot-src/);
});

test("三态：范围未登记 / 台账不可读 / 扫描面为空 一律 exit 2", (t) => {
  const empty = fixture(t, {});
  const noFiles = run(empty);
  assert.equal(noFiles.status, 2, noFiles.stdout + noFiles.stderr);
  assert.match(noFiles.stderr, /::error::门禁故障/);
  assert.match(noFiles.stderr, /扫描面为空/);

  const root = fixture(t, { "a.ts": "export const a = 1;\n" });
  const badRegistry = run(root);
  assert.equal(badRegistry.status, 0, badRegistry.stdout + badRegistry.stderr);
  const broken = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--root",
      root,
      "--registry",
      join(root, "registry.json"),
      "--exemptions",
      join(root, "missing-exemptions.json"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(broken.status, 2, broken.stdout + broken.stderr);
  assert.match(broken.stderr, /::error::门禁故障/);
  assert.match(broken.stderr, /豁免台账不可读/);
});

test("豁免：文件级登记生效，但注释不能替代登记", (t) => {
  const files = {
    "hit.ts": [
      "export function read(list: { getSnapshot(): { current?: string } }): string | undefined {",
      "  return list.getSnapshot()?.current;",
      "}",
    ].join("\n"),
  };
  const root = fixture(t, files);
  const marked = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--root",
      root,
      "--registry",
      join(root, "registry.json"),
      "--exemptions",
      join(root, "exemptions.json"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(marked.status, 1, marked.stdout + marked.stderr);

  writeFileSync(
    join(root, "exemptions.json"),
    JSON.stringify({
      exemptions: [
        {
          gate: "forbid-session-snapshot-src",
          path: "packages/dsh-probe/src/client/hit.ts",
          reason: "fixture：登记豁免",
          trackingIssue: "#1028",
        },
      ],
    }),
  );
  const exempt = run(root);
  assert.equal(exempt.status, 0, exempt.stdout + exempt.stderr);
  assert.match(exempt.stdout, /登记豁免 1 处/);

  // 注释而不登记：有 marker 无台账条目 → bad（判红，且文案点名两者不等价）。
  writeFileSync(
    join(root, "packages", "dsh-probe", "src", "client", "hit.ts"),
    [
      "export function read(list: { getSnapshot(): { current?: string } }): string | undefined {",
      "  return list.getSnapshot()?.current; // dsh-gate:allow-session-snapshot #1028 fixture",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(root, "exemptions.json"), JSON.stringify({ exemptions: [] }));
  const markerOnly = run(root);
  assert.equal(markerOnly.status, 1, markerOnly.stdout + markerOnly.stderr);
  assert.match(markerOnly.stderr, /注释不能替代登记/);
});

test("真实仓库：本仓客户端面零 .current 读取（判据在真实数据上绿）", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /forbid-session-snapshot-src: OK/);
});
