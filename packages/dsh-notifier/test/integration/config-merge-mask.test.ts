/**
 * dsh-notifier —— 掩码字面量的作用域、两条链路的话术与取值域必填键（#1016 S3/S4）。
 *
 * #1174 shape 拆分产物：原 test/integration/config-merge-roundtrip.test.ts 按自然职责块拆成
 * 「形态回归」与「掩码与 auth」两个测试文件，本文件只留掩码与 auth 这一族，fullName 与断言
 * 逐字保留（套件名沿用原标题）。跨文件共用的夹具在 ./config-merge-support.ts。
 *
 * 无文件系统、无网络、不碰 DSH_HOME：本文件只跑纯函数，落盘纪律不适用。
 */
import { describe, expect, it } from "vitest";

import { resolveDraftChannels } from "../../src/server/config/impl/draft/index.ts";
import type { ResolvedDraft } from "../../src/server/config/impl/draft/index.ts";
import type { RawSettingValue, StoredSettings } from "../../src/server/config/impl/model/type.ts";
import { mergeChannels } from "../../src/server/config/impl/service/merge.ts";
import type { ChannelMerge } from "../../src/server/config/impl/service/merge.ts";
import { projectForView } from "../../src/server/config/impl/service/view.ts";
import { REQUIRED_KEYS, VALUE_DOMAIN_REQUIRED_KEYS } from "../../src/shared/interface.ts";
import {
  BARK,
  BROWSER,
  HOOK,
  MASK,
  SYSTEM,
  byId,
  channelsOf,
  diskOf,
  judge,
  roundTrip,
  submitDraft,
} from "./config-merge-support.ts";
import type { Channel } from "./config-merge-support.ts";

/**
 * 掩码字面量的**跨端契约**：掩码只在密钥字段上有「未修改」的语义，在别的键上它就是一个普通字符串。
 *
 * 这一组是 #1016 收尾批两条 P2 的判据面（F1 作用域 / F2 话术归并）。分工：上面那 13 条形态判据钉
 * 「既有语义不许漂」，这一组钉「掩码字面量本身不许越界」。
 *
 * 每条都走**真实客户端链**（视图 → 基线 → 草稿 → diff → 合并 → 判据），不直调合并造形态——F1 的
 * 现场正是「客户端把八个星号原样交回来」，直调合并看不到它从哪来。
 */
describe("掩码字面量的作用域与两条链路的话术（F1 / F2）", () => {
  /** 磁盘：两条内置 + 一条 bark（带真凭据与旧名字）+ 一条 webhook（带真 token）。 */
  function maskDisk(): StoredSettings {
    return diskOf(
      { id: "bark:1", ...BARK, name: "旧名字" },
      { id: "hook:1", ...HOOK, token: "REAL-TOKEN" },
    );
  }

  /**
   * 一个情形：同一份提交面（带掩码的原始形态）分别喂给写面与 dry-run，取两边的话术。
   *
   * 提交面由 `submitDraft` 走真实链产出，于是「客户端确实把掩码原样交回来了」是链自己保证的，
   * 不是本文件手写的形态。
   */
  function bothPaths(
    disk: StoredSettings,
    editId: string,
    part: Record<string, unknown>,
  ): {
    readonly payload: readonly Channel[];
    readonly write: ChannelMerge;
    readonly dry: ResolvedDraft;
  } {
    const { payload, merged } = submitDraft(disk, editId, part);
    return {
      payload,
      write: merged,
      dry: resolveDraftChannels({ channels: payload }, channelsOf(disk)),
    };
  }

  /** 话术配对断言：两边都得拒，且**逐字**相同（toBe——含子串的写法正是当初两句漂成两句的形状）。 */
  function expectSameHint(got: ReturnType<typeof bothPaths>, label: string): string {
    expect(got.write.ok, label + " · 写面应当拒收").toBe(false);
    if (got.write.ok) throw new Error("应当拒收");
    expect(got.dry.ok, label + " · dry-run 应当拒收").toBe(false);
    if (got.dry.ok) throw new Error("dry-run 应当拒收");
    expect(got.dry.hint, label).toBe(got.write.error.hint);
    return got.write.error.hint;
  }

  // 判据 1（F1 前半）：**非密钥键上的掩码是普通值**——照写落盘，不 400、也不静默沿用存量。
  //
  // 钉的是「掩码语义的作用域」。改坏方向有两个，症状完全不同，本条同时按住：
  //   (a) 哨兵对**任意键**生效且无源即拒 → 用户把频道名写成八个星号，保存撞一句**关于凭据**的 400；
  //   (b) 哨兵对**任意键**生效且有源即 KEEP → 界面显示新名字、磁盘上是旧名字，那次改名被静默吞掉。
  // (a) 的症状是落盘值里没有 name（判据直接红），(b) 的症状是落盘值是「旧名字」（同样红）。
  it("判据 1：非密钥键写掩码 → 普通写入（既不 400，也不静默沿用存量）", () => {
    const disk = maskDisk();
    for (const key of ["name", "group", "icon"] as const) {
      const { write } = bothPaths(disk, "bark:1", { [key]: MASK });
      expect(write.ok, key).toBe(true);
      if (!write.ok) throw new Error("应当放行：" + write.error.hint);
      // 落盘就是用户写的那八个星号：不是存量沿用（(b)），也不是被吞掉（(a)）。
      expect(byId(write.channels as Channel[], "bark:1")[key], key).toBe(MASK);
    }
  });

  // 判据 1 的另一格：磁盘上**没有**这个键时同样照写——(a) 那句关于凭据的 400 正是从这一格冒出来的
  // （复核实测：磁盘 hook:1 无 name 键 + 提交 name:"********" → 写面 400、dry-run 接受）。
  it("判据 1 的另一格：存量没有该键时也照写（新频道的名字写成八个星号）", () => {
    const merged = mergeChannels(
      [
        { ...BROWSER },
        { ...SYSTEM },
        {
          id: "bark:new",
          type: "bark",
          baseUrl: "https://api.day.app",
          deviceKey: "real-key",
          name: MASK,
        },
      ] as unknown as RawSettingValue,
      diskOf().channels ?? [],
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("应当放行：" + merged.error.hint);
    expect(byId(merged.channels as Channel[], "bark:new").name).toBe(MASK);
  });

  // 判据 2（F1 后半）：掩码落在**别的 type 的密钥字段名**上 → 400，且**不是**被当普通值写进磁盘。
  //
  // 任务书点名不许省掉的那一格：只把状态 2 收窄到「本 type 的密钥字段名」时，跨 type 残留掩码会掉进
  // 第五态（普通写入）→ 占位符原样落盘，那条凭据从此报废，正是掩码工作要消灭的那件事。
  it("判据 2：跨 type 残留的密钥字段名带掩码 → 400，且不当普通值写进磁盘", () => {
    const disk = maskDisk();
    const got = bothPaths(disk, "hook:1", { deviceKey: MASK });
    // 前提事实：客户端确实把这个掩码原样交回来了（缺了它这条可能是在测别的原因）。
    expect(byId(got.payload, "hook:1").deviceKey).toBe(MASK);
    expect(got.write.ok).toBe(false);
    if (got.write.ok) throw new Error("应当拒收");
    expect(got.write.error.key).toBe("channels");
    // 关键的反向断言：不是「接受了但把占位符写进磁盘」。
    expect(JSON.stringify(got.write)).not.toContain(MASK);
  });

  // 判据 3（F1 前半的另一半）：本 type 的密钥字段带掩码 → 有源 KEEP、无源 400。
  //
  // 钉的是「掩码在密钥位上仍然表达未修改」——判据 1 把作用域收窄之后，这一格不许被顺带削掉
  // （把它也当普通值，用户每保存一次就把自己的凭据洗成八个星号）。
  it("判据 3：本 type 密钥字段带掩码 → 沿用存量原值；无源 → 400", () => {
    const disk = maskDisk();
    // 有源：沿用磁盘上的真凭据（不是掩码本身）。**改的是别的字段**——凭据位在视图里已经是掩码，
    // 「把它设成掩码」与基线相等、diff 不会产出 channels；真实链上它是被整组带出去的。
    const kept = bothPaths(disk, "hook:1", { name: "新名字" });
    expect(byId(kept.payload, "hook:1").token, "前提：提交面里凭据位是掩码").toBe(MASK);
    expect(kept.write.ok).toBe(true);
    if (!kept.write.ok) throw new Error("应当放行：" + kept.write.error.hint);
    expect(byId(kept.write.channels as Channel[], "hook:1").token).toBe("REAL-TOKEN");

    // 无源：id 改名 → 按 id 对齐取不到原值 → 400（话术与 dry-run 相同）。
    const submitted = [
      { ...BROWSER },
      { ...SYSTEM },
      { id: "bark:renamed", type: "bark", baseUrl: "https://api.day.app", deviceKey: MASK },
    ] as unknown as RawSettingValue;
    const write = mergeChannels(submitted, maskDisk().channels ?? []);
    const dry = resolveDraftChannels({ channels: submitted }, channelsOf(maskDisk()));
    expect(write.ok).toBe(false);
    expect(dry.ok).toBe(false);
    if (write.ok || dry.ok) throw new Error("应当拒收");
    expect(dry.hint).toBe(write.error.hint);
  });

  // 判据 4（F2）：写面与 dry-run 对**同一情形**给**逐字相同**的一句。
  //
  // 两条链路各自判各自的，一份提交面同时喂两边。配对覆盖两种情形——跨 type 残留，以及换型时
  // 「无源 + 残留同时成立」。最后这一种钉的是「先说哪一句」：它不许取决于 `Object.entries` 的键序
  // （那正是修复前两句分叉的成因），也不许合并成一句（判据 2 / 3 的作用域就是这么分的）。
  it("判据 4：写面与 dry-run 对同一情形给逐字相同的 hint", () => {
    const disk = maskDisk();
    const residual = expectSameHint(bothPaths(disk, "hook:1", { deviceKey: MASK }), "跨 type 残留");
    const retype = expectSameHint(
      bothPaths(disk, "hook:1", {
        type: "bark",
        baseUrl: "https://api.day.app",
        deviceKey: MASK,
        token: MASK,
      }),
      "换型（无源 + 残留同时成立）",
    );
    // 两种情形是**两句话**，不许合并成一句。
    expect(residual).not.toBe(retype);
  });

  // 判据 5（F4）：webhook 上的 deviceKey（掩码形态）是跨 type 残留，0.2.9 升级清理把它删掉——
  // 那一步是这条残留的清道夫。写面这一侧钉的是「清理之前它确实招来 400」，与 steps.test.ts 的
  // 「判据 #2 的反向格」合起来才是完整那一格：清理前有症状、清理后没键。
  it("判据 5：webhook 上的 deviceKey 掩码在清理前确实招来 400（清道夫清的就是它）", () => {
    const disk = diskOf({ id: "hook:1", ...HOOK, deviceKey: MASK });
    // 前提事实：视图把这条残留原样外发（缺了它这条就没断到东西）。
    expect(byId(projectForView(disk).channels as Channel[], "hook:1").deviceKey).toBe(MASK);
    // 用户改这条的别的字段也存不下去：整组提交把它带上，写面按跨 type 残留掩码 400。
    expect(submitDraft(disk, "hook:1", { name: "改名" }).merged.ok).toBe(false);
  });
});

/**
 * 取值域类必填键（webhook 的 `auth`）的**删除手势**：与在场必填键同一条路（#1016 写面侧）。
 *
 * 修的是**写面侧**与清理步侧（0.2.9 形态清理）同源的那条路。清理步修好之后不再造「url 齐全、只是没有
 * auth」的残缺条目了，但写面自己还留着同一个手势的另一条路：客户端把 `auth` 清空成 `null` / `""` 时，
 * 合并按「非必填键显式删除」把键 **DROP** 掉，删键造出的那条频道随即被输入闸门以「auth 非法」400 拒收。
 * 于是同一个手势有三种结局：`url` 清空说的是「url 是必填键，不能删除」，`auth` 清空说的是「auth 非法」，
 * 而用户做的事在界面上是同一个动作。
 *
 * **为什么是「按必填键处理」而不是「让合并把它写回去」**：合并只回答「这次写把这个键变成了什么」，
 * 把 `null` 悄悄改写成磁盘上的旧值，等于替用户编了一个他没填的值，而界面上仍然是空的。
 *
 * **`auth` 刻意不进 `REQUIRED_KEYS`**：那张表的每个消费方（输入闸门的「缺 X」话术、`preexisting`
 * 记账、清理步判据 #5）都按「缺席即错」在用它，`auth` 混进去会让「它的判据是取值域」这条约定消失
 * 在一个布尔标记里。合并要的是两张表的**并集**，故读两张、不合并（service/merge.ts 的 requiredKeysOf）。
 */
describe("取值域必填键 auth：清空手势与在场必填键同判", () => {
  /** 磁盘上的一条 webhook：`auth` 合法（取值域内），凭据四个键齐全（掩码还原要按 id 取原值）。 */
  const AUTH_DISK = diskOf({ id: "hook:1", ...HOOK, auth: "bearer" });

  /**
   * 存量 webhook：`auth` 键**不在对象上**（用户手改文件造出来的形态，与 `AUTH_DISK` 只差这一个键）。
   *
   * `HOOK` 本来就不带 `auth`（它只保证凭据四个键齐全，`auth` 是取值域键、不是凭据位），所以
   * 「从 HOOK 上摘掉 auth」就是 HOOK 本身——不必也不能写成 `{ ...HOOK, auth: undefined }`：那是
   * 「键在场、值为 undefined」，与「键不在」是两种不同的事件（本组判据五 / 六要钉的正是后者，
   * 合并对前者走取值域、对后者走「不动」）。
   */
  const NO_AUTH_HOOK: Channel = { id: "hook:1", ...HOOK };

  // 判据一：真实客户端链上的清空手势（assignChannelFields 把 "" / undefined 写成 null）→ 必填键那一句话。
  //
  // 改坏方向（判据层说话、合并层照旧删键）：话术从「auth 是必填键，不能删除」翻成「auth 非法」，
  // 而两条路都是 400——症状从「用户知道自己删了什么」变成「用户以为自己填错了值」，排查方向整个换掉。
  it("判据一：UI 清空 auth（assignChannelFields 写的 null）→ 400「auth 是必填键，不能删除」", () => {
    const draft = submitDraft(AUTH_DISK, "hook:1", { auth: "" });
    // 前提事实：显式清空确实进了提交面（是 null，不是键缺席——键缺席是「不动」，那是下一组的事）。
    expect(byId(draft.payload, "hook:1").auth).toBe(null);
    expect(draft.merged.ok).toBe(false);
    if (draft.merged.ok) throw new Error("应当拒收");
    expect(draft.merged.error.key).toBe("channels");
    expect(draft.merged.error.hint).toContain("auth 是必填键，不能删除");
    // 反向断言：不是取值域那一句话（那正是修之前用户看到的话）。
    expect(draft.merged.error.hint).not.toContain("auth 非法");
  });

  // 判据二：空串那一支与 null 同义（合并的状态 4 是为旧客户端兜底的），话术必须逐字同一句。
  //
  // `auth` 刻意**不在**客户端空串剥除清单里（shared/channel-compare.ts：清单只收「在别的类型里可选」的
  // 键），所以空串原样抵达写面，两支都要归到同一句话上。
  //
  // 手写提交面绕过 assignChannelFields（本组要的就是「客户端已经交出空串」这个前提）。
  it("判据二：旧客户端的空串兜底（auth 提交空串）→ 与 null 逐字同一句 400", () => {
    const submitted = [
      { ...BROWSER },
      { ...SYSTEM },
      { id: "hook:1", ...HOOK, auth: "" },
    ] as unknown as RawSettingValue;
    const merged = mergeChannels(submitted, AUTH_DISK.channels ?? []);
    const nullMerged = mergeChannels(
      [
        { ...BROWSER },
        { ...SYSTEM },
        { id: "hook:1", ...HOOK, auth: null },
      ] as unknown as RawSettingValue,
      AUTH_DISK.channels ?? [],
    );
    expect(merged.ok).toBe(false);
    expect(nullMerged.ok).toBe(false);
    if (merged.ok || nullMerged.ok) throw new Error("应当拒收");
    expect(merged.error.hint).toBe(nullMerged.error.hint);
    expect(merged.error.hint).toContain("auth 是必填键，不能删除");
  });

  // 判据三：不碰 `auth` 就照常保存，且 `auth` 逐字不变——掩码通道没有被本改动带歪。
  //
  // `auth` 不是凭据字段（密钥位是 token / password / headerValue），所以它在视图里原样外发、原样带回；
  // 同一组里顺带钉住凭据位仍是「掩码换回磁盘原值」：本改动碰的是状态 3 / 4，掩码是状态 2，两条道不许串。
  it("判据三：客户端没碰 auth（只改名）→ 放行，落盘 auth 逐字不变、凭据位换回真值", () => {
    const trip = roundTrip(AUTH_DISK, "hook:1", { name: "群机器人" });
    expect(trip.verdictOk).toBe(true);
    expect(byId(trip.persisted, "hook:1").auth).toBe("bearer");
    expect(byId(trip.persisted, "hook:1").token).toBe("tok");
    expect(byId(trip.persisted, "hook:1").name).toBe("群机器人");
  });

  // 判据四：**键缺席 → 不动**（边界一）。本补丁只动「键在场、值为空」那一种手势，两者是不同的键序事件：
  // 提交里没有 `auth` 这个键时，磁盘上的原值原样沿用，合并不拒也不删。
  //
  // 改坏方向（把「键缺席」也当清空）：用户只改了名字就被告知 `auth` 不能删——他把这条键从界面上整个
  // 清掉、或客户端没有这个字段时，每次保存都被自己的旧值挡回来。
  it("判据四：提交里 auth 键缺席 → 不动，磁盘上的原值原样沿用", () => {
    const merged = mergeChannels(
      [
        { ...BROWSER },
        { ...SYSTEM },
        { id: "hook:1", ...HOOK, token: MASK, name: "改名" },
      ] as unknown as RawSettingValue,
      AUTH_DISK.channels ?? [],
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("应当放行：" + merged.error.hint);
    expect(byId(merged.channels as Channel[], "hook:1").auth).toBe("bearer");
    expect(byId(merged.channels as Channel[], "hook:1").name).toBe("改名");
  });

  // 判据五：磁盘上 `auth` **键缺席**（用户手改文件造出来的）而客户端只改别的 → 照常放行，边界不回归。
  //
  // 真实链上客户端拿得到 `auth`：视图逐字外发，基线由**比较规范形**补出 `auth: "none"`（shared/
  // channel-compare.ts 的 CHANNEL_COMPARE_DEFAULTS，与写面投递投影同语义），于是提交面里那个键有值，
  // 合并走的是第五态（写入），落盘上从此有 `auth`。本条钉的是这一格。
  it("判据五：磁盘 auth 键缺席、客户端只改别的 → 照常放行（落盘由客户端的补值物化出 auth）", () => {
    const disk = diskOf(NO_AUTH_HOOK);
    // 前提事实：视图确实没有这个键（视图不补默认值，补值发生在比较规范形那一步）。
    expect("auth" in byId(projectForView(disk).channels as Channel[], "hook:1")).toBe(false);

    const trip = roundTrip(disk, "hook:1", { name: "群机器人" });
    expect(trip.verdictOk).toBe(true);
    expect(byId(trip.persisted, "hook:1").auth).toBe("none");
  });

  // 判据六：存量本就残缺（磁盘 `auth` 键缺席）+ 用户**显式**清空 → 仍 400，不因「本就残缺」而放行。
  //
  // 与半坏条目的判据二 2a 同款：`preexisting` 放行的是「存量本就残缺、这次既没补上也没删掉」，
  // 显式删除手势不在那一列。半坏那条的放行路径对 `auth` 也一样成立——两条判据必须成对，否则
  // 「显式清空」在一条上被拒、在另一条上被放行，用户看到的仍是同一次保存的两种结局。
  it("判据六：磁盘 auth 键缺席 + 显式清空（null）→ 仍 400（显式删除手势不在 preexisting 放行里）", () => {
    const disk = diskOf(NO_AUTH_HOOK);
    const draft = submitDraft(disk, "hook:1", { auth: "" });
    expect(byId(draft.payload, "hook:1").auth).toBe(null);
    expect(draft.merged.ok).toBe(false);
    if (draft.merged.ok) throw new Error("应当拒收");
    expect(draft.merged.error.hint).toContain("auth 是必填键，不能删除");
  });

  // 判据七：**值不在白名单**仍然只由判据层说（边界三），合并不重复判取值域。
  //
  // `oauth` 是一个非空、非掩码、非空串的值 → 第五态（写入）→ 判据层以「auth 非法」拒收。
  // 改坏方向（把取值域也搬进合并）：同一份输入在两条路上各有一份白名单，漂的那次症状是
  // 「合并放行、判据拒收」或反过来，而两边的话术会指着不同的事。
  it("判据七：值不在白名单仍归判据层（合并放行写入，话术仍是「auth 非法」）", () => {
    const verdict = judge(
      [{ ...BROWSER }, { ...SYSTEM }, { id: "hook:1", ...HOOK, auth: "oauth" }],
      AUTH_DISK,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.hint).toContain("auth 非法");
  });

  // 同源守卫：两张必填键表的**每一项**，清空手势都必须是同一个「必填键，不能删除」的出口。
  //
  // 形状是数据驱动而不是抄一份清单：遍历 `REQUIRED_KEYS` 与 `VALUE_DOMAIN_REQUIRED_KEYS` 的每一项，
  // 给那个键种一次显式清空。新增一个键时本条自动跟着走（**这正是单一来源的形状**）；
  // 反向也成立：哪张表里多了一项而合并没跟上、或本组退回「只读 REQUIRED_KEYS」，本条立刻红。
  //
  // 种子条目只种**被测的那一个键**（其余键一律缺席）——缺席判据由合并的「不动」处理，与本条要测的
  // 「键在场、值为空」是不同的事件，两条混在一起会测不成任何一边。
  it("同源守卫：两张必填键表逐项清空 → 都 400 且话术同族（合并退回只读一张表就红）", () => {
    const tables = { ...REQUIRED_KEYS, ...VALUE_DOMAIN_REQUIRED_KEYS };
    for (const [type, keys] of Object.entries(tables)) {
      for (const key of keys) {
        const seed: Channel = { id: type + ":" + key, type, name: "种子 " + key };
        seed[key] = null;
        const merged = mergeChannels(
          [{ ...BROWSER }, { ...SYSTEM }, seed] as unknown as RawSettingValue,
          [],
        );
        expect(merged.ok, type + "." + key + " 清空应被拒").toBe(false);
        if (merged.ok) throw new Error("应当拒收");
        expect(merged.error.hint, type + "." + key).toContain(key + " 是必填键，不能删除");
      }
    }
  });
});
