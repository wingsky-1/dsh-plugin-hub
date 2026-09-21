/**
 * dsh-jev-decide — 客户端 DOM 原子层（客户端专属，归 src/client/）。
 *
 * 零 bare import；全部经文本节点渲染（textContent / createTextNode），不用 innerHTML，
 * 不用 React/dompurify——净化只依赖宿主已净化数据（snippetRedacted 等）+ 文本节点。
 * 所有 dj- 类名见同目录 style.css。
 */

export type Attrs = Record<string, unknown>;

/** 最小 el()：class/text/hidden/style/onX/dataset/其余 setAttribute；子节点只收文本或 Node。 */
export function el(tag: string, attrs?: Attrs | null, children?: unknown): HTMLElement {
  const node = document.createElement(tag);
  if (attrs !== null && attrs !== undefined) {
    for (const key of Object.keys(attrs)) {
      const value: unknown = attrs[key];
      if (key === "children" || value === undefined || value === null) continue;
      if (key === "class") node.className = String(value);
      else if (key === "text") node.textContent = String(value);
      else if (key === "hidden") node.hidden = Boolean(value);
      else if (key === "disabled") (node as HTMLButtonElement).disabled = Boolean(value);
      else if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value as Partial<CSSStyleDeclaration>);
      } else if (key === "dataset" && typeof value === "object") {
        const ds = value as Record<string, unknown>;
        for (const dk of Object.keys(ds)) {
          const dv = ds[dk];
          if (dv !== undefined && dv !== null) node.dataset[dk] = String(dv);
        }
      } else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === "value" && "value" in node) {
        (node as HTMLInputElement).value = String(value);
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const item of list) {
    if (item === undefined || item === null || item === false) continue;
    if (typeof item === "string" || typeof item === "number") {
      node.appendChild(document.createTextNode(String(item)));
    } else if (item instanceof Node) {
      node.appendChild(item);
    }
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

export function setText(node: HTMLElement, text: string): void {
  node.textContent = text;
}

/** 文本输入（autocomplete 恒 off；placeholder 禁真密钥示例由调用方保证）。 */
export function textInput(opts: {
  readonly value?: string;
  readonly placeholder?: string;
  readonly type?: string;
  readonly disabled?: boolean;
}): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "dj-input";
  input.type = opts.type ?? "text";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  if (opts.placeholder !== undefined) input.placeholder = opts.placeholder;
  if (opts.value !== undefined) input.value = opts.value;
  if (opts.disabled === true) input.disabled = true;
  return input;
}

export function numberInput(opts: {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "dj-input";
  input.type = "number";
  input.autocomplete = "off";
  input.value = String(opts.value);
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  if (opts.step !== undefined) input.step = String(opts.step);
  return input;
}

export function actionButton(label: string, cls?: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls !== undefined ? cls : "dj-btn";
  btn.textContent = label;
  return btn;
}

export function badge(text: string, cls?: string): HTMLElement {
  return el("span", { class: cls !== undefined ? "dj-badge " + cls : "dj-badge", text });
}

export function noteLine(text: string): HTMLElement {
  return el("div", { class: "dj-note", text });
}

export function okLine(text: string): HTMLElement {
  return el("div", { class: "dj-ok", text });
}

export function errorLine(text: string): HTMLElement {
  return el("div", { class: "dj-error", text });
}

/** 折叠块（custom folding：按钮 + hidden 正文；状态纯内存，不过度设计 aria）。 */
export function fold(opts: {
  readonly title: string;
  readonly open?: boolean;
  readonly body: HTMLElement;
}): { readonly root: HTMLElement; readonly setOpen: (open: boolean) => void } {
  const root = el("div", { class: "dj-fold" });
  const body = opts.body;
  body.hidden = opts.open !== true;
  const head = el("button", { class: "dj-foldHead", type: "button" });
  const title = el("span", { text: opts.title });
  const chev = el("span", { text: body.hidden ? "▸" : "▾" });
  head.appendChild(title);
  head.appendChild(chev);
  const setOpen = (open: boolean): void => {
    body.hidden = !open;
    setText(chev, open ? "▾" : "▸");
    head.setAttribute("aria-expanded", open ? "true" : "false");
  };
  head.setAttribute("aria-expanded", body.hidden ? "false" : "true");
  head.addEventListener("click", () => setOpen(body.hidden === true));
  root.appendChild(head);
  root.appendChild(body);
  return { root, setOpen };
}

/** 时间文案（本地时区；非法 ts 回空串，不抛）。 */
export function fmtTime(ts: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  try {
    const d = new Date(ts);
    const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes()) +
      ":" +
      pad(d.getSeconds())
    );
  } catch {
    return "";
  }
}

export function shortId(id: string, len = 8): string {
  if (id.length <= len) return id;
  return id.slice(0, len);
}
