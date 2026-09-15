/**
 * host/typert 适配层 —— 官方类型只在这一个文件里出现，域内只认自己的窄接口。
 *
 * 为什么这一层要有判据：覆盖率读数显示它只有 47%（未覆盖的正是 `current()` 的两条返回分支
 * 与 `configure` 的包装分支）——也就是「读到了描述符」与「把我们的结果转成官方 wire」这两段。
 * 它们各自的失效形态都不是异常而是**静默错位**：
 *
 * 1. 查找表的键名是字符串常量。拼错不会有任何编译错误，只会让我们等一个永不到来的 provider
 *    （文件根永远按官方语义走，看起来像「插件没生效」）。
 * 2. `descriptor.resolve` 必须带着描述符作 `this` 调用（官方描述符是对象方法），
 *    裸取函数引用会在真机上第一次求值就 TypeError，而假端口单测全绿。
 * 3. `configure` 交回的 `sessionId` 必须是官方那一个（已品牌化的），不是我们回传的字符串。
 */
import { describe, expect, it } from "vitest";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { TypertLookupsPort } from "../../src/server/host/typert.ts";
import { bindTypert } from "../../src/server/host/typert.ts";

/** 官方查找表的键：改这个名字等于换一张表，必须与 dsh-api-workspace-files 的注册一致。 */
const KEY = "workspaceFileScope";

function fakeLookups(descriptor?: unknown) {
  const gets: string[] = [];
  const configureCalls: Array<{
    key: string;
    resolve: (id: SessionId) => Promise<unknown>;
  }> = [];
  const listeners = new Set<() => void>();
  const port = {
    get: (key: string) => {
      gets.push(key);
      return descriptor;
    },
    configure: (key: string, resolve: (id: SessionId) => Promise<unknown>) => {
      configureCalls.push({ key, resolve });
      return () => undefined;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as TypertLookupsPort;
  return { port, gets, configureCalls, listeners };
}

describe("current()：读当前生效的描述符", () => {
  it("查找表里没有这个键时回 undefined，而且问的就是那个键名", () => {
    const lookups = fakeLookups(undefined);
    expect(bindTypert(lookups.port).current()).toBeUndefined();
    // 键名拼错时 provider 永远不会出现——这条断言就是那条静默失效的闸门。
    expect(lookups.gets).toEqual([KEY]);
  });

  it("把官方描述符包成窄面：会话 id 原样传下去，返回形状只留两个字段", async () => {
    const asked: string[] = [];
    const descriptor = {
      resolve: async (id: SessionId) => {
        asked.push(String(id));
        return { sessionId: id, workspaceRoot: "/official", extra: "dropped" };
      },
    };
    const current = bindTypert(fakeLookups(descriptor).port).current();
    if (current === undefined) throw new Error("描述符在场时必须捕获到");
    expect(await current.resolve("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/official" });
    expect(asked).toEqual(["s1"]);
  });

  it("调用描述符的 resolve 时带着它自己作 this（裸取函数引用会在真机上 TypeError）", async () => {
    const descriptor = {
      root: "/from-descriptor",
      async resolve(id: SessionId) {
        // 读 this 是官方描述符的真实形态：丢了接收者这里当场抛。
        return { sessionId: id, workspaceRoot: this.root };
      },
    };
    const current = bindTypert(fakeLookups(descriptor).port).current();
    if (current === undefined) throw new Error("描述符在场时必须捕获到");
    expect(await current.resolve("s1")).toEqual({
      sessionId: "s1",
      workspaceRoot: "/from-descriptor",
    });
  });

  it("官方 resolve 回 undefined 时窄面也回 undefined（不造一个空根）", async () => {
    const descriptor = { resolve: async () => undefined };
    const current = bindTypert(fakeLookups(descriptor).port).current();
    if (current === undefined) throw new Error("描述符在场时必须捕获到");
    expect(await current.resolve("s1")).toBeUndefined();
  });
});

describe("subscribe / configure：与官方查找表对接", () => {
  it("subscribe 把官方通知转发给我们那一个监听器，并回退订面", () => {
    const lookups = fakeLookups(undefined);
    let seen = 0;
    const unsubscribe = bindTypert(lookups.port).subscribe(() => {
      seen += 1;
    });
    // 官方的事件载荷与本域无关：我们只把「再看一眼」这件事做一次。
    for (const listener of lookups.listeners) listener();
    expect(seen).toBe(1);
    expect(lookups.listeners.size).toBe(1);

    unsubscribe();
    expect(lookups.listeners.size).toBe(0);
  });

  it("configure 用同一个键登记，并把**官方** sessionId 回填到 wire 上", async () => {
    const lookups = fakeLookups(undefined);
    bindTypert(lookups.port).configure(async () => ({
      sessionId: "我们自己回传的字符串",
      workspaceRoot: "/wt",
    }));

    expect(lookups.configureCalls.map((call) => call.key)).toEqual([KEY]);
    const resolve = lookups.configureCalls[0]?.resolve;
    if (resolve === undefined) throw new Error("configure 没有被调用");
    expect(await resolve("s1" as SessionId)).toEqual({ sessionId: "s1", workspaceRoot: "/wt" });
  });

  it("我们的解析器回 undefined 时 configure 的回调也回 undefined", async () => {
    const lookups = fakeLookups(undefined);
    bindTypert(lookups.port).configure(async () => undefined);
    const resolve = lookups.configureCalls[0]?.resolve;
    if (resolve === undefined) throw new Error("configure 没有被调用");
    expect(await resolve("s1" as SessionId)).toBeUndefined();
  });
});
