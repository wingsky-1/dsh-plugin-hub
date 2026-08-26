// @ts-nocheck
/**
 * dsh-idle-archive — unit：设置纯函数（sanitizeSettings / defaultSettings）。
 *
 * #83 剩余缺口结构化单测。覆盖：
 * - defaultSettings：五键结构与默认值、每次调用返回新对象；
 * - sanitizeSettings 正例：全键合法提交、部分键提交（缺省回落默认）、
 *   小数四舍五入、边界值钳制（各键 min/max）；
 * - sanitizeSettings 反例：null/undefined/原始类型/数组整体回落默认、
 *   非有限数值（NaN/Infinity/-Infinity）与类型错值（字符串/布尔）单键回落默认、
 *   enabled 非 boolean 回落 true、未知键丢弃、返回对象不含原型链杂质。
 */
import { assert } from "./helpers.ts";
import { sanitizeSettings, defaultSettings } from "../src/index.ts";

// ---------------------------------------------------------------- defaultSettings

const def = defaultSettings();

assert.deepEqual(
  def,
  { idleHours: 72, snoozeHours: 24, scanMinutes: 60, enabled: true, maxRows: 50 },
  "defaultSettings 五键结构与默认值",
);
assert.deepEqual(Object.keys(def).sort(), ["enabled", "idleHours", "maxRows", "scanMinutes", "snoozeHours"], "键集合固定");
assert.notEqual(defaultSettings(), def, "每次调用返回新对象（调用方改动不串扰）");
assert.equal(typeof def.idleHours, "number", "数值字段为 number 类型");

// ---------------------------------------------------------------- sanitizeSettings：正例

// 全键合法提交
{
  const s = sanitizeSettings({ idleHours: 12, snoozeHours: 6, scanMinutes: 30, enabled: false, maxRows: 10 });
  assert.deepEqual(s, { idleHours: 12, snoozeHours: 6, scanMinutes: 30, enabled: false, maxRows: 10 }, "全键合法提交原样保留");
}

// 部分键提交：只覆盖给定键，其余保持默认
{
  const s = sanitizeSettings({ scanMinutes: 15 });
  assert.equal(s.scanMinutes, 15, "部分提交：给定键生效");
  assert.equal(s.idleHours, 72, "部分提交：缺省键回落默认 idleHours");
  assert.equal(s.snoozeHours, 24, "部分提交：缺省键回落默认 snoozeHours");
  assert.equal(s.maxRows, 50, "部分提交：缺省键回落默认 maxRows");
  assert.equal(s.enabled, true, "部分提交：缺省键回落默认 enabled");
}

// 各键边界值钳制（min/max 与 LIMITS 一致）
assert.equal(sanitizeSettings({ idleHours: 1 }).idleHours, 1, "idleHours min=1 保持");
assert.equal(sanitizeSettings({ idleHours: 24 * 365 }).idleHours, 24 * 365, "idleHours max=8760 保持");
assert.equal(sanitizeSettings({ snoozeHours: 1 }).snoozeHours, 1, "snoozeHours min=1 保持");
assert.equal(sanitizeSettings({ snoozeHours: 24 * 30 }).snoozeHours, 24 * 30, "snoozeHours max=720 保持");
assert.equal(sanitizeSettings({ scanMinutes: 5 }).scanMinutes, 5, "scanMinutes min=5 保持");
assert.equal(sanitizeSettings({ scanMinutes: 24 * 60 }).scanMinutes, 24 * 60, "scanMinutes max=1440 保持");
assert.equal(sanitizeSettings({ maxRows: 1 }).maxRows, 1, "maxRows min=1 保持");
assert.equal(sanitizeSettings({ maxRows: 200 }).maxRows, 200, "maxRows max=200 保持");

// 越界钳制与四舍五入
assert.equal(sanitizeSettings({ idleHours: 0 }).idleHours, 1, "idleHours=0 下越界钳到 min");
assert.equal(sanitizeSettings({ maxRows: 999 }).maxRows, 200, "maxRows=999 上越界钳到 max");
assert.equal(sanitizeSettings({ scanMinutes: 4.4 }).scanMinutes, 5, "4.4 四舍五入为 4 再钳到 min=5");
assert.equal(sanitizeSettings({ snoozeHours: 6.5 }).snoozeHours, 7, "6.5 四舍五入为 7");
assert.equal(sanitizeSettings({ maxRows: 10.2 }).maxRows, 10, "10.2 四舍五入为 10");

// enabled 合法布尔
assert.equal(sanitizeSettings({ enabled: false }).enabled, false, "enabled=false 接受");
assert.equal(sanitizeSettings({ enabled: true }).enabled, true, "enabled=true 接受");

// ---------------------------------------------------------------- sanitizeSettings：反例（整体非法）

assert.deepEqual(sanitizeSettings(null), def, "null 回落默认");
assert.deepEqual(sanitizeSettings(undefined), def, "undefined 回落默认");
assert.deepEqual(sanitizeSettings(42), def, "数字整体回落默认");
assert.deepEqual(sanitizeSettings("x"), def, "字符串整体回落默认");
assert.deepEqual(sanitizeSettings(true), def, "布尔整体回落默认");
assert.deepEqual(sanitizeSettings([]), def, "数组（typeof object 但无已知键）回落默认");
assert.deepEqual(sanitizeSettings(() => {}), def, "函数整体回落默认");

// ---------------------------------------------------------------- sanitizeSettings：反例（单键非法）

assert.equal(sanitizeSettings({ idleHours: NaN }).idleHours, 72, "NaN 忽略回落默认");
assert.equal(sanitizeSettings({ idleHours: Infinity }).idleHours, 72, "Infinity 忽略回落默认");
assert.equal(sanitizeSettings({ idleHours: -Infinity }).idleHours, 72, "-Infinity 忽略回落默认");
assert.equal(sanitizeSettings({ idleHours: "48" }).idleHours, 72, "字符串数值不接受回落默认");
assert.equal(sanitizeSettings({ idleHours: null }).idleHours, 72, "null 值不接受回落默认");
assert.equal(sanitizeSettings({ snoozeHours: "x" }).snoozeHours, 24, "snoozeHours 类型错值回落默认");
assert.equal(sanitizeSettings({ scanMinutes: true }).scanMinutes, 60, "scanMinutes 类型错值回落默认");
assert.equal(sanitizeSettings({ maxRows: {} }).maxRows, 50, "maxRows 对象值回落默认");
assert.equal(sanitizeSettings({ enabled: "yes" }).enabled, true, "enabled 非 boolean 回落默认 true");
assert.equal(sanitizeSettings({ enabled: 0 }).enabled, true, "enabled 数字 0 回落默认 true");

// ---------------------------------------------------------------- 其他语义

// 未知键丢弃：输出只含五个已知键
{
  const s = sanitizeSettings({ idleHours: 10, unknown: "v", another: 1 });
  assert.equal("unknown" in s, false, "未知键丢弃");
  assert.equal("another" in s, false, "第二个未知键丢弃");
  assert.deepEqual(Object.keys(s).sort(), ["enabled", "idleHours", "maxRows", "scanMinutes", "snoozeHours"], "输出键集合与 Settings 同构");
}

// 输出为全新对象：不改写输入
{
  const input = Object.freeze({ idleHours: 3 });
  const s = sanitizeSettings(input);
  assert.equal(s.idleHours, 3, "冻结输入可正常读取");
  assert.notEqual(s, input, "返回新对象不回写输入");
}

console.log("PASS: dsh-idle-archive unit-settings（sanitizeSettings 正反例 / defaultSettings 结构与默认值）");
