import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PKG_ROOT,
  SCRIPTS_DIR,
  TARGET_DSH_VERSION,
  scriptFile,
  winCmdShimFor,
} from "./smoke-support";

export function verifyCoreContract() {
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
}

export function scriptTextContract() {
  describe("6b. verify-isolated.mjs 关键契约文本锚定", () => {
    let script;
    let coreSrc;

    beforeAll(() => {
      script = readFileSync(scriptFile, "utf8");
      coreSrc = readFileSync(join(SCRIPTS_DIR, "lib", "verify-core.mjs"), "utf8");
    });

    // 归一化语义由 6a resolvePkgArg 行为断言覆盖——内建进 verify-core，不依赖独立文件
    const optionContracts = [
      "--port 0",
      "--browser",
      "--keep",
      "--no-build",
      "--evidence-dir",
      "--json",
    ];
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
      "v:",
      "ok:",
      "dsh:",
      "dshHome:",
      "profile:",
      "port:",
      "pid:",
      "browser:",
      "telemetry:",
      "ready:",
      "readyAt:",
      "evidenceDir:",
      "cleanup:",
      "officialContract: false",
      "非官方契约，不承诺实际生效",
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

    it("dsh 清理先 SIGTERM、等待 5s，再 SIGKILL 兜底", () => {
      const stopDsh = script.split("async function stopDshChild() {")[1]?.split("\n}")[0] ?? "";
      const term = stopDsh.indexOf('killDsh(dshChild, "SIGTERM")');
      const wait = stopDsh.indexOf("waitPidExit(dshChild.pid, 5000)");
      const kill = stopDsh.indexOf('killDsh(dshChild, "SIGKILL")');
      expect(term).toBeGreaterThanOrEqual(0);
      expect(wait).toBeGreaterThan(term);
      expect(kill).toBeGreaterThan(wait);
    });

    it("settle 幂等守卫先于任何清理动作", () => {
      const settle = script.split("async function settle() {")[1]?.split("\n}")[0] ?? "";
      expect(settle.trimStart().startsWith("if (settling) return;\n  settling = true;")).toBe(true);
    });

    // 归一化语义注释在 lib/verify-core.mjs（resolvePkgArg 归属处）
    it("脚本注释声明相对路径 git URL 陷阱", () => {
      expect(coreSrc.includes("dsh 会把非绝对路径当 git URL 解析")).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------- 6c. 子进程退出码实测
}

export function scriptExitContract() {
  describe("6c. 子进程退出码实测（不启动 dsh / 浏览器，走 PATH 缺 dsh 与 --help 路径）", () => {
    let h;
    let bad;
    let j;
    let jLines;
    let parsed;
    let afterDash;
    let u;
    let missingPort;
    let jsonBad;
    let helpInline;
    let jsonThenFalse;
    let noDsh;
    let emptyPathDir;

    beforeAll(() => {
      emptyPathDir = mkdtempSync(join(tmpdir(), "dsh-verify-empty-path-"));
      const noDshEnv = { PATH: emptyPathDir };
      const run = (args, extraEnv = {}) => {
        let code = 0;
        let out = "";
        try {
          out = execFileSync(process.execPath, [scriptFile, ...args], {
            encoding: "utf8",
            env: { ...process.env, ...extraEnv },
          });
        } catch (e) {
          code = e.status ?? -1;
          out = (e.stdout ?? "") + (e.stderr ?? "");
        }
        return { code, out };
      };
      // --help：用法提示，退出码 0
      h = run(["--help"]);
      // --dsh 已删除：未知选项退出码 2
      bad = run(["--dsh", "/nonexistent/dsh"]);
      // --json + 未知选项：stdout **恰好 1 行** JSON（含 exitCode 2；锁定
      // stdout 只出 JSON 的约束，人类文案不得混入）
      j = run(["--json", "--dsh", "/nonexistent/dsh"]);
      jLines = j.out
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);
      parsed = JSON.parse(jLines[0]);
      // 回归：`--` 之后的 --json 是插件参数，不得误开全局 jsonMode；
      // PATH 无 dsh，fail-closed 在隔离目录创建之前
      afterDash = run(["--", "--json"], noDshEnv);
      // 未知选项：退出码 2
      u = run(["--bogus"]);
      // 缺参：取值型选项不带值（parseArgs 内置文案是英文，故这条锁住中文自查）
      missingPort = run(["--port"]);
      // --json 非法内联值
      jsonBad = run(["--json=bad"]);
      // 回归：布尔选项带内联值须被静默接受（内置 boolean 不接受内联值，由归一兜住）
      helpInline = run(["--help=1"]);
      // 回归：--json 与 --json=false 并存按**末位胜出**，即不进 json 模式（stdout 走人类文案）
      jsonThenFalse = run(["--json", "--json=false"], noDshEnv);
      // PATH 无 dsh：fail-closed，退出码 2
      noDsh = run([], noDshEnv);
    });

    afterAll(() => {
      rmSync(emptyPathDir, { recursive: true, force: true });
    });

    it("--help 退出码 0", () => {
      expect(h.code).toBe(0);
    });

    it("--help 含脚本名", () => {
      expect(h.out.includes("verify-isolated.mjs")).toBeTruthy();
    });

    it("--help 显式锁定目标 dsh 单版本", () => {
      expect(h.out).toContain(TARGET_DSH_VERSION);
      expect(h.out).toContain("PATH");
      expect(h.out).not.toContain("--dsh");
    });

    it("--dsh 已删除：未知选项退出码 2", () => {
      expect(bad.code).toBe(2);
      expect(bad.out).toContain("未知选项: --dsh");
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

    it("-- 之后 --json 不误开 jsonMode（stdout 非 JSON，走 PATH 缺 dsh 错误）", () => {
      expect(afterDash.code).toBe(2);
      expect(!afterDash.out.trim().startsWith("{")).toBeTruthy();
      expect(afterDash.out).toContain("PATH 中找不到 dsh 入口");
    });

    it("未知选项退出码 2", () => {
      expect(u.code).toBe(2);
    });

    // 以下五条锁住 parseArgs 改造后新增的解析层契约：改造前这些文案一条都没有断言，
    // 布尔内联值与 --json 末位胜出两条回归因此全绿漏过。
    it("未知选项文案带出错 token（可定位）", () => {
      expect(u.out).toContain("错误: 未知选项: --bogus");
    });

    it("缺参文案为中文且指出选项名", () => {
      expect(missingPort.code).toBe(2);
      expect(missingPort.out).toContain("错误: --port 需要一个参数");
    });

    it("--json 非法内联值报中文错", () => {
      expect(jsonBad.code).toBe(2);
      expect(jsonBad.out).toContain("错误: --json 只接受 true/false: bad");
    });

    it("布尔选项带内联值被接受（--help=1 仍打用法并 exit 0）", () => {
      expect(helpInline.code).toBe(0);
      expect(helpInline.out).toContain("verify-isolated.mjs");
    });

    it("--json 与 --json=false 并存按末位胜出（不进 json 模式，stdout 走人类文案）", () => {
      expect(jsonThenFalse.code).toBe(2);
      expect(jsonThenFalse.out.trim().startsWith("{")).toBeFalsy();
      expect(jsonThenFalse.out).toContain("PATH 中找不到 dsh 入口");
    });

    it("PATH 无 dsh 时 fail-closed，不创建隔离目录", () => {
      expect(noDsh.code).toBe(2);
      expect(noDsh.out).toContain("PATH 中找不到 dsh 入口");
    });
  });

  // ---------------------------------------------------------------- 6d. 就绪前退出回归
  // 复现路径：dsh web 启动即崩（端口被占 EADDRINUSE / 插件加载失败 / 就绪前净退出）。
  // 修复前：exit handler 抢先 requestExit 透传 dsh 退出码 → settle 抢先 process.exit
  // → waitReady 的 dead 检测与 CliError 诊断不可达（stderr 空），且 dsh exit 0 静默
  // 假成功、非契约码（3）穿透契约表。修复后：就绪前退出只记录，统一走
  // CliError(EXIT.FAIL=1) + 引用 dsh.log 的可操作诊断。
}

export function earlyExitContract() {
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
      writeFileSync(
        fakeDshScript,
        `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.2.1-rc.2"); process.exit(0); }
if (args[0] === "plugin" && args.includes("list")) {
  const i = args.indexOf("--profile");
  const dir = join(process.env.DSH_HOME, "profiles", args[i + 1]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }));
  process.exit(0);
}
process.exit(Number(process.env.FAKE_DH_EXIT ?? "0"));
`,
      );
      chmodSync(fakeDshScript, 0o755);
      const fakeDsh = winCmdShimFor(fakeDshScript);
      // PATH 驱动：目录内置名 `dsh` 指向假 dsh，前置到 PATH 首位（node 取自当前进程目录）。
      // win32 按 pathEntryFor 同口径提供 dsh.cmd 转发（裸 symlink 无扩展名会绕过 shell 回退）。
      const fakePathDir = mkdtempSync(join(tmpDir, "path-bin-"));
      if (process.platform === "win32") {
        writeFileSync(
          join(fakePathDir, "dsh.cmd"),
          `@echo off\r\n"${process.execPath}" "${fakeDsh}" %*\r\n`,
        );
      } else {
        symlinkSync(fakeDsh, join(fakePathDir, "dsh"));
      }
      const fakePathEnv = {
        PATH: [fakePathDir, dirname(process.execPath), process.env.PATH]
          .filter(Boolean)
          .join(delimiter),
      };
      const runWithFake = (exitCode) => {
        let code = 0;
        let out = "";
        try {
          out = execFileSync(process.execPath, [scriptFile, "--port", "0"], {
            encoding: "utf8",
            env: { ...process.env, ...fakePathEnv, FAKE_DH_EXIT: String(exitCode) },
            timeout: 30000,
          });
        } catch (e) {
          code = e.status ?? -1;
          out = (e.stdout ?? "") + (e.stderr ?? "");
        }
        return { code, out };
      };
      // dsh exit 0（就绪前净退出）：不得静默假成功——契约码必须 1 且 stderr 有诊断
      fake0 = runWithFake(0);
      // dsh exit 3（非契约码）：不得穿透——契约码必须 1
      fake3 = runWithFake(3);
      // --json：错误路径 stdout 单 JSON（人类文案走 stderr，只解析 stdout）、exitCode=1
      let jout = "";
      try {
        jout = execFileSync(process.execPath, [scriptFile, "--json", "--port", "0"], {
          encoding: "utf8",
          env: { ...process.env, ...fakePathEnv, FAKE_DH_EXIT: "0" },
          timeout: 30000,
        });
      } catch (e) {
        jcode = e.status ?? -1;
        jout = e.stdout ?? "";
      } // stdout 单 JSON；人类文案在 stderr 不并入
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
}

export function readDshUrlContract() {
  describe("10f. 访问 URL 解析（readDshUrl 行完整性）", () => {
    let core2;

    beforeAll(async () => {
      core2 = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "verify-core.mjs")).href);
    });

    it("readDshUrl 取带令牌 URL", () => {
      expect(core2.readDshUrl("dsh web: http://127.0.0.1:41915/?token=abc\n")).toBe(
        "http://127.0.0.1:41915/?token=abc",
      );
    });

    it("readDshUrl 拒绝截断行（半个令牌表现为 401，比缺参数更难排查）", () => {
      expect(core2.readDshUrl("dsh web: http://127.0.0.1:41915")).toBe(null);
    });

    it("readDshUrl 无行返回 null", () => {
      expect(core2.readDshUrl("noise")).toBe(null);
    });
  });

  // 10g. verify-isolated 契约锚定：选项 / 预置步骤 / verdict 字段 / --help
}
