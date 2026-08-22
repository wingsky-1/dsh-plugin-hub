/**
 * dsh-web-file-preview — 预览 404 负路径 basename 兜底搜索（issue #41）。
 *
 * 场景：聊天正文里只有裸文件名（无任何分隔符/祖先凭证），`resolve(cwd, 裸名)`
 * 必然 404，而文件实际位于工作区子目录。本模块仅在 **file 路由 404 负路径** 上
 * 提供一层受控兜底（主路径命中零新增开销）：
 *
 *   主路径  `git ls-files --cached --others --exclude-standard` 流式搜 basename
 *           —— gitignore 全语义交给 git 权威实现；流式逐行比对，原始候选收集到
 *           2 个即 kill 子进程早停；
 *   回退    非 git 目录 / git 不可用 / 1500ms 超时 → 硬编码黑名单遍历（跳过
 *           dot 目录与 node_modules、不跟随 symlink、触顶放弃）。
 *
 * inert 原则（对齐宿主 producedFileMentions「basename 歧义即 inert」）：唯一
 * 命中且 fs.stat 存在性校验通过才采信；0 命中 / ≥2 歧义 / 触顶 / 校验失败一律
 * 返回 null 维持原 404，绝不猜。结果不缓存（每次负路径独立判定）。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";

/** git 主路径超时毫数（issue 实测大仓 ~20ms，1.5s 已是数量级冗余）。 */
const GIT_SEARCH_TIMEOUT_MS = 1500;
/** 回退遍历默认触顶：最多检查的文件数，超过即放弃维持 404。 */
export const DEFAULT_WALK_LIMIT = 20000;

export interface BasenameFallbackOptions {
  /**
   * 回退遍历触顶上限（仅回退遍历路径生效）；生产默认 20000。
   * 供 smoke 注入小值构造触顶场景，生产调用不传。
   */
  walkLimit?: number;
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
  const viaGit = await searchViaGit(cwd, name);
  if (viaGit !== undefined) return viaGit; // git 给出权威结论（含「确认不存在」）
  // 回退：非 git 目录 / git 不可用 / 超时 → 黑名单遍历
  return walkWithBlacklist(cwd, name, opts.walkLimit ?? DEFAULT_WALK_LIMIT);
}

/**
 * 对 ≤2 个原始候选做 fs.stat 存在性校验后收敛：
 * `--cached` 可能列出已删除未提交文件，命中后必须校验（issue 护栏）。
 * @returns 恰好 1 个存活候选 → 该路径；0 个或 ≥2 个 → null。
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

/** git 主路径三态：确定结论（路径/null）/ undefined（无法给出权威结论，需回退遍历）。 */
type GitSearchOutcome = string | null | undefined;

/**
 * 主路径：`git -C <cwd> -c core.quotePath=false ls-files --cached --others --exclude-standard`
 * 流式读 stdout 逐行比对 basename。第二个原始候选出现即 kill 早停。
 *
 * 结论语义：
 *  - 正常退出（exit 0）→ git 权威：候选过滤后唯一则返回之；否则 null（含被
 *    .gitignore 忽略而未列出的情形——被忽略文件不应被兜底暴露）。
 *  - 非 git 目录（exit 128）/ git 缺失（ENOENT）/ 1500ms 超时 kill → undefined，
 *    由调用方回退黑名单遍历。
 *
 * `core.quotePath=false`：git 默认对非 ASCII 文件名输出带引号的八进制转义
 * （如 `"\346\210\220\345\93\201.png"`），关闭后 UTF-8 名（中文等）原样输出，
 * 才能与请求 basename 精确比对——issue 主场景即裸中文名。
 */
function searchViaGit(cwd: string, name: string): Promise<GitSearchOutcome> {
  return new Promise((settle) => {
    let settled = false;
    const finish = (value: GitSearchOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const hits: string[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "git",
        ["-C", cwd, "-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard"],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
    } catch {
      finish(undefined); // spawn 同步异常 → 回退
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL"); // 超时 → 回退遍历（close 后经 timedOut 结算）
    }, GIT_SEARCH_TIMEOUT_MS);

    let timedOut = false;
    let killedEarly = false;
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line === "") continue;
        // 行即仓库内相对路径（-C cwd 下相对该目录）；取其 basename 精确比对。
        const lastSlash = Math.max(line.lastIndexOf("/"), line.lastIndexOf("\\"));
        if (lastSlash !== -1 && line.slice(lastSlash + 1) !== name) continue;
        if (lastSlash === -1 && line !== name) continue;
        hits.push(join(cwd, line));
        if (hits.length >= 2) {
          killedEarly = true; // 第二个原始候选 → 无需再读，kill 早停
          child.kill("SIGKILL");
          child.stdout!.destroy();
          return;
        }
      }
    });
    child.on("error", () => {
      timedOut = true; // ENOENT 等进程级故障：借 timedOut 标记走回退分支
      finish(undefined);
    });
    child.on("close", (code) => {
      if (timedOut || killedEarly) {
        // 超时 → 回退；早停歧义 → 候选已收满 2，直接走统一过滤收敛（≥2 必弃）。
        if (killedEarly) void uniqueExisting(hits).then((v) => finish(v));
        else finish(undefined);
        return;
      }
      if (code !== 0) {
        finish(undefined); // 非 git 目录（128）等 → 回退遍历
        return;
      }
      void uniqueExisting(hits).then((v) => finish(v));
    });
  });
}

/**
 * 回退路径：硬编码黑名单 DFS 遍历（保守默认①：非 git 区忽略规则不解析
 * .gitignore，仅跳过 dot 目录与 node_modules）。
 *  - 不跟随 symlink：readdir(withFileTypes) 的 isFile/isDirectory 均为 lstat
 *    语义，symlink 一律跳过；
 *  - 触顶（检查文件数 > walkLimit）→ 放弃返回 null 维持 404（此时唯一性无法
 *    保证，即使已有候选也不采信）；
 *  - 无权限/IO 错误的子目录静默跳过。
 */
async function walkWithBlacklist(root: string, name: string, walkLimit: number): Promise<string | null> {
  const stack: string[] = [root];
  let seen = 0;
  const hits: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/已被删等 → 该子树跳过
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // 黑名单：dot 目录（含 .git）与 node_modules 不进入。
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          stack.push(join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue; // symlink/fifo/socket 一律不算
      seen++;
      if (seen > walkLimit) return null; // 触顶 → 放弃维持 404
      if (entry.name === name) {
        hits.push(join(dir, entry.name));
        if (hits.length >= 2) return uniqueExistingSync(hits); // 收满 2 即止
      }
    }
  }
  return uniqueExistingSync(hits);
}

/** 同步版收敛（walk 内命中均为 readdir 实存文件；保留 stat 双保险防竞态）。 */
function uniqueExistingSync(candidates: string[]): Promise<string | null> {
  return uniqueExisting(candidates);
}
