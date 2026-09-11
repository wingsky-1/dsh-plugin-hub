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
 *
 * 迁移说明（#722 阶段 2 收口）：原文件是脚本式顶层断言（无 test()/it() 包装，vitest
 * 报 No test suite found），且**没有**兄弟包 e2e 里的 check()/failures[]/process.exit
 * 自建 runner——唯一的"汇总"是结尾一句 console.log。现迁为 describe/it：原每个编号
 * 主题块一个 describe、原每条断言一个 it，判定口径与断言集合均未改动。加载方式保持
 * 原样：仍读包内资源（SKILL.md / cordis.patch.yml / README / references）+ 动态
 * import skill 脚本（emulation / verify-core / audit / onboarding）+ execFileSync 真实
 * 子进程；端口仍是 `--port 0` 由 verify-isolated.mjs 自行 findFreePort（无固定端口）。
 *
 * 交错动作纪律：本文件大量「写 fixture → 断言 → 改 fixture → 断言」的累积序列
 * （尤以 9d 审计正反例、10c onboarding fixture 为甚），故统一以 beforeAll 逐行保留原
 * 动作顺序、并在**每个原断言位置取观测快照**（值而非引用），it 只对快照断言。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parseFrontmatter } from "../../../../shared/frontmatter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const SKILL_DIR = join(PKG_ROOT, "skills", "dsh-verify-isolated");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
const scriptFile = join(SCRIPTS_DIR, "verify-isolated.mjs");
const driverFile = join(SCRIPTS_DIR, "browser-driver.mjs");
const REF_DIR = join(SKILL_DIR, "references");
const REF_FILES = ["script-contracts.md", "manual-setup.md", "browser-kernel.md", "viewport-geometry.md"];

// win32：.mjs 夹具无法直接 spawn（shebang 仅 POSIX 语义）——按产品 win32 设计
// 路径提供 .cmd 入口（isWinScript → shell:true 回退），垫片转发到 node。
function winCmdShimFor(scriptAbs) {
  if (process.platform !== "win32") return scriptAbs;
  const cmdShim = join(dirname(scriptAbs), `${basename(scriptAbs, ".mjs")}.cmd`);
  writeFileSync(cmdShim, `@echo off\r\n"${process.execPath}" "%~dp0${basename(scriptAbs)}" %*\r\n`);
  return cmdShim;
}

// ---------------------------------------------------------------- 1. skills 目录结构 + frontmatter
describe("1. skills 目录结构 + frontmatter", () => {
  let skillExists;
  let skillRaw;
  let fm;

  beforeAll(() => {
    skillExists = existsSync(SKILL_FILE);
    skillRaw = readFileSync(SKILL_FILE, "utf8");
    fm = parseFrontmatter(skillRaw);
  });

  it("skills/dsh-verify-isolated/SKILL.md 存在", () => {
    expect(skillExists).toBeTruthy();
  });

  it("SKILL.md frontmatter name", () => {
    expect(fm.name).toBe("dsh-verify-isolated");
  });

  it("description 含隔离环境", () => {
    expect(fm.description ?? "").toMatch(/隔离环境/);
  });

  // 防回归：脚本定位必须走 skill 资源 base（注入的 Base directory），不得
  // 写死 npm 副本形态的 node_modules 路径——link:/checkout 形态下该路径不存在
  it("SKILL.md 不得写死 node_modules/@wingsky-1 路径（应经 skill 资源 base 定位）", () => {
    expect(!skillRaw.includes("node_modules/@wingsky-1")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 2. 一键脚本随 skill 分发
describe("2. 一键脚本随 skill 分发（node 实现，删除 .sh 不留 shim）", () => {
  it("verify-isolated.mjs 随 skill 目录分发", () => {
    expect(existsSync(scriptFile)).toBeTruthy();
  });

  it("verify-isolated.sh 已删除，不留 shim（skill 随包整体发布无新旧错配）", () => {
    expect(!existsSync(join(SCRIPTS_DIR, "verify-isolated.sh"))).toBeTruthy();
  });

  it("共享基础工具 lib/verify-core.mjs 随 skill 目录分发", () => {
    expect(existsSync(join(SCRIPTS_DIR, "lib", "verify-core.mjs"))).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 3. cordis.patch.yml
describe("3. cordis.patch.yml 复用官方 provider + bundledSkillDir 配置", () => {
  let patch;

  beforeAll(() => {
    patch = readFileSync(join(PKG_ROOT, "cordis.patch.yml"), "utf8");
  });

  it("patch 复用官方 dsh-skill-filesystem（archify 模式）", () => {
    expect(patch.includes("@deepseek-ai/dsh-skill-filesystem")).toBeTruthy();
  });

  it("providerName 配置", () => {
    expect(patch.includes("providerName: dsh-verify-isolated")).toBeTruthy();
  });

  it("includeDefaultRoots: false（只加载本包 skill，不加载项目/用户默认根）", () => {
    expect(patch.includes("includeDefaultRoots: false")).toBeTruthy();
  });

  it("bundledSkillDir 配置在位", () => {
    expect(patch.includes("bundledSkillDir:")).toBeTruthy();
  });

  it("bundledSkillDir 从包 manifest 解析（不猜路径）", () => {
    expect(patch.includes("@wingsky-1/dsh-verify-isolated/package.json")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 4. bundledSkillDir JS 表达式模拟
describe("4. bundledSkillDir JS 表达式模拟：从 profile baseUrl 解析包 → skills", () => {
  let resolvedSkills;

  beforeAll(() => {
    const req = createRequire(join(PKG_ROOT, "noop.js"));
    const manifestPath = req.resolve("@wingsky-1/dsh-verify-isolated/package.json");
    resolvedSkills = join(dirname(manifestPath), "skills");
  });

  it("bundledSkillDir 解析到包内 skills", () => {
    expect(resolvedSkills).toBe(join(PKG_ROOT, "skills"));
  });
});

// ---------------------------------------------------------------- 5. browser-driver.mjs 存在 + --help
describe("5. browser-driver.mjs 存在 + --help 参数契约（不启动浏览器实例）", () => {
  let driverExists;
  let help;
  let noArgExitsNonZero;

  beforeAll(() => {
    driverExists = existsSync(driverFile);
    help = execFileSync(process.execPath, [driverFile, "--help"], { encoding: "utf8" });
    noArgExitsNonZero = false;
    try { execFileSync(process.execPath, [driverFile], { encoding: "utf8" }); }
    catch { noArgExitsNonZero = true; }
  });

  it("browser-driver.mjs 随 skill 目录分发", () => {
    expect(driverExists).toBeTruthy();
  });

  it("browser-driver --help 声明统一 JSON 输出", () => {
    expect(help.includes("--json")).toBeTruthy();
  });

  // 原脚本把命令契约写在数组循环内，故按命令展开为逐条可见用例。
  const driverCommands = ["launch", "quit", "snapshot", "click", "eval", "fill", "wait", "screenshot", "console"];
  it.each(driverCommands)("browser-driver --help 契约含命令 %s", (cmd) => {
    expect(help.includes(cmd)).toBeTruthy();
  });

  it("browser-driver 无参数应非零退出（用法提示，不误启动浏览器）", () => {
    expect(noArgExitsNonZero).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 5b. 设备模拟（视口）
describe("5b. 设备模拟（视口）：纯函数行为 + 参数错误退出码（离线，不启动浏览器）", () => {
  let help;
  let emulationExists;
  let emu;
  let noFlagActive;
  let allFlagsParsed;
  let widthOnly;
  let widthOnlyMetrics;
  let badViewportCode;
  let badViewportOut;
  let evalHelp;
  let driverSrc;
  let mobileOmitted;
  let mobileFalseActive;
  let mobileFalseMobile;

  const get = (obj: Record<string, string>) => (n: string) => obj[n];

  beforeAll(async () => {
    help = execFileSync(process.execPath, [driverFile, "--help"], { encoding: "utf8" });
    const emulationFile = join(SCRIPTS_DIR, "lib", "emulation.mjs");
    emulationExists = existsSync(emulationFile);

    emu = await import(pathToFileURL(emulationFile).href);
    noFlagActive = emu.parseEmulationFlags(get({})).active;
    allFlagsParsed = emu.parseEmulationFlags(get({ width: "375", height: "667", dpr: "2", mobile: "true" }));
    widthOnly = emu.parseEmulationFlags(get({ width: "375" }));
    widthOnlyMetrics = emu.buildDeviceMetrics(widthOnly, { width: 800, height: 600 });

    // 参数校验先于连浏览器：state 指向不存在的实例时也应报参数错误而非环境错误
    badViewportCode = 0; badViewportOut = "";
    try {
      badViewportOut = execFileSync(process.execPath, [
        driverFile, "eval", "--state", join(tmpdir(), "nonexistent-browser.state"),
        "--width", "0", "--expression", "1",
      ], { encoding: "utf8" });
    } catch (e) { badViewportCode = e.status ?? -1; badViewportOut = e.stdout ?? ""; }

    // --mobile 取值语义：「出现即启用」会让 `--mobile=false` 得到与字面相反的结果
    mobileOmitted = emu.parseEmulationFlags(get({ mobile: "true" })).mobile;
    mobileFalseActive = emu.parseEmulationFlags(get({ mobile: "false" })).active;
    mobileFalseMobile = emu.parseEmulationFlags(get({ width: "375", mobile: "false" })).mobile;

    // 逐命令 help 是实际查参入口：设备 flag 只在全局 help 可见即等于该入口失效
    evalHelp = execFileSync(process.execPath, [driverFile, "--help", "eval"], { encoding: "utf8" });
    driverSrc = readFileSync(driverFile, "utf8");
  });

  it("browser-driver --help 声明视口尺寸 flag", () => {
    expect(help.includes("--width") && help.includes("--height")).toBeTruthy();
  });

  it("browser-driver --help 声明 --dpr", () => {
    expect(help.includes("--dpr")).toBeTruthy();
  });

  it("browser-driver --help 声明 --mobile", () => {
    expect(help.includes("--mobile")).toBeTruthy();
  });

  it("设备模拟纯函数 lib/emulation.mjs 随 skill 分发", () => {
    expect(emulationExists).toBeTruthy();
  });

  it("无设备 flag 不启用模拟（页面命令走零开销路径）", () => {
    expect(noFlagActive).toBe(false);
  });

  it("四个设备 flag 全部解析", () => {
    expect(allFlagsParsed).toEqual({ active: true, width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
  });

  it("只给 --width：height 留空待补齐、dpr 默认 1", () => {
    expect(widthOnly).toEqual({ active: true, width: 375, height: undefined, deviceScaleFactor: 1, mobile: false });
  });

  it("缺省维度按页面当前视口补齐（不把 undefined 传给 CDP）", () => {
    expect(widthOnlyMetrics).toEqual({ width: 375, height: 600, deviceScaleFactor: 1, mobile: false });
  });

  // 非法值必须抛错：否则 NaN/undefined 直达 CDP，用户只会看到难懂的协议报错。
  // 原脚本把 6 个非法值写在数组循环内，故逐个展开为可见用例。
  const badViewportFlags = [
    { width: "0" }, { width: "abc" }, { height: "10001" }, { dpr: "0" }, { dpr: "abc" }, { dpr: "9" },
  ];
  it.each(badViewportFlags.map((bad) => ({ title: `非法参数应抛可操作错误: ${JSON.stringify(bad)}`, bad })))("$title", ({ bad }) => {
    expect(() => emu.parseEmulationFlags(get(bad))).toThrow(/错误: --(width|height|dpr)/);
  });

  it("视口参数非法应退出 1", () => {
    expect(badViewportCode).toBe(1);
  });

  it("视口参数非法输出错误 JSON", () => {
    expect(JSON.parse(badViewportOut.trim()).ok).toBe(false);
  });

  it("错误文案点名非法参数 --width", () => {
    expect(badViewportOut.includes("--width")).toBeTruthy();
  });

  it("--mobile（省略值）启用移动语义", () => {
    expect(mobileOmitted).toBe(true);
  });

  it("--mobile=false 不启用模拟", () => {
    expect(mobileFalseActive).toBe(false);
  });

  it("--mobile=false 不打开移动语义", () => {
    expect(mobileFalseMobile).toBe(false);
  });

  it("--mobile 取值非法应报错（不猜测）", () => {
    expect(() => emu.parseEmulationFlags(get({ mobile: "maybe" }))).toThrow(/错误: --mobile/);
  });

  it("逐命令 help 含该命令自身参数", () => {
    expect(evalHelp.includes("--expression")).toBeTruthy();
  });

  it("逐命令 help 含设备模拟 flag", () => {
    expect(evalHelp.includes("--width") && evalHelp.includes("--dpr")).toBeTruthy();
  });

  // 七条页面命令都必须走设备模拟路径：任何一条改回直连 connectPage，都会让
  // --width 等 flag 在该命令上静默失效（单命令回退的回归盲区）
  const emulatedCommands = ["cmdSnapshot", "cmdClick", "cmdEval", "cmdFill", "cmdWait", "cmdScreenshot", "cmdConsole"];
  it.each(emulatedCommands)("%s 接入设备模拟（页面命令不得绕过 wrapper 直连）", (cmd) => {
    const body = driverSrc.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
    expect(body.includes("withPageEmulation(")).toBeTruthy();
  });

  it("connectPage 只被 withPageEmulation 调用（设备模拟单点接入）", () => {
    expect((driverSrc.match(/await connectPage\(/g) || []).length).toBe(1);
  });

  // 清理静默失败会把视口残留给后续命令，两条告警路径都必须留在代码里
  it("清理抛错路径有可见警告", () => {
    expect(driverSrc.includes("设备模拟清理失败")).toBeTruthy();
  });

  it("清理后回读核对是否复原", () => {
    expect(driverSrc.includes("设备模拟清理后视口未复原")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 6a. verify-core 行为断言
describe("6a. lib/verify-core.mjs import 行为断言", () => {
  let core;
  let pollHit;
  let pollTimeout;
  let freePort;
  let readDshPort;
  let rpSkillsKind;
  let rpDotSkillsKind;
  let rpTildeKind;
  let rpTildeAbs;
  let rpWinTildeAbs;
  let rpWinDriveKind;
  let rpAbsKind;
  let rpScopeKind;
  let rpGitKind;
  let rpScopeAbs;

  beforeAll(async () => {
    core = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "verify-core.mjs")).href);
    pollHit = await core.poll(() => true, 500, 50);
    pollTimeout = await core.poll(() => false, 150, 50);
    freePort = await core.findFreePort();
    readDshPort = core.readDshPort;

    // resolvePkgArg：归一化语义内建（相对路径绝对化 / 包规格原样透传 / ~ 展开）。
    // 原脚本此处的前提是「cwd = 包根」（注释：smoke 由 pnpm -r 在各包目录执行）；
    // vitest 的 cwd 是仓库根，故显式切到包根取这批观测值后立刻还原——断言判定不变。
    const cwdBefore = process.cwd();
    process.chdir(PKG_ROOT);
    try {
      rpSkillsKind = core.resolvePkgArg("skills").kind;
      rpDotSkillsKind = core.resolvePkgArg("./skills").kind;
      rpTildeKind = core.resolvePkgArg("~").kind;
      rpTildeAbs = core.resolvePkgArg("~/x").abs;
      if (process.platform === "win32") {
        rpWinTildeAbs = core.resolvePkgArg("~\\x").abs;
        rpWinDriveKind = core.resolvePkgArg("C:\\abs\\path").kind;
      }
      rpAbsKind = core.resolvePkgArg("/abs/path").kind;
      rpScopeKind = core.resolvePkgArg("@scope/name").kind;
      rpGitKind = core.resolvePkgArg("https://github.com/a/b.git").kind;
      rpScopeAbs = core.resolvePkgArg("@scope/name").abs;
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it("EXIT.OK=0（正常完成）", () => {
    expect(core.EXIT.OK).toBe(0);
  });

  it("EXIT.FAIL=1（启动或就绪失败）", () => {
    expect(core.EXIT.FAIL).toBe(1);
  });

  it("EXIT.USAGE=2（参数错误）", () => {
    expect(core.EXIT.USAGE).toBe(2);
  });

  it("EXIT.SIGINT=130（Ctrl+C 透传）", () => {
    expect(core.EXIT.SIGINT).toBe(130);
  });

  it("EXIT.SIGTERM=143（SIGTERM 透传）", () => {
    expect(core.EXIT.SIGTERM).toBe(143);
  });

  // poll：fn 立即 true / 超时 false
  it("poll 命中立即返回 true", () => {
    expect(pollHit).toBe(true);
  });

  it("poll 超时返回 false", () => {
    expect(pollTimeout).toBe(false);
  });

  // findFreePort：127.0.0.1 上探测到真实空闲端口
  it("findFreePort 返回合法端口", () => {
    expect(Number.isInteger(freePort) && freePort > 0 && freePort < 65536).toBeTruthy();
  });

  // resolvePkgArg：归一化语义内建（相对路径绝对化 / 包规格原样透传 / ~ 展开）；
  // 观测值在包根 cwd 下取得（见 beforeAll）。
  it("cwd 存在的相对路径 → path", () => {
    expect(rpSkillsKind).toBe("path");
  });

  it("形态类路径 ./ → path", () => {
    expect(rpDotSkillsKind).toBe("path");
  });

  it("~ → path（home 展开）", () => {
    expect(rpTildeKind).toBe("path");
  });

  it("~/x → home 前缀展开", () => {
    expect(rpTildeAbs).toBe(join(homedir(), "x"));
  });

  if (process.platform === "win32") {
    it("~\\x → home 前缀展开（Windows 反斜杠形态）", () => {
      expect(rpWinTildeAbs).toBe(join(homedir(), "x"));
    });

    it("盘符绝对路径 → path", () => {
      expect(rpWinDriveKind).toBe("path");
    });
  }

  it("绝对路径 → path", () => {
    expect(rpAbsKind).toBe("path");
  });

  it("@scope/name 包规格 → spec 原样透传", () => {
    expect(rpScopeKind).toBe("spec");
  });

  it("git URL → spec 原样透传", () => {
    expect(rpGitKind).toBe("spec");
  });

  it("spec 无 abs", () => {
    expect(rpScopeAbs).toBe(null);
  });

  // readDshPort：B6 parsed 通道（0.1.2-rc.1 实证格式）
  it("readDshPort 解析端口行", () => {
    expect(readDshPort("dsh web: http://127.0.0.1:34567/?token=abc")).toBe(34567);
  });

  it("readDshPort 无端口行返回 null", () => {
    expect(readDshPort("noise line\nsome other output")).toBe(null);
  });

  // 截断 chunk 尾部（无 / 或 ? 收尾）不 latch；端口范围 1-65535 外视为无匹配
  it("readDshPort 截断端口行不 latch（行完整性）", () => {
    expect(readDshPort("dsh web: http://127.0.0.1:34")).toBe(null);
  });

  it("readDshPort 端口范围校验（>65535 → null）", () => {
    expect(readDshPort("dsh web: http://127.0.0.1:70000/?token=abc")).toBe(null);
  });

  it("readDshPort 端口范围校验（0 → null）", () => {
    expect(readDshPort("dsh web: http://127.0.0.1:0/?token=abc")).toBe(null);
  });
});

// ---------------------------------------------------------------- 6b. 关键契约文本锚定
describe("6b. verify-isolated.mjs 关键契约文本锚定", () => {
  let script;
  let coreSrc;

  beforeAll(() => {
    script = readFileSync(scriptFile, "utf8");
    coreSrc = readFileSync(join(SCRIPTS_DIR, "lib", "verify-core.mjs"), "utf8");
  });

  // 归一化语义由 6a resolvePkgArg 行为断言覆盖——内建进 verify-core，不依赖独立文件
  const optionContracts = ["--dsh", "--port 0", "--browser", "--keep", "--no-build", "--evidence-dir", "--json"];
  it.each(optionContracts)("脚本含 %s 选项契约", (opt) => {
    expect(script.includes(opt)).toBeTruthy();
  });

  it("脚本含 B6 verdict.json 契约", () => {
    expect(script.includes("verdict.json")).toBeTruthy();
  });

  it("脚本含 dsh.log 收集契约", () => {
    expect(script.includes("dsh.log")).toBeTruthy();
  });

  const exitCodeContracts = ["130", "143"];
  it.each(exitCodeContracts)("退出码契约表含 %s", (code) => {
    expect(script.includes(code)).toBeTruthy();
  });

  // B6 verdict schema 字段集锚（从单字符串锚升级为字段序列 + 关键值）
  const verdictFields = [
    "v:", "ok:", "dsh:", "dshHome:", "profile:", "port:", "pid:", "browser:",
    "telemetry:", "ready:", "readyAt:", "evidenceDir:", "cleanup:",
    "officialContract: false", "非官方契约，不承诺实际生效",
  ];
  it.each(verdictFields)("verdict schema 含字段 %s", (field) => {
    expect(script.includes(field)).toBeTruthy();
  });

  // 四重隔离语义锚定：
  it("隔离实例显式回环绑定（锚定启动行）", () => {
    expect(script.includes('"--host", "127.0.0.1"')).toBeTruthy();
  });

  it("隔离实例显式禁用遥测", () => {
    expect(script.includes("DSH_TELEMETRY_DISABLED")).toBeTruthy();
  });

  it("verify_<随机> profile 走 node crypto", () => {
    expect(script.includes("randomBytes(4)")).toBeTruthy();
  });

  it("profile 初始化用显式 plugin list（不再依赖 add --help 隐式初始化）", () => {
    expect(script.includes('["plugin", "--profile", profile, "list"]')).toBeTruthy();
  });

  // 用户可见契约文案（SKILL.md §5.1 自检清单与就绪/清理流程依赖）：
  it("就绪断言通过输出", () => {
    expect(script.includes("就绪断言通过")).toBeTruthy();
  });

  it("就绪超时可操作错误", () => {
    expect(script.includes("15s 内未就绪")).toBeTruthy();
  });

  it("就绪探测核对 dsh 进程存活（防端口被占假阳性）", () => {
    expect(script.includes("进程在就绪前退出")).toBeTruthy();
  });

  it("就绪探测带超时（不裸连）", () => {
    expect(script.includes("AbortSignal.timeout")).toBeTruthy();
  });

  it("--no-build 缺产物报可操作错误", () => {
    expect(script.includes("--no-build 但缺少构建产物")).toBeTruthy();
  });

  it("--no-build 陈旧产物 mtime 警告", () => {
    expect(script.includes("源码比构建产物新")).toBeTruthy();
  });

  // 归一化语义注释在 lib/verify-core.mjs（resolvePkgArg 归属处）
  it("脚本注释声明相对路径 git URL 陷阱", () => {
    expect(coreSrc.includes("dsh 会把非绝对路径当 git URL 解析")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 6c. 子进程退出码实测
describe("6c. 子进程退出码实测（不启动 dsh / 浏览器，走 --dsh 不存在与 --help 路径）", () => {
  let h;
  let bad;
  let j;
  let jLines;
  let parsed;
  let afterDash;
  let u;

  beforeAll(() => {
    const run = (args) => {
      let code = 0;
      let out = "";
      try { out = execFileSync(process.execPath, [scriptFile, ...args], { encoding: "utf8" }); }
      catch (e) { code = e.status ?? -1; out = (e.stdout ?? "") + (e.stderr ?? ""); }
      return { code, out };
    };
    // --help：用法提示，退出码 0
    h = run(["--help"]);
    // --dsh 不存在：参数错误退出码 2
    bad = run(["--dsh", "/nonexistent/dsh"]);
    // --json --dsh 不存在：stdout **恰好 1 行** JSON（含 exitCode 2；锁定
    // stdout 只出 JSON 的约束，人类文案不得混入）
    j = run(["--json", "--dsh", "/nonexistent/dsh"]);
    jLines = j.out.trim().split("\n").filter((l) => l.trim().length > 0);
    parsed = JSON.parse(jLines[0]);
    // 回归：`--` 之后的 --json 是插件参数，不得误开全局 jsonMode
    afterDash = run(["--dsh", "/nonexistent/dsh", "--", "--json"]);
    // 未知选项：退出码 2
    u = run(["--bogus"]);
  });

  it("--help 退出码 0", () => {
    expect(h.code).toBe(0);
  });

  it("--help 含脚本名", () => {
    expect(h.out.includes("verify-isolated.mjs")).toBeTruthy();
  });

  it("--dsh 不存在退出码 2（找不到 dsh 入口）", () => {
    expect(bad.code).toBe(2);
  });

  it("--json 错误路径退出码 2", () => {
    expect(j.code).toBe(2);
  });

  it("--json 错误路径 stdout 只有 1 行 JSON", () => {
    expect(jLines.length).toBe(1);
  });

  it("--json 错误对象 ok=false", () => {
    expect(parsed.ok).toBe(false);
  });

  it("--json 错误对象 exitCode=2", () => {
    expect(parsed.exitCode).toBe(2);
  });

  it("-- 之后 --json 仍按参数错误退出码 2", () => {
    expect(afterDash.code).toBe(2);
  });

  it("-- 之后的 --json 不误开 jsonMode（stdout 非 JSON）", () => {
    expect(!afterDash.out.trim().startsWith("{")).toBeTruthy();
  });

  it("未知选项退出码 2", () => {
    expect(u.code).toBe(2);
  });
});

// ---------------------------------------------------------------- 6d. 就绪前退出回归
// 复现路径：dsh web 启动即崩（端口被占 EADDRINUSE / 插件加载失败 / 就绪前净退出）。
// 修复前：exit handler 抢先 requestExit 透传 dsh 退出码 → settle 抢先 process.exit
// → waitReady 的 dead 检测与 CliError 诊断不可达（stderr 空），且 dsh exit 0 静默
// 假成功、非契约码（3）穿透契约表。修复后：就绪前退出只记录，统一走
// CliError(EXIT.FAIL=1) + 引用 dsh.log 的可操作诊断。
describe("6d. 回归：dsh 就绪前退出 → 契约码 1 + 可操作诊断", () => {
  let tmpDir;
  let fake0;
  let fake3;
  let jcode;
  let jparsed;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dsh-verify-smoke-"));
    // 假 dsh：--version 有输出；plugin list 创建 profile 骨架（bundle 注入要读
    // package.json，不建则 ENOENT 走不到就绪阶段）；web 启动（--host 参数）时
    // 按 FAKE_DH_EXIT 立即退出（模拟就绪前崩溃）
    const fakeDshScript = join(tmpDir, "fake-dsh.mjs");
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
    fake0 = runWithFake(0);
    // dsh exit 3（非契约码）：不得穿透——契约码必须 1
    fake3 = runWithFake(3);
    // --json：错误路径 stdout 单 JSON（人类文案走 stderr，只解析 stdout）、exitCode=1
    let jout = "";
    try {
      jout = execFileSync(process.execPath, [scriptFile, "--json", "--dsh", fakeDsh, "--port", "0"], {
        encoding: "utf8", env: { ...process.env, FAKE_DH_EXIT: "0" }, timeout: 30000,
      });
    } catch (e) { jcode = e.status ?? -1; jout = e.stdout ?? ""; } // stdout 单 JSON；人类文案在 stderr 不并入
    jparsed = JSON.parse(jout.trim().split("\n").filter(Boolean).at(-1));
  }, 120_000);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true }); // 零污染纪律
  });

  it("dsh 就绪前 exit0 时脚本退出码必须 1（不透传 0 假成功）", () => {
    expect(fake0.code).toBe(1);
  });

  it("就绪前退出给可操作诊断（引用 dsh.log）", () => {
    expect(fake0.out.includes("就绪前退出")).toBeTruthy();
  });

  it("诊断引用 dsh.log 文件路径", () => {
    expect(fake0.out.includes("dsh.log")).toBeTruthy();
  });

  it("dsh 就绪前 exit3 时脚本退出码必须 1（不透传非契约码）", () => {
    expect(fake3.code).toBe(1);
  });

  it("exit3 同样给可操作诊断", () => {
    expect(fake3.out.includes("就绪前退出")).toBeTruthy();
  });

  it("--json 就绪前退出 exitCode 必须 1", () => {
    expect(jcode).toBe(1);
  });

  it("--json 就绪前退出 ok=false", () => {
    expect(jparsed.ok).toBe(false);
  });

  it("--json 就绪前退出 exitCode=1", () => {
    expect(jparsed.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------- 7. SKILL.md 主线 + references
// 断言跟随内容位置：主线判据留在 SKILL.md，支线（内核 / 视口 / 手动步骤 / 脚本契约）
// 在各自的 reference 里自包含——把支线内容抄回正文以满足旧断言，会让披露重新退化。
describe("7. SKILL.md 主线 + references/ 支线（渐进式披露：内容随分支下沉）", () => {
  let skillRaw;
  let refExists;
  let kernelRef;
  let vpRef;
  let manualRef;
  let contractRef;
  let skillLines;

  beforeAll(() => {
    skillRaw = readFileSync(SKILL_FILE, "utf8");
    refExists = {};
    for (const name of REF_FILES) refExists[name] = existsSync(join(REF_DIR, name));
    const refTextOf = (name) => readFileSync(join(REF_DIR, name), "utf8");
    kernelRef = refTextOf("browser-kernel.md");
    vpRef = refTextOf("viewport-geometry.md");
    manualRef = refTextOf("manual-setup.md");
    contractRef = refTextOf("script-contracts.md");
    skillLines = skillRaw.split("\n").length;
  });

  it.each(REF_FILES)("支线参考 references/%s 随 skill 分发", (name) => {
    expect(refExists[name]).toBeTruthy();
  });

  // 7a. 主线：每次触发都要用的判据与约束
  it("SKILL.md 含四重隔离说明", () => {
    expect(skillRaw.includes("四重隔离")).toBeTruthy();
  });

  it("SKILL.md 含多会话并行约束", () => {
    expect(skillRaw.includes("多会话并行")).toBeTruthy();
  });

  it("SKILL.md 自检清单含插件 DSH_HOME 感知项", () => {
    expect(skillRaw.includes("DSH_HOME 感知")).toBeTruthy();
  });

  it("SKILL.md 含遥测禁用原则", () => {
    expect(skillRaw.includes("DSH_TELEMETRY_DISABLED=1")).toBeTruthy();
  });

  it("SKILL.md 含显式回环原则", () => {
    expect(skillRaw.includes("--host 127.0.0.1")).toBeTruthy();
  });

  it("SKILL.md 含 --dsh 版本锚定用法", () => {
    expect(skillRaw.includes("--dsh")).toBeTruthy();
  });

  it("SKILL.md 声明非回环访问形态的边界与官方选项", () => {
    expect(skillRaw.includes("--trusted-host")).toBeTruthy();
  });

  // 7b. 指针：每个 reference 都要有指向它的入口，且声明读它的时机（否则等于不可达）
  it.each(REF_FILES)("SKILL.md 指向 references/%s", (name) => {
    expect(skillRaw.includes(name)).toBeTruthy();
  });

  it("SKILL.md 声明 --help 为选项契约唯一事实源（正文不复述）", () => {
    expect(skillRaw.includes("唯一事实源")).toBeTruthy();
  });

  it("SKILL.md 保持主线体量（未超 260 行，超限说明支线内容回灌正文）", () => {
    expect(skillLines < 260).toBeTruthy();
  });

  // 7c. 支线：各自的 reference 自包含
  const kernelAnchors = ["DSH_VERIFY_CHROME", "ms-playwright", "Google Chrome.app", "ProgramFiles"];
  it.each(kernelAnchors)("references/browser-kernel.md 含内核锚点 %s", (anchor) => {
    expect(kernelRef.includes(anchor)).toBeTruthy();
  });

  const viewportAnchors = ["--width", "设备视口与几何验证", "基线档", "resizeTo", "ontouchstart"];
  it.each(viewportAnchors)("references/viewport-geometry.md 含视口锚点 %s", (anchor) => {
    expect(vpRef.includes(anchor)).toBeTruthy();
  });

  it("references/viewport-geometry.md 保留 resizeTo 不可用的理由", () => {
    expect(vpRef.includes("高度不生效")).toBeTruthy();
  });

  // 防照抄锁：resizeTo 只作为「为何不用」的事实出现，示例代码块里不得再出现
  it("references/viewport-geometry.md 示例代码块不出现 resizeTo", () => {
    expect(vpRef.split("```bash").slice(1).every((b) => !b.split("```")[0].includes("resizeTo"))).toBeTruthy();
  });

  const manualAnchors = ["DSH_HOME=$(mktemp -d)", "WELCOME_NOTICE_VERSION", "DSH_WEB_URL", "browser-driver.mjs"];
  it.each(manualAnchors)("references/manual-setup.md 含手动步骤锚点 %s", (anchor) => {
    expect(manualRef.includes(anchor)).toBeTruthy();
  });

  const contractAnchors = ["WHITELIST_V", "verdict.json", "退出码", "symlink", "t0"];
  it.each(contractAnchors)("references/script-contracts.md 含契约锚点 %s", (anchor) => {
    expect(contractRef.includes(anchor)).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 8. README 同步新能力
describe("8. README 同步新能力", () => {
  let readme;

  beforeAll(() => {
    readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
  });

  it("README 同步 browser-driver", () => {
    expect(readme.includes("browser-driver.mjs")).toBeTruthy();
  });

  it("README 同步 --browser 用法", () => {
    expect(readme.includes("--browser")).toBeTruthy();
  });

  it("README 同步四重隔离说明", () => {
    expect(readme.includes("四重隔离")).toBeTruthy();
  });

  it("README 同步 node 版脚本名（升级路径）", () => {
    expect(readme.includes("verify-isolated.mjs")).toBeTruthy();
  });

  it("README 同步设备模拟纯函数模块", () => {
    expect(readme.includes("emulation.mjs")).toBeTruthy();
  });

  it("README 同步视口档位用法", () => {
    expect(readme.includes("--width")).toBeTruthy();
  });

  it("README 不再以旧 bash 脚本路径作为当前用法（升级路径说明除外）", () => {
    expect(!readme.includes("scripts/verify-isolated.sh")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 9. B4 隔离审计
// win32：目录符号链接需特权，junction 无需且 lstat/realpath 语义一致，
// 越界检测（realpath 落点在扫描根外）不受影响。
const SYMLINK_TYPE = process.platform === "win32" ? "junction" : "dir";

describe("9a. 白名单版本化 + 模式全集存在", () => {
  let auditExists;
  let audit;
  let whitelistV;

  beforeAll(async () => {
    const auditFile = join(SCRIPTS_DIR, "lib", "audit.mjs");
    auditExists = existsSync(auditFile);
    audit = await import(pathToFileURL(auditFile).href);
    whitelistV = audit.WHITELIST_V;
  });

  it("lib/audit.mjs 随 skill 目录分发", () => {
    expect(auditExists).toBeTruthy();
  });

  // 预置模式数组，版本化 WHITELIST_V；v2 起含 dsh 自身写面
  // .credentials.yaml / storages/**；v3 起含 settings.yaml——首启弹窗跳过会预置它，
  // 页面改设置也由 dsh 重写。
  it("WHITELIST_V 版本化格式", () => {
    expect(whitelistV).toMatch(/^v\d+$/);
  });

  const whitelistPatterns = [
    "profiles/**", "*.json", "*.jsonl", "*.log", ".credentials.yaml", "settings.yaml",
    "browser.state", "browser-profile/**", "evidence/**", "audit/**",
    "storages/**", "dsh.log", "verdict.json",
  ];
  it.each(whitelistPatterns)("预置白名单含 %s", (p) => {
    expect(audit.WHITELIST.includes(p)).toBeTruthy();
  });
});

describe("9b. 脚本契约锚定（USAGE/parseCli/--help 同步义务 + 结论行文案 + 落盘契约）", () => {
  let script;

  beforeAll(() => {
    script = readFileSync(scriptFile, "utf8");
  });

  const auditOptions = ["--audit", "--audit-extra-dirs"];
  it.each(auditOptions)("脚本含 %s 选项契约", (opt) => {
    expect(script.includes(opt)).toBeTruthy();
  });

  it("脚本引用版本化白名单常量", () => {
    expect(script.includes("WHITELIST_V")).toBeTruthy();
  });

  it("审计结论行通过文案", () => {
    expect(script.includes("审计:通过")).toBeTruthy();
  });

  it("审计结论行可疑文案", () => {
    expect(script.includes("项可疑")).toBeTruthy();
  });

  it("审计报告落盘契约（--keep 落 $ISOLATED_HOME/audit/audit.json）", () => {
    expect(script.includes("audit.json")).toBeTruthy();
  });

  // 回归：t0 基线必须在**就绪断言通过之后**（dsh 启动写面与官方
  // bundle link 进基线——语义「就绪后运行期写面审计」，源码位置锚定）
  it("t0 基线快照位于就绪断言通过之后（时序）", () => {
    expect(script.indexOf("auditBaseline = [") > script.indexOf("就绪断言通过")).toBeTruthy();
  });
});

describe("9c. --audit 子进程退出码实测", () => {
  let h2;
  let badExtra;
  let badFile;
  let m6;
  let m6Lines;
  let m6Parsed;
  let fileAsExtra;
  let plainFile;

  beforeAll(() => {
    const run = (args) => {
      let code = 0;
      let out = "";
      try { out = execFileSync(process.execPath, [scriptFile, ...args], { encoding: "utf8" }); }
      catch (e) { code = e.status ?? -1; out = (e.stdout ?? "") + (e.stderr ?? ""); }
      return { code, out };
    };
    h2 = run(["--audit", "--help"]);
    badExtra = run(["--audit", "--audit-extra-dirs", join(tmpdir(), "dsh-verify-no-such-audit-dir-xyz")]);
    // M4：--audit-extra-dirs 传文件 → 参数错误（exit 2，不得静默漏审）
    fileAsExtra = mkdtempSync(join(tmpdir(), "dsh-verify-extra-file-"));
    plainFile = join(fileAsExtra, "afile");
    writeFileSync(plainFile, "x");
    badFile = run(["--audit", "--audit-extra-dirs", plainFile]);
    // t0 前错误（extra-dir 不存在）--json 单 JSON 恒带 audit:null（与 verdict 对齐）
    m6 = run(["--json", "--audit", "--audit-extra-dirs", join(tmpdir(), "dsh-verify-no-such-audit-dir-m6")]);
    m6Lines = m6.out.trim().split("\n").filter((l) => l.trim().length > 0);
    m6Parsed = JSON.parse(m6Lines[0]);
  });

  afterAll(() => {
    if (fileAsExtra) rmSync(fileAsExtra, { recursive: true, force: true });
  });

  it("--audit --help 退出码 0", () => {
    expect(h2.code).toBe(0);
  });

  it("--help 含 --audit-extra-dirs 用法", () => {
    expect(h2.out.includes("--audit-extra-dirs")).toBeTruthy();
  });

  it("--audit-extra-dirs 目录不存在退出码 2（参数错误）", () => {
    expect(badExtra.code).toBe(2);
  });

  it("--audit-extra-dirs 传文件退出码 2（必须是目录）", () => {
    expect(badFile.code).toBe(2);
  });

  it("--audit-extra-dirs 非目录报可操作错误", () => {
    expect(badFile.out.includes("必须是目录")).toBeTruthy();
  });

  it("--json t0 前错误路径退出码 2", () => {
    expect(m6.code).toBe(2);
  });

  it("--json t0 前错误路径 stdout 只有 1 行 JSON", () => {
    expect(m6Lines.length).toBe(1);
  });

  it("error JSON 恒带 audit 字段", () => {
    expect(Object.prototype.hasOwnProperty.call(m6Parsed, "audit")).toBeTruthy();
  });

  it("t0 前错误 audit=null（未进入审计）", () => {
    expect(m6Parsed.audit).toBe(null);
  });
});

// 9g. --audit 端到端回归：假 dsh 就绪前建模 dsh 启动写面
// （官方 bundle link 指向外部 + .credentials.yaml + storages/**），验证：
//   变体 A（干净运行）：exit 0 + 审计:通过 + verdict.audit pass + --keep 落盘
//   audit/audit.json（启动写面进 t0 基线 → 不误报，核心回归）；
//   变体 B（运行期写面）：RUNTIME_WRITE → exit 0 + verdict.audit suspicious
//   count=1（mystery.bin）——「就绪后运行期写面审计」语义仍生效。
describe("9g. --audit 端到端回归（假 dsh 建模启动写面）", () => {
  let tmp2;
  let a;
  let av;
  let b;
  let bv;
  let aAuditJsonExists;
  let auditWhitelistV;

  beforeAll(async () => {
    const audit = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "audit.mjs")).href);
    tmp2 = mkdtempSync(join(tmpdir(), "dsh-verify-audit-e2e-"));
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
    a = runAuditE2E({});
    aAuditJsonExists = Boolean(a.home && existsSync(join(a.home, "audit", "audit.json")));
    av = JSON.parse(readFileSync(join(a.home, "verdict.json"), "utf8"));
    // 变体 B：运行期写面
    b = runAuditE2E({ RUNTIME_WRITE: "1" });
    bv = JSON.parse(readFileSync(join(b.home, "verdict.json"), "utf8"));
    // 零污染纪律：--keep 保留的隔离 home 由 smoke 显式清理
    if (a.home) rmSync(a.home, { recursive: true, force: true });
    if (b.home) rmSync(b.home, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
    auditWhitelistV = audit.WHITELIST_V;
  }, 180_000);

  it("变体A 干净运行 exit 0", () => {
    expect(a.code).toBe(0);
  });

  it("变体A 输出审计:通过", () => {
    expect(a.out.includes("审计:通过")).toBeTruthy();
  });

  it("变体A --keep 落盘 audit/audit.json", () => {
    expect(aAuditJsonExists).toBeTruthy();
  });

  it("变体A verdict.audit conclusion=pass", () => {
    expect(av.audit.conclusion).toBe("pass");
  });

  it("变体A verdict.audit count=0（启动写面进基线不误报）", () => {
    expect(av.audit.count).toBe(0);
  });

  it("变体A verdict.audit.whitelistV 与模块一致", () => {
    expect(av.audit.whitelistV).toBe(auditWhitelistV);
  });

  it("变体B 运行期写面 exit 0", () => {
    expect(b.code).toBe(0);
  });

  it("变体B verdict.audit conclusion=suspicious", () => {
    expect(bv.audit.conclusion).toBe("suspicious");
  });

  it("变体B count=1", () => {
    expect(bv.audit.count).toBe(1);
  });

  it("变体B 可疑路径 mystery.bin", () => {
    expect(bv.audit.suspicious[0].path).toBe("mystery.bin");
  });
});

// 9d. mkdtemp fixture 正反例（零污染纪律：全部落在 mkdtemp 隔离目录）。
// 该段是一整条累积序列（每一例复用同一个 tmp，前例写入的条目仍参与后例判定），
// 故 beforeAll 逐行重放全序列并在每个原断言位置取快照，it 只断言快照。
describe("9d. mkdtemp fixture 正反例", () => {
  let tmp;
  let outside;
  let p1;
  let p2;
  let p3;
  let p4;
  let ctime;
  let n1;
  let n1b;
  let n2;
  let n3;
  let e9;
  let f1;
  let f2;

  beforeAll(async () => {
    const audit = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "audit.mjs")).href);
    tmp = mkdtempSync(join(tmpdir(), "dsh-verify-audit-"));
    outside = mkdtempSync(join(tmpdir(), "dsh-verify-audit-out-"));
    const w = (p, s) => { mkdirSync(join(tmp, dirname(p)), { recursive: true }); writeFileSync(join(tmp, p), s); };
    const wl = audit.WHITELIST;

    // 正例1：白名单外新增 → 可疑（新增）
    {
      const t0 = audit.scanSnapshot(tmp);
      w("mystery.bin", "x");
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      p1 = { count: r.count, path: r.suspicious[0].path, type: r.suspicious[0].type, conclusion: r.conclusion };
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
      p2 = {
        count: r.count,
        evilLink: r.suspicious.some((s) => s.path === "evil-link" && s.type === "越界 symlink"),
        nested: r.suspicious.some((s) => s.path === "profiles/verify_x/evil2" && s.type === "越界 symlink"),
        dupNew: r.suspicious.some((s) => s.path === "evil-link" && s.type === "新增"),
      };
    }

    // 正例3：白名单外删除 → 可疑（删除）
    {
      w("doomed.bin", "x");
      const t0 = audit.scanSnapshot(tmp);
      rmSync(join(tmp, "doomed.bin"));
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      p3 = { count: r.count, deleted: r.suspicious.some((s) => s.path === "doomed.bin" && s.type === "删除") };
    }

    // 正例4：白名单外修改（size 变化）→ 可疑（修改）
    {
      w("mut.bin", "aa");
      const t0 = audit.scanSnapshot(tmp);
      w("mut.bin", "bbbb");
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      p4 = { count: r.count, modified: r.suspicious.some((s) => s.path === "mut.bin" && s.type === "修改") };
    }

    // 同 size 同 mtimeMs 快速重写经 ctimeMs 检出——直接构造
    // Entry（不依赖文件系统时间精度，验证 ctimeMs 参与修改判定逻辑本身）
    {
      const mk = (ctimeMs) => ({
        root: tmp,
        entries: new Map([["rewrite.bin", { type: "file", size: 4, mtimeMs: 1000, ctimeMs }]]),
      });
      const r = audit.runAudit({ t0: mk(1000), t1: mk(1001), isolatedRoot: tmp });
      ctime = { count: r.count, type: r.suspicious[0].type };
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
      n1 = { count: r.count, conclusion: r.conclusion };
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
      n1b = { count: r.count, conclusion: r.conclusion };
    }

    // 反例2：t0 已存在且目标未变的外部 symlink（link: 挂载点）不报
    {
      mkdirSync(join(tmp, "profiles", "verify_x", "node_modules"), { recursive: true });
      symlinkSync(join(outside, "pkg"), join(tmp, "profiles", "verify_x", "node_modules", "pkg"), SYMLINK_TYPE);
      const t0 = audit.scanSnapshot(tmp);
      const t1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0, t1, isolatedRoot: tmp });
      n2 = { reportsNodeModules: r.suspicious.some((s) => s.path.includes("node_modules")) };
    }

    // 反例3：t1 无变化 → 通过
    {
      const s0 = audit.scanSnapshot(tmp);
      const s1 = audit.scanSnapshot(tmp);
      const r = audit.runAudit({ t0: s0, t1: s1, isolatedRoot: tmp });
      n3 = { count: r.count, conclusion: r.conclusion };
    }

    // 9e. browser-profile/** 整树白名单 + 跳过深扫（数万文件，只记目录条目）
    {
      w("browser-profile/deep/file", "y");
      const s = audit.scanSnapshot(tmp, { skipDeep: audit.SKIP_DEEP });
      e9 = { hasDir: s.entries.has("browser-profile"), hasDeepFile: s.entries.has("browser-profile/deep/file") };
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
      f1 = { count: r1.count, conclusion: r1.conclusion };
      // 运行期新增（白名单外）→ 仍报
      w("runtime-mystery.bin", "x");
      const r2 = audit.runAudit({ t0, t1: audit.scanSnapshot(tmp, { skipDeep: audit.SKIP_DEEP }), isolatedRoot: tmp });
      f2 = { count: r2.count, path: r2.suspicious[0].path, type: r2.suspicious[0].type };
    }
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true }); // 零污染纪律
    rmSync(outside, { recursive: true, force: true });
  });

  describe("正例1：白名单外新增 → 可疑（新增）", () => {
    it("白名单外新增报 1 项", () => {
      expect(p1.count).toBe(1);
    });

    it("可疑路径正确", () => {
      expect(p1.path).toBe("mystery.bin");
    });

    it("可疑类型为新增", () => {
      expect(p1.type).toBe("新增");
    });

    it("结论 suspicious", () => {
      expect(p1.conclusion).toBe("suspicious");
    });
  });

  describe("正例2：越界 symlink（顶层 + 白名单内）", () => {
    it("新增 2 条越界 symlink", () => {
      expect(p2.count).toBe(2);
    });

    it("新增越界 symlink 报可疑", () => {
      expect(p2.evilLink).toBeTruthy();
    });

    it("白名单内新增越界 symlink 仍报（防逃逸优先）", () => {
      expect(p2.nested).toBeTruthy();
    });

    // 越界 symlink 不重复报「新增」（防逃逸通道优先，diff 剔除）
    it("越界 symlink 不重复报新增", () => {
      expect(!p2.dupNew).toBeTruthy();
    });
  });

  describe("正例3：白名单外删除 → 可疑（删除）", () => {
    it("白名单外删除报 1 项", () => {
      expect(p3.count).toBe(1);
    });

    it("白名单外删除报可疑", () => {
      expect(p3.deleted).toBeTruthy();
    });
  });

  describe("正例4：白名单外修改（size 变化）→ 可疑（修改）", () => {
    it("白名单外修改报 1 项", () => {
      expect(p4.count).toBe(1);
    });

    it("白名单外修改报可疑", () => {
      expect(p4.modified).toBeTruthy();
    });
  });

  describe("ctimeMs 参与修改判定", () => {
    it("同 size 同 mtimeMs、ctimeMs 不同 → 报 1 项修改", () => {
      expect(ctime.count).toBe(1);
    });

    it("ctimeMs 变化报「修改」", () => {
      expect(ctime.type).toBe("修改");
    });
  });

  describe("反例1：白名单内变化忽略", () => {
    it("白名单内变化忽略", () => {
      expect(n1.count).toBe(0);
    });

    it("结论 pass", () => {
      expect(n1.conclusion).toBe("pass");
    });
  });

  describe("反例1b（m4 补强）：白名单内删除/修改忽略", () => {
    it("白名单内删除/修改忽略", () => {
      expect(n1b.count).toBe(0);
    });

    it("白名单内删除/修改结论 pass", () => {
      expect(n1b.conclusion).toBe("pass");
    });
  });

  describe("反例2：link: 挂载点合法", () => {
    it("t0 已存在且目标未变的外部 symlink（link: 挂载点）不报", () => {
      expect(!n2.reportsNodeModules).toBeTruthy();
    });
  });

  describe("反例3：t1 无变化 → 通过", () => {
    it("t1 无变化 0 可疑", () => {
      expect(n3.count).toBe(0);
    });

    it("t1 无变化结论 pass", () => {
      expect(n3.conclusion).toBe("pass");
    });
  });

  describe("9e. browser-profile 跳过深扫", () => {
    it("browser-profile 目录条目在位", () => {
      expect(e9.hasDir).toBeTruthy();
    });

    it("browser-profile/** 跳过深扫", () => {
      expect(!e9.hasDeepFile).toBeTruthy();
    });
  });

  describe("9f. dsh 启动写面回归（纯函数层）", () => {
    it("启动写面进 t0 基线，干净运行 pass", () => {
      expect(f1.count).toBe(0);
    });

    it("干净运行结论 pass", () => {
      expect(f1.conclusion).toBe("pass");
    });

    it("运行期新增仍报 1 项", () => {
      expect(f2.count).toBe(1);
    });

    it("运行期新增路径正确", () => {
      expect(f2.path).toBe("runtime-mystery.bin");
    });

    it("运行期新增类型为新增", () => {
      expect(f2.type).toBe("新增");
    });
  });
});

// ---------------------------------------------------------------- 10. 首启弹窗跳过与访问令牌
// 10a. 须知版本提取：命中真实产物形态 / 未命中返回 null。降级而非抛错是契约——
// dsh 改了常量形态时应当「不预置 + 浏览器兜底」，而不是伪造版本来假装跳过
describe("10a. 须知版本提取", () => {
  let onboardingExists;
  let ob;

  beforeAll(async () => {
    const onboardingFile = join(SCRIPTS_DIR, "lib", "onboarding.mjs");
    onboardingExists = existsSync(onboardingFile);
    ob = await import(pathToFileURL(onboardingFile).href);
  });

  it("首启弹窗跳过纯函数 lib/onboarding.mjs 随 skill 分发", () => {
    expect(onboardingExists).toBeTruthy();
  });

  it("从客户端产物提取须知版本", () => {
    expect(ob.extractWelcomeNoticeVersion('const WELCOME_NOTICE_VERSION = "2026-08-13.1";')).toBe("2026-08-13.1");
  });

  it("无版本常量返回 null（降级不抛）", () => {
    expect(ob.extractWelcomeNoticeVersion("nothing here")).toBe(null);
  });

  it("null 输入返回 null", () => {
    expect(ob.extractWelcomeNoticeVersion(null)).toBe(null);
  });
});

// 10b. settings 文档形状 + 注入防护：settings.yaml 是 dsh 要解析的结构化文档，
// 意外字符会改写命名空间结构而不只是一个字段值
describe("10b. settings 文档形状 + 注入防护", () => {
  let ob;

  beforeAll(async () => {
    ob = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "onboarding.mjs")).href);
  });

  it("settings 文档形状", () => {
    expect(ob.welcomeSettingsDocument("2026-08-13.1")).toBe("ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n");
  });

  it("版本含换行被拒绝", () => {
    expect(() => ob.welcomeSettingsDocument("bad\nvalue")).toThrow(/意外字符/);
  });
});

// 10c. dsh 安装根与产物定位（mkdtemp fixture 建模 npm 提升布局）
describe("10c. dsh 安装根与产物定位（mkdtemp fixture 建模 npm 提升布局）", () => {
  let fix;
  let fixBare;
  let dshRoot;
  let bin;
  let rootBare;
  let dshRootResolved;
  let welcomeClientFile;
  let e2eVersion;
  let bareClientFile;
  let bareVersion;

  beforeAll(async () => {
    const ob = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "onboarding.mjs")).href);
    fix = mkdtempSync(join(tmpdir(), "dsh-verify-onboarding-"));
    fixBare = mkdtempSync(join(tmpdir(), "dsh-verify-onboarding-bare-"));
    dshRoot = join(fix, "node_modules", "@deepseek-ai", "dsh");
    const clientDir = join(dshRoot, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models");
    mkdirSync(join(dshRoot, "lib"), { recursive: true });
    mkdirSync(join(clientDir, "lib"), { recursive: true });
    writeFileSync(join(dshRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }));
    writeFileSync(join(dshRoot, "lib", "bin.js"), "");
    writeFileSync(join(clientDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-client-ui-settings-models" }));
    writeFileSync(join(clientDir, "lib", "client.js"), 'const WELCOME_NOTICE_VERSION = "2099-01-01.1";');
    bin = join(dshRoot, "lib", "bin.js");
    dshRootResolved = ob.dshRootOf(bin);
    welcomeClientFile = ob.welcomeClientFileOf(dshRoot);
    e2eVersion = ob.findWelcomeNoticeVersion(bin)?.version;

    // 负例用独立 fixture（依赖从一开始就不存在）：删除文件会被 require.resolve
    // 的路径缓存挡住，测不出真实的「依赖缺失」路径
    rootBare = join(fixBare, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(rootBare, "lib"), { recursive: true });
    writeFileSync(join(rootBare, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }));
    writeFileSync(join(rootBare, "lib", "bin.js"), "");
    bareClientFile = ob.welcomeClientFileOf(rootBare);
    bareVersion = ob.findWelcomeNoticeVersion(join(rootBare, "lib", "bin.js"));
  });

  afterAll(() => {
    rmSync(fix, { recursive: true, force: true }); // 零污染纪律
    rmSync(fixBare, { recursive: true, force: true });
  });

  it("dshRootOf 从入口向上解析安装根", () => {
    expect(dshRootResolved).toBe(dshRoot);
  });

  it("welcomeClientFileOf 经 Node 解析算法定位产物", () => {
    expect(welcomeClientFile).toBe(join(dshRoot, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models", "lib", "client.js"));
  });

  it("端到端解析版本", () => {
    expect(e2eVersion).toBe("2099-01-01.1");
  });

  it("依赖解析失败返回 null（降级不抛）", () => {
    expect(bareClientFile).toBe(null);
  });

  it("产物缺失时端到端返回 null（预置失败只警告）", () => {
    expect(bareVersion).toBe(null);
  });
});

// 10d. 弹窗探针表达式：跳过文案集合（en + zh）+ click 必须是真的开关。
// 实测曾复现「--no-auto-dismiss 仍把弹窗点掉」——探针照样 click，开关退化成
// 只改输出文案的假开关，故此处锁死「禁止分支先于 target.click()」的顺序
describe("10d. 弹窗探针表达式", () => {
  let skipButtonTexts;
  let authMarker;
  let probes;

  beforeAll(async () => {
    const ob = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "onboarding.mjs")).href);
    skipButtonTexts = [...ob.SKIP_BUTTON_TEXTS];
    authMarker = ob.AUTH_REQUIRED_MARKER;
    probes = {
      auto: ob.buildOverlayProbeExpression(),
      manual: ob.buildOverlayProbeExpression({ click: false }),
    };
  });

  it("跳过按钮文案含 en + zh（locale 变化不失效）", () => {
    expect(skipButtonTexts).toEqual(["Continue", "Configure later", "继续", "稍后配置"]);
  });

  it("默认探针允许点击", () => {
    expect(/const allowClick = true/.test(probes.auto)).toBeTruthy();
  });

  it("--no-auto-dismiss 探针禁止点击", () => {
    expect(/const allowClick = false/.test(probes.manual)).toBeTruthy();
  });

  // 原脚本把「两类探针各自四项」写在数组循环内，故按探针展开为逐条可见用例。
  const probeCases = [
    { title: "默认探针", key: "auto" },
    { title: "--no-auto-dismiss 探针", key: "manual" },
  ];

  it.each(probeCases)("$title：探针保留点击路径", ({ key }) => {
    expect(probes[key].includes("target.click()")).toBeTruthy();
  });

  it.each(probeCases)("$title：禁止点击的分支先于 target.click()（防假开关回归）", ({ key }) => {
    expect(probes[key].indexOf("if (!allowClick) return") < probes[key].indexOf("target.click()")).toBeTruthy();
  });

  it.each(probeCases)("$title：探针以应用根 inert 为阻断判据", ({ key }) => {
    expect(probes[key].includes("root.inert !== true")).toBeTruthy();
  });

  it.each(probeCases)("$title：探针携带鉴权拒绝文案判据", ({ key }) => {
    expect(probes[key].includes(authMarker)).toBeTruthy();
  });

  it("401 判据与 dsh web 实际文案一致", () => {
    expect(authMarker).toBe("dsh web authentication required");
  });
});

// 10e. 令牌脱敏：回显 URL 会随证据归档，真令牌只允许留在 0o600 的 state/log
describe("10e. 令牌脱敏", () => {
  let ob;

  beforeAll(async () => {
    ob = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "onboarding.mjs")).href);
  });

  it("回显去令牌", () => {
    expect(ob.redactToken("http://127.0.0.1:41915/?token=abc123")).toBe("http://127.0.0.1:41915/?token=***");
  });

  it("多参数下只替换令牌值", () => {
    expect(ob.redactToken("http://127.0.0.1:1/a?x=1&token=abc&y=2")).toBe("http://127.0.0.1:1/a?x=1&token=***&y=2");
  });

  it("非字符串原样返回", () => {
    expect(ob.redactToken(undefined)).toBe(undefined);
  });
});

// 10f. 访问 URL 解析（令牌唯一来源）：只认 dsh 打印的完整 URL，截断即 null
describe("10f. 访问 URL 解析（readDshUrl 行完整性）", () => {
  let core2;

  beforeAll(async () => {
    core2 = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "verify-core.mjs")).href);
  });

  it("readDshUrl 取带令牌 URL", () => {
    expect(core2.readDshUrl("dsh web: http://127.0.0.1:41915/?token=abc\n")).toBe("http://127.0.0.1:41915/?token=abc");
  });

  it("readDshUrl 拒绝截断行（半个令牌表现为 401，比缺参数更难排查）", () => {
    expect(core2.readDshUrl("dsh web: http://127.0.0.1:41915")).toBe(null);
  });

  it("readDshUrl 无行返回 null", () => {
    expect(core2.readDshUrl("noise")).toBe(null);
  });
});

// 10g. verify-isolated 契约锚定：选项 / 预置步骤 / verdict 字段 / --help
describe("10g. verify-isolated 首启弹窗契约锚定", () => {
  let vScript;
  let viHelp;

  beforeAll(() => {
    vScript = readFileSync(scriptFile, "utf8");
    viHelp = execFileSync(process.execPath, [scriptFile, "--help"], { encoding: "utf8" });
  });

  const onboardingContracts = ["--no-skip-onboarding", "presetWelcomeNotice", "settings.yaml", "首启弹窗预置"];
  it.each(onboardingContracts)("verify-isolated 含首启弹窗契约 %s", (opt) => {
    expect(vScript.includes(opt)).toBeTruthy();
  });

  const onboardingVerdictFields = ["web:", "onboarding:", "tokenSource:"];
  it.each(onboardingVerdictFields)("verdict schema 含字段 %s", (field) => {
    expect(vScript.includes(field)).toBeTruthy();
  });

  it("带令牌 URL 写入 browser.state.dshWebUrl", () => {
    expect(vScript.includes("st.dshWebUrl = webUrl")).toBeTruthy();
  });

  it("--help 声明 --no-skip-onboarding", () => {
    expect(viHelp.includes("--no-skip-onboarding")).toBeTruthy();
  });

  it("--help 说明访问令牌（GUI 带鉴权）", () => {
    expect(viHelp.includes("令牌")).toBeTruthy();
  });
});

// 10h. browser-driver 契约锚定：--url state / 弹窗开关 / 导航命令接入 goto。
// eval 与 fill 不导航，故不得接入（要能检查弹窗本身，且不抹掉页面状态）
describe("10h. browser-driver 首启弹窗契约锚定", () => {
  let dScript;
  let drvHelp;

  beforeAll(() => {
    dScript = readFileSync(driverFile, "utf8");
    drvHelp = execFileSync(process.execPath, [driverFile, "--help"], { encoding: "utf8" });
  });

  const driverOnboardingContracts = ["--no-auto-dismiss", "--overlay-wait", "dshWebUrl", "onboardingBlocked"];
  it.each(driverOnboardingContracts)("browser-driver 含 %s 契约", (opt) => {
    expect(dScript.includes(opt)).toBeTruthy();
  });

  const gotoCommands = ["cmdSnapshot", "cmdClick", "cmdWait", "cmdScreenshot"];
  it.each(gotoCommands)("%s 接入导航收尾（弹窗跳过不得绕过）", (cmd) => {
    const body = dScript.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
    expect(body.includes("goto(")).toBeTruthy();
  });

  // console 走长连接收事件（短连接的 goto 会丢事件），导航与收尾内联，但收尾必须在
  it("cmdConsole 内联接入导航收尾（弹窗跳过不得绕过）", () => {
    const body = dScript.split("async function cmdConsole(")[1]?.split("\nasync function ")[0] ?? "";
    expect(body.includes("settleOverlays(")).toBeTruthy();
  });

  const nonNavigatingCommands = ["cmdEval", "cmdFill"];
  it.each(nonNavigatingCommands)("%s 不导航、不触发弹窗跳过（设计契约）", (cmd) => {
    const body = dScript.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
    expect(!body.includes("goto(") && !body.includes("settleOverlays(")).toBeTruthy();
  });

  it("--help 声明 --url state 保留取值", () => {
    expect(drvHelp.includes("--url <url|state>")).toBeTruthy();
  });

  it("--help 声明 --no-auto-dismiss", () => {
    expect(drvHelp.includes("--no-auto-dismiss")).toBeTruthy();
  });
});

// 10i. 文档同步：跳过与令牌是「跑得起来」的前提，缺任一处都会让执行者卡在 401
// 或 inert 页面上（缺陷正是文档空白导致的）
describe("10i. 文档同步（跳过与令牌指导锚点）", () => {
  let skillRaw;
  let readmeZh;
  let readmeEn;

  beforeAll(() => {
    skillRaw = readFileSync(SKILL_FILE, "utf8");
    readmeZh = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    readmeEn = readFileSync(join(PKG_ROOT, "README.en.md"), "utf8");
  });

  const skillAnchors = ["--url state", "首启弹窗", "401", "token=***", "--no-skip-onboarding", "inert"];
  it.each(skillAnchors)("SKILL.md 含跳过/鉴权指导锚点 %s", (anchor) => {
    expect(skillRaw.includes(anchor)).toBeTruthy();
  });

  const readmeZhAnchors = ["--no-skip-onboarding", "--url state", "token=***", "settings.yaml"];
  it.each(readmeZhAnchors)("README.md 含 %s", (anchor) => {
    expect(readmeZh.includes(anchor)).toBeTruthy();
  });

  const readmeEnAnchors = ["--no-skip-onboarding", "--url state", "token=***", "onboarding.mjs"];
  it.each(readmeEnAnchors)("README.en.md 含 %s", (anchor) => {
    expect(readmeEn.includes(anchor)).toBeTruthy();
  });
});

