/**
 * dsh-provider-usage — 用户适配器持久化（设置页 add/select 承载，免手改配置）。
 *
 * #276 方案 A 阶段 3 拆分：自 index.ts 抽离，导出面由 index.ts 转发 re-export
 * 保持不变（外部消费者仍从 lib/index.js 导入）。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expandHomePath, pluginHome, resolvePath } from "./path-resolve.ts";

/** 用户适配器登记条目（add 路由写入、启动时合并加载）。 */
export interface UserAdapterRecord {
  /** 适配器唯一名（= mjs 导出的 name）。 */
  id: string;
  /** 展示名。 */
  label: string;
  /** 认领的 provider 列表。 */
  providers: string[];
  /** 文件路径（绝对路径或可解析形态）。 */
  file: string;
}

/** 用户适配器清单文件路径（历史根目录下）。 */
export function userAdaptersFile(root: string): string {
  return join(root, "user-adapters.json");
}

/** 启用选择状态文件路径（历史根目录下）。 */
export function adapterStateFile(root: string): string {
  return join(root, "adapter-state.json");
}

/** 防御式解析用户适配器清单文本（坏文件返回 []）。 */
export function parseUserAdapters(raw: string | undefined): UserAdapterRecord[] {
  if (typeof raw !== "string" || raw === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const list = (data as Record<string, unknown>)["adapters"];
  if (!Array.isArray(list)) return [];
  const out: UserAdapterRecord[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const label = typeof rec.label === "string" ? rec.label : "";
    const providers = Array.isArray(rec.providers)
      ? rec.providers.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    const file = typeof rec.file === "string" ? rec.file : "";
    if (id.length > 0 && providers.length > 0 && file.length > 0) {
      out.push({ id, label: label || id, providers, file });
    }
  }
  return out;
}

/** 读取用户适配器清单（坏文件/不存在返回 []）。 */
export async function readUserAdapters(root: string): Promise<UserAdapterRecord[]> {
  try {
    if (!existsSync(userAdaptersFile(root))) return [];
    return parseUserAdapters(await readFile(userAdaptersFile(root), "utf8"));
  } catch {
    return [];
  }
}

/** 读取持久化的启用映射（provider → name；null 表示显式清空）。 */
export async function readAdapterState(root: string): Promise<Record<string, string | null>> {
  try {
    if (!existsSync(adapterStateFile(root))) return {};
    const parsed: unknown = JSON.parse(await readFile(adapterStateFile(root), "utf8"));
    // #184：顶层必须是 plain object——null / 数组 / 字符串等类数组输入一律拒绝，
    // 返回与「无有效状态」一致的空对象（调用方遍历空对象即无任何恢复动作）
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const data = parsed as Record<string, unknown>;
    const out: Record<string, string | null> = {};
    for (const [provider, id] of Object.entries(data)) {
      if (typeof provider !== "string" || provider.length === 0) continue;
      if (id === null) out[provider] = null;
      else if (typeof id === "string" && id.length > 0) out[provider] = id;
    }
    return out;
  } catch {
    return {};
  }
}

/** 校验 add 入参 file 字段：文件存在可读 + 路径规整禁穿越。 */
export function resolveAddAdapterFile(
  input: unknown,
  dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh"),
): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.includes("\0")) return undefined;
  const expandedForCheck = expandHomePath(trimmed);
  if (resolve(expandedForCheck) !== expandedForCheck) return undefined; // 拒绝 a/../b、./x 未规整形态
  const resolved = resolvePath(expandedForCheck);
  if (resolved === undefined) return undefined;
  if (!isAbsolute(trimmed)) {
    // 相对路径：解析结果必须位于 DSH_HOME 或插件 home 之内
    for (const base of [dshHome, pluginHome(dshHome)]) {
      const rel = relative(base, resolved);
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return resolved;
    }
    return undefined;
  }
  return resolved;
}