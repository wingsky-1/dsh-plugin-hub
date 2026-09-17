/**
 * dsh-lan-proxy — apply 的 launch token 提供者接线（src/server/apply.ts:118-173）。
 *
 * integration 层（ARCHITECTURE-METHOD §8）：真实 cordis 生命周期（fake ctx）+ 真实
 * 转发器 + fake 官方 connection 服务，锁住两段此前只在纯函数层或产物层有备份的接线：
 * 「connection.authenticatedUrl → token」的来源（createLanProxy 层的注入判据只证明
 * 「拿到 token 之后怎么用」，证明不了「token 从哪来」），以及「带 dsh 会话 cookie 的
 * 请求绝不注入 token」的排除分支（src/server/proxy/impl/proxy.ts 的 !hasDshAuthCookie）。
 * unit 层覆盖的是纯谓词 hasDshAuthCookie 与 withLaunchToken，e2e 覆盖组合语义但那是
 * 产物层、不进变异面——本层补的正是源码层的组合判据。
 *
 * 观测面：真实转发一次，看 fake 上游收到的 req.url。转发器端口不写死——apply 不返回
 * 句柄，故捕获其原生 console 出口的 `listening http://host:PORT` 行回读端口（apply
 * 用原生 console 而非 cordis logger，见 apply.ts:37-41），配 listen(0) 动态分配，避免
 * 固定端口在并发/残留进程下的 EADDRINUSE 假阳性。
 */
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from "vitest";

import { apply } from "../../src/server/apply.ts";

type LogEntry = { level: "info" | "warn"; text: string };
type Scenario = {
  home: string;
  upstreamUrls: string[];
  logs: LogEntry[];
  get: (headers?: Record<string, string>) => Promise<{ status: number | undefined; body: string }>;
  stop: () => Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 诊断输出：这一层的失败模式（端口占用、证书、上游连接）根因大多只出现在被测代码的
 *  console 输出里，失败时必须把它打出来，而不是只留一句「未在 8s 内启动转发器」。 */
const dumpLogs = (logs: LogEntry[]): string =>
  logs.length === 0 ? "（空）" : logs.map((l) => `[${l.level}] ${l.text}`).join("\n");

/**
 * 起一套 apply + 真实转发器 + fake 上游；connectionValue 即 inject 回调收到的服务。
 * config 覆盖 apply 的组合层配置（横幅用例靠它切 ownsHostCompat；缺省即插件默认态）。
 */
async function startScenario(
  connectionValue: unknown,
  config: Record<string, unknown> = {},
): Promise<Scenario> {
  const home = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-token-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const upstreamUrls: string[] = [];
  const upstream = createServer((req, res) => {
    upstreamUrls.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));

  const logs: LogEntry[] = [];
  // vi.spyOn 而非裸赋值：裸赋值会盖住 vitest 自己的 per-test console 捕获（失败时看不到
  // 被测代码的原始输出），且手工还原容易漏——isolate: true 只保证不外溢，不保证会还。
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push({ level: "info", text: a.join(" ") });
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    logs.push({ level: "warn", text: a.join(" ") });
  });

  const disposers: Array<() => void> = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: {
      port: (upstream.address() as AddressInfo).port,
      register: () => () => {},
      tapIndex: () => () => {},
    },
    inject(services: string[], fn: (c: unknown) => void) {
      if (services.includes("connection")) {
        fn({ connection: connectionValue, effect: (f: () => unknown) => f() });
      }
    },
    effect(fn: () => unknown) {
      const d = fn();
      if (typeof d === "function") disposers.push(d as () => void);
      return d;
    },
  };

  const stop = async (): Promise<void> => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {}
    }
    await new Promise<void>((r) => upstream.close(() => r()));
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  };

  try {
    apply(ctx as unknown as Parameters<typeof apply>[0], {
      host: "127.0.0.1",
      port: 0,
      httpsEnabled: false,
      httpsPort: 0,
      enabled: true,
      ...config,
    });
    // 端口回读用轮询而非固定 sleep（防 flake 纪律）。
    const deadline = Date.now() + 8000;
    let listeningLine: string | undefined;
    while (Date.now() < deadline) {
      listeningLine = logs.find((l) => l.text.includes("listening http://"))?.text;
      if (listeningLine !== undefined) break;
      await sleep(20);
    }
    // 两种失败必须分开报：没起来（超时）与起来了但解析不出端口，修复方向完全不同。
    if (listeningLine === undefined) {
      throw new Error(
        `apply 未在 8s 内启动转发器（没有出现 listening 日志）。捕获到的 console 输出：\n${dumpLogs(logs)}`,
      );
    }
    const captured = /listening http:\/\/[^:]+:(\d+)/.exec(listeningLine)?.[1];
    const httpPort = captured === undefined ? Number.NaN : Number(captured);
    if (Number.isNaN(httpPort)) {
      throw new Error(
        `apply 打了 listening 日志但端口解析失败（期望 listening http://host:PORT）：${listeningLine}\n完整输出：\n${dumpLogs(logs)}`,
      );
    }
    const port = httpPort;
    return {
      home,
      upstreamUrls,
      logs,
      get: (headers: Record<string, string> = {}) =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: "127.0.0.1",
              port,
              path: "/",
              method: "GET",
              headers: { host: "127.0.0.1:3081", ...headers },
            },
            (r) => {
              let body = "";
              r.on("data", (c) => (body += c));
              r.on("end", () => resolve({ status: r.statusCode, body }));
            },
          );
          req.on("error", reject);
          req.end();
        }),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

describe("apply HTTPS 开关", () => {
  it("禁用 HTTPS 时不准备证书，HTTP 转发仍可用", async () => {
    const scenario = await startScenario({}, { httpsEnabled: false });
    try {
      expect(await scenario.get()).toEqual({ status: 200, body: "ok" });
      // HTTP ready 在 TLS 准备和 listen 完成之后；这里不靠等待时长证明没有落盘。
      expect(
        readdirSync(scenario.home, { recursive: true }).filter((name) =>
          /\.pem$/.test(String(name)),
        ),
      ).toEqual([]);
      expect(scenario.logs.filter((entry) => entry.text.includes("https https://"))).toEqual([]);
    } finally {
      await scenario.stop();
    }
  });

  it("启用 HTTPS 时通过 TLS 连接真实转发到上游", async () => {
    const scenario = await startScenario({}, { httpsEnabled: true });
    try {
      const line = scenario.logs.find((entry) => entry.text.includes("https https://"))?.text;
      expect(line).toBeDefined();
      const portText = /https https:\/\/[^:]+:(\d+)/.exec(line ?? "")?.[1];
      if (portText === undefined) throw new Error("HTTPS ready 未给出监听端口");
      const response = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          // 仅信任本场景自动生成的自签证书；真实握手及响应仍由 Node HTTPS 执行。
          const req = httpsRequest(
            {
              hostname: "127.0.0.1",
              port: Number(portText),
              path: "/",
              ca: readFileSync(join(scenario.home, "lan-proxy", "dsh-lan-proxy-cert.pem")),
              agent: false,
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => {
                body += chunk;
              });
              res.on("error", reject);
              res.on("end", () => resolve({ status: res.statusCode, body }));
            },
          );
          req.setTimeout(5000, () => req.destroy(new Error("HTTPS 请求超时")));
          req.on("error", reject);
          req.end();
        },
      );
      expect(response).toEqual({ status: 200, body: "ok" });
      expect(scenario.upstreamUrls).toEqual(["/"]);
    } finally {
      await scenario.stop();
    }
  });
});

type ScenarioSpec = {
  label: string;
  title: string;
  connection: unknown;
  expectedUrl: string;
  /** 请求头；cookie 排除场景靠它带 dsh 会话 cookie。 */
  headers?: Record<string, string>;
};

const NO_COOKIE_TITLE = "无会话 cookie 的 GET / 到达上游时的 URL 符合接线预期";

const SCENARIOS: ScenarioSpec[] = [
  {
    label: "authenticatedUrl 返回带 token 的 URL → 上游收到该 token",
    title: NO_COOKIE_TITLE,
    connection: { authenticatedUrl: () => "http://lan-proxy.local/?token=minted-826" },
    expectedUrl: "/?token=minted-826",
  },
  {
    label: "authenticatedUrl 返回不带 token 的 URL → 不注入",
    title: NO_COOKIE_TITLE,
    connection: { authenticatedUrl: () => "http://lan-proxy.local/" },
    expectedUrl: "/",
  },
  {
    label: "authenticatedUrl 抛异常 → 降级为不注入",
    title: NO_COOKIE_TITLE,
    connection: {
      authenticatedUrl: () => {
        throw new Error("connection boom");
      },
    },
    expectedUrl: "/",
  },
  {
    label: "connection 服务缺少 authenticatedUrl → 不注入",
    title: NO_COOKIE_TITLE,
    connection: { rpc: {} },
    expectedUrl: "/",
  },
  {
    // 排除分支（proxy.ts 的 !hasDshAuthCookie）在源码层此前无备份：unit 只测纯谓词，
    // e2e 测组合语义但 e2e 是产物层且不进变异面。取反本分支即可打红这一条。
    label: "带 dsh 会话 cookie → 绝不注入 token（防有效 cookie 无限 303）",
    title: "带 dsh 会话 cookie 的 GET / 到达上游时未被注入 token",
    connection: { authenticatedUrl: () => "http://lan-proxy.local/?token=minted-826" },
    expectedUrl: "/",
    headers: { cookie: "dsh-auth-web=still-valid" },
  },
];

// ownsHostCompat 状态行（P2-1）：这条横幅此前无任何断言，CI 变异日志里留下存活体。
// 默认态与开启态各断言一次——两者是横幅里唯一把这个开关讲给操作者的地方（故障态下
// 设置卡片不挂载，见 README 安全模型的「已知限制」）。
describe("integration: 启动横幅的 ownsHostCompat 状态行", () => {
  const bannerScenario = { rpc: {} };
  let offScenario: Scenario | undefined;
  let onScenario: Scenario | undefined;

  beforeAll(async () => {
    offScenario = await startScenario(bannerScenario);
    onScenario = await startScenario(bannerScenario, { ownsHostCompat: true });
  }, 60_000);

  afterAll(async () => {
    if (offScenario !== undefined) await offScenario.stop();
    if (onScenario !== undefined) await onScenario.stop();
  });

  it("默认态横幅含 ownsHostCompat: OFF", () => {
    const current = offScenario;
    if (current === undefined) throw new Error("scenario 未建立");
    expect(current.logs.some((l) => l.text.includes("ownsHostCompat: OFF"))).toBe(true);
  });

  it("ownsHostCompat: true 时横幅含 ownsHostCompat: ON", () => {
    const current = onScenario;
    if (current === undefined) throw new Error("scenario 未建立");
    expect(current.logs.some((l) => l.text.includes("ownsHostCompat: ON"))).toBe(true);
  });
});

for (const sc of SCENARIOS) {
  describe(`integration: apply launch token 提供者 — ${sc.label}`, () => {
    let scenario: Scenario | undefined;
    beforeAll(async () => {
      scenario = await startScenario(sc.connection);
    }, 30_000);
    afterAll(async () => {
      if (scenario !== undefined) await scenario.stop();
    });
    it(sc.title, async () => {
      const current = scenario;
      if (current === undefined) throw new Error("scenario 未建立");
      // 断言失败时把被测代码的 console 输出打出来（onTestFailed 只能在测试体内注册；
      // 此时 console 仍被 spy 着，而 console.error 不在 spy 面内，能直达失败输出）。
      onTestFailed(() => {
        console.error(`[scenario 捕获的 console 输出]\n${dumpLogs(current.logs)}`);
      });
      const res = await current.get(sc.headers);
      expect(res.status).toBe(200);
      // body 此前只被收集、从未断言；fake 上游恒定回 "ok"，这条断言覆盖「响应体真的
      // 从上游原样穿过转发层」这一段（不再留装饰性数据）。
      expect(res.body).toBe("ok");
      expect(current.upstreamUrls.at(-1)).toBe(sc.expectedUrl);
    });
  });
}
