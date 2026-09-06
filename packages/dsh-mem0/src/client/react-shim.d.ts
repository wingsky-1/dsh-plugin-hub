// 浏览器半区 React 类型 shim（仅类型面）。
// React 运行时由 dsh web 的 factory require("react") 注入（build-client externals 路径），
// 此处只提供编译期类型（any 兜底），不引入 @types/react 运行时/编译依赖。
// 形态对齐 #605 已验证写法：模块内裸 namespace JSX（TS7 --jsx react 下与全局 JSX 合并）。
declare module "react" {
  const React: any;
  export = React;
  // #612：useState/useRef/useMemo/useCallback 的泛型签名（shim 里 React 是 any，
  // 泛型调用 useState<T>(...) 需要签名存在才合法）
  export function useState<S>(initialState: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
  export function useRef<T>(initialValue: T): { current: T };
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T;
  export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
}

namespace JSX {
  interface Element extends any {}
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}

// #612：事件类型 shim——组件用 `ChangeEvent<HTMLInputElement>` 等裸类型标注
// onChange 回调（无 @types/react 依赖；运行时事件对象天然鸭子类型）。
interface ChangeEvent<T = any> {
  target: T & { value: string };
  preventDefault(): void;
}

