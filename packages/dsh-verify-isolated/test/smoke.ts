/**
 * dsh-verify-isolated — smoke：skills 目录结构 + SKILL.md frontmatter + patch 配置
 * + 新增脚本参数契约（browser-driver.mjs / verify-isolated.sh）。
 *
 * 无网络、无真实凭据、**不真正启动浏览器**（防跨平台 flake，遵守 docs/DEVELOPMENT.md §5）。
 * 验证（参照 archify-dsh 的 bundledSkillDir 模式）：
 * 1. 包内 skills/dsh-verify-isolated/SKILL.md 存在且 frontmatter name 正确；
 * 2. 一键脚本随 skill 目录分发；
 * 3. cordis.patch.yml 复用官方 @deepseek-ai/dsh-skill-filesystem，配置
 *    providerName / includeDefaultRoots:false / bundledSkillDir（从包 manifest
 *    解析 skills 目录）；
 * 4. bundledSkillDir 的 JS 表达式在模拟 profile baseUrl 下能解析到真实 skills 目录；
 * 5. browser-driver.mjs 存在，--help 参数契约覆盖全部原子命令，无参数非零退出；
 * 6. verify-isolated.sh 含 --browser 与 --port 0 修复逻辑；
 * 7. SKILL.md 含多会话并行章节与三平台内核自查清单；
 * 8. README 同步新能力。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

// ---- 5. browser-driver.mjs 存在 + --help 参数契约（不启动浏览器实例） ----
const driverFile = join(SKILL_DIR, "scripts", "browser-driver.mjs");
assert.ok(existsSync(driverFile), "browser-driver.mjs 随 skill 目录分发");
const help = execFileSync(process.execPath, [driverFile, "--help"], { encoding: "utf8" });
assert.ok(help.includes("--json"), "browser-driver --help 声明统一 JSON 输出");
for (const cmd of ["launch", "quit", "snapshot", "click", "eval", "fill", "wait", "screenshot", "console"]) {
  assert.ok(help.includes(cmd), `browser-driver --help 契约含命令 ${cmd}`);
}
let noArgExitsNonZero = false;
try { execFileSync(process.execPath, [driverFile], { encoding: "utf8" }); }
catch { noArgExitsNonZero = true; }
assert.ok(noArgExitsNonZero, "browser-driver 无参数应非零退出（用法提示，不误启动浏览器）");

// ---- 6. verify-isolated.sh 含 --browser 与 --port 0 修复逻辑 ----
{
  const script = readFileSync(scriptFile, "utf8");
  assert.ok(script.includes("--browser"), "脚本含 --browser 选项");
  assert.ok(script.includes("browser-driver.mjs"), "脚本调用 browser-driver.mjs");
  assert.ok(script.includes("browser.state"), "脚本管理 browser.state 实例文件");
  assert.ok(script.includes("--port 0"), "脚本含 --port 0 处理分支");
  assert.ok(script.includes("探测空闲端口"), "--port 0 自选真实空闲端口（修复打印 0 无效）");
}

// ---- 7. SKILL.md 含多会话并行章节与三平台内核自查 ----
assert.ok(raw.includes("多会话并行"), "SKILL.md 含多会话并行章节");
assert.ok(raw.includes("四重隔离"), "SKILL.md 含四重隔离说明");
assert.ok(raw.includes("DSH_VERIFY_CHROME"), "SKILL.md 含 DSH_VERIFY_CHROME 内核指定");
assert.ok(raw.includes("ms-playwright"), "SKILL.md 含 ms-playwright 缓存路径表");
assert.ok(raw.includes("Google Chrome.app"), "SKILL.md 含 macOS 自查路径");
assert.ok(raw.includes("ProgramFiles"), "SKILL.md 含 Windows 自查路径");

// ---- 8. README 同步新能力 ----
const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
assert.ok(readme.includes("browser-driver.mjs"), "README 同步 browser-driver");
assert.ok(readme.includes("--browser"), "README 同步 --browser 用法");
assert.ok(readme.includes("四重隔离"), "README 同步四重隔离说明");

console.log("PASS: dsh-verify-isolated smoke（skills 结构 / frontmatter / patch / 路径解析 / 脚本参数契约 / 文档同步）");