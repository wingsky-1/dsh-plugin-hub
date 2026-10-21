/**
 * dsh-mcp-manager — unit：宿主服务类型锚的可赋值性（#1164 WP4）。
 *
 * 判据（编译期，本文件由 test/tsconfig.json 编译面检查）：
 * - 官方 `Context["llm"]` 整面可赋值给本包的 `ModelInfoPort`，且 port 的返回类型仍是官方
 *   `resolveModelInfo` 的返回类型——防止把锚定面改成自造形状后 `compose.ts` 的 `as` 把它静默压过去。
 * - 官方活 agent（`Context["agents"].list()` 元素）可赋值给 `AgentFace`，成员与官方同源。
 *
 * 判据（运行期）：
 * - `bindHost` 的晚读 thunk 原样转发官方 llm 服务（不复制、不换形）；
 * - `liveAgents` 把官方 agent 投影成 `id + ctx.tools.restrict`，`restrict` 保持同一引用；
 * - 服务缺席时 thunk 给 undefined、活 agent 表为空，不抛。
 *
 * 为什么值得写：生产代码用 `ctx.get("llm")` / `ctx.get("agents")` 取宽值，类型正确性全靠
 * 锚定面；没有这条断言时，锚定面与官方漂移只能等到消费点（或干脆静默）才暴露。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
// 只为把 Context["llm"] 的声明合并拉进本编译面（与 host-faces.ts 同款 import type）。
import type {} from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import { bindHost } from "../../src/server/shared/compose.ts";
import type { AgentFace, ModelInfoPort } from "../../src/server/shared/host-faces.ts";

type Assert<T extends true> = T;

/** 官方 llm 整面必须可赋值给锚定面（锚定面只能是它的减法）。 */
type LlmCoversAnchor = Assert<Context["llm"] extends ModelInfoPort ? true : false>;
/** 锚定面的方法返回类型必须逐字等于官方（防自造返回形状）。 */
type AnchorReturnMatches = Assert<
  ReturnType<ModelInfoPort["resolveModelInfo"]> extends ReturnType<
    Context["llm"]["resolveModelInfo"]
  >
    ? true
    : false
>;
/** 组合根从官方 agent 投影出的最小面（`{id, tools}`）必须可赋值给 AgentFace。 */
type AgentCoversAnchor = Assert<
  { readonly id: Agent["id"]; readonly tools: Agent["ctx"]["tools"] } extends AgentFace
    ? true
    : false
>;
/** AgentFace 的成员必须与官方同源（id 与 restrict 的签名不漂移）。 */
type OfficialAgentFace = {
  readonly id: Agent["id"];
  readonly tools: Pick<Agent["ctx"]["tools"], "restrict">;
};
type AgentFaceMatchesOfficial = Assert<AgentFace extends OfficialAgentFace ? true : false>;
/**
 * 编译期命中面：把四条断言收进一个类型引用，避免 lint 判「未使用」；断言在各自声明处即生效
 * （条件类型不满足 true 约束时 tsc 直接红，不依赖这里是否被读取）。
 */
type _AnchorAssertions = [
  LlmCoversAnchor,
  AnchorReturnMatches,
  AgentCoversAnchor,
  AgentFaceMatchesOfficial,
];

type HostCtxArg = Parameters<typeof bindHost>[0];

/** 官方服务缺席时的最小宿主上下文：只实现 bindHost 直接触碰的成员，其余按宿主形状断言。 */
function fakeHostCtx(services: { llm?: unknown; agents?: unknown }): HostCtxArg {
  return {
    logger: { warn: () => {}, exporter: () => () => {} },
    webServer: { register: () => () => {} },
    tools: { register: () => () => {}, schemas: () => [] },
    on: () => () => {},
    systemPrompt: { section: () => {} },
    provide: () => () => {},
    effect: () => () => {},
    plugin: () => ({ await: () => Promise.resolve(), dispose: () => Promise.resolve() }),
    get: (name: string) =>
      name === "llm" ? services.llm : name === "agents" ? services.agents : undefined,
  } as unknown as HostCtxArg;
}

describe("宿主服务类型锚：ModelInfoPort / AgentFace", () => {
  it("models() 原样转发官方 llm 的 resolveModelInfo（晚读 thunk，不是装配期快照）", async () => {
    const llm = {
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
        inputModalities: ["text", "image"] as const,
      }),
    } satisfies ModelInfoPort;
    const faces = bindHost(fakeHostCtx({ llm }));

    expect(faces.models()).toBe(llm);
    const info = await faces.models()!.resolveModelInfo("deepseek", "deepseek-chat");
    expect(info.inputModalities).toEqual(["text", "image"]);
  });

  it('liveAgents() 从 Context["agents"].list() 投影最小面，restrict 保持同一引用', () => {
    const restrict = () => () => {};
    const agents = { list: () => [{ id: "session-1", ctx: { tools: { restrict } } }] };
    const faces = bindHost(fakeHostCtx({ agents }));

    const live = faces.events.liveAgents();
    expect(live.map((agent) => agent.id)).toEqual(["session-1"]);
    expect(live[0]?.tools.restrict).toBe(restrict);
  });

  it("服务缺席：两个晚读面给 undefined / 空表，不抛", () => {
    const faces = bindHost(fakeHostCtx({}));
    expect(faces.models()).toBeUndefined();
    expect(faces.events.liveAgents()).toEqual([]);
  });
});
