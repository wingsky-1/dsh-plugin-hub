/**
 * dsh-provider-usage — unit：#732 抽出的 registry 域纯函数直接打面。
 *
 * - provider-config.ts：seam 目录定位 / settingsPath 下钻 / apiKeyEnv 判读 / 服务就位 /
 *   进程内密钥来源 / 环境变量名
 * - user-adapters.ts：清单项归一 / 清单外壳 / 启用映射归一 / 顶层形态标签 /
 *   取证备份归集与轮转名单 / add 入参规整 / 穿越判定 / 相对路径围栏
 * - registry.ts：替换前收集旧条目 / 契约拒绝文案 / 改名撞名预检 / 旧启用关系快照
 *
 * 纪律：零网络、零真实凭据（凭据链用例经临时 DSH_HOME 隔离，绝不读 ~/.dsh）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  SettingsDescriptor,
  SettingsForms,
  SettingsNamespace,
} from "@deepseek-ai/dsh-settings";
import type { LlmConfigurableProvider } from "@deepseek-ai/dsh-llm";
import {
  trimmedOrUndefined,
  providerApiKeyEnvVar,
  resolveInlineKey,
  findProviderDirEntry,
  drillSettingsPath,
  apiKeyEnvOf,
  seamServicesOf,
  seamDiagnosticOf,
  resolveProviderConfig,
} from "../../../src/server/registry/provider-config.ts";
import {
  toAdapterRecord,
  adapterListOf,
  adapterStateMap,
  describeTopLevelShape,
  collectBackupEntries,
  removableBackupFiles,
  normalizeAdapterFileInput,
  isUntraversedPath,
  containedInHomes,
  ADAPTER_STATE_BACKUP_LIMIT,
} from "../../../src/server/registry/user-adapters.ts";
import {
  collectEntriesByFile,
  invalidAdapterRejection,
  rejectDuplicateName,
  collectWasEnabledProviders,
  makeAdapterRegistry,
} from "../../../src/server/registry/registry.ts";
import type { UsageStatsAdapter } from "../../../src/shared/interface.ts";

/** 合法 v2 契约适配器。 */
function adapter(name: string, providers: string[], file?: string): UsageStatsAdapter {
  return {
    version: 2,
    name,
    label: name,
    providers,
    async fetchData() {
      return {};
    },
    formatCapsule() {
      return "";
    },
    formatPanel() {
      return "";
    },
    ...(file === undefined ? {} : { file }),
  } as unknown as UsageStatsAdapter;
}

/** 官方目录条目（以官方类型构造；displayName 取 provider 名）。 */
function providerEntry(
  provider: string,
  settingsNs: string,
  settingsPath: readonly string[] = [],
): LlmConfigurableProvider {
  return { provider, displayName: provider, settingsNs, settingsPath };
}

/** 官方 SettingsDescriptor（完整字段；seam 只读 ns/value，其余按官方契约补齐）。 */
function descriptor(ns: string, value: unknown): SettingsDescriptor {
  return {
    ns: ns as SettingsNamespace,
    autoGenerate: false,
    schema: {},
    value,
    revision: 1,
    applies: "live",
  };
}

/** 官方 settings 读面（Partial：缺 describe 即 API 漂移用例）。 */
type SettingsFace = Partial<Pick<SettingsForms, "describe">>;

/** seam 的 settings 面：官方派生形状，或 #1163 前的旧 get(ns) 形状（回归用例专用）。 */
type SettingsSeamFake = SettingsFace | { get?: (ns: string) => unknown };

/** credentials 面：官方 catalog 无类型包（见 provider-config.ts 的豁免注释），显式 duck。 */
type CredentialsFace = { resolve?: (ref: string) => Promise<{ value?: string } | undefined> };

/**
 * 显式 unknown 鸭子上下文：llm/settings/credentials 各面经官方类型构造，
 * ctx 本身保持 unknown（seam 的运行时收窄面，不把拼装形状当契约）。
 */
function seamCtx(opts: {
  entries?: LlmConfigurableProvider[];
  settings?: SettingsSeamFake;
  credentials?: CredentialsFace;
}): unknown {
  return {
    ...(opts.entries === undefined
      ? {}
      : { llm: { listConfigurableProviders: () => opts.entries } }),
    get: (name: string): unknown => {
      if (name === "settings") return opts.settings;
      if (name === "credentials") return opts.credentials;
      return undefined;
    },
  };
}

describe("provider-config 进程内密钥来源", () => {
  it("trimmedOrUndefined：去空白；空白串与非串视同无值", () => {
    expect(trimmedOrUndefined("  sk-1  ")).toBe("sk-1");
    expect(trimmedOrUndefined("   ")).toBeUndefined();
    expect(trimmedOrUndefined(42)).toBeUndefined();
  });

  it("providerApiKeyEnvVar：连字符转下划线并大写", () => {
    expect(providerApiKeyEnvVar("opencode-go")).toBe("OPENCODE_GO_API_KEY");
    expect(providerApiKeyEnvVar("deepseek-official")).toBe("DEEPSEEK_OFFICIAL_API_KEY");
  });

  it("resolveInlineKey：显式配置优先于环境变量", () => {
    process.env.RESOLVE_INLINE_TEST_API_KEY = "from-env";
    try {
      expect(resolveInlineKey("resolve-inline-test", "  sk-explicit  ")).toBe("sk-explicit");
      expect(resolveInlineKey("resolve-inline-test")).toBe("from-env");
    } finally {
      delete process.env.RESOLVE_INLINE_TEST_API_KEY;
    }
  });

  it("resolveInlineKey：非 opencode-go 不吃旧名兼容键", () => {
    process.env.OPENCODE_GO_API_KEY = "legacy";
    try {
      expect(resolveInlineKey("resolve-inline-test")).toBeUndefined();
      expect(resolveInlineKey("opencode-go")).toBe("legacy");
    } finally {
      delete process.env.OPENCODE_GO_API_KEY;
    }
  });
});

describe("provider-config seam 定位纯面", () => {
  const ctx = seamCtx({
    entries: [providerEntry("pi-ai-r", "llm-pi-ai", ["providers", "pi-ai-r"])],
    settings: {
      describe: () => [
        descriptor("llm-pi-ai", { providers: { "pi-ai-r": { apiKeyEnv: "RJK_API_KEY" } } }),
      ],
    },
    credentials: { resolve: async () => ({ value: "sk" }) },
  });

  it("findProviderDirEntry：命中本 provider 条目（含 settingsPath）", () => {
    expect(findProviderDirEntry(ctx, "pi-ai-r")?.settingsPath).toEqual(["providers", "pi-ai-r"]);
  });

  it("findProviderDirEntry：ctx 非对象 / 无 llm 面 / 目录无此 provider 均 undefined", () => {
    expect(findProviderDirEntry(undefined, "pi-ai-r")).toBeUndefined();
    expect(findProviderDirEntry({}, "pi-ai-r")).toBeUndefined();
    expect(findProviderDirEntry(ctx, "other")).toBeUndefined();
  });

  it("drillSettingsPath：沿嵌套段下钻，缺段即 undefined", () => {
    expect(drillSettingsPath({ a: { b: { c: 7 } } }, ["a", "b", "c"])).toBe(7);
    expect(drillSettingsPath({ a: {} }, ["a", "missing"])).toBeUndefined();
    expect(drillSettingsPath(undefined, ["a"])).toBeUndefined();
  });

  it("apiKeyEnvOf：非空串收下，空串与非串拒", () => {
    expect(apiKeyEnvOf({ apiKeyEnv: "DEEPSEEK_API_KEY" })).toBe("DEEPSEEK_API_KEY");
    expect(apiKeyEnvOf({ apiKeyEnv: "" })).toBeUndefined();
    expect(apiKeyEnvOf({})).toBeUndefined();
    expect(apiKeyEnvOf(null)).toBeUndefined();
  });

  it("seamServicesOf：settings 读面为 describe()，两服务就位时给出取用面", () => {
    expect(typeof seamServicesOf(ctx)?.settingsGet).toBe("function");
    // 旧 `settings.get(ns)` 形状不再被当作 seam（#1163 回归：静默吃旧接口）
    expect(seamServicesOf({ get: () => undefined })).toBeUndefined();
    // 缺 credentials 服务同样不可用
    expect(seamServicesOf({ describe: () => [] })).toBeUndefined();
    expect(seamServicesOf({})).toBeUndefined();
  });

  it("settingsGet：按 ns 取 describe 条目 value；无该 ns 即 undefined", () => {
    const services = seamServicesOf(ctx);
    expect(services?.settingsGet("llm-pi-ai")).toEqual({
      providers: { "pi-ai-r": { apiKeyEnv: "RJK_API_KEY" } },
    });
    expect(services?.settingsGet("missing-ns")).toBeUndefined();
  });
});

describe("seamDiagnosticOf：服务缺席不报 / 方法不在报（API 漂移 fail-loud）", () => {
  const okCtx = seamCtx({
    settings: { describe: () => [] },
    credentials: { resolve: async () => undefined },
  });

  it("正常：describe + resolve 就位 → 空诊断", () => {
    expect(seamDiagnosticOf(okCtx)).toEqual([]);
  });

  it("settings 服务在但缺 describe → 报 settings 漂移（文案可定位）", () => {
    const out = seamDiagnosticOf(seamCtx({ settings: {} }));
    expect(out).toHaveLength(1);
    expect(out[0]?.service).toBe("settings");
    expect(out[0]?.message).toContain("describe()");
  });

  it("旧 get(ns) 形状 → 报 settings 漂移且点明旧形状（#1163 回归）", () => {
    const out = seamDiagnosticOf(seamCtx({ settings: { get: () => undefined } }));
    expect(out).toHaveLength(1);
    expect(out[0]?.service).toBe("settings");
    expect(out[0]?.message).toContain("get(ns)");
  });

  it("credentials 服务在但缺 resolve → 报 credentials 漂移", () => {
    const out = seamDiagnosticOf(seamCtx({ settings: { describe: () => [] }, credentials: {} }));
    expect(out.map((d) => d.service)).toEqual(["credentials"]);
    expect(out[0]?.message).toContain("resolve(ref)");
  });

  it("两服务同时漂移 → 固定顺序 settings → credentials", () => {
    const out = seamDiagnosticOf(seamCtx({ settings: {}, credentials: {} }));
    expect(out.map((d) => d.service)).toEqual(["settings", "credentials"]);
  });

  it("服务缺席（get 无对象 / ctx 无 get / ctx 非对象）→ 不报，按正常回落处理", () => {
    expect(seamDiagnosticOf(seamCtx({}))).toEqual([]);
    expect(seamDiagnosticOf({ llm: { listConfigurableProviders: () => [] } })).toEqual([]);
    expect(seamDiagnosticOf(undefined)).toEqual([]);
  });
});

/**
 * 在隔离 DSH_HOME + 干净环境变量下执行：V1 链不得命中真实 ~/.dsh 或宿主环境
 * （#1167 评审 P1-2：环境里存在 DEEPSEEK_OFFICIAL_API_KEY 时，known-ref 用例会假红）。
 */
async function withIsolatedCredentials<T>(
  fn: () => Promise<T>,
  extraEnvKeys: readonly string[] = [],
): Promise<T> {
  const keys = ["DEEPSEEK_OFFICIAL_API_KEY", ...extraEnvKeys];
  const prevHome = process.env.DSH_HOME;
  const prevKeys = new Map(keys.map((k) => [k, process.env[k]]));
  const dir = mkdtempSync(join(tmpdir(), "u-usage-provider-config-"));
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

describe("provider-config 凭据解析：describe seam + 已知 ref 兜底", () => {
  it("seam：describe 取 apiKeyEnv 后经 credentials.resolve 取值", async () => {
    const ctx = seamCtx({
      entries: [providerEntry("r-direct", "llm-r")],
      settings: { describe: () => [descriptor("llm-r", { apiKeyEnv: "R_REF" })] },
      credentials: {
        resolve: async (ref: string) => (ref === "R_REF" ? { value: "sk-seam" } : undefined),
      },
    });
    const r = await resolveProviderConfig("r-direct", ctx);
    expect(r.apiKey).toBe("sk-seam");
  });

  it("旧 settings.get 形状不再被当作 seam，且诊断经 onDiagnostic 报出（#1163 回归）", async () => {
    await withIsolatedCredentials(async () => {
      const diagnostics: string[] = [];
      const ctx = seamCtx({
        entries: [providerEntry("r-old", "llm-old")],
        settings: { get: () => ({ apiKeyEnv: "OLD_REF" }) },
        credentials: { resolve: async () => ({ value: "sk-old" }) },
      });
      const r = await resolveProviderConfig("r-old", ctx, undefined, (message) => {
        diagnostics.push(message);
      });
      expect(r.apiKey).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("get(ns)");
    }, ["R_OLD_API_KEY"]);
  });

  it("服务缺席（无 settings/credentials）不产生诊断，按正常回落后走 V1 链", async () => {
    const diagnostics: string[] = [];
    const ctx = seamCtx({ entries: [providerEntry("r-absent", "llm-absent")] });
    const r = await resolveProviderConfig("r-absent", ctx, undefined, (message) =>
      diagnostics.push(message),
    );
    expect(r.apiKey).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it("已知 provider ref 兜底：settings 缺席时仍从 credentials 取 DEEPSEEK_API_KEY", async () => {
    const calls: string[] = [];
    const ctx = {
      get: (name: string) =>
        name === "credentials"
          ? {
              resolve: async (ref: string) => {
                calls.push(ref);
                return ref === "DEEPSEEK_API_KEY" ? { value: "sk-known" } : undefined;
              },
            }
          : undefined,
    };
    await withIsolatedCredentials(async () => {
      const r = await resolveProviderConfig("deepseek-official", ctx);
      expect(r.apiKey).toBe("sk-known");
      expect(calls).toEqual(["DEEPSEEK_API_KEY"]);
    });
  });

  it("非已知 provider 不触发已知 ref 兜底", async () => {
    const calls: string[] = [];
    const ctx = {
      get: () => ({
        resolve: async (ref: string) => {
          calls.push(ref);
          return { value: "x" };
        },
      }),
    };
    await withIsolatedCredentials(async () => {
      const r = await resolveProviderConfig("mystery-provider", ctx);
      expect(r.apiKey).toBeUndefined();
      expect(calls).toEqual([]);
    });
  });

  it("describe 以 redactSecrets:true 读取（最小权限）", async () => {
    const seen: unknown[] = [];
    const ctx = {
      llm: {
        listConfigurableProviders: () => [
          { provider: "r-redact", settingsNs: "llm-redact", settingsPath: [] },
        ],
      },
      get: (name: string) =>
        name === "settings"
          ? {
              describe: (options: unknown) => {
                seen.push(options);
                return [{ ns: "llm-redact", value: { apiKeyEnv: "R_REF" } }];
              },
            }
          : { resolve: async () => ({ value: "sk" }) },
    };
    await withIsolatedCredentials(async () => {
      await resolveProviderConfig("r-redact", ctx);
    });
    expect(seen).toEqual([{ redactSecrets: true }]);
  });

  it("describe 抛错 → seam 回落而非 reject（仍能走 known-ref 兜底）", async () => {
    const ctx = {
      llm: {
        listConfigurableProviders: () => [
          { provider: "deepseek-official", settingsNs: "llm-deepseek", settingsPath: [] },
        ],
      },
      get: (name: string) =>
        name === "settings"
          ? {
              describe: () => {
                throw new Error("describe-boom");
              },
            }
          : {
              resolve: async (ref: string) =>
                ref === "DEEPSEEK_API_KEY" ? { value: "sk-known" } : undefined,
            },
    };
    await withIsolatedCredentials(async () => {
      const r = await resolveProviderConfig("deepseek-official", ctx);
      expect(r.apiKey).toBe("sk-known");
    });
  });
});

describe("user-adapters 清单归一纯面", () => {
  it("toAdapterRecord：四字段齐备成条目，label 缺省回落 id", () => {
    const rec = toAdapterRecord({ id: "a", providers: ["p"], file: "/x.mjs" });
    expect(rec).toEqual({ id: "a", label: "a", providers: ["p"], file: "/x.mjs" });
  });

  it("toAdapterRecord：providers 剔空串与非串，剔空后为空即弃条目", () => {
    expect(
      toAdapterRecord({ id: "a", providers: ["p", "", 3], file: "/x.mjs" })?.providers,
    ).toEqual(["p"]);
    expect(toAdapterRecord({ id: "a", providers: [], file: "/x.mjs" })).toBeUndefined();
  });

  it("toAdapterRecord：缺 id / 缺 file / 非对象皆弃", () => {
    expect(toAdapterRecord({ providers: ["p"], file: "/x.mjs" })).toBeUndefined();
    expect(toAdapterRecord({ id: "a", providers: ["p"] })).toBeUndefined();
    expect(toAdapterRecord(null)).toBeUndefined();
    expect(toAdapterRecord([1])).toBeUndefined();
  });

  it("adapterListOf：adapters 非数组或顶层非对象皆 undefined", () => {
    expect(adapterListOf({ adapters: [{ id: "a" }] })).toEqual([{ id: "a" }]);
    expect(adapterListOf({ adapters: "x" })).toBeUndefined();
    expect(adapterListOf(null)).toBeUndefined();
  });
});

describe("user-adapters 启用状态归一纯面", () => {
  it("adapterStateMap：null 保留为显式清空，非空串保留，其余丢弃", () => {
    expect(adapterStateMap({ p1: "a", p2: null, p3: "", p4: 7, p5: {} })).toEqual({
      p1: "a",
      p2: null,
    });
  });

  it("adapterStateMap：空 provider 键丢弃", () => {
    expect(adapterStateMap({ "": "a", p: "b" })).toEqual({ p: "b" });
  });

  it("describeTopLevelShape：null / array / 其它类型各有标签", () => {
    expect(describeTopLevelShape(null)).toBe("null");
    expect(describeTopLevelShape([])).toBe("array");
    expect(describeTopLevelShape("x")).toBe("string");
    expect(describeTopLevelShape(7)).toBe("number");
  });
});

describe("user-adapters 取证备份轮转纯面", () => {
  it("collectBackupEntries：只收 prefix+数字(可选-序号) 形态并按 (ts, seq) 升序", () => {
    const out = collectBackupEntries(
      [
        "adapter-state.json.bak-20",
        "adapter-state.json.bak-3",
        "adapter-state.json.bak-10-2",
        "other",
      ],
      "/d",
      "adapter-state.json.bak-",
    );
    expect(out.map((e) => e.timestamp)).toEqual([3, 10, 20]);
  });

  it("removableBackupFiles：受保护新备份不删，其余超上限部分取最老", () => {
    const names = [10, 20, 30, 40, 50, 60].map((ts) => `adapter-state.json.bak-${ts}`);
    const entries = collectBackupEntries(names, "/d", "adapter-state.json.bak-");
    const keep = ADAPTER_STATE_BACKUP_LIMIT - 1;
    const out = removableBackupFiles(entries, "/d/adapter-state.json.bak-60");
    expect(out).toHaveLength(entries.length - keep - 1);
    expect(out[0]).toBe("/d/adapter-state.json.bak-10");
  });
});

describe("user-adapters add 入参判定纯面", () => {
  it("normalizeAdapterFileInput：非串 / 空串 / 含 NUL 皆拒", () => {
    expect(normalizeAdapterFileInput("  /a/b.mjs ")).toBe("/a/b.mjs");
    expect(normalizeAdapterFileInput("   ")).toBeUndefined();
    expect(normalizeAdapterFileInput("/a\u0000b")).toBeUndefined();
    expect(normalizeAdapterFileInput(7)).toBeUndefined();
  });

  it("isUntraversedPath：a/../b 与 ./x 判为穿越（禁），规整路径放行", () => {
    expect(isUntraversedPath("/a/../b")).toBe(false);
    expect(isUntraversedPath("./x")).toBe(false);
    expect(isUntraversedPath("/a/b/c.mjs")).toBe(true);
  });

  it("containedInHomes：DSH_HOME 之内放行，之外拒", () => {
    expect(containedInHomes("/home/u", "/home/u/plugins/a.mjs")).toBe("/home/u/plugins/a.mjs");
    expect(containedInHomes("/home/u", "/etc/passwd")).toBeUndefined();
  });
});

describe("registry 替换预检纯面", () => {
  const file = "/u/a.mjs";

  it("collectEntriesByFile：跨 provider 桶按 name 去重收集本文件条目", () => {
    const a = {
      adapter: adapter("n", ["p1"]),
      name: "n",
      label: "n",
      providers: ["p1"],
      source: "user-file" as const,
      file,
    };
    const map = collectEntriesByFile(
      new Map([
        ["p1", [a]],
        ["p2", [a]],
      ]),
      file,
    );
    expect([...map.keys()]).toEqual(["n"]);
  });

  it("invalidAdapterRejection：契约失败给出定稿文案", () => {
    const out = invalidAdapterRejection({ version: 1 });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.code).toBe("invalid-adapter");
    expect(out.ok === false && out.detail).toContain("契约校验失败");
  });

  it("rejectDuplicateName：新名属本文件旧名 → 放行（null）", () => {
    const old = new Map([["n", {} as never]]);
    expect(rejectDuplicateName(adapter("n", ["p"]), old, new Set(["n"]))).toBeNull();
  });

  it("rejectDuplicateName：新名被其他来源占用 → 拒绝并保留旧条目", () => {
    const out = rejectDuplicateName(adapter("n", ["p"]), new Map(), new Set(["n"]));
    expect(out?.ok).toBe(false);
    expect(out?.ok === false && out.code).toBe("duplicate-name");
    expect(out?.ok === false && out.detail).toContain("旧条目保留");
  });

  it("collectWasEnabledProviders：只收本文件旧条目当前确为启用者的 provider", () => {
    const old = new Map([
      [
        "n",
        {
          adapter: adapter("n", ["p1", "p2"]),
          name: "n",
          label: "n",
          providers: ["p1", "p2"],
          source: "user-file" as const,
          file,
        },
      ],
    ]);
    const out = collectWasEnabledProviders(
      old,
      new Map([
        ["p1", "n"],
        ["p2", "other"],
      ]),
    );
    expect([...out]).toEqual(["p1"]);
  });
});
describe("registry：seam 诊断登记 health.errors（去重 / 同 key 覆盖 / 正常与缺席不报）", () => {
  const entries = [providerEntry("r-drift", "llm-drift")];

  it("settings 漂移经 recordError(provider-config,load) 进 snapshot().errors；同签名只登记一次", async () => {
    const diag: string[] = [];
    const registry = makeAdapterRegistry({ diag: (m) => diag.push(m) });
    const ctx = seamCtx({ entries, settings: {} });
    await registry.resolveProviderConfig("r-drift", ctx);
    await registry.resolveProviderConfig("r-drift", ctx);
    const errors = registry.snapshot().errors.filter((e) => e.key === "provider-config");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("load");
    expect(errors[0]?.message).toContain("describe()");
    expect(typeof errors[0]?.at).toBe("number");
    // diag 出口只响一次（去重防每轮取数刷时间戳/日志）
    expect(diag.filter((m) => m.includes("provider-config"))).toHaveLength(1);
  });

  it("恢复后同一漂移再次出现 → 重新登记（去重状态复位，错误条目保留）", async () => {
    const diag: string[] = [];
    const registry = makeAdapterRegistry({ diag: (m) => diag.push(m) });
    const drift = seamCtx({ entries, settings: {} });
    const normal = seamCtx({
      entries,
      settings: { describe: () => [] },
      credentials: { resolve: async () => undefined },
    });
    await registry.resolveProviderConfig("r-drift", drift);
    await registry.resolveProviderConfig("r-drift", normal); // 恢复：复位去重状态
    await registry.resolveProviderConfig("r-drift", drift); // 同一漂移再次出现
    expect(diag.filter((m) => m.includes("provider-config"))).toHaveLength(2);
    const errors = registry.snapshot().errors.filter((e) => e.key === "provider-config");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("describe()");
  });

  it("正常 seam 与服务缺席均不登记 provider-config 错误", async () => {
    const registry = makeAdapterRegistry({ diag: () => {} });
    await registry.resolveProviderConfig(
      "r-drift",
      seamCtx({
        entries,
        settings: { describe: () => [] },
        credentials: { resolve: async () => undefined },
      }),
    );
    await registry.resolveProviderConfig("r-drift", seamCtx({ entries }));
    expect(registry.snapshot().errors.filter((e) => e.key === "provider-config")).toEqual([]);
  });

  it("签名变化时同 key 覆盖（settings 漂移 → credentials 漂移）", async () => {
    const registry = makeAdapterRegistry({ diag: () => {} });
    await registry.resolveProviderConfig("r-drift", seamCtx({ entries, settings: {} }));
    await registry.resolveProviderConfig(
      "r-drift",
      seamCtx({ entries, settings: { describe: () => [] }, credentials: {} }),
    );
    const errors = registry.snapshot().errors.filter((e) => e.key === "provider-config");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("resolve(ref)");
  });
});
