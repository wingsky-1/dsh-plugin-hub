/**
 * 提交信息规范（#722 阶段五）：Conventional Commits，规则集用官方 config-conventional。
 *
 * 为什么不做自定义放宽：实测与本仓既有提交实践兼容——近 30 个提交 100% 带 conventional
 * 前缀，header 最长 91 字符、body 最长 84 字符，均在默认上限（100）内。放宽会削弱本钩子
 * 唯一的判据。
 */
export default { extends: ['@commitlint/config-conventional'] }
