#!/usr/bin/env node
"use strict";

/**
 * vendored-binaries 门禁自测（#784 遗留 D 项 / 批 2b）。
 *
 * 判据轴是「会不会随发布物分发」，故本文件的核心用例是**把同一个二进制放到不同位置**：
 * 放进 `files` 白名单 ⇒ 必须登记；放进 `docs/`（不分发）⇒ 不登记也合法。把这条写死，
 * 是为了防「用扩展名或目录名白名单代替发布物面」的实现回潮——那种实现会在
 * `test/fixtures/*.bin` 上假红、又在真正 vendored 的二进制上假绿。
 *
 * 覆盖：分发面判定（files 字面/glob/缺省/退役目录）、登记表双向 fail-closed（未登记、
 * 哈希漂移、license 缺失/空/不在分发面、内容已非二进制、字段非法、重复、登记表不可读）、
 * CLI 退出码、pack-check 随包断言、以及**接线钉**（ci.yml 步骤 + local-gate cheapGlobal +
 * package.json script 三处必须同时存在——门禁没有执行点等于没有门禁）。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkVendoredTarball,
  distributionPaths,
  scanVendoredBinaries,
  sha256File,
  verifyVendoredBinaries,
} from "../lib/vendored-binaries-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "verify-vendored-binaries.mjs");
const PKG = "dsh-demo";
const BINARY = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const LICENSE_TEXT = "MIT License\n\nCopyright (c) 2026 Example\n";

const TMP = [];
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP.push(d);
  return d;
}
after(() => {
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
});

/** 造 fixture 库：`files` 为白名单（缺省=不写该字段，即 npm「整包」语义）。 */
function makeRoot({ files, tree = {}, manifest, pkgExtra = {} } = {}) {
  const root = mkTmp("vendored-root-");
  const pkgDir = join(root, "packages", PKG);
  mkdirSync(pkgDir, { recursive: true });
  const pkgJson = { name: "@wingsky-1/dsh-demo", version: "1.0.0", ...pkgExtra };
  if (files !== undefined) pkgJson.files = files;
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkgJson));
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(pkgDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (manifest) {
    mkdirSync(join(root, "scripts", "data"), { recursive: true });
    writeFileSync(join(root, "scripts", "data", "plugins-manifest.json"), JSON.stringify(manifest));
  }
  return root;
}

/** 登记表刻意放扫描面之外：治理数据不随 --root 漂移（与 forbid-* 的 --exemptions 同语义）。 */
function writeRegistry(entries) {
  const p = join(mkTmp("vendored-reg-"), "vendored-binaries.json");
  writeFileSync(p, JSON.stringify({ version: 1, entries }));
  return p;
}

/** 跑判定：entries 为函数时以 root 为参（取真实 sha256）；registryRaw 用于非法 JSON 用例。 */
function judge(spec) {
  const root = makeRoot(spec);
  const reg =
    spec.registryRaw !== undefined
      ? (() => {
          const p = join(mkTmp("vendored-reg-"), "vendored-binaries.json");
          writeFileSync(p, spec.registryRaw);
          return p;
        })()
      : writeRegistry(spec.entries === undefined ? [] : spec.entries(root));
  return { root, reg, result: verifyVendoredBinaries(root, { registryPath: reg }) };
}

/** 合法登记项（哈希取自 fixture 文件本身）。 */
function entryOf(root, rel, { licenseFile = `${rel}.LICENSE`, ...over } = {}) {
  return {
    path: `packages/${PKG}/${rel}`,
    sha256: sha256File(join(root, "packages", PKG, rel)),
    license: "MIT",
    source: "https://example.invalid/upstream@1.0.0",
    licenseFile: `packages/${PKG}/${licenseFile}`,
    ...over,
  };
}

const join2 = (p) => p.join("\n");

// ---------- 一、分发面判定：判据是「会不会随发布物分发」 ----------

test("正例：发布物面内无二进制 → 无问题", () => {
  const { result } = judge({
    files: ["lib", "README.md"],
    tree: { "lib/index.js": "export const a = 1\n", "README.md": "text\n" },
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.hits, 0);
});

test("反例：files 面内的二进制未登记 → 点名路径", () => {
  const { result } = judge({ files: ["lib"], tree: { "lib/tool.exe": BINARY } });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /未登记的裸二进制/);
  assert.match(result.problems[0], /packages\/dsh-demo\/lib\/tool\.exe/);
  assert.equal(result.hits, 1);
});

test("核心判据：同一二进制放在 docs/（不分发）→ 不登记也合法", () => {
  const { result } = judge({
    files: ["lib"],
    tree: { "lib/index.js": "text\n", "docs/tool.exe": BINARY },
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.hits, 0);
});

test("核心判据：二进制放在 test/fixtures 但 files 明确包含它 → 必须登记（不看目录名）", () => {
  const { result } = judge({
    files: ["lib", "test/fixtures"],
    tree: { "test/fixtures/sample.bin": BINARY },
  });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /test\/fixtures\/sample\.bin/);
});

test("files 用 glob：assets/**/*.bin 展开命中（子树遍历）", () => {
  const { result } = judge({
    files: ["lib", "assets/**/*.bin"],
    tree: { "assets/deep/nested/blob.bin": BINARY, "assets/note.md": "text\n" },
  });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /assets\/deep\/nested\/blob\.bin/);
});

test("files 用 glob：遍历根内的非匹配文件不算分发（glob 过滤不能只看遍历根）", () => {
  // 反例方向：遍历根 assets/ 下放一个后缀不合模式的二进制，它**不**随包分发（npm 按模式裁剪），
  // 若实现只把 glob 当作「遍历根」而不做 matchesGlob 过滤，这一格会假红 → 逼出逃生分支。
  const { result } = judge({
    files: ["assets/**/*.bin"],
    tree: { "assets/blob.exe": BINARY, "assets/ok.bin": BINARY },
  });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /assets\/ok\.bin/);
});

test("files 缺省（npm「整包」语义）：整包视为分发面，但 node_modules 除外", () => {
  const { result } = judge({
    tree: { "lib/tool.exe": BINARY, "node_modules/dep/thing.node": BINARY },
  });
  assert.equal(result.hits, 1);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /lib\/tool\.exe/);
});

// ---------- 一之二、npm 强制包含集：files 之外仍然随包分发的四种形态 ----------
// 只读 files 会把这四种判成「不分发」→ 假阴性。每条都用 `npm pack --dry-run` 实测过
// npm 确实打包该二进制（见提交信息），不是从 npm 文档猜的。

test("npm 强制包含：bin 指向的二进制在 files 之外也必须登记", () => {
  const { result } = judge({
    files: ["lib"],
    pkgExtra: { bin: { tool: "bin/tool.exe" } },
    tree: { "lib/index.js": "text\n", "bin/tool.exe": BINARY },
  });
  assert.equal(result.hits, 1);
  assert.match(join2(result.problems), /packages\/dsh-demo\/bin\/tool\.exe/);
});

test("npm 强制包含：main 指向的二进制在 files 之外也必须登记", () => {
  const { result } = judge({
    files: ["lib"],
    pkgExtra: { main: "native/loader.node" },
    tree: { "lib/index.js": "text\n", "native/loader.node": BINARY },
  });
  assert.equal(result.hits, 1);
  assert.match(join2(result.problems), /packages\/dsh-demo\/native\/loader\.node/);
});

test("npm 强制包含：bundledDependencies 子树里的二进制在 files 之外也必须登记", () => {
  const { result } = judge({
    files: ["lib"],
    pkgExtra: { dependencies: { dep: "1.0.0" }, bundledDependencies: ["dep"] },
    tree: {
      "lib/index.js": "text\n",
      "node_modules/dep/package.json": "{}\n",
      "node_modules/dep/addon.node": BINARY,
    },
  });
  assert.equal(result.hits, 1);
  assert.match(join2(result.problems), /packages\/dsh-demo\/node_modules\/dep\/addon\.node/);
});

test("npm 强制包含：根级 README*/LICENSE* 与 package.json 在面内，非根级同名文件不在", () => {
  const root = makeRoot({
    files: ["lib"],
    tree: {
      "lib/index.js": "text\n",
      "docs/README": "text\n",
      "README.bin": BINARY,
      LICENSE: BINARY,
    },
  });
  const surface = distributionPaths(join(root, "packages", PKG));
  for (const rel of ["package.json", "README.bin", "LICENSE"]) {
    assert.ok(surface.includes(rel), `${rel} 应随包分发`);
  }
  // 强制包含的 README/LICENSE 只认根级：`docs/` 不在 files 里，其 README 不随包分发
  assert.ok(!surface.includes("docs/README"), "非根级 README 不随包分发，算进来是多报");

  const result = verifyVendoredBinaries(root, { registryPath: writeRegistry([]) });
  assert.equal(result.hits, 2);
  assert.match(join2(result.problems), /README\.bin/);
  assert.match(join2(result.problems), /packages\/dsh-demo\/LICENSE/);
});

test("files 条目归一化：尾斜杠展开出的路径与登记项对得上（不产生双斜杠）", () => {
  // 不归一化时展开面里是 `lib//sub/tool.exe`，按规范路径登记的条目会被判「不在发布物面内」——
  // 门禁把正确动作判红，用户只能把登记表写成双斜杠来迁就实现。
  const { root, result } = judge({
    files: ["lib/"],
    tree: { "lib/sub/tool.exe": BINARY, "lib/sub/tool.exe.LICENSE": LICENSE_TEXT },
    entries: (r) => [entryOf(r, "lib/sub/tool.exe")],
  });
  assert.ok(
    distributionPaths(join(root, "packages", PKG)).includes("lib/sub/tool.exe"),
    "展开面里应是规范相对路径",
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.registered, 1);
});

test("files 条目归一化：前导 ./ 与尾斜杠并存仍归一化", () => {
  const { result } = judge({ files: ["./assets/"], tree: { "assets/blob.bin": BINARY } });
  assert.equal(result.hits, 1);
  assert.match(join2(result.problems), /packages\/dsh-demo\/assets\/blob\.bin/);
});

test("files 否定条目：`!` 命中的二进制不随包分发（npm 支持否定，多报会逼出逃生分支）", () => {
  const { result } = judge({
    files: ["assets", "!assets/secret.bin"],
    tree: { "assets/a.bin": BINARY, "assets/secret.bin": BINARY },
  });
  assert.equal(result.hits, 1);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /assets\/a\.bin/);
  assert.ok(!join2(result.problems).includes("secret.bin"), "被否定的文件不该要求登记");
});

test("files 否定条目：目录形态 `!dir` 排除整棵子树", () => {
  const { result } = judge({
    files: ["lib", "!lib/vendor"],
    tree: { "lib/a.exe": BINARY, "lib/vendor/b.exe": BINARY },
  });
  assert.equal(result.hits, 1);
  assert.match(result.problems[0], /lib\/a\.exe/);
});

test("files 否定条目：否定不覆盖 npm 强制包含集（实测 `!README.bin` 挡不住强制包含）", () => {
  const { result } = judge({
    files: ["lib", "!README.bin"],
    tree: { "lib/a.js": "text\n", "README.bin": BINARY },
  });
  assert.equal(result.hits, 1);
  assert.match(result.problems[0], /README\.bin/);
});

test("退役残留目录不参与扫描（manifest.retired）", () => {
  const root = makeRoot({
    files: ["lib"],
    tree: { "lib/index.js": "text\n" },
    manifest: {
      active: [PKG],
      standalone: [],
      retired: [{ name: "dsh-old", reason: "fixture" }],
      configSurfacesPending: [{ package: PKG, reason: "fixture", reviewBy: "2027-01-01" }],
    },
  });
  const oldDir = join(root, "packages", "dsh-old");
  mkdirSync(join(oldDir, "lib"), { recursive: true });
  writeFileSync(
    join(oldDir, "package.json"),
    JSON.stringify({ name: "@wingsky-1/dsh-old", files: ["lib"] }),
  );
  writeFileSync(join(oldDir, "lib", "legacy.exe"), BINARY);

  const result = verifyVendoredBinaries(root, { registryPath: writeRegistry([]) });
  assert.deepEqual(result.problems, []);
  assert.equal(result.hits, 0);
  assert.ok(
    result.scanned > 0,
    "活跃包仍在扫描面内（否则这条用例只是被「扫描面为空」拦下，没证明退役分支）",
  );
});

test("扫描面为空 → 判据前提不成立，不得当作零命中放行", () => {
  const root = mkTmp("vendored-empty-");
  mkdirSync(join(root, "packages"), { recursive: true });
  const result = verifyVendoredBinaries(root, { registryPath: writeRegistry([]) });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /发布物面为空/);
});

// ---------- 二、登记表双向 fail-closed ----------

test("正例：登记项齐备（哈希一致 + 许可文本随包）→ 无问题", () => {
  const { result } = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "lib/tool.exe.LICENSE": LICENSE_TEXT },
    entries: (r) => [entryOf(r, "lib/tool.exe")],
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.registered, 1);
});

test("反例：内容改一字节而登记表沿用旧哈希 → sha256 漂移被点出", () => {
  const root = makeRoot({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "lib/tool.exe.LICENSE": LICENSE_TEXT },
  });
  const before = entryOf(root, "lib/tool.exe");
  assert.deepEqual(
    verifyVendoredBinaries(root, { registryPath: writeRegistry([before]) }).problems,
    [],
  );
  writeFileSync(join(root, "packages", PKG, "lib", "tool.exe"), Buffer.from([...BINARY, 0x01]));
  const drifted = verifyVendoredBinaries(root, { registryPath: writeRegistry([before]) });
  assert.match(join2(drifted.problems), /sha256 漂移/);
  assert.match(join2(drifted.problems), new RegExp(before.sha256));
});

test("反例：登记项文件不存在 → 登记表与仓库脱钩", () => {
  const { result } = judge({
    files: ["lib"],
    tree: { "lib/index.js": "text\n" },
    entries: () => [
      {
        path: `packages/${PKG}/lib/gone.exe`,
        sha256: "a".repeat(64),
        license: "MIT",
        source: "https://example.invalid/x",
        licenseFile: `packages/${PKG}/lib/gone.exe.LICENSE`,
      },
    ],
  });
  assert.ok(join2(result.problems).includes("登记项文件不存在"));
});

test("反例：许可文本缺失 / 为空 / 不在分发面 → 三种都判红", () => {
  const missing = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY },
    entries: (r) => [entryOf(r, "lib/tool.exe")],
  });
  assert.match(join2(missing.result.problems), /license 文本不存在/);

  const empty = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "lib/tool.exe.LICENSE": "   \n" },
    entries: (r) => [entryOf(r, "lib/tool.exe")],
  });
  assert.match(join2(empty.result.problems), /为空文件/);

  // 许可放在 docs/（不分发）= vendored 了副本却只把许可留在仓库里，合规上等于没附
  const outside = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "docs/tool.exe.LICENSE": LICENSE_TEXT },
    entries: (r) => [entryOf(r, "lib/tool.exe", { licenseFile: "docs/tool.exe.LICENSE" })],
  });
  assert.match(join2(outside.result.problems), /不在发布物面内：vendored 了副本却没随包附许可文本/);
});

test("反例：登记项内容已不是二进制 / 不在分发面 → 登记表腐坏两个方向", () => {
  const text = judge({
    files: ["lib"],
    tree: { "lib/thing.txt": "plain text\n", "lib/thing.txt.LICENSE": LICENSE_TEXT },
    entries: (r) => [entryOf(r, "lib/thing.txt")],
  });
  assert.match(join2(text.result.problems), /内容已不是二进制/);

  const notShipped = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "lib/tool.exe.LICENSE": LICENSE_TEXT, "docs/keep.exe": BINARY },
    entries: (r) => [entryOf(r, "docs/keep.exe", { licenseFile: "lib/tool.exe.LICENSE" })],
  });
  assert.match(join2(notShipped.result.problems), /不在发布物面内（登记它不产生任何合规效果）/);
});

test("反例：字段缺失 / sha256 形态非法 / 重复登记 → 各报一次，不放大成噪声", () => {
  const shape = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "lib/tool.exe.LICENSE": LICENSE_TEXT },
    entries: (r) => {
      const e = entryOf(r, "lib/tool.exe");
      delete e.license;
      return [e];
    },
  });
  assert.equal(shape.result.problems.length, 1);
  assert.match(shape.result.problems[0], /字段缺失或非字符串：license/);

  // sha256 形态非法时只报形态问题：同一处错误不该再被报成一条「漂移」
  const badHash = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "lib/tool.exe.LICENSE": LICENSE_TEXT },
    entries: (r) => [entryOf(r, "lib/tool.exe", { sha256: "not-a-hash" })],
  });
  assert.equal(badHash.result.problems.length, 1);
  assert.match(badHash.result.problems[0], /sha256 形态非法/);

  const dup = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "lib/tool.exe.LICENSE": LICENSE_TEXT },
    entries: (r) => [entryOf(r, "lib/tool.exe"), entryOf(r, "lib/tool.exe")],
  });
  assert.match(join2(dup.result.problems), /重复登记/);
});

test("登记表不可读 → 抛错（判据不可执行，不得退化成零命中放行）", () => {
  const root = makeRoot({ files: ["lib"], tree: { "lib/tool.exe": BINARY } });
  assert.throws(
    () => verifyVendoredBinaries(root, { registryPath: join(root, "nope.json") }),
    /登记表不存在/,
  );
  assert.throws(
    () =>
      verifyVendoredBinaries(root, {
        registryPath: (() => {
          const p = join(mkTmp("vendored-reg-"), "broken.json");
          writeFileSync(p, "{ not json");
          return p;
        })(),
      }),
    /非法 JSON/,
  );
});

test("scanVendoredBinaries 只回发布物面内的二进制（排序）", () => {
  const root = makeRoot({
    files: ["lib", "assets"],
    tree: {
      "lib/b.exe": BINARY,
      "lib/a.exe": BINARY,
      "lib/readme.txt": "text\n",
      "docs/c.exe": BINARY,
    },
  });
  assert.deepEqual(scanVendoredBinaries(root), [
    "packages/dsh-demo/lib/a.exe",
    "packages/dsh-demo/lib/b.exe",
  ]);
});

// ---------- 三、pack-check 随包断言（tarball 面） ----------

test("pack-check：随包发布了二进制却没附许可文本 → 判红；清单覆盖 → 通过", () => {
  const tarballRoot = mkTmp("vendored-tar-");
  mkdirSync(join(tarballRoot, "lib"), { recursive: true });
  const entry = { path: `packages/${PKG}/lib/tool.exe` };

  // 二进制没进 tarball（被 files 裁剪）→ 发布物与登记表脱钩
  assert.match(join2(checkVendoredTarball(tarballRoot, `packages/${PKG}`, [entry])), /未随包发布/);

  writeFileSync(join(tarballRoot, "lib", "tool.exe"), BINARY);
  assert.match(
    join2(checkVendoredTarball(tarballRoot, `packages/${PKG}`, [entry])),
    /缺 lib\/THIRD-PARTY-LICENSES/,
  );

  writeFileSync(join(tarballRoot, "lib", "THIRD-PARTY-LICENSES"), "THIRD-PARTY LICENSES\n");
  assert.match(
    join2(checkVendoredTarball(tarballRoot, `packages/${PKG}`, [entry])),
    /未覆盖 vendored 二进制/,
  );

  writeFileSync(
    join(tarballRoot, "lib", "THIRD-PARTY-LICENSES"),
    `THIRD-PARTY LICENSES\n\n${entry.path} — MIT\n`,
  );
  assert.deepEqual(checkVendoredTarball(tarballRoot, `packages/${PKG}`, [entry]), []);

  // 别的包的登记项与本包无关
  assert.deepEqual(
    checkVendoredTarball(tarballRoot, `packages/${PKG}`, [
      { path: "packages/dsh-other/lib/x.exe" },
    ]),
    [],
  );
});

// ---------- 四、CLI 与真实仓库现状 ----------

test("CLI：正例 exit 0，反例 exit 1，登记表不可读 exit 2", () => {
  const clean = makeRoot({ files: ["lib"], tree: { "lib/index.js": "text\n" } });
  const ok = spawnSync(
    process.execPath,
    [SCRIPT, "--root", clean, "--registry", writeRegistry([])],
    { encoding: "utf8" },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PASS \| 发布物面内无未登记裸二进制/);

  const dirty = makeRoot({ files: ["lib"], tree: { "lib/tool.exe": BINARY } });
  const bad = spawnSync(
    process.execPath,
    [SCRIPT, "--root", dirty, "--registry", writeRegistry([])],
    { encoding: "utf8" },
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL \| 未登记的裸二进制/);
  assert.match(bad.stdout, /packages\/dsh-demo\/lib\/tool\.exe/);

  const unreadable = spawnSync(
    process.execPath,
    [SCRIPT, "--root", clean, "--registry", join(clean, "missing.json")],
    { encoding: "utf8" },
  );
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /判定不可执行/);
});

test("真实仓库：发布物面内零命中，登记表为空即合规", () => {
  const result = verifyVendoredBinaries(ROOT);
  assert.deepEqual(result.problems, []);
  assert.equal(result.registered, 0);
  assert.ok(result.scanned > 0, "扫描面不应为空");
});

// ---------- 五、接线钉：三个执行点必须同时存在 ----------

test("接线：ci.yml 步骤 + local-gate cheapGlobal + package.json script 三处同时在", () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(
    ci.includes("node scripts/gate/verify-vendored-binaries.mjs"),
    "ci.yml 缺执行点：门禁不进 CI 等于没有门禁",
  );
  const localGate = readFileSync(join(ROOT, "scripts", "gate", "local-gate.mjs"), "utf8");
  // 断言到 args 行而不是标签文字：只匹配 label 的话，把 args 换成别的闸仍然全绿
  // （实测变异 M15 就是这么活下来的）。
  assert.ok(
    localGate.includes('args: ["verify:vendored-binaries"]'),
    "local-gate.mjs 的 cheapGlobal 缺该闸：本地档看不到，本地绿而 CI 红的落差由此产生",
  );
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["verify:vendored-binaries"],
    "node scripts/gate/verify-vendored-binaries.mjs",
  );
  // pack-check 的调用点同样要钉：本文件其余用例直接调库函数，删掉 pack-check 里那段
  // 「最终 tarball 带了许可文本」的断言不会有任何用例变红（实测变异 M19）。
  const packCheck = readFileSync(join(ROOT, "scripts", "gate", "pack-check.ts"), "utf8");
  assert.ok(
    packCheck.includes("checkVendoredTarball(pkgRoot, `packages/${p}`, vendored)"),
    "pack-check 缺随包断言调用：源码面判据不覆盖最终发布物",
  );
  assert.ok(
    packCheck.includes("vendoredEntriesFor(ROOT, `packages/${p}`)"),
    "pack-check 未按包读取登记表",
  );
});
