/**
 * dsh-notifier 客户端 —— 页面内即时反馈（横幅 + 短提示）。
 *
 * 非安全上下文（局域网 http）下系统级通知不可用，本模块是唯一的降级提醒通道。
 *
 * 裁剪做成纯函数不是为了复用，而是为了**可判据**：旧实现在 querySelectorAll 的静态快照上写
 * `while (banners.length >= 3) banners[0].remove()`，而 Element.remove() 不改变那个数组的长度，
 * 条件恒真。页面可见 + 系统通知不可用时，第 4 条不同 kind 的通知会让主线程同步忙等、整页冻结。
 * trimBanners 按算好的条数从最旧端淘汰，天然有界。
 */

/** 同屏最多保留的横幅条数（追加一条后不超过它）。 */
export const BANNER_CAP = 3;

/** 横幅 / 短提示的自动消失时长（毫秒）。 */
const BANNER_TTL_MS = 8000;
const TOAST_TTL_MS = 3000;

/** 可移除节点：本模块只用到 remove，测试因此不必造真实 DOM。 */
export interface Removable {
  remove(): void;
}

/** 追加一条之前需要淘汰的条数；0 表示还有空位。 */
export function bannerTrimCount(existing: number, cap: number): number {
  return Math.max(0, existing - cap + 1);
}

/** 从最旧端淘汰，使追加一条后总数不超过 cap。 */
export function trimBanners(banners: readonly Removable[], cap: number): void {
  for (const node of banners.slice(0, bannerTrimCount(banners.length, cap))) node.remove();
}

/** 本模块的 DOM 构造助手：只声明真正会写的属性——宽泛签名会让拼错的属性名不再报错。 */
interface ElAttrs {
  class?: string;
  text?: string;
  dataset?: Readonly<Record<string, string>>;
  style?: string;
}

function el(tag: string, attrs: ElAttrs, children?: readonly Node[]): HTMLElement {
  const node = document.createElement(tag);
  if (attrs.class !== undefined) node.className = attrs.class;
  if (attrs.text !== undefined) node.textContent = attrs.text;
  if (attrs.dataset !== undefined) Object.assign(node.dataset, attrs.dataset);
  if (attrs.style !== undefined) node.style.cssText = attrs.style;
  if (children !== undefined) {
    for (const child of children) node.appendChild(child);
  }
  return node;
}

/** 页面内横幅（点击聚焦，自动消失，最多 BANNER_CAP 条）。
 *  kind 由帧携带、可含任意字符，因此按 dataset 比对而不拼 CSS 选择器——拼选择器遇引号/反斜杠
 *  会抛错，而抛错会让整帧静默丢弃。 */
export function showBanner(kind: string, title: string, message: string): void {
  const kindKey = String(kind);
  const existing = Array.prototype.slice.call(
    document.querySelectorAll(".dn-banner"),
  ) as HTMLElement[];
  const survivors: HTMLElement[] = [];
  for (const node of existing) {
    if (node.dataset.kind === kindKey) node.remove();
    else survivors.push(node);
  }
  trimBanners(survivors, BANNER_CAP);
  const banner = el("div", { class: "dn-banner", dataset: { kind: kindKey } });
  banner.addEventListener("click", () => {
    window.focus();
    banner.remove();
  });
  banner.appendChild(
    el("div", { style: "display:flex;align-items:center;gap:6px" }, [
      el("span", { text: "🔔" }),
      el("span", { text: title, style: "font-weight:600" }),
    ]),
  );
  banner.appendChild(
    el("div", {
      text: message,
      style: "margin-top:4px;font-size:12px;line-height:1.5;white-space:pre-line",
    }),
  );
  document.body.appendChild(banner);
  setTimeout(() => {
    banner.remove();
  }, BANNER_TTL_MS);
}

/** 页面内短提示（操作反馈）。 */
export function toast(message: string): void {
  const node = el("div", { class: "dn-toast", text: message });
  document.body.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, TOAST_TTL_MS);
}
