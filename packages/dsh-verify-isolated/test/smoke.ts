/**
 * dsh-verify-isolated — smoke：skills 目录结构 + SKILL.md frontmatter + patch 配置
 * + 新增脚本参数契约（browser-driver.mjs / verify-isolated.mjs，node 重写 #517 C8）。
 *
 * 无网络、无真实凭据、**不真正启动 dsh / 浏览器**（防跨平台 flake，遵守
 * docs/DEVELOPMENT.md §5）。验证（参照 archify-dsh 的 bundledSkillDir 模式）：
 * 1. 包内 skills/dsh-verify-isolated/SKILL.md 存在且 frontmatter name 正确；
 * 2. 一键脚本随 skill 目录分发（verify-isolated.mjs，verify-isolated.sh 已删除不留 shim）；
 * 3. cordis.patch.yml 复用官方 @deepseek-ai/dsh-skill-filesystem，配置
 *    providerName / includeDefaultRoots:false / bundledSkillDir（从包 manifest
 *    解析 skills 目录）；
 * 4. bundledSkillDir 的 JS 表达式在模拟 profile baseUrl 下能解析到真实 skills 目录；
 * 5. browser-driver.mjs 存在，--help 参数契约覆盖全部原子命令，无参数非零退出；
 * 6. verify-isolated.mjs 关键契约：--dsh/--port 0/--browser/--keep/--no-build/
 *    --evidence-dir/verdict.json/dsh.log/退出码（0/1/2/130/143）文本锚定 +
 *    lib/verify-core.mjs import 行为断言（EXIT 常量 / poll / findFreePort /
 *    resolvePkgArg C11 归一化 / readDshPort parsed 通道）+ 子进程退出码实测
 *    （--help=0、--dsh 不存在=2、--json 错误=单 JSON）；
 * 7. SKILL.md 含多会话并行章节与三平台内核自查清单；
 * 8. README 同步新能力。
 *
 * 注（#517 C11 并入）：resolve-pkg-paths.mjs 独立文件随 C8 内建进
 * lib/verify-core.mjs 的 resolvePkgArg（6a 行为断言覆盖原 6.5 段语义）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parseFrontmatter } from "../../../shared/frontmatter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const SKILL_DIR = join(PKG_ROOT, "skills", "dsh-verify-isolated");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");

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

// ---- 2. 一键脚本随 skill 分发（node 重写：#517 C8，删除 .sh 不留 shim） ----
const scriptFile = join(SCRIPTS_DIR, "verify-isolated.mjs");
assert.ok(existsSync(scriptFile), "verify-isolated.mjs 随 skill 目录分发");
assert.ok(!existsSync(join(SCRIPTS_DIR, "verify-isolated.sh")),
  "verify-isolated.sh 已删除，不留 shim（skill 随包整体发布无新旧错配）");
assert.ok(existsSync(join(SCRIPTS_DIR, "lib", "verify-core.mjs")),
  "共享基础工具 lib/verify-core.mjs 随 skill 目录分发");

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
const driverFile = join(SCRIPTS_DIR, "browser-driver.mjs");
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

// ---- 6. verify-isolated.mjs：lib import 行为断言 + 关键契约文本锚定 + 退出码实测 ----
{
  // 6a. lib/verify-core.mjs import 行为断言（弃纯文本 grep 锁脚本细节）
  const core = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "verify-core.mjs")).href);
  assert.equal(core.EXIT.OK, 0, "EXIT.OK=0（正常完成）");
  assert.equal(core.EXIT.FAIL, 1, "EXIT.FAIL=1（启动或就绪失败）");
  assert.equal(core.EXIT.USAGE, 2, "EXIT.USAGE=2（参数错误）");
  assert.equal(core.EXIT.SIGINT, 130, "EXIT.SIGINT=130（Ctrl+C 透传）");
  assert.equal(core.EXIT.SIGTERM, 143, "EXIT.SIGTERM=143（SIGTERM 透传）");
  // poll：fn 立即 true / 超时 false
  assert.equal(await core.poll(() => true, 500, 50), true, "poll 命中立即返回 true");
  assert.equal(await core.poll(() => false, 150, 50), false, "poll 超时返回 false");
  // findFreePort：127.0.0.1 上探测到真实空闲端口
  const fp = await core.findFreePort();
  assert.ok(Number.isInteger(fp) && fp > 0 && fp < 65536, `findFreePort 返回合法端口: ${fp}`);
  // resolvePkgArg：C11 归一化语义内建（相对路径绝对化 / 包规格原样透传 / ~ 展开）
  //（cwd = 包根，smoke 由 pnpm -r 在各包目录执行）
  assert.equal(core.resolvePkgArg("skills").kind, "path", "cwd 存在的相对路径 → path");
  assert.equal(core.resolvePkgArg("./skills").kind, "path", "形态类路径 ./ → path");
  assert.equal(core.resolvePkgArg("~").kind, "path", "~ → path（home 展开）");
  assert.equal(core.resolvePkgArg("~/x").abs, join(homedir(), "x"), "~/x → home 前缀展开");
  assert.equal(core.resolvePkgArg("/abs/path").kind, "path", "绝对路径 → path");
  assert.equal(core.resolvePkgArg("@scope/name").kind, "spec", "@scope/name 包规格 → spec 原样透传");
  assert.equal(core.resolvePkgArg("https://github.com/a/b.git").kind, "spec", "git URL → spec 原样透传");
  assert.equal(core.resolvePkgArg("@scope/name").abs, null, "spec 无 abs");
  // readDshPort：B6 parsed 通道（0.1.2-rc.1 实证格式）
  assert.equal(core.readDshPort("dsh web: http://127.0.0.1:34567/?token=abc"), 34567, "readDshPort 解析端口行");
  assert.equal(core.readDshPort("noise line\nsome other output"), null, "readDshPort 无端口行返回 null");
  // P2-6/7：截断 chunk 尾部（无 / 或 ? 收尾）不 latch；端口范围 1-65535 外视为无匹配
  assert.equal(core.readDshPort("dsh web: http://127.0.0.1:34"), null, "readDshPort 截断端口行不 latch（行完整性）");
  assert.equal(core.readDshPort("dsh web: http://127.0.0.1:70000/?token=abc"), null, "readDshPort 端口范围校验（>65535 → null）");
  assert.equal(core.readDshPort("dsh web: http://127.0.0.1:0/?token=abc"), null, "readDshPort 端口范围校验（0 → null）");

  // 6b. 关键契约文本锚定（不锁脚本细节，锁对外契约面；#517 C11 归一化语义由
  // 6a resolvePkgArg 行为断言覆盖——内建进 verify-core，不依赖 C11 独立文件）
  const script = readFileSync(scriptFile, "utf8");
  for (const opt of ["--dsh", "--port 0", "--browser", "--keep", "--no-build", "--evidence-dir", "--json"]) {
    assert.ok(script.includes(opt), `脚本含 ${opt} 选项契约`);
  }
  assert.ok(script.includes("verdict.json"), "脚本含 B6 verdict.json 契约");
  assert.ok(script.includes("dsh.log"), "脚本含 dsh.log 收集契约");
  for (const code of ["130", "143"]) assert.ok(script.includes(code), `退出码契约表含 ${code}`);
  // B6 verdict schema 字段集锚（从单字符串锚升级为字段序列 + 关键值）
  for (const field of [
    "v:", "ok:", "dsh:", "dshHome:", "profile:", "port:", "pid:", "browser:",
    "telemetry:", "ready:", "readyAt:", "evidenceDir:", "cleanup:",
    "officialContract: false", "非官方契约，不承诺实际生效",
  ]) {
    assert.ok(script.includes(field), `verdict schema 含字段 ${field}`);
  }
  // 四重隔离语义锚定（#376 加固面保留）：
  assert.ok(script.includes('"--host", "127.0.0.1"'), "隔离实例显式回环绑定（锚定启动行）");
  assert.ok(script.includes("DSH_TELEMETRY_DISABLED"), "隔离实例显式禁用遥测");
  assert.ok(script.includes("randomBytes(4)"), "verify_<随机> profile 走 node crypto");
  assert.ok(script.includes('["plugin", "--profile", profile, "list"]'),
    "profile 初始化用显式 plugin list（不再依赖 add --help 隐式初始化）");
  // 用户可见契约文案（SKILL.md §5.1 自检清单与就绪/清理流程依赖）：
  assert.ok(script.includes("就绪断言通过"), "就绪断言通过输出");
  assert.ok(script.includes("15s 内未就绪"), "就绪超时可操作错误");
  assert.ok(script.includes("进程在就绪前退出"), "就绪探测核对 dsh 进程存活（防端口被占假阳性）");
  assert.ok(script.includes("AbortSignal.timeout"), "就绪探测带超时（不裸连）");
  assert.ok(script.includes("--no-build 但缺少构建产物"), "--no-build 缺产物报可操作错误");
  assert.ok(script.includes("源码比构建产物新"), "--no-build 陈旧产物 mtime 警告");
  // C11 语义注释在 lib/verify-core.mjs（resolvePkgArg 归属处）
  const coreSrc = readFileSync(join(SCRIPTS_DIR, "lib", "verify-core.mjs"), "utf8");
  assert.ok(coreSrc.includes("dsh 会把非绝对路径当 git URL 解析"), "脚本注释声明相对路径 git URL 陷阱（#517 C11）");
}

// ---- 6c. 子进程退出码实测（不启动 dsh / 浏览器，走 --dsh 不存在与 --help 路径） ----
{
  const run = (args) => {
    let code = 0;
    let out = "";
    try { out = execFileSync(process.execPath, [scriptFile, ...args], { encoding: "utf8" }); }
    catch (e) { code = e.status ?? -1; out = (e.stdout ?? "") + (e.stderr ?? ""); }
    return { code, out };
  };
  // --help：用法提示，退出码 0
  const h = run(["--help"]);
  assert.equal(h.code, 0, "--help 退出码 0");
  assert.ok(h.out.includes("verify-isolated.mjs"), "--help 含脚本名");
  // --dsh 不存在：参数错误退出码 2
  const bad = run(["--dsh", "/nonexistent/dsh"]);
  assert.equal(bad.code, 2, "--dsh 不存在退出码 2（找不到 dsh 入口）");
  // --json --dsh 不存在：stdout **恰好 1 行** JSON（含 exitCode 2；P2-10 锁定
  // stdout 只出 JSON 的约束，人类文案不得混入）
  const j = run(["--json", "--dsh", "/nonexistent/dsh"]);
  assert.equal(j.code, 2, "--json 错误路径退出码 2");
  const jLines = j.out.trim().split("\n").filter((l) => l.trim().length > 0);
  assert.equal(jLines.length, 1, "--json 错误路径 stdout 只有 1 行 JSON");
  const parsed = JSON.parse(jLines[0]);
  assert.equal(parsed.ok, false, "--json 错误对象 ok=false");
  assert.equal(parsed.exitCode, 2, "--json 错误对象 exitCode=2");
  // P1-1 回归：`--` 之后的 --json 是插件参数，不得误开全局 jsonMode
  const afterDash = run(["--dsh", "/nonexistent/dsh", "--", "--json"]);
  assert.equal(afterDash.code, 2, "-- 之后 --json 仍按参数错误退出码 2");
  assert.ok(!afterDash.out.trim().startsWith("{"), "-- 之后的 --json 不误开 jsonMode（stdout 非 JSON）");
  // 未知选项：退出码 2
  const u = run(["--bogus"]);
  assert.equal(u.code, 2, "未知选项退出码 2");
}

// ---- 6d. P1 回归（#517 C8 复核）：dsh 就绪前退出 → 契约码 1 + 可操作诊断 ----
// 复现路径：dsh web 启动即崩（端口被占 EADDRINUSE / 插件加载失败 / 就绪前净退出）。
// 修复前：exit handler 抢先 requestExit 透传 dsh 退出码 → settle 抢先 process.exit
// → waitReady 的 dead 检测与 CliError 诊断不可达（stderr 空），且 dsh exit 0 静默
// 假成功、非契约码（3）穿透契约表。修复后：就绪前退出只记录，统一走
// CliError(EXIT.FAIL=1) + 引用 dsh.log 的可操作诊断。
{
  const tmp = mkdtempSync(join(tmpdir(), "dsh-verify-smoke-"));
  try {
    // 假 dsh：--version 有输出；plugin list 创建 profile 骨架（bundle 注入要读
    // package.json，不建则 ENOENT 走不到就绪阶段）；web 启动（--host 参数）时
    // 按 FAKE_DH_EXIT 立即退出（模拟就绪前崩溃）
    const fakeDsh = join(tmp, "fake-dsh.mjs");
    writeFileSync(fakeDsh, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fake-dsh 0.0.0"); process.exit(0); }
if (args[0] === "plugin" && args.includes("list")) {
  const i = args.indexOf("--profile");
  const dir = join(process.env.DSH_HOME, "profiles", args[i + 1]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }));
  process.exit(0);
}
process.exit(Number(process.env.FAKE_DH_EXIT ?? "0"));
`);
    chmodSync(fakeDsh, 0o755);
    const runWithFake = (exitCode) => {
      let code = 0; let out = "";
      try {
        out = execFileSync(process.execPath, [scriptFile, "--dsh", fakeDsh, "--port", "0"], {
          encoding: "utf8", env: { ...process.env, FAKE_DH_EXIT: String(exitCode) }, timeout: 30000,
        });
      } catch (e) { code = e.status ?? -1; out = (e.stdout ?? "") + (e.stderr ?? ""); }
      return { code, out };
    };
    // dsh exit 0（就绪前净退出）：不得静默假成功——契约码必须 1 且 stderr 有诊断
    const fake0 = runWithFake(0);
    assert.equal(fake0.code, 1, `dsh 就绪前 exit0 时脚本退出码必须 1（不透传 0 假成功），实际 ${fake0.code}`);
    assert.ok(fake0.out.includes("就绪前退出"), "就绪前退出给可操作诊断（引用 dsh.log）");
    assert.ok(fake0.out.includes("dsh.log"), "诊断引用 dsh.log 文件路径");
    // dsh exit 3（非契约码）：不得穿透——契约码必须 1
    const fake3 = runWithFake(3);
    assert.equal(fake3.code, 1, `dsh 就绪前 exit3 时脚本退出码必须 1（不透传非契约码），实际 ${fake3.code}`);
    assert.ok(fake3.out.includes("就绪前退出"), "exit3 同样给可操作诊断");
    // --json：错误路径 stdout 单 JSON（人类文案走 stderr，只解析 stdout）、exitCode=1
    let jcode = 0; let jout = "";
    try {
      jout = execFileSync(process.execPath, [scriptFile, "--json", "--dsh", fakeDsh, "--port", "0"], {
        encoding: "utf8", env: { ...process.env, FAKE_DH_EXIT: "0" }, timeout: 30000,
      });
    } catch (e) { jcode = e.status ?? -1; jout = e.stdout ?? ""; } // stdout 单 JSON；人类文案在 stderr 不并入
    assert.equal(jcode, 1, `--json 就绪前退出 exitCode 必须 1，实际 ${jcode}`);
    const jparsed = JSON.parse(jout.trim().split("\n").filter(Boolean).at(-1));
    assert.equal(jparsed.ok, false, "--json 就绪前退出 ok=false");
    assert.equal(jparsed.exitCode, 1, "--json 就绪前退出 exitCode=1");
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // 零污染纪律（#218）
  }
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
assert.ok(readme.includes("verify-isolated.mjs"), "README 同步 node 版脚本名（升级路径）");
assert.ok(!readme.includes("scripts/verify-isolated.sh"), "README 不再以旧 bash 脚本路径作为当前用法（升级路径说明除外）");

console.log("PASS: dsh-verify-isolated smoke（skills 结构 / frontmatter / patch / 路径解析 / verify-core 行为 / 脚本契约与退出码 / 文档同步）");