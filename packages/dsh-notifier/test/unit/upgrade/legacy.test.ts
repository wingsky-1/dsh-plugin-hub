/**
 * dsh-notifier upgrade 域 legacy 块 —— 存量设置的读取（V1：官方 settings 命名空间 / V0：自建 JSON 文件）。
 *
 * 判据面：这一块决定升级后用户看到的是**哪一份设置**。取错顺序（V0 盖 V1）或漏做语义转换的表现都是
 * 「升级后设置回到了更早的样子」，而磁盘上一切正常、没有任何报错。故这里逐条锁优先级与转换规则。
 */
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { legacyFile } from "../../../src/server/shared/interface.ts";
import { readLegacySettings } from "../../../src/server/upgrade/impl/legacy/index.ts";
import type { LegacySettingsFace } from "../../../src/server/upgrade/impl/legacy/type.ts";
import { tempDshHome, wire } from "../../helpers.ts";

/** 本插件 0.2.3 在官方 settings 服务里用的命名空间。 */
const NS = "dsh-notifier";

/**
 * 假描述符：本域只读 `ns` 与 `user` 两项，官方描述符的其余字段（schema / revision / applies）
 * 与判据无关，也就没必要在这里拼出来——拼一份假的反倒成了第二个事实源。
 */
type FakeDescriptor = { ns: string; user?: unknown };

/** settings 的描述选项：只关心脱敏开关，其余键不参与判据。 */
type FakeDescribeOptions = { redactSecrets?: boolean };

let home: { readonly dir: string; dispose: () => void };

beforeEach(() => {
  home = tempDshHome();
});

afterEach(() => {
  home.dispose();
});

/** 假 settings 读面：`describe` 给固定条目，或按需抛错（服务在但调用失败）。 */
function makeSettings(entries: readonly FakeDescriptor[], throws = false): LegacySettingsFace {
  return {
    describe: () => {
      if (throws) throw new Error("settings 服务拒绝了这次调用");
      return entries as unknown as ReturnType<LegacySettingsFace["describe"]>;
    },
  };
}

/** 写一份 V0 配置文件（旧的自建 JSON）。 */
function writeLegacyFile(name: string, body: unknown): void {
  writeFileSync(legacyFile(name), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

describe("读取优先级：V1 优先，V0 兜底", () => {
  it("settings 里有本插件命名空间时无视 V0 文件（反过来取会让设置回到更早的样子）", () => {
    writeLegacyFile("dsh-notifier.json", { notifyAsk: true });
    const settings = makeSettings([{ ns: NS, user: { notifyAsk: false } }]);
    expect(readLegacySettings(settings)).toEqual({ notifyAsk: false });
  });

  it("settings 里没有本插件命名空间时回退 V0 文件", () => {
    writeLegacyFile("dsh-notifier.json", { notifyAsk: true });
    const settings = makeSettings([{ ns: "other-plugin", user: { notifyAsk: false } }]);
    expect(readLegacySettings(settings)).toEqual({ notifyAsk: true });
  });

  it("V1 条目存在但 user 不是对象时同样回退 V0 文件（脏条目不能把存量配置吃掉）", () => {
    writeLegacyFile("dsh-notifier.json", { notifyAsk: true });
    // 数组只是脏的一种：标量（typeof 不是 object）与 null（typeof 是 object 但取键会抛）都要挡住。
    for (const user of [["notifyAsk"], "notifyAsk", 42, wire<FakeDescriptor["user"]>(null)]) {
      expect(readLegacySettings(makeSettings([{ ns: NS, user }]))).toEqual({ notifyAsk: true });
    }
  });

  it("读存量设置时要求脱敏（不要求脱敏会把密钥类设置读进内存并原样搬进新配置）", () => {
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

  it("settings 调用抛错时回退 V0 文件（服务在但拒绝这次调用，不该拦住插件启动）", () => {
    writeLegacyFile("dsh-notifier.json", { notifyAsk: true });
    expect(readLegacySettings(makeSettings([], true))).toEqual({ notifyAsk: true });
  });

  it("V0 的第二个候选名在 json 缺失时生效（0.2.3 迁移把 json 改名成 .migrated.bak，内容逐字相同）", () => {
    writeLegacyFile("dsh-notifier.json.migrated.bak", { notifyAsk: false });
    expect(readLegacySettings(makeSettings([]))).toEqual({ notifyAsk: false });
  });

  it("V0 文件损坏时给空对象并原地保留文件（用户可能还想手工看看里面是什么）", () => {
    writeLegacyFile("dsh-notifier.json", "{ 这不是 JSON");
    expect(readLegacySettings(makeSettings([]))).toEqual({});
    expect(existsSync(legacyFile("dsh-notifier.json"))).toBe(true);
  });

  // 合法 JSON 但不是对象：数组/标量都能被 Object.keys 读出一堆下标键，认下来就等于往配置里
  // 灌进用户从没设过的键——所以两个候选名都要按「解释不了」处理。
  it("V0 文件是合法 JSON 但不是对象时两个候选都不认（数组/标量会读出一堆假键）", () => {
    writeLegacyFile("dsh-notifier.json", [1, 2]);
    writeLegacyFile("dsh-notifier.json.migrated.bak", '"这不是对象"');

    expect(readLegacySettings(makeSettings([]))).toEqual({});
  });

  it("两份来源都没有时给空对象（它就是「没有可迁的东西」的答案）", () => {
    expect(readLegacySettings(makeSettings([]))).toEqual({});
  });
});

describe("语义转换：旧键 → 当前键", () => {
  it("剔掉装配键（新架构下它们是启动参数，留在配置里会被读成用户显式设置过的值）", () => {
    const legacy = readLegacySettings(
      makeSettings([
        {
          ns: NS,
          user: {
            enabled: true,
            configFile: "/tmp/config.json",
            historyFile: "/tmp/history.jsonl",
            statusFile: "/tmp/status.json",
            toastScript: "/tmp/toast.ps1",
            notifyAsk: false,
          },
        },
      ]),
    );
    expect(Object.keys(legacy)).toEqual(["notifyAsk"]);
    expect(legacy.notifyAsk).toBe(false);
  });

  it("旧的全局声音开关摊到两个出口键上（用户原来的选择不作废）", () => {
    const legacy = readLegacySettings(makeSettings([{ ns: NS, user: { notifySound: false } }]));
    expect(legacy.browserSound).toBe(false);
    expect(legacy.systemSound).toBe(false);
  });

  it("出口键已有值时不被旧键覆盖（新架构下用户已经分别选过）", () => {
    const legacy = readLegacySettings(
      makeSettings([{ ns: NS, user: { notifySound: true, browserSound: false } }]),
    );
    expect(legacy.browserSound).toBe(false);
    expect(legacy.systemSound).toBe(true);
  });

  it("契约不认识的键原样保留（可能是用户手写的或更高版本留下的，迁移没资格替他们决定丢哪些）", () => {
    const legacy = readLegacySettings(
      makeSettings([{ ns: NS, user: { customKey: 42, notifyAsk: true } }]),
    );
    expect(legacy.customKey).toBe(42);
    expect(legacy.notifyAsk).toBe(true);
  });
});
