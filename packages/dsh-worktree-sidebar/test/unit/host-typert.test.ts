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
 *
 * 假件的形状**照官方类型写**（`TypertLookupProvider` 的四个业务字段、`TypertDisposer` 是
 * `() => Promise<void>`、`subscribe` 的监听器吃一个 `TypertRegistryChange`）：
 * 用双断言把它糊过去的话，「少一个字段」「disposer 是同步的」这类形状漂移就再也测不出来了。
 */
import { describe, expect, it } from "vitest";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { TypertLookupProvider, TypertRegistryChange } from "@deepseek-ai/dsh-typert-protocol";
import type { TypertLookupsPort } from "../../src/server/host/typert.ts";
import { bindTypert } from "../../src/server/host/typert.ts";

/** 官方查找表的键：改这个名字等于换一张表，必须与 dsh-api-workspace-files 的注册一致。 */
const KEY = "workspaceFileScope";

/** 本域的窄返回值（官方 wire 上就是这两项）。 */
interface Scope {
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

/** 官方描述符的**完整形状**：四个业务字段一个都不能少（代码里读的是同一个键上的这个东西）。 */
function descriptorOf(resolve: TypertLookupProvider["resolve"]): TypertLookupProvider {
  return {
    parameter: "workspaceFileScope",
    wire: "workspaceFileScopeId",
    hostTypeSymbol: "@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope",
    wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
    resolve,
  };
}

type Get = TypertLookupsPort["get"];
type Configure = TypertLookupsPort["configure"];
type Subscribe = TypertLookupsPort["subscribe"];

function fakeLookups(provider?: TypertLookupProvider) {
  const gets: string[] = [];
  const configureKeys: string[] = [];
  const probes: Array<(id: string) => Promise<Scope | undefined>> = [];
  const listeners = new Set<Parameters<Subscribe>[0]>();

  const get: Get = (key) => {
    gets.push(key);
    return provider;
  };
  const configure: Configure = (key, resolver) => {
    configureKeys.push(key);
    probes.push(async (id) => {
      // 官方那一面的参数是「所有 lookup 键的 wire 联合」（`TypertLookupWire<TypertLookupMap[K]>`），
      // 本域这一个键的 wire 是 SessionId。用 `never` 过桥：它是唯一可赋给任意参数类型的值，
      // 也就避免为了这一句而引入 any / unknown（返回的那一支由 `in` 收窄）。
      const scope = await resolver(id as never);
      if (scope === undefined || !("workspaceRoot" in scope)) return undefined;
      return { sessionId: String(scope.sessionId), workspaceRoot: scope.workspaceRoot };
    });
    return async () => undefined;
  };
  const subscribe: Subscribe = (listener) => {
    listeners.add(listener);
    return async () => {
      listeners.delete(listener);
    };
  };

  /** 触发一次官方通知：载荷与本域无关（我们只把「再看一眼」这件事做一次）。 */
  const notify = (): void => {
    const change: TypertRegistryChange = { kind: "lookup", key: KEY };
    for (const listener of [...listeners]) listener(change);
  };

  return {
    port: { get, configure, subscribe } satisfies TypertLookupsPort,
    gets,
    configureKeys,
    probes,
    listeners,
    notify,
  };
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
    const provider = descriptorOf(async (id) => {
      asked.push(String(id));
      return { sessionId: id, workspaceRoot: "/official" };
    });
    const current = bindTypert(fakeLookups(provider).port).current();
    if (current === undefined) throw new Error("描述符在场时必须捕获到");

    expect(await current.resolve("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/official" });
    expect(asked).toEqual(["s1"]);
  });

  it("调用描述符的 resolve 时带着它自己作 this（裸取函数引用会在真机上 TypeError）", async () => {
    // 读 `this` 是官方描述符的真实形态：resolve 是对象方法，而我们把 `descriptor.resolve` 取出来调用，
    // 少了 `.bind(descriptor)` 时这里当场抛（假端口单测本来全绿，这正是它要挡住的那一类）。
    const official = {
      parameter: "session",
      wire: "sessionId",
      hostTypeSymbol: "@deepseek-ai/dsh-session#Session",
      wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
      root: "/from-descriptor",
      resolve(id: SessionId): { sessionId: SessionId; workspaceRoot: string } {
        return { sessionId: id, workspaceRoot: this.root };
      },
    };
    const provider: TypertLookupProvider = official;
    const current = bindTypert(fakeLookups(provider).port).current();
    if (current === undefined) throw new Error("描述符在场时必须捕获到");

    expect(await current.resolve("s1")).toEqual({
      sessionId: "s1",
      workspaceRoot: "/from-descriptor",
    });
  });

  it("官方 resolve 回 undefined 时窄面也回 undefined（不造一个空根）", async () => {
    const current = bindTypert(fakeLookups(descriptorOf(async () => undefined)).port).current();
    if (current === undefined) throw new Error("描述符在场时必须捕获到");
    expect(await current.resolve("s1")).toBeUndefined();
  });
});

describe("subscribe / configure：与官方查找表对接", () => {
  it("subscribe 把官方通知转发给我们那一个监听器，并回退订面", async () => {
    const lookups = fakeLookups(undefined);
    let seen = 0;
    const unsubscribe = bindTypert(lookups.port).subscribe(() => {
      seen += 1;
    });
    expect(lookups.listeners.size).toBe(1);

    lookups.notify();
    expect(seen).toBe(1);

    await unsubscribe();
    expect(lookups.listeners.size).toBe(0);
  });

  it("configure 用同一个键登记，并把**官方** sessionId 回填到 wire 上", async () => {
    const lookups = fakeLookups(undefined);
    bindTypert(lookups.port).configure(async () => ({
      sessionId: "我们自己回传的字符串",
      workspaceRoot: "/wt",
    }));

    expect(lookups.configureKeys).toEqual([KEY]);
    const probe = lookups.probes[0];
    if (probe === undefined) throw new Error("configure 没有被调用");
    expect(await probe("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/wt" });
  });

  it("我们的解析器回 undefined 时 configure 的回调也回 undefined", async () => {
    const lookups = fakeLookups(undefined);
    bindTypert(lookups.port).configure(async () => undefined);
    const probe = lookups.probes[0];
    if (probe === undefined) throw new Error("configure 没有被调用");
    expect(await probe("s1")).toBeUndefined();
  });
});
