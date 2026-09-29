/**
 * dsh-mcp-manager — unit：写边界凭据策略门（#770-2 环境净化，B 相）。
 *
 * 覆盖：
 * - isSecretEnvName 精确判定：MONKEY / TURKEY_SIZE / KEYBOARD / AUTHOR_NAME 放行
 *   （子串误伤回归锁死），MY_TOKEN / MY_SECRET / Authorization 命中，DSH_HOME 豁免；
 * - assertEnvPolicy 双审：非秘密槽位携带 ${SECRET} 引用拦截（set/unset 皆拦），
 *   展开值与活秘密逐字相同拦截（文案含键名与改法，不含字面量）；文档示例形态
 *   （CONTEXT7_API_KEY 同名模板、Authorization Bearer 模板、空值继承）放行；
 * - B 门扩面：url（仅 userinfo/查询值活值 + 引用污染）与 args（整值/等号后段活值 +
 *   引用污染）同口径，精确匹配防误伤（host/path/子串不审）；
 * - R5：MYAPIKEY 粘连名判否（宁漏不误伤，防词表膨胀静默翻转）；
 * - 三入口一致：manager.add / manager.update 拒绝污染配置且不落盘，
 *   POST /import/json 同门 400；normalize / fromClaudeEntry / parseClaudeJson 保持纯映射不拦截；
 * - 既有回归：L3 式明文（非活秘密）经 add 照常 201 落盘。
 *
 * 接线：真 McpManager + 真 configModel 端口（installAll 实装）——端口 Pick 缺 assertEnvPolicy
 * 即在此文件内爆（装配对账之外再加一道活接线）。manager 侧用 enabled:false 跳过 start 连接面；
 * 凭据全为虚构测试串；落盘仅进 mkdtempSync 隔离目录；注入快照为主，仅两处显式读写 process.env
 * （缺省快照接线证明），键名前缀 DSH_770_B2_ 隔离，try/finally 还原。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  fromClaudeEntry,
  normalizeServer,
  parseClaudeJson,
} from "../../src/server/config/interface.ts";
import {
  assertEnvPolicy,
  extractEnvRefs,
  isSecretEnvName,
} from "../../src/server/config/impl/env/policy.ts";
import type { RoutesManager } from "../../src/server/connection/interface.ts";
import * as configModelApi from "../../src/server/config/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as configStoreApi from "../../src/server/store/interface.ts";
import * as statsApi from "../../src/server/stats/interface.ts";
import * as workspaceApi from "../../src/server/workspace/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";
import {
  installOrchestrator,
  releaseOrchestrator,
  McpManager,
} from "../../src/server/connection/orchestrator/interface.ts";
import { installApi, releaseApi, makeRoutes, ROUTES } from "../../src/server/api/interface.ts";
import { callHandler, fakeManagerCtx } from "../helpers.ts";

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  try {
    releaseOrchestrator();
  } catch {}
  try {
    releaseApi();
  } catch {}
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function installAll(): void {
  installOrchestrator({
    catalog: catalogApi,
    configModel: configModelApi,
    configStore: configStoreApi,
    runtime: {} as never,
    lifecycle: {} as never,
    pipeline: pipelineApi,
    stats: statsApi,
    workspace: {} as never,
    upgrade: {} as never,
  });
  installApi({ workspace: workspaceApi, configModel: configModelApi });
}

function emptyManager(): InstanceType<typeof McpManager> {
  const dir = makeTempDir("dsh-mcp-b2-");
  const store = new McpStore(join(dir, "global.json"));
  store.data = { version: 1, servers: [] } as unknown as McpStore["data"];
  return new McpManager(fakeManagerCtx(), store as never) as InstanceType<typeof McpManager>;
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  return {
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
    on: () => {},
  } as unknown as IncomingMessage;
}

describe("isSecretEnvName 精确判定", () => {
  it("子串误伤回归：MONKEY / TURKEY_SIZE / KEYBOARD / AUTHOR_NAME 放行", () => {
    for (const name of ["MONKEY", "TURKEY_SIZE", "KEYBOARD", "AUTHOR_NAME", "TURKEY", "TURKEY2"]) {
      expect(isSecretEnvName(name), `${name} 不得判凭据形`).toBe(false);
    }
  });

  it("命中：MY_TOKEN / MY_SECRET / GITHUB_TOKEN / CONTEXT7_API_KEY / Authorization", () => {
    for (const name of [
      "MY_TOKEN",
      "MY_SECRET",
      "TOKEN",
      "SECRET",
      "KEY",
      "GITHUB_TOKEN",
      "CONTEXT7_API_KEY",
      "Authorization",
      "authorization",
      "AWS_CREDENTIALS",
      "API_KEYS",
      "TOKEN2",
      "X-PASSWD",
      "my-auth-token",
    ]) {
      expect(isSecretEnvName(name), `${name} 须判凭据形`).toBe(true);
    }
  });

  it("R5：MYAPIKEY 无分隔符粘连仍判否（宁漏不误伤，防词表膨胀静默翻转）", () => {
    // policy.ts 注释写明取精确性：MYAPIKEY 切词切不开，与 APIKEY 全等不等；
    // 若未来有人把 MYAPIKEY 收进词表，此断言变红即显式复核点。
    expect(isSecretEnvName("MYAPIKEY")).toBe(false);
  });

  it("豁免：DSH_HOME 大小写皆放行；正当名 DEBUG / PATH 放行；非字符串/空串判否", () => {
    expect(isSecretEnvName("DSH_HOME")).toBe(false);
    expect(isSecretEnvName("dsh_home")).toBe(false);
    expect(isSecretEnvName("DEBUG")).toBe(false);
    expect(isSecretEnvName("PATH")).toBe(false);
    expect(isSecretEnvName("")).toBe(false);
    expect(isSecretEnvName(undefined)).toBe(false);
    expect(isSecretEnvName(42)).toBe(false);
  });
});

describe("extractEnvRefs 口径", () => {
  it("抽取 ${VAR} 引用；非法变量名不同 expandEnv 一样不认；非字符串给空", () => {
    expect(extractEnvRefs("a${MY_TOKEN}b${X}")).toEqual(["MY_TOKEN", "X"]);
    expect(extractEnvRefs("${1BAD}")).toEqual([]);
    expect(extractEnvRefs("plain")).toEqual([]);
    expect(extractEnvRefs(42)).toEqual([]);
    expect(extractEnvRefs(undefined)).toEqual([]);
  });
});

describe("assertEnvPolicy 双审（注入快照）", () => {
  const SNAP = {
    DSH_770_B2_TOKEN: "b2-live-token-9f3",
    DSH_770_B2_SECRET: "b2-live-secret-7q1",
    DSH_HOME: "/home/u/.dsh",
    TURKEY_SIZE: "big-bird",
    OTHER_PLAIN: "aaa",
  };

  it("放行：误伤名/豁免引用/文档模板/Bearer 模板/空值继承/普通引用", () => {
    expect(() =>
      assertEnvPolicy({ TURKEY_SIZE: "big", MONKEY: "banana" }, undefined, SNAP),
    ).not.toThrow();
    expect(() => assertEnvPolicy({ TOOL_PATH: "${DSH_HOME}/bin" }, undefined, SNAP)).not.toThrow();
    expect(() => assertEnvPolicy({ DSH_HOME: "/home/u/.dsh" }, undefined, SNAP)).not.toThrow();
    expect(() =>
      assertEnvPolicy({ CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" }, undefined, {
        ...SNAP,
        CONTEXT7_API_KEY: "ck-live-5",
      }),
    ).not.toThrow();
    expect(() =>
      assertEnvPolicy(undefined, { Authorization: "Bearer ${DSH_770_B2_TOKEN}" }, SNAP),
    ).not.toThrow();
    expect(() => assertEnvPolicy({ MY_TOKEN: "" }, undefined, SNAP)).not.toThrow();
    expect(() =>
      assertEnvPolicy({ A: "plain", B: "x${OTHER_PLAIN}y" }, undefined, SNAP),
    ).not.toThrow();
    expect(() =>
      assertEnvPolicy({ BACKUP_TOKEN: "${DSH_770_B2_TOKEN}" }, undefined, SNAP),
    ).not.toThrow();
    expect(() => assertEnvPolicy(undefined, undefined, SNAP)).not.toThrow();
  });

  it("拒绝值携带：DEBUG 槽位引用凭据变量（set 与 unset 皆拦，按名 fail-closed）", () => {
    expect(() => assertEnvPolicy({ DEBUG: "${DSH_770_B2_SECRET}" }, undefined, SNAP)).toThrow(
      /env key "DEBUG" must not reference secret variable/,
    );
    expect(() => assertEnvPolicy({ DEBUG: "${DSH_770_B2_UNSET_SECRET}" }, undefined, SNAP)).toThrow(
      /DSH_770_B2_UNSET_SECRET/,
    );
    expect(() => assertEnvPolicy(undefined, { "X-Debug": "v=${DSH_770_B2_TOKEN}" }, SNAP)).toThrow(
      /headers key "X-Debug" must not reference secret variable/,
    );
  });

  it("拒绝活秘密查重：MY_TOKEN 明文与非秘密槽位明文拷贝", () => {
    expect(() => assertEnvPolicy({ MY_TOKEN: "b2-live-token-9f3" }, undefined, SNAP)).toThrow(
      /env key "MY_TOKEN" duplicates the live value of secret variable/,
    );
    expect(() => assertEnvPolicy({ DEBUG: "b2-live-secret-7q1" }, undefined, SNAP)).toThrow(
      /move it under a secret-shaped key/,
    );
  });

  it("文案明确且不泄漏：含键名/变量名/改法，不含活秘密字面量", () => {
    let smuggle = "";
    try {
      assertEnvPolicy({ DEBUG: "${DSH_770_B2_SECRET}" }, undefined, SNAP);
    } catch (error) {
      smuggle = String((error as Error).message);
    }
    expect(smuggle).toContain("DEBUG");
    expect(smuggle).toContain("DSH_770_B2_SECRET");
    expect(smuggle).toContain("rename the key");
    expect(smuggle.includes("b2-live-secret-7q1")).toBe(false);

    let duplicate = "";
    try {
      assertEnvPolicy({ MY_TOKEN: "b2-live-token-9f3" }, undefined, SNAP);
    } catch (error) {
      duplicate = String((error as Error).message);
    }
    expect(duplicate).toContain("MY_TOKEN");
    expect(duplicate).toContain("DSH_770_B2_TOKEN");
    expect(duplicate).toContain("${MY_TOKEN}");
    expect(duplicate.includes("b2-live-token-9f3")).toBe(false);
  });

  it("L3 兼容：非活秘密明文（既有合法形态）放行", () => {
    expect(() =>
      assertEnvPolicy({ HIDDEN_TOKEN: "l3-fake-env-secret-T6y8U1" }, undefined, SNAP),
    ).not.toThrow();
  });
});

describe("assertEnvPolicy url/args 扩面（B 门，与 env 同口径）", () => {
  const SNAP = {
    DSH_770_B2_TOKEN: "b2-live-token-9f3",
    DSH_770_B2_SECRET: "b2-live-secret-7q1",
    DSH_HOME: "/home/u/.dsh",
    OTHER_PLAIN: "aaa",
  };

  it("拒绝：url userinfo/查询值内嵌活口令", () => {
    expect(() =>
      assertEnvPolicy(undefined, undefined, SNAP, "https://user:b2-live-token-9f3@example.com/mcp"),
    ).toThrow(/url key "url" duplicates the live value of secret variable/);
    expect(() =>
      assertEnvPolicy(
        undefined,
        undefined,
        SNAP,
        "https://example.com/mcp?token=b2-live-secret-7q1&other=x",
      ),
    ).toThrow(/DSH_770_B2_SECRET/);
  });

  it("拒绝：args --token 活值（独立元素与等号形态）", () => {
    expect(() =>
      assertEnvPolicy(undefined, undefined, SNAP, undefined, [
        "-y",
        "--token",
        "b2-live-token-9f3",
      ]),
    ).toThrow(/args index 2 duplicates the live value of secret variable/);
    expect(() =>
      assertEnvPolicy(undefined, undefined, SNAP, undefined, ["--token=b2-live-secret-7q1"]),
    ).toThrow(/args index 0 duplicates the live value/);
  });

  it("拒绝：url/args 秘密引用污染（set 与 unset 皆拦，按名 fail-closed）", () => {
    expect(() =>
      assertEnvPolicy(
        undefined,
        undefined,
        SNAP,
        "https://example.com/mcp?token=${DSH_770_B2_SECRET}",
      ),
    ).toThrow(/url key "url" must not reference secret variable/);
    expect(() =>
      assertEnvPolicy(undefined, undefined, SNAP, undefined, [
        "--token",
        "${DSH_770_B2_UNSET_SECRET_X}",
      ]),
    ).toThrow(/args index 1 must not reference secret variable/);
  });

  it("放行：非活值 url/args；精确匹配防误伤（host/path/子串不审）", () => {
    expect(() =>
      assertEnvPolicy(undefined, undefined, SNAP, "https://example.com/mcp?token=not-live-value", [
        "-y",
        "pkg",
      ]),
    ).not.toThrow();
    // host/path 含活值子串不审：只审 userinfo/查询值精确相等。
    expect(() =>
      assertEnvPolicy(
        undefined,
        undefined,
        SNAP,
        "https://example.com/b2-live-token-9f3/mcp?token=other",
      ),
    ).not.toThrow();
    // args 长串含活值子串不审：只审整值/等号后段精确相等。
    expect(() =>
      assertEnvPolicy(undefined, undefined, SNAP, undefined, [
        "prefix-b2-live-token-9f3-suffix",
        "--name=x",
      ]),
    ).not.toThrow();
    // 缺省 url/args 照旧放行（既有三参调用兼容）。
    expect(() => assertEnvPolicy({ NOTE: "hi" }, undefined, SNAP)).not.toThrow();
  });

  it("文案不泄漏：url/args 报错不含活秘密字面量", () => {
    let duplicate = "";
    try {
      assertEnvPolicy(
        undefined,
        undefined,
        SNAP,
        "https://example.com/mcp?token=b2-live-token-9f3",
      );
    } catch (error) {
      duplicate = String((error as Error).message);
    }
    expect(duplicate).toContain("DSH_770_B2_TOKEN");
    expect(duplicate.includes("b2-live-token-9f3")).toBe(false);

    let smuggle = "";
    try {
      assertEnvPolicy(undefined, undefined, SNAP, undefined, ["${DSH_770_B2_SECRET}"]);
    } catch (error) {
      smuggle = String((error as Error).message);
    }
    expect(smuggle).toContain("DSH_770_B2_SECRET");
    expect(smuggle.includes("b2-live-secret-7q1")).toBe(false);
  });
});

describe("两阶段 enforcement：纯映射不拦截", () => {
  it("normalizeServer 保持纯形状校验：凭据形明文键不抛（策略门在写边界）", () => {
    expect(
      normalizeServer({
        name: "s",
        transport: "stdio",
        command: "echo",
        env: { MY_TOKEN: "whatever-plaintext" },
      }).env,
    ).toEqual({ MY_TOKEN: "whatever-plaintext" });
  });

  it("fromClaudeEntry / parseClaudeJson 保持纯映射：GITHUB_TOKEN 明文不抛", () => {
    expect(fromClaudeEntry("github", { command: "x", env: { GITHUB_TOKEN: "tok" } }).env).toEqual({
      GITHUB_TOKEN: "tok",
    });
    expect(parseClaudeJson(JSON.stringify({ s: { command: "x" } }))).toHaveLength(1);
  });
});

describe("三入口同门（真 manager + 真端口）", () => {
  it("add 拒绝污染且不落盘；L3 式明文与文档模板放行", async () => {
    installAll();
    const manager = emptyManager();
    await expect(
      manager.add(
        {
          name: "b2-bad",
          transport: "stdio",
          command: "echo",
          env: { DEBUG: "${DSH_770_B2_UNSET_SECRET_A}" },
          enabled: false,
        },
        "global",
      ),
    ).rejects.toThrow(/DEBUG/);
    expect(manager.store.find("b2-bad")).toBeUndefined();
    const l3style = await manager.add(
      {
        name: "b2-l3",
        transport: "stdio",
        command: "echo",
        env: { HIDDEN_TOKEN: "b2-plain-not-live-9z" },
        enabled: false,
      },
      "global",
    );
    expect(l3style.env).toEqual({ HIDDEN_TOKEN: "b2-plain-not-live-9z" });
    const doctemplate = await manager.add(
      {
        name: "b2-doc",
        transport: "stdio",
        command: "echo",
        env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
        enabled: false,
      },
      "global",
    );
    expect(doctemplate.env).toEqual({ CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" });
  });

  it("add 活秘密查重经缺省快照读父环境（显式 set/restore）", async () => {
    installAll();
    const manager = emptyManager();
    const prev = process.env.DSH_770_B2_DUP_TOKEN;
    process.env.DSH_770_B2_DUP_TOKEN = "b2-dup-live-4";
    try {
      await expect(
        manager.add(
          {
            name: "b2-dup",
            transport: "stdio",
            command: "echo",
            env: { MY_TOKEN: "b2-dup-live-4" },
            enabled: false,
          },
          "global",
        ),
      ).rejects.toThrow(/duplicates the live value of secret variable/);
      expect(manager.store.find("b2-dup")).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.DSH_770_B2_DUP_TOKEN;
      else process.env.DSH_770_B2_DUP_TOKEN = prev;
    }
  });

  it("update 拒绝污染补丁且既有值不变", async () => {
    installAll();
    const manager = emptyManager();
    await manager.add(
      {
        name: "b2-upd",
        transport: "stdio",
        command: "echo",
        env: { NOTE: "hi" },
        enabled: false,
      },
      "global",
    );
    await expect(
      manager.update("b2-upd", { env: { DEBUG: "${DSH_770_B2_UNSET_SECRET_U}" } }, "global"),
    ).rejects.toThrow(/DEBUG/);
    expect(manager.store.find("b2-upd")?.env).toEqual({ NOTE: "hi" });
    const ok = await manager.update("b2-upd", { command: "cat" }, "global");
    expect(ok.command).toBe("cat");
    expect(ok.env).toEqual({ NOTE: "hi" });
  });

  it("import 同门：污染 JSON → 400 大声失败且不入库；干净 JSON → 200", async () => {
    installAll();
    const manager = emptyManager();
    const routes = makeRoutes(manager as unknown as RoutesManager);
    const importRoute = routes.find((r) => r.path === ROUTES.importJson);
    expect(importRoute).toBeDefined();
    const bad = await callHandler(
      importRoute!,
      fakeReq("POST", ROUTES.importJson, {
        json: JSON.stringify({
          "b2-imp": { command: "echo", env: { DEBUG: "${DSH_770_B2_UNSET_SECRET_IMP}" } },
        }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(String((bad.payload as { error?: string }).error)).toContain("DEBUG");
    expect(String((bad.payload as { error?: string }).error)).toContain(
      "DSH_770_B2_UNSET_SECRET_IMP",
    );
    expect(manager.store.find("b2-imp")).toBeUndefined();
    const good = await callHandler(
      importRoute!,
      fakeReq("POST", ROUTES.importJson, {
        json: JSON.stringify({ "b2-ok": { command: "echo", env: { NOTE: "hi" } } }),
      }),
    );
    expect(good.status).toBe(200);
    expect((good.payload as { imported?: string[] }).imported).toEqual(["b2-ok"]);
  });
});
