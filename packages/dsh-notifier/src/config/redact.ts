/**
 * dsh-notifier — 配置域：凭据脱敏与掩码回填。
 *
 * 安全模块定位：SECRET_MASK / CHANNEL_SECRET_FIELDS 是本域 secret 字段语义的
 * 单一事实源——redactConfigView（读出口）按清单掩码、unmaskChannels（写入口）
 * 按清单回填，新增频道类型的 secret 字段只改 CHANNEL_SECRET_FIELDS。
 * GET /config 的 user 与 effective、PUT 成功响应的 user 一律经 redactConfigView
 * 输出——调用方不得绕过（契约测试深度扫描锁死）。
 */
import { PROTOTYPE_POLLUTION_KEYS } from "./config.ts";

/** device key 的响应掩码（PUT 提交整值等于它 = 该实例 key 未修改）。 */
export const SECRET_MASK = "********";

/**
 * 各频道类型的 secret 字段清单（掩码泛化单一事实源）：redactConfigView
 * 按此清单掩码、unmaskChannels 按此清单回填——新增频道类型的 secret 字段只改本表。
 * 未知类型回落 ["deviceKey"]（兼容第三方贡献频道沿用 bark 掩码语义）。
 */
export const CHANNEL_SECRET_FIELDS: Record<string, readonly string[]> = {
  bark: ["deviceKey"],
  webhook: ["token", "password", "headerValue"],
};

/**
 * 配置读取面统一脱敏出口（单一收口）：深拷贝后把 channels[].secret
 * 字段（泛化：按 CHANNEL_SECRET_FIELDS[type] 清单遍历——bark→deviceKey、
 * webhook→token/password/headerValue；未知类型回落 deviceKey）掩码为 SECRET_MASK。
 * GET /config 的 user 与 effective、PUT 成功响应的 user 一律经此函数输出——调用方
 * 不得绕过（契约测试深度扫描锁死）。
 *
 * 读出口同时剔除原型链/特殊成员自有键（constructor/prototype/
 * toString/hasOwnProperty/valueOf/__proto__ 等）——settings user 层原始节可能被
 * 手改 yaml 注入这类键，读出口一律不暴露（与写通道剔除口径一致，防 UI/脚本
 * 看到并回写脏键）。
 *
 * 模板类型仅约束输入输出同构；实现按结构化克隆 + 单键覆写，对任意 JSON 值安全。
 */
export function redactConfigView<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value ?? null)) as T & { channels?: Array<Record<string, unknown>> };
  if (clone && typeof clone === "object") {
    for (const key of PROTOTYPE_POLLUTION_KEYS) {
      // clone 的静态类型由泛型 T 决定，无法按任意字符串键索引；Reflect.deleteProperty
      // 只要求值可赋给 object（安全收窄，不经 unknown 逃生），且语义等价——clone 是
      // JSON.parse 产物，自有属性全部 configurable，删自有键时与 delete 不可区分。
      if (Object.prototype.hasOwnProperty.call(clone, key)) Reflect.deleteProperty(clone, key);
    }
  }
  if (Array.isArray(clone?.channels)) {
    for (const ch of clone.channels) {
      if (!ch || typeof ch !== "object") continue;
      const type = typeof ch.type === "string" ? ch.type : "";
      const fields = CHANNEL_SECRET_FIELDS[type] ?? ["deviceKey"];
      for (const field of fields) {
        if (typeof ch[field] === "string") ch[field] = SECRET_MASK;
      }
    }
  }
  return clone;
}

/**
 * 掩码回填（PUT /config 保存通道）：patch 实例的 secret 字段整值等于
 * SECRET_MASK 时按 **id 对齐**回填 user 层原值（严禁按下标——数组序变会把 A 的
 * key 回填进 B，造成凭据串实例）。泛化：按 CHANNEL_SECRET_FIELDS[type]
 * 清单逐字段回填（webhook 的 token/password/headerValue 与 bark 的 deviceKey 同语义）。
 * 必须先于 validateSettings/sanitizeSettings 执行（掩码不是合法 secret 值语义，
 * 未回填会被 400 拦死）。
 *
 * @returns 回填后的 channels 数组；`missing` = 新增实例却提交掩码（无原值可回填），
 *   调用方应 400 拒绝——掩码只允许表达「未修改」。
 */
export function unmaskChannels(
  patchChannels: unknown,
  userChannels: unknown,
): { ok: true; channels: unknown[] } | { ok: false } {
  if (!Array.isArray(patchChannels)) return { ok: true, channels: [] };
  const originals = new Map<string, Record<string, string>>();
  if (Array.isArray(userChannels)) {
    for (const ch of userChannels) {
      if (typeof ch === "object" && ch !== null) {
        const rec = ch as Record<string, unknown>;
        if (typeof rec.id !== "string") continue;
        const type = typeof rec.type === "string" ? rec.type : "";
        const fields = CHANNEL_SECRET_FIELDS[type] ?? ["deviceKey"];
        const secrets: Record<string, string> = {};
        for (const field of fields) {
          if (typeof rec[field] === "string") secrets[field] = rec[field] as string;
        }
        originals.set(rec.id, secrets);
      }
    }
  }
  const out: unknown[] = [];
  for (const item of patchChannels) {
    if (typeof item !== "object" || item === null) return { ok: false };
    const ch = { ...(item as Record<string, unknown>) };
    const type = typeof ch.type === "string" ? ch.type : "";
    const fields = CHANNEL_SECRET_FIELDS[type] ?? ["deviceKey"];
    const original = typeof ch.id === "string" ? originals.get(ch.id) : undefined;
    for (const field of fields) {
      if (ch[field] === SECRET_MASK) {
        const value = original?.[field];
        if (value === undefined) return { ok: false }; // 新实例不允许掩码占位
        ch[field] = value;
      }
    }
    out.push(ch);
  }
  return { ok: true, channels: out };
}