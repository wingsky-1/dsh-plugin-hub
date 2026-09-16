/**
 * dsh-notifier — e2e 冒烟测试（vitest 的 e2e project）：真实端口 / 真实 SSE 连接 / 真实子进程。
 *
 * 与 unit、integration 两层分工：那两层用假宿主、假 res、假时钟探边界与分支；本层只做一件事——
 * 把组合根挂到**真实宿主**上（`@deepseek-ai/dsh-host-webserver` 的 `WebServer` 服务，它就是宿主
 * 侧 `ctx.webServer` 的实现），然后经真实 loopback socket 打真实路由、在真实连接上收真实帧、
 * 让真实子进程跑系统出口。
 *
 * 为什么不自己写一个最小宿主适配器：真实 `WebServer` 自带 bind(0) 临时端口、exact/prefix 路由表
 * 与 404 fallback，用它等于把「宿主怎么接路由」这件事的假设全部去掉；适配器只在校验「宿主职责」
 * 时才需要（比如要观察注册现场），而那是 integration 层已有的面。
 *
 * 多平台 CI 规划（本层现状与后续）：
 * - Linux：已落地。桩 `notify-send` 断言真实子进程收到的 argv 逐字 + 平台探测命中；再加一条真机
 *   用例（系统真有 `notify-send` 且 D-Bus 会话可用时真实调用一次并断言退出码，否则带 reason 跳过）。
 * - Windows：待后续 CI 矩阵。届时按 `ctx.skip(process.platform !== "win32", …)` 显式标记启用，
 *   守 `buildSystemCommand` 的 win32 分支（`powershell -NoProfile … -File <toast.ps1> -Payload <base64>`）
 *   与 `toast.ps1` 随包分发。本机没有 Windows runner，现在写就是恒 skip 的死代码。
 * - macOS：待后续 CI 矩阵。同上按 `darwin` 标记，守 `osascript -e 'display notification …'`
 *   分支与 `afplay` 自播。
 * 平台用例一律显式标记（`ctx.skip(cond, reason)`）并在用例名里写明「平台相关」，不做静默 skip
 * ——静默跳过的用例在 CI 上等于不存在。
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import WebServer from "@deepseek-ai/dsh-host-webserver";

import { dshHome } from "../../../../shared/dsh-home.js";
import type { HostCapabilities } from "../../src/server/channels/interface.ts";
import type { NotifierService } from "../../src/index.ts";
import { pollUntil, tempDshHome, withEnv } from "../helpers.ts";

/**
 * 桩 `notify-send`：系统出口先 `execFile(bin, ["--version"])` 探测、再 `spawn` 执行，两次都要落进
 * 同一个日志。PATH 前置必须在**任何一次系统出口投递之前**——平台探测在进程内只做一次
 * （`platformCapabilities` 的 promise 缓存），晚一步探到的就是系统真机那一份。
 */
const realPath = process.env.PATH ?? "";
const stubDir = mkdtempSync(join(tmpdir(), "dsh-notifier-e2e-bin-"));
const stubLog = join(stubDir, "notify-send.log");
writeFileSync(
  join(stubDir, "notify-send"),
  `#!/bin/sh\n{ echo call; for arg in "$@"; do printf 'arg\\t%s\\n' "$arg"; done; } >> '${stubLog}'\nexit 0\n`,
);
chmodSync(join(stubDir, "notify-send"), 0o755);
process.env.PATH = `${stubDir}:${realPath}`;

// DSH_HOME 必须先于被测模块求值：config / stores / stream 的单例在模块加载期就用 `notifierFile()`
// 定死了路径，顺序反了本节全部落盘就写进真实 `~/.dsh`（正在跑的 `dsh web` 的 home）。
const home = tempDshHome();
const notifier = await import("../../src/index.ts");
const apiApi = await import("../../src/server/api/interface.ts");
const sharedApi = await import("../../src/server/shared/interface.ts");
const systemApi = await import("../../src/server/channels/impl/system/index.ts");
const systemDepsApi = await import("../../src/server/channels/impl/system/deps.ts");

const storageDir = join(home.dir, "@wingsky-1", "dsh-notifier");
const configFile = sharedApi.notifierFile(sharedApi.CONFIG_FILE_NAME);
const historyFile = sharedApi.notifierFile(sharedApi.HISTORY_FILE_NAME);
const seqFile = sharedApi.notifierFile(sharedApi.SEQ_FILE_NAME);
const statusFile = sharedApi.notifierFile(sharedApi.STATUS_FILE_NAME);

/** 宿主契约冻结的 7 条端点（客户端锁定，独立抄写才守得住改路径）。 */
const ROUTE_PATHS: readonly string[] = [
  "/api/dsh-notifier/config",
  "/api/dsh-notifier/history",
  "/api/dsh-notifier/status",
  "/api/dsh-notifier/kinds",
  "/api/dsh-notifier/test",
  "/api/dsh-notifier/health",
  "/api/dsh-notifier/diagnostics",
  "/api/dsh-notifier/events",
];

/**
 * 浏览器出口开、系统出口关：HTTP 与 SSE 用例不该在开发机上弹真实系统通知，也不该让 system 通道的
 * 1 秒节流把 Linux 用例挡掉（节流状态住 dispatch 单例里，跨用例存活）。
 *
 * 关的是**渠道开关**（`enabled`），不是弹窗 / 声音键：后两者只决定出口有没有事可做，关掉它们渠道
 * 照样进池并留下一条 skipped 明细。两条内置频道的形态显式写出来，割接便不会再去改这份种子。
 */
const BROWSER_ONLY = {
  channels: [
    {
      type: "browser",
      id: "browser",
      enabled: true,
      popup: true,
      sound: false,
      whenVisible: false,
    },
    { type: "system", id: "system", enabled: false, popup: false, sound: false },
  ],
  historyMaxAgeDays: 0,
  kindRoutes: {},
} as const;

/** 系统出口单开（只弹不响）：声音关掉才不会真去 `pw-play` / `paplay` 播一遍。 */
const SYSTEM_ONLY = {
  channels: [
    {
      type: "browser",
      id: "browser",
      enabled: false,
      popup: false,
      sound: false,
      whenVisible: false,
    },
    { type: "system", id: "system", enabled: true, popup: true, sound: false },
  ],
  notifyTaskDone: true,
  historyMaxAgeDays: 0,
} as const;

/**
 * Linux 弹窗命令的期望 argv（`buildSystemCommand` 的 linux 形态，逐字）。它在等待条件与断言里
 * 各用一次：桩是先写 `call` 行、再逐行写 argv 的，日志可能停在半行上，只等「桩被碰过」会拿着
 * 半截 argv 去断言——症状是偶发红，且只在慢 runner 上出现。
 */
const LINUX_NOTIFY_ARGV: readonly string[] = [
  "-h",
  "boolean:suppress-sound:true",
  "DSH：测试通知",
  "通知链路工作正常（此通知来自测试按钮）",
];

/** 两组 argv 是否逐字相同。 */
function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

/** 写一份设置文件（组合根装配时同步读它，故必须用同步写）。 */
function seed(settings: Record<string, unknown>): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * 本用例的序号锚点（每轮 +1000）。序号是 fire-and-forget 写，递增的锚点让「这一格只可能由本轮
 * 自己的广播产生」，否则上一个用例迟到的那一笔会把判据变成偶然。
 */
let seqAnchor = 0;

function seedSeqAnchor(): void {
  seqAnchor += 1000;
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(seqFile, `${seqAnchor}\n`);
}

interface Mounted {
  readonly root: Context;
  readonly port: number;
  unmount(): Promise<void>;
}

/** 已挂载但用例没显式卸载的实例：`afterEach` 兜底收掉，免得路由与 SSE 连接漏到下一个用例。 */
let live: Mounted | null = null;

/**
 * 按宿主的真实挂载顺序装配：先起真实 WebServer 服务与 settings 服务，再 `ctx.plugin(本体)`。
 *
 * `settings` 是本插件的**显式依赖**（组合根的 `inject`），宿主保证它在装配前就绪；本层用不到存量
 * 命名空间，所以给一个没有命名空间的假服务。
 */
async function mount(): Promise<Mounted> {
  const root = new Context();
  root.provide("settings", { describe: () => [] });
  const webServer: Fiber = await root.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  // 组合根的 `inject = ["webServer", "settings"]` 由 cordis 兜住，`await()` 返回时 7 条路由已经挂上。
  const plugin: Fiber = await root.plugin(notifier);
  await plugin.await();
  const mounted: Mounted = {
    root,
    port: root.webServer.port,
    unmount: async () => {
      live = null;
      await plugin.dispose();
      await webServer.dispose();
    },
  };
  live = mounted;
  return mounted;
}

/** 服务面：组合根经 `ctx.provide` 挂在宿主上下文上的那一个（与消费方拿到的是同一个对象）。 */
function serviceOf(root: Context): NotifierService {
  const service = root.get("wingsky.notifier", false);
  if (service === undefined) throw new Error("服务面未挂上：组合根没有装配");
  return service;
}

interface HttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** 真实 loopback 请求。`headers` 可覆盖 Host —— 回环围栏的那条判据正是拿它当诱饵。 */
function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** 线上响应的解析：外部数据不受编译期约束，故先经 `unknown` 再落到期望形状。 */
function parseBody<T>(text: string): T {
  return JSON.parse(text) as unknown as T;
}

/**
 * 线协议里的一帧（`data:` 行）。`sound` 是播放决议对象而不是布尔（客户端据 `mode` 决定谁来发声）；
 * `whenVisible` 是浏览器出口的展示条件，由服务端随帧下发——客户端不查配置就能决定「可见时弹不弹」。
 */
interface SseFrame {
  readonly type: string;
  readonly seq?: number;
  readonly kind?: string;
  readonly title?: string;
  readonly message?: string;
  readonly sound?: { readonly mode: string; readonly tone?: string };
  readonly whenVisible?: boolean;
}

interface SseConnection {
  readonly raw: () => string;
  readonly frames: () => SseFrame[];
  close(): void;
}

/** 真实 SSE 客户端：拿到真实响应流，累积原文，随时可解析出已到达的帧。 */
function openSse(port: number, path: string): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    let raw = "";
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host: `127.0.0.1:${port}`, accept: "text/event-stream" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE 建连失败：HTTP ${res.statusCode}`));
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        resolve({ raw: () => raw, frames: () => framesOf(raw), close: () => req.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 已到达的帧：坏行当没到（解析失败不该让整条连接看起来断了）。 */
function framesOf(raw: string): SseFrame[] {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .flatMap((line) => {
      try {
        return [parseBody<SseFrame>(line.slice("data: ".length))];
      } catch {
        return [];
      }
    });
}

/** 历史行：只取本文件当判据的字段（整体比较会把域内文案变化变成假红）。 */
interface HistoryLine {
  kind?: string;
  channels?: ReadonlyArray<{ channelId: string; status: string }>;
}

/** 四态值域：结论取决于跑测机器，判据只能落在「落在闭集里」。 */
const VERDICTS: readonly string[] = ["ok", "degraded", "unreachable", "unknown"];

/** `/health` 的响应：能力面是**摘要**（每维度只有状态），故这里不能写 checked/players。 */
interface HealthBody {
  ok: boolean;
  plugin: string;
  platform: string;
  sseEvicts: Record<string, number>;
  capabilities: {
    host: {
      verdict: string;
      unknownDimensions: string[];
      popup: { state: string };
      sound: { state: string };
    };
  };
}

/** `/diagnostics` 的响应：完整面。 */
interface DiagnosticsBody {
  platform: string;
  capabilities: { host: HostCapabilities };
}

function historyLines(): HistoryLine[] {
  let text: string;
  try {
    text = readFileSync(historyFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [parseBody<HistoryLine>(line)];
      } catch {
        return [];
      }
    });
}

/** 桩收到的全部调用，逐次一组 argv（`--version` 探测与真通知调用分开成组）。 */
function stubCalls(): string[][] {
  let text: string;
  try {
    text = readFileSync(stubLog, "utf8");
  } catch {
    return [];
  }
  const calls: string[][] = [];
  for (const line of text.split("\n")) {
    if (line === "call") {
      calls.push([]);
      continue;
    }
    if (line.startsWith("arg\t") && calls.length > 0) calls[calls.length - 1].push(line.slice(4));
  }
  return calls;
}

/** 在指定 PATH 下跑一条命令，拿到退出码（真机用例的判据就是它）。 */
function exitCodeOf(bin: string, args: readonly string[]): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(bin, [...args], { timeout: 10_000 }, (cause) => {
      if (cause === null) {
        resolve(0);
        return;
      }
      const code: unknown = cause.code;
      resolve(typeof code === "number" ? code : null);
    });
  });
}

beforeEach(() => {
  // 单例的落盘路径跨用例不变，能重置的只有文件：不重置的话上一个用例的配置与历史就是本用例的起点。
  rmSync(historyFile, { force: true });
  rmSync(configFile, { force: true });
  rmSync(statusFile, { force: true });
  seedSeqAnchor();
  seed(BROWSER_ONLY);
});

afterEach(async () => {
  if (live !== null) await live.unmount();
  // api 域的装配标记只在它自己的 release() 走完时才复位，而用例里任何一条断言红了都会跳过补偿，
  // 后续用例就会级联红成一片。域释放幂等，这里无条件补一次。
  apiApi.releaseApi();
});

afterAll(() => {
  home.dispose();
  rmSync(stubDir, { recursive: true, force: true });
});

describe("真实 HTTP 面（真实宿主 + 真实 loopback socket）", () => {
  it("7 条端点全部挂在真实宿主上：兄弟路径 404、方法不在表里 405 并带 allow", async () => {
    const { port } = await mount();

    // 每条端点都发一次真实请求，并断言**成功**：只断「不是 404」分不出「路由挂了且能用」与
    // 「路由挂了但恒错」（实测：把 GET /status 改成恒 500，旧的 not.toBe(404) 照样绿）。
    // `/events` 常驻连接（SSE），它的「已认领」由下面 SSE 组的真实连接证明，这里不盲等它结束。
    for (const path of ROUTE_PATHS.filter((path) => path !== "/api/dsh-notifier/events")) {
      const res = await send(
        port,
        path,
        path.endsWith("/test") ? { method: "POST", body: "{}" } : {},
      );
      expect(res.status, `${path} 已被本插件认领且能正常回答`).toBe(200);
    }

    // 测试按钮的投递是 fire-and-forget 的：不等它落定，那笔迟到的归档会落进下一个用例的现场
    // （下一个用例清过历史后断言「空」，看到的就是别人的记录）。
    await pollUntil(
      () => historyLines().some((line) => line.kind === "test"),
      "测试按钮投递收尾",
      10_000,
    );

    const unknown = await send(port, "/api/dsh-notifier/nope");
    expect(unknown.status, "未注册的兄弟路径由宿主 fallback 兜成 404").toBe(404);

    const wrongMethod = await send(port, "/api/dsh-notifier/health", { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow, "405 必须带 allow：调用方不必回翻文档").toBe("GET");
    expect(parseBody<{ error: string }>(wrongMethod.body).error).toBe("method not allowed: DELETE");
  });

  it("GET /health：真实 socket 上给出插件名、宿主平台、回收计数与能力面摘要（键集不与实现分叉）", async () => {
    const { port } = await mount();
    const res = await send(port, "/api/dsh-notifier/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = parseBody<HealthBody>(res.body);
    // 键集精确：多一个少一个都说明客户端与实现分叉了。
    expect(Object.keys(body).sort()).toEqual(
      ["capabilities", "ok", "platform", "plugin", "sseEvicts"].sort(),
    );
    expect(body.ok).toBe(true);
    expect(body.plugin).toBe("dsh-notifier");
    expect(body.platform).toBe(process.platform);
    expect(body.sseEvicts).toEqual({
      close: 0,
      error: 0,
      stalled: 0,
      maxage: 0,
      destroyed: 0,
      dispose: 0,
    });
    // 能力面结论取决于跑测机器有没有桌面会话，钉死具体值只会得到一条跟环境跑的假判据；
    // 这里判值域与形状，明细面（checked/players/remediation）由 /diagnostics 的用例判。
    expect(VERDICTS).toContain(body.capabilities.host.verdict);
    expect(Array.isArray(body.capabilities.host.unknownDimensions)).toBe(true);
    expect(Object.keys(body.capabilities.host).sort()).toEqual(
      ["popup", "sound", "unknownDimensions", "verdict"].sort(),
    );
    expect(Object.keys(body.capabilities.host.popup)).toEqual(["state"]);
    expect(Object.keys(body.capabilities.host.sound)).toEqual(["state"]);
  });

  it("GET /diagnostics：完整面给的是同一份缓存结果，且一条明细都不缺", async () => {
    const { port } = await mount();
    const health = await send(port, "/api/dsh-notifier/health");
    const diagnostics = await send(port, "/api/dsh-notifier/diagnostics");
    expect(diagnostics.status).toBe(200);

    const summary = parseBody<HealthBody>(health.body).capabilities.host;
    const full = parseBody<DiagnosticsBody>(diagnostics.body).capabilities.host;
    // 两条路由共用同一次探测：结论必须一致，摘要必须是完整面的投影。
    expect(full.verdict).toBe(summary.verdict);
    expect(full.unknownDimensions).toEqual(summary.unknownDimensions);
    expect(full.popup.state).toBe(summary.popup.state);
    expect(full.sound.state).toBe(summary.sound.state);
    // 明细只在完整面上：探测了哪些维度、缺哪个包。
    expect(Array.isArray(full.popup.checked)).toBe(true);
    expect(Array.isArray(full.sound.checked)).toBe(true);
    expect(Array.isArray(full.sound.players)).toBe(true);
    expect(Array.isArray(full.remediation)).toBe(true);
    // 播放器只报可执行文件名、音色只报布尔：绝对路径正是 lan-proxy 已披露的那类泄露。
    expect(JSON.stringify(full)).not.toContain("/usr/share/sounds");
    expect(JSON.stringify(full)).not.toContain("/System/Library");
  });

  it("GET /health 的 sseEvicts 是真实计数：断开一条 SSE 后 close ≥ 1（写死的零会被这条判红）", async () => {
    const { port } = await mount();
    const connection = await openSse(port, "/api/dsh-notifier/events");
    connection.close();
    // 服务端在 socket 的 close 回调里记这一笔，是异步的；用带截止时间的轮询等它上涨。
    // 不能复用 pollUntil：它收同步谓词，传 async 函数会被当成「永远成立」而立刻返回（判据变假绿）。
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await send(port, "/api/dsh-notifier/health");
      const body = parseBody<{ sseEvicts: { close: number } }>(res.body);
      if (body.sseEvicts.close >= 1) return;
      if (Date.now() > deadline) throw new Error("客户端断开后 close 计数在 10s 内未上涨");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

  it("GET /config 与 PUT /config：视图四件套经真实 socket 往返，写入真实落盘并推进 revision", async () => {
    const { port } = await mount();

    const first = await send(port, "/api/dsh-notifier/config");
    expect(first.status).toBe(200);
    const view = parseBody<{
      ok: boolean;
      revision: number;
      writable: boolean;
      user: Record<string, unknown>;
      effective: Record<string, unknown>;
    }>(first.body);
    expect(view.ok).toBe(true);
    expect(view.writable).toBe(true);
    // 渠道形态只有 `channels` 一处表达（0.2.3 的顶层渠道键已被升级割接搬走并删除）。
    const effectiveChannels = view.effective.channels as ReadonlyArray<Record<string, unknown>>;
    const builtin = (type: string) => effectiveChannels.find((channel) => channel.type === type);
    expect(builtin("browser")?.popup, "种下的设置读得回来").toBe(true);
    expect(builtin("system")?.popup).toBe(false);

    const saved = await send(port, "/api/dsh-notifier/config", {
      method: "PUT",
      body: JSON.stringify({ patch: { historyMaxAgeDays: 5 }, expectedRevision: view.revision }),
    });
    expect(saved.status).toBe(200);
    const written = parseBody<{ ok: boolean; revision: number; user: Record<string, unknown> }>(
      saved.body,
    );
    expect(written.ok).toBe(true);
    expect(written.revision, "写入推进修订号").not.toBe(view.revision);
    expect(written.user.historyMaxAgeDays).toBe(5);
    await pollUntil(
      () => readFileSync(configFile, "utf8").includes('"historyMaxAgeDays": 5'),
      "配置写入真实落盘",
      10_000,
    );

    const conflict = await send(port, "/api/dsh-notifier/config", {
      method: "PUT",
      body: JSON.stringify({ patch: { historyMaxAgeDays: 6 }, expectedRevision: view.revision }),
    });
    expect(conflict.status).toBe(409);
    expect(parseBody<{ error: { code: string } }>(conflict.body).error.code).toBe(
      "SETTINGS_CONFLICT",
    );

    const badJson = await send(port, "/api/dsh-notifier/config", { method: "PUT", body: "{" });
    expect(badJson.status).toBe(400);
    expect(parseBody<{ error: { code: string } }>(badJson.body).error.code).toBe("invalid-json");

    const emptyPatch = await send(port, "/api/dsh-notifier/config", {
      method: "PUT",
      body: JSON.stringify({ patch: {} }),
    });
    expect(emptyPatch.status, "空 patch 是界面上的一次点击，不是一次无变化的写").toBe(400);
  });

  it("历史与状态端点读写真实落盘：POST /test 的投递归档经 GET /history 读回", async () => {
    const { port } = await mount();

    // 先经真实 DELETE 划一次界：它把此前排队的写入清干净，于是「接下来读到空」不是抢跑得来的。
    const reset = await send(port, "/api/dsh-notifier/history", { method: "DELETE" });
    expect(reset.status).toBe(200);

    const before = await send(port, "/api/dsh-notifier/history");
    expect(before.status).toBe(200);
    expect(parseBody<{ records: HistoryLine[] }>(before.body).records).toEqual([]);

    const accepted = await send(port, "/api/dsh-notifier/test", { method: "POST", body: "{}" });
    expect(accepted.status).toBe(200);
    const receipt = parseBody<{ ok: boolean; sseConnections: number }>(accepted.body);
    expect(receipt.ok).toBe(true);
    expect(receipt.sseConnections, "无连接时的句柄数").toBe(0);

    // 投递是 fire-and-forget 的，等它在磁盘上可见而不是等一个固定时长。
    await pollUntil(
      () => historyLines().some((line) => line.kind === "test"),
      "测试通知落史",
      10_000,
    );
    const listed = await send(port, "/api/dsh-notifier/history");
    const records = parseBody<{ records: HistoryLine[] }>(listed.body).records;
    expect(records).toHaveLength(1);
    expect(records[0]?.channels).toEqual([{ channelId: "browser", status: "ok" }]);

    const status = await send(port, "/api/dsh-notifier/status");
    expect(status.status).toBe(200);
    // 状态在内存镜像里随投递终态落定，而历史可见已经证明那次 dispatch 走完了（归档排在投递之后）。
    expect(
      parseBody<{ channels: Record<string, { lastStatus: string }> }>(status.body).channels.browser
        ?.lastStatus,
    ).toBe("ok");

    const cleared = await send(port, "/api/dsh-notifier/history", { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(parseBody<{ ok: boolean; removed: number }>(cleared.body)).toEqual({
      ok: true,
      removed: 1,
    });
    const after = await send(port, "/api/dsh-notifier/history");
    expect(parseBody<{ records: HistoryLine[] }>(after.body).records).toEqual([]);
  });

  it("POST /test 的畸形 body 在真实 socket 上 fail-closed：400 且一条投递都不发生", async () => {
    const { port } = await mount();

    // 先经真实 DELETE 划线：畸形请求之后历史必须仍是空的，「零副作用」才有可观察的判据。
    expect((await send(port, "/api/dsh-notifier/history", { method: "DELETE" })).status).toBe(200);

    // 真 Readable 的 async 迭代（单测那条走的是假迭代器），两种成因各走一遍。
    const malformed = await send(port, "/api/dsh-notifier/test", { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
    expect(
      parseBody<{ ok: boolean; error: { code: string; details: string } }>(malformed.body),
    ).toEqual({ ok: false, error: { code: "invalid-json", details: "请求体不是合法 JSON" } });

    const notObject = await send(port, "/api/dsh-notifier/test", { method: "POST", body: "42" });
    expect(notObject.status).toBe(400);
    expect(
      parseBody<{ error: { details: string } }>(notObject.body).error.details,
      "合法 JSON 但不是对象是另一种成因",
    ).toBe("请求体必须是 JSON 对象");

    // 「畸形」与「缺席」是两件事：没有 body 仍然按全频道测试受理。
    expect((await send(port, "/api/dsh-notifier/test", { method: "POST" })).status).toBe(200);

    await pollUntil(
      () => historyLines().some((line) => line.kind === "test"),
      "缺席 body 的那次测试通知落史",
      10_000,
    );
    const records = parseBody<{ records: HistoryLine[] }>(
      (await send(port, "/api/dsh-notifier/history")).body,
    ).records;
    expect(records, "两条畸形请求一条都不许投递").toHaveLength(1);
  });

  it("种类端点：未登记 404、参数非法 400，登记后确认并真实落进配置", async () => {
    const { root, port } = await mount();

    const listed = await send(port, "/api/dsh-notifier/kinds");
    expect(listed.status).toBe(200);
    expect(Array.isArray(parseBody<{ kinds: unknown[] }>(listed.body).kinds)).toBe(true);

    const ghost = await send(port, "/api/dsh-notifier/kinds", {
      method: "POST",
      body: JSON.stringify({ kind: "e2e:ghost", confirmed: true }),
    });
    expect(ghost.status, "未登记的 kind 一律 404（管理面不替用户放行陌生种类）").toBe(404);

    const malformed = await send(port, "/api/dsh-notifier/kinds", {
      method: "POST",
      body: JSON.stringify({ kind: "", confirmed: true }),
    });
    expect(malformed.status).toBe(400);

    serviceOf(root).registerKind({ id: "e2e:face", label: "E2E 面" });
    const afterRegister = await send(port, "/api/dsh-notifier/kinds");
    expect(
      parseBody<{ kinds: Array<{ id: string; confirmed: boolean }> }>(afterRegister.body).kinds,
    ).toContainEqual({ id: "e2e:face", label: "E2E 面", confirmed: false });

    const confirmed = await send(port, "/api/dsh-notifier/kinds", {
      method: "POST",
      body: JSON.stringify({ kind: "e2e:face", confirmed: true }),
    });
    expect(confirmed.status).toBe(200);
    expect(
      parseBody<{ kinds: Array<{ id: string; confirmed: boolean }> }>(confirmed.body).kinds,
    ).toContainEqual({ id: "e2e:face", label: "E2E 面", confirmed: true });
    await pollUntil(
      () => readFileSync(configFile, "utf8").includes("e2e:face"),
      "确认态真实落盘",
      10_000,
    );
  });

  it("回环围栏：Host 头不是回环（DNS 重绑定诱饵）与 cross-site 请求一律 403", async () => {
    const { port } = await mount();

    const rebound = await send(port, "/api/dsh-notifier/health", {
      headers: { host: "attacker.example" },
    });
    expect(rebound.status, "来源是回环但 Host 不是：D-Bus 式的诱饵必须被拒").toBe(403);
    expect(parseBody<{ error: string; code: string; status: number }>(rebound.body)).toEqual({
      error: "forbidden: loopback-only",
      code: "FORBIDDEN_LOOPBACK",
      status: 403,
    });

    const crossSite = await send(port, "/api/dsh-notifier/health", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status, "跨站默认拒绝，不猜测放行").toBe(403);

    // 对照组：同一次装配里回环 Host 放行——否则上面的 403 可能只是路由没挂。
    const ok = await send(port, "/api/dsh-notifier/health");
    expect(ok.status).toBe(200);
  });

  it("围栏拒答体的机读字段：403 与 405 各自带稳定的 code/status，error 仍是裸字符串", async () => {
    const { port } = await mount();

    const forbidden = await send(port, "/api/dsh-notifier/health", {
      headers: { host: "attacker.example" },
    });
    expect(forbidden.status).toBe(403);
    const forbiddenBody = parseBody<{ error: unknown; code: string; status: number }>(
      forbidden.body,
    );
    expect(forbiddenBody.code).toBe("FORBIDDEN_LOOPBACK");
    expect(forbiddenBody.status).toBe(403);
    // 向后兼容的关键：error 不能被升级成对象——旧客户端读失败提示的顺序是
    // 「details → error → HTTP <status>」，它识别局域网直连只认最后那条兜底里的状态码。
    expect(typeof forbiddenBody.error).toBe("string");

    const notAllowed = await send(port, "/api/dsh-notifier/health", { method: "DELETE" });
    expect(notAllowed.status).toBe(405);
    const notAllowedBody = parseBody<{ error: unknown; code: string; status: number }>(
      notAllowed.body,
    );
    expect(notAllowedBody.code).toBe("METHOD_NOT_ALLOWED");
    expect(notAllowedBody.status).toBe(405);
    expect(typeof notAllowedBody.error).toBe("string");
  });
});

describe("真实 SSE 面", () => {
  it("真实连接先收到开流锚点，投递后在真实连接上收到 notify 帧", async () => {
    const { root, port } = await mount();
    const connection = await openSse(port, "/api/dsh-notifier/events");
    try {
      // 心跳是 30 秒级，不真等：开流锚点（注释帧）就是「响应头已被立刻 flush」的可见证据
      // ——少了它客户端要等到第一个心跳才从 CONNECTING 进入 OPEN。
      await pollUntil(() => connection.raw().includes(": connected"), "开流锚点到场", 10_000);

      await serviceOf(root).send({ kind: "done", title: "端到端标题", body: "端到端正文" });
      await pollUntil(() => connection.frames().length >= 1, "帧到达真实连接", 10_000);

      expect(connection.frames()[0]).toEqual({
        type: "notify",
        seq: seqAnchor + 1,
        kind: "done",
        title: "端到端标题",
        message: "端到端正文",
        ts: expect.any(Number) as unknown as number,
        sound: { mode: "silent" },
        // 种下的浏览器条目 `whenVisible:false`：展示条件随帧下发，值就是条目里那一个。
        whenVisible: false,
      });
    } finally {
      connection.close();
    }
  });

  it("断线重连 ?since=N：只补拉序号大于 N 的帧，已确认的那条不重放", async () => {
    const { root, port } = await mount();
    const service = serviceOf(root);

    const first = await openSse(port, "/api/dsh-notifier/events");
    await service.send({ kind: "done", title: "第一帧", body: "A" });
    await pollUntil(() => first.frames().length >= 1, "第一帧到达", 10_000);
    const frameA = first.frames()[0];
    expect(frameA?.title).toBe("第一帧");
    first.close();

    // 重连带 `?since=<A 的序号>`：实现按 `seq > since` 过滤补拉缓冲。
    const second = await openSse(port, `/api/dsh-notifier/events?since=${frameA?.seq ?? 0}`);
    try {
      await pollUntil(() => second.raw().includes(": connected"), "重连锚点到场", 10_000);
      await service.send({ kind: "done", title: "第二帧", body: "B" });
      await pollUntil(
        () => second.frames().some((frame) => frame.title === "第二帧"),
        "补拉窗口之后的新帧到达",
        10_000,
      );
      // 帧在一条流上是顺序的：若 since 被忽略，A 一定排在 B 之前到达，这条判据会红。
      expect(second.frames().map((frame) => frame.title)).toEqual(["第二帧"]);
    } finally {
      second.close();
    }
  });
});

describe("Linux 系统通知（平台相关）", () => {
  it("平台相关（linux）：桩 notify-send 被探测命中，并以逐字 argv 收到通知", async (ctx) => {
    ctx.skip(process.platform !== "linux", "本用例守的是 buildSystemCommand 的 linux 分支");
    rmSync(stubLog, { force: true });
    // 本用例刚把桩日志清空，而平台探测在进程内只缓存一次：不复位缓存，`--version` 那一次就留在了
    // 前一个用例的日志窗口里，这条判据会变成「看谁先跑」（`/health` 的用例现在也会触发探测）。
    systemDepsApi.releaseSystemDeps();
    seed(SYSTEM_ONLY);
    const { port } = await mount();

    // 经真实 HTTP 面的测试按钮走同一条裁决管线，而不是直接调出口。
    const accepted = await send(port, "/api/dsh-notifier/test", {
      method: "POST",
      body: JSON.stringify({ channelId: "system" }),
    });
    expect(accepted.status).toBe(200);
    // 等的是**完整 argv**而不是「桩被碰过」：探测那一次也会写日志，而通知那一次是先写 `call` 行
    // 再逐行写 argv 的，只等前者会拿着半截 argv 去断言。
    await pollUntil(
      () => stubCalls().some((call) => sameArgv(call, LINUX_NOTIFY_ARGV)),
      "桩收到完整的通知 argv",
      15_000,
    );

    // 「--version 探测」只有非 darwin/win32 那一支才会发生，它同时是「探测命中」与「走了 Linux 分支」
    // 的证据；探测在进程内只缓存一次，故断言的是日志里存在过而不是它是第 0 次。
    expect(stubCalls()).toContainEqual(["--version"]);
    // argv 逐字：`-h boolean:suppress-sound:true <title> <body>`（DE 的 sound hint 不可依赖，
    // 发声一律由出口自播承担，故恒带 suppress-sound）。
    expect(stubCalls()).toContainEqual([...LINUX_NOTIFY_ARGV]);
  });

  it("平台相关（linux 真机）：真实 notify-send 且 D-Bus 会话可用时真实调用一次并断言退出码", async (ctx) => {
    ctx.skip(process.platform !== "linux", "非 Linux 平台没有 notify-send 这一支");

    // PATH 先还原成系统的那一份：上面的桩只会让这条用例假绿。
    const restore = withEnv({ PATH: realPath });
    try {
      const probe = await systemApi.probePlatform(sharedApi.toastScriptPath());
      ctx.skip(!probe.notifySendAvailable, "系统 PATH 里没有真实 notify-send");
      const command = systemApi.buildSystemCommand(probe, "DSH：真机冒烟", "平台相关用例", {
        sound: false,
        selfPlay: false,
        toastScript: sharedApi.toastScriptPath(),
      });
      ctx.skip(command.length === 0, "本平台给不出系统通知命令（notify-send 探测未命中）");
      // D-Bus 会话不可用时 notify-send 必然非零退出，那测到的是环境而不是本插件，故显式跳过并写明原因。
      const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
      const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
      const sessionBus =
        busAddress !== "" || (runtimeDir !== "" && existsSync(join(runtimeDir, "bus")));
      ctx.skip(
        !sessionBus,
        "D-Bus 会话不可用（无 DBUS_SESSION_BUS_ADDRESS 且无 $XDG_RUNTIME_DIR/bus）",
      );

      expect(command[0]).toBe("notify-send");
      // 真实调用一次：退出码 0 就是这次系统通知真的发出去了。
      const code = await exitCodeOf(command[0], command.slice(1));
      expect(code, `真实 notify-send 退出码（argv: ${command.join(" ")}）`).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("落盘隔离", () => {
  it("本次 run 的全部产物都住进临时 DSH_HOME，包私有目录里只有契约约定的五个文件", async () => {
    const { port } = await mount();
    await send(port, "/api/dsh-notifier/test", { method: "POST", body: "{}" });
    await pollUntil(() => historyLines().some((line) => line.kind === "test"), "历史落盘", 10_000);

    // 路径同源：单例的落盘位置全部由同一个 DSH_HOME 拼出来，而它指向本文件独占的临时目录。
    expect(dshHome()).toBe(home.dir);
    expect(historyFile.startsWith(home.dir)).toBe(true);
    expect(configFile.startsWith(home.dir)).toBe(true);
    expect(seqFile.startsWith(home.dir)).toBe(true);

    // 原子写会先落一个同目录临时文件，status 的防抖落盘可能正在飞：那是实现的中间物，剔掉再比对。
    await pollUntil(
      () =>
        readdirSync(storageDir)
          .filter((name) => !name.includes(".tmp-"))
          .sort()
          .join(",") ===
        [
          sharedApi.CONFIG_FILE_NAME,
          sharedApi.HISTORY_FILE_NAME,
          sharedApi.SEQ_FILE_NAME,
          sharedApi.STATUS_FILE_NAME,
          sharedApi.VERSION_FILE_NAME,
        ]
          .sort()
          .join(","),
      "五个存储文件齐备且没有多出来的产物",
      10_000,
    );
  });
});
