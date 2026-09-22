/**
 * dsh-mcp-manager — 客户端 DOM 工具函数（core 层）。
 *
 * 阶段 7 分层：HTTP API 请求已拆出至 ./api.ts（拆出自原 dom.ts——dom.ts
 * 保留 DOM 元素创建职责，api.ts 收 HTTP 请求职责）。
 * 仅 export 纯函数，不依赖任何状态。
 */

/** el() 的 attrs 是结构化属性袋：checked/disabled 只落在能接收它们的表单控件上。 */
type FormControl = HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * 盘古之白：CJK 与拉丁字母/数字之间自动插入半角空格。
 * 用于状态摘要等中英混排文案（不要对纯标识符/服务器名调用）。
 * 覆盖面说明：仅 CJK 统一表意文字（U+3400–U+4DBF、U+4E00–U+9FFF）与兼容区
 * （U+F900–U+FAFF），假名/谚文/扩展 B+ 不在范围内——状态文案均为中文标点+
 * 拉丁数字/括号，该范围已够用；如需扩面先补单测再放宽。
 * 连字符说明：类内不得出现裸 `-`（旧写法 `㐀-鿿-鿿` 被解析为字面连字符，
 * 会把 `project-1` 撕成 `project- 1`——连字符标识符必须保持原样）。
 */
export function pangu(text: string): string {
  return String(text)
    .replace(/([㐀-䶿一-鿿豈-﫿])([A-Za-z0-9@#$%^&*()[\]{}<>+\-=/\\|])/g, "$1 $2")
    .replace(/([A-Za-z0-9@#$%^&*()[\]{}<>+\-=/\\|])([㐀-䶿一-鿿豈-﫿])/g, "$1 $2");
}

/** 创建带属性/子节点的 DOM 元素（泛型按标签名收窄返回）。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  children?: unknown[],
): HTMLElementTagNameMap[K] {
  // children 兼容两种传法：第三个位置参数，或 attrs.children（本插件调用点
  // 一直把 children 放进 attrs——早期版本只读第三参数导致子节点从未挂载）。
  const kids: unknown[] = children ?? (attrs.children as unknown[] | undefined) ?? [];
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value == null ? "" : String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value as Record<string, string>);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value as EventListener);
    else if (key === "checked") (node as HTMLInputElement).checked = value as boolean;
    else if (key === "disabled") (node as FormControl).disabled = value as boolean;
    else if (key === "children") continue;
    else node.setAttribute(key, String(value));
  }
  for (const child of kids) {
    if (child === undefined || child === null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : (child as Node));
  }
  return node;
}
