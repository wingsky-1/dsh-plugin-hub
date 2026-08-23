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
import { normalizeConfig, parseHHMM, isInQuietHours, DEFAULT_CONFIG, configFile, historyFile, toastScriptPath } from "../lib/index.js";

const work = mkdtempSync(join(tmpdir(), "dnotify-unit-config-"));
try {
  const DEFAULT_CONFIG_UNTOUCHED = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // 路径契约（config.ts 导出；apply 未覆盖路径时由宿主按此位置读写）
  assert.equal(configFile(), join(homedir(), ".dsh", "dsh-notifier.json"), "配置路径固定到 ~/.dsh/dsh-notifier.json");
  assert.equal(historyFile(), join(homedir(), ".dsh", "dsh-notifier-history.jsonl"), "历史路径固定到 ~/.dsh/dsh-notifier-history.jsonl");
  assert.ok(toastScriptPath().endsWith(join("lib", "toast.ps1")), "toast 脚本随包 lib/ 下");

  assert.equal(normalizeConfig(undefined).notifyAsk, true);
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
} finally {
  rmSync(work, { recursive: true, force: true });
}
