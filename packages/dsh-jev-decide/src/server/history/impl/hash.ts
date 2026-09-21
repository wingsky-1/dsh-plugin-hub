/** history 域实现：哈希与展示名（纯函数，node:crypto/node:path 仅本文件）。 */
import { createHash } from "node:crypto";
import { basename } from "node:path";

/** 工作目录指纹（分文件键；归一化换行差异不影响同一目录）。 */
export function rootHashOf(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex").slice(0, 32);
}

/** 状态指纹（原文不出境存证，只存哈希）。 */
export function stateHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/** 根展示名（仅 basename，完整路径永不入库）。 */
export function rootDisplayOf(root: string): string {
  const base = basename(root);
  return base === "" ? root.slice(-32) : base;
}

/** 查询 root 参数归一：hex 指纹直用，路径即哈希（调用方传哪种都可）。 */
export function resolveRootHash(root: string): string {
  if (/^[0-9a-f]{16,64}$/.test(root)) return root;
  return rootHashOf(root);
}
