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
assert.ok(readFileSync(scriptFile, "utf8").includes('verify_$(node -e'),
  "脚本含 verify_<随机> profile 逻辑（node crypto 生成，不依赖 openssl CLI）");

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

// ---- 6. verify-isolated.sh 参数契约：--browser/--port 0/#376 加固（--dsh/回环/遥测/初始化/就绪断言/L1/L2） ----
{
  const script = readFileSync(scriptFile, "utf8");
  assert.ok(script.includes("--browser"), "脚本含 --browser 选项");
  assert.ok(script.includes("browser-driver.mjs"), "脚本调用 browser-driver.mjs");
  assert.ok(script.includes("browser.state"), "脚本管理 browser.state 实例文件");
  assert.ok(script.includes("--port 0"), "脚本含 --port 0 处理分支");
  assert.ok(script.includes("探测空闲端口"), "--port 0 自选真实空闲端口（修复打印 0 无效）");
  // #376 H1：--dsh 参数化 dsh 入口（版本锚定），校验可执行 + 版本展示
  assert.ok(script.includes("--dsh"), "脚本含 --dsh 选项（dsh 入口版本锚定）");
  assert.ok(script.includes('DSH_BIN="$2"'), "--dsh 解析到 DSH_BIN");
  assert.ok(script.includes('DSH_BIN=dsh'), "DSH_BIN 默认 dsh（无 --dsh 时行为兼容现状）");
  assert.ok(script.includes('dsh 入口不可执行'), "--dsh 目标不可执行时 fail fast");
  assert.ok(script.includes("--version"), "启动前展示 dsh 版本（锚定证据）");
  // #376 H2：显式回环 + 遥测禁用（锚定启动行本体——注释里出现同串不算数）
  assert.ok(script.includes('DSH_TELEMETRY_DISABLED=1 "$DSH_ABS"'), "隔离实例显式禁用遥测（锚定启动行）");
  assert.ok(
    script.includes('"$DSH_ABS" --profile "$PROFILE" --host 127.0.0.1 --port "$PORT" --no-open'),
    "隔离实例显式回环绑定（锚定启动行）",
  );
  // #376 M1：profile 初始化走显式 plugin list（不再依赖 add --help 未文档化行为）
  assert.ok(script.includes('plugin --profile "$PROFILE" list'), "profile 初始化用显式 plugin list");
  assert.ok(!script.includes("add --help >/dev/null"), "不再依赖 add --help 隐式初始化（注释提及不受限）");
  assert.ok(script.includes("profile 初始化失败"), "初始化失败 fail loudly");
  // #376 M2：启动后就绪断言（轮询 HTTP 可达 + 进程存活核对，超时可操作错误）
  assert.ok(script.includes("就绪断言通过"), "启动后就绪断言通过输出");
  assert.ok(script.includes("15s 内未就绪"), "就绪超时给可操作错误");
  assert.ok(script.includes("AbortSignal.timeout"), "就绪探测带超时（不裸连）");
  assert.ok(script.includes("进程在就绪前退出"), "就绪探测核对 dsh 进程存活（防端口被占假阳性）");
  assert.ok(script.includes("r.status < 500"), "就绪判定不接受 5xx");
  // #376 L1：openssl/realpath 依赖替换为 node（脚本本已硬依赖 node）
  assert.ok(script.includes("randomBytes(4)"), "随机后缀走 node crypto");
  assert.ok(!script.includes("openssl rand"), "不再依赖 openssl CLI");
  assert.ok(!script.includes('realpath -m "$pkg"'), "不再调用 GNU realpath -m（注释提及不受限）");
  assert.ok(script.includes('require("node:path").resolve'), "路径解析走 node path.resolve");
  // #376 L2：--no-build 产物存在性检查 + 陈旧产物警告
  assert.ok(script.includes("--no-build 但缺少构建产物"), "--no-build 缺产物报可操作错误");
  assert.ok(script.includes("源码比构建产物新"), "--no-build 陈旧产物 mtime 警告");
  // 启动生命周期：后台 + 就绪断言 + wait（EXIT trap 兜底 kill）
  assert.ok(script.includes('DSH_PID=$!'), "dsh 后台启动记录 pid");
  assert.ok(script.includes('wait "$DSH_PID"'), "前台 wait 保持阻塞体感");
  // #517 C11：插件参数归一化——脚本调用 resolve-pkg-paths.mjs，add 用绝对路径数组
  assert.ok(script.includes("resolve-pkg-paths.mjs"), "脚本调用 resolve-pkg-paths.mjs（#517 C11 单点归一化）");
  assert.ok(script.includes("PKGS_ABS=()"), "脚本累积 PKGS_ABS 绝对路径数组");
  assert.ok(script.includes('add "${PKGS_ABS[@]}"'), "plugin add 用归一化后的绝对路径数组（非原始相对路径）");
  assert.ok(script.includes("dsh 会把非绝对路径当 git URL 解析"), "脚本注释声明相对路径 git URL 陷阱（#517 C11）");
  assert.ok(!script.includes('plugin add "${PKGS[@]}"'), "plugin add 不再直接传原始 ${PKGS[@]}（相对路径会当 git URL）");
}

// ---- 6.5 resolve-pkg-paths.mjs 行为断言（#517 C11：路径 vs 包规格归一化） ----
{
  const resolver = join(SKILL_DIR, "scripts", "resolve-pkg-paths.mjs");
  assert.ok(existsSync(resolver), "resolve-pkg-paths.mjs 随 skill 目录分发");
  const absBase = runResolver(resolver, ["--json", "--", "./rel", "@scope/name", "@wingsky-1/dsh-notifier"]);
  // 相对路径（./ 形态）→ path（resolve）
  const rel = absBase.find((i) => i.input === "./rel");
  assert.equal(rel.kind, "path", "./rel 判为 path");
  assert.ok(rel.abs.endsWith("/rel") && rel.abs.startsWith("/"), "./rel 解析为绝对路径");
  // 包规格 → spec 原样透传
  assert.equal(absBase.find((i) => i.input === "@scope/name").kind, "spec", "@scope/name 判为 spec");
  assert.equal(absBase.find((i) => i.input === "@scope/name").abs, null, "spec 无 abs");
  assert.equal(absBase.find((i) => i.input === "@wingsky-1/dsh-notifier").kind, "spec", "scoped 包名判为 spec");
  // cwd 存在路径 → path（仓库根踩点：packages/dsh-notifier，与脚本真实调用场景一致）
  const REPO_ROOT = join(PKG_ROOT, "..", "..");
  const exist1 = runResolver(resolver, ["--json", "--", "packages/dsh-notifier"], REPO_ROOT);
  assert.equal(exist1[0].kind, "path", "cwd 存在的相对目录判为 path");
  assert.ok(exist1[0].abs.includes("/packages/dsh-notifier") && exist1[0].abs.startsWith("/"), "cwd 存在目录解析为绝对路径");
  // 绝对路径 → path 原样
  const abs1 = runResolver(resolver, ["--json", "--", "/tmp/x"]);
  assert.equal(abs1[0].kind, "path", "绝对路径判为 path");
  assert.equal(abs1[0].abs, "/tmp/x", "绝对路径逐字节保留");
  // ~ 开头 → 展开 home
  const tilde = runResolver(resolver, ["--json", "--", "~"]);
  assert.equal(tilde[0].kind, "path", "~ 判为 path");
  assert.ok(tilde[0].abs.startsWith("/") && !tilde[0].abs.includes("~"), "~ 展开为 home 绝对路径");
  // 不含空格外的边界：无参数非零退出
  let noArgFails = false;
  try { runResolver(resolver, []); } catch (e) { noArgFails = e.status === 2; }
  assert.ok(noArgFails, "resolver 无参数非零退出（exit 2）");
}

/** 跑 resolve-pkg-paths.mjs --json 并解析输出。 */
function runResolver(resolver, args, cwd) {
  const out = execFileSync(process.execPath, [resolver, ...args], { encoding: "utf8", ...(cwd ? { cwd } : {}) });
  return JSON.parse(out.trim());
}

// ---- 7. SKILL.md 含多会话并行章节与三平台内核自查 ----
assert.ok(raw.includes("多会话并行"), "SKILL.md 含多会话并行章节");
assert.ok(raw.includes("四重隔离"), "SKILL.md 含四重隔离说明");
assert.ok(raw.includes("DSH_VERIFY_CHROME"), "SKILL.md 含 DSH_VERIFY_CHROME 内核指定");
assert.ok(raw.includes("ms-playwright"), "SKILL.md 含 ms-playwright 缓存路径表");
assert.ok(raw.includes("Google Chrome.app"), "SKILL.md 含 macOS 自查路径");
assert.ok(raw.includes("ProgramFiles"), "SKILL.md 含 Windows 自查路径");
// #376 配套：SKILL.md 含 --dsh 用法与隔离自检第 5 项（插件持久化 DSH_HOME 感知）
assert.ok(raw.includes("--dsh"), "SKILL.md 含 --dsh 版本锚定用法");
assert.ok(raw.includes("DSH_HOME 感知"), "SKILL.md 自检清单含插件 DSH_HOME 感知项（#510 盲区）");
assert.ok(raw.includes("DSH_TELEMETRY_DISABLED=1"), "SKILL.md 含遥测禁用原则");
assert.ok(raw.includes("--host 127.0.0.1"), "SKILL.md 含显式回环原则");

// ---- 8. README 同步新能力 ----
const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
assert.ok(readme.includes("browser-driver.mjs"), "README 同步 browser-driver");
assert.ok(readme.includes("--browser"), "README 同步 --browser 用法");
assert.ok(readme.includes("四重隔离"), "README 同步四重隔离说明");

console.log("PASS: dsh-verify-isolated smoke（skills 结构 / frontmatter / patch / 路径解析 / 脚本参数契约 / 文档同步）");