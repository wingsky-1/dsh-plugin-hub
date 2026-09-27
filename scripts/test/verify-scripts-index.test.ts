#!/usr/bin/env node
/**
 * verify-scripts-index 自测（#733 计划项 3.3 E2）：索引存在性 + 引用即登记（棘轮）+ 解析口径。
 *
 * 为什么这几条：判据的价值全在「口径」上——小节目录怎么解析、模板条目怎么跳过、glob 引用
 * 要不要展开、被引用但不存在的路径算不算违规。每一条都写成一个用例，口径改动会先在这里红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "verify-scripts-index.mjs");

/**
 * 构造最小 fixture 仓库：`package.json` 引用一个 gate 脚本 + 一份索引。
 * files: [{ rel, content }]（相对仓库根；目录自动创建）
 * dirs: 只需目录、不需文件的路径（目录说明符的解析落点）。
 */
function fixture(files: Array<{ rel: string; content: string }>, dirs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "verify-scripts-index-"));
  for (const rel of dirs) mkdirSync(join(root, rel), { recursive: true });
  for (const { rel, content } of files) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const PKG = JSON.stringify({ scripts: { "demo:gate": "node scripts/gate/demo.mjs" } }, null, 2);
const INDEX = "## gate/（根门禁）\n\n- `gate/demo.mjs` — 演示门禁。\n";

function run(root: string) {
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("正例：被引用的脚本已登记 → exit 0", () => {
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: INDEX },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stdout, /verify-scripts-index: OK/);
});

test("棘轮：新增一个被调用点引用的脚本但未登记 → 红", () => {
  const r = run(
    fixture([
      {
        rel: "package.json",
        content: JSON.stringify({
          scripts: { a: "node scripts/gate/demo.mjs", b: "node scripts/gate/fresh.mjs" },
        }),
      },
      { rel: "scripts/README.md", content: INDEX },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
      { rel: "scripts/gate/fresh.mjs", content: "export const b = 1\n" },
    ]),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stderr, /被调用点引用但未登记进 scripts\/README\.md：scripts\/gate\/fresh\.mjs/);
});

test("判据 A：索引项指向不存在的文件 → 红（索引腐烂）", () => {
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      {
        rel: "scripts/README.md",
        content: `${INDEX}- \`gate/ghost.mjs\` — 已被删掉的脚本。\n`,
      },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
    ]),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stderr, /索引项不存在：scripts\/gate\/ghost\.mjs/);
});

test("判据 A：含 `<pkg>` 的模板条目跳过存在性检查", () => {
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      {
        rel: "scripts/README.md",
        content: `${INDEX}\n## 仓库根的派生生成物\n\n- \`stryker.conf.d/<pkg>-<segment>.json\` — 派生配置（模板条目）。\n`,
      },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
});

test("解析口径：`tools/` 小节相对 tools/ 解析（回归：lint 路径的假阳性）", () => {
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      {
        rel: "scripts/README.md",
        content: `${INDEX}\n## tools/lint/（lint 工具链）\n\n- \`lint/bin/lint.mjs\` — lint 入口。\n`,
      },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
      { rel: "tools/lint/bin/lint.mjs", content: "export const lint = 1\n" },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
});

test("引用面口径：glob 引用不展开（测试文件按命名约定发现）", () => {
  const r = run(
    fixture([
      {
        rel: "package.json",
        content: JSON.stringify({
          scripts: {
            gate: "node scripts/gate/demo.mjs",
            tests: "node --test scripts/test/*.test.ts",
          },
        }),
      },
      { rel: "scripts/README.md", content: INDEX },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
      { rel: "scripts/test/fresh.test.ts", content: "export const t = 1\n" },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
});

test("引用面口径：被引用但文件不存在（历史注记/用法示例）不参与判据", () => {
  const r = run(
    fixture([
      {
        rel: "package.json",
        content: JSON.stringify({
          scripts: { gate: "node scripts/gate/demo.mjs" },
          note: "早期实现见 scripts/test/retired-bridge.cjs（已退役）",
        }),
      },
      { rel: "scripts/README.md", content: INDEX },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
});

test("相对 import 臂：被相对 import 指向的脚本未登记 → 红（只认字面前缀时它是隐形的）", () => {
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: INDEX },
      {
        rel: "scripts/gate/demo.mjs",
        content: 'import { exitCode } from "../lib/exit-code.mjs";\nexport const a = exitCode;\n',
      },
      { rel: "scripts/lib/exit-code.mjs", content: "export const exitCode = 0;\n" },
    ]),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(
    r.stderr,
    /被调用点引用但未登记进 scripts\/README\.md：scripts\/lib\/exit-code\.mjs/,
  );
});

test("相对 import 臂：目标已登记 → exit 0，且目录说明符不展开成 index 文件", () => {
  const r = run(
    fixture(
      [
        { rel: "package.json", content: PKG },
        { rel: "scripts/README.md", content: `${INDEX}- \`lib/exit-code.mjs\` — 退出码常量库。\n` },
        {
          rel: "scripts/gate/demo.mjs",
          content:
            'import { exitCode } from "../lib/exit-code.mjs";\nimport { a } from "../lib/pkg";\nexport const b = exitCode + a;\n',
        },
        { rel: "scripts/lib/exit-code.mjs", content: "export const exitCode = 0;\n" },
        { rel: "scripts/lib/pkg/index.ts", content: "export const a = 1;\n" },
      ],
      ["scripts/lib/pkg"],
    ),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stdout, /verify-scripts-index: OK/);
});

test("相对 import 臂：说明符按所在文件解析（同名串在不同深度指向不同目标）", () => {
  // 同一串 "../lib/x.mjs"：`scripts/gate/` 下解析到 scripts/lib/x.mjs（已登记），
  // `scripts/build/nested/` 下解析到 scripts/build/lib/x.mjs（未登记）。按基名匹配或按
  // 仓库根解析的实现会把两者混同——判红必须点名后者，且不得把前者误报成未登记。
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: `${INDEX}- \`lib/x.mjs\` — 顶层同名库。\n` },
      {
        rel: "scripts/gate/demo.mjs",
        content: 'import { x } from "../lib/x.mjs";\nexport const a = x;\n',
      },
      {
        rel: "scripts/build/nested/builder.mjs",
        content: 'import { x } from "../lib/x.mjs";\nexport const b = x;\n',
      },
      { rel: "scripts/lib/x.mjs", content: "export const x = 1;\n" },
      { rel: "scripts/build/lib/x.mjs", content: "export const x = 2;\n" },
    ]),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stderr, /未登记进 scripts\/README\.md：scripts\/build\/lib\/x\.mjs/);
  assert.doesNotMatch(r.stderr, /scripts\/lib\/x\.mjs/);
});

test("相对 import 臂：解析后不存在的目标（判据自造夹具串）不参与判据", () => {
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: INDEX },
      {
        rel: "scripts/gate/demo.mjs",
        content: 'import { x } from "../lib/ghost.mjs";\nexport const a = x;\n',
      },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
});

test("相对 import 臂：指向测试文件的目标按命名约定免登记（排除的是被引用方）", () => {
  // 排除面只作用在被引用方：测试文件自身不要求登记，但测试作为**引用源**仍计入——
  // 故 demo.mjs 这条 import 照常生效（它已登记），测试文件不判红。
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: INDEX },
      { rel: "scripts/gate/demo.mjs", content: 'import "../test/demo.test.ts";\n' },
      {
        rel: "scripts/test/demo.test.ts",
        content: 'import { a } from "../gate/demo.mjs";\nexport const t = a;\n',
      },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
});

test("fail-closed：索引不可读 → exit 2 且统一故障注解包含原因", () => {
  const r = run(fixture([]));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^::error::门禁故障（非判据结论）：verify-scripts-index: 索引不可读/m);
  assert.ok(r.stderr.includes("scripts/README.md"), r.stderr);
  assert.match(r.stderr, /ENOENT/);
  assert.equal(r.stdout, "");
});

test("fail-closed：索引里没有任何条目（解析口径与文档结构脱节）→ exit 2", () => {
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: "没有任何列表项的说明文档。\n" },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
    ]),
  );
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^::error::门禁故障（非判据结论）：verify-scripts-index:/m);
  assert.match(r.stderr, /没有任何 .* 形态条目/);
});

test("fail-closed：引用面解析为空（提取口径失效，不是「没有引用」）→ exit 2", () => {
  const r = run(
    fixture([
      { rel: "package.json", content: JSON.stringify({ scripts: { a: "echo hi" } }) },
      { rel: "scripts/README.md", content: INDEX },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1\n" },
    ]),
  );
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^::error::门禁故障（非判据结论）：verify-scripts-index:/m);
  assert.match(r.stderr, /引用面解析为空/);
});

test("本仓真实快照：索引与引用面一致 → exit 0，且报告面被打印", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stdout, /索引条目 \d+ 条全部存在，引用面 \d+ 条全部已登记/);
  assert.match(r.stdout, /未被引用且未登记 \d+ 个——仅报告，不判红/);
});

/**
 * #875 S3 的两个实证盲区：只被相对 import 指向的库（`dir-imports-spec.ts` 只被单测引用），
 * 在判据改前对引用面隐形——从索引删掉它们，判据不响。
 */
const BLIND_SPOT_ENTRIES = ["lib/dir-imports-spec.ts", "lib/shared-dts-lib.ts"];

test("反向验证（本仓真实快照）：把两个盲区目标的登记行删掉 → 门禁响", () => {
  const realIndex = readFileSync(join(ROOT, "scripts", "README.md"), "utf8");
  for (const entry of BLIND_SPOT_ENTRIES) {
    assert.ok(realIndex.includes(`\`${entry}\``), `盲区目标必须在索引里登记：${entry}`);
  }
  const stripped = realIndex
    .split("\n")
    .filter((line) => !BLIND_SPOT_ENTRIES.some((entry) => line.includes(`\`${entry}\``)))
    .join("\n");
  // 索引副本落 mkdtemp 隔离目录：仓内不得留下测试产物。--index 相对 root 解析，故传
  // 指向隔离目录的相对路径，仓内一个字节都不写。
  const dir = mkdtempSync(join(tmpdir(), "verify-scripts-index-real-"));
  const indexPath = join(dir, "README.md");
  writeFileSync(indexPath, stripped);
  try {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--root", ROOT, "--index", relative(ROOT, indexPath)],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /::error::门禁故障/);
    for (const entry of BLIND_SPOT_ENTRIES) {
      assert.match(
        r.stderr,
        new RegExp(`未登记进 [^：]+：scripts/${entry.replace(".", "\\.")}`),
        `删掉 ${entry} 的登记后判据必须响`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
