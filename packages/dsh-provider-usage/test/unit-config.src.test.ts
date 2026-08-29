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
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
console.error("EVAL-ORDER-TAG: CONFIG");
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { assert } from "./helpers.ts";
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
  expandHomePath,
  resolveProviderConfig,
} from "../src/index.ts";
import {
  ADAPTER_STATE_BACKUP_LIMIT,
  adapterStateFile,
  readAdapterStateResult,
  writeAdapterState,
} from "../src/user-adapters.ts";

// ================================================================ #150 二阶段：resolveAddAdapterFile 路径校验矩阵
// 注意位置：本块必须位于本模块求值的最前部（同步段）。resolveAddAdapterFile/
// expandHomePath 内部的 untildify 对 homedir() 首调固化且不可重置，而含顶层
// await 的兄弟模块（如 unit-apply 的 apply 用例经 resolvePath 触达）会在本文件
// 的 await 让出窗口内插入执行——若固化被其以外部 HOME 抢先完成，~ 展开用例
// 将不可达。同步段先于任何其他模块的插入执行，故在此显式完成受控固化。

{
  // HOME/DSH_HOME 指向临时目录；~ 展开、绝对路径、目录拒绝都基于真实文件系统
  const home = mkdtempSync(join(tmpdir(), "dou-addfile-"));
  const savedDsh = process.env.DSH_HOME;
  const savedHomeEnv = process.env.HOME;
  process.env.DSH_HOME = home;
  process.env.HOME = home;
  try {
    // 显式受控固化：此后进程内 ~ 展开落点恒为本隔离目录。
    // 若落点已指向别处（前置模块抢先固化），直接失败暴露，不做静默降级。
    if (expandHomePath("~") !== home) {
      assert.fail(
        `untildify homedir 已被前置调用固化为 ${expandHomePath("~")}（期望 ${home}），~ 展开用例前提失效`,
      );
    }
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

    // ~ 展开路径（isAbsolute(trimmed) false → 相对分支命中 dshHome 基座）。
    // untildify 对 homedir() 有模块级缓存（首次调用固化），~ 展开落点不随运行中
    // HOME 设置变化，故以 expandHomePath("~") 的固化落点为基座构造探针文件，
    // 并硬性要求落点位于本用例隔离目录内：若不满足，说明 untildify 已被前置
    // 模块以外部 HOME 抢先固化、本用例可达性前提被破坏——直接失败暴露，
    // 不允许静默退化为弱断言（二选一分支会让正向路径失去可达性）。
    const tildeName = `dou-tilde-probe-${process.pid}.mjs`;
    const expandedTarget = expandHomePath(`~/${tildeName}`);
    if (!expandedTarget.startsWith(home)) {
      assert.fail(
        `untildify homedir 固化到外部 ${expandedTarget}（本用例隔离目录 ${home}），~ 展开用例不可达`,
      );
    }
    writeFileSync(expandedTarget, "export default {};", "utf8");
    assert.equal(resolveAddAdapterFile(`~/${tildeName}`), expandedTarget,
      "~ 路径展开并命中 HOME 内文件");
    // 负向用例与落点无关：未创建的同名探针必不存在
    assert.equal(resolveAddAdapterFile("~/dou-no-such-probe.mjs"), undefined, "~ 路径文件不存在拒绝");

    // ~user 形态不展开（untildify 仅处理裸 ~ 前缀），解析失败拒绝。
    // 该断言与缓存无关：无论落点在哪，"~other/x.mjs" 不展开且不存在 → 拒绝。
    assert.equal(resolveAddAdapterFile("~other/x.mjs"), undefined, "~user 形态不展开拒绝");
  } finally {
    process.env.DSH_HOME = savedDsh;
    if (savedHomeEnv === undefined) delete process.env.HOME;
    else process.env.HOME = savedHomeEnv;
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
  assert.equal(readFileSync(publicStateFile, "utf8"), "not json", "公开读取 helper 保持坏文件原样不动");
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("adapter-state.json.bak-")), [],
    "公开读取 helper 不产生隔离备份（保持既有无副作用语义）");

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

// ================================================================ #301：状态损坏留证 + 原子耐久写

{
  const root = mkdtempSync(join(tmpdir(), "dou-state-301-corrupt-"));
  const file = adapterStateFile(root);
  const diagnostics: string[] = [];
  writeFileSync(file, "{broken", "utf8");

  const result = await readAdapterStateResult(root, {
    diagnostic: (message) => diagnostics.push(message),
    now: () => 301,
  });
  const backup = `${file}.bak-301`;
  assert.equal(result.status, "quarantined", "坏 JSON 被识别为已隔离状态");
  assert.equal(result.backupFile, backup, "隔离文件名使用 .bak-<ts> 留证");
  assert.equal(existsSync(file), false, "损坏目标文件已移出主路径");
  assert.equal(readFileSync(backup, "utf8"), "{broken", "损坏原文完整保留在备份");
  assert.ok(diagnostics.some((line) => line.includes("JSON 损坏") && line.includes("bak-301")),
    "损坏隔离通过诊断通道可见");
  assert.ok(diagnostics.some((line) => line.includes("仅供取证") && line.includes("不会自动恢复")
    && line.includes(`最多保留 ${ADAPTER_STATE_BACKUP_LIMIT} 份`)),
  "隔离诊断准确说明备份不会自动回灌且有界轮转");

  writeFileSync(file, "{broken-again", "utf8");
  const second = await readAdapterStateResult(root, {
    diagnostic: (message) => diagnostics.push(message),
    now: () => 301,
  });
  const secondBackup = `${file}.bak-301-1`;
  assert.equal(second.backupFile, secondBackup, "同一时间戳碰撞时使用递增后缀且不覆盖旧备份");
  assert.equal(readFileSync(backup, "utf8"), "{broken", "时间戳碰撞后首份损坏证据保持不变");
  assert.equal(readFileSync(secondBackup, "utf8"), "{broken-again", "第二份损坏证据独立保留");

  await writeAdapterState(root, { p301: "adapter-301", disabled: null }, () => {});
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { p301: "adapter-301", disabled: null },
    "隔离后可原子写入新的合法状态");
  assert.equal(readFileSync(backup, "utf8"), "{broken", "新写入不覆盖损坏现场备份");
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), [], "成功写入后无临时文件残留");
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600, "POSIX 状态文件权限限制为 0600");
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "dou-state-301-rotation-"));
  const file = adapterStateFile(root);
  const diagnostics: string[] = [];
  for (let timestamp = 401; timestamp < 401 + ADAPTER_STATE_BACKUP_LIMIT; timestamp += 1) {
    writeFileSync(file, `{broken-${timestamp}`, "utf8");
    await readAdapterStateResult(root, {
      diagnostic: (message) => diagnostics.push(message),
      now: () => timestamp,
    });
  }

  // 系统时钟回拨时，本次新证据也必须受保护；旧集合中最早的一份先轮转。
  writeFileSync(file, "{broken-clock-regression", "utf8");
  const regressed = await readAdapterStateResult(root, {
    diagnostic: (message) => diagnostics.push(message),
    now: () => 1,
  });
  const regressedBackup = `${file}.bak-1`;
  assert.equal(regressed.backupFile, regressedBackup, "时钟回拨仍为本次现场创建独立备份");
  assert.equal(readFileSync(regressedBackup, "utf8"), "{broken-clock-regression",
    "本次新隔离证据不因较小时间戳被轮转");
  const afterRegression = readdirSync(root).filter((name) => name.startsWith("adapter-state.json.bak-")).sort();
  assert.equal(afterRegression.length, ADAPTER_STATE_BACKUP_LIMIT, "取证备份数量严格受常量上限约束");
  assert.equal(afterRegression.includes("adapter-state.json.bak-401"), false, "超过上限时轮转旧集合中最早备份");
  assert.equal(afterRegression.includes("adapter-state.json.bak-1"), true, "轮转始终保护本次新备份");

  writeFileSync(file, "{broken-406", "utf8");
  await readAdapterStateResult(root, {
    diagnostic: (message) => diagnostics.push(message),
    now: () => 406,
  });
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith("adapter-state.json.bak-")).sort(),
    [402, 403, 404, 405, 406].map((timestamp) => `adapter-state.json.bak-${timestamp}`),
    "后续隔离继续按时间戳轮转，仅保留最近有界集合",
  );
}

{
  const root = mkdtempSync(join(tmpdir(), "dou-state-301-shape-"));
  const file = adapterStateFile(root);
  const diagnostics: string[] = [];
  writeFileSync(file, '["not","a","mapping"]', "utf8");

  const result = await readAdapterStateResult(root, {
    diagnostic: (message) => diagnostics.push(message),
    now: () => 303,
  });
  const backup = `${file}.bak-303`;
  assert.equal(result.status, "invalid-shape", "合法 JSON 的非法顶层形态被单独识别");
  assert.equal(result.backupFile, backup, "非法顶层形态同样隔离留证");
  assert.equal(existsSync(file), false, "非法形态目标文件已移出主路径，避免后续覆盖现场");
  assert.equal(readFileSync(backup, "utf8"), '["not","a","mapping"]', "非法形态原文完整保留");
  assert.ok(diagnostics.some((line) => line.includes("顶层结构无效") && line.includes("bak-303")),
    "非法顶层形态通过诊断通道可见");
}

{
  const root = mkdtempSync(join(tmpdir(), "dou-state-301-rotation-order-"));
  const file = adapterStateFile(root);
  const prefix = "adapter-state.json.bak-";
  const valid = ["13", "9", "12", "10-12", "11", "10-2", "10"];
  for (const suffix of valid) writeFileSync(`${file}.bak-${suffix}`, `evidence-${suffix}`, "utf8");
  const decoys = [
    `${prefix}x8`,
    `${prefix}8-tail`,
    `${prefix}10-x`,
    `${prefix}9007199254740992`,
    `${"x".repeat(prefix.length)}8`,
  ];
  for (const name of decoys) writeFileSync(join(root, name), `decoy-${name}`, "utf8");

  writeFileSync(file, "{current-14", "utf8");
  await readAdapterStateResult(root, { diagnostic: () => {}, now: () => 14 });

  const expectedKept = ["10-12", "11", "12", "13", "14"]
    .map((suffix) => `${prefix}${suffix}`)
    .sort();
  assert.deepEqual(
    readdirSync(root).filter((name) => /^adapter-state\.json\.bak-(?:10-12|11|12|13|14)$/.test(name)).sort(),
    expectedKept,
    "轮转按数字时间戳及多位碰撞后缀排序，不依赖 readdir/字典序",
  );
  for (const suffix of ["9", "10", "10-2"]) {
    assert.equal(existsSync(`${file}.bak-${suffix}`), false, `较旧合法备份 ${suffix} 已轮转`);
  }
  for (const name of decoys) {
    assert.equal(existsSync(join(root, name)), true, `非本实现生成的相似文件 ${name} 不参与轮转`);
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "dou-state-301-quarantine-fail-"));
  const file = adapterStateFile(root);
  const diagnostics: string[] = [];
  writeFileSync(file, "not-json", "utf8");
  const result = await readAdapterStateResult(root, {
    diagnostic: (message) => diagnostics.push(message),
    now: () => 302,
    moveToBackup: async () => {
      const error = new Error("simulated quarantine denial") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    },
  });
  assert.equal(result.status, "unreadable", "隔离失败标为 unreadable，供写路径 fail-closed");
  assert.equal(readFileSync(file, "utf8"), "not-json", "隔离失败时损坏原文件仍保留");
  assert.ok(diagnostics.some((line) => line.includes("隔离失败")), "隔离失败通过诊断通道可见");
}

if (process.platform !== "win32") {
  const root = mkdtempSync(join(tmpdir(), "dou-state-301-rotation-scan-fail-"));
  const file = adapterStateFile(root);
  const diagnostics: string[] = [];
  writeFileSync(file, "{scan-failure", "utf8");
  chmodSync(root, 0o300); // readFile/link/unlink 可用，readdir 因缺少 read 位失败。
  let result: Awaited<ReturnType<typeof readAdapterStateResult>>;
  try {
    result = await readAdapterStateResult(root, {
      diagnostic: (message) => diagnostics.push(message),
      now: () => 501,
    });
  } finally {
    chmodSync(root, 0o700);
  }
  assert.equal(result.status, "quarantined", "轮转扫描失败不撤销已经成功的隔离");
  assert.equal(readFileSync(`${file}.bak-501`, "utf8"), "{scan-failure", "扫描失败时本次证据仍完整保留");
  assert.ok(diagnostics.some((line) => line.includes("轮转扫描失败") && line.includes("现有备份保持不变")),
    "轮转扫描失败经独立诊断可见");
}

{
  const root = mkdtempSync(join(tmpdir(), "dou-state-301-rotation-delete-fail-"));
  const file = adapterStateFile(root);
  const diagnostics: string[] = [];
  mkdirSync(`${file}.bak-1`); // 匹配命名但不可用 unlink 删除，稳定触发轮转失败。
  for (const timestamp of [2, 3, 4, 5]) writeFileSync(`${file}.bak-${timestamp}`, `evidence-${timestamp}`, "utf8");
  writeFileSync(file, "{delete-failure", "utf8");

  const result = await readAdapterStateResult(root, {
    diagnostic: (message) => diagnostics.push(message),
    now: () => 6,
  });
  assert.equal(result.status, "quarantined", "旧备份删除失败不撤销已经成功的隔离");
  assert.equal(readFileSync(`${file}.bak-6`, "utf8"), "{delete-failure", "删除失败时本次证据仍完整保留");
  assert.ok(diagnostics.some((line) => line.includes("旧取证备份 adapter-state.json.bak-1 轮转失败")
    && line.includes("现有备份保持不变")),
  "旧备份删除失败经独立诊断可见且不误报本次隔离失败");
}

{
  const root = mkdtempSync(join(tmpdir(), "dou-state-301-write-fail-"));
  const diagnostics: string[] = [];
  mkdirSync(adapterStateFile(root)); // 目标为目录，保证原子 rename 失败
  await assert.rejects(() => writeAdapterState(root, { p301: "adapter-301" },
    (message) => diagnostics.push(message)),
    "原子替换失败必须向调用方抛出，禁止静默吞错");
  assert.deepEqual(diagnostics, [], "rename 前失败不误走 post-commit 耐久性诊断");
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), [],
    "失败写入清理临时文件，不留下半写状态");
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
