// dsh-lan-proxy e2e：host trust 注入 —— 真 cordis Context + 官方 WebServer 整链（issue #856）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出为独立场景文件。断言与 describe 名逐字保留。
// 真 socket / 真服务面只在 e2e（不进变异面）；「覆盖 vs 不覆盖」等杀灭力留在
// test/unit/host-trust.test.ts。这里验证的是装配链本身：官方 renderIndex
// （结构化注入表 → tapIndex 变换）把注入送到 head 内的正确位置。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import WebServer from "@deepseek-ai/dsh-host-webserver";
import { apply } from "../../lib/index.js";

// client 契约产物（marker 宿主一致性判据需要 lib/client.js 的字面量）。
const clientCode = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");

describe("host trust 注入：真 Context + WebServer 整链（issue #856）", () => {
  // 与 dsh-web-frontend/dist/index.html 同形（module 入口在 head 内）。
  const INDEX_HTML = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    "    <title>DeepSeek Harness</title>",
    '    <script type="module" crossorigin src="./assets/index-abc.js"></script>',
    "  </head>",
    "  <body>",
    '    <div id="root"></div>',
    "  </body>",
    "</html>",
  ].join("\n");
  const HOST_TRUST_SCRIPT_OPEN = '<script id="__dshLanProxyHostTrust__">';

  let home = "";
  let prevHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-host-trust-e2e-"));
    prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
  });

  afterAll(() => {
    process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** 起真实宿主（bind(0)）→ 挂本插件 → 走官方 renderIndex，返回渲染结果与端口。 */
  async function renderWithPlugin(config: Record<string, unknown>) {
    const root = new Context();
    const server = await root.plugin(WebServer, { host: "127.0.0.1", port: 0 });
    const fiber = await root.plugin(
      {
        name: "lan-proxy",
        inject: ["webServer"],
        apply: (ctx: Context, cfg: Record<string, unknown>) =>
          apply(ctx, cfg as unknown as Parameters<typeof apply>[1]),
      },
      config,
    );
    await fiber.await();
    // 渲染失败也必须回收真实监听句柄（#690 S2c：未回收的 socket 会让整包挂到超时判红）。
    try {
      return { rendered: root.webServer.renderIndex(INDEX_HTML), port: root.webServer.port };
    } finally {
      await fiber.dispose();
      await server.dispose();
    }
  }

  it("开关开启：注入在 head 内且在 boot-readiness 尾脚本之前（真实 bind(0) 端口）", async () => {
    const { rendered, port } = await renderWithPlugin({
      enabled: false,
      httpsEnabled: false,
      printBanner: false,
      ownsHostCompat: true,
    });
    const at = rendered.indexOf(HOST_TRUST_SCRIPT_OPEN);
    // dsh-host-webserver 0.2.1-rc.2 起 `port` 类型收窄为 `number | undefined`（listen 绑定前为
    // undefined）。这里已 attach 并 listen 完（bind(0)），先显式收窄再断言正整数，
    // 断言强度与原 `Number.isInteger(port) && port > 0` 等价（undefined 必判红）。
    expect(port).not.toBeUndefined();
    if (port === undefined) throw new Error("webServer.port 在 listen 后仍为 undefined");
    expect(Number.isInteger(port) && port > 0).toBe(true);
    expect(rendered.indexOf("__DSH_BOOT_READY__")).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(rendered.indexOf("<head>"));
    expect(at).toBeLessThan(rendered.indexOf("</head>"));
    expect(at).toBeLessThan(rendered.indexOf("__DSH_BOOT_READY__"));
    // marker 宿客一致性（P1-2）：两侧都从**产物**派生，不导入常量——该常量已退出包导出面
    // （符号不属安装面 / 配置面 / 契约面），而「宿主注入脚本写什么」与「客户端观测器读什么」
    // 的真实承载面本来就是产物文本：marker 从 lib/client.js 的赋值语句里正则取出，再断言
    // 宿主渲染出的注入脚本写的是同一个全局键。任一侧改名/改值（或客户端产物不再带该 marker），
    // 这两条各自转红；比导入同一个常量更强。
    const clientMarker = /HOST_TRUST_RUNTIME_MARKER = "([^"]+)"/.exec(clientCode)?.[1];
    expect(typeof clientMarker).toBe("string");
    expect(rendered.includes(`globalThis.${clientMarker} = true`)).toBe(true);
  });

  it("开关关闭：同一链路不注入（插件确实挂着——polyfill 仍在）", async () => {
    const { rendered } = await renderWithPlugin({
      enabled: false,
      httpsEnabled: false,
      printBanner: false,
      ownsHostCompat: false,
    });
    expect(rendered.includes(HOST_TRUST_SCRIPT_OPEN)).toBe(false);
    expect(rendered.includes("__dshRandomUuidPolyfill__")).toBe(true);
  });
});

// Node 24 全局 agent 默认 keep-alive，销毁它让事件循环干净退出。
afterAll(async () => {
  const { globalAgent } = await import("node:http");
  globalAgent.destroy();
});
