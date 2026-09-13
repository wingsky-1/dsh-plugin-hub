/**
 * dsh-notifier pipeline 域 finalize 块 —— 请求加工成待投递消息。
 *
 * 判据为什么是这些：
 *  - 强度缺省按 kind 补齐，外部 kind 则**缺席**而不是补一个中间档：出口的缺省路径已经定义了
 *    「未提供」的语义，这里再补一套就是第二个默认值来源；
 *  - 标题按码点截断、正文不截断：正文长度权威在各出口自己那里（bark 4096 / 页面 2048 /
 *    系统通知 256），在这里截会把系统通知的上限强加给所有出口。
 */
import { describe, expect, it } from "vitest";

import { finalizeRequest } from "../../../src/server/pipeline/impl/finalize/index.ts";
import { BUILTIN_KINDS } from "../../../src/server/pipeline/impl/service/kinds.ts";
import type { BuiltinKind } from "../../../src/server/pipeline/impl/service/kinds.ts";
import type { NotifyRequest } from "../../../src/server/pipeline/impl/service/type.ts";
import type { NotifySeverity } from "../../../src/server/pipeline/deps.ts";
import { wire } from "../../helpers.ts";

/**
 * 内置 kind → 缺省强度。独立写一遍而不是从源码导：值表漂移必须在这里红，抄源码就恒真了。
 * 表的完整性由「种类逐个对齐 `BUILTIN_KINDS`」那一条兜住。
 */
const KIND_SEVERITY_EXPECTED: ReadonlyArray<readonly [BuiltinKind, NotifySeverity]> = [
  ["ask", "warning"],
  ["question", "info"],
  ["done", "success"],
  ["subagent-done", "info"],
  ["error", "failure"],
  ["turn-end", "info"],
  ["test", "info"],
];

function requestOf(over: Partial<NotifyRequest> = {}): NotifyRequest {
  return { kind: "done", title: "标题", body: "正文", ...over };
}

describe("finalizeRequest", () => {
  // 缺省强度串了档，用户看到的呈现与事件严重性不符（error 看起来像普通提示）。
  it("内置 kind 补缺省强度：error 必须是 failure（出错通知显示成普通提示就白通知了）", () => {
    for (const [kind, severity] of KIND_SEVERITY_EXPECTED) {
      expect(finalizeRequest(requestOf({ kind }), 1).severity, kind).toBe(severity);
    }
    expect(KIND_SEVERITY_EXPECTED.map(([kind]) => kind).sort()).toEqual([...BUILTIN_KINDS].sort());
  });

  // 非法强度被当成合法值传给出口，对端会收到它不认识的档位。
  it("调用方显式给的强度优先；非法强度视同未提供，回落 kind 缺省", () => {
    expect(finalizeRequest(requestOf({ kind: "error", severity: "info" }), 1).severity).toBe(
      "info",
    );
    expect(
      finalizeRequest(requestOf({ kind: "error", severity: wire<NotifySeverity>("critical") }), 1)
        .severity,
    ).toBe("failure");
  });

  // 给外部 kind 补一个「中间档」，等于替调用方决定了它没说的语义。
  it("外部 kind 没有缺省强度：不写 severity 键，调用方说了才写", () => {
    expect("severity" in finalizeRequest(requestOf({ kind: "demo:report" }), 1)).toBe(false);
    expect(
      finalizeRequest(requestOf({ kind: "demo:report", severity: "warning" }), 1).severity,
    ).toBe("warning");
    expect(
      "severity" in
        finalizeRequest(requestOf({ kind: "demo:report", severity: wire<NotifySeverity>("x") }), 1),
    ).toBe(false);
  });

  // 在定稿层截正文会把系统通知的 256 上限强加给所有出口，用户的正文被提前砍掉。
  it("标题按 64 码点截断且不腰斩 emoji；正文原样透传（长度权威在各出口）", () => {
    expect(
      Array.from(finalizeRequest(requestOf({ title: "题".repeat(65) }), 1).title),
    ).toHaveLength(64);
    const emoji = "🙂".repeat(64);
    expect(finalizeRequest(requestOf({ title: emoji }), 1).title).toBe(emoji);
    const longBody = "文".repeat(5000);
    expect(finalizeRequest(requestOf({ body: longBody }), 1).body).toBe(longBody);
  });

  // ts 或 kind 被改写，历史与投递载荷就对不上号，webhook 的 {{kind}} 也会跟着错。
  it("定稿不改内容：kind 与 ts 原样进消息（webhook 的 {{kind}}、bark 的 levels[kind] 都靠它）", () => {
    const message = finalizeRequest(
      requestOf({ kind: "demo:report", title: "T", body: "B" }),
      1_700_000_000_000,
    );
    expect(message.kind).toBe("demo:report");
    expect(message.ts).toBe(1_700_000_000_000);
    expect(message.title).toBe("T");
    expect(message.body).toBe("B");
  });
});
