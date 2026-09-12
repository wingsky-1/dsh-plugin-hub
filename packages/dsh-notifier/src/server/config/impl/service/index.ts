/**
 * dsh-notifier config 域 —— 设置存取的实现。
 *
 * 状态是实例字段：目录、生效快照、用户层、修订号、写队列。类本身可以被实例化
 * 多次，但域只装配一个——「唯一存取点」靠契约层不导出实例来保证，而不是靠把状态
 * 藏进闭包让别人够不着。
 *
 * 读写都是**组合**而非直通：读 = 文件 → 净化 → 归一化（叠加组合层入口）→ 生效
 * 快照；写 = 掩码还原 → 校验 → 合并 → 原子落盘 → 刷新快照。调用方不需要知道这条
 * 链上有几道工序，也不该知道。
 *
 * **装配期同步读完文件**：读面是同步的，而「装配完成」与「文件读完」之间只要留
 * 一个窗口，窗口内的读者就会拿到尚未生效的默认值——一次几 KB 的同步读换掉整类
 * 竞态，值。
 *
 * 依赖方向：只引用本目录、`../input/`、`../model/`、`../redact/`、包内共享层，
 * 不引用 `interface.ts`。
 */
import { createHash } from "node:crypto";
import type { ConfigDeps } from "../../deps.ts";
import { readTextFileSync, writeTextAtomic } from "../../../shared/file-io.ts";
import { CONFIG_FILE_NAME, notifierFile } from "../../../shared/paths.ts";
import { normalizeConfig, parseJsonObject, sanitizeSettings, validateSettings } from "../input/index.ts";
import { DEFAULT_CONFIG } from "../model/index.ts";
import type { NotifyConfig, RawSettingValue, SettingsPatch, StoredSettings } from "../model/type.ts";
import { redactConfig, unmaskChannels } from "../redact/index.ts";
import type { SettingsView, WriteResult } from "./type.ts";

/** 掩码还原后的写入口 patch；失败 = patch 里的新实例提交了掩码占位。 */
type RestoredPatch = { ok: true; patch: SettingsPatch } | { ok: false };

/** 新增频道提交掩码占位时的拒绝理由（掩码只表达「未修改」，新实例没有原值可还原）。 */
const NEW_CHANNEL_MASK_HINT = "新增频道不能提交掩码占位，请填写真实凭据";

/** 原型链上的危险键名：JSON 文本能造出自有键，展开进设置对象就会改写原型。 */
const UNSAFE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * 未装配时的占位。
 *
 * 装配是必经路径（`installed` 守卫），占位值不会被真正读到；它的作用是让字段有
 * 确定的类型，从而不必让每个使用点都先判一次空。
 */
const UNINSTALLED: ConfigDeps = { entry: {}, logger: { warn: () => {} } };

const NOOP = (): void => {};

/** 通知设置：本插件配置文件的唯一存取点。 */
class ConfigStore {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 落盘路径：DSH home 由环境决定、进程内不变，故随实例一次性定下。 */
  private readonly file = notifierFile(CONFIG_FILE_NAME);
  /** 装配入参（组合层入口层与失败出口）。 */
  private deps: ConfigDeps = UNINSTALLED;
  /** 文件内容原样镜像：写回时以它为基底，才不会被一次保存抹掉不认识的键。 */
  private stored: StoredSettings = {};
  /** 用户层（净化后）：写面做掩码还原、视图做回显都要它。 */
  private user: Partial<NotifyConfig> = {};
  /** 生效设置：入口层与用户层合并、归一化后的形态，读面直接给它。 */
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

  /** 当前生效设置（含明文凭据；不外发）。 */
  current(): NotifyConfig {
    return this.effective;
  }

  /** 设置页视图：脱敏后的用户层与生效值 + 修订号 + 可写性，同一刻取齐。 */
  view(): SettingsView {
    return {
      user: redactConfig(this.user),
      revision: this.revision,
      writable: true,
      effective: redactConfig(this.effective),
    };
  }

  /**
   * 写：掩码还原 → 校验 → 合并 → 落盘 → 刷新快照。
   *
   * 顺序不可换：掩码不是合法的密钥值，未还原就被校验拦死；校验必须晚于掩码还原、
   * 早于落盘，否则非法值会先写进文件再被报错。
   *
   * 校验与合并之间不做净化：净化会把陌生键剔掉，而陌生键是**透传保留**的——文件
   * 里已有的不受影响，本次提交携带的一并写回。
   */
  async write(patch: SettingsPatch, expectedRevision?: number): Promise<WriteResult> {
    const restored = this.restoreSecrets(patch);
    if (!restored.ok) {
      return { ok: false, reason: "invalid", error: { key: "channels", hint: NEW_CHANNEL_MASK_HINT } };
    }
    const verdict = validateSettings(restored.patch);
    if (!verdict.ok) return { ok: false, reason: "invalid", error: verdict.error };

    const incoming = writableEntries(restored.patch);
    return this.enqueue(() => this.commit(incoming, expectedRevision));
  }

  /**
   * 提交：版本比对 → 合并 → 原子落盘 → 采纳。
   *
   * 整段在写队列内执行：版本比对与写入之间若能被另一次写插入，乐观并发就形同虚设
   * ——两次写都读到同一个旧版本、都判定通过，后写的那次把先写的悄悄覆盖。
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
    this.effective = normalizeConfig({ ...this.deps.entry, ...stored });
    this.revision = revisionOf(stored);
  }

  /**
   * 掩码还原：patch 里等于掩码的密钥字段，按 id 换回用户层原值。
   *
   * 只在 patch 带了频道时才有这一步——其余键没有密钥语义。
   */
  private restoreSecrets(patch: SettingsPatch): RestoredPatch {
    const channels = patch.channels;
    if (channels === undefined) return { ok: true, patch };
    const restored = unmaskChannels(channels, this.user.channels);
    return restored.ok ? { ok: true, patch: { ...patch, channels: restored.channels } } : { ok: false };
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
 * 提交体 → 可写入的原始设置。
 *
 * 只剔除原型链危险键，其余（含契约不认识的键）原样放行：配置文件里的陌生键可能是
 * 手写的、也可能是更高版本留下的，一次保存把它们抹掉属于静默破坏。
 */
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
 * 键先排序再进摘要——键序不是内容，同一份设置在两次读写之间换了键序不该被当成
 * 改动，否则界面会凭空收到一次「你编辑期间它变了」。
 */
function revisionOf(stored: StoredSettings): number {
  const text = JSON.stringify(stored, Object.keys(stored).sort());
  return createHash("sha256").update(text, "utf8").digest().readUInt32BE(0);
}
