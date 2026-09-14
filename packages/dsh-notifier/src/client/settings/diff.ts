/**
 * dsh-notifier 客户端 —— 设置草稿的纯逻辑（差异 / 域过滤 / 字段合并 / 数值钳制）。
 *
 * 抽出来的理由不是分层好看，而是**可判据**：这几个函数决定「保存什么」——提交哪些键、
 * 什么时候整组带走 channels、清空输入算删键还是写空串。它们原先住在 index.tsx 内，而那个
 * 文件 import 了 react 与 style.css，node 无法导入，于是只能挂在公共 apply 上或对源码做正则
 * 来测，实际结果是一条判据都没有。零依赖的独立模块让它们第一次可以被直测。
 *
 * 跨端契约提醒：channels 的空串形态同时被服务端读面 normalize 与服务端写面校验解释，
 * 动这里的剥除/删键语义等于动服务端行为，必须两端一起看。
 */

/**
 * 基线 diff：返回 settings 相对 baseLine 中**值不同**的键集合（增量 patch，只提交变更键——
 * 防组合层 base 被默认值回写覆盖）。深比较用 JSON.stringify（值同序同即视为未变，UI 编辑
 * 对象字段时键序稳定）。settings 中不存在于 baseLine 的新增键（diff 语义下的新增）与值不同的
 * 既有键都会被提交；baseLine 中已删除的键不提交删除（增量 merge patch 无删除语义）。
 *
 * @param settings 当前 UI 编辑态（effective 深拷贝起点）。
 * @param baseLine 加载基线（loadCard 时的 effective 深拷贝）。
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
    // → 400 死锁。剥除与读面 normalize（空串按未配置剥除）同语义，纯读不改草稿，用户后续
    // 输入仍经 assignChannelFields 正常写。
    const value = key === "channels" && Array.isArray(cur) ? cur.map(stripChannelEmpties) : cur;
    const same = JSON.stringify(value) === JSON.stringify(base);
    if (!same) payload[key] = value;
  }
  return payload;
}

/** 空串即「未配置」的可选 string 字段清单（bark 与 webhook 实例的**并集**）。
 *  `url` 在这里是因为 bark 的 url 是可选的自定义端点覆写；对 webhook 而言 url 是必填，但那条路
 *  走不到剥除——UI 写回时 assignChannelFields 已把空串删键，接着服务端 validateWebhookChannel
 *  以「缺少 url」400 拦下（而不是静默写进一个打不通的地址）。
 *  真正不在清单内的是 id/type/baseUrl/deviceKey/auth：为空时原样提交、由服务端写面校验拦
 *  （必填不允许空，语义正确）；非 string 值（number/boolean/levels 对象）不触碰。 */
const CHANNEL_OPTIONAL_STRING_KEYS: readonly string[] = [
  "name",
  "token",
  "username",
  "password",
  "headerName",
  "headerValue",
  "template",
  "sound",
  "group",
  "icon",
  "url",
];

/** 单个频道实例的空串可选字段剥除：浅拷贝后删除值为空串的可选字段。只处理 string 值，
 *  number/boolean/对象字段不触碰；非对象输入原样返回（防御数组/null）。 */
export function stripChannelEmpties(ch: unknown): unknown {
  if (typeof ch !== "object" || ch === null || Array.isArray(ch)) return ch;
  const out = Object.assign({}, ch as Record<string, unknown>);
  for (const key of CHANNEL_OPTIONAL_STRING_KEYS) {
    if (typeof out[key] === "string" && (out[key] as string).length === 0) delete out[key];
  }
  return out;
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
 * 频道实例字段合并：part 中**空串/undefined 值从 target 删除该键**，其余浅覆盖。
 *
 * 空串在服务端写面校验中是「非法值」而非「未配置」——token/username/password/headerValue
 * 要求非空、headerName 过头名正则；读面 normalize 却把空串剥除（等价未配置）。若把清空输入
 * 回写成 "" 提交，实例会带着空串残留被整组 400（「填了又删空」死锁的必现根因之一）——空串
 * 删键后提交面与读面同语义（键不存在 = 未配置）。undefined 一并删键：数字/下拉清空走的是
 * 同一条路（清空 badge/level 传的就是 undefined），而 Object.assign 会把 undefined 保留成
 * 「有这个键但值为 undefined」，JSON 序列化后与删键等价、但草稿对象本身多一个键，
 * 「键在不在」正是 levels/badge 这些字段的值域判据。
 */
export function assignChannelFields(
  target: Record<string, unknown>,
  part: Record<string, unknown>,
): Record<string, unknown> {
  const out = Object.assign({}, target);
  for (const key of Object.keys(part)) {
    const value = part[key];
    if (value === "" || value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}
