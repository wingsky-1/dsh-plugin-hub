/**
 * dsh-notifier upgrade 域 legacy reader：正式历史来源是 DSH home 的 settings.yaml 与
 * settings.yaml.imported；describe 与 V0 JSON 只作低优先级兜底。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_FILE_NAME,
  legacyFile,
  notifierFile,
} from "../../../src/server/shared/interface.ts";
import { readLegacySettings } from "../../../src/server/upgrade/impl/legacy/index.ts";
import { migrateConfigShape } from "../../../src/server/upgrade/impl/steps/config-shape.ts";
import type { LegacySettingsFace } from "../../../src/server/upgrade/impl/legacy/type.ts";
import { tempDshHome } from "../../helpers.ts";

/** 本插件 0.2.3 在旧官方 settings 文档里的命名空间。 */
const NS = "dsh-notifier";

type FakeDescriptor = { ns: string; user?: unknown };
type FakeDescribeOptions = { redactSecrets?: boolean };

let home: { readonly dir: string; dispose: () => void };

beforeEach(() => {
  home = tempDshHome();
});

afterEach(() => {
  home.dispose();
});

/** 假 settings 读面只提供 describe；正式文件由 DSH_HOME 下的真实路径读取。 */
function makeSettings(entries: readonly FakeDescriptor[], throws = false): LegacySettingsFace {
  return {
    describe: () => {
      if (throws) throw new Error("settings 服务拒绝了这次调用");
      return entries as unknown as ReturnType<LegacySettingsFace["describe"]>;
    },
  };
}

function writeSettingsDocument(text: string, name = "settings.yaml"): string {
  const path = join(home.dir, name);
  writeFileSync(path, text, "utf8");
  return path;
}

function writeLegacyFile(name: string, body: unknown): void {
  writeFileSync(legacyFile(name), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

describe("正式 legacy settings 来源", () => {
  it("只有 settings.yaml.imported 时也能读到旧 notifier 分节", () => {
    writeSettingsDocument(
      "dsh-notifier:\n  notifyAsk: false\n  notifyTaskDone: true\n",
      "settings.yaml.imported",
    );

    expect(readLegacySettings(makeSettings([]))).toEqual({
      notifyAsk: false,
      notifyTaskDone: true,
    });
  });

  it("settings.yaml 高于 imported；普通对象递归合并，数组与标量整体替换", () => {
    writeSettingsDocument(
      `dsh-notifier:
  notifyTaskDone: true
  nested:
    importedOnly: 7
    shared: imported
    items:
      - imported
  scalarConflict: imported
`,
      "settings.yaml.imported",
    );
    writeSettingsDocument(
      `dsh-notifier:
  notifyTaskDone: false
  nested:
    currentOnly: 8
    shared: current
    items:
      - current
  scalarConflict: current
`,
    );

    expect(readLegacySettings(makeSettings([]))).toEqual({
      notifyTaskDone: false,
      nested: {
        currentOnly: 8,
        importedOnly: 7,
        shared: "current",
        items: ["current"],
      },
      scalarConflict: "current",
    });
  });

  it("正式双文件整体高于 describe 与 V0 JSON", () => {
    writeSettingsDocument("dsh-notifier:\n  notifyAsk: false\n  customKey: official\n");
    writeLegacyFile("dsh-notifier.json", { notifyAsk: true, customKey: "v0" });
    const settings = makeSettings([{ ns: NS, user: { notifyAsk: true, customKey: "describe" } }]);

    expect(readLegacySettings(settings)).toEqual({ notifyAsk: false, customKey: "official" });
  });

  it.each(["settings.yaml", "settings.yaml.imported"])("%s 存在但 YAML 损坏时明确失败", (name) => {
    writeSettingsDocument("dsh-notifier:\n\tnotifyAsk: false\n", name);

    expect(() => readLegacySettings(makeSettings([]))).toThrow(
      new RegExp(name.replace(".", "\\.")),
    );
  });

  it.each(["settings.yaml", "settings.yaml.imported"])("%s 存在但不可读时明确失败", (name) => {
    mkdirSync(join(home.dir, name));

    expect(() => readLegacySettings(makeSettings([]))).toThrow(
      new RegExp(name.replace(".", "\\.")),
    );
  });

  it.each([
    ["just a scalar\n", /顶层不是普通对象/],
    ["dsh-notifier: scalar\n", /分节不是普通对象/],
    ["dsh-notifier: &self\n  notifyAsk: false\n  self: *self\n", /分节无法序列化/],
  ])("正式来源内容无效时明确失败：%s", (text, error) => {
    writeSettingsDocument(text);

    expect(() => readLegacySettings(makeSettings([]))).toThrow(error);
  });

  it("重复读取正式来源不改写源文件", () => {
    const path = writeSettingsDocument(
      "dsh-notifier:\n  notifyAsk: false\n",
      "settings.yaml.imported",
    );
    const before = readFileSync(path, "utf8");

    const first = readLegacySettings(makeSettings([]));
    const second = readLegacySettings(makeSettings([]));

    expect(first).toEqual({ notifyAsk: false });
    expect(second).toEqual(first);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("重复运行配置形态割接得到逐字相同的结果", () => {
    writeSettingsDocument(
      "dsh-notifier:\n  notifyAsk: true\n  notifyTaskDone: false\n",
      "settings.yaml.imported",
    );
    writeSettingsDocument("dsh-notifier:\n  notifyAsk: false\n");
    const configFile = notifierFile(CONFIG_FILE_NAME);

    migrateConfigShape(makeSettings([]));
    const first = readFileSync(configFile, "utf8");
    migrateConfigShape(makeSettings([]));
    const second = readFileSync(configFile, "utf8");

    expect(JSON.parse(first)).toMatchObject({ notifyAsk: false, notifyTaskDone: false });
    expect(second).toBe(first);
  });
});

describe("低优先级兜底：describe → V0 JSON", () => {
  it("正式来源没有 notifier 分节时使用 describe", () => {
    writeSettingsDocument("other-plugin:\n  value: 1\n");
    const settings = makeSettings([{ ns: NS, user: { notifyAsk: false } }]);

    expect(readLegacySettings(settings)).toEqual({ notifyAsk: false });
  });

  it("describe 高于 V0 JSON", () => {
    writeLegacyFile("dsh-notifier.json", { notifyAsk: true });
    const settings = makeSettings([{ ns: NS, user: { notifyAsk: false } }]);

    expect(readLegacySettings(settings)).toEqual({ notifyAsk: false });
  });

  it("describe 条目存在但 user 不是普通对象时回退 V0 JSON", () => {
    writeLegacyFile("dsh-notifier.json", { notifyAsk: true });
    for (const user of [["notifyAsk"], "notifyAsk", 42, null]) {
      expect(readLegacySettings(makeSettings([{ ns: NS, user }]))).toEqual({ notifyAsk: true });
    }
  });

  it("读 describe 时要求脱敏", () => {
    const calls: Array<FakeDescribeOptions | undefined> = [];
    const settings: LegacySettingsFace = {
      describe: (options) => {
        calls.push(options);
        return [{ ns: NS, user: { notifyAsk: false } }] as unknown as ReturnType<
          LegacySettingsFace["describe"]
        >;
      },
    };

    expect(readLegacySettings(settings)).toEqual({ notifyAsk: false });
    expect(calls).toEqual([{ redactSecrets: true }]);
  });

  it("describe 调用抛错时回退 V0 JSON", () => {
    writeLegacyFile("dsh-notifier.json", { notifyAsk: true });

    expect(readLegacySettings(makeSettings([], true))).toEqual({ notifyAsk: true });
  });

  it("运行时额外 documentPath getter 被读取就抛，reader 不回退旧路径", () => {
    const settings = {
      describe: () =>
        [{ ns: NS, user: { notifyAsk: false } }] as unknown as ReturnType<
          LegacySettingsFace["describe"]
        >,
      get documentPath(): string {
        throw new Error("documentPath 不得被读取");
      },
    };

    expect(readLegacySettings(settings)).toEqual({ notifyAsk: false });
  });

  it("V0 的第二个候选名在 json 缺失时生效", () => {
    writeLegacyFile("dsh-notifier.json.migrated.bak", { notifyAsk: false });

    expect(readLegacySettings(makeSettings([]))).toEqual({ notifyAsk: false });
  });

  it("V0 JSON 损坏时明确失败并保留原文件", () => {
    writeLegacyFile("dsh-notifier.json", "{ 这不是 JSON");

    expect(() => readLegacySettings(makeSettings([]))).toThrow(/JSON 解析失败/);
    expect(existsSync(legacyFile("dsh-notifier.json"))).toBe(true);
  });

  it("V0 JSON 顶层不是普通对象时明确失败", () => {
    writeLegacyFile("dsh-notifier.json", [1, 2]);

    expect(() => readLegacySettings(makeSettings([]))).toThrow(/顶层不是普通对象/);
  });

  it("所有来源都不存在时返回空对象", () => {
    expect(readLegacySettings(makeSettings([]))).toEqual({});
  });
});

describe("旧键语义转换与安全边界", () => {
  it("正式来源剔除装配键并把旧全局音效键摊到两个出口", () => {
    writeSettingsDocument(
      "dsh-notifier:\n  enabled: true\n  configFile: /legacy/config.json\n  notifySound: false\n  notifyTaskDone: false\n",
    );

    expect(readLegacySettings(makeSettings([]))).toEqual({
      notifySound: false,
      notifyTaskDone: false,
      browserSound: false,
      systemSound: false,
    });
  });

  it("出口键已有值时不被旧全局声音键覆盖", () => {
    writeSettingsDocument(
      "dsh-notifier:\n  notifySound: true\n  browserSound: false\n",
      "settings.yaml.imported",
    );
    writeSettingsDocument("dsh-notifier:\n  browserSound: false\n");

    const legacy = readLegacySettings(makeSettings([]));
    expect(legacy.browserSound).toBe(false);
    expect(legacy.systemSound).toBe(true);
  });

  it("契约不认识的键原样保留", () => {
    writeSettingsDocument("dsh-notifier:\n  customKey: 42\n  notifyAsk: true\n");

    const legacy = readLegacySettings(makeSettings([]));
    expect(legacy.customKey).toBe(42);
    expect(legacy.notifyAsk).toBe(true);
  });

  it("原型链上的危险键名不搬运", () => {
    writeSettingsDocument(
      `{"dsh-notifier":{"notifyAsk":true,"__proto__":{"polluted":true},"constructor":"x","prototype":"y"}}`,
    );

    const out = readLegacySettings(makeSettings([]));
    expect(out).toEqual({ notifyAsk: true });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});
