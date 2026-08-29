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
import { normalizeConfig, parseHHMM, isInQuietHours, DEFAULT_CONFIG, configFile, historyFile, toastScriptPath } from "../src/index.ts";

const work = mkdtempSync(join(tmpdir(), "dnotify-unit-config-"));
try {
  const DEFAULT_CONFIG_UNTOUCHED = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // 路径契约（config.ts 导出）：configFile 是存量自建 json 的迁移源路径（issue #76 后
  // 配置走官方 settings 存储，configFile 不再读写，仅迁移读取/改名）；historyFile 与
  // toast 脚本路径不变。
  assert.equal(configFile(), join(homedir(), ".dsh", "dsh-notifier.json"), "配置迁移源路径固定到 ~/.dsh/dsh-notifier.json");
  assert.equal(historyFile(), join(homedir(), ".dsh", "dsh-notifier-history.jsonl"), "历史路径固定到 ~/.dsh/dsh-notifier-history.jsonl");
  assert.ok(toastScriptPath().endsWith("toast.ps1"), "toast 脚本路径固定到 toast.ps1（src 插桩形态下随加载源解析到 src/）");

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

  // M4 配置归一化：askRemindMin / quietHours.allowKinds
  assert.equal(normalizeConfig({ askRemindMin: 3 }).askRemindMin, 3, "审批提醒分钟可配");
  assert.equal(normalizeConfig({ askRemindMin: 0 }).askRemindMin, 0, "0=关闭审批提醒");
  assert.equal(normalizeConfig({ askRemindMin: "x" }).askRemindMin, DEFAULT_CONFIG.askRemindMin, "非法提醒分钟回默认 5");
  assert.deepEqual(normalizeConfig({ quietHours: { allowKinds: ["ask", "bogus", "error"] } }).quietHours.allowKinds, ["ask", "error"], "allowKinds 白名单过滤");

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
} finally {
  rmSync(work, { recursive: true, force: true });
}
