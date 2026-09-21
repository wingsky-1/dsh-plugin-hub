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
  normalizeConfig,
  parseJsonObject,
  sanitizeSettings,
  validateSettings,
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
   * 写：掩码还原 → 校验 → 合并 → 落盘 → 刷新快照。
   *
   * 顺序不可换：掩码不是合法密钥值，未还原就被校验拦死；校验早于落盘，否则非法值会先写进文件。
   * 校验与合并之间不净化：陌生键是透传保留的，一次保存不该把它们抹掉。0.2.3 的顶层渠道键已由
   * upgrade 域在装配期搬走，写面收到它们会被校验直接拒（退役键清单），不在这里做二次翻译。
   */
  async write(patch: SettingsPatch, expectedRevision?: number): Promise<WriteResult> {
    const restored = this.restoreSecrets(patch);
    if (!restored.ok) {
      return {
        ok: false,
        reason: "invalid",
        error: { key: "channels", hint: NEW_CHANNEL_MASK_HINT },
      };
    }
    const verdict = validateSettings(restored.patch);
    if (!verdict.ok) return { ok: false, reason: "invalid", error: verdict.error };

    const incoming = writableEntries(restored.patch);
    return this.enqueue(() => this.commit(incoming, expectedRevision));
  }

  /**
   * 提交：版本比对 → 合并 → 原子落盘 → 采纳。
   *
   * 整段在写队列内执行：比对与写入之间若能被另一次写插入，乐观并发就形同虚设
   * ——两次写都读到同一旧版本、都判定通过，后写的把先写的悄悄覆盖。
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
