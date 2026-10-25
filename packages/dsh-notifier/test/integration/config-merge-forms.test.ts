/**
 * dsh-notifier —— 写面**按字段合并**在 10 种磁盘形态上的形态回归（#1016 S2）。
 *
 * #1174 shape 拆分产物：原 test/integration/config-merge-roundtrip.test.ts 按自然职责块拆成
 * 「形态回归」与「掩码与 auth」两个测试文件，本文件只留形态回归这一族（10 种磁盘形态 /
 * 通用不变量 / 半坏条目），fullName 与断言逐字保留（套件名沿用原标题）。跨文件共用的
 * 夹具（磁盘形态字面量、往返链、合并结论读取）在 ./config-merge-support.ts。
 *
 * 判据从「假阳性 = 0」升级成**落盘形态回归**：每种形态都断言「走完真实往返链、只改 name 之后，
 * 落盘的那条频道**逐字等于**预期形态」——预期形态是手写的字面量，不是「跑一遍看看输出什么」。
 * 合并的实现、读面的归一化、出口的掩码、客户端的剥空串，任一处漂了都会打红其中一条。
 *
 * 链路与真客户端逐段对应（行号对客户端 index.tsx / client/settings/diff.ts / server/config/impl/service）：
 *   磁盘 → projectForView（读面的**视图通道**：键子集 + 原样 + 掩码）→ GET /config 外发
 *        → snapshotBaseline（loadCard 建基线与草稿）→ 用户改一个字段（assignChannelFields）
 *        → diffSettingsPayload（保存时算增量）→ mergeChannels（写面按字段合并，掩码在这一步
 *        按 id 换回存量原值）→ validateSettingsWithMerge（判据审合并结果）
 *
 * **越界值原样保留是 S3 的既定语义（读面不再归一化），不是回归**：#1016 S3 把读面拆成
 * 「投递投影 / 外发视图」两条通道，投递侧一行未改（`current()` 仍是 normalizeConfig 的结果），而**外发
 * 的视图只做键子集 + 原样 + 掩码**。于是磁盘上越界的 `timeoutMs: 999999`、越界的 `timeoutSec: 99999`、
 * 不在白名单的 `preset: "nope"` 会原样交给客户端、原样交回写面，被合并判成「原样带回」进 inherited 而
 * 不重判值域，最终**落盘保持磁盘原值**。S2 之前它们会被读面钳成 0 / "custom" 再落盘——那是「宿主的解释
 * 被当成用户的值写回磁盘」，正是 S3 要消灭的那件事。形态四与形态十的字面量据此翻转。
 *
 * 顺带被 S3 翻转的还有**读面曾经补出来、而视图不再补的键**（各条 bark/webhook 的 `enabled: false`）：
 * 它们过去由 normalizeConfig 物化、经客户端原样带回而落盘，现在既没人补、客户端也不补，于是**落盘上
 * 就没有这个键**。而 `levels: {} / timeoutMs: 0 / headers: {} / timeoutSec: 0 / preset: "custom" /
 * auth: "none"` 仍在——它们由**客户端的比较规范形**（shared/channel-compare.ts）补，两端共用那一份，
 * 与 S3 无关。逐形态的字面量把这条界线钉死：哪几个键是宿主侧的解释、哪几个是客户端侧的补齐。
 *
 * 第三处与 S2 之前的版本不同，同样是为了「模拟链路不再与真实链路分叉」：
 *   - 除 `channels` 外的十条磁盘形态都**带上了两条内置条目**。0.2.4 的配置形态割接会把内置补进文件、
 *     写面又拒收缺内置的提交，所以「磁盘上没有内置」只可能是 0.2.3 及更早的文件；而读面自 S3 起不再物化
 *     它们，那样的文件在设置页上提交任何一次都会撞「内置渠道不能删除」的 400。形态七与形态八仍以「没有
 *     内置」为前提，各自记着它自己的那条理由。
 *   - 提交体**带着掩码**直接进 mergeChannels，不再由本文件调 unmaskChannels 预还原。生产写面
 *     早已不走那条还原路径（掩码是合并的五态之一），继续在测试里走它就是拿一条不存在的链路
 *     冒充真实链路。
 *   - 判据入口是 validateSettingsWithMerge（审合并结果 + inherited），不再有基线与 scope。
 *
 *
 * 文件末尾另有一组「半坏条目不许锁死设置页」的判据（#1016 S3 回归修复）：S3 让读面不再丢弃半坏
 * 条目，而写面的「必填键在场」是**形状**判据、不看增量，于是「升级后手改文件造出的半坏条目」会把
 * 此后每一次保存都变成 400——比 S3 之前更差。形态八断言的是**升级清理之后**的磁盘形态，那一步只在
 * 刻度推进时跑一次，救不了「升级后手改」这条路；末尾那组判据钉的是写面这一侧不许锁人。
 *
 * 无文件系统、无网络、不碰 DSH_HOME：本文件只跑纯函数，落盘纪律不适用。
 */
import { describe, expect, it } from "vitest";

import type { RawSettingValue, StoredSettings } from "../../src/server/config/impl/model/type.ts";
import { mergeChannels } from "../../src/server/config/impl/service/merge.ts";
import { projectForView } from "../../src/server/config/impl/service/view.ts";
import {
  assignChannelFields,
  diffSettingsPayload,
  snapshotBaseline,
} from "../../src/client/settings/diff.ts";
import {
  BARK,
  BROWSER,
  FORMS,
  HALF_DISK,
  HOOK,
  MASK,
  SYSTEM,
  byId,
  diskOf,
  idsOf,
  judge,
  preexistingOf,
  roundTrip,
  submitDraft,
} from "./config-merge-support.ts";
import type { Channel, Form, RoundTrip } from "./config-merge-support.ts";

describe("10 种磁盘形态：走完真实往返链、只改一个 name，落盘逐字等于预期形态", () => {
  for (const form of FORMS) {
    it(form.label, () => {
      const trip = roundTrip(form.disk, form.editId, form.part);

      // 判据放行：这批形态里有越界值、非法枚举、半坏条目，用户改个名字必须存得下去。
      expect(trip.verdictOk).toBe(true);
      // 落盘的频道 id 与顺序。
      expect(idsOf(trip.persisted)).toEqual([...form.keptIds]);
      // 被改那条的**完整**落盘形态：磁盘原样保住的键 + 客户端交上来的补值 + 用户改的 name。
      expect(byId(trip.persisted, form.editId)).toEqual(form.kept);
      // 任何形态下，占位符都不许留在落盘结果里。
      expect(JSON.stringify(trip.persisted)).not.toContain(MASK);
      form.also?.(form, trip);
    });
  }
});

/**
 * 这一形态里「磁盘上有、客户端没提交、落盘却丢了或被改写」的键，逐条写成一句话。
 *
 * 单独抽成纯函数是为了让上面那条用例只做断言：分支都在这里，用例里只剩「结果为空」一句话。
 * 返回空数组 = 键一条不少、值一字未改。
 */
function lostOrRewritten(form: Form, trip: RoundTrip): string[] {
  const problems: string[] = [];
  // 「客户端看见了什么」问的是**视图通道**而不是投递投影：S3 之后外发的是 projectForView 的结果。
  // 视图没看见的条目（形态八的半坏条目，现在由 upgrade 域的形态清理在装配期删掉）不参与本不变量。
  const seenIds = new Set(
    (projectForView(form.disk).channels as Channel[]).map((item) => String(item.id)),
  );
  for (const diskChannel of (form.disk.channels ?? []) as Channel[]) {
    const id = String(diskChannel.id ?? "");
    if (!seenIds.has(id)) continue;
    const kept = byId(trip.persisted, id);
    for (const [key, value] of Object.entries(diskChannel)) {
      // name 是用户这次真改的那一个；其余「客户端交了」的键以提交值为准（见逐形态的字面量）。
      if (key === "name" || key in trip.submitted) continue;
      if (!(key in kept)) problems.push(form.label + " · " + id + "." + key + " 键消失");
      else if (JSON.stringify(kept[key]) !== JSON.stringify(value)) {
        problems.push(form.label + " · " + id + "." + key + " 值被改写");
      }
    }
  }
  return problems;
}

describe("同一组形态的通用不变量（逐条对着 10 种形态跑，不靠人眼扫）", () => {
  // 不变量一：**磁盘上客户端没碰过的键，一条都不许少**。
  //
  // 旧语义（整组替换）下这条全红：落盘只剩客户端交上来的键，timeoutMs / myCustom / 残留空串
  // 这些用户根本没碰过的东西会跟着消失。逐形态的字面量已经钉住了同样的事实，这里再从另一头
  // （按「客户端交了什么」机械地推一遍）钉一次——字面量要人读，机械推论不给人留例外。
  it("磁盘上客户端没提交的键，逐字留下（键不丢、值不改）", () => {
    for (const form of FORMS) {
      const trip = roundTrip(form.disk, form.editId, form.part);
      expect(idsOf(trip.persisted), form.label).toContain(form.editId);
      expect(lostOrRewritten(form, trip), form.label).toEqual([]);
    }
  });

  // 不变量二：凭据位上的值一律来自**磁盘**，不来自客户端，也不来自占位符。
  //
  // 这是合并那一侧最容易写反的一格：把占位符当普通值写进磁盘（凭据从此报废），或把客户端的
  // 归一化空串写回去（用户没清空却被清空）。两种错法都被这条一次性按住。
  it("凭据位：落盘值一律等于磁盘上的原值（不是占位、不是提交侧的值）", () => {
    for (const form of FORMS) {
      const trip = roundTrip(form.disk, form.editId, form.part);
      const diskEntry = ((form.disk.channels ?? []) as Channel[]).find(
        (item) => item.id === form.editId,
      );
      for (const key of ["deviceKey", "token", "password", "headerValue"]) {
        if (!(key in trip.submitted)) continue;
        // 前提事实：凭据位在提交面里确实是占位（否则这条就没断到东西）。
        expect(trip.submitted[key], form.label + " · " + key).toBe(MASK);
        expect(byId(trip.persisted, form.editId)[key], form.label + " · " + key).toEqual(
          diskEntry?.[key],
        );
      }
    }
  });

  // 不变量三：掩码**无原值可还原**时，写面与草稿测试（dry-run）给同一个答案。
  //
  // 客户端新建一条频道时不会凭空造出占位，但换型（同一 id 换成另一种 type）会：读出口按类型掩码，
  // 类型一变凭据的来源就断了。写面此前把这种占位当普通值写进磁盘，而 dry-run 一直 400——同一份
  // 草稿在「保存」与「试发」两条路上得到两个答案，正是掩码搬进 merge 要消灭的那个缺陷。
  it("掩码无原值可还原：写面拒收且话术与 dry-run 同句（不把占位符写进磁盘）", () => {
    const disk: StoredSettings = {
      channels: [{ id: "hook:1", ...HOOK, auth: "bearer", token: "REAL" }],
    };
    const snapshot = snapshotBaseline(projectForView(disk) as unknown as Record<string, unknown>);
    const draft = Object.assign({}, snapshot) as Record<string, unknown>;
    const list = (draft.channels as Channel[]).slice();
    const index = list.findIndex((item) => item.id === "hook:1");
    // 同一个 id 换成 bark：换型 = 换了一条，bark 的 deviceKey 在存量里没有对应原值。
    list[index] = assignChannelFields(list[index], {
      type: "bark",
      baseUrl: "https://api.day.app",
      deviceKey: MASK,
    }) as Channel;
    draft.channels = list;
    const payload = diffSettingsPayload(draft, snapshot);

    const merged = mergeChannels(payload.channels as RawSettingValue, disk.channels ?? []);

    // 前提事实：提交面里那个 deviceKey 确实是占位（否则这条会因别的原因红）。
    const swapped = (payload.channels as Channel[]).find((item) => item.id === "hook:1");
    expect(swapped?.deviceKey).toBe(MASK);
    expect(merged.ok).toBe(false);
    if (merged.ok) throw new Error("应当拒收");
    expect(merged.error.key).toBe("channels");
    expect(merged.error.hint).toContain("不能提交掩码占位");
  });
});

/**
 * 半坏条目（存量本就缺必填键）不许把用户锁死在设置页外——S3 的一处真实回归。
 *
 * 两条通道撞出来的：读面自 S3 起**不丢弃**半坏条目（视图逐字外发），而写面的「必填键在场」是形状判据、
 * 不看增量。于是用户手改出一条半坏条目之后，此后每一次保存都 400，连改**别的**频道的名字都存不下去。
 * 形态八断言的是 0.2.9 形态清理**之后**的磁盘形态，而那一步只在刻度推进时跑一次，救不了「升级后手改」。
 *
 * 下面每条各钉一个方向：放行的**只是**「存量本就残缺」，手势、建模、视图三处都不许顺带放宽。
 */
describe("半坏条目：不锁死设置页（改另一条频道即保存成功）", () => {
  it("判据一：只改另一条频道的名字 → 保存成功，半坏条目逐字未变（不补值、不删键、凭据不回退成掩码）", () => {
    const trip = roundTrip(HALF_DISK, "hook:1", { name: "群机器人" });

    // 本组判据的核心：S3 之前读面静默丢弃这条，用户看不见它但设置页能用；现在不许退化成「每次保存都 400」。
    expect(trip.verdictOk).toBe(true);

    // 半坏条目的落盘形态：存量有的键一条不少、值一字未改，**并且没有凭空多出 baseUrl**（写面不猜值）。
    // levels / timeoutMs 仍由客户端的比较规范形补出（与形态一/二同款，与本判据无关）。
    expect(byId(trip.persisted, "bark:half")).toEqual({
      id: "bark:half",
      type: "bark",
      deviceKey: "key-half",
      levels: {},
      timeoutMs: 0,
    });
    expect("baseUrl" in byId(trip.persisted, "bark:half")).toBe(false);
    // 凭据位是磁盘上的原值，不是掩码（放行不等于把凭据洗掉）。
    expect(byId(trip.persisted, "bark:half").deviceKey).toBe("key-half");
  });

  it("判据二：用户主动把 baseUrl 删了（传 null）仍 400 —— 放行的是「存量本就残缺」，不是「删必填键」", () => {
    // 2a：半坏条目上的显式删除手势。存量本就缺这个键，但手势是**显式的**（客户端写 null），仍要拒。
    const half = submitDraft(HALF_DISK, "bark:half", { baseUrl: null });
    // 前提事实：这次提交里半坏条目确实带了 baseUrl: null（否则下面那条会因别的原因红）。
    expect(byId(half.payload, "bark:half").baseUrl).toBe(null);
    expect(half.merged.ok).toBe(false);
    if (half.merged.ok) throw new Error("应当拒收");
    expect(half.merged.error.hint).toContain("baseUrl 是必填键，不能删除");

    // 2b：合法 bark 上清空必填键——存量里这个键是好的，用户要删它，400（这是「不留一个打不通的空壳」）。
    const good = submitDraft(diskOf({ id: "bark:1", ...BARK }), "bark:1", { baseUrl: null });
    expect(good.merged.ok).toBe(false);
    if (good.merged.ok) throw new Error("应当拒收");
    expect(good.merged.error.hint).toContain("baseUrl 是必填键，不能删除");
  });

  it("判据三：新建的频道缺必填键仍 400 —— 存量里没有这条，就没有「本就残缺」可言", () => {
    const verdict = judge(
      [{ ...BROWSER }, { ...SYSTEM }, { id: "bark:new", type: "bark", deviceKey: "key-new" }],
      diskOf(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.hint).toContain("缺少 baseUrl");
  });

  it("判据四：视图不过滤 —— 客户端看得见这条半坏条目，且补得回、删得掉", () => {
    // 「视图过滤」那种修法会让判据一变绿，但代价是用户**看不见**这条了（文件里有、界面里没有，两套事实，
    // 正是 S3 要消灭的那件事）。下面逐段钉住「看得见」与「有出路」，把那种修法判红。
    const shown = (
      (projectForView(HALF_DISK) as unknown as Record<string, unknown>).channels as Channel[]
    ).find((item) => item.id === "bark:half");
    expect(shown).toBeDefined();
    // 客户端看见的确实是**半坏**的那条：baseUrl 缺席、凭据已掩码——没有被谁悄悄补上或替换掉。
    expect("baseUrl" in (shown as Channel)).toBe(false);
    expect((shown as Channel).deviceKey).toBe(MASK);

    // 视图 → 草稿 → 提交这一段没把它换掉：客户端原样把它交回写面。
    const trip = roundTrip(HALF_DISK, "hook:1", { name: "群机器人" });
    const sent = byId(trip.payload, "bark:half");
    expect("baseUrl" in sent).toBe(false);
    expect(sent.deviceKey).toBe(MASK);

    // 出路一：把 baseUrl 补上 → 这条自此合法，保存成功（不必重启、不必手改文件）。
    const fixed = roundTrip(HALF_DISK, "bark:half", { baseUrl: "https://api.day.app" });
    expect(fixed.verdictOk).toBe(true);
    expect(byId(fixed.persisted, "bark:half").baseUrl).toBe("https://api.day.app");

    // 出路二：把这条整条删掉 → 保存成功（删整条不触发任何形状判据，也不该被它拖着一起拒）。
    const dropped = submitDraft(HALF_DISK, "hook:1", { name: "群机器人" }, "bark:half");
    expect(dropped.merged.ok).toBe(true);
    if (!dropped.merged.ok) throw new Error("应当放行：" + dropped.merged.error.hint);
    expect(idsOf(dropped.merged.channels as Channel[])).toEqual(["browser", "system", "hook:1"]);
  });

  // #1016 P2-1：半坏条目的另一半形态——**必填键在场但值是空串**。上面那组是「键缺席」，而磁盘上真实会
  // 出现的是空串（读面过去补默认补出来的那批，以及用户手写 / 旧版落盘留下的）。
  //
  // 改坏方向（把 baseUrl / deviceKey 留在空串剥除清单外）：客户端提交前不剥 → 写面判「删必填键」→ 每一次
  // 保存都 400「baseUrl 是必填键，不能删除」，用户改**别的**频道的名字都存不下去——正是 S3 刚修掉的那个
  // 锁死，只是这次是从客户端那一侧重新进来。bark 锁、webhook 不锁（url 一直在剥除清单里）正是这个差。
  it("判据五：必填键是**空串**的半坏条目走真实客户端链保存成功（剥空串 → 键缺席 → preexisting 放行）", () => {
    const emptyUrl: Channel = {
      type: "bark",
      id: "bark:half",
      baseUrl: "",
      deviceKey: "key-half",
      name: "地址空串",
    };
    const emptyKey: Channel = {
      type: "bark",
      id: "bark:half2",
      baseUrl: "https://api.day.app",
      deviceKey: "",
    };
    const disk: StoredSettings = diskOf(emptyUrl, emptyKey, { id: "hook:1", ...HOOK });

    // 前提事实：视图把两个空串原样外发（读面不补默认值），客户端拿到的就是空串。
    const shown = (projectForView(disk) as unknown as Record<string, unknown>)
      .channels as Channel[];
    expect(byId(shown, "bark:half").baseUrl).toBe("");
    // deviceKey 是凭据，但**空串不被掩码**（#1016 缺陷 A 的正解：掩码一个空串等于告诉用户「这里有值」）。
    expect(byId(shown, "bark:half2").deviceKey).toBe("");

    // 真实链：改**另一条**频道的名字（用户与那条半坏的毫无关系）→ 保存成功。
    const trip = roundTrip(disk, "hook:1", { name: "群机器人" });
    expect(trip.verdictOk).toBe(true);

    // 客户端确实剥掉了空串（键缺席，不是把空串交出去）：前提事实，缺了它这条可能是在测「什么都没发生」。
    expect("baseUrl" in byId(trip.payload, "bark:half")).toBe(false);
    expect("deviceKey" in byId(trip.payload, "bark:half2")).toBe(false);

    // 落盘形态：存量原样（空串仍是空串——剥除只发生在提交面，不改磁盘），凭据不回退成掩码。
    expect(byId(trip.persisted, "bark:half").baseUrl).toBe("");
    expect(byId(trip.persisted, "bark:half2").deviceKey).toBe("");
    expect(byId(trip.persisted, "hook:1").name).toBe("群机器人");
  });

  // P2-1 不得把「显式清空」也放过：UI 写回走 assignChannelFields，空值被写成 " + BT + "null" + BT + "（不是空串），
  // 原样穿过剥除 → 写面照样 400。这条与上面那条是一对：剥的是**读面补出来的**空串，拒的是**用户的手指**。
  it("判据六：同一个键，用户显式清空（assignChannelFields 写的 null）仍 400 —— 剥除只吃空串", () => {
    const good = diskOf({ id: "bark:1", ...BARK }, { id: "hook:1", ...HOOK });
    for (const key of ["baseUrl", "deviceKey"] as const) {
      const draft = submitDraft(good, "bark:1", { [key]: null });
      // 前提事实：显式清空确实进了提交面（null 不是空串，剥除不吃它）。
      expect(byId(draft.payload, "bark:1")[key]).toBe(null);
      expect(draft.merged.ok).toBe(false);
      if (draft.merged.ok) throw new Error("应当拒收");
      expect(draft.merged.error.hint, key).toContain(key + " 是必填键，不能删除");
    }
  });
  it("合并结论带出「存量本就残缺」的必填键清单：半坏条目有它，合法与新建条目都没有", () => {
    // 机制本身的判据（钉的是记账，不是放行）：清单由 merge 从存量事实算出，与提交面无关。
    const trip = submitDraft(HALF_DISK, "hook:1", { name: "群机器人" });
    expect([...preexistingOf(trip.merged, "bark:half")]).toEqual(["baseUrl"]);
    // 同一次提交里那条合法 webhook 不进清单（它的 url 是好的）。
    expect([...preexistingOf(trip.merged, "hook:1")]).toEqual([]);

    const fresh = mergeChannels(
      [
        { ...BROWSER },
        { ...SYSTEM },
        { id: "bark:new", type: "bark", deviceKey: "key-new" },
      ] as unknown as RawSettingValue,
      diskOf().channels ?? [],
    );
    expect([...preexistingOf(fresh, "bark:new")]).toEqual([]);
  });

  it("不许放宽过头：存量里本来是好的必填键，被这次提交写成非法值，仍 400", () => {
    // 半坏豁免只认「两边都坏」；存量里是好的、这次被写坏，是用户（或客户端）造成的，必须拒。
    const verdict = judge(
      [{ ...BROWSER }, { ...SYSTEM }, { id: "bark:1", ...BARK, baseUrl: 123 }],
      diskOf({ id: "bark:1", ...BARK }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.hint).toContain("缺少 baseUrl");
  });
});
