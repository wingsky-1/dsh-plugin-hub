/**
 * dsh-provider-usage — integration：适配器域组合根三维度（#768 计划表 rev2 D4 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/adapters 门面活装配）；本文件零落盘
 *（不断言文件产物，mkdtemp 不适用——产物零污染天然成立）。三维度：
 * - D4一 经域门面装配：三内置适配器只经 server/adapters/interface.ts，不直连
 *   .mjs 实现文件，不走旧 domain1 入口；apply/apply.ts、apply/index.ts、
 *   shared/config.ts 的适配器消费收口本门面；门面禁整文件 re-export；
 * - D4二 契约校验 fail-fast：非法适配器拒收（register 返回 false）+ 内置装配
 *   任一被拒即抛（registerBuiltinAdapters）；裸调 register 忽略返回值即红；
 * - D4三 .mjs 不动契约 + 覆盖率锚另立：三内置 .mjs 经新门面仍满足 v2 形状，
 *   构建拷贝（prepare-lib-entry）与变异排除（mutation-topology）同步改址。
 *
 * 每条附判据句（把 X 改坏必须红）；红证明见同文件“探针：脏输入必被 flag”。
 * 文本哨兵仅锚真实 ABI（provider 名/适配器 id/lib 拷贝路径/变异排除路径/装配调用），
 * 不做风格断言。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { containsAny, hasExportStar } from "../../helpers.ts";
import {
  openCodeGoAdapter,
  deepSeekOfficialAdapter,
  zaiCodingCnAdapter,
  registerBuiltinAdapters,
  OPENCODE_GO_ADAPTER_ID,
  DEEPSEEK_OFFICIAL_PROVIDER,
  DEEPSEEK_OFFICIAL_ADAPTER_ID,
  ZAI_CODING_CN_PROVIDER,
  ZAI_CODING_CN_ADAPTER_ID,
} from "../../../src/server/adapters/interface.ts";
import { OPENCODE_GO_PROVIDER } from "../../../src/shared/interface.ts";
import { OPENCODE_GO_PROVIDER as AdaptersProvider } from "../../../src/server/adapters/interface.ts";
import { registerBuiltinAdapters as ImplRegister } from "../../../src/server/adapters/register.ts";
import {
  openCodeGoAdapter as MjsOpenCodeGo,
  OPENCODE_GO_PROVIDER as MjsProvider,
} from "../../../src/server/adapters/opencode-go.mjs";
import { deepSeekOfficialAdapter as MjsDeepSeek } from "../../../src/server/adapters/deepseek-official.mjs";
import { zaiCodingCnAdapter as MjsZai } from "../../../src/server/adapters/zai-coding-cn.mjs";
import * as adaptersDepsNs from "../../../src/server/adapters/deps.ts";
import type { AdapterHostUtils, BuiltinRegistryPort } from "../../../src/server/adapters/deps.ts";
import { makeAdapterRegistry } from "../../../src/server/registry/interface.ts";
import { describeUsageStatsAdapterShape, ADAPTER_UTILS } from "../../../src/shared/interface.ts";
import type { UsageStatsAdapter } from "../../../src/shared/interface.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const pkgDir = join(here, "..", "..", "..");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applyFaceSrc = readFileSync(join(srcDir, "apply", "index.ts"), "utf8");
const sharedConfigSrc = readFileSync(join(srcDir, "shared", "config.ts"), "utf8");
const adaptersFaceSrc = readFileSync(join(srcDir, "server", "adapters", "interface.ts"), "utf8");
const adaptersRegisterSrc = readFileSync(join(srcDir, "server", "adapters", "register.ts"), "utf8");
const prepareLibEntrySrc = readFileSync(join(pkgDir, "scripts", "prepare-lib-entry.ts"), "utf8");
const topologySrc = readFileSync(
  join(repoRoot, "scripts", "data", "mutation-topology.json"),
  "utf8",
);

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：窄面在此复用名称。 */
const hostUtils: AdapterHostUtils = ADAPTER_UTILS;
const registryPort: BuiltinRegistryPort = makeAdapterRegistry();

/** 旧门面判据：任一旧 domain1/adapters 引用残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain1/adapters"]);
}

/** 直连判据：绕过门面直引 .mjs 实现文件即红。 */
function directMjsRef(src: string): boolean {
  return /adapters\/[a-z0-9-]+\.mjs/.test(src);
}

/** 装配 fail-fast 判据：组合根未走 registerBuiltinAdapters 即红。 */
function hasFailFast(src: string): boolean {
  return src.includes("registerBuiltinAdapters(");
}

/** 三内置（门面出口，.mjs 零改动的同一引用）。 */
const BUILTINS: readonly UsageStatsAdapter[] = [
  openCodeGoAdapter,
  deepSeekOfficialAdapter,
  zaiCodingCnAdapter,
];

describe("D4一 经 server/adapters 域门面装配", () => {
  it("组合根只经新门面取内置（旧入口残留必须红）", () => {
    expect(usesOldFace(applySrc)).toBe(false);
    expect(usesOldFace(applyFaceSrc)).toBe(false);
    expect(usesOldFace(sharedConfigSrc)).toBe(false);
    expect(applySrc.includes("server/adapters/interface")).toBe(true);
  });

  it("组合根不直连 .mjs 实现文件（直引必须红）", () => {
    expect(directMjsRef(applySrc)).toBe(false);
    expect(directMjsRef(applyFaceSrc)).toBe(false);
    expect(directMjsRef(sharedConfigSrc)).toBe(false);
  });

  it("门面收口：interface 与 .mjs 同一引用（包装即红）", () => {
    expect(openCodeGoAdapter).toBe(MjsOpenCodeGo);
    expect(deepSeekOfficialAdapter).toBe(MjsDeepSeek);
    expect(zaiCodingCnAdapter).toBe(MjsZai);
    expect(registerBuiltinAdapters).toBe(ImplRegister);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    const codeLines = adaptersFaceSrc
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith("*"));
    expect(hasExportStar(codeLines)).toBe(false);
  });

  it("ABI 字面：provider 名与适配器 id（静默改名必须红）", () => {
    // #768 B1a 等值哨兵：mjs:24 字面与 shared/provider.ts:13 同值（双字面漂移必须红）
    expect(MjsProvider).toBe(OPENCODE_GO_PROVIDER);
    expect(OPENCODE_GO_PROVIDER).toBe("opencode-go");
    // #768 A波7：旧址门面仍透出同一引用（兼容门面）
    expect(AdaptersProvider).toBe(OPENCODE_GO_PROVIDER);
    expect(OPENCODE_GO_ADAPTER_ID).toBe("opencode-go-builtin");
    expect(DEEPSEEK_OFFICIAL_PROVIDER).toBe("deepseek-official");
    expect(DEEPSEEK_OFFICIAL_ADAPTER_ID).toBe("deepseek-official-builtin");
    expect(ZAI_CODING_CN_PROVIDER).toBe("zai-coding-cn");
    expect(ZAI_CODING_CN_ADAPTER_ID).toBe("zai-coding-cn-builtin");
  });

  it("注入面窄面：ADAPTER_UTILS 满足 8 键口径（缺键必须红）", () => {
    for (const key of [
      "miniAreaSvg",
      "fin",
      "dayKey",
      "lastNDayKeys",
      "escHtml",
      "escAttr",
      "niceDomain",
      "trendOf",
    ] as const) {
      expect(typeof (hostUtils as Record<string, unknown>)[key]).toBe("function");
    }
  });

  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(adaptersDepsNs)).toEqual([]);
  });
});

describe("D4二 契约校验 fail-fast（非法适配器拒收必须红）", () => {
  let builtinResults: boolean[];
  let illegalResults: boolean[];
  let duplicateRejected: boolean;
  let builtinNames: (string | undefined)[];

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    builtinResults = BUILTINS.map((adapter) => reg.register(adapter, "builtin"));
    builtinNames = BUILTINS.map((adapter) => adapter.name);
    const illegals: unknown[] = [
      { version: 1 },
      {
        version: 2,
        name: "ab!!",
        providers: ["p"],
        fetchData: async () => ({}),
        formatCapsule: () => "",
        formatPanel: () => "",
      },
      {
        version: 2,
        name: "x",
        providers: ["p"],
        fetchData: async () => ({}),
        formatCapsule: () => "",
        formatPanel: () => "",
      },
      {
        version: 2,
        name: "ok-name",
        providers: [],
        fetchData: async () => ({}),
        formatCapsule: () => "",
        formatPanel: () => "",
      },
      {
        version: 2,
        name: "ok-name",
        providers: ["p"],
        formatCapsule: () => "",
        formatPanel: () => "",
      },
      {
        version: 2,
        name: "ok-name",
        providers: ["p"],
        fetchData: async () => ({}),
        formatPanel: () => "",
      },
      {
        version: 2,
        name: "ok-name",
        providers: ["p"],
        fetchData: async () => ({}),
        formatCapsule: () => "",
      },
      null,
    ];
    illegalResults = illegals.map((candidate) =>
      reg.register(candidate, "user-file", "/tmp/d4-illegal.mjs"),
    );
    const dupReg = makeAdapterRegistry();
    dupReg.register(BUILTINS[0], "builtin");
    duplicateRejected = dupReg.register(BUILTINS[0], "builtin");
  });

  it("三内置经新门面注册成功（改坏 .mjs 契约必须红）", () => {
    expect(builtinResults).toEqual([true, true, true]);
  });

  it("非法形状逐条拒收（放行任一条必须红）", () => {
    expect(illegalResults).toEqual([false, false, false, false, false, false, false, false]);
  });

  it("同名重复注册拒绝（放行必须红）", () => {
    expect(duplicateRejected).toBe(false);
  });

  it("三内置名稳定（改名必须红）", () => {
    expect(builtinNames).toEqual([
      "opencode-go-builtin",
      "deepseek-official-builtin",
      "zai-coding-cn-builtin",
    ]);
  });

  it("fail-fast：内置被拒即抛并点名（吞错必须红）", () => {
    const deadPort: BuiltinRegistryPort = { register: () => false };
    expect(() => registerBuiltinAdapters(deadPort, [openCodeGoAdapter])).toThrow(
      "opencode-go-builtin",
    );
    const livePort: BuiltinRegistryPort = { register: () => true };
    expect(() => registerBuiltinAdapters(livePort, BUILTINS)).not.toThrow();
    expect(() => registerBuiltinAdapters(registryPort, [])).not.toThrow();
  });

  it("组合根走 fail-fast 装配（裸调 register 必须红）", () => {
    expect(hasFailFast(applySrc)).toBe(true);
    expect(hasFailFast(adaptersRegisterSrc)).toBe(true);
  });
});

describe("D4三 .mjs 不动契约 + 覆盖率锚另立", () => {
  it("三内置经新门面仍满足 v2 形状（分叉必须红）", () => {
    for (const adapter of BUILTINS) {
      expect(describeUsageStatsAdapterShape(adapter)).toBe(null);
    }
  });

  it("构建拷贝改址 server/adapters（旧址残留必须红）", () => {
    expect(prepareLibEntrySrc.includes("lib/server/adapters")).toBe(true);
    expect(prepareLibEntrySrc.includes("domain1/adapters")).toBe(false);
  });

  it("变异排除改址 server/adapters（旧址残留必须红）", () => {
    for (const name of ["deepseek-official", "opencode-go", "zai-coding-cn"]) {
      expect(topologySrc.includes("src/server/adapters/" + name + ".mjs")).toBe(true);
      expect(topologySrc.includes("src/domain1/adapters/" + name + ".mjs")).toBe(false);
    }
  });
});

describe("探针：脏输入必被 flag（detector 失明则本段先红）", () => {
  it("旧门面 detector 对脏输入有效", () => {
    expect(usesOldFace('import { x } from "../domain1/adapters/interface.ts"')).toBe(true);
    expect(usesOldFace('import { x } from "../server/adapters/interface.ts"')).toBe(false);
  });

  it("直连 detector 对脏输入有效", () => {
    expect(directMjsRef('import { a } from "./adapters/opencode-go.mjs"')).toBe(true);
    expect(directMjsRef('import { a } from "./adapters/interface.ts"')).toBe(false);
  });

  it("fail-fast detector 对脏输入有效", () => {
    expect(hasFailFast("registerBuiltinAdapters(registry, builtins)")).toBe(true);
    expect(hasFailFast('registry.register(openCodeGoAdapter, "builtin")')).toBe(false);
  });

  it("export * detector 对脏输入有效", () => {
    expect(hasExportStar(['export * from "./x.mjs"'])).toBe(true);
    expect(hasExportStar(['export { a } from "./x.mjs"'])).toBe(false);
  });
});
