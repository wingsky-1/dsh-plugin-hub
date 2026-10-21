/**
 * dsh-verify-isolated — 可选真实宿主 provider-usage 探针的离线 smoke。
 *
 * 无网络、无真实凭据、不启动 dsh：断言 scripts/lib/provider-usage-probe.mjs 的
 * 解析/判定/报告纯函数与注入 fetch 的薄 I/O。覆盖四态 fixture：
 *   - skip：隔离 DSH_HOME 无存储凭据 → 输出「未验证（无凭据）」、退出 0；
 *   - fresh：有凭据 + stats.ok=true → 退出 0，lastSuccessAt 取 fetchedAt；
 *   - stale：有凭据 + stats.error=timeout（非 no-api-key）→ 退出 0；
 *   - no-api-key：有凭据 + stats.error=no-api-key → 退出 1 + 可操作诊断。
 *
 * 另锁安全面：只读隔离 home、不把 records（浏览器会话）误当 API 凭据、URL 去 query、
 * 输出不含令牌/密钥、health 只取白名单字段、--help 可见新选项、探针接在就绪之后。
 * 真实宿主运行不在本文件（无凭据时 skip；本机不伪造凭据）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const SCRIPTS_DIR = join(PKG_ROOT, "skills", "dsh-verify-isolated", "scripts");
const SCRIPT_FILE = join(SCRIPTS_DIR, "verify-isolated.mjs");
const PROBE_FILE = join(SCRIPTS_DIR, "lib", "provider-usage-probe.mjs");

const FETCHED_AT = 1700000000000;

/** 有凭据的 stats 帧（带 capsuleHtml 验证白名单丢弃）。 */
const FRESH_STATS = {
  plugin: "dsh-provider-usage",
  version: 2,
  provider: "deepseek-official",
  adapterName: "deepseek-official",
  status: "fresh",
  capsuleHtml: "<b>must-not-be-in-evidence</b>",
  ok: true,
  configured: true,
  reason: null,
  error: null,
  fetchedAt: FETCHED_AT,
  adapterVersion: 0,
};

const STALE_STATS = {
  ...FRESH_STATS,
  status: "stale",
  ok: false,
  reason: "fetch-failed",
  error: "timeout",
};

const NO_API_KEY_STATS = {
  ...FRESH_STATS,
  status: "stale",
  ok: false,
  reason: "fetch-failed",
  error: "no-api-key",
};

const HEALTH_OK = {
  ok: true,
  plugin: "dsh-provider-usage",
  provider: "deepseek-official",
  errors: [],
};

const HEALTH_WITH_ERRORS = {
  ok: true,
  provider: "deepseek-official",
  errors: [
    {
      key: "deepseek-official/deepseek-official",
      at: 1700000001000,
      kind: "exec",
      message: "timeout",
    },
    { key: "file:user.mjs", at: 1700000002000, kind: "load", message: "契约校验失败" },
  ],
  layerErrors: { aggregate: { count: 0, recent: [] } },
};

let probe;
let tmpRoot;

beforeAll(async () => {
  probe = await import(pathToFileURL(PROBE_FILE).href);
  tmpRoot = mkdtempSync(join(tmpdir(), "dsh-verify-probe-"));
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** 写一个隔离凭据 fixture（测试占位值，不是真实凭据）。 */
function writeCredentials(name, text) {
  const dir = mkdtempSync(join(tmpRoot, `${name}-`));
  const file = join(dir, ".credentials.yaml");
  writeFileSync(file, text);
  return file;
}

/** 注入 fetch：按 URL 返回预设响应；记录请求，不做任何网络。 */
function makeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const href = String(url);
    calls.push(href);
    const hit = Object.entries(routes).find(([suffix]) => href.includes(suffix));
    if (!hit) throw new Error(`unexpected probe URL: ${href}`);
    return new Response(hit[1].body ?? JSON.stringify(hit[1].json), {
      status: hit[1].status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

describe("1. 凭据证据：refs 条目才算凭据（records 是浏览器会话，不算）", () => {
  it("空文件/注释不算", () => {
    expect(probe.hasStoredCredentialDocument("")).toBe(false);
    expect(probe.hasStoredCredentialDocument("# only a comment\n\n")).toBe(false);
  });

  it("只有 records（隔离 dsh web 启动写的浏览器会话）不算凭据", () => {
    const text = [
      "version: 1",
      "records:",
      "  client-connection.browser-session:",
      "    kind: grant",
      "    payload:",
      "      version: 1",
      "      secret: placeholder",
      "",
    ].join("\n");
    expect(probe.hasStoredCredentialDocument(text)).toBe(false);
  });

  it("空 refs 块不算凭据", () => {
    expect(probe.hasStoredCredentialDocument("version: 1\nrefs:\nrecords: {}\n")).toBe(false);
    expect(probe.hasStoredCredentialDocument("version: 1\nrefs: {}\n")).toBe(false);
  });

  it("refs 块下有条目才算凭据", () => {
    const text = [
      "version: 1",
      "refs:",
      "  TEST_PROVIDER_API_KEY:",
      "    type: string",
      "    value: test-placeholder",
      "",
    ].join("\n");
    expect(probe.hasStoredCredentialDocument(text)).toBe(true);
  });

  it("refs 行内非空形态也算凭据", () => {
    expect(probe.hasStoredCredentialDocument("version: 1\nrefs: {TEST: value}\n")).toBe(true);
  });

  it("旧扁平布局（无 version）保守识别为凭据", () => {
    expect(probe.hasStoredCredentialDocument("TEST_PROVIDER_API_KEY: test-placeholder\n")).toBe(
      true,
    );
  });

  it("classifyCredentials 四态", () => {
    expect(probe.classifyCredentials({ exists: false }).reason).toBe("no-file");
    expect(probe.classifyCredentials({ exists: true, text: undefined }).reason).toBe("unreadable");
    expect(probe.classifyCredentials({ exists: true, text: "version: 1\n" }).reason).toBe(
      "empty-store",
    );
    expect(
      probe.classifyCredentials({ exists: true, text: "version: 1\nrefs:\n  A: b\n" }).reason,
    ).toBe("stored-ref");
  });
});

describe("2. stats 解析（白名单字段 + lastSuccessAt 语义）", () => {
  it("丢弃 capsuleHtml 等非白名单字段", () => {
    const parsed = probe.parseStatsResponse(200, FRESH_STATS);
    expect(parsed.ok).toBe(true);
    expect(parsed.fetchedAt).toBe(FETCHED_AT);
    expect(parsed.capsuleHtml).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("must-not-be-in-evidence");
  });

  it("ok=true 时 lastSuccessAt 取 fetchedAt", () => {
    expect(probe.parseStatsResponse(200, FRESH_STATS).lastSuccessAt).toBe(FETCHED_AT);
  });

  it("ok=false 且无显式 lastSuccessAt 时为 null（不猜测）", () => {
    expect(probe.parseStatsResponse(200, STALE_STATS).lastSuccessAt).toBeNull();
    expect(probe.parseStatsResponse(200, NO_API_KEY_STATS).lastSuccessAt).toBeNull();
  });

  it("显式 lastSuccessAt 字段优先", () => {
    const parsed = probe.parseStatsResponse(200, { ...STALE_STATS, lastSuccessAt: 123 });
    expect(parsed.lastSuccessAt).toBe(123);
  });

  it("非对象 payload 标记 parsed=false（不抛）", () => {
    expect(probe.parseStatsResponse(200, null).parsed).toBe(false);
    expect(probe.parseStatsResponse(200, "text").parsed).toBe(false);
  });
});

describe("3. health 解析（errors/fetchErrors 白名单，仅诊断）", () => {
  it("errors 白名单字段，fetchErrors 取 kind=exec 子集", () => {
    const parsed = probe.parseHealthResponse(200, HEALTH_WITH_ERRORS);
    expect(parsed.errorsTotal).toBe(2);
    expect(parsed.fetchErrorCount).toBe(1);
    expect(parsed.fetchErrors).toHaveLength(1);
    expect(parsed.fetchErrors[0].kind).toBe("exec");
    expect(parsed.errors[0]).toEqual({
      key: "deepseek-official/deepseek-official",
      at: 1700000001000,
      kind: "exec",
      message: "timeout",
    });
    expect(parsed.layerErrors).toBeUndefined();
  });

  it("errors 上限 10 条，超出不污染证据", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`,
      at: i,
      kind: "load",
      message: "m",
    }));
    const parsed = probe.parseHealthResponse(200, { ok: true, errors: many });
    expect(parsed.errors).toHaveLength(10);
    expect(parsed.errorsTotal).toBe(20);
  });
});

describe("4. evaluateProbe 四态 fixture", () => {
  it("skip：无存储凭据 → status=skip / exit 0 / 明示未验证", () => {
    const result = probe.evaluateProbe({
      credentials: { present: false, reason: "no-file" },
    });
    expect(result.status).toBe("skip");
    expect(result.exitCode).toBe(0);
    expect(result.headline).toBe("未验证（无凭据）");
    expect(result.stats).toBeNull();
    expect(result.diagnostics.join("\n")).toContain("~/.dsh");
  });

  it("fresh：有凭据 + ok:true → pass / exit 0", () => {
    const result = probe.evaluateProbe({
      credentials: { present: true, reason: "stored-ref" },
      stats: probe.parseStatsResponse(200, FRESH_STATS),
      health: probe.parseHealthResponse(200, HEALTH_OK),
    });
    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.stats.ok).toBe(true);
    expect(result.diagnostics.join("\n")).toContain("stats.ok=true");
  });

  it("stale：有凭据 + error=timeout（非 no-api-key）→ pass / exit 0", () => {
    const result = probe.evaluateProbe({
      credentials: { present: true, reason: "stored-ref" },
      stats: probe.parseStatsResponse(200, STALE_STATS),
      health: probe.parseHealthResponse(200, HEALTH_WITH_ERRORS),
    });
    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics.join("\n")).toContain("不是 no-api-key");
  });

  it("no-api-key：有凭据但 seam 未取到 key → fail / exit 1 + 可操作诊断", () => {
    const result = probe.evaluateProbe({
      credentials: { present: true, reason: "stored-ref" },
      stats: probe.parseStatsResponse(200, NO_API_KEY_STATS),
      health: probe.parseHealthResponse(200, HEALTH_WITH_ERRORS),
    });
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics.join("\n")).toContain("apiKeyEnv");
    expect(result.diagnostics.join("\n")).toContain("get(ns)");
    expect(result.diagnostics.join("\n")).toContain("不要复制真实凭据");
  });

  it("真实路由采样形状（status=cached、adapterName=*-builtin、带 capsuleHtml）仍判 fail exit 1", () => {
    // 本 fixture 取自 0.2.1-rc.2 隔离实例的真实 /stats 响应（capsuleHtml 已截短），
    // 只用于锁解析兼容性；不含任何凭据。
    const realStats = {
      plugin: "dsh-provider-usage",
      version: 2,
      provider: "deepseek-official",
      adapterName: "deepseek-official-builtin",
      status: "cached",
      capsuleHtml: "<span>DeepSeek 余额 --</span>",
      ok: false,
      configured: true,
      reason: "fetch-failed",
      error: "no-api-key",
      fetchedAt: 1792589278017,
      adapterVersion: 0,
    };
    const parsed = probe.parseStatsResponse(200, realStats);
    expect(parsed.status).toBe("cached");
    expect(parsed.adapterName).toBe("deepseek-official-builtin");
    expect(parsed.lastSuccessAt).toBeNull();
    const result = probe.evaluateProbe({
      credentials: { present: true, reason: "stored-ref" },
      stats: parsed,
      health: probe.parseHealthResponse(200, { ok: true, errors: [] }),
    });
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
  });

  it("真实 /health 形状：adapters/historyDir/layerErrors/trend 不进白名单输出", () => {
    const realHealth = {
      ok: true,
      plugin: "dsh-provider-usage",
      version: 2,
      provider: "opencode-go",
      cacheSize: 2,
      adapters: [{ name: "deepseek-official-builtin", providers: ["deepseek-official"] }],
      enabled: { "deepseek-official": "deepseek-official-builtin" },
      errors: [],
      historyDir: "/tmp/real-home/dsh-provider-usage",
      layerErrors: { aggregate: { count: 0, recent: [] } },
      trend: { days: 0, pendingRows: 0 },
    };
    const parsed = probe.parseHealthResponse(200, realHealth);
    expect(parsed.errorsTotal).toBe(0);
    const text = JSON.stringify(parsed);
    expect(text).not.toContain("/tmp/real-home");
    expect(text).not.toContain("adapters");
    expect(text).not.toContain("layerErrors");
    expect(text).not.toContain("trend");
  });

  it("stats 请求不可用 / HTTP 非 200 / 非 JSON 都判 fail exit 1", () => {
    const noStats = probe.evaluateProbe({
      credentials: { present: true, reason: "stored-ref" },
      stats: null,
      statsError: "connect ECONNREFUSED",
    });
    expect(noStats.status).toBe("fail");
    expect(noStats.exitCode).toBe(1);

    const http500 = probe.evaluateProbe({
      credentials: { present: true, reason: "stored-ref" },
      stats: probe.parseStatsResponse(500, { error: "stats timeout" }),
    });
    expect(http500.status).toBe("fail");
    expect(http500.exitCode).toBe(1);

    const notJson = probe.evaluateProbe({
      credentials: { present: true, reason: "stored-ref" },
      stats: probe.parseStatsResponse(200, null),
      statsError: "响应不是合法 JSON",
    });
    expect(notJson.status).toBe("fail");
    expect(notJson.exitCode).toBe(1);
  });
});

describe("5. 报告脱敏与 URL 去 query", () => {
  it("URL 只保留 origin+pathname", () => {
    expect(probe.sanitizeProbeUrl("http://127.0.0.1:9/stats?provider=x&token=secret")).toBe(
      "http://127.0.0.1:9/stats",
    );
  });

  it("redactSecrets 覆盖 token/Bearer/sk- 前缀", () => {
    const redacted = probe.redactSecrets(
      "token=abc123 api_key: sk-live-123456789 Bearer abcdefghijklmnop",
    );
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("sk-live-123456789");
    expect(redacted).not.toContain("abcdefghijklmnop");
  });

  it("skip 报告逐字含「未验证（无凭据）」，且不含 stats 行", () => {
    const result = probe.evaluateProbe({ credentials: { present: false, reason: "no-file" } });
    const lines = probe.formatProbeReport({
      ...result,
      endpoints: { stats: "", health: "" },
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
    const text = lines.join("\n");
    expect(text).toContain("未验证（无凭据）");
    expect(text).not.toContain("stats: GET");
  });

  it("pass 报告字段白名单，不含 capsuleHtml", () => {
    const result = probe.evaluateProbe({
      credentials: { present: true, reason: "stored-ref" },
      stats: probe.parseStatsResponse(200, FRESH_STATS),
      health: probe.parseHealthResponse(200, HEALTH_OK),
    });
    const text = probe
      .formatProbeReport({
        ...result,
        endpoints: {
          stats: "http://127.0.0.1:9/api/dsh-provider-usage/stats",
          health: "http://127.0.0.1:9/api/dsh-provider-usage/health",
        },
        checkedAt: "2026-01-01T00:00:00.000Z",
      })
      .join("\n");
    expect(text).toContain("HTTP 200");
    expect(text).not.toContain("must-not-be-in-evidence");
    expect(text).not.toContain("token=");
  });
});

describe("6. runProviderUsageProbe 薄 I/O（注入 fetch，零网络）", () => {
  it("无凭据：不发任何请求，skip exit 0", async () => {
    const { impl, calls } = makeFetch({});
    const result = await probe.runProviderUsageProbe({
      baseUrl: "http://127.0.0.1:9/",
      credentialsPath: join(tmpRoot, "missing", ".credentials.yaml"),
      fetchImpl: impl,
      now: () => 0,
    });
    expect(calls).toHaveLength(0);
    expect(result.status).toBe("skip");
    expect(result.exitCode).toBe(0);
  });

  it("有凭据 + fresh：请求两个端点，pass exit 0，endpoints 无 query", async () => {
    const credentialsPath = writeCredentials(
      "fresh",
      "version: 1\nrefs:\n  TEST_PROVIDER_API_KEY:\n    type: string\n    value: test-placeholder\n",
    );
    const { impl, calls } = makeFetch({
      "/api/dsh-provider-usage/stats": { status: 200, json: FRESH_STATS },
      "/api/dsh-provider-usage/health": { status: 200, json: HEALTH_OK },
    });
    const result = await probe.runProviderUsageProbe({
      baseUrl: "http://127.0.0.1:9/",
      credentialsPath,
      fetchImpl: impl,
      now: () => 0,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("provider=deepseek-official");
    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.checkedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(result.endpoints.stats).toBe("http://127.0.0.1:9/api/dsh-provider-usage/stats");
    expect(result.endpoints.health).toBe("http://127.0.0.1:9/api/dsh-provider-usage/health");
    expect(result.endpoints.stats).not.toContain("provider=");
  });

  it("有凭据 + no-api-key：fail exit 1", async () => {
    const credentialsPath = writeCredentials(
      "nokey",
      "version: 1\nrefs:\n  TEST_PROVIDER_API_KEY:\n    type: string\n    value: test-placeholder\n",
    );
    const { impl } = makeFetch({
      "/api/dsh-provider-usage/stats": { status: 200, json: NO_API_KEY_STATS },
      "/api/dsh-provider-usage/health": { status: 200, json: HEALTH_WITH_ERRORS },
    });
    const result = await probe.runProviderUsageProbe({
      baseUrl: "http://127.0.0.1:9/",
      credentialsPath,
      fetchImpl: impl,
      now: () => 0,
    });
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.health.fetchErrorCount).toBe(1);
  });

  it("stats HTTP 500：fail exit 1，仍带 health 诊断", async () => {
    const credentialsPath = writeCredentials(
      "http500",
      "version: 1\nrefs:\n  TEST_PROVIDER_API_KEY:\n    type: string\n    value: test-placeholder\n",
    );
    const { impl } = makeFetch({
      "/api/dsh-provider-usage/stats": { status: 500, json: { error: "stats timeout" } },
      "/api/dsh-provider-usage/health": { status: 200, json: HEALTH_OK },
    });
    const result = await probe.runProviderUsageProbe({
      baseUrl: "http://127.0.0.1:9/",
      credentialsPath,
      fetchImpl: impl,
      now: () => 0,
    });
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.stats.httpStatus).toBe(500);
  });

  it("非 JSON 响应：fail exit 1", async () => {
    const credentialsPath = writeCredentials(
      "notjson",
      "version: 1\nrefs:\n  TEST_PROVIDER_API_KEY:\n    type: string\n    value: test-placeholder\n",
    );
    const { impl } = makeFetch({
      "/api/dsh-provider-usage/stats": { status: 200, body: "<html>not json</html>" },
      "/api/dsh-provider-usage/health": { status: 200, body: "not json" },
    });
    const result = await probe.runProviderUsageProbe({
      baseUrl: "http://127.0.0.1:9/",
      credentialsPath,
      fetchImpl: impl,
      now: () => 0,
    });
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.stats.parsed).toBe(false);
  });
});

describe("7. CLI 契约与接入点", () => {
  it("--help 可见 --probe-provider-usage 与退出码说明", () => {
    const help = execFileSync(process.execPath, [SCRIPT_FILE, "--help"], { encoding: "utf8" });
    expect(help).toContain("--probe-provider-usage");
    expect(help).toContain("未验证（无凭据）");
    expect(help).toContain("no-api-key");
    expect(help).toContain("非离线 CI 门禁");
  });

  it("探针接在就绪断言与访问 URL 之后、前台等待之前", () => {
    const source = execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(SCRIPT_FILE)}, "utf8"))`,
      ],
      { encoding: "utf8" },
    );
    const readyAt = source.indexOf("await awaitDshReady(collector, verdictPort);");
    const probeAt = source.indexOf("await runProviderUsageProbeStep();");
    const waitAt = source.indexOf("await waitForDshExit();");
    expect(readyAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(readyAt);
    expect(waitAt).toBeGreaterThan(probeAt);
  });

  it("verdict 含去敏的 providerUsage 字段（未启用为 null）", () => {
    const source = execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(SCRIPT_FILE)}, "utf8"))`,
      ],
      { encoding: "utf8" },
    );
    expect(source).toContain("providerUsage: providerUsageResult");
  });

  it("探针库文件随 skill 分发，且不 import 用户 home / 凭据读取之外的脚本", () => {
    const source = execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(PROBE_FILE)}, "utf8"))`,
      ],
      { encoding: "utf8" },
    );
    expect(source).toContain("existsSync(credentialsPath)");
    expect(source).not.toContain("homedir()");
    expect(source).not.toContain("~/.dsh/.credentials.yaml");
  });
});
