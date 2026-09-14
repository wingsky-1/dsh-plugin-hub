/**
 * scope 域 —— 生效值、失效自愈、接管资格（等待 / 捕获 / 放弃）与「解析器永不抛出」。
 *
 * 为什么这是最需要逐条断言的一片：这里的每个分支失效都不报错，只让文件根指向错的地方，
 * 或者更糟——让整个文件读取链路硬失败（resolver 抛异常会被官方 gateway 翻成 gateway/lookup-failed，
 * 那不是回退，是整条链路不可用）。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { BindingRecord } from "../../src/server/binding/interface.ts";
import type { FileScope, LookupDescriptorPort, ScopeDeps } from "../../src/server/scope/deps.ts";
import { directoryExists } from "../../src/server/scope/impl/own/index.ts";
import { effectiveWorktree, resolveScope } from "../../src/server/scope/impl/resolve/index.ts";
import { scopeService } from "../../src/server/scope/impl/service/index.ts";
import { installScope, releaseScope, takeoverState } from "../../src/server/scope/interface.ts";

const record: BindingRecord = {
  repoRoot: "/repo",
  worktreeRoot: "/wt",
  branch: "feature",
  createdAt: "2026-09-14T00:00:00.000Z",
};

const warns: string[] = [];
const logger = { warn: (message: string) => warns.push(message) };

/** 域是进程内单例：每个用例装一次、afterEach 统一释放——漏掉会让下一个用例撞「只能装配一次」。 */
afterEach(() => {
  releaseScope();
  warns.splice(0);
});

/**
 * 官方 provider 的假件：`registerProvider()` 复刻官方「注册即 emit 一次查找表变更」。
 *
 * 订阅语义必须是真的（订阅之前 emit 的事件不补发），否则「先订阅、再重读」这条判据会恒真。
 */
function fakeLookups(initialDescriptor?: LookupDescriptorPort) {
  let descriptor = initialDescriptor;
  const listeners = new Set<() => void>();
  /** 注册一个 provider 并 emit：官方 register 的形状（dsh-typert-registry/lib/index.js:238-251）。 */
  const registerProvider = (next: LookupDescriptorPort): void => {
    descriptor = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    current: () => descriptor,
    registerProvider,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
  };
}

function scopeDeps(
  options: {
    binding?: Record<string, BindingRecord>;
    belongs?: boolean;
    dropOk?: boolean;
    exists?: boolean;
    descriptor?: LookupDescriptorPort;
    configureThrows?: boolean;
    /** 官方 provider 恰好在 install 的 `subscribe` 调用**之中**注册（订阅与重读之间的那个窗口）。 */
    providerArrivesDuringSubscribe?: LookupDescriptorPort;
    /** 会话链：子会话 id → 父会话 id（缺省没有父）。 */
    parents?: Record<string, string>;
  } = {},
) {
  const table = new Map<string, BindingRecord>(Object.entries(options.binding ?? {}));
  const dropped: string[] = [];
  /** 谁被查过登记：父链走错时这里会出现不存在的会话（或同一个 id 出现两次）。 */
  const bindingGets: string[] = [];
  const configured: Array<(id: string) => Promise<FileScope | undefined>> = [];
  let disposed = false;

  const lookups = fakeLookups(options.descriptor);
  const subscribe = (listener: () => void): (() => void) => {
    if (options.providerArrivesDuringSubscribe !== undefined) {
      // 事件在订阅**期间**发完：只有订阅之后的那次重读能看见它。
      lookups.registerProvider(options.providerArrivesDuringSubscribe);
    }
    return lookups.subscribe(listener);
  };

  const deps: ScopeDeps = {
    logger,
    binding: {
      get: (id) => {
        bindingGets.push(id);
        return table.get(id);
      },
      drop: async (id) => {
        if (options.dropOk === false) return { ok: false, reason: "disk full" };
        table.delete(id);
        dropped.push(id);
        return { ok: true };
      },
    },
    git: { belongsTo: async () => options.belongs !== false },
    typert: {
      current: () => lookups.current(),
      subscribe,
      configure: (resolver) => {
        if (options.configureThrows === true) throw new Error("already configured");
        configured.push(resolver);
        return () => {
          disposed = true;
        };
      },
    },
    sessions: { parentOf: (id) => options.parents?.[id] },
    existsDirectory: () => options.exists !== false,
  };

  return {
    deps,
    table,
    dropped,
    bindingGets,
    configured,
    lookups,
    isDisposed: () => disposed,
    /** 让官方 provider 出现（并 emit 一次），驱动本域的等待路径。 */
    appear: (descriptor: LookupDescriptorPort) => lookups.registerProvider(descriptor),
  };
}

describe("directoryExists 的默认语义", () => {
  const statOf = (existing: readonly string[]) => (path: string) =>
    existing.includes(path) ? { isDirectory: () => true } : undefined;

  it("存在且是目录为真、不存在为假", () => {
    expect(directoryExists("/a", statOf(["/a"]))).toBe(true);
    expect(directoryExists("/b", statOf(["/a"]))).toBe(false);
  });

  it("存在但不是目录为假", () => {
    expect(directoryExists("/a", () => ({ isDirectory: () => false }))).toBe(false);
  });

  it("stat 抛出（权限 / IO 抖动）按存在处理——读不了不等于不存在", () => {
    expect(
      directoryExists("/a", () => {
        throw new Error("EACCES");
      }),
    ).toBe(true);
  });
});

describe("effectiveWorktree", () => {
  it("无绑定返回 null", async () => {
    const { deps } = scopeDeps();
    expect(await effectiveWorktree(deps, "s1")).toBeNull();
  });

  it("绑定有效时返回 worktree 根（且不摘除）", async () => {
    const { deps, dropped } = scopeDeps({ binding: { s1: record }, belongs: true, exists: true });
    expect(await effectiveWorktree(deps, "s1")).toBe("/wt");
    expect(dropped.length).toBe(0);
  });

  it("目录已消失时按未绑定处理，并摘掉绑定（让客户端 revision 失效）", async () => {
    const { deps, dropped, table } = scopeDeps({ binding: { s1: record }, exists: false });
    expect(await effectiveWorktree(deps, "s1")).toBeNull();
    expect(dropped).toEqual(["s1"]);
    expect(table.has("s1")).toBe(false);
    expect(warns.some((w) => w.includes("worktree 目录不存在"))).toBe(true);
  });

  it("已不是该仓库的 worktree 时按未绑定处理，并摘掉绑定", async () => {
    const { deps, dropped } = scopeDeps({ binding: { s1: record }, exists: true, belongs: false });
    expect(await effectiveWorktree(deps, "s1")).toBeNull();
    expect(dropped).toEqual(["s1"]);
    expect(warns.some((w) => w.includes("已不是该仓库的 worktree"))).toBe(true);
  });

  it("归属校验不通过时不调用 drop 之外的任何东西（目录未被删）", async () => {
    const { deps, dropped } = scopeDeps({ binding: { s1: record }, exists: true, belongs: false });
    await effectiveWorktree(deps, "s1");
    expect(dropped.length).toBe(1);
  });

  it("摘除失败时仍然按未绑定处理，不回退到已失效的绑定", async () => {
    const { deps, dropped } = scopeDeps({
      binding: { s1: record },
      exists: false,
      dropOk: false,
    });
    expect(await effectiveWorktree(deps, "s1")).toBeNull();
    expect(dropped.length).toBe(0);
    expect(warns.some((w) => w.includes("摘除失效绑定失败"))).toBe(true);
  });
});

describe("子 agent 继承父会话的登记", () => {
  const official: LookupDescriptorPort = {
    resolve: async (id) => ({ sessionId: id, workspaceRoot: "/official" }),
  };

  it("本会话没登记时取父会话的生效根", async () => {
    const { deps } = scopeDeps({
      binding: { parent: record },
      parents: { child: "parent" },
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBe("/wt");
  });

  it("父链多级：本会话 → 父 → 祖父", async () => {
    const { deps } = scopeDeps({
      binding: { grand: record },
      parents: { child: "parent", parent: "grand" },
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBe("/wt");
  });

  it("自己登记了就不向上看（父的登记是另一个根）", async () => {
    const own: BindingRecord = { ...record, worktreeRoot: "/wt-own" };
    const { deps } = scopeDeps({
      binding: { child: own, parent: record },
      parents: { child: "parent" },
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBe("/wt-own");
  });

  it("到顶（没有父）按未绑定处理，且不再向不存在的父会话查登记", async () => {
    const { deps, bindingGets } = scopeDeps({
      binding: { parent: record },
      parents: {},
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBeNull();
    expect(bindingGets).toEqual(["child"]);
  });

  it("父链成环时停下（错数据不转圈，每个会话最多查一次）", async () => {
    const { deps, bindingGets } = scopeDeps({ parents: { a: "b", b: "a" }, exists: true });
    expect(await effectiveWorktree(deps, "a")).toBeNull();
    expect(bindingGets).toEqual(["a", "b"]);
  });

  it("父会话的登记失效 → 摘掉它，仍按未绑定处理（回退自己的 cwd）", async () => {
    const { deps, dropped, table } = scopeDeps({
      binding: { parent: record },
      parents: { child: "parent" },
      exists: false,
    });
    expect(await effectiveWorktree(deps, "child")).toBeNull();
    expect(dropped).toEqual(["parent"]);
    expect(table.has("parent")).toBe(false);
  });

  it("路由与解析器读同一份继承结果（一处实现覆盖两端）", async () => {
    const { deps, configured } = scopeDeps({
      descriptor: official,
      binding: { parent: record },
      parents: { child: "parent" },
      exists: true,
      belongs: true,
    });
    installScope(deps);
    // 路由那条（api 域读 effectiveWorktree）与 resolver 那条（官方 gateway 读它）必须同源。
    expect(await scopeService.effectiveWorktree("child")).toBe("/wt");
    expect(await configured[0]?.("child")).toEqual({
      sessionId: "child",
      workspaceRoot: "/wt",
    });
  });
});

describe("resolveScope 的委托与永不抛出", () => {
  it("命中绑定时不调用委托", async () => {
    const { deps } = scopeDeps({ binding: { s1: record }, exists: true, belongs: true });
    let called = 0;
    const result = await resolveScope(
      deps,
      async () => {
        called += 1;
        return undefined;
      },
      "s1",
    );
    expect(result).toEqual({ sessionId: "s1", workspaceRoot: "/wt" });
    expect(called).toBe(0);
  });

  it("未命中时委托官方语义", async () => {
    const { deps } = scopeDeps();
    const result = await resolveScope(
      deps,
      async (id) => ({ sessionId: id, workspaceRoot: "/cwd" }),
      "s1",
    );
    expect(result).toEqual({ sessionId: "s1", workspaceRoot: "/cwd" });
  });

  it("取绑定抛异常时回落委托，且异常不外泄", async () => {
    const { deps } = scopeDeps();
    const throwing: ScopeDeps = {
      ...deps,
      binding: {
        get: () => {
          throw new Error("boom");
        },
        drop: deps.binding.drop,
      },
    };
    const result = await resolveScope(
      throwing,
      async (id) => ({ sessionId: id, workspaceRoot: "/cwd" }),
      "s1",
    );
    expect(result).toEqual({ sessionId: "s1", workspaceRoot: "/cwd" });
    expect(warns.some((w) => w.includes("解析文件根失败"))).toBe(true);
  });

  it("存在性判定本身抛异常时也回落委托（不是硬失败）", async () => {
    const { deps } = scopeDeps({ binding: { s1: record } });
    const throwing: ScopeDeps = {
      ...deps,
      existsDirectory: () => {
        throw new Error("stat exploded");
      },
    };
    const result = await resolveScope(
      throwing,
      async (id) => ({ sessionId: id, workspaceRoot: "/cwd" }),
      "s1",
    );
    expect(result).toEqual({ sessionId: "s1", workspaceRoot: "/cwd" });
    expect(warns.some((w) => w.includes("解析文件根失败"))).toBe(true);
  });

  it("委托自己也抛错时返回 undefined，不把异常抛给 gateway", async () => {
    const { deps } = scopeDeps();
    const result = await resolveScope(
      deps,
      async () => {
        throw new Error("delegate exploded");
      },
      "s1",
    );
    expect(result).toBeUndefined();
    expect(warns.some((w) => w.includes("官方默认解析失败"))).toBe(true);
  });
});

describe("installScope 的接管资格", () => {
  const official: LookupDescriptorPort = {
    resolve: async (id) => ({ sessionId: id, workspaceRoot: "/official" }),
  };

  it("provider 已注册时**捕获官方 resolve** 并委托（不是委托我们自己的包装）", async () => {
    const { deps, configured } = scopeDeps({ descriptor: official });
    installScope(deps);
    expect(scopeService.isInstalled()).toBe(true);
    expect(takeoverState()).toBe("live");
    expect(configured.length).toBe(1);
    expect(await configured[0]?.("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/official" });
  });

  it("provider 尚未注册时不接管、不 configure，只出声等它（文件根保持官方语义）", async () => {
    const { deps, configured } = scopeDeps();
    installScope(deps);
    expect(takeoverState()).toBe("waiting");
    expect(scopeService.isInstalled()).toBe(false);
    expect(configured.length).toBe(0);
    expect(await scopeService.effectiveWorktree("s1")).toBeNull();
    expect(warns.filter((w) => w.includes("provider 尚未注册")).length).toBe(1);
  });

  it("provider 随后出现（查找表通知）→ 当场接管", async () => {
    const { deps, configured, appear } = scopeDeps();
    installScope(deps);
    appear(official);
    expect(takeoverState()).toBe("live");
    expect(configured.length).toBe(1);
    expect(await configured[0]?.("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/official" });
  });

  it("provider 恰好在订阅调用期间注册 → 订阅之后的那次重读必须看见它", () => {
    // 事件在 subscribe 调用里就发完了（订阅者还没有登记），只靠通知会永久停在等待态。
    const { deps, configured } = scopeDeps({ providerArrivesDuringSubscribe: official });
    installScope(deps);
    expect(takeoverState()).toBe("live");
    expect(configured.length).toBe(1);
  });

  it("等待期的重复通知不重复出声，接管后也不再 configure", () => {
    const { deps, configured, appear } = scopeDeps();
    installScope(deps);
    appear(official);
    appear(official);
    expect(configured.length).toBe(1);
    expect(warns.filter((w) => w.includes("provider 尚未注册")).length).toBe(1);
  });

  it("已被第三方 configure 时放弃接管并出声，且此后不再试（终态）", () => {
    const { deps, configured, appear } = scopeDeps({
      descriptor: official,
      configureThrows: true,
    });
    installScope(deps);
    expect(takeoverState()).toBe("abandoned");
    expect(scopeService.isInstalled()).toBe(false);
    expect(configured.length).toBe(0);
    expect(warns.some((w) => w.includes("已有解析器，放弃接管"))).toBe(true);
    // 再来通知也不再试：重试只会反复撞同一个「已被占用」。
    appear(official);
    expect(configured.length).toBe(0);
  });

  it("未接管（等待中或已放弃）时 effectiveWorktree 恒为 null（客户端因此不动文件根）", async () => {
    const waiting = scopeDeps();
    installScope(waiting.deps);
    expect(await scopeService.effectiveWorktree("s1")).toBeNull();
    releaseScope();

    const abandoned = scopeDeps({ descriptor: official, configureThrows: true });
    installScope(abandoned.deps);
    expect(await scopeService.effectiveWorktree("s1")).toBeNull();
  });

  it("接管后 effectiveWorktree 反映当前绑定（路由与解析器读同一个值）", async () => {
    const { deps } = scopeDeps({
      descriptor: official,
      binding: { s1: record },
      exists: true,
      belongs: true,
    });
    installScope(deps);
    expect(await scopeService.effectiveWorktree("s1")).toBe("/wt");
    expect(await scopeService.effectiveWorktree("other")).toBeNull();
  });

  it("release 之后官方那侧留着的闭包不再拿旧 deps 出结果（回 undefined）", async () => {
    const { deps, configured } = scopeDeps({
      descriptor: official,
      binding: { s1: record },
      exists: true,
      belongs: true,
    });
    installScope(deps);
    expect(await configured[0]?.("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/wt" });
    releaseScope();
    // 闭包按调用当刻读装配入参：释放之后它只能回 undefined，让 gateway 走 lookup-not-found。
    expect(await configured[0]?.("s1")).toBeUndefined();
  });

  it("release 退订、调用 disposer（官方默认解析随之恢复），且幂等", () => {
    const { deps, isDisposed, lookups } = scopeDeps({ descriptor: official });
    installScope(deps);
    expect(lookups.listenerCount()).toBe(1);
    releaseScope();
    expect(isDisposed()).toBe(true);
    expect(lookups.listenerCount()).toBe(0);
    releaseScope();
    expect(isDisposed()).toBe(true);
  });
});

describe("二次装配守卫与 release 复位", () => {
  const official: LookupDescriptorPort = {
    resolve: async (id) => ({ sessionId: id, workspaceRoot: "/official" }),
  };

  it("第二次装配当场抛错，不静默接管两份", () => {
    const first = scopeDeps({ descriptor: official });
    installScope(first.deps);
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    expect(() => installScope(scopeDeps().deps)).toThrow(
      "dsh-worktree-sidebar: scope 域只能装配一次",
    );
    expect(first.configured.length).toBe(1);
  });

  it("release 交还 resolver，且再次装配必须能重新接管", () => {
    const first = scopeDeps({ descriptor: official });
    installScope(first.deps);
    expect(scopeService.isInstalled()).toBe(true);
    releaseScope();
    expect(first.isDisposed()).toBe(true);
    expect(scopeService.isInstalled()).toBe(false);
    expect(takeoverState()).toBe("idle");

    const second = scopeDeps({ descriptor: official });
    installScope(second.deps);
    expect(scopeService.isInstalled()).toBe(true);
    expect(second.configured.length).toBe(1);
  });

  it("「已被占用」是当次事实：上一次被占用不阻止 release 后的下一次接管", () => {
    const occupied = scopeDeps({ descriptor: official, configureThrows: true });
    installScope(occupied.deps);
    expect(scopeService.isInstalled()).toBe(false);
    releaseScope();
    const free = scopeDeps({ descriptor: official });
    installScope(free.deps);
    expect(scopeService.isInstalled()).toBe(true);
    expect(free.configured.length).toBe(1);
  });

  it("release 之后能力面当场失败，不拿旧 deps 出结果", async () => {
    releaseScope();
    await expect(scopeService.effectiveWorktree("s1")).rejects.toThrow(
      "dsh-worktree-sidebar: scope 域尚未装配",
    );
  });
});
