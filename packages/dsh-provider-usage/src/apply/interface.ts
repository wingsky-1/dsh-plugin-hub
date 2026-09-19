/**
 * dsh-provider-usage — apply/ 装配层模块锚点（空门面，#768 D11 起）。
 *
 * 本文件无导出：原唯一源码消费（domain2/routes/reports.ts 的
 * ReportConfigService 类型导入）已改走 server/report-routes/deps.ts 窄口，
 * 按最小导出纪律消除转发（复活即重建装配层倒灌业务域的类型依赖）。
 * 文件本身保留——目录归属判据以 interface.ts 存在性锚定模块
 * （verify-dir-imports 叶子粒度），删除会让组合根全部跨域边失锚。
 * apply/ 是装配层组合根（特权目录），对外面 = apply() 主函数、
 * inject 与 lib 导出面——但 lib 入口仍是 apply/index.ts（bundle-host 锚点，
 * 经 lib/index.js 对外），本文件只服务模块归属这一场景。
 *
 * D13 前置：删除本文件时须同步更新 dir-imports 基线（apply 模块归属消失，
 * apply|* 边失锚）+ gate-exemptions 台账 + 报告路由组合根的存在性断言。
 */
export {};
