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
  /** Mermaid 全局单调 render id 计数（issue #104）：跨 Modal 递增不重置，
   * 保证同文档内 mermaid.render 的元素 id 永不冲突（mermaid 内部按 id 查找节点）。 */
  mermaidRenderId: number;
  /** 当前活跃 mermaid hydration 注册表（issue #104 返工）：记录已渲染块元素与
   * 图源，系统明暗切换时对存量图就地重渲染（mermaid v11 无 setTheme，走
   * re-initialize 路线）。closeModal 与下次 hydration 覆盖清理，不跨 Modal 累积。 */
  activeMermaidHydration:
    | { seq: number; container: HTMLElement; entries: Array<{ el: HTMLElement; source: string }> }
    | undefined;

  // 灯箱状态
  /** 灯箱根元素。 */
  lboxEl: HTMLElement | undefined;
  /** 灯箱图片元素。 */
  lboxImg: HTMLImageElement | undefined;
  /** 灯箱缩放比例。 */
  lboxScale: number;
  /** 灯箱水平平移。 */
  lboxTx: number;
  /** 灯箱垂直平移。 */
  lboxTy: number;

  // 与宿主 ROUTES 一致的路径（单一来源见宿主 src/routes.ts）。
  API: {
    file: string;
    diff: string;
    health: string;
    mermaid: string;
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
    mermaidRenderId: 0,
    activeMermaidHydration: undefined,
    lboxEl: undefined,
    lboxImg: undefined,
    lboxScale: 1,
    lboxTx: 0,
    lboxTy: 0,
    API: {
      file: "/api/dsh-file-preview/file",
      diff: "/api/dsh-file-preview/diff",
      health: "/api/dsh-file-preview/health",
      mermaid: "/api/dsh-file-preview/mermaid",
    },
  };
}