/**
 * dsh-mcp-manager — unit：A+ 自持图片准入的纯逻辑（#767 笔 1b 交付物 B）。
 *
 * 覆盖：合法图片落库成正附件块且文本块保序、附件库缺席、路由解不出、模型不声明 image 模态、
 * 非法 media type / 非 canonical base64 的整批拒绝、落库抛错降级；以及「模型面图片块不被二次
 * 准入」。接线面（finalizeContent 换入）在 unit-middleware.test.ts 里另有判据。
 *
 * 直连 `inject/impl/image-admission/index.ts`——不 import src/index.ts（单元层导入面越界存量）。
 */
import { describe, expect, it } from "vitest";
import type {
  AttachmentsPort,
  ModelAttachmentRef,
  ModelContentBlock,
  SaveImageInput,
} from "../../src/server/shared/interface.ts";
import type { ImageAdmissionRequest } from "../../src/server/inject/impl/image-admission/index.ts";
import {
  containsRemoteImage,
  projectImageAdmission,
  resolveRoute,
} from "../../src/server/inject/impl/image-admission/index.ts";

/** 合法 PNG 头（canonical base64：decode→encode 往返逐字节相等）。 */
const PNG = "iVBORw0KGgo=";

/** 只做「非图片块 → 文本」的接线点替身；真实规则是 middleware-register 的 formatCallContentBlock。 */
const formatBlock = (block: unknown) => `T:${JSON.stringify(block)}`;

const routeAgent = {
  session: { requestHeader: () => ({ config: { provider: "p", model: "m" } }) },
  options: { provider: "p2", model: "m2" },
};

const IMAGE_MODEL = { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) };
const TEXT_MODEL = { resolveModelInfo: async () => ({ inputModalities: ["text"] }) };

function saveStore(refs: ModelAttachmentRef[], record: SaveImageInput[][]): AttachmentsPort {
  return {
    saveImages: async (inputs: readonly SaveImageInput[]) => {
      // 快照入参（不保留活引用）：断言只读落库时的字节与 mediaType，复制与引用 verdict 一致。
      record.push([...inputs]);
      return refs;
    },
  };
}

/**
 * 诊断路径恒产文本块：取其 text。类型面是块联合，此处按测试前置收窄——若实现改出非文本块，
 * 此处抛错（红），不断言通过。
 */
function textAt(out: ModelContentBlock[] | undefined, index: number): string {
  const block = out?.[index];
  if (
    typeof block === "object" &&
    block !== null &&
    "text" in block &&
    typeof block.text === "string"
  )
    return block.text;
  throw new Error(`测试前置失效：索引 ${index} 处不是文本块`);
}

/** 一次调用的最小请求。 */
function request(overrides: Partial<ImageAdmissionRequest> = {}) {
  return {
    agent: routeAgent,
    content: [],
    signal: undefined,
    faces: { attachments: () => undefined, models: () => undefined },
    formatBlock,
    ...overrides,
  };
}

describe("image-admission：A+ 自持图片准入（纯逻辑）", () => {
  it("B8 合法图片 + 路由声明 image + 落库成功 → 原位换入 {type:image,attachment}，文本块保序", async () => {
    const record: SaveImageInput[][] = [];
    const out = await projectImageAdmission(
      request({
        content: [
          { type: "text", text: "前" },
          { type: "image", mimeType: "image/png", data: PNG },
          { type: "resource", uri: "x" },
        ],
        faces: {
          attachments: () => saveStore([{ id: "att-1" }], record),
          models: () => IMAGE_MODEL,
        },
      }),
    );
    expect(out).toEqual([
      { type: "text", text: `T:${JSON.stringify({ type: "text", text: "前" })}` },
      { type: "image", attachment: { id: "att-1" } },
      { type: "text", text: `T:${JSON.stringify({ type: "resource", uri: "x" })}` },
    ]);
    // 解码面：交给落库的必须是字节与四值白名单里的 mediaType。
    expect(record.length).toBe(1);
    expect(record[0].length).toBe(1);
    expect(record[0][0].mediaType).toBe("image/png");
    expect(Buffer.from(record[0][0].data).toString("base64")).toBe(PNG);
  });

  it("B9 附件库缺席 → 诊断含 no attachment store is mounted，且不调用 saveImages", async () => {
    let called = 0;
    const out = await projectImageAdmission(
      request({
        content: [{ type: "image", mimeType: "image/png", data: PNG }],
        faces: {
          attachments: () => undefined,
          models: () => {
            called += 1;
            return IMAGE_MODEL;
          },
        },
      }),
    );
    expect(out!.length).toBe(1);
    expect(out![0].type).toBe("text");
    expect(textAt(out, 0)).toContain("no attachment store is mounted");
    expect(called, "附件库缺席时不该问模型目录").toBe(0);
  });

  it("B10 路由解不出（无 agent / 无 provider+model）→ the current model route could not be resolved", async () => {
    const noAgent = await projectImageAdmission(
      request({
        agent: undefined,
        content: [{ type: "image", mimeType: "image/png", data: PNG }],
        faces: { attachments: () => saveStore([], []), models: () => IMAGE_MODEL },
      }),
    );
    expect(textAt(noAgent, 0)).toContain("the current model route could not be resolved");
    const partial = await projectImageAdmission(
      request({
        agent: { session: { requestHeader: () => ({ config: { provider: "p" } }) }, options: {} },
        content: [{ type: "image", mimeType: "image/png", data: PNG }],
        faces: { attachments: () => saveStore([], []), models: () => IMAGE_MODEL },
      }),
    );
    expect(textAt(partial, 0)).toContain("the current model route could not be resolved");
    // 模型目录服务缺席也归同一条（官方把 llm === undefined 并进这里）。
    const noLlm = await projectImageAdmission(
      request({
        content: [{ type: "image", mimeType: "image/png", data: PNG }],
        faces: { attachments: () => saveStore([], []), models: () => undefined },
      }),
    );
    expect(textAt(noLlm, 0)).toContain("the current model route could not be resolved");
  });

  it("B11 模型不声明 image 模态 → does not declare image input（默认部署最常见的降级路径）", async () => {
    const out = await projectImageAdmission(
      request({
        content: [{ type: "image", mimeType: "image/png", data: PNG }],
        faces: { attachments: () => saveStore([], []), models: () => TEXT_MODEL },
      }),
    );
    expect(out![0].type).toBe("text");
    expect(textAt(out, 0)).toContain('model "m" does not declare image input');
  });

  it("B12 非法 media type / 非 canonical base64 → 逐条诊断，且整批都不进 saveImages", async () => {
    const record: SaveImageInput[][] = [];
    const out = await projectImageAdmission(
      request({
        content: [
          { type: "image", mimeType: "image/bmp", data: PNG },
          { type: "text", text: "中" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8" },
          { type: "image", mimeType: "image/png", data: PNG },
        ],
        faces: {
          attachments: () => saveStore([{ id: "att-1" }], record),
          models: () => IMAGE_MODEL,
        },
      }),
    );
    expect(textAt(out, 0)).toContain("the declared media type is not PNG, JPEG, WebP, or GIF");
    expect(textAt(out, 2)).toContain("the image data is not canonical base64");
    // 第三条是同一个非法批里被连坐的合法图：归因写「同批另一张非法」。
    expect(textAt(out, 3)).toContain("another image in the same result was invalid");
    expect(out!.filter((block) => block.type === "image").length).toBe(0);
    expect(record.length, "任一解码失败即整批不落库").toBe(0);
  });

  it("B13 saveImages 抛错 → 降级成诊断文本，不抛给模型", async () => {
    const out = await projectImageAdmission(
      request({
        content: [{ type: "image", mimeType: "image/png", data: PNG }],
        faces: {
          attachments: () => ({
            saveImages: async () => {
              throw new Error("store exploded");
            },
          }),
          models: () => IMAGE_MODEL,
        },
      }),
    );
    expect(out![0].type).toBe("text");
    expect(textAt(out, 0)).toBe(
      "[image unavailable: image/png; durable image storage rejected the result; raw image data remains available to programmatic callers]",
    );
  });

  it("B13b resolveModelInfo 抛错 → the current model route could not be verified", async () => {
    const out = await projectImageAdmission(
      request({
        content: [{ type: "image", mimeType: "image/png", data: PNG }],
        faces: {
          attachments: () => saveStore([], []),
          models: () => ({
            resolveModelInfo: async () => {
              throw new Error("catalog down");
            },
          }),
        },
      }),
    );
    expect(textAt(out, 0)).toContain("the current model route could not be verified");
  });

  it("B13c signal 已取消 → the tool call was canceled before image storage", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await projectImageAdmission(
      request({
        content: [{ type: "image", mimeType: "image/png", data: PNG }],
        signal: controller.signal,
        faces: { attachments: () => saveStore([], []), models: () => IMAGE_MODEL },
      }),
    );
    expect(textAt(out, 0)).toContain("the tool call was canceled before image storage");
  });

  it("未命中：无图片块 / 已是模型面图片块 → 不建投影（返回 undefined，交给 render 兜底）", async () => {
    expect(
      await projectImageAdmission(request({ content: [{ type: "text", text: "只有文本" }] })),
    ).toBe(undefined);
    // 模型面形态 {type:"image", attachment} 没有 data 字段：不得被二次准入。
    const modelFace = [{ type: "image", attachment: { id: "att-1" } }];
    expect(containsRemoteImage(modelFace)).toBe(false);
    expect(await projectImageAdmission(request({ content: modelFace }))).toBe(undefined);
  });

  it("resolveRoute：会话 header 优先，回落 agent.options；取不到给 undefined", () => {
    expect(resolveRoute(routeAgent)).toEqual({ provider: "p", model: "m" });
    expect(
      resolveRoute({
        session: { requestHeader: () => ({ config: { model: "m3" } }) },
        options: { provider: "p3" },
      }),
    ).toEqual({ provider: "p3", model: "m3" });
    // requestHeader 抛（会话还没有 header 快照）不得把准入路径打断。
    expect(
      resolveRoute({
        session: {
          requestHeader: () => {
            throw new Error("no header yet");
          },
        },
        options: { provider: "p4", model: "m4" },
      }),
    ).toEqual({ provider: "p4", model: "m4" });
    expect(resolveRoute(undefined)).toEqual({ provider: undefined, model: undefined });
  });

  it("B-M1 超限单张（>8 MiB）→ 整批诊断且不落库（#903）", async () => {
    let saved = 0;
    const big = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
    const out = await projectImageAdmission(
      request({
        content: [{ type: "image", mimeType: "image/png", data: big }],
        faces: {
          attachments: () => ({
            saveImages: async () => {
              saved += 1;
              return [{ id: "att-1" }];
            },
          }),
          models: () => IMAGE_MODEL,
        },
      }),
    );
    expect(out!.length).toBe(1);
    expect(textAt(out, 0)).toContain("exceeds 8 MiB");
    expect(saved).toBe(0);
  });

  it("B-M1 超长字符串（>16MB base64）→ 直接硬拒，不进正则不解码（#903）", async () => {
    let saved = 0;
    // 20MB 全 A：若走 canonical 正则会回溯爆栈（实测 8MB 即抛），必须被长度门先拦下。
    const huge = "A".repeat(20 * 1024 * 1024);
    const out = await projectImageAdmission(
      request({
        content: [{ type: "image", mimeType: "image/png", data: huge }],
        faces: {
          attachments: () => ({
            saveImages: async () => {
              saved += 1;
              return [{ id: "att-1" }];
            },
          }),
          models: () => IMAGE_MODEL,
        },
      }),
    );
    expect(out!.length).toBe(1);
    expect(textAt(out, 0)).toContain("exceeds 8 MiB");
    expect(saved).toBe(0);
  });

  it("B-M1 超量批次（>10 张）→ 整批诊断且一字节不解（#903）", async () => {
    let saved = 0;
    const content = Array.from({ length: 11 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: PNG,
    }));
    const out = await projectImageAdmission(
      request({
        content,
        faces: {
          attachments: () => ({
            saveImages: async () => {
              saved += 1;
              return [];
            },
          }),
          models: () => IMAGE_MODEL,
        },
      }),
    );
    expect(out!.length).toBe(11);
    expect(textAt(out, 0)).toContain("too many images");
    expect(saved).toBe(0);
  });
});
