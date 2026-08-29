// @ts-nocheck
/**
 * dsh-mcp-manager — 测试共享辅助（smoke + 各 unit 双份共用）。
 *
 * 防 flake 纪律（DEVELOPMENT.md §5 / issue #315）：一律用事件驱动 await /
 * pollUntil 轮询替代「固定 sleep 等响应/等后台」的时序假设。本文件是单一事实源：
 * 任何测试文件需要「等 handler 响应」或「等后台异步落定」时，从这里取原语，
 * 禁止在测试里自行写固定 sleep。
 */
import assert from "node:assert/strict";

export { assert };

/** 伪造 node:http res：捕获 writeHead / end，供断言状态码与响应体。 */
export function fakeRes() {
  const state = { status: 200, headers: {}, body: "", destroyed: false, writableEnded: false };
  return {
    state,
    get destroyed() {
      return state.destroyed;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    writeHead(status, headers) {
      state.status = status;
      Object.assign(state.headers, headers ?? {});
    },
    write(chunk) {
      state.body += chunk.toString();
    },
    end(chunk) {
      if (chunk !== undefined) state.body += chunk.toString();
      state.writableEnded = true;
    },
    setHeader() {},
    on(event, cb) {
      if (event === "close") state.onClose = cb;
    },
    destroy() {
      state.destroyed = true;
    },
  };
}

/**
 * 统一调用路由 handler 并拿响应。
 *
 * 防 flake 关键形态：async handler 时 await（writeJson 在 resolve 前同步触发
 * end 回调，故 await 返回后 res 已完整写入）；同步 handler 时立即返回。
 * 返回 { status, payload }：payload 为 JSON 解析后的响应体，非 JSON 时回退原文。
 * 禁止在调用方「调用 handler 后 sleep 再读外联变量」——一律用本封装或直接 await。
 *
 * @param {{ handler: Function }} route 路由对象（makeRoutes 产物）。
 * @param {object} req 请求桩（fakeReq 形态）。
 * @param {object} [res] 响应桩，缺省用 fakeRes()。
 */
export async function callHandler(route, req, res = fakeRes()) {
  const ret = route.handler(req, res);
  if (ret !== undefined && typeof ret.then === "function") await ret;
  let payload;
  try {
    payload = JSON.parse(res.state.body || "null");
  } catch {
    payload = res.state.body;
  }
  return { status: res.state.status, payload };
}

/**
 * 轮询等待条件成立（防 flake：轮询替代固定 sleep）。超时抛错。
 * 谓词每 tick 重估；tick 是轮询 tick（语义分类：轮询 tick），非「等够毫秒」。
 */
export async function pollUntil(label, cond, { timeoutMs = 5000, tickMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

/**
 * 观察窗口内持续轮询断言测量值保持 baseline（反向验证：确认某后台行为停止，
 * 如 close/disposer 后不再写心跳帧）。窗口内每 tick 都断言，任何时刻偏离立即失败，
 * 比「单次固定 sleep 后一次性断言」更能即时暴露竞态。窗口时长是物理必需
 * （无法不经过时间就证明『未来无新帧』），tick 属轮询 tick。
 */
export async function assertNoGrowth(label, measure, baseline, { windowMs = 120, tickMs = 10 } = {}) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    assert.equal(measure(), baseline, label);
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
