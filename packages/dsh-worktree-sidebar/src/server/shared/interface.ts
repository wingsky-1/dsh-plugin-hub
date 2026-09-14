/**
 * 共享层门面：包内跨域引用共享设施的唯一入口。
 *
 * 共享层是叶子——它不依赖任何域，域依赖它。收口到一处，「共享层提供了什么」
 * 才有可被门禁校验的答案，而不是散在各域对若干实现文件的直引里
 * （verify-dir-imports 的规则 1/2 判据）。
 */
export type { FileRead, FileWrite } from "./file-io.ts";
export { readTextFileSync, writeTextAtomic, writeTextAtomicSync } from "./file-io.ts";
export type { LoggerPort } from "./type.ts";
export { BINDINGS_FILE_NAME, bindingsFile } from "./paths.ts";
