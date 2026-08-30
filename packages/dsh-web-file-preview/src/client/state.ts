/**
 * dsh-web-file-preview — 客户端状态类型与工厂。
 *
 * 所有可变状态收进单一 State 对象，在 apply() 内创建，经参数传递到各模块。
 * 禁止模块级全局变量，确保连续挂载/卸载无残留。
 */

import type { GroupResult } from "./renderer.ts";

/** 返回栈条目：保存上一文件路径/会话 cwd + 预览态快照，返回时原样还原。 */
export interface NavEntry {
  path: string;
  cwd: string | undefined;
  previewMode: "preview" | "raw" | "diff";
  rawText?: string;
  diffText?: string;
  diffUntracked?: boolean;
  /** issue #73：html 预览 serve token/src 快照——返回时直接复用 iframe（免重新 alloc）。 */
  serveToken?: string;
  serveSrc?: string;
}

/** 文件预览客户端全部可变状态。 */
export interface FilePreviewState {
  /** 预览 Modal 遮罩层根元素。 */
  overlay: HTMLElement | undefined;
  /** 插件是否已卸载（dispose 标记）。 */
  disposed: boolean;
  /** 当前图片 blob objectURL（关闭 Modal 时释放）。 */
  trackedObjectUrl: string | undefined;
  /** 当前「预览 / 原始 / Diff」模式。 */
  previewMode: "preview" | "raw" | "diff";
  /** 已 fetch 的原文文本。 */
  rawText: string | undefined;
  /** git diff 原文。 */
  diffText: string | undefined;
  /** 是否未跟踪文件（无 git 基线）。 */
  diffUntracked: boolean;
  /** 当前渲染分组。 */
  currentGroup: GroupResult | undefined;
  /** 预览代数：每次打开/关闭自增，旧请求落地时丢弃。 */
  openSeq: number;
  /** 当前预览的在途请求取消句柄。 */
  activeAbort: AbortController | undefined;
  /** 当前预览文件路径。 */
  currentPath: string;
  /** 当前预览会话 cwd。 */
  currentCwd: string | undefined;
  /** 待定位的标题锚点（issue #45：带 fragment 的引用在 md 首次渲染后消费一次）。 */
  pendingFrag: string | undefined;
  /** md 内嵌图 blob objectURL 清单（closeModal 统一 revoke）。 */
  trackedBlobUrls: string[];
  /** 最大并发取图数。 */
  MAX_IMG_CONCURRENCY: number;
  /** 当前在途取图数。 */
  imgInFlight: number;
  /** 排队待加载的内嵌图队列。 */
  imgQueue: Array<{ img: HTMLImageElement; src: string }>;
  /** 返回历史栈。 */
  backStack: NavEntry[];
  /** 返回栈环形上限。 */
  MAX_BACK: number;
  /** 首次打开预览时的触发元素（a11y：终态关闭时还原焦点）。 */
  sessionOriginFocus: HTMLElement | undefined;
  /** issue #73：当前 html 预览的 serve token（closeModal 时上报 release 释放）。 */
  serveToken: string | undefined;
  /** issue #73：当前 html 预览的 iframe src（重建/切 tab 复用，免重复 alloc）。 */
  serveSrc: string | undefined;
  /** Mermaid 全局单调 render id 计数（issue #104）：跨 Modal 递增不重置，
   * 保证同文档内 mermaid.render 的元素 id 永不冲突（mermaid 内部按 id 查找节点）。 */
  mermaidRenderId: number;
  /** 当前活跃 mermaid hydration 注册表（issue #104 返工）：记录已渲染块元素与
   * 图源，系统明暗切换时对存量图就地重渲染（mermaid v11 无 setTheme，走
   * re-initialize 路线）。closeModal 与下次 hydration 覆盖清理，不跨 Modal 累积。 */
  activeMermaidHydration:
    | { seq: number; container: HTMLElement; entries: Array<{ el: HTMLElement; source: string }> }
    | undefined;

  // 灯箱/查看器状态（issue #293：openLightbox 泛化为 openViewer，内容不再限 <img>）
  /** 灯箱根元素。 */
  lboxEl: HTMLElement | undefined;
  /** 查看器内容元素（<img> 或 mermaid 克隆 <svg>，泛化字段，原 lboxImg；
   * SVG 元素不在 HTML 命名空间，故用 Element 联合类型）。 */
  lboxContent: HTMLElement | SVGElement | undefined;
  /** 查看器缩放比例。 */
  lboxScale: number;
  /** 查看器水平平移。 */
  lboxTx: number;
  /** 查看器垂直平移。 */
  lboxTy: number;
  /** 查看器关闭后焦点还原目标（触发元素，若仍在 DOM；issue #293 C7 a11y）。 */
  lboxRestoreFocus: HTMLElement | undefined;

  // issue #344：全屏按钮状态
  /** 当前是否处于全屏态（真全屏或 CSS 视口放大降级态）。 */
  fsActive: boolean;
  /** 全屏是否受支持（fullscreenEnabled + requestFullscreen 探测结果）。 */
  fsSupported: boolean;

  // 与宿主 ROUTES 一致的路径（单一来源见宿主 src/routes.ts）。
  API: {
    file: string;
    diff: string;
    health: string;
    mermaid: string;
    serve: string;
    alloc: string;
    release: string;
  };
}

/** 创建初始状态对象。 */
export function createState(): FilePreviewState {
  return {
    overlay: undefined,
    disposed: false,
    trackedObjectUrl: undefined,
    previewMode: "preview",
    rawText: undefined,
    diffText: undefined,
    diffUntracked: false,
    currentGroup: undefined,
    openSeq: 0,
    activeAbort: undefined,
    currentPath: "",
    currentCwd: undefined,
    pendingFrag: undefined,
    trackedBlobUrls: [],
    MAX_IMG_CONCURRENCY: 6,
    imgInFlight: 0,
    imgQueue: [],
    backStack: [],
    MAX_BACK: 32,
    sessionOriginFocus: undefined,
    serveToken: undefined,
    serveSrc: undefined,
    mermaidRenderId: 0,
    activeMermaidHydration: undefined,
    lboxEl: undefined,
    lboxContent: undefined,
    lboxScale: 1,
    lboxTx: 0,
    lboxTy: 0,
    lboxRestoreFocus: undefined,
    fsActive: false,
    fsSupported: false,
    API: {
      file: "/api/dsh-file-preview/file",
      diff: "/api/dsh-file-preview/diff",
      health: "/api/dsh-file-preview/health",
      mermaid: "/api/dsh-file-preview/mermaid",
      serve: "/api/dsh-file-preview/serve",
      alloc: "/api/dsh-file-preview/alloc",
      release: "/api/dsh-file-preview/release",
    },
  };
}