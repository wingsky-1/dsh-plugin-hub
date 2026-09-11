/**
 * dsh-provider-usage — hot reload 场景子进程探针（unit-contract 的 hotreload 段专用）。
 *
 * 为什么走子进程：本段回放的是**原生 Node** 的 ESM 语义（生产运行态），子进程把测试
 * 运行器的模块图与缓存隔离在外。此处还兼有历史成因——旧版本戳 `import(url + "?t=" + mtimeMs)`
 * 会被 vite 系运行器按 `/\bt=\d{13}&?\b/` 剥掉毫秒整数位，只剩亚毫秒小数位参与模块标识，
 * 内核 coarse 时钟下同一 tick 的两次写入因此撞进同一模块缓存，同一断言序列时而拿到新版本、
 * 时而拿到缓存版本（#722 实证）。版本戳现已改为 `?mtime=<mtimeMs>&size=<size>`
 * （见 src/domain1/registry/hotreload.ts），vitest 内亦可直接驱动，子进程保留为原生语义护栏。
 * stdout 只输出一行 JSON 观测量供上层逐条断言。
 */
import { mkdtempSync, writeFileSync, utimesSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HotReloadableAdapter, ADAPTER_CONTRACT_VERSION, OPENCODE_GO_PROVIDER } from "../src/apply/index.ts";

const dir = mkdtempSync(join(tmpdir(), "dou-hr-probe-"));
const body = (v) => `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "hr-unit";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { v: ${v} }; }
export function formatCapsule() { return "<span>v${v}</span>"; }
export function formatPanel() { return "<p>v${v}</p>"; }
`;

const missing = join(dir, "missing.mjs");
const events = [];
const hrMissing = new HotReloadableAdapter(missing, 60000, (i) => events.push(i));
const started = await hrMissing.start();

const good = join(dir, "good.mjs");
writeFileSync(good, body(1), "utf8");
const hr = new HotReloadableAdapter(good, 60000);
const startedOk = await hr.start();
const currentAfterStart = hr.current !== null;
hr.stop(); // 停表后手动 poll

// 内容变更（mtime 变化）→ 重载
writeFileSync(good, body(2), "utf8");
utimesSync(good, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
const polled = await hr.pollOnce();
const currentAfterPoll = hr.current !== null;

// 校验失败的替换内容 → reload 报错且 current 不动
writeFileSync(good, 'export const version = 1; export const name = "bad";', "utf8");
utimesSync(good, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
const badReload = await hr.pollOnce();

// 文件删除 → 保留当前适配器不切换
unlinkSync(good);
const delPoll = await hr.pollOnce();
const currentAfterDelete = hr.current !== null;

console.log(JSON.stringify({
  startedMissingOk: started.ok,
  startedMissingError: started.error ?? null,
  eventsLength: events.length,
  startedOk: startedOk.ok,
  currentAfterStart,
  polledOk: polled.ok,
  currentAfterPoll,
  badReloadOk: badReload.ok,
  badReloadError: badReload.error ?? null,
  delPollOk: delPoll.ok,
  currentAfterDelete,
}));
