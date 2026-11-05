/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { ReportLlmService } from "../../../src/server/execute/interface.ts";
import { generateReportOutcome } from "./report-generation-support.ts";

// Official block and terminal cases.
const PRIVATE_REASONING = "不得保存的推理原文";
const TOOL_ARGUMENTS =
  '{"key":"sk-test-not-a-real-key","path":"/home/private/report.json","control":"\u0000"}';
const REPORT_TOOL_CALL_ID = "report-tool-call" as ToolCallId;
const UNSUPPORTED_TOOL_ERROR = "模型返回了报告不支持的工具调用";
const UNSUPPORTED_CONTENT_ERROR = "模型返回了报告不支持的内容块";

export const PRIVATE_IMAGE_NAME = "private-image-name.png";
export const PRIVATE_FILE_NAME = "private-file-name.txt";
export const PRIVATE_TOOL_NAME = "private_dynamic_tool";

import { CHUNKS, GEN, fakeLlm } from "./report-generation-support.ts";

// 官方 ContentBlock 的真实字段形状；附件 id 是品牌字符串，测试只在边界处做窄断言。
const IMAGE_BLOCK = {
  type: "image",
  attachment: {
    attachmentId: "image-fixture",
    mediaType: "image/png",
    bytes: 1,
    width: 1,
    height: 1,
    name: PRIVATE_IMAGE_NAME,
  },
} as ContentBlock;
const FILE_BLOCK = {
  type: "file",
  attachment: {
    attachmentId: "file-fixture",
    name: PRIVATE_FILE_NAME,
    bytes: 1,
  },
} as ContentBlock;
const TOOL_ADDITION_BLOCK: ContentBlock = {
  type: "tool-addition",
  toolName: PRIVATE_TOOL_NAME,
};
const TOOL_REMOVAL_BLOCK: ContentBlock = {
  type: "tool-removal",
  toolName: PRIVATE_TOOL_NAME,
};

const UNSUPPORTED_CONTENT_BLOCKS: Array<{ name: string; block: ContentBlock }> = [
  { name: "image", block: IMAGE_BLOCK },
  { name: "file", block: FILE_BLOCK },
  { name: "tool-addition", block: TOOL_ADDITION_BLOCK },
  { name: "tool-removal", block: TOOL_REMOVAL_BLOCK },
];

const UNSUPPORTED_CONTENT_STREAMS: Array<{ name: string; chunks: StreamChunk[] }> = [
  ...UNSUPPORTED_CONTENT_BLOCKS.flatMap(
    ({ name, block }): Array<{ name: string; chunks: StreamChunk[] }> => [
      {
        name: `${name} block-start`,
        chunks: [
          { type: "block-start", index: 0, blockType: block.type },
          { type: "text-delta", index: 0, text: "不应保存的正文" },
          { type: "finish", reason: { kind: "stop" } },
        ],
      },
      {
        name: `${name} block-end`,
        chunks: [
          { type: "block-end", index: 0, block },
          { type: "text-delta", index: 0, text: "不应保存的正文" },
          { type: "finish", reason: { kind: "stop" } },
        ],
      },
    ],
  ),
];

const UNSUPPORTED_TOOL_STREAMS: Array<{ name: string; chunks: StreamChunk[] }> = [
  {
    name: "tool-call-delta",
    chunks: [
      {
        type: "tool-call-delta",
        index: 0,
        id: REPORT_TOOL_CALL_ID,
        name: "read_private_file",
        argumentsDelta: TOOL_ARGUMENTS,
      },
      { type: "finish", reason: { kind: "stop" } },
    ],
  },
  {
    name: "tool-call block-end",
    chunks: [
      {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: REPORT_TOOL_CALL_ID,
          name: "read_private_file",
          arguments: TOOL_ARGUMENTS,
        },
      },
      { type: "finish", reason: { kind: "stop" } },
    ],
  },
  {
    name: "tool-calls finish",
    chunks: [
      { type: "text-delta", index: 0, text: "不应成功保存的正文" },
      { type: "finish", reason: { kind: "tool-calls" } },
    ],
  },
];

// Exact-model capability cases.
const effortId = (value: string): ReasoningEffortId => value as ReasoningEffortId;

const GENERIC_CAPABILITY: LlmResolvedModelInfo = {
  provider: "generic-provider",
  id: "generic-model",
  name: "Generic Model",
  reasoning: {
    efforts: [
      { id: effortId("vendor::balanced"), name: "Balanced", description: "通用平衡档" },
      { id: effortId("vendor::deep"), name: "Deep" },
    ],
    defaultEffort: effortId("vendor::balanced"),
  },
};

const GENERIC_WITHOUT_REASONING: LlmResolvedModelInfo = {
  provider: "generic-provider",
  id: "generic-model",
  name: "Generic Model",
};

// Stream and structured failure matrices.
export const RAW_PROVIDER_FAILURE =
  "key=sk-test-not-a-real-key path=/home/private/report.json control=\u0000";
const SAFE_STREAM_FAILURE = {
  kind: "transient",
  code: "provider-stream-failed",
} as const;
const SAFE_STREAM_UNKNOWN = {
  kind: "unknown",
  code: "provider-stream-failed",
} as const;
const SAFE_STREAM_PERMANENT = {
  kind: "permanent",
  code: "provider-stream-failed",
} as const;
const SAFE_STREAM_ABORTED = {
  kind: "aborted",
  code: "request-aborted",
} as const;
const STREAM_CASES = [
  {
    name: "EMPTY_RESPONSE",
    error: { code: "EMPTY_RESPONSE", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_FAILURE,
  },
  {
    name: "RATE_LIMIT",
    error: { code: "RATE_LIMIT", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_FAILURE,
  },
  {
    name: "SERVER",
    error: { code: "SERVER", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_FAILURE,
  },
  {
    name: "TIMEOUT",
    error: { code: "TIMEOUT", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_FAILURE,
  },
  {
    name: "TRANSPORT",
    error: { code: "TRANSPORT", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_FAILURE,
  },
  {
    name: "AUTH",
    error: { code: "AUTH", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "INVALID_CREDENTIAL",
    error: { code: "INVALID_CREDENTIAL", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "MISSING_CREDENTIAL",
    error: { code: "MISSING_CREDENTIAL", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "QUOTA",
    error: { code: "QUOTA", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "ACCOUNT_QUOTA",
    error: { code: "ACCOUNT_QUOTA", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "INVALID_REQUEST",
    error: { code: "INVALID_REQUEST", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "CONTEXT_WINDOW",
    error: { code: "CONTEXT_WINDOW", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "CONTEXT_WINDOW_EXCEEDED",
    error: { code: "CONTEXT_WINDOW_EXCEEDED", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "CONTENT_FILTER",
    error: { code: "CONTENT_FILTER", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "NO_ADAPTER",
    error: { code: "NO_ADAPTER", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "未知 code",
    error: { code: "FUTURE_CODE", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_UNKNOWN,
  },
  {
    name: "HTTP 401",
    error: { status: 401, message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "HTTP 429 无结构化 code",
    error: { statusCode: 429, message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_UNKNOWN,
  },
  {
    name: "HTTP 429 + RATE_LIMIT",
    error: { statusCode: 429, code: "RATE_LIMIT", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_FAILURE,
  },
  {
    name: "HTTP 429 + QUOTA",
    error: { statusCode: 429, code: "QUOTA", message: RAW_PROVIDER_FAILURE },
    expected: SAFE_STREAM_PERMANENT,
  },
  {
    name: "嵌套 LlmFailure",
    error: { failure: { code: "RATE_LIMIT", message: RAW_PROVIDER_FAILURE } },
    expected: SAFE_STREAM_FAILURE,
  },
  {
    name: "Error cause",
    error: Object.assign(new Error(RAW_PROVIDER_FAILURE), {
      cause: { code: "AUTH" },
    }),
    expected: SAFE_STREAM_PERMANENT,
  },
] as const;
const STRUCTURED_FAILURE_CASES = [
  {
    name: "空正文",
    expected: { kind: "empty-output", code: "empty-output" },
    run: () =>
      generateReportOutcome(
        GEN({ llm: fakeLlm([{ type: "finish", reason: { kind: "stop" } }]).llm }),
      ),
  },
  {
    name: "未知内容事件",
    expected: { kind: "unknown", code: "unknown-stream-event" },
    run: () =>
      generateReportOutcome(
        GEN({
          llm: fakeLlm([futureContentChunk(), { type: "finish", reason: { kind: "stop" } }]).llm,
        }),
      ),
  },
  {
    name: "未知终态",
    expected: { kind: "unknown", code: "unknown-finish" },
    run: () =>
      generateReportOutcome(
        GEN({
          llm: fakeLlm([{ type: "text-delta", index: 0, text: "不能保存" }, futureFinishChunk()])
            .llm,
        }),
      ),
  },
  {
    name: "缺失终态",
    expected: { kind: "unknown", code: "missing-finish" },
    run: () =>
      generateReportOutcome(
        GEN({ llm: fakeLlm([{ type: "text-delta", index: 0, text: "不能保存" }]).llm }),
      ),
  },
  {
    name: "不支持工具",
    expected: { kind: "permanent", code: "unsupported-tool" },
    run: () =>
      generateReportOutcome(GEN({ llm: fakeLlm(UNSUPPORTED_TOOL_STREAMS[0]!.chunks).llm })),
  },
  {
    name: "不支持非文本内容块",
    expected: { kind: "permanent", code: "unsupported-content" },
    run: () =>
      generateReportOutcome(GEN({ llm: fakeLlm(UNSUPPORTED_CONTENT_STREAMS[0]!.chunks).llm })),
  },
  {
    name: "路由不可用",
    expected: { kind: "permanent", code: "route-unavailable" },
    run: () => generateReportOutcome(GEN({ llm: fakeLlm(CHUNKS, { noProviders: true }).llm })),
  },
  {
    name: "空 route 不进入 stream",
    expected: { kind: "permanent", code: "route-unavailable" },
    run: () =>
      generateReportOutcome(
        GEN({
          llm: fakeLlm(CHUNKS).llm,
          route: { status: "success", route: { provider: "", model: "" } },
        }),
      ),
  },
  {
    name: "路由解析异常",
    expected: { kind: "unknown", code: "route-resolution-failed" },
    run: () =>
      generateReportOutcome(
        GEN({
          llm: fakeLlm(CHUNKS, {
            throwInListProviders: "raw provider route credential must not escape",
          }).llm,
        }),
      ),
  },
  ...STREAM_CASES.map(({ name, error, expected }) => ({
    name: `流异常 ${name}`,
    error,
    expected,
    run: () => {
      const llm: ReportLlmService = {
        ...fakeLlm().llm,
        stream: () =>
          (async function* (): AsyncGenerator<StreamChunk> {
            throw error;
          })(),
      };
      return generateReportOutcome(GEN({ llm }));
    },
  })),
  {
    name: "流异常时调用方 signal 已 abort",
    expected: SAFE_STREAM_ABORTED,
    run: () => {
      const llm: ReportLlmService = {
        ...fakeLlm().llm,
        stream: () =>
          (async function* (): AsyncGenerator<StreamChunk> {
            throw { code: "RATE_LIMIT", message: RAW_PROVIDER_FAILURE };
          })(),
      };
      const controller = new AbortController();
      controller.abort();
      return generateReportOutcome(GEN({ llm, signal: controller.signal }));
    },
  },
  {
    name: "capability 缺失",
    expected: { kind: "permanent", code: "capability-unavailable" },
    run: () =>
      generateReportOutcome(GEN({ llm: fakeLlm(CHUNKS).llm, reasoningEffort: "vendor::deep" })),
  },
  {
    name: "capability 不支持 effort",
    expected: { kind: "permanent", code: "capability-unsupported" },
    run: () =>
      generateReportOutcome(
        GEN({
          llm: fakeLlm(CHUNKS, { capability: GENERIC_WITHOUT_REASONING }).llm,
          reasoningEffort: "vendor::deep",
        }),
      ),
  },
  {
    name: "capability 解析异常",
    expected: { kind: "permanent", code: "capability-failed" },
    run: () =>
      generateReportOutcome(
        GEN({
          llm: fakeLlm(CHUNKS, { capabilityError: "raw capability response" }).llm,
          reasoningEffort: "vendor::deep",
        }),
      ),
  },
  {
    name: "finish error",
    expected: { kind: "permanent", code: "provider-finish-failed" },
    run: () =>
      generateReportOutcome(
        GEN({
          llm: fakeLlm([
            {
              type: "finish",
              reason: { kind: "error", failure: { message: "raw finish secret", code: "raw" } },
            },
          ]).llm,
        }),
      ),
  },
  {
    name: "finish aborted",
    expected: { kind: "aborted", code: "request-aborted" },
    run: () =>
      generateReportOutcome(
        GEN({
          llm: fakeLlm([
            {
              type: "finish",
              reason: { kind: "aborted", failure: { message: "raw abort secret", code: "raw" } },
            },
          ]).llm,
        }),
      ),
  },
  {
    name: "调用前 signal abort",
    expected: { kind: "aborted", code: "request-aborted" },
    run: () => {
      const controller = new AbortController();
      controller.abort();
      return generateReportOutcome(GEN({ llm: fakeLlm(CHUNKS).llm, signal: controller.signal }));
    },
  },
] as const;

// Normal, terminal, and future terminal cases.
const NORMAL_FINISH_REASONS: Array<{ name: string; reason: FinishReason }> = [
  { name: "stop", reason: { kind: "stop" } },
  { name: "max-tokens", reason: { kind: "max-tokens" } },
];
const TERMINAL_FAILURES: Array<{
  name: string;
  reason: FinishReason;
  expectedError: string;
}> = [
  {
    name: "error",
    reason: {
      kind: "error",
      failure: { message: RAW_PROVIDER_FAILURE, code: "sk-code-must-not-leak" },
    },
    expectedError: "模型请求失败",
  },
  {
    name: "aborted",
    reason: {
      kind: "aborted",
      failure: { message: RAW_PROVIDER_FAILURE, code: "sk-code-must-not-leak" },
    },
    expectedError: "模型请求已取消",
  },
];
function futureFinishChunk(): StreamChunk {
  const chunk: StreamChunk = { type: "finish", reason: { kind: "stop" } };
  Object.defineProperty(chunk.reason, "kind", { value: "future-stop" });
  return chunk;
}

function futureContentChunk(): StreamChunk {
  const chunk: StreamChunk = {
    type: "reasoning-delta",
    index: 0,
    text: "未来扩展内容",
  };
  Object.defineProperty(chunk, "type", { value: "future-delta" });
  return chunk;
}
const ERROR_FINISH_CHUNK: StreamChunk = {
  type: "finish",
  reason: { kind: "error", failure: { message: RAW_PROVIDER_FAILURE, code: "raw-code" } },
};
const NORMAL_FINISH_CHUNK: StreamChunk = { type: "finish", reason: { kind: "stop" } };

const TERMINAL_MERGE_CASES: Array<{
  name: string;
  first: StreamChunk;
  second: StreamChunk;
  expectedError: string;
}> = [
  {
    name: "error→normal",
    first: ERROR_FINISH_CHUNK,
    second: NORMAL_FINISH_CHUNK,
    expectedError: "模型请求失败",
  },
  {
    name: "normal→unknown",
    first: NORMAL_FINISH_CHUNK,
    second: futureFinishChunk(),
    expectedError: "模型流返回未知终态",
  },
  {
    name: "unknown→error",
    first: futureFinishChunk(),
    second: ERROR_FINISH_CHUNK,
    expectedError: "模型请求失败",
  },
  {
    name: "unknown→normal",
    first: futureFinishChunk(),
    second: NORMAL_FINISH_CHUNK,
    expectedError: "模型流返回未知终态",
  },
];

export {
  PRIVATE_REASONING,
  TOOL_ARGUMENTS,
  REPORT_TOOL_CALL_ID,
  UNSUPPORTED_TOOL_ERROR,
  UNSUPPORTED_CONTENT_ERROR,
  UNSUPPORTED_CONTENT_STREAMS,
  UNSUPPORTED_TOOL_STREAMS,
  effortId,
  GENERIC_CAPABILITY,
  GENERIC_WITHOUT_REASONING,
  STREAM_CASES,
  STRUCTURED_FAILURE_CASES,
  NORMAL_FINISH_REASONS,
  TERMINAL_FAILURES,
  futureFinishChunk,
  futureContentChunk,
  TERMINAL_MERGE_CASES,
};
export type {
  ContentBlock,
  GenerateOptions,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
  ToolCallId,
};
