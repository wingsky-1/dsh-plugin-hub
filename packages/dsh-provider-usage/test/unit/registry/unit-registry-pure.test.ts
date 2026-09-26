/**
 * dsh-provider-usage — unit：#732 抽出的 registry 域纯函数直接打面。
 *
 * - provider-config.ts：seam 目录定位 / settingsPath 下钻 / apiKeyEnv 判读 / 服务就位 /
 *   进程内密钥来源 / 环境变量名
 * - user-adapters.ts：清单项归一 / 清单外壳 / 启用映射归一 / 顶层形态标签 /
 *   取证备份归集与轮转名单 / add 入参规整 / 穿越判定 / 相对路径围栏
 * - registry.ts：替换前收集旧条目 / 契约拒绝文案 / 改名撞名预检 / 旧启用关系快照
 *
 * 纪律：零 I/O（seam 与 add 路径全为纯判定）、零网络、零凭据。
 */
import { describe, expect, it } from "vitest";
import {
  trimmedOrUndefined,
  providerApiKeyEnvVar,
  resolveInlineKey,
  findProviderDirEntry,
  drillSettingsPath,
  apiKeyEnvOf,
  seamServicesOf,
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
  const ctx = {
    llm: {
      listConfigurableProviders: () => [
        { provider: "pi-ai-r", settingsNs: "llm-pi-ai", settingsPath: ["providers", "pi-ai-r"] },
      ],
    },
    get: (name: string) =>
      name === "settings"
        ? { get: () => ({ providers: { "pi-ai-r": { apiKeyEnv: "RJK_API_KEY" } } }) }
        : { resolve: async () => ({ value: "sk" }) },
  };

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

  it("seamServicesOf：两服务就位时给出取用面，缺一即 undefined", () => {
    expect(typeof seamServicesOf(ctx)?.settingsGet).toBe("function");
    expect(seamServicesOf({ get: () => undefined })).toBeUndefined();
    expect(seamServicesOf({})).toBeUndefined();
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
