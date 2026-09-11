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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeConfig, parseHHMM, isInQuietHours, DEFAULT_CONFIG, configFile, historyFile, statusFile, toastScriptPath, normalizeBarkBaseUrl, redactConfigView, unmaskChannels, SECRET_MASK, BARK_ID_PATTERN, validateSettings, sanitizeSettings, sanitizePatchSettings, QUIET_ALLOW_KINDS, SOUND_IDS, isSoundSetting, resolveSoundSetting } from "../../src/index.ts";
// seqFile 是域内路径函数（装配用），不进包导出面——src 直连（同
// unit-server-sse-bus 直测 src/interface 姿态；包导出面快照契约零 diff）。
import { seqFile } from "../../src/config/interface.ts";
import type { BarkChannelConfig, NotifyConfig } from "../../src/config/interface.ts";

/** resolveSoundSetting 的真实输入域：存量 user 层两新键可缺（undefined）、旧键可为历史残留值。 */
type SoundConfigInput = Pick<NotifyConfig, "browserSound" | "systemSound" | "notifySound">;

/** 默认配置未被 normalize 污染的快照（模块加载即取，早于任何被测调用）。 */
const DEFAULT_CONFIG_UNTOUCHED = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

/** 掩码回填受理面（未受理即抛——断言前置的受理条件）。 */
function unmaskOk(result: ReturnType<typeof unmaskChannels>): Array<Record<string, unknown>> {
  if (!result.ok) throw new Error("掩码回填未受理");
  return result.channels as unknown as Array<Record<string, unknown>>;
}

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-unit-config-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("路径契约：三路径默认形态（无 DSH_HOME）", () => {
  // config.ts 导出：三路径 DSH_HOME 感知——默认形态（无 DSH_HOME）与旧版逐字节一致。
  // configFile 是存量自建 json 的迁移源路径（迁移后配置走官方 settings 存储）。
  it("默认形态：迁移源路径 ~/.dsh/dsh-notifier.json", () => {
    expect(configFile()).toBe(join(homedir(), ".dsh", "dsh-notifier.json"));
  });

  it("默认形态：历史路径 ~/.dsh/dsh-notifier-history.jsonl", () => {
    expect(historyFile()).toBe(join(homedir(), ".dsh", "dsh-notifier-history.jsonl"));
  });

  it("默认形态：状态路径 ~/.dsh/dsh-notifier-status.json", () => {
    expect(statusFile()).toBe(join(homedir(), ".dsh", "dsh-notifier-status.json"));
  });

  it("默认形态：seq 计数路径 ~/.dsh/notifier-seq.json（与 statusFile 同目录，R-6/D22）", () => {
    expect(seqFile()).toBe(join(homedir(), ".dsh", "notifier-seq.json"));
  });

  it("toast 脚本路径固定到 toast.ps1（src 插桩形态下随加载源解析到 src/）", () => {
    expect(toastScriptPath().endsWith("toast.ps1")).toBeTruthy();
  });
});

describe("路径契约：设 DSH_HOME 时读写面都落隔离 home", () => {
  // 隔离验证不读/不写真实 ~/.dsh；historyFile / toast 脚本路径默认形态不变。
  let dshHomeIso: string;

  beforeAll(() => {
    dshHomeIso = mkdtempSync(join(tmpdir(), "dnotify-dsh-home-"));
    process.env.DSH_HOME = dshHomeIso;
  });
  afterAll(() => {
    delete process.env.DSH_HOME;
    rmSync(dshHomeIso, { recursive: true, force: true });
  });

  it("#510：迁移源随 DSH_HOME（隔离 home 的旧配置才被迁移）", () => {
    expect(configFile()).toBe(join(dshHomeIso, "dsh-notifier.json"));
  });

  it("#510：历史读/写面随 DSH_HOME", () => {
    expect(historyFile()).toBe(join(dshHomeIso, "dsh-notifier-history.jsonl"));
  });

  it("#510：状态写面随 DSH_HOME", () => {
    expect(statusFile()).toBe(join(dshHomeIso, "dsh-notifier-status.json"));
  });

  it("#510：seq 计数读写面随 DSH_HOME", () => {
    expect(seqFile()).toBe(join(dshHomeIso, "notifier-seq.json"));
  });
});

describe("DEFAULT_CONFIG 全字段默认值锁定", () => {
  // 对照 config.ts 幸存 BooleanLiteral：默认值翻转的存活变异体由显式默认断言杀灭
  it("normalizeConfig(undefined).notifyAsk 默认 true", () => {
    expect(normalizeConfig(undefined).notifyAsk).toBe(true);
  });

  it("默认错误通知开启", () => {
    expect(DEFAULT_CONFIG.notifyTaskError).toBe(true);
  });

  it("默认轮结束通知关闭", () => {
    expect(DEFAULT_CONFIG.notifyTurnEnd).toBe(false);
  });

  it("默认系统通知开启", () => {
    expect(DEFAULT_CONFIG.systemNotify).toBe(true);
  });

  it("默认浏览器通知开启", () => {
    expect(DEFAULT_CONFIG.browserNotify).toBe(true);
  });

  it("默认提示音开启", () => {
    expect(DEFAULT_CONFIG.notifySound).toBe(true);
  });

  it("channels 默认空", () => {
    expect(DEFAULT_CONFIG.channels).toEqual([]);
  });

  it("kindRoutes 默认空", () => {
    expect(DEFAULT_CONFIG.kindRoutes).toEqual({});
  });

  it("allowKinds 默认空", () => {
    expect(DEFAULT_CONFIG.allowKinds).toEqual([]);
  });
});

describe("每通道独立声音配置 A1：SOUND_IDS 定稿集合", () => {
  it("A1：SOUND_IDS 定稿 4 音色（无 default/complete）", () => {
    expect([...SOUND_IDS]).toEqual(["ding", "bell", "chime", "pop"]);
  });

  it("A1：browserSound 默认 true（跟随系统）", () => {
    expect(DEFAULT_CONFIG.browserSound).toBe(true);
  });

  it("A1：systemSound 默认 true（跟随系统）", () => {
    expect(DEFAULT_CONFIG.systemSound).toBe(true);
  });
});

describe("A2：isSoundSetting 合法域与非法域", () => {
  for (const ok of [false, true, "ding", "bell", "chime", "pop"]) {
    it(`A2：isSoundSetting(${JSON.stringify(ok)}) 合法`, () => {
      expect(isSoundSetting(ok)).toBe(true);
    });
  }

  for (const bad of ["default", "complete", "loud", "", 1, null, { a: 1 }]) {
    it(`A2：isSoundSetting(${JSON.stringify(bad)}) 非法`, () => {
      expect(isSoundSetting(bad)).toBe(false);
    });
  }
});

describe("A2：SETTING_VALIDATORS 含两新键（合法通过、非法 400）", () => {
  it("A2：browserSound 音色合法", () => {
    expect(validateSettings({ browserSound: "ding" })).toBe(null);
  });

  it("A2：systemSound false 合法", () => {
    expect(validateSettings({ systemSound: false })).toBe(null);
  });

  it("A2：非白名单音色拒绝（首个非法键）", () => {
    expect(validateSettings({ browserSound: "default" })?.key).toBe("browserSound");
  });

  it("A2：systemSound 非白名单拒绝", () => {
    expect(validateSettings({ systemSound: "complete" })?.key).toBe("systemSound");
  });

  it("A2：browserSound 任意字符串拒绝", () => {
    expect(validateSettings({ browserSound: "<script>" })?.key).toBe("browserSound");
  });

  it("A2：hint 含音色白名单提示", () => {
    expect(String(validateSettings({ browserSound: 1 })?.hint).includes("ding/bell/chime/pop")).toBeTruthy();
  });
});

describe("A3：normalize 声音专用分支（合法归一化、非法不回默认且不透传）", () => {
  it("A3：browserSound 音色归一化", () => {
    expect(normalizeConfig({ browserSound: "ding" }).browserSound).toBe("ding");
  });

  it("A3：systemSound 音色归一化", () => {
    expect(normalizeConfig({ systemSound: "pop", browserSound: false }).systemSound).toBe("pop");
  });

  it("A3：两键独立归一化", () => {
    expect(normalizeConfig({ systemSound: "pop", browserSound: false }).browserSound).toBe(false);
  });

  it("A3：非法值丢弃回默认（回落 default true）", () => {
    expect(normalizeConfig({ browserSound: "<script>" }).browserSound).toBe(true);
  });

  it("A3：不透传（无 <script> 键）", () => {
    const evilSound = normalizeConfig({ browserSound: "<script>", systemSound: "ding", other: 1 }) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(evilSound, "<script>")).toBe(false);
  });

  it("A3：browserSound 键恒存在（默认兜底）", () => {
    const evilSound = normalizeConfig({ browserSound: "<script>", systemSound: "ding", other: 1 }) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(evilSound, "browserSound")).toBe(true);
  });

  it("A3：非法值不跨键污染", () => {
    expect(normalizeConfig({ browserSound: "<script>" }).systemSound).toBe(true);
  });
});

describe("A4：resolveSoundSetting 四形态回落（两新键齐 / 单新键 / 仅旧键 / 全缺）", () => {
  it("A4：新键优先（browser）", () => {
    expect(resolveSoundSetting({ browserSound: "ding", systemSound: "pop", notifySound: false }, "browser")).toBe("ding");
  });

  it("A4：新键优先（system）", () => {
    expect(resolveSoundSetting({ browserSound: "ding", systemSound: "pop", notifySound: false }, "system")).toBe("pop");
  });

  it("A4：显式 false 不再回落（写面权威）", () => {
    expect(resolveSoundSetting({ browserSound: false, systemSound: undefined, notifySound: true } as unknown as SoundConfigInput, "browser")).toBe(false);
  });

  it("A4：system 显式 true 不回落旧键", () => {
    expect(resolveSoundSetting({ browserSound: undefined, systemSound: true, notifySound: false } as unknown as SoundConfigInput, "system")).toBe(true);
  });

  it("A4：仅旧键 → 回落 notifySound", () => {
    expect(resolveSoundSetting({ browserSound: undefined, systemSound: undefined, notifySound: false } as unknown as SoundConfigInput, "browser")).toBe(false);
  });

  it("A4：仅旧键回落沿用（含旧值形态）", () => {
    expect(resolveSoundSetting({ browserSound: undefined, systemSound: undefined, notifySound: "ding" } as unknown as SoundConfigInput, "system")).toBe("ding");
  });

  it("A4：全缺 → true（跟随系统默认）", () => {
    expect(resolveSoundSetting({ browserSound: undefined, systemSound: undefined, notifySound: undefined } as unknown as SoundConfigInput, "browser")).toBe(true);
  });

  it("A4：全缺 → true（system）", () => {
    expect(resolveSoundSetting({ browserSound: undefined, systemSound: undefined, notifySound: undefined } as unknown as SoundConfigInput, "system")).toBe(true);
  });
});

describe("读面：normalize 后镜像恒含两新键（仅旧键表态时等价映射）", () => {
  // 防「用户曾关声音升级后复活」；两键互不干扰，供 resolveSoundSetting 消费
  it("读面：仅旧键 false → 等价映射 browserSound=false（不复活成有声）", () => {
    expect(normalizeConfig({ notifySound: false }).browserSound).toBe(false);
  });

  it("读面：systemSound 同映射 false", () => {
    expect(normalizeConfig({ notifySound: false }).systemSound).toBe(false);
  });

  it("读面：显式新键优先于旧键映射", () => {
    expect(normalizeConfig({ notifySound: false, browserSound: "ding" }).browserSound).toBe("ding");
  });

  it("读面：旧键映射只作用于未显式新键的通道", () => {
    expect(normalizeConfig({ notifySound: false, browserSound: "ding" }).systemSound).toBe(false);
  });
});

describe("sanitizeContent 契约键（B-4）", () => {
  it("B-4：sanitizeContent 默认 true（统一脱敏开启）", () => {
    expect(DEFAULT_CONFIG.sanitizeContent).toBe(true);
  });

  it("B-4：sanitizeContent=false 明文可配置", () => {
    expect(normalizeConfig({ sanitizeContent: false }).sanitizeContent).toBe(false);
  });

  it("B-4：非布尔丢弃回默认 true", () => {
    expect(normalizeConfig({ sanitizeContent: "x" }).sanitizeContent).toBe(true);
  });

  it("B-4：sanitizeContent false 合法", () => {
    expect(validateSettings({ sanitizeContent: false })).toBe(null);
  });

  it("B-4：非布尔拒绝（首个非法键）", () => {
    expect(validateSettings({ sanitizeContent: "yes" })?.key).toBe("sanitizeContent");
  });

  it("B-4：hint 含布尔范围描述", () => {
    expect(String(validateSettings({ sanitizeContent: "yes" })?.hint).includes("布尔")).toBeTruthy();
  });
});

describe("normalizeConfig：部分覆盖、未知键透传、非法丢弃", () => {
  it("partial override：notifyAsk=false 生效", () => {
    expect(normalizeConfig({ notifyAsk: false, bogus: 1, quietHours: { enabled: true, start: "23:30", end: "06:00", x: 1 } }).notifyAsk).toBe(false);
  });

  it("partial override：未覆盖键回默认 notifyTaskDone=true", () => {
    expect(normalizeConfig({ notifyAsk: false, bogus: 1, quietHours: { enabled: true, start: "23:30", end: "06:00", x: 1 } }).notifyTaskDone).toBe(true);
  });

  it("quietHours.enabled 透传 true", () => {
    expect(normalizeConfig({ notifyAsk: false, bogus: 1, quietHours: { enabled: true, start: "23:30", end: "06:00", x: 1 } }).quietHours.enabled).toBe(true);
  });

  it("quietHours.start 合法值保留", () => {
    expect(normalizeConfig({ notifyAsk: false, bogus: 1, quietHours: { enabled: true, start: "23:30", end: "06:00", x: 1 } }).quietHours.start).toBe("23:30");
  });

  it("未知键透传保留（防降级丢键）", () => {
    expect((normalizeConfig({ notifyAsk: false, bogus: 1, quietHours: { enabled: true, start: "23:30", end: "06:00", x: 1 } }) as unknown as { bogus?: number }).bogus).toBe(1);
  });

  it("非法 HH:MM(25:00) 丢弃回默认", () => {
    expect(normalizeConfig({ quietHours: { start: "25:00" } }).quietHours.start).toBe("22:00");
  });

  it("非两位 HH:MM 丢弃", () => {
    expect(normalizeConfig({ quietHours: { start: "9:30" } }).quietHours.start).toBe("22:00");
  });

  it("非布尔丢弃（notifyAsk=yes 回默认 true）", () => {
    expect(normalizeConfig({ notifyAsk: "yes" }).notifyAsk).toBe(true);
  });

  it("页面可见也弹可配置", () => {
    expect(normalizeConfig({ notifyWhenVisible: true }).notifyWhenVisible).toBe(true);
  });

  it("非布尔丢弃（notifyWhenVisible=x 回默认 false）", () => {
    expect(normalizeConfig({ notifyWhenVisible: "x" }).notifyWhenVisible).toBe(false);
  });

  it("提问通知可配置", () => {
    expect(normalizeConfig({ notifyQuestion: false }).notifyQuestion).toBe(false);
  });

  it("非布尔丢弃回默认（notifyQuestion=x → true）", () => {
    expect(normalizeConfig({ notifyQuestion: "x" }).notifyQuestion).toBe(true);
  });

  it("normalizeConfig 不污染默认配置", () => {
    expect(DEFAULT_CONFIG_UNTOUCHED.quietHours.enabled).toBe(false);
  });
});

describe("数值范围键：errorMergeWindowMs / doneMergeWindowMs / historyMaxAgeDays / askRemindMin", () => {
  it("合并窗口可配置", () => {
    expect(normalizeConfig({ errorMergeWindowMs: 5000 }).errorMergeWindowMs).toBe(5000);
  });

  it("非法窗口丢弃", () => {
    expect(normalizeConfig({ errorMergeWindowMs: -1 }).errorMergeWindowMs).toBe(DEFAULT_CONFIG.errorMergeWindowMs);
  });

  it("非数字窗口丢弃", () => {
    expect(normalizeConfig({ errorMergeWindowMs: "x" }).errorMergeWindowMs).toBe(DEFAULT_CONFIG.errorMergeWindowMs);
  });

  it("完成聚合窗口 0=关闭", () => {
    expect(normalizeConfig({ doneMergeWindowMs: 0 }).doneMergeWindowMs).toBe(0);
  });

  it("完成聚合窗口可配", () => {
    expect(normalizeConfig({ doneMergeWindowMs: 1500 }).doneMergeWindowMs).toBe(1500);
  });

  it("非法完成窗口回默认", () => {
    expect(normalizeConfig({ doneMergeWindowMs: "x" }).doneMergeWindowMs).toBe(DEFAULT_CONFIG.doneMergeWindowMs);
  });

  it("错误合并窗口 0=关闭", () => {
    expect(normalizeConfig({ errorMergeWindowMs: 0 }).errorMergeWindowMs).toBe(0);
  });

  it("负数错误窗口回默认", () => {
    expect(normalizeConfig({ errorMergeWindowMs: -1 }).errorMergeWindowMs).toBe(DEFAULT_CONFIG.errorMergeWindowMs);
  });

  it("按天清理可配", () => {
    expect(normalizeConfig({ historyMaxAgeDays: 30 }).historyMaxAgeDays).toBe(30);
  });

  it("按天清理 0=关", () => {
    expect(normalizeConfig({ historyMaxAgeDays: 0 }).historyMaxAgeDays).toBe(0);
  });

  it("审批提醒分钟可配", () => {
    expect(normalizeConfig({ askRemindMin: 3 }).askRemindMin).toBe(3);
  });

  it("0=关闭审批提醒", () => {
    expect(normalizeConfig({ askRemindMin: 0 }).askRemindMin).toBe(0);
  });

  it("非法提醒分钟回默认 5", () => {
    expect(normalizeConfig({ askRemindMin: "x" }).askRemindMin).toBe(DEFAULT_CONFIG.askRemindMin);
  });
});

describe("子代理完成通知开关", () => {
  it("子代理完成通知默认关闭", () => {
    expect(DEFAULT_CONFIG.notifySubagentDone).toBe(false);
  });

  it("子代理完成可配置", () => {
    expect(normalizeConfig({ notifySubagentDone: true }).notifySubagentDone).toBe(true);
  });

  it("非布尔丢弃回默认", () => {
    expect(normalizeConfig({ notifySubagentDone: "x" }).notifySubagentDone).toBe(false);
  });
});

describe("SSE 连接上限：默认 16，范围 1~1024，非法值丢弃回默认", () => {
  it("maxConnections 默认 16", () => {
    expect(DEFAULT_CONFIG.maxConnections).toBe(16);
  });

  it("无输入回默认 16", () => {
    expect(normalizeConfig(undefined).maxConnections).toBe(16);
  });

  it("上限可配", () => {
    expect(normalizeConfig({ maxConnections: 8 }).maxConnections).toBe(8);
  });

  it("下限 1 可配", () => {
    expect(normalizeConfig({ maxConnections: 1 }).maxConnections).toBe(1);
  });

  it("0 非法回默认", () => {
    expect(normalizeConfig({ maxConnections: 0 }).maxConnections).toBe(DEFAULT_CONFIG.maxConnections);
  });

  it("负数非法回默认", () => {
    expect(normalizeConfig({ maxConnections: -3 }).maxConnections).toBe(DEFAULT_CONFIG.maxConnections);
  });

  it("超上界 1024 非法回默认", () => {
    expect(normalizeConfig({ maxConnections: 1025 }).maxConnections).toBe(DEFAULT_CONFIG.maxConnections);
  });

  it("小数取整", () => {
    expect(normalizeConfig({ maxConnections: 16.6 }).maxConnections).toBe(17);
  });

  it("字符串非法回默认", () => {
    expect(normalizeConfig({ maxConnections: "8" }).maxConnections).toBe(DEFAULT_CONFIG.maxConnections);
  });

  it("未知键仍透传（排除表不吞其他键）", () => {
    expect((normalizeConfig({ maxConnections: 4, bogus: 1 }) as unknown as { bogus?: number }).bogus).toBe(1);
  });
});

describe("parseHHMM", () => {
  it('parseHHMM("22:00") → 1320', () => {
    expect(parseHHMM("22:00")).toBe(1320);
  });

  it('parseHHMM("08:30") → 510', () => {
    expect(parseHHMM("08:30")).toBe(510);
  });

  it('parseHHMM("8:30") → NaN（非两位）', () => {
    expect(Number.isNaN(parseHHMM("8:30"))).toBeTruthy();
  });

  it('parseHHMM("25:00") → NaN（越界）', () => {
    expect(Number.isNaN(parseHHMM("25:00"))).toBeTruthy();
  });
});

describe("isInQuietHours", () => {
  it("跨午夜晚间", () => {
    expect(isInQuietHours(new Date(2026, 0, 1, 23, 0), { enabled: true, start: "22:00", end: "08:00" })).toBe(true);
  });

  it("跨午夜凌晨", () => {
    expect(isInQuietHours(new Date(2026, 0, 1, 7, 0), { enabled: true, start: "22:00", end: "08:00" })).toBe(true);
  });

  it("中午不静默", () => {
    expect(isInQuietHours(new Date(2026, 0, 1, 12, 0), { enabled: true, start: "22:00", end: "08:00" })).toBe(false);
  });

  it("禁用", () => {
    expect(isInQuietHours(new Date(2026, 0, 1, 12, 0), { enabled: false, start: "22:00", end: "08:00" })).toBe(false);
  });

  it("同日内", () => {
    expect(isInQuietHours(new Date(2026, 0, 1, 9, 0), { enabled: true, start: "09:00", end: "17:00" })).toBe(true);
  });

  it("同日窗口下界外不静默", () => {
    expect(isInQuietHours(new Date(2026, 0, 1, 8, 0), { enabled: true, start: "09:00", end: "17:00" })).toBe(false);
  });
});

describe("quietHours.allowKinds 归一化与豁免候选全量", () => {
  it("#421：QUIET_ALLOW_KINDS 覆盖全部内置事件 kind", () => {
    expect([...QUIET_ALLOW_KINDS]).toEqual(["ask", "question", "done", "subagent-done", "error", "turn-end"]);
  });

  it("放开后 done 等全部内置事件可豁免", () => {
    // quietHours.allowKinds 放开白名单（全部内置事件可豁免）
    expect(normalizeConfig({ quietHours: { allowKinds: ["ask", "done", "error"] } }).quietHours.allowKinds).toEqual(["ask", "done", "error"]);
  });

  it("放开后未知 kind 保留（豁免仅 includes 匹配）", () => {
    expect(normalizeConfig({ quietHours: { allowKinds: ["ask", "bogus", "error"] } }).quietHours.allowKinds).toEqual(["ask", "bogus", "error"]);
  });

  it("边界：空串/超长过滤、去重", () => {
    expect(normalizeConfig({ quietHours: { allowKinds: ["ask", "", "x".repeat(65), "ask"] } }).quietHours.allowKinds).toEqual(["ask"]);
  });
});

describe("normalizeBarkBaseUrl（SSRF 姿态：scheme 白名单 + 凭据拒绝 + query/hash 丢弃）", () => {
  it("origin 原样", () => {
    expect(normalizeBarkBaseUrl("http://127.0.0.1:40280")).toBe("http://127.0.0.1:40280");
  });

  it("尾斜杠去除", () => {
    expect(normalizeBarkBaseUrl("http://127.0.0.1:40280/")).toBe("http://127.0.0.1:40280");
  });

  it("query/hash 丢弃", () => {
    expect(normalizeBarkBaseUrl("https://api.day.app/push?x=1#frag")).toBe("https://api.day.app/push");
  });

  it("非 http(s) scheme 拒绝", () => {
    expect(normalizeBarkBaseUrl("ftp://example.com")).toBe(null);
  });

  it("带凭据 URL 拒绝", () => {
    expect(normalizeBarkBaseUrl("http://user:pass@example.com")).toBe(null);
  });

  it("不可解析拒绝", () => {
    expect(normalizeBarkBaseUrl("not a url")).toBe(null);
  });

  it("空串拒绝", () => {
    expect(normalizeBarkBaseUrl("")).toBe(null);
  });

  it("非字符串拒绝", () => {
    expect(normalizeBarkBaseUrl(42)).toBe(null);
  });
});

const okCh = { id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "realKey123", enabled: false, sound: "minuet", group: "dsh" };

describe("channels 实例归一化：合法保留 / 非法丢弃 / id 去重 / 保留键剔除", () => {
  it("非法实例丢弃，合法实例保留", () => {
    const mergedCh = normalizeConfig({ channels: [okCh, { id: "bad id", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true }, "junk", null] });
    expect(mergedCh.channels.length).toBe(1);
  });

  it("合法实例 baseUrl 保留", () => {
    const mergedCh = normalizeConfig({ channels: [okCh, { id: "bad id", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true }, "junk", null] });
    expect((mergedCh.channels[0] as BarkChannelConfig).baseUrl).toBe("https://api.day.app");
  });

  it("可选参数保留", () => {
    const mergedCh = normalizeConfig({ channels: [okCh, { id: "bad id", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true }, "junk", null] });
    expect((mergedCh.channels[0] as BarkChannelConfig).sound).toBe("minuet");
  });

  it("重复 id 去重", () => {
    const dupCh = normalizeConfig({ channels: [{ id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k1", enabled: true }, { id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k2", enabled: false }] });
    expect(dupCh.channels.length).toBe(1);
  });

  it("重复 id 首个胜出", () => {
    const dupCh = normalizeConfig({ channels: [{ id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k1", enabled: true }, { id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k2", enabled: false }] });
    expect((dupCh.channels[0] as BarkChannelConfig).deviceKey).toBe("k1");
  });

  it("未知 string 参数透传（Bark 前向兼容）", () => {
    const opaqueCh = normalizeConfig({ channels: [{ id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true, volume: "0.7", device_key: "evil", ciphertext: "x" }] }).channels[0] as unknown as Record<string, unknown>;
    expect(opaqueCh.volume).toBe("0.7");
  });

  it("保留键 device_key 剔除", () => {
    const opaqueCh = normalizeConfig({ channels: [{ id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true, volume: "0.7", device_key: "evil", ciphertext: "x" }] }).channels[0] as unknown as Record<string, unknown>;
    expect("device_key" in opaqueCh).toBe(false);
  });

  it("保留键 ciphertext 剔除", () => {
    const opaqueCh = normalizeConfig({ channels: [{ id: "a1", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true, volume: "0.7", device_key: "evil", ciphertext: "x" }] }).channels[0] as unknown as Record<string, unknown>;
    expect("ciphertext" in opaqueCh).toBe(false);
  });

  it("id 格式合法样例", () => {
    expect(BARK_ID_PATTERN.test("phone") && BARK_ID_PATTERN.test("bark-01")).toBeTruthy();
  });

  it("id 格式拒绝大写/单位/连字符开头", () => {
    expect(!BARK_ID_PATTERN.test("Bad") && !BARK_ID_PATTERN.test("a") && !BARK_ID_PATTERN.test("-x")).toBeTruthy();
  });
});

describe("kindRoutes / allowKinds 归一化", () => {
  it("kindRoutes 值去重", () => {
    const mergedRoutes = normalizeConfig({ kindRoutes: { error: ["browser", "system", "browser"], turnEnd: ["browser"], badKind: "x", empty: [] } });
    expect(mergedRoutes.kindRoutes.error).toEqual(["browser", "system"]);
  });

  it("kindRoutes 单元素保留", () => {
    const mergedRoutes = normalizeConfig({ kindRoutes: { error: ["browser", "system", "browser"], turnEnd: ["browser"], badKind: "x", empty: [] } });
    expect(mergedRoutes.kindRoutes.turnEnd).toEqual(["browser"]);
  });

  it("非数组值丢弃", () => {
    const mergedRoutes = normalizeConfig({ kindRoutes: { error: ["browser", "system", "browser"], turnEnd: ["browser"], badKind: "x", empty: [] } });
    expect("badKind" in mergedRoutes.kindRoutes).toBe(false);
  });

  it("空数组丢弃", () => {
    const mergedRoutes = normalizeConfig({ kindRoutes: { error: ["browser", "system", "browser"], turnEnd: ["browser"], badKind: "x", empty: [] } });
    expect("empty" in mergedRoutes.kindRoutes).toBe(false);
  });

  it("allowKinds 去重与长度过滤", () => {
    expect(normalizeConfig({ allowKinds: ["idle-archive:due", "", "x".repeat(65), "idle-archive:due"] }).allowKinds).toEqual(["idle-archive:due"]);
  });

  it("顶层 allowKinds 超 128 项截断到 128", () => {
    // allowKinds 128 项上限——normalize 截断（>128 保留前 128 项）
    const overCap = Array.from({ length: 130 }, (_, i) => "kind-" + i);
    expect(normalizeConfig({ allowKinds: overCap }).allowKinds.length).toBe(128);
  });

  it("quietHours.allowKinds 超 128 项截断到 128", () => {
    const overCap = Array.from({ length: 130 }, (_, i) => "kind-" + i);
    expect((normalizeConfig({ quietHours: { allowKinds: overCap } }).quietHours.allowKinds ?? []).length).toBe(128);
  });
});

describe("透传排除表同步（L144 坑回归）", () => {
  const opaque = normalizeConfig({ channels: "junk", kindRoutes: 5, allowKinds: true, bogus: 1 });

  it("channels 非法回默认且不透传", () => {
    expect(opaque.channels).toEqual([]);
  });

  it("kindRoutes 非法回默认且不透传", () => {
    expect(opaque.kindRoutes).toEqual({});
  });

  it("allowKinds 非法回默认且不透传", () => {
    expect(opaque.allowKinds).toEqual([]);
  });

  it("其他未知键仍透传", () => {
    expect((opaque as unknown as { bogus?: number }).bogus).toBe(1);
  });
});

describe("读面纵深：normalizeConfig 透传剔除原型链成员自有键", () => {
  // 存量 user 层若含 JSON.parse 注入的 constructor/__proto__ 等键，不得脏写
  // 运行时镜像、不得改原型
  const readEvil = JSON.parse('{"constructor":1,"toString":2,"hasOwnProperty":3,"valueOf":4,"__proto__":{"polluted":1},"futureRead":9,"notifyAsk":true}');
  const readOut = normalizeConfig(readEvil);

  it("读面：已知键正常归一化", () => {
    expect(readOut.notifyAsk).toBe(true);
  });

  it("读面：普通未知键仍透传", () => {
    expect((readOut as unknown as { futureRead?: number }).futureRead).toBe(9);
  });

  it("读面：constructor 剔除不透传（非自有键）", () => {
    expect(Object.prototype.hasOwnProperty.call(readOut, "constructor")).toBe(false);
  });

  it("读面：toString 剔除不透传（非自有键）", () => {
    expect(Object.prototype.hasOwnProperty.call(readOut, "toString")).toBe(false);
  });

  it("读面：normalizeConfig 输出原型未被污染", () => {
    expect(Object.getPrototypeOf(readOut)).toBe(Object.prototype);
  });
});

describe("凭据脱敏：redactConfigView", () => {
  const withSecret = { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "realKey123", enabled: true }], notifyAsk: true };

  it("deviceKey 掩码", () => {
    expect(redactConfigView(withSecret).channels[0].deviceKey).toBe(SECRET_MASK);
  });

  it("深拷贝不污染输入", () => {
    redactConfigView(withSecret);
    expect(withSecret.channels[0].deviceKey).toBe("realKey123");
  });

  it("其余字段原样", () => {
    expect(redactConfigView(withSecret).notifyAsk).toBe(true);
  });

  it("无 channels 输入原样", () => {
    expect(redactConfigView({ a: 1 })).toEqual({ a: 1 });
  });

  it("null 输入兜底", () => {
    expect(redactConfigView(undefined)).toBe(null);
  });
});

describe("redactConfigView 特殊键剔除（自有键，非序列化副效应）", () => {
  // 用 defineProperty 造**自有** constructor/__proto__ 键（JSON.stringify 会丢弃
  // undefined 值但不会丢自有键；此处刻意让 stringify 保留它们，证明剔除是
  // redactConfigView 自身逻辑而非序列化副效应）
  function evilOut(): Record<string, unknown> {
    const evilOwn: Record<string, unknown> = { keep: 1 };
    Object.defineProperty(evilOwn, "constructor", { value: 1, enumerable: true });
    Object.defineProperty(evilOwn, "__proto__", { value: { polluted: 1 }, enumerable: true });
    Object.defineProperty(evilOwn, "toString", { value: "x", enumerable: true });
    return redactConfigView(evilOwn) as unknown as Record<string, unknown>;
  }

  it("读出口：普通键保留", () => {
    expect(Object.prototype.hasOwnProperty.call(evilOut(), "keep")).toBe(true);
  });

  it("读出口：constructor 自有键剔除", () => {
    expect(Object.prototype.hasOwnProperty.call(evilOut(), "constructor")).toBe(false);
  });

  it("读出口：__proto__ 自有键剔除", () => {
    expect(Object.prototype.hasOwnProperty.call(evilOut(), "__proto__")).toBe(false);
  });

  it("读出口：toString 自有键剔除", () => {
    expect(Object.prototype.hasOwnProperty.call(evilOut(), "toString")).toBe(false);
  });

  it("读出口：无全局原型污染", () => {
    evilOut();
    expect((Object.prototype as { polluted?: unknown }).polluted).toBe(undefined);
  });
});

describe("掩码回填：unmaskChannels", () => {
  const userChs = [{ id: "phone", deviceKey: "realKey123" }, { id: "pad", deviceKey: "padKey456" }];
  const masked = () => unmaskChannels(
    [{ id: "pad", deviceKey: SECRET_MASK, baseUrl: "https://h", type: "bark", enabled: true }, { id: "phone", deviceKey: SECRET_MASK, baseUrl: "https://h", type: "bark", enabled: true }, { id: "new1", deviceKey: "freshKey", baseUrl: "https://h", type: "bark", enabled: false }],
    userChs,
  );

  it("回填成功", () => {
    expect(masked().ok).toBeTruthy();
  });

  it("乱序掩码按 id 对齐回填（防下标串凭据）", () => {
    expect(unmaskOk(masked())[0].deviceKey).toBe("padKey456");
  });

  it("乱序掩码按 id 对齐回填 2", () => {
    expect(unmaskOk(masked())[1].deviceKey).toBe("realKey123");
  });

  it("新实例非掩码 key 保留", () => {
    expect(unmaskOk(masked())[2].deviceKey).toBe("freshKey");
  });

  it("新实例带掩码拒绝", () => {
    expect(!unmaskChannels([{ id: "brand-new", deviceKey: SECRET_MASK }], userChs).ok).toBeTruthy();
  });

  it("user 层空时新实例掩码拒绝", () => {
    expect(!unmaskChannels([{ id: "brand-new", deviceKey: SECRET_MASK }], []).ok).toBeTruthy();
  });

  it("非掩码 patch 原样通过", () => {
    const plainPatch = unmaskChannels([{ id: "phone", deviceKey: "plain" }], userChs);
    expect(plainPatch.ok && (plainPatch as { channels: Array<{ deviceKey: string }> }).channels[0].deviceKey === "plain").toBeTruthy();
  });

  it("非数组输入兜底 ok", () => {
    expect(unmaskChannels(undefined, userChs).ok).toBeTruthy();
  });
});

describe("写入校验：channels 整组（重复 id / 保留键 / scheme / deviceKey）", () => {
  it("合法实例通过", () => {
    expect(validateSettings({ channels: [okCh] })).toBe(null);
  });

  it("重复 id 拒绝", () => {
    expect(validateSettings({ channels: [okCh, { ...okCh, id: "phone" }] })?.key).toBe("channels");
  });

  it("保留键写入口径拒绝", () => {
    expect(validateSettings({ channels: [{ ...okCh, device_key: "x" }] })?.key).toBe("channels");
  });

  it("非法 scheme 拒绝", () => {
    expect(validateSettings({ channels: [{ ...okCh, baseUrl: "ftp://h" }] })?.key).toBe("channels");
  });

  it("空 deviceKey 拒绝", () => {
    expect(validateSettings({ channels: [{ ...okCh, deviceKey: "" }] })?.key).toBe("channels");
  });
});

describe("levels（kind→level 稀疏映射矩阵）归一化", () => {
  it("合法 levels 归一化保留", () => {
    const lvCh = { ...okCh, levels: { question: "timeSensitive", error: "active", "subagent-done": "active" } };
    const mergedLv = normalizeConfig({ channels: [lvCh] }).channels[0] as unknown as Record<string, unknown>;
    expect(mergedLv.levels).toEqual({ question: "timeSensitive", error: "active", "subagent-done": "active" });
  });

  it("非法值/空键/超长键丢弃", () => {
    const badLv = normalizeConfig({ channels: [{ ...okCh, levels: { question: "timeSensitive", bogus: "urgent", "": "active", x: "x".repeat(65) } }] }).channels[0] as unknown as Record<string, unknown>;
    expect(badLv.levels).toEqual({ question: "timeSensitive" });
  });

  it("原型污染类键剔除", () => {
    const protoLv = normalizeConfig({ channels: [{ ...okCh, levels: JSON.parse('{"__proto__":"critical","constructor":"active","prototype":"passive","question":"active"}') }] }).channels[0] as unknown as Record<string, unknown>;
    expect(protoLv.levels).toEqual({ question: "active" });
  });

  it("空对象 levels 归一化为缺省", () => {
    const noLv = normalizeConfig({ channels: [{ ...okCh, levels: {} }] }).channels[0] as unknown as Record<string, unknown>;
    expect("levels" in noLv).toBe(false);
  });

  it("levels 键不干扰未知参数透传", () => {
    const opaqueLv = normalizeConfig({ channels: [{ ...okCh, levels: { question: "active" }, volume: "0.7" }] }).channels[0] as unknown as Record<string, unknown>;
    expect(opaqueLv.volume).toBe("0.7");
  });
});

describe("levels 写入校验（严格口径：任一项非法整组 400）", () => {
  const lvCh = { ...okCh, levels: { question: "timeSensitive", error: "active", "subagent-done": "active" } };
  const many = Object.fromEntries(Array.from({ length: 65 }, function (_, i) { return ["k" + i, "active"]; }));

  it("合法 levels 通过", () => {
    expect(validateSettings({ channels: [lvCh] })).toBe(null);
  });

  it("非法 level 值拒绝", () => {
    expect(validateSettings({ channels: [{ ...okCh, levels: { question: "loud" } }] })?.key).toBe("channels");
  });

  it("空 kind 键拒绝", () => {
    expect(validateSettings({ channels: [{ ...okCh, levels: { "": "active" } }] })?.key).toBe("channels");
  });

  it("原型键拒绝", () => {
    expect(validateSettings({ channels: [{ ...okCh, levels: JSON.parse('{"q":"active","__proto__":"critical"}') }] })?.key).toBe("channels");
  });

  it("超 64 项 levels 拒绝", () => {
    expect(validateSettings({ channels: [{ ...okCh, levels: many }] })?.key).toBe("channels");
  });
});

describe("kindRoutes / allowKinds / quietHours.allowKinds 写入校验", () => {
  it("合法 kindRoutes 通过", () => {
    expect(validateSettings({ kindRoutes: { error: ["browser"] } })).toBe(null);
  });

  it("空数组 kindRoutes 拒绝", () => {
    expect(validateSettings({ kindRoutes: { error: [] } })?.key).toBe("kindRoutes");
  });

  it("合法 allowKinds 通过", () => {
    expect(validateSettings({ allowKinds: ["a:b"] })).toBe(null);
  });

  it("非字符串 allowKinds 拒绝", () => {
    expect(validateSettings({ allowKinds: [42] })?.key).toBe("allowKinds");
  });

  it("放开后全部内置事件可写入豁免", () => {
    // quietHours.allowKinds 写入校验放开（与顶层 allowKinds 同口径：非空字符串 ≤64、≤128）
    expect(validateSettings({ quietHours: { enabled: true, allowKinds: ["ask", "done", "turn-end"] } })).toBe(null);
  });

  it("quietHours.allowKinds 非字符串拒绝（整组 400）", () => {
    expect(validateSettings({ quietHours: { allowKinds: [42] } })?.key).toBe("quietHours");
  });

  it("quietHours.allowKinds 空串拒绝", () => {
    expect(validateSettings({ quietHours: { allowKinds: [""] } })?.key).toBe("quietHours");
  });
});

describe("allowKinds 128 项上限（写入校验 >128 拒绝、恰好 128 通过）", () => {
  // isAllowKinds / isConfirmedKinds 同口径
  const capPlus1 = Array.from({ length: 129 }, (_, i) => "k" + i);
  const cap128 = Array.from({ length: 128 }, (_, i) => "k" + i);

  it("顶层 allowKinds 超 128 项拒绝", () => {
    expect(validateSettings({ allowKinds: capPlus1 })?.key).toBe("allowKinds");
  });

  it("quietHours.allowKinds 超 128 项拒绝（整组 400）", () => {
    expect(validateSettings({ quietHours: { allowKinds: capPlus1 } })?.key).toBe("quietHours");
  });

  it("顶层 allowKinds 恰 128 项通过", () => {
    expect(validateSettings({ allowKinds: cap128 })).toBe(null);
  });

  it("quietHours.allowKinds 恰 128 项通过", () => {
    expect(validateSettings({ quietHours: { allowKinds: cap128 } })).toBe(null);
  });
});

describe("sanitizeSettings（组合层 entry 白名单通道，#470 双通道拆分）", () => {
  it("sanitizeSettings channels 往返", () => {
    const sanitizedCh = sanitizeSettings({ channels: [{ ...okCh, volume: "0.7" }] });
    expect(sanitizedCh && Array.isArray(sanitizedCh.channels) && sanitizedCh.channels.length === 1).toBeTruthy();
  });

  it("entry 白名单通道：未来键仍丢弃（组合层装配专用）", () => {
    expect(sanitizeSettings({ futureKey: 1 })).toEqual({});
  });
});

describe("sanitizePatchSettings（PUT/迁移透传通道）", () => {
  it("透传通道：纯未知键原样保留", () => {
    expect(sanitizePatchSettings({ futureKey: 1 })).toEqual({ futureKey: 1 });
  });

  it("透传通道：已知+未知混合双保留", () => {
    expect(sanitizePatchSettings({ notifyAsk: false, futureKey: { a: 1 } })).toEqual({ notifyAsk: false, futureKey: { a: 1 } });
  });

  it("透传通道：空 patch 空对象（调用方按 400 语义处理）", () => {
    expect(sanitizePatchSettings({})).toEqual({});
  });

  it("透传通道：已知键非法 → 整体拒绝 null", () => {
    expect(sanitizePatchSettings({ notifyAsk: "yes" })).toBe(null);
  });

  it("透传通道：装配键全部剔除（不入 user 层）", () => {
    expect(sanitizePatchSettings({ configFile: "/x", toastScript: "/y", historyFile: "/z", statusFile: "/s", enabled: false })).toEqual({});
  });

  it("透传通道：混合提交剔除装配键、保留已知+未知", () => {
    expect(sanitizePatchSettings({ configFile: "/x", notifyQuestion: false, futureKey: 2 })).toEqual({ notifyQuestion: false, futureKey: 2 });
  });

  it("透传通道：任意 JSON 值原样并入", () => {
    // 透传通道不深改值（原样引用与深等）
    const nested = { futureObj: { x: [1, 2] } };
    expect(sanitizePatchSettings(nested)).toEqual(nested);
  });

  it("透传通道：非对象 → null", () => {
    expect(sanitizePatchSettings(null)).toBe(null);
  });

  it("透传通道：纯已知键与 entry 白名单同结果", () => {
    expect(sanitizePatchSettings({ notifyTaskDone: true })).toEqual({ notifyTaskDone: true });
  });

  it("透传通道：channels 内未知 string/number 参数保留（Bark 前向兼容不变）", () => {
    expect((sanitizePatchSettings({ channels: [{ ...okCh, volume: "0.7" }] }) as unknown as { channels: Array<Record<string, unknown>> }).channels[0].volume).toBe("0.7");
  });

  it("透传通道：数组 patch → null（拒绝，不写脏 user 层）", () => {
    // 数组 patch 不得被当对象透传成数字索引脏键 → null（调用方 400）
    expect(sanitizePatchSettings([1, 2])).toBe(null);
  });

  it("透传通道：空数组 → null", () => {
    expect(sanitizePatchSettings([])).toBe(null);
  });

  it("透传通道：原型链成员键剔除、未知键仍透传", () => {
    // 原型链成员键经 JSON.parse 成为自有键 → 剔除不写入、不触发原型校验器
    const protoEvil = JSON.parse('{"__proto__":{"polluted":1},"constructor":1,"prototype":2,"toString":3,"hasOwnProperty":4,"valueOf":5,"futureKey":7}');
    expect(sanitizePatchSettings(protoEvil)).toEqual({ futureKey: 7 });
  });

  it("透传通道：__proto__ 不改变 out 原型（无原型污染）", () => {
    const protoEvil = JSON.parse('{"__proto__":{"polluted":1},"constructor":1,"prototype":2,"toString":3,"hasOwnProperty":4,"valueOf":5,"futureKey":7}');
    expect(Object.getPrototypeOf(sanitizePatchSettings(protoEvil))).toBe(Object.prototype);
  });

  it("透传通道：原型键与已知键混合 → 只留已知键", () => {
    const protoKnownEvil = JSON.parse('{"notifyAsk":false,"__proto__":{"polluted":1},"constructor":1}');
    expect(sanitizePatchSettings(protoKnownEvil)).toEqual({ notifyAsk: false });
  });

  it("透传通道：未知键 null 透传保留、已知键 null 跳过", () => {
    // null 值语义分层——未知键 null 透传保留（与读面一致），
    // 已知键 null 沿用既有跳过语义（视同未提交）
    expect(sanitizePatchSettings({ nullFuture: null, notifyAsk: null })).toEqual({ nullFuture: null });
  });

  it("透传通道：纯已知键 null patch 净化后空对象（调用方按 400 处理）", () => {
    expect(sanitizePatchSettings({ notifyAsk: null })).toEqual({});
  });

  it("透传通道：纯未知键 null patch 非空（可写）", () => {
    expect(sanitizePatchSettings({ nullFuture: null })).toEqual({ nullFuture: null });
  });
});

describe("读面 normalizeConfig 未知键 null 透传（与写面闭合）", () => {
  it("读面：未知键 null 透传保留", () => {
    const nullRead = normalizeConfig({ nullFuture: null });
    expect(Object.prototype.hasOwnProperty.call(nullRead, "nullFuture")).toBe(true);
  });

  it("读面：未知键 null 值原样", () => {
    const nullRead = normalizeConfig({ nullFuture: null });
    expect((nullRead as unknown as { nullFuture?: null }).nullFuture).toBe(null);
  });
});
