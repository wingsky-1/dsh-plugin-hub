/**
 * dsh-web-file-preview — 全屏按钮纯逻辑（issue #344，无 DOM 依赖）。
 *
 * 与 viewer-math / link-resolver 同一模式：把全屏按钮的纯逻辑（能力探测 / 全屏态
 * 判定 / 按钮文案 / Esc 语义）抽在此模块，node smoke 经 esbuild 内存打包直测真实
 * 源码（见 test/smoke.ts「issue #344：fullscreen-math 全屏纯逻辑直测」）；DOM 胶水
 * 在 preview.ts（薄层只做事件接线与状态搬运，不承载分支逻辑）。
 *
 * 可测性：谓词以 DocumentLike / ElementLike 最小投影为入参（只依赖
 * fullscreenEnabled / fullscreenElement / requestFullscreen / exitFullscreen 语义），
 * 真实 Document 结构性兼容，smoke 用最小投影直测判定路径，不依赖真实 DOM。
 */

/** 全屏能力与状态所需的最小文档投影（真实 Document 结构性兼容）。 */
export interface DocumentLike {
  /** 文档是否允许进入全屏（浏览器策略门卫，false 时 requestFullscreen 必被拒）。 */
  fullscreenEnabled?: boolean;
  /** 当前全屏元素；非全屏态为 null。 */
  fullscreenElement?: Element | null;
}

/** 全屏切换目标所需的最小元素投影（真实 Element 结构性兼容）。 */
export interface FullscreenTargetLike {
  requestFullscreen(options?: { navigationUI?: string }): Promise<void> | void;
}

/** 退出全屏所需的最小文档投影（真实 Document 结构性兼容）。 */
export interface FullscreenExitLike {
  exitFullscreen?(): Promise<void> | void;
}

/**
 * 浏览器是否支持对普通元素调用全屏 API（WebKit 前缀归一到标准名）：
 * - 标准名存在（Chrome/Edge/Firefox/Safari 16.4+）：fullscreenEnabled === true 且
 *   元素有 requestFullscreen；
 * - WebKit 前缀（旧 iOS Safari）：webkitFullscreenEnabled 时元素有
 *   webkitRequestFullscreen 同样可用（本次不展开前缀分支，统一按标准名探测，
 *   降级态负责兜底——见 fullscreenLabel）。
 */
export function fullscreenSupported(doc: DocumentLike, target: FullscreenTargetLike): boolean {
  if (!(doc.fullscreenEnabled === true)) return false;
  return typeof target.requestFullscreen === "function";
}

/** 当前是否处于全屏态（真实 Document 的 fullscreenElement 非空）。 */
export function isFullscreenActive(doc: DocumentLike): boolean {
  return doc.fullscreenElement !== null && doc.fullscreenElement !== undefined;
}

/**
 * 全屏按钮文案（验收 A1）：全屏态「退出全屏」，非全屏态「全屏」；
 * 浏览器不支持全屏时后缀「（放大）」表示走视口放大降级态，避免误导。
 */
export function fullscreenLabel(isActive: boolean, supported: boolean): string {
  if (!supported) return isActive ? "退出放大" : "放大预览";
  return isActive ? "退出全屏" : "全屏";
}

/**
 * Esc 键语义（验收 A1 硬断言）：全屏态下第一次 Esc 只退出全屏、不关闭 Modal——
 * 由 onKeyDown 据此拦截并 return（不触碰 finalizeSession）；非全屏态才走既有
 * 关闭/灯箱逻辑。真实浏览器在元素全屏下通常消费掉 Esc（仅触发 fullscreenchange），
 * 但 Safari/Firefox 会把 keydown 派发给页面，此谓词保证两浏览器行为一致。
 */
export function shouldInterceptEscapeAsFullscreenExit(active: boolean, key: string): boolean {
  return key === "Escape" && active;
}

/** 退出全屏（幂等）：非全屏态调用无副作用（exitFullscreen 未定义/非全屏均安全）。 */
export function exitFullscreenQuiet(doc: FullscreenExitLike): void {
  if (typeof doc.exitFullscreen !== "function") return;
  try { void doc.exitFullscreen(); } catch { /* 忽略 */ }
}