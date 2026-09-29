/**
 * dsh-mcp-manager — unit：workspace 域的 (scope, name)→id 内存表（#767 S1-4a）。
 *
 * 判据锚点：同参恒同值、不同参不共享、scope 边界不产生键歧义、id 恒满足官方字符集与长度、
 * 冲突重试有界、生成器产出非法值时如实抛错、跨实例不共享（I9 实证）。
 *
 * 官方 SERVER_NAME_PATTERN 在断言里**独立抄写**一份：若拿被测实现消费的那份常量做断言，常量被
 * 改宽时两侧一起变，判据静默失效；这里额外用 source 相等把「共享层那份仍是官方口径」钉住。
 *
 * 本片全同步（id 分配不涉任何等待），没有时序假设，因此不需要 pollUntil，也不存在固定 sleep。
 */
import { describe, expect, it } from "vitest";
import { SERVER_NAME_PATTERN } from "../../src/server/shared/interface.ts";
import { makeServerIdTable } from "../../src/server/workspace/interface.ts";

/** 官方 @deepseek-ai/dsh-mcp-client 的 serverName 约束（独立抄写，防同源互证）。 */
const OFFICIAL_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 按序吐出候选值的注入生成器；`calls` 暴露调用次数，用来证明「命中已有条目不再要 id」。 */
function idSequence(values: string[]) {
  let index = 0;
  return {
    factory: () => values[Math.min(index++, values.length - 1)],
    calls: () => index,
  };
}

describe("(scope, name) → id 内存表", () => {
  it("同一 (scope, name) 恒得同一 id，且只向生成器要一次", () => {
    const seq = idSequence(["id_one"]);
    const table = makeServerIdTable({ idFactory: seq.factory });
    const first = table.idFor("/proj/a", "srv");
    expect(table.idFor("/proj/a", "srv")).toBe(first);
    expect(table.idFor("/proj/a", "srv")).toBe(first);
    expect(first).toBe("id_one");
    expect(seq.calls()).toBe(1);
  });

  it("不同 (scope, name) 取到不同 id", () => {
    const seq = idSequence(["id_a", "id_b", "id_c"]);
    const table = makeServerIdTable({ idFactory: seq.factory });
    const ids = [
      table.idFor("/proj/a", "srv"),
      table.idFor("/proj/a", "other"),
      table.idFor("/proj/b", "srv"),
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it("同名不同 scope 各自成条：跨 root 同名不再互斥", () => {
    const seq = idSequence(["id_g", "id_p"]);
    const table = makeServerIdTable({ idFactory: seq.factory });
    expect(table.idFor("@global", "srv")).toBe("id_g");
    expect(table.idFor("/proj/a", "srv")).toBe("id_p");
    expect(table.has("@global", "srv")).toBe(true);
    expect(table.has("/proj/a", "srv")).toBe(true);
  });

  it("has 只反映已分配状态，不触发分配", () => {
    const seq = idSequence(["id_x"]);
    const table = makeServerIdTable({ idFactory: seq.factory });
    expect(table.has("/proj/a", "srv")).toBe(false);
    expect(seq.calls()).toBe(0);
    table.idFor("/proj/a", "srv");
    expect(table.has("/proj/a", "srv")).toBe(true);
    expect(table.has("/proj/b", "srv")).toBe(false);
    expect(seq.calls()).toBe(1);
  });

  it("scope 与 name 的边界不含分隔符歧义：常见分隔符都不改变归属", () => {
    // 实现按 scope 分表；若改成「拼成一个字符串键」，下面每种分隔符都会把两组并成同一个键。
    for (const sep of [":", "/", "|", "\u0000", " "]) {
      const seq = idSequence(["id_1", "id_2"]);
      const table = makeServerIdTable({ idFactory: seq.factory });
      expect(table.idFor("s", `x${sep}y`)).not.toBe(table.idFor(`s${sep}x`, "y"));
    }
  });

  it("id 恒满足官方模式：注入的确定性生成器", () => {
    const table = makeServerIdTable({ idFactory: () => "Fixed_ID-09" });
    const id = table.idFor("/proj/a", "srv");
    expect(id).toBe("Fixed_ID-09");
    expect(OFFICIAL_SERVER_NAME_PATTERN.test(id)).toBe(true);
    // 共享层那份是单一物理定义，必须仍是官方口径（否则 id 的准入判定会跟着漂）。
    expect(SERVER_NAME_PATTERN.source).toBe(OFFICIAL_SERVER_NAME_PATTERN.source);
  });

  it("id 恒满足官方模式：默认生成器 200 次抽取各不相同且全部合规", () => {
    const table = makeServerIdTable();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = table.idFor("/proj/a", `srv-${i}`);
      expect(OFFICIAL_SERVER_NAME_PATTERN.test(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  it("生成器连续产出已占用的 id 时重试，直到取到未占用候选", () => {
    const seq = idSequence(["dup", "dup", "uniq"]);
    const table = makeServerIdTable({ idFactory: seq.factory });
    expect(table.idFor("/proj/a", "srv")).toBe("dup");
    expect(table.idFor("/proj/a", "other")).toBe("uniq");
    expect(seq.calls()).toBe(3);
  });

  it("冲突重试有上界：恒定冲突的生成器如实抛错且不留半条记录", () => {
    const table = makeServerIdTable({ idFactory: () => "same" });
    expect(table.idFor("/proj/a", "srv")).toBe("same");
    expect(() => table.idFor("/proj/a", "other")).toThrow(/分配失败/);
    expect(table.has("/proj/a", "other")).toBe(false);
    expect(table.idFor("/proj/a", "srv")).toBe("same");
  });

  it("生成器产出非法字符的 id 时如实抛错，不静默放行", () => {
    const table = makeServerIdTable({ idFactory: () => "bad id!" });
    expect(() => table.idFor("/proj/a", "srv")).toThrow(/SERVER_NAME_PATTERN/);
    expect(table.has("/proj/a", "srv")).toBe(false);
  });

  it("生成器返回非字符串时同样拒绝（正则会隐式字符串化并放行 undefined）", () => {
    const table = makeServerIdTable({ idFactory: () => undefined as unknown as string });
    expect(() => table.idFor("/proj/a", "srv")).toThrow(/SERVER_NAME_PATTERN/);
  });

  it("跨实例不共享：第二张表不影响第一张（I9）", () => {
    const first = makeServerIdTable({ idFactory: () => "shared_id" });
    const second = makeServerIdTable({ idFactory: () => "shared_id" });
    expect(first.idFor("/proj/a", "srv")).toBe("shared_id");
    // 第一张表已占用 shared_id；第二张表若真独立，就必须照常分配（模块级状态会让它冲突抛错）。
    expect(second.idFor("/proj/a", "other")).toBe("shared_id");
    expect(first.has("/proj/a", "other")).toBe(false);
    expect(second.has("/proj/a", "other")).toBe(true);
  });
});
