/**
 * dsh-verify-isolated — smoke：skills 目录结构 + SKILL.md frontmatter + patch 配置
 * + 新增脚本参数契约（browser-driver.mjs / verify-isolated.mjs）。
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
 *    resolvePkgArg 归一化 / readDshPort parsed 通道）+ 子进程退出码实测
 *    （--help=0、--dsh 不存在=2、--json 错误=单 JSON）；
 * 7. SKILL.md 主线 + references/ 支线（渐进式披露）：主线判据与约束（四重隔离 / 并行 /
 *    DSH_HOME 感知 / 遥测 / 回环 / 版本锚定 / 访问形态边界）+ 每个 reference 都有指针
 *    与「读它的时机」+ 主线体量上限（防支线内容回灌）+ 各 reference 自包含锚点；
 * 8. README 同步新能力。
 *
 * 9. B4 隔离审计（含复核修复）：lib/audit.mjs 纯函数行为断言
 *    （WHITELIST_V 版本化、scanSnapshot/diffAgainstWhitelist/checkSymlinkEscape/
 *    runAudit）+ mkdtemp fixture 正反例（越界 symlink / 白名单外新增/删除/修改 /
 *    白名单内新增/删除/修改忽略 / link: 挂载点合法 / t1 无变化通过 / browser-profile
 *    跳过深扫 / ctimeMs 参与修改判定 / 9f dsh 启动写面进基线干净运行 pass）+
 *    脚本契约锚定（--audit / --audit-extra-dirs / 结论行 / audit.json / t0 位于
 *    就绪断言之后）+ 子进程退出码实测（--audit --help=0、--audit-extra-dirs 不存在
 *    或传文件=2、t0 前错误 JSON 恒带 audit:null）+ 9g 假 dsh 端到端回归
 *    （启动写面建模：干净运行 exit0+pass / 运行期写面 suspicious count=1）。
 *
 * 10. 首启弹窗跳过与访问令牌：lib/onboarding.mjs 纯函数（须知版本提取与降级 /
 *    settings 文档形状与注入防护 / dsh 安装根与产物定位的 fixture 正反例 / 探针
 *    表达式的 allowClick 真开关顺序 / 令牌脱敏 / 401 判据）+ readDshUrl 行完整性 +
 *    脚本与 browser-driver 契约锚定（--no-skip-onboarding、--url state、
 *    --no-auto-dismiss、导航命令接入 goto 而 eval/fill 不接入）+ SKILL/README 中英
 *    四份文档的跳过与令牌指导锚点（前提性指导缺失会让执行者卡在 401/inert 页面）。
 *
 * 注：resolve-pkg-paths.mjs 的语义已内建进
 * lib/verify-core.mjs 的 resolvePkgArg（6a 行为断言覆盖原 6.5 段语义）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

// 防回归：脚本定位必须走 skill 资源 base（注入的 Base directory），不得
// 写死 npm 副本形态的 node_modules 路径——link:/checkout 形态下该路径不存在
assert.ok(!raw.includes("node_modules/@wingsky-1"),
  "SKILL.md 不得写死 node_modules/@wingsky-1 路径（应经 skill 资源 base 定位）");

// ---- 2. 一键脚本随 skill 分发（node 实现，删除 .sh 不留 shim） ----
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

// ---- 5b. 设备模拟（视口）：纯函数行为 + 参数错误退出码（离线，不启动浏览器） ----
{
  assert.ok(help.includes("--width") && help.includes("--height"), "browser-driver --help 声明视口尺寸 flag");
  assert.ok(help.includes("--dpr"), "browser-driver --help 声明 --dpr");
  assert.ok(help.includes("--mobile"), "browser-driver --help 声明 --mobile");
  const emulationFile = join(SCRIPTS_DIR, "lib", "emulation.mjs");
  assert.ok(existsSync(emulationFile), "设备模拟纯函数 lib/emulation.mjs 随 skill 分发");

  const emu = await import(pathToFileURL(emulationFile).href);
  const get = (obj: Record<string, string>) => (n: string) => obj[n];
  assert.equal(emu.parseEmulationFlags(get({})).active, false,
    "无设备 flag 不启用模拟（页面命令走零开销路径）");
  assert.deepEqual(
    emu.parseEmulationFlags(get({ width: "375", height: "667", dpr: "2", mobile: "true" })),
    { active: true, width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
    "四个设备 flag 全部解析");
  const widthOnly = emu.parseEmulationFlags(get({ width: "375" }));
  assert.deepEqual(widthOnly, { active: true, width: 375, height: undefined, deviceScaleFactor: 1, mobile: false },
    "只给 --width：height 留空待补齐、dpr 默认 1");
  assert.deepEqual(emu.buildDeviceMetrics(widthOnly, { width: 800, height: 600 }),
    { width: 375, height: 600, deviceScaleFactor: 1, mobile: false },
    "缺省维度按页面当前视口补齐（不把 undefined 传给 CDP）");
  // 非法值必须抛错：否则 NaN/undefined 直达 CDP，用户只会看到难懂的协议报错
  for (const bad of [{ width: "0" }, { width: "abc" }, { height: "10001" }, { dpr: "0" }, { dpr: "abc" }, { dpr: "9" }]) {
    assert.throws(() => emu.parseEmulationFlags(get(bad)), /错误: --(width|height|dpr)/,
      `非法参数应抛可操作错误: ${JSON.stringify(bad)}`);
  }

  // 参数校验先于连浏览器：state 指向不存在的实例时也应报参数错误而非环境错误
  let badCode = 0; let badOut = "";
  try {
    badOut = execFileSync(process.execPath, [
      driverFile, "eval", "--state", join(tmpdir(), "nonexistent-browser.state"),
      "--width", "0", "--expression", "1",
    ], { encoding: "utf8" });
  } catch (e) { badCode = e.status ?? -1; badOut = e.stdout ?? ""; }
  assert.equal(badCode, 1, `视口参数非法应退出 1，实际 ${badCode}`);
  assert.equal(JSON.parse(badOut.trim()).ok, false, "视口参数非法输出错误 JSON");
  assert.ok(badOut.includes("--width"), "错误文案点名非法参数 --width");

  // --mobile 取值语义：「出现即启用」会让 `--mobile=false` 得到与字面相反的结果
  assert.equal(emu.parseEmulationFlags(get({ mobile: "true" })).mobile, true, "--mobile（省略值）启用移动语义");
  assert.equal(emu.parseEmulationFlags(get({ mobile: "false" })).active, false, "--mobile=false 不启用模拟");
  assert.equal(emu.parseEmulationFlags(get({ width: "375", mobile: "false" })).mobile, false,
    "--mobile=false 不打开移动语义");
  assert.throws(() => emu.parseEmulationFlags(get({ mobile: "maybe" })), /错误: --mobile/,
    "--mobile 取值非法应报错（不猜测）");

  // 逐命令 help 是实际查参入口：设备 flag 只在全局 help 可见即等于该入口失效
  const evalHelp = execFileSync(process.execPath, [driverFile, "--help", "eval"], { encoding: "utf8" });
  assert.ok(evalHelp.includes("--expression"), "逐命令 help 含该命令自身参数");
  assert.ok(evalHelp.includes("--width") && evalHelp.includes("--dpr"), "逐命令 help 含设备模拟 flag");

  // 七条页面命令都必须走设备模拟路径：任何一条改回直连 connectPage，都会让
  // --width 等 flag 在该命令上静默失效（单命令回退的回归盲区）
  const driverSrc = readFileSync(driverFile, "utf8");
  for (const cmd of ["cmdSnapshot", "cmdClick", "cmdEval", "cmdFill", "cmdWait", "cmdScreenshot", "cmdConsole"]) {
    const body = driverSrc.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
    assert.ok(body.includes("withPageEmulation("), `${cmd} 接入设备模拟（页面命令不得绕过 wrapper 直连）`);
  }
  assert.equal((driverSrc.match(/await connectPage\(/g) || []).length, 1,
    "connectPage 只被 withPageEmulation 调用（设备模拟单点接入）");
  // 清理静默失败会把视口残留给后续命令，两条告警路径都必须留在代码里
  assert.ok(driverSrc.includes("设备模拟清理失败"), "清理抛错路径有可见警告");
  assert.ok(driverSrc.includes("设备模拟清理后视口未复原"), "清理后回读核对是否复原");
}

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
  // resolvePkgArg：归一化语义内建（相对路径绝对化 / 包规格原样透传 / ~ 展开）
  //（cwd = 包根，smoke 由 pnpm -r 在各包目录执行）
  assert.equal(core.resolvePkgArg("skills").kind, "path", "cwd 存在的相对路径 → path");
  assert.equal(core.resolvePkgArg("./skills").kind, "path", "形态类路径 ./ → path");
  assert.equal(core.resolvePkgArg("~").kind, "path", "~ → path（home 展开）");
  assert.equal(core.resolvePkgArg("~/x").abs, join(homedir(), "x"), "~/x → home 前缀展开");
  if (process.platform === "win32") {
    assert.equal(core.resolvePkgArg("~\\x").abs, join(homedir(), "x"), "~\\x → home 前缀展开（Windows 反斜杠形态）");
    assert.equal(core.resolvePkgArg("C:\\abs\\path").kind, "path", "盘符绝对路径 → path");
  }
  assert.equal(core.resolvePkgArg("/abs/path").kind, "path", "绝对路径 → path");
  assert.equal(core.resolvePkgArg("@scope/name").kind, "spec", "@scope/name 包规格 → spec 原样透传");
  assert.equal(core.resolvePkgArg("https://github.com/a/b.git").kind, "spec", "git URL → spec 原样透传");
  assert.equal(core.resolvePkgArg("@scope/name").abs, null, "spec 无 abs");
  // readDshPort：B6 parsed 通道（0.1.2-rc.1 实证格式）
  assert.equal(core.readDshPort("dsh web: http://127.0.0.1:34567/?token=abc"), 34567, "readDshPort 解析端口行");
  assert.equal(core.readDshPort("noise line\nsome other output"), null, "readDshPort 无端口行返回 null");
  // 截断 chunk 尾部（无 / 或 ? 收尾）不 latch；端口范围 1-65535 外视为无匹配
  assert.equal(core.readDshPort("dsh web: http://127.0.0.1:34"), null, "readDshPort 截断端口行不 latch（行完整性）");
  assert.equal(core.readDshPort("dsh web: http://127.0.0.1:70000/?token=abc"), null, "readDshPort 端口范围校验（>65535 → null）");
  assert.equal(core.readDshPort("dsh web: http://127.0.0.1:0/?token=abc"), null, "readDshPort 端口范围校验（0 → null）");

  // 6b. 关键契约文本锚定（不锁脚本细节，锁对外契约面；归一化语义由
  // 6a resolvePkgArg 行为断言覆盖——内建进 verify-core，不依赖独立文件）
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
  // 四重隔离语义锚定：
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
  // 归一化语义注释在 lib/verify-core.mjs（resolvePkgArg 归属处）
  const coreSrc = readFileSync(join(SCRIPTS_DIR, "lib", "verify-core.mjs"), "utf8");
  assert.ok(coreSrc.includes("dsh 会把非绝对路径当 git URL 解析"), "脚本注释声明相对路径 git URL 陷阱");
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
  // --json --dsh 不存在：stdout **恰好 1 行** JSON（含 exitCode 2；锁定
  // stdout 只出 JSON 的约束，人类文案不得混入）
  const j = run(["--json", "--dsh", "/nonexistent/dsh"]);
  assert.equal(j.code, 2, "--json 错误路径退出码 2");
  const jLines = j.out.trim().split("\n").filter((l) => l.trim().length > 0);
  assert.equal(jLines.length, 1, "--json 错误路径 stdout 只有 1 行 JSON");
  const parsed = JSON.parse(jLines[0]);
  assert.equal(parsed.ok, false, "--json 错误对象 ok=false");
  assert.equal(parsed.exitCode, 2, "--json 错误对象 exitCode=2");
  // 回归：`--` 之后的 --json 是插件参数，不得误开全局 jsonMode
  const afterDash = run(["--dsh", "/nonexistent/dsh", "--", "--json"]);
  assert.equal(afterDash.code, 2, "-- 之后 --json 仍按参数错误退出码 2");
  assert.ok(!afterDash.out.trim().startsWith("{"), "-- 之后的 --json 不误开 jsonMode（stdout 非 JSON）");
  // 未知选项：退出码 2
  const u = run(["--bogus"]);
  assert.equal(u.code, 2, "未知选项退出码 2");
}

// ---- 6d. 回归：dsh 就绪前退出 → 契约码 1 + 可操作诊断 ----
// 复现路径：dsh web 启动即崩（端口被占 EADDRINUSE / 插件加载失败 / 就绪前净退出）。
// 修复前：exit handler 抢先 requestExit 透传 dsh 退出码 → settle 抢先 process.exit
// → waitReady 的 dead 检测与 CliError 诊断不可达（stderr 空），且 dsh exit 0 静默
// 假成功、非契约码（3）穿透契约表。修复后：就绪前退出只记录，统一走
// CliError(EXIT.FAIL=1) + 引用 dsh.log 的可操作诊断。
// win32：.mjs 夹具无法直接 spawn（shebang 仅 POSIX 语义）——按产品 win32 设计
// 路径提供 .cmd 入口（isWinScript → shell:true 回退），垫片转发到 node。
function winCmdShimFor(scriptAbs) {
  if (process.platform !== "win32") return scriptAbs;
  const cmdShim = join(dirname(scriptAbs), `${basename(scriptAbs, ".mjs")}.cmd`);
  writeFileSync(cmdShim, `@echo off\r\n"${process.execPath}" "%~dp0${basename(scriptAbs)}" %*\r\n`);
  return cmdShim;
}

{
  const tmp = mkdtempSync(join(tmpdir(), "dsh-verify-smoke-"));
  try {
    // 假 dsh：--version 有输出；plugin list 创建 profile 骨架（bundle 注入要读
    // package.json，不建则 ENOENT 走不到就绪阶段）；web 启动（--host 参数）时
    // 按 FAKE_DH_EXIT 立即退出（模拟就绪前崩溃）
    const fakeDshScript = join(tmp, "fake-dsh.mjs");
    writeFileSync(fakeDshScript, `#!/usr/bin/env node
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
    chmodSync(fakeDshScript, 0o755);
    const fakeDsh = winCmdShimFor(fakeDshScript);
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
    rmSync(tmp, { recursive: true, force: true }); // 零污染纪律
  }
}

// ---- 7. SKILL.md 主线 + references/ 支线（渐进式披露：内容随分支下沉） ----
// 断言跟随内容位置：主线判据留在 SKILL.md，支线（内核 / 视口 / 手动步骤 / 脚本契约）
// 在各自的 reference 里自包含——把支线内容抄回正文以满足旧断言，会让披露重新退化。
const REF_DIR = join(SKILL_DIR, "references");
const REF_FILES = ["script-contracts.md", "manual-setup.md", "browser-kernel.md", "viewport-geometry.md"];
for (const name of REF_FILES) {
  assert.ok(existsSync(join(REF_DIR, name)), `支线参考 references/${name} 随 skill 分发`);
}
const refText = (name) => readFileSync(join(REF_DIR, name), "utf8");

// 7a. 主线：每次触发都要用的判据与约束
assert.ok(raw.includes("四重隔离"), "SKILL.md 含四重隔离说明");
assert.ok(raw.includes("多会话并行"), "SKILL.md 含多会话并行约束");
assert.ok(raw.includes("DSH_HOME 感知"), "SKILL.md 自检清单含插件 DSH_HOME 感知项");
assert.ok(raw.includes("DSH_TELEMETRY_DISABLED=1"), "SKILL.md 含遥测禁用原则");
assert.ok(raw.includes("--host 127.0.0.1"), "SKILL.md 含显式回环原则");
assert.ok(raw.includes("--dsh"), "SKILL.md 含 --dsh 版本锚定用法");
assert.ok(raw.includes("--trusted-host"), "SKILL.md 声明非回环访问形态的边界与官方选项");

// 7b. 指针：每个 reference 都要有指向它的入口，且声明读它的时机（否则等于不可达）
for (const name of REF_FILES) assert.ok(raw.includes(name), `SKILL.md 指向 references/${name}`);
assert.ok(raw.includes("唯一事实源"), "SKILL.md 声明 --help 为选项契约唯一事实源（正文不复述）");
const skillLines = raw.split("\n").length;
assert.ok(skillLines < 260, `SKILL.md 保持主线体量（实际 ${skillLines} 行，超限说明支线内容回灌正文）`);

// 7c. 支线：各自的 reference 自包含
const kernelRef = refText("browser-kernel.md");
for (const anchor of ["DSH_VERIFY_CHROME", "ms-playwright", "Google Chrome.app", "ProgramFiles"]) {
  assert.ok(kernelRef.includes(anchor), `references/browser-kernel.md 含内核锚点 ${anchor}`);
}
const vpRef = refText("viewport-geometry.md");
for (const anchor of ["--width", "设备视口与几何验证", "基线档", "resizeTo", "ontouchstart"]) {
  assert.ok(vpRef.includes(anchor), `references/viewport-geometry.md 含视口锚点 ${anchor}`);
}
assert.ok(vpRef.includes("高度不生效"), "references/viewport-geometry.md 保留 resizeTo 不可用的理由");
// 防照抄锁：resizeTo 只作为「为何不用」的事实出现，示例代码块里不得再出现
assert.ok(vpRef.split("```bash").slice(1).every((b) => !b.split("```")[0].includes("resizeTo")),
  "references/viewport-geometry.md 示例代码块不出现 resizeTo");
const manualRef = refText("manual-setup.md");
for (const anchor of ["DSH_HOME=$(mktemp -d)", "WELCOME_NOTICE_VERSION", "DSH_WEB_URL", "browser-driver.mjs"]) {
  assert.ok(manualRef.includes(anchor), `references/manual-setup.md 含手动步骤锚点 ${anchor}`);
}
const contractRef = refText("script-contracts.md");
for (const anchor of ["WHITELIST_V", "verdict.json", "退出码", "symlink", "t0"]) {
  assert.ok(contractRef.includes(anchor), `references/script-contracts.md 含契约锚点 ${anchor}`);
}

// ---- 8. README 同步新能力 ----
const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
assert.ok(readme.includes("browser-driver.mjs"), "README 同步 browser-driver");
assert.ok(readme.includes("--browser"), "README 同步 --browser 用法");
assert.ok(readme.includes("四重隔离"), "README 同步四重隔离说明");
assert.ok(readme.includes("verify-isolated.mjs"), "README 同步 node 版脚本名（升级路径）");
assert.ok(readme.includes("emulation.mjs"), "README 同步设备模拟纯函数模块");
assert.ok(readme.includes("--width"), "README 同步视口档位用法");
assert.ok(!readme.includes("scripts/verify-isolated.sh"), "README 不再以旧 bash 脚本路径作为当前用法（升级路径说明除外）");

// ---- 9. B4 隔离审计：lib/audit.mjs 纯函数行为断言 + 脚本契约锚定 + 退出码实测 ----
// win32：目录符号链接需特权，junction 无需且 lstat/realpath 语义一致，
// 越界检测（realpath 落点在扫描根外）不受影响。
const SYMLINK_TYPE = process.platform === "win32" ? "junction" : "dir";
{
  const auditFile = join(SCRIPTS_DIR, "lib", "audit.mjs");
  assert.ok(existsSync(auditFile), "lib/audit.mjs 随 skill 目录分发");
  const audit = await import(pathToFileURL(auditFile).href);

  // 9a. 白名单版本化 + 模式全集存在（预置模式数组，版本化 WHITELIST_V；
  // v2 起含 dsh 自身写面 .credentials.yaml / storages/**；
  // v3 起含 settings.yaml——首启弹窗跳过会预置它，页面改设置也由 dsh 重写）
  assert.match(audit.WHITELIST_V, /^v\d+$/, `WHITELIST_V 版本化格式: ${audit.WHITELIST_V}`);
  for (const p of [
    "profiles/**", "*.json", "*.jsonl", "*.log", ".credentials.yaml", "settings.yaml",
    "browser.state", "browser-profile/**", "evidence/**", "audit/**",
    "storages/**", "dsh.log", "verdict.json",
  ]) {
    assert.ok(audit.WHITELIST.includes(p), `预置白名单含 ${p}`);
  }

  // 9b. 脚本契约锚定（USAGE/parseCli/--help 同步义务 + 结论行文案 + 落盘契约）
  const script = readFileSync(scriptFile, "utf8");
  for (const opt of ["--audit", "--audit-extra-dirs"]) {
    assert.ok(script.includes(opt), `脚本含 ${opt} 选项契约`);
  }
  assert.ok(script.includes("WHITELIST_V"), "脚本引用版本化白名单常量");
  assert.ok(script.includes("审计:通过"), "审计结论行通过文案");
  assert.ok(script.includes("项可疑"), "审计结论行可疑文案");
  assert.ok(script.includes("audit.json"), "审计报告落盘契约（--keep 落 $ISOLATED_HOME/audit/audit.json）");
  // 回归：t0 基线必须在**就绪断言通过之后**（dsh 启动写面与官方
  // bundle link 进基线——语义「就绪后运行期写面审计」，源码位置锚定）
  assert.ok(
    script.indexOf("auditBaseline = [") > script.indexOf("就绪断言通过"),
    "t0 基线快照位于就绪断言通过之后（时序）",
  );

  // 9c. 子进程退出码实测：--audit 不破坏退出码契约（0/2）；extra dir 不存在/
  // 非目录 → 2；t0 前错误路径 --json 单 JSON 恒带 audit:null
  const run = (args) => {
    let code = 0;
    let out = "";
    try { out = execFileSync(process.execPath, [scriptFile, ...args], { encoding: "utf8" }); }
    catch (e) { code = e.status ?? -1; out = (e.stdout ?? "") + (e.stderr ?? ""); }
    return { code, out };
  };
  const h2 = run(["--audit", "--help"]);
  assert.equal(h2.code, 0, "--audit --help 退出码 0");
  assert.ok(h2.out.includes("--audit-extra-dirs"), "--help 含 --audit-extra-dirs 用法");
  const badExtra = run(["--audit", "--audit-extra-dirs", join(tmpdir(), "dsh-verify-no-such-audit-dir-xyz")]);
  assert.equal(badExtra.code, 2, "--audit-extra-dirs 目录不存在退出码 2（参数错误）");
  // M4：--audit-extra-dirs 传文件 → 参数错误（exit 2，不得静默漏审）
  const fileAsExtra = mkdtempSync(join(tmpdir(), "dsh-verify-extra-file-"));
  const plainFile = join(fileAsExtra, "afile");
  writeFileSync(plainFile, "x");
  const badFile = run(["--audit", "--audit-extra-dirs", plainFile]);
  assert.equal(badFile.code, 2, "--audit-extra-dirs 传文件退出码 2（必须是目录）");
  assert.ok(badFile.out.includes("必须是目录"), "--audit-extra-dirs 非目录报可操作错误");
  // t0 前错误（extra-dir 不存在）--json 单 JSON 恒带 audit:null（与 verdict 对齐）
  const m6 = run(["--json", "--audit", "--audit-extra-dirs", join(tmpdir(), "dsh-verify-no-such-audit-dir-m6")]);
  assert.equal(m6.code, 2, "--json t0 前错误路径退出码 2");
  const m6Lines = m6.out.trim().split("\n").filter((l) => l.trim().length > 0);
  assert.equal(m6Lines.length, 1, "--json t0 前错误路径 stdout 只有 1 行 JSON");
  const m6Parsed = JSON.parse(m6Lines[0]);
  assert.ok(Object.prototype.hasOwnProperty.call(m6Parsed, "audit"), "error JSON 恒带 audit 字段");
  assert.equal(m6Parsed.audit, null, "t0 前错误 audit=null（未进入审计）");

  // 9g. --audit 端到端回归：假 dsh 就绪前建模 dsh 启动写面
  // （官方 bundle link 指向外部 + .credentials.yaml + storages/**），验证：
  //   变体 A（干净运行）：exit 0 + 审计:通过 + verdict.audit pass + --keep 落盘
  //   audit/audit.json（启动写面进 t0 基线 → 不误报，核心回归）；
  //   变体 B（运行期写面）：RUNTIME_WRITE → exit 0 + verdict.audit suspicious
  //   count=1（mystery.bin）——「就绪后运行期写面审计」语义仍生效。
  {
    const tmp2 = mkdtempSync(join(tmpdir(), "dsh-verify-audit-e2e-"));
    const fakeDsh = join(tmp2, "fake-dsh-audit.mjs");
    writeFileSync(fakeDsh, `#!/usr/bin/env node
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fake-dsh 0.0.0"); process.exit(0); }
if (args[0] === "plugin" && args.includes("list")) {
  const i = args.indexOf("--profile");
  const dir = join(process.env.DSH_HOME, "profiles", args[i + 1]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }));
  process.exit(0);
}
if (args[0] === "plugin" && args.includes("add")) { process.exit(0); }
if (args.includes("--host")) {
  const H = process.env.DSH_HOME;
  const pi = args.indexOf("--profile");
  const prof = args[pi + 1];
  mkdirSync(join(H, "profiles", prof, "node_modules", "@deepseek-ai"), { recursive: true });
  // 悬空 bundle 链接：win32 目符号链接需特权，junction 无需且悬空语义一致。
  if (process.platform === "win32") {
    symlinkSync("C:\\\\nonexistent\\\\dsh-install\\\\lib", join(H, "profiles", prof, "node_modules", "@deepseek-ai", "dsh-base"), "junction");
  } else {
    symlinkSync("/nonexistent/dsh-install/lib", join(H, "profiles", prof, "node_modules", "@deepseek-ai", "dsh-base"), "dir");
  }
  writeFileSync(join(H, ".credentials.yaml"), "token: fake\\n");
  mkdirSync(join(H, "storages"), { recursive: true });
  writeFileSync(join(H, "storages", "workspace.json"), "{}");
  const port = Number(args[args.indexOf("--port") + 1]);
  const srv = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  srv.on("error", () => process.exit(1));
  srv.listen(port, "127.0.0.1", () => {
    console.log("dsh web: http://127.0.0.1:" + port + "/");
    if (process.env.RUNTIME_WRITE === "1") {
      setTimeout(() => writeFileSync(join(H, "mystery.bin"), "runtime-write"), 2000);
    }
    setTimeout(() => { srv.close(); process.exit(0); }, 2500);
  });
  setTimeout(() => { srv.close(); process.exit(0); }, 3000);
  await new Promise(() => {});
}
process.exit(1);
`);
    chmodSync(fakeDsh, 0o755);
    const fakeDshEntry = winCmdShimFor(fakeDsh);
    const runAuditE2E = (extraEnv) => {
      let code = 0;
      let out = "";
      try {
        out = execFileSync(process.execPath, [scriptFile, "--audit", "--keep", "--dsh", fakeDshEntry, "--port", "0"], {
          encoding: "utf8", env: { ...process.env, ...extraEnv }, timeout: 60000,
        });
      } catch (e) { code = e.status ?? -1; out = (e.stdout ?? "") + (e.stderr ?? ""); }
      const home = /DSH_HOME=([^ ]+)/.exec(out)?.[1] ?? null;
      return { code, out, home };
    };
    // 变体 A：干净运行
    const a = runAuditE2E({});
    assert.equal(a.code, 0, `变体A 干净运行 exit 0（实际 ${a.code}）`);
    assert.ok(a.out.includes("审计:通过"), "变体A 输出审计:通过");
    assert.ok(a.home && existsSync(join(a.home, "audit", "audit.json")), "变体A --keep 落盘 audit/audit.json");
    const av = JSON.parse(readFileSync(join(a.home, "verdict.json"), "utf8"));
    assert.equal(av.audit.conclusion, "pass", "变体A verdict.audit conclusion=pass");
    assert.equal(av.audit.count, 0, "变体A verdict.audit count=0（启动写面进基线不误报）");
    assert.equal(av.audit.whitelistV, audit.WHITELIST_V, "变体A verdict.audit.whitelistV 与模块一致");
    // 变体 B：运行期写面
    const b = runAuditE2E({ RUNTIME_WRITE: "1" });
    assert.equal(b.code, 0, `变体B 运行期写面 exit 0（实际 ${b.code}）`);
    const bv = JSON.parse(readFileSync(join(b.home, "verdict.json"), "utf8"));
    assert.equal(bv.audit.conclusion, "suspicious", "变体B verdict.audit conclusion=suspicious");
    assert.equal(bv.audit.count, 1, "变体B count=1");
    assert.equal(bv.audit.suspicious[0].path, "mystery.bin", "变体B 可疑路径 mystery.bin");
    // 零污染纪律：--keep 保留的隔离 home 由 smoke 显式清理
    if (a.home) rmSync(a.home, { recursive: true, force: true });
    if (b.home) rmSync(b.home, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  }

  // 9d. mkdtemp fixture 正反例（零污染纪律：全部落在 mkdtemp 隔离目录）
  const tmp = mkdtempSync(join(tmpdir(), "dsh-verify-audit-"));
  const outside = mkdtempSync(join(tmpdir(), "dsh-verify-audit-out-"));
  try {
    const w = (p, s) => { mkdirSync(join(tmp, dirname(p)), { recursive: true }); writeFileSync(join(tmp, p), s); };
    const wl = audit.WHITELIST;
    // 正例1：白名单外新增 → 可疑（新增）
    {
      const t0 = audit.scanSnapshot(tmp);
      w("mystery.bin", "x");
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      assert.equal(r.count, 1, `白名单外新增报 1 项（实际 ${r.count}）`);
      assert.equal(r.suspicious[0].path, "mystery.bin", "可疑路径正确");
      assert.equal(r.suspicious[0].type, "新增", "可疑类型为新增");
      assert.equal(r.conclusion, "suspicious", "结论 suspicious");
    }
    // 正例2：越界 symlink——新增且 resolve 后在扫描根外（顶层 + 白名单内
    // profiles/** 都报，防逃逸优先于白名单忽略）
    {
      const t0 = audit.scanSnapshot(tmp);
      symlinkSync(join(outside, "evil"), join(tmp, "evil-link"), SYMLINK_TYPE);
      mkdirSync(join(tmp, "profiles", "verify_x"), { recursive: true });
      symlinkSync(join(outside, "evil2"), join(tmp, "profiles", "verify_x", "evil2"), SYMLINK_TYPE);
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      assert.equal(r.count, 2, `新增 2 条越界 symlink（实际 ${r.count}）`);
      assert.ok(r.suspicious.some((s) => s.path === "evil-link" && s.type === "越界 symlink"),
        "新增越界 symlink 报可疑");
      assert.ok(r.suspicious.some((s) => s.path === "profiles/verify_x/evil2" && s.type === "越界 symlink"),
        "白名单内新增越界 symlink 仍报（防逃逸优先）");
      // 越界 symlink 不重复报「新增」（防逃逸通道优先，diff 剔除）
      assert.ok(!r.suspicious.some((s) => s.path === "evil-link" && s.type === "新增"),
        "越界 symlink 不重复报新增");
    }
    // 正例3：白名单外删除 → 可疑（删除）
    {
      w("doomed.bin", "x");
      const t0 = audit.scanSnapshot(tmp);
      rmSync(join(tmp, "doomed.bin"));
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      assert.equal(r.count, 1, `白名单外删除报 1 项（实际 ${r.count}）`);
      assert.ok(r.suspicious.some((s) => s.path === "doomed.bin" && s.type === "删除"),
        "白名单外删除报可疑");
    }
    // 正例4：白名单外修改（size 变化）→ 可疑（修改）
    {
      w("mut.bin", "aa");
      const t0 = audit.scanSnapshot(tmp);
      w("mut.bin", "bbbb");
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      assert.equal(r.count, 1, `白名单外修改报 1 项（实际 ${r.count}）`);
      assert.ok(r.suspicious.some((s) => s.path === "mut.bin" && s.type === "修改"),
        "白名单外修改报可疑");
    }
    // 同 size 同 mtimeMs 快速重写经 ctimeMs 检出——直接构造
    // Entry（不依赖文件系统时间精度，验证 ctimeMs 参与修改判定逻辑本身）
    {
      const mk = (ctimeMs) => ({
        root: tmp,
        entries: new Map([["rewrite.bin", { type: "file", size: 4, mtimeMs: 1000, ctimeMs }]]),
      });
      const r = audit.runAudit({ t0: mk(1000), t1: mk(1001), isolatedRoot: tmp });
      assert.equal(r.count, 1, "同 size 同 mtimeMs、ctimeMs 不同 → 报 1 项修改");
      assert.equal(r.suspicious[0].type, "修改", "ctimeMs 变化报「修改」");
    }
    // 反例1：白名单内变化忽略（*.json/*.log/.credentials.yaml/browser.state/
    // profiles/**/evidence/**/audit/**/storages/**）
    {
      const t0 = audit.scanSnapshot(tmp);
      w("settings.json", "{}");
      w("browser.state", "{}");
      w("dsh.log", "hello");
      w(".credentials.yaml", "token: x\n");
      w("profiles/verify_x/p.json", "{}");
      w("evidence/shot.png", "x");
      w("audit/audit.json", "{}");
      w("storages/workspace.json", "{}");
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp, whitelist: wl });
      assert.equal(r.count, 0, `白名单内变化忽略（实际 ${r.count}）`);
      assert.equal(r.conclusion, "pass", "结论 pass");
    }
    // 反例1b（m4 补强）：白名单内删除/修改忽略
    {
      w("wl-del.json", "{}");
      w("wl-mod.log", "old");
      const t0 = audit.scanSnapshot(tmp);
      rmSync(join(tmp, "wl-del.json")); // 白名单内删除（*.json）
      w("wl-mod.log", "new content"); // 白名单内修改（*.log）
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      assert.equal(r.count, 0, `白名单内删除/修改忽略（实际 ${r.count}）`);
      assert.equal(r.conclusion, "pass", "白名单内删除/修改结论 pass");
    }
    // 反例2：t0 已存在且目标未变的外部 symlink（link: 挂载点）不报
    {
      mkdirSync(join(tmp, "profiles", "verify_x", "node_modules"), { recursive: true });
      symlinkSync(join(outside, "pkg"), join(tmp, "profiles", "verify_x", "node_modules", "pkg"), SYMLINK_TYPE);
      const t0 = audit.scanSnapshot(tmp);
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      assert.ok(!r.suspicious.some((s) => s.path.includes("node_modules")),
        "t0 已存在且目标未变的外部 symlink（link: 挂载点）不报");
    }
    // 反例3：t1 无变化 → 通过
    {
      const s0 = audit.scanSnapshot(tmp);
      const s1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0: s0, t1: s1, isolatedRoot: tmp });
      assert.equal(r.count, 0, "t1 无变化 0 可疑");
      assert.equal(r.conclusion, "pass", "t1 无变化结论 pass");
    }
    // 9e. browser-profile/** 整树白名单 + 跳过深扫（数万文件，只记目录条目）
    {
      w("browser-profile/deep/file", "y");
      const s = audit.scanSnapshot(tmp, { skipDeep: audit.SKIP_DEEP });
      assert.ok(s.entries.has("browser-profile"), "browser-profile 目录条目在位");
      assert.ok(!s.entries.has("browser-profile/deep/file"), "browser-profile/** 跳过深扫");
    }
    // 9f. dsh 启动写面回归（纯函数层）：t0 含官方 bundle link（指向
    // 扫描根外、t0 已存在未变 → 合法挂载点）+ .credentials.yaml + storages/**，
    // 干净运行 pass；运行期新增（白名单外）仍报——「就绪后运行期写面审计」语义
    {
      mkdirSync(join(tmp, "profiles", "verify_x", "node_modules", "@deepseek-ai"), { recursive: true });
      symlinkSync(join(outside, "dsh-install-lib"), join(tmp, "profiles", "verify_x", "node_modules", "@deepseek-ai", "dsh-base"), SYMLINK_TYPE);
      w(".credentials.yaml", "token: x\n");
      w("storages/workspace.json", "{}");
      const t0 = audit.scanSnapshot(tmp, { skipDeep: audit.SKIP_DEEP });
      // 干净运行：t1 无变化 → pass（启动写面在基线内，483 条 bundle link 场景建模）
      const r1 = audit.runAudit({ t0, t1: audit.scanSnapshot(tmp, { skipDeep: audit.SKIP_DEEP }), isolatedRoot: tmp });
      assert.equal(r1.count, 0, `启动写面进 t0 基线，干净运行 pass（实际 ${r1.count}）`);
      assert.equal(r1.conclusion, "pass", "干净运行结论 pass");
      // 运行期新增（白名单外）→ 仍报
      w("runtime-mystery.bin", "x");
      const r2 = audit.runAudit({ t0, t1: audit.scanSnapshot(tmp, { skipDeep: audit.SKIP_DEEP }), isolatedRoot: tmp });
      assert.equal(r2.count, 1, `运行期新增仍报 1 项（实际 ${r2.count}）`);
      assert.equal(r2.suspicious[0].path, "runtime-mystery.bin", "运行期新增路径正确");
      assert.equal(r2.suspicious[0].type, "新增", "运行期新增类型为新增");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // 零污染纪律
    rmSync(outside, { recursive: true, force: true });
  }
}

// ---- 10. 首启弹窗跳过（onboarding）与访问令牌 ----
{
  const onboardingFile = join(SCRIPTS_DIR, "lib", "onboarding.mjs");
  assert.ok(existsSync(onboardingFile), "首启弹窗跳过纯函数 lib/onboarding.mjs 随 skill 分发");
  const ob = await import(pathToFileURL(onboardingFile).href);

  // 10a. 须知版本提取：命中真实产物形态 / 未命中返回 null。降级而非抛错是契约——
  // dsh 改了常量形态时应当「不预置 + 浏览器兜底」，而不是伪造版本来假装跳过
  assert.equal(
    ob.extractWelcomeNoticeVersion('const WELCOME_NOTICE_VERSION = "2026-08-13.1";'),
    "2026-08-13.1", "从客户端产物提取须知版本");
  assert.equal(ob.extractWelcomeNoticeVersion("nothing here"), null, "无版本常量返回 null（降级不抛）");
  assert.equal(ob.extractWelcomeNoticeVersion(null), null, "null 输入返回 null");

  // 10b. settings 文档形状 + 注入防护：settings.yaml 是 dsh 要解析的结构化文档，
  // 意外字符会改写命名空间结构而不只是一个字段值
  assert.equal(ob.welcomeSettingsDocument("2026-08-13.1"),
    "ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n", "settings 文档形状");
  assert.throws(() => ob.welcomeSettingsDocument("bad\nvalue"), /意外字符/, "版本含换行被拒绝");

  // 10c. dsh 安装根与产物定位（mkdtemp fixture 建模 npm 提升布局）
  const fix = mkdtempSync(join(tmpdir(), "dsh-verify-onboarding-"));
  const fixBare = mkdtempSync(join(tmpdir(), "dsh-verify-onboarding-bare-"));
  try {
    const dshRoot = join(fix, "node_modules", "@deepseek-ai", "dsh");
    const clientDir = join(dshRoot, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models");
    mkdirSync(join(dshRoot, "lib"), { recursive: true });
    mkdirSync(join(clientDir, "lib"), { recursive: true });
    writeFileSync(join(dshRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }));
    writeFileSync(join(dshRoot, "lib", "bin.js"), "");
    writeFileSync(join(clientDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-client-ui-settings-models" }));
    writeFileSync(join(clientDir, "lib", "client.js"), 'const WELCOME_NOTICE_VERSION = "2099-01-01.1";');
    const bin = join(dshRoot, "lib", "bin.js");
    assert.equal(ob.dshRootOf(bin), dshRoot, "dshRootOf 从入口向上解析安装根");
    assert.equal(ob.welcomeClientFileOf(dshRoot), join(clientDir, "lib", "client.js"),
      "welcomeClientFileOf 经 Node 解析算法定位产物");
    assert.equal(ob.findWelcomeNoticeVersion(bin)?.version, "2099-01-01.1", "端到端解析版本");

    // 负例用独立 fixture（依赖从一开始就不存在）：删除文件会被 require.resolve
    // 的路径缓存挡住，测不出真实的「依赖缺失」路径
    const rootBare = join(fixBare, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(rootBare, "lib"), { recursive: true });
    writeFileSync(join(rootBare, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }));
    writeFileSync(join(rootBare, "lib", "bin.js"), "");
    assert.equal(ob.welcomeClientFileOf(rootBare), null, "依赖解析失败返回 null（降级不抛）");
    assert.equal(ob.findWelcomeNoticeVersion(join(rootBare, "lib", "bin.js")), null,
      "产物缺失时端到端返回 null（预置失败只警告）");
  } finally {
    rmSync(fix, { recursive: true, force: true }); // 零污染纪律
    rmSync(fixBare, { recursive: true, force: true });
  }

  // 10d. 弹窗探针表达式：跳过文案集合（en + zh）+ click 必须是真的开关。
  // 实测曾复现「--no-auto-dismiss 仍把弹窗点掉」——探针照样 click，开关退化成
  // 只改输出文案的假开关，故此处锁死「禁止分支先于 target.click()」的顺序
  assert.deepEqual([...ob.SKIP_BUTTON_TEXTS], ["Continue", "Configure later", "继续", "稍后配置"],
    "跳过按钮文案含 en + zh（locale 变化不失效）");
  const probeAuto = ob.buildOverlayProbeExpression();
  const probeManual = ob.buildOverlayProbeExpression({ click: false });
  assert.ok(/const allowClick = true/.test(probeAuto), "默认探针允许点击");
  assert.ok(/const allowClick = false/.test(probeManual), "--no-auto-dismiss 探针禁止点击");
  for (const expr of [probeAuto, probeManual]) {
    assert.ok(expr.includes("target.click()"), "探针保留点击路径");
    assert.ok(expr.indexOf("if (!allowClick) return") < expr.indexOf("target.click()"),
      "禁止点击的分支先于 target.click()（防假开关回归）");
    assert.ok(expr.includes("root.inert !== true"), "探针以应用根 inert 为阻断判据");
    assert.ok(expr.includes(ob.AUTH_REQUIRED_MARKER), "探针携带鉴权拒绝文案判据");
  }
  assert.equal(ob.AUTH_REQUIRED_MARKER, "dsh web authentication required",
    "401 判据与 dsh web 实际文案一致");

  // 10e. 令牌脱敏：回显 URL 会随证据归档，真令牌只允许留在 0o600 的 state/log
  assert.equal(ob.redactToken("http://127.0.0.1:41915/?token=abc123"), "http://127.0.0.1:41915/?token=***",
    "回显去令牌");
  assert.equal(ob.redactToken("http://127.0.0.1:1/a?x=1&token=abc&y=2"), "http://127.0.0.1:1/a?x=1&token=***&y=2",
    "多参数下只替换令牌值");
  assert.equal(ob.redactToken(undefined), undefined, "非字符串原样返回");

  // 10f. 访问 URL 解析（令牌唯一来源）：只认 dsh 打印的完整 URL，截断即 null
  const core2 = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "verify-core.mjs")).href);
  assert.equal(core2.readDshUrl("dsh web: http://127.0.0.1:41915/?token=abc\n"),
    "http://127.0.0.1:41915/?token=abc", "readDshUrl 取带令牌 URL");
  assert.equal(core2.readDshUrl("dsh web: http://127.0.0.1:41915"), null,
    "readDshUrl 拒绝截断行（半个令牌表现为 401，比缺参数更难排查）");
  assert.equal(core2.readDshUrl("noise"), null, "readDshUrl 无行返回 null");

  // 10g. verify-isolated 契约锚定：选项 / 预置步骤 / verdict 字段 / --help
  const vScript = readFileSync(scriptFile, "utf8");
  for (const opt of ["--no-skip-onboarding", "presetWelcomeNotice", "settings.yaml", "首启弹窗预置"]) {
    assert.ok(vScript.includes(opt), `verify-isolated 含首启弹窗契约 ${opt}`);
  }
  for (const field of ["web:", "onboarding:", "tokenSource:"]) {
    assert.ok(vScript.includes(field), `verdict schema 含字段 ${field}`);
  }
  assert.ok(vScript.includes("st.dshWebUrl = webUrl"), "带令牌 URL 写入 browser.state.dshWebUrl");
  const viHelp = execFileSync(process.execPath, [scriptFile, "--help"], { encoding: "utf8" });
  assert.ok(viHelp.includes("--no-skip-onboarding"), "--help 声明 --no-skip-onboarding");
  assert.ok(viHelp.includes("令牌"), "--help 说明访问令牌（GUI 带鉴权）");

  // 10h. browser-driver 契约锚定：--url state / 弹窗开关 / 导航命令接入 goto。
  // eval 与 fill 不导航，故不得接入（要能检查弹窗本身，且不抹掉页面状态）
  const dScript = readFileSync(driverFile, "utf8");
  for (const opt of ["--no-auto-dismiss", "--overlay-wait", "dshWebUrl", "onboardingBlocked"]) {
    assert.ok(dScript.includes(opt), `browser-driver 含 ${opt} 契约`);
  }
  for (const cmd of ["cmdSnapshot", "cmdClick", "cmdWait", "cmdScreenshot"]) {
    const body = dScript.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
    assert.ok(body.includes("goto("), `${cmd} 接入导航收尾（弹窗跳过不得绕过）`);
  }
  // console 走长连接收事件（短连接的 goto 会丢事件），导航与收尾内联，但收尾必须在
  {
    const body = dScript.split("async function cmdConsole(")[1]?.split("\nasync function ")[0] ?? "";
    assert.ok(body.includes("settleOverlays("), "cmdConsole 内联接入导航收尾（弹窗跳过不得绕过）");
  }
  for (const cmd of ["cmdEval", "cmdFill"]) {
    const body = dScript.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
    assert.ok(!body.includes("goto(") && !body.includes("settleOverlays("),
      `${cmd} 不导航、不触发弹窗跳过（设计契约）`);
  }
  const drvHelp = execFileSync(process.execPath, [driverFile, "--help"], { encoding: "utf8" });
  assert.ok(drvHelp.includes("--url <url|state>"), "--help 声明 --url state 保留取值");
  assert.ok(drvHelp.includes("--no-auto-dismiss"), "--help 声明 --no-auto-dismiss");

  // 10i. 文档同步：跳过与令牌是「跑得起来」的前提，缺任一处都会让执行者卡在 401
  // 或 inert 页面上（缺陷正是文档空白导致的）
  const skillRaw = readFileSync(SKILL_FILE, "utf8");
  for (const anchor of ["--url state", "首启弹窗", "401", "token=***", "--no-skip-onboarding", "inert"]) {
    assert.ok(skillRaw.includes(anchor), `SKILL.md 含跳过/鉴权指导锚点 ${anchor}`);
  }
  const readmeZh = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
  for (const anchor of ["--no-skip-onboarding", "--url state", "token=***", "settings.yaml"]) {
    assert.ok(readmeZh.includes(anchor), `README.md 含 ${anchor}`);
  }
  const readmeEn = readFileSync(join(PKG_ROOT, "README.en.md"), "utf8");
  for (const anchor of ["--no-skip-onboarding", "--url state", "token=***", "onboarding.mjs"]) {
    assert.ok(readmeEn.includes(anchor), `README.en.md 含 ${anchor}`);
  }
}

console.log("PASS: dsh-verify-isolated smoke（skills 结构 / frontmatter / patch / 路径解析 / verify-core 行为 / 脚本契约与退出码 / B4 审计纯函数与 fixture 正反例 / 首启弹窗跳过与访问令牌 / 文档同步）");