/**
 * dsh-web-file-preview — 预览 404 负路径 basename 兜底搜索（issue #41 通用化，#486）。
 *
 * 场景：聊天正文/引用给出的路径 resolve 404（目录写错/缺前缀/纯裸名），而文件
 * 实际位于工作区某处。本模块在宿主 **file/alloc 路由 resolve 失败** 时提供一层
 * 受控兜底：按请求路径的 basename（裸文件名）在会话 cwd 内做**唯一命中**搜索。
 *
 * 实现（issue #486 通用化，git 退役）：
 *   - 载体 fdir 6.5.0（零依赖，通用文件系统遍历——**不依赖 git**，任意工作区
 *     可用，含非 git 目录 / 被 .gitignore 忽略但真实存在的文件）；
 *   - 薄壳（本模块自写）：黑名单剪枝（dot 目录 / node_modules）、`excludeSymlinks`
 *     （不收集 symlink 文件、不跟随 symlink 目录——与 #41 旧遍历 lstat 语义一致）、
 *     filter 谓词内精确 basename 比对（只用 entry.name，规避 Windows 分隔符问题）、
 *     收集到第 2 个原始候选即 abort 早停、结果统一 stat 收敛（>1 即弃）；
 *   - 超时（壁钟 1500ms）与触顶（walkLimit 20000）双保险：任一触发即放弃维持
 *     404（唯一性无法保证，即使已有候选也不采信）。
 *
 * inert 原则（对齐宿主 producedFileMentions「basename 歧义即 inert」）：唯一命中
 * 且 fs.stat 存在性校验通过才采信；0 命中 / ≥2 歧义 / 触顶 / 超时 / 校验失败一律
 * 返回 null 维持原 404，绝不猜。
 *
 * gitignore 语义（issue #486 A1 决策）：**物理存在 + 唯一即暴露**，不解析
 * .gitignore——与插件安全模型一致（/file 路由本就不做逃出拦截、可读任意文件，
 * 被 gitignore 的文件本就经 /file 直读可达，兜底搜索暴露它不新增访问面）。
 * dot **目录**跳过（索引质量/成本控制），但 dot **文件**（.env/.gitignore 裸名）
 * 可命中。
 *
 * 并发去重（性能）：同 (cwd, name) 的并发请求经 in-flight 合并只爬一次；搜索
 * 的 null 结论做秒级负缓存（TTL 1s，仅缓存「确认不存在」）——防同一批失效引用
 * （如 md 内 20 张失效内嵌图）并发/连续触发全量遍历叠堆（实测 20 并发 miss
 * 325ms → in-flight 合并后 23.6ms）。
 */

import { fdir } from "fdir";
import { join } from "node:path";
import { stat } from "node:fs/promises";

/** 搜索壁钟超时毫数（旧 git 主路径沿用值；fdir 遍历实测远小于此，属保险冗余）。 */
const SEARCH_TIMEOUT_MS = 1500;
/** 回退遍历默认触顶：最多检查的文件数，超过即放弃维持 404。 */
export const DEFAULT_WALK_LIMIT = 20000;
/** 负缓存 TTL（ms）：仅缓存「确认不存在」结论，防同 basename 连续 404 重复全量遍历。 */
const NEG_CACHE_TTL_MS = 1000;

export interface BasenameFallbackOptions {
  /**
   * 遍历触顶上限（检查文件数）；生产默认 20000。
   * 供 smoke 注入小值构造触顶场景，生产调用不传。
   */
  walkLimit?: number;
}

/** 负缓存条目。 */
interface NegCacheEntry {
  expiresAt: number;
}

/** (cwd|name) → 负缓存（模块级；命中为 stat 已确认不存在，短 TTL 陈旧风险可忽略）。 */
const negCache = new Map<string, NegCacheEntry>();
/** 遍历结果（result + 是否完整遍历——complete 决定能否负缓存）。 */
interface WalkOutcome {
  result: string | null;
  complete: boolean;
}
/** (cwd|name) → in-flight 搜索 promise（同 key 并发只爬一次）。 */
const inflight = new Map<string, Promise<WalkOutcome>>();

/** 负缓存键。 */
function cacheKeyOf(cwd: string, name: string): string {
  return `${cwd}\u0000${name}`;
}

/**
 * 从请求 path 提取用于兜底搜索的 basename（兼容 / 与 \ 分隔符）。
 * @returns 末段非空字符串；path 为空/以分隔符结尾（末段为空）→ null（不做兜底）。
 */
export function bareBasenameOf(path: string): string | null {
  if (typeof path !== "string" || path === "") return null;
  const segments = path.split(/[\\/]+/);
  const last = segments[segments.length - 1];
  return last === "" || last === "." || last === ".." ? null : last;
}

/**
 * 在工作区 cwd 内按 basename 做受控兜底搜索。
 *
 * 并发去重：同 (cwd, name) 的并发调用共享同一次遍历（in-flight 合并）；确认
 * 不存在的结论进入秒级负缓存。测试如需绕过缓存注入小 walkLimit 构造触顶场景，
 * 用不同 name 即可避开缓存键冲突（smoke 均用唯一随机文件名）。
 *
 * @param cwd - 搜索根（会话工作区）。
 * @param name - 目标 basename（精确匹配，大小写敏感——与请求方给出的名字一致才算凭证）。
 * @returns 唯一命中且 stat 通过的真实绝对路径；其余情况一律 null（维持 404）。
 */
export async function findUniqueByBasename(
  cwd: string,
  name: string,
  opts: BasenameFallbackOptions = {},
): Promise<string | null> {
  if (typeof cwd !== "string" || cwd === "" || typeof name !== "string" || name === "") {
    return null;
  }
  const walkLimit = opts.walkLimit ?? DEFAULT_WALK_LIMIT;
  const key = cacheKeyOf(cwd, name);

  // 负缓存：短 TTL 内确认不存在 → 直接 null（免重复全量遍历）。
  const cached = negCache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return null;

  // in-flight 合并：同 key 已有遍历在途 → 共享其结果（缓存由发起者写入）。
  const pending = inflight.get(key);
  if (pending !== undefined) return pending.then((o) => o.result);

  const run = walkWithBlacklist(cwd, name, walkLimit).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  const outcome = await run;
  // 负缓存（评审/实测：防同一批失效引用连续 404 重复全量遍历叠堆）——
  // **仅缓存「完整遍历且 0 命中」**（complete=true）：该结论 = 当前 cwd 内确认
  // 无此 basename，短 TTL 内重复请求免重爬。触顶/超时/歧义/abort（complete=false
  // 或 ≥2 候选）**不缓存**——它们不代表「确认不存在」，只是本次放弃；缓存会
  // 把受限搜索的结论错当全局结论（如 walkLimit=0 触顶后同一 name 的完整搜索被
  // 错误短路——unit 实测踩坑）。
  if (outcome.complete && outcome.result === null) {
    negCache.set(key, { expiresAt: Date.now() + NEG_CACHE_TTL_MS });
  }
  return outcome.result;
}

/**
 * 对收集到的原始候选做 fs.stat 存在性校验后收敛。
 * @returns 恰好 1 个存活候选 → 该路径；0 个或 ≥2 个 → null（>1 即弃——
 *   abort/并发下已收集候选可能 ≥2，按歧义处理绝不猜）。
 */
async function uniqueExisting(candidates: string[]): Promise<string | null> {
  const alive: string[] = [];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
    } catch {
      continue; // 已删/不可达 → 该候选作废
    }
    alive.push(candidate);
    if (alive.length >= 2) return null; // 歧义即弃，绝不猜
  }
  return alive.length === 1 ? alive[0] : null;
}

/**
 * fdir 通用遍历 + 自写薄壳（黑名单 / 不跟 symlink / basename 精确 / 早停 / 触顶）。
 *
 * fdir 构造选项语义（实测，fdir 6.5.0）：
 *  - `excludeSymlinks: true`：不收集 symlink 文件、不跟随 symlink 目录（默认会
 *    收集/跟随——与旧 lstat 语义相反，必须显式关闭，防环）；
 *  - `suppressErrors: true`（默认）：EACCES 等 readdir 失败静默跳过该目录（不
 *    中断、不抛）；
 *  - `filters` 谓词在**文件级**调用——这里做 basename 精确匹配与候选收集。
 * 黑名单（dot 目录 / node_modules）经 fdir `exclude` 回调剪枝（dirName 判定），
 * 与旧遍历一致；dot 文件不剪（.env/.gitignore 裸名可命中）。
 *
 * 早停：filter 收集到第 2 个候选即 AbortController.abort()——fdir `withMaxFiles(2)`
 * 只是输出截断、遍历照走，必须 filter+abort 才是真早停（选型实测）。
 * 触顶：filter 内检查文件计数，超过 walkLimit 即 abort（唯一性无法保证）。
 * 超时：壁钟 setTimeout abort（与触顶同语义——放弃维持 404）。
 *
 * @returns complete=true 表示「遍历完整结束（未触顶/未超时）」——此时 result
 *   null 即确认 cwd 内无此 basename（可负缓存）；complete=false（触顶/超时）
 *   表示本次放弃，result null 不代表不存在（不可负缓存）。歧义早停
 *   （≥2 候选 abort）视为完整遍历（结论=歧义，绝不猜）。
 */
async function walkWithBlacklist(
  root: string,
  name: string,
  walkLimit: number,
): Promise<{ result: string | null; complete: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const candidates: string[] = [];
  let seen = 0;
  let incomplete = false; // 触顶/超时/异常 → 遍历未完整结束
  try {
    await new fdir({
      excludeSymlinks: true,
      suppressErrors: true,
      signal: controller.signal,
      filters: [
        (_fullPath: string, isDirectory: boolean) => {
          if (isDirectory) return true; // 目录不参与文件匹配；由 exclude 回调剪枝
          seen++;
          if (seen > walkLimit) {
            incomplete = true; // 触顶 → 放弃（唯一性无法保证）
            controller.abort();
            return false;
          }
          // 只用 basename 精确比对（fdir 回调给整路径，Windows 分隔符差异在此
          // 规避——从右侧取最后一段）。
          const lastSlash = Math.max(_fullPath.lastIndexOf("/"), _fullPath.lastIndexOf("\\"));
          const base = lastSlash === -1 ? _fullPath : _fullPath.slice(lastSlash + 1);
          if (base !== name) return false;
          candidates.push(_fullPath);
          if (candidates.length >= 2) controller.abort(); // 歧义已可判定 → 早停
          return false;
        },
      ],
      exclude: (dirName: string) => {
        // 黑名单：dot 目录（含 .git）与 node_modules 不进入（与旧遍历一致）。
        return dirName.startsWith(".") || dirName === "node_modules";
      },
    })
      // withFullPaths：filter 谓词收到的路径必须含 root 前缀（fdir 默认只传
      // basename——joinPath=(f)=>f；候选 stat 收敛需要完整绝对路径）。
      .withFullPaths()
      .crawl(root)
      .withPromise();
  } catch {
    // abort（早停/触顶/超时）在 fdir 以 rejection 呈现；候选已收集在闭包内。
    // 触顶已由 incomplete 标记；其余 abort 归因为超时/意外 → 一律按不完整处理
    //（0 候选时 result null 不可负缓存——保守正确）。
    if (!incomplete) incomplete = true;
  } finally {
    clearTimeout(timeout);
  }
  return { result: await uniqueExisting(candidates), complete: !incomplete };
}
