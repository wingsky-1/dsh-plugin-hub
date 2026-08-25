/**
 * dsh-mcp-manager — 客户端 DOM 工具函数。
 *
 * DOM 元素创建、HTTP API 请求等纯工具函数。
 * 仅 export 纯函数，不依赖任何状态。
 */

/** 创建带属性/子节点的 DOM 元素。 */
export function el(tag: any, attrs: any = {}, children?: any): any {
  // children 兼容两种传法：第三个位置参数，或 attrs.children（本插件调用点
  // 一直把 children 放进 attrs——早期版本只读第三参数导致子节点从未挂载）。
  if (children === undefined) children = attrs.children ?? [];
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value as string;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value as any);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "checked") (node as any).checked = value;
    else if (key === "disabled") (node as any).disabled = value;
    else if (key === "children") continue;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === undefined || child === null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * HTTP API 请求。
 * 返回 JSON 解析后的 body；非 2xx 抛 Error。
 * 带默认超时（10s，AbortSignal），防挂起请求占用连接（#111 变更点驱动）。
 * 调用方自带 signal 时：超时兜底不启用（调用方 signal 优先，避免双取消竞争）。
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