/**
 * dsh-mcp-manager — unit：McpStore 持久化全分支 + mcpServers JSON 导入。
 *
 * 覆盖：
 * - McpStore.load：文件不存在重置内存态、损坏 JSON 保持内存态并推进基线、
 *   解析成功但缺 servers/形态不对重置为空（#903 M3-store；损坏仍保持，两者区分）
 * - McpStore.save：目录缺失递归创建（两层缺失区分 recursive 语义）、原子写、mtime 基线、
 *   同路径串行 + 唯一 tmp 名（#903 M-store）、写前冲突 fail-closed（#903 M3-store 反写）
 * - changedOnDisk / reloadIfChanged：无基线、外部修改、文件删除、同毫秒改内容（全文快照）
 * - find / upsert（替换不追加）/ remove（未知名 no-op）
 * - fromClaudeEntry / parseClaudeJson：http/sse/stdio 全分支与错误路径
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// I8 导入面收窄：store/config 两域门面直引，不再经包根组合根。
const { McpStore } = await import("../../src/server/store/interface.ts");
const { fromClaudeEntry, parseClaudeJson } = await import("../../src/server/config/interface.ts");
const { readCatalogServerFromDisk } = await import("../../src/server/store/interface.ts");

let tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("构造器初始态", () => {
  it("初始 version 为 1", () => {
    const store = new McpStore(join(tempDir(), "mcp.json"));
    expect(store.data.version).toBe(1);
  });

  it("初始 servers 为空数组", () => {
    const store = new McpStore(join(tempDir(), "mcp.json"));
    expect(store.data.servers.length).toBe(0);
  });

  it("初始 mtimeMs 为 undefined", () => {
    const store = new McpStore(join(tempDir(), "mcp.json"));
    expect(store.mtimeMs).toBeUndefined();
  });

  it("无基线时 changedOnDisk 恒 false（即便文件存在）", async () => {
    const dir = tempDir();
    const store = new McpStore(join(dir, "mcp.json"));
    writeFileSync(join(dir, "mcp.json"), "{}");
    expect(await store.changedOnDisk()).toBe(false);
  });
});

describe("load：文件不存在 → 重置内存态 + 0 基线", () => {
  async function loadMissing() {
    const dir = tempDir();
    const store = new McpStore(join(dir, "missing.json"));
    store.data.servers.push({ name: "stale", transport: "stdio", command: "x" });
    await store.load();
    return store;
  }

  it("文件不存在应清空内存 servers", async () => {
    const store = await loadMissing();
    expect(store.data.servers.length).toBe(0);
  });

  it("文件不存在建立 0 基线", async () => {
    const store = await loadMissing();
    expect(store.mtimeMs).toBe(0);
  });
});

describe("load：正常读取 + mtime 基线", () => {
  async function loadedFixture() {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "a", transport: "stdio", command: "echo" }] }),
    );
    const store = new McpStore(path);
    await store.load();
    return { store, path };
  }

  /** 外部修改 mtime（并可选换内容）→ 制造磁盘变更。 */
  async function afterExternalChange({ rewrite = false } = {}) {
    const { store, path } = await loadedFixture();
    const future = Date.now() / 1000 + 10;
    utimesSync(path, future, future);
    if (rewrite) {
      writeFileSync(
        path,
        JSON.stringify({ version: 1, servers: [{ name: "b", transport: "stdio", command: "x" }] }),
      );
      utimesSync(path, future, future);
    }
    return { store, path };
  }

  it("正常读取 servers 数", async () => {
    const { store } = await loadedFixture();
    expect(store.data.servers.length).toBe(1);
  });

  it("正常读取 servers[0].name", async () => {
    const { store } = await loadedFixture();
    expect(store.data.servers[0].name).toBe("a");
  });

  it("load 建立 mtime 基线", async () => {
    const { store } = await loadedFixture();
    expect(typeof store.mtimeMs === "number" && store.mtimeMs > 0).toBeTruthy();
  });

  it("基线刚建立不应视为变更", async () => {
    const { store } = await loadedFixture();
    expect(await store.changedOnDisk()).toBe(false);
  });

  it("外部修改 mtime → changedOnDisk true", async () => {
    const { store } = await afterExternalChange();
    expect(await store.changedOnDisk()).toBe(true);
  });

  it("磁盘变更触发重读", async () => {
    const { store } = await afterExternalChange({ rewrite: true });
    expect(await store.reloadIfChanged()).toBe(true);
  });

  it("重读后内容为新值", async () => {
    const { store } = await afterExternalChange({ rewrite: true });
    await store.reloadIfChanged();
    expect(store.data.servers[0].name).toBe("b");
  });

  it("基线同步后不再变更", async () => {
    const { store } = await afterExternalChange({ rewrite: true });
    await store.reloadIfChanged();
    expect(await store.reloadIfChanged()).toBe(false);
  });
});

describe("load：解析成功但缺 servers/形态不对 → 重置为空（#903 M3-store）", () => {
  // 旧口径静默保留内存旧值：已删配置会在下次读盘复活。损坏 JSON 仍保持内存态
  // （下一分组），两者区分处理。
  async function loadInvalidServers(payload: string) {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, payload);
    const store = new McpStore(path);
    store.data.servers.push({ name: "keep", transport: "stdio", command: "x" });
    await store.load();
    return store;
  }

  it("servers 非 Array → 重置为空", async () => {
    const store = await loadInvalidServers(JSON.stringify({ version: 1, servers: "nope" }));
    expect(store.data.servers.length).toBe(0);
  });

  it("缺 servers 键（{}）→ 重置为空", async () => {
    const store = await loadInvalidServers(JSON.stringify({ version: 1 }));
    expect(store.data.servers.length).toBe(0);
  });
});

describe("load：损坏 JSON → 保持内存态，仍推进基线", () => {
  async function loadBroken() {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    writeFileSync(path, "{broken json!");
    const store = new McpStore(path);
    store.data.servers.push({ name: "kept", transport: "stdio", command: "x" });
    await store.load();
    return store;
  }

  it("损坏存储保持内存态", async () => {
    const store = await loadBroken();
    expect(store.data.servers.length).toBe(1);
  });

  it("仍推进基线避免反复重读", async () => {
    const store = await loadBroken();
    expect(typeof store.mtimeMs === "number" && store.mtimeMs > 0).toBeTruthy();
  });
});

describe("save：目录两层缺失 → recursive 创建；原子写 + 基线更新", () => {
  async function savedFixture() {
    const dir = tempDir();
    const path = join(dir, "l1", "l2", "mcp.json");
    const store = new McpStore(path);
    store.upsert({ name: "s", transport: "stdio", command: "echo" });
    await store.save();
    return { store, path };
  }

  it("recursive mkdir 后写入成功", async () => {
    const { path } = await savedFixture();
    expect(existsSync(path)).toBeTruthy();
  });

  it("写入内容为 upsert 的服务器", async () => {
    const { path } = await savedFixture();
    expect(JSON.parse(await readFile(path, "utf8")).servers[0].name).toBe("s");
  });

  it("save 更新 mtime 基线", async () => {
    const { store } = await savedFixture();
    expect(store.mtimeMs! > 0).toBeTruthy();
  });

  it("save 后 changedOnDisk 为 false", async () => {
    const { store } = await savedFixture();
    expect(await store.changedOnDisk()).toBe(false);
  });

  it("文件删除视为变更", async () => {
    const { store, path } = await savedFixture();
    // 文件被删除后 current=0 !== 基线 → 变更。
    rmSync(path);
    expect(await store.changedOnDisk()).toBe(true);
  });

  it("删除后 reloadIfChanged 返回 true", async () => {
    const { store, path } = await savedFixture();
    rmSync(path);
    store.data.servers.push({ name: "ghost", transport: "stdio", command: "x" });
    expect(await store.reloadIfChanged()).toBe(true);
  });

  it("删除后重读清空配置", async () => {
    const { store, path } = await savedFixture();
    rmSync(path);
    store.data.servers.push({ name: "ghost", transport: "stdio", command: "x" });
    await store.reloadIfChanged();
    expect(store.data.servers.length).toBe(0);
  });
});

describe("find / upsert / remove", () => {
  function crudFixture() {
    const store = new McpStore(join(tempDir(), "mcp.json"));
    return store;
  }

  function withServers() {
    const store = crudFixture();
    store.upsert({ name: "a", transport: "stdio", command: "1" });
    store.upsert({ name: "b", transport: "stdio", command: "2" });
    store.upsert({ name: "a", transport: "stdio", command: "3" });
    return store;
  }

  it("find 未知名返回 undefined", () => {
    const store = crudFixture();
    expect(store.find("nope")).toBeUndefined();
  });

  it("upsert 已有名替换不追加", () => {
    const store = withServers();
    expect(store.data.servers.length).toBe(2);
  });

  it("upsert 已有名替换为新值", () => {
    const store = withServers();
    expect(store.find("a")!.command).toBe("3");
  });

  it("upsert 其它名保持原值", () => {
    const store = withServers();
    expect(store.find("b")!.command).toBe("2");
  });

  it("remove 未知名 no-op", () => {
    const store = withServers();
    store.remove("nope");
    expect(store.data.servers.length).toBe(2);
  });

  it("remove 已知名缩减列表", () => {
    const store = withServers();
    store.remove("a");
    expect(store.data.servers.length).toBe(1);
  });

  it("remove 后 find 返回 undefined", () => {
    const store = withServers();
    store.remove("a");
    expect(store.find("a")).toBeUndefined();
  });
});

describe("fromClaudeEntry：http / sse / stdio 全分支", () => {
  it("type=http + url → streamable-http", () => {
    const http = fromClaudeEntry("h", { type: "http", url: "http://localhost:9/x" });
    expect(http.transport).toBe("streamable-http");
  });

  it("type=http 透传 url", () => {
    const http = fromClaudeEntry("h", { type: "http", url: "http://localhost:9/x" });
    expect(http.url).toBe("http://localhost:9/x");
  });

  it("type=sse 视为 http 族", () => {
    const sse = fromClaudeEntry("e", { type: "sse", url: "http://s/" });
    expect(sse.transport).toBe("streamable-http");
  });

  it("type=http 缺 url → 抛 missing url", () => {
    expect(() => fromClaudeEntry("bad", { type: "http" })).toThrow(/missing url/);
  });

  it("url 为空串 → 抛 missing url", () => {
    expect(() => fromClaudeEntry("bad", { url: "" })).toThrow(/missing url/);
  });

  it("headers 合入条目", () => {
    const withHeaders = fromClaudeEntry("h2", {
      url: "http://h/",
      headers: { Authorization: "Bearer ${T}" },
      env: { A: "1" },
    });
    expect(withHeaders.headers).toEqual({ Authorization: "Bearer ${T}" });
  });

  it("http 条目 env 记录来源 keys", () => {
    const withHeaders = fromClaudeEntry("h2", {
      url: "http://h/",
      headers: { Authorization: "Bearer ${T}" },
      env: { A: "1" },
    });
    expect(withHeaders.sourceEnv).toEqual(["A"]);
  });

  it("空 env 不设 sourceEnv", () => {
    const noEnv = fromClaudeEntry("h3", { url: "http://h/", env: {} });
    expect(noEnv.sourceEnv).toBeUndefined();
  });

  it("stdio transport 映射", () => {
    const stdio = fromClaudeEntry("c", {
      command: "npx",
      args: ["-y", 42],
      cwd: "/w",
      env: { K: 1, N: null },
    });
    expect(stdio.transport).toBe("stdio");
  });

  it("stdio command 映射", () => {
    const stdio = fromClaudeEntry("c", {
      command: "npx",
      args: ["-y", 42],
      cwd: "/w",
      env: { K: 1, N: null },
    });
    expect(stdio.command).toBe("npx");
  });

  it("args map String", () => {
    const stdio = fromClaudeEntry("c", {
      command: "npx",
      args: ["-y", 42],
      cwd: "/w",
      env: { K: 1, N: null },
    });
    expect(stdio.args).toEqual(["-y", "42"]);
  });

  it("stdio cwd 映射", () => {
    const stdio = fromClaudeEntry("c", {
      command: "npx",
      args: ["-y", 42],
      cwd: "/w",
      env: { K: 1, N: null },
    });
    expect(stdio.cwd).toBe("/w");
  });

  it("env 值 String 化", () => {
    const stdio = fromClaudeEntry("c", {
      command: "npx",
      args: ["-y", 42],
      cwd: "/w",
      env: { K: 1, N: null },
    });
    expect(stdio.env).toEqual({ K: "1", N: "null" });
  });

  it("stdio 缺省 cwd 为 undefined", () => {
    const bare = fromClaudeEntry("c2", { command: "x" });
    expect(bare.cwd).toBeUndefined();
  });

  it("stdio 缺省 args 为 undefined", () => {
    const bare = fromClaudeEntry("c2", { command: "x" });
    expect(bare.args).toBeUndefined();
  });

  it("stdio 缺省 env 为 undefined", () => {
    const bare = fromClaudeEntry("c2", { command: "x" });
    expect(bare.env).toBeUndefined();
  });

  it("空 cwd 不设置", () => {
    const emptyCwd = fromClaudeEntry("c3", { command: "x", cwd: "" });
    expect(emptyCwd.cwd).toBeUndefined();
  });

  it("非数组 args 忽略", () => {
    const nonArrayArgs = fromClaudeEntry("c4", { command: "x", args: "not-array" });
    expect(nonArrayArgs.args).toBeUndefined();
  });

  it("空条目 → 抛 unsupported entry", () => {
    expect(() => fromClaudeEntry("bad2", {})).toThrow(/unsupported entry/);
  });

  it("command 为空串 → 抛 unsupported entry", () => {
    expect(() => fromClaudeEntry("bad3", { command: "" })).toThrow(/unsupported entry/);
  });
});

describe("parseClaudeJson：形状校验", () => {
  const valid = '{"a":{"command":"x"},"b":{"url":"http://b/"}}';

  it("合法对象解析出两条条目", () => {
    expect(parseClaudeJson(valid).length).toBe(2);
  });

  it("条目名保序", () => {
    expect(parseClaudeJson(valid)[0].name).toBe("a");
  });

  it("url 条目映射为 streamable-http", () => {
    expect(parseClaudeJson(valid)[1].transport).toBe("streamable-http");
  });

  it("数组顶层 → must be an object", () => {
    expect(() => parseClaudeJson("[1]")).toThrow(/must be an object/);
  });

  it("null 顶层 → must be an object", () => {
    expect(() => parseClaudeJson("null")).toThrow(/must be an object/);
  });

  it("字符串顶层 → must be an object", () => {
    expect(() => parseClaudeJson('"s"')).toThrow(/must be an object/);
  });

  it("条目非对象 → entry must be an object", () => {
    expect(() => parseClaudeJson('{"a":1}')).toThrow(/entry must be an object/);
  });

  it("条目为 null → entry must be an object", () => {
    expect(() => parseClaudeJson('{"a":null}')).toThrow(/entry must be an object/);
  });

  it("坏 JSON → SyntaxError", () => {
    expect(() => parseClaudeJson("{oops")).toThrow(SyntaxError);
  });
});

// B17：save 失败时 tmp 残留必须清理（唯一 tmp 名 + 失败清理） ----
describe("B17：save 失败时 tmp 残留必须清理", () => {
  function victimFixture() {
    const dir = tempDir();
    // rename 目标为已存在目录 → EISDIR，注入写入失败路径
    const victimPath = join(dir, "victim");
    mkdirSync(victimPath);
    const store = new McpStore(victimPath);
    store.data = {
      version: 1,
      servers: [{ name: "s1", transport: "stdio", command: "echo", enabled: true }],
    };
    return { victimPath, store };
  }

  it("save 失败应上抛", async () => {
    const { store } = victimFixture();
    await expect(store.save()).rejects.toThrow(/EISDIR|ENOTEMPTY|EEXIST|EPERM|ENOTDIR/);
  });

  it("B17：save 失败后真名 tmp 残留应清理（#903 M-store：旧断言查从未创建过的名字，空转）", async () => {
    const { victimPath, store } = victimFixture();
    const dir = victimPath.slice(0, victimPath.lastIndexOf("/"));
    await store.save().catch(() => {});
    // 真残留名前缀 = <path>.tmp.（pid.时间戳[.随机].tmp）：目录枚举断言，而非查固定名。
    const leftovers = readdirSync(dir).filter((name) => name.startsWith("victim.tmp."));
    expect(leftovers).toEqual([]);
  });
});

// #903 M-store/M3-store：串行 save + 同毫秒检出 + 写前冲突 fail-closed ----
describe("save 串行与冲突（#903）", () => {
  function twoStoresSamePath() {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "a", transport: "stdio", command: "echo" }] }),
    );
    return { dir, path };
  }

  it("同实例并发双 save 都成功且内容正确", async () => {
    const { path } = twoStoresSamePath();
    const store = new McpStore(path);
    await store.load();
    store.upsert({ name: "b", transport: "stdio", command: "x" });
    await Promise.all([store.save(), store.save()]);
    expect(
      JSON.parse(await readFile(path, "utf8"))
        .servers.map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("同毫秒改内容 → changedOnDisk true（全文快照第二道锁）", async () => {
    const { path } = twoStoresSamePath();
    const store = new McpStore(path);
    await store.load();
    const base = statSync(path);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "c", transport: "stdio", command: "y" }] }),
    );
    // 把 mtime 压回基线：纯 mtime 口径会漏检，快照必须兜住。
    utimesSync(path, base.atime, base.mtime);
    expect(await store.changedOnDisk()).toBe(true);
  });

  it("外部变更后 save fail-closed 抛错（不静默覆盖）", async () => {
    const { path } = twoStoresSamePath();
    const store = new McpStore(path);
    await store.load();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "ext", transport: "stdio", command: "z" }] }),
    );
    store.upsert({ name: "mine", transport: "stdio", command: "m" });
    await expect(store.save()).rejects.toThrow(/外部被修改/);
    // 外部内容原样保留：
    expect(JSON.parse(await readFile(path, "utf8")).servers[0].name).toBe("ext");
  });

  it("reload 后 save 不再冲突", async () => {
    const { path } = twoStoresSamePath();
    const store = new McpStore(path);
    await store.load();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "ext", transport: "stdio", command: "z" }] }),
    );
    await store.reloadIfChanged();
    store.upsert({ name: "mine", transport: "stdio", command: "m" });
    await store.save();
    expect(
      JSON.parse(await readFile(path, "utf8"))
        .servers.map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(["ext", "mine"]);
  });
});

// S2-b：save 取 mode 表 + 显式路径回落（既有文件内加判据，不新增文件） ----
describe("S2-b：save 取 mode 表 + 显式路径回落", () => {
  it("显式任意路径 save 照常写盘且 mode 0o600（锁住回落兼容）", async () => {
    const dir = tempDir();
    // 不在 mode 登记表的任意路径（用户 storePath 显式接管）：回落既有 0o600。
    const path = join(dir, "custom-arbitrary.json");
    const store = new McpStore(path);
    store.upsert({ name: "s", transport: "stdio", command: "echo" });
    await store.save();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).servers[0].name).toBe("s");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("项目级新形态路径 save 落 null 口径（file-io 层已覆盖 null 写面，此处只锁登记 + 落盘成功）", async () => {
    const { projectConfigFile, fileMode } = await import("../../src/server/shared/interface.ts");
    const dir = tempDir();
    const projPath = projectConfigFile(join(dir, "proj"));
    expect(fileMode(projPath)).toBeNull();
    const store = new McpStore(projPath);
    store.upsert({ name: "p", transport: "stdio", command: "echo" });
    await store.save();
    expect(existsSync(projPath)).toBe(true);
    expect(JSON.parse(await readFile(projPath, "utf8")).servers[0].name).toBe("p");
  });
});

// readCatalogServerFromDisk：目录注入端在中间层单元未建时的磁盘 last-good 兜底读。
// 覆盖定位守卫（载荷/entries 缺失或异形、未命中该名字）与条目形状清洗两条不同问题。
describe("readCatalogServerFromDisk", () => {
  const write = (dir: string, text: string): string => {
    const path = join(dir, "catalog.json");
    writeFileSync(path, text, "utf8");
    return path;
  };

  it("正常条目：discoveredAt 与工具清单原样取回", async () => {
    const path = write(
      tempDir(),
      JSON.stringify({
        entries: { alpha: { discoveredAt: 42, tools: [{ name: "t1", description: "d1" }] } },
      }),
    );
    const out = await readCatalogServerFromDisk(path, "alpha");
    expect(out).toEqual({
      discoveredAt: 42,
      tools: [{ name: "t1", description: "d1" }],
    });
  });

  it("未命中该服务器名 → undefined（同名不串）", async () => {
    const path = write(
      tempDir(),
      JSON.stringify({ entries: { alpha: { discoveredAt: 1, tools: [] } } }),
    );
    expect(await readCatalogServerFromDisk(path, "beta")).toBeUndefined();
  });

  it("entries 容器缺失或为 null → undefined（非对象不做键读取）", async () => {
    const dir = tempDir();
    for (const text of [
      "{}",
      JSON.stringify({ entries: null }),
      JSON.stringify({ entries: "not-a-table" }),
      "[]",
      "null",
    ]) {
      expect(await readCatalogServerFromDisk(write(dir, text), "alpha"), text).toBeUndefined();
    }
  });

  it("条目自身为 null / 标量 → undefined（命中名但非对象）", async () => {
    const dir = tempDir();
    for (const value of ["null", "5", '"str"']) {
      const path = write(dir, JSON.stringify({ entries: { alpha: JSON.parse(value) } }));
      expect(await readCatalogServerFromDisk(path, "alpha"), value).toBeUndefined();
    }
  });

  it("损坏 JSON 与文件缺失 → undefined（容错不抛）", async () => {
    const dir = tempDir();
    expect(await readCatalogServerFromDisk(write(dir, "{not json"), "alpha")).toBeUndefined();
    expect(await readCatalogServerFromDisk(join(dir, "nope.json"), "alpha")).toBeUndefined();
  });

  it("形状清洗：discoveredAt 非数字归 0、工具名非字符串跳过、描述缺失补空串", async () => {
    const path = write(
      tempDir(),
      JSON.stringify({
        entries: {
          alpha: {
            discoveredAt: "7",
            tools: [{ name: "ok" }, { description: "no-name" }, null, "s", { name: 3 }, 42],
          },
        },
      }),
    );
    const out = await readCatalogServerFromDisk(path, "alpha");
    expect(out?.discoveredAt).toBe(0);
    expect(out?.tools).toEqual([{ name: "ok", description: "" }]);
  });

  it("tools 非数组 → 空清单（不是 undefined）", async () => {
    const path = write(
      tempDir(),
      JSON.stringify({ entries: { alpha: { discoveredAt: 1, tools: null } } }),
    );
    expect(await readCatalogServerFromDisk(path, "alpha")).toEqual({
      discoveredAt: 1,
      tools: [],
    });
  });
});
