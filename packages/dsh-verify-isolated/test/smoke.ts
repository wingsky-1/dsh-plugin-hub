/**
 * dsh-verify-isolated — smoke：provider 注册 + SKILL.md 可发现 + frontmatter 解析。
 *
 * 无网络、无真实凭据；用 fake ctx 的最小 skills 注册表面验证：
 * 1. apply() 会调用 ctx.skills.registerProvider（注册 provider）；
 * 2. provider.list() 返回包内 SKILL.md 候选（name= dsh-verify-isolated）；
 * 3. provider.get() 返回完整 body（含 frontmatter 解析出的 description）。
 */
import assert from "node:assert/strict";
import { apply, PROVIDER_NAME, SKILL_DIR } from "../src/index.ts";

// ---- fake ctx：最小 skills 注册表面 ----
const registered = [];
const fakeCtx = {
  skills: {
    registerProvider(create) {
      registered.push(create);
      return () => {};
    },
  },
};

apply(fakeCtx);

assert.equal(registered.length, 1, "apply 应注册 1 个 provider");

const provider = registered[0]({
  signal: new AbortController().signal,
  invalidate: () => {},
});

// ---- provider 元信息 ----
assert.equal(provider.name, "dsh-verify-isolated", "provider 名");
assert.equal(PROVIDER_NAME, "dsh-verify-isolated", "导出常量一致");

// ---- list()：候选 = 包内 SKILL.md ----
const candidates = await provider.list();
assert.equal(candidates.length, 1, "恰好 1 个 skill 候选");
const [cand] = candidates;
assert.equal(cand.name, "dsh-verify-isolated", "skill 名来自 frontmatter");
assert.match(cand.description ?? "", /隔离环境/, "description 含隔离环境");
assert.equal(cand.locator.kind, "directory", "locator 为目录型");
assert.ok(cand.path?.endsWith("SKILL.md"), "path 指向包内 SKILL.md");

// ---- get()：完整 body ----
const def = await provider.get(cand, {});
assert.ok(def, "get 返回 skill 定义");
assert.equal(def.name, "dsh-verify-isolated");
assert.match(def.content, /^---/, "body 含 frontmatter");
assert.match(def.content, /verify-isolated\.sh/, "body 提及一键脚本");
assert.equal(def.resourceBase.kind, "directory");
assert.equal(def.resourceBase.path, SKILL_DIR, "resourceBase 指向包根");

// ---- SKILL.md 实际存在且脚本在包内 ----
import { existsSync } from "node:fs";
assert.ok(existsSync(new URL("../SKILL.md", import.meta.url)), "SKILL.md 存在");
assert.ok(existsSync(new URL("../scripts/verify-isolated.sh", import.meta.url)), "脚本存在");

console.log("PASS: dsh-verify-isolated smoke（provider 注册 / SKILL.md 发现 / frontmatter 解析）");
