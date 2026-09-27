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
  // 同一串 "../lib/x.mjs" 出现在两个不同深度的文件里：scripts/gate/demo.mjs 解析到
  // scripts/lib/x.mjs（**已登记**），scripts/build/nested/builder.mjs 解析到
  // scripts/build/lib/x.mjs（**未登记**）。判红必须**只**点名后者。
  // 为什么摆成「三个同名、两个是真实目标、一个无人指向」（复核 P2-2：原夹具两种实现
  // 同判，全绿）：
  //   · 按仓库根/基名直接拼的实现 -> 目标不存在，被存在性过滤吃掉 => rc=0，被 status
  //     断言判死；
  //   · 「扫 scripts/ 下所有与说明符同基名的文件」的实现 -> 把**无人指向**的
  //     scripts/release/x.mjs 也算成引用 => 多点一个名字，被下面 doesNotMatch 判死；
  //   · 只有「按所在文件解析」的实现恰好只点 build/lib/x.mjs 一个。
  // 已登记的 scripts/lib/x.mjs 是真实目标且已登记，任何实现都不得点名它（第二道
  // doesNotMatch），这条同时钉住「不误报已登记项」。
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: `${INDEX}- \`lib/x.mjs\` — 已登记的同名库。\n` },
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
      // 同基名但**无任何说明符指向**（正确实现不得把它算成引用）
      { rel: "scripts/release/x.mjs", content: "export const x = 3;\n" },
    ]),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  // 只点名 build/lib/x.mjs：已登记项与「无人指向的同基名文件」都不得出现。
  assert.match(r.stderr, /未登记进 scripts\/README\.md：scripts\/build\/lib\/x\.mjs/);
  assert.doesNotMatch(r.stderr, /未登记进 [^\n]*：scripts\/lib\/x\.mjs/);
  assert.doesNotMatch(r.stderr, /未登记进 [^\n]*：scripts\/release\/x\.mjs/);
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

test("相对 import 臂：指向测试文件的目标免登记（排除的是被引用方）", () => {
  // 被引用方是测试文件 ⇒ 免登记。判红与不判红要能分辨方向，故这里让 demo.mjs 反过来
  // import 测试文件：测试文件作为**目标**免登记（期望 rc=0），而它作为**源**对
  // gate/demo.mjs 的引用照常生效——gate/demo.mjs 已登记，故不判红。若把排除挪到引用方
  // （即测试文件整体不参与扫描），本用例仍会绿，所以方向由下面「源侧仍计入」那条
  // 独立钉住，不靠本条自证。
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

test("new URL 臂：运行时读文件的相对目标未登记 → 红（不是 import 面却是真依赖）", () => {
  // 复核 P1-1：`new URL` 不带 import 关键词，前两条臂都读不到，`data/plugin-row-migration.json`
  // 长期未登记而门禁不响——就是这类活假绿。这条用例是第三臂存在的理由。
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: INDEX },
      {
        rel: "scripts/gate/demo.mjs",
        content:
          'import { readFileSync } from "node:fs";\nconst d = readFileSync(new URL("../data/rows.json", import.meta.url), "utf8");\nexport const a = d;\n',
      },
      { rel: "scripts/data/rows.json", content: "{}\n" },
    ]),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stderr, /被调用点引用但未登记进 scripts\/README\.md：scripts\/data\/rows\.json/);
});

test("new URL 臂：目标已登记 → exit 0；解析出仓库根等非 scripts/ 目标不参与", () => {
  // `new URL("../..", import.meta.url)` 解析到仓库根，不在 scripts/ 下，不归本判据。
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: `${INDEX}- \`data/rows.json\` — 迁移映射数据。\n` },
      {
        rel: "scripts/gate/demo.mjs",
        content:
          'import { readFileSync } from "node:fs";\nconst root = new URL("../..", import.meta.url);\nconst d = readFileSync(new URL("../data/rows.json", import.meta.url), "utf8");\nexport const a = [root.href, d];\n',
      },
      { rel: "scripts/data/rows.json", content: "{}\n" },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stdout, /verify-scripts-index: OK/);
});

test("引用面口径：glob 说明符不展开（相对臂使该闸承重，删除即判红）", () => {
  // 复核 P3-2：字面臂的正则字符类不含 `*`，glob 在那条臂上根本匹配不出，`*` 闸因此
  // 曾是不可达分支；相对臂的说明符类允许 `*`，它第一次变得可达并承重，所以要钉住。
  // 夹具让解析结果**真的存在**（文件名里带 `*`，Linux 允许）：正常实现被 `*` 闸挡下
  // => rc=0；删掉 `*` 闸则该文件计入引用面且未登记 => rc=1。只写「目标不存在」的夹具
  // 会被存在性过滤兜住，删闸仍绿，钉不住。
  //
  // win32 早退（本仓 test:scripts 里第一处平台条件分支）：`*` 属 Windows 文档化的
  // 保留字符集，「含 `*` 且存在」的文件 / 目录 / symlink 三条构造路都不通，win32 上
  // 原理上造不出本形态。**这不是 `skip` 掩盖失败**：夹具在此早退，不做任何替代断言，
  // 因为本形态在 win32 根本不存在；也**不是判据正确性问题**——门禁在 CI 全部
  // ubuntu-latest 执行，glob 闸在所有实际执行环境里都被验证，覆盖限制只针对
  // Windows 本地跑 test:scripts。维护者在意 Windows 可跑，但仅限于已有 win32 适配
  // 覆盖到的场景；此条是**已知且接受的覆盖限制**，不是「已解决」。
  if (process.platform === "win32") return;
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: INDEX },
      {
        rel: "scripts/gate/demo.mjs",
        content: 'import { x } from "../lib/star*.mjs";\nexport const a = x;\n',
      },
      { rel: "scripts/lib/star*.mjs", content: "export const x = 1;\n" },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(r.stdout, /verify-scripts-index: OK/);
});

test("相对 import 臂：测试文件作为**引用源**仍计入（排除只作用在被引用方）", () => {
  // 方向的反向钉子：测试文件 import 了一个**未登记**的库，判据必须判红——证明
  // `scripts/test/**` 免登记是「被引用方」的豁免，不是「测试文件不参与扫描」。
  // 把排除挪到引用方（测试文件整体跳过）会让本用例转绿，故它才是方向的真正守卫。
  const r = run(
    fixture([
      { rel: "package.json", content: PKG },
      { rel: "scripts/README.md", content: INDEX },
      { rel: "scripts/gate/demo.mjs", content: "export const a = 1;\n" },
      {
        rel: "scripts/test/uses.test.ts",
        content: 'import { t } from "../lib/only-test-used.ts";\nexport const u = t;\n',
      },
      { rel: "scripts/lib/only-test-used.ts", content: "export const t = 1;\n" },
    ]),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /::error::门禁故障/);
  assert.match(
    r.stderr,
    /被调用点引用但未登记进 scripts\/README\.md：scripts\/lib\/only-test-used\.ts/,
  );
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
 * #875 S3 的实证盲区（改判据前对引用面隐形，从索引删掉它们门禁不响）：
 *   - `lib/dir-imports-spec.ts`：只被相对 import（且只被单测）指向；
 *   - `lib/shared-dts-lib.ts`：被 pack-check 生产判据相对 import 指向；
 *   - `data/plugin-row-migration.json`：被 `new URL(…, import.meta.url)` 运行时读文件
 *     指向（复核 P1-1 的活假绿，判据当时无感）。
 */
const BLIND_SPOT_ENTRIES = [
  "lib/dir-imports-spec.ts",
  "lib/shared-dts-lib.ts",
  "data/plugin-row-migration.json",
];

test("反向验证（本仓真实快照）：把三个盲区目标的登记行删掉 → 门禁响", () => {
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
