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
import {
  UNSAFE_KEYS,
  normalizeConfig,
  parseJsonObject,
  sanitizeSettings,
  validateSettingsWithMerge,
} from "../input/index.ts";
import { mergeChannels } from "./merge.ts";
import { projectForView } from "./view.ts";
import { DEFAULT_CONFIG } from "../model/index.ts";
import type {
  NotifyConfig,
  RawSettingValue,
  SettingInvalid,
  SettingsPatch,
  StoredSettings,
} from "../model/type.ts";
import { redactStored } from "../redact/index.ts";
import type { SettingsView, WriteResult } from "./type.ts";

/** 合并结论的包装：`merged` 为 undefined = 本次提交没有 `channels` 这个键（「没动它」）。 */
type MergeOutcome =
  | {
      readonly ok: true;
      readonly merged:
        | {
            readonly channels: RawSettingValue;
            readonly inherited: readonly ReadonlySet<string>[];
            readonly preexisting: readonly ReadonlySet<string>[];
          }
        | undefined;
    }
  | { readonly ok: false; readonly error: SettingInvalid };

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
  /** 生效设置（**投递投影**）：归一化补过默认值、收敛过越界，**不外发**——`current()` 拿它。 */
  private effective: NotifyConfig = DEFAULT_CONFIG;
  /** 视图投影（**外发**）：键子集 + 原样 + 掩码，**不补默认值**。与投递投影是两份数据，见 view 模块的文件头。 */
  private viewConfig: Partial<NotifyConfig> = {};
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

  /** 当前生效设置（**投递投影**：补过默认值、收敛过越界；含明文凭据，**不外发**）。
   *
   *  pipeline / sdk / stores / dry-run 全靠它，故它一行不改地继续喂 `normalizeConfig` 的结果。 */
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
      // 视图投影**不是**投递投影（#1016 S3）：外发的是「磁盘原样 + 掩码」，补出来的默认值与被钳过的
      // 越界值留在域内。两者混用会让一次无关保存把磁盘形态改写成读面的实现——见 view 模块的文件头。
      effective: this.viewConfig,
    };
  }

  /**
   * 写：整段挂进写队列，队列内完成按字段合并（含掩码还原）→ 校验 → 落盘 → 刷新快照。
   *
   * 为什么不把合并与校验留在队列外：两者都要读存量（合并沿用哪些键、判据据此决定重判哪些），
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
   * 一次写的全过程：按字段合并（含掩码还原）→ 校验合并结果 → 落盘 → 刷新快照。
   *
   * **整段在写队列内**，合并与校验都算在内（issue #1016 批次 B）。原来还原与校验在队列外，
   * 于是它们读到的存量是「入队那一刻」的：并发的两次写里，后一次会用前一次落盘**之前**的
   * 用户层去还原掩码、判定「原样带回」，基线跟着另一次写漂走。把它们移进队列后，合并、判据
   * 三者看到的是同一份存量快照。
   *
   * 顺序不可换（#1016 S2）：合并必须**先于**校验——判据审的是合并后的条目，而「删键之后必填键
   * 此刻为空」这条判据只有合并之后才问得出；校验必须早于落盘，否则非法值会先写进文件。掩码在
   * 合并里解（五态之一，见 merge 模块），不再有独立的还原步骤：两条路径各解一次会让「掩码在
   * 哪一步变成原值」有两个答案，而判据看到的形态与落盘的形态就必须逐字一致。
   *
   * 校验与合并之间不净化：磁盘上**存量**的陌生键不在提交里，合并原样沿用，一次保存抹不掉它们；
   * 而**本次提交**的陌生键由判据 400（#1016 S2 删掉了 extras 透传面）。0.2.3 的顶层渠道键已由
   * upgrade 域在装配期搬走，写面收到它们会被校验直接拒（退役键清单），不在这里做二次翻译。
   * 合并那一侧读哪份存量（磁盘原样，不是 effective）由 `mergePatchChannels` 的注释交代。
   */
  private async apply(patch: SettingsPatch, expectedRevision?: number): Promise<WriteResult> {
    const outcome = mergePatchChannels(patch.channels, this.stored);
    if (!outcome.ok) return { ok: false, reason: "invalid", error: outcome.error };
    // 判据看**合并后**的频道条目（形状与必填键）；顶层键仍按提交面逐值判——顶层没有按键合并这回事。
    const verdict = validateSettingsWithMerge(patch, outcome.merged);
    if (!verdict.ok) return { ok: false, reason: "invalid", error: verdict.error };

    const subject: SettingsPatch =
      outcome.merged === undefined ? patch : { ...patch, channels: outcome.merged.channels };
    const incoming = writableEntries(subject);
    return this.commit(incoming, expectedRevision);
  }

  /**
   * 提交：版本比对 → 合并 → 原子落盘 → 采纳。
   *
   * 整段在写队列内执行：比对与写入之间若能被另一次写插入，乐观并发就形同虚设
   * ——两次写都读到同一旧版本、都判定通过，后写的把先写的悄悄覆盖。
   *
   * `expectedRevision` 与合并结果的 `inherited` **语义不同，不许合并成一个参数**：
   * 前者是**内容摘要**比对，防的是「两个客户端同时改」的丢失更新（防的是覆盖）；
   * 后者是**同 id 同 type 同名字段**的沿用清单，解的是「存量非法值不该因一次无关保存被拒」的
   * 过度拒绝（防的是错杀）。两者一个按内容断版本、一个按字段认改动，混在一起会让任一条判据
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

  /**
   * 文件内容到达：镜像原样留下，**两份投影**由它各自派生（#1016 S3）。
   *
   * 这一行是「读面拆两条通道」的落点：`effective` 走归一化（投递侧要完整形态），`viewConfig` 走
   * 键子集投影（外发侧要磁盘原样）。两者曾共用一份数据，于是「补出来的默认值」被当成用户存过的值
   * 交回磁盘——见 view 模块的文件头与 `view()` 的注释。
   */
  private adopt(stored: StoredSettings): void {
    this.stored = stored;
    this.user = sanitizeSettings(stored);
    this.effective = normalizeConfig(stored);
    this.viewConfig = projectForView(stored);
    this.revision = revisionOf(stored);
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

/**
 * 提交里的 `channels` → 合并结果（掩码也在这一步解，见 merge 模块的五态）。
 *
 * 基线取 `stored`（**磁盘原样**）而不是 `effective`：合并的目的是「客户端没带的字段落盘后还在」，
 * 而 effective 是归一化补过默认值、剥过空串、钳过越界的形态——拿它当基底等于把一份补值写回文件，
 * 让磁盘上的形态随读面实现漂移。
 *
 * 提交里没有 `channels` 这个键时给 `undefined`（「这次没动它」）：顶层仍是整值替换，提交里没有
 * 的键不进 `merged`，由 `commit` 的基底原样带过去。
 */
function mergePatchChannels(
  channels: RawSettingValue | undefined,
  stored: StoredSettings,
): MergeOutcome {
  if (channels === undefined) return { ok: true, merged: undefined };
  const merged = mergeChannels(channels, stored.channels ?? []);
  if (!merged.ok) return { ok: false, error: merged.error };
  return {
    ok: true,
    // 两笔账整份带过去：值域判据看 inherited（「值原样来自存量」），「必填键在场」看 preexisting
    // （「键的缺席本来就来自存量」）。判据侧按同下标取用，见 MergedChannelScope。
    merged: {
      channels: merged.channels,
      inherited: merged.inherited,
      preexisting: merged.preexisting,
    },
  };
}

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
