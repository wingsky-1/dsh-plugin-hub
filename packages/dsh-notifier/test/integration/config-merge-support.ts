/**
 * dsh-notifier —— 写面**按字段合并**的共享夹具（#1174 shape 拆分产物）。
 *
 * 归属：support（mutation-topology 的 supportFiles 语义），**不入任何测试层、不计 --min、
 * 不进变异面**。本模块只提供**事实与记录**——磁盘形态的字面量、往返链的调用、合并结论的读取——
 * 不重写被测决策：合并的判定、读面的视图、客户端的剥空串与补值全部仍由被测实现给出。
 *
 * 原文件 test/integration/config-merge-roundtrip.test.ts 按自然职责块拆成两个测试文件
 * （形态回归 / 掩码与 auth），跨文件共用的部分落在这里。三块的 describe 标题、it 标题与
 * 断言逐字保留。
 *
 * 无文件系统、无网络、不碰 DSH_HOME：本模块只跑纯函数，落盘纪律不适用。
 */
import { expect } from "vitest";

import { validateSettingsWithMerge } from "../../src/server/config/impl/input/index.ts";
import type { RawSettingValue, StoredSettings } from "../../src/server/config/impl/model/type.ts";
import { mergeChannels } from "../../src/server/config/impl/service/merge.ts";
import type { ChannelMerge } from "../../src/server/config/impl/service/merge.ts";
import { projectForView } from "../../src/server/config/impl/service/view.ts";
import {
  assignChannelFields,
  diffSettingsPayload,
  snapshotBaseline,
} from "../../src/client/settings/diff.ts";

/** 掩码占位字面量：与设置页、redact 域、merge 域同一份跨端契约（独立写出，不从源码 import）。 */
export const MASK = "********";

/** 合法 bark：写面要求 id / baseUrl / deviceKey 非空。 */
export const BARK = { type: "bark", baseUrl: "https://api.day.app", deviceKey: "key-1" };

/**
 * 合法 webhook：凭据四个键**都**在磁盘上。
 *
 * 为什么不能只写 url：**掩码还原按 id 对齐取原值**，磁盘上没这个键就换不回真凭据；而外发视图
 * 只对**非空**的凭据掩码（空串不掩，见 redact 域的注释），所以四个键都得在磁盘上带着真值，
 * 「凭据在磁盘上是空串」那一支由形态九单独覆盖。
 */
export const HOOK = {
  type: "webhook",
  url: "https://example.test/hook",
  token: "tok",
  username: "u",
  password: "p",
  headerName: "X-Key",
  headerValue: "hv",
};

/** 一条频道（存储层形状不受契约约束，按原始值看）。 */
export type Channel = Record<string, RawSettingValue>;

/** 一次往返的结果。 */
export type RoundTrip = {
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
export function roundTrip(
  disk: StoredSettings,
  editId: string,
  part: Record<string, unknown>,
): RoundTrip {
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
export function submitDraft(
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
export function byId(list: readonly Channel[], id: string): Channel {
  const found = list.find((item) => item.id === id);
  if (found === undefined) throw new Error("落盘结果里没有 id=" + id + " 的频道");
  return found;
}

/**
 * 磁盘形态里的频道数组（dry-run 的原值来源）。存储层的 `channels` 是宽联合而不是数组，
 * 这里按「是数组就用，不是就当没有」收一下——本文件的磁盘形态都由 `diskOf` 造出来，那边恒是数组。
 */
export function channelsOf(stored: StoredSettings): readonly RawSettingValue[] {
  const list = stored.channels;
  return Array.isArray(list) ? list : [];
}

/** 落盘结果的频道 id 列表（顺序是内容的一部分，见 service 域 stableJson 的注释）。 */
export function idsOf(list: readonly Channel[]): string[] {
  return list.map((item) => String(item.id));
}

/**
 * 两条内置条目的形态：0.2.4 的配置形态割接把它们补进文件，0.2.9 的形态清理保证它们恒在场
 * （#1016 S3 起读面不再物化它们），所以除形态七 / 形态八外的磁盘形态都带它们。
 */
export const BROWSER: Channel = {
  type: "browser",
  id: "browser",
  enabled: true,
  popup: true,
  sound: true,
  whenVisible: false,
};

export const SYSTEM: Channel = {
  type: "system",
  id: "system",
  enabled: true,
  popup: true,
  sound: true,
};

/** 磁盘形态：两条内置 + 用户自己配的条目（真实文件里就是这个样子）。 */
export function diskOf(...entries: Channel[]): StoredSettings {
  return { channels: [BROWSER, SYSTEM, ...entries] };
}

/**
 * 十种磁盘形态 + 每种的**预期落盘**。
 *
 * kept 是被改的那条在落盘时的完整字面量：磁盘原样保住的键、客户端交上来的归一化补值、以及用户
 * 改的 name，三者叠加后的终态。手写字面量而不是「跑一遍取输出」——后者会把任何实现（包括写错的
 * 实现）都冻成「预期」。
 */
export type Form = {
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

export const FORMS: readonly Form[] = [
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
    // 用户改个名字都存不下去。删半坏条目因此落到 0.2.9 的形态清理（canonical-keys.ts），本形态断言的
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

/** 半坏 bark：磁盘上本就缺 `baseUrl`——用户在 0.2.9 升级**之后**手改文件造出来的那种形态。 */
export const HALF_BARK: Channel = { id: "bark:half", type: "bark", deviceKey: "key-half" };

/** 判据一/二/四的磁盘：两条内置 + 半坏 bark + 一条合法 webhook（用户改的是 webhook，不碰那条坏的）。 */
export const HALF_DISK: StoredSettings = diskOf(HALF_BARK, { id: "hook:1", ...HOOK });

/** 合并结论里「存量本就残缺、这次也没补上」的必填键清单（与 `channels` 同下标）。 */
export function preexistingOf(merged: ChannelMerge, id: string): ReadonlySet<string> {
  if (!merged.ok) throw new Error("合并本该成功：" + JSON.stringify(merged.error));
  const index = (merged.channels as Channel[]).findIndex((item) => item.id === id);
  if (index < 0) throw new Error("合并结果里没有 id=" + id + " 的频道");
  return merged.preexisting[index];
}

/** 提交面 + 判据：只审合并结果，供「不该被放行」那几条用。 */
export function judge(
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
