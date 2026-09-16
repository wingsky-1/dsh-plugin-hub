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
import {
  bindingOrigin,
  effectiveWorktree,
  resolveScope,
  rootOf,
} from "../../src/server/scope/impl/resolve/index.ts";
import { scopeService } from "../../src/server/scope/impl/service/index.ts";
import {
  chainDiagnostics,
  installScope,
  releaseScope,
  takeoverState,
  worktreeOrigin,
} from "../../src/server/scope/interface.ts";

/** 会话 header 的创建时间；登记里存的凭据与它一致时绑定才算「属于当前这个会话」。 */
const SESSION_CREATED_AT = 1_700_000_000_000;

const record: BindingRecord = {
  repoRoot: "/repo",
  worktreeRoot: "/wt",
  branch: "feature",
  createdAt: "2026-09-14T00:00:00.000Z",
  sessionCreatedAt: SESSION_CREATED_AT,
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
    /** 摘除本身抛错（原子写失败以外的那类故障）。 */
    dropThrows?: boolean;
    /**
     * 归属读数。`true`/`false` 是早先写的简写（same / different），保留以免二十多处调用点全改；
     * 新增的第三态用字符串表达——它正是「读不出来」与「确实不同」必须分开的那一态。
     */
    belongs?: boolean | "same" | "different" | "unknown";
    dropOk?: boolean;
    exists?: boolean;
    descriptor?: LookupDescriptorPort;
    configureThrows?: boolean;
    /** 官方 provider 恰好在 install 的 `subscribe` 调用**之中**注册（订阅与重读之间的那个窗口）。 */
    providerArrivesDuringSubscribe?: LookupDescriptorPort;
    /** 会话链（**活**会话）：子会话 id → 父会话 id（缺省没有父）。 */
    parents?: Record<string, string>;
    /** 已结束、只能从**持久面**读父链的会话 id。 */
    notLive?: readonly string[];
    /** 持久面里的父链：会话 id → 父会话 id。 */
    storedParents?: Record<string, string>;
    /** 持久面读取抛错（后端坏掉）——本域必须把它收口成「到顶」。 */
    storedThrows?: boolean;
    /** 活会话的身份凭据；缺省与会话登记里的凭据一致。 */
    identities?: Record<string, number>;
    /** 已结束会话的身份凭据（持久面）。缺席即「读不出来」。 */
    storedIdentities?: Record<string, number>;
    /** 持久面身份读取抛错（后端坏掉）——调用方必须保住登记，只出声。 */
    identityThrows?: boolean;
  } = {},
) {
  const table = new Map<string, BindingRecord>(Object.entries(options.binding ?? {}));
  const dropped: string[] = [];
  /** 谁被查过登记：父链走错时这里会出现不存在的会话（或同一个 id 出现两次）。 */
  const bindingGets: string[] = [];
  /** 谁被持久面查过：活着的顶层会话不该出现在这里（那是确定的到顶，不该白加一次 IO）。 */
  const storedCalls: string[] = [];
  /** 谁被持久面查过**身份**：活会话的身份核对同样不该落到这里。 */
  const identityCalls: string[] = [];
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
        if (options.dropThrows === true) throw new Error("drop exploded");
        if (options.dropOk === false) return { ok: false, reason: "disk full" };
        table.delete(id);
        dropped.push(id);
        return { ok: true };
      },
    },
    git: {
      belongsTo: async () => {
        if (options.belongs === "unknown") {
          return { kind: "unknown", reason: "git 执行失败（EACCES）", notRepo: false } as const;
        }
        return options.belongs === false || options.belongs === "different"
          ? ({ kind: "different" } as const)
          : ({ kind: "same" } as const);
      },
    },
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
    sessions: {
      liveParentOf: (id) => {
        if (options.notLive?.includes(id) === true) return { kind: "not-live" };
        const parent = options.parents?.[id];
        return parent === undefined ? { kind: "root" } : { kind: "parent", id: parent };
      },
      storedParentOf: async (id) => {
        storedCalls.push(id);
        if (options.storedThrows === true) throw new Error("stored sessions unavailable");
        return options.storedParents?.[id];
      },
      liveIdentityOf: (id) => {
        if (options.notLive?.includes(id) === true) return undefined;
        return { createdAt: options.identities?.[id] ?? SESSION_CREATED_AT };
      },
      storedIdentityOf: async (id) => {
        identityCalls.push(id);
        if (options.identityThrows === true) throw new Error("identity unavailable");
        const createdAt = options.storedIdentities?.[id];
        return createdAt === undefined ? undefined : { createdAt };
      },
    },
    existsDirectory: () => options.exists !== false,
  };

  return {
    deps,
    table,
    dropped,
    bindingGets,
    storedCalls,
    identityCalls,
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

  it("默认实现按真 fs 判定：不存在的路径为假（throwIfNoEntry 写反会把它变成 true）", () => {
    // 这条必须走**默认**实现：注入 stat 的用例证明不了 `throwIfNoEntry` 的取值，
    // 而写反之后 ENOENT 会走 catch 分支，于是「目录没了」被判成「读不了」→ 永久留住绑定。
    expect(directoryExists("/dsh-worktree-sidebar-不存在-" + Date.now())).toBe(false);
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

  it("摘除本身抛错时也出声，且仍按未绑定处理（失败不许只落在没人看的 catch 里）", async () => {
    const { deps, table } = scopeDeps({
      binding: { s1: record },
      exists: false,
      dropThrows: true,
    });
    expect(await effectiveWorktree(deps, "s1")).toBeNull();
    // 摘除失败 → 磁盘上那条还在（下一次解析会再试一次），但这一次必须按未绑定回答。
    expect(table.has("s1")).toBe(true);
    expect(warns.some((w) => w.includes("摘除失效绑定抛出"))).toBe(true);
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

describe("会话身份：重启后新会话复用同一个 id", () => {
  const official: LookupDescriptorPort = {
    resolve: async (id) => ({ sessionId: id, workspaceRoot: "/official" }),
  };

  it("身份不同 ⇒ 摘掉登记并按未绑定处理（新会话不得继承上一进程的登记）", async () => {
    const { deps, dropped, table } = scopeDeps({
      binding: { s1: record },
      identities: { s1: SESSION_CREATED_AT + 1 },
      exists: true,
      belongs: "same",
    });
    expect(await effectiveWorktree(deps, "s1")).toBeNull();
    expect(dropped).toEqual(["s1"]);
    expect(table.has("s1")).toBe(false);
    expect(warns.some((w) => w.includes("已被另一个会话复用"))).toBe(true);
  });

  it("身份相同 ⇒ 照常返回 worktree 根（真恢复的会话仍然继承）", async () => {
    const { deps, dropped } = scopeDeps({ binding: { s1: record }, exists: true });
    expect(await effectiveWorktree(deps, "s1")).toBe("/wt");
    expect(dropped.length).toBe(0);
  });

  it("已结束会话从持久面读身份：读到且不同 ⇒ 摘掉", async () => {
    const { deps, dropped } = scopeDeps({
      binding: { s1: record },
      notLive: ["s1"],
      storedIdentities: { s1: 1 },
      exists: true,
    });
    expect(await effectiveWorktree(deps, "s1")).toBeNull();
    expect(dropped).toEqual(["s1"]);
  });

  it("身份读不出来（持久面缺席）⇒ 保留登记，不把「读不到」当成「不是同一个会话」", async () => {
    const { deps, dropped } = scopeDeps({
      binding: { s1: record },
      notLive: ["s1"],
      exists: true,
    });
    expect(await effectiveWorktree(deps, "s1")).toBe("/wt");
    expect(dropped.length).toBe(0);
  });

  it("身份读取抛错（持久面坏掉）⇒ 保留登记并出声", async () => {
    const { deps, dropped } = scopeDeps({
      binding: { s1: record },
      notLive: ["s1"],
      identityThrows: true,
      exists: true,
    });
    expect(await effectiveWorktree(deps, "s1")).toBe("/wt");
    expect(dropped.length).toBe(0);
    expect(warns.some((w) => w.includes("无法核对会话身份"))).toBe(true);
  });

  it("活会话的身份核对不查持久面（health 的成本读数与判定同源）", async () => {
    const { deps, identityCalls } = scopeDeps({ binding: { s1: record }, exists: true });
    await effectiveWorktree(deps, "s1");
    expect(identityCalls).toEqual([]);
  });

  it("持久面身份核对计入 health 读数；chainDiagnostics 回的是快照，改它改不动域内计数器", async () => {
    const { deps } = scopeDeps({
      descriptor: official,
      binding: { s1: record },
      notLive: ["s1"],
      storedIdentities: { s1: SESSION_CREATED_AT },
      exists: true,
    });
    installScope(deps);
    expect(await scopeService.effectiveWorktree("s1")).toBe("/wt");
    expect(chainDiagnostics().storedReads).toBe(1);

    const snapshot = chainDiagnostics() as { storedReads: number };
    snapshot.storedReads = 999;
    expect(chainDiagnostics().storedReads).toBe(1);
  });
});

describe("归属读数读不出来时保留登记", () => {
  it("belongsTo 回 unknown ⇒ 不摘除、照常返回根，并出声说明原因", async () => {
    const { deps, dropped } = scopeDeps({
      binding: { s1: record },
      belongs: "unknown",
      exists: true,
    });
    expect(await effectiveWorktree(deps, "s1")).toBe("/wt");
    expect(dropped.length).toBe(0);
    expect(warns.some((w) => w.includes("无法确认 worktree 归属") && w.includes("EACCES"))).toBe(
      true,
    );
  });

  it("目录不存在优先于归属判定：不为了问 git 而放过一次明确的「目录没了」", async () => {
    const { deps, dropped } = scopeDeps({
      binding: { s1: record },
      belongs: "unknown",
      exists: false,
    });
    expect(await effectiveWorktree(deps, "s1")).toBeNull();
    expect(dropped).toEqual(["s1"]);
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
    const { deps, bindingGets, storedCalls } = scopeDeps({
      binding: { parent: record },
      parents: {},
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBeNull();
    expect(bindingGets).toEqual(["child"]);
    // 活着的会话答「没有父」就是确定的到顶：不该再去问持久面（那是请求路径上的额外 IO）。
    expect(storedCalls).toEqual([]);
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

  it("子会话已结束（不在册）时从持久面取父链：继承仍然成立", async () => {
    const { deps, storedCalls } = scopeDeps({
      binding: { parent: record },
      notLive: ["child"],
      storedParents: { child: "parent" },
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBe("/wt");
    expect(storedCalls).toEqual(["child"]);
  });

  it("多级父链跨两种来源：结束的子 → 结束的父 → 活着的祖父", async () => {
    const { deps, storedCalls } = scopeDeps({
      binding: { grand: record },
      notLive: ["child", "parent"],
      storedParents: { child: "parent", parent: "grand" },
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBe("/wt");
    expect(storedCalls).toEqual(["child", "parent"]);
  });

  it("持久面读不出来时按「到顶」收口，不把异常抛进解析器", async () => {
    const { deps } = scopeDeps({
      binding: { parent: record },
      notLive: ["child"],
      storedThrows: true,
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBeNull();
  });

  it("持久面查了几次、坏了几次都进 health 读数（那是这处无声降级唯一的痕迹）", async () => {
    const hit = scopeDeps({
      descriptor: official,
      binding: { parent: record },
      notLive: ["child"],
      storedParents: { child: "parent" },
      exists: true,
      belongs: true,
    });
    installScope(hit.deps);
    expect(await scopeService.effectiveWorktree("child")).toBe("/wt");
    expect(chainDiagnostics()).toEqual({
      storedReads: 1,
      storedFailures: 0,
      lastFailure: undefined,
    });

    releaseScope();
    const broken = scopeDeps({
      descriptor: official,
      notLive: ["child"],
      storedThrows: true,
      exists: true,
      belongs: true,
    });
    installScope(broken.deps);
    // 收口仍然成立（到顶），但这一次失败必须留在读数里，而不是只留在没人看得到的 catch 里。
    expect(await scopeService.effectiveWorktree("child")).toBeNull();
    expect(chainDiagnostics()).toEqual({
      storedReads: 1,
      storedFailures: 1,
      lastFailure: "stored sessions unavailable",
    });
  });

  it("活着的顶层会话不查持久面，读数也必须是 0（判定与成本读数同源）", async () => {
    const { deps } = scopeDeps({
      descriptor: official,
      binding: { s1: record },
      exists: true,
      belongs: true,
    });
    installScope(deps);
    expect(await scopeService.effectiveWorktree("s1")).toBe("/wt");
    expect(chainDiagnostics().storedReads).toBe(0);
  });

  it("release 复位读数：下一次装配从 0 起，不留上一代的痕迹", async () => {
    const first = scopeDeps({ descriptor: official, notLive: ["child"], storedThrows: true });
    installScope(first.deps);
    await scopeService.effectiveWorktree("child");
    expect(chainDiagnostics().storedFailures).toBe(1);

    releaseScope();
    const second = scopeDeps({ descriptor: official, notLive: ["child"], storedParents: {} });
    installScope(second.deps);
    await scopeService.effectiveWorktree("child");
    expect(chainDiagnostics()).toEqual({
      storedReads: 1,
      storedFailures: 0,
      lastFailure: undefined,
    });
  });

  it("持久面缺席（组合里没挂后端）＝退回 live-only，不抛", async () => {
    const { deps } = scopeDeps({
      binding: { parent: record },
      notLive: ["child"],
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "child")).toBeNull();
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

describe("bindingOrigin 的三态与来源读取面", () => {
  it("rootOf 把三态翻成根：none 回 null，own / inherited 回登记里的根", () => {
    expect(rootOf({ kind: "none" })).toBeNull();
    expect(rootOf({ kind: "own", record })).toBe("/wt");
    expect(rootOf({ kind: "inherited", record, ownerSessionId: "parent" })).toBe("/wt");
  });

  it("本会话自己的登记 → own，record 就是表里那一条", async () => {
    const { deps } = scopeDeps({ binding: { s1: record }, exists: true, belongs: true });
    expect(await bindingOrigin(deps, "s1")).toEqual({ kind: "own", record });
  });

  it("只有父链上有登记 → inherited，并报出持有它的那个会话", async () => {
    const { deps } = scopeDeps({
      binding: { parent: record },
      parents: { child: "parent" },
      exists: true,
      belongs: true,
    });
    expect(await bindingOrigin(deps, "child")).toEqual({
      kind: "inherited",
      record,
      ownerSessionId: "parent",
    });
  });

  it("哪都没有 → none（不是「继承了一个 null」）", async () => {
    const { deps } = scopeDeps();
    expect(await bindingOrigin(deps, "s1")).toEqual({ kind: "none" });
  });

  it("双跳链：ownerSessionId 是最近一个**持有登记**的祖先，不是直接父", async () => {
    const { deps } = scopeDeps({
      binding: { grand: record },
      parents: { child: "parent", parent: "grand" },
      exists: true,
      belongs: true,
    });
    const origin = await bindingOrigin(deps, "child");
    expect(origin).toEqual({ kind: "inherited", record, ownerSessionId: "grand" });
  });

  it("用户 fork 的形态（有 parentSession、无 delegationDepth）与子 agent 走同一条判据", async () => {
    // fork 的 header 里本域能看到的事实只有 parentSession（端口里没有 delegationDepth / origin），
    // 所以「有父链」就是继承——维护者裁决「保留 fork 继承」在代码里就是这个样子。
    // 形态取自真机会话链：0d295ac4 ← f20ff925 ← fe0d5336，三条都是 isSeeded 的 fork。
    const { deps } = scopeDeps({
      binding: { "session-0d295ac4": record },
      parents: { "session-fe0d5336": "session-f20ff925", "session-f20ff925": "session-0d295ac4" },
      exists: true,
      belongs: true,
    });
    expect(await effectiveWorktree(deps, "session-fe0d5336")).toBe("/wt");
    expect(await bindingOrigin(deps, "session-fe0d5336")).toEqual({
      kind: "inherited",
      record,
      ownerSessionId: "session-0d295ac4",
    });
  });

  it("父记录失效时先摘掉它，再继续向上命中祖父（自愈不截断父链）", async () => {
    const grand: BindingRecord = { ...record, worktreeRoot: "/wt-grand" };
    const { deps, dropped, table } = scopeDeps({
      binding: { parent: record, grand },
      parents: { child: "parent", parent: "grand" },
      belongs: true,
    });
    // 只有父那条登记的目录没了；祖父那条仍然有效（harness 的 exists 是全局的，故这里按路径覆盖）。
    const scoped: ScopeDeps = { ...deps, existsDirectory: (path) => path !== record.worktreeRoot };
    expect(await bindingOrigin(scoped, "child")).toEqual({
      kind: "inherited",
      record: grand,
      ownerSessionId: "grand",
    });
    expect(dropped).toEqual(["parent"]);
    expect(table.has("parent")).toBe(false);
  });

  it("takeover 门是刻意分叉的：provider 缺席（waiting）时生效根回 null，登记事实照旧可读", async () => {
    const { deps } = scopeDeps({ binding: { s1: record }, exists: true, belongs: true });
    installScope(deps);
    expect(scopeService.takeoverState()).toBe("waiting");
    // 浏览器面（生效根）按官方语义走；工具面（登记事实）必须仍能读到自己的登记，
    // 否则接管冲突时连一条登记都清理不掉。
    expect(await scopeService.effectiveWorktree("s1")).toBeNull();
    expect(await worktreeOrigin("s1")).toEqual({ kind: "own", record });
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
    expect(scopeService.takeoverState()).toBe("live");
    expect(takeoverState()).toBe("live");
    expect(configured.length).toBe(1);
    expect(await configured[0]?.("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/official" });
  });

  it("provider 尚未注册时不接管、不 configure，只出声等它（文件根保持官方语义）", async () => {
    const { deps, configured } = scopeDeps();
    installScope(deps);
    expect(takeoverState()).toBe("waiting");
    expect(scopeService.takeoverState()).not.toBe("live");
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
    expect(scopeService.takeoverState()).not.toBe("live");
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
    expect(scopeService.takeoverState()).toBe("live");
    releaseScope();
    expect(first.isDisposed()).toBe(true);
    expect(scopeService.takeoverState()).not.toBe("live");
    expect(takeoverState()).toBe("idle");

    const second = scopeDeps({ descriptor: official });
    installScope(second.deps);
    expect(scopeService.takeoverState()).toBe("live");
    expect(second.configured.length).toBe(1);
  });

  it("「已被占用」是当次事实：上一次被占用不阻止 release 后的下一次接管", () => {
    const occupied = scopeDeps({ descriptor: official, configureThrows: true });
    installScope(occupied.deps);
    expect(scopeService.takeoverState()).not.toBe("live");
    releaseScope();
    const free = scopeDeps({ descriptor: official });
    installScope(free.deps);
    expect(scopeService.takeoverState()).toBe("live");
    expect(free.configured.length).toBe(1);
  });

  it("release 之后能力面当场失败，不拿旧 deps 出结果", async () => {
    releaseScope();
    await expect(scopeService.effectiveWorktree("s1")).rejects.toThrow(
      "dsh-worktree-sidebar: scope 域尚未装配",
    );
  });
});
