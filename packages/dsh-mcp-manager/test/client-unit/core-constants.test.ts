/**
 * dsh-mcp-manager — client-unit：core/constants.ts 的直接判据（状态映射与路径投影）。
 *
 * 守的事实（每条一句话）：
 * - core/constants.ts：把 statusDot 的六态配色任一改掉、把 STATUS_ORDER 的展示次序
 *   调换、把 STATUS_TEXT 的字典键错配，三者任一必须红。
 * - core/i18n.ts：把 tStatus 的已知/未知两支对调（`!== undefined` 改成 `=== undefined`）、
 *   或把回落值从原始 key 改成空串，必须红。
 *
 * 字典锚点纪律（testing SKILL §6「不同源期望」）：期望值一律手写字面量，不从被测实现
 * import。STATUS_TEXT 的键与 STATUS_ORDER 的 titleKey 用字面量数组钉，statusDot 的配色
 * 用字面量表钉——常量改成任何值都红。
 *
 * 假件说明（testing SKILL §3）：locale 是手写活绑定假件（只覆盖本文件断言用到的那几个
 * 键，其余回落 key 本体），不用任何 vi 替身；bindLocale 的重绑在 afterEach 里复原成
 * 「回落 key 本体」的缺省态，避免活绑定泄漏到别的测试文件（shared/client/i18n.ts 的
 * `export let t` 是跨模块活绑定，见该文件头注释）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
import { API, STATUS_ORDER, STATUS_TEXT, statusDot } from "../../src/client/core/constants.ts";

/** 六态的展示次序是行为事实（浮窗与面板都按它建桶、分组），故钉成字面量序列。 */
const ORDER_KEYS = [
  "connected",
  "connecting",
  "reconnecting",
  "stopped",
  "disabled",
  "failed",
] as const;

/** 状态 → 字典键的字面量锚（不从 STATUS_TEXT import，否则常量改了用例照绿）。 */
const TEXT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["connected", "stConnected"],
  ["connecting", "stConnecting"],
  ["reconnecting", "stReconnecting"],
  ["stopped", "stStopped"],
  ["disabled", "stDisabled"],
  ["failed", "stFailed"],
];

/** 状态点配色字面量锚。中性灰是「未在表内」的回落值，与 stopped/disabled 共用同一串。 */
const DOT_COLORS: ReadonlyArray<readonly [string, string]> = [
  ["connected", "var(--dsw-alias-state-success-primary,#0f9d6e)"],
  ["connecting", "var(--dsw-alias-state-business-primary,#2f7bf6)"],
  ["reconnecting", "var(--dsw-alias-state-warn-primary,#e08b1e)"],
  ["stopped", "var(--dsw-alias-label-tertiary,#9aa1ad)"],
  ["disabled", "var(--dsw-alias-label-tertiary,#9aa1ad)"],
  ["failed", "var(--dsw-alias-state-error-primary,#e0483e)"],
];

const NEUTRAL_DOT = "var(--dsw-alias-label-tertiary,#9aa1ad)";

afterEach(() => {
  // 复原成缺省「回落 key 本体」态：本模块的 t 是活绑定，漏复原会污染同 worker 的后续文件。
  bindLocale({ bind: () => (key: string) => key }, "mcpManager");
});

describe("constants：状态点配色", () => {
  it("六态逐态取到字面量配色（改任一色值即红）", () => {
    const actual = DOT_COLORS.map(([status]) => statusDot(status));
    expect(actual).toEqual(DOT_COLORS.map(([, color]) => color));
  });

  it("表外状态回落中性灰（六态之外的输入不得拿到状态色）", () => {
    expect(statusDot("weird")).toBe(NEUTRAL_DOT);
    expect(statusDot("")).toBe(NEUTRAL_DOT);
  });

  it("回落色与 stopped/disabled 共用同一串（中性档不是第四种颜色）", () => {
    expect(statusDot("weird")).toBe(statusDot("stopped"));
    expect(statusDot("weird")).toBe(statusDot("disabled"));
  });
});

describe("constants：状态分组排序", () => {
  it("展示次序为 connected→connecting→reconnecting→stopped→disabled→failed", () => {
    expect(STATUS_ORDER.map((group) => group.key)).toEqual([...ORDER_KEYS]);
  });

  it("每档的字典键与 titleKey 逐条对齐（渲染期按 titleKey 取文案）", () => {
    expect(STATUS_ORDER.map((group) => group.titleKey)).toEqual([
      "stConnected",
      "stConnecting",
      "stReconnecting",
      "stStopped",
      "stDisabled",
      "stFailed",
    ]);
  });

  it("每档的 dot 字段与 statusDot() 同源同值（两处颜色不得漂移）", () => {
    for (const group of STATUS_ORDER) {
      expect(group.dot).toBe(statusDot(group.key));
    }
  });

  it("失败档与重连档用告警/错误色，非失败档不用（配色语义分档）", () => {
    const byKey = new Map(STATUS_ORDER.map((group) => [group.key, group.dot]));
    expect(byKey.get("failed")).toContain("state-error");
    expect(byKey.get("reconnecting")).toContain("state-warn");
    expect(byKey.get("connected")).toContain("state-success");
  });
});

describe("constants：状态 → 字典键映射", () => {
  it("六态逐条映射到字面量字典键（错配即红）", () => {
    const actual = TEXT_KEYS.map(([status]) => STATUS_TEXT[status]);
    expect(actual).toEqual(TEXT_KEYS.map(([, key]) => key));
  });

  it("映射表不含六态以外的键（表外状态必须走 i18n 的回落分支）", () => {
    expect(Object.keys(STATUS_TEXT).sort()).toEqual([...ORDER_KEYS].sort());
  });
});

describe("constants：路径表投影", () => {
  it("11 条路由全部投影到客户端 API 键面（漏投影即红）", () => {
    expect(Object.keys(API).sort()).toEqual([
      "config",
      "connect",
      "disconnect",
      "events",
      "health",
      "importJson",
      "reconnect",
      "resume",
      "servers",
      "session",
      "toolDisable",
    ]);
  });

  // 值本身由 test/e2e/cross-end-lock.test.ts 的两端一致性锁负责（不重复断同一事实），
  // 这里只钉「每条都是绝对 /api 路径」，防某个投影被写成相对路径。
  it("每条投影都是 /api 绝对路径（客户端按 origin 直接拼）", () => {
    for (const [name, path] of Object.entries(API)) {
      expect(path.startsWith("/api/dsh-mcp/")).toBe(true);
      expect(name).not.toBe("");
    }
  });
});
