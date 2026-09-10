/**
 * dsh-provider-usage — apply/ 装配层目录门面。
 *
 * 目录化约定：目录外（domain2/domain1/shared）引用 apply/ 一律经本
 * 文件消费。apply/ 是装配层组合根（特权目录），对外面 = apply() 主函数、
 * inject 与 lib 导出面——但 lib 入口仍是 apply/index.ts（bundle-host 锚点，
 * 经 lib/index.js 对外），本文件只服务「目录外源码引用」这一场景。
 *
 * 最小面具名导出、禁 `export *`：当前目录外对 apply/ 的唯一源码消费是
 * domain2/routes/reports.ts 的类型导入（ReportConfigService），故本面只导出
 * 该类型。apply()/inject/ROUTES 属 lib 契约面，不入本目录门面（无目录外
 * 源码引用，避免出现无消费者的镜像导出）。
 */
export type { ReportConfigService } from "./report-config-service.ts";