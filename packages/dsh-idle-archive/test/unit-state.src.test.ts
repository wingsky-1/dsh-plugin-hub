// @ts-nocheck
/**
 * dsh-idle-archive — unit：状态文件纯读写（readState / writeState / stateFile）。
 *
 * #83 剩余缺口结构化单测。覆盖：
 * - stateFile：DSH_HOME 注入优先、未注入回落 ~/.dsh；
 * - readState：缺文件回落默认、BOM 剥离、settings 净化合并、snoozed 过期清理、
 *   snoozed 数组/原始类型拒绝、坏 JSON 回落且不覆盖写；
 * - writeState：深层目录自动创建、tmp+rename 原子写后无残留 tmp、写后读回一致。
 *
 * 防 flake 纪律：全部用例经 withTempHome 走隔离临时 DSH_HOME，无网络、
 * 无真实用户路径字面量、轮询替代固定 sleep（本组用例纯异步 IO，无等待）。
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assert, withTempHome } from "./helpers.ts";
import { defaultSettings, sanitizeSettings, stateFile, readState, writeState } from "../src/index.ts";

const def = defaultSettings();

// ---------------------------------------------------------------- stateFile

{
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = "/tmp/dia-fake-home";
  assert.equal(stateFile(), join("/tmp/dia-fake-home", "dsh-idle-archive.json"), "DSH_HOME 注入时状态文件指向其下");
  delete process.env.DSH_HOME;
  assert.equal(stateFile(), join(homedir(), ".dsh", "dsh-idle-archive.json"), "未注入时回落 ~/.dsh");
  if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
}

// ---------------------------------------------------------------- readState：缺文件回落默认

await withTempHome(async () => {
  const st = await readState();
  assert.deepEqual(st.settings, def, "缺文件 settings 回落默认");
  assert.deepEqual(st.snoozed, {}, "缺文件 snoozed 为空映射");
});

// ---------------------------------------------------------------- writeState + readState：写后读回

await withTempHome(async () => {
  const st = await writeState({
    settings: sanitizeSettings({ idleHours: 8, enabled: false }),
    snoozed: { s1: Date.now() + 60_000 },
  }).then(readState);
  assert.equal(st.settings.idleHours, 8, "写后读回 idleHours");
  assert.equal(st.settings.enabled, false, "写后读回 enabled");
  assert.ok(typeof st.snoozed.s1 === "number" && st.snoozed.s1 > Date.now(), "未过期 snooze 读回保留");

  // 落盘格式：JSON、两空格缩进、单一最终文件
  const raw = JSON.parse(readFileSync(stateFile(), "utf8"));
  assert.equal(raw.settings.idleHours, 8, "落盘内容为合法 JSON 且含 settings");
  assert.ok(raw.snoozed && typeof raw.snoozed === "object" && !Array.isArray(raw.snoozed), "落盘含 snoozed 映射");
  assert.ok(!existsSync(stateFile() + ".tmp") && !/\.tmp$/.test(readStateTmpProbe()), "原子写完成后无 .tmp 残留");
});

/** 探测状态目录中是否残留 tmp 文件（配合上一用例）。 */
function readStateTmpProbe(): string {
  const dir = stateFile().slice(0, stateFile().lastIndexOf("/"));
  const names = existsSync(dir) ? readdirSync(dir) : [];
  return names.find((n) => n.endsWith(".tmp")) ?? "";
}

// ---------------------------------------------------------------- writeState：深层目录自动创建

await withTempHome(async () => {
  process.env.DSH_HOME = join(process.env.DSH_HOME, "nested", "deeper");
  await writeState({ settings: def, snoozed: {} });
  assert.ok(existsSync(stateFile()), "DSH_HOME 子路径不存在时自动递归创建并写入");
});

// ---------------------------------------------------------------- readState：净化与容错

// BOM 剥离：\uFEFF 开头的 UTF-8 文件可正常解析
await withTempHome(async () => {
  writeFileSync(stateFile(), "\uFEFF" + JSON.stringify({ settings: { idleHours: 5 }, snoozed: {} }), "utf8");
  const st = await readState();
  assert.equal(st.settings.idleHours, 5, "BOM 头剥离后正常解析 settings");
});

// settings 字段缺失 → sanitize(undefined) 回落默认；非法值单键净化
await withTempHome(async () => {
  writeFileSync(stateFile(), JSON.stringify({ snoozed: {} }), "utf8");
  let st = await readState();
  assert.deepEqual(st.settings, def, "settings 字段缺失回落默认");
  writeFileSync(stateFile(), JSON.stringify({ settings: { idleHours: 99999, scanMinutes: "bad" }, snoozed: {} }), "utf8");
  st = await readState();
  assert.equal(st.settings.idleHours, 24 * 365, "越界 idleHours 读入时钳制");
  assert.equal(st.settings.scanMinutes, 60, "类型错值 scanMinutes 读入时回落默认");
});

// snoozed 过期清理 + 非法条目过滤
await withTempHome(async () => {
  writeFileSync(
    stateFile(),
    JSON.stringify({
      settings: {},
      snoozed: {
        expired: Date.now() - 1000,
        fresh: Date.now() + 60_000,
        "": Date.now() + 60_000, // 空 id 过滤
        badnum: "not-a-number", // 非 number until 过滤
        [String(123)]: Date.now() + 60_000, // 数字型键名（JSON 键恒字符串，保留）
      },
    }),
    "utf8",
  );
  const st = await readState();
  assert.ok(!("expired" in st.snoozed), "已过期 snooze 清理");
  assert.ok("fresh" in st.snoozed, "未过期 snooze 保留");
  assert.ok(!("" in st.snoozed), "空 id 条目过滤");
  assert.ok(!("badnum" in st.snoozed), "非数值 until 条目过滤");
});

// snoozed 为数组 / 原始类型 → 整体拒绝为空
await withTempHome(async () => {
  writeFileSync(stateFile(), JSON.stringify({ settings: {}, snoozed: ["a", "b"] }), "utf8");
  let st = await readState();
  assert.deepEqual(st.snoozed, {}, "snoozed 数组整体拒绝");
  writeFileSync(stateFile(), JSON.stringify({ settings: {}, snoozed: "x" }), "utf8");
  st = await readState();
  assert.deepEqual(st.snoozed, {}, "snoozed 字符串整体拒绝");
});

// 整个文件顶层为数组/原始类型 → 回落默认
await withTempHome(async () => {
  writeFileSync(stateFile(), "[1,2]", "utf8");
  let st = await readState();
  assert.deepEqual(st.settings, def, "顶层数组回落默认 settings");
  writeFileSync(stateFile(), '"str"', "utf8");
  st = await readState();
  assert.deepEqual(st.snoozed, {}, "顶层字符串回落默认 snoozed");
});

// 坏 JSON → 回落默认且不覆盖写坏文件（等下次写入再修复）
await withTempHome(async () => {
  writeFileSync(stateFile(), "{broken", "utf8");
  const st = await readState();
  assert.deepEqual(st.settings, def, "坏 JSON 回落默认 settings");
  assert.equal(readFileSync(stateFile(), "utf8"), "{broken", "坏文件原样保留不被覆盖");
});

console.log("PASS: dsh-idle-archive unit-state（stateFile / readState 容错 / writeState 原子写，DSH_HOME 全程隔离）");
