#!/usr/bin/env node
"use strict";
/**
 * host-service-diff 自测（#1164 C 项）。
 *
 * 覆盖：
 *   - 旧 .d.ts 有 settings.get、新 .d.ts 删掉 -> --check exit 1，JSON 报 removedMethods=["get"]；
 *   - 同树 -> exit 0；反向（新->旧）-> exit 1；
 *   - 事件删除同样计入判红；
 *   - 无类型服务（credentials 等）始终进 untyped 观察面；
 *   - 静态/数据/WASM/平台包无声明 -> 显式分类，不伪装为 typed；
 *   - 声明入口缺失或暴露根运行时 API -> exit 2（工具故障，不得读成无变化）；
 *   - exports.types 的多入口声明全部解析；
 *   - --help exit 0。
 *
 * fixture 全部落 mkdtempSync 隔离目录，测试结束清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHostServiceSurface,
  diffHostServiceSurfaces,
  discoverPackageDirs,
} from "../derive/host-service-diff.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "derive", "host-service-diff.ts");

function pkgDir(tree: string, name: string): string {
  return join(tree, "node_modules", "@deepseek-ai", name);
}

function writePackage(
  tree: string,
  name: string,
  version: string,
  dts: string,
  files: Record<string, string> = {},
): void {
  const dir = pkgDir(tree, name);
  mkdirSync(join(dir, "lib", "types"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@deepseek-ai/" + name,
      version,
      types: "lib/types/index.d.ts",
    }),
  );
  writeFileSync(join(dir, "lib", "types", "index.d.ts"), dts);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function writeManifestPackage(
  tree: string,
  name: string,
  version: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): void {
  const dir = pkgDir(tree, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/" + name, version, ...manifest }),
  );
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const OLD_SETTINGS = `
declare module "@deepseek-ai/cordis" {
  interface Context {
    settings: SettingsForms;
    llm: LlmRuntime;
    "session/event": unknown;
  }
}
export interface SettingsForms {
  get(ns: string): unknown;
  update(ns: string, patch: object): Promise<void>;
}
export interface LlmRuntime {
  listConfigurableProviders(): readonly string[];
}
`;

const NEW_SETTINGS = `
declare module "@deepseek-ai/cordis" {
  interface Context {
    settings: SettingsForms;
    llm: LlmRuntime;
  }
}
export interface SettingsForms {
  describe(options?: object): readonly unknown[];
  update(ns: string, patch: object): Promise<void>;
}
export interface LlmRuntime {
  listConfigurableProviders(): readonly string[];
}
`;

function makeTree(settingsDts: string): string {
  const tree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-"));
  writePackage(tree, "dsh-settings", "0.2.1-rc.2", settingsDts);
  writePackage(
    tree,
    "dsh-llm",
    "0.2.1-rc.2",
    "export interface LlmRuntime { listConfigurableProviders(): readonly string[]; }\n",
  );
  return tree;
}

function addStaticPackage(tree: string): void {
  writeManifestPackage(
    tree,
    "dsh-web-frontend",
    "0.2.2-rc.1",
    { exports: { "./dist/*": "./dist/*", "./package.json": "./package.json" } },
    { "dist/index.html": "<!doctype html>" },
  );
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

test("discoverPackageDirs：支持 node_modules 根与 scope 目录", () => {
  const tree = makeTree(OLD_SETTINGS);
  try {
    assert.deepEqual(
      discoverPackageDirs(tree)
        .map((dir) => dir.split("/").at(-1))
        .sort(),
      ["dsh-llm", "dsh-settings"],
    );
    assert.deepEqual(
      discoverPackageDirs(join(tree, "node_modules", "@deepseek-ai"))
        .map((dir) => dir.split("/").at(-1))
        .sort(),
      ["dsh-llm", "dsh-settings"],
    );
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("buildHostServiceSurface：Context 服务/事件/方法表", () => {
  const tree = makeTree(OLD_SETTINGS);
  try {
    const surface = buildHostServiceSurface(tree);
    assert.ok(surface.services.has("settings"));
    assert.ok(surface.services.has("llm"));
    assert.ok(surface.events.has("session/event"));
    assert.ok(surface.links.get("settings") === "SettingsForms");
    assert.deepEqual([...surface.methodTables.get("SettingsForms")!].sort(), ["get", "update"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("diff：settings.get 删除被识别为破坏性", () => {
  const oldTree = makeTree(OLD_SETTINGS);
  const newTree = makeTree(NEW_SETTINGS);
  try {
    const diff = diffHostServiceSurfaces(
      buildHostServiceSurface(oldTree),
      buildHostServiceSurface(newTree),
    );
    const settings = diff.changedServices.find((change) => change.service === "settings");
    assert.ok(settings !== undefined);
    assert.deepEqual(settings.removedMethods, ["get"]);
    assert.deepEqual(settings.addedMethods, ["describe"]);
    assert.deepEqual(diff.removedEvents, ["session/event"]);
    assert.equal(diff.hasRemovals, true);
    assert.ok(diff.untypedServices.includes("credentials"));
  } finally {
    rmSync(oldTree, { recursive: true, force: true });
    rmSync(newTree, { recursive: true, force: true });
  }
});

test("CLI --check：旧->新 exit 1，同树 exit 0，反向 exit 1", () => {
  const oldTree = makeTree(OLD_SETTINGS);
  const newTree = makeTree(NEW_SETTINGS);
  try {
    const forward = run(["--from", oldTree, "--to", newTree, "--check"]);
    assert.equal(forward.status, 1, forward.stderr.slice(0, 500));
    assert.match(forward.stdout, /settings/);
    assert.match(forward.stdout, /get/);
    assert.match(forward.stdout, /RESULT: FAIL/);

    const same = run(["--from", newTree, "--to", newTree, "--check"]);
    assert.equal(same.status, 0, same.stderr.slice(0, 500));
    assert.match(same.stdout, /RESULT: PASS/);

    const reverse = run(["--from", newTree, "--to", oldTree, "--check"]);
    assert.equal(reverse.status, 1, reverse.stderr.slice(0, 500));
    assert.match(reverse.stdout, /describe/);
  } finally {
    rmSync(oldTree, { recursive: true, force: true });
    rmSync(newTree, { recursive: true, force: true });
  }
});

test("CLI --json：结构化字段可消费", () => {
  const oldTree = makeTree(OLD_SETTINGS);
  const newTree = makeTree(NEW_SETTINGS);
  try {
    const r = run(["--from", oldTree, "--to", newTree, "--json", "--check"]);
    assert.equal(r.status, 1, r.stderr.slice(0, 500));
    const parsed = JSON.parse(r.stdout) as {
      changedServices: { service: string; removedMethods: string[]; addedMethods: string[] }[];
      removedEvents: string[];
      untypedServices: string[];
      hasRemovals: boolean;
    };
    const settings = parsed.changedServices.find((change) => change.service === "settings");
    assert.ok(settings !== undefined);
    assert.deepEqual(settings.removedMethods, ["get"]);
    assert.deepEqual(settings.addedMethods, ["describe"]);
    assert.deepEqual(parsed.removedEvents, ["session/event"]);
    assert.ok(parsed.untypedServices.includes("credentials"));
    assert.equal(parsed.hasRemovals, true);
  } finally {
    rmSync(oldTree, { recursive: true, force: true });
    rmSync(newTree, { recursive: true, force: true });
  }
});

test("CLI --check：静态包显式无声明，不伪装为 typed", () => {
  const oldTree = makeTree(OLD_SETTINGS);
  const newTree = makeTree(OLD_SETTINGS);
  addStaticPackage(oldTree);
  addStaticPackage(newTree);
  try {
    const oldSurface = buildHostServiceSurface(oldTree);
    assert.equal(
      oldSurface.packages.find((pkg) => pkg.name === "@deepseek-ai/dsh-web-frontend")?.entry,
      null,
    );
    assert.deepEqual(oldSurface.noDeclarationPackages, [
      {
        name: "@deepseek-ai/dsh-web-frontend",
        version: "0.2.2-rc.1",
        reason: "no root runtime API (static/data/WASM/platform package)",
      },
    ]);

    const r = run(["--from", oldTree, "--to", newTree, "--json", "--check"]);
    assert.equal(r.status, 0, r.stderr.slice(0, 500));
    const parsed = JSON.parse(r.stdout) as {
      noDeclarationPackages: {
        from: { name: string; version: string; reason: string }[];
        to: { name: string; version: string; reason: string }[];
      };
    };
    assert.deepEqual(parsed.noDeclarationPackages.from, oldSurface.noDeclarationPackages);
    assert.deepEqual(parsed.noDeclarationPackages.to, oldSurface.noDeclarationPackages);
  } finally {
    rmSync(oldTree, { recursive: true, force: true });
    rmSync(newTree, { recursive: true, force: true });
  }
});

test("CLI --check：静态包存在时，typed 服务删除仍 exit 1", () => {
  const oldTree = makeTree(OLD_SETTINGS);
  const newTree = makeTree(NEW_SETTINGS);
  addStaticPackage(oldTree);
  addStaticPackage(newTree);
  try {
    const r = run(["--from", oldTree, "--to", newTree, "--check"]);
    assert.equal(r.status, 1, r.stderr.slice(0, 500));
    assert.match(r.stdout, /SettingsForms/);
    assert.match(r.stdout, /get/);
  } finally {
    rmSync(oldTree, { recursive: true, force: true });
    rmSync(newTree, { recursive: true, force: true });
  }
});

test("CLI fail-closed：清单声明的 types 缺失时不得回落到常见入口", () => {
  const tree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-bad-"));
  try {
    writeManifestPackage(
      tree,
      "dsh-settings",
      "0.0.0",
      { types: "lib/types/missing.d.ts" },
      { "lib/types/index.d.ts": OLD_SETTINGS },
    );
    const r = run(["--from", tree, "--to", tree, "--check"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /FAIL-CLOSED/);
    assert.match(r.stderr, /lib\/types\/missing\.d\.ts/);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("CLI fail-closed：无声明、无 exports、无静态证据的空包 exit 2", () => {
  const tree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-empty-"));
  try {
    writeManifestPackage(
      tree,
      "dsh-unknown",
      "0.0.0",
      {},
      { "node_modules/dep/schema.json": "{}" },
    );
    const r = run(["--from", tree, "--to", tree, "--check"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /无法证明仅暴露静态资源/);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("CLI fail-closed：根运行时 JS 无声明 exit 2", () => {
  const tree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-runtime-"));
  try {
    writeManifestPackage(
      tree,
      "dsh-runtime",
      "0.0.0",
      { exports: { ".": { import: "./lib/index.js" } } },
      { "lib/index.js": "export const value = 1;\n" },
    );
    const r = run(["--from", tree, "--to", tree, "--check"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /FAIL-CLOSED/);
    assert.match(r.stderr, /无法证明仅暴露静态资源/);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("CLI fail-closed：Node 默认 index.js/cjs/mjs 无声明 exit 2", () => {
  for (const file of ["index.js", "index.cjs", "index.mjs"]) {
    const tree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-default-index-"));
    try {
      writeManifestPackage(tree, "dsh-runtime", "0.0.0", {}, { [file]: "export {};\n" });
      const r = run(["--from", tree, "--to", tree, "--check"]);
      assert.equal(r.status, 2, file);
      assert.match(r.stderr, /无法证明仅暴露静态资源/);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
});

test("CLI fail-closed：无声明子路径 JS 或未知目标均 exit 2", () => {
  const fixtures = [
    { subpath: "./api", target: "./api.js", file: "api.js" },
    { subpath: "./asset", target: "./asset.bin", file: "asset.bin" },
    { subpath: "./api/*", target: "./dist/*.js", file: "dist/api.js" },
  ];
  for (const fixture of fixtures) {
    const tree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-subpath-"));
    try {
      writeManifestPackage(
        tree,
        "dsh-runtime",
        "0.0.0",
        { exports: { [fixture.subpath]: fixture.target } },
        { [fixture.file]: "opaque\n" },
      );
      const r = run(["--from", tree, "--to", tree, "--check"]);
      assert.equal(r.status, 2, fixture.target);
      assert.match(r.stderr, /无法证明仅暴露静态资源/);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
});

test("CLI --check：仅 exports.types 的入口同样进入方法面", () => {
  const oldTree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-exports-old-"));
  const newTree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-exports-new-"));
  const manifest = {
    exports: {
      "./runtime": {
        types: "./lib/runtime.d.ts",
        default: "./lib/runtime.js",
      },
    },
  };
  try {
    writeManifestPackage(oldTree, "dsh-settings", "0.2.1-rc.2", manifest, {
      "lib/runtime.d.ts": OLD_SETTINGS,
      "lib/runtime.js": "export {};\n",
    });
    writeManifestPackage(newTree, "dsh-settings", "0.2.2-rc.1", manifest, {
      "lib/runtime.d.ts": NEW_SETTINGS,
      "lib/runtime.js": "export {};\n",
    });
    const r = run(["--from", oldTree, "--to", newTree, "--check"]);
    assert.equal(r.status, 1, r.stderr.slice(0, 500));
    assert.match(r.stdout, /SettingsForms/);
    assert.match(r.stdout, /get/);
  } finally {
    rmSync(oldTree, { recursive: true, force: true });
    rmSync(newTree, { recursive: true, force: true });
  }
});

test("buildHostServiceSurface：合并并去重全部 exports.types 入口", () => {
  const tree = mkdtempSync(join(tmpdir(), "dsh-host-service-diff-multi-"));
  try {
    writeManifestPackage(
      tree,
      "dsh-settings",
      "0.2.2-rc.1",
      {
        exports: {
          "./context": { types: "./lib/context.d.ts", default: "./lib/context.js" },
          "./settings": { types: "./lib/settings.d.ts", default: "./lib/settings.js" },
          "./settings-alias": { types: "./lib/settings.d.ts", default: "./lib/settings.js" },
        },
      },
      {
        "lib/context.d.ts":
          'declare module "@deepseek-ai/cordis" { interface Context { settings: SettingsForms; } }\n',
        "lib/settings.d.ts": "export interface SettingsForms { get(ns: string): unknown; }\n",
        "lib/context.js": "export {};\n",
        "lib/settings.js": "export {};\n",
      },
    );
    const surface = buildHostServiceSurface(tree);
    assert.ok(surface.links.get("settings") === "SettingsForms");
    assert.deepEqual([...surface.methodTables.get("SettingsForms")!], ["get"]);
    assert.equal(surface.packages[0]?.files, 2);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("CLI --help exit 0 且列出退出码", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--from/);
  assert.match(r.stdout, /--check/);
  assert.match(r.stdout, /2 = 工具故障/);
});
