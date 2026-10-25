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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, expect } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import WebServer from "@deepseek-ai/dsh-host-webserver";

import type { HostCapabilities } from "../../src/server/channels/interface.ts";
import type { NotifierService } from "../../src/index.ts";
import { tempDshHome } from "../helpers.ts";

/**
 * 桩 `notify-send`：系统出口先 `execFile(bin, ["--version"])` 探测、再 `spawn` 执行，两次都要落进
 * 同一个日志。PATH 前置必须在**任何一次系统出口投递之前**——平台探测在进程内只做一次
 * （`platformCapabilities` 的 promise 缓存），晚一步探到的就是系统真机那一份。
 */
export const realPath = process.env.PATH ?? "";
export const stubDir = mkdtempSync(join(tmpdir(), "dsh-notifier-e2e-bin-"));
export const stubLog = join(stubDir, "notify-send.log");
writeFileSync(
  join(stubDir, "notify-send"),
  `#!/bin/sh\n{ echo call; for arg in "$@"; do printf 'arg\\t%s\\n' "$arg"; done; } >> '${stubLog}'\nexit 0\n`,
);
chmodSync(join(stubDir, "notify-send"), 0o755);
process.env.PATH = `${stubDir}:${realPath}`;

// DSH_HOME 必须先于被测模块求值：config / stores / stream 的单例在模块加载期就用 `notifierFile()`
// 定死了路径，顺序反了本节全部落盘就写进真实 `~/.dsh`（正在跑的 `dsh web` 的 home）。
export const home = tempDshHome();
const notifier = await import("../../src/index.ts");
const apiApi = await import("../../src/server/api/interface.ts");
export const sharedApi = await import("../../src/server/shared/interface.ts");
export const systemApi = await import("../../src/server/channels/impl/system/index.ts");
export const systemDepsApi = await import("../../src/server/channels/impl/system/deps.ts");

export const storageDir = join(home.dir, "@wingsky-1", "dsh-notifier");
export const configFile = sharedApi.notifierFile(sharedApi.CONFIG_FILE_NAME);
export const historyFile = sharedApi.notifierFile(sharedApi.HISTORY_FILE_NAME);
export const seqFile = sharedApi.notifierFile(sharedApi.SEQ_FILE_NAME);
const statusFile = sharedApi.notifierFile(sharedApi.STATUS_FILE_NAME);

/** 宿主契约冻结的 7 条端点（客户端锁定，独立抄写才守得住改路径）。 */
export const ROUTE_PATHS: readonly string[] = [
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
export const SYSTEM_ONLY = {
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

/** 系统出口单开（弹窗 + 指定音色）：真实链路上自播需要声音，冒烟环境无播放器即 ok + 警告。 */
export const SYSTEM_SOUND = {
  channels: [
    {
      type: "browser",
      id: "browser",
      enabled: false,
      popup: false,
      sound: false,
      whenVisible: false,
    },
    { type: "system", id: "system", enabled: true, popup: true, sound: "ding" },
  ],
  notifyTaskDone: true,
  historyMaxAgeDays: 0,
} as const;

/**
 * Linux 弹窗命令的期望 argv（`buildSystemCommand` 的 linux 形态，逐字）。它在等待条件与断言里
 * 各用一次：桩是先写 `call` 行、再逐行写 argv 的，日志可能停在半行上，只等「桩被碰过」会拿着
 * 半截 argv 去断言——症状是偶发红，且只在慢 runner 上出现。
 */
export const LINUX_NOTIFY_ARGV: readonly string[] = [
  "-h",
  "boolean:suppress-sound:true",
  "DSH：测试通知",
  "通知链路工作正常（此通知来自测试按钮）",
];

/** 两组 argv 是否逐字相同。 */
export function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

/** 写一份设置文件（组合根装配时同步读它，故必须用同步写）。 */
export function seed(settings: Record<string, unknown>): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * 本用例的序号锚点（每轮 +1000）。序号是 fire-and-forget 写，递增的锚点让「这一格只可能由本轮
 * 自己的广播产生」，否则上一个用例迟到的那一笔会把判据变成偶然。
 */
export let seqAnchor = 0;

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
export async function mount(): Promise<Mounted> {
  const root = new Context();
  root.provide("settings", { describe: () => [] });
  const webServer: Fiber = await root.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  // 组合根的 `inject = ["webServer", "settings"]` 由 cordis 兜住，`await()` 返回时 7 条路由已经挂上。
  const plugin: Fiber = await root.plugin(notifier);
  await plugin.await();
  // dsh-host-webserver 0.2.1-rc.2 起 `port` 类型收窄为 `number | undefined`（listen 绑定前为
  // undefined）。这里 WebServer 已起并 listen 完（bind(0)），先显式收窄再断言正整数，
  // 断言强度不减（undefined 必判红）。
  const port = root.webServer.port;
  expect(port).not.toBeUndefined();
  if (port === undefined) throw new Error("webServer.port 在 listen 后仍为 undefined");
  expect(Number.isInteger(port) && port > 0).toBe(true);
  const mounted: Mounted = {
    root,
    port,
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
export function serviceOf(root: Context): NotifierService {
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
export function send(
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
export function parseBody<T>(text: string): T {
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
export function openSse(port: number, path: string): Promise<SseConnection> {
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
export interface HistoryLine {
  kind?: string;
  ts?: number;
  channels?: ReadonlyArray<{
    channelId: string;
    status: string;
    soundWarning?: { code: string; params?: Record<string, string | number>; detail?: string };
  }>;
}

/** 四态值域：结论取决于跑测机器，判据只能落在「落在闭集里」。 */
export const VERDICTS: readonly string[] = ["ok", "degraded", "unreachable", "unknown"];

/** `/health` 的响应：能力面是**摘要**（每维度只有状态），故这里不能写 checked/players。 */
export interface HealthBody {
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
export interface DiagnosticsBody {
  platform: string;
  capabilities: { host: HostCapabilities };
}

export function historyLines(): HistoryLine[] {
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
export function stubCalls(): string[][] {
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
export function exitCodeOf(bin: string, args: readonly string[]): Promise<number | null> {
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
