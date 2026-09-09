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

/**
 * 伪造 MCP 传输面（统一 mock 面，防各测试自造桩漂移：issue #664 阶段 1 基建）。
 *
 * 形态贴合 supervisor/protocol 对 transport 的消费面：
 * - `sdk`：SDK Client.connect 的连接对象（protocol initialize 透传 `transport.sdk`）；
 * - `stderrTail`：stdio 启动失败诊断尾巴（protocol initialize 读取）；
 * - `close()`：fire-and-forget 异步关闭，closeCalls 计数供轮询断言，
 *   onClose 回调列表随 onClose 触发（supervisor teardownGeneration 语义）。
 */
export function fakeTransport(overrides = {}) {
  const transport = {
    sdk: {},
    stderrTail: undefined,
    closeCalls: 0,
    onClose: [],
    async close() {
      transport.closeCalls += 1;
      transport.onClose.forEach((cb) => {
        try {
          cb();
        } catch {
          // 回调抛错与 close 自身抛错语义一致：吞掉不炸 teardown
        }
      });
    },
  };
  return Object.assign(transport, overrides);
}

/**
 * 伪造 MCPClient（连接监督器的最小执行面）。
 *
 * 消费面（supervisor.ts）：initialize() / listTools(cursor?) / callTool(name, args, opts)；
 * script 可注入各方法返回值（Promise 或同步均可）；`calls` 记录每次调用参数，供
 * 「调用顺序/参数面」断言（如 B5 代际清理顺序、B18 退避口径）。未注入的默认值：
 * initialize 返回版本协商素对象、listTools 返回空工具集、callTool 返回文本 content。
 */
export function fakeMCPClient(script = {}) {
  const transport = fakeTransport();
  const calls = [];
  const client = {
    transport,
    calls,
    async initialize() {
      calls.push(["initialize"]);
      if (script.initialize) return script.initialize();
      return { protocolVersion: "2024-11-05" };
    },
    async listTools(cursor) {
      calls.push(["listTools", cursor]);
      if (script.listTools) return script.listTools(cursor);
      return { tools: [] };
    },
    async callTool(name, args, opts) {
      calls.push(["callTool", name, args, opts]);
      if (script.callTool) return script.callTool(name, args, opts);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return client;
}
