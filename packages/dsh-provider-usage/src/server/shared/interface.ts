/**
 * dsh-provider-usage — server/shared 共享层门面（#768 S2）。
 *
 * 共享层是叶子——它不依赖任何域，域依赖它。收口到一处是为了让「共享层提供了什么」
 * 有一个可被门禁校验的答案，而不是散落在各域对实现文件的直引里。
 * 本包 server/shared 现阶段唯一叶子 = errsurf（域2每层错误面）；
 * 禁新建 file-io 叶（S2 约束：per-root 链留 schedule，见 server/upgrade/deps.ts 注记）。
 * 目录化约定：目录外一律经本文件消费，禁 `export * from` 整文件 re-export。
 */
export {
  makeLayerErrorSurface,
  makeNoopLayerErrorSurface,
  LAYER_ERROR_KEYS,
  LAYER_ERROR_MAX_RECENT_DEFAULT,
} from "./errsurf.ts";
export type {
  LayerErrorKey,
  LayerErrorRecord,
  LayerErrorState,
  LayerErrorSurface,
  LayerErrorSurfaceOptions,
} from "./errsurf.ts";
