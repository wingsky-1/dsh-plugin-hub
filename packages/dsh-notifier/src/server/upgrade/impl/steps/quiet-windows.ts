/**
 * upgrade 域 0.2.5 → 0.2.6：免打扰多时间窗——把旧的顶层 start/end 搬进 windows[0] 并删除旧键。
 *
 * 为什么直接读写文件而不是走 config 域的写面：与 0.2.4 的配置形态割接同理，链跑在各域装配之前，
 * 那时写面没有装配好的配置镜像（见 steps/config-shape.ts 的注释）。本步只做结构搬运，不解释语义：
 * 起止是否合法由 config 域归一化在装配后判定，这里只认有没有这两个键。
 *
 * 幂等：windows 已在场、没有配置文件、没有 quietHours、旧键不全时都直接返回，重跑与首次跑的结果逐字相同。
 */
import {
  readTextFileSync,
  writeTextAtomicSync,
  CONFIG_FILE_NAME,
  notifierFile,
} from "../../../shared/interface.ts";
import type { RawSettingValue } from "../../deps.ts";

/** 旧形的两个时钟键：值搬进 windows[0] 之后删除——同一个事实不留两处表达。 */
const LEGACY_CLOCK_KEYS: readonly string[] = ["start", "end"];

/**
 * 割接：旧 start/end 搬进 windows[0] 并删除旧键。
 *
 * 只搬「两个键都在」的完整旧形：缺了一半的文件不动（读面 legacy 回落会把它看成默认窗口，
 * 而搬一半等于替用户编半个窗口——割接不替用户决定取值，见 config-shape.ts 的同款纪律）。
 */
export function migrateQuietWindows(): void {
  const file = notifierFile(CONFIG_FILE_NAME);
  const read = readTextFileSync(file);
  if (!read.ok) return;
  const stored = parseObject(read.text);
  const shaped = withQuietWindows(stored);
  // 没有活要干时一个字都不写：每次启动重写文件会把用户手改的格式重新序列化，那是静默改写而不是迁移。
  if (shaped === null) return;
  const written = writeTextAtomicSync(file, JSON.stringify(shaped, null, 2) + "\n");
  if (!written.ok) throw new Error("dsh-notifier: 免打扰多时间窗割接落盘失败 — " + written.reason);
}

/** 割接后的形态；null = 没有可搬的键（幂等出口）。 */
function withQuietWindows(
  stored: Record<string, RawSettingValue>,
): Record<string, RawSettingValue> | null {
  const quiet = stored.quietHours;
  if (!isRecord(quiet)) return null;
  if (Array.isArray(quiet.windows)) {
    // 已迁移：正常路径旧键早已删除，防的只是手改出的混合形态（windows 与旧键并存）。
    if (quiet.start === undefined && quiet.end === undefined) return null;
    const cleaned: Record<string, RawSettingValue> = { ...quiet };
    for (const key of LEGACY_CLOCK_KEYS) delete cleaned[key];
    return { ...stored, quietHours: cleaned };
  }
  if (typeof quiet.start !== "string" || typeof quiet.end !== "string") return null;
  const next: Record<string, RawSettingValue> = {
    ...quiet,
    windows: [{ start: quiet.start, end: quiet.end }],
  };
  for (const key of LEGACY_CLOCK_KEYS) delete next[key];
  return { ...stored, quietHours: next };
}

/** 文件内容 → 对象；坏 JSON 与非对象都当「没有配置」——一份读不动的文件不该让启动失败。 */
function parseObject(text: string): Record<string, RawSettingValue> {
  try {
    const parsed: RawSettingValue = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
