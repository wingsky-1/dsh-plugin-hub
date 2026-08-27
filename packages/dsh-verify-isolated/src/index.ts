/**
 * dsh-verify-isolated — 隔离环境浏览器验证 skill（宿主半）。
 *
 * 职责：作为 dsh-verify-isolated skill 的宿主载体。skill 加载不由本模块完成——
 * cordis.patch.yml 复用官方 @deepseek-ai/dsh-skill-filesystem，用 bundledSkillDir
 * 指向包内 skills/ 目录（参照 archify-dsh 模式），官方 provider 负责发现与注册。
 *
 * 本模块仅提供门禁要求的宿主导出（name / apply）：verify-npm-layout 断言宿主
 * 入口导出 name 且出现 apply。apply 为空实现——skill 注册完全由官方
 * dsh-skill-filesystem provider 承担，无需自写注册代码。
 */
export const name = "dsh-verify-isolated";

/** 空 apply：本插件无宿主逻辑，skill 加载由 cordis.patch.yml 配置的官方 provider 完成。 */
export function apply(): void {
  // no-op：skill provider 由 @deepseek-ai/dsh-skill-filesystem 经 bundledSkillDir 挂载
}
