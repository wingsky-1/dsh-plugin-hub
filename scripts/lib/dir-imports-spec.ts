#!/usr/bin/env node
/**
 * dir-imports-spec — import specifier 三分类纯函数（#792 方案 A9 取数层）。
 *
 * 为什么需要：门禁此前只认相对路径，bare spec 与 `node:*` 在 resolveTarget 返回 null 后
 * 被静默跳过，于是「共享层不得依赖 node / 不得引插件包」这类判据没有事实面。本库把 spec
 * 归一为 relative / builtin / external 三类，供判据层消费。
 *
 * 对外契约：
 *   - `name` 是**归一化后的模块名**：builtin 去掉 `node:` 前缀（`node:fs` 与 `fs` 同为
 *     `fs`），external 只取包名（scoped 取两段，丢弃子路径），relative 保留原样；
 *   - builtin 的事实源是 `node:module` 的 builtinModules；带 `node:` 前缀者一律归 builtin，
 *     即便名字不在表内——Node 运行期会抛未知内置模块错误，归错只会更严，不会把不存在的
 *     模块变成可用的外部依赖。
 *
 * 本库当前只被单测引用，判红接入见 #792 PR6。
 */
import { builtinModules } from "node:module";
import { isAbsolute } from "node:path";

export type SpecKind = "relative" | "builtin" | "external";

export interface SpecClassification {
  kind: SpecKind;
  name: string;
}

/** 归一化后的内置模块名集合；builtinModules 少数条目自带 `node:` 前缀，故双向剥一次。 */
const BUILTIN_MODULES = new Set(
  builtinModules.map((name) => (name.startsWith("node:") ? name.slice("node:".length) : name)),
);

const NODE_PREFIX = "node:";

/**
 * 归类一个 import specifier。
 *
 * 绝对路径归 relative：它是磁盘位置，既不是内置模块也不是可安装的外部包。
 */
export function classifySpec(spec: string): SpecClassification {
  if (spec.startsWith(".") || isAbsolute(spec)) return { kind: "relative", name: spec };
  const hasNodePrefix = spec.startsWith(NODE_PREFIX);
  const bare = hasNodePrefix ? spec.slice(NODE_PREFIX.length) : spec;
  if (hasNodePrefix || BUILTIN_MODULES.has(bare)) return { kind: "builtin", name: bare };
  const segments = bare.split("/");
  const name = bare.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return { kind: "external", name };
}
