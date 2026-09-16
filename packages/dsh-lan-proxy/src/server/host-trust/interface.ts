/**
 * host trust 域对外承诺：自条件注入纯函数、官方 index 变换钩子注册与两条契约字面量。
 *
 * 本域回答「非回环页面如何拿回被上游按 isLoopback 降级掉的设置面」。它与转发、
 * 配置、TLS 无共享代码路径——apply 只在装配顶层注册一次 tap，此后由配置域的
 * 解析值逐请求驱动，故自成一段。
 */
export {
  applyHostTrustInjection,
  registerHostTrustInjection,
  HOST_TRUST_ELEMENT_ID,
  HOST_TRUST_RUNTIME_MARKER,
} from "./impl/injection.ts";
