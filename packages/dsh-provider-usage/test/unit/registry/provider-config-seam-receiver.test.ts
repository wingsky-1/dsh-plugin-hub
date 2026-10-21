/**
 * dsh-provider-usage — unit：凭据 seam 的 credentials.resolve 取用面（#1167 回归）。
 *
 * 独立成文件而非并进 registry-pure.test.ts：该文件的 seam 用例区在 #1169 中重写，
 * 新文件可无冲突叠加，也让这条回归的判据面更聚焦。
 *
 * 回归事实：宿主 LocalCredentialProvider.resolve 是读 this.values 的原型方法，
 * 裸函数取出再调用会丢 receiver → TypeError → /stats 504 → 前端无数据。
 *
 * 纪律：零网络、零真实凭据（临时 DSH_HOME + 干净环境变量隔离）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProviderConfig } from "../../../src/server/registry/provider-config.ts";

/**
 * 在隔离 DSH_HOME + 干净环境变量下执行，避免 V1 链命中真实 ~/.dsh 或宿主环境。
 * 与 registry-pure.test.ts 的同名 helper 同口径；不跨文件 import（测试文件互引会重复求值）。
 */
async function withIsolatedCredentials<T>(
  fn: () => Promise<T>,
  extraEnvKeys: readonly string[] = [],
): Promise<T> {
  const keys = ["DEEPSEEK_OFFICIAL_API_KEY", ...extraEnvKeys];
  const prevHome = process.env.DSH_HOME;
  const prevKeys = new Map(keys.map((k) => [k, process.env[k]]));
  const dir = mkdtempSync(join(tmpdir(), "u-usage-provider-config-seam-"));
  process.env.DSH_HOME = dir;
  for (const k of keys) delete process.env[k];
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    for (const [k, v] of prevKeys) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("provider-config 凭据 seam：credentials.resolve 取用面", () => {
  it("resolve 依赖 this 时仍能取值（#1167 回归：裸函数丢 receiver）", async () => {
    // 形态对齐宿主 LocalCredentialProvider：resolve 读 this.values，不是箭头函数。
    // 修复前这里抛 TypeError: Cannot read properties of undefined (reading 'get')。
    const values = new Map([["R_BOUND_REF", "sk-bound"]]);
    const ctx = {
      llm: {
        listConfigurableProviders: () => [
          { provider: "r-bound", settingsNs: "llm-bound", settingsPath: [] },
        ],
      },
      get: (name: string) =>
        name === "settings"
          ? { describe: () => [{ ns: "llm-bound", value: { apiKeyEnv: "R_BOUND_REF" } }] }
          : {
              values,
              resolve(ref: string) {
                const v = this.values.get(ref);
                return Promise.resolve(v === undefined ? undefined : { value: v });
              },
            },
    };
    await withIsolatedCredentials(async () => {
      const r = await resolveProviderConfig("r-bound", ctx);
      expect(r.apiKey).toBe("sk-bound");
    }, ["R_BOUND_API_KEY"]);
  });

  it("resolve reject 被吞掉，不击穿取数入口（回落后续链）", async () => {
    const ctx = {
      llm: {
        listConfigurableProviders: () => [
          { provider: "r-reject", settingsNs: "llm-reject", settingsPath: [] },
        ],
      },
      get: (name: string) =>
        name === "settings"
          ? { describe: () => [{ ns: "llm-reject", value: { apiKeyEnv: "R_REJECT_REF" } }] }
          : { resolve: () => Promise.reject(new Error("resolve-boom")) },
    };
    await withIsolatedCredentials(async () => {
      const r = await resolveProviderConfig("r-reject", ctx);
      expect(r.apiKey).toBeUndefined();
    }, ["R_REJECT_API_KEY"]);
  });
});
