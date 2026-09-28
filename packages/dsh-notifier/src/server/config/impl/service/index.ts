/**
 * dsh-notifier config 域 —— 设置存取的实现：读 = 文件 → 净化 → 归一化 → 快照，写 = 掩码还原 → 校验 → 合并 → 落盘。
 *
 * 装配期同步读完文件：读面是同步的，留一个窗口就会有读者拿到尚未生效的默认值。
 */
import { createHash } from "node:crypto";
import type { ConfigDeps } from "../../deps.ts";
import {
  readTextFileSync,
  writeTextAtomic,
  CONFIG_FILE_NAME,
  notifierFile,
} from "../../../shared/interface.ts";
// 两端共享面（不是上面那个 server/shared）：频道比较规范形与客户端 diff 共用同一份。
import { canonicalChannelsForCompare } from "../../../../shared/interface.ts";
import {
  normalizeConfig,
  parseJsonObject,
  sanitizeSettings,
  validateSettingsWithBase,
} from "../input/index.ts";
import { DEFAULT_CONFIG } from "../model/index.ts";
import type {
  NotifyConfig,
  RawSettingValue,
  SettingsPatch,
  StoredSettings,
} from "../model/type.ts";
import { redactConfig, redactStored, unmaskChannels } from "../redact/index.ts";
import type { SettingsView, WriteResult } from "./type.ts";

/** 掩码还原后的写入口 patch；失败 = patch 里的新实例提交了掩码占位。 */
type RestoredPatch = { ok: true; patch: SettingsPatch } | { ok: false };

/** 新增频道提交掩码占位时的拒绝理由（掩码只表达「未修改」，新实例没有原值可还原）。
 *
 * 导出给草稿测试（dry-run）复用同一句话：id 改名带掩码、无源新频道带掩码都是「没有原值可还原」
 * 的同一种失败，两处各写一句迟早漂成两种说法。 */
export const NEW_CHANNEL_MASK_HINT = "新增频道不能提交掩码占位，请填写真实凭据";

/** 原型链上的危险键名：JSON 文本能造出自有键，展开进设置对象就会改写原型。 */
const UNSAFE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** 未装配时的占位：装配是必经路径，占位只是让字段不必每个使用点判空。 */
const UNINSTALLED: ConfigDeps = { logger: { warn: () => {} } };

const NOOP = (): void => {};

/** 通知设置：本插件配置文件的唯一存取点。 */
class ConfigStore {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 落盘路径：DSH home 由环境决定、进程内不变，故随实例一次性定下。 */
  private readonly file = notifierFile(CONFIG_FILE_NAME);
  /** 装配入参（失败出口）。 */
  private deps: ConfigDeps = UNINSTALLED;
  /** 文件内容原样镜像：写回时以它为基底，才不会被一次保存抹掉不认识的键。 */
  private stored: StoredSettings = {};
  /** 用户层（净化后）：写面做掩码还原、视图做回显都要它。 */
  private user: Partial<NotifyConfig> = {};
  /** 生效设置：用户层归一化后的形态，读面直接给它。 */
  private effective: NotifyConfig = DEFAULT_CONFIG;
  /** 用户层修订号（内容摘要）：乐观并发的比较依据。 */
  private revision = 0;
  /** 写队列尾：新写挂在它后面，「读-改-写」不会交错。 */
  private tail: Promise<void> = Promise.resolve();

  /** 装配：读一次文件定下初值；此后只经 `write` 变更。 */
  install(deps: ConfigDeps): void {
    if (this.installed) throw new Error("dsh-notifier: config 域只能装配一次");
    this.installed = true;
    this.deps = deps;
    const read = readTextFileSync(this.file);
    // 没有文件与文件是空的，对读面是同一件事：都没有用户层。
    this.adopt(read.ok ? parseJsonObject(read.text) : {});
  }

  /** 卸载：放开装配入参并丢掉用户层快照——它同时是「用户层」与「磁盘状态」的记忆。 */
  release(): void {
    this.installed = false;
    this.deps = UNINSTALLED;
    this.adopt({});
  }

  /** 当前生效设置（含明文凭据；不外发）。 */
  current(): NotifyConfig {
    return this.effective;
  }

  /** 设置页视图：脱敏后的用户层与生效值 + 修订号 + 可写性，同一刻取齐。 */
  view(): SettingsView {
    return {
      // `user` 是**存储原样**（只掩码）：陌生键也要看得见——净化后的 this.user 里没有它们，
      // 而它们确实还在文件里，视图不显示就等于「文件里有、界面里没有」两套事实。
      user: redactStored(this.stored),
      revision: this.revision,
      writable: true,
      effective: redactConfig(this.effective),
    };
  }

  /**
   * 写：整段挂进写队列，队列内完成掩码还原 → 校验 → 合并 → 落盘 → 刷新快照。
   *
   * 为什么不把还原与校验留在队列外：它们都要读存量（掩码还原的原值、校验的基线），
   * 队列外读到的存量会被并发的另一次写抽走。详见 `apply` 的注释。
   *
   * `apply` 必须**直调 commit，不得再 enqueue**：enqueue 同步把 tail 设成 result.then(...)，
   * task 内再 enqueue 就是等自己刚挂上去的 tail——那个 tail 排在自己后面，自己不返回它就不 resolve。
   * 故 apply 与 commit 之间不经队列，是**结构上**写死的，不靠调用方记得。
   */
  async write(patch: SettingsPatch, expectedRevision?: number): Promise<WriteResult> {
    return this.enqueue(() => this.apply(patch, expectedRevision));
  }

  /**
   * 一次写的全过程：掩码还原 → 带存量基线的校验 → 合并 → 落盘 → 刷新快照。
   *
   * **整段在写队列内**，还原与校验都算在内（issue #1016 批次 B）。原来还原与校验在队列外，
   * 于是它们读到的存量是「入队那一刻」的：并发的两次写里，后一次会用前一次落盘**之前**的
   * 用户层去还原掩码、判定「原样带回」，基线跟着另一次写漂走。把它们移进队列后，还原、判据、
   * 合并三者看到的是同一份存量快照。
   *
   * 顺序不可换：掩码不是合法密钥值，未还原就被校验拦死；校验早于落盘，否则非法值会先写进文件。
   * 校验与合并之间不净化：陌生键是透传保留的，一次保存不该把它们抹掉。0.2.3 的顶层渠道键已由
   * upgrade 域在装配期搬走，写面收到它们会被校验直接拒（退役键清单），不在这里做二次翻译。
   *
   * **基线取「客户端看过的那份视图」，且是明文**（`writeScopeOf` 的入参，见 `baseChannels`）：
   * 取磁盘原样（`this.user.channels`）是错的——客户端草稿来自 `GET /config` 的 `effective`
   * 再过一遍比较规范形，它交回的每一个键都是归一化之后的形态。拿磁盘原样当基线，客户端带回的
   * 归一化补值（enabled/timeoutMs/levels/auth/preset/headers/timeoutSec）、空串剥除、非法值钳制、
   * 陌生键搬进 extras、旧顶层键投影就全成了「本次改动」：最普通的一份 bark 配置，用户只改名字，
   * 机制会报三到八个字段都动过。实测 10 种磁盘形态（形态清单与逐条判据见
   * test/integration/config-write-scope-roundtrip.test.ts 的十条形态用例，与下表一一对应）：
   *
   *   形态                              user-base  裸 effective  canon-base
   *   1 最普通 bark                          3           4          0
   *   2 webhook                             5           1          0
   *   3 残留空串                            7           4          0
   *   4 越界钳制                            3           4          0
   *   5 非法枚举                            4           4          0
   *   6 陌生键搬 extras                     5           4          0
   *   7 旧顶层键投影                        5           0          0
   *   8 半坏条目并存                        3           4          0
   *   9 webhook 凭据空串                    8           4          0
   *   10 webhook 越界+非法枚举               5           1          0
   *   区间                                  3~8         0~4        全 0
   *
   * 三列的读法：同一份磁盘、同一组用户手势，只换基线取哪一侧。三条要点——**区间下界来自
   * 最普通的那份 bark**（形态 1/4/8 各 3），**上界来自形态九**（凭据在磁盘上是空串，掩码往返
   * 把三个空串请回提交侧），**canon-base 全 0 才是本机制要的那个数**：另两列不是「差不多对」，
   * 是系统性偏。
   *
   * canon-base 那一列**不是**「把基线取对就够」：凭据字段的空串是在掩码还原**之后**才回到提交侧
   * 的（磁盘 token:"" → 读出口掩码 → 客户端原样带回 → 服务端还原成 ""），基线再对，提交侧不跟着
   * 剥空串仍然是三个假阳性。两侧同形这件事两端各做一半，见 `writeScopeOf` 里的剥除。
   *
   * 不套 redactConfig：比的是**明文**，而掩码还原的原值也是明文，两侧同源才逐字节相同。
   * 归一化视图里没有的半坏条目（无投递目标的空壳）在两侧**同时缺席**，天然不参与比较——
   * 客户端草稿里本来就没有它，真实往返链不会把它带回来。
   *
   * `checked.scope`（本次改动 vs 存量带回）本 PR 不据此拒任何东西：判据结论与不带基线时逐字
   * 相同。它随返回值交出去，是后续边界判据（重复 id / URL 写面 / 边界值）唯一要接的缝。
   */
  private async apply(patch: SettingsPatch, expectedRevision?: number): Promise<WriteResult> {
    const restored = this.restoreSecrets(patch);
    if (!restored.ok) {
      return {
        ok: false,
        reason: "invalid",
        error: { key: "channels", hint: NEW_CHANNEL_MASK_HINT },
      };
    }
    const checked = validateSettingsWithBase(restored.patch, this.baseChannels());
    const verdict = checked.verdict;
    if (!verdict.ok) return { ok: false, reason: "invalid", error: verdict.error };

    const incoming = writableEntries(restored.patch);
    return this.commit(incoming, expectedRevision);
  }

  /**
   * 写面判定用的存量基线：**客户端看过的那份视图**，明文。
   *
   * 为什么是 effective 而不是 `this.user.channels`（磁盘原样）：客户端的草稿与基线都来自
   * `GET /config` 的 `effective`，提交回来的是那份的子集。磁盘原样与客户端所见在归一化补值、
   * 空串剥除、非法值钳制、陌生键搬 extras、旧顶层键投影这五类上分叉——两侧形态不同，
   * 「原样带回」就会被读成「本次改动」，而用户明明只改了一个字段。
   *
   * 为什么还要过一遍 `canonicalChannelsForCompare`：`effective` 自己会写出空串
   * （normalize 的「空串即没有」是输出约定），而客户端提交前会把这些空串剥掉（stripChannelEmpties）。
   * 基线不跟着剥，同一批空串就成了假阳性。与客户端**共用同一份**比较规范形，两端才不会各自漂。
   *
   * 基线这一侧剥了还不够，提交侧也得剥（`writeScopeOf` 里做）：凭据字段的空串是**掩码往返之后**
   * 才回到提交侧的——磁盘上 `token:""` 的频道，读出口把它掩码成占位、客户端原样带回占位、
   * 服务端按 id 还原成 ""。还原发生在剥除之后，于是那一批空串只在提交侧出现，基线侧永远没有。
   * 这是「只有密钥字段会这样」的原因：只有它们走掩码往返。
   *
   * 为什么明文不掩码：掩码还原（restoreSecrets）的原值来源是 `this.user.channels`，还原出来的是
   * 明文；基线若带掩码，客户端原样带回的凭据就会与基线逐字不等，被读成「用户刚改过凭据」。
   */
  private baseChannels(): RawSettingValue {
    return canonicalChannelsForCompare(this.effective.channels) as RawSettingValue;
  }

  /**
   * 提交：版本比对 → 合并 → 原子落盘 → 采纳。
   *
   * 整段在写队列内执行：比对与写入之间若能被另一次写插入，乐观并发就形同虚设
   * ——两次写都读到同一旧版本、都判定通过，后写的把先写的悄悄覆盖。
   *
   * `expectedRevision` 与 `apply` 里的存量基线**语义不同，不许合并成一个参数**：
   * 前者是**内容摘要**比对，防的是「两个客户端同时改」的丢失更新（防的是覆盖）；
   * 后者是**同 id 同名字段**比对，解的是「存量非法值不该因一次无关保存被拒」的过度拒绝
   * （防的是错杀）。两者一个按内容断版本、一个按字段认改动，混在一起会让任一条判据
   * 悄悄变成另一条：把字段比对当版本号，用户改一个字段就凭空冲突；把版本号当字段比对，
   * 别的键变过就会让这次保存看起来「没改过」。
   */
  private async commit(incoming: StoredSettings, expectedRevision?: number): Promise<WriteResult> {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { ok: false, reason: "conflict" };
    }
    const merged: StoredSettings = { ...this.stored, ...incoming };
    const written = await writeTextAtomic(this.file, `${JSON.stringify(merged, null, 2)}\n`);
    if (!written.ok) {
      this.deps.logger.warn(`dsh-notifier: 配置写入失败 — ${written.reason}`);
      return { ok: false, reason: "unavailable" };
    }
    this.adopt(merged);
    return { ok: true, view: this.view() };
  }

  /** 文件内容到达：镜像原样留下，用户层与生效值由它派生。 */
  private adopt(stored: StoredSettings): void {
    this.stored = stored;
    this.user = sanitizeSettings(stored);
    this.effective = normalizeConfig(stored);
    this.revision = revisionOf(stored);
  }

  /** 掩码还原：patch 里等于掩码的密钥字段按 id 换回用户层原值；只有带了频道才需要这一步。 */
  private restoreSecrets(patch: SettingsPatch): RestoredPatch {
    const channels = patch.channels;
    if (channels === undefined) return { ok: true, patch };
    const restored = unmaskChannels(channels, this.user.channels);
    return restored.ok
      ? { ok: true, patch: { ...patch, channels: restored.channels } }
      : { ok: false };
  }

  /** 把一次写挂到队列尾；前一次无论成败，后一次都照常执行。 */
  private enqueue(task: () => Promise<WriteResult>): Promise<WriteResult> {
    const result = this.tail.then(task, task);
    this.tail = result.then(NOOP, NOOP);
    return result;
  }
}

/** 本域唯一的存取点实例：类不外放，外面 `new` 不出第二份设置状态。 */
export const configStore = new ConfigStore();

/** 提交体 → 可写入的原始设置：只剔除原型链危险键，契约不认识的键原样放行（抹掉属于静默破坏）。 */
function writableEntries(patch: SettingsPatch): StoredSettings {
  const entries: Record<string, RawSettingValue> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || UNSAFE_KEYS.includes(key)) continue;
    entries[key] = value;
  }
  return entries;
}

/**
 * 修订号：用户层内容的摘要。
 *
 * 键序不是内容，换键序不该算改动；但排序必须**递归**做——`JSON.stringify` 的 replacer
 * 数组会作用到每一层，用它排顶层键会把嵌套键（频道、免打扰、路由表）统统丢掉，两份内容
 * 不同的设置于是算出同一个修订号，乐观并发的版本冲突漏判。
 */
function revisionOf(stored: StoredSettings): number {
  return createHash("sha256").update(stableJson(stored), "utf8").digest().readUInt32BE(0);
}

/** 稳定序列化：对象递归按键排序，数组保持原序（数组顺序是内容的一部分）。 */
function stableJson(value: RawSettingValue): string {
  if (isJsonArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isJsonObject(value)) {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** JSON 数组：`readonly` 数组落在 `Array.isArray` 的收窄结果之外，用守卫补上。 */
function isJsonArray(value: RawSettingValue): value is readonly RawSettingValue[] {
  return Array.isArray(value);
}

/** JSON 对象：排除数组与 `null`（`typeof null` 也是 `"object"`）。 */
function isJsonObject(value: RawSettingValue): value is StoredSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
