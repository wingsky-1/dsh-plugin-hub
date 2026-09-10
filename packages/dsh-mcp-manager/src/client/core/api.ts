/**
 * dsh-mcp-manager — 客户端 HTTP API 请求（core 层）。
 *
 * 阶段 7 分层：本文件拆出自原 dom.ts（dom.ts 保留 DOM 工具职责 el()，
 * HTTP 请求职责独立成 api.ts），与宿主 ROUTES 的对接面收拢一处。
 * 仅 export 纯函数，不依赖任何状态。
 */

/**
 * HTTP API 请求。
 * 返回 JSON 解析后的 body；非 2xx 抛 Error。
 * 带默认超时（10s，AbortSignal），防挂起请求占用连接（#111 变更点驱动）。
 * 调用方自带 signal 时：超时兜底不启用（调用方 signal 优先，避免双取消竞争）。
 *
 * C14 备忘：当前全部路由返回 JSON body；未来新增 204 无 body 路由时，
 * response.json() 抛错会落到 body=undefined，调用方不得静默把 undefined
 * 当成功结果消费（需在新增 204 路由时显式补状态码分支）。
 */
export async function api(path: any, options: any = {}): Promise<any> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const hasCallerSignal = options.signal !== undefined;
  const controller = new AbortController();
  const timer = hasCallerSignal ? undefined : setTimeout(() => controller.abort(new Error(`request timed out (${timeoutMs}ms)`)), timeoutMs);
  const merged = { ...options, signal: options.signal ?? controller.signal };
  try {
    const response = await fetch(path, merged);
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    return body;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
