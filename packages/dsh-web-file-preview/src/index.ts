/**
 * dsh-web-file-preview — 组合根（宿主端）。
 *
 * 让 web 端点击对话里的文件链接即可在浏览器内预览：
 *  - 宿主端注册 /api/dsh-file-preview/file（loopback 围栏，按 cwd 防穿越，
 *    图片直出 / 文本 UTF-8 直出）；
 *  - 客户端拦截对话中可点击的文件链接，弹出预览 Modal（见 src/client.ts）。
 *
 * 最小可行性版（MVP）：只做"文件内容服务 + 前端预览"，不校验路径是否属于
 * 已登记工作区——访问控制由平台/用户负责，本插件不做重复兜底。
 *
 * 激活：安装进 profile（见 cordis.patch.yml），重启一次 dsh web 生效。
 */

// 官方类型层（issue #16/#48，锁版见 pnpm-workspace catalog；仅 import type，
// 编译期擦除，禁止运行时值导入——contract-check 有门禁）。dsh-host-webserver
// 经 declare module 注入 ctx.webServer，必须引入其类型面。
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import { ROUTES, makeRoutes, serveFileRoute, type PreviewConfig } from "./routes.ts";
import { previewKindOf } from "./mime.ts";
import { computeGitDiff } from "./git.ts";

/** 稳定的 cordis 插件名。 */
export const name = "web-file-preview";

/** 需要已初始化的 web 服务器。 */
export const inject = ["webServer"];

/** 默认配置。 */
export const DEFAULT_CONFIG: Required<PreviewConfig> = {
  enabled: true,
  // issue #344：文本类预览上限 512KB → 20M（超限仍 413 + truncated，语义不变；
  // 客户端对超大文本降级为纯 <pre> 截断渲染，见 render-limit.ts）。
  maxTextBytes: 20 * 1024 * 1024,
  // issue #73 D3 + #344：与 maxTextBytes 对称（20M）——serve 单资源上限，超限 413。
  maxAssetBytes: 20 * 1024 * 1024,
};

/** 归一化配置：只接受合法值，非法丢弃回默认。 */
export function normalizeConfig(config: PreviewConfig | undefined): PreviewConfig {
  const result: PreviewConfig = { ...DEFAULT_CONFIG };
  if (config !== undefined && typeof config === "object") {
    if (typeof config.enabled === "boolean") result.enabled = config.enabled;
    if (
      typeof config.maxTextBytes === "number" &&
      Number.isFinite(config.maxTextBytes) &&
      config.maxTextBytes > 0
    ) {
      result.maxTextBytes = config.maxTextBytes;
    }
    if (
      typeof config.maxAssetBytes === "number" &&
      Number.isFinite(config.maxAssetBytes) &&
      config.maxAssetBytes > 0
    ) {
      result.maxAssetBytes = config.maxAssetBytes;
    }
  }
  return result;
}

/** 插件 apply：薄壳，只做登记。enabled=false 时不注册任何路由。 */
export function apply(ctx: Context, config?: PreviewConfig): void {
  const cfg = normalizeConfig(config);
  if (cfg.enabled === false) return;

  ctx.effect(() => {
    const disposers: Array<() => void> = [];
    try {
      for (const route of makeRoutes(cfg)) {
        disposers.push(ctx.webServer.register(route));
      }
    } catch (error) {
      ctx.logger.error?.("[dsh-web-file-preview] 注册路由失败:", error);
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 忽略清理期异常 */
        }
      }
    };
  }, "dsh-web-file-preview: routes");
}

// 路由常量 / 纯函数透出（smoke、客户端契约、诊断共用）。
export { ROUTES, makeRoutes, serveFileRoute, previewKindOf, computeGitDiff };
// issue #41：basename 兜底纯函数（issue #423 补强：单测直测变异覆盖）。
export { bareBasenameOf, findUniqueByBasename } from "./basename-fallback.ts";
// issue #73：serve token 虚拟伺服（smoke 直测 + 诊断）。
export { serveTokenRoute, allocServeToken, releaseServeToken, serveContentTypeOf, getTokenStore, resetServeTokenStore } from "./routes.ts";
export { createTokenStore, DEFAULT_TOKEN_TTL_MS, DEFAULT_TOKEN_MAX, DEFAULT_ACTIVE_WINDOW_MS, type TokenStore, type TokenStoreOptions } from "./serve-tokens.ts";
// 预览分组判定（单一事实源，宿主/客户端共用；经此透出供 smoke 断言双端一致）。
export { groupOfPath, groupOfExt, extOf, isPreviewablePath, isLikelySingleFilePath, cleanRefChipPath } from "./grouping.ts";
// Markdown 相对/绝对引用展开、fragment 拆分与 openPreview 入参归一（U8 v2 + issue #45/#479；
// 纯函数，经此透出供 smoke 断言）。
export { resolveRelativePath, resolveAbsolutePath, splitReferenceFragment, normalizeBasePath } from "./relpath.ts";
// 点击链接解析纯逻辑（客户端无 DOM 依赖，经此透出供单元测试）。
export { basenameOf, decideGate, resolveFileLink } from "./client/link-resolver.ts";
// 引用 → 预览目标重写决策纯逻辑（issue #45；无 DOM 依赖，经此透出供单元测试）。
export { rewriteTarget } from "./client/rewrite-target.ts";

