/**
 * host/sessions 适配层 —— 会话链的**两个来源**怎么合成三态。
 *
 * 为什么这一层必须有判据：scope 域的用例递的全是**假端口**，真正把官方 live 面与持久面
 * 翻成 parent / root / not-live 的映射、以及「持久面按调用时刻取」这条时机纪律都住在这里。
 * 把 root 与 not-live 换一下，或把软取提到装配期，全仓没有一条判据会红——而这两种错法
 * 分别把「每个普通会话白加一次持久读取」与「晚挂的后端永久缺席」带进来。
 */
import { describe, expect, it } from "vitest";
import type { SessionsFace, StoredSessionsFace } from "../../src/server/host/sessions.ts";
import { bindSessions } from "../../src/server/host/sessions.ts";

/** 官方 live 面：`header.parentSession` 有无都要能表达（无父 ≠ 不在册）。 */
function liveFace(table: Record<string, string | undefined>) {
  const calls: string[] = [];
  const face: SessionsFace = {
    get: (id) => {
      const key = String(id);
      calls.push(key);
      if (!(key in table)) return undefined;
      const parent = table[key];
      return { header: parent === undefined ? {} : { parentSession: parent } };
    },
  };
  return { face, calls };
}

/** 官方持久面：单会话 header；查不到回 undefined（契约如此，不是抛错）。 */
function storedFace(table: Record<string, string>) {
  const calls: string[] = [];
  const face: StoredSessionsFace = {
    stat: async (id) => {
      const key = String(id);
      calls.push(key);
      const parent = table[key];
      return parent === undefined ? undefined : { header: { parentSession: parent } };
    },
  };
  return { face, calls };
}

describe("bindSessions：三态映射", () => {
  it("活着的顶层会话回 root，且**不问持久面**（确定的到顶不该变成请求路径上的一次 IO）", () => {
    const live = liveFace({ s1: undefined });
    const stored = storedFace({ s1: "谁都不该问" });

    expect(bindSessions(live.face, () => stored.face).liveParentOf("s1")).toEqual({ kind: "root" });
    expect(stored.calls).toEqual([]);
    expect(live.calls).toEqual(["s1"]);
  });

  it("活会话有父时回 parent(id)", () => {
    const live = liveFace({ child: "parent" });
    expect(bindSessions(live.face, () => undefined).liveParentOf("child")).toEqual({
      kind: "parent",
      id: "parent",
    });
  });

  it("不在册回 not-live，只有这一态才回落持久面（父链按 header 原样给出）", async () => {
    const live = liveFace({});
    const stored = storedFace({ child: "parent" });
    const port = bindSessions(live.face, () => stored.face);

    expect(port.liveParentOf("child")).toEqual({ kind: "not-live" });
    expect(await port.storedParentOf("child")).toBe("parent");
    expect(stored.calls).toEqual(["child"]);
  });

  it("持久面里也没有这条会话（契约是回 undefined，不是抛）→ 到顶", async () => {
    const port = bindSessions(liveFace({}).face, () => storedFace({}).face);
    expect(await port.storedParentOf("ghost")).toBeUndefined();
  });

  it("持久面缺席（组合里没挂后端）＝如实回 undefined，不抛", async () => {
    const port = bindSessions(liveFace({}).face, () => undefined);
    expect(await port.storedParentOf("child")).toBeUndefined();
  });

  it("持久面按**调用时刻**取：后端晚挂之后那一次就必须读得到", async () => {
    const stored = storedFace({ child: "parent" });
    let backend: StoredSessionsFace | undefined = undefined;
    const port = bindSessions(liveFace({}).face, () => backend);

    expect(await port.storedParentOf("child")).toBeUndefined();
    backend = stored.face;
    expect(await port.storedParentOf("child")).toBe("parent");
  });
});
