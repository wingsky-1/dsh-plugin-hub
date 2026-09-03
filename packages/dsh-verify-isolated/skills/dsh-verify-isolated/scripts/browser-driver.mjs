#!/usr/bin/env node
/**
 * browser-driver.mjs — dsh-verify-isolated 自带独立浏览器实例驱动（raw CDP，零依赖）。
 *
 * 设计目标：每个验证任务持有独立 chromium 实例（独立 user-data-dir + 独立调试端口），
 * 多会话并行互不可见，从结构上杜绝共享 MCP server 的 tab 漂移/串扰。零第三方依赖，
 * 只使用 Node 内置模块（child_process / fs / path / os / net / http 与 Node>=22 的
 * 全局 WebSocket），遵守发布物零运行时依赖纪律。
 *
 * 命令/参数契约以 `--help` 输出为准（launch / quit / snapshot / click / eval / fill /
 * wait / screenshot / console，统一 --json 输出）。内核探测链见 detectChrome()。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createServer } from "node:net";
import { get } from "node:http";

// --- 基础工具 ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function jsonOut(obj, pretty) {
  process.stdout.write(JSON.stringify(obj, null, pretty ? 2 : 0) + "\n");
}

// 实例级输出：统一 JSON，默认紧凑单行
const out = (flags, obj) => jsonOut(obj, flags.has("pretty"));

function fail(msg) {
  jsonOut({ ok: false, error: msg });
  process.exit(1);
}

function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { positionals.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq !== -1) { flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(key, next); i++; }
    else flags.set(key, "true");
  }
  return { flags, positionals };
}

function flag(flags, name, def) {
  const v = flags.get(name);
  return v === undefined ? def : v;
}

function httpJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`解析 ${url} 响应失败: ${e.message}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求 ${url} 超时`)));
    req.on("error", reject);
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitPidExit(pid, timeoutMs) {
  await poll(() => !pidAlive(pid), timeoutMs, 200);
  return !pidAlive(pid);
}

// --- CDP WebSocket RPC（内置全局 WebSocket，Node >= 22） ---

function rpc(wsUrl, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("当前 Node 无全局 WebSocket（需 Node >= 22），请升级 Node 或改用系统 Chrome 手工调试"));
      return;
    }
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); try { ws.close(); } catch {} };
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: nextId, method, params }));
      pending.set(nextId, { resolve, reject });
      nextId++;
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) { cleanup(); p.reject(new Error(`${method}: ${msg.error.message}`)); }
        else { cleanup(); p.resolve(msg.result); }
      }
    };
    ws.onerror = () => { cleanup(); reject(new Error(`WebSocket 连接失败: ${wsUrl}`)); };
    ws.onclose = () => { cleanup(); reject(new Error(`WebSocket 已关闭: ${wsUrl}`)); };
  });
}

// --- 浏览器内核探测（三平台，唯一收敛点） ---

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function* msPlaywrightCandidates() {
  let dir = null;
  if (platform() === "win32") dir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : null;
  else if (platform() === "darwin") dir = join(homedir(), "Library", "Caches", "ms-playwright");
  else dir = join(homedir(), ".cache", "ms-playwright");
  if (!dir || !existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const base = join(dir, entry);
    let st; try { st = statSync(base); } catch { continue; }
    if (!st.isDirectory() || !entry.startsWith("chrom")) continue;
    // linux
    for (const p of [join(base, "chrome-linux", "chrome"), join(base, "chrome-headless-shell-linux64", "chrome-headless-shell")]) if (isFile(p)) yield p;
    // mac：chrome-mac/Chromium.app/Contents/MacOS/Chromium 或其它 .app 名
    if (platform() === "darwin") {
      for (const sub of ["chrome-mac", "chromium-mac"]) {
        const appDir = join(base, sub);
        if (!existsSync(appDir)) continue;
        for (const app of readdirSync(appDir)) {
          const bin = join(appDir, app, "Contents", "MacOS", app.replace(/\.app$/, ""));
          if (isFile(bin)) yield bin;
        }
      }
    }
    // win
    for (const p of [join(base, "chrome-win", "chrome.exe"), join(base, "chrome-win32", "chrome.exe"), join(base, "chrome-headless-shell-win64", "chrome-headless-shell.exe")]) if (isFile(p)) yield p;
  }
}

function* pathCandidates() {
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"];
  const paths = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of paths) {
    for (const name of names) {
      const p = join(dir, name);
      if (isFile(p)) yield p;
      if (platform() === "win32") { const pe = p + ".exe"; if (isFile(pe)) yield pe; }
    }
  }
}

function* commonPathCandidates() {
  const home = homedir();
  if (platform() === "darwin") {
    const apps = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"];
    for (const root of ["/Applications", join(home, "Applications")]) {
      for (const app of apps) {
        const p = join(root, `${app}.app`, "Contents", "MacOS", app);
        if (isFile(p)) yield p;
      }
    }
  } else if (platform() === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const subs = [join("Google", "Chrome", "Application", "chrome.exe"), join("Chromium", "Application", "chrome.exe"), join("Microsoft", "Edge", "Application", "msedge.exe")];
    for (const root of roots) for (const sub of subs) { const p = join(root, sub); if (isFile(p)) yield p; }
  } else {
    for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/local/bin/google-chrome", "/opt/google/chrome/chrome", "/snap/bin/chromium", "/usr/bin/microsoft-edge"]) if (isFile(p)) yield p;
  }
}

const INSTALL_GUIDE = `未探测到 Chromium 系浏览器内核。可执行安装指引：
  - Linux (Debian/Ubuntu): sudo apt-get install -y chromium-browser   或安装 google-chrome-stable（官网 .deb）
  - Linux (Fedora):       sudo dnf install -y chromium
  - macOS:                brew install --cask google-chrome   （或 chromium）
  - Windows:              winget install Google.Chrome        （或 Microsoft.Edge）
  - 任意平台：也可 npx playwright install chromium（默认装入 ~/.cache/ms-playwright 缓存，本驱动会自动发现）
  已装但探测不到时，用 DSH_VERIFY_CHROME=/path/to/chrome（或 chromium/msedge）显式指定内核路径`;

function detectChrome() {
  const envOverride = process.env.DSH_VERIFY_CHROME;
  if (envOverride) {
    if (isFile(envOverride)) return envOverride;
    fail(`DSH_VERIFY_CHROME 指定路径不存在: ${envOverride}\n${INSTALL_GUIDE}`);
  }
  for (const cand of [...msPlaywrightCandidates(), ...pathCandidates(), ...commonPathCandidates()]) {
    if (isFile(cand)) return cand;
  }
  fail(INSTALL_GUIDE);
}

// --- launch / quit ---

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function readState(statePath) {
  if (!existsSync(statePath)) fail(`state 文件不存在: ${statePath}（请先 launch）`);
  try { return JSON.parse(readFileSync(statePath, "utf8")); }
  catch { fail(`state 文件解析失败: ${statePath}`); }
}

async function cmdLaunch(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const chromePath = flag(flags, "chrome", null);
  const userDataDir = flag(flags, "user-data-dir", null);
  const port = Number(flag(flags, "port", "0"));
  const ownedDir = !userDataDir; // 未显式指定则 mkdtemp 自建，quit 时一并清理
  const finalUserDataDir = userDataDir || mkdtempSync(join(tmpdir(), "dsh-verify-"));
  const bin = chromePath || detectChrome();

  let actualPort = port;
  if (!actualPort) actualPort = await findFreePort();

  const stderrBuf = [];
  const headlessFlags = ["--headless=new", "--headless"];
  let child = null;
  let version = null;

  for (const headless of headlessFlags) {
    const args = [
      headless, "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${actualPort}`, `--user-data-dir=${finalUserDataDir}`, "about:blank",
    ];
    stderrBuf.length = 0;
    child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.unref(); // daemon：父进程退出不等待浏览器，实例由 state 文件管理
    child.stderr.on("data", (c) => { if (stderrBuf.join("").length < 4096) stderrBuf.push(String(c)); });
    try {
      version = await waitForDebugEndpoint(actualPort, child, 15000, () => stderrBuf.join("").split("\n").slice(-8).join("\n"));
      break;
    } catch (e) {
      if (child && pidAlive(child.pid)) { try { child.kill("SIGKILL"); } catch {} }
      const headlessHint = /headless/i.test(stderrBuf.join(""));
      if (headless === "--headless=new" && headlessHint && child.exitCode !== null) continue; // 旧内核不认 =new，回退
      throw e;
    }
  }

  const state = {
    version: 1,
    pid: child.pid,
    port: actualPort,
    chromePath: bin,
    userDataDir: finalUserDataDir,
    userDataDirOwned: ownedDir,
    wsUrl: version.webSocketDebuggerUrl,
    launchedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  out(flags, { ok: true, ...state, stateFile: statePath });
}

async function waitForDebugEndpoint(port, child, timeoutMs, stderrSnapshot) {
  const deadline = Date.now() + timeoutMs;
  let stderrTail = "";
  for (;;) {
    if (child.exitCode !== null) {
      stderrTail = stderrSnapshot();
      throw new Error(`浏览器进程提前退出（exit=${child.exitCode}）\n${stderrTail}`);
    }
    try {
      const v = await httpJson(`http://127.0.0.1:${port}/json/version`, 1000);
      if (v && v.webSocketDebuggerUrl) return v;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`等待 CDP 就绪超时（${timeoutMs}ms）\n${stderrTail}`);
    await sleep(200);
  }
}

async function cmdQuit(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const st = readState(statePath);
  // 1. CDP 优雅关闭（浏览器自行释放 user-data-dir 锁）
  try {
    const v = await httpJson(`http://127.0.0.1:${st.port}/json/version`, 1500);
    if (v && v.webSocketDebuggerUrl) await rpc(v.webSocketDebuggerUrl, "Browser.close", {}, 5000);
  } catch {}
  // 2. 等进程退出，兜底 SIGTERM / SIGKILL
  if (st.pid && pidAlive(st.pid)) {
    await waitPidExit(st.pid, 5000);
    if (pidAlive(st.pid)) {
      try { process.kill(st.pid, "SIGTERM"); } catch {}
      await waitPidExit(st.pid, 3000);
      if (pidAlive(st.pid)) { try { process.kill(st.pid, "SIGKILL"); } catch {} }
    }
  }
  const exited = st.pid ? !pidAlive(st.pid) : true;
  // 3. 清理自建临时目录与 state 文件
  if (st.userDataDirOwned && st.userDataDir) { try { rmSync(st.userDataDir, { recursive: true, force: true }); } catch {} }
  try { unlinkSync(statePath); } catch {}
  out(flags, { ok: true, pid: st.pid, exited, cleaned: st.userDataDirOwned ? st.userDataDir : null, stateFile: statePath });
}

// --- 页面操作（每次调用独立连接，操作互不依赖） ---

async function connectPage(statePath, index) {
  const st = readState(statePath);
  if (!pidAlive(st.pid)) fail(`浏览器实例未运行（pid=${st.pid} 不在），请先 launch`);
  const list = await httpJson(`http://127.0.0.1:${st.port}/json/list`);
  let pages = (list || []).filter((t) => t.type === "page");
  if (pages.length === 0) {
    await rpc(st.wsUrl, "Target.createTarget", { url: "about:blank" }, 5000);
    const list2 = await httpJson(`http://127.0.0.1:${st.port}/json/list`);
    pages = (list2 || []).filter((t) => t.type === "page");
  }
  const idx = index === undefined ? 0 : index;
  const page = pages[idx];
  if (!page) fail(`无页面 target（共 ${pages.length} 个，index=${idx}）`);
  await rpc(page.webSocketDebuggerUrl, "Page.enable", {});
  await rpc(page.webSocketDebuggerUrl, "Runtime.enable", {});
  return { st, page };
}

async function evalRaw(wsUrl, expression) {
  const res = await rpc(wsUrl, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`页面执行异常: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  }
  return res.result.value;
}

async function navigateIfGiven(wsUrl, url, timeoutMs = 15000) {
  if (!url) return;
  await rpc(wsUrl, "Page.navigate", { url });
  await poll(async () => (await evalRaw(wsUrl, "document.readyState")) === "complete", timeoutMs, 200);
}

function selExpr(selector, extra) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    ${extra || "return { found: true };"}
  })()`;
}

async function waitSelector(wsUrl, selector, timeoutMs) {
  // selExpr 未命中返回 { found:false }（对象恒 truthy），poll 必须显式判 found===true，
  // 否则等待会立即「成功」（假绿，PR #481 P1-1）
  const found = await poll(async () => {
    try { return (await evalRaw(wsUrl, selExpr(selector))).found === true; }
    catch { return false; }
  }, timeoutMs, 200);
  if (!found) throw new Error(`等待选择器超时（${timeoutMs}ms）: ${selector}`);
}

async function cmdSnapshot(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const { st, page } = await connectPage(statePath, Number(flag(flags, "index", "0")));
  const url = flag(flags, "url", null);
  await navigateIfGiven(page.webSocketDebuggerUrl, url);
  const title = await evalRaw(page.webSocketDebuggerUrl, "document.title");
  const readyState = await evalRaw(page.webSocketDebuggerUrl, "document.readyState");
  const pageUrl = await evalRaw(page.webSocketDebuggerUrl, "location.href");
  const selector = flag(flags, "selector", null);
  let bodyText = null;
  let element = null;
  if (selector) {
    element = await evalRaw(page.webSocketDebuggerUrl, selExpr(selector, `
      const r = el.getBoundingClientRect();
      return { found: true, tag: el.tagName, text: (el.innerText || el.textContent || "").slice(0, 2000), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };`));
  } else {
    bodyText = (await evalRaw(page.webSocketDebuggerUrl, "document.body ? document.body.innerText.slice(0, 2000) : ''") || "");
  }
  const pages = (await httpJson(`http://127.0.0.1:${st.port}/json/list`) || []).filter((t) => t.type === "page");
  out(flags, { ok: true, title, url: pageUrl, readyState, tabCount: pages.length, bodyText, element });
}

async function cmdClick(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const { page } = await connectPage(statePath, Number(flag(flags, "index", "0")));
  const url = flag(flags, "url", null);
  const selector = flag(flags, "selector", null);
  const timeoutMs = Number(flag(flags, "timeout", "10000"));
  if (!selector) fail("click 需要 --selector");
  await navigateIfGiven(page.webSocketDebuggerUrl, url);
  await waitSelector(page.webSocketDebuggerUrl, selector, timeoutMs);
  const clicked = await evalRaw(page.webSocketDebuggerUrl, selExpr(selector, `
    el.scrollIntoView({ block: "center" });
    el.click();
    return { found: true, clicked: true, tag: el.tagName };`));
  out(flags, { ok: true, selector, clicked, url: url || undefined });
}

async function cmdEval(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const { page } = await connectPage(statePath, Number(flag(flags, "index", "0")));
  const expression = flag(flags, "expression", null);
  if (!expression) fail("eval 需要 --expression");
  const value = await evalRaw(page.webSocketDebuggerUrl, expression);
  out(flags, { ok: true, value });
}

async function cmdFill(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const { page } = await connectPage(statePath, Number(flag(flags, "index", "0")));
  const selector = flag(flags, "selector", null);
  const value = flag(flags, "value", "");
  const timeoutMs = Number(flag(flags, "timeout", "10000"));
  if (!selector) fail("fill 需要 --selector");
  await waitSelector(page.webSocketDebuggerUrl, selector, timeoutMs);
  const filled = await evalRaw(page.webSocketDebuggerUrl, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { found: true, tag, value: el.value };
  })()`);
  out(flags, { ok: true, selector, value, filled });
}

async function cmdWait(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const { page } = await connectPage(statePath, Number(flag(flags, "index", "0")));
  const url = flag(flags, "url", null);
  const selector = flag(flags, "selector", null);
  const timeoutMs = Number(flag(flags, "timeout", "10000"));
  if (!selector) fail("wait 需要 --selector");
  const started = Date.now();
  await navigateIfGiven(page.webSocketDebuggerUrl, url);
  await waitSelector(page.webSocketDebuggerUrl, selector, timeoutMs);
  out(flags, { ok: true, selector, waitedMs: Date.now() - started });
}

async function cmdScreenshot(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const { st, page } = await connectPage(statePath, Number(flag(flags, "index", "0")));
  const url = flag(flags, "url", null);
  const selector = flag(flags, "selector", null);
  const outPath = flag(flags, "path", `screenshot-${Date.now()}.png`);
  await navigateIfGiven(page.webSocketDebuggerUrl, url);
  let clip = undefined;
  if (selector) {
    await waitSelector(page.webSocketDebuggerUrl, selector, 10000);
    clip = await evalRaw(page.webSocketDebuggerUrl, selExpr(selector, `
      const r = el.getBoundingClientRect();
      return { found: true, x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 };`));
    if (!clip || !clip.found) throw new Error(`截图元素未找到: ${selector}`);
    clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.dpr };
  }
  const shot = await rpc(page.webSocketDebuggerUrl, "Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true, fromSurface: true, clip,
  });
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  const dims = clip ? { width: clip.width, height: clip.height } : null;
  out(flags, { ok: true, path: outPath, bytes: Buffer.byteLength(shot.data, "base64"), clip: dims, url: url || undefined });
}

async function cmdConsole(flags) {
  const statePath = flag(flags, "state", "browser.state");
  const { page } = await connectPage(statePath, Number(flag(flags, "index", "0")));
  const url = flag(flags, "url", null);
  const waitMs = Number(flag(flags, "wait-ms", "2500"));
  const messages = [];
  const collect = (ev) => {
    if (!ev.data || typeof ev.data !== "string") return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || m.id) return;
    if (m.method === "Runtime.consoleAPICalled") {
      const args = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type);
      messages.push({ type: m.params.type, text: args.join(" "), url: m.params.url || null, line: m.params.lineNumber ?? null });
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails || {};
      messages.push({ type: "exception", text: d.exception?.description || d.text || "未捕获异常", url: d.url || null, line: d.lineNumber ?? null });
    } else if (m.method === "Log.entryAdded") {
      const e = m.params.entry || {};
      messages.push({ type: "log", level: e.level, text: e.text, url: e.url || null, line: e.lineNumber ?? null });
    }
  };
  const ws = await openRawWs(page.webSocketDebuggerUrl, collect);
  // domain enable 是会话级状态：须在事件收集的长连接上启用，短连接 enable 不生效
  await rpcRaw(ws, "Runtime.enable", {});
  await rpcRaw(ws, "Log.enable", {});
  try {
    if (url) {
      await rpcRaw(ws, "Page.navigate", { url });
      await poll(async () => {
        try { return (await rpcRaw(ws, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true })).result.value === "complete"; }
        catch { return false; }
      }, 15000, 200);
    } else {
      await rpcRaw(ws, "Page.reload", {});
    }
  } catch {}
  await sleep(waitMs);
  ws.close();
  out(flags, { ok: true, messages, capturedMs: waitMs });
}

// console 专用：原始 WebSocket 会话（长连接收事件）
function openRawWs(wsUrl, onMessage) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("当前 Node 无全局 WebSocket（需 Node >= 22），请升级 Node"));
      return;
    }
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`WebSocket 连接失败: ${wsUrl}`));
    ws.onmessage = onMessage;
  });
}

function rpcRaw(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcRaw.nextId;
    const timer = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 15000);
    const onMsg = (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
rpcRaw.nextId = 0;

// --- 入口 ---

const USAGE = `用法: node browser-driver.mjs <command> [--flag value]... [--json] [--pretty]

命令：
  launch      启动独立浏览器实例并写入 state（--state <path> [--port N] [--user-data-dir <path>] [--chrome <path>]）
  quit        优雅关闭实例并清理（--state <path>）
  snapshot    页面快照（[--url <url>] [--selector <css>] [--index N]）
  click       点击元素（--selector <css> [--url <url>] [--timeout ms] [--index N]）
  eval        执行 JS（--expression <js> [--index N]）
  fill        填充表单（--selector <css> --value <v> [--timeout ms] [--index N]）
  wait        等待选择器（--selector <css> [--url <url>] [--timeout ms] [--index N]）
  screenshot  截图（[--url <url>] [--selector <css>] [--path <png>] [--index N]）
  console     捕获 console/异常（[--url <url>] [--wait-ms N] [--index N]）

通用：--state <path> 指定实例 state 文件（多会话并行必须各自独立）；
内核探测：DSH_VERIFY_CHROME env > ms-playwright 缓存 > PATH > 平台常见路径，全缺 fail-fast。
详情见本文件头部注释。`;

function printHelp(cmd) {
  if (!cmd) { process.stdout.write(USAGE + "\n"); return; }
  const lines = USAGE.split("\n").filter((l) => l.includes(cmd) || l.startsWith("用法") || l.startsWith("命令"));
  process.stdout.write(lines.join("\n") + "\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { process.stdout.write(USAGE + "\n"); process.exit(2); }
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === "help") { printHelp(argv[1]); process.exit(0); }
  const { flags } = parseArgs(argv.slice(1));
  if (flags.has("help")) { printHelp(first); process.exit(0); }
  const pretty = flags.has("pretty");
  try {
    switch (first) {
      case "launch": await cmdLaunch(flags); break;
      case "quit": await cmdQuit(flags); break;
      case "snapshot": await cmdSnapshot(flags); break;
      case "click": await cmdClick(flags); break;
      case "eval": await cmdEval(flags); break;
      case "fill": await cmdFill(flags); break;
      case "wait": await cmdWait(flags); break;
      case "screenshot": await cmdScreenshot(flags); break;
      case "console": await cmdConsole(flags); break;
      default: jsonOut({ ok: false, error: `未知命令: ${first}` }); process.exit(2);
    }
    // 成功路径显式退出：launch 等命令持有子进程管道句柄，不显式退出会阻塞事件循环
    process.exit(0);
  } catch (e) {
    jsonOut({ ok: false, error: e.message });
    process.exit(1);
  }
}

main();
