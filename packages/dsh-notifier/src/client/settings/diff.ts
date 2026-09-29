/**
 * dsh-notifier 客户端 —— 设置草稿的纯逻辑（差异 / 域过滤 / 字段合并 / 数值钳制）。
 *
 * 抽出来的理由不是分层好看，而是**可判据**：这几个函数决定「保存什么」——提交哪些键、
 * 什么时候整组带走 channels、清空输入算删键还是写空串。它们原先住在 index.tsx 内，而那个
 * 文件 import 了 react 与 style.css，node 无法导入，于是只能挂在公共 apply 上或对源码做正则
 * 来测，实际结果是一条判据都没有。零依赖的独立模块让它们第一次可以被直测。
 *
 * 跨端契约提醒：channels 的空串形态同时被服务端**投递投影**（normalizeConfig）与服务端写面解释，
 * 动这里的剥除/删键语义等于动服务端行为，必须两端一起看。
 *
 * 比较规范形（剥空串 + 按类型补缺省值）**住在 src/shared/channel-compare.ts**，不重写在本文件：
 * 它是「什么算同一份内容」这一问题的口径文本，客户端与宿主端的 merge 都要对着它读（见该文件头）。
 * 两端各留一份就一定会漂——漂了的后果是用户什么都没改却被判成本次改动。
 */
import {
  canonicalChannelsForCompare,
  canonicalSettingsForCompare,
  stripChannelEmpties,
} from "../../shared/interface.ts";

// 这三个函数的**定义**在 src/shared/channel-compare.ts（它是对端可对照的口径文本）。
// 这里原样转出，客户端调用点与判据的导入路径一字不动：搬实现不等于搬入口。
export {
  canonicalSettingsForCompare,
  normalizeChannelForCompare,
  stripChannelEmpties,
} from "../../shared/interface.ts";

/**
 * 基线 diff：返回 settings 相对 baseLine 中**值不同**的键集合（增量 patch，只提交变更键——
 * 防组合层 base 被默认值回写覆盖）。深比较走 stableEqual（键序无关，见下）；比较双方先过
 * 同一比较规范形（normalizeChannelForCompare，双侧——#912 以前只剥 cur 侧，base 侧残留
 * 空串即恒脏）。settings 中不存在于 baseLine 的新增键（diff 语义下的新增）与值不同的
 * 既有键都会被提交；baseLine 中已删除的键不提交删除（增量 merge patch 无删除语义）。
 *
 * 提交形态与比较形态是两回事：payload 里放的是 strip 形态（只剥空串，auth/preset/timeout
 * 与 levels 等原样提交——服务端写面校验看到的是用户真值，缺 auth 照常 400）；比较时才用
 * 规范形（缺键补服务端默认值）。两者分离，比较再对称也不会把一次合法提交洗成非法。
 *
 * @param settings 当前 UI 编辑态（snapshotBaseline 起点，见下）。
 * @param baseLine 加载基线（snapshotBaseline 快照，见下）。
 */
export function diffSettingsPayload(
  settings: Record<string, unknown>,
  baseLine: Record<string, unknown> | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (baseLine === null) return payload;
  for (const key in settings) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    const cur = settings[key];
    const base = baseLine[key];
    // channels 整组提交前对实例做空串可选字段剥除——存量配置（0.2.2 保存失败前/手改 yaml/
    // 旧版本）可能残留 token:"" 等空串形态，UI 编辑任一字段都会触发整组提交把残留一起带走
    // → 写面按字段合并把空串读成**显式删除**（状态 4），用户的凭据被一次无关保存静默删掉；
    // 必填键上更直接撞 400「必填键，不能删除」。剥成键缺席后落进「不动 / preexisting 放行」两条路，
    // 纯读不改草稿，用户后续输入仍经 assignChannelFields 正常写。
    const value = key === "channels" && Array.isArray(cur) ? cur.map(stripChannelEmpties) : cur;
    const same = stableEqual(canonicalForCompare(key, cur), canonicalForCompare(key, base));
    if (!same) payload[key] = value;
  }
  return payload;
}

/** 单键的比较规范形：channels 逐项过共享面的比较规范形，其余键原样。 */
function canonicalForCompare(key: string, value: unknown): unknown {
  if (key === "channels" && Array.isArray(value)) return canonicalChannelsForCompare(value);
  return value;
}

/**
 * 稳定序列化（与服务端 config/impl/service 的 stableJson 同语义，#912 比较键序无关的参照）：
 * 对象递归按键排序，数组保持原序（数组顺序是内容的一部分——频道顺序变了就是变了）。
 * undefined 按 JSON 语义消化：对象里的 undefined 值键直接丢弃（与 JSON.stringify 一致，
 * 基线缺键与草稿显式写 undefined 因此同形）；数组里的 undefined 记 null（同 JSON）；
 * 顶层 undefined（基线缺键逐键读出的形态）给一个显式规范形，保证可比。
 */
export function stableJsonValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : stableJsonValue(item))).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((field) => record[field] !== undefined)
      .sort()
      .map((field) => `${JSON.stringify(field)}:${stableJsonValue(record[field])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * 键序无关的深相等：比较双方先过同一规范形。
 *
 * 以前的口径是“键序不同即视为已变”；#912 改为无关——Object.assign 浅拷贝与合并处的键序
 * 取决于写路径（load/discard/rebase/putAndCommit 各不相同），与用户是否改过东西无关，
 * 敏感即误报（首屏恒脏的次要成因）。
 */
export function stableEqual(a: unknown, b: unknown): boolean {
  return stableJsonValue(a) === stableJsonValue(b);
}

/**
 * 基线快照：服务端 effective 写进 baselineRef 之前先过比较规范形。
 *
 * load 与 discard 与 quiet（applyLatestQuiet）与冲突覆盖（resolveConflictOverwrite）四路径
 * 统一走这里——基线存的是收敛后的形态，重拉与放弃即与草稿同形，不复脏。草稿侧同样用它
 * （渲染等价：输入框里 undefined 与空串同显空，levels 缺席与空对象同由调用点兜住，auth 缺席
 * 回落 none）；提交 payload 仍带齐 auth 与 preset 与 timeout（补齐的值服务端本来就会兜底，
 * wire 语义不变——chAdd 预置的 auth none 与 timeoutSec 10 照常提交）。
 */
export function snapshotBaseline(effective: Record<string, unknown>): Record<string, unknown> {
  return canonicalSettingsForCompare(effective);
}

/**
 * 409 冲突「保留我的修改并覆盖」的 rebase：以服务端最新 effective 为基底，把本地变更键的值
 * 覆盖上去（键级 last-write-wins，与 JSON Merge Patch / Firebase per-key merge 同语义）——
 * 本地变更键集合由调用方在用户触发「覆盖」动作时实时重算（非 409 时刻快照，横幅期间的新编辑
 * 不丢）。顶层浅拷贝即可（settings 不可变更新模式，patch 不原位改对象）。
 *
 * @param localChanges 本地相对旧基线的变更键集合（域/全量均适用）。
 * @param remoteEffective 服务端最新 effective（GET /config 拉取）。
 */
export function rebaseSettings(
  localChanges: Record<string, unknown>,
  remoteEffective: Record<string, unknown>,
): Record<string, unknown> {
  return Object.assign({}, remoteEffective, localChanges);
}

/**
 * 按保存入口从全量 diff 中取子集（域保存）：
 * - entry "all"：原样返回（foot 全量保存）；
 * - entry "channels"：仅保留 channels 键（频道域保存——事件/参数半成品草稿不随频道域保存
 *   提交）；该键不存在时返回空对象；
 * - 未知入口：返回空对象（保守不提交——fail-closed，写错枚举值只会少提交，不会多提交）。
 */
export function domainPayload(
  diff: Record<string, unknown>,
  entry: string,
): Record<string, unknown> {
  if (entry === "all") return diff;
  if (entry === "channels") {
    if (!Object.prototype.hasOwnProperty.call(diff, "channels")) return {};
    return { channels: diff.channels };
  }
  return {};
}

/**
 * 频道实例字段合并：part 中**值为空（`""` / `undefined`）的键写成 `null`**，其余浅覆盖。
 *
 * 为什么是 `null` 而不是删键（#1016 S2，**安全相关**）：服务端写面现在按字段合并，
 * **键缺席读成「不动」**。用户清空 webhook 的 token 后若只是把键删掉，提交里就没有这个键，
 * 合并判它「不动」——旧凭据原封不动留在磁盘上继续被投递，而界面上显示的是空。写 `null` 是
 * 「显式删除」这条独立手势，服务端据此删键，磁盘与界面才重新对上。
 *
 * `undefined` 走同一条路：数字框与下拉清空传的就是 `undefined`，而它们与文本框表达的是
 * 同一个手势——「这个字段不要了」。渲染侧不受影响（`textInput` / `numInput` 把 null 与 undefined
 * 一律回显空串，`ch.levels || {}` 一类取值同样吃得下 null）。
 *
 * 必填键（url / baseUrl / deviceKey）清空后提交，服务端以「必填键，不能删除」400 拒收——
 * 那是对的：一条打不通的频道不该被静默存下来。
 */
export function assignChannelFields(
  target: Record<string, unknown>,
  part: Record<string, unknown>,
): Record<string, unknown> {
  const out = Object.assign({}, target);
  for (const key of Object.keys(part)) {
    const value = part[key];
    out[key] = value === "" || value === undefined ? null : value;
  }
  return out;
}
