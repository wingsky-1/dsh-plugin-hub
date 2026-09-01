/**
 * dsh-verify-isolated — smoke：skills 目录结构 + SKILL.md frontmatter + patch 配置。
 *
 * 无网络、无真实凭据；验证（参照 archify-dsh 的 bundledSkillDir 模式）：
 * 1. 包内 skills/dsh-verify-isolated/SKILL.md 存在且 frontmatter name 正确；
 * 2. 一键脚本随 skill 目录分发；
 * 3. cordis.patch.yml 复用官方 @deepseek-ai/dsh-skill-filesystem，配置
 *    providerName / includeDefaultRoots:false / bundledSkillDir（从包 manifest
 *    解析 skills 目录）；
 * 4. bundledSkillDir 的 JS 表达式在模拟 profile baseUrl 下能解析到真实 skills 目录。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseFrontmatter } from "../../../shared/frontmatter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const SKILL_DIR = join(PKG_ROOT, "skills", "dsh-verify-isolated");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");

// ---- 1. skills 目录结构 + frontmatter ----
assert.ok(existsSync(SKILL_FILE), "skills/dsh-verify-isolated/SKILL.md 存在");
const raw = readFileSync(SKILL_FILE, "utf8");
const fm = parseFrontmatter(raw);
assert.equal(fm.name, "dsh-verify-isolated", "SKILL.md frontmatter name");
assert.match(fm.description ?? "", /隔离环境/, "description 含隔离环境");

// 防回归（#428）：脚本定位必须走 skill 资源 base（注入的 Base directory），不得
// 写死 npm 副本形态的 node_modules 路径——link:/checkout 形态下该路径不存在
assert.ok(!raw.includes("node_modules/@wingsky-1"),
  "SKILL.md 不得写死 node_modules/@wingsky-1 路径（应经 skill 资源 base 定位）");

// ---- 2. 一键脚本随 skill 分发 ----
const scriptFile = join(SKILL_DIR, "scripts", "verify-isolated.sh");
assert.ok(existsSync(scriptFile), "一键脚本随 skill 目录分发");
assert.ok(readFileSync(scriptFile, "utf8").includes("verify_$(openssl rand -hex 4)"),
  "脚本含 verify_<随机> profile 逻辑");

// ---- 3. cordis.patch.yml 复用官方 provider + bundledSkillDir 配置 ----
const patch = readFileSync(join(PKG_ROOT, "cordis.patch.yml"), "utf8");
assert.ok(patch.includes("@deepseek-ai/dsh-skill-filesystem"),
  "patch 复用官方 dsh-skill-filesystem（archify 模式）");
assert.ok(patch.includes("providerName: dsh-verify-isolated"), "providerName 配置");
assert.ok(patch.includes("includeDefaultRoots: false"),
  "includeDefaultRoots: false（只加载本包 skill，不加载项目/用户默认根）");
assert.ok(patch.includes("bundledSkillDir:"), "bundledSkillDir 配置在位");
assert.ok(patch.includes("@wingsky-1/dsh-verify-isolated/package.json"),
  "bundledSkillDir 从包 manifest 解析（不猜路径）");

// ---- 4. bundledSkillDir JS 表达式模拟：从 profile baseUrl 解析包 → skills ----
{
  const req = createRequire(join(PKG_ROOT, "noop.js"));
  const manifestPath = req.resolve("@wingsky-1/dsh-verify-isolated/package.json");
  const resolvedSkills = join(dirname(manifestPath), "skills");
  assert.equal(resolvedSkills, join(PKG_ROOT, "skills"), "bundledSkillDir 解析到包内 skills");
}

console.log("PASS: dsh-verify-isolated smoke（skills 结构 / frontmatter / patch 配置 / 路径解析）");