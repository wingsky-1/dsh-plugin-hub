/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CFG,
  GEN,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  applyPromptTemplate,
  buildStatsSnapshot,
  fakeLlm,
  generateReport,
  join,
  mkdtempSync,
  notifyReport,
  persistReport,
  readFileSync,
  reportHtmlFile,
  reportMetaFile,
  rmSync,
  textOf,
  tmpdir,
  type TrendDirRow,
} from "./report-generation-support.ts";

type RedactionState = {
  allDirs: string[];
  injected: string;
  noDirSnap: ReturnType<typeof buildStatsSnapshot>;
  rMetaOk: boolean;
  promptText: string;
  htmlText: string;
  metaText: string;
  sentLen: number;
  pushBody: string;
};

function registerRedactionDirCases(state: RedactionState): void {
  for (const [, d] of state.allDirs.entries()) {
    it(`注入 JSON 目录键无路径分隔符：${JSON.stringify(d)}`, () => {
      expect(!d.includes("/") && !d.includes("\\")).toBeTruthy();
    });

    it(`注入 JSON 目录键无 C0+DEL+C1 控制字符：${JSON.stringify(d)}`, () => {
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(d)).toBeFalsy();
    });

    it(`注入 JSON 目录键 ≤80 字符（实际 ${d.length}）`, () => {
      expect(d.length <= 80).toBeTruthy();
    });
  }

  it("POSIX 绝对路径出口 = basename", () => {
    expect(state.allDirs.includes("secret-project")).toBeTruthy();
  });

  it("Windows 绝对路径出口 = basename", () => {
    expect(state.allDirs.includes("repo")).toBeTruthy();
  });

  it("C1 形态（pro\\u009bj）剥除后 = proj（复核 P1-2）", () => {
    expect(state.allDirs.includes("proj")).toBeTruthy();
  });

  it("控制字符剥除 + 截断 80 形态（剥后残留字面字符保留）", () => {
    const hostileDir = state.allDirs.find((d) => d.startsWith("x"));
    expect(
      hostileDir !== undefined && hostileDir.length <= 80 && !/[\u0000-\u001f]/.test(hostileDir),
    ).toBeTruthy();
  });

  it("注入 JSON 全文不含原始绝对路径", () => {
    expect(state.injected.includes("/home/alice")).toBeFalsy();
  });

  it("注入 JSON 全文不含 Windows 路径", () => {
    expect(
      !state.injected.includes("Users\\\\bob") && !state.injected.includes("Users\\bob"),
    ).toBeTruthy();
  });

  it("无目录事实 → byDirectory 空数组（不补造）", () => {
    expect(state.noDirSnap.byDirectory).toEqual([]);
  });

  it("带目录快照生成成功", () => {
    expect(state.rMetaOk).toBe(true);
  });

  it("{stats} 注入 prompt 全文无绝对路径（出口 2 前置：模型只见 basename 形态）", () => {
    expect(
      !state.promptText.includes("/home/alice") && !state.promptText.includes("Users\\bob"),
    ).toBeTruthy();
  });

  it("prompt 含 basename 形态目录名（模型可见面）", () => {
    expect(
      state.promptText.includes("secret-project") && state.promptText.includes("repo"),
    ).toBeTruthy();
  });

  const artifacts: Array<[string, () => string]> = [
    ["HTML", () => state.htmlText],
    ["meta", () => state.metaText],
  ];

  for (const [name, getArtifact] of artifacts) {
    it(`报告产物（${name}）不含绝对路径`, () => {
      const artifact = getArtifact();
      expect(!artifact.includes("/home/alice") && !artifact.includes("Users\\bob")).toBeTruthy();
    });

    it(`报告产物（${name}）无原始控制字符（排版 \\n/\\t 除外）`, () => {
      const artifact = getArtifact();
      // 目录键不携带的排版性换行/制表除外（meta.json 为缩进 2 pretty JSON），其余 C0 控制字符不得出现
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(artifact)).toBeFalsy();
    });
  }

  it("产物正文含 basename 目录名（LLM 叙事引用）", () => {
    expect(state.htmlText.includes("secret-project")).toBeTruthy();
  });
}

function registerRedactionArtifactCases(state: RedactionState): void {
  it("推送已发出", () => {
    expect(state.sentLen).toBe(1);
  });

  it("推送摘要不含任何路径分隔符（仅周期/窗口/数值）", () => {
    expect(!state.pushBody.includes("/") && !state.pushBody.includes("\\")).toBeTruthy();
  });

  it("推送摘要无控制字符", () => {
    expect(/[\u0000-\u001f\u007f]/.test(state.pushBody)).toBeFalsy();
  });

  it("推送摘要含周期标识（数值型摘要形态）", () => {
    expect(state.pushBody.includes("daily")).toBeTruthy();
  });
}

describe("#633 分片 b C2：脱敏出口逐条断言（basename 化 + 三出口）", () => {
  const state = {} as RedactionState;
  const MALICIOUS_DIRS = [
    "/home/alice/secret-project",
    "C:\\Users\\bob\\work\\repo",
    `x\n\t${"y".repeat(120)}`,
    "pro\u009bj",
    TREND_UNIDENTIFIED,
  ];
  const MALICIOUS_INPUTS = [100, 50, 10, 3, 5];
  const snap = buildStatsSnapshot({
    period: "daily",
    startDay: "2026-09-03",
    endDay: "2026-09-03",
    buckets: [],
    dirRows: MALICIOUS_DIRS.map((dir, i): TrendDirRow => ({
      v: TREND_ROW_VERSION,
      kind: "dir",
      day: "2026-09-03",
      dir,
      input: MALICIOUS_INPUTS[i],
      output: null,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
      turns: 0,
      toolCalls: 0,
    })),
    prevTotal: null,
  });
  state.allDirs = snap.byDirectory.map((r) => r.dir);
  state.injected = applyPromptTemplate("统计：{stats}", JSON.stringify(snap));
  state.noDirSnap = buildStatsSnapshot({
    period: "daily",
    startDay: "2026-09-03",
    endDay: "2026-09-03",
    buckets: [],
    prevTotal: null,
  });

  beforeAll(async () => {
    // 出口 2：报告产物正文（fake llm 回显目录 basename 的叙事正文；正文为 LLM 叙事——
    // 断言落盘链路 HTML 文档 + meta 不含路径形态，正文载体经 format 净化）
    const { llm, seen } = fakeLlm([
      { type: "text-delta", index: 0, text: "昨天用量集中在 secret-project 与 repo 两个目录。" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    const r = await generateReport(GEN({ llm, statsJson: JSON.stringify(snap) }));
    state.rMetaOk = r.meta.ok;
    state.promptText = textOf(seen.calls[0]!.messages[0].content[0]);
    // 产物正文出口：persistReport 的 HTML 文档与 meta.json 落盘形态（临时目录隔离）
    const rootDir = mkdtempSync(join(tmpdir(), "dou-report-c2-"));
    await persistReport(rootDir, r.meta, r.body);
    state.htmlText = readFileSync(reportHtmlFile(rootDir, r.meta.period, r.meta.key), "utf8");
    state.metaText = readFileSync(reportMetaFile(rootDir, r.meta.period, r.meta.key), "utf8");
    rmSync(rootDir, { recursive: true, force: true });
    // 出口 3：notifier 推送摘要（notifyReport 捕获 send 请求体）
    const sent: Array<{ title: unknown; body: unknown }> = [];
    // notifyReport 的 ctx 为宿主全量面，窄 fake 经 unknown 断言装配（仅 get 面为真）。
    const fakeCtx = {
      get: () => ({
        send: async (req: { title: unknown; body: unknown }) => {
          sent.push(req);
        },
      }),
    } as unknown as Parameters<typeof notifyReport>[0];
    notifyReport(fakeCtx, CFG({ push: { enabled: true } }), r.meta, snap, (s: string) => s);
    state.sentLen = sent.length;
    state.pushBody = sent.length > 0 ? `${sent[0].title} ${sent[0].body}` : "";
  });

  registerRedactionDirCases(state);
  registerRedactionArtifactCases(state);
});
