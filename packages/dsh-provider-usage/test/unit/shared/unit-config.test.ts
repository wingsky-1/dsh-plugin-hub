// @ts-nocheck
/**
 * dsh-provider-usage — unit：配置归一化补充（normalizeConfig 边界、parseUserAdapters）。
 *
 * 补充 smoke-pure 已覆盖的 normalizeConfig 基础路径，聚焦边界：
 * warmupIntervalMs 下限、cacheDurationMs 下限、apiKey 字符串透传、
 * autoReload 布尔透传、maxSizeMB 上限、historyDir 字符串。
 *
 * #82 批次 3 增补：resolveProviderConfig 全链（含 opencodeKeyFromAuth 分支）。
 *
 * #150 二阶段增补：normalizeConfig 全字段非法类型丢弃 + clamp 双边界矩阵、
 * parseUserAdapters 字段级异型值分支（length>0 非目标类型）、readAdapterState
 * 全分支、resolveAddAdapterFile 路径校验矩阵、normalizeUiConfig/面板锚点纯函数矩阵。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
console.error("EVAL-ORDER-TAG: CONFIG");
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  normalizeConfig,
  DEFAULT_CONFIG,
  DEFAULT_UI_CONFIG,
  normalizeUiConfig,
  panelAnchorForPlacement,
  panelTopForAnchor,
  Z_INDEX_BASE_MIN,
  Z_INDEX_BASE_MAX,
  panelZIndexFor,
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  breakpointForWidth,
  clampPointToViewport,
  clampZIndexBase,
  uiConfigFile,
  readAdapterState,
  parseUserAdapters,
  resolveAddAdapterFile,
  resolveProviderConfig,
  expandHomePath,
} from "../../../src/apply/index.ts";

// ================================================================ #150 二阶段：resolveAddAdapterFile 路径校验矩阵
// 位置无关：本块断言全部不依赖「本文件先于兄弟文件求值」。

describe("resolveAddAdapterFile 路径校验矩阵（#150 二阶段）", () => {
  let home, realFile, tildeProbe, tildeTarget, restoreEnv;

  beforeAll(() => {
    // HOME/DSH_HOME 指向临时目录；~ 展开、绝对路径、目录拒绝都基于真实文件系统
    // Windows 上 os.homedir()（untildify 固化源）读 USERPROFILE，须一并重定向。
    home = mkdtempSync(join(tmpdir(), "dou-addfile-"));
    const savedDsh = process.env.DSH_HOME;
    const savedHomeEnv = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.DSH_HOME = home;
    process.env.HOME = home;
    if (process.platform === "win32") process.env.USERPROFILE = home;
    restoreEnv = () => {
      process.env.DSH_HOME = savedDsh;
      if (savedHomeEnv === undefined) delete process.env.HOME;
      else process.env.HOME = savedHomeEnv;
      if (process.platform === "win32") {
        if (savedUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = savedUserProfile;
      }
    };

    realFile = join(home, "real.mjs");
    writeFileSync(realFile, "export default {};", "utf8");

    // ~ 展开正向用例（isAbsolute(trimmed) false → 相对分支命中 dshHome 基座）：
    // untildify 对 homedir() 首调固化且进程内不可重置，但 per-file 隔离（#690 S2c）下每个
    // 测试文件独占进程，兄弟文件不再影响本文件的固化落点；而本块在此之前已把 HOME/DSH_HOME
    // 指向受控临时目录，故可直接在文件内断言——#712 的子进程过渡补丁已拆。
    tildeProbe = "dou-tilde-probe.mjs";
    tildeTarget = expandHomePath(`~/${tildeProbe}`);
    writeFileSync(tildeTarget, "export default {};", "utf8");
  });

  afterAll(() => {
    restoreEnv?.();
  });

  it("非字符串拒绝", () => {
    expect(resolveAddAdapterFile(42)).toBe(undefined);
  });

  it("null 拒绝", () => {
    expect(resolveAddAdapterFile(null)).toBe(undefined);
  });

  it("空串拒绝", () => {
    expect(resolveAddAdapterFile("")).toBe(undefined);
  });

  it("纯空白拒绝", () => {
    expect(resolveAddAdapterFile("   ")).toBe(undefined);
  });

  it("含 NUL 拒绝", () => {
    expect(resolveAddAdapterFile("a\0b")).toBe(undefined);
  });

  // 未规整形态（resolve 后改变）
  it("a/../b 未规整拒绝", () => {
    expect(resolveAddAdapterFile(`a/../b`)).toBe(undefined);
  });

  it("./x 未规整拒绝", () => {
    expect(resolveAddAdapterFile("./x.mjs")).toBe(undefined);
  });

  // 绝对路径：文件存在才放行
  it("绝对路径文件不存在拒绝", () => {
    expect(resolveAddAdapterFile(join(home, "missing.mjs"))).toBe(undefined);
  });

  it("存在的绝对路径放行", () => {
    expect(resolveAddAdapterFile(realFile)).toBe(realFile);
  });

  // 目录路径拒绝（statSync.isFile false）
  it("目录路径拒绝", () => {
    expect(resolveAddAdapterFile(home)).toBe(undefined);
  });

  it("~ 展开命中受控 HOME（固化落点正确）", () => {
    expect(expandHomePath("~")).toBe(home);
  });

  it("~ 展开应落在 HOME 内", () => {
    expect(tildeTarget.startsWith(home), `~ 展开应落在 HOME 内：${tildeTarget}`).toBeTruthy();
  });

  it("~ 展开并命中 HOME 内文件", () => {
    expect(resolveAddAdapterFile(`~/${tildeProbe}`)).toBe(tildeTarget);
  });

  // 负向用例与固化落点无关：未创建的同名探针必不存在
  it("~ 路径文件不存在拒绝", () => {
    expect(resolveAddAdapterFile("~/dou-no-such-probe.mjs")).toBe(undefined);
  });

  // ~user 形态不展开（untildify 仅处理裸 ~ 前缀），解析失败拒绝。
  // 该断言与缓存无关：无论落点在哪，"~other/x.mjs" 不展开且不存在 → 拒绝。
  it("~user 形态不展开拒绝", () => {
    expect(resolveAddAdapterFile("~other/x.mjs")).toBe(undefined);
  });
});

// normalizeConfig 边界覆盖（smoke-pure 已覆盖 adapter/provider/fetchTimeoutMs/maxAgeDays）

describe("normalizeConfig 边界覆盖", () => {
  it("warmupIntervalMs 下限 60000", () => {
    expect(normalizeConfig({ warmupIntervalMs: 0 }).warmupIntervalMs).toBe(60000);
  });

  it("warmupIntervalMs 合法透传", () => {
    expect(normalizeConfig({ warmupIntervalMs: 120000 }).warmupIntervalMs).toBe(120000);
  });

  it("warmupIntervalMs 非法丢弃", () => {
    expect(normalizeConfig({ warmupIntervalMs: "x" }).warmupIntervalMs).toBe(DEFAULT_CONFIG.warmupIntervalMs);
  });

  it("cacheDurationMs 下限 5000", () => {
    expect(normalizeConfig({ cacheDurationMs: 1000 }).cacheDurationMs).toBe(5000);
  });

  it("cacheDurationMs 合法透传", () => {
    expect(normalizeConfig({ cacheDurationMs: 10000 }).cacheDurationMs).toBe(10000);
  });

  it("cacheDurationMs 非法丢弃", () => {
    expect(normalizeConfig({ cacheDurationMs: "x" }).cacheDurationMs).toBe(DEFAULT_CONFIG.cacheDurationMs);
  });

  // #198 H1/H2：默认缓存由 60000 下调至 30000；显式配置语义与下限 clamp 保持
  it("#198 H1: 默认 cacheDurationMs=30000", () => {
    expect(DEFAULT_CONFIG.cacheDurationMs).toBe(30000);
  });

  it("#198 H1: 未配置时生效 30000", () => {
    expect(normalizeConfig({}).cacheDurationMs).toBe(30000);
  });

  it("#198 H2: 显式 60000 生效 60000", () => {
    expect(normalizeConfig({ cacheDurationMs: 60000 }).cacheDurationMs).toBe(60000);
  });

  it("#198 H2: 下限 clamp 保持", () => {
    expect(normalizeConfig({ cacheDurationMs: 4999 }).cacheDurationMs).toBe(5000);
  });

  it("apiKey 字符串透传", () => {
    expect(normalizeConfig({ apiKey: "sk-abc123" }).apiKey).toBe("sk-abc123");
  });

  it("apiKey 非字符串丢弃回默认空串", () => {
    expect(normalizeConfig({ apiKey: 123 }).apiKey).toBe("");
  });

  it("autoReload 可关闭", () => {
    expect(normalizeConfig({ autoReload: false }).autoReload).toBe(false);
  });

  it("autoReload 非布尔丢弃回 true", () => {
    expect(normalizeConfig({ autoReload: "false" }).autoReload).toBe(true);
  });

  it("autoReload 数字 1 丢弃回 true", () => {
    expect(normalizeConfig({ autoReload: 1 }).autoReload).toBe(true);
  });

  it("maxSizeMB 上限 500", () => {
    expect(normalizeConfig({ maxSizeMB: 600 }).maxSizeMB).toBe(500);
  });

  it("maxSizeMB 合法透传", () => {
    expect(normalizeConfig({ maxSizeMB: 50 }).maxSizeMB).toBe(50);
  });

  it("maxSizeMB 负数当前无下限检查（跟随实现行为）", () => {
    expect(normalizeConfig({ maxSizeMB: -1 }).maxSizeMB).toBe(-1);
  });

  it("maxSizeMB 非数字丢弃回默认", () => {
    expect(normalizeConfig({ maxSizeMB: "x" }).maxSizeMB).toBe(DEFAULT_CONFIG.maxSizeMB);
  });

  it("historyDir 字符串透传", () => {
    expect(normalizeConfig({ historyDir: "/custom/hist" }).historyDir).toBe("/custom/hist");
  });

  it("historyDir 非字符串丢弃回默认空串", () => {
    expect(normalizeConfig({ historyDir: 42 }).historyDir).toBe("");
  });

  it("staticPath 字符串透传", () => {
    expect(normalizeConfig({ staticPath: "/v1/custom" }).staticPath).toBe("/v1/custom");
  });
});

// ---------------------------------------------------------------- resolveProviderConfig 全链

// resolveProviderConfig 内部会访问 resolveApiKey → opencodeKeyFromAuth。
// 注意：unit-*.test.ts 与 smoke.test.ts 同为 `test/**/*.test.ts` glob 下的平级文件（#690 S2）
// （ESM import 先于 module body），此时 DSH_HOME 尚未指向隔离目录、真实环境
// 的凭据链（~/.dsh/.credentials.yaml / 环境变量）仍可被读到。因此本文件内所有
// resolveProviderConfig 用例自行隔离 DSH_HOME/HOME 并清理凭据环境变量，
// finally 恢复，避免污染后续 smoke 断言。

/** 保存并清空凭据环境变量，返回恢复函数。DSH_HOME 始终指向隔离目录。
 *  homeDir 同时重定向 HOME 与 USERPROFILE（Windows os.homedir() 读后者，
 *  opencode auth.json 等按 homedir() 解析的路径在两个平台行为一致）。 */
function isolateCredEnv(homeDir?: string) {
  const saved = {
    dshHome: process.env.DSH_HOME,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    key: process.env.OPENCODE_GO_API_KEY,
    key2: process.env.OPENCODE_GO_PROVIDER_API_KEY,
  };
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_GO_PROVIDER_API_KEY;
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dou-dshhome-"));
  if (homeDir !== undefined) {
    process.env.HOME = homeDir;
    if (process.platform === "win32") process.env.USERPROFILE = homeDir;
  }
  return () => {
    const r = (k: string, v: string | undefined) => {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    };
    r("DSH_HOME", saved.dshHome);
    r("HOME", saved.home);
    if (process.platform === "win32") r("USERPROFILE", saved.userProfile);
    r("OPENCODE_GO_API_KEY", saved.key);
    r("OPENCODE_GO_PROVIDER_API_KEY", saved.key2);
  };
}

describe("resolveProviderConfig 全链", () => {
  // 1) auth.json（opencodeKeyFromAuth 全分支）：HOME 指向临时目录且无 .credentials.yaml
  describe("auth.json：opencode-go 密钥", () => {
    let restore, resolved;

    beforeAll(async () => {
      const authDir = mkdtempSync(join(tmpdir(), "dou-auth-"));
      const authLocal = join(authDir, ".local", "share", "opencode");
      mkdirSync(authLocal, { recursive: true });
      restore = isolateCredEnv(authDir);
      writeFileSync(join(authLocal, "auth.json"), JSON.stringify({
        "opencode-go": { type: "api", key: "sk-auth-json" },
      }), "utf8");
      resolved = await resolveProviderConfig("opencode-go");
    });

    afterAll(() => restore?.());

    it("auth.json 的 opencode-go 密钥被读取", () => {
      expect(resolved.apiKey).toBe("sk-auth-json");
    });
  });

  // 1b) auth.json 走 opencode 旧键名
  describe("auth.json：opencode 旧键名", () => {
    let restore, resolved;

    beforeAll(async () => {
      const authDir = mkdtempSync(join(tmpdir(), "dou-auth-legacy-"));
      const authLocal = join(authDir, ".local", "share", "opencode");
      mkdirSync(authLocal, { recursive: true });
      restore = isolateCredEnv(authDir);
      writeFileSync(join(authLocal, "auth.json"), JSON.stringify({
        "opencode": { type: "api", key: "sk-auth-legacy" },
      }), "utf8");
      resolved = await resolveProviderConfig("opencode-go");
    });

    afterAll(() => restore?.());

    it("auth.json 旧键名 opencode 兼容读取", () => {
      expect(resolved.apiKey).toBe("sk-auth-legacy");
    });
  });

  // 2) .credentials.yaml：DSH_HOME 下创建凭据文件
  describe(".credentials.yaml：DSH_HOME 下的凭据文件", () => {
    let restore, resolved;

    beforeAll(async () => {
      restore = isolateCredEnv();
      writeFileSync(join(process.env.DSH_HOME, ".credentials.yaml"), [
        "version: 1",
        "refs:",
        "  OPENCODE_GO_API_KEY: sk-from-yaml",
      ].join("\n"), "utf8");
      resolved = await resolveProviderConfig("opencode-go");
    });

    afterAll(() => restore?.());

    it(".credentials.yaml 的密钥被读取", () => {
      expect(resolved.apiKey).toBe("sk-from-yaml");
    });
  });

  // 3) 显式传入的 apiKey 优先级最高
  describe("显式 apiKey 优先级最高", () => {
    let restore, resolved;

    beforeAll(async () => {
      restore = isolateCredEnv();
      resolved = await resolveProviderConfig("opencode-go", undefined, { apiKey: "sk-explicit" });
    });

    afterAll(() => restore?.());

    it("显式 apiKey 优先", () => {
      expect(resolved.apiKey).toBe("sk-explicit");
    });
  });

  // 4) 环境变量优先于 auth.json
  describe("环境变量优先于 auth.json", () => {
    let restore, resolved;

    beforeAll(async () => {
      const authDir = mkdtempSync(join(tmpdir(), "dou-auth-env-"));
      const authLocal = join(authDir, ".local", "share", "opencode");
      mkdirSync(authLocal, { recursive: true });
      restore = isolateCredEnv(authDir);
      writeFileSync(join(authLocal, "auth.json"), JSON.stringify({
        "opencode-go": { type: "api", key: "sk-auth-json" },
      }), "utf8");
      process.env.OPENCODE_GO_API_KEY = "sk-from-env";
      resolved = await resolveProviderConfig("opencode-go");
    });

    afterAll(() => restore?.());

    it("环境变量优先于 auth.json", () => {
      expect(resolved.apiKey).toBe("sk-from-env");
    });
  });

  // 5) 无任何可信密钥来源 → undefined（不抛错）
  describe("无任何可信密钥来源 → undefined（不抛错）", () => {
    let restore, resolved;

    beforeAll(async () => {
      const noHome = mkdtempSync(join(tmpdir(), "dou-noauth-"));
      restore = isolateCredEnv(noHome);
      resolved = await resolveProviderConfig("opencode-go");
    });

    afterAll(() => restore?.());

    it("无密钥来源返回 undefined", () => {
      expect(resolved.apiKey).toBe(undefined);
    });

    it("无 apiEndpoint 返回 undefined", () => {
      expect(resolved.apiEndpoint).toBe(undefined);
    });
  });

  // 6) 非 opencode-go provider 不应读 auth.json
  describe("非 opencode-go provider 不应读 auth.json", () => {
    let restore, resolved;

    beforeAll(async () => {
      const authDir = mkdtempSync(join(tmpdir(), "dou-auth-x-"));
      const authLocal = join(authDir, ".local", "share", "opencode");
      mkdirSync(authLocal, { recursive: true });
      restore = isolateCredEnv(authDir);
      writeFileSync(join(authLocal, "auth.json"), JSON.stringify({
        "opencode-go": { type: "api", key: "sk-auth-json" },
      }), "utf8");
      resolved = await resolveProviderConfig("anthropic");
    });

    afterAll(() => restore?.());

    it("非 opencode-go provider 不读 auth.json", () => {
      expect(resolved.apiKey).toBe(undefined);
    });
  });
});

// ================================================================ #150 二阶段：normalizeConfig 全字段矩阵

describe("normalizeConfig 全字段矩阵（#150 二阶段）", () => {
  // 非字符串字段一律丢弃回默认（三元 false 分支）
  it("staticPath 非字符串丢弃", () => {
    expect(normalizeConfig({ staticPath: 42 }).staticPath).toBe("");
  });

  it("provider 非字符串丢弃回默认", () => {
    expect(normalizeConfig({ provider: 42 }).provider).toBe(DEFAULT_CONFIG.provider);
  });

  it("apiEndpoint 非字符串丢弃", () => {
    expect(normalizeConfig({ apiEndpoint: 42 }).apiEndpoint).toBe("");
  });

  it("adapter 非字符串丢弃", () => {
    expect(normalizeConfig({ adapter: 42 }).adapter).toBe("");
  });

  // fetchTimeoutMs 固定 5s 不可配置（#206 配套：远端慢时 2s 频繁超时；warmup 与 /stats 同限）
  it("fetchTimeoutMs 固定 5s 不可配置", () => {
    expect(normalizeConfig({ fetchTimeoutMs: 400 }).fetchTimeoutMs).toBe(DEFAULT_CONFIG.fetchTimeoutMs);
  });

  it("fetchTimeoutMs 固定 5s 不可配置（上限值也忽略）", () => {
    expect(normalizeConfig({ fetchTimeoutMs: 30000 }).fetchTimeoutMs).toBe(DEFAULT_CONFIG.fetchTimeoutMs);
  });

  it("fetchTimeoutMs 非法输入保持默认", () => {
    expect(normalizeConfig({ fetchTimeoutMs: "x" }).fetchTimeoutMs).toBe(DEFAULT_CONFIG.fetchTimeoutMs);
  });

  // maxAgeDays 上限 365、下限正整数（#184：<=0 或非整数回落默认，避免 maybePrune 下界落在未来全量清史）
  it("maxAgeDays 合法边界 1 保留", () => {
    expect(normalizeConfig({ maxAgeDays: 1 }).maxAgeDays).toBe(1);
  });

  it("maxAgeDays 边界 365 透传", () => {
    expect(normalizeConfig({ maxAgeDays: 365 }).maxAgeDays).toBe(365);
  });

  it("maxAgeDays 上限 365", () => {
    expect(normalizeConfig({ maxAgeDays: 366 }).maxAgeDays).toBe(365);
  });

  it("maxAgeDays 负数回落默认", () => {
    expect(normalizeConfig({ maxAgeDays: -5 }).maxAgeDays).toBe(DEFAULT_CONFIG.maxAgeDays);
  });

  it("maxAgeDays 0 回落默认", () => {
    expect(normalizeConfig({ maxAgeDays: 0 }).maxAgeDays).toBe(DEFAULT_CONFIG.maxAgeDays);
  });

  it("maxAgeDays 非整数回落默认", () => {
    expect(normalizeConfig({ maxAgeDays: 1.5 }).maxAgeDays).toBe(DEFAULT_CONFIG.maxAgeDays);
  });

  it("maxAgeDays 数组丢弃", () => {
    expect(normalizeConfig({ maxAgeDays: [] }).maxAgeDays).toBe(DEFAULT_CONFIG.maxAgeDays);
  });

  // warmupIntervalMs 下限
  it("warmupIntervalMs 下限 60000（59999 抬升）", () => {
    expect(normalizeConfig({ warmupIntervalMs: 59999 }).warmupIntervalMs).toBe(60000);
  });

  it("warmupIntervalMs 边界透传", () => {
    expect(normalizeConfig({ warmupIntervalMs: 60000 }).warmupIntervalMs).toBe(60000);
  });

  it("warmupIntervalMs 数组丢弃（Number.isFinite([]) 为 false）", () => {
    expect(normalizeConfig({ warmupIntervalMs: [] }).warmupIntervalMs).toBe(DEFAULT_CONFIG.warmupIntervalMs);
  });

  // cacheDurationMs 下限
  it("cacheDurationMs 下限 5000（4999 抬升）", () => {
    expect(normalizeConfig({ cacheDurationMs: 4999 }).cacheDurationMs).toBe(5000);
  });

  it("cacheDurationMs 数组丢弃", () => {
    expect(normalizeConfig({ cacheDurationMs: [] }).cacheDurationMs).toBe(DEFAULT_CONFIG.cacheDurationMs);
  });

  // maxSizeMB 上限
  it("maxSizeMB 上限 500（501 压回）", () => {
    expect(normalizeConfig({ maxSizeMB: 501 }).maxSizeMB).toBe(500);
  });

  it("maxSizeMB 数组丢弃", () => {
    expect(normalizeConfig({ maxSizeMB: [] }).maxSizeMB).toBe(DEFAULT_CONFIG.maxSizeMB);
  });

  // null/undefined/标量输入 → 全默认
  it("null 输入全默认", () => {
    expect(normalizeConfig(null)).toEqual({ ...DEFAULT_CONFIG });
  });

  it("undefined 输入全默认", () => {
    expect(normalizeConfig(undefined)).toEqual({ ...DEFAULT_CONFIG });
  });

  it("标量输入全默认", () => {
    expect(normalizeConfig(42)).toEqual({ ...DEFAULT_CONFIG });
  });
});

// ================================================================ #150 二阶段：parseUserAdapters 字段级异型值分支

describe("parseUserAdapters 字段级异型值分支（#150 二阶段）", () => {
  // item 非对象跳过（length 属性不存在 → 三元 false 分支）
  it("item 为 null 跳过", () => {
    expect(parseUserAdapters('{"adapters":[null]}')).toEqual([]);
  });

  it("item 为数字跳过", () => {
    expect(parseUserAdapters('{"adapters":[42]}')).toEqual([]);
  });

  it("item 为字符串跳过", () => {
    expect(parseUserAdapters('{"adapters":["str"]}')).toEqual([]);
  });

  // id 异型但 length>0：原实现按非字符串丢弃，变异为直通时输出会带数组 id
  it("id 为 length>0 数组拒绝", () => {
    expect(parseUserAdapters('{"adapters":[{"id":["x","y"],"providers":["p"],"file":"/f"}]}')).toEqual([]);
  });

  it("id 为对象拒绝", () => {
    expect(parseUserAdapters('{"adapters":[{"id":{},"providers":["p"],"file":"/f"}]}')).toEqual([]);
  });

  // label 异型：回退 id（label||id 语义），不采纳异型值本身
  it("label 为数组时回退 id（不被异型值污染）", () => {
    const out = parseUserAdapters('{"adapters":[{"id":"a","label":["L"],"providers":["p1"],"file":"/f"}]}');
    expect(out).toEqual([{ id: "a", label: "a", providers: ["p1"], file: "/f" }]);
  });

  // providers 元素异型过滤：全部被滤掉后 providers 空 → 条目整体拒绝
  it("providers 元素全为数组被滤空后条目拒绝", () => {
    expect(parseUserAdapters('{"adapters":[{"id":"a","providers":[["x"],[2]],"file":"/f"}]}')).toEqual([]);
  });

  it("providers 元素为类数组对象被滤空后条目拒绝", () => {
    expect(parseUserAdapters('{"adapters":[{"id":"a","providers":[{"length":1}],"file":"/f"}]}')).toEqual([]);
  });

  it("providers 为非数组拒绝", () => {
    expect(parseUserAdapters('{"adapters":[{"id":"a","providers":"pstr","file":"/f"}]}')).toEqual([]);
  });

  // file 异型但 length>0：原实现按非字符串置空 → 条目拒绝
  it("file 为 length>0 数组拒绝", () => {
    expect(parseUserAdapters('{"adapters":[{"id":"a","providers":["p"],"file":["/f"]}]}')).toEqual([]);
  });

  // data 顶层异型 JSON
  it("JSON null 返回空数组", () => {
    expect(parseUserAdapters("null")).toEqual([]);
  });

  it("JSON 数字返回空数组", () => {
    expect(parseUserAdapters("42")).toEqual([]);
  });

  it("JSON 字符串返回空数组", () => {
    expect(parseUserAdapters('"str"')).toEqual([]);
  });
});

// ================================================================ #150 二阶段：readAdapterState 全分支（root 直传临时目录）

describe("readAdapterState 全分支（#150 二阶段）", () => {
  let missingFile, badJson, badJsonRaw, bakFiles, legalState;
  let topString, topNumber, topNull, topArray, plainObject;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-state-"));
    missingFile = await readAdapterState(root);

    const publicStateFile = join(root, "adapter-state.json");
    writeFileSync(publicStateFile, "not json", "utf8");
    badJson = await readAdapterState(root);
    badJsonRaw = readFileSync(publicStateFile, "utf8");
    bakFiles = readdirSync(root).filter((name) => name.startsWith("adapter-state.json.bak-"));

    // 合法映射 + null 显式清空 + 各非法形态逐个区分
    writeFileSync(join(root, "adapter-state.json"), JSON.stringify({
      p1: "a",
      p2: null,
      p3: "",
      p4: 42,
      p5: ["a"],
      p6: {},
      "": "empty-key",
    }), "utf8");
    legalState = await readAdapterState(root);

    // #184：顶层非 plain object（字符串/数字/null/数组）一律拒绝 → 空对象（与「无有效状态」同形态）
    writeFileSync(join(root, "adapter-state.json"), '"ab"', "utf8");
    topString = await readAdapterState(root);
    writeFileSync(join(root, "adapter-state.json"), "42", "utf8");
    topNumber = await readAdapterState(root);
    writeFileSync(join(root, "adapter-state.json"), "null", "utf8");
    topNull = await readAdapterState(root);
    writeFileSync(join(root, "adapter-state.json"), '["a","b"]', "utf8");
    topArray = await readAdapterState(root);

    // plain object 正常解析（拒绝路径不误伤合法映射）
    writeFileSync(join(root, "adapter-state.json"), '{"p9":"x"}', "utf8");
    plainObject = await readAdapterState(root);
  });

  it("状态文件缺失返回空对象", () => {
    expect(missingFile).toEqual({});
  });

  it("坏 JSON 返回空对象", () => {
    expect(badJson).toEqual({});
  });

  it("发布物公开读取 helper 保持坏文件原样不动", () => {
    expect(badJsonRaw).toBe("not json");
  });

  it("发布物公开读取 helper 不产生隔离备份（保持既有无副作用语义）", () => {
    expect(bakFiles).toEqual([]);
  });

  it("仅保留非空字符串 id 与显式 null；空 key/空串/数字/数组/对象全部剔除", () => {
    expect(legalState).toEqual({ p1: "a", p2: null });
  });

  it("顶层字符串拒绝（不再按字符索引展开）", () => {
    expect(topString).toEqual({});
  });

  it("顶层数字拒绝", () => {
    expect(topNumber).toEqual({});
  });

  it("顶层 null 拒绝", () => {
    expect(topNull).toEqual({});
  });

  it("顶层数组拒绝", () => {
    expect(topArray).toEqual({});
  });

  it("plain object 正常解析", () => {
    expect(plainObject).toEqual({ p9: "x" });
  });
});

// ================================================================ #150 二阶段：UI 配置与面板锚点纯函数矩阵

describe("UI 配置与面板锚点纯函数矩阵（#150 二阶段）", () => {
  // normalizeUiConfig：非法容器回退默认
  it("null 配置回退默认", () => {
    expect(normalizeUiConfig(null)).toEqual({ ...DEFAULT_UI_CONFIG });
  });

  it("undefined 配置回退默认", () => {
    expect(normalizeUiConfig(undefined)).toEqual({ ...DEFAULT_UI_CONFIG });
  });

  it("标量配置回退默认", () => {
    expect(normalizeUiConfig("str")).toEqual({ ...DEFAULT_UI_CONFIG });
  });

  // placement 四合法值透传 + 非法回退
  for (const p of ["top-right", "top-left", "bottom-right", "bottom-left"]) {
    it(`placement ${p} 透传`, () => {
      expect(normalizeUiConfig({ placement: p }).placement).toBe(p);
    });
  }

  it("placement 非法枚举回退", () => {
    expect(normalizeUiConfig({ placement: "center" }).placement).toBe(DEFAULT_UI_CONFIG.placement);
  });

  it("placement 数字回退", () => {
    expect(normalizeUiConfig({ placement: 42 }).placement).toBe(DEFAULT_UI_CONFIG.placement);
  });

  it("placement null 回退", () => {
    expect(normalizeUiConfig({ placement: null }).placement).toBe(DEFAULT_UI_CONFIG.placement);
  });

  // offset clamp 矩阵：负数压 0、超上限压 2000、小数四舍五入、数字字符串经 Number() 接受
  it("offsetX 负数压 0", () => {
    expect(normalizeUiConfig({ offsetX: -5 }).offsetX).toBe(0);
  });

  it("offsetX 超 2000 压回", () => {
    expect(normalizeUiConfig({ offsetX: 2500 }).offsetX).toBe(2000);
  });

  it("offsetX 小数四舍五入", () => {
    expect(normalizeUiConfig({ offsetX: 3.7 }).offsetX).toBe(4);
  });

  it("offsetX 边界 0 透传", () => {
    expect(normalizeUiConfig({ offsetX: 0 }).offsetX).toBe(0);
  });

  it("offsetX 边界 2000 透传", () => {
    expect(normalizeUiConfig({ offsetX: 2000 }).offsetX).toBe(2000);
  });

  it("offsetY 数字字符串经 Number() 接受", () => {
    expect(normalizeUiConfig({ offsetY: "12" }).offsetY).toBe(12);
  });

  it("offsetY 非数字字符串回退默认", () => {
    expect(normalizeUiConfig({ offsetY: "abc" }).offsetY).toBe(DEFAULT_UI_CONFIG.offsetY);
  });

  it("panelOffsetY Infinity 回退默认", () => {
    expect(normalizeUiConfig({ panelOffsetY: Number.POSITIVE_INFINITY }).panelOffsetY).toBe(DEFAULT_UI_CONFIG.panelOffsetY);
  });

  it("panelOffsetY 小数四舍五入", () => {
    expect(normalizeUiConfig({ panelOffsetY: 7.2 }).panelOffsetY).toBe(7);
  });

  // 完整合法配置原样归一
  it("完整合法配置透传（缺省层级基准回退默认）", () => {
    expect(normalizeUiConfig({ placement: "bottom-left", offsetX: 10, offsetY: 20, panelOffsetY: 30 }))
      .toEqual({ placement: "bottom-left", offsetX: 10, offsetY: 20, panelOffsetY: 30, zIndexBase: DEFAULT_UI_CONFIG.zIndexBase });
  });

  // #128 zIndexBase clamp 矩阵：非法回退默认 / 越界压边界 / 合法透传
  it("缺省 zIndexBase 回退默认 40", () => {
    expect(normalizeUiConfig({}).zIndexBase).toBe(DEFAULT_UI_CONFIG.zIndexBase);
  });

  it("合法层级基准透传", () => {
    expect(normalizeUiConfig({ zIndexBase: 500 }).zIndexBase).toBe(500);
  });

  it("低于下界压到 1", () => {
    expect(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase).toBe(Z_INDEX_BASE_MIN);
  });

  it("负数压到 1", () => {
    expect(normalizeUiConfig({ zIndexBase: -99 }).zIndexBase).toBe(Z_INDEX_BASE_MIN);
  });

  it("上界 9000 透传", () => {
    expect(normalizeUiConfig({ zIndexBase: 9000 }).zIndexBase).toBe(Z_INDEX_BASE_MAX);
  });

  it("超上界压到 9000", () => {
    expect(normalizeUiConfig({ zIndexBase: 99999 }).zIndexBase).toBe(Z_INDEX_BASE_MAX);
  });

  it("非数字字符串回退默认", () => {
    expect(normalizeUiConfig({ zIndexBase: "x" }).zIndexBase).toBe(DEFAULT_UI_CONFIG.zIndexBase);
  });

  it("NaN 回退默认", () => {
    expect(normalizeUiConfig({ zIndexBase: Number.NaN }).zIndexBase).toBe(DEFAULT_UI_CONFIG.zIndexBase);
  });

  it("子浮层派生扩展点 base+30（B5，主面板与胶囊取配置值）", () => {
    expect(panelZIndexFor(40)).toBe(70);
  });

  // #128 断点判定纯函数分支翻转 + 视口终 clamp（safe-area inset 恒 0 自然退化）
  it("手机竖屏 narrow", () => {
    expect(breakpointForWidth(320)).toBe("narrow");
  });

  it("480 边界归 narrow", () => {
    expect(breakpointForWidth(BREAKPOINT_NARROW_MAX)).toBe("narrow");
  });

  it("481 翻转 tablet", () => {
    expect(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1)).toBe("tablet");
  });

  it("834 边界归 tablet", () => {
    expect(breakpointForWidth(BREAKPOINT_TABLET_MAX)).toBe("tablet");
  });

  it("835 翻转 wide", () => {
    expect(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1)).toBe("wide");
  });

  it("负坐标钳回视口原点", () => {
    expect(clampPointToViewport(-30, -50, 100, 80, 375, 667)).toEqual({ x: 0, y: 0 });
  });

  it("右/下溢出钳回视口内", () => {
    expect(clampPointToViewport(400, 700, 100, 80, 375, 667)).toEqual({ x: 275, y: 587 });
  });

  it("视口内坐标不变（桌面零回归）", () => {
    expect(clampPointToViewport(10, 20, 50, 40, 800, 600)).toEqual({ x: 10, y: 20 });
  });

  it("clampZIndexBase 小数四舍五入", () => {
    expect(clampZIndexBase(7.6, 40)).toBe(8);
  });

  // panelAnchorForPlacement 全分支
  it("bottom-right 向上弹出", () => {
    expect(panelAnchorForPlacement("bottom-right")).toBe("bottom");
  });

  it("bottom-left 向上弹出", () => {
    expect(panelAnchorForPlacement("bottom-left")).toBe("bottom");
  });

  it("top-right 向下弹出", () => {
    expect(panelAnchorForPlacement("top-right")).toBe("top");
  });

  it("top-left 向下弹出", () => {
    expect(panelAnchorForPlacement("top-left")).toBe("top");
  });

  it("缺省向下弹出", () => {
    expect(panelAnchorForPlacement(undefined)).toBe("top");
  });

  // panelTopForAnchor：双锚点 + 底部溢出钳到 6
  it("顶部锚点 = pillBottom+gap", () => {
    expect(panelTopForAnchor("top", 100, 120, 80, 8)).toBe(128);
  });

  it("底部锚点 = pillTop-height-gap", () => {
    expect(panelTopForAnchor("bottom", 200, 220, 80, 8)).toBe(112);
  });

  it("底部锚点溢出钳到 6", () => {
    expect(panelTopForAnchor("bottom", 50, 60, 80, 8)).toBe(6);
  });

  it("顶部锚点过小钳到 6", () => {
    expect(panelTopForAnchor("top", 0, 0, 0, 4)).toBe(6);
  });

  // uiConfigFile 拼装规则
  it("ui.json 拼装", () => {
    expect(uiConfigFile("/root")).toBe(join("/root", "ui.json"));
  });
});
