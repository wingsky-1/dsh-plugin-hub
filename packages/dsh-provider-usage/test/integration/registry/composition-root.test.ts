/**
 * dsh-provider-usage — integration：注册表域组合根三维度（#768 计划表 rev2 D7 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/registry 门面活装配）；落盘一律进
 * mkdtempSync 隔离目录（产物零污染）。三维度：
 * - D7一 经 server/registry 域门面装配：候选/持久化/加载校验/热更新/密钥链/路径
 *   一族只经 server/registry/interface.ts，不走旧 domain1/registry 入口；
 *   apply/apply.ts、apply/index.ts、server/pipeline/stats-service.ts、
 *   server/adapters/deps.ts、server/data-routes/adapters.ts 的注册表消费收口新门面；
 *   门面禁整文件 re-export；包导出面（apply/index.ts 转发名）收窄后集合（B波）。
 * - D7二 候选 + 唯一启用 + 错误登记：同 provider 多候选任一时刻一启用
 *   （双启用必须红）+ 非法/重名拒收登记错误（删登记即红）。
 * - D7三 deps 注入面窄面：RegistryDiag/RegistrySanitize 命名接缝与块内联
 *   双生子（makeAdapterRegistry Options 保留内联函数类型，不 import type 本面）；
 *   deps.ts 纯类型面运行时零出口。
 *
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupIsolatedDirs, containsAny, hasExportStar, makeIsolatedDir } from "../../helpers.ts";
import {
  makeAdapterRegistry,
  userAdaptersFile,
  adapterStateFile,
  parseUserAdapters,
  readUserAdapters,
  readAdapterStateResult,
  readAdapterState,
  writeAdapterState,
  resolveAddAdapterFile,
  loadUserHostAdapterFile,
  loadUserAdapterChecked,
  readStamp,
  stampEqual,
  loadAndValidateAdapter,
  HotReloadableAdapter,
  credentialsFile,
  opencodeAuthFile,
  resolveProviderConfig,
  pluginHome,
  expandHomePath,
  resolvePath,
} from "../../../src/server/registry/interface.ts";
import { makeAdapterRegistry as ImplMake } from "../../../src/server/registry/registry.ts";
import {
  userAdaptersFile as ImplUserAdaptersFile,
  adapterStateFile as ImplAdapterStateFile,
  parseUserAdapters as ImplParse,
  readUserAdapters as ImplReadList,
  readAdapterStateResult as ImplReadResult,
  readAdapterState as ImplReadState,
  writeAdapterState as ImplWriteState,
  resolveAddAdapterFile as ImplResolveAdd,
} from "../../../src/server/registry/user-adapters.ts";
import {
  loadUserHostAdapterFile as ImplLoadFile,
  loadUserAdapterChecked as ImplLoadChecked,
} from "../../../src/server/registry/user-adapter-loader.ts";
import {
  readStamp as ImplReadStamp,
  stampEqual as ImplStampEqual,
  loadAndValidateAdapter as ImplLoadValidate,
  HotReloadableAdapter as ImplHotReload,
} from "../../../src/server/registry/hotreload.ts";
import {
  credentialsFile as ImplCredFile,
  opencodeAuthFile as ImplAuthFile,
  resolveProviderConfig as ImplResolveCfg,
} from "../../../src/server/registry/provider-config.ts";
import {
  pluginHome as ImplPluginHome,
  expandHomePath as ImplExpand,
  resolvePath as ImplResolvePath,
} from "../../../src/server/registry/path-resolve.ts";
import * as registryDepsNs from "../../../src/server/registry/deps.ts";
import type { RegistryDiag, RegistrySanitize } from "../../../src/server/registry/deps.ts";
import type { UsageStatsAdapter } from "../../../src/shared/interface.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applyFaceSrc = readFileSync(join(srcDir, "apply", "index.ts"), "utf8");
const pipelineStatsSrc = readFileSync(
  join(srcDir, "server", "pipeline", "stats-service.ts"),
  "utf8",
);
const adaptersDepsSrc = readFileSync(join(srcDir, "server", "adapters", "deps.ts"), "utf8");
const routesAdaptersSrc = readFileSync(
  join(srcDir, "server", "data-routes", "adapters.ts"),
  "utf8",
);
const registryFaceSrc = readFileSync(join(srcDir, "server", "registry", "interface.ts"), "utf8");
const registryDepsSrc = readFileSync(join(srcDir, "server", "registry", "deps.ts"), "utf8");
const unitStatsTestSrc = readFileSync(
  join(srcDir, "..", "test", "unit", "pipeline", "unit-stats-service.test.ts"),
  "utf8",
);
const topologySrc = readFileSync(
  join(repoRoot, "scripts", "data", "mutation-topology.json"),
  "utf8",
);

/** 旧门面判据：任一旧 domain1/registry 引用残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain1/registry"]);
}

/** 唯一启用探针：同 provider 有两行以上 enabled=true 即双启用（必须红）。 */
function hasDualEnabled(
  infos: Array<{ providers: string[]; enabled: boolean }>,
  provider: string,
): boolean {
  return infos.filter((i) => i.providers.includes(provider) && i.enabled).length > 1;
}

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：窄面在此复用名称。 */
const diagSeam: RegistryDiag = () => undefined;
const sanitizeSeam: RegistrySanitize = (s) => s;

function mkAdapter(overrides: Record<string, unknown> = {}): UsageStatsAdapter {
  return {
    version: 2,
    name: "adapter-a",
    label: "A",
    providers: ["prov-x"],
    fetchData: async () => ({ v: 1 }),
    formatCapsule: () => "<b>a</b>",
    formatPanel: () => "<p>a</p>",
    ...overrides,
  } as unknown as UsageStatsAdapter;
}

const tmpDirs: string[] = [];
function isolatedDir(prefix: string): string {
  return makeIsolatedDir(tmpDirs, prefix);
}
afterEach(() => {
  cleanupIsolatedDirs(tmpDirs);
});

describe("D7一 经 server/registry 域门面装配", () => {
  it("组合根只经新门面取注册表（旧入口残留必须红）", () => {
    expect(usesOldFace(applySrc)).toBe(false);
    expect(usesOldFace(applyFaceSrc)).toBe(false);
    expect(usesOldFace(pipelineStatsSrc)).toBe(false);
    expect(usesOldFace(adaptersDepsSrc)).toBe(false);
    expect(usesOldFace(routesAdaptersSrc)).toBe(false);
    expect(usesOldFace(unitStatsTestSrc)).toBe(false);
    expect(applySrc.includes("server/registry/interface")).toBe(true);
    expect(applyFaceSrc.includes("server/registry/interface")).toBe(true);
    // 域内相对引用（server/pipeline、server/adapters 与 server/data-routes 经
    //   ../registry 取本域门面，字面不含 server/ 前缀，判据按相对形态锚定，
    //   改回旧址即红；D10 起 data-routes 亦为 server 内域）
    expect(pipelineStatsSrc.includes("../registry/interface")).toBe(true);
    expect(adaptersDepsSrc.includes("../registry/interface")).toBe(true);
    expect(routesAdaptersSrc.includes("../registry/interface")).toBe(true);
  });

  it("门面收口：interface 与实现同一引用（包装即红）", () => {
    expect(makeAdapterRegistry).toBe(ImplMake);
    expect(userAdaptersFile).toBe(ImplUserAdaptersFile);
    expect(adapterStateFile).toBe(ImplAdapterStateFile);
    expect(parseUserAdapters).toBe(ImplParse);
    expect(readUserAdapters).toBe(ImplReadList);
    expect(readAdapterStateResult).toBe(ImplReadResult);
    expect(readAdapterState).toBe(ImplReadState);
    expect(writeAdapterState).toBe(ImplWriteState);
    expect(resolveAddAdapterFile).toBe(ImplResolveAdd);
    expect(loadUserHostAdapterFile).toBe(ImplLoadFile);
    expect(loadUserAdapterChecked).toBe(ImplLoadChecked);
    expect(readStamp).toBe(ImplReadStamp);
    expect(stampEqual).toBe(ImplStampEqual);
    expect(loadAndValidateAdapter).toBe(ImplLoadValidate);
    expect(HotReloadableAdapter).toBe(ImplHotReload);
    expect(credentialsFile).toBe(ImplCredFile);
    expect(opencodeAuthFile).toBe(ImplAuthFile);
    expect(resolveProviderConfig).toBe(ImplResolveCfg);
    expect(pluginHome).toBe(ImplPluginHome);
    expect(expandHomePath).toBe(ImplExpand);
    expect(resolvePath).toBe(ImplResolvePath);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    for (const src of [registryFaceSrc, registryDepsSrc]) {
      const codeLines = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("*"));
      expect(hasExportStar(codeLines)).toBe(false);
    }
  });

  it("门面值出口恰为 21 项（多一项即公共面膨胀）", async () => {
    const faceNs = await import("../../../src/server/registry/interface.ts");
    expect(Object.keys(faceNs).sort()).toEqual(
      [
        "makeAdapterRegistry",
        "userAdaptersFile",
        "adapterStateFile",
        "parseUserAdapters",
        "readUserAdapters",
        "readAdapterStateResult",
        "readAdapterState",
        "writeAdapterState",
        "resolveAddAdapterFile",
        "loadUserHostAdapterFile",
        "loadUserAdapterChecked",
        "readStamp",
        "stampEqual",
        "loadAndValidateAdapter",
        "HotReloadableAdapter",
        "credentialsFile",
        "opencodeAuthFile",
        "resolveProviderConfig",
        "pluginHome",
        "expandHomePath",
        "resolvePath",
      ].sort(),
    );
  });

  it("变异面登记随域改址（旧路径残留即红）", () => {
    for (const p of [
      "src/domain1/registry/registry.ts",
      "src/domain1/registry/user-adapter-loader.ts",
      "src/domain1/registry/user-adapters.ts",
      "src/domain1/registry/hotreload.ts",
      "src/domain1/registry/path-resolve.ts",
      "src/domain1/registry/provider-config.ts",
    ]) {
      expect(topologySrc.includes(p)).toBe(false);
    }
    for (const p of [
      "src/server/registry/registry.ts",
      "src/server/registry/user-adapter-loader.ts",
      "src/server/registry/user-adapters.ts",
      "src/server/registry/hotreload.ts",
      "src/server/registry/path-resolve.ts",
      "src/server/registry/provider-config.ts",
    ]) {
      expect(topologySrc.includes(p)).toBe(true);
    }
  });
});

describe("D7二 候选 + 唯一启用 + 错误登记", () => {
  it("双启用必须红：同 provider 双候选仅一启用（双行 enabled 即红）", () => {
    const reg = makeAdapterRegistry({ diag: diagSeam, sanitizePath: sanitizeSeam });
    expect(reg.register(mkAdapter({ name: "first" }), "builtin")).toBe(true);
    expect(reg.register(mkAdapter({ name: "second" }), "builtin")).toBe(true);
    const snap = reg.snapshot();
    expect(hasDualEnabled(snap.infos, "prov-x")).toBe(false);
    expect(reg.isEnabled("prov-x", "first")).toBe(false);
    expect(reg.isEnabled("prov-x", "second")).toBe(true);
    expect(reg.getEntry("prov-x")?.name).toBe("second");
    expect(reg.get("prov-x")?.name).toBe("second");
  });

  it("enabledHint=false 只入候选不启用（默认启用偷跑即红）", () => {
    const reg = makeAdapterRegistry({ diag: diagSeam, sanitizePath: sanitizeSeam });
    expect(reg.register(mkAdapter(), "user-file", "/f.mjs", false)).toBe(true);
    expect(reg.hasCandidates("prov-x")).toBe(true);
    expect(reg.getEntry("prov-x")).toBe(undefined);
    expect(reg.isEnabled("prov-x", "adapter-a")).toBe(false);
    expect(reg.select("prov-x", "adapter-a")).toBe(true);
    expect(reg.isEnabled("prov-x", "adapter-a")).toBe(true);
  });

  it("非法适配器拒收并登记错误（吞登记即红）", () => {
    const seen: string[] = [];
    const reg = makeAdapterRegistry({
      diag: (m) => seen.push(m),
      sanitizePath: sanitizeSeam,
    });
    expect(reg.register({ version: 1 }, "builtin")).toBe(false);
    expect(reg.hasCandidates("prov-x")).toBe(false);
    const f = join(isolatedDir("dou-regD7-"), "bad.mjs");
    writeFileSync(f, "export default {};", "utf8");
    expect(reg.register({ version: 2 }, "user-file", f)).toBe(false);
    expect(reg.snapshot().errors.length > 0).toBe(true);
    expect(seen.length > 0).toBe(true);
  });

  it("重名拒收并登记错误（复写即红）", () => {
    const reg = makeAdapterRegistry({ diag: diagSeam, sanitizePath: sanitizeSeam });
    expect(reg.register(mkAdapter(), "builtin")).toBe(true);
    expect(reg.register(mkAdapter(), "user-file", "/dup.mjs")).toBe(false);
    expect(reg.hasName("adapter-a")).toBe(true);
    expect(reg.snapshot().errors.some((e) => e.message.includes("重复"))).toBe(true);
  });

  it("select 语义：未知 false、清空恒成功（误成功即红）", () => {
    const reg = makeAdapterRegistry({ diag: diagSeam, sanitizePath: sanitizeSeam });
    expect(reg.select("nope", null)).toBe(true);
    expect(reg.select("nope", "ghost")).toBe(false);
    reg.register(mkAdapter(), "builtin");
    expect(reg.select("prov-x", null)).toBe(true);
    expect(reg.get("prov-x")).toBe(undefined);
    expect(reg.enabledProviders()).toEqual([]);
  });

  it("recordError 同 key 覆盖只留最近一次（双留即红）", () => {
    const reg = makeAdapterRegistry({ diag: diagSeam, sanitizePath: sanitizeSeam });
    reg.recordError("dup", "load", "第一次");
    reg.recordError("dup", "exec", "第二次");
    const dups = reg.snapshot().errors.filter((e) => e.key === "dup");
    expect(dups.length).toBe(1);
    expect(dups[0].message).toBe("第二次");
    expect(dups[0].kind).toBe("exec");
  });

  it("持久化往返经隔离目录（落仓库即红）", async () => {
    const dir = isolatedDir("dou-regD7-state-");
    expect(await readUserAdapters(dir)).toEqual([]);
    expect(await readAdapterState(dir)).toEqual({});
    await writeAdapterState(dir, { "prov-x": "adapter-a" }, () => undefined);
    expect(await readAdapterState(dir)).toEqual({ "prov-x": "adapter-a" });
    const probed = readAdapterStateResult;
    expect(typeof probed).toBe("function");
    const abs = join(dir, "probe.mjs");
    writeFileSync(abs, "export default {};", "utf8");
    expect(resolveAddAdapterFile(abs)).toBe(abs);
  });
});

describe("D7三 deps 注入面窄面", () => {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(registryDepsNs)).toEqual([]);
  });

  it("命名接缝装配注册表（改名断链即红）", () => {
    const reg = makeAdapterRegistry({ diag: diagSeam, sanitizePath: sanitizeSeam });
    reg.register(mkAdapter(), "builtin");
    expect(reg.hasCandidates("prov-x")).toBe(true);
    expect(reg.getEntry("prov-x")?.name).toBe("adapter-a");
  });
});

describe("探针：detector 失明则本段先红", () => {
  it("旧门面 detector 对脏输入有效", () => {
    expect(usesOldFace("import { x } from ../domain1/registry/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../server/registry/interface.ts")).toBe(false);
  });

  it("export * detector 对脏输入有效", () => {
    expect(hasExportStar(["export * from ./registry.ts"])).toBe(true);
    expect(hasExportStar(["export { a } from ./registry.ts"])).toBe(false);
  });

  it("双启用 detector 对脏输入有效", () => {
    expect(
      hasDualEnabled(
        [
          { providers: ["p"], enabled: true },
          { providers: ["p"], enabled: true },
        ],
        "p",
      ),
    ).toBe(true);
    expect(
      hasDualEnabled(
        [
          { providers: ["p"], enabled: false },
          { providers: ["p"], enabled: true },
        ],
        "p",
      ),
    ).toBe(false);
  });
});
