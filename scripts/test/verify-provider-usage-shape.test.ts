/**
 * verify-provider-usage-shape 自测（#768 干跑红修复：源码文本断言迁 gate 层）。
 *
 * 三态全覆盖（子进程真实 exit code）+ 纯函数口径 + 真实仓库锚 + 本地接线：
 *   - 正常三文件形态 → exit 0；
 *   - 脏输入（构造多一参 / 历史含 process.env / 聚合缺注解）→ exit 1；
 *   - 缺文件 / --root 非目录 → exit 2（fail-closed，::error:: 注解）；
 *   - serviceCtorKeys 与测试侧同形（含脏输入探针）；
 *   - 真实仓库自跑 exit 0（只断言一致性，不写死形态）；
 *   - local-gate 的 pr 计划含该闸（标签与 args 耦合）。
 *
 * fixture 一律建在 mkdtempSync 的临时根（仓库零污染纪律）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  checkApply,
  checkHistory,
  checkStore,
  serviceCtorKeys,
} from "../gate/verify-provider-usage-shape.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "verify-provider-usage-shape.mjs");

const APPLY_REL = "packages/dsh-provider-usage/src/apply/apply.ts";
const HISTORY_REL = "packages/dsh-provider-usage/src/server/history/history.ts";
const STORE_REL = "packages/dsh-provider-usage/src/server/aggregate/store.ts";

const APPLY_OK = "const s = new ReportConfigService({ root, initial, onUpdate });\n";
const HISTORY_OK = "export const historyVersion = 2;\n";
const STORE_OK = "const deletePromises: Array<Promise<void>> = [];\n";

/** 在临时根下写三形态文件（缺省为全通过形态，单项可覆盖为脏输入）。 */
function fixture(parts: { apply?: string; history?: string; store?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "provider-usage-shape-"));
  const apply = parts.apply ?? APPLY_OK;
  const history = parts.history ?? HISTORY_OK;
  const store = parts.store ?? STORE_OK;
  for (const [rel, text] of [
    [APPLY_REL, apply],
    [HISTORY_REL, history],
    [STORE_REL, store],
  ] as Array<[string, string]>) {
    if (text === null) continue;
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

function run(root: string, extra: string[] = []) {
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", root, ...extra], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("serviceCtorKeys：与测试侧同形（三键排序通过/多一参必红）", () => {
  assert.deepEqual(serviceCtorKeys(APPLY_OK), ["initial", "onUpdate", "root"]);
  const dirty = "const s = new ReportConfigService({ root, initial, onUpdate, scheduler });";
  assert.notDeepEqual(serviceCtorKeys(dirty), ["initial", "onUpdate", "root"]);
  assert.equal(serviceCtorKeys("const s = makeService(root);"), null);
});

test("checkApply/checkHistory/checkStore：纯函数口径（脏输入各红一行）", () => {
  assert.equal(checkApply(APPLY_OK), null);
  assert.match(
    String(checkApply("const s = new ReportConfigService({ root, initial });")),
    /实参键集/,
  );
  assert.equal(checkHistory(HISTORY_OK), null);
  assert.match(String(checkHistory("const h = process.env.HOME\n")), /不得读环境/);
  assert.match(String(checkHistory('import { dshHome } from "x"\n')), /不得读环境/);
  assert.match(String(checkHistory('import { homedir } from "node:os"\n')), /不得读环境/);
  assert.equal(checkStore(STORE_OK), null);
  assert.match(String(checkStore("const deletePromises = [];\n")), /具名注解/);
});

test("正例：三形态全通过 → exit 0", () => {
  const r = run(fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verify-provider-usage-shape: OK/);
});

test("反例a：构造多递一参 → exit 1（判据句中文）", () => {
  const r = run(
    fixture({
      apply: "const s = new ReportConfigService({ root, initial, onUpdate, scheduler });\n",
    }),
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /实参键集须恰为/);
  assert.match(r.stdout, /verify-provider-usage-shape: FAIL/);
});

test("反例b：历史实现含 process.env → exit 1", () => {
  const r = run(fixture({ history: "export const h = process.env.HOME;\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /不得读环境/);
});

test("反例c：聚合缺具名注解 → exit 1", () => {
  const r = run(fixture({ store: "const deletePromises = [];\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /具名注解/);
});

test("缺文件 fail-closed → exit 2（不读成通过/不达标）", () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-usage-shape-missing-"));
  mkdirSync(join(dir, "packages", "dsh-provider-usage", "src", "apply"), { recursive: true });
  writeFileSync(join(dir, APPLY_REL), APPLY_OK);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /::error::门禁故障（非判据结论）/);
    assert.match(r.stderr, /缺被测文件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--root 非目录 fail-closed → exit 2", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", join(tmpdir(), "no-such-dir-768")], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /::error::门禁故障（非判据结论）/);
});

test("真实仓库自跑 exit 0（只断言一致性，不写死形态）", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verify-provider-usage-shape: OK/);
});

test("接线：local-gate 的 pr 计划含该闸（标签与 args 耦合）", () => {
  const plan = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "gate", "local-gate.mjs"), "--tier", "pr", "--dry-run"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(
    plan.stdout,
    /\n {2}- verify-provider-usage-shape（provider-usage 形态锁[^\n]* {2}→ {2}node scripts\/gate\/verify-provider-usage-shape\.mjs$/m,
    "local-gate 的 cheapGlobal 缺该闸（或标签与 args 脱钩）：本地档看不到，本地绿而 CI 红的落差由此产生",
  );
});
