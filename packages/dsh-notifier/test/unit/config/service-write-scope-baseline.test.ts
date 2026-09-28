/**
 * dsh-notifier config 域 service 块 —— 写面**基线取哪一份**（#1016 批次 B 使能面）。
 *
 * 单独一个文件而不是并进 service.test.ts：这里要 `vi.mock` 掉 input 模块、拦截写面
 * 真的传进去的基线参数，而 mock 是**整文件**生效的——并进去会让同文件的其它用例也拿到桩件，
 * 等于把一整块既有判据改成「在桩件下跑」。这里把面隔开，代价是复制一小段夹具。
 *
 * 要钉死的不变量只有一条：**写面判定用的存量基线，必须是客户端实际看过的那份视图**，
 * 而不是磁盘原样（`this.user.channels`），也不是没剥过空串的裸 effective。
 *
 * 形态层面的判据在 test/integration/config-write-scope-roundtrip.test.ts（真实往返链）；
 * 这里钉的是**服务实现确实交出了那份基线**——上一条判据管「该取哪份」，这条管「真的取了」。
 * 两条缺一不可：基线取错时写面唯一能观察到的结论（400 / 落盘）一个字都不变，
 * 光靠行为面看不出来。
 *
 * 导入顺序纪律同 service.test.ts：`configStore` 是模块级单例，落盘路径在构造时定死，
 * 必须先建临时 home 再动态导入被测模块。mock 在 `vi.mock` 处提升，动态导入发生在其后，
 * 故桩件对被测模块生效。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeLogger, tempDshHome } from "../../helpers.ts";
import type {
  RawSettingValue,
  StoredSettings,
} from "../../../src/server/config/impl/model/type.ts";

/** 写面每次调用 validateSettingsWithBase 时传进来的基线；按调用次序留存。 */
const baselineCalls: Array<unknown> = [];

vi.mock("../../../src/server/config/impl/input/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/server/config/impl/input/index.ts")>();
  return {
    ...actual,
    validateSettingsWithBase: (raw: unknown, base?: unknown) => {
      baselineCalls.push(base);
      return actual.validateSettingsWithBase(
        raw as Parameters<typeof actual.validateSettingsWithBase>[0],
        base as Parameters<typeof actual.validateSettingsWithBase>[1],
      );
    },
  };
});

const home = tempDshHome();
const { CONFIG_FILE_NAME, notifierFile } = await import("../../../src/server/shared/interface.ts");
const { normalizeConfig } = await import("../../../src/server/config/impl/input/index.ts");
const { canonicalChannelsForCompare } = await import("../../../src/shared/interface.ts");
const configFile = notifierFile(CONFIG_FILE_NAME);
const { installConfig, releaseConfig, writeConfig } =
  await import("../../../src/server/config/interface.ts");

/** 提交/基线里的单条频道：存储层形状不受契约约束，故按原始值看（与 service.test.ts 同口径）。 */
type Channel = Record<string, RawSettingValue>;

/** 手写配置文件：模拟用户或别的工具改过磁盘上那一份。 */
function writeConfigFile(text: string): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, text);
}

/** 客户端交回的一份提交：内置两条 + 指定频道（只带 name 改动）。 */
function submitWith(channels: Channel[]): { channels: Channel[] } {
  return {
    channels: [
      {
        type: "browser",
        id: "browser",
        enabled: true,
        popup: true,
        sound: false,
        whenVisible: false,
      },
      { type: "system", id: "system", enabled: false, popup: false, sound: false },
      ...channels,
    ],
  };
}

/** 最近一次调用传进来的基线（按频道数组读）。 */
function capturedBase(): Channel[] {
  const last = baselineCalls.at(-1);
  if (!Array.isArray(last))
    throw new Error("写面没有以频道数组作基线（调用记录：" + baselineCalls.length + "）");
  return last as Channel[];
}

beforeEach(() => {
  baselineCalls.length = 0;
  rmSync(configFile, { force: true });
});

afterEach(() => {
  releaseConfig();
});

afterAll(() => {
  home.dispose();
});

describe("写面基线：取客户端看过的那份视图（#1016 批次 B）", () => {
  // 判别力最强的一条：基线里**没有**半坏条目。
  // 基线取磁盘原样（this.user.channels）时它在场——那条正是本机制的过度拒绝来源
  // （用户在界面上看得见它、真实客户端却不会把它带回来，判据无从问起）。
  // 归一化视图里它不存在，于是两侧同时缺席，天然不参与比较。
  it("半坏条目（baseUrl 为空）在基线里不在场：基线不是磁盘原样", async () => {
    const disk = {
      channels: [
        { type: "bark", id: "bark:1", baseUrl: "https://api.day.app", deviceKey: "key-1" },
        { type: "bark", id: "bark:half", baseUrl: "", deviceKey: "key-half" },
      ],
    };
    writeConfigFile(JSON.stringify(disk));
    installConfig({ logger: makeLogger() });
    // 前提事实：磁盘上有它，而客户端收到的那份（生效设置）里没有。
    expect(JSON.parse(JSON.stringify(disk)).channels.length).toBe(2);
    expect(normalizeConfig(disk).channels.some((item) => item.id === "bark:half")).toBe(false);

    await writeConfig(
      submitWith([
        {
          type: "bark",
          id: "bark:1",
          baseUrl: "https://api.day.app",
          deviceKey: "key-1",
          name: "手机",
        },
      ]),
    );

    const base = capturedBase();
    expect(base.map((item) => item.id)).not.toContain("bark:half");
    expect(base.map((item) => item.id)).toEqual(["browser", "system", "bark:1"]);
  });

  // 基线里**带**读面归一化补出来的默认值：磁盘上没有的 enabled/timeoutMs/levels 必须在场。
  // 少了它们（= 取磁盘原样）就把「读面补的默认值」读成「用户刚设的」。
  it("归一化补的默认值在基线里在场：enabled/timeoutMs/levels 三个磁盘上没有的键", async () => {
    writeConfigFile(
      JSON.stringify({
        channels: [
          { type: "bark", id: "bark:1", baseUrl: "https://api.day.app", deviceKey: "key-1" },
        ],
      }),
    );
    installConfig({ logger: makeLogger() });

    await writeConfig(
      submitWith([
        {
          type: "bark",
          id: "bark:1",
          baseUrl: "https://api.day.app",
          deviceKey: "key-1",
          name: "手机",
        },
      ]),
    );

    const bark = capturedBase().find((item) => item.id === "bark:1");
    expect(bark).toBeDefined();
    expect(bark?.enabled).toBe(false);
    expect(bark?.timeoutMs).toBe(0);
    expect(bark?.levels).toEqual({});
  });

  // 越界值被钳制的那一条：基线里是钳制后的 0，不是磁盘上的 999999。
  // 判反的后果最直接——后续的边界值判据会把「用户刚设成 0」当成本次改动去拒。
  it("越界值在基线里是钳制后的结果：磁盘 timeoutMs:999999 ⇒ 基线 timeoutMs:0", async () => {
    writeConfigFile(
      JSON.stringify({
        channels: [
          {
            type: "bark",
            id: "bark:1",
            baseUrl: "https://api.day.app",
            deviceKey: "key-1",
            timeoutMs: 999_999,
          },
        ],
      }),
    );
    installConfig({ logger: makeLogger() });

    await writeConfig(
      submitWith([
        {
          type: "bark",
          id: "bark:1",
          baseUrl: "https://api.day.app",
          deviceKey: "key-1",
          timeoutMs: 0,
          name: "手机",
        },
      ]),
    );

    const bark = capturedBase().find((item) => item.id === "bark:1");
    expect(bark?.timeoutMs).toBe(0);
  });

  // 基线是**明文**不是掩码：掩码还原的原值来源是用户层（明文），两侧同源才逐字节相同。
  // 套 redactConfig 的话，客户端原样带回的凭据会与基线逐字不等，被读成「用户刚改过凭据」。
  it("基线里的凭据是明文（不是掩码占位）", async () => {
    writeConfigFile(
      JSON.stringify({
        channels: [
          { type: "bark", id: "bark:1", baseUrl: "https://api.day.app", deviceKey: "key-1" },
        ],
      }),
    );
    installConfig({ logger: makeLogger() });

    // 提交里带掩码（真实客户端对未编辑凭据就是原样带回掩码），还原后仍应是明文比对。
    await writeConfig(
      submitWith([
        {
          type: "bark",
          id: "bark:1",
          baseUrl: "https://api.day.app",
          deviceKey: "********",
          name: "手机",
        },
      ]),
    );

    const bark = capturedBase().find((item) => item.id === "bark:1");
    expect(bark?.deviceKey).toBe("key-1");
  });

  // 汇总断言：整份基线**逐字等于**「生效设置过共享面比较规范形」的结果。
  // 上四条是这条的各个侧面（可读性），这条是它的完整形式：换任何一种取法（磁盘原样、
  // 裸 effective、掩码版）都会在这条上判红。
  it("整份基线逐字等于客户端看过的那份视图（生效设置过比较规范形）", async () => {
    const disk: StoredSettings = {
      channels: [
        {
          type: "bark",
          id: "bark:1",
          baseUrl: "https://api.day.app",
          deviceKey: "key-1",
          name: "",
          timeoutMs: 999_999,
        },
        { type: "bark", id: "bark:half", baseUrl: "", deviceKey: "key-half" },
      ],
    };
    writeConfigFile(JSON.stringify(disk));
    installConfig({ logger: makeLogger() });

    await writeConfig(
      submitWith([
        {
          type: "bark",
          id: "bark:1",
          baseUrl: "https://api.day.app",
          deviceKey: "key-1",
          name: "手机",
          timeoutMs: 0,
        },
      ]),
    );

    const expected = canonicalChannelsForCompare(normalizeConfig(disk).channels) as Channel[];
    expect(capturedBase()).toEqual(expected);
  });
});
