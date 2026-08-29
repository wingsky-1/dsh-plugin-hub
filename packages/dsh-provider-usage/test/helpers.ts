// @ts-nocheck
/**
 * dsh-provider-usage — 单元测试共享辅助（纯函数断言用，不创建临时目录）。
 */
import assert from "node:assert/strict";

export { assert };

// ---------------------------------------------------------------- 时序工具（#315 批次 A）
//
// 防 flake 纪律（docs/DEVELOPMENT.md §5 + issue #315）：
// - 同步调用 async handler 后「固定 sleep 再读外联 payload」是 CI 慢 runner 下
//   偶发超时读 undefined 的根因（#313 实证）。统一改 await handler：
//   writeJson 在 resolve 前同步触发 end 回调，await 完成后 payload 必已就绪。
// - 真后台异步数据（预热采样 / 历史落盘 / 热更新 / TTL 到龄）一律 pollUntil
//   轮询可观测条件，禁止固定 sleep 假设异步完成时刻。

/**
 * 统一路由调用封装（等响应语义位专用）。
 *
 * - async handler：await 其 promise；writeJson 在 resolve 前同步调用 res.end，
 *   故 await 完成后 payload 已由默认 end 回调填充。
 * - 同步 handler（health / adapters 等）：立即返回，payload 同步就绪。
 *
 * @param route 路由对象（含 handler(req, res)）
 * @param req 构造好的 fake 请求
 * @param resExt 可选 res 覆盖项（如需要捕获 writeHead 状态码 / 原始 chunk 时传入）
 * @returns Promise<payload>（async handler）或 payload（同步 handler）
 */
export function callHandler<T = unknown>(
  route: { handler: (req: unknown, res: unknown) => unknown },
  req: unknown,
  resExt: Record<string, unknown> = {},
): Promise<T> | T {
  let payload: T = undefined as unknown as T;
  const res = {
    writeHead: () => {},
    end: (chunk: unknown) => { payload = JSON.parse(String(chunk)) as T; },
    ...resExt,
  };
  const ret = route.handler(req, res);
  if (ret && typeof (ret as Promise<unknown>).then === "function") {
    return (ret as Promise<unknown>).then(() => payload);
  }
  return payload; // 同步 handler：end 已同步触发
}

/**
 * 轮询直到条件成立或超时（真后台异步数据位专用，替代固定 sleep）。
 *
 * @param cond 条件函数；返回真值即结束（可 async）
 * @param deadlineMs 轮询截止（默认 5000ms）
 * @param tickMs 两次探测间隔（默认 50ms）
 * @returns 条件成立时的返回值；超时未成立返回 undefined
 */
export async function pollUntil<T = boolean>(
  cond: () => T | Promise<T>,
  deadlineMs = 5000,
  tickMs = 50,
): Promise<T | undefined> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

// ---------------------------------------------------------------- sanitizeHtml 统一判定标准 v2（测试侧单一事实源）
//
// 本节是 sanitizeHtml 安全判据的唯一测试侧实现：smoke-pure / unit-v1 等一律
// 引用此处，禁止再复制解码器/危险模式/判定函数（P2③——round1 的 P1-1 穿透
// 正是「实现与判据镜像漂移、共盲放过 Tab/LF/CR 实体族」的后果）。
//
// 与 src/sanitize.ts 实现的关系：**有意保持独立**。实现是净化器本体（发布物），
// 判据是浏览器语义参照（qa 复核基准），二者互为对抗；判据内部单一事实源即可，
// 不得为「复用」而让 src 反向 import 测试文件或扩大 lib/index.js 导出面。

/** 具名实体表（qa 判据子集）：产出 ASCII 危险字符的 WHATWG 正式名小写。 */
const JUDGE_NAMED: Record<string, string> = {
  lt: "<", gt: ">", amp: "&", quot: '"', apos: "'",
  colon: ":", semi: ";", equals: "=", sol: "/", num: "#",
  lpar: "(", rpar: ")",
};

/** 恰好一轮 HTML 实体解码（具名 + 十进制 + 十六进制数字实体，有无分号均解）。 */
export function judgeDecodeOnce(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);?/g, (_m: string, h: string) =>
      String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_m: string, d: string) =>
      String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);?/g, (_m: string, nm: string) =>
      JUDGE_NAMED[nm.toLowerCase()] ?? `&${nm}`);
}

/**
 * 浏览器语义视图：一轮解码后按 WHATWG URL basic parser 入口语义剥除全部
 * ASCII tab/newline/CR（jav&#9;ascript: 剥后 scheme 还原为 javascript:）。
 */
export function judgeBrowserView(s: string): string {
  return judgeDecodeOnce(s).replace(/[\t\n\r]/g, "");
}

/** 危险载体模式集合（统一判定标准同款）。 */
export const SANITIZE_DANGER_RE =
  /<script\b|<iframe\b|<frame\b|<object\b|<embed\b|<meta\b|<link\b|<base\b|\son\w+\s*=|javascript\s*:|data\s*:\s*text\/html|expression\s*\(/i;

/** 统一判定标准 v2：净化输出经浏览器语义视图后不匹配任何危险载体模式。 */
export function judgeContained(out: string): boolean {
  return !SANITIZE_DANGER_RE.test(judgeBrowserView(out));
}

/** pad(k)：每轮净化仅暴露一层 <meta> 的深嵌套构造（k 层需 k 轮收敛）。 */
export function judgePad(k: number): string {
  let s = "<meta>";
  for (let i = 1; i < k; i++) s = "<met" + s + "a>";
  return s;
}

// ---------------------------------------------------------------- 全局 fetch 注入串行通道（#120）

/**
 * 全局 fetch 注入的进程内串行通道：所有需要临时替换 globalThis.fetch 的测试块
 * 一律经本通道执行，promise 链保证窗口互不重叠——save/restore 恒配对，
 * 杜绝 ESM TLA 并发求值下的交错驻留（A 窗口慢路径 await 期间 B 窗口把 A 的
 * mock 当作 savedFetch 保存、恢复链错位后 mock 永久驻留，#120 实证）。
 *
 * @param body 注入体：经 set(mock) 更换全局 fetch（可多次），返回值透传给调用方；
 *             退出时无论成败都恢复进入通道时刻的全局现场。
 */
export function injectGlobalFetch<T>(
  body: (set: (m: unknown) => void) => Promise<T>,
): Promise<T> {
  const run = fetchChain.then(async (): Promise<T> => {
    const saved = globalThis.fetch;
    const set = (m: unknown): void => { globalThis.fetch = m as typeof fetch; };
    try {
      return await body(set);
    } finally {
      globalThis.fetch = saved;
    }
  });
  fetchChain = run.then(() => undefined, () => undefined);
  return run;
}
let fetchChain: Promise<unknown> = Promise.resolve();
