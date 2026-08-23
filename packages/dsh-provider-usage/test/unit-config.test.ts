// @ts-nocheck
/**
 * dsh-provider-usage — unit：配置归一化补充（normalizeConfig 边界、parseUserAdapters）。
 *
 * 补充 smoke-pure 已覆盖的 normalizeConfig 基础路径，聚焦边界：
 * warmupIntervalMs 下限、cacheDurationMs 下限、apiKey 字符串透传、
 * autoReload 布尔透传、maxSizeMB 上限、historyDir 字符串。
 *
 * #82 批次 3 增补：resolveProviderConfig 全链（含 opencodeKeyFromAuth 分支）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { assert } from "./helpers.ts";
import {
  normalizeConfig,
  DEFAULT_CONFIG,
  resolveProviderConfig,
} from "../lib/index.js";

// normalizeConfig 边界覆盖（smoke-pure 已覆盖 adapter/provider/fetchTimeoutMs/maxAgeDays）

assert.equal(normalizeConfig({ warmupIntervalMs: 0 }).warmupIntervalMs, 60000, "warmupIntervalMs 下限 60000");
assert.equal(normalizeConfig({ warmupIntervalMs: 120000 }).warmupIntervalMs, 120000, "warmupIntervalMs 合法透传");
assert.equal(normalizeConfig({ warmupIntervalMs: "x" }).warmupIntervalMs, DEFAULT_CONFIG.warmupIntervalMs, "warmupIntervalMs 非法丢弃");

assert.equal(normalizeConfig({ cacheDurationMs: 1000 }).cacheDurationMs, 5000, "cacheDurationMs 下限 5000");
assert.equal(normalizeConfig({ cacheDurationMs: 10000 }).cacheDurationMs, 10000, "cacheDurationMs 合法透传");
assert.equal(normalizeConfig({ cacheDurationMs: "x" }).cacheDurationMs, DEFAULT_CONFIG.cacheDurationMs, "cacheDurationMs 非法丢弃");

assert.equal(normalizeConfig({ apiKey: "sk-abc123" }).apiKey, "sk-abc123", "apiKey 字符串透传");
assert.equal(normalizeConfig({ apiKey: 123 }).apiKey, "", "apiKey 非字符串丢弃回默认空串");

assert.equal(normalizeConfig({ autoReload: false }).autoReload, false, "autoReload 可关闭");
assert.equal(normalizeConfig({ autoReload: "false" }).autoReload, true, "autoReload 非布尔丢弃回 true");
assert.equal(normalizeConfig({ autoReload: 1 }).autoReload, true, "autoReload 数字 1 丢弃回 true");

assert.equal(normalizeConfig({ maxSizeMB: 600 }).maxSizeMB, 500, "maxSizeMB 上限 500");
assert.equal(normalizeConfig({ maxSizeMB: 50 }).maxSizeMB, 50, "maxSizeMB 合法透传");
assert.equal(normalizeConfig({ maxSizeMB: -1 }).maxSizeMB, -1, "maxSizeMB 负数当前无下限检查（跟随实现行为）");
assert.equal(normalizeConfig({ maxSizeMB: "x" }).maxSizeMB, DEFAULT_CONFIG.maxSizeMB, "maxSizeMB 非数字丢弃回默认");

assert.equal(normalizeConfig({ historyDir: "/custom/hist" }).historyDir, "/custom/hist", "historyDir 字符串透传");
assert.equal(normalizeConfig({ historyDir: 42 }).historyDir, "", "historyDir 非字符串丢弃回默认空串");

assert.equal(normalizeConfig({ staticPath: "/v1/custom" }).staticPath, "/v1/custom", "staticPath 字符串透传");

// ---------------------------------------------------------------- resolveProviderConfig 全链

// resolveProviderConfig 内部会访问 resolveApiKey → opencodeKeyFromAuth。
// 注意：unit-*.test.ts 由 smoke.ts import，在 smoke.ts 模块体执行前运行
// （ESM import 先于 module body），此时 DSH_HOME 尚未指向隔离目录、真实环境
// 的凭据链（~/.dsh/.credentials.yaml / 环境变量）仍可被读到。因此本文件内所有
// resolveProviderConfig 用例自行隔离 DSH_HOME/HOME 并清理凭据环境变量，
// finally 恢复，避免污染后续 smoke 断言。

/** 保存并清空凭据环境变量，返回恢复函数。DSH_HOME 始终指向隔离目录。 */
function isolateCredEnv(homeDir?: string) {
  const saved = {
    dshHome: process.env.DSH_HOME,
    home: process.env.HOME,
    key: process.env.OPENCODE_GO_API_KEY,
    key2: process.env.OPENCODE_GO_PROVIDER_API_KEY,
  };
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_GO_PROVIDER_API_KEY;
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dou-dshhome-"));
  if (homeDir !== undefined) process.env.HOME = homeDir;
  return () => {
    const r = (k: string, v: string | undefined) => {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    };
    r("DSH_HOME", saved.dshHome);
    r("HOME", saved.home);
    r("OPENCODE_GO_API_KEY", saved.key);
    r("OPENCODE_GO_PROVIDER_API_KEY", saved.key2);
  };
}

// 1) auth.json（opencodeKeyFromAuth 全分支）：HOME 指向临时目录且无 .credentials.yaml
{
  const authDir = mkdtempSync(join(tmpdir(), "dou-auth-"));
  const authLocal = join(authDir, ".local", "share", "opencode");
  mkdirSync(authLocal, { recursive: true });
  const restore = isolateCredEnv(authDir);
  try {
    writeFileSync(join(authLocal, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "sk-auth-json" },
    }), "utf8");
    const resolved = await resolveProviderConfig("opencode-go");
    assert.equal(resolved.apiKey, "sk-auth-json", "auth.json 的 opencode-go 密钥被读取");
  } finally {
    restore();
  }
}

// 1b) auth.json 走 opencode 旧键名
{
  const authDir = mkdtempSync(join(tmpdir(), "dou-auth-legacy-"));
  const authLocal = join(authDir, ".local", "share", "opencode");
  mkdirSync(authLocal, { recursive: true });
  const restore = isolateCredEnv(authDir);
  try {
    writeFileSync(join(authLocal, "auth.json"), JSON.stringify({
      "opencode": { type: "api", key: "sk-auth-legacy" },
    }), "utf8");
    const resolved = await resolveProviderConfig("opencode-go");
    assert.equal(resolved.apiKey, "sk-auth-legacy", "auth.json 旧键名 opencode 兼容读取");
  } finally {
    restore();
  }
}

// 2) .credentials.yaml：DSH_HOME 下创建凭据文件
{
  const restore = isolateCredEnv();
  try {
    writeFileSync(join(process.env.DSH_HOME, ".credentials.yaml"), [
      "version: 1",
      "refs:",
      "  OPENCODE_GO_API_KEY: sk-from-yaml",
    ].join("\n"), "utf8");
    const resolved = await resolveProviderConfig("opencode-go");
    assert.equal(resolved.apiKey, "sk-from-yaml", ".credentials.yaml 的密钥被读取");
  } finally {
    restore();
  }
}

// 3) 显式传入的 apiKey 优先级最高
{
  const restore = isolateCredEnv();
  try {
    const resolved = await resolveProviderConfig("opencode-go", undefined, { apiKey: "sk-explicit" });
    assert.equal(resolved.apiKey, "sk-explicit", "显式 apiKey 优先");
  } finally {
    restore();
  }
}

// 4) 环境变量优先于 auth.json
{
  const authDir = mkdtempSync(join(tmpdir(), "dou-auth-env-"));
  const authLocal = join(authDir, ".local", "share", "opencode");
  mkdirSync(authLocal, { recursive: true });
  const restore = isolateCredEnv(authDir);
  try {
    writeFileSync(join(authLocal, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "sk-auth-json" },
    }), "utf8");
    process.env.OPENCODE_GO_API_KEY = "sk-from-env";
    const resolved = await resolveProviderConfig("opencode-go");
    assert.equal(resolved.apiKey, "sk-from-env", "环境变量优先于 auth.json");
  } finally {
    restore();
  }
}

// 5) 无任何可信密钥来源 → undefined（不抛错）
{
  const noHome = mkdtempSync(join(tmpdir(), "dou-noauth-"));
  const restore = isolateCredEnv(noHome);
  try {
    const resolved = await resolveProviderConfig("opencode-go");
    assert.equal(resolved.apiKey, undefined, "无密钥来源返回 undefined");
    assert.equal(resolved.apiEndpoint, undefined, "无 apiEndpoint 返回 undefined");
  } finally {
    restore();
  }
}

// 6) 非 opencode-go provider 不应读 auth.json
{
  const authDir = mkdtempSync(join(tmpdir(), "dou-auth-x-"));
  const authLocal = join(authDir, ".local", "share", "opencode");
  mkdirSync(authLocal, { recursive: true });
  const restore = isolateCredEnv(authDir);
  try {
    writeFileSync(join(authLocal, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "sk-auth-json" },
    }), "utf8");
    const resolved = await resolveProviderConfig("anthropic");
    assert.equal(resolved.apiKey, undefined, "非 opencode-go provider 不读 auth.json");
  } finally {
    restore();
  }
}