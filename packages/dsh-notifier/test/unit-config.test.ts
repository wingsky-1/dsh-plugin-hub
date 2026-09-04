// @ts-nocheck
/**
 * dsh-notifier — unit：配置契约（normalizeConfig / DEFAULT_CONFIG）与免打扰判定
 * （parseHHMM / isInQuietHours）。
 *
 * 覆盖：默认值/部分覆盖/非法值丢弃/未知键透传/默认对象不被污染/
 * 数值范围键（errorMergeWindowMs、askRemindMin、doneMergeWindowMs、
 * historyMaxAgeDays）/quietHours 归一化（HH:MM 校验、allowKinds 白名单）。
 */
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { assert } from "./helpers.ts";
import { normalizeConfig, parseHHMM, isInQuietHours, DEFAULT_CONFIG, configFile, historyFile, statusFile, toastScriptPath, normalizeBarkBaseUrl, redactConfigView, unmaskChannels, SECRET_MASK, BARK_ID_PATTERN, validateSettings, sanitizeSettings, sanitizePatchSettings, QUIET_ALLOW_KINDS } from "../lib/index.js";

const work = mkdtempSync(join(tmpdir(), "dnotify-unit-config-"));
try {
  const DEFAULT_CONFIG_UNTOUCHED = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // 路径契约（config.ts 导出，#510）：三路径 DSH_HOME 感知——默认形态（无
  // DSH_HOME）与旧版逐字节一致；设 DSH_HOME 时读写面都落隔离 home（隔离验证
  // 不读/不写真实 ~/.dsh）。configFile 是存量自建 json 的迁移源路径（issue #76
  // 后配置走官方 settings 存储，configFile 不再读写，仅迁移读取/改名），迁移源
  // 语义不变、仅 base 解析随 DSH_HOME；historyFile / toast 脚本路径默认形态不变。
  assert.equal(configFile(), join(homedir(), ".dsh", "dsh-notifier.json"), "默认形态：迁移源路径 ~/.dsh/dsh-notifier.json");
  assert.equal(historyFile(), join(homedir(), ".dsh", "dsh-notifier-history.jsonl"), "默认形态：历史路径 ~/.dsh/dsh-notifier-history.jsonl");
  assert.equal(statusFile(), join(homedir(), ".dsh", "dsh-notifier-status.json"), "默认形态：状态路径 ~/.dsh/dsh-notifier-status.json");
  assert.ok(toastScriptPath().endsWith("toast.ps1"), "toast 脚本路径固定到 toast.ps1（src 插桩形态下随加载源解析到 src/）");
  const dshHomeIso = mkdtempSync(join(tmpdir(), "dnotify-dsh-home-"));
  process.env.DSH_HOME = dshHomeIso;
  try {
    assert.equal(configFile(), join(dshHomeIso, "dsh-notifier.json"), "#510：迁移源随 DSH_HOME（隔离 home 的旧配置才被迁移）");
    assert.equal(historyFile(), join(dshHomeIso, "dsh-notifier-history.jsonl"), "#510：历史读/写面随 DSH_HOME");
    assert.equal(statusFile(), join(dshHomeIso, "dsh-notifier-status.json"), "#510：状态写面随 DSH_HOME");
  } finally {
    delete process.env.DSH_HOME;
    rmSync(dshHomeIso, { recursive: true, force: true });
  }

  assert.equal(normalizeConfig(undefined).notifyAsk, true);
  // DEFAULT_CONFIG 全字段默认值锁定（对照 config.ts 幸存 BooleanLiteral：
  // 默认值翻转的存活变异体由显式默认断言杀灭）
  assert.equal(DEFAULT_CONFIG.notifyTaskError, true, "默认错误通知开启");
  assert.equal(DEFAULT_CONFIG.notifyTurnEnd, false, "默认轮结束通知关闭");
  assert.equal(DEFAULT_CONFIG.systemNotify, true, "默认系统通知开启");
  assert.equal(DEFAULT_CONFIG.browserNotify, true, "默认浏览器通知开启");
  assert.equal(DEFAULT_CONFIG.notifySound, true, "默认提示音开启");
  const merged = normalizeConfig({ notifyAsk: false, bogus: 1, quietHours: { enabled: true, start: "23:30", end: "06:00", x: 1 } });
  assert.equal(merged.notifyAsk, false);
  assert.equal(merged.notifyTaskDone, true);
  assert.equal(merged.quietHours.enabled, true);
  assert.equal(merged.quietHours.start, "23:30");
  assert.equal(merged.bogus, 1, "未知键透传保留（防降级丢键）");
  assert.equal(normalizeConfig({ quietHours: { start: "25:00" } }).quietHours.start, "22:00", "非法 HH:MM(25:00) 丢弃回默认");
  assert.equal(normalizeConfig({ quietHours: { start: "9:30" } }).quietHours.start, "22:00", "非两位 HH:MM 丢弃");
  assert.equal(normalizeConfig({ notifyAsk: "yes" }).notifyAsk, true, "非布尔丢弃");
  assert.equal(normalizeConfig({ notifyWhenVisible: true }).notifyWhenVisible, true, "页面可见也弹可配置");
  assert.equal(normalizeConfig({ notifyWhenVisible: "x" }).notifyWhenVisible, false, "非布尔丢弃");
  assert.equal(normalizeConfig({ notifyQuestion: false }).notifyQuestion, false, "提问通知可配置");
  assert.equal(normalizeConfig({ notifyQuestion: "x" }).notifyQuestion, true, "非布尔丢弃回默认");
  assert.equal(DEFAULT_CONFIG_UNTOUCHED.quietHours.enabled, false, "normalizeConfig 不污染默认配置");
  assert.equal(normalizeConfig({ errorMergeWindowMs: 5000 }).errorMergeWindowMs, 5000, "合并窗口可配置");
  assert.equal(normalizeConfig({ errorMergeWindowMs: -1 }).errorMergeWindowMs, DEFAULT_CONFIG.errorMergeWindowMs, "非法窗口丢弃");
  assert.equal(normalizeConfig({ errorMergeWindowMs: "x" }).errorMergeWindowMs, DEFAULT_CONFIG.errorMergeWindowMs, "非数字窗口丢弃");
  assert.equal(DEFAULT_CONFIG.notifySubagentDone, false, "子代理完成通知默认关闭");
  assert.equal(normalizeConfig({ notifySubagentDone: true }).notifySubagentDone, true, "子代理完成可配置");
  assert.equal(normalizeConfig({ notifySubagentDone: "x" }).notifySubagentDone, false, "非布尔丢弃回默认");

  assert.equal(parseHHMM("22:00"), 1320);
  assert.equal(parseHHMM("08:30"), 510);
  assert.ok(Number.isNaN(parseHHMM("8:30")));
  assert.ok(Number.isNaN(parseHHMM("25:00")));

  assert.equal(isInQuietHours(new Date(2026, 0, 1, 23, 0), { enabled: true, start: "22:00", end: "08:00" }), true, "跨午夜晚间");
  assert.equal(isInQuietHours(new Date(2026, 0, 1, 7, 0), { enabled: true, start: "22:00", end: "08:00" }), true, "跨午夜凌晨");
  assert.equal(isInQuietHours(new Date(2026, 0, 1, 12, 0), { enabled: true, start: "22:00", end: "08:00" }), false, "中午不静默");
  assert.equal(isInQuietHours(new Date(2026, 0, 1, 12, 0), { enabled: false, start: "22:00", end: "08:00" }), false, "禁用");
  assert.equal(isInQuietHours(new Date(2026, 0, 1, 9, 0), { enabled: true, start: "09:00", end: "17:00" }), true, "同日内");
  assert.equal(isInQuietHours(new Date(2026, 0, 1, 8, 0), { enabled: true, start: "09:00", end: "17:00" }), false);

  // #421：QUIET_ALLOW_KINDS 扩至全部 6 个内置事件（豁免候选全量）
  assert.deepEqual([...QUIET_ALLOW_KINDS], ["ask", "question", "done", "subagent-done", "error", "turn-end"], "#421：QUIET_ALLOW_KINDS 覆盖全部内置事件 kind");

  // M4 配置归一化：askRemindMin / quietHours.allowKinds
  assert.equal(normalizeConfig({ askRemindMin: 3 }).askRemindMin, 3, "审批提醒分钟可配");
  assert.equal(normalizeConfig({ askRemindMin: 0 }).askRemindMin, 0, "0=关闭审批提醒");
  assert.equal(normalizeConfig({ askRemindMin: "x" }).askRemindMin, DEFAULT_CONFIG.askRemindMin, "非法提醒分钟回默认 5");
  // #421：quietHours.allowKinds 放开白名单（全部内置事件可豁免）——未知 kind 项保留、
  // 空串/超长项过滤、去重
  assert.deepEqual(normalizeConfig({ quietHours: { allowKinds: ["ask", "done", "error"] } }).quietHours.allowKinds, ["ask", "done", "error"], "放开后 done 等全部内置事件可豁免");
  assert.deepEqual(normalizeConfig({ quietHours: { allowKinds: ["ask", "bogus", "error"] } }).quietHours.allowKinds, ["ask", "bogus", "error"], "放开后未知 kind 保留（豁免仅 includes 匹配）");
  assert.deepEqual(normalizeConfig({ quietHours: { allowKinds: ["ask", "", "x".repeat(65), "ask"] } }).quietHours.allowKinds, ["ask"], "边界：空串/超长过滤、去重");

  // 合并/清理配置：doneMergeWindowMs / errorMergeWindowMs(0=关) / historyMaxAgeDays
  assert.equal(normalizeConfig({ doneMergeWindowMs: 0 }).doneMergeWindowMs, 0, "完成聚合窗口 0=关闭");
  assert.equal(normalizeConfig({ doneMergeWindowMs: 1500 }).doneMergeWindowMs, 1500, "完成聚合窗口可配");
  assert.equal(normalizeConfig({ doneMergeWindowMs: "x" }).doneMergeWindowMs, DEFAULT_CONFIG.doneMergeWindowMs, "非法完成窗口回默认");
  assert.equal(normalizeConfig({ errorMergeWindowMs: 0 }).errorMergeWindowMs, 0, "错误合并窗口 0=关闭");
  assert.equal(normalizeConfig({ errorMergeWindowMs: -1 }).errorMergeWindowMs, DEFAULT_CONFIG.errorMergeWindowMs, "负数错误窗口回默认");
  assert.equal(normalizeConfig({ historyMaxAgeDays: 30 }).historyMaxAgeDays, 30, "按天清理可配");
  assert.equal(normalizeConfig({ historyMaxAgeDays: 0 }).historyMaxAgeDays, 0, "按天清理 0=关");

  // #330 SSE 连接上限：默认 16，范围 1~1024，非法值丢弃回默认；未知键透传排除表不吞它
  assert.equal(DEFAULT_CONFIG.maxConnections, 16, "maxConnections 默认 16");
  assert.equal(normalizeConfig(undefined).maxConnections, 16, "无输入回默认 16");
  assert.equal(normalizeConfig({ maxConnections: 8 }).maxConnections, 8, "上限可配");
  assert.equal(normalizeConfig({ maxConnections: 1 }).maxConnections, 1, "下限 1 可配");
  assert.equal(normalizeConfig({ maxConnections: 0 }).maxConnections, DEFAULT_CONFIG.maxConnections, "0 非法回默认");
  assert.equal(normalizeConfig({ maxConnections: -3 }).maxConnections, DEFAULT_CONFIG.maxConnections, "负数非法回默认");
  assert.equal(normalizeConfig({ maxConnections: 1025 }).maxConnections, DEFAULT_CONFIG.maxConnections, "超上界 1024 非法回默认");
  assert.equal(normalizeConfig({ maxConnections: 16.6 }).maxConnections, 17, "小数取整");
  assert.equal(normalizeConfig({ maxConnections: "8" }).maxConnections, DEFAULT_CONFIG.maxConnections, "字符串非法回默认");
  assert.equal(normalizeConfig({ maxConnections: 4, bogus: 1 }).bogus, 1, "未知键仍透传（排除表不吞其他键）");

  // ===== M2：channels / kindRoutes / allowKinds 三键（issue #366）=====
  assert.deepEqual(DEFAULT_CONFIG.channels, [], "channels 默认空");
  assert.deepEqual(DEFAULT_CONFIG.kindRoutes, {}, "kindRoutes 默认空");
  assert.deepEqual(DEFAULT_CONFIG.allowKinds, [], "allowKinds 默认空");

  // baseUrl 规范化（SSRF 姿态：scheme 白名单 + 凭据拒绝 + query/hash 丢弃）
  assert.equal(normalizeBarkBaseUrl("http://127.0.0.1:40280"), "http://127.0.0.1:40280", "origin 原样");
  assert.equal(normalizeBarkBaseUrl("http://127.0.0.1:40280/"), "http://127.0.0.1:40280", "尾斜杠去除");
  assert.equal(normalizeBarkBaseUrl("https://api.day.app/push?x=1#frag"), "https://api.day.app/push", "query/hash 丢弃");
  assert.equal(normalizeBarkBaseUrl("ftp://example.com"), null, "非 http(s) scheme 拒绝");
  assert.equal(normalizeBarkBaseUrl("http://user:pass@example.com"), null, "带凭据 URL 拒绝");
  assert.equal(normalizeBarkBaseUrl("not a url"), null, "不可解析拒绝");
  assert.equal(normalizeBarkBaseUrl(""), null, "空串拒绝");
  assert.equal(normalizeBarkBaseUrl(42), null, "非字符串拒绝");

  // 实例归一化：合法保留 / 非法丢弃 / id 去重首个胜出 / 未知参数透传 / 保留键剔除
  const okCh = { id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "realKey123", enabled: false, sound: "minuet", group: "dsh" };
  const mergedCh = normalizeConfig({ channels: [okCh, { id: "bad id", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true }, "junk", null] });
  assert.equal(mergedCh.channels.length, 1, "非法实例丢弃，合法实例保留");
  assert.equal(mergedCh.channels[0].baseUrl, "https://api.day.app");
  assert.equal(mergedCh.channels[0].sound, "minuet", "可选参数保留");
  const dupCh = normalizeConfig({ channels: [{ id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k1", enabled: true }, { id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k2", enabled: false }] });
  assert.equal(dupCh.channels.length, 1, "重复 id 去重");
  assert.equal(dupCh.channels[0].deviceKey, "k1", "重复 id 首个胜出");
  const opaqueCh = normalizeConfig({ channels: [{ id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true, volume: "0.7", device_key: "evil", ciphertext: "x" }] }).channels[0] as Record<string, unknown>;
  assert.equal(opaqueCh.volume, "0.7", "未知 string 参数透传（Bark 前向兼容）");
  assert.equal("device_key" in opaqueCh, false, "保留键 device_key 剔除");
  assert.equal("ciphertext" in opaqueCh, false, "保留键 ciphertext 剔除");
  assert.ok(BARK_ID_PATTERN.test("phone") && BARK_ID_PATTERN.test("bark-01"), "id 格式合法样例");
  assert.ok(!BARK_ID_PATTERN.test("Bad") && !BARK_ID_PATTERN.test("a") && !BARK_ID_PATTERN.test("-x"), "id 格式拒绝大写/单位/连字符开头");

  // kindRoutes / allowKinds 归一化
  const mergedRoutes = normalizeConfig({ kindRoutes: { error: ["browser", "system", "browser"], turnEnd: ["browser"], badKind: "x", empty: [] } });
  assert.deepEqual(mergedRoutes.kindRoutes.error, ["browser", "system"], "kindRoutes 值去重");
  assert.deepEqual(mergedRoutes.kindRoutes.turnEnd, ["browser"]);
  assert.equal("badKind" in mergedRoutes.kindRoutes, false, "非数组值丢弃");
  assert.equal("empty" in mergedRoutes.kindRoutes, false, "空数组丢弃");
  assert.deepEqual(normalizeConfig({ allowKinds: ["idle-archive:due", "", "x".repeat(65), "idle-archive:due"] }).allowKinds, ["idle-archive:due"], "allowKinds 去重与长度过滤");
  // #427：allowKinds 128 项上限——normalize 截断（>128 保留前 128 项）
  const overCap = Array.from({ length: 130 }, (_, i) => "kind-" + i);
  assert.equal(normalizeConfig({ allowKinds: overCap }).allowKinds.length, 128, "顶层 allowKinds 超 128 项截断到 128");
  assert.equal(normalizeConfig({ quietHours: { allowKinds: overCap } }).quietHours.allowKinds.length, 128, "quietHours.allowKinds 超 128 项截断到 128");

  // 透传排除表同步：三键非法值不得以原样透传覆盖归一化结果（L144 坑回归）
  const opaque = normalizeConfig({ channels: "junk", kindRoutes: 5, allowKinds: true, bogus: 1 });
  assert.deepEqual(opaque.channels, [], "channels 非法回默认且不透传");
  assert.deepEqual(opaque.kindRoutes, {}, "kindRoutes 非法回默认且不透传");
  assert.deepEqual(opaque.allowKinds, [], "allowKinds 非法回默认且不透传");
  assert.equal(opaque.bogus, 1, "其他未知键仍透传");

  // #470 复核 P0（读面纵深）：normalizeConfig 透传剔除原型链成员自有键——
  // 存量 user 层若含 JSON.parse 注入的 constructor/__proto__ 等键，不得脏写
  // 运行时镜像、不得改原型
  const readEvil = JSON.parse('{"constructor":1,"toString":2,"hasOwnProperty":3,"valueOf":4,"__proto__":{"polluted":1},"futureRead":9,"notifyAsk":true}');
  const readOut = normalizeConfig(readEvil);
  assert.equal(readOut.notifyAsk, true, "读面：已知键正常归一化");
  assert.equal(readOut.futureRead, 9, "读面：普通未知键仍透传");
  assert.equal(Object.prototype.hasOwnProperty.call(readOut, "constructor"), false, "读面：constructor 剔除不透传（非自有键）");
  assert.equal(Object.prototype.hasOwnProperty.call(readOut, "toString"), false, "读面：toString 剔除不透传（非自有键）");
  assert.equal(Object.getPrototypeOf(readOut), Object.prototype, "读面：normalizeConfig 输出原型未被污染");

  // ===== M2：凭据脱敏与掩码回填（评审 P0-1/P0-2）=====
  const withSecret = { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "realKey123", enabled: true }], notifyAsk: true };
  const redacted = redactConfigView(withSecret);
  assert.equal(redacted.channels[0].deviceKey, SECRET_MASK, "deviceKey 掩码");
  assert.equal(withSecret.channels[0].deviceKey, "realKey123", "深拷贝不污染输入");
  assert.equal(redacted.notifyAsk, true, "其余字段原样");
  assert.deepEqual(redactConfigView({ a: 1 }), { a: 1 }, "无 channels 输入原样");
  assert.equal(redactConfigView(undefined), null, "null 输入兜底");
  // #470 qa 复核发现 2：redactConfigView 特殊键剔除的函数级直测——用
  // defineProperty 造**自有** constructor/__proto__ 键（JSON.stringify 会丢弃
  // undefined 值但不会丢自有键；此处刻意让 stringify 保留它们，证明剔除是
  // redactConfigView 自身逻辑而非序列化副效应）
  const evilOwn = { keep: 1 };
  Object.defineProperty(evilOwn, "constructor", { value: 1, enumerable: true });
  Object.defineProperty(evilOwn, "__proto__", { value: { polluted: 1 }, enumerable: true });
  Object.defineProperty(evilOwn, "toString", { value: "x", enumerable: true });
  const evilOut = redactConfigView(evilOwn);
  assert.equal(Object.prototype.hasOwnProperty.call(evilOut, "keep"), true, "读出口：普通键保留");
  assert.equal(Object.prototype.hasOwnProperty.call(evilOut, "constructor"), false, "读出口：constructor 自有键剔除");
  assert.equal(Object.prototype.hasOwnProperty.call(evilOut, "__proto__"), false, "读出口：__proto__ 自有键剔除");
  assert.equal(Object.prototype.hasOwnProperty.call(evilOut, "toString"), false, "读出口：toString 自有键剔除");
  assert.equal(Object.prototype.polluted, undefined, "读出口：无全局原型污染");

  const userChs = [{ id: "phone", deviceKey: "realKey123" }, { id: "pad", deviceKey: "padKey456" }];
  const unmasked = unmaskChannels(
    [{ id: "pad", deviceKey: SECRET_MASK, baseUrl: "https://h", type: "bark", enabled: true }, { id: "phone", deviceKey: SECRET_MASK, baseUrl: "https://h", type: "bark", enabled: true }, { id: "new1", deviceKey: "freshKey", baseUrl: "https://h", type: "bark", enabled: false }],
    userChs,
  );
  assert.ok(unmasked.ok, "回填成功");
  if (unmasked.ok) {
    assert.equal(unmasked.channels[0].deviceKey, "padKey456", "乱序掩码按 id 对齐回填（防下标串凭据）");
    assert.equal(unmasked.channels[1].deviceKey, "realKey123", "乱序掩码按 id 对齐回填 2");
    assert.equal(unmasked.channels[2].deviceKey, "freshKey", "新实例非掩码 key 保留");
  }
  assert.ok(!unmaskChannels([{ id: "brand-new", deviceKey: SECRET_MASK }], userChs).ok, "新实例带掩码拒绝");
  assert.ok(!unmaskChannels([{ id: "brand-new", deviceKey: SECRET_MASK }], []).ok, "user 层空时新实例掩码拒绝");
  const plainPatch = unmaskChannels([{ id: "phone", deviceKey: "plain" }], userChs);
  assert.ok(plainPatch.ok && (plainPatch as { channels: Array<{ deviceKey: string }> }).channels[0].deviceKey === "plain", "非掩码 patch 原样通过");
  assert.ok(unmaskChannels(undefined, userChs).ok, "非数组输入兜底 ok");

  // 写入校验：channels 整组（重复 id 400 口径 / 保留键拒绝 / baseUrl scheme）
  assert.equal(validateSettings({ channels: [okCh] }), null, "合法实例通过");
  assert.equal(validateSettings({ channels: [okCh, { ...okCh, id: "phone" }] })?.key, "channels", "重复 id 拒绝");
  assert.equal(validateSettings({ channels: [{ ...okCh, device_key: "x" }] })?.key, "channels", "保留键写入口径拒绝");
  assert.equal(validateSettings({ channels: [{ ...okCh, baseUrl: "ftp://h" }] })?.key, "channels", "非法 scheme 拒绝");
  assert.equal(validateSettings({ channels: [{ ...okCh, deviceKey: "" }] })?.key, "channels", "空 deviceKey 拒绝");

  // levels（kind→level 稀疏映射矩阵）：归一化保留合法 / 丢弃非法值 / 剔原型键 / 不进透传
  const lvCh = { ...okCh, levels: { question: "timeSensitive", error: "active", "subagent-done": "active" } };
  const mergedLv = normalizeConfig({ channels: [lvCh] }).channels[0] as Record<string, unknown>;
  assert.deepEqual(mergedLv.levels, { question: "timeSensitive", error: "active", "subagent-done": "active" }, "合法 levels 归一化保留");
  const badLv = normalizeConfig({ channels: [{ ...okCh, levels: { question: "timeSensitive", bogus: "urgent", "": "active", x: "x".repeat(65) } }] }).channels[0] as Record<string, unknown>;
  assert.deepEqual(badLv.levels, { question: "timeSensitive" }, "非法值/空键/超长键丢弃");
  const protoLv = normalizeConfig({ channels: [{ ...okCh, levels: JSON.parse('{"__proto__":"critical","constructor":"active","prototype":"passive","question":"active"}') }] }).channels[0] as Record<string, unknown>;
  assert.deepEqual(protoLv.levels, { question: "active" }, "原型污染类键剔除");
  const noLv = normalizeConfig({ channels: [{ ...okCh, levels: {} }] }).channels[0] as Record<string, unknown>;
  assert.equal("levels" in noLv, false, "空对象 levels 归一化为缺省");
  const opaqueLv = normalizeConfig({ channels: [{ ...okCh, levels: { question: "active" }, volume: "0.7" }] }).channels[0] as Record<string, unknown>;
  assert.equal(opaqueLv.volume, "0.7", "levels 键不干扰未知参数透传");
  // levels 写入校验（严格口径：任一项非法整组 400）
  assert.equal(validateSettings({ channels: [lvCh] }), null, "合法 levels 通过");
  assert.equal(validateSettings({ channels: [{ ...okCh, levels: { question: "loud" } }] })?.key, "channels", "非法 level 值拒绝");
  assert.equal(validateSettings({ channels: [{ ...okCh, levels: { "": "active" } }] })?.key, "channels", "空 kind 键拒绝");
  assert.equal(validateSettings({ channels: [{ ...okCh, levels: JSON.parse('{"q":"active","__proto__":"critical"}') }] })?.key, "channels", "原型键拒绝");
  const many = Object.fromEntries(Array.from({ length: 65 }, function (_, i) { return ["k" + i, "active"]; }));
  assert.equal(validateSettings({ channels: [{ ...okCh, levels: many }] })?.key, "channels", "超 64 项 levels 拒绝");
  assert.equal(validateSettings({ kindRoutes: { error: ["browser"] } }), null, "合法 kindRoutes 通过");
  assert.equal(validateSettings({ kindRoutes: { error: [] } })?.key, "kindRoutes", "空数组 kindRoutes 拒绝");
  assert.equal(validateSettings({ allowKinds: ["a:b"] }), null, "合法 allowKinds 通过");
  assert.equal(validateSettings({ allowKinds: [42] })?.key, "allowKinds", "非字符串 allowKinds 拒绝");
  // #421：quietHours.allowKinds 写入校验放开（与顶层 allowKinds 同口径：非空字符串 ≤64、≤128）
  assert.equal(validateSettings({ quietHours: { enabled: true, allowKinds: ["ask", "done", "turn-end"] } }), null, "放开后全部内置事件可写入豁免");
  assert.equal(validateSettings({ quietHours: { allowKinds: [42] } })?.key, "quietHours", "quietHours.allowKinds 非字符串拒绝（整组 400）");
  assert.equal(validateSettings({ quietHours: { allowKinds: [""] } })?.key, "quietHours", "quietHours.allowKinds 空串拒绝");
  // #427：allowKinds 128 项上限——写入校验 >128 拒绝、恰好 128 通过（isAllowKinds / isConfirmedKinds 同口径）
  const capPlus1 = Array.from({ length: 129 }, (_, i) => "k" + i);
  assert.equal(validateSettings({ allowKinds: capPlus1 })?.key, "allowKinds", "顶层 allowKinds 超 128 项拒绝");
  assert.equal(validateSettings({ quietHours: { allowKinds: capPlus1 } })?.key, "quietHours", "quietHours.allowKinds 超 128 项拒绝（整组 400）");
  const cap128 = Array.from({ length: 128 }, (_, i) => "k" + i);
  assert.equal(validateSettings({ allowKinds: cap128 }), null, "顶层 allowKinds 恰 128 项通过");
  assert.equal(validateSettings({ quietHours: { allowKinds: cap128 } }), null, "quietHours.allowKinds 恰 128 项通过");
  const sanitizedCh = sanitizeSettings({ channels: [{ ...okCh, volume: "0.7" }] });
  assert.ok(sanitizedCh && Array.isArray(sanitizedCh.channels) && sanitizedCh.channels.length === 1, "sanitizeSettings channels 往返");
  assert.deepEqual(sanitizeSettings({ futureKey: 1 }), {}, "entry 白名单通道：未来键仍丢弃（组合层装配专用，#470 双通道拆分）");

  // ===== #470：sanitizePatchSettings（PUT/迁移透传通道）=====
  assert.deepEqual(sanitizePatchSettings({ futureKey: 1 }), { futureKey: 1 }, "透传通道：纯未知键原样保留");
  assert.deepEqual(sanitizePatchSettings({ notifyAsk: false, futureKey: { a: 1 } }), { notifyAsk: false, futureKey: { a: 1 } }, "透传通道：已知+未知混合双保留");
  assert.deepEqual(sanitizePatchSettings({}), {}, "透传通道：空 patch 空对象（调用方按 400 语义处理）");
  assert.equal(sanitizePatchSettings({ notifyAsk: "yes" }), null, "透传通道：已知键非法 → 整体拒绝 null");
  assert.deepEqual(sanitizePatchSettings({ configFile: "/x", toastScript: "/y", historyFile: "/z", statusFile: "/s", enabled: false }), {}, "透传通道：装配键全部剔除（不入 user 层）");
  assert.deepEqual(sanitizePatchSettings({ configFile: "/x", notifyQuestion: false, futureKey: 2 }), { notifyQuestion: false, futureKey: 2 }, "透传通道：混合提交剔除装配键、保留已知+未知");
  // 透传通道不深改值（原样引用与深等）
  const nested = { futureObj: { x: [1, 2] } };
  const nestedOut = sanitizePatchSettings(nested);
  assert.deepEqual(nestedOut, nested, "透传通道：任意 JSON 值原样并入");
  assert.equal(sanitizePatchSettings(null), null, "透传通道：非对象 → null");
  assert.deepEqual(sanitizePatchSettings({ notifyTaskDone: true }), { notifyTaskDone: true }, "透传通道：纯已知键与 entry 白名单同结果");
  assert.equal(sanitizePatchSettings({ channels: [{ ...okCh, volume: "0.7" }] }).channels[0].volume, "0.7", "透传通道：channels 内未知 string/number 参数保留（Bark 前向兼容不变）");
  // #470 复核 P0：数组 patch 不得被当对象透传成数字索引脏键 → null（调用方 400）
  assert.equal(sanitizePatchSettings([1, 2]), null, "透传通道：数组 patch → null（拒绝，不写脏 user 层）");
  assert.equal(sanitizePatchSettings([]), null, "透传通道：空数组 → null");
  // #470 复核 P0：原型链成员键经 JSON.parse 成为自有键 → 剔除不写入、不触发原型校验器
  const protoEvil = JSON.parse('{"__proto__":{"polluted":1},"constructor":1,"prototype":2,"toString":3,"hasOwnProperty":4,"valueOf":5,"futureKey":7}');
  const protoEvilOut = sanitizePatchSettings(protoEvil);
  assert.deepEqual(protoEvilOut, { futureKey: 7 }, "透传通道：原型链成员键剔除、未知键仍透传");
  assert.equal(Object.getPrototypeOf(protoEvilOut), Object.prototype, "透传通道：__proto__ 不改变 out 原型（无原型污染）");
  const protoKnownEvil = JSON.parse('{"notifyAsk":false,"__proto__":{"polluted":1},"constructor":1}');
  assert.deepEqual(sanitizePatchSettings(protoKnownEvil), { notifyAsk: false }, "透传通道：原型键与已知键混合 → 只留已知键");
  // #470 qa 复核发现 1：null 值语义分层——未知键 null 透传保留（与读面一致），
  // 已知键 null 沿用既有跳过语义（视同未提交）
  assert.deepEqual(sanitizePatchSettings({ nullFuture: null, notifyAsk: null }), { nullFuture: null }, "透传通道：未知键 null 透传保留、已知键 null 跳过");
  assert.deepEqual(sanitizePatchSettings({ notifyAsk: null }), {}, "透传通道：纯已知键 null patch 净化后空对象（调用方按 400 处理）");
  assert.deepEqual(sanitizePatchSettings({ nullFuture: null }), { nullFuture: null }, "透传通道：纯未知键 null patch 非空（可写）");
  // 读面 normalizeConfig 本就透传 null（与写面闭合）
  const nullRead = normalizeConfig({ nullFuture: null });
  assert.equal(Object.prototype.hasOwnProperty.call(nullRead, "nullFuture"), true, "读面：未知键 null 透传保留");
  assert.equal(nullRead.nullFuture, null, "读面：未知键 null 值原样");
} finally {
  rmSync(work, { recursive: true, force: true });
}
