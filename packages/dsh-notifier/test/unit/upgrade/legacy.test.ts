/**
 * dsh-notifier upgrade 域 legacy 块 —— 存量设置的读取（V1：宿主 settings 文档 / 服务面，V0：自建 JSON 文件）。
 *
 * 判据面：这一块决定升级后用户看到的是**哪一份设置**。取错顺序（V0 盖 V1）或漏做语义转换的表现都是
 * 「升级后设置回到了更早的样子」，而磁盘上一切正常、没有任何报错。故这里逐条锁优先级与转换规则。
 *
 * 一条专门的判据面：**未注册命名空间也要读得到**（`describe()` 只列已注册的，而本插件不再注册它）。
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** 假 settings 读面：`describe` 给固定条目（或按需抛错），`documentPath` 指向宿主文档（缺省 = provider 没有文件）。 */
function makeSettings(
  entries: readonly FakeDescriptor[],
  throws = false,
  documentPath?: string,
): LegacySettingsFace {
  return {
    describe: () => {
      if (throws) throw new Error("settings 服务拒绝了这次调用");
      return entries as unknown as ReturnType<LegacySettingsFace["describe"]>;
    },
    documentPath,
  };
}

/** 写一份宿主 settings 文档（默认 YAML 形态，与官方文件型 provider 一致）。 */
function writeDocument(text: string, name = "settings.yaml"): string {
  const path = join(home.dir, name);
  writeFileSync(path, text, "utf8");
  return path;
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

  it("读服务面时要求脱敏（脱敏开关只管服务面出口；文档那条路拿到的本来就是原文）", () => {
    const calls: Array<FakeDescribeOptions | undefined> = [];
    const settings: LegacySettingsFace = {
      describe: (options) => {
        calls.push(options);
        return [{ ns: NS, user: { notifyAsk: false } }] as unknown as ReturnType<
          LegacySettingsFace["describe"]
        >;
      },
      documentPath: undefined,
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

describe("宿主文档文件：未注册命名空间的存量也读得到", () => {
  it("describe 里没有本插件命名空间（新架构不注册它）时，文档里的分节照样读出来", () => {
    const doc = writeDocument("dsh-notifier:\n  notifyTaskDone: false\n");
    // 这正是本块存在的理由：服务面只列已注册的命名空间，文档那条路必须自己把存量读出来。
    expect(readLegacySettings(makeSettings([], false, doc))).toEqual({ notifyTaskDone: false });
  });

  it("provider 没自报路径时按 DSH home 下的 settings.yaml 兜底", () => {
    // 路径由夹具自己拼（不走实现的任何 helper）：兜底名与兜底位置都得被独立钉住。
    writeDocument("dsh-notifier:\n  customKey: 42\n", "settings.yaml");
    expect(readLegacySettings(makeSettings([]))).toEqual({ customKey: 42 });
  });

  it("文档是 JSON 时同样能读（官方 provider 支持 .json 扩展名）", () => {
    writeDocument(`{"${NS}":{"notifyAsk":true}}`, "settings.json");
    expect(readLegacySettings(makeSettings([]))).toEqual({ notifyAsk: true });
  });

  it("`.json` 判定按扩展名而不是「碰巧 YAML 也读得动」", () => {
    // 重复键：YAML 解析器直接抛错，`JSON.parse` 取后者——只有真的走了 JSON 那条分支才读得出来。
    writeDocument(`{"${NS}":{"notifyAsk":true},"${NS}":{"notifyAsk":false}}`, "settings.json");
    expect(readLegacySettings(makeSettings([]))).toEqual({ notifyAsk: false });
  });

  it("provider 取文档路径就抛错时按没有文件处理（与服务面同形的失败处理）", () => {
    const settings: LegacySettingsFace = {
      describe: () =>
        [{ ns: NS, user: { notifyAsk: true } }] as unknown as ReturnType<
          LegacySettingsFace["describe"]
        >,
      get documentPath(): string | undefined {
        throw new Error("provider 取文档路径失败");
      },
    };
    expect(readLegacySettings(settings)).toEqual({ notifyAsk: true });
  });

  it("循环引用的分节按读不动处理（割接要把它序列化进 config.json）", () => {
    // YAML 别名可以自指：这样的分节落盘时会让 `JSON.stringify` 抛错，读的时候就得当它读不动、回退下一环。
    const doc = writeDocument("dsh-notifier: &self\n  notifyTaskDone: false\n  self: *self\n");
    expect(
      readLegacySettings(makeSettings([{ ns: NS, user: { notifyAsk: true } }], false, doc)),
    ).toEqual({ notifyAsk: true });
    expect(readLegacySettings(makeSettings([], false, doc))).toEqual({});
  });

  it("文档与服务面都有时以文档为准（它是用户提交的原始层，服务面给的是解析值）", () => {
    const doc = writeDocument("dsh-notifier:\n  notifyAsk: false\n");
    const settings = makeSettings([{ ns: NS, user: { notifyAsk: true } }], false, doc);
    expect(readLegacySettings(settings)).toEqual({ notifyAsk: false });
  });

  it("文档解释不了时回退服务面，服务面也读不到时回退 V0（坏文件、缺分节、分节不是对象都不能把存量吃掉）", () => {
    writeLegacyFile("dsh-notifier.json", { notifyAsk: false });
    const broken = [
      "dsh-notifier:\n\tnotifyAsk: false\n",
      "other-plugin:\n  notifyAsk: false\n",
      'dsh-notifier: "不是对象"\n',
    ];
    for (const [index, text] of broken.entries()) {
      const doc = writeDocument(text, `broken-${index}.yaml`);
      expect(
        readLegacySettings(makeSettings([{ ns: NS, user: { notifyAsk: true } }], false, doc)),
      ).toEqual({ notifyAsk: true });
      // 服务面也给不出东西时，这一环同样不能把 V0 吃掉。
      expect(readLegacySettings(makeSettings([], false, doc))).toEqual({ notifyAsk: false });
    }
  });

  it("两个候选文件同时存在时 `.yaml` 优先（官方缺省名在前）", () => {
    writeDocument("dsh-notifier:\n  notifyAsk: false\n", "settings.yaml");
    writeDocument(`{"${NS}":{"notifyAsk":true}}`, "settings.json");
    expect(readLegacySettings(makeSettings([]))).toEqual({ notifyAsk: false });
  });

  it("documentPath 是空白串时按「没给出路径」处理，回到 DSH home 兜底", () => {
    writeDocument("dsh-notifier:\n  notifyAsk: false\n", "settings.yaml");
    for (const blank of ["", "   ", "\t"]) {
      expect(readLegacySettings(makeSettings([], false, blank))).toEqual({ notifyAsk: false });
    }
  });

  it("自报的路径指向不存在的文件时只回退服务面，不拿缺省名去猜（用户配过自定义路径）", () => {
    writeDocument("dsh-notifier:\n  notifyAsk: false\n", "settings.yaml");
    const missing = join(home.dir, "custom", "settings.yaml");
    expect(readLegacySettings(makeSettings([], false, missing))).toEqual({});
    expect(
      readLegacySettings(makeSettings([{ ns: NS, user: { notifyAsk: true } }], false, missing)),
    ).toEqual({ notifyAsk: true });
  });

  it("`.yml` 扩展名的文档按 YAML 解析（provider 支持它，只是缺省名是 yaml）", () => {
    const doc = writeDocument("dsh-notifier:\n  notifyAsk: false\n", "settings.yml");
    expect(readLegacySettings(makeSettings([], false, doc))).toEqual({ notifyAsk: false });
  });

  it("原型链上的危险键名不搬运（与 config 域写面同一份口径）", () => {
    const doc = writeDocument(
      `{"${NS}":{"notifyAsk":true,"__proto__":{"polluted":true},"constructor":"x","prototype":"y"}}`,
      "settings.json",
    );
    const out = readLegacySettings(makeSettings([], false, doc));
    expect(out).toEqual({ notifyAsk: true });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("文档来源同样做语义转换：装配键剔除、旧全局音效键摊到两个出口", () => {
    const doc = writeDocument(
      "dsh-notifier:\n  enabled: true\n  configFile: /legacy/config.json\n  notifySound: false\n  notifyTaskDone: false\n",
    );
    expect(readLegacySettings(makeSettings([], false, doc))).toEqual({
      notifySound: false,
      notifyTaskDone: false,
      browserSound: false,
      systemSound: false,
    });
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
