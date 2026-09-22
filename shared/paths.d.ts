/**
 * 插件主目录拼装（单一事实源，实现见 `./paths.js`）：等同
 * `join(base, ...segments)`，默认形态路径逐字节不变。
 *
 * 只收敛「包主目录」直拼；以下 7 类排除：legacy/旧根（旧版迁移读面）、
 * settings 文档（宿主文档读面）、resolve 对比（比较/候选命中顺序是语义）、
 * 用户输入解析（`~`/相对路径展开）、credentials-userHome（DSH_HOME 域外凭据）、
 * 展示脱敏（字符串替换不落盘）、包内反推（随包分发不在 DSH home 下）。
 * provider-registry 的旧 `pluginHome` 保留为包内 facade（公开签名不变）。
 * 完整理由见 `./paths.js` 函数 JSDoc。
 */
export declare function pluginHome(base: string, ...segments: string[]): string;
