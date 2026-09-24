/**
 * dsh-notifier upgrade 域 service 块 —— 装配面：跑链的时机与存量配置的割接。
 *
 * 判据面：升级必须在**各域装配之前**同步跑完（先装配就等于让各域读到旧形态并带着它继续跑），存量配置
 * 的读取面由组合根以显式依赖注入，装配期即可同步读——没有就绪回调、没有重试，所以「服务没来」这条
 * 分支在本域已不存在。0.2.4 那一步是同一次版本迁移的两半：存储布局归位 + 配置形态割接（直接读写
 * 配置文件，不经 config 域写面——链跑在各域装配之前，那时写面还没有装配好的配置镜像）。
 *
 * 链本身还锁两处：**起点边界**（刻度恰好停在 `fromVersion` 的装机必须执行这一步——唯一的真实升级
 * 场景；判据落在「旧文件被搬走了」，因为步骤幂等，只看新布局是否被覆盖的话恒跑也绿）与**落后/超前
 * 对账**（三种落差分属三处要改的地方，合成一条等于三处都只剩「有出声」这一个判据）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_FILE_NAME,
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  VERSION_FILE_NAME,
  legacyFile,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import { reportGap, runUpgradeSteps } from "../../../src/server/upgrade/impl/chain/index.ts";
import { STEPS } from "../../../src/server/upgrade/impl/steps/index.ts";
import { compareVersions } from "../../../src/server/upgrade/impl/version/index.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";

/** 0.2.3 及更早的历史文件在 home 根目录，名字与新布局不同。 */
const LEGACY_HISTORY_FILE_NAME = "dsh-notifier-history.jsonl";

/** 步骤表里最高的目标版本：链跑完的刻度应当正好落在它上面。 */
function newestTarget(): string {
  return STEPS.map((step) => step.targetVersion).reduce((newest, version) =>
    compareVersions(version, newest) > 0 ? version : newest,
  );
}

/** 步骤表里最低的目标版本：没有刻度文件时链从零跑起，制造失败的用例先红在这一步。 */
function oldestTarget(): string {
  return STEPS.map((step) => step.targetVersion).reduce((oldest, version) =>
    compareVersions(version, oldest) < 0 ? version : oldest,
  );
}

let home: { readonly dir: string; dispose: () => void };

beforeEach(() => {
  home = tempDshHome();
});

afterEach(() => {
  releaseUpgrade();
  home.dispose();
});

/** 磁盘上的配置文件；没写过即抛出（判据要的是内容，不是「读不到也算过」）。 */
function configOnDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")) as Record<
    string,
    unknown
  >;
}

/** 磁盘上的存储版本；失败路径必须能直接证明它没有被写动。 */
function storedVersionOnDisk(): string {
  return readFileSync(notifierFile(VERSION_FILE_NAME), "utf8").trim();
}

/** 把链固定在首个真实升级边界，失败前后就能比较同一份刻度。 */
function seedStoredVersion(version: string): void {
  writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), `${version}\n`);
}

/** 存量命名空间记录：本域只读 `ns` 与 `user` 两项，官方描述符的其余字段与判据无关。 */
type LegacyEntry = { ns: string; user?: unknown };

/**
 * 假 settings 读面：同步给出一份命名空间记录，并记下被读过几次——「链失败时不读存量」这条判据靠它
 * 证伪（读面被碰过就说明半完成的迁移还在往前走）。
 */
function makeLegacy(entries: readonly LegacyEntry[] = []) {
  let reads = 0;
  const face = {
    describe: () => {
      reads += 1;
      return entries as unknown as ReturnType<UpgradeDeps["legacySettings"]["describe"]>;
    },
  };
  return { face, reads: () => reads };
}

/** 装配一次升级域（链在装配期同步跑完）。 */
function assemble(options: { legacy?: ReturnType<typeof makeLegacy> } = {}) {
  const logger = makeLogger();
  const legacy = options.legacy ?? makeLegacy();
  const deps: UpgradeDeps = { logger, legacySettings: legacy.face };
  installUpgrade(deps);
  return { logger, legacy, deps };
}

/**
 * 配置形态割接（0.2.4 那一步的另一半）：把存量的顶层渠道键搬进 `channels` 的两条内置条目。
 *
 * 判据面是「搬什么、什么时候搬」：只搬**有值**的键（缺的留给 config 域归一化补默认——割接不替用户决定
 * 默认值）、出口音效键优先于旧的全局键、条目恒在最前，以及在两种「没有活要干」的情形下一个字都不写。
 */
describe("配置形态割接", () => {
  /** 种一份磁盘上的配置文件（0.2.3 的形态：顶层渠道键 + 实例）。 */
  function seedConfig(stored: Record<string, unknown>): void {
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), `${JSON.stringify(stored, null, 2)}\n`);
  }

  /** 割接补出来的空壳条目：只带身份，字段全靠存量键有值才搬。 */
  const EMPTY_BUILTINS = [
    { type: "browser", id: "browser" },
    { type: "system", id: "system" },
  ];

  it("存量顶层渠道键搬进两条内置条目后即删除：只搬有值的键，旧键一个都不留", () => {
    seedConfig({ notifyAsk: false, browserNotify: false, systemNotify: true });

    assemble();

    expect(configOnDisk().channels).toEqual([
      { type: "browser", id: "browser", popup: false },
      { type: "system", id: "system", popup: true },
    ]);
    // 搬完即删：同一个事实不留两处表达——留着旧键就是下一个 `notifySound` 式的隐患。
    expect("browserNotify" in configOnDisk()).toBe(false);
    expect("systemNotify" in configOnDisk()).toBe(false);
  });

  it("存量音效按出口键优先：出口键有值就用它，缺了才回落旧的全局键", () => {
    seedConfig({ browserSound: "ding", notifySound: false });

    assemble();

    expect(configOnDisk().channels).toEqual([
      { type: "browser", id: "browser", sound: "ding" },
      { type: "system", id: "system", sound: false },
    ]);
  });

  it("补出来的内置条目恒在数组最前，实例按原有相对顺序留在后面", () => {
    const bark = { type: "bark", id: "a", enabled: true };
    const hook = { type: "webhook", id: "b", enabled: true };
    seedConfig({ channels: [bark, hook] });

    assemble();

    expect(configOnDisk().channels).toEqual([...EMPTY_BUILTINS, bark, hook]);
  });

  it("两条内置条目已在场而仍有存量：只合并存量，不重复补条目", () => {
    const builtins = [
      {
        type: "browser",
        id: "browser",
        enabled: true,
        popup: true,
        sound: true,
        whenVisible: false,
      },
      { type: "system", id: "system", enabled: true, popup: true, sound: true },
    ];
    seedConfig({ channels: builtins });

    assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) });

    expect(configOnDisk().notifyAsk).toBe(false);
    expect(configOnDisk().channels).toEqual(builtins);
  });

  it("channels 被手改成非数组：照样补出两条内置条目，坏值不阻断割接", () => {
    seedConfig({ channels: "broken" });

    assemble();

    expect(configOnDisk().channels).toEqual(EMPTY_BUILTINS);
  });

  it("配置文件存在但 JSON 损坏：升级失败且刻度不动；修好后重试提交到目标", () => {
    seedStoredVersion("0.2.3");
    const file = notifierFile(CONFIG_FILE_NAME);
    writeTextAtomicSync(file, "{ 坏掉的\n");

    expect(() =>
      assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) }),
    ).toThrow(/配置形态割接解析失败/);
    expect(storedVersionOnDisk()).toBe("0.2.3");

    writeTextAtomicSync(file, "{}\n");
    expect(() => assemble()).not.toThrow();
    expect(storedVersionOnDisk()).toBe(newestTarget());
  });

  it("配置文件存在但不可读：升级失败且刻度不动；移除阻塞后重试成功", () => {
    seedStoredVersion("0.2.3");
    const file = notifierFile(CONFIG_FILE_NAME);
    mkdirSync(join(file, "占位"), { recursive: true });

    expect(() => assemble()).toThrow(/配置形态割接读取失败/);
    expect(storedVersionOnDisk()).toBe("0.2.3");

    rmSync(file, { recursive: true, force: true });
    expect(() => assemble()).not.toThrow();
    expect(storedVersionOnDisk()).toBe(newestTarget());
  });

  it.each([
    ["读取", () => mkdirSync(join(home.dir, "settings.yaml")), /legacy settings 来源 读取失败/],
    [
      "解析",
      () => writeFileSync(join(home.dir, "settings.yaml"), "dsh-notifier:\n\tnotifyAsk: false\n"),
      /YAML 解析失败/,
    ],
    [
      "序列化",
      () =>
        writeFileSync(
          join(home.dir, "settings.yaml"),
          "dsh-notifier: &self\n  notifyAsk: false\n  self: *self\n",
        ),
      /分节无法序列化/,
    ],
  ])(
    "正式 legacy 来源%s失败：链失败、刻度不动，清障重试后到目标",
    (_failure, breakSource, error) => {
      seedStoredVersion("0.2.3");
      breakSource();

      expect(() => assemble()).toThrow(error);
      expect(storedVersionOnDisk()).toBe("0.2.3");

      rmSync(join(home.dir, "settings.yaml"), { recursive: true, force: true });
      expect(() => assemble()).not.toThrow();
      expect(storedVersionOnDisk()).toBe(newestTarget());
    },
  );

  it("正式 legacy 分节为空仍按成功空迁移：刻度到目标且不创建 config", () => {
    seedStoredVersion("0.2.3");
    writeFileSync(join(home.dir, "settings.yaml"), "dsh-notifier: {}\n");

    expect(() => assemble()).not.toThrow();
    expect(storedVersionOnDisk()).toBe(newestTarget());
    expect(existsSync(notifierFile(CONFIG_FILE_NAME))).toBe(false);
  });

  // 幂等出口：没有存量、两条内置条目也都在场时一个字都不该写——每次启动重写文件会把用户后来
  // 手改的取值按割接结果重新序列化（未知键以外的一切都被重排），那是静默改写而不是迁移。
  // 种文件刻意用**压缩格式**：一旦割接重写了它，缩进就会暴露（逐字比对因此抓得住「白写一次」）。
  it("没有存量且两条内置条目已在场：文件逐字不动", () => {
    const before = JSON.stringify({
      notifyAsk: false,
      channels: [
        {
          type: "browser",
          id: "browser",
          enabled: true,
          popup: true,
          sound: true,
          whenVisible: false,
        },
        { type: "system", id: "system", enabled: true, popup: true, sound: true },
      ],
    });
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), before);

    assemble();

    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);
  });
});

describe("装配期跑链", () => {
  it("装配返回时刻度已落在步骤表最后一步的目标版本，初始形态也已落定", () => {
    assemble();

    expect(readFileSync(notifierFile(VERSION_FILE_NAME), "utf8").trim()).toBe(newestTarget());
    expect(existsSync(notifierFile(HISTORY_FILE_NAME))).toBe(true);
  });

  it("版本路径是目录时链在读取边界失败，迁移步骤与最终刻度回写都不发生", () => {
    const versionFile = notifierFile(VERSION_FILE_NAME);
    const sentinel = join(versionFile, "占位");
    mkdirSync(versionFile, { recursive: true });
    writeFileSync(sentinel, "保持原样", "utf8");
    const legacy = makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]);

    expect(() => assemble({ legacy })).toThrow(/存储版本文件读取失败.*EISDIR/);
    expect(legacy.reads()).toBe(0);
    expect(existsSync(notifierFile(HISTORY_FILE_NAME))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("保持原样");
  });

  it.each([
    ["空", "  \n", /存储版本文件为空/],
    ["非法", "not-a-version\n", /存储版本文件包含非法或不支持的版本号/],
  ])("版本文件为%s时链在读取边界失败，原内容与最终 marker 都不动", (_name, text, error) => {
    const versionFile = notifierFile(VERSION_FILE_NAME);
    writeTextAtomicSync(versionFile, text);
    const legacy = makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]);

    expect(() => assemble({ legacy })).toThrow(error);
    expect(legacy.reads()).toBe(0);
    expect(existsSync(notifierFile(HISTORY_FILE_NAME))).toBe(false);
    expect(readFileSync(versionFile, "utf8")).toBe(text);
  });

  it("刻度已到目标版本的存储不再重跑步骤（否则每次启动都会拿旧文件盖回用户改过的新数据）", () => {
    mkdirSync(dirname(notifierFile(HISTORY_FILE_NAME)), { recursive: true });
    writeFileSync(notifierFile(HISTORY_FILE_NAME), '{"ts":99}\n', "utf8");
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), `${newestTarget()}\n`);

    assemble();

    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":99}\n');
  });

  // 起点边界是唯一真实的升级场景：装机刻度恰好停在这一步的起点。边界写成 `> 0` 时这一步整个跳过，
  // 而外部表现是「升级后历史读空、旧文件还躺在 home 根目录」——故判据必须落在「旧文件被搬走了」上。
  it("刻度停在 0.2.3 的装机必须执行 0.2.3→0.2.4 这一步", () => {
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), "0.2.3\n");
    const legacy = legacyFile(LEGACY_HISTORY_FILE_NAME);
    writeFileSync(legacy, '{"ts":7}\n', "utf8");

    assemble();

    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":7}\n');
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(`${legacy}.migrated.bak`, "utf8")).toBe('{"ts":7}\n');
  });

  // 0.2.4 → 0.2.5 是空步：只推进刻度，不碰用户数据。判据落在「历史文件逐字不动」上——
  // 空实现若误写存储，这里即红；链会继续走到表末（0.2.6），故刻度断言落在最新目标版本上。
  it("刻度停在 0.2.4 的装机执行后续链：刻度到表末且历史文件逐字不动", () => {
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), "0.2.4\n");
    mkdirSync(dirname(notifierFile(HISTORY_FILE_NAME)), { recursive: true });
    writeFileSync(notifierFile(HISTORY_FILE_NAME), '{"ts":99}\n', "utf8");

    assemble();

    expect(readFileSync(notifierFile(VERSION_FILE_NAME), "utf8").trim()).toBe("0.2.6");
    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":99}\n');
  });

  // 反方向：刻度已到目标时这一步一次都不能跑。判据不能只看「新布局的内容没被覆盖」——步骤本身幂等，
  // 恒跑也绿；旧文件仍在原地才是「一次都没跑」的证据（跑了就会归档它）。
  it("刻度已到目标版本时这一步完全不执行：home 根的旧文件原地不动", () => {
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), `${newestTarget()}\n`);
    const legacy = legacyFile(LEGACY_HISTORY_FILE_NAME);
    writeFileSync(legacy, '{"ts":7}\n', "utf8");

    assemble();

    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(`${legacy}.migrated.bak`)).toBe(false);
  });

  // 刻度是「这一步做完了」的凭证：回写不进去却继续跑，下次启动会从一个不存在的刻度重来。
  it("步骤跑完但最终刻度回写失败即中止", () => {
    const versionFile = notifierFile(VERSION_FILE_NAME);
    const sentinel = join(versionFile, "占位");
    const targetVersion = "0.2.4";
    const deps: UpgradeDeps = { logger: makeLogger(), legacySettings: makeLegacy().face };

    expect(() =>
      runUpgradeSteps(
        [
          {
            fromVersion: "0.2.3",
            targetVersion,
            run() {
              rmSync(versionFile, { force: true });
              mkdirSync(versionFile, { recursive: true });
              writeFileSync(sentinel, "保持原样", "utf8");
            },
          },
        ],
        deps,
      ),
    ).toThrow(`存储版本号回写失败（${targetVersion}）`);
    expect(readFileSync(sentinel, "utf8")).toBe("保持原样");
  });

  it("链失败即中止启动，并说清失败在哪一步；此时不读存量（带着半完成迁移继续跑更危险）", () => {
    seedStoredVersion("0.2.3");
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), "{ 坏掉的\n");
    const legacy = makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]);

    expect(() => assemble({ legacy })).toThrow(`存储升级到 ${oldestTarget()} 失败`);
    expect(legacy.reads()).toBe(0);
    expect(storedVersionOnDisk()).toBe("0.2.3");
  });

  it("链失败后重试装配会真正重跑链（失败不该占住「已装配」，否则启动失败一次就再也装不上）", () => {
    seedStoredVersion("0.2.3");
    const configFile = notifierFile(CONFIG_FILE_NAME);
    writeTextAtomicSync(configFile, "{ 坏掉的\n");
    expect(() => assemble()).toThrow(/存储升级到 .* 失败/u);

    writeTextAtomicSync(configFile, "{}\n");
    const legacy = makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]);
    expect(() => assemble({ legacy })).not.toThrow();
    expect(readFileSync(notifierFile(VERSION_FILE_NAME), "utf8").trim()).toBe(newestTarget());
    expect(configOnDisk().notifyAsk).toBe(false);
  });
});

describe("链跑完后的版本对账：三种落差分开报", () => {
  // 三态的判据必须分别给：只用「装配后有没有 warn」这一条，把三种落差合并成一条也绿，
  // 而它们要人去改的地方完全不同（补步骤 / 改 package.json / 换回正确的装机）。
  it("刻度与插件版本一致：一个字的诊断都不出（对账不该成为日常噪音）", () => {
    const logger = makeLogger();

    reportGap(newestTarget(), newestTarget(), logger);

    expect(logger.warns).toEqual([]);
  });

  it("刻度落后于插件版本：报「缺少对应的升级步骤」（改的是步骤表）", () => {
    const logger = makeLogger();

    reportGap("0.1.0", "0.3.0", logger);

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("存储版本 0.1.0 落后于插件版本 0.3.0");
    expect(logger.warns[0]).toContain("缺少对应的升级步骤");
  });

  it("刻度超前而步骤表也超前：报「步骤表与 package.json 不同步」（改的是 package.json）", () => {
    const logger = makeLogger();

    reportGap("0.3.0", "0.2.3", logger);

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain(`升级链的目标版本 ${newestTarget()} 高于插件版本 0.2.3`);
    expect(logger.warns[0]).toContain("步骤表与 package.json 不同步");
  });

  it("刻度超前而步骤表没超前：报「不回退」（装的是更旧的包，改的是装机本身）", () => {
    const logger = makeLogger();

    reportGap("0.3.0", newestTarget(), logger);

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("本插件的升级链不回退");
  });
});

describe("存量设置的割接：装配期同步读，直接读写配置文件", () => {
  it("装配返回时存量已割接落盘：旧键换成新形态，装配键不进配置", () => {
    const legacy = makeLegacy([
      {
        ns: "dsh-notifier",
        user: { enabled: true, notifyAsk: false, notifySound: false, configFile: "/legacy/x.json" },
      },
    ]);

    assemble({ legacy });

    // 同步读面：装配返回时割接已经写完，没有「等一会儿再来读」的窗口。
    expect(legacy.reads()).toBe(1);
    const stored = configOnDisk();
    expect(stored.notifyAsk).toBe(false);
    // 旧键搬完即删：文件里只留条目一处表达
    expect("notifySound" in stored).toBe(false);
    // 旧的全局音效键摊到两条内置条目的 `sound` 上（用户当时关掉的提示音不该复活）。
    expect(stored.channels).toEqual([
      { type: "browser", id: "browser", sound: false },
      { type: "system", id: "system", sound: false },
    ]);
    // 组合层装配键在旧格式里就属于启动参数，迁移后不该出现在配置里。
    expect("configFile" in stored).toBe(false);
    expect("enabled" in stored).toBe(false);
  });

  it("既没有存量也没有配置文件：不凭空建一份（默认值被读成「用户改过」是另一条语义的反面）", () => {
    assemble();

    expect(existsSync(notifierFile(CONFIG_FILE_NAME))).toBe(false);
  });

  it("配置文件已有内容时以文件为基底合并存量：存量覆盖同名键，文件里多出来的形状留住", () => {
    const file = notifierFile(CONFIG_FILE_NAME);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ notifyAsk: true, historyMaxAgeDays: 32 })}\n`, "utf8");

    assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) });

    const stored = configOnDisk();
    expect(stored.notifyAsk).toBe(false);
    expect(stored.historyMaxAgeDays).toBe(32);
  });

  it("后续步骤失败即抛且整条链的刻度仍停在链起点；恢复写权限后重试一次提交到目标", () => {
    seedStoredVersion("0.2.3");
    const configFile = notifierFile(CONFIG_FILE_NAME);
    const storageDir = dirname(configFile);
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(configFile, '{"notifyAsk":true}\n', "utf8");
    // 存储布局先落定，确保只读故障精确发生在 config 原子写，而不是更早的 storage-layout。
    writeFileSync(notifierFile(HISTORY_FILE_NAME), "", "utf8");
    writeFileSync(notifierFile(STATUS_FILE_NAME), "{}\n", "utf8");
    writeFileSync(notifierFile(SEQ_FILE_NAME), "0\n", "utf8");

    chmodSync(storageDir, 0o555);
    let caught: unknown;
    try {
      assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) });
    } catch (cause) {
      caught = cause;
    } finally {
      chmodSync(storageDir, 0o755);
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("配置形态割接落盘失败");
    expect(storedVersionOnDisk()).toBe("0.2.3");
    expect(configOnDisk().notifyAsk).toBe(true);

    expect(() =>
      assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) }),
    ).not.toThrow();
    expect(storedVersionOnDisk()).toBe(newestTarget());
    expect(configOnDisk().notifyAsk).toBe(false);
  });
});

describe("生命周期", () => {
  it("重复装配当场抛错；release 幂等且不清掉已落盘的割接结果，之后可以再装配", () => {
    const legacy = makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]);
    assemble({ legacy });
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    expect(() => assemble()).toThrow("dsh-notifier: upgrade 域只能装配一次");

    const before = readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8");
    releaseUpgrade();
    releaseUpgrade();
    // 本域没有需要在卸载时收回的东西：链已经写完的文件不会被卸载动作改回去。
    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);

    expect(() => assemble()).not.toThrow();
  });
});
