/**
 * 宿主端包内共享层门面：跨域引用的唯一入口。
 *
 * 共享层是叶子——它不依赖任何域，域依赖它。收口到一处，是为了让「共享层提供了什么」
 * 有唯一可被门禁校验的答案（verify-dir-imports 规则 1/2 只认 interface.ts）。
 */
export { DEFAULT_DEFLATE_POLICY } from "./deflate.ts";
export type { DeflatePolicy } from "./deflate.ts";
export { DEFAULT_OPTIONS } from "./defaults.ts";
export { isLoopbackTarget } from "./net.ts";
export { legacyPluginDir, pluginDir } from "./paths.ts";
