/**
 * dsh-notifier —— 写面**按字段合并**在 10 种磁盘形态上的形态回归（#1016 S2）。
 *
 * **文件名在 S4 才改对（此前是历史名 `config-write-scope-roundtrip`）**：它诞生时断的是「写面范围
 * （scope）」，而那个面已在 #1016 S2 的收尾里删掉（零消费者，且与 inherited 对「提交没带某字段」
 * 给相反答案）。S3 收尾时按下改名，是因为它被三处登记引用——scripts/test/service-contract-wiring.test.ts
 * 的测试面清单、mutation-topology.json 的 config/channels 段 testFiles、以及从拓扑派生的
 * vitest.stryker.d/*.config.ts——改一个字要连带重冻结这三份，而那一步的净收益只是改一行文件名。
 * S4 本来就要重写本文件的判据，迁移成本降到最低，于是连同台账一并改对，改完跑
 * `pnpm stryker:gen` 重派生。**要保留下来的从来不是那个名字，是它枚举的 10 种磁盘形态**——
 * 每一种都是真实存量配置文件里真会出现的样子，而每一种都曾是「用户只改一个名字，却让整条频道的
 * 凭据/开关/超时一起被改写」的候选现场。
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
 * 再往后一组是**取值域类必填键**（webhook 的 `auth`）的删除手势：它在合并层过去按「非必填键显式删除」
 * 被删键，删键造出的残缺随即被输入闸门以「auth 非法」拒收，而 `url` 被清空时说的是「url 是必填键，
 * 不能删除」——同一条手势、两种话术，用户无从分辨是哪一处出错。这一组钉的是两边对齐后的样子，
 * 以及三条不许跟着变宽的边界（键缺席不动、值域判据仍归判据层、掩码通道不回归）。
 *
 * 无文件系统、无网络、不碰 DSH_HOME：本文件只跑纯函数，落盘纪律不适用。
 */
import { describe, expect, it } from "vitest";

import { validateSettingsWithMerge } from "../../src/server/config/impl/input/index.ts";
import { resolveDraftChannels } from "../../src/server/config/impl/draft/index.ts";
import type { ResolvedDraft } from "../../src/server/config/impl/draft/index.ts";
import type { RawSettingValue, StoredSettings } from "../../src/server/config/impl/model/type.ts";
import { mergeChannels } from "../../src/server/config/impl/service/merge.ts";
import type { ChannelMerge } from "../../src/server/config/impl/service/merge.ts";
import { projectForView } from "../../src/server/config/impl/service/view.ts";
import { REQUIRED_KEYS, VALUE_DOMAIN_REQUIRED_KEYS } from "../../src/shared/interface.ts";
import {
  assignChannelFields,
  diffSettingsPayload,
  snapshotBaseline,
} from "../../src/client/settings/diff.ts";

/** 掩码占位字面量：与设置页、redact 域、merge 域同一份跨端契约（独立写出，不从源码 import）。 */
const MASK = "********";

/** 合法 bark：写面要求 id / baseUrl / deviceKey 非空。 */
const BARK = { type: "bark", baseUrl: "https://api.day.app", deviceKey: "key-1" };

/**
 * 合法 webhook：凭据四个键**都**在磁盘上。
 *
 * 为什么不能只写 url：**掩码还原按 id 对齐取原值**，磁盘上没这个键就换不回真凭据；而外发视图
 * 只对**非空**的凭据掩码（空串不掩，见 redact 域的注释），所以四个键都得在磁盘上带着真值，
 * 「凭据在磁盘上是空串」那一支由形态九单独覆盖。
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

/** 一条频道（存储层形状不受契约约束，按原始值看）。 */
type Channel = Record<string, RawSettingValue>;

/** 一次往返的结果。 */
type RoundTrip = {
  /** 落盘的频道数组（合并结果，即 commit 要写进文件的那份）。 */
  readonly persisted: readonly Channel[];
  /** 判据结论（机制不改变它：审的是合并结果，不带任何基线）。 */
  readonly verdictOk: boolean;
  /** 用户改的那条在提交里的形态（掩码还在——它要到合并那一步才换回原值）。 */
  readonly submitted: Channel;
  /** 提交面里的**全部**频道：判别「客户端有没有看见 / 有没有交回某一条」时用它，而不是只看被改那条。 */
  readonly payload: readonly Channel[];
};

/**
 * 走一遍真实往返链：磁盘 → … → 写面合并 → 判据。
 *
 * @param disk 磁盘上的配置文件内容（原样，未经净化/归一化）。
 * @param editId 用户改的是哪条频道。
 * @param part 用户在界面上改的字段（其余一律原样）。
 */
function roundTrip(disk: StoredSettings, editId: string, part: Record<string, unknown>): RoundTrip {
  const { payload, merged } = submitDraft(disk, editId, part);
  if (!merged.ok) throw new Error("合并被拒：" + JSON.stringify(merged.error));
  const verdict = validateSettingsWithMerge(
    { channels: merged.channels as RawSettingValue[] },
    merged,
  );

  const submitted = (payload as Channel[]).find((item) => item.id === editId);
  if (submitted === undefined) throw new Error("提交里没有 id=" + editId + " 的频道");
  return { persisted: merged.channels as Channel[], verdictOk: verdict.ok, submitted, payload };
}

/**
 * 同一条链，但**停在合并为止**、且不在合并被拒时抛错——「必填键删除手势被拒」正是末尾那组判据要断言的
 * 结论，抛错就断言不到话术。抛错版的 roundTrip 保留给那 13 条形态判据（合并被拒在那里就该炸）。
 */
function submitDraft(
  disk: StoredSettings,
  editId: string,
  part: Record<string, unknown>,
  removeId?: string,
): { readonly payload: Channel[]; readonly merged: ChannelMerge } {
  // 读面的**视图通道**（#1016 S3）：键子集 + 原样 + 掩码，**不补默认值**——这才是 GET /config 外发的那份。
  // （投递投影 normalizeConfig 是另一条通道，只服务域内消费者，不在这条链上。）
  const effective = projectForView(disk);
  // GET /config 外发的 effective（凭据掩码）→ 客户端建基线与草稿（loadCard）。
  const snapshot = snapshotBaseline(effective as unknown as Record<string, unknown>);
  const draft = Object.assign({}, snapshot) as Record<string, unknown>;
  // 用户改一个字段：逐段照搬 chPatch——先 slice 出新数组再改单项。这一步不能图省事就地改：
  // loadCard 的草稿是基线的**浅**拷贝，两边共用同一个 channels 数组，就地改会把基线一起改掉，
  // 于是 diff 恒等、永远提交不出 channels。
  const list = (draft.channels as Channel[]).slice();
  const index = list.findIndex((item) => item.id === editId);
  if (index < 0) throw new Error("磁盘形态里没有 id=" + editId + " 的频道");
  list[index] = assignChannelFields(list[index], part) as Channel;
  // 「把这条频道删掉」也是设置页上真实存在的手势，与编辑同一条链（草稿少一条 → 整组 channels 进提交面）。
  draft.channels = removeId === undefined ? list : list.filter((item) => item.id !== removeId);

  // 保存：整组提交（改任一字段都会把 channels 整组带上）。**掩码原样带走**，还原是合并的职责。
  const payload = diffSettingsPayload(draft, snapshot);
  if (!Array.isArray(payload.channels)) throw new Error("改了频道却没有产生 channels 提交");

  // 写面：按字段合并（基线 = 磁盘原样）。
  return {
    payload: payload.channels as Channel[],
    merged: mergeChannels(payload.channels as RawSettingValue, disk.channels ?? []),
  };
}

/** 按 id 取一条；取不到当场失败（形态回归里「取不到」本身就是回归）。 */
function byId(list: readonly Channel[], id: string): Channel {
  const found = list.find((item) => item.id === id);
  if (found === undefined) throw new Error("落盘结果里没有 id=" + id + " 的频道");
  return found;
}

/**
 * 磁盘形态里的频道数组（dry-run 的原值来源）。存储层的 `channels` 是宽联合而不是数组，
 * 这里按「是数组就用，不是就当没有」收一下——本文件的磁盘形态都由 `diskOf` 造出来，那边恒是数组。
 */
function channelsOf(stored: StoredSettings): readonly RawSettingValue[] {
  const list = stored.channels;
  return Array.isArray(list) ? list : [];
}

/** 落盘结果的频道 id 列表（顺序是内容的一部分，见 service 域 stableJson 的注释）。 */
function idsOf(list: readonly Channel[]): string[] {
  return list.map((item) => String(item.id));
}

/**
 * 两条内置条目的形态：0.2.4 的配置形态割接把它们补进文件，0.2.8 的形态清理保证它们恒在场
 * （#1016 S3 起读面不再物化它们），所以除形态七 / 形态八外的磁盘形态都带它们。
 */
const BROWSER: Channel = {
  type: "browser",
  id: "browser",
  enabled: true,
  popup: true,
  sound: true,
  whenVisible: false,
};

const SYSTEM: Channel = {
  type: "system",
  id: "system",
  enabled: true,
  popup: true,
  sound: true,
};

/** 磁盘形态：两条内置 + 用户自己配的条目（真实文件里就是这个样子）。 */
function diskOf(...entries: Channel[]): StoredSettings {
  return { channels: [BROWSER, SYSTEM, ...entries] };
}

/**
 * 十种磁盘形态 + 每种的**预期落盘**。
 *
 * kept 是被改的那条在落盘时的完整字面量：磁盘原样保住的键、客户端交上来的归一化补值、以及用户
 * 改的 name，三者叠加后的终态。手写字面量而不是「跑一遍取输出」——后者会把任何实现（包括写错的
 * 实现）都冻成「预期」。
 */
type Form = {
  readonly label: string;
  /** 磁盘上的配置文件内容（原样）。 */
  readonly disk: StoredSettings;
  /** 用户改哪条、改什么。 */
  readonly editId: string;
  readonly part: Record<string, unknown>;
  /** 落盘后全部频道的 id 顺序。 */
  readonly keptIds: readonly string[];
  /** 被改那条在落盘时的完整形态。 */
  readonly kept: Channel;
  /** 这一形态特有的事实（形态专属的陷阱），逐条断言。传入本形态，读它的 disk 不必靠下标。 */
  readonly also?: (form: Form, trip: RoundTrip) => void;
};

const FORMS: readonly Form[] = [
  {
    label: "形态一：最普通的 bark（磁盘只有 id/type/baseUrl/deviceKey 四个键）",
    disk: diskOf({ id: "bark:1", ...BARK }),
    editId: "bark:1",
    part: { name: "手机" },
    keptIds: ["browser", "system", "bark:1"],
    // levels / timeoutMs 磁盘上没有，是**客户端的比较规范形**补出来的（shared/channel-compare.ts，
    // 两端共用那一份），客户端原样带回，于是这一次保存把它们写进了文件。
    // `enabled` 仍然缺席：它过去由读面归一化补出，S3 的视图不再补，于是也没人交了。
    kept: {
      id: "bark:1",
      type: "bark",
      baseUrl: "https://api.day.app",
      deviceKey: "key-1",
      timeoutMs: 0,
      levels: {},
      name: "手机",
    },
    also: (_form, trip) => {
      // 凭据不是客户端交上来的那个占位符，而是磁盘上的原值。
      expect(trip.submitted.deviceKey).toBe(MASK);
      expect(byId(trip.persisted, "bark:1").deviceKey).toBe("key-1");
    },
  },
  {
    label: "形态二：webhook（凭据四个键都在磁盘上）",
    disk: diskOf({ id: "hook:1", ...HOOK }),
    editId: "hook:1",
    part: { name: "群机器人" },
    keptIds: ["browser", "system", "hook:1"],
    // preset / auth / headers / timeoutSec 同样出自客户端的比较规范形；`enabled` 无人补，缺席。
    kept: {
      type: "webhook",
      id: "hook:1",
      url: "https://example.test/hook",
      token: "tok",
      username: "u",
      password: "p",
      headerName: "X-Key",
      headerValue: "hv",
      preset: "custom",
      auth: "none",
      headers: {},
      timeoutSec: 0,
      name: "群机器人",
    },
    also: (_form, trip) => {
      // 三个密钥位在提交里都是占位，落盘必须是磁盘上的原值，一个都不能是占位符本身。
      for (const key of ["token", "password", "headerValue"]) {
        expect(trip.submitted[key], key).toBe(MASK);
      }
      expect(JSON.stringify(trip.persisted)).not.toContain(MASK);
    },
  },
  {
    label: "形态三：磁盘上残留空串（0.2.2 保存失败前 / 手改文件留下的形态）",
    disk: diskOf({ id: "bark:1", ...BARK, name: "", group: "", sound: "", icon: "", url: "" }),
    editId: "bark:1",
    part: { name: "手机" },
    keptIds: ["browser", "system", "bark:1"],
    // 视图不再把空串剥掉，可**客户端的剥空串**（stripChannelEmpties）照样剥，于是那四个键不在提交面里
    // ⇒ 合并按「键缺席 = 不动」原样沿用磁盘上的空串。**空串没有被静默删掉，也没有被写成别的形态**。
    kept: {
      id: "bark:1",
      type: "bark",
      baseUrl: "https://api.day.app",
      deviceKey: "key-1",
      name: "手机",
      group: "",
      sound: "",
      icon: "",
      url: "",
      timeoutMs: 0,
      levels: {},
    },
    also: (_form, trip) => {
      for (const key of ["group", "sound", "icon", "url"]) {
        expect(key in trip.submitted, key).toBe(false);
        expect(byId(trip.persisted, "bark:1")[key], key).toBe("");
      }
    },
  },
  {
    label: "形态四：越界值原样保留（磁盘 timeoutMs 999999）",
    disk: diskOf({ id: "bark:1", ...BARK, timeoutMs: 999_999 }),
    editId: "bark:1",
    part: { name: "手机" },
    keptIds: ["browser", "system", "bark:1"],
    // 999999 是越界值。S3 之后视图原样外发、客户端原样带回、合并判「原样带回」进 inherited 不重判值域，
    // 于是**落盘仍是 999999**——这不是「用户改了超时」，用户压根没碰过它。S2 之前读面会把它钳成 0 再落盘，
    // 那正是「宿主的解释被当成用户的值写回磁盘」；越界值该被 upgrade 域的形态清理删键，而不是被读面改写。
    kept: {
      id: "bark:1",
      type: "bark",
      baseUrl: "https://api.day.app",
      deviceKey: "key-1",
      timeoutMs: 999_999,
      levels: {},
      name: "手机",
    },
    also: (_form, trip) => {
      expect(trip.submitted.timeoutMs).toBe(999_999);
    },
  },
  {
    label: "形态五：非法枚举原样保留（磁盘 level 是 urgent，不在白名单）",
    disk: diskOf({ id: "bark:1", ...BARK, level: "urgent" }),
    editId: "bark:1",
    part: { name: "手机" },
    keptIds: ["browser", "system", "bark:1"],
    // level 非法：视图原样外发 ⇒ 客户端原样带回 ⇒ 合并判「原样带回」进 inherited ⇒ 判据不重判值域。
    // 存量原样留着，用户改个名字存得下去；那条非法值由 upgrade 域的形态清理删键。
    kept: {
      id: "bark:1",
      type: "bark",
      baseUrl: "https://api.day.app",
      deviceKey: "key-1",
      level: "urgent",
      timeoutMs: 0,
      levels: {},
      name: "手机",
    },
    also: (_form, trip) => {
      expect(trip.submitted.level).toBe("urgent");
    },
  },
  {
    label: "形态六：频道条目上的陌生键（磁盘 myCustom）",
    disk: diskOf({ id: "bark:1", ...BARK, myCustom: "x" }),
    editId: "bark:1",
    part: { name: "手机" },
    keptIds: ["browser", "system", "bark:1"],
    // **连带项 B 的端到端形态**：视图不做任何键名映射，myCustom 原样进客户端、原样带回；写面本该对
    // 陌生键 400（validateKnownKeys），它不撞是因为合并判它「原样带回」进了 inherited——而那条判定成立
    // 的前提是**客户端不碰这个键**。客户端若哪天对它做投影（改名/丢弃），这条会当场变红。
    kept: {
      id: "bark:1",
      type: "bark",
      baseUrl: "https://api.day.app",
      deviceKey: "key-1",
      myCustom: "x",
      timeoutMs: 0,
      levels: {},
      name: "手机",
    },
    also: (_form, trip) => {
      expect("myCustom" in trip.submitted).toBe(true);
      // extras 子对象仍然不存在：S2 删掉它之后没有任何一处再收陌生键。
      expect("extras" in trip.submitted).toBe(false);
    },
  },
  {
    label: "形态七：还没割接的旧顶层键（磁盘只有 systemEnabled / notifySound，没有 channels）",
    disk: { systemEnabled: true, notifySound: "default" },
    editId: "system",
    part: { name: "本机" },
    keptIds: ["browser", "system"],
    // 磁盘上根本没有 channels 键，视图按缺键回落默认表（见 view 模块：顶层缺键取默认表的值，否则
    // 设置页少两个控件），客户端交回的就是那两条内置的默认形态。
    // **顶层键不由这次写动**：commit 的基底是磁盘原样，systemEnabled / notifySound 仍在文件里——
    // 读面自 S3 起不再消费它们，搬走它们是 upgrade 域 0.2.4 割接的职责。
    kept: { type: "system", id: "system", enabled: true, popup: true, sound: true, name: "本机" },
    also: (form, trip) => {
      expect(byId(trip.persisted, "browser")).toEqual(BROWSER);
      // 读面不认旧顶层键（判别力 #7）：视图里既没有它们，sound 也不由它们推出。
      const view = projectForView(form.disk) as unknown as Record<string, unknown>;
      expect("notifySound" in view).toBe(false);
      expect("systemEnabled" in view).toBe(false);
      expect(byId(trip.persisted, "system").sound).toBe(true);
    },
  },
  {
    label: "形态八：半坏条目由 upgrade 域删掉之后（磁盘上只剩两条合法 bark 与两条内置）",
    disk: diskOf({ id: "bark:1", ...BARK }),
    editId: "bark:1",
    part: { name: "手机" },
    // **这条判据搬到了 upgrade 域（#1016 S3）**：读面过去会丢弃「没有投递目标的空壳」条目，而 S3 的
    // 视图原样外发它 —— 客户端把它交回来，写面以「bark:half 的 baseUrl 是必填键，不能删除」400 拒掉，
    // 用户改个名字都存不下去。删半坏条目因此落到 0.2.8 的形态清理（canonical-keys.ts），本形态断言的
    // 是**清理之后**磁盘上的样子。
    keptIds: ["browser", "system", "bark:1"],
    kept: {
      id: "bark:1",
      type: "bark",
      baseUrl: "https://api.day.app",
      deviceKey: "key-1",
      timeoutMs: 0,
      levels: {},
      name: "手机",
    },
    also: () => {
      // 前提事实：读面**不再**丢弃半坏条目——它原样进视图（写面随后会拒它）。
      // 钉的是职责归属：清理归 upgrade 域，读面不认形态。
      const view = projectForView({
        channels: [{ id: "bark:half", type: "bark", baseUrl: "", deviceKey: "key-half" }],
      });
      expect((view.channels as Channel[])[0].id).toBe("bark:half");
    },
  },
  {
    label: "形态九：webhook 凭据在磁盘上是空串（未设置，不是「一个内容为空的凭据」）",
    disk: diskOf({
      id: "hook:1",
      ...HOOK,
      token: "",
      username: "u",
      password: "",
      headerName: "X-Key",
      headerValue: "",
    }),
    editId: "hook:1",
    part: { name: "群机器人" },
    keptIds: ["browser", "system", "hook:1"],
    // 空串不再被掩码（#1016 缺陷 A），客户端剥空串把它们删掉，于是提交面压根没有这三个键 ⇒
    // 合并原样沿用磁盘上的空串。落盘仍是**空串**，既没被写成占位符，也没被凭空删掉。
    kept: {
      type: "webhook",
      id: "hook:1",
      url: "https://example.test/hook",
      token: "",
      username: "u",
      password: "",
      headerName: "X-Key",
      headerValue: "",
      preset: "custom",
      auth: "none",
      headers: {},
      timeoutSec: 0,
      name: "群机器人",
    },
    also: (_form, trip) => {
      for (const key of ["token", "password", "headerValue"]) {
        expect(key in trip.submitted, key).toBe(false);
        expect(byId(trip.persisted, "hook:1")[key], key).toBe("");
      }
    },
  },
  {
    label: "形态十：webhook 侧的越界值与非法枚举原样保留（形态四的对偶）",
    disk: diskOf({ id: "hook:1", ...HOOK, timeoutSec: 99_999, preset: "nope" }),
    editId: "hook:1",
    part: { name: "群机器人" },
    keptIds: ["browser", "system", "hook:1"],
    // 与形态四同一条纪律：越界与非法枚举由 upgrade 域的形态清理删键，读面不改写它们，于是落盘保持
    // 磁盘原值（99999 / "nope"）。auth 是客户端比较规范形补出来的，它不在磁盘上、不是存量。
    kept: {
      type: "webhook",
      id: "hook:1",
      url: "https://example.test/hook",
      token: "tok",
      username: "u",
      password: "p",
      headerName: "X-Key",
      headerValue: "hv",
      timeoutSec: 99_999,
      preset: "nope",
      auth: "none",
      headers: {},
      name: "群机器人",
    },
    also: (_form, trip) => {
      expect(trip.submitted.timeoutSec).toBe(99_999);
      expect(trip.submitted.preset).toBe("nope");
    },
  },
];

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
/** 半坏 bark：磁盘上本就缺 `baseUrl`——用户在 0.2.8 升级**之后**手改文件造出来的那种形态。 */
const HALF_BARK: Channel = { id: "bark:half", type: "bark", deviceKey: "key-half" };

/** 判据一/二/四的磁盘：两条内置 + 半坏 bark + 一条合法 webhook（用户改的是 webhook，不碰那条坏的）。 */
const HALF_DISK: StoredSettings = diskOf(HALF_BARK, { id: "hook:1", ...HOOK });

/** 合并结论里「存量本就残缺、这次也没补上」的必填键清单（与 `channels` 同下标）。 */
function preexistingOf(merged: ChannelMerge, id: string): ReadonlySet<string> {
  if (!merged.ok) throw new Error("合并本该成功：" + JSON.stringify(merged.error));
  const index = (merged.channels as Channel[]).findIndex((item) => item.id === id);
  if (index < 0) throw new Error("合并结果里没有 id=" + id + " 的频道");
  return merged.preexisting[index];
}

/** 提交面 + 判据：只审合并结果，供「不该被放行」那几条用。 */
function judge(
  channels: readonly Channel[],
  stored: StoredSettings,
): { readonly ok: boolean; readonly hint: string } {
  const merged = mergeChannels(channels as unknown as RawSettingValue, stored.channels ?? []);
  if (!merged.ok) return { ok: false, hint: merged.error.hint };
  const verdict = validateSettingsWithMerge(
    { channels: merged.channels as RawSettingValue[] },
    merged,
  );
  return verdict.ok ? { ok: true, hint: "" } : { ok: false, hint: verdict.error.hint };
}

/**
 * 半坏条目（存量本就缺必填键）不许把用户锁死在设置页外——S3 的一处真实回归。
 *
 * 两条通道撞出来的：读面自 S3 起**不丢弃**半坏条目（视图逐字外发），而写面的「必填键在场」是形状判据、
 * 不看增量。于是用户手改出一条半坏条目之后，此后每一次保存都 400，连改**别的**频道的名字都存不下去。
 * 形态八断言的是 0.2.8 形态清理**之后**的磁盘形态，而那一步只在刻度推进时跑一次，救不了「升级后手改」。
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

  // 判据 5（F4）：webhook 上的 deviceKey（掩码形态）是跨 type 残留，0.2.8 升级清理把它删掉——
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
 * 修的是**写面侧**与清理步侧（0.2.8 形态清理）同源的那条路。清理步修好之后不再造「url 齐全、只是没有
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
