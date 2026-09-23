/** 密钥硬化：ENV 正则 + 全大写形状 + PUT 互斥 + GET 掩码 + 日志无原文（mkdtemp 隔离，全离线）。
 *
 * 守的是 config/model.validatePutBody + service.savePatch/toMaskedConfig/resolveApiKey：
 * 把正则放宽、互斥删掉、掩码漏原文任一改动，本文件必红。落盘仅 mkdtempSync 目录。
 */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePutBody } from "../../src/server/config/impl/model.ts";
import {
  loadState,
  resolveApiKey,
  savePatch,
  toMaskedConfig,
} from "../../src/server/config/impl/service.ts";
import type { ConfigDeps } from "../../src/server/config/deps.ts";
import { atomicWrite0600Sync, readJsonSync, readTextSync } from "../../src/server/store/impl/io.ts";
import { keyShapeCategory } from "../../src/shared/contract.ts";

function depsWithLog(seen: string[]): ConfigDeps {
  return {
    io: { readJsonSync, readTextSync, atomicWrite0600Sync },
    logger: {
      warn: (m: string) => {
        seen.push(m);
      },
    },
  };
}
function plainDeps(): ConfigDeps {
  return { io: { readJsonSync, readTextSync, atomicWrite0600Sync }, logger: { warn: () => {} } };
}
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "jev-keys-"));
}
const PLAINTEXT = "Abcdefgh12345678";

describe("ENV 引用正则", () => {
  it("合法：大写开头 2..64 位 A-Z0-9_", () => {
    for (const good of ["JEV_API_KEY", "A1", "AKIAIOSFODNN7EXAMPLE", "JEV_TEST_KEY_X1"]) {
      expect(validatePutBody({ apiKeyRef: good }).ok).toBe(true);
    }
    expect(validatePutBody({ apiKeyRef: "A".repeat(64) }).ok).toBe(true);
  });
  it("非法：小写/中文/空串/数字开头/下划线开头/连字符/超长", () => {
    for (const bad of [
      "lower",
      "jev_key",
      "密钥",
      "",
      "a",
      "1ABC",
      "_ABC",
      "JEV-KEY",
      "A".repeat(65),
    ]) {
      const r = validatePutBody({ apiKeyRef: bad });
      expect(r.ok).toBe(false);
    }
  });
  it("null 即清除引用（合法补丁）", () => {
    const r = validatePutBody({ apiKeyRef: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.apiKeyRef).toBe(null);
  });
});

describe("明文形状与全大写缺口", () => {
  it("形状类别：empty/too-short/charset 精确", () => {
    expect(keyShapeCategory("")).toBe("empty");
    expect(keyShapeCategory("abc")).toBe("too-short");
    expect(keyShapeCategory("1234567890123456")).toBe("charset");
    expect(keyShapeCategory("Abcdefgh12345678!")).toBe("charset");
    expect(keyShapeCategory(PLAINTEXT)).toBe(null);
  });
  it("全大写长串拒收（P0 硬化，阈值 20）", () => {
    // src ALL_CAPS_REJECT_MIN_LEN=20：≥20 位全大写字母数字混合或 AKIA/ASIA 前缀即 charset；
    // 16 位全大写无前缀可辨仍放行（与 src 对齐，不从严）。
    expect(keyShapeCategory("AKIAIOSFODNN7EXAMPLE")).toBe("charset");
    expect(keyShapeCategory("ABCDEFGHIJKLMNOP")).toBe(null);
    const r = validatePutBody({ apiKeyPlaintext: "AKIAIOSFODNN7EXAMPLE", confirm: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.errorCode).toBe("INVALID_KEY_SHAPE");
      expect(r.failure.category).toBe("charset");
      expect(JSON.stringify(r.failure)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    }
  });
  it("形状拒收仅回类别、无原文", () => {
    const short = validatePutBody({ apiKeyPlaintext: "abc", confirm: true });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.failure.errorCode).toBe("INVALID_KEY_SHAPE");
      expect(short.failure.category).toBe("too-short");
      expect(JSON.stringify(short.failure)).not.toContain("abc");
    }
  });
  it("短密钥无 confirm 仍 400 形状错（形状先于确认）", () => {
    const short = validatePutBody({ apiKeyPlaintext: "abc" });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.failure.category).toBe("too-short");
  });
  it("明文免二次确认：缺 confirm 即成功", () => {
    const r = validatePutBody({ apiKeyPlaintext: PLAINTEXT });
    expect(r.ok).toBe(true);
    expect(validatePutBody({ apiKeyPlaintext: PLAINTEXT, confirm: true }).ok).toBe(true);
  });
  it("confirm 显式 false 同样忽略；孤 confirm 无害空补丁", () => {
    const allowed = validatePutBody({ apiKeyPlaintext: PLAINTEXT, confirm: false });
    expect(allowed.ok).toBe(true);
    const lone = validatePutBody({ confirm: true });
    expect(lone.ok).toBe(true);
    if (lone.ok) expect(lone.patch).toEqual({});
  });
});

describe("M1 合并语义：presets 按 id 合并，history 浅合并", () => {
  it("presets 子集补丁只改命中项（secret-leak 不复活）", () => {
    const home = tempHome();
    const checked = validatePutBody({
      presets: [{ id: "general", enabled: false, automationCap: 2 }],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const saved = savePatch(home, checked.patch, plainDeps());
    expect(saved.config.presets.find((p) => p.id === "general")?.enabled).toBe(false);
    expect(saved.config.presets.find((p) => p.id === "secret-leak")?.enabled).toBe(false);
    expect(saved.config.presets.find((p) => p.id === "plan-review")?.enabled).toBe(true);
    expect(saved.config.presets).toHaveLength(5);
  });
  it("history 部分补丁保留未提键", () => {
    const home = tempHome();
    const checked = validatePutBody({ history: { perSession: 100 } });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const saved = savePatch(home, checked.patch, plainDeps());
    expect(saved.config.history).toMatchObject({ perSession: 100, totalSessions: 50 });
  });
});

describe("PUT 双轨互斥 + GET 掩码 + 日志无原文", () => {
  it("同体双轨即 MUTUALLY_EXCLUSIVE", () => {
    const r = validatePutBody({
      apiKeyRef: "JEV_API_KEY",
      apiKeyPlaintext: PLAINTEXT,
      confirm: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.errorCode).toBe("MUTUALLY_EXCLUSIVE");
  });
  it("PUT 落盘后 GET 掩码：config/掩码面均无原文", () => {
    const home = tempHome();
    const checked = validatePutBody({ apiKeyPlaintext: PLAINTEXT, confirm: true });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const saved = savePatch(home, checked.patch, plainDeps());
    expect(saved.config.connection.hasPlaintextKey).toBe(true);
    const masked = toMaskedConfig(saved);
    expect(JSON.stringify(masked)).not.toContain(PLAINTEXT);
    expect(masked.connection.hasPlaintextKey).toBe(true);
    expect(masked.connection.apiKeyRef).toBe(undefined);
    const diskConfig = readFileSync(join(home, "@wingsky-1/dsh-jev-decide", "config.json"), "utf8");
    expect(diskConfig).not.toContain(PLAINTEXT);
    const reloaded = toMaskedConfig(loadState(home, plainDeps()));
    expect(JSON.stringify(reloaded)).not.toContain(PLAINTEXT);
  });
  it("ENV 引用优先于明文；切轨即折叠清空 secrets", () => {
    const home = tempHome();
    const secret = validatePutBody({ apiKeyPlaintext: PLAINTEXT, confirm: true });
    expect(secret.ok).toBe(true);
    if (!secret.ok) return;
    savePatch(home, secret.patch, plainDeps());
    const ref = validatePutBody({ apiKeyRef: "JEV_TEST_KEY_X1" });
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const saved = savePatch(home, ref.patch, plainDeps());
    const resolved = resolveApiKey(saved, { JEV_TEST_KEY_X1: "EnvSecretValue12345" }, plainDeps());
    expect(resolved).toMatchObject({ key: "EnvSecretValue12345", source: "env" });
    expect(resolveApiKey(saved, {}, plainDeps()).source).toBe("none");
    const secretsDisk = readFileSync(
      join(home, "@wingsky-1/dsh-jev-decide", "secrets.json"),
      "utf8",
    );
    expect(secretsDisk).not.toContain(PLAINTEXT);
  });
  it("落盘权限 0600/0700（R8，POSIX）", () => {
    if (process.platform === "win32") return;
    const home = tempHome();
    const checked = validatePutBody({ apiKeyPlaintext: PLAINTEXT, confirm: true });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    savePatch(home, checked.patch, plainDeps());
    const dir = join(home, "@wingsky-1/dsh-jev-decide");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
  });
  it("日志永无密钥原文", () => {
    const home = tempHome();
    const seen: string[] = [];
    const checked = validatePutBody({ apiKeyPlaintext: PLAINTEXT, confirm: true });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    savePatch(home, checked.patch, depsWithLog(seen));
    // 手改坏形状明文：解析视同无 key 并告警，告警不得带原文。
    const state = loadState(home, plainDeps());
    const BAD_PLAINTEXT = "XxBadShort";
    const tampered = { ...state, plaintext: BAD_PLAINTEXT };
    const out = resolveApiKey(tampered, {}, depsWithLog(seen));
    expect(out.source).toBe("none");
    expect(seen.join("\n")).not.toContain(PLAINTEXT);
    expect(seen.join("\n")).not.toContain(BAD_PLAINTEXT);
  });
});
