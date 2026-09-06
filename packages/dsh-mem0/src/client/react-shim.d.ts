// 浏览器半区 React 类型 shim（仅类型面）。
// React 运行时由 dsh web 的 factory require("react") 注入（build-client externals 路径），
// 此处只提供编译期类型（any 兜底），不引入 @types/react 运行时/编译依赖。
// 形态对齐 #605 已验证写法：模块内裸 namespace JSX（TS7 --jsx react 下与全局 JSX 合并）。
declare module "react" {
  const React: any;
  export = React;
}

namespace JSX {
  interface Element extends any {}
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
