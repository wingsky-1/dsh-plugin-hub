/**
 * dsh-mcp-manager — catalog/digest.ts：目录条目 digest（#664 阶段 5）。
 *
 * 自 src/catalog.ts 拆出（digest 域）：sha256 摘要，**只含服务器集合（name），
 * 不含描述文本**——工具描述不稳定（按需注册/动态描述），含描述会永远追不上
 * 抖动触发替换注入；只含 name 后服务器增删才触发替换。
 */

import { createHash } from "node:crypto";
import type { CatalogEntry } from "./entries.ts";

/**
 * 目录条目 digest（sha256）——**只含服务器集合（name），不含描述文本**。
 *
 * 为什么：MCP 服务器的工具描述集合不稳定（按需注册/动态描述，实测 code-graph
 * 等服务器不同时刻的摘要都不同）。若 digest 含描述文本，缓存摘要一更新就触发
 * 替换注入——永远追不上抖动。digest 只含 name 后：
 * - 服务器增删 → digest 变 → 原位替换（合理）
 * - 描述/缓存更新 → digest 不变 → 本会话目录保持快照（静态能力地图语义，
 *   与消息声明"仅描述能力、不代表当前连接状态"一致），跨会话才反映新缓存
 */
export function digestCatalogEntries(entries: CatalogEntry[]): string {
  const canonical = entries.map((entry) => entry.name).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}