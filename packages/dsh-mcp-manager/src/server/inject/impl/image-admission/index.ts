/**
 * dsh-mcp-manager — inject/impl/image-admission/index.ts：ws_mcp_call 的 **A+ 自持图片准入**
 * （#767 笔 1b 交付物 B）。
 *
 * 背景：本包把远端转发改道宿主的 `ctx.tools.execute` 之后，官方执行器那次图片准入（它读
 * `exec.agent` 解模型路由）随 F4 收口一起去掉了——远端图片结果原本能落成真附件，去掉 agent 后
 * 只能退化成 `[image content]`。本模块把那次准入在本包内补回来：解模型路由 → 白名单解码 →
 * `attachments.saveImages` → 经官方 `finalizeContent` 接缝把模型面内容换成真附件块。
 *
 * 判定顺序与文案**照官方 dsh-mcp-client 的 implement**（`resolveImageAdmission` /
 * `prepareImageProjection` / `imageDiagnostic`，逐字段一致，主控已逐条核实）；任何拒绝都只
 * 降级成诊断文本、不抛——图片落不了库不该让一次工具调用失败。
 *
 * 本模块是纯逻辑（不 import 任何域内实现）：文本块的渲染规则由接线点按实参递进来
 * （middleware-register 的 `formatCallContentBlock`），避免两处各写一份占位规则而漂移。
 */
import type {
  AttachmentsPort,
  ModelContentBlock,
  ModelInfoPort,
  SaveImageInput,
} from "../../../shared/interface.ts";

/** 官方四值白名单（本地 store 会把 PNG 转码成 WebP，故返回的 mediaType 可能与之不同）。 */
const IMAGE_MEDIA_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** canonical base64：官方同款正则，且要求 decode→encode 往返逐字节相等（拒绝别名形态）。 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * 单张解码上限 8 MiB（#903 B-M1 DoS 面：远端结果来自可信服务器也可能作恶，
 * 超大 base64 解码即占内存）。超限与非法同路——进 validationErrors 走既有整批诊断降级。
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 单次结果图片数上限（#903 B-M1：批量下发数百张即 O(n) 解码+落库）。超限整批转诊断，
 * 在解码前判定——一字节都不解。
 */
const MAX_IMAGES_PER_RESULT = 10;

/** 图片准入要用的两条宿主能力：**晚读** thunk（服务可能缺席，且 apply 期取不到）。 */
export interface ImageAdmissionFaces {
  readonly attachments: () => AttachmentsPort | undefined;
  readonly models: () => ModelInfoPort | undefined;
}

/** 一次准入请求的全部输入。 */
export interface ImageAdmissionRequest {
  /** 外层调用身份：模型自己的 agent（不受我方 deny 影响），用于解当前模型路由。 */
  readonly agent: unknown;
  /** 待投影的**远端原始** content（必须是你 return 的那个 value 的 content，含 stale 前置提示）。 */
  readonly content: readonly unknown[];
  readonly signal: AbortSignal | undefined;
  readonly faces: ImageAdmissionFaces;
  /** 非图片块的文本化规则（接线点传 formatCallContentBlock，单一实现）。 */
  readonly formatBlock: (block: unknown) => string;
}

/** 当前模型路由（provider + model）。 */
export interface ImageRoute {
  readonly provider?: string;
  readonly model?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 远端**原始**图片块的判据：`type === "image"` 且 `data` 是字符串。
 *
 * `typeof data === "string"` 这一半是承重的：本包自己产出的模型面图片块是
 * `{type:"image", attachment}`（没有 `data`），用这个判据天然把它排除，不会二次准入。
 */
export function isRemoteImageBlock(block: unknown): boolean {
  const rec = recordOf(block);
  return rec !== undefined && rec.type === "image" && typeof rec.data === "string";
}

/** content 里是否存在远端原始图片块（不存在 → 不建投影，结果面逐字节不变）。 */
export function containsRemoteImage(content: readonly unknown[]): boolean {
  return content.some(isRemoteImageBlock);
}

/**
 * 解当前模型路由：会话最近一次 `request/header` 快照里的 config 优先，回落到 agent 的静态
 * options（官方 `resolveImageAdmission` 的取法）。任何一环取不到都给 `undefined`，由调用方
 * 归到 "the current model route could not be resolved"。
 */
export function resolveRoute(agent: unknown): ImageRoute {
  const agentRecord = recordOf(agent);
  const session = recordOf(agentRecord?.session);
  const routedConfig = routedConfigOf(session);
  const options = recordOf(agentRecord?.options);
  return {
    provider: stringOf(routedConfig?.provider) ?? stringOf(options?.provider),
    model: stringOf(routedConfig?.model) ?? stringOf(options?.model),
  };
}

/** 可调用判定（类型谓词）：让 requestHeader 的窄化免断言。 */
export function isCallable(value: unknown): value is () => unknown {
  return typeof value === "function";
}

/** 会话最近一次 request/header 快照里的 config（无快照 / 假 agent → undefined）。 */
export function routedConfigOf(
  session: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (session === undefined || !isCallable(session.requestHeader)) return undefined;
  try {
    // 必须带 receiver 调用：requestHeader 读实例字段（this.headerFold），裸引用会丢 this。
    return recordOf(recordOf(session.requestHeader.call(session))?.config);
  } catch {
    // 会话尚未产出 header 快照 / 假 agent：回落静态 options。
    return undefined;
  }
}

/** 稳定诊断文案（官方逐字）。 */
function imageDiagnostic(block: Record<string, unknown>, reason: string): string {
  const mediaType = typeof block.mimeType === "string" ? block.mimeType : "unknown media type";
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`;
}

/** 解码一个远端图片块（不接受 base64 别名）。 */
function decodeImage(block: Record<string, unknown>): SaveImageInput {
  const mediaType = block.mimeType;
  if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.includes(mediaType)) {
    throw new Error("the declared media type is not PNG, JPEG, WebP, or GIF");
  }
  const data = block.data;
  if (typeof data !== "string") {
    throw new Error("the image data is not canonical base64");
  }
  // #903 B-M1：canonical 正则在数 MB 输入上回溯爆栈（实测 8MB 输入抛
  // Maximum call stack size exceeded）——16MB base64 必超 8MiB 解码上限，直接硬拒，
  // 不进正则不解码；1MB 以上跳过正则、只用解码往返判定（文案一致）。
  if (data.length > MAX_IMAGE_BYTES * 2) {
    throw new Error("the image data exceeds 8 MiB");
  }
  if (data.length <= 1024 * 1024 && !CANONICAL_BASE64.test(data)) {
    throw new Error("the image data is not canonical base64");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) {
    throw new Error("the image data is not canonical base64");
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("the image data exceeds 8 MiB");
  }
  return {
    data: bytes,
    mediaType: mediaType as SaveImageInput["mediaType"],
  };
}

/** 解析准入并交出附件库（官方判定顺序：attachments → 路由 → llm → 模态 → signal）。 */
async function resolveAdmission(
  faces: ImageAdmissionFaces,
  agent: unknown,
  signal: AbortSignal | undefined,
): Promise<AttachmentsPort> {
  const attachments = faces.attachments();
  if (attachments === undefined) throw new Error("no attachment store is mounted");
  const route = resolveRoute(agent);
  const models = faces.models();
  if (route.provider === undefined || route.model === undefined || models === undefined) {
    throw new Error("the current model route could not be resolved");
  }
  let info: { inputModalities?: readonly string[] };
  try {
    info = await models.resolveModelInfo(route.provider, route.model, signal);
  } catch {
    throw new Error("the current model route could not be verified");
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes("image")) {
    throw new Error(`model "${route.model}" does not declare image input`);
  }
  if (signal?.aborted === true) throw new Error("the tool call was canceled before image storage");
  return attachments;
}

/** 按原位置投影：远端图片块换成 image/诊断块，其余块仍走接线点给的文本规则。 */
function projectContent(
  content: readonly unknown[],
  formatBlock: (block: unknown) => string,
  image: (block: Record<string, unknown>, index: number) => ModelContentBlock,
): ModelContentBlock[] {
  const projected: ModelContentBlock[] = [];
  for (const [index, block] of content.entries()) {
    if (isRemoteImageBlock(block)) {
      projected.push(image(recordOf(block) as Record<string, unknown>, index));
      continue;
    }
    projected.push({ type: "text", text: formatBlock(block) });
  }
  return projected;
}

/**
 * 把远端结果里的图片块准入成模型面内容。
 *
 * @returns 完整模型面投影（文本块 + 原位图片/诊断块）；**没有远端原始图片块时返回 `undefined`**
 *   ——调用方据此不建映射，结果面继续走 `render`（既有行为逐字节不变）。
 */
export async function projectImageAdmission(
  request: ImageAdmissionRequest,
): Promise<ModelContentBlock[] | undefined> {
  const { agent, content, signal, faces, formatBlock } = request;
  if (!containsRemoteImage(content)) return undefined;

  // 批量上限先行（#903 B-M1）：超限整批转诊断，一字节都不解。
  const remoteCount = countRemoteImages(content);
  if (remoteCount > MAX_IMAGES_PER_RESULT) {
    return diagnosticProjection(
      content,
      formatBlock,
      `too many images in one result (>${MAX_IMAGES_PER_RESULT})`,
    );
  }

  const decoded = decodeRemoteImages(content);
  // 任一解码失败 → 整批转文本诊断（含「同批另一张非法」这条归因）。
  if (decoded.validationErrors.size > 0) {
    return projectContent(content, formatBlock, (block, index) => ({
      type: "text",
      text: imageDiagnostic(
        block,
        decoded.validationErrors.get(index) ?? "another image in the same result was invalid",
      ),
    }));
  }

  let attachments: AttachmentsPort;
  try {
    attachments = await resolveAdmission(faces, agent, signal);
  } catch (error) {
    return diagnosticProjection(content, formatBlock, errorText(error));
  }
  return projectStoredImages(content, formatBlock, attachments, decoded);
}

/** content 里的远端原始图片块计数。 */
export function countRemoteImages(content: readonly unknown[]): number {
  let count = 0;
  for (const block of content) if (isRemoteImageBlock(block)) count += 1;
  return count;
}

/** 逐块解码远端图片：解码失败按「下标 → 文案」记账（不中断整批扫描）。 */
export function decodeRemoteImages(content: readonly unknown[]): {
  indexes: number[];
  images: SaveImageInput[];
  validationErrors: Map<number, string>;
} {
  const indexes: number[] = [];
  const images: SaveImageInput[] = [];
  const validationErrors = new Map<number, string>();
  for (const [index, block] of content.entries()) {
    if (!isRemoteImageBlock(block)) continue;
    indexes.push(index);
    try {
      images.push(decodeImage(recordOf(block) as Record<string, unknown>));
    } catch (error) {
      validationErrors.set(index, errorText(error));
    }
  }
  return { indexes, images, validationErrors };
}

/** 整批转诊断文本（超限 / 准入解析失败两条路径共用）。 */
export function diagnosticProjection(
  content: readonly unknown[],
  formatBlock: (block: unknown) => string,
  reason: string,
): ModelContentBlock[] {
  return projectContent(content, formatBlock, (block) => ({
    type: "text",
    text: imageDiagnostic(block, reason),
  }));
}

/** 落库与最终投影：落库失败 / 返回值缺项都按「durable image storage rejected」处理。 */
export async function projectStoredImages(
  content: readonly unknown[],
  formatBlock: (block: unknown) => string,
  attachments: AttachmentsPort,
  decoded: { indexes: number[]; images: SaveImageInput[] },
): Promise<ModelContentBlock[]> {
  try {
    const refs = await attachments.saveImages(decoded.images);
    const byIndex = new Map(decoded.indexes.map((index, offset) => [index, refs[offset]]));
    return projectContent(content, formatBlock, (block, index) => {
      const ref = byIndex.get(index);
      // 落库返回值比入参短（实现违约）时按拒绝处理：模型面不允许出现 attachment 为空的图片块。
      return ref === undefined
        ? {
            type: "text",
            text: imageDiagnostic(block, "durable image storage rejected the result"),
          }
        : { type: "image", attachment: ref };
    });
  } catch {
    // 落库失败不抛（官方区分 ImageAdmissionError 与一般存储错误；本包不引 dsh-attachment，
    // 故统一用后者那条更保守的文案）。
    return diagnosticProjection(content, formatBlock, "durable image storage rejected the result");
  }
}

/** 错误文案归一（Error 取 message，其余按 String）。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
