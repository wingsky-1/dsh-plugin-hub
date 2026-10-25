/**
 * dsh-notifier upgrade 域 steps 块 —— canonical-keys 的 shared 派生面守卫。
 *
 * 判据面与执行机制完整迁移自原 steps.test.ts 的同源守卫自然块；隔离根与清理时序保持不变。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  BARK_KNOWN_KEYS,
  BARK_LEVELS,
  BARK_TIMEOUT_MS_LIMIT,
  DEFAULTS,
  HISTORY_MAX_AGE_DAYS_LIMIT,
  REQUIRED_KEYS,
  VALUE_DOMAIN_REQUIRED_KEYS,
  WEBHOOK_AUTHS,
  WEBHOOK_KNOWN_KEYS,
  WEBHOOK_PRESETS,
  WEBHOOK_TIMEOUT,
} from "../../../src/shared/interface.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import {
  BARK,
  BROWSER,
  HOOK,
  SYSTEM,
  channelsOnDisk,
  clean,
  cleanups,
} from "./upgrade-steps-support.ts";

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

describe("配置形态清理（canonical-keys）", describeCanonicalKeysSharedGuards);
function describeCanonicalKeysSharedGuards() {
  it(
    "同源守卫：顶层键集与共享表的默认值键集同源（DEFAULTS 加 channels，一个不多一个不少）",
    canonicalTest28,
  );

  it(
    "同源守卫：出站字段形态表**覆盖**两张已知键表的全部键（否则新增字段静默不过形态清理）",
    canonicalTest29,
  );

  it(
    "同源守卫：补齐的内置条目与默认表里的那两条逐字相等（防它与 config 域的默认表漂）",
    canonicalTest30,
  );

  it("同源守卫：必填键逐条读 shared 的 REQUIRED_KEYS（清单漂了或退回删键都红）", canonicalTest31);

  it(
    "同源守卫：取值域必填键逐条读 shared 的 VALUE_DOMAIN_REQUIRED_KEYS（清单漂了或退回删键都红）",
    canonicalTest32,
  );

  it("同源守卫：数值边界读 shared（界内取值不删、超出即删，两侧同源）", canonicalTest33);

  it("同源守卫：枚举取值域读 shared（白名单内的逐字保留、表外的删键）", canonicalTest34);
}

function canonicalTest28() {
  const stored: Record<string, unknown> = { channels: [BROWSER, SYSTEM] };
  for (const [key, value] of Object.entries(DEFAULTS)) stored[key] = value;
  const out = clean(stored);
  expect(Object.keys(out).sort()).toEqual([...Object.keys(DEFAULTS), "channels"].sort());
}

function canonicalTest29() {
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
}

function canonicalTest30() {
  const out = clean({ channels: [BARK] });
  expect(channelsOnDisk(out).slice(0, 2)).toEqual(DEFAULT_CONFIG.channels);
}

// 同源守卫（#1016 单一事实源，硬要求 #4）：清理步的**必填键**逐条读 shared 的 REQUIRED_KEYS。
//
// 这条断言的形状是「数据驱动」而不是「抄一份清单」：它遍历 REQUIRED_KEYS 的每一项，给那个键种一个
// 形态不对的值，断言**整条消失**。改坏方向有两类，两类都红：
//   ① 清理步退回自维护一份必填键清单而它与 REQUIRED_KEYS 漂了 → 本条某个键种进去却留着；
//   ② 清理步把「必填键形态不符」又退回「只删键」 → 条目还在（且少了那个键），本条红。
// 反向也成立：REQUIRED_KEYS 新增一个键时本条自动跟着走，不需要改这里——**这正是单一来源的形状**。
function canonicalTest31() {
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
}

// 同源守卫（#1016 单一事实源，硬要求 #4 的另一半）：**取值域必填键**逐条读 shared 的
// VALUE_DOMAIN_REQUIRED_KEYS，形状与上一条对 REQUIRED_KEYS 的守卫同款。
//
// 种子条目只种**被测的那一个键**，同表里其它取值域必填键一律缺席——缺席是判据 #6 那一侧（保留），
// 于是本条只测「那个键值不在取值域」这一个变量。改坏方向仍是两类：清理步退回自维护一份清单而它与
// shared 漂了（某个键种进去却留着），或把这一格退回「只删键」（条目还在，且少了那个键）。
function canonicalTest32() {
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
}

// 同源守卫（硬要求 #4 的另一半）：**数值边界**也读 shared，不在本域另抄。
//
// 清理步的后果是删用户的键，所以「合法形态」的定义必须与读面/写面同源。这三条各钉一个曾经抄过的地方：
// historyMaxAgeDays 上界、bark timeoutMs 上界、webhook timeout 区间。
//
// 改坏方向：把任一边改小 → 界内取值被当成越界删掉（用户的合法配置静默消失）；改大 → 越界值留在
// 磁盘上，此后每次保存都被写面拒。本条双向都拦得住，因为断言的是「界内不动、界外删」。
function canonicalTest33() {
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
    clean({ channels: [BROWSER, SYSTEM, { ...BARK, timeoutMs: BARK_TIMEOUT_MS_LIMIT }] }).channels,
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
    expect(clean({ channels: [BROWSER, SYSTEM, { ...HOOK, timeoutSec: bound }] }).channels).toEqual(
      [BROWSER, SYSTEM, { ...HOOK, timeoutSec: bound }],
    );
  }
  expect(
    Object.hasOwn(
      channelsOnDisk(
        clean({ channels: [BROWSER, SYSTEM, { ...HOOK, timeoutSec: WEBHOOK_TIMEOUT.max + 1 }] }),
      )[2],
      "timeoutSec",
    ),
  ).toBe(false);
}

// 同源守卫（硬要求 #4 的第三半）：**枚举**取值域读 shared。
//
// level / auth / preset 三张表都在 shared（与写面、客户端设置页共用）。清理步若另抄一份，用户在设置页
// 选得到的值会被升级当成非法删掉——症状是「设置页里能选，升级后没声了」。
function canonicalTest34() {
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
    channels: [BROWSER, SYSTEM, { ...BARK, level: "nope" }, { ...HOOK, id: "h:2", preset: "nope" }],
  });
  expect(channelsOnDisk(out).slice(2)).toEqual([
    { type: "bark", id: "bark:1", baseUrl: "https://x", deviceKey: "k" },
    { type: "webhook", id: "h:2", url: "https://y" },
  ]);
}
