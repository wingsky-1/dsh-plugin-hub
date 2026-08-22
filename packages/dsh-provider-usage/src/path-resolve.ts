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
// issue #87：~ 展开复用成熟开源实现 untildify（与 dsh-web-file-preview 同源同版，
// devDependency + 构建期 esbuild 内联，发布物零运行时依赖）。
// 行为边界：仅展开开头的 `~`；`~user/...` 形态不展开、原样返回（旧手写实现把
// ~user 误展开到当前用户 home 的权宜语义一并移除——UI placeholder 只承诺 ~/.dsh/...）。
import untildify from "untildify";

/**
 * 插件 home 目录（host 文件逻辑归属区 ~/.dsh/plugins/provider-usage）。
 * @param base - DSH_HOME 根（缺省读 env，回落 ~/.dsh）；参数化供调用方在非全局
 *   env 场景（如路由入参校验）复用同一拼装规则。
 */
export function pluginHome(base = process.env.DSH_HOME ?? join(homedir(), ".dsh")): string {
  return join(base, "plugins", "provider-usage");
}

/**
 * `~` 前缀展开（issue #87 单一事实源：resolvePath 与 resolveAddAdapterFile 共用，
 * 保证「UI 承诺支持 ~ 路径」与校验行为一致）。
 */
export function expandHomePath(p: string): string {
  return untildify(p);
}

/**
 * 解析路径（支持 `~`、`~user`、绝对路径、相对 DSH_HOME/插件 home）。
 * @param p - 原始路径。
 * @returns 解析后的绝对路径，或 undefined（解析失败/文件不存在）。
 */
export function resolvePath(p: string): string | undefined {
  if (typeof p !== "string" || p.trim() === "") return undefined;
  const trimmed = p.trim();

  // 1. ~ 展开与绝对路径判定（expandHomePath 统一处理，issue #87）
  const expandedHome = expandHomePath(trimmed);
  let expanded: string;
  if (expandedHome !== trimmed) {
    expanded = expandedHome;
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