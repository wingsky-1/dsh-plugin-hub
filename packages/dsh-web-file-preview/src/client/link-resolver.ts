// dsh-web-file-preview — 文件链接识别纯逻辑（issue #37）。
//
// 从点击目标向上解析「文件路径线索」的两阶段算法与点击闸门决策，抽成无 DOM
// 依赖的纯模块（DOM 以最小投影 ResolverNode 注入），供双端复用与 smoke 直测：
//  - 阶段一（权威凭证）：祖先链上的 data-ref-chip / path-like title / <a href>
//    是元素显式声明的路径，永远优先于文本嗅探；
//  - 阶段二（文本后备）：CODE/SPAN/A/BUTTON 的 path-like 文本只作后备暂存，
//    绝不提前返回——凭证与本轮文本命中 basename 一致时采信凭证完整路径，
//    不一致则跳过该凭证（不猜；与宿主 producedFileMentions 的保守原则同源）；
//    整条链无凭证时才回退文本命中。
//
// 背景：dsh-better-sidebar 等第三方文件树行为
// `<div title="完整路径"><span>裸文件名</span></div>`，旧实现逐节点命中即返回，
// span 的裸文件名会抢在祖先完整路径之前被采用，文件移动后必然 404。

import { isLikelySingleFilePath, cleanRefChipPath } from "../grouping.js";

/** 点击闸门：放行（不做任何拦截）或进入链接解析。 */
export type GateDecision = "pass" | "inspect";

/** 第三方插件逃生门属性：带此属性的元素子树一律不拦截（跨区域生效）。 */
export const EXEMPT_SELECTOR = "[data-dsh-no-preview]";

/**
 * 对话流作用域选择器（追加式数组）。宿主 ChatView 对话流列容器自带官方属性
 * `data-chat-flow`、消息行 seat 带 `data-chat-anchor-key`（宿主自身滚动锚点
 * 定位所用，比 CSS-module hash 类名稳定）；作用域外一律放行，从根上避免对
 * 第三方插件 UI 的全局嗅探误伤。宿主改版时在此追加新锚点即可。
 */
export const SCOPE_SELECTORS = ["[data-chat-flow]", "[data-chat-anchor-key]"];

/** 最小节点投影：客户端由真实 Element 惰性适配，smoke 由对象字面量构造。 */
export interface ResolverNode {
  /** 大写 tagName。 */
  tag: string;
  /** 相关属性快照（title / href / data-ref-chip），缺省为空串。 */
  attrs: Record<string, string>;
  /** trim 后的 textContent（大容器可为空串以省读取开销）。 */
  text: string;
  /** 祖先节点（自内向外方向），链尾为 null。 */
  parent: ResolverNode | null;
}

/** 链接解析结果：file 携带路径；folder 仅作提示语义。 */
export interface ResolvedLink {
  path: string | null;
  kind: "file" | "folder";
}

/** basename 提取并归一化：分隔符统一（\ 与 /）、去首尾空白、小写比较
 * （固定 toLowerCase，不用 locale-aware 形式，规避 Turkish I 等陷阱）。 */
export function basenameOf(value: string): string {
  return (value.split(/[\\/]/).pop() ?? "").trim().toLowerCase();
}

/** 路径形如判定（单一事实源 src/grouping.ts）。 */
function isPathLike(value: string): boolean {
  return isLikelySingleFilePath(value);
}

/**
 * 点击闸门决策（顺序敏感，评审 P0-2）：
 * 1. 命中豁免属性 `data-dsh-no-preview` → 放行（优先级高于作用域，
 *    使 flow 外的豁免元素同样生效，语义单一：「带此属性的子树一律不拦」）；
 * 2. 命中任一作用域选择器（对话流子树）→ 进入链接解析；
 * 3. 其余 → 放行。
 */
export function decideGate(probe: { matches(selector: string): boolean }, scopeSelectors: readonly string[]): GateDecision {
  if (probe.matches(EXEMPT_SELECTOR)) return "pass";
  for (const selector of scopeSelectors) {
    if (probe.matches(selector)) return "inspect";
  }
  return "pass";
}

/** 凭证是否可采信：尚无文本命中，或凭证与本轮文本命中指向同一文件（basename 一致）。 */
function credentialAdopts(credential: string, textHit: string | null): boolean {
  return textHit === null || basenameOf(credential) === basenameOf(textHit);
}

/**
 * 自内向外单趟解析（评审 P0-1：凭证永远优先于一切文本命中——含相对路径
 * 文本在内都只暂存 textHit，绝不提前返回）：
 *  - data-ref-chip 权威分支最先：file → cleanRefChipPath 还原干净路径；
 *    folder → 提示语义；session/skill/不可解析 → 跳过本节点全部分支继续向上
 *    （与旧行为一致，其 title/text 不参与本轮嗅探）；
 *  - path-like title / A[href] 为凭证：basename 校验通过即返回完整路径，
 *    不一致则跳过该凭证（不猜）继续向上；
 *  - CODE/SPAN/A/BUTTON 的 path-like 文本记为首个 textHit（后续不再覆盖）；
 *  - 循环结束仍无凭证 → 回退 textHit（裸名或相对路径，维持旧行为兜底）。
 */
export function resolveFileLink(start: ResolverNode): ResolvedLink | null {
  let textHit: string | null = null;
  let node: ResolverNode | null = start;
  while (node !== null) {
    const chip = (node.attrs["data-ref-chip"] ?? "").trim();
    if (chip !== "") {
      if (chip === "file") {
        const clean = cleanRefChipPath(node.attrs.title ?? "", "file");
        if (clean !== null) return { path: clean, kind: "file" };
      } else if (chip === "folder") {
        return { path: null, kind: "folder" };
      }
      // session / skill / 无法解析的 file：跳过本节点全部分支，继续向上。
      node = node.parent;
      continue;
    }
    const title = (node.attrs.title ?? "").trim();
    if (title !== "" && isPathLike(title) && credentialAdopts(title, textHit)) {
      return { path: title, kind: "file" };
    }
    if (node.tag === "A") {
      const href = (node.attrs.href ?? "").trim();
      if (href !== "" && isPathLike(href) && credentialAdopts(href, textHit)) {
        return { path: href, kind: "file" };
      }
    }
    if (textHit === null && (node.tag === "CODE" || node.tag === "SPAN" || node.tag === "A" || node.tag === "BUTTON")) {
      const text = node.text.trim();
      if (text.length > 0 && text.length <= 1024 && isPathLike(text)) textHit = text;
    }
    node = node.parent;
  }
  return textHit === null ? null : { path: textHit, kind: "file" };
}
