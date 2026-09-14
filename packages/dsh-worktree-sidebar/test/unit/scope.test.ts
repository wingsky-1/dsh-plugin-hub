/**
 * scope 域 —— 生效值、失效自愈、接管资格、官方默认的等价性与「解析器永不抛出」。
 *
 * 为什么这是最需要逐条断言的一片：这里的每个分支失效都不报错，只让文件根指向错的地方，
 * 或者更糟——让整个文件读取链路硬失败（resolver 抛异常会被官方 gateway 翻成 gateway/lookup-failed，
 * 那不是回退，是整条链路不可用）。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { BindingRecord } from "../../src/contract.ts";
import type {
  DefaultScopePort,
  FileScope,
  HeaderFace,
  LookupDescriptorPort,
  ScopeDeps,
} from "../../src/server/scope/deps.ts";
import { createFallback } from "../../src/server/scope/impl/fallback/index.ts";
import {
  directoryExists,
  effectiveWorktree,
  resolveScope,
} from "../../src/server/scope/impl/resolve/index.ts";
import { scopeService } from "../../src/server/scope/impl/service/index.ts";
import { installScope, releaseScope } from "../../src/server/scope/interface.ts";

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

function scopeDeps(
  options: {
    binding?: Record<string, BindingRecord>;
    belongs?: boolean;
    dropOk?: boolean;
    exists?: boolean;
    defaults?: Partial<DefaultScopePort>;
    descriptor?: LookupDescriptorPort;
    configureThrows?: boolean;
  } = {},
) {
  const table = new Map<string, BindingRecord>(Object.entries(options.binding ?? {}));
  const dropped: string[] = [];
  const configured: Array<(id: string) => Promise<FileScope | undefined>> = [];
  let disposed = false;

  const defaults: DefaultScopePort = {
    live: () => undefined,
    stored: async () => undefined,
    sandboxRoot: () => undefined,
    ...options.defaults,
  };

  const deps: ScopeDeps = {
    logger,
    binding: {
      get: (id) => table.get(id),
      drop: async (id) => {
        if (options.dropOk === false) return { ok: false, reason: "disk full" };
        table.delete(id);
        dropped.push(id);
        return { ok: true };
      },
    },
    git: { belongsTo: async () => options.belongs !== false },
    typert: {
      current: () => options.descriptor,
      configure: (resolver) => {
        if (options.configureThrows === true) throw new Error("already configured");
        configured.push(resolver);
        return () => {
          disposed = true;
        };
      },
    },
    defaults,
    existsDirectory: () => options.exists !== false,
  };

  return { deps, table, dropped, configured, isDisposed: () => disposed };
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

describe("官方默认的等价实现", () => {
  function fallback(overrides: Partial<DefaultScopePort>) {
    return createFallback({
      live: () => undefined,
      stored: async () => undefined,
      sandboxRoot: () => undefined,
      ...overrides,
    });
  }

  it("有活会话时用它的 cwd", async () => {
    const resolve = fallback({ live: () => ({ cwd: "/live" }) });
    expect(await resolve("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/live" });
  });

  it("有活会话时不查持久化（与官方同序）", async () => {
    let storedCalls = 0;
    const resolve = fallback({
      live: () => ({ cwd: "/live" }),
      stored: async () => {
        storedCalls += 1;
        return { cwd: "/stored" };
      },
    });
    await resolve("s1");
    expect(storedCalls).toBe(0);
  });

  it("无活会话时用持久化里的 cwd", async () => {
    const resolve = fallback({ stored: async () => ({ cwd: "/stored" }) });
    expect(await resolve("s2")).toEqual({ sessionId: "s2", workspaceRoot: "/stored" });
  });

  it("header 存在但 cwd 缺失时回落沙箱根（这条正是最容易写错的分支）", async () => {
    const resolve = fallback({
      live: () => ({ cwd: undefined }),
      sandboxRoot: () => "/sandbox",
    });
    expect(await resolve("s3")).toEqual({ sessionId: "s3", workspaceRoot: "/sandbox" });
  });

  it("持久化 header 存在但 cwd 缺失时同样回落沙箱根", async () => {
    const resolve = fallback({
      stored: async () => ({ cwd: undefined }),
      sandboxRoot: () => "/sandbox",
    });
    expect(await resolve("s3b")).toEqual({ sessionId: "s3b", workspaceRoot: "/sandbox" });
  });

  it("header 完全缺失时返回 undefined，**不**回落沙箱根（与官方同形）", async () => {
    const resolve = fallback({ sandboxRoot: () => "/sandbox" });
    expect(await resolve("s4")).toBeUndefined();
  });

  it("沙箱根也取不到时不返回 undefined 根（防御性收口）", async () => {
    const resolve = fallback({ live: () => ({ cwd: undefined }) });
    expect(await resolve("s5")).toEqual({ sessionId: "s5", workspaceRoot: "" });
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
  it("provider 已注册时**捕获官方 resolve** 并委托（不是委托我们自己的包装）", async () => {
    const official: LookupDescriptorPort = {
      resolve: async (id) => ({ sessionId: id, workspaceRoot: "/official" }),
    };
    const { deps, configured } = scopeDeps({
      descriptor: official,
      // 兜底会给出这个值；若捕获失败、误用兜底，断言就会看到它。
      defaults: { live: () => ({ cwd: "/fallback-would-say-this" }) },
    });
    installScope(deps);
    expect(scopeService.isInstalled()).toBe(true);
    expect(configured.length).toBe(1);
    expect(await configured[0]?.("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/official" });
  });

  it("provider 缺失时用等价实现兜底", async () => {
    const { deps, configured } = scopeDeps({
      defaults: { live: () => ({ cwd: "/live-cwd" }) },
    });
    installScope(deps);
    expect(await configured[0]?.("s1")).toEqual({ sessionId: "s1", workspaceRoot: "/live-cwd" });
  });

  it("已被第三方 configure 时放弃接管并出声，不抢", () => {
    const { deps, configured } = scopeDeps({ configureThrows: true });
    installScope(deps);
    expect(scopeService.isInstalled()).toBe(false);
    expect(configured.length).toBe(0);
    expect(warns.some((w) => w.includes("已有解析器，放弃接管"))).toBe(true);
  });

  it("未接管时 effectiveWorktree 恒为 null（客户端因此不动文件根）", async () => {
    const { deps } = scopeDeps({ configureThrows: true });
    installScope(deps);
    expect(await scopeService.effectiveWorktree("s1")).toBeNull();
  });

  it("接管后 effectiveWorktree 反映当前绑定（路由与解析器读同一个值）", async () => {
    const { deps } = scopeDeps({ binding: { s1: record }, exists: true, belongs: true });
    installScope(deps);
    expect(await scopeService.effectiveWorktree("s1")).toBe("/wt");
    expect(await scopeService.effectiveWorktree("other")).toBeNull();
  });

  it("release 调用 disposer（官方默认解析随之恢复），且幂等", () => {
    const { deps, isDisposed } = scopeDeps();
    installScope(deps);
    releaseScope();
    expect(isDisposed()).toBe(true);
    releaseScope();
    expect(isDisposed()).toBe(true);
  });
});

describe("二次装配守卫与 release 复位", () => {
  it("第二次装配当场抛错，不静默接管两份", () => {
    const first = scopeDeps();
    installScope(first.deps);
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    expect(() => installScope(scopeDeps().deps)).toThrow(
      "dsh-worktree-sidebar: scope 域只能装配一次",
    );
    expect(first.configured.length).toBe(1);
  });

  it("release 交还 resolver，且再次装配必须能重新接管", () => {
    const first = scopeDeps();
    installScope(first.deps);
    expect(scopeService.isInstalled()).toBe(true);
    releaseScope();
    expect(first.isDisposed()).toBe(true);
    expect(scopeService.isInstalled()).toBe(false);

    const second = scopeDeps();
    installScope(second.deps);
    expect(scopeService.isInstalled()).toBe(true);
    expect(second.configured.length).toBe(1);
  });

  it("「已被占用」是当次事实：上一次被占用不阻止 release 后的下一次接管", () => {
    const occupied = scopeDeps({ configureThrows: true });
    installScope(occupied.deps);
    expect(scopeService.isInstalled()).toBe(false);
    releaseScope();
    const free = scopeDeps();
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

/** 类型面哨兵：HeaderFace 的形状就是「cwd 可为 undefined」这一件事。 */
const _headerShape: HeaderFace = { cwd: undefined };
void _headerShape;
