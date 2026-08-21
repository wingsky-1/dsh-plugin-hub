/**
 * dsh-provider-usage — 路径解析工具（M2 用户适配器注入）。
 *
 * 解析规则（同计划 3.2）：
 * 1. `~`/`~user` 前缀 → 当前用户 home 展开。
 * 2. 绝对路径 → 原样。
 * 3. 相对路径 → 依次尝试相对 `DSH_HOME`（默认 `~/.dsh`）与相对插件 home
 *    （`~/.dsh/plugins/<plugin>`），先命中者胜。
 * 4. 解析后做 `existsSync` / 可读校验；失败 → 记诊断 + 该条目跳过。
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 插件 home 目录（host 文件逻辑归属区 ~/.dsh/plugins/provider-usage）。 */
export function pluginHome(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "plugins", "provider-usage");
}

/**
 * 解析路径（支持 `~`、`~user`、绝对路径、相对 DSH_HOME/插件 home）。
 * @param p - 原始路径。
 * @returns 解析后的绝对路径，或 undefined（解析失败/文件不存在）。
 */
export function resolvePath(p: string): string | undefined {
  if (typeof p !== "string" || p.trim() === "") return undefined;
  const trimmed = p.trim();

  // 1. ~ 展开
  let expanded: string;
  if (trimmed.startsWith("~")) {
    // ~ 或 ~user
    const slashIdx = trimmed.indexOf("/");
    const userPart = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
    if (userPart === "~" || userPart === "~root") {
      expanded = join(homedir(), trimmed.slice(userPart.length));
    } else {
      // ~user 在非 root 环境较复杂，统一用当前用户 home 展开（大多数场景）
      expanded = join(homedir(), trimmed.slice(1));
    }
  } else if (isAbsolute(trimmed)) {
    expanded = trimmed;
  } else {
    // 相对路径：尝试 DSH_HOME → 插件 home
    const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const candidates = [join(dshHome, trimmed), join(pluginHome(), trimmed)];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        expanded = candidate;
        break;
      }
    }
    // 若无候选命中，取 DSH_HOME 相对路径（文件可能后续创建）
    expanded = join(dshHome, trimmed);
  }

  // 最终校验：可读
  if (!existsSync(expanded)) return undefined;

  // 检查是否为常规文件（非目录）
  try {
    if (!statSync(expanded).isFile()) return undefined;
  } catch {
    return undefined;
  }

  return expanded;
}

/**
 * 弱校验：只做路径展开，不做 existsSync 检查（用于加载前先判断目标路径，失败
 * 由 import 侧处理）。
 */
export function resolvePathWeak(p: string): string {
  if (typeof p !== "string" || p.trim() === "") return "";
  const trimmed = p.trim();
  if (trimmed.startsWith("~")) {
    const slashIdx = trimmed.indexOf("/");
    const home = homedir();
    if (slashIdx === -1) return join(home, trimmed.slice(1));
    return join(home, trimmed.slice(slashIdx + 1));
  }
  if (isAbsolute(trimmed)) return trimmed;
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(dshHome, trimmed);
}