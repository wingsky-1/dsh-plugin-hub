// dsh 插件家族共享层 — 客户端样式注入（issue #477 收敛，单一事实源）。
//
// 历史：dsh-notifier / dsh-lan-proxy 各持一份 id+dataset.version 幂等注入实现，
// dsh-web-file-preview / dsh-provider-usage / dsh-mcp-manager 各持一份
// data-attr 查询标记实现，行为同构、实现漂移；统一由本模块参数化承载。
// 调用方只补 { id, cssText, version? } 实参，不再各自持有注入代码。
//
// 行为契约（验收锚点，测试 scripts/test/shared-client-ensure-style.test.ts）：
// 1. head 缺失：首行静默早退（no-op 不抛）——与「注入尽力而为、挂载失败只
//    warn」纪律同精神；页面无 head 时样式无渲染意义，幂等语义保证下次 apply
//    重新注入。调用侧不得再为 head 缺失加 guard/DOMContentLoaded 兜底
//   （dsh-provider-usage 旧 DOMContentLoaded 兜底随迁移删除，属理论不可达防御）。
// 2. 幂等：同 id 已存在且 version 未变（或未传 version）→ 不动现有节点；
//    version 变化 → 旧节点 remove 后重建（热更新失效语义，dataset.version
//    承载版本）。无 version 不写 dataset.version。
// 3. 卸载：返回 disposer（remove 该 id 节点；节点不存在时 no-op）。卸载后
//    再次调用 ensureStyle 重新注入（幂等键随节点移除自然复位）。
// 4. id 命名：统一 `dsh-<pkg>-style` 前缀隔离（DEVELOPMENT.md §2.3）；
//    data-attr 标记全部退役——升级热更瞬间旧标记节点与新 id 节点短暂并存
//    属接受的一次性瞬态（CSS 全类名前缀、规则叠加无可见差异，不引入清扫）。
//
// 准入规则锚点（shared/README.md「插件家族共享层」）：本模块无模块级可变状态，
// 每包独立构建 client.js 各含一份内联副本，包间互不干扰。

/**
 * 按 id 幂等注入 <style> 节点（issue #477 收敛后的 5 包统一样式注入入口）。
 * @param {string} options.id - <style> 幂等键（package-owned，约定 dsh-<pkg>-style）。
 * @param {string} options.cssText - 样式文本（构建期 text-loader 内联的 style.css 内容）。
 * @param {string} [options.version] - 可选版本号：写入 dataset.version，变化时重建节点。
 * @returns {() => void} 卸载函数（remove 该 id 节点；无节点时 no-op）。
 * @throws {TypeError} id/cssText 缺失或类型不符（编程错误 fail-loud，与运行时
 *   环境缺失的静默早退不同——后者是环境边界不是调用方错误）。
 */
export function ensureStyle(options) {
  const opts = options || {};
  const id = opts.id;
  const cssText = opts.cssText;
  const version = opts.version;
  if (typeof id !== "string" || id === "" || typeof cssText !== "string") {
    throw new TypeError("ensureStyle: { id, cssText } 为必填且须为字符串（id 非空）");
  }
  // 卸载闭包全路径同构（按 id 查找 remove，无节点 no-op）——幂等命中路径也
  // 返回可用 disposer，调用方无论何时拿到都能卸载当前节点。
  const dispose = function () {
    const node = document.getElementById(id);
    if (node !== null) node.remove();
  };
  // head 缺失静默早退（契约 1）：document.head == null 时本次调用 no-op。
  if (document.head == null) return dispose;
  const existing = document.getElementById(id);
  if (existing !== null) {
    // 未传 version：不比较（节点已在 → 幂等不动）。
    if (version === undefined) return dispose;
    if (existing.dataset.version === version) return dispose;
    existing.remove(); // version 变化 → 重建（热更新失效语义）
  }
  const style = document.createElement("style");
  style.id = id;
  if (version !== undefined) style.dataset.version = version;
  style.textContent = cssText;
  document.head.appendChild(style);
  return dispose;
}
