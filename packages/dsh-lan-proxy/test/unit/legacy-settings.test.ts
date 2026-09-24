/**
 * legacy settings migration：从官方 settings 文档的旧 namespace 收编到 canonical scope。
 *
 * 这些用例只观察独立 step 的公开结果与磁盘 marker；fixture 不模拟实现内部的合并函数。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_SETTINGS_NS,
  SETTINGS_MIGRATION_MARKER_NAME,
  migrateLegacySettings,
  readLegacySettings,
} from "../../src/server/migrate/impl/legacy-settings/index.ts";

type Scope = {
  readonly updates: Record<string, unknown>[];
  update(patch: object): Promise<void>;
};

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-legacy-settings-"));
  roots.push(root);
  return root;
}

function makeScope(
  initial: Record<string, unknown> = {},
): Scope & { user: Record<string, unknown> } {
  const scope = {
    user: { ...initial },
    updates: [] as Record<string, unknown>[],
    async update(patch: object): Promise<void> {
      const copy = JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;
      scope.updates.push(copy);
      scope.user = { ...scope.user, ...copy };
    },
  };
  return scope;
}

function writeDocument(
  root: string,
  name: string,
  section: Record<string, unknown> | string,
): void {
  const text =
    typeof section === "string" ? section : JSON.stringify({ [LEGACY_SETTINGS_NS]: section });
  writeFileSync(join(root, name), text, "utf8");
}

function marker(root: string): string {
  return join(root, "plugin", SETTINGS_MIGRATION_MARKER_NAME);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy settings reader", () => {
  it("settings.yaml 是唯一来源时读取旧 namespace", () => {
    const home = tempRoot();
    writeDocument(home, "settings.yaml", { port: 4101, enabled: false });

    const result = readLegacySettings({ home });

    expect(result.ok).toBe(true);
    expect(result.hasSection).toBe(true);
    expect(result.values).toEqual({ port: 4101, enabled: false });
  });

  it("settings.yaml.imported 是唯一来源时读取旧 namespace", () => {
    const home = tempRoot();
    writeDocument(home, "settings.yaml.imported", { port: 4102, printBanner: false });

    const result = readLegacySettings({ home });

    expect(result.ok).toBe(true);
    expect(result.hasSection).toBe(true);
    expect(result.values).toEqual({ port: 4102, printBanner: false });
  });

  it("递归合并嵌套 plain object，数组与标量由 settings.yaml 整体替换", () => {
    const home = tempRoot();
    writeDocument(home, "settings.yaml.imported", {
      port: 4000,
      enabled: true,
      wsCompressPaths: ["/imported"],
      wsDeflatePolicy: { browser: false, uaDeny: ["/imported"] },
    });
    writeDocument(home, "settings.yaml", {
      port: 4200,
      enabled: false,
      wsCompressPaths: ["/settings"],
      wsDeflatePolicy: { browser: true },
    });

    const result = readLegacySettings({ home });

    expect(result.ok).toBe(true);
    expect(result.values).toEqual({
      port: 4200,
      enabled: false,
      wsCompressPaths: ["/settings"],
      wsDeflatePolicy: { browser: true, uaDeny: ["/imported"] },
    });
  });

  it("递归结果深 clone，并用 null prototype 隔离 __proto__", () => {
    const home = tempRoot();
    writeDocument(
      home,
      "settings.yaml",
      '{"dsh-lan-proxy":{"wsDeflatePolicy":{"__proto__":{"polluted":true}}}}',
    );

    const result = readLegacySettings({ home });
    const policy = result.values.wsDeflatePolicy;
    const source = result.documents.find((document) => document.name === "settings.yaml")?.values
      .wsDeflatePolicy;
    const clonedChild = Object.getOwnPropertyDescriptor(policy, "__proto__")?.value;
    const sourceChild = Object.getOwnPropertyDescriptor(source, "__proto__")?.value;

    expect(result.ok).toBe(true);
    expect(Object.getPrototypeOf(result.values)).toBe(null);
    expect(Object.getPrototypeOf(policy)).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(policy, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(clonedChild)).toBe(null);
    expect(clonedChild).not.toBe(sourceChild);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("legacy settings migration", () => {
  it("两源按字段合并，settings.yaml 覆盖 imported 的冲突字段", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", {
      port: 4200,
      enabled: false,
      wsCompressPaths: ["/from-settings"],
    });
    writeDocument(home, "settings.yaml.imported", {
      port: 4000,
      host: "127.0.0.2",
      wsCompressPaths: ["/from-imported", "/kept-only-by-imported"],
    });
    const scope = makeScope();

    const result = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });

    expect(result.status).toBe("migrated");
    expect(scope.updates).toEqual([
      {
        port: 4200,
        host: "127.0.0.2",
        enabled: false,
        wsCompressPaths: ["/from-settings"],
      },
    ]);
    expect(existsSync(marker(home))).toBe(true);
  });

  it("当前嵌套 user 只补缺失子键，不覆盖已有值", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", {
      wsDeflatePolicy: { browser: false, uaDeny: ["/old"] },
      wsCompressPaths: ["/old"],
    });
    const scope = makeScope({ wsDeflatePolicy: { browser: true }, wsCompressPaths: [] });

    const result = await migrateLegacySettings({
      home,
      configDir,
      currentUser: {
        wsDeflatePolicy: { browser: true },
        wsCompressPaths: [],
      },
      scope,
    });

    expect(result.status).toBe("migrated");
    expect(scope.updates).toEqual([{ wsDeflatePolicy: { uaDeny: ["/old"] } }]);
    expect(scope.user.wsCompressPaths).toEqual([]);
  });

  it.each([
    ["null", null],
    ["空数组", []],
    ["空对象", {}],
  ])("当前嵌套 user 的%s阻断旧子键补写", async (_label, currentPolicy) => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", {
      wsDeflatePolicy: { browser: false, uaDeny: ["/old"] },
      wsCompressPaths: ["/old"],
    });
    const scope = makeScope();
    const currentUser = { wsDeflatePolicy: currentPolicy, wsCompressPaths: [] };

    const result = await migrateLegacySettings({ home, configDir, currentUser, scope });

    expect(result.status).toBe("migrated");
    expect(result.migrated).toBe(false);
    expect(scope.updates).toEqual([{}]);
    expect(currentUser).toEqual({ wsDeflatePolicy: currentPolicy, wsCompressPaths: [] });
  });

  it("嵌套字段类型非法时失败且不写完成 marker", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", { wsDeflatePolicy: ["not", "an", "object"] });
    const scope = makeScope();

    const result = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });

    expect(result.status).toBe("failed");
    expect(result.completed).toBe(false);
    expect(scope.updates).toEqual([]);
    expect(existsSync(marker(home))).toBe(false);
  });

  it("YAML 别名形成循环对象时失败且不写完成 marker", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(
      home,
      "settings.yaml",
      "dsh-lan-proxy:\n  wsDeflatePolicy: &policy\n    browser: false\n    self: *policy\n",
    );
    const scope = makeScope();

    const result = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });

    expect(result.status).toBe("failed");
    expect(result.completed).toBe(false);
    expect(scope.updates).toEqual([]);
    expect(existsSync(marker(home))).toBe(false);
  });

  it("完成 marker 写入失败时返回失败且保留可重试状态", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin-file");
    writeFileSync(configDir, "not a directory", "utf8");
    writeDocument(home, "settings.yaml", { port: 4800 });
    const scope = makeScope();

    const result = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });

    expect(result.status).toBe("failed");
    expect(result.completed).toBe(false);
    expect(scope.updates).toEqual([{ port: 4800 }]);
    expect(existsSync(configDir)).toBe(true);
  });

  it("当前 canonical user 的值和数组整体优先，旧源只补缺失字段", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", {
      port: 4200,
      wsCompressPaths: ["/old"],
      tlsCertFile: "/legacy-cert",
    });
    const scope = makeScope({ port: 4300, wsCompressPaths: [] });

    const result = await migrateLegacySettings({
      home,
      configDir,
      currentUser: { port: 4300, wsCompressPaths: [], tlsCertFile: null },
      scope,
    });

    expect(result.status).toBe("migrated");
    // null 是用户层的显式决定：旧源不得把已清除的可选键写回来。
    expect(scope.updates).toEqual([{}]);
    expect(scope.user.port).toBe(4300);
    expect(scope.user.wsCompressPaths).toEqual([]);
    expect(scope.user.tlsCertFile).toBeUndefined();
  });

  it("currentUser 保持 raw 契约，不清洗也不改写", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", { port: 4200, enabled: false });
    const scope = makeScope();
    const currentUser = Object.freeze({ port: "raw-user-value", unknown: Object.freeze(["raw"]) });

    const result = await migrateLegacySettings({ home, configDir, currentUser, scope });

    expect(result.status).toBe("migrated");
    expect(result.migrated).toBe(true);
    expect(scope.updates).toEqual([{ enabled: false }]);
    expect(currentUser).toEqual({ port: "raw-user-value", unknown: ["raw"] });
  });

  it("读到的文件解析失败时不写 canonical scope，也不写完成 marker", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeFileSync(join(home, "settings.yaml"), "dsh-lan-proxy: [", "utf8");
    const scope = makeScope();

    const result = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });

    expect(result.status).toBe("failed");
    expect(result.completed).toBe(false);
    expect(scope.updates).toEqual([]);
    expect(existsSync(marker(home))).toBe(false);
  });

  it("存在的 settings.yaml 不可读时不把它当空文档成功", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    mkdirSync(join(home, "settings.yaml"));
    const scope = makeScope();

    const result = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });

    expect(result.status).toBe("failed");
    expect(result.completed).toBe(false);
    expect(scope.updates).toEqual([]);
    expect(existsSync(marker(home))).toBe(false);
  });

  it("写入失败不写 marker，下一次重试可成功完成", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", { port: 4400 });
    let attempts = 0;
    const scope = {
      updates: [] as Record<string, unknown>[],
      async update(patch: object): Promise<void> {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary settings failure");
        this.updates.push(patch as Record<string, unknown>);
      },
    };

    const first = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });
    expect(first.status).toBe("failed");
    expect(existsSync(marker(home))).toBe(false);

    const second = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });
    expect(second.status).toBe("migrated");
    expect(scope.updates).toEqual([{ port: 4400 }]);
    expect(existsSync(marker(home))).toBe(true);
  });

  it("完成后用户改值并重启，旧源不会复活已清除的字段", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", {
      port: 4500,
      tlsCertFile: "/legacy-cert",
    });
    const scope = makeScope();
    const first = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });
    expect(first.status).toBe("migrated");

    scope.user = { port: 4600 };
    const second = await migrateLegacySettings({
      home,
      configDir,
      currentUser: scope.user,
      scope,
    });

    expect(second.status).toBe("already-complete");
    expect(scope.updates).toHaveLength(1);
    expect(scope.user).toEqual({ port: 4600 });
  });

  it("没有旧 section 时不写 marker，后续出现 imported 仍可消费", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    const scope = makeScope();

    const first = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });
    expect(first.status).toBe("skipped");
    expect(first.completed).toBe(false);
    expect(scope.updates).toEqual([]);
    expect(existsSync(marker(home))).toBe(false);

    writeDocument(home, "settings.yaml.imported", { port: 4700 });
    const second = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });

    expect(second.status).toBe("migrated");
    expect(scope.updates).toEqual([{ port: 4700 }]);
    expect(existsSync(marker(home))).toBe(true);
  });

  it("只有旧 section 的空对象也完成一次空 patch，随后 marker 阻断重跑", async () => {
    const home = tempRoot();
    const configDir = join(home, "plugin");
    mkdirSync(configDir);
    writeDocument(home, "settings.yaml", {});
    const scope = makeScope();

    const first = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });
    const second = await migrateLegacySettings({ home, configDir, currentUser: {}, scope });

    expect(first.status).toBe("migrated");
    expect(first.migrated).toBe(false);
    expect(scope.updates).toEqual([{}]);
    expect(second.status).toBe("already-complete");
    expect(readFileSync(marker(home), "utf8")).toContain("1");
  });
});
