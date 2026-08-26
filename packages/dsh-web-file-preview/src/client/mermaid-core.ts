/**
 * dsh-web-file-preview — Mermaid 渲染编排纯逻辑（issue #104，无 DOM 依赖）。
 *
 * 与 link-resolver / rewrite-target 同一模式：决策与流程编排抽在无 DOM 的模块，
 * node smoke 经 esbuild 内存打包直测真实源码（成功替换 / 单块失败回退 / chunk
 * 加载失败整体回退 / 代数失效中断四条路径）；DOM 胶水在 mermaid.ts（薄到只做
 * 元素收集、替换与回退落盘，不承载分支逻辑）。
 *
 * mermaid 库本身不在此层 import——以最小结构接口注入，保持本模块零第三方依赖、
 * 避免 node 测试环境拉入浏览器库。
 */

/** mermaid 懒加载 chunk 暴露的最小 API 面（仅声明本插件实际用到的方法）。 */
export interface MermaidApiLike {
  /** 幂等初始化：每次 hydration 开始调用，写入 securityLevel/theme 等安全配置。 */
  initialize(config: Record<string, unknown>): unknown;
  /** 渲染单图为 SVG 字符串；图源语法错误时 reject（回退路径的触发点）。 */
  render(id: string, source: string): Promise<{ svg: string }>;
  /** 明暗主题切换跟随（v11 提供；缺失时静默跳过，下次 initialize 生效）。 */
  setTheme?(theme: string): unknown;
}

/**
 * hydration 编排的 IO 注入面：
 * - loadModule：动态 import chunk（变量 URL，运行时真懒加载）；
 * - themeOf / nextId / liveCheck / sanitizeSvg：宿主侧策略（主题、单调 id、竞态、二次消毒）；
 * - onReplaced / onFallback：结果落盘回调（DOM 层执行替换 / 回退标记）。
 */
export interface HydrationIo {
  loadModule(): Promise<MermaidApiLike>;
  themeOf(): "dark" | "default";
  nextId(): string;
  /** 竞态防护：Modal 关闭重开（openSeq 变化）或容器已脱离文档时为 false。 */
  liveCheck(): boolean;
  sanitizeSvg(svg: string): string;
  onReplaced(index: number, svgHtml: string, error?: undefined): void;
  onFallback(index: number, error: unknown): void;
}

/**
 * 对收集好的 mermaid 块源码串行执行「加载 → 初始化 → 逐块渲染 → 回调落盘」。
 *
 * 语义约定（复核批复口径）：
 * - sources 为空直接返回（普通 md 零成本，绝不触发 chunk 拉取）；
 * - chunk 加载失败 → 全部块回退为代码，不外抛（绝不白屏）；
 * - 单块渲染失败（如语法错误）→ 该块回退，其余块继续；
 * - 每块渲染前后各校验一次 liveCheck，失效即静默停止（旧代结果不写回新视图）；
 * - 串行渲染：mermaid 渲染为主线程重活，逐块 await 避免一次性长任务。
 */
export async function runMermaidHydration(sources: string[], io: HydrationIo): Promise<void> {
  if (sources.length === 0 || !io.liveCheck()) return;
  let api: MermaidApiLike;
  try {
    api = await io.loadModule();
  } catch (error) {
    for (let i = 0; i < sources.length; i++) io.onFallback(i, error);
    return;
  }
  // 安全基线（issue #104 批复）：strict（文本转义 + 禁 click 回调）+ 关闭自动扫描 +
  // htmlLabels:false（标签走纯 SVG text，缩小注入面）+ 按 prefers-color-scheme 选主题。
  api.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: io.themeOf(),
  });
  for (let i = 0; i < sources.length; i++) {
    if (!io.liveCheck()) return;
    try {
      const rendered = await api.render(io.nextId(), sources[i]);
      const svg = rendered?.svg ?? "";
      if (typeof svg !== "string" || svg === "") throw new Error("mermaid returned empty svg");
      if (!io.liveCheck()) return;
      io.onReplaced(i, io.sanitizeSvg(svg));
    } catch (error) {
      io.onFallback(i, error);
    }
  }
}
