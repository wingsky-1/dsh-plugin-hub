// 浏览器半区 React 类型 shim（仅类型面）。
// React 运行时由 dsh web 的 factory require("react") 注入（build-client externals 路径），
// 此处只为本包实际消费的 API 面（useState/useEffect/useCallback/useMemo/useRef/
// createElement——源码以 JSX 形态书写，createElement 为 JSX
// 编译产物与类型检查的消费面）提供编译期类型，不引入 @types/react 运行时/编译依赖。
declare module "react" {
  /** React 节点：元素 / 原文 / 可空（含嵌套数组，供 map 渲染列表）。 */
  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly ReactNode[];

  /** createElement 产物（结构最小面）。 */
  export interface ReactElement {
    type: unknown;
    props: unknown;
    key: string | number | null;
  }

  /** useState：状态 + setter（支持函数式更新）。 */
  export function useState<S>(
    initialState: S | (() => S),
  ): [S, (next: S | ((prev: S) => S)) => void];

  /** useEffect：副作用 + 可选清理函数，deps 只作依赖数组。 */
  export function useEffect(
    effect: () => void | (() => void),
    deps?: readonly unknown[],
  ): void;

  /** useCallback：按 deps 记忆回调（保持引用稳定）。 */
  export function useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    deps: readonly unknown[],
  ): T;

  /** useMemo：按 deps 记忆计算结果（渲染桶折叠 / stackOrder / Y 域）。 */
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;

  /** useRef：跨渲染可变容器（图表容器 DOM 引用，宽度测量用）。 */
  export function useRef<T>(initialValue: T): { current: T };

  /**
   * createElement：type 为标签名或函数组件；props 键值宽松（本包只传样式/事件/
   * 数据面），children 支持 ReactNode 及其数组。
   */
  export function createElement(
    type: string | ((props: any) => ReactNode),
    props?: Record<string, unknown> | null,
    ...children: ReactNode[]
  ): ReactElement;
}

// JSX 全局命名空间（顶层 namespace 形态：.tsx 实际消费 JSX 命名空间时 declare
// global 形态不生效）。Element 与上方
// declare module "react" 的 ReactElement 面同构（本包 shim 为细类型面，非
// notifier 的 React:any 兜底形态，JSX 表达式需可赋给组件标注的 ReactElement/
// ReactNode），仅编译期类型，零运行时影响。
namespace JSX {
  interface Element {
    type: unknown;
    props: unknown;
    key: string | number | null;
  }
  interface IntrinsicAttributes {
    key?: string | number | null;
  }
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
