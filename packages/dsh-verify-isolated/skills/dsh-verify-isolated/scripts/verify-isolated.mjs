#!/usr/bin/env node
/**
 * verify-isolated.mjs — 隔离环境浏览器验证一键脚本（dsh-verify-isolated 插件包
 * 配套，随本 skill 分发）。原 `verify-isolated.sh`（bash + 内嵌 node -e）整体
 * 重写为纯 node 实现（#517 C8，需 Node >= 22），**不保留 shim**：skill 随包整体
 * 发布，不存在新旧错配。升级路径：`bash .../verify-isolated.sh ...` →
 * `node .../verify-isolated.mjs ...`，参数与输出文案逐行对齐。
 *
 * 用途：在不污染真实 ~/.dsh（含正在使用的 web profile）的前提下，拉起一个
 * 完全隔离的 dsh web 实例，用于客户端 UI 改动的浏览器实测。
 *
 * 四重隔离：
 *   1. DSH_HOME 指向全新临时目录 —— 隔离凭据 / 会话 / home 级 cordis.patch.yml；
 *   2. 独立 profile verify_<8位随机> —— 隔离插件组合栈，不触碰用户 web profile；
 *   3. 独立端口 + 显式回环（--host 127.0.0.1）—— 当前 dsh 默认即回环，显式写死
 *      把隐式行为钉成结构性保证，防上游默认变更；
 *   4. --browser 时独立浏览器实例（browser-driver.mjs，raw CDP 零依赖）。
 * 隔离环境同时显式 DSH_TELEMETRY_DISABLED=1：测试数据不外发遥测（0.1.2 线
 * profile-boot 消费的官方开关）。
 *
 * 用法：
 *   node verify-isolated.mjs [--dsh <path>] [--port <port>] [--browser] [--keep]
 *                            [--no-build] [--evidence-dir <dir>] [--json]
 *                            [-- <pkg-path>...]
 *   --dsh <path>       指定 dsh 入口（默认 PATH 中的 dsh）。隔离实测必须锚定目标
 *                      dsh 版本——PATH 里碰巧存在的版本会让验证结果不可复现（#376 H1）。
 *   --port <port>      默认 3456；--port 0 自动探测真实空闲端口并打印（修复打印 0）。
 *                      探测块贴近 dsh 启动，防 EADDRINUSE 窗口（#481 P2-1）。
 *   --browser          额外启动独立浏览器实例（browser-driver.mjs）：独立
 *                      user-data-dir + 自选空闲调试端口 + headless，实例信息写入
 *                      $ISOLATED_HOME/browser.state（与 DSH_HOME 同生命周期）。
 *   --keep             结束后保留临时 DSH_HOME（不删，方便排查；路径会打印）。
 *   --no-build         跳过挂载前的 pnpm build；此时校验产物存在（缺失即报可操作
 *                      错误），并对比 src/ 与产物的 mtime，源码更新即给陈旧警告。
 *   --evidence-dir <dir>
 *                      证据目录（B7）：默认 $ISOLATED_HOME/evidence/；显式外部化
 *                      时建 <dir>/evidence-<profile>/ 子目录，**绝不动外部目录**
 *                      （不删、不覆盖，仅创建子目录并打印路径）。
 *   --json             stdout 只出最终 verdict JSON（人类文案全部走 stderr）。
 *   --                 之后为要挂载的本地插件路径（相对路径基于当前 cwd 解析；
 *                      npm 包名 / git URL 原样透传，见 lib/verify-core.mjs
 *                      resolvePkgArg——C11 语义内建）。
 *   --help             显示本帮助。
 *
 * 退出码契约（显式表，smoke 锁定）：
 *   ┌─────┬────────────────────────────────────────────────────────────────┐
 *   │  0  │ 正常完成：启动 + 就绪 + 前台等待 dsh 退出，清理完毕              │
 *   │  1  │ 启动或就绪失败：profile 初始化失败 / add 失败 / dsh 就绪前退出 / │
 *   │     │ 15s 就绪超时                                                    │
 *   │  2  │ 参数错误：未知选项 / 缺参 / 找不到 dsh 入口 / --no-build 缺产物  │
 *   │ 130 │ SIGINT（Ctrl+C）：终态清理后透传                                 │
 *   │ 143 │ SIGTERM：终态清理后透传                                          │
 *   └─────┴────────────────────────────────────────────────────────────────┘
 *   （其余：dsh 自身异常退出码原样透传——bash 版 wait 透传同语义，见 main() 中
 *     child "exit" 处理注释。）
 *
 * Windows 三坑（承诺等级：试验性，文档已标注；smoke 不启动 dsh，Windows 行为走
 * 代码审查）：
 *   1. spawn .cmd 回退：.cmd/.bat 入口不能直接 spawn（无 PATHEXT 解析），
 *      shell:true 回退（见 spawnDsh）；
 *   2. 无 POSIX 信号：SIGTERM/SIGINT 语义在 Windows 不成立，kill 走
 *      taskkill /T /F 进程树（见 killDsh）；
 *   3. taskkill /T 进程树清理：Node child.kill 只杀壳进程、孙进程残留，
 *      统一按 pid 树清理。
 *
 * B6 启动自检 verdict：就绪后写 $ISOLATED_HOME/verdict.json（0o600），退出终态
 * 更新 cleanup 字段（中间态 "running" → 终态 "done" / "kept"）。端口实际绑定
 * 三通道：parsed（解析 dsh.log 端口行）→ asserted（就绪断言端口）→ probed
 * （--port 0 探测端口），标 source。
 *
 * B7 证据目录：默认 $ISOLATED_HOME/evidence/；供截图/快照等归档，退出随
 * DSH_HOME 一并清理（--keep 保留）。显式 --evidence-dir 时建外部子目录，
 * 绝不动外部目录本体。
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  EXIT, findFreePort, jsonOut, pidAlive, readDshPort, resolvePkgArg, waitPidExit,
} from "./lib/verify-core.mjs";

const SCRIPT_DIR = import.meta.dirname; // Node >= 22 全程可用
const DRIVER = join(SCRIPT_DIR, "browser-driver.mjs");
const DEFAULT_PORT = 3456;
const READY_TIMEOUT_MS = 15000;
const LOG_TAIL_LIMIT = 4096; // 防背压：收集缓冲限长（browser-driver stderrBuf 先例）

const USAGE = `用法: node verify-isolated.mjs [--dsh <path>] [--port <port>] [--browser] [--keep] [--no-build] [--evidence-dir <dir>] [--json] [-- <pkg-path>...]

选项：
  --dsh <path>         指定 dsh 入口（默认 PATH 中的 dsh；隔离实测必须锚定版本，防 PATH 漂移）
  --port <port>        端口（默认 3456；--port 0 自动探测真实空闲端口并打印）
  --browser            额外启动独立浏览器实例（browser-driver.mjs，raw CDP 零依赖）
  --keep               结束后保留临时 DSH_HOME（默认自动删除）
  --no-build           跳过挂载前 pnpm build（校验产物存在 + 陈旧警告）
  --evidence-dir <dir> 证据目录外部化（建 <dir>/evidence-<profile>/，绝不动外部目录）
  --json               stdout 只出最终 verdict JSON（人类文案走 stderr）
  --                   之后为要挂载的本地插件路径（相对路径基于 cwd 绝对化；npm 包名 / git URL 原样透传）
  --help               显示本帮助

环境要求：Node >= 22（同 browser-driver）。
退出码：0 正常 / 1 启动或就绪失败 / 2 参数错误 / 130 SIGINT / 143 SIGTERM。`;

// --- 全局运行态（cleanup / verdict / 信号多路共享） ---
let flags = null;
let jsonMode = false;
let dshAbs = null;
let dshVersion = null;
let isolatedHome = null;
let profile = null;
let browserState = null;
let dshLogPath = null;
let verdictPath = null;
let evidenceDir = null;
let dshChild = null;
let actualPort = null;
let portSource = null;
let dshWebPort = 0; // 传给 dsh 的有效端口（--port 0 时为探测值）
let browserPort = null;
let readyOk = false;
let readyIso = null;
let exiting = null; // { code: number, signal: string|null } 退出请求
let settling = false;
let errorPayload = null; // --json 错误路径已输出的错误对象（settle 不再重复出 JSON）

// 人类文案输出：--json 时走 stderr（stdout 只出最终 JSON），普通模式走 stdout
//（SKILL.md §5.1 自检清单依赖 `profile=verify_<随机>` / `DSH_HOME=…` 等可读行）。
function out(msg) {
  (jsonMode ? process.stderr : process.stdout).write(msg + "\n");
}
// 警告恒走 stderr（bash 版 console.warn 同语义）
function outWarn(msg) {
  process.stderr.write(msg + "\n");
}

// 携带显式退出码的错误（top catch 统一收口 → 尽力清理 → 输出 → 退出）
class CliError extends Error {
  constructor(msg, code = EXIT.FAIL) {
    super(msg);
    this.code = code;
  }
}

// --- CLI 解析（对齐 bash 版参数契约；--help 为新增） ---
function parseCli(argv) {
  jsonMode = argv.includes("--json") || argv.some((a) => a.startsWith("--json="));
  const f = {
    dsh: null, port: DEFAULT_PORT, browser: false, keep: false,
    noBuild: false, evidenceDir: null, json: jsonMode, help: false,
  };
  const pkgs = [];
  const bad = (msg) => { throw new CliError(msg, EXIT.USAGE); };
  const val = (i, opt) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) bad(`错误: ${opt} 需要一个参数`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pkgs.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const inline = eq === -1 ? null : a.slice(eq + 1);
      switch (key) {
        case "dsh": f.dsh = inline ?? val(i, "--dsh"); if (inline === null) i++; break;
        case "port": {
          const raw = inline ?? val(i, "--port");
          if (inline === null) i++;
          const p = Number(raw);
          if (!Number.isInteger(p) || p < 0 || p > 65535) bad(`错误: --port 需要 0-65535 的整数: ${raw}`);
          f.port = p;
          break;
        }
        case "browser": f.browser = true; break;
        case "keep": f.keep = true; break;
        case "no-build": f.noBuild = true; break;
        case "evidence-dir": f.evidenceDir = inline ?? val(i, "--evidence-dir"); if (inline === null) i++; break;
        case "json": f.json = true; break;
        case "help": f.help = true; break;
        default: bad(`未知选项: ${a}`);
      }
    } else if (a.startsWith("-") && a !== "-") {
      bad(`未知选项: ${a}`);
    } else {
      pkgs.push(a);
    }
  }
  return { flags: f, pkgs };
}

// --- dsh 入口校验与版本锚定（#376 H1） ---
function checkExecutable(p) {
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    if (process.platform === "win32") return resolve(p); // Windows 无可执行位语义
    return (st.mode & 0o111) !== 0 ? resolve(p) : null;
  } catch { return null; }
}

function resolveDsh(candidate) {
  if (!candidate) return null;
  const hasSep = candidate.includes("/") || (process.platform === "win32" && candidate.includes("\\"));
  if (isAbsolute(candidate) || hasSep) return checkExecutable(candidate);
  // PATH 查找（等价 command -v；win32 补 .cmd/.bat/.exe 后缀）
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const hit = checkExecutable(join(dir, candidate));
    if (hit) return hit;
    if (process.platform === "win32") {
      for (const ext of ["cmd", "bat", "exe"]) {
        const h = checkExecutable(`${join(dir, candidate)}.${ext}`);
        if (h) return h;
      }
    }
  }
  return null;
}

function readDshVersion(abs) {
  try {
    const raw = execFileSync(abs, ["--version"], { encoding: "utf8", timeout: 10000 });
    return (raw.split("\n")[0] || "").trim();
  } catch { return "unknown"; }
}

// --- dsh 子进程管理（Windows 三坑集中在此） ---
function killDsh(child, signal) {
  if (!child || !pidAlive(child.pid)) return;
  if (process.platform === "win32") {
    // 坑 2/3：无 POSIX 信号 + child.kill 只杀壳进程；统一 taskkill /T 清进程树
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {}
  } else {
    try { process.kill(child.pid, signal); } catch {}
  }
}

function spawnDsh(abs, args, env) {
  // 坑 1：.cmd/.bat 入口不能直接 spawn（无 PATHEXT 解析），shell:true 回退
  const winScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(abs);
  const opts = { env, stdio: ["ignore", "pipe", "pipe"] };
  return winScript ? spawn(abs, args, { ...opts, shell: true }) : spawn(abs, args, opts);
}

// dsh 子命令（plugin list / add 等）：spawn env 显式 {...process.env, DSH_HOME}，
// 等价 bash `export DSH_HOME=...` 后的子命令环境。
function runDsh(args, silent = true) {
  return spawnSync(dshAbs, args, {
    env: { ...process.env, DSH_HOME: isolatedHome },
    stdio: silent ? "ignore" : "inherit",
    timeout: 600000,
  });
}

// --- B6 verdict（就绪中间态 cleanup:"running" → 终态 "done"/"kept"） ---
function makeVerdict(mut) {
  return {
    v: 1,
    ok: false,
    dsh: { path: dshAbs, version: dshVersion },
    dshHome: isolatedHome,
    profile,
    port: { requested: flags?.port ?? null, actual: actualPort, source: portSource },
    pid: dshChild?.pid ?? null,
    browser: flags?.browser ? { state: browserState, port: browserPort } : null,
    telemetry: {
      env: { DSH_TELEMETRY_DISABLED: "1" },
      officialContract: false,
      note: "非官方契约，不承诺实际生效",
    },
    ready: readyOk,
    readyAt: readyIso,
    evidenceDir,
    cleanup: "running", // 中间态；终态由 writeVerdictTerminal 覆写为 done/kept
    ...mut,
  };
}

function writeVerdict(partial) {
  if (!isolatedHome) return;
  try {
    writeFileSync(verdictPath, JSON.stringify(makeVerdict(partial), null, 2), { mode: 0o600 });
  } catch (e) {
    outWarn(`verdict 写入失败: ${e.message}`);
  }
}

function writeVerdictRunning() {
  writeVerdict({ ok: true, ready: true, readyAt: readyIso, cleanup: "running" });
}

function writeVerdictTerminal() {
  const done = readyOk && (exiting?.code ?? EXIT.FAIL) === 0;
  writeVerdict({ ok: done, ready: readyOk, readyAt: readyIso, cleanup: flags?.keep ? "kept" : "done" });
}

// --- 插件处理（C11 内建归一化 + 构建 / --no-build 校验 / add） ---
function newestMtime(dir) {
  let m = 0;
  const walk = (d) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const t = statSync(p).mtimeMs; if (t > m) m = t; }
    }
  };
  walk(dir);
  return m;
}

function hasBuildScript(pkgAbs) {
  try {
    return !!JSON.parse(readFileSync(join(pkgAbs, "package.json"), "utf8")).scripts?.build;
  } catch { return false; }
}

function setupPlugins(pkgs) {
  if (pkgs.length === 0) return;
  // 1. 归一化全部参数（C11 语义内建）：path → 绝对路径；spec → 原样透传
  const items = pkgs.map(resolvePkgArg);
  for (const it of items) {
    const label = it.kind === "path" ? it.abs : it.input;
    // 非本地插件目录（无 package.json）：跳过构建，原样交给 add（包名/git URL）
    if (it.kind === "spec" || !existsSync(join(it.abs, "package.json"))) {
      out(`跳过: 非本地插件目录（无 package.json）: ${label}（若为包名/git URL 将原样传给 dsh）`);
      continue;
    }
    if (flags.noBuild) {
      const prods = ["lib", "dist"].map((d) => join(it.abs, d))
        .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
      if (prods.length === 0) {
        throw new CliError(
          `错误: --no-build 但缺少构建产物（lib/ 或 dist/）: ${it.abs}\n` +
          "       请先 pnpm build，或去掉 --no-build 让脚本自动构建",
          EXIT.USAGE,
        );
      }
      // 陈旧警告（#376 L2）：src 比产物新 → 提示可能验证到旧版本
      const src = join(it.abs, "src");
      const s = existsSync(src) ? newestMtime(src) : 0;
      const p = Math.max(...prods.map(newestMtime));
      if (s > p) outWarn(`警告: 源码比构建产物新（--no-build 可能验证到旧版本）: ${it.abs}`);
    } else if (hasBuildScript(it.abs)) {
      out(`构建插件: ${it.abs}`);
      const r = spawnSync("pnpm", ["build"], {
        cwd: it.abs,
        env: process.env,
        stdio: ["inherit", jsonMode ? "pipe" : "inherit", "inherit"],
        timeout: 600000,
      });
      if (jsonMode && r.stdout) process.stderr.write(String(r.stdout)); // 不污染 stdout
      if (r.status !== 0) throw new CliError(`错误: pnpm build 失败（退出码 ${r.status}）: ${it.abs}`, EXIT.FAIL);
    } else {
      out(`跳过构建（无 build 脚本）: ${it.abs}`);
    }
  }
  // 2. add 统一用归一化结果（相对路径已在 dsh 侧被当 git URL，C11）
  const addArgs = items.map((it) => (it.kind === "path" ? it.abs : it.input));
  const add = runDsh(["plugin", "--profile", profile, "add", ...addArgs], true);
  if (add.status !== 0) {
    throw new CliError(
      `错误: dsh plugin add 失败（已传入归一化路径）:\n${addArgs.map((p) => `  - ${p}`).join("\n")}`,
      EXIT.FAIL,
    );
  }
}

// --- 就绪断言（#376 M2）：轮询 HTTP 可达 + 进程存活核对 ---
// 2xx-4xx 就绪（GUI 带鉴权，实测 401 即就绪）、5xx/拒绝继续等、
// AbortSignal.timeout 1.5s、15s 超时、进程退出立即判失败。
async function waitReady(port, pid) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (!pidAlive(pid)) return "dead";
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return "ready";
    } catch { /* 连接拒绝 / 超时：继续等 */ }
    if (Date.now() >= deadline) return "timeout";
    await new Promise((r) => setTimeout(r, 250));
  }
}

// --- 退出终态：单一幂等清理（kill dsh → browser quit → verdict → rm） ---
// SIGINT / SIGTERM / child exit / 抛错四路汇聚于此；Ctrl+C 透传 130/143。
function requestExit(code, signal) {
  if (exiting) return;
  exiting = { code, signal };
  if (dshChild && signal) killDsh(dshChild, signal);
  void settle();
}

async function settle() {
  if (settling) return;
  settling = true;
  try {
    // 1. kill dsh（含窗口等待 + SIGKILL 兜底）
    if (dshChild) {
      await waitPidExit(dshChild.pid, 5000);
      if (pidAlive(dshChild.pid)) killDsh(dshChild, "SIGKILL");
      await waitPidExit(dshChild.pid, 2000);
    }
    // 2. browser quit（如有实例，CDP 优雅关闭 + kill 兜底，行为同 bash trap）
    if (flags?.browser && browserState && existsSync(browserState)) {
      out("清理浏览器实例（browser-driver quit）...");
      try {
        spawnSync(process.execPath, [DRIVER, "quit", "--state", browserState, "--json"], { stdio: "ignore", timeout: 20000 });
      } catch {}
    }
    // 3. verdict 终态 cleanup（done/kept）
    writeVerdictTerminal();
    // 4. 不 --keep 时清理 ISOLATED_HOME
    if (isolatedHome) {
      if (flags?.keep) {
        out(`（--keep）临时 DSH_HOME 保留于: ${isolatedHome}`);
        out(`（--keep）如需删除: rm -rf '${isolatedHome}'`);
      } else {
        rmSync(isolatedHome, { recursive: true, force: true });
      }
    }
  } catch (e) {
    outWarn(`清理异常（继续退出）: ${e.message}`);
  } finally {
    // --json：stdout 只出一份 JSON——错误路径已输出错误对象则不再重复，否则出
    // 最终 verdict（ok/cleanup 终态与 verdict.json 文件一致）
    if (jsonMode) {
      if (errorPayload) jsonOut(errorPayload);
      else jsonOut(makeVerdict({ ok: readyOk && (exiting?.code ?? EXIT.FAIL) === 0, cleanup: flags?.keep ? "kept" : "done" }));
    }
    process.exit(exiting?.code ?? EXIT.FAIL);
  }
}

process.on("SIGINT", () => requestExit(EXIT.SIGINT, "SIGINT"));
process.on("SIGTERM", () => requestExit(EXIT.SIGTERM, "SIGTERM"));

// --- 主流程 ---
async function main() {
  const { flags: f, pkgs } = parseCli(process.argv.slice(2));
  flags = f;
  jsonMode = f.json;
  if (f.help) { process.stdout.write(USAGE + "\n"); process.exit(EXIT.OK); }

  // 0. dsh 入口校验与版本锚定展示（fail fast，不在建完环境后才失败）
  const rawDsh = f.dsh ?? "dsh";
  dshAbs = resolveDsh(rawDsh);
  if (!dshAbs) {
    throw new CliError(`错误: 找不到 dsh 入口: ${rawDsh}（--dsh 需指向可执行的 dsh）`, EXIT.USAGE);
  }
  dshVersion = readDshVersion(dshAbs);
  out(`dsh 入口: ${dshAbs} (${dshVersion})`);

  // 1. 第一层隔离：全新临时 DSH_HOME（隔离凭据/会话/home 级 patch）
  isolatedHome = mkdtempSync(join(tmpdir(), "dsh-verify-"));
  profile = `verify_${randomBytes(4).toString("hex")}`;
  browserState = join(isolatedHome, "browser.state");
  dshLogPath = join(isolatedHome, "dsh.log");
  verdictPath = join(isolatedHome, "verdict.json");
  // B7：证据目录默认 $ISOLATED_HOME/evidence/；显式 --evidence-dir 外部化时建
  // <dir>/evidence-<profile>/ 子目录（recursive 幂等，绝不动外部目录本体）
  evidenceDir = f.evidenceDir
    ? join(resolve(f.evidenceDir), `evidence-${profile}`)
    : join(isolatedHome, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  out(`证据目录: ${evidenceDir}`);

  // 2. 初始化独立 profile（显式 plugin list；失败 fail loudly 给可操作错误）
  const init = runDsh(["plugin", "--profile", profile, "list"], true);
  if (init.status !== 0) {
    throw new CliError(`错误: profile 初始化失败（dsh plugin --profile ${profile} list）——检查 dsh 入口与版本`, EXIT.FAIL);
  }

  // 3. 注入内置 web-app bundle（按名从 dsh 安装目录解析，不走 npm）
  const profilePkg = join(isolatedHome, "profiles", profile, "package.json");
  const pj = JSON.parse(readFileSync(profilePkg, "utf8"));
  const bundles = pj.dsh.profile.bundles;
  if (!bundles.includes("@deepseek-ai/dsh-base")) bundles.unshift("@deepseek-ai/dsh-base");
  if (!bundles.includes("@deepseek-ai/dsh-web-app")) {
    bundles.splice(bundles.indexOf("@deepseek-ai/dsh-base") + 1, 0, "@deepseek-ai/dsh-web-app");
  }
  writeFileSync(profilePkg, JSON.stringify(pj, null, 2));

  // 4. 挂载本地插件（C11 归一化 + 构建 / --no-build 校验 + add）
  setupPlugins(pkgs);

  // 5. 启动独立浏览器实例（--browser）：实例信息写入 browser.state
  if (f.browser) {
    const launch = spawnSync(
      process.execPath,
      [DRIVER, "launch", "--state", browserState, "--user-data-dir", join(isolatedHome, "browser-profile"), "--json"],
      { stdio: ["ignore", "pipe", "inherit"], timeout: 60000 },
    );
    if (launch.status !== 0) {
      const detail = (launch.stdout || "").toString().trim();
      throw new CliError(`错误: 浏览器实例启动失败（browser-driver launch, 退出码 ${launch.status}）${detail ? `\n${detail}` : ""}`, EXIT.FAIL);
    }
    // 非 --json：透传 launch 的 JSON 输出（bash 版行为）；--json 时 stdout 归零
    if (!jsonMode && launch.stdout) process.stdout.write(String(launch.stdout));
    try {
      browserPort = JSON.parse(readFileSync(browserState, "utf8")).port ?? null;
    } catch { browserPort = null; }
    out(`浏览器实例就绪: state=${browserState}（操作命令见 browser-driver.mjs --help）`);
  }

  // 6. 修复 --port 0：贴近 dsh 启动探测真实空闲端口再传给 dsh（#481 P2-1）
  dshWebPort = f.port;
  if (f.port === 0) {
    dshWebPort = await findFreePort();
    out(`（--port 0）已探测空闲端口: ${dshWebPort}`);
  }

  // 7. 把 dsh web 实际端口并入 browser.state（供并行任务核对；bash 同款）
  if (f.browser && existsSync(browserState)) {
    try {
      const st = JSON.parse(readFileSync(browserState, "utf8"));
      st.dshWebPort = dshWebPort;
      writeFileSync(browserState, JSON.stringify(st, null, 2));
    } catch { /* state 解析失败不阻断启动 */ }
  }

  out(`隔离环境就绪: DSH_HOME=${isolatedHome}  profile=${profile}`);
  out(`启动 dsh web 于 http://127.0.0.1:${dshWebPort} （Ctrl+C 退出并自动清理）`);

  // 8. 启动（后台子进程 + 显式回环 + 遥测禁用）。spawn env 显式带 DSH_HOME 与
  //    DSH_TELEMETRY_DISABLED（等价 bash 启动行前缀）；dsh stdout/stderr 收集到
  //    $ISOLATED_HOME/dsh.log（限长缓冲防背压 + B6 parsed 端口解析源）。
  dshChild = spawnDsh(dshAbs, ["--profile", profile, "--host", "127.0.0.1", "--port", String(dshWebPort), "--no-open"], {
    ...process.env,
    DSH_HOME: isolatedHome,
    DSH_TELEMETRY_DISABLED: "1",
  });

  let logTail = ""; // 4096 限长滚动缓冲（防背压先例）
  const onDshData = (chunk) => {
    const s = String(chunk);
    try { appendFileSync(dshLogPath, s); } catch {}
    logTail += s;
    if (logTail.length > LOG_TAIL_LIMIT) logTail = logTail.slice(logTail.length - LOG_TAIL_LIMIT);
    // parsed 通道：dsh.log 端口行（chunk 可能在行中截断，故对滚动缓冲整体匹配）。
    // 实证（0.1.2-rc.1）：dsh 打印 `dsh web: http://127.0.0.1:<port>/` 的时刻晚于
    // HTTP 就绪——故 parsed 未取得前**持续允许覆盖**（probed/asserted → parsed），
    // 而不是就绪瞬间一锤定音；终态 verdict 以 parsed 为准。
    if (!actualPort || portSource !== "parsed") {
      const p = readDshPort(logTail);
      if (p) { actualPort = p; portSource = "parsed"; }
    }
  };
  dshChild.stdout.on("data", onDshData);
  dshChild.stderr.on("data", onDshData);

  // child 退出：正常/异常透传 dsh 自身退出码（bash wait 同语义）；Ctrl+C 同进程组
  // 时 dsh 收到 SIGINT 退出，此处 signal → 130/143（信号路径已由 SIGINT handler
  // 兜底，双路汇聚 settle 幂等）。
  dshChild.once("exit", (code, signal) => {
    if (exiting) return;
    const mapped = signal === "SIGINT" ? EXIT.SIGINT : signal === "SIGTERM" ? EXIT.SIGTERM : (code ?? EXIT.FAIL);
    requestExit(mapped, null);
  });

  // 9. 就绪断言（轮询 HTTP + 进程存活核对，15s 超时可操作错误）
  const verdictPort = dshWebPort;
  const ready = await waitReady(verdictPort, dshChild.pid);
  if (ready === "dead") {
    throw new CliError(
      "错误: dsh web 进程在就绪前退出（可能端口被占/EADDRINUSE/插件加载失败）——按上方 dsh 输出排查；--keep 可保留现场",
      EXIT.FAIL,
    );
  }
  if (ready === "timeout") {
    throw new CliError(`错误: dsh web 15s 内未就绪（端口 ${verdictPort}）——按上方 dsh 输出排查；--keep 可保留现场`, EXIT.FAIL);
  }
  readyOk = true;
  readyIso = new Date().toISOString();
  // 端口实际绑定三通道收口：parsed → asserted（就绪断言端口）→ probed。
  // 就绪成功瞬间 data 事件可能尚未排到、dsh 端口行也可能晚于 HTTP 就绪打印
  // （实证），故先对 dsh.log 文件做一次 parsed 兜底；仍无则落 asserted/probed。
  if (!actualPort || portSource !== "parsed") {
    try {
      const p = readDshPort(readFileSync(dshLogPath, "utf8"));
      if (p) { actualPort = p; portSource = "parsed"; }
    } catch {}
  }
  if (!actualPort) {
    actualPort = verdictPort;
    portSource = flags.port === 0 ? "probed" : "asserted";
  }
  out(`就绪断言通过: http://127.0.0.1:${actualPort} 已可达（pid=${dshChild.pid}）`);

  // B6：就绪后写 verdict 中间态（cleanup:"running"，退出时更新终态）
  writeVerdictRunning();

  // 10. 前台等待：dsh 退出（含 Ctrl+C）后 settle 统一清理
  await new Promise((r) => dshChild.once("exit", r));
  if (!exiting) requestExit(EXIT.OK, null);
  await settle();
}

main().catch(async (e) => {
  const code = Number.isInteger(e?.code) ? e.code : EXIT.FAIL;
  // 输出错误：--json 时 stdout 单 JSON（settle 不再重复出），普通模式人类文案 stderr
  if (jsonMode) errorPayload = { ok: false, error: e.message, exitCode: code };
  else process.stderr.write(e.message + "\n");
  // 已进入 settle 则直接收尾（信号路径先到）；否则走统一清理（bash EXIT trap）
  if (settling) return;
  requestExit(code, null);
});