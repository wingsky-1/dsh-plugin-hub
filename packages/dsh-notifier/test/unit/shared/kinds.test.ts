/**
 * dsh-notifier src/shared —— 通知类型表（两端共享面）的直连判据。
 *
 * 值逐项钉住而不是「表里有几项」：宿主端的裁决开关与客户端的事件卡/色点读同一张表，
 * 漏配一项的症状是「界面给得出、宿主不认」，只看长度或只看键集都抓不到。
 */
import { describe, expect, it } from "vitest";

import { BOOLEAN_KEYS } from "../../../src/server/config/impl/input/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import {
  BUILTIN_KINDS,
  KIND_SEVERITY,
  KIND_SWITCHES,
  NOTIFY_SEVERITIES,
  isBuiltinKind,
  isNotifySeverity,
} from "../../../src/shared/interface.ts";

describe("BUILTIN_KINDS / isBuiltinKind", () => {
  it("取值与顺序逐项钉住（顺序即设置页展示顺序）", () => {
    expect([...BUILTIN_KINDS]).toEqual([
      "ask",
      "question",
      "done",
      "subagent-done",
      "error",
      "turn-end",
      "test",
    ]);
  });

  it("isBuiltinKind 只认内置名；外部 命名空间:id 与近似拼写一律判否", () => {
    for (const kind of BUILTIN_KINDS) expect(isBuiltinKind(kind), kind).toBe(true);
    const rejected = ["demo:report", "ask:", ":ask", "Test", "turn_end", "ask ", "", "test2"];
    for (const kind of rejected) expect(isBuiltinKind(kind), kind).toBe(false);
  });

  it("内置名一律不含冒号（与外部命名空间天然不相交）", () => {
    expect(BUILTIN_KINDS.filter((kind) => kind.includes(":"))).toEqual([]);
  });
});

describe("KIND_SEVERITY / NOTIFY_SEVERITIES / isNotifySeverity", () => {
  it("键集与 BUILTIN_KINDS 逐项一致（新增 kind 漏配强度在这里红）", () => {
    expect(Object.keys(KIND_SEVERITY).sort()).toEqual([...BUILTIN_KINDS].sort());
  });

  it("取值逐项钉住（客户端色点与服务端定稿读同一张表）", () => {
    expect(KIND_SEVERITY).toEqual({
      ask: "warning",
      question: "info",
      done: "success",
      "subagent-done": "info",
      error: "failure",
      "turn-end": "info",
      test: "info",
    });
  });

  it("NOTIFY_SEVERITIES 取值与顺序逐项钉住，且覆盖 KIND_SEVERITY 的全部取值", () => {
    expect([...NOTIFY_SEVERITIES]).toEqual(["info", "success", "warning", "failure"]);
    for (const kind of BUILTIN_KINDS) {
      expect(NOTIFY_SEVERITIES, kind).toContain(KIND_SEVERITY[kind]);
    }
  });

  it("isNotifySeverity 边界：大小写与未知档一律判非法（跨边界值不得被放行）", () => {
    for (const severity of NOTIFY_SEVERITIES) {
      expect(isNotifySeverity(severity), severity).toBe(true);
    }
    const rejected = ["Info", "critical", "warn", "", " info"];
    for (const value of rejected) {
      expect(isNotifySeverity(value), value).toBe(false);
    }
  });
});

describe("KIND_SWITCHES：kind → 事件开关键", () => {
  it("键集 = BUILTIN_KINDS 去掉 test（test 不对应任何宿主事件，也就没有开关）", () => {
    expect(Object.keys(KIND_SWITCHES).sort()).toEqual(
      BUILTIN_KINDS.filter((kind) => kind !== "test").sort(),
    );
  });

  it("值逐项钉住，且都是设置模型里真实存在的布尔键（同 BOOLEAN_KEYS 的键集）", () => {
    expect(KIND_SWITCHES).toEqual({
      ask: "notifyAsk",
      question: "notifyQuestion",
      done: "notifyTaskDone",
      "subagent-done": "notifySubagentDone",
      error: "notifyTaskError",
      "turn-end": "notifyTurnEnd",
    });
    expect([...Object.values(KIND_SWITCHES)].sort()).toEqual([...BOOLEAN_KEYS].sort());
    for (const key of Object.values(KIND_SWITCHES)) {
      expect(typeof DEFAULT_CONFIG[key], key).toBe("boolean");
    }
  });

  // 客户端那张逆向表（开关键 → kind）由本表反转得到，故这里把反转结果也钉住：
  // 收口前它是客户端手里的一份副本，两份漂移的症状是「事件卡色点与开关对不上号」。
  it("反转即客户端的开关键 → kind 表（收口前那份副本逐项一致）", () => {
    const inverted = Object.fromEntries(
      Object.entries(KIND_SWITCHES).map(([kind, key]) => [key, kind]),
    );
    expect(inverted).toEqual({
      notifyAsk: "ask",
      notifyQuestion: "question",
      notifyTaskDone: "done",
      notifySubagentDone: "subagent-done",
      notifyTaskError: "error",
      notifyTurnEnd: "turn-end",
    });
  });
});
