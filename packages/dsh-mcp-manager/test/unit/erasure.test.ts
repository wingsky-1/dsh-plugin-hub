/**
 * dsh-mcp-manager — unit：erasure 域（#922 伴随项 E：装配侧兜底擦除）。
 *
 * 覆盖实现的三条承重约束：只擦行首声明（散文豁免）、注释连带不留无主注释、
 * 花括号深度收口；未知形状宁漏不坏；监听层无泄漏原引用返回、累计计数 warn。
 * 夹具按真实 SDK 渲染形状建模（ToolArgsMap 值声明 + ToolOutputMap 输出块，
 * 均带文档注释）：渲染格式漂移导致漏擦时，“行首零残留”断言即红。
 *
 * 直连域门面（src/server/erasure/interface.ts）——不 import src/index.ts。
 */
import { describe, expect, it } from "vitest";
import { eraseMcpSdkDeclarations, startSdkErasure } from "../../src/server/erasure/interface.ts";
import type { ErasureAssemblePort } from "../../src/server/erasure/interface.ts";

const NL = String.fromCharCode(10);

/** 行首残留扫描：结果里不得再有行首 mcp__ 声明（渲染漂移即红）。 */
function leakedLines(text: string): string[] {
  return text.split(NL).filter((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("mcp__")) return false;
    const rest = trimmed.slice(5);
    return rest.indexOf(":") > 0;
  });
}

/** 真实渲染形状的 SDK 片段：值声明、输出块（含嵌套）、散文提及、非 mcp 条目。 */
const SDK_FIXTURE = [
  "interface ToolArgsMap {",
  "  /** Clicks on the provided element */",
  "  mcp__2P7Wojdly5Rc__click: unknown;",
  "  /** Ask the user a concise question. */",
  "  ask_user_question: {",
  "    questions: string;",
  "  };",
  "  /** Prose mentions mcp__ mid-line are not declarations. */",
  "  present: {",
  "    files: string;",
  "  };",
  "}",
  "interface ToolOutputMap {",
  "  /**",
  "   * Multi-line doc for the output block.",
  "   */",
  "  mcp__2P7Wojdly5Rc__click: {",
  "    content: string;",
  "    nested: {",
  "      deep: number;",
  "    };",
  "  };",
  "  present: {",
  "    turn: number;",
  "  };",
  "}",
].join(NL);

/** 假组装口：捕获监听、摘除可观测。 */
function makeAssemble(): {
  handlers: Array<(a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>;
  unhooked: string[];
  port: ErasureAssemblePort;
} {
  const handlers: Array<(a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<unknown>> =
    [];
  const unhooked: string[] = [];
  return {
    handlers,
    unhooked,
    port: {
      onAssemble: ((handler: unknown): (() => void) => {
        handlers.push(
          handler as (a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<unknown>,
        );
        return () => {
          unhooked.push("assemble");
        };
      }) as unknown as ErasureAssemblePort["onAssemble"],
    },
  };
}

function makeLogger(): { warns: string[]; warn: (message: string) => void } {
  const warns: string[] = [];
  return {
    warns,
    warn: (message: string) => {
      warns.push(message);
    },
  };
}

describe("erasure 域：tools:sdk 段的 mcp__ 声明级擦除", () => {
  it("E1 值声明连同附着注释被擦，非 mcp__ 条目与散文原样保留", () => {
    const result = eraseMcpSdkDeclarations(SDK_FIXTURE);
    expect(result.erased, "一处值声明加一处输出块").toBe(2);
    expect(leakedLines(result.text), "行首零残留").toEqual([]);
    expect(result.text, "非 mcp 条目保留").toContain("ask_user_question");
    expect(result.text, "输出映射的非 mcp 块保留").toContain("turn: number;");
    expect(result.text, "散文注释行保留").toContain("Prose mentions mcp__ mid-line");
    expect(result.text, "被擦声明的注释不残留").not.toContain("Clicks on the provided element");
  });

  it("E2 输出映射块按 brace 深度收口，嵌套不提前结束、不误删块外行", () => {
    const result = eraseMcpSdkDeclarations(SDK_FIXTURE);
    expect(result.text, "块内嵌套行被带走").not.toContain("deep: number;");
    expect(result.text, "块外同名收口行保留").toContain("questions: string;");
    expect(result.text.split(NL).length, "只删声明相关行").toBe(SDK_FIXTURE.split(NL).length - 11);
  });

  it("E3 未知形状宁漏不坏：未来渲染形状原样保留且计数为零", () => {
    const future = ["interface ToolArgsMap {", "  mcp__zzz__tool: SomeFutureShape;", "}"].join(NL);
    const result = eraseMcpSdkDeclarations(future);
    expect(result.erased).toBe(0);
    expect(result.text).toBe(future);
  });

  it("E4 无泄漏文本原样返回", () => {
    const clean = ["interface ToolArgsMap {", "  present: {", "  };", "}"].join(NL);
    const result = eraseMcpSdkDeclarations(clean);
    expect(result.erased).toBe(0);
    expect(result.text).toBe(clean);
    expect(eraseMcpSdkDeclarations("").erased).toBe(0);
  });

  it("E5 监听：泄漏轮替换 tools:sdk 段、他段不动、warn 一次", async () => {
    const assemble = makeAssemble();
    const logger = makeLogger();
    const dispose = startSdkErasure({ assemble: assemble.port, logger });
    const other = { name: "plugin:x", text: "mcp__ prose stays" };
    const sdk = { name: "tools:sdk", text: SDK_FIXTURE };
    const downstream = { sections: [sdk, other], marker: 1 };
    const out = (await assemble.handlers[0](downstream, {}, async () => downstream)) as {
      sections: Array<{ name: string; text: string }>;
    };
    expect(out, "有泄漏返回新装配").not.toBe(downstream);
    expect(leakedLines(out.sections[0].text)).toEqual([]);
    expect(out.sections[1], "他段同一引用").toBe(other);
    expect(logger.warns.length).toBe(1);
    expect(logger.warns[0]).toContain("#922");
    dispose();
    expect(assemble.unhooked).toEqual(["assemble"]);
  });

  it("E6 监听：干净轮原引用返回、不 warn；累计计数跨轮累加", async () => {
    const assemble = makeAssemble();
    const logger = makeLogger();
    startSdkErasure({ assemble: assemble.port, logger });
    const clean = { sections: [{ name: "tools:sdk", text: "interface T {}" }] };
    const cleanOut = await assemble.handlers[0](clean, {}, async () => clean);
    expect(cleanOut, "干净轮同一引用").toBe(clean);
    expect(logger.warns).toEqual([]);
    const dirty = { sections: [{ name: "tools:sdk", text: SDK_FIXTURE }] };
    await assemble.handlers[0](dirty, {}, async () => dirty);
    await assemble.handlers[0](dirty, {}, async () => dirty);
    expect(logger.warns.length).toBe(2);
    expect(logger.warns[1]).toContain("round 2");
    expect(logger.warns[1]).toContain("total 4");
  });

  it("E7 监听：非字符串段、无 sections、非对象下游一律透传", async () => {
    const assemble = makeAssemble();
    const logger = makeLogger();
    startSdkErasure({ assemble: assemble.port, logger });
    const odd = { sections: [{ name: "tools:sdk", text: 42 }, null] };
    const oddOut = await assemble.handlers[0](odd, {}, async () => odd);
    expect(oddOut).toBe(odd);
    const bare = { marker: 1 };
    const bareOut = await assemble.handlers[0](bare, {}, async () => bare);
    expect(bareOut).toBe(bare);
    expect(logger.warns).toEqual([]);
  });
});
