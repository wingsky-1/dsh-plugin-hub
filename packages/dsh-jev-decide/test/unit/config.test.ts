/** config 域单测（纯逻辑 + mkdtempSync 落盘隔离，全程离线）。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDefaultConfig,
  normalizeLoadedConfig,
  validatePutBody,
} from "../../src/server/config/impl/model.ts";
import {
  configFile,
  jevHome,
  presetsFile,
  secretsFile,
  versionFile,
} from "../../src/server/config/impl/paths.ts";
import {
  readStoredVersion,
  resolveApiKey,
  savePatch,
  toMaskedConfig,
  writeStoredVersion,
} from "../../src/server/config/impl/service.ts";
import type { ConfigDeps } from "../../src/server/config/deps.ts";
import { atomicWrite0600Sync, readJsonSync, readTextSync } from "../../src/server/store/impl/io.ts";

function deps(): ConfigDeps {
  return { io: { readJsonSync, readTextSync, atomicWrite0600Sync }, logger: { warn: () => {} } };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "jev-config-"));
}

describe("默认值", () => {
  it("version=1 且 secret-leak 默认关闭", () => {
    const config = buildDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.connection).toMatchObject({
      hasPlaintextKey: false,
      timeoutMs: 8000,
      maxConcurrency: 4,
      truncBudget: 32000,
    });
    expect(config.presets).toHaveLength(5);
    expect(config.presets.find((p) => p.id === "secret-leak")?.enabled).toBe(false);
    expect(config.history).toMatchObject({ perSession: 200, totalSessions: 50 });
  });
  it("每次返回新对象（不共享引用）", () => {
    const a = buildDefaultConfig();
    const b = buildDefaultConfig();
    expect(a).not.toBe(b);
    expect(a.presets).not.toBe(b.presets);
  });
});

describe("PUT 校验", () => {
  it("apiKeyRef 正则：小写/中文/空串拒收", () => {
    for (const bad of ["lower", "密钥", "", "a", "1ABC"]) {
      const r = validatePutBody({ apiKeyRef: bad });
      expect(r.ok).toBe(false);
    }
    expect(validatePutBody({ apiKeyRef: "JEV_API_KEY" }).ok).toBe(true);
  });
  it("双轨互斥：同传 400", () => {
    const r = validatePutBody({
      apiKeyRef: "JEV_API_KEY",
      apiKeyPlaintext: "Abcdefgh12345678",
      confirm: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.errorCode).toBe("MUTUALLY_EXCLUSIVE");
  });
  it("明文免二次确认", () => {
    expect(validatePutBody({ apiKeyPlaintext: "Abcdefgh12345678" }).ok).toBe(true);
  });
  it("密钥形状拒收仅回类别", () => {
    const short = validatePutBody({ apiKeyPlaintext: "abc", confirm: true });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.failure.errorCode).toBe("INVALID_KEY_SHAPE");
      expect(short.failure.category).toBe("too-short");
      expect(JSON.stringify(short.failure)).not.toContain("abc");
    }
  });
  it("退役 baseUrl 与未知键 400", () => {
    const retired = validatePutBody({ baseUrl: "https://x" });
    expect(retired.ok).toBe(false);
    if (!retired.ok) expect(retired.failure.errorCode).toBe("RETIRED_KEY");
    const unknown = validatePutBody({ whatever: 1 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.failure.errorCode).toBe("UNKNOWN_KEY");
  });
  it("数值越界 400", () => {
    expect(validatePutBody({ timeoutMs: 1 }).ok).toBe(false);
    expect(validatePutBody({ maxConcurrency: 99 }).ok).toBe(false);
    expect(validatePutBody({ truncBudget: 50 }).ok).toBe(false);
  });
});

describe("落盘与版本", () => {
  it("VERSION 缺席即 0.0.0，写入后读回", () => {
    const home = tempHome();
    expect(readStoredVersion(home, deps())).toBe("0.0.0");
    writeStoredVersion(home, "0.1.0", deps());
    expect(readStoredVersion(home, deps())).toBe("0.1.0");
    expect(versionFile(home)).toContain("@wingsky-1/dsh-jev-decide");
  });
  it("三文件独立命名空间目录", () => {
    const home = tempHome();
    expect(jevHome(home)).toContain("@wingsky-1/dsh-jev-decide");
    expect(configFile(home)).not.toBe(secretsFile(home));
    expect(secretsFile(home)).not.toBe(presetsFile(home));
  });
  it("退役键迁移剥离", () => {
    const { config, retired } = normalizeLoadedConfig({
      connection: { baseUrl: "x" },
      presets: [],
      history: {},
    });
    expect(retired).toContain("baseUrl");
    expect(config.version).toBe(1);
  });
  it("PUT 落盘后 GET 掩码（无原文）", () => {
    const home = tempHome();
    const checked = validatePutBody({ apiKeyPlaintext: "Abcdefgh12345678", confirm: true });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const saved = savePatch(home, checked.patch, deps());
    expect(saved.config.connection.hasPlaintextKey).toBe(true);
    const masked = toMaskedConfig(saved);
    expect(JSON.stringify(masked)).not.toContain("Abcdefgh12345678");
    expect(masked.connection.hasPlaintextKey).toBe(true);
  });
  it("ENV 引用优先于明文", () => {
    const home = tempHome();
    const ref = validatePutBody({ apiKeyRef: "JEV_TEST_KEY_X1" });
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const saved = savePatch(home, ref.patch, deps());
    const resolved = resolveApiKey(saved, { JEV_TEST_KEY_X1: "EnvSecretValue12345" }, deps());
    expect(resolved).toMatchObject({ key: "EnvSecretValue12345", source: "env" });
    expect(resolveApiKey(saved, {}, deps()).source).toBe("none");
  });
});
