/**
 * dsh-provider-usage — domain2/routes/ 空锚点（#768 D12 起）。
 *
 * 本文件无导出：ui 四块（health/trend/ui-config/events）+ 装配形状（context）
 * 已迁 server/ui-routes（interface 门面 + deps 注入面，零行为变更），本面不再转发；
 * 报告路由已于 D11 迁出。文件保留只为模块归属（verify-dir-imports 叶子粒度），
 * D13 删除本文件并同步基线（dir-imports 基线 + gate-exemptions 台账 +
 * ui-routes 组合根的存在性断言）。
 */
export {};
