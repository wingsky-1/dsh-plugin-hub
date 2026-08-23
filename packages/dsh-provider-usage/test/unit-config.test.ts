// @ts-nocheck
/**
 * dsh-provider-usage — unit：配置归一化补充（normalizeConfig 边界、parseUserAdapters）。
 *
 * 补充 smoke-pure 已覆盖的 normalizeConfig 基础路径，聚焦边界：
 * warmupIntervalMs 下限、cacheDurationMs 下限、apiKey 字符串透传、
 * autoReload 布尔透传、maxSizeMB 上限、historyDir 字符串。
 */
import { assert } from "./helpers.ts";
import {
  normalizeConfig,
  DEFAULT_CONFIG,
} from "../lib/index.js";

// normalizeConfig 边界覆盖（smoke-pure 已覆盖 adapter/provider/fetchTimeoutMs/maxAgeDays）

assert.equal(normalizeConfig({ warmupIntervalMs: 0 }).warmupIntervalMs, 60000, "warmupIntervalMs 下限 60000");
assert.equal(normalizeConfig({ warmupIntervalMs: 120000 }).warmupIntervalMs, 120000, "warmupIntervalMs 合法透传");
assert.equal(normalizeConfig({ warmupIntervalMs: "x" }).warmupIntervalMs, DEFAULT_CONFIG.warmupIntervalMs, "warmupIntervalMs 非法丢弃");

assert.equal(normalizeConfig({ cacheDurationMs: 1000 }).cacheDurationMs, 5000, "cacheDurationMs 下限 5000");
assert.equal(normalizeConfig({ cacheDurationMs: 10000 }).cacheDurationMs, 10000, "cacheDurationMs 合法透传");
assert.equal(normalizeConfig({ cacheDurationMs: "x" }).cacheDurationMs, DEFAULT_CONFIG.cacheDurationMs, "cacheDurationMs 非法丢弃");

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