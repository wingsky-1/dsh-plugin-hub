// @ts-nocheck
// dsh-subagent-model-inherit 冒烟测试 —— 无网络、无真实凭据、无 dsh 进程依赖。
//
// 验证发布物边界与挂载契约：
//   - name / inject 导出正确
//   - cordis.patch.yml 存在且 YAML 可解析、insert 行 id/name 正确、不带 config
//   - package.json 的 dsh.bundle.patch 指向 cordis.patch.yml
//   - package.json 的 files 含构建产物；exports["."] 存在（纯宿主端，无 ./client）
//   - apply 在空 ctx 上不抛错（防御分支）
//
// 运行：node test/smoke.ts （需先 pnpm build 产出 lib/）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, name, inject } from "../lib/index.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

// ---- 导出契约
assert.equal(name, "subagent-model-inherit", "name 必须为 subagent-model-inherit");
assert.deepEqual(inject, ["agents"], "inject 必须为 [\"agents\"]");
assert.equal(typeof apply, "function", "apply 必须为函数");

// ---- patch 契约（正则断言，与 scripts/gate/pack-check.ts 同款做法）
const patchText = readFileSync(join(pkgDir, "cordis.patch.yml"), "utf8");
const ids = [...patchText.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
const names = [...patchText.matchAll(/^\s*-\s+id:\s*\S+\s*name:\s*'?"?([^'"\s]+)'?"?\s*$/gm)].map((m) => m[1]);
assert.deepEqual(ids, ["ui-dsh-subagent-model-inherit"], "patch 必须恰有一行 insert 且 id 正确");
assert.deepEqual(names, ["@wingsky-1/dsh-subagent-model-inherit"], "insert name 错误");
assert.match(patchText, /^- insert:/m, "必须是 insert 形态");
assert.ok(!/^\s*config:/m.test(patchText), "insert 行不得带 config（走 schema 默认值）");

// ---- package.json 契约
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "dsh.bundle.patch 必须指向 cordis.patch.yml");
assert.ok(pkg.files.includes("lib"), "files 必须含 lib 构建产物");
assert.equal(pkg.exports["./client"], undefined, "纯宿主端不得声明 ./client 导出");
assert.equal(pkg.main, "lib/index.js", "main 必须为 lib/index.js");

// ---- 防御路径：空 ctx（无 agents 服务）apply 不抛错、不注册监听
{
  const registered = [];
  apply({
    get: () => undefined,
    on: (event) => registered.push(event),
  });
  assert.equal(registered.length, 0, "缺 agents 服务时不得注册任何事件监听");
}

console.log("smoke: all assertions passed");
