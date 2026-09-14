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
 * 覆盖：分发面判定（files 字面/glob/缺省/退役目录/否定条目/尾斜杠归一化/npm 强制包含集，
 * 含一条**已登记偏离**：无斜杠否定不按 npm 的 matchBase 语义排除任意深度）、
 * 内容嗅探窗口（头段 512 字节边界、文件头形态、**只在尾段出现的 NUL**、UTF-8 字符边界、
 * 纯文本与带 BOM 的 UTF-16 不假红）、登记表双向 fail-closed（未登记、
 * 哈希漂移、license 缺失/空/不在分发面、内容已非二进制、字段非法/kind 非法、重复、登记表不可读）、
 * 第一方资产形态（first-party 只需 path+sha256+kind）、非普通文件（软链目录）与未构建声明条目的
 * 报告、CLI 退出码与未登记命中的 sha256、pack-check 随包断言、以及**接线钉**（ci.yml 未被注释的
 * 执行步骤 + local-gate --dry-run 计划里的命令 + package.json script——门禁没有执行点等于没有门禁）。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
/** 第一方资产用真实形态的样本：1x1 PNG（图形资源是最典型的第一方二进制资产）。 */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6300010000050001",
  "hex",
);

const TMP: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP.push(d);
  return d;
}
after(() => {
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
});

/** fixture 库的构造参数（judge 在它之上再加「登记表怎么来」）。 */
interface RootSpec {
  files?: string[];
  tree?: Record<string, string | Buffer>;
  manifest?: unknown;
  pkgExtra?: Record<string, unknown>;
}

/** 造 fixture 库：`files` 为白名单（缺省=不写该字段，即 npm「整包」语义）。 */
function makeRoot({ files, tree = {}, manifest, pkgExtra = {} }: RootSpec = {}) {
  const root = mkTmp("vendored-root-");
  const pkgDir = join(root, "packages", PKG);
  mkdirSync(pkgDir, { recursive: true });
  const pkgJson: Record<string, unknown> = {
    name: "@wingsky-1/dsh-demo",
    version: "1.0.0",
    ...pkgExtra,
  };
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
function writeRegistry(entries: unknown[]): string {
  const p = join(mkTmp("vendored-reg-"), "vendored-binaries.json");
  writeFileSync(p, JSON.stringify({ version: 1, entries }));
  return p;
}

/** judge 的入参：fixture 参数 + 「登记表怎么来」（entries 取真实 sha256 / registryRaw 喂非法 JSON）。 */
interface JudgeSpec extends RootSpec {
  registryRaw?: string;
  entries?: (root: string) => unknown[];
}

/** 跑判定：entries 为函数时以 root 为参（取真实 sha256）；registryRaw 用于非法 JSON 用例。 */
function judge(spec: JudgeSpec) {
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
function entryOf(
  root: string,
  rel: string,
  {
    licenseFile = `${rel}.LICENSE`,
    ...over
  }: { licenseFile?: string } & Record<string, unknown> = {},
) {
  return {
    path: `packages/${PKG}/${rel}`,
    sha256: sha256File(join(root, "packages", PKG, rel)),
    license: "MIT",
    source: "https://example.invalid/upstream@1.0.0",
    licenseFile: `packages/${PKG}/${licenseFile}`,
    ...over,
  };
}

const join2 = (p: string[]): string => p.join("\n");

/** 合法第一方登记项：只有 path/sha256/kind——自有二进制资产没有第三方许可义务。 */
function firstPartyOf(root: string, rel: string) {
  return {
    path: `packages/${PKG}/${rel}`,
    sha256: sha256File(join(root, "packages", PKG, rel)),
    kind: "first-party",
  };
}

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

test("npm 强制包含：bin 的值是数组时逐个并入分发面", () => {
  const { result } = judge({
    files: ["lib"],
    pkgExtra: { bin: { tool: ["bin/a.exe", "bin/b.exe"] } },
    tree: { "lib/index.js": "text\n", "bin/a.exe": BINARY, "bin/b.exe": BINARY },
  });
  assert.equal(result.hits, 2);
});

test("npm 强制包含：bundleDependencies 别名同样展开为分发面", () => {
  const { result } = judge({
    files: ["lib"],
    pkgExtra: { dependencies: { dep: "1.0.0" }, bundleDependencies: ["dep"] },
    tree: { "lib/index.js": "text\n", "node_modules/dep/addon.node": BINARY },
  });
  assert.equal(result.hits, 1);
  assert.match(join2(result.problems), /packages\/dsh-demo\/node_modules\/dep\/addon\.node/);
});

test("npm 强制包含：声明的 bin/main 在磁盘上不存在时不进分发面（不制造幻影路径）", () => {
  // 未构建或写错路径的 bin|main 不是分发物；把它当成分发面成员，扫描面与 NOTE 报告都会指向
  // 一个不存在的路径。
  const root = makeRoot({
    files: ["lib"],
    pkgExtra: { bin: { tool: "bin/gone.exe" }, main: "native/gone.node" },
    tree: { "lib/index.js": "text\n" },
  });
  const surface = distributionPaths(join(root, "packages", PKG));
  assert.ok(!surface.includes("bin/gone.exe"));
  assert.ok(!surface.includes("native/gone.node"));
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

test("已登记偏离：无斜杠否定（`!*.exe`）不按 npm 的 matchBase 语义排除任意深度", () => {
  // npm 实测：`files:["lib","!*.exe"]` 跑 `npm pack --dry-run --json` 时 lib/top.exe 与
  // lib/sub/tool.exe 都被排除（npm 对无斜杠模式按 basename 匹配任意深度）；本实现用
  // path.matchesGlob，`*.exe` 不跨 `/`（只有 `**/*.exe` 才跨），故两者都仍在分发面内 ⇒ 多报。
  // 为什么不照 npm 实现：过匹配会把「多报」翻成静默漏报，而漏报正是本门禁存在的理由。
  // 将来真有包用上无斜杠否定，先按该包的 `npm pack --dry-run` 实测口径实现，并补一条正例。
  const { result } = judge({
    files: ["lib", "!*.exe"],
    tree: { "lib/a.txt": "text\n", "lib/top.exe": BINARY, "lib/sub/tool.exe": BINARY },
  });
  assert.equal(result.hits, 2, "今天的口径是「一条都不排除」——这是有意登记的偏离");
  assert.match(join2(result.problems), /packages\/dsh-demo\/lib\/top\.exe/);
  assert.match(join2(result.problems), /packages\/dsh-demo\/lib\/sub\/tool\.exe/);
});

// ---------- 一之三、内容嗅探窗口：二进制不在前 512 字节也不能漏 ----------
// isbinaryfile 只看喂入缓冲的前 512 字节（MAX_BYTES），故「前 512 字节纯 ASCII、二进制在其后」
// 是实测过的假阴性；用例分别锚住 512 字节边界、文件头形态与「头段采样之外的尾段」。

test("内容嗅探：前 512 字节纯 ASCII、其后才是 NUL → 仍判为二进制", () => {
  const payload = Buffer.concat([Buffer.alloc(512, 0x41), Buffer.alloc(512, 0)]);
  const { result } = judge({ files: ["lib"], tree: { "lib/payload.bin": payload } });
  assert.equal(result.hits, 1, "512 字节窗口外的 NUL 必须被尾部采样命中");
  assert.match(result.problems[0], /packages\/dsh-demo\/lib\/payload\.bin/);
});

test("内容嗅探：NUL 只落在尾段（>8 KiB 纯 ASCII 前缀）也必须命中——头段哨兵的盲区", () => {
  // 头段采样只有 8 KiB：12 KiB 纯 ASCII 前缀 + 尾部 NUL 的文件，头段与 isbinaryfile 的 512
  // 字节窗口都看不见二进制，**只有尾段采样能发现它**。删掉尾段就是静默漏报（合规缺口）——
  // 实测把尾段换成空缓冲时，此前整套用例全绿。
  const payload = Buffer.concat([
    Buffer.alloc(12 * 1024, 0x41),
    Buffer.from([0]),
    Buffer.alloc(512, 0x41),
  ]);
  const { result } = judge({ files: ["lib"], tree: { "lib/payload.bin": payload } });
  assert.equal(result.hits, 1, "头段之外的 NUL 必须被尾段采样命中");
  assert.match(result.problems[0], /packages\/dsh-demo\/lib\/payload\.bin/);
});

test("内容嗅探：512 字节 ASCII + 文件头 + 大段 NUL → 仍判为二进制", () => {
  const payload = Buffer.concat([Buffer.alloc(512, 0x41), BINARY, Buffer.alloc(4096, 0)]);
  const { result } = judge({ files: ["lib"], tree: { "lib/payload.bin": payload } });
  assert.equal(result.hits, 1);
  assert.match(result.problems[0], /packages\/dsh-demo\/lib\/payload\.bin/);
});

test("内容嗅探：纯 ASCII 文本不因放大采样窗口而假红", () => {
  const text = Buffer.from("a".repeat(20 * 1024));
  const { result } = judge({ files: ["lib"], tree: { "lib/plain.txt": text } });
  assert.equal(result.hits, 0);
  assert.deepEqual(result.problems, []);
});

test("内容嗅探：带 BOM 的 UTF-16 文本不因 NUL 预筛而假红", () => {
  // NUL 预筛把采样段整个过一遍，但带 BOM 的 UTF-16 文本自身就含 NUL；isbinaryfile 对 BOM
  // 有豁免，预筛必须口径一致，否则纯文本被要求按「裸二进制」登记。
  const text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文文本内容\n", "utf16le")]);
  const { result } = judge({ files: ["lib"], tree: { "lib/utf16.txt": text } });
  assert.equal(result.hits, 0);
  assert.deepEqual(result.problems, []);
});

test("内容嗅探：采样块起点落在 UTF-8 字符边界（截断多字节序列会被误判成二进制）", () => {
  // 尾段起点落在字符中间时，isbinaryfile 会把截断的多字节序列计成可疑字节，纯中文文本
  // （本仓生成的 `.d.ts` 就是）被判成二进制。这里直接钉住喂给嗅探器的采样块起点，不依赖
  // isbinaryfile 的内容启发式（那让用例变得碰运气）。
  const root = makeRoot({
    files: ["lib"],
    tree: { "lib/zh.txt": Buffer.from("中".repeat(400)) }, // 1200 字节；尾段起点 176 落在字符内部
  });
  const starts: number[] = [];
  scanVendoredBinaries(root, {
    isBinary: (buf) => {
      starts.push(buf[0]);
      return false;
    },
  });
  assert.ok(starts.length >= 2, "头尾两段都要喂给嗅探器");
  assert.ok(
    starts.every((b) => (b & 0xc0) !== 0x80),
    "采样块不得以 UTF-8 续字节开头",
  );
});

test("未构建的工作副本：files 声明但磁盘不存在的条目只报告、不判红", () => {
  const { result } = judge({ files: ["lib", "README.md"], tree: { "README.md": "text\n" } });
  assert.deepEqual(result.problems, []);
  assert.ok(
    result.reports.some((r) => r.includes("packages/dsh-demo/lib")),
    "未构建的 lib/ 必须报告出来：扫描面静默变小是事实，不能装作没发生",
  );
});

test("CLI：声明但缺失的条目打印 NOTE 且 exit 0（报告不是判据）", () => {
  const root = makeRoot({ files: ["lib", "README.md"], tree: { "README.md": "text\n" } });
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root, "--registry", writeRegistry([])], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NOTE \| .*packages\/dsh-demo\/lib/);
});

test("发布物面内的软链目录：给出可读文案而不是 exit 2（无法嗅探不等于环境错误）", () => {
  // walkFiles 按 dirent 分类，符号链接既不是目录也不会被递归，于是它以「文件」身份进入
  // 发布物面；嗅探器对目录抛 `Path provided was not a file!`，整条判据退化成 exit 2。
  const root = makeRoot({
    files: ["lib"],
    tree: { "lib/index.js": "text\n", "real/x.js": "text\n" },
  });
  symlinkSync(
    join(root, "packages", PKG, "real"),
    join(root, "packages", PKG, "lib", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.deepEqual(scanVendoredBinaries(root), [], "软链目录不参与嗅探，且 scan 不抛错");

  const r = spawnSync(process.execPath, [SCRIPT, "--root", root, "--registry", writeRegistry([])], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `不该退化成 exit 2：${r.stderr}`);
  assert.match(r.stdout, /NOTE \| .*lib\/linked.*非普通文件/);
});

test("登记项指向非普通文件（软链目录）→ 判红并给出可读文案", () => {
  const root = makeRoot({ files: ["lib"], tree: { "real/x.js": "text\n" } });
  mkdirSync(join(root, "packages", PKG, "lib"), { recursive: true });
  symlinkSync(
    join(root, "packages", PKG, "real"),
    join(root, "packages", PKG, "lib", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = verifyVendoredBinaries(root, {
    registryPath: writeRegistry([
      {
        path: `packages/${PKG}/lib/linked`,
        sha256: "a".repeat(64),
        license: "MIT",
        source: "https://example.invalid/x",
        licenseFile: `packages/${PKG}/lib/linked.LICENSE`,
      },
    ]),
  });
  assert.match(join2(result.problems), /登记项不是普通文件/);
});

test("退役残留目录不参与扫描（manifest.retired）", () => {
  const root = makeRoot({
    files: ["lib"],
    tree: { "lib/index.js": "text\n" },
    manifest: {
      active: [PKG],
      standalone: [],
      retired: [{ name: "dsh-old", reason: "fixture" }],
      configSurfaces: [{ package: PKG, surface: "none", reason: "fixture" }],
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

// ---------- 二之二、登记项类别：第一方资产 vs 第三方副本 ----------

test("first-party 资产：只给 path+sha256+kind 即合规（不必伪造 source/license）", () => {
  const { result } = judge({
    files: ["lib"],
    tree: { "lib/logo.png": PNG },
    entries: (r) => [firstPartyOf(r, "lib/logo.png")],
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.registered, 1);
});

test("first-party 资产：sha256 仍是硬绑定，内容漂移判红", () => {
  const root = makeRoot({ files: ["lib"], tree: { "lib/logo.png": PNG } });
  const before = firstPartyOf(root, "lib/logo.png");
  assert.deepEqual(
    verifyVendoredBinaries(root, { registryPath: writeRegistry([before]) }).problems,
    [],
  );
  writeFileSync(join(root, "packages", PKG, "lib", "logo.png"), Buffer.from([...PNG, 0x01]));
  const drifted = verifyVendoredBinaries(root, { registryPath: writeRegistry([before]) });
  assert.match(join2(drifted.problems), /sha256 漂移/);
});

test("first-party 资产：即使带了 licenseFile 也不按第三方副本审许可随包", () => {
  // 第一方资产没有第三方许可义务；若这里退化成「凡有 licenseFile 就查」，一个从 vendored
  // 条目改过来的第一方条目会因为残留字段被判红，正确动作又变成删字段迁就实现。
  const { result } = judge({
    files: ["lib"],
    tree: { "lib/logo.png": PNG },
    entries: (r) => [
      { ...firstPartyOf(r, "lib/logo.png"), licenseFile: `packages/${PKG}/lib/gone.LICENSE` },
    ],
  });
  assert.deepEqual(result.problems, []);
});

test("登记项 kind 非法 → 判红（不认识的类别不得静默当 vendored 放过）", () => {
  const { result } = judge({
    files: ["lib"],
    tree: { "lib/tool.exe": BINARY, "lib/tool.exe.LICENSE": LICENSE_TEXT },
    entries: (r) => [{ ...entryOf(r, "lib/tool.exe"), kind: "third-party" }],
  });
  assert.match(join2(result.problems), /kind 非法：third-party/);
});

test("first-party 资产不进 pack-check 的第三方许可覆盖断言", () => {
  const tarballRoot = mkTmp("vendored-firstparty-tar-");
  mkdirSync(join(tarballRoot, "lib"), { recursive: true });
  writeFileSync(join(tarballRoot, "lib", "logo.png"), PNG);
  const entry = { path: `packages/${PKG}/lib/logo.png`, kind: "first-party" };
  assert.deepEqual(checkVendoredTarball(tarballRoot, `packages/${PKG}`, [entry]), []);
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
      // 刻意删掉 license 来喂「字段缺失」：登记项在这里当可变字典用，断言的是实现对该字段的判断
      const e: Record<string, unknown> = entryOf(r, "lib/tool.exe");
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
  // 与 collect-licenses 的 vendoredSection 同格式：两行 = 夹住段头，许可正文在其后
  const licenseList = (body: string): string =>
    `THIRD-PARTY LICENSES\n\n${"=".repeat(69)}\nvendored 二进制：${entry.path}\n` +
    `MIT — 来源：https://example.invalid/upstream@1.0.0\n${"=".repeat(69)}\n\n${body}\n`;

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

  // 只有段头字符串、正文为空：`lic.includes(path)` 会通过，等于没断言「许可随包」
  writeFileSync(join(tarballRoot, "lib", "THIRD-PARTY-LICENSES"), licenseList("   "));
  assert.match(
    join2(checkVendoredTarball(tarballRoot, `packages/${PKG}`, [entry])),
    /正文为空（段头字符串不等于附了许可文本）/,
  );

  writeFileSync(join(tarballRoot, "lib", "THIRD-PARTY-LICENSES"), licenseList("MIT License text"));
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

  // 空值按参数错误处理（复用 exemption-gate 的取值实现后仍须 fail-closed）
  const blank = spawnSync(process.execPath, [SCRIPT, "--root=", "--registry", writeRegistry([])], {
    encoding: "utf8",
  });
  assert.equal(blank.status, 2);
  assert.match(blank.stderr, /--root 取值非法/);
});

test("CLI：未登记的命中直接打印 sha256（登记表 note 的「先跑门禁取哈希」才成立）", () => {
  const root = makeRoot({ files: ["lib"], tree: { "lib/tool.exe": BINARY } });
  const expected = sha256File(join(root, "packages", PKG, "lib", "tool.exe"));
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root, "--registry", writeRegistry([])], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.ok(
    r.stdout.includes(expected),
    "未登记命中必须给出可直接登记的 sha256，否则用户只能自己另算",
  );
});

test("真实仓库：登记表与扫描面一致（登记第一项后这条仍应绿）", () => {
  const result = verifyVendoredBinaries(ROOT);
  assert.deepEqual(result.problems, []);
  assert.ok(result.scanned > 0, "扫描面不应为空");
  // 不钉 registered === 0：那会把「今天的真空」写死，第一次真登记时这条必然红，正确动作
  // 反而变成改测试。结构性不变量是「登记条数 == 扫描命中条数」（登记表与事实一一对应：
  // 少登记一项、多登记一项都已由 problems 判红）。
  assert.equal(result.registered, result.hits, "登记条数必须等于扫描命中条数");
});

// ---------- 五、接线钉：三个执行点必须同时存在 ----------

/** local-gate 某一档的计划步骤（--dry-run 不执行任何步骤；机制同 local-gate-steps.test.ts）。 */
function plannedSteps(tier: string): string {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "gate", "local-gate.mjs"), "--tier", tier, "--dry-run"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `--tier ${tier} --dry-run 应 exit 0：${r.stderr}`);
  return r.stdout;
}

test("接线：ci.yml 有未被注释的执行步骤 + local-gate 计划步骤含该闸 + package.json script", () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  // 子串断言会被注释掉的执行点满足：把 run 行注释掉后 561 个用例仍全绿（复核实测）。
  // 先剥掉注释行，再按「一步的 run:」形态断言存在性。
  const stepLines = ci
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  assert.ok(
    stepLines.some((l) => /^run:\s*node scripts\/gate\/verify-vendored-binaries\.mjs$/.test(l)),
    "ci.yml 缺（未被注释的）执行点：门禁不进 CI 等于没有门禁",
  );

  // local-gate 的步骤表走仓库自己的 --dry-run 计划输出，不读源码子串；断言到「将要执行的
  // 命令」而不是标签：只匹配标签的话，把 args 换成别的闸仍然全绿（原实现就是这么活下来的）。
  const plan = plannedSteps("pr");
  assert.match(
    plan,
    /\n {2}- verify:vendored-binaries（发布物面内裸二进制：登记 \+ 哈希绑定 \+ 许可随包） {2}→ {2}\S+ verify:vendored-binaries$/m,
    "local-gate 的 cheapGlobal 缺该闸（或标签与 args 脱钩）：本地档看不到，本地绿而 CI 红的落差由此产生",
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
