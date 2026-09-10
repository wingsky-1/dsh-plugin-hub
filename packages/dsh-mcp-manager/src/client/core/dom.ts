/**
 * dsh-mcp-manager — 客户端 DOM 工具函数（core 层）。
 *
 * 阶段 7 分层：HTTP API 请求已拆出至 ./api.ts（拆出自原 dom.ts——dom.ts
 * 保留 DOM 元素创建职责，api.ts 收 HTTP 请求职责）。
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
