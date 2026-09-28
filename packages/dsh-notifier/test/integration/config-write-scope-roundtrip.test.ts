/**
 * dsh-notifier —— 写面范围（#1016 批次 B 使能面）的**端到端往返**判据。
 *
 * 为什么单独一个文件、单独一层：这条机制的全部价值挂在一条**跨端不变量**上——
 * 「用户没改过的字段必须读成原样带回」。这条不变量只有在**真实往返链**上才成立，而单侧测
 * 两侧都测不出：写面的基线取磁盘原样时，客户端交回的每一个归一化产物（补的默认值、剥掉的
 * 空串、钳制过的越界值、搬进 extras 的陌生键）都会被读成「本次改动」，而单看写面它自洽、
 * 单看客户端它也自洽。本文件把两侧接起来，让不变量有地方可断。
 *
 * 链路与真客户端逐段对应（行号对 `src/client/index.tsx` / `src/client/settings/diff.ts` /
 * `src/server/config/impl/service/index.ts`）：
 *   磁盘 → normalizeConfig（读面 effective）→ redactConfig（GET /config 外发）
 *        → snapshotBaseline（loadCard 建基线与草稿）→ 用户改一个字段（assignChannelFields）
 *        → diffSettingsPayload（保存时算增量）→ unmaskChannels（写面还原凭据）
 *        → validateSettingsWithBase（写面判据，带存量基线）
 *
 * 判据：只改一个字段 ⇒ **只有**那一个字段 isEdited=true。基线取错侧（磁盘原样 / 裸 effective）
 * 会让同一条断言多出 3~8 个字段，判红（逐形态读数见 service 域 `apply` 注释里那张表）。
 *
 * 无文件系统、无网络、不碰 DSH_HOME：本文件只跑纯函数，落盘纪律不适用。
 */
import { describe, expect, it } from "vitest";

import { canonicalChannelsForCompare } from "../../src/shared/interface.ts";
import {
  normalizeConfig,
  sanitizeSettings,
  validateSettings,
  validateSettingsWithBase,
} from "../../src/server/config/impl/input/index.ts";
import type {
  RawSettingValue,
  SettingsPatch,
  StoredSettings,
} from "../../src/server/config/impl/model/type.ts";
import { redactConfig, unmaskChannels } from "../../src/server/config/impl/redact/index.ts";
import {
  assignChannelFields,
  diffSettingsPayload,
  snapshotBaseline,
} from "../../src/client/settings/diff.ts";
import type { ChannelWriteScope } from "../../src/server/config/impl/input/type.ts";

/** 合法 bark：写面要求 id / baseUrl / deviceKey 非空。 */
const BARK = { type: "bark", baseUrl: "https://api.day.app", deviceKey: "key-1" };

/**
 * 合法 webhook：凭据四个键**都**在磁盘上。
 *
 * 为什么不能只写 url：读面归一化会给缺失的凭据补空串，读出口再把空串掩码成掩码占位，客户端
 * 原样带回时写面按 id 找原值找不到（磁盘那条本来就没这个键）→ 掩码还原失败。这是真实存在的一条
 * 既有行为（与本机制无关），本文件要的是「一条顺利走完的往返」，故从磁盘形态上避开。
 */
const HOOK = {
  type: "webhook",
  url: "https://example.test/hook",
  token: "tok",
  username: "u",
  password: "p",
  headerName: "X-Key",
  headerValue: "hv",
};

/** 一次真实往返的结果。 */
type RoundTrip = {
  /** 提交上来的频道数组（掩码还原之后，即写面判据真正看到的那份）。 */
  readonly submitted: readonly RawSettingValue[];
  /** 被改的那一条在提交里的形态（下标 0 恒是内置 browser，按 id 取不要按下标）。 */
  readonly incoming: Record<string, RawSettingValue>;
  /** 写面判据给出的范围面。 */
  readonly scope: ChannelWriteScope;
  /** 该 id 下被判为「本次改动」的字段全集。 */
  readonly edited: readonly string[];
  /** 判据结论；机制不改变它（与不带基线时逐字相同）。 */
  readonly verdictOk: boolean;
};

/**
 * 走一遍真实往返链：磁盘 → … → 写面判据。
 *
 * @param disk 磁盘上的配置文件内容（原样，未经净化/归一化）。
 * @param editId 用户改的是哪条频道。
 * @param part 用户在界面上改的字段（其余一律原样）。
 */
function roundTrip(disk: StoredSettings, editId: string, part: Record<string, unknown>): RoundTrip {
  // 读面：净化得用户层（掩码还原的原值来源）、归一化得生效设置（视图外发的内容）。
  const user = sanitizeSettings(disk);
  const effective = normalizeConfig(disk);
  // GET /config 外发的 effective（凭据掩码）→ 客户端建基线与草稿（loadCard）。
  const snapshot = snapshotBaseline(redactConfig(effective) as unknown as Record<string, unknown>);
  const draft = Object.assign({}, snapshot) as Record<string, unknown>;
  // 用户改一个字段：逐段照搬 chPatch（index.tsx:1294）——先 slice 出新数组再改单项。
  // 这一步不能图省事就地改：loadCard 的草稿是基线的**浅**拷贝，两边共用同一个 channels 数组，
  // 就地改会把基线一起改掉，于是 diff 恒等、永远提交不出 channels。
  const list = (draft.channels as Array<Record<string, unknown>>).slice();
  const index = list.findIndex((item) => item.id === editId);
  if (index < 0) throw new Error(`磁盘形态里没有 id=${editId} 的频道`);
  list[index] = assignChannelFields(list[index], part);
  draft.channels = list;

  // 保存：整组提交（改任一字段都会把 channels 整组带上）。
  const payload = diffSettingsPayload(draft, snapshot);
  if (!Array.isArray(payload.channels)) throw new Error("改了频道却没有产生 channels 提交");
  const restored = unmaskChannels(payload.channels as RawSettingValue, user.channels);
  if (!restored.ok) throw new Error("掩码还原失败（链路上少了一环或磁盘形态选得不对）");
  const submitted = restored.channels as readonly RawSettingValue[];

  // 写面：基线 = 客户端看过的那份视图（service 域 baseChannels），明文。
  const base = canonicalChannelsForCompare(effective.channels) as RawSettingValue;
  const checked = validateSettingsWithBase(
    { channels: submitted as RawSettingValue[] } as SettingsPatch,
    base,
  );

  // 判为本次改动的字段全集：两侧出现过的键都问一遍（存量的键被抹掉也算一次真改动）。
  const incoming = submitted.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as { id?: unknown }).id === editId,
  ) as Record<string, RawSettingValue>;
  if (incoming === undefined) throw new Error(`提交里没有 id=${editId} 的频道`);
  const baseChannel = (base as Array<Record<string, RawSettingValue>>).find(
    (item) => item.id === editId,
  );
  const fields = new Set([
    ...Object.keys(incoming),
    ...(baseChannel ? Object.keys(baseChannel) : []),
  ]);
  return {
    submitted,
    incoming,
    scope: checked.scope,
    edited: [...fields].filter((field) => checked.scope.isEdited(editId, field)).sort(),
    verdictOk: checked.verdict.ok,
  };
}

/**
 * 机制的地基：只改一个字段 ⇒ 只有那一个字段算本次改动。
 *
 * 逐形态断言，两侧都断：既断「真改动没被认出来」（判成原样带回 = 漏拒），也断
 * 「没改的被认成改动」（判成本次改动 = 过度拒绝，把人锁死在设置页外面）。
 */
describe("写面范围：真实往返链上「只改一个字段就只有那一个字段算改动」", () => {
  // 形态一：最普通的一份 bark —— 磁盘上只有 id/type/baseUrl/deviceKey 四个键。
  // 客户端交回的 enabled/timeoutMs/levels 三个键是**读面归一化补出来的**，用户从没碰过。
  // 基线取磁盘原样时这三个键必被判成本次改动（实测：还多出 levels 这类补值）。
  it("最普通的 bark：用户只改名字，enabled/timeoutMs/levels 三个磁盘上不存在的键不算改动", () => {
    const trip = roundTrip({ channels: [{ id: "bark:1", ...BARK }] }, "bark:1", { name: "手机" });
    expect(trip.verdictOk).toBe(true);
    expect(trip.incoming).toMatchObject({ name: "手机" });
    // 前提事实：这三个键确实在提交里、确实不在磁盘上——它们是归一化补出来的。
    const submitted = trip.incoming;
    expect(submitted.enabled).toBe(false);
    expect(submitted.timeoutMs).toBe(0);
    expect(submitted.levels).toEqual({});
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态二：webhook。归一化补的默认值换成 auth/preset/headers/timeoutSec 四个，
  // 且读面会给缺失的可选字段补空串、客户端提交前又把空串剥掉（template 就是这样没的）。
  it("webhook：用户只改名字，auth/preset/headers/timeoutSec 与被剥掉的空串都不算改动", () => {
    const trip = roundTrip({ channels: [{ id: "hook:1", ...HOOK }] }, "hook:1", {
      name: "群机器人",
    });
    expect(trip.verdictOk).toBe(true);
    const submitted = trip.incoming;
    // 前提事实：归一化补的默认值在提交里（客户端比较规范形补的）。
    expect(submitted.auth).toBe("none");
    expect(submitted.preset).toBe("custom");
    expect(submitted.headers).toEqual({});
    expect(submitted.timeoutSec).toBe(0);
    // template 在磁盘上没有 → 读面补空串 → 客户端剥掉 → 两侧同时没有它，不该算改动。
    expect("template" in submitted).toBe(false);
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态三：磁盘上残留空串（0.2.2 保存失败前 / 手改 yaml / 旧版本留下的形态）。
  // 读面把空串当「未配置」剥掉、客户端提交前也剥；基线若不跟着剥，同一批空串全是假阳性。
  it("残留空串：name/group/sound/icon/url 在磁盘上都是空串，客户端剥掉后不算改动", () => {
    const trip = roundTrip(
      { channels: [{ id: "bark:1", ...BARK, name: "", group: "", sound: "", icon: "", url: "" }] },
      "bark:1",
      { name: "手机" },
    );
    expect(trip.verdictOk).toBe(true);
    const submitted = trip.incoming;
    for (const key of ["group", "sound", "icon", "url"]) {
      expect(key in submitted, key).toBe(false);
    }
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态四：**越界值被钳制**。磁盘 timeoutMs:999999 越界，读面 asCount 钳回 0，客户端把 0
  // 交回来。基线取磁盘原样时这一项被判成「用户刚把它设成 0」——后续的边界值判据会据此
  // 拒掉一次根本没碰过它的保存，是这批形态里最毒的一条。
  it("越界值被钳制：磁盘 timeoutMs:999999，用户没碰过它，提交里的 0 不算本次改动", () => {
    const trip = roundTrip(
      { channels: [{ id: "bark:1", ...BARK, timeoutMs: 999_999 }] },
      "bark:1",
      { name: "手机" },
    );
    expect(trip.verdictOk).toBe(true);
    // 前提事实：提交里确实是钳制后的 0。
    expect(trip.incoming.timeoutMs).toBe(0);
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态五：非法枚举被读面吃掉。磁盘 level:"urgent" 非法 → 读面不输出 level → 客户端不带它
  // 提交。基线取磁盘原样时会读成「用户刚把 level 删了」。
  it("非法枚举被归一化吃掉：磁盘 level 非法、提交里没有它，不算「用户刚删了」", () => {
    const trip = roundTrip({ channels: [{ id: "bark:1", ...BARK, level: "urgent" }] }, "bark:1", {
      name: "手机",
    });
    expect(trip.verdictOk).toBe(true);
    expect("level" in trip.incoming).toBe(false);
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态六：陌生键搬进 extras。磁盘顶层的 myCustom 被读面收进 extras 子对象再交回来，
  // 键位从顶层迁到子对象。基线取磁盘原样时，myCustom 与 extras 两边都算「本次改动」。
  // 注：这条形态当前会被写面以「extras 只能是字符串或数字」400 拒掉（既有行为，与本机制无关，
  // 见交付的「越界发现」）。判据只断范围面，verdict 单列一行如实记着。
  it("陌生键搬进 extras：形状迁移不算本次改动（verdict 仍按今天的判据走）", () => {
    const trip = roundTrip({ channels: [{ id: "bark:1", ...BARK, myCustom: "x" }] }, "bark:1", {
      name: "手机",
    });
    expect(trip.incoming.extras).toEqual({ myCustom: "x" });
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态七：旧顶层键投影。0.2.3 之前把开关写在顶层（systemEnabled），读面物化成内置条目。
  // 磁盘上根本没有 channels 里的 system 条目，客户端交回的是物化后的那条。
  it("旧顶层键投影：内置 system 条目在磁盘上没有，客户端交回的那份不算改动", () => {
    const trip = roundTrip({ systemEnabled: true, notifySound: "default" }, "system", {
      name: "本机",
    });
    expect(trip.verdictOk).toBe(true);
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态八：半坏条目并存。磁盘上有一条 baseUrl 为空的 bark——读面丢弃它（没有投递目标的
  // 空壳），客户端草稿里压根没有它，真实往返**不会**把它带回来。基线取磁盘原样时它会以
  // 「提交里缺这条 ⇒ 删了它」的形式被算成全字段改动；取客户端那份视图时两侧同时缺席。
  it("半坏条目并存：用户改的是另一条，半坏条目既不在草稿里也不在基线里", () => {
    const disk: StoredSettings = {
      channels: [
        { id: "bark:1", ...BARK },
        { id: "bark:half", type: "bark", baseUrl: "", deviceKey: "key-half" },
      ],
    };
    // 前提事实：读面确实丢弃了它。
    expect(normalizeConfig(disk).channels.some((item) => item.id === "bark:half")).toBe(false);
    const trip = roundTrip(disk, "bark:1", { name: "手机" });
    expect(trip.submitted.some((item) => (item as { id?: string }).id === "bark:half")).toBe(false);
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态九：**凭据字段在磁盘上是空串**。读出口把空串掩码成占位，客户端原样带回占位，服务端
  // 按 id 还原成 ""——而剥空串（客户端的 stripChannelEmpties）与比较规范形（基线）都发生在
  // 掩码还原**之前**，还原把磁盘的 "" 请回来之后提交侧凭空多出 token/password/headerValue
  // 三个键，基线侧没有它们，三个假阳性一次全中。
  // **只有密钥字段会这样**：只有它们走掩码往返（CHANNEL_SECRET_FIELDS.webhook）；
  // bark 也测不到——它唯一的密钥 deviceKey 为空时整条被读面丢弃（没有投递目标的空壳），
  // 根本进不了比较。webhook 只有 url 必填，空凭据能活过归一化。
  it("webhook 磁盘凭据是空串：还原回来的 token/password/headerValue 都不算本次改动", () => {
    const trip = roundTrip(
      {
        channels: [
          {
            id: "hook:1",
            type: "webhook",
            url: "https://example.test/hook",
            token: "",
            username: "u",
            password: "",
            headerName: "X-Key",
            headerValue: "",
          },
        ],
      },
      "hook:1",
      { name: "群机器人" },
    );
    expect(trip.verdictOk).toBe(true);
    // 前提事实：掩码还原确实把磁盘的空串请回了提交侧（剥除发生在还原之前）。
    expect(trip.incoming.token).toBe("");
    expect(trip.incoming.password).toBe("");
    expect(trip.incoming.headerValue).toBe("");
    // 非密钥的凭据字段两侧都被剥掉，本来就是对的——一并钉住，免得「靠剥得更多」蒙对。
    expect(trip.incoming.username).toBe("u");
    expect(trip.incoming.headerName).toBe("X-Key");
    expect("template" in trip.incoming).toBe(false);
    expect(trip.edited).toEqual(["name"]);
  });

  // 形态十：webhook 侧的越界值与非法枚举（形态四的 webhook 对偶）：磁盘 timeoutSec:99999
  // 被读面钳回 0、preset:"nope" 被归一成 custom，两者在提交侧以归一化后的形态回来，与基线同形。
  it("webhook 越界与非法枚举被读面收敛：用户只改名字，timeoutSec/preset 不算改动", () => {
    const trip = roundTrip(
      { channels: [{ id: "hook:1", ...HOOK, timeoutSec: 99_999, preset: "nope" }] },
      "hook:1",
      { name: "群机器人" },
    );
    expect(trip.verdictOk).toBe(true);
    expect(trip.incoming.timeoutSec).toBe(0);
    expect(trip.incoming.preset).toBe("custom");
    expect(trip.edited).toEqual(["name"]);
  });
});

/**
 * 机制的第二条不变量：**它不改变任何一条现有判据结论**。
 *
 * 同一条提交，带基线与不带基线的结论必须逐字相同。有基线只是多交出一份「本次改动」信息，
 * 判据本身一个字都没多判——本 PR 是使能面，不是收紧面。
 */
describe("写面范围：带基线不改变任何一条校验结论", () => {
  it("同一条提交，带基线与不带基线的结论逐字相同（合法与非法都试）", () => {
    const cases: Array<{ label: string; patch: SettingsPatch; base: RawSettingValue }> = [
      {
        label: "合法：只改名字",
        patch: { channels: [{ id: "bark:1", ...BARK, name: "手机" }] },
        base: canonicalChannelsForCompare(
          normalizeConfig({ channels: [{ id: "bark:1", ...BARK }] }).channels,
        ) as RawSettingValue,
      },
      {
        label: "非法：level 不在白名单",
        patch: { channels: [{ id: "bark:1", ...BARK, level: "urgent" }] },
        base: canonicalChannelsForCompare(
          normalizeConfig({ channels: [{ id: "bark:1", ...BARK }] }).channels,
        ) as RawSettingValue,
      },
      {
        label: "非法：顶层计数越界",
        patch: { historyMaxAgeDays: -1 },
        base: canonicalChannelsForCompare(normalizeConfig({}).channels) as RawSettingValue,
      },
    ];
    for (const item of cases) {
      expect(validateSettingsWithBase(item.patch, item.base).verdict, item.label).toEqual(
        validateSettings(item.patch),
      );
    }
  });
});
