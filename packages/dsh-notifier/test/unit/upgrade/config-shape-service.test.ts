/**
 * dsh-notifier upgrade 域 service 块 —— 业务割接的装配面。
 *
 * 判据面只有两块，都是**业务**：① 配置形态割接（0.2.4 那一步的另一半）搬了什么、什么时候搬；
 * ② 存量设置的割接在装配期同步读、直接读写配置文件，割接落盘时即完成。存量配置的读取面由组合根
 * 以显式依赖注入，装配期即可读——没有就绪回调、没有重试，所以「服务没来」这条分支在本域已不存在。
 *
 * 链骨架（待办步筛选与排序、逐步 await、每步回写、失败即抛、错误文案、版本对账、重复装配）
 * 与刻度读写原语由 shared/upgrade-chain.js 单一实现并在 shared/test 里测，本包不重复测。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newestTargetVersion } from "../../../../../shared/upgrade-chain.js";
import {
  CONFIG_FILE_NAME,
  VERSION_FILE_NAME,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import { STEPS } from "../../../src/server/upgrade/impl/steps/index.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";

/** 步骤表里最高的目标版本：链跑完的刻度应当正好落在它上面。 */
function newestTarget(): string {
  return newestTargetVersion(STEPS);
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
 * 假 settings 读面：同步给出一份命名空间记录，并记下被读过几次——「割接失败时不读存量」这条判据
 * 靠它证伪（读面被碰过就说明半完成的迁移还在往前走）。
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

/** 装配一次升级域（链在装配期异步跑完，故本 helper 收 Promise）。 */
async function assemble(options: { legacy?: ReturnType<typeof makeLegacy> } = {}) {
  const logger = makeLogger();
  const legacy = options.legacy ?? makeLegacy();
  const deps: UpgradeDeps = { logger, legacySettings: legacy.face };
  await installUpgrade(deps);
  return { logger, legacy, deps };
}

/**
 * 配置形态割接（0.2.4 那一步的另一半）：把存量的顶层渠道键搬进 `channels` 的两条内置条目。
 *
 * 判据面是「搬什么、什么时候搬」：只搬**有值**的键（缺的留给 config 域归一化补默认——割接不替用户决定
 * 默认值）、出口音效键优先于旧的全局键、条目恒在最前，以及在两种「没有活要干」的情形下一个字都不写。
 */
/** 种一份磁盘上的配置文件（0.2.3 的形态：顶层渠道键 + 实例）。 */
function seedConfig(stored: Record<string, unknown>): void {
  writeTextAtomicSync(
    notifierFile(CONFIG_FILE_NAME),
    `${JSON.stringify(stored, null, 2)}
`,
  );
}

/**
 * 两条内置条目在**整条链跑完之后**的形态：0.2.4 割接只写身份与有值的存量键，0.2.9 的形态清理再把缺席
 * 字段按默认表补齐（#1016 P1-1）。本文件断的是链的终态，故夹具取补齐后的形态。
 *
 * 逐字取自默认表而不是手抄——补的值本就是默认表的值，同源由 steps.test.ts 的同源守卫钉住。
 */
const EMPTY_BUILTINS = DEFAULT_CONFIG.channels;

describe("配置形态割接", describeConfigShapeMigrations);
function describeConfigShapeMigrations() {
  it("存量顶层渠道键搬进两条内置条目后即删除：只搬有值的键，旧键一个都不留", configShapeTest1);

  it("存量音效按出口键优先：出口键有值就用它，缺了才回落旧的全局键", configShapeTest2);

  it("补出来的内置条目恒在数组最前，实例按原有相对顺序留在后面", configShapeTest3);

  it("两条内置条目已在场而仍有存量：只合并存量，不重复补条目", configShapeTest4);

  it("channels 被手改成非数组：照样补出两条内置条目，坏值不阻断割接", configShapeTest5);

  it("配置文件存在但 JSON 损坏：升级失败且刻度不动；修好后重试提交到目标", configShapeTest6);

  it("配置文件存在但不可读：升级失败且刻度不动；移除阻塞后重试成功", configShapeTest7);

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
    async (_failure, breakSource, error) => {
      seedStoredVersion("0.2.3");
      breakSource();

      await expect(assemble()).rejects.toThrow(error);
      expect(storedVersionOnDisk()).toBe("0.2.3");

      rmSync(join(home.dir, "settings.yaml"), { recursive: true, force: true });
      await assemble();
      expect(storedVersionOnDisk()).toBe(newestTarget());
    },
  );

  it("正式 legacy 分节为空仍按成功空迁移：刻度到目标且不创建 config", configShapeTest8);

  // 幂等出口：没有存量、两条内置条目也都在场时一个字都不该写——每次启动重写文件会把用户后来
  // 手改的取值按割接结果重新序列化（未知键以外的一切都被重排），那是静默改写而不是迁移。
  // 种文件刻意用**压缩格式**：一旦割接重写了它，缩进就会暴露（逐字比对因此抓得住「白写一次」）。
  it("没有存量且两条内置条目已在场：文件逐字不动", configShapeTest9);
}

async function configShapeTest1() {
  seedConfig({ notifyAsk: false, browserNotify: false, systemNotify: true });

  await assemble();

  // popup 是搬来的**用户值**（browserNotify: false / systemNotify: true），不是默认表的 true——
  // 其余字段由 0.2.9 按默认表补齐（#1016 P1-1）。
  expect(configOnDisk().channels).toEqual([
    {
      type: "browser",
      id: "browser",
      enabled: true,
      popup: false,
      sound: true,
      whenVisible: false,
    },
    { type: "system", id: "system", enabled: true, popup: true, sound: true },
  ]);
  // 搬完即删：同一个事实不留两处表达——留着旧键就是下一个 `notifySound` 式的隐患。
  expect("browserNotify" in configOnDisk()).toBe(false);
  expect("systemNotify" in configOnDisk()).toBe(false);
}

async function configShapeTest2() {
  seedConfig({ browserSound: "ding", notifySound: false });

  await assemble();

  expect(configOnDisk().channels).toEqual([
    {
      type: "browser",
      id: "browser",
      enabled: true,
      popup: true,
      sound: "ding",
      whenVisible: false,
    },
    { type: "system", id: "system", enabled: true, popup: true, sound: false },
  ]);
}

async function configShapeTest3() {
  // 实例带齐各自的投递必需键：半坏条目在 0.2.9 的清理步里**不再被删**（#1016 P1-2 选 (a)），但它们
  // 留在结果里会让这条用例断不到本意的「顺序」上——夹具该用干净形态。
  const bark = { type: "bark", id: "a", enabled: true, baseUrl: "https://x", deviceKey: "k" };
  const hook = { type: "webhook", id: "b", enabled: true, url: "https://y" };
  seedConfig({ channels: [bark, hook] });

  await assemble();

  expect(configOnDisk().channels).toEqual([...EMPTY_BUILTINS, bark, hook]);
}

async function configShapeTest4() {
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

  await assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) });

  expect(configOnDisk().notifyAsk).toBe(false);
  expect(configOnDisk().channels).toEqual(builtins);
}

async function configShapeTest5() {
  seedConfig({ channels: "broken" });

  await assemble();

  expect(configOnDisk().channels).toEqual(EMPTY_BUILTINS);
}

async function configShapeTest6() {
  seedStoredVersion("0.2.3");
  const file = notifierFile(CONFIG_FILE_NAME);
  writeTextAtomicSync(file, "{ 坏掉的\n");

  await expect(
    assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) }),
  ).rejects.toThrow(/配置形态割接解析失败/);
  expect(storedVersionOnDisk()).toBe("0.2.3");

  writeTextAtomicSync(file, "{}\n");
  await assemble();
  expect(storedVersionOnDisk()).toBe(newestTarget());
}

async function configShapeTest7() {
  seedStoredVersion("0.2.3");
  const file = notifierFile(CONFIG_FILE_NAME);
  mkdirSync(join(file, "占位"), { recursive: true });

  await expect(assemble()).rejects.toThrow(/配置形态割接读取失败/);
  expect(storedVersionOnDisk()).toBe("0.2.3");

  rmSync(file, { recursive: true, force: true });
  await assemble();
  expect(storedVersionOnDisk()).toBe(newestTarget());
}

async function configShapeTest8() {
  seedStoredVersion("0.2.3");
  writeFileSync(join(home.dir, "settings.yaml"), "dsh-notifier: {}\n");

  await assemble();
  expect(storedVersionOnDisk()).toBe(newestTarget());
  expect(existsSync(notifierFile(CONFIG_FILE_NAME))).toBe(false);
}

async function configShapeTest9() {
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

  await assemble();

  expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);
}
