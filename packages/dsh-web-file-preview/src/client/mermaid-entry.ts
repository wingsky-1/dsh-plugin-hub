/**
 * dsh-web-file-preview — Mermaid 懒加载 chunk 入口（issue #104，构建期独立产物）。
 *
 * 该入口由 scripts/build/build-client.ts 的 buildMermaidChunk 以 esbuild
 * `format: "esm"` 打成独立的 lib/client-mermaid.js（整库内联、自包含），
 * 不进 lib/client.js——普通 md / 文本 / 图片预览首屏零额外开销。
 *
 * 客户端在 md 渲染出 ` ```mermaid ` 代码块后才以「运行时变量 URL」动态
 * import 宿主路由 `/api/dsh-file-preview/mermaid` 拉取本 chunk（esbuild 对
 * 变量 URL 的 import() 原样保留为浏览器真动态 import，IIFE 下亦然——已实验
 * 证实；字面量路径会被静态解析内联，故客户端不得写死相对路径）。
 *
 * 只做默认导出透传，不做任何初始化——initialize 由宿主侧按需调用
 * （securityLevel: "strict" + 按 prefers-color-scheme 选主题）。
 */

import mermaid from "mermaid";

export default mermaid;
