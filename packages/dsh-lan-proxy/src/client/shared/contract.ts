/**
 * dsh-lan-proxy — 客户端路由契约（issue #911）。
 *
 * 与宿主 ROUTES（src/server/config/impl/routes.ts）同值的镜像：两边各写一份的
 * 失败形态是静默的（对不上只表现成请求 404），故两端一致性由单测锁定
 * （CLIENT_ROUTES 与宿主 ROUTES 值全等，见 test/unit/unit-cacert.test.ts）。
 *
 * 构建期 __DSH_ROUTES__ 存在时优先取注入值（bundle-host extraDefine）；非 bundle
 * 环境（单测/源码直引）回落本地镜像——typeof 守卫写法抄 worktree-sidebar
 * （declare const 只活在类型层，裸引用在非 bundle 下 ReferenceError）。
 */
export const CLIENT_ROUTES = {
  config: "/api/dsh-lan-proxy/config",
  health: "/api/dsh-lan-proxy/health",
  caCert: "/api/dsh-lan-proxy/ca-cert",
  /** 一键 CA 动作（POST 只写；#930 Phase 2）：与宿主 ROUTES.caGenerate 同值（单测锁定）。 */
  caGenerate: "/api/dsh-lan-proxy/ca/generate",
} as const;

/** 构建期注入的宿主路由表（bundle-host extraDefine；缺席即 undefined）。 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;

/** 取注入值（非字符串/缺席即回落镜像，保证永远是可用字符串）。 */
function injected(key: "config" | "health" | "caCert" | "caGenerate", fallback: string): string {
  if (typeof __DSH_ROUTES__ !== "undefined") {
    const value = __DSH_ROUTES__[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

/** 卡片实际使用的路由表（注入优先，镜像兜底）。 */
export const APP_ROUTES: {
  readonly config: string;
  readonly health: string;
  readonly caCert: string;
  readonly caGenerate: string;
} = {
  config: injected("config", CLIENT_ROUTES.config),
  health: injected("health", CLIENT_ROUTES.health),
  caCert: injected("caCert", CLIENT_ROUTES.caCert),
  caGenerate: injected("caGenerate", CLIENT_ROUTES.caGenerate),
};
