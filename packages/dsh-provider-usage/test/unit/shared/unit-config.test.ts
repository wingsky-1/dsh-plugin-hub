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
import { spawnSync } from "node:child_process";
import { assert } from "../../helpers.ts";
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
} from "../../../lib/index.js";

/**
 * 在独立子进程内验证 ~ 展开并命中 HOME 内文件。
 *
 * untildify 对 homedir() 首调固化且不可重置：正向用例只有在「本进程首次调用发生在受控
 * HOME 之后」时才可达。glob 化（#690 S2）后文件求值顺序不再可控（smoke.test.ts 可能先以
 * 外部 HOME 固化），故用子进程取得干净的固化起点——子进程只加载本包产物，首调必然受控。
 * 失败以退出码 3/4/5 区分（固化落点 / 展开落点 / 解析结果），不做静默降级。
 */
/**
 * 子进程只继承 ESM loader 钩子（Stryker tap-runner 用 `--import` 注入 lib→src 重定向）：
 * 不继承则子进程读到未变异的 lib 产物，被测路径的变异体会逃逸、拉低变异分。
 * `-r/--require` 是 tap-runner 的覆盖率桥，与本探针无关，故不继承。
 */
function inheritedLoaderArgs(): string[] {
  const FLAGS = new Set(["--import", "--loader", "--experimental-loader"]);
  const out: string[] = [];
  for (let i = 0; i < process.execArgv.length; i += 1) {
    const arg = process.execArgv[i];
    const flag = [...FLAGS].find((f) => arg === f || arg.startsWith(`${f}=`));
    if (!flag) continue;
    out.push(arg);
    if (arg === flag && process.execArgv[i + 1] !== undefined) {
      out.push(process.execArgv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function assertTildeResolutionInChild(home: string): void {
  const libUrl = new URL("../../../lib/index.js", import.meta.url).href;
  const probe = "dou-tilde-probe.mjs";
  const script = `
const { expandHomePath, resolveAddAdapterFile } = await import(${JSON.stringify(libUrl)});
const { writeFileSync } = await import("node:fs");
const home = process.env.DSH_HOME;
const frozen = expandHomePath("~");
if (frozen !== home) { console.error("freeze=" + frozen); process.exit(3); }
const target = expandHomePath("~/${probe}");
if (!target.startsWith(home)) { console.error("target=" + target); process.exit(4); }
writeFileSync(target, "export default {};", "utf8");
const resolved = resolveAddAdapterFile("~/${probe}");
if (resolved !== target) { console.error("resolved=" + resolved); process.exit(5); }
`;
  const child = spawnSync(process.execPath, [...inheritedLoaderArgs(), "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      DSH_HOME: home,
      ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
    },
  });
  assert.equal(child.status, 0,
    `~ 展开子进程探针失败（status=${child.status}）：${(child.stderr || child.stdout || "").trim()}`);
}

// ================================================================ #150 二阶段：resolveAddAdapterFile 路径校验矩阵
// 位置无关：本块断言全部不依赖「本文件先于兄弟文件求值」。唯一依赖 homedir 固化
// 时机的 ~ 展开正向用例改由独立子进程执行（见 assertTildeResolutionInChild）。

{
  // HOME/DSH_HOME 指向临时目录；~ 展开、绝对路径、目录拒绝都基于真实文件系统
  // Windows 上 os.homedir()（untildify 固化源）读 USERPROFILE，须一并重定向。
  const home = mkdtempSync(join(tmpdir(), "dou-addfile-"));
  const savedDsh = process.env.DSH_HOME;
  const savedHomeEnv = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.DSH_HOME = home;
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  try {
    // 非字符串 / 空串 / NUL
    assert.equal(resolveAddAdapterFile(42), undefined, "非字符串拒绝");
    assert.equal(resolveAddAdapterFile(null), undefined, "null 拒绝");
    assert.equal(resolveAddAdapterFile(""), undefined, "空串拒绝");
    assert.equal(resolveAddAdapterFile("   "), undefined, "纯空白拒绝");
    assert.equal(resolveAddAdapterFile("a\0b"), undefined, "含 NUL 拒绝");

    // 未规整形态（resolve 后改变）
    assert.equal(resolveAddAdapterFile(`a/../b`), undefined, "a/../b 未规整拒绝");
    assert.equal(resolveAddAdapterFile("./x.mjs"), undefined, "./x 未规整拒绝");

    // 绝对路径：文件存在才放行
    assert.equal(resolveAddAdapterFile(join(home, "missing.mjs")), undefined, "绝对路径文件不存在拒绝");
    const realFile = join(home, "real.mjs");
    writeFileSync(realFile, "export default {};", "utf8");
    assert.equal(resolveAddAdapterFile(realFile), realFile, "存在的绝对路径放行");

    // 目录路径拒绝（statSync.isFile false）
    assert.equal(resolveAddAdapterFile(home), undefined, "目录路径拒绝");

    // ~ 展开正向用例（isAbsolute(trimmed) false → 相对分支命中 dshHome 基座）：
    // untildify 对 homedir() 首调固化且进程内不可重置，父进程的固化落点取决于兄弟
    // 文件的求值顺序；glob 化后顺序不可控，故放进独立子进程验证。
    assertTildeResolutionInChild(home);
    // 负向用例与固化落点无关：未创建的同名探针必不存在
    assert.equal(resolveAddAdapterFile("~/dou-no-such-probe.mjs"), undefined, "~ 路径文件不存在拒绝");

    // ~user 形态不展开（untildify 仅处理裸 ~ 前缀），解析失败拒绝。
    // 该断言与缓存无关：无论落点在哪，"~other/x.mjs" 不展开且不存在 → 拒绝。
    assert.equal(resolveAddAdapterFile("~other/x.mjs"), undefined, "~user 形态不展开拒绝");
  } finally {
    process.env.DSH_HOME = savedDsh;
    if (savedHomeEnv === undefined) delete process.env.HOME;
    else process.env.HOME = savedHomeEnv;
    if (process.platform === "win32") {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    }
  }
}


// normalizeConfig 边界覆盖（smoke-pure 已覆盖 adapter/provider/fetchTimeoutMs/maxAgeDays）

assert.equal(normalizeConfig({ warmupIntervalMs: 0 }).warmupIntervalMs, 60000, "warmupIntervalMs 下限 60000");
assert.equal(normalizeConfig({ warmupIntervalMs: 120000 }).warmupIntervalMs, 120000, "warmupIntervalMs 合法透传");
assert.equal(normalizeConfig({ warmupIntervalMs: "x" }).warmupIntervalMs, DEFAULT_CONFIG.warmupIntervalMs, "warmupIntervalMs 非法丢弃");

assert.equal(normalizeConfig({ cacheDurationMs: 1000 }).cacheDurationMs, 5000, "cacheDurationMs 下限 5000");
assert.equal(normalizeConfig({ cacheDurationMs: 10000 }).cacheDurationMs, 10000, "cacheDurationMs 合法透传");
assert.equal(normalizeConfig({ cacheDurationMs: "x" }).cacheDurationMs, DEFAULT_CONFIG.cacheDurationMs, "cacheDurationMs 非法丢弃");

// #198 H1/H2：默认缓存由 60000 下调至 30000；显式配置语义与下限 clamp 保持
assert.equal(DEFAULT_CONFIG.cacheDurationMs, 30000, "#198 H1: 默认 cacheDurationMs=30000");
assert.equal(normalizeConfig({}).cacheDurationMs, 30000, "#198 H1: 未配置时生效 30000");
assert.equal(normalizeConfig({ cacheDurationMs: 60000 }).cacheDurationMs, 60000, "#198 H2: 显式 60000 生效 60000");
assert.equal(normalizeConfig({ cacheDurationMs: 4999 }).cacheDurationMs, 5000, "#198 H2: 下限 clamp 保持");

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
// ================================================================ #150 二阶段：normalizeConfig 全字段矩阵

// 非字符串字段一律丢弃回默认（三元 false 分支）
assert.equal(normalizeConfig({ staticPath: 42 }).staticPath, "", "staticPath 非字符串丢弃");
assert.equal(normalizeConfig({ provider: 42 }).provider, DEFAULT_CONFIG.provider, "provider 非字符串丢弃回默认");
assert.equal(normalizeConfig({ apiEndpoint: 42 }).apiEndpoint, "", "apiEndpoint 非字符串丢弃");
assert.equal(normalizeConfig({ adapter: 42 }).adapter, "", "adapter 非字符串丢弃");

// fetchTimeoutMs 固定 5s 不可配置（#206 配套：远端慢时 2s 频繁超时；warmup 与 /stats 同限）
assert.equal(normalizeConfig({ fetchTimeoutMs: 400 }).fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs, "fetchTimeoutMs 固定 5s 不可配置");
assert.equal(normalizeConfig({ fetchTimeoutMs: 30000 }).fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs, "fetchTimeoutMs 固定 5s 不可配置（上限值也忽略）");
assert.equal(normalizeConfig({ fetchTimeoutMs: "x" }).fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs, "fetchTimeoutMs 非法输入保持默认");

// maxAgeDays 上限 365、下限正整数（#184：<=0 或非整数回落默认，避免 maybePrune 下界落在未来全量清史）
assert.equal(normalizeConfig({ maxAgeDays: 1 }).maxAgeDays, 1, "maxAgeDays 合法边界 1 保留");
assert.equal(normalizeConfig({ maxAgeDays: 365 }).maxAgeDays, 365, "maxAgeDays 边界 365 透传");
assert.equal(normalizeConfig({ maxAgeDays: 366 }).maxAgeDays, 365, "maxAgeDays 上限 365");
assert.equal(normalizeConfig({ maxAgeDays: -5 }).maxAgeDays, DEFAULT_CONFIG.maxAgeDays, "maxAgeDays 负数回落默认");
assert.equal(normalizeConfig({ maxAgeDays: 0 }).maxAgeDays, DEFAULT_CONFIG.maxAgeDays, "maxAgeDays 0 回落默认");
assert.equal(normalizeConfig({ maxAgeDays: 1.5 }).maxAgeDays, DEFAULT_CONFIG.maxAgeDays, "maxAgeDays 非整数回落默认");
assert.equal(normalizeConfig({ maxAgeDays: [] }).maxAgeDays, DEFAULT_CONFIG.maxAgeDays, "maxAgeDays 数组丢弃");

// warmupIntervalMs 下限
assert.equal(normalizeConfig({ warmupIntervalMs: 59999 }).warmupIntervalMs, 60000, "warmupIntervalMs 下限 60000（59999 抬升）");
assert.equal(normalizeConfig({ warmupIntervalMs: 60000 }).warmupIntervalMs, 60000, "warmupIntervalMs 边界透传");
assert.equal(normalizeConfig({ warmupIntervalMs: [] }).warmupIntervalMs, DEFAULT_CONFIG.warmupIntervalMs, "warmupIntervalMs 数组丢弃（Number.isFinite([]) 为 false）");

// cacheDurationMs 下限
assert.equal(normalizeConfig({ cacheDurationMs: 4999 }).cacheDurationMs, 5000, "cacheDurationMs 下限 5000（4999 抬升）");
assert.equal(normalizeConfig({ cacheDurationMs: [] }).cacheDurationMs, DEFAULT_CONFIG.cacheDurationMs, "cacheDurationMs 数组丢弃");

// maxSizeMB 上限
assert.equal(normalizeConfig({ maxSizeMB: 501 }).maxSizeMB, 500, "maxSizeMB 上限 500（501 压回）");
assert.equal(normalizeConfig({ maxSizeMB: [] }).maxSizeMB, DEFAULT_CONFIG.maxSizeMB, "maxSizeMB 数组丢弃");

// null/undefined/标量输入 → 全默认
assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG }, "null 输入全默认");
assert.deepEqual(normalizeConfig(undefined), { ...DEFAULT_CONFIG }, "undefined 输入全默认");
assert.deepEqual(normalizeConfig(42), { ...DEFAULT_CONFIG }, "标量输入全默认");

// ================================================================ #150 二阶段：parseUserAdapters 字段级异型值分支

// item 非对象跳过（length 属性不存在 → 三元 false 分支）
assert.deepEqual(parseUserAdapters('{"adapters":[null]}'), [], "item 为 null 跳过");
assert.deepEqual(parseUserAdapters('{"adapters":[42]}'), [], "item 为数字跳过");
assert.deepEqual(parseUserAdapters('{"adapters":["str"]}'), [], "item 为字符串跳过");

// id 异型但 length>0：原实现按非字符串丢弃，变异为直通时输出会带数组 id
assert.deepEqual(parseUserAdapters('{"adapters":[{"id":["x","y"],"providers":["p"],"file":"/f"}]}'), [],
  "id 为 length>0 数组拒绝");
assert.deepEqual(parseUserAdapters('{"adapters":[{"id":{},"providers":["p"],"file":"/f"}]}'), [],
  "id 为对象拒绝");

// label 异型：回退 id（label||id 语义），不采纳异型值本身
{
  const out = parseUserAdapters('{"adapters":[{"id":"a","label":["L"],"providers":["p1"],"file":"/f"}]}');
  assert.deepEqual(out, [{ id: "a", label: "a", providers: ["p1"], file: "/f" }],
    "label 为数组时回退 id（不被异型值污染）");
}

// providers 元素异型过滤：全部被滤掉后 providers 空 → 条目整体拒绝
assert.deepEqual(parseUserAdapters('{"adapters":[{"id":"a","providers":[["x"],[2]],"file":"/f"}]}'), [],
  "providers 元素全为数组被滤空后条目拒绝");
assert.deepEqual(parseUserAdapters('{"adapters":[{"id":"a","providers":[{"length":1}],"file":"/f"}]}'), [],
  "providers 元素为类数组对象被滤空后条目拒绝");
assert.deepEqual(parseUserAdapters('{"adapters":[{"id":"a","providers":"pstr","file":"/f"}]}'), [],
  "providers 为非数组拒绝");

// file 异型但 length>0：原实现按非字符串置空 → 条目拒绝
assert.deepEqual(parseUserAdapters('{"adapters":[{"id":"a","providers":["p"],"file":["/f"]}]}'), [],
  "file 为 length>0 数组拒绝");

// data 顶层异型 JSON
assert.deepEqual(parseUserAdapters("null"), [], "JSON null 返回空数组");
assert.deepEqual(parseUserAdapters("42"), [], "JSON 数字返回空数组");
assert.deepEqual(parseUserAdapters('"str"'), [], "JSON 字符串返回空数组");

// ================================================================ #150 二阶段：readAdapterState 全分支（root 直传临时目录）

{
  const root = mkdtempSync(join(tmpdir(), "dou-state-"));
  assert.deepEqual(await readAdapterState(root), {}, "状态文件缺失返回空对象");

  const publicStateFile = join(root, "adapter-state.json");
  writeFileSync(publicStateFile, "not json", "utf8");
  assert.deepEqual(await readAdapterState(root), {}, "坏 JSON 返回空对象");
  assert.equal(readFileSync(publicStateFile, "utf8"), "not json", "发布物公开读取 helper 保持坏文件原样不动");
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("adapter-state.json.bak-")), [],
    "发布物公开读取 helper 不产生隔离备份（保持既有无副作用语义）");

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
  const state = await readAdapterState(root);
  assert.deepEqual(state, { p1: "a", p2: null },
    "仅保留非空字符串 id 与显式 null；空 key/空串/数字/数组/对象全部剔除");

  // #184：顶层非 plain object（字符串/数字/null/数组）一律拒绝 → 空对象（与「无有效状态」同形态）
  writeFileSync(join(root, "adapter-state.json"), '"ab"', "utf8");
  assert.deepEqual(await readAdapterState(root), {}, "顶层字符串拒绝（不再按字符索引展开）");
  writeFileSync(join(root, "adapter-state.json"), "42", "utf8");
  assert.deepEqual(await readAdapterState(root), {}, "顶层数字拒绝");
  writeFileSync(join(root, "adapter-state.json"), "null", "utf8");
  assert.deepEqual(await readAdapterState(root), {}, "顶层 null 拒绝");
  writeFileSync(join(root, "adapter-state.json"), '["a","b"]', "utf8");
  assert.deepEqual(await readAdapterState(root), {}, "顶层数组拒绝");

  // plain object 正常解析（拒绝路径不误伤合法映射）
  writeFileSync(join(root, "adapter-state.json"), '{"p9":"x"}', "utf8");
  assert.deepEqual(await readAdapterState(root), { p9: "x" }, "plain object 正常解析");
}

// ================================================================ #150 二阶段：UI 配置与面板锚点纯函数矩阵

// normalizeUiConfig：非法容器回退默认
assert.deepEqual(normalizeUiConfig(null), { ...DEFAULT_UI_CONFIG }, "null 配置回退默认");
assert.deepEqual(normalizeUiConfig(undefined), { ...DEFAULT_UI_CONFIG }, "undefined 配置回退默认");
assert.deepEqual(normalizeUiConfig("str"), { ...DEFAULT_UI_CONFIG }, "标量配置回退默认");

// placement 四合法值透传 + 非法回退
for (const p of ["top-right", "top-left", "bottom-right", "bottom-left"]) {
  assert.equal(normalizeUiConfig({ placement: p }).placement, p, `placement ${p} 透传`);
}
assert.equal(normalizeUiConfig({ placement: "center" }).placement, DEFAULT_UI_CONFIG.placement, "placement 非法枚举回退");
assert.equal(normalizeUiConfig({ placement: 42 }).placement, DEFAULT_UI_CONFIG.placement, "placement 数字回退");
assert.equal(normalizeUiConfig({ placement: null }).placement, DEFAULT_UI_CONFIG.placement, "placement null 回退");

// offset clamp 矩阵：负数压 0、超上限压 2000、小数四舍五入、数字字符串经 Number() 接受
assert.equal(normalizeUiConfig({ offsetX: -5 }).offsetX, 0, "offsetX 负数压 0");
assert.equal(normalizeUiConfig({ offsetX: 2500 }).offsetX, 2000, "offsetX 超 2000 压回");
assert.equal(normalizeUiConfig({ offsetX: 3.7 }).offsetX, 4, "offsetX 小数四舍五入");
assert.equal(normalizeUiConfig({ offsetX: 0 }).offsetX, 0, "offsetX 边界 0 透传");
assert.equal(normalizeUiConfig({ offsetX: 2000 }).offsetX, 2000, "offsetX 边界 2000 透传");
assert.equal(normalizeUiConfig({ offsetY: "12" }).offsetY, 12, "offsetY 数字字符串经 Number() 接受");
assert.equal(normalizeUiConfig({ offsetY: "abc" }).offsetY, DEFAULT_UI_CONFIG.offsetY, "offsetY 非数字字符串回退默认");
assert.equal(normalizeUiConfig({ panelOffsetY: Number.POSITIVE_INFINITY }).panelOffsetY, DEFAULT_UI_CONFIG.panelOffsetY,
  "panelOffsetY Infinity 回退默认");
assert.equal(normalizeUiConfig({ panelOffsetY: 7.2 }).panelOffsetY, 7, "panelOffsetY 小数四舍五入");

// 完整合法配置原样归一
assert.deepEqual(
  normalizeUiConfig({ placement: "bottom-left", offsetX: 10, offsetY: 20, panelOffsetY: 30 }),
  { placement: "bottom-left", offsetX: 10, offsetY: 20, panelOffsetY: 30, zIndexBase: DEFAULT_UI_CONFIG.zIndexBase },
  "完整合法配置透传（缺省层级基准回退默认）",
);

// #128 zIndexBase clamp 矩阵：非法回退默认 / 越界压边界 / 合法透传
assert.equal(normalizeUiConfig({}).zIndexBase, DEFAULT_UI_CONFIG.zIndexBase, "缺省 zIndexBase 回退默认 40");
assert.equal(normalizeUiConfig({ zIndexBase: 500 }).zIndexBase, 500, "合法层级基准透传");
assert.equal(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase, Z_INDEX_BASE_MIN, "低于下界压到 1");
assert.equal(normalizeUiConfig({ zIndexBase: -99 }).zIndexBase, Z_INDEX_BASE_MIN, "负数压到 1");
assert.equal(normalizeUiConfig({ zIndexBase: 9000 }).zIndexBase, Z_INDEX_BASE_MAX, "上界 9000 透传");
assert.equal(normalizeUiConfig({ zIndexBase: 99999 }).zIndexBase, Z_INDEX_BASE_MAX, "超上界压到 9000");
assert.equal(normalizeUiConfig({ zIndexBase: "x" }).zIndexBase, DEFAULT_UI_CONFIG.zIndexBase, "非数字字符串回退默认");
assert.equal(normalizeUiConfig({ zIndexBase: Number.NaN }).zIndexBase, DEFAULT_UI_CONFIG.zIndexBase, "NaN 回退默认");
assert.equal(panelZIndexFor(40), 70, "子浮层派生扩展点 base+30（B5，主面板与胶囊取配置值）");

// #128 断点判定纯函数分支翻转 + 视口终 clamp（safe-area inset 恒 0 自然退化）
assert.equal(breakpointForWidth(320), "narrow", "手机竖屏 narrow");
assert.equal(breakpointForWidth(BREAKPOINT_NARROW_MAX), "narrow", "480 边界归 narrow");
assert.equal(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1), "tablet", "481 翻转 tablet");
assert.equal(breakpointForWidth(BREAKPOINT_TABLET_MAX), "tablet", "834 边界归 tablet");
assert.equal(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1), "wide", "835 翻转 wide");
assert.deepEqual(clampPointToViewport(-30, -50, 100, 80, 375, 667), { x: 0, y: 0 }, "负坐标钳回视口原点");
assert.deepEqual(clampPointToViewport(400, 700, 100, 80, 375, 667), { x: 275, y: 587 }, "右/下溢出钳回视口内");
assert.deepEqual(clampPointToViewport(10, 20, 50, 40, 800, 600), { x: 10, y: 20 }, "视口内坐标不变（桌面零回归）");
assert.equal(clampZIndexBase(7.6, 40), 8, "clampZIndexBase 小数四舍五入");

// panelAnchorForPlacement 全分支
assert.equal(panelAnchorForPlacement("bottom-right"), "bottom", "bottom-right 向上弹出");
assert.equal(panelAnchorForPlacement("bottom-left"), "bottom", "bottom-left 向上弹出");
assert.equal(panelAnchorForPlacement("top-right"), "top", "top-right 向下弹出");
assert.equal(panelAnchorForPlacement("top-left"), "top", "top-left 向下弹出");
assert.equal(panelAnchorForPlacement(undefined), "top", "缺省向下弹出");

// panelTopForAnchor：双锚点 + 底部溢出钳到 6
assert.equal(panelTopForAnchor("top", 100, 120, 80, 8), 128, "顶部锚点 = pillBottom+gap");
assert.equal(panelTopForAnchor("bottom", 200, 220, 80, 8), 112, "底部锚点 = pillTop-height-gap");
assert.equal(panelTopForAnchor("bottom", 50, 60, 80, 8), 6, "底部锚点溢出钳到 6");
assert.equal(panelTopForAnchor("top", 0, 0, 0, 4), 6, "顶部锚点过小钳到 6");

// uiConfigFile 拼装规则
assert.equal(uiConfigFile("/root"), join("/root", "ui.json"), "ui.json 拼装");
