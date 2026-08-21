// 客户端 .css 模块类型（仅类型面，不含任何运行时/依赖）。
// build-client 的 .css text-loader 在构建期把 style.css 原样内联为字符串，
// 这里只让 tsc（verbatimModuleSyntax）能类型化 `import STYLE from "./style.css"`。
declare module "*.css" {
  const styleText: string;
  export default styleText;
}
