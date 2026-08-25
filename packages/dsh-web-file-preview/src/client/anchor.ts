/**
 * dsh-web-file-preview — Modal 内标题锚点定位（issue #45）。
 *
 * marked v18 默认不为 heading 输出 id，纯锚点（#section）在 Modal 内没有落点可滚。
 * 本模块按 GitHub GFM slug 规则的最小子集为 h1-h6 补齐 id，并提供「Modal 正文内
 * 平滑滚动定位 + 落点短暂高亮」。
 *
 * 自写说明（全局规则 5 的调研结论）：社区现成实现是 marked 官方扩展
 * marked-gfm-heading-id——引入即新增第三方依赖（触发仓库红线审批流程），而其
 * 核心只是一个 ~15 行的 slugger；对齐 github-slugger 最小语义（小写化、去标点
 * 保留 unicode 字母/数字/连字符、空白折叠为 -、同名依序 -n），内联成本远低于
 * 引依赖，故自写并在 PR 说明取舍。
 */

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

/** GitHub 风格 slug：小写化；删除字母/数字/空白/连字符以外的字符；空白折叠为 -。 */
function gfmSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** scope 内按 id 查元素；CSS.escape 不可用/异常时降级为全量属性比对。 */
function queryById(scope: ParentNode, id: string): Element | null {
  try {
    return scope.querySelector(`[id="${CSS.escape(id)}"]`);
  } catch {
    for (const el of Array.from(scope.querySelectorAll("[id]"))) {
      if (el.getAttribute("id") === id) return el;
    }
    return null;
  }
}

/**
 * 为容器内 h1-h6 补 GFM 风格 id（已有 id 不动；同名标题依序 -1 -2…，
 * 与 GitHub 渲染行为一致）。幂等：重复调用不产生漂移。
 */
export function applyHeadingIds(container: ParentNode): void {
  const used = new Set<string>();
  for (const existing of Array.from(container.querySelectorAll("[id]"))) {
    used.add(existing.getAttribute("id") ?? "");
  }
  for (const heading of Array.from(container.querySelectorAll(HEADING_SELECTOR))) {
    const el = heading as HTMLElement;
    if (el.id !== "") {
      used.add(el.id);
      continue;
    }
    const base = gfmSlug(el.textContent || "");
    if (base === "") continue;
    let id = base;
    for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
    el.id = id;
    used.add(id);
  }
}

/**
 * 在 scope（Modal overlay / 正文容器）内定位 fragment 对应的标题并平滑滚动；
 * 目标不存在返回 false（issue #45：目标不存在则忽略，绝不报错打扰）。
 * 命中时给目标加 .fwp-frag-hit 短暂高亮（用户可见落点反馈，动画结束自动移除）。
 */
export function scrollToFragment(scope: ParentNode | undefined | null, fragment: string): boolean {
  if (!scope || fragment === "") return false;
  const target = queryById(scope, fragment);
  if (target === null) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  const el = target as HTMLElement;
  el.classList.add("fwp-frag-hit");
  window.setTimeout(() => el.classList.remove("fwp-frag-hit"), 1600);
  return true;
}
