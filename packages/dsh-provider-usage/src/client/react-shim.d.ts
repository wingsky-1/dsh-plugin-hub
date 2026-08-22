// 浏览器半区 React 类型 shim（仅类型面，issue #28 最小声明）。
// React 运行时由 dsh web 的 factory require("react") 注入（build-client externals 路径），
// 此处只为本包实际消费的 API 面（useState/useEffect/useCallback/createElement）
// 提供编译期类型，不引入 @types/react 运行时/编译依赖。
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
