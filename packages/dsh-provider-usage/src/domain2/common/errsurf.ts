/**
 * dsh-provider-usage — domain2/common/errsurf 过渡垫片（#768 S2）。
 *
 * canonical 实现已迁至 `src/server/shared/errsurf.ts`（Q5 尺子见该文件头注记）；
 * 本文件仅 re-export，保证旧导入路径（domain2 内实现、既有测试）在 D13 common
 * 消除前零改动可用。D13 删除本文件并把全部消费者切到 server/shared 门面。
 * 禁止在此追加任何定义——名字只有一个物理定义（server/shared 侧）。
 */
export {
  makeLayerErrorSurface,
  makeNoopLayerErrorSurface,
  LAYER_ERROR_KEYS,
  LAYER_ERROR_MAX_RECENT_DEFAULT,
} from "../../server/shared/interface.ts";
export type {
  LayerErrorKey,
  LayerErrorRecord,
  LayerErrorState,
  LayerErrorSurface,
  LayerErrorSurfaceOptions,
} from "../../server/shared/interface.ts";
