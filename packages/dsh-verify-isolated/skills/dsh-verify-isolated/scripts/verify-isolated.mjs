#!/usr/bin/env node
/**
 * verify-isolated.mjs — 隔离环境浏览器验证一键脚本（dsh-verify-isolated 插件包
 * 配套，随本 skill 分发）。原 `verify-isolated.sh`（bash + 内嵌 node -e）整体
 * 重写为纯 node 实现（需 Node >= 22），**不保留 shim**：skill 随包整体
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
 *   node verify-isolated.mjs [--port <port>] [--browser] [--keep]
 *                            [--no-build] [--evidence-dir <dir>] [--audit]
 *                            [--audit-extra-dirs <dir>] [--no-skip-onboarding]
 *                            [--probe-provider-usage] [--json] [-- <pkg-path>...]
 *   dsh 入口     从 PATH 解析 `dsh`，要求 `dsh --version` 为 0.2.2-rc.1。找不到、
 *                不可用、读取失败或其它版本一律 fail-closed，避免产出不属于目标
 *                runtime 的 preset/验证证据。
 *   --port <port>      默认 3456；--port 0 自动探测真实空闲端口并打印（修复打印 0）。
 *                      探测块贴近 dsh 启动，防 EADDRINUSE 窗口。
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
 *   --audit            隔离审计（B4）：对比隔离 DSH_HOME 写面与预置白名单
 *                      （版本化 WHITELIST_V，lib/audit.mjs），白名单外变化报
 *                      「可疑」（新增/删除/修改 + 越界 symlink），**不阻断退出**
 *                      （审计是补充非门禁，退出码契约不变）；t0 基线在**就绪
 *                      断言成功后**扫描（dsh 启动写面进基线，审计 dsh 运行期
 *                      写面；先扫后写 + 白名单双保险）。
 *   --audit-extra-dirs <dir>
 *                      额外审计目录（可重复）：相对路径基于 cwd 绝对化；局限
 *                      ——审计只扫 $ISOLATED_HOME 子树 + 本选项指定目录，**不扫
 *                      真实 home**（插件写真实 ~/.dsh 的数据面不在判定面内）。
 *   --no-skip-onboarding
 *                      不预置首启弹窗跳过（默认预置 settings.yaml 的
 *                      <namespace>.welcomeNoticeVersion，使「内测声明」默认
 *                      不弹；命名空间与版本均从同一份 dsh 客户端产物现取，任一
 *                      缺失就不预置并交给 browser-driver 导航后兜底。
 *                      要验证 onboarding 弹窗本身时用它保留原生首启态。
 *   --json             stdout 只出最终 verdict JSON（人类文案全部走 stderr）。
 *   --probe-provider-usage
 *                      可选真实宿主验证（**不是离线 CI 门禁**）：隔离实例就绪后请求
 *                      provider-usage 的 /stats?provider=deepseek-official 与 /health，
 *                      解析 ok/error/lastSuccessAt 与 health.errors/fetchErrors 后
 *                      **立即退出**（不进入前台等待）。隔离 DSH_HOME 的
 *                      .credentials.yaml 无 refs 条目 → skip（输出「未验证（无凭据）」，
 *                      退出 0）；有存储凭据且 ok:true 或 error 非 no-api-key → 退出 0；
 *                      有存储凭据但 no-api-key → 退出 1 并给可操作诊断。不读取/复制
 *                      用户 ~/.dsh 凭据，不把继承的 env 凭据当证据，不回显 token/密钥。
 *   --                 之后为要挂载的本地插件路径（相对路径基于当前 cwd 解析；
 *                      npm 包名 / git URL 原样透传，见 lib/verify-core.mjs
 *                      resolvePkgArg）。
 *   --help             显示本帮助。
 *
 * 退出码契约（显式表，smoke 锁定）：
 *   +-----+------------------------------------------------------------------+
 *   |  0  | 正常完成：启动 + 就绪 + 前台等待 dsh 退出，清理完毕                |
 *   |  1  | 启动或就绪失败：profile 初始化失败 / add 失败 / dsh 就绪前退出 /   |
 *   |     | 15s 就绪超时                                                      |
 *   |  2  | 参数错误：未知选项 / 缺参 / 找不到 dsh 入口 / --no-build 缺产物    |
 *   | 130 | SIGINT（Ctrl+C）：终态清理后透传                                   |
 *   | 143 | SIGTERM：终态清理后透传                                            |
 *   +-----+------------------------------------------------------------------+
 *   （--probe-provider-usage 的 fail 也归 1：凭据存在但 no-api-key / stats 请求或
 *    响应不可用；skip/pass 归 0。探针模式跑完即退出，不进入前台等待。）
 *   （其余：就绪后 dsh 自身异常退出码原样透传；信号退出归一为 130/143——与
 *     bash 版 wait 透传同语义，见 main() 中 child "exit" 处理注释。）
 *
 * Windows 三坑（承诺等级：试验性，文档已标注；smoke 不启动 dsh，Windows 行为走
 * 代码审查）：
 *   1. spawn/execFile 对 .cmd 回退：.cmd/.bat 入口无 PATHEXT 解析，统一
 *      shell:true 回退（见 spawnDsh / readDshVersion / runDsh / resolveDsh
 *      注释）；win32 下 PATH 查找优先 .exe，仅剩 .cmd/.bat 时按脚本回退；
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
 *
 * B4 隔离审计（--audit）：判定面 = 预置白名单（WHITELIST_V 版本化，
 * lib/audit.mjs 纯函数：scanSnapshot / diffAgainstWhitelist /
 * checkSymlinkEscape / runAudit）外的新增/删除/修改 + 越界 symlink；
 * symlink 快照 lstat 不跟随，「t0 已存在且目标未变的外部 symlink（link:
 * 挂载点）合法不报」，「新增或目标变化且 resolve 后在**所在扫描根**外的
 * 报『越界 symlink』（防插件经 symlink 写到隔离环境之外）。时序：t0 基线
 * 在**就绪断言成功之后**（dsh web 首启自建的 profiles/node_modules/** 官方
 * bundle link 与顶层 .credentials.yaml/storages/** 启动写面进基线——语义为
 * 「就绪后运行期写面审计」；verdict 中间态在其后写入，先扫后写 + 白名单
 * 双保险）；审计 diff 插在 settle「kill dsh → browser quit → 审计 →
 * verdict 终态 → rm」；--keep 落 $ISOLATED_HOME/audit/audit.json，否则并入
 * verdict JSON（audit 字段，--json 错误对象恒带 audit 字段与 verdict 对齐）。
 * 不阻断退出（审计异常仅警告，退出码契约不变）。就绪前退出/超时路径
 * auditBaseline 为 null → 审计跳过不报。
 *
 * 首启弹窗默认跳过（--no-skip-onboarding 关闭）：全新 DSH_HOME 的首屏是两个
 * **阻断式**弹窗（「内测声明」→「添加 API Key」），二者都把 #root 置为 inert，
 * 页面上的一切点击静默失效。内测声明由 settings.yaml 的
 * <namespace>.welcomeNoticeVersion 与客户端常量精确相等决定，故启动前预置该
 * 值即默认不弹——命名空间与版本均按 dsh 版本现取（lib/onboarding.mjs：
 * WELCOME_NOTICE_SETTINGS_NAMESPACE / WELCOME_NOTICE_VERSION）；任一缺失就只
 * 警告并交给 browser-driver 导航后兜底，绝不用硬编码值伪造「已跳过」。「添加 API Key」
 * 无法预置消除（其「稍后配置」只在当前页面生命周期内有效），由 browser-driver
 * 在导航后自动点击跳过。弹窗成因、复现与对照见 SKILL.md 的硬前提（§3.2）。
 *
 * 访问 URL 与令牌：GUI 带鉴权，裸端口只得到 401 文本页，浏览器命令必须使用
 * dsh 启动打印的带令牌 URL。脚本解析该行并：打印供直接使用、写入 browser.state
 * 的 dshWebUrl（0o600，供 browser-driver 的 `--url state` 取用）；verdict 里只
 * 记不含令牌的 web.url——verdict 会经 --json 进入 CI 日志，令牌不进日志。
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  EXIT,
  findFreePort,
  jsonOut,
  pidAlive,
  readDshPort,
  readDshUrl,
  waitPidExit,
} from "./lib/verify-core.mjs";
import { isInside, runAudit, scanSnapshot, SKIP_DEEP, WHITELIST_V } from "./lib/audit.mjs";
import { formatProbeReport, runProviderUsageProbe } from "./lib/provider-usage-probe.mjs";
import { CliError, createUsage, detectJsonMode, parseCli } from "./lib/cli.mjs";
import { isWinScript, readDshVersion, resolveDsh } from "./lib/dsh-entry.mjs";
import { resetOnboardingPreset } from "./lib/onboarding-preset.mjs";
import { initProfileAndBundles, setupPlugins } from "./lib/plugin-setup.mjs";

const SCRIPT_DIR = import.meta.dirname; // Node >= 22 全程可用
const DRIVER = join(SCRIPT_DIR, "browser-driver.mjs");
// 目标 runtime 单版锚定（精确版本，不放宽成 semver range）。
const TARGET_DSH_VERSION = "0.2.2-rc.1";
const READY_TIMEOUT_MS = 15000;
const URL_WAIT_MS = 5000; // 访问 URL 行晚于 HTTP 就绪的等待上限（见 9b 注释）
const LOG_TAIL_LIMIT = 4096; // 防背压：收集缓冲限长（browser-driver stderrBuf 先例）
const USAGE = createUsage(TARGET_DSH_VERSION);

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
let childExitBeforeReady = null; // 就绪前 dsh 退出记录
let exiting = null; // { code: number, signal: string|null } 退出请求
let settling = false;
let errorPayload = null; // --json 错误路径已输出的错误对象（settle 不再重复出 JSON）
let auditBaseline = null; // B4：t0 基线快照 [{ root, snapshot }]（--audit 时）
let auditResult = null; // B4：settle 审计输出（--audit 时；并入 verdict/audit.json）
let auditExtraDirsAbs = []; // B4：绝对化后的 --audit-extra-dirs（settle 审计与 verdict 共用）
let onboardingPreset = null; // 首启弹窗预置结果（--no-skip-onboarding 时为 disabled）
let providerUsageResult = null; // 可选真实宿主探针结果（--probe-provider-usage 时进 verdict）
let webUrl = null; // 带令牌的访问 URL（仅落 browser.state / 打印，不进 verdict）
let webUrlBare = null; // 不含令牌的访问 URL（进 verdict，防 --json 日志泄漏令牌）

// 人类文案输出：--json 时走 stderr（stdout 只出最终 JSON），普通模式走 stdout
//（SKILL.md §4 自检清单依赖 `profile=verify_<随机>` / `DSH_HOME=…` 等可读行）。
function out(msg) {
  (jsonMode ? process.stderr : process.stdout).write(msg + "\n");
}
// 警告恒走 stderr（bash 版 console.warn 同语义）
function outWarn(msg) {
  process.stderr.write(msg + "\n");
}

// --- CLI 解析与 dsh 入口解析在 lib/ 同名职责模块；入口只保留运行态接线 ---

// --- dsh 子进程管理（Windows 三坑集中在此） ---
function killDsh(child, signal) {
  if (!child || !pidAlive(child.pid)) return;
  if (process.platform === "win32") {
    // 坑 2/3：无 POSIX 信号 + child.kill 只杀壳进程；统一 taskkill /T 清进程树
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {}
  } else {
    try {
      process.kill(child.pid, signal);
    } catch {}
  }
}

function spawnDsh(abs, args, env) {
  // 坑 1：.cmd/.bat 入口不能直接 spawn（无 PATHEXT 解析），shell:true 回退
  const opts = { env, stdio: ["ignore", "pipe", "pipe"] };
  return isWinScript(abs) ? spawn(abs, args, { ...opts, shell: true }) : spawn(abs, args, opts);
}

// dsh 子命令（plugin list / add 等）：spawn env 显式 {...process.env, DSH_HOME}，
// 等价 bash `export DSH_HOME=...` 后的子命令环境。win32 三坑之 1：.cmd 入口
// spawnSync 无 PATHEXT 解析，shell:true 回退（试验性承诺）。
function runDsh(args, silent = true) {
  return spawnSync(dshAbs, args, {
    env: { ...process.env, DSH_HOME: isolatedHome },
    stdio: silent ? "ignore" : "inherit",
    timeout: 600000,
    ...(isWinScript(dshAbs) ? { shell: true } : {}),
  });
}

// --- B6 verdict（就绪中间态 cleanup:"running" → 终态 "done"/"kept"） ---
function makeVerdict(mut) {
  return {
    v: 1,
    ok: false,
    dsh: { path: dshAbs, version: dshVersion },
    dshHome: isolatedHome,
    profile: profile,
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
    evidenceDir: evidenceDir,
    // 访问 URL 恒去令牌：verdict 会经 --json 进 CI 日志，令牌真值只落
    // browser.state.dshWebUrl 与 dsh.log（均 0o600），tokenSource 指明去哪取。
    web: { url: webUrlBare, tokenSource: webUrl ? "browser.state.dshWebUrl" : null },
    onboarding: onboardingPreset,
    // 可选真实宿主探针（--probe-provider-usage）：结果已脱敏（URL 去 query、字段白名单），
    // 未启用时为 null。探针不是离线 CI 门禁；skip 也如实进 verdict，防「没跑=通过」。
    providerUsage: providerUsageResult,
    audit: auditResult, // B4：--audit 时 settle 审计结果；否则 null（--json 终态含同字段）
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
  writeVerdict({
    ok: done,
    ready: readyOk,
    readyAt: readyIso,
    cleanup: flags?.keep ? "kept" : "done",
  });
}

// --- 就绪断言：轮询 HTTP 可达 + 进程存活核对 ---
// 2xx-4xx 就绪（GUI 带鉴权，实测 401 即就绪）、5xx/拒绝继续等、
// AbortSignal.timeout 1.5s、15s 超时、进程退出立即判失败。
async function waitReady(port, pid) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (!pidAlive(pid)) return "dead";
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return "ready";
    } catch {
      /* 连接拒绝 / 超时：继续等 */
    }
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

async function stopDshChild() {
  // 1. kill dsh：与 bash trap 对齐，先 SIGTERM 优雅终止（5s 窗口），SIGKILL
  //    仅作二次兜底（避免活体 dsh 被直接 SIGKILL 跳过清理钩子）
  if (!dshChild) return;
  if (pidAlive(dshChild.pid)) killDsh(dshChild, "SIGTERM");
  await waitPidExit(dshChild.pid, 5000);
  if (pidAlive(dshChild.pid)) killDsh(dshChild, "SIGKILL");
}

function quitBrowserInstance() {
  // 2. browser quit（如有实例，CDP 优雅关闭 + kill 兜底，行为同 bash trap）
  if (!(flags?.browser && browserState && existsSync(browserState))) return;
  out("清理浏览器实例（browser-driver quit）...");
  try {
    spawnSync(process.execPath, [DRIVER, "quit", "--state", browserState, "--json"], {
      stdio: "ignore",
      timeout: 20000,
    });
  } catch {}
}

function collectAuditSuspicious() {
  const all = [];
  for (const b of auditBaseline) {
    const t1 = scanSnapshot(b.root, { skipDeep: SKIP_DEEP });
    const r = runAudit({ t0: b.snapshot, t1, isolatedRoot: b.root });
    all.push(...r.suspicious);
  }
  // 去重 + 稳定排序（extra dir 与 DSH_HOME 已校验不重叠，防御性去重）
  const seen = new Set();
  return all
    .filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function reportAuditResult(suspicious) {
  const count = suspicious.length;
  auditResult = {
    enabled: true,
    whitelistV: WHITELIST_V,
    extraDirs: auditExtraDirsAbs, // 记绝对化后的目录（与 t0 扫描根一致）
    suspicious,
    count,
    conclusion: count === 0 ? "pass" : "suspicious",
    runAt: new Date().toISOString(),
  };
  if (count === 0) {
    out("审计:通过");
    return;
  }
  out(`审计:可疑项 ${count}:`);
  for (const s of suspicious) {
    out(`可疑: ${s.path}（${s.type}${s.detail ? `: ${s.detail}` : ""}）`);
  }
  out(`审计: ${count}项可疑`);
}

function persistAuditReport() {
  // --keep 落 $ISOLATED_HOME/audit/audit.json（t1 扫描之后写，先扫后写
  // 排除自身；audit/** 白名单双保险在位）
  if (!(flags.keep && isolatedHome)) return;
  const auditPath = join(isolatedHome, "audit", "audit.json");
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, JSON.stringify(auditResult, null, 2));
  out(`审计报告: ${auditPath}`);
}

function runSettleAudit() {
  // 3. 隔离审计（B4，--audit）：t1 终态扫描 → 白名单 diff + symlink 防逃逸 →
  //    输出结论。审计是补充非门禁：任何异常仅警告（auditResult 带 error），
  //    不阻断退出、不影响退出码契约。
  if (!(flags?.audit && auditBaseline)) return;
  try {
    reportAuditResult(collectAuditSuspicious());
    persistAuditReport();
  } catch (e) {
    outWarn(`审计异常（不影响退出码）: ${e.message}`);
    auditResult = {
      enabled: true,
      whitelistV: WHITELIST_V,
      extraDirs: auditExtraDirsAbs,
      suspicious: [],
      count: -1,
      conclusion: "error",
      error: e.message,
      runAt: new Date().toISOString(),
    };
  }
}

function finalizeVerdictAndHome() {
  // 4. verdict 终态 cleanup（done/kept；audit 字段已并入 makeVerdict）
  writeVerdictTerminal();
  // 5. 不 --keep 时清理 ISOLATED_HOME
  if (!isolatedHome) return;
  if (flags?.keep) {
    out(`（--keep）临时 DSH_HOME 保留于: ${isolatedHome}`);
    out(`（--keep）如需删除: rm -rf '${isolatedHome}'`);
    return;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
}

/**
 * 退出前 stdout 要出的那一份 JSON：错误路径已产出错误对象则补齐 audit 字段后原样出，
 * 否则出最终 verdict（ok/cleanup 终态与 verdict.json 文件一致）。
 */
function settleJsonPayload() {
  // B4：error 对象恒置 audit 字段（auditResult ?? null）与 verdict 对齐——t0 之前
  // 错误（如 extra-dir 不存在）时 audit 为 null 而非缺失，字段契约一致（M6）。
  if (errorPayload) {
    errorPayload.audit = auditResult ?? null;
    return errorPayload;
  }
  return makeVerdict({
    ok: readyOk && (exiting?.code ?? EXIT.FAIL) === 0,
    cleanup: flags?.keep ? "kept" : "done",
  });
}

function emitSettleOutput() {
  // --json：stdout 只出一份 JSON；非 --json 模式此处不出声。
  if (jsonMode) jsonOut(settleJsonPayload());
  process.exit(exiting?.code ?? EXIT.FAIL);
}

async function settle() {
  if (settling) return;
  settling = true;
  try {
    await stopDshChild();
    quitBrowserInstance();
    runSettleAudit();
    finalizeVerdictAndHome();
  } catch (e) {
    outWarn(`清理异常（继续退出）: ${e.message}`);
  } finally {
    emitSettleOutput();
  }
}

process.on("SIGINT", () => requestExit(EXIT.SIGINT, "SIGINT"));
process.on("SIGTERM", () => requestExit(EXIT.SIGTERM, "SIGTERM"));

// --- 主流程分阶段 helpers（复杂度门禁 40：main 只保留线性编排） ---
function resolveAuditExtraDirs(f) {
  // 0a. B4 --audit-extra-dirs 参数校验（纯参数级 fail fast：存在性 + 必须是
  // 目录 + 基于 cwd 绝对化；与 DSH_HOME 重叠校验延后到 mkdtemp 之后）。
  // 未开 --audit 时忽略（警告提示，审计需 --audit 显式开启——extra dirs 单独无效）。
  if (!f.audit) {
    if (f.auditExtraDirs.length > 0) {
      outWarn("警告: --audit-extra-dirs 未开启 --audit，忽略（审计需 --audit 显式开启）");
    }
    return [];
  }
  return f.auditExtraDirs.map((raw) => {
    const abs = resolve(raw);
    if (!existsSync(abs)) {
      throw new CliError(
        `错误: --audit-extra-dirs 目录不存在: ${raw}（相对路径基于 cwd 解析）`,
        EXIT.USAGE,
      );
    }
    if (!statSync(abs).isDirectory()) {
      throw new CliError(`错误: --audit-extra-dirs 必须是目录: ${raw}`, EXIT.USAGE);
    }
    return abs;
  });
}

function resolveDshEntry() {
  // 0. PATH 解析 dsh + 单版目标校验；必须在创建隔离目录与写 preset 之前 fail-closed。
  const rawDsh = "dsh";
  dshAbs = resolveDsh(rawDsh);
  if (!dshAbs) {
    throw new CliError(
      `错误: PATH 中找不到 dsh 入口（请安装 dsh ${TARGET_DSH_VERSION} 并确认 PATH）`,
      EXIT.USAGE,
    );
  }
  dshVersion = readDshVersion(dshAbs);
  if (!dshVersion) {
    throw new CliError(
      `错误: 无法读取 dsh 版本: ${dshAbs}（实际版本: 读取失败；期望版本: ${TARGET_DSH_VERSION}）`,
      EXIT.USAGE,
    );
  }
  if (dshVersion !== TARGET_DSH_VERSION) {
    throw new CliError(
      `错误: dsh 版本不匹配: ${dshAbs}（实际版本: ${dshVersion}；期望版本: ${TARGET_DSH_VERSION}）`,
      EXIT.USAGE,
    );
  }
  out(`dsh 入口: ${dshAbs} (${dshVersion})`);
}

function setupIsolatedHome(f, extraDirsAbs) {
  // 1. 第一层隔离：全新临时 DSH_HOME（隔离凭据/会话/home 级 patch）
  isolatedHome = mkdtempSync(join(tmpdir(), "dsh-verify-"));
  profile = `verify_${randomBytes(4).toString("hex")}`;
  browserState = join(isolatedHome, "browser.state");
  dshLogPath = join(isolatedHome, "dsh.log");
  verdictPath = join(isolatedHome, "verdict.json");
  // B4：extra dir 不得与隔离 DSH_HOME 重叠（同树重复审计 + 判定基准歧义）
  for (const dir of extraDirsAbs) {
    if (isInside(dir, isolatedHome) || isInside(isolatedHome, dir)) {
      throw new CliError(`错误: --audit-extra-dirs 与隔离 DSH_HOME 重叠: ${dir}`, EXIT.USAGE);
    }
  }
  // dsh.log 含隔离实例访问 token（dsh web URL 行）——与 verdict/browser.state
  // 一致 0o600 初始化（仅本用户可读，防同机其他用户窥探）。
  try {
    writeFileSync(dshLogPath, "", { mode: 0o600 });
  } catch {}
  // B7：证据目录默认 $ISOLATED_HOME/evidence/；显式 --evidence-dir 外部化时建
  // <dir>/evidence-<profile>/ 子目录（recursive 幂等，绝不动外部目录本体）
  evidenceDir = f.evidenceDir
    ? join(resolve(f.evidenceDir), `evidence-${profile}`)
    : join(isolatedHome, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  out(`证据目录: ${evidenceDir}`);
}

function launchBrowserIfNeeded(f) {
  // 5. 启动独立浏览器实例（--browser）：实例信息写入 browser.state。
  //    刻意不传 DSH_HOME：browser-driver 属宿主环境工具（探测系统 Chrome 内核、
  //    操作 /tmp 级 user-data-dir），不随隔离 home（同 pnpm build 方向注释）。
  if (!f.browser) return;
  const launch = spawnSync(
    process.execPath,
    [
      DRIVER,
      "launch",
      "--state",
      browserState,
      "--user-data-dir",
      join(isolatedHome, "browser-profile"),
      "--json",
    ],
    { stdio: ["ignore", "pipe", "inherit"], timeout: 60000 },
  );
  if (launch.status !== 0) {
    const detail = (launch.stdout || "").toString().trim();
    throw new CliError(
      `错误: 浏览器实例启动失败（browser-driver launch, 退出码 ${launch.status}）${detail ? `\n${detail}` : ""}`,
      EXIT.FAIL,
    );
  }
  // 非 --json：透传 launch 的 JSON 输出（bash 版行为）；--json 时 stdout 归零
  if (!jsonMode && launch.stdout) process.stdout.write(String(launch.stdout));
  try {
    browserPort = JSON.parse(readFileSync(browserState, "utf8")).port ?? null;
  } catch {
    browserPort = null;
  }
  out(`浏览器实例就绪: state=${browserState}（操作命令见 browser-driver.mjs --help）`);
}

async function resolveWebPort(f) {
  // 6. 修复 --port 0：贴近 dsh 启动探测真实空闲端口再传给 dsh
  dshWebPort = f.port;
  if (f.port === 0) {
    dshWebPort = await findFreePort();
    out(`（--port 0）已探测空闲端口: ${dshWebPort}`);
  }
}

function syncBrowserPort(f) {
  // 7. 把 dsh web 实际端口并入 browser.state（供并行任务核对；bash 同款）
  if (!(f.browser && existsSync(browserState))) return;
  try {
    const st = JSON.parse(readFileSync(browserState, "utf8"));
    st.dshWebPort = dshWebPort;
    writeFileSync(browserState, JSON.stringify(st, null, 2));
  } catch {
    /* state 解析失败不阻断启动 */
  }
}

function spawnDshChild() {
  // 8. 启动（后台子进程 + 显式回环 + 遥测禁用）。spawn env 显式带 DSH_HOME 与
  //    DSH_TELEMETRY_DISABLED（等价 bash 启动行前缀）；dsh stdout/stderr 收集到
  //    $ISOLATED_HOME/dsh.log（限长缓冲防背压 + B6 parsed 端口解析源）。
  dshChild = spawnDsh(
    dshAbs,
    ["--profile", profile, "--host", "127.0.0.1", "--port", String(dshWebPort), "--no-open"],
    {
      ...process.env,
      DSH_HOME: isolatedHome,
      DSH_TELEMETRY_DISABLED: "1",
    },
  );
}

function createDshLogCollector() {
  let logTail = ""; // 4096 限长滚动缓冲（防背压先例）
  // dsh.log 文件侧无限增长说明：dsh web 输出量极小（实测启动仅一行 URL），
  // 且 dsh.log 位于一次性临时 ISOLATED_HOME（退出即删），单次运行量级有限、
  // 不设文件侧滚动；内存侧 logTail 4096 限长防背压是唯一防膨胀约束。
  const onData = (chunk) => {
    const s = String(chunk);
    try {
      appendFileSync(dshLogPath, s);
    } catch {}
    logTail += s;
    if (logTail.length > LOG_TAIL_LIMIT) logTail = logTail.slice(logTail.length - LOG_TAIL_LIMIT);
    // parsed 通道：dsh.log 端口行（chunk 可能在行中截断，故对滚动缓冲整体匹配）。
    // 实证（0.1.2-rc.1）：dsh 打印 `dsh web: http://127.0.0.1:<port>/` 的时刻晚于
    // HTTP 就绪——故 parsed 未取得前**持续允许覆盖**（probed/asserted → parsed），
    // 而不是就绪瞬间一锤定音；终态 verdict 以 parsed 为准。
    if (!actualPort || portSource !== "parsed") {
      const p = readDshPort(logTail);
      if (p) {
        actualPort = p;
        portSource = "parsed";
      }
    }
  };
  return { onData, tail: () => logTail };
}

function attachChildExitHandler() {
  // child 退出：**就绪前退出不透传退出码**——dsh 启动即崩（端口被占
  // EADDRINUSE / 插件加载失败 / 就绪前净退出）时若直接 requestExit 透传，
  // settle 会在微任务内抢先 process.exit，使下方 waitReady 的 dead 检测与
  // CliError 诊断整段不可达：stderr 空（无可操作诊断）且 dsh exit 0（就绪前
  // 净退出）会静默假成功、非契约码（如 3）穿透契约表。
  // 故就绪前退出只记录，让 waitReady 的 pidAlive 检测返回 dead → 统一走
  // CliError(EXIT.FAIL) 路径（有诊断文案 + 契约退出码 1）。
  // **就绪后**：信号退出归一为 130/143，其余 dsh 异常退出码原样透传
  //（bash 版 wait 透传同语义，头部退出码表括号行措辞与此一致）。
  dshChild.once("exit", (code, signal) => {
    if (exiting) return;
    if (!readyOk) {
      childExitBeforeReady = { code, signal };
      return;
    }
    const mapped =
      signal === "SIGINT" ? EXIT.SIGINT : signal === "SIGTERM" ? EXIT.SIGTERM : (code ?? EXIT.FAIL);
    requestExit(mapped, null);
  });
}

function throwIfDshExitedEarly(collector) {
  const detail = childExitBeforeReady
    ? `（dsh 就绪前退出 code=${childExitBeforeReady.code ?? "null"} signal=${childExitBeforeReady.signal ?? "null"}）`
    : "";
  const tail = collector.tail().slice(-LOG_TAIL_LIMIT).trim();
  throw new CliError(
    `错误: dsh web 进程在就绪前退出${detail}（可能端口被占/EADDRINUSE/插件加载失败）\n` +
      `--- dsh 输出尾部（内存缓冲；完整 dsh.log 仅 --keep 保留: ${dshLogPath}）---\n` +
      `${tail || "（无输出）"}`,
    EXIT.FAIL,
  );
}

function throwReadinessTimeout(collector, verdictPort) {
  const tail = collector.tail().slice(-LOG_TAIL_LIMIT).trim();
  throw new CliError(
    `错误: dsh web 15s 内未就绪（端口 ${verdictPort}）\n` +
      `--- dsh 输出尾部（内存缓冲；完整 dsh.log 仅 --keep 保留: ${dshLogPath}）---\n` +
      `${tail || "（无输出）"}`,
    EXIT.FAIL,
  );
}

function resolveReadyPort(verdictPort) {
  // 端口实际绑定三通道收口：parsed → asserted（就绪断言端口）→ probed。
  // **无条件**以 dsh.log 全文重解析 parsed（chunk 截断可能已 latch 错误
  // 端口——readDshPort 行完整性校验已防截断，此处双保险覆盖任何早到解析；
  // 无匹配则落 asserted/probed）。
  try {
    const p = readDshPort(readFileSync(dshLogPath, "utf8"));
    if (p) {
      actualPort = p;
      portSource = "parsed";
    }
  } catch {}
  if (!actualPort) {
    actualPort = verdictPort;
    portSource = flags.port === 0 ? "probed" : "asserted";
  }
  out(`就绪断言通过: http://127.0.0.1:${actualPort} 已可达（pid=${dshChild.pid}）`);
}

async function awaitDshReady(collector, verdictPort) {
  // 9. 就绪断言（轮询 HTTP + 进程存活核对，15s 超时可操作错误）。
  //    dead/timeout 诊断内联 logTail 尾部（内存滚动缓冲，非 --keep 时 dsh.log
  //    随 ISOLATED_HOME 删除——引用文件路径用户按提示查看时已不存在）。
  const ready = await waitReady(verdictPort, dshChild.pid);
  if (ready === "dead") throwIfDshExitedEarly(collector);
  if (ready === "timeout") throwReadinessTimeout(collector, verdictPort);
  readyOk = true;
  readyIso = new Date().toISOString();
  resolveReadyPort(verdictPort);
}

/** 轮询 dsh.log 直到解析出带令牌 URL 或超时；解析不到时 webUrl 保持 null。 */
async function awaitWebUrlFromLog() {
  const deadline = Date.now() + URL_WAIT_MS;
  for (;;) {
    try {
      webUrl = readDshUrl(readFileSync(dshLogPath, "utf8"));
    } catch {}
    if (webUrl || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 把带令牌 URL 记进 browser.state 供 browser-driver 以 --url state 取用；失败不阻断启动。 */
function recordBrowserStateUrl(f) {
  if (!f.browser || !existsSync(browserState)) return;
  try {
    const st = JSON.parse(readFileSync(browserState, "utf8"));
    if (webUrl) st.dshWebUrl = webUrl;
    writeFileSync(browserState, JSON.stringify(st, null, 2));
    if (webUrl) out("浏览器命令: 用 `--url state` 取该带令牌 URL（示例见 SKILL.md §3.1）");
  } catch {
    /* state 解析失败不阻断启动 */
  }
}

async function resolveAccessUrl(f) {
  // 9b. 访问 URL 与令牌：GUI 带鉴权，浏览器命令必须用带令牌的 URL（裸端口只得到
  //     401 文本页）。令牌只从 dsh 打印行取真值，只落 0o600 的 browser.state 与
  //     dsh.log，verdict 记去令牌形态——verdict 会经 --json 进 CI 日志。
  webUrlBare = `http://127.0.0.1:${actualPort}/`;
  // dsh 打印 URL 行的时刻晚于 HTTP 就绪（与端口 parsed 通道同源的既有实证），
  // 就绪即读会稳定落空——那会把「必须带令牌」的引导降级成一句无用警告。
  await awaitWebUrlFromLog();
  if (!webUrl) {
    outWarn(
      `警告: 未从 dsh 输出解析到带令牌的访问 URL（dsh.log 行格式变化？）——浏览器命令请自行从 ${dshLogPath} 取 URL`,
    );
  } else {
    out(`访问 URL（含访问令牌，GUI 鉴权必需）: ${webUrl}`);
  }
  recordBrowserStateUrl(f);
}

function snapshotAuditBaseline(f, extraDirsAbs) {
  // B4：t0 基线快照（--audit）——位置在**就绪断言成功之后**、verdict 中间态
  // 写入之前。语义为「**就绪后运行期写面审计**」：dsh web **首启**才自建的
  // profiles/node_modules/** 官方 bundle link（指向真实 dsh 安装目录、越界但
  // t0 已存在未变 → 合法挂载点不报）与顶层 .credentials.yaml / storages/**
  // 启动写面全部进基线，干净运行不再误报；审计面 = dsh 就绪后、退出前这段
  // 运行期的增量写面（插件/会话/持久化）。verdict.json（中间态）在 t0 **之后**
  // 写入，先扫后写 + 白名单（verdict.json）双保险。就绪前退出/超时路径
  // auditBaseline 保持 null → settle 守卫跳过审计（不报），与「未进入运行期
  // 审计」语义一致。
  if (!f.audit) return;
  auditBaseline = [
    { root: isolatedHome, snapshot: scanSnapshot(isolatedHome, { skipDeep: SKIP_DEEP }) },
  ];
  for (const dir of extraDirsAbs) {
    auditBaseline.push({ root: dir, snapshot: scanSnapshot(dir, { skipDeep: SKIP_DEEP }) });
  }
}

/**
 * 11. 可选真实宿主 provider-usage 探针（--probe-provider-usage）。
 *
 * 就绪后请求 /api/dsh-provider-usage/stats?provider=deepseek-official 与
 * /api/dsh-provider-usage/health，解析白名单字段并打印脱敏报告；返回探针退出码。
 * 探针模式跑完即退出（不进入前台等待）：skip/pass=0，fail=1。无凭据时 skip 并
 * 明示「未验证（无凭据）」——探针不是离线 CI 门禁，没跑不等于通过。
 */
async function runProviderUsageProbeStep() {
  out("provider-usage 探针: 开始（可选真实宿主验证，不是离线 CI 门禁）...");
  const result = await runProviderUsageProbe({
    baseUrl: `http://127.0.0.1:${actualPort}/`,
    credentialsPath: join(isolatedHome, ".credentials.yaml"),
  });
  providerUsageResult = result;
  for (const line of formatProbeReport(result)) out(line);
  out(`provider-usage 探针退出码: ${result.exitCode}（${result.status}）`);
  return result.exitCode;
}

async function waitForDshExit() {
  // B6：就绪后写 verdict 中间态（cleanup:"running"，退出时更新终态）
  writeVerdictRunning();
  // 10. 前台等待：dsh 退出（含 Ctrl+C）后 settle 统一清理
  await new Promise((r) => dshChild.once("exit", r));
  if (!exiting) requestExit(EXIT.OK, null);
  await settle();
}

// --- 主流程 ---
async function main() {
  const argv = process.argv.slice(2);
  jsonMode = detectJsonMode(argv);
  const { flags: f, pkgs } = parseCli(argv);
  flags = f;
  jsonMode = f.json;
  // --json 时 USAGE 走 stderr（stdout 只出 JSON 的约束对 --help 同样生效）
  if (f.help) {
    (jsonMode ? process.stderr : process.stdout).write(USAGE + "\n");
    process.exit(EXIT.OK);
  }

  // 0a + 0（分阶段 helpers，顺序不变：先参数校验，再 dsh 入口锚定）
  const extraDirsAbs = resolveAuditExtraDirs(f);
  auditExtraDirsAbs = extraDirsAbs;
  resolveDshEntry();

  // 1 + 1b + 2 + 3 + 4（分阶段 helpers，顺序不变）
  setupIsolatedHome(f, extraDirsAbs);
  onboardingPreset = resetOnboardingPreset(f, { isolatedHome, dshAbs, out, outWarn });
  initProfileAndBundles({ isolatedHome, profile, runDsh });
  setupPlugins(pkgs, {
    noBuild: f.noBuild,
    jsonMode,
    profile,
    out,
    outWarn,
    runDsh,
  });

  // 5 + 6 + 7（分阶段 helpers，顺序不变）
  launchBrowserIfNeeded(f);
  await resolveWebPort(f);
  syncBrowserPort(f);

  out(`隔离环境就绪: DSH_HOME=${isolatedHome}  profile=${profile}`);
  out(`启动 dsh web 于 http://127.0.0.1:${dshWebPort} （Ctrl+C 退出并自动清理）`);

  // 8 + 9 + 9b + B4 + 10 + 11（分阶段 helpers，顺序不变）
  spawnDshChild();
  const collector = createDshLogCollector();
  dshChild.stdout.on("data", collector.onData);
  dshChild.stderr.on("data", collector.onData);
  attachChildExitHandler();
  const verdictPort = dshWebPort;
  await awaitDshReady(collector, verdictPort);
  await resolveAccessUrl(f);
  // 审计 t0 在探针请求之前：探针是运行期行为，写面增量应计入审计面。
  snapshotAuditBaseline(f, extraDirsAbs);
  // 11. 可选真实宿主探针：跑完即退出，退出码由探针判定（skip/pass=0，fail=1）。
  if (f.probeProviderUsage) {
    const probeCode = await runProviderUsageProbeStep();
    requestExit(probeCode, null);
    await settle();
    return;
  }
  await waitForDshExit();
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
