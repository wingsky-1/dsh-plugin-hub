/**
 * dsh-mcp-manager — server/shared/tool-names.ts：模型可见注册名的唯一派生点。
 *
 * 为什么落共享层：中间层转发与虚拟单元注册都按同一个名字查表，规则一旦出现第二份，
 * 某些工具就会永远查不到——名字是键，不是展示文本。
 *
 * 为什么不进 constants.ts：本文件依赖 node:crypto（超长名的哈希回退），而 constants.ts
 * 处在 config 域的模块求值路径上，必须保持零 import。
 */

import { createHash } from "node:crypto";

/** DeepSeek 函数名契约：最多 64 字符、仅 [A-Za-z0-9_-]。 */
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/** 从 (serverName, rawName) 派生模型可见的公开工具名。 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256")
    .update(`${serverName}\0${rawName}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
