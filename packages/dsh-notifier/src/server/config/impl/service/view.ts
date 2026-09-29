/**
 * dsh-notifier config 域 —— **视图投影**（#1016 重构第 4 步：读面拆「投递投影 / 外发视图」）。
 *
 * 读面有两条出口，它们要的东西**相反**，过去共用一份数据（`normalizeConfig` 的结果）才一直互相别扭：
 *   - **投递投影**（`normalizeConfig`，service 域内私有）：缺键补默认、越界钳回合法域、认不出的条目丢弃。
 *     域内消费者（pipeline / sdk / stores / dry-run）要的是「一份一定可用的完整设置」，**宿主的解释在
 *     这一侧就该做完**，故它一行都不改地继续喂 `current()` / `readConfig()`。
 *   - **视图投影**（本模块，外发客户端）：**只做「键子集 + 原样 + 掩码」**。补出来的默认值是宿主侧的
 *     解释，外发出去等于让客户端把它当成「用户存过的值」原样提交回磁盘——一次无关保存就把磁盘形态改写成
 *     读面的实现（越界值被钳成 0、非法枚举被换成 custom），而用户什么都没碰过。
 *
 * 因此本模块的纪律是「**除掩码外一个字都不改**」：不补默认值、不钳越界、不丢非法值、不补内置条目、
 * 不投影旧键。磁盘上是什么，客户端看见的就是什么。
 *
 * 两处与读面不同，且都是刻意的：
 *   1. **顶层只取 11 个已知键**（`DEFAULT_CONFIG` 的键集，`channels` 是其中之一），磁盘上的顶层陌生键
 *      不进视图。理由不是洁癖：写面对未知顶层键一律 400（`verdictOf` 的 CONFIG_KEYS 判据），把它交给
 *      客户端只会被原样带回并当场被拒——视图给出一份「提交必然 400」的数据，用户改个名字都存不下去。
 *   2. **顶层缺键取默认表的值**（键集恒为 11 个）。设置页要渲染全部 11 个控件，缺一个就是一处空白；而
 *      顶层不存在「用户写过什么被改写」——值一旦在磁盘上就原样穿过，缺的才给默认值。这与上面的「不补默认值」
 *      不冲突：那条纪律针对的是 `channels` **条目内部**的补值，而那正是会被交回磁盘的那部分。
 *
 * **本模块不做任何键名映射**——这是 S3 的一项承重依赖，理由见 `projectForView` 的注释。
 */
import { DEFAULT_CONFIG } from "../model/index.ts";
import type { NotifyConfig, RawSettingValue, StoredSettings } from "../model/type.ts";
import { redactStored } from "../redact/index.ts";

/**
 * 视图的顶层键集：默认表的 11 个键。派生而不是另抄一份清单——抄一份的症状是「模型加了键而视图里没有它」，
 * 设置页会少一个控件且无从察觉。
 */
const VIEW_KEYS: readonly (keyof NotifyConfig)[] = Object.keys(
  DEFAULT_CONFIG,
) as (keyof NotifyConfig)[];

/**
 * 视图投影：磁盘形态 → 外发给客户端的那一份（凭据已掩码）。
 *
 * **不做任何键名映射**：磁盘上频道条目里的陌生键原样进视图，客户端原样带回，写面 merge 判它「原样带回」
 * 进 `inherited` 因而不重判值域，于是它既不丢也不撞 400。这条链的前提是**客户端不对该键做任何投影**：
 * 将来客户端若把它映射成别的键名（或改名/丢弃），写面看到的就是一次「本次提交」而不是「原样带回」，随即
 * 400（`validateKnownKeys`）。改动客户端 `stripChannelEmpties` / `normalizeChannelForCompare` 的键清单时
 * 必须一并重看本段。
 */
export function projectForView(stored: StoredSettings): Partial<NotifyConfig> {
  // 累加器用可写索引签名（`StoredSettings` 是只读的存储镜像，构造中的对象不是存储）。
  const picked: Record<string, RawSettingValue> = {};
  for (const key of VIEW_KEYS) {
    const onDisk = stored[key];
    picked[key] = onDisk === undefined ? DEFAULT_CONFIG[key] : onDisk;
  }
  // 掩码是本模块唯一允许的加工，且实现在 redact 域（`redactStored` = 键子集原样 + 掩码）：凭据明文出到
  // 界面是安全问题，两个出口必须共用同一份掩码实现，抄一份就一定会漂。
  return redactStored(picked) as Partial<NotifyConfig>;
}
