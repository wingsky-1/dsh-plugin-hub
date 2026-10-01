/**
 * dsh-notifier upgrade 域 steps 块 —— 0.2.3 → 0.2.4 的存储布局归位。
 *
 * 判据面：这是唯一**动用户数据**的一步。搬错的表现是静默丢数据——历史读空、状态表回默认、旧文件
 * 留在 home 根目录，而用户只会看到「通知记录没了」。故逐条锁：内容逐字保留、旧文件留痕、
 * 目标已存在时**不覆盖**（用户可能已经在新位置改过东西）、重跑不累积归档。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BARK_KNOWN_KEYS,
  BARK_LEVELS,
  BARK_LEVELS_LIMIT,
  BARK_TIMEOUT_MS_LIMIT,
  DEFAULTS,
  HISTORY_MAX_AGE_DAYS_LIMIT,
  REQUIRED_KEYS,
  VALUE_DOMAIN_REQUIRED_KEYS,
  WEBHOOK_AUTHS,
  WEBHOOK_KNOWN_KEYS,
  WEBHOOK_PRESETS,
  WEBHOOK_TEMPLATE_MAX_CHARS,
  WEBHOOK_TIMEOUT,
} from "../../../src/shared/interface.ts";
import { normalizeConfig } from "../../../src/server/config/impl/input/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type {
  RawSettingValue,
  StoredSettings,
} from "../../../src/server/config/impl/model/type.ts";
import { projectForView } from "../../../src/server/config/impl/service/view.ts";
import {
  CONFIG_FILE_NAME,
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  legacyFile,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import { migrateCanonicalKeys } from "../../../src/server/upgrade/impl/steps/canonical-keys.ts";
import { migrateStorageLayout } from "../../../src/server/upgrade/impl/steps/storage-layout.ts";
import { tempDshHome } from "../../helpers.ts";

/** 本文件内建过的隔离环境，逐个在 afterEach 还原并删除。 */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

/** 建一个隔离 DSH_HOME（迁移的读端与写端都从它解析路径）。 */
function isolatedHome(): string {
  const home = tempDshHome();
  cleanups.push(home.dispose);
  return home.dir;
}

function writeLegacy(name: string, text: string): void {
  writeFileSync(legacyFile(name), text, "utf8");
}

/** 旧文件名 → 新文件名 → 一份有代表性的内容（jsonl 是多行、json 是单行、seq 是数字）。 */
const ENTRIES = [
  ["dsh-notifier-history.jsonl", HISTORY_FILE_NAME, '{"ts":1,"kind":"done"}\n{"ts":2}\n'],
  [
    "dsh-notifier-status.json",
    STATUS_FILE_NAME,
    '{"bark:main":{"lastTs":9,"lastStatus":"ok","failStreak":0}}\n',
  ],
  ["notifier-seq.json", SEQ_FILE_NAME, "7\n"],
] as const;

/**
 * 0.2.8 → 0.2.9：配置形态清理（#1016 S3）。
 *
 * 判据面：读面自 S3 起不再兜底（视图只做键子集 + 原样 + 掩码），兜底搬到本步。搬错的表现分两种，
 * 都很安静：**该删的没删**——磁盘上留着越界 / 非法枚举 / 缺必填键的条目，此后每一次无关保存都可能被
 * 拒，或者设置页把它原样交给客户端再原样带回（读面曾经会替它收敛，现在是原样往返）；**该留的删了**——
 * 合法但非默认的取值（配满的 levels、8000 字符的 template、凭据空串）被当成脏值清掉，用户配的东西
 * 无声消失。故逐条锁判据方向，并且逐条钉住「重跑一个字不写」。
 */
describe("配置形态清理（canonical-keys）", () => {
  const BARK = { type: "bark", id: "bark:1", baseUrl: "https://x", deviceKey: "k" };
  const HOOK = { type: "webhook", id: "hook:1", url: "https://y" };
  /**
   * 两条内置条目的**干净**形态（0.2.9 清理之后磁盘上就是这个样子），取自默认表而不是手抄一份——与默认表
   * 同源由末尾那条同源守卫钉住。
   *
   * **刻意用完整形态而不是 `{type,id}`**：0.2.4 割接在用户没设过任何旧键时写出的确实是
   * `{type,id}`，而本步现在会把它补齐（判据 #8 的第二格）。让多数用例拿干净形态当输入，
   * 「残缺形态会被补」这件事才由那一条单独断，而不是散落在每条断言的差异里。
   */
  function builtinDefault(type: string): Record<string, unknown> {
    const found = DEFAULT_CONFIG.channels.find((channel) => channel.type === type);
    if (found === undefined) throw new Error("默认表里没有内置频道 " + type);
    return found as unknown as Record<string, unknown>;
  }
  const BROWSER = builtinDefault("browser");
  const SYSTEM = builtinDefault("system");

  /** 落盘后的频道数组（存储层形状不受契约约束，按原始值看）。 */
  function channelsOnDisk(stored: Record<string, unknown>): Array<Record<string, unknown>> {
    return stored.channels as Array<Record<string, unknown>>;
  }

  /** 任意一份设置（视图投影）里的频道数组；存储层形状不受契约约束，按原始值看。 */
  function channelsOf(config: unknown): Array<Record<string, RawSettingValue>> {
    const picked = (config as { channels?: RawSettingValue }).channels;
    return (picked ?? []) as Array<Record<string, RawSettingValue>>;
  }

  /** 种一份磁盘配置并跑一步清理，返回落盘后的内容。 */
  function clean(stored: Record<string, unknown>): Record<string, unknown> {
    isolatedHome();
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), `${JSON.stringify(stored, null, 2)}\n`);
    migrateCanonicalKeys();
    return JSON.parse(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")) as Record<
      string,
      unknown
    >;
  }

  /** 磁盘原文（跑之前），用于「一个字不写」的逐字比对。 */
  function seedRaw(text: string): void {
    isolatedHome();
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), text);
  }

  it("判据 #1：顶层不在已知键集内的键删除（0.2.3 的旧顶层渠道键、退役的 maxConnections、手写的未来键）", () => {
    const out = clean({
      channels: [BROWSER, SYSTEM, BARK],
      notifySound: false,
      maxConnections: 64,
      futureFlag: true,
    });
    expect(Object.keys(out)).toEqual(["channels"]);
  });

  it("判据 #2：频道条目内不在该 type 字段名集合内的键删除（含凭据别名保留键）", () => {
    const out = clean({
      channels: [
        BROWSER,
        SYSTEM,
        { ...BARK, volume: 5, device_key: "别名" },
        { ...HOOK, retries: 2, auth_token: "别名" },
      ],
    });
    expect(out.channels).toEqual([BROWSER, SYSTEM, BARK, HOOK]);
  });

  // 判据 #2 的**反向那一格**：上面那条用的全是从未出现在任一已知键表里的键（volume / device_key /
  // retries / auth_token），它证明不了「按 type 取表」这件事——把 `knownKeysOf` 改成返回**两类型并集**
  // （BARK_KNOWN_KEYS ∪ WEBHOOK_KNOWN_KEYS），上面那条照样全绿。
  //
  // 这一条补的正是那一格：bark 的键挂在 webhook 条目上（deviceKey 是跨 type 残留掩码的落点、
  // baseUrl / levels 是投递必需键与映射表），反向亦然（token / headerValue / timeoutSec 挂到 bark 上）。
  // 它是**跨 type 残留的清道夫**——磁盘上留着这些键，读面就把它们原样外发、客户端原样带回，
  // 写面随后要么 400（陌生键）要么被当普通值写回，而带掩码的那一种正是写面拒收话术要解释的情形。
  it("判据 #2 的反向格：别的 type 的已知键挂在条目上同样删除（按 type 取表，不是取并集）", () => {
    const out = clean({
      channels: [
        BROWSER,
        SYSTEM,
        { ...HOOK, deviceKey: "跨类型残留", baseUrl: "https://x", levels: { done: "passive" } },
        { ...BARK, token: "跨类型残留", headerValue: "跨类型残留", timeoutSec: 30 },
      ],
    });
    expect(out.channels).toEqual([BROWSER, SYSTEM, HOOK, BARK]);
    // 前提事实：这些键确实在**另一张**已知键表里（否则这条就只是在测「陌生键删除」，与 #2 同义）。
    expect(BARK_KNOWN_KEYS).toContain("deviceKey");
    expect(BARK_KNOWN_KEYS).toContain("baseUrl");
    expect(BARK_KNOWN_KEYS).toContain("levels");
    expect(WEBHOOK_KNOWN_KEYS).toContain("token");
    expect(WEBHOOK_KNOWN_KEYS).toContain("headerValue");
    expect(WEBHOOK_KNOWN_KEYS).toContain("timeoutSec");
  });

  it("判据 #3：类型不符的标量删键不夹值（notifyAsk 写成字符串、allowKinds 写成数字）", () => {
    const out = clean({
      channels: [BROWSER, SYSTEM],
      notifyAsk: "yes",
      allowKinds: 3,
    });
    expect("notifyAsk" in out).toBe(false);
    expect("allowKinds" in out).toBe(false);
  });

  it("判据 #4：越界与非法枚举删键不夹值（timeoutSec / timeoutMs / level / preset / historyMaxAgeDays）", () => {
    // auth 刻意不在这条用例里：它是**取值域必填键**，白名单外删的是整条而不是键（判据 #5 第三格）。
    const out = clean({
      channels: [
        BROWSER,
        SYSTEM,
        { ...BARK, timeoutMs: 999_999, level: "urgent" },
        { ...HOOK, timeoutSec: 99_999, preset: "nope" },
      ],
      historyMaxAgeDays: 4000,
    });
    expect(out.channels).toEqual([BROWSER, SYSTEM, BARK, HOOK]);
    expect("historyMaxAgeDays" in out).toBe(false);
  });

  it("判据 #4 的另一面：界内取值**不动**（timeoutSec: 60 / timeoutMs: 0 / historyMaxAgeDays: 3650）", () => {
    const out = clean({
      channels: [
        BROWSER,
        SYSTEM,
        { ...BARK, timeoutMs: 0, level: "critical" },
        { ...HOOK, timeoutSec: 60, preset: "ntfy", auth: "bearer" },
      ],
      historyMaxAgeDays: 3650,
    });
    expect(out.channels).toEqual([
      BROWSER,
      SYSTEM,
      { ...BARK, timeoutMs: 0, level: "critical" },
      { ...HOOK, timeoutSec: 60, preset: "ntfy", auth: "bearer" },
    ]);
    expect(out.historyMaxAgeDays).toBe(3650);
  });

  // 判据 #5 的两格。**格与格的分界是「这个键是不是必填」**，读的是 shared 的 REQUIRED_KEYS。
  //
  // 第一格（非必填键形态不符 → 只删键）：token / headerValue 是凭据字段但不是投递必需键，删掉它们之后
  // 这条 webhook 仍然投递得了（url 还在），留着条目是对的。password 是**空串**——形态合法，空串表达
  // 「未设置」，一个字都不动。
  //
  // 改坏方向（退回「一律只删键」）：bark 那条会剩下 `{type,id,baseUrl}`——本步**自己**造出一条残缺条目，
  // 而判据 #6 承诺的恰恰是半坏条目整条保留。两条判据相隔不到十行、方向相反，用户看到的现象是
  // 「升级后我那条频道打不通了」，而罪魁是升级本身。
  it("判据 #5：非必填键值形态不符只删该键（凭据字段的空串**不动**——它表达的是「未设置」）", () => {
    const hook = { ...HOOK, token: null, password: "", headerValue: 7, name: "钩子" };
    const out = clean({ channels: [BROWSER, SYSTEM, BARK, hook] });
    // token / headerValue 两个键消失（值形态不对），password 是空串（留），条目与 name 一起留着。
    expect(out.channels).toEqual([
      BROWSER,
      SYSTEM,
      BARK,
      { type: "webhook", id: "hook:1", url: "https://y", password: "", name: "钩子" },
    ]);
  });

  // 判据 #5 的第二格（#1016 单一事实源收口）：**必填键**值形态不符 → **删整条**。
  //
  // 为什么不是「只删键」：删掉 baseUrl 就是本步当场造出一条残缺条目。磁盘上原本只有这一个字段不对
  // （用户手滑打成了数字），清理之后整条都投递不了，而 S3 自己修通的三条路（视图可见 / 写面
  // preexisting 放行 / 投递投影丢弃）会把这条半坏条目永久接住——代价由用户承担，原因是升级。
  //
  // 与判据 #6 的边界是**「键在不在」**，不是「这条条目完整不完整」：缺席 / 空串是用户手改出来的残缺，
  // 原样保留；形态不符是本步造出来的，不能留。这条用例与下一条（判据 #6）合起来才是完整边界。
  it("判据 #5 第二格：必填键值形态不符 → 删整条（本步不造残缺条目）", () => {
    const badBaseUrl = { ...BARK, baseUrl: 12345, name: "地址写成数字" };
    const badDeviceKey = {
      type: "bark",
      id: "bark:2",
      baseUrl: "https://x",
      deviceKey: null,
      name: "凭据写成 null",
    };
    const badUrl = { type: "webhook", id: "hook:2", url: 7, name: "地址写成数字" };
    const kept = { ...HOOK, name: "完好" };
    const out = clean({ channels: [BROWSER, SYSTEM, badBaseUrl, badDeviceKey, badUrl, kept] });
    // 三条全没了，完好那条与它的 name 一起留着——判据从「删键」升级成「删整条」时，删的必须是整条。
    expect(out.channels).toEqual([BROWSER, SYSTEM, kept]);
  });

  // 判别力（#1016 单一事实源，硬要求 #1）：清理步遇必填键值形态不符时**不产生**残缺条目。
  //
  // 这一条与上一条不是同一件事：上一条断言「整条消失」，这一条断言「磁盘上不留任何半成品」——
  // 改坏方向是「删键但条目留着」，那种实现下上一条会红吗？会（多出一条），这一条则给出正面证据：
  // 跑完之后**逐条**检查没有任何一条少了必填键。
  it("判别力 #1：必填键值形态不符的条目，清理后磁盘上不存在「少一个必填键」的条目", () => {
    const out = clean({
      channels: [
        BROWSER,
        SYSTEM,
        { ...BARK, baseUrl: 12345 },
        { ...BARK, id: "bark:2", deviceKey: { nested: true } },
        { type: "webhook", id: "hook:2", url: 7 },
        { type: "webhook", id: "hook:3", url: null },
      ],
    });
    for (const channel of channelsOnDisk(out)) {
      const type = channel.type as string;
      for (const key of REQUIRED_KEYS[type] ?? []) {
        // 「键不在」与「键在但是空串」是**用户手改出来的**残缺，判据 #6 明确保留——
        // 判别力只针对「本步会不会新造出半成品」，故只钉「本该存在的必填键一个都不许被本步删掉」。
        expect(Object.hasOwn(channel, key), type + "." + key).toBe(true);
      }
    }
  });

  // 判别力（硬要求 #2）：非必填键值形态不符 → 只删该键、条目保留。
  //
  // 与判据 #5 第一格同向但断言面不同：那条钉具体三个键，这一条钉「除该键外逐字不动」——
  // 改坏方向是把非必填键也升级成删整条，那症状是「用户一条好端端的频道，升级后不见了」。
  it("判别力 #2：非必填键值形态不符只删该键，条目连其余字段逐字保留", () => {
    const hook = {
      type: "webhook",
      id: "h:1",
      url: "https://y",
      name: "我的钩子",
      enabled: true,
      token: 42,
      timeoutSec: 30,
    };
    expect(clean({ channels: [BROWSER, SYSTEM, hook] }).channels).toEqual([
      BROWSER,
      SYSTEM,
      {
        type: "webhook",
        id: "h:1",
        url: "https://y",
        name: "我的钩子",
        enabled: true,
        timeoutSec: 30,
      },
    ]);
  });

  // 判据 #5 的第三格（取值域类必填键，webhook 的 `auth`）：值不在 WEBHOOK_AUTHS 里 → **删整条**。
  //
  // 与第二格同形，区别只在判据用哪个谓词：`auth` 不在 REQUIRED_KEYS 里是因为它的判据是取值域而不是「在场」，
  // 不因为处置可以更轻。**删键的后果是本步自己造出残缺**：写面 `validateWebhookChannel` 对「auth 缺席」与
  // 「auth 非法」是同一句拒收，于是磁盘上剩下那条「url 齐全、只是没有 auth」的频道，此后每一次无关保存
  // 都被 400 拒收——与 baseUrl 被删时的症状逐字相同，而罪魁同样是升级本身。
  //
  // 改坏方向（退回「只删 auth 键」）：磁盘上多出一条此后永远存不下的频道，本条立刻红（多出一个条目）。
  it("判据 #5 第三格：取值域必填键（auth）值不在白名单 → 删整条，不是只删 auth 键", () => {
    const badNumber = {
      type: "webhook",
      id: "hook:number",
      url: "https://y",
      auth: 123,
      name: "认证写成数字",
    };
    const badString = {
      type: "webhook",
      id: "hook:string",
      url: "https://y",
      auth: "magic",
      name: "白名单外的串",
    };
    const badNull = {
      type: "webhook",
      id: "hook:null",
      url: "https://y",
      auth: null,
      name: "空值",
    };
    const kept = { ...HOOK, auth: "bearer", name: "完好" };
    const out = clean({ channels: [BROWSER, SYSTEM, badNumber, badString, badNull, kept] });
    // 三条全没了（连 name 一起），白名单内的 auth 那条逐字留着——处置与在场必填键一字不差。
    expect(out.channels).toEqual([BROWSER, SYSTEM, kept]);
  });

  // 第三格与判据 #6 的边界仍是「键在不在 + 空串」：键缺席、值为空串都是**用户手改**出来的「没填」，
  // 原样保留——`auth` 不在 REQUIRED_KEYS 里不改变判据 #6 对它的承诺。
  //
  // 改坏方向（把空串也算成白名单外）：用户手改坏一次配置，升级就把他的频道连 name 一起删掉，而他在设置页
  // 里从头到尾见过它——那正是判据 #6 拒绝付的「看不见的代价」。
  it("判据 #5 第三格的边界：auth 键缺席或空串逐字保留（判据 #6 对取值域必填键同样生效）", () => {
    const absent = { type: "webhook", id: "h:absent", url: "https://y", name: "缺 auth" };
    const empty = { type: "webhook", id: "h:empty", url: "https://y", auth: "", name: "auth 空串" };
    expect(clean({ channels: [BROWSER, SYSTEM, HOOK, absent, empty] }).channels).toEqual([
      BROWSER,
      SYSTEM,
      HOOK,
      absent,
      empty,
    ]);
  });

  // #1016 P1-2 选 (a) 的落点：投递必需键空串或缺席**不再删整条**，原样留在磁盘上。
  //
  // **本条是本轮唯一一处「编号保留、语义反转」的判据**：S3 任务书（#1016 P1-2）给 #6 的原文是「频道
  // 条目缺必填键（bark 缺 baseUrl/deviceKey、webhook 缺 url）→ 删整条条目」，实现时发现它与 S3 自己刚
  // 修通的半坏条目三条路自相矛盾（见 canonical-keys.ts 文件头），遂反转成「整条保留」。
  //
  // **号不重排**（S4 裁决）：#1–#8 是一份闭合清单，把被否决的那条「另起编号」或整段重排都不解决
  // 问题、只把陷阱挪位置——重排之后清单里从此没有 #6，评审得靠数才看得出这里曾有一条被否决，而
  // 「半坏条目该不该删」这个决定本身在代码里也就没了着落。真正能掐掉陷阱的是**把反转写在编号旁边**
  // （就是本段），不是换号。号仍是稳定句柄：谁引用过「判据 #6」都还指得到这一条。
  //
  // 改坏方向（回到旧实现）：整条消失、连 name 一起丢，而用户在设置页里从头到尾没见过它——S3 刚把半坏
  // 条目的三条路（视图看得见 / 写面 preexisting 放行 / 投递投影整条丢弃）修通，升级步再把它删掉是自相矛盾。
  it("判据 #6：半坏条目（必填键空串或缺席）整条保留、逐字不动 —— 反转自 #1016 P1-2 的「删整条」；deviceKey 空串的 bark 连 name 一起留着", () => {
    const emptyDeviceKey = {
      type: "bark",
      id: "bark:empty-key",
      baseUrl: "https://x",
      deviceKey: "",
      name: "凭据空串",
    };
    const emptyBaseUrl = {
      type: "bark",
      id: "bark:empty",
      baseUrl: "",
      deviceKey: "k",
      name: "地址空串",
    };
    const absentBaseUrl = { type: "bark", id: "bark:no-url", deviceKey: "k", name: "缺地址" };
    const absentUrl = { type: "webhook", id: "hook:no-url", name: "缺 url" };
    const out = clean({
      channels: [BROWSER, SYSTEM, BARK, emptyDeviceKey, emptyBaseUrl, absentBaseUrl, absentUrl],
    });
    expect(out.channels).toEqual([
      BROWSER,
      SYSTEM,
      BARK,
      emptyDeviceKey,
      emptyBaseUrl,
      absentBaseUrl,
      absentUrl,
    ]);
  });

  // 判别力（硬要求 #3）：手改出来的残缺条目（键**缺席**）→ 原样保留，判据 #6 不变。
  //
  // 这一条是判据 #5 第二格那半边的对照：同样是「这条投递不了」，**成因**不同、处置就不同——
  //   - 键缺席 / 空串：**用户**手改出来的。本步不制造它，也不假装它不存在，删它等于替用户做决定。
  //   - 键在但形态不对：**本步**的正对面。若这时还只删键，本步就成了残缺条目的生产者。
  //
  // 改坏方向：把缺席也升级成删整条（回到 S3 任务书原文），本条立刻红——用户手改坏一次配置，
  // 升级就把他的频道连 name 一起删掉，而他在设置页里从头到尾见过它。
  it("判别力 #3：手改出来的残缺条目（必填键缺席）原样保留，与形态不符的处置分界清晰", () => {
    const absent = [
      { type: "bark", id: "bark:no-url", deviceKey: "k", name: "缺 baseUrl" },
      { type: "bark", id: "bark:no-key", baseUrl: "https://x", name: "缺 deviceKey" },
      { type: "webhook", id: "h:no-url", name: "缺 url" },
    ];
    const out = clean({ channels: [BROWSER, SYSTEM, BARK, ...absent] });
    // 三条半坏条目逐字留着（BARK 是完好的对照），一条都没少。
    expect(out.channels).toEqual([BROWSER, SYSTEM, BARK, ...absent]);
  });

  // 判别力（硬要求 #3 的第二半）：必填键**空串**同样原样保留。
  //
  // 空串走的是「形态合法」那一条路（`typeof "" === "string"`），所以它与「形态不符」的处置天然分开——
  // 删键逻辑压根不看它。这条把它钉住：改坏方向是「把空串也算成形态不符」，症状是用户把凭据清空后
  // 升级，那条频道连同 name 一起消失。
  it("判别力 #3 续：必填键空串逐字保留（空串是合法形态，不是形态不符）", () => {
    const empties = [
      { type: "bark", id: "bark:e1", baseUrl: "", deviceKey: "k", name: "地址空串" },
      { type: "bark", id: "bark:e2", baseUrl: "https://x", deviceKey: "", name: "凭据空串" },
      { type: "webhook", id: "h:e1", url: "", name: "钩子地址空串" },
    ];
    expect(clean({ channels: [BROWSER, SYSTEM, BARK, ...empties] }).channels).toEqual([
      BROWSER,
      SYSTEM,
      BARK,
      ...empties,
    ]);
  });

  // 判据 #7 **已反转**（#1016 残留 2）：迁移**不得**按重复身份去重。
  //
  // 原行为「重复 id 保留首条」在这里是数据销毁：升级那一刻把用户第二条频道连凭据一起从磁盘删掉，
  // 设置页上它还在（视图原样外发），而任何一次无关保存又立刻被写面 400 说「身份重复」——数据没了，
  // 理由还指向一个用户没做过的操作。issue #1016 批次 B 明禁「迁移不得静默取首项」。
  //
  // 现在的分工：写面绝对拒（用户删掉其中一条即可自救），投递投影取首项只为不再双投，两处都不改磁盘。
  it("判据 #7：重复身份的条目原样保留（迁移不得静默取首项）", () => {
    const out = clean({
      channels: [
        BROWSER,
        SYSTEM,
        { ...BARK, name: "首条" },
        { ...BARK, name: "次条" },
        { type: "webhook", id: "hook:1", url: "https://a" },
        { type: "webhook", id: "hook:1", url: "https://b" },
      ],
    });
    // 逐条都在，且次序不变：包括那两条凭据不同的 webhook（url 就是它们的凭据面）。
    expect(out.channels).toEqual([
      BROWSER,
      SYSTEM,
      { ...BARK, name: "首条" },
      { ...BARK, name: "次条" },
      { type: "webhook", id: "hook:1", url: "https://a" },
      { type: "webhook", id: "hook:1", url: "https://b" },
    ]);
  });

  // 去掉去重**不等于**跳过逐条清理：重复身份的那一条仍然要照常清陌生键，只是**不再被整条丢掉**。
  // 去掉 `seenIds` 的改法很容易顺手把第二条漏在清理之外（把 `continue` 提到了 `cleanEntry` 之前），
  // 那会让升级给磁盘留下一条带陌生键的重复条目——本条专钉这个方向。
  it("判据 #7：重复身份的那一条仍照常清陌生键（去重去掉 ≠ 跳过逐条清理）", () => {
    const out = clean({
      channels: [BROWSER, SYSTEM, BARK, { ...BARK, name: "次条", 陌生键: 1 }],
    });
    expect(out.channels).toEqual([BROWSER, SYSTEM, BARK, { ...BARK, name: "次条" }]);
  });

  // 判据 #8 的第二格（#1016 P1-1）：**在场但字段残缺**。0.2.4 割接在用户没设过任何旧键时写出的就是
  // `{type,id}`——那是「用户从没碰过这条内置」的真实磁盘形态。
  //
  // 改坏方向（回到只补整条的旧实现）：字段缺席 → 客户端按 `ch.popup === true` 判开关 → 渲染成全关，
  // 而投递投影按默认表照发，于是**界面显示全关、实际照发**。最后那条判别力用例是这道题的正脸。
  it("判据 #8 的第二格：内置条目在场但字段残缺 → 补缺席字段，值取内置默认表", () => {
    const out = clean({ channels: [{ type: "system", id: "system" }, BARK] });
    expect(channelsOnDisk(out)[0]).toEqual(BROWSER);
    expect(channelsOnDisk(out)[1]).toEqual(SYSTEM);
  });

  // 补字段只补「键不在」，不覆盖显式值：用户把内置显式关掉是在表态，抹回默认 true 是静默改写用户的输入。
  // 改坏方向（把判据写成「值不等于默认就补」）：用户关掉的系统通知在升级后自己又开了，且没有任何提示。
  it("补字段不覆盖显式值：enabled:false / popup:false 的内置条目升级后仍是 false", () => {
    const off = { type: "system", id: "system", enabled: false, popup: false };
    const out = clean({ channels: [off, BARK] });
    expect(channelsOnDisk(out)[0]).toEqual(BROWSER);
    expect(channelsOnDisk(out)[1]).toEqual({ ...off, sound: true });
  });

  // 判别力 #1（#1016 P1-1 的正脸）：**视图与投递投影对两条内置逐字段一致**。
  //
  // 这条之所以不是「补齐了就算完」：读面自 S3 起有两条通道——视图逐字外发、投递投影按默认表物化。补齐只
  // 保证磁盘上是完整形态，而「用户看到的开关」与「实际发不发」是两条通道各自的解释；它们在残缺形态上会
  // 给出相反的答案（视图全关 / 投递照发），补齐之后必须同形。
  it("判别力 #1：残缺的内置条目清理后，视图与投递投影对两条内置逐字段一致", () => {
    const stored = clean({
      channels: [BARK, { type: "browser", id: "browser" }, { type: "system", id: "system" }],
    }) as StoredSettings;
    const shown = channelsOf(projectForView(stored));
    // 投递投影按已知键物化成 `ChannelConfig` 联合；本用例只比**字段值**，故按原始记录读（两侧口径相同）。
    const sent = normalizeConfig(stored).channels as unknown as Array<
      Record<string, RawSettingValue>
    >;
    for (const type of ["browser", "system"]) {
      const one = shown.find((channel) => channel.type === type);
      const other = sent.find((channel) => channel.type === type);
      expect(one, type).toBeDefined();
      expect(other, type).toBeDefined();
      for (const field of ["enabled", "popup", "sound", "whenVisible"] as const) {
        // 两边都没有这个键时跳过（system 本来就没有 whenVisible——「都不给」仍是一致的）。
        if (one?.[field] === undefined && other?.[field] === undefined) continue;
        expect(one?.[field], type + "." + field).toBe(other?.[field]);
      }
    }
  });
  it("判据 #8：两条内置缺哪补哪，且恒排在最前", () => {
    const onlySystem = clean({ channels: [SYSTEM, BARK] });
    expect(channelsOnDisk(onlySystem)[0]).toEqual({
      type: "browser",
      id: "browser",
      enabled: true,
      popup: true,
      sound: true,
      whenVisible: false,
    });
    const none = clean({ channels: [BARK] });
    expect(channelsOnDisk(none).slice(0, 2)).toEqual([
      {
        type: "browser",
        id: "browser",
        enabled: true,
        popup: true,
        sound: true,
        whenVisible: false,
      },
      { type: "system", id: "system", enabled: true, popup: true, sound: true },
    ]);
  });

  // 判据方向的反面：合法但**非默认**的取值一个字都不许动。写面「拒新增、不动存量」的语义是 S2 立的，
  // 本步若把它们当脏值清掉，用户配的东西会无声消失——那是本步能造成的最贵的一次错误。
  //
  // 两条尺寸上界取自 src/shared/config-schema.ts（与写面同一个事实源）：本步判的是「这个值在
  // 本版本有没有这种**形态**」，尺寸不属于形态，故贴着上界的取值同样一个字不动。抄一份数字就等于
  // 测试里另开一处第二事实源——上界改了而这里没改，断言就从「判不清理」退化成「判恰好没变的常量」。
  it("合法但非默认的取值**不清理**：满配的 levels / 贴上界的 template / 过头名 / 凭据空串", () => {
    const levels = Object.fromEntries(
      Array.from({ length: BARK_LEVELS_LIMIT }, (_unused, index) => [`kind-${index}`, "passive"]),
    );
    const bark = { ...BARK, levels };
    const hook = {
      ...HOOK,
      template: "x".repeat(WEBHOOK_TEMPLATE_MAX_CHARS),
      headerName: "X-Very-Long-Custom-Header-Name",
      password: "",
    };
    const out = clean({ channels: [BROWSER, SYSTEM, bark, hook] });
    expect(out.channels).toEqual([BROWSER, SYSTEM, bark, hook]);
  });

  // 判别力 #4：干净形态重跑一个字不写。这里用**压缩格式**种文件——重新序列化必然带缩进，
  // 于是「白写一次」会以字节差异暴露，而不是以「内容一样」蒙过去。
  it("判别力 #4：干净形态返回 null、一个字不写（连缩进都不变）", () => {
    const before = JSON.stringify({
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
        BARK,
        HOOK,
      ],
      notifyAsk: true,
      historyMaxAgeDays: 30,
      quietHours: { enabled: true, windows: [{ start: "22:00", end: "08:00" }] },
    });
    seedRaw(before);

    migrateCanonicalKeys();

    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);
  });

  // 幂等：清理跑过一遍之后再跑一遍，第二个字都不写——链在「每步成功后立刻回写刻度」的骨架下要求
  // 每一步自身可重入（失败后从同一步重跑），而每次启动都重写文件就是静默改写用户的格式。
  it("判别力 #4：同一份输入连跑两次，第二次不写盘（幂等）", () => {
    isolatedHome();
    writeTextAtomicSync(
      notifierFile(CONFIG_FILE_NAME),
      `${JSON.stringify({ channels: [SYSTEM, { ...BARK, level: "urgent", volume: 5 }] }, null, 2)}\n`,
    );

    migrateCanonicalKeys();
    const afterFirst = readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8");

    migrateCanonicalKeys();

    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(afterFirst);
  });

  it("没有配置文件：不凭空建一份（默认值被读成「用户改过」是另一条语义的反面）", () => {
    isolatedHome();

    migrateCanonicalKeys();

    expect(existsSync(notifierFile(CONFIG_FILE_NAME))).toBe(false);
  });

  it("空配置：一个键都没有的文件逐字不动", () => {
    seedRaw("{}\n");

    migrateCanonicalKeys();

    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe("{}\n");
  });

  it("坏 JSON：不抛，文件逐字不动（一份读不动的文件不该让启动失败）", () => {
    seedRaw("{ 坏掉的\n");

    expect(() => migrateCanonicalKeys()).not.toThrow();
    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe("{ 坏掉的\n");
  });

  // 同源守卫：本步的顶层键集、字段形态表、补齐的内置默认值都派生自共享表 / 默认表，
  // 派生点写错一处，用户配置会在升级里**静默消失**。三条断言各钉一个派生点。
  it("同源守卫：顶层键集与共享表的默认值键集同源（DEFAULTS 加 channels，一个不多一个不少）", () => {
    const stored: Record<string, unknown> = { channels: [BROWSER, SYSTEM] };
    for (const [key, value] of Object.entries(DEFAULTS)) stored[key] = value;
    const out = clean(stored);
    expect(Object.keys(out).sort()).toEqual([...Object.keys(DEFAULTS), "channels"].sort());
  });

  it("同源守卫：出站字段形态表**覆盖**两张已知键表的全部键（否则新增字段静默不过形态清理）", () => {
    // 每张已知键表都取一个**合法值**种进条目：清理后逐字不变，就证明该键既没被当成陌生键删掉、
    // 也没被形态表判成非法。加字段却忘了进形态表时，这一条会以「键消失」打红。
    const bark = {
      ...BARK,
      enabled: true,
      level: "active",
      levels: { error: "critical" },
      group: "g",
      sound: "ding",
      icon: "i",
      url: "https://u",
      badge: 0,
      timeoutMs: 1,
      name: "n",
    };
    const hook = {
      ...HOOK,
      enabled: true,
      preset: "custom",
      auth: "bearer",
      token: "t",
      username: "u",
      password: "p",
      headerName: "X",
      headerValue: "v",
      template: "{}",
      headers: { "X-A": "1" },
      timeoutSec: 10,
      name: "n",
    };
    expect(Object.keys(bark).sort()).toEqual([...BARK_KNOWN_KEYS].sort());
    expect(Object.keys(hook).sort()).toEqual([...WEBHOOK_KNOWN_KEYS].sort());
    expect(clean({ channels: [BROWSER, SYSTEM, bark, hook] }).channels).toEqual([
      BROWSER,
      SYSTEM,
      bark,
      hook,
    ]);
  });

  it("同源守卫：补齐的内置条目与默认表里的那两条逐字相等（防它与 config 域的默认表漂）", () => {
    const out = clean({ channels: [BARK] });
    expect(channelsOnDisk(out).slice(0, 2)).toEqual(DEFAULT_CONFIG.channels);
  });

  // 同源守卫（#1016 单一事实源，硬要求 #4）：清理步的**必填键**逐条读 shared 的 REQUIRED_KEYS。
  //
  // 这条断言的形状是「数据驱动」而不是「抄一份清单」：它遍历 REQUIRED_KEYS 的每一项，给那个键种一个
  // 形态不对的值，断言**整条消失**。改坏方向有两类，两类都红：
  //   ① 清理步退回自维护一份必填键清单而它与 REQUIRED_KEYS 漂了 → 本条某个键种进去却留着；
  //   ② 清理步把「必填键形态不符」又退回「只删键」 → 条目还在（且少了那个键），本条红。
  // 反向也成立：REQUIRED_KEYS 新增一个键时本条自动跟着走，不需要改这里——**这正是单一来源的形状**。
  it("同源守卫：必填键逐条读 shared 的 REQUIRED_KEYS（清单漂了或退回删键都红）", () => {
    for (const [type, keys] of Object.entries(REQUIRED_KEYS)) {
      for (const key of keys) {
        const seed: Record<string, unknown> = {
          type,
          id: type + ":" + key,
          name: "种子 " + key,
        };
        // 另一种类型不会带的键补齐成合法值，让本条只测「那个键形态不符」这一个变量。
        for (const other of keys) if (other !== key) seed[other] = "ok";
        seed[key] = 12345;
        const out = clean({ channels: [BROWSER, SYSTEM, seed] });
        expect(
          channelsOnDisk(out).map((c) => c.id),
          type + "." + key + " 值形态不符时整条应消失",
        ).toEqual([BROWSER.id, SYSTEM.id]);
      }
    }
  });

  // 同源守卫（#1016 单一事实源，硬要求 #4 的另一半）：**取值域必填键**逐条读 shared 的
  // VALUE_DOMAIN_REQUIRED_KEYS，形状与上一条对 REQUIRED_KEYS 的守卫同款。
  //
  // 种子条目只种**被测的那一个键**，同表里其它取值域必填键一律缺席——缺席是判据 #6 那一侧（保留），
  // 于是本条只测「那个键值不在取值域」这一个变量。改坏方向仍是两类：清理步退回自维护一份清单而它与
  // shared 漂了（某个键种进去却留着），或把这一格退回「只删键」（条目还在，且少了那个键）。
  it("同源守卫：取值域必填键逐条读 shared 的 VALUE_DOMAIN_REQUIRED_KEYS（清单漂了或退回删键都红）", () => {
    for (const [type, keys] of Object.entries(VALUE_DOMAIN_REQUIRED_KEYS)) {
      for (const key of keys) {
        const seed: Record<string, unknown> = { type, id: type + ":" + key, name: "种子 " + key };
        seed[key] = 12345;
        const out = clean({ channels: [BROWSER, SYSTEM, seed] });
        expect(
          channelsOnDisk(out).map((channel) => channel.id),
          type + "." + key + " 值不在取值域时整条应消失",
        ).toEqual([BROWSER.id, SYSTEM.id]);
      }
    }
  });

  // 同源守卫（硬要求 #4 的另一半）：**数值边界**也读 shared，不在本域另抄。
  //
  // 清理步的后果是删用户的键，所以「合法形态」的定义必须与读面/写面同源。这三条各钉一个曾经抄过的地方：
  // historyMaxAgeDays 上界、bark timeoutMs 上界、webhook timeout 区间。
  //
  // 改坏方向：把任一边改小 → 界内取值被当成越界删掉（用户的合法配置静默消失）；改大 → 越界值留在
  // 磁盘上，此后每次保存都被写面拒。本条双向都拦得住，因为断言的是「界内不动、界外删」。
  it("同源守卫：数值边界读 shared（界内取值不删、超出即删，两侧同源）", () => {
    // historyMaxAgeDays：上界与越一格。
    expect(clean({ channels: [BARK], historyMaxAgeDays: HISTORY_MAX_AGE_DAYS_LIMIT })).toEqual(
      expect.objectContaining({ historyMaxAgeDays: HISTORY_MAX_AGE_DAYS_LIMIT }),
    );
    expect(
      Object.hasOwn(
        clean({ channels: [BARK], historyMaxAgeDays: HISTORY_MAX_AGE_DAYS_LIMIT + 1 }),
        "historyMaxAgeDays",
      ),
    ).toBe(false);
    // bark timeoutMs：上界与越一格。
    expect(
      clean({ channels: [BROWSER, SYSTEM, { ...BARK, timeoutMs: BARK_TIMEOUT_MS_LIMIT }] })
        .channels,
    ).toEqual([BROWSER, SYSTEM, { ...BARK, timeoutMs: BARK_TIMEOUT_MS_LIMIT }]);
    expect(
      Object.hasOwn(
        channelsOnDisk(
          clean({ channels: [BROWSER, SYSTEM, { ...BARK, timeoutMs: BARK_TIMEOUT_MS_LIMIT + 1 }] }),
        )[2],
        "timeoutMs",
      ),
    ).toBe(false);
    // webhook timeoutSec：区间两端与区间外。
    for (const bound of [WEBHOOK_TIMEOUT.min, WEBHOOK_TIMEOUT.max]) {
      expect(
        clean({ channels: [BROWSER, SYSTEM, { ...HOOK, timeoutSec: bound }] }).channels,
      ).toEqual([BROWSER, SYSTEM, { ...HOOK, timeoutSec: bound }]);
    }
    expect(
      Object.hasOwn(
        channelsOnDisk(
          clean({ channels: [BROWSER, SYSTEM, { ...HOOK, timeoutSec: WEBHOOK_TIMEOUT.max + 1 }] }),
        )[2],
        "timeoutSec",
      ),
    ).toBe(false);
  });

  // 同源守卫（硬要求 #4 的第三半）：**枚举**取值域读 shared。
  //
  // level / auth / preset 三张表都在 shared（与写面、客户端设置页共用）。清理步若另抄一份，用户在设置页
  // 选得到的值会被升级当成非法删掉——症状是「设置页里能选，升级后没声了」。
  it("同源守卫：枚举取值域读 shared（白名单内的逐字保留、表外的删键）", () => {
    const bark = { ...BARK, level: BARK_LEVELS[BARK_LEVELS.length - 1] };
    const hook = {
      ...HOOK,
      auth: WEBHOOK_AUTHS[WEBHOOK_AUTHS.length - 1],
      preset: WEBHOOK_PRESETS[WEBHOOK_PRESETS.length - 1],
    };
    expect(clean({ channels: [BROWSER, SYSTEM, bark, hook] }).channels).toEqual([
      BROWSER,
      SYSTEM,
      bark,
      hook,
    ]);
    // 表外取值：删键但**条目留着**——level / preset 都不是必填键。auth 刻意不在这半边：它是取值域必填键，
    const out = clean({
      channels: [
        BROWSER,
        SYSTEM,
        { ...BARK, level: "nope" },
        { ...HOOK, id: "h:2", preset: "nope" },
      ],
    });
    expect(channelsOnDisk(out).slice(2)).toEqual([
      { type: "bark", id: "bark:1", baseUrl: "https://x", deviceKey: "k" },
      { type: "webhook", id: "h:2", url: "https://y" },
    ]);
  });
});

describe("旧文件归位", () => {
  it.each(ENTRIES)(
    "%s 搬成新布局的 %s：内容逐字保留，旧文件改名留痕",
    (legacyName, targetName, text) => {
      isolatedHome();
      writeLegacy(legacyName, text);

      migrateStorageLayout();

      expect(readFileSync(notifierFile(targetName), "utf8")).toBe(text);
      expect(existsSync(legacyFile(legacyName))).toBe(false);
      expect(readFileSync(`${legacyFile(legacyName)}.migrated.bak`, "utf8")).toBe(text);
    },
  );

  it("没有旧文件时也把初始形态落定（目标不存在会让「这一份处理过了」的判据永远不成立）", () => {
    isolatedHome();
    migrateStorageLayout();

    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe("");
    expect(readFileSync(notifierFile(STATUS_FILE_NAME), "utf8")).toBe("{}\n");
    // 序号文件的初始形态与流侧落盘同形（流侧写 `${seq}\n`）：首次读取要得到 0。
    expect(readFileSync(notifierFile(SEQ_FILE_NAME), "utf8")).toBe("0\n");
  });

  it("目标已存在时只归档旧文件、不覆盖目标（用户可能已经在新位置改过东西，拿历史盖回去就是用旧盖新）", () => {
    const home = isolatedHome();
    mkdirSync(dirname(notifierFile(HISTORY_FILE_NAME)), { recursive: true });
    writeFileSync(notifierFile(HISTORY_FILE_NAME), '{"ts":99}\n', "utf8");
    writeLegacy("dsh-notifier-history.jsonl", '{"ts":1}\n');

    migrateStorageLayout();

    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":99}\n');
    expect(readFileSync(`${legacyFile("dsh-notifier-history.jsonl")}.migrated.bak`, "utf8")).toBe(
      '{"ts":1}\n',
    );
    expect(readdirSync(home)).toContain("dsh-notifier-history.jsonl.migrated.bak");
  });

  it("重跑不累积归档名（旧文件第一次就改成了固定后缀，第二次已无源文件可归档）", () => {
    const home = isolatedHome();
    writeLegacy("dsh-notifier-history.jsonl", '{"ts":1}\n');

    migrateStorageLayout();
    migrateStorageLayout();

    expect(readdirSync(home).filter((name) => name.endsWith(".migrated.bak"))).toEqual([
      "dsh-notifier-history.jsonl.migrated.bak",
    ]);
    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":1}\n');
  });

  it("旧文件读不出来即抛（迁移没做完而启动照常，等于让各域按错误的形态去读数据）", () => {
    isolatedHome();
    // 同名目录：路径存在但没有可读内容——「搬不动」不能被当成「没有旧数据」。
    mkdirSync(legacyFile("dsh-notifier-history.jsonl"), { recursive: true });

    expect(() => migrateStorageLayout()).toThrow(/旧存储文件不可读/u);
  });

  // 归档是「这一份处理过了」的标记：改名失败却继续，旧数据就悬在两套布局之间（新位置有了副本，
  // 归档标记却没有），而用户看到的是「迁移成功」。
  it("旧文件改名失败即抛（归档没成功就不能算这一步做完了）", () => {
    isolatedHome();
    const legacy = legacyFile("dsh-notifier-history.jsonl");
    writeLegacy("dsh-notifier-history.jsonl", '{"ts":1}\n');
    // 归档目标被非空目录占住：rename 覆盖不了它。
    mkdirSync(`${legacy}.migrated.bak`, { recursive: true });
    writeFileSync(join(`${legacy}.migrated.bak`, "占位"), "", "utf8");

    expect(() => migrateStorageLayout()).toThrow(/旧存储文件改名失败/u);
  });
});
