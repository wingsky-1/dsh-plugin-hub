import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..", "..");
const GATE = join(ROOT, "scripts", "gate", "plugin-locale.ts");

/** fixture 规格：只描述「相对合规态」要动的地方。 */
interface Spec {
  /** locale 目录下的文件；缺 en.json 即删锚点。 */
  files?: Record<string, unknown>;
  /** 省略即不写该 locale 文件。 */
  skipFiles?: string[];
  noLocaleDir?: boolean;
  filesWhitelist?: string[];
  exportsLocale?: unknown;
  summary?: Record<string, string>;
}

/**
 * 铺一个隔离 repo root + 单包 fixture，并用 node_modules 自引用软链让解析器实证能跑通
 * （真实 link: 安装同形；不铺则契约 4 会先炸、掩盖其余断言）。
 */
function fixture(spec: Spec) {
  const root = mkdtempSync(join(tmpdir(), "plugin-locale-"));
  const name = "@probe/pkg";
  const pkgDir = join(root, "packages", "dsh-probe");
  mkdirSync(pkgDir, { recursive: true });
  const files = {
    "en.json": { meta: { title: "Probe", description: "English description." } },
    "zh.json": { meta: { title: "探针", description: "中文描述。" } },
    ...(spec.files ?? {}),
  };
  if (!spec.noLocaleDir) {
    mkdirSync(join(pkgDir, "locale"), { recursive: true });
    for (const [f, doc] of Object.entries(files)) {
      if ((spec.skipFiles ?? []).includes(f)) continue;
      writeFileSync(join(pkgDir, "locale", f), JSON.stringify(doc, null, 2));
    }
  }
  const exportsField: Record<string, unknown> = {
    ".": { types: "./lib/index.d.ts", default: "./lib/index.js" },
    "./package.json": "./package.json",
  };
  if (spec.exportsLocale !== null) {
    exportsField["./locale/*"] =
      spec.exportsLocale === undefined ? "./locale/*" : spec.exportsLocale;
  }
  const manifest = {
    name,
    version: "0.0.0",
    exports: exportsField,
    files: spec.filesWhitelist ?? ["lib", "locale", "package.json"],
    dsh: { catalog: { summary: spec.summary ?? { en: "English description.", zh: "中文描述。" } } },
  };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2));
  mkdirSync(join(pkgDir, "lib"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@probe"), { recursive: true });
  symlinkSync(pkgDir, join(root, "node_modules", "@probe", "pkg"), "dir");
  return root;
}

function runGate(root: string) {
  const r = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** 判红正例：期望 exit 1 且判词含指定片段。 */
function assertRed(spec: Spec, expect: string, name: string) {
  test(name, () => {
    const root = fixture(spec);
    try {
      const r = runGate(root);
      assert.equal(r.code, 1, `应判红（exit 1），实际 ${r.code}；输出：${r.out.slice(0, 300)}`);
      assert.ok(r.out.includes(expect), `判词应含「${expect}」，实际：${r.out.slice(0, 400)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("合规 fixture 通过（exit 0）", () => {
  const root = fixture({});
  try {
    const r = runGate(root);
    assert.equal(r.code, 0, `合规态应通过，实际 ${r.code}；输出：${r.out.slice(0, 400)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

assertRed({ noLocaleDir: true }, "缺 locale/ 目录", "缺 locale/ 目录 → 判红");
assertRed({ skipFiles: ["en.json"] }, "缺 locale/en.json", "缺 en.json 锚点 → 判红");
assertRed(
  { filesWhitelist: ["lib", "package.json"] },
  'files 未含 "locale"',
  "files 漏 locale → 判红",
);
assertRed({ exportsLocale: null }, 'exports["./locale/*"]', "exports 漏 locale 通配 → 判红");
assertRed(
  { exportsLocale: { default: "./locale/*" } },
  'exports["./locale/*"]',
  "exports 非恒等形态 → 判红",
);
assertRed(
  { files: { "en.json": { title: "x", description: "English description." } } },
  "缺 meta 对象",
  "缺 meta 包装层 → 判红",
);
assertRed(
  { files: { "en.json": { meta: { title: "  ", description: "English description." } } } },
  "meta.title",
  "title 空串 → 判红",
);
assertRed(
  { files: { "zh-CN.json": { meta: { title: "x", description: "y" } } }, skipFiles: ["zh.json"] },
  "不在宿主内置目录",
  "zh-CN.json（合法但永不命中）→ 判红",
);
assertRed(
  { files: { "strings.json": { meta: { title: "x", description: "y" } } }, skipFiles: ["zh.json"] },
  "不在宿主内置目录",
  "strings.json（被上游静默吸收成语言）→ 判红",
);
assertRed(
  { files: { "en.json": { meta: { title: "Probe", description: "漂移了。" } } } },
  "不是逐字相等",
  "description 与 catalog.summary 漂移 → 判红",
);
assertRed(
  {
    files: {
      "en.json": { extra: 1, meta: { title: "Probe", description: "English description." } },
    },
  },
  "不被上游读取",
  "顶层多余键 → 判红",
);
assertRed(
  {
    files: {
      "en.json": { meta: { title: "Probe", description: "English description.", icon: "x.svg" } },
    },
  },
  "不被上游使用",
  "meta.icon（上游静默忽略）→ 判红",
);
