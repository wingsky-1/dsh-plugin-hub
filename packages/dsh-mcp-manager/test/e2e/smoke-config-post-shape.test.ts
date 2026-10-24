// dsh-mcp-manager 冒烟测试（vitest e2e project）—— config POST 经 apply 注入 settings 族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「config POST 经 apply 注入 settings」it 的
// settings stub 装配段上提为 makeSettingsStub（describe/write/update 三面，this 语义是判据本体），
// it 回调只留路由断言与写回断言。fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { apply, ROUTES } from "../../lib/index.js";
import { installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import { fakeCtx, fakeRes, type FakeReq } from "./remaining-smoke-support.ts";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

/**
 * 原 it 内 settingsStub 装配段逐字上提（#1174 shape 拆分产物）。
 * update 的 this 检查是 #125 判据本体：调用链解构丢 this → this.write undefined → 抛 TypeError → 路由 400。
 */
function makeSettingsStub(initial: Record<string, unknown>) {
  let scopeValue = initial;
  const writeNamespaces: string[] = [];
  const settingsStub = {
    // 接缝经 describe 活读（闭包读当前 scopeValue，写后读回新值）。
    describe() {
      return [{ ns: "dsh-mcp-manager", value: { ...scopeValue }, revision: 0 }];
    },
    async write(ns: string, patch: unknown) {
      writeNamespaces.push(ns);
      scopeValue = { ...(scopeValue ?? {}), ...((patch ?? {}) as Record<string, unknown>) };
    },
    update(
      this: { write: (ns: string, patch: unknown) => Promise<unknown> },
      ns: string,
      patch: unknown,
    ) {
      if (!this || typeof this.write !== "function") {
        throw new TypeError("settings.update 被以错误 this 调用（this.write undefined）");
      }
      return this.write(ns, patch);
    },
  };
  return { settingsStub, writeNamespaces, readScope: () => scopeValue };
}

it("config POST 经 apply 注入 settings：update 保留 this 不再 400（回归 #125）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-settings-"));
  const { settingsStub, writeNamespaces, readScope } = makeSettingsStub({
    ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } },
  });
  const sctx = {
    settings: settingsStub,
    effect: (fn: () => unknown) => {
      fn();
      return () => {};
    },
  };
  const ctx = fakeCtx({
    inject: (keys: unknown, cb: (s: typeof sctx) => void) => {
      if (Array.isArray(keys) && keys.includes("settings")) cb(sctx);
      return () => {};
    },
  });
  const localReq = (method: string, url: string, body?: unknown) =>
    ({
      method,
      url,
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "localhost:3080",
        origin: "http://localhost:3080",
        "sec-fetch-site": "same-origin",
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    }) as unknown as FakeReq;
  try {
    await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
    const configRoute = ctx.routes.find((route) => route.path === ROUTES.config);
    expect(configRoute, "config 路由已注册").toBeTruthy();
    const write = fakeRes();
    await configRoute!.handler(
      localReq("POST", ROUTES.config, {
        position: "bottom-right",
        offsetX: 12,
        offsetY: 20,
        blankY: 60,
      }),
      write,
    );
    expect(write.state.status, "settings.update 以正确 this 调用 → 写路由 200（不再 400）").toBe(
      200,
    );
    expect(writeNamespaces, "只向 canonical settings namespace 写入").toEqual(["dsh-mcp-manager"]);
    const written = JSON.parse(write.state.body);
    expect(written.position).toBe("bottom-right");
    expect(written.offsetX).toBe(12);
    expect(written.offsetY).toBe(20);
    expect(written.blankY).toBe(60);
    // 落盘：this 正确时 settings.update 内部 this.write 已把 Config.ui 补丁合并进 scope。
    expect(readScope().ui.offset, "settings.update 落盘（this.write 生效）").toEqual({
      x: 12,
      y: 20,
      blankY: 60,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
