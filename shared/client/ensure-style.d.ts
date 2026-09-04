/** ensureStyle 参数（issue #477 v2 契约）。 */
export interface EnsureStyleOptions {
  /** <style> 幂等键（package-owned 命名空间，统一 `dsh-<pkg>-style` 前缀隔离）。 */
  id: string;
  /** 样式文本（构建期 text-loader 内联的 style.css 内容）。 */
  cssText: string;
  /** 可选版本号：写入 dataset.version；变化时旧节点 remove 后重建（热更新失效）。 */
  version?: string;
}

/**
 * 按 id 幂等注入 <style> 节点（5 包统一样式注入入口，issue #477 收敛）。
 *
 * 行为契约：
 * - head 缺失（document.head == null）静默早退 no-op 不抛；
 * - 同 id 已存在且 version 未变（或未传）→ 不动现有节点；version 变化 → 重建；
 * - 无 version 不写 dataset.version；
 * - 返回 disposer（remove 该 id 节点；节点不存在时 no-op），卸载后再次调用
 *   ensureStyle 重新注入。
 */
export declare function ensureStyle(options: EnsureStyleOptions): () => void;
