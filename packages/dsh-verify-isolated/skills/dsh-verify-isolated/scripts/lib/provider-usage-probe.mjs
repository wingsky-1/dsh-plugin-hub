/**
 * provider-usage-probe.mjs — 可选真实宿主 provider-usage 探针（纯函数 + 注入 fetch 的薄 I/O）。
 *
 * 目的：在隔离 dsh 实例**就绪后**验证内置 deepseek-official 适配器能否经真实宿主完成
 * 一次取数，并识别「隔离环境有存储凭据、但 seam 取不到 key」的 API 漂移（no-api-key）。
 *
 * 语义（与 references/script-contracts.md 对齐）：
 *   - 隔离 DSH_HOME 无存储凭据（.credentials.yaml 无 refs 条目）→ skip，退出 0，明示未验证；
 *   - 有存储凭据 + stats.ok:true 或 error 非 no-api-key → pass，退出 0；
 *   - 有存储凭据 + stats.error === "no-api-key" → fail，退出 1，打印可操作诊断；
 *   - stats 请求失败 / 响应不可解析 / HTTP 非 200 → fail，退出 1（探针自身拿不到判定）。
 * 健康面（/api/dsh-provider-usage/health）只作诊断证据，不参与 pass/fail 判定——它表达
 * 适配器/分层健康，取数失败与否以 stats 为准。
 *
 * 安全边界（硬约束）：
 *   - 只读**隔离** DSH_HOME 下的 .credentials.yaml，永不读取/复制用户真实 ~/.dsh；
 *   - 只判断 refs 是否有条目，不解析、不保存、不回显任何凭据值；
 *   - 不把继承的环境变量当作凭据证据：env key 会经 V1 兜底让探针「假通过」，掩盖 seam
 *     漂移；无存储凭据时明确输出「未验证（无凭据）」而不是给一个不成立的 pass；
 *   - 探针只请求回环 baseUrl（API 路由由宿主 loopback 围栏保护），不拼接访问令牌；
 *   - 输出只含白名单字段，URL 去 query，文本经 redactSecrets 兜底。
 *
 * 本模块的纯函数（hasStoredCredentialDocument / classifyCredentials / parseStatsResponse /
 * parseHealthResponse / evaluateProbe / formatProbeReport / redactSecrets / sanitizeProbeUrl）
 * 供离线 fixture 断言；runProviderUsageProbe 是唯一 I/O 面，fetch 可注入（测试零网络）。
 */
import { existsSync, readFileSync } from "node:fs";

/** 探针固定 provider（与 provider-usage 内置 DeepSeek 适配器的 provider 键一致）。 */
export const PROBE_PROVIDER = "deepseek-official";

/** provider-usage 取数统计路由（src/apply/apply.ts 的 ROUTES.stats）。 */
export const STATS_PATH = "/api/dsh-provider-usage/stats";

/** provider-usage 健康路由（src/apply/apply.ts 的 ROUTES.health；宿主无独立 /health 路由）。 */
export const HEALTH_PATH = "/api/dsh-provider-usage/health";

/** 单请求超时：stats 侧适配器自身 5s 固定超时，留一倍余量。 */
export const PROBE_TIMEOUT_MS = 10000;

/** health.errors 最多保留条数（防大响应污染证据）。 */
const MAX_HEALTH_ERRORS = 10;

/** 只接受 plain object。 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串或 null。 */
function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 有限数字或 null。 */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 文本脱敏兜底：URL query / Bearer / 常见 key 前缀 / key=value 形态。
 * 探针本就不输出原始响应，这是防御性第二层（错误文本可能来自适配器/宿主）。
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (typeof text !== "string") return "";
  let out = text;
  out = out.replace(
    /([?&](?:token|api[_-]?key|access[_-]?token|secret|password)=)[^&\s]+/gi,
    "$1***",
  );
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-***");
  out = out.replace(
    /\b((?:token|api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;}"']+/gi,
    "$1***",
  );
  return out;
}

/**
 * 输出用 URL：只保留 origin + pathname，丢弃全部 query（provider 参数在报告里单列，
 * 令牌等任何 query 值一律不出现在回显/verdict 中）。
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeProbeUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "（无法解析的 URL）";
  }
}

/** 去掉行内注释（凭据文件的结构行判断只需 `#` 前的部分；不解析引号内 `#`）。 */
function stripLineComment(line) {
  const at = line.indexOf("#");
  return at === -1 ? line : line.slice(0, at);
}

const TOP_LEVEL_KEY_RE = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:/;

/** 取顶层键名（无缩进行），非顶层键返回 null。 */
function topLevelKeyOf(line) {
  if (/^\s/.test(line)) return null;
  const m = TOP_LEVEL_KEY_RE.exec(line);
  return m === null ? null : (m[1] ?? m[2] ?? m[3]);
}

/**
 * 判断 credentials 文档是否有**可解析的存储凭据**（纯文本结构判断，不读值）。
 *
 * 官方 dsh-credentials-local 的 version 1 布局把 API key 存在 `refs:` 下，浏览器会话
 * 密钥存在 `records:` 下。隔离 dsh web 启动后会写 records（浏览器会话），因此**不能**用
 * 「.credentials.yaml 是否存在」当凭据证据，否则无凭据环境会被误判成有凭据。
 *
 * 覆盖面：
 *   - `refs:` 块下至少一个条目（含嵌套键）；
 *   - `refs: {NAME: value}` 行内形态（非空）；
 *   - 旧版扁平布局（无 `version:`，顶层直接是 `NAME: value`）经 dsh 启动时迁移，
 *     此处按「无 version + 有条目」保守识别。
 * 注释、空行、`version`/`records` 顶层键本身都不算凭据。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
function refsHasEntry(lines, refsIndex) {
  const refsLine = lines[refsIndex];
  const inline = refsLine.slice(refsLine.indexOf(":") + 1).trim();
  if (inline !== "" && inline !== "{}" && inline !== "~" && inline !== "null") return true;
  // 块形态：refs 之后、下一个顶层键之前的第一个缩进键即条目。
  for (const line of lines.slice(refsIndex + 1)) {
    if (topLevelKeyOf(line) !== null) break;
    if (/^\s+\S[^:]*\s*:/.test(line)) return true;
  }
  return false;
}

/** 旧扁平布局（无 version 顶层键）：顶层标量键即凭据条目（records/refs 不算）。 */
function hasFlatLayoutCredential(lines) {
  if (lines.some((line) => topLevelKeyOf(line) === "version")) return false;
  return lines.some((line) => {
    const key = topLevelKeyOf(line);
    if (key === null || key === "records" || key === "refs") return false;
    return /:.*\S/.test(line);
  });
}

export function hasStoredCredentialDocument(text) {
  if (typeof text !== "string" || text.trim() === "") return false;
  const lines = text
    .split(/\r?\n/)
    .map(stripLineComment)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  const refsIndex = lines.findIndex((line) => topLevelKeyOf(line) === "refs");
  return refsIndex === -1 ? hasFlatLayoutCredential(lines) : refsHasEntry(lines, refsIndex);
}

/**
 * 凭据证据分类（纯函数）。
 * @param {{ exists?: boolean, text?: string }} evidence
 * @returns {{ present: boolean, reason: "stored-ref" | "no-file" | "empty-store" | "unreadable" }}
 */
export function classifyCredentials(evidence) {
  if (!evidence || evidence.exists !== true) return { present: false, reason: "no-file" };
  if (typeof evidence.text !== "string") return { present: false, reason: "unreadable" };
  if (!hasStoredCredentialDocument(evidence.text)) return { present: false, reason: "empty-store" };
  return { present: true, reason: "stored-ref" };
}

/**
 * /stats 响应解析（白名单字段；capsuleHtml 等一律丢弃）。
 *
 * `lastSuccessAt`：当前路由未直接暴露该字段，故对 ok:true 的帧用 fetchedAt 作为最后成功
 * 时刻；未来若宿主新增 lastSuccessAt 字段则优先采用。ok:false 时无法得知过去的成功时刻，
 * 恒为 null（不猜测）。
 *
 * @param {number|null} httpStatus
 * @param {unknown} payload
 * @returns {{ httpStatus: number|null, parsed: boolean, ok: boolean, error: string|null,
 *   reason: string|null, status: string|null, fetchedAt: number|null, lastSuccessAt: number|null,
 *   provider: string|null, adapterName: string|null }}
 */
/** body 字段读取：body 为 null 时恒 null（把空判断收敛到一处，降低判定分支数）。 */
function fieldOf(body, pick) {
  return body === null ? null : pick(body);
}

/** status 白名单（fresh/cached/stale），未知形态一律 null。 */
function statsStatusOf(body) {
  if (body === null) return null;
  const status = body.status;
  if (status === "fresh" || status === "cached" || status === "stale") return status;
  return null;
}

export function parseStatsResponse(httpStatus, payload) {
  const body = isRecord(payload) ? payload : null;
  const fetchedAt = fieldOf(body, (b) => numberOrNull(b.fetchedAt));
  const ok = fieldOf(body, (b) => b.ok === true) === true;
  const explicitLastSuccessAt = fieldOf(body, (b) => numberOrNull(b.lastSuccessAt));
  return {
    httpStatus: numberOrNull(httpStatus),
    parsed: body !== null,
    ok,
    error: fieldOf(body, (b) => stringOrNull(b.error)),
    reason: fieldOf(body, (b) => stringOrNull(b.reason)),
    status: statsStatusOf(body),
    fetchedAt,
    lastSuccessAt: explicitLastSuccessAt ?? (ok ? fetchedAt : null),
    provider: fieldOf(body, (b) => stringOrNull(b.provider)),
    adapterName: fieldOf(body, (b) => stringOrNull(b.adapterName)),
  };
}

/**
 * /health 响应解析（白名单字段）。health.errors 每项是适配器最近一次错误登记
 * （{ key, at, kind: load|exec, message }）；fetchErrors 取 kind=exec 子集
 * （即 fetchData 执行失败），当前路由未单独暴露该字段，未来若给数字则以它为准。
 *
 * @param {number|null} httpStatus
 * @param {unknown} payload
 */
/** 单条 health error 的白名单投影；非对象返回 null 由调用方过滤。 */
function healthErrorEntryOf(entry) {
  if (!isRecord(entry)) return null;
  const kind = entry.kind === "load" || entry.kind === "exec" ? entry.kind : null;
  return {
    key: stringOrNull(entry.key) ?? "",
    at: numberOrNull(entry.at),
    kind,
    message: stringOrNull(entry.message) ?? "",
  };
}

function healthErrorsOf(rawErrors) {
  const out = [];
  for (const entry of rawErrors.slice(0, MAX_HEALTH_ERRORS)) {
    const parsed = healthErrorEntryOf(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function parseHealthResponse(httpStatus, payload) {
  const body = isRecord(payload) ? payload : null;
  const rawErrors = fieldOf(body, (b) => (Array.isArray(b.errors) ? b.errors : [])) ?? [];
  const errors = healthErrorsOf(rawErrors);
  const fetchErrors = errors.filter((entry) => entry.kind === "exec");
  const explicitCount = fieldOf(body, (b) => numberOrNull(b.fetchErrors));
  return {
    httpStatus: numberOrNull(httpStatus),
    parsed: body !== null,
    ok: fieldOf(body, (b) => b.ok === true) === true,
    provider: fieldOf(body, (b) => stringOrNull(b.provider)),
    errors,
    errorsTotal: rawErrors.length,
    fetchErrors,
    fetchErrorCount: explicitCount ?? fetchErrors.length,
  };
}

/** no-api-key 的可操作诊断（不含任何凭据值，不提示复制真实凭据）。 */
const NO_API_KEY_DIAGNOSTICS = [
  "隔离 DSH_HOME 存在存储凭据（refs 有条目），但 stats 返回 no-api-key —— 凭据 seam 未把 key 交给 provider。",
  "排查顺序（目标 dsh 0.2.1-rc.2）：",
  "1) provider 是否在 llm.listConfigurableProviders 目录中（拼写 deepseek-official）；",
  "2) provider profile 的 apiKeyEnv 是否指向凭据引用名，且该 ref 在 .credentials.yaml 的 refs 下有条目；",
  "3) settings 服务取用是否仍是已漂移的 get(ns) 形态（0.2.1-rc.2 的 SettingsForms 只有 describe/update/replace/mutate）；",
  "4) credentials.resolve(ref) 是否返回非空 value；health.errors / layerErrors 是否登记 provider-config 诊断。",
  "不要复制真实凭据到隔离环境；请用测试专用凭据或 CI 注入的隔离存储复现。",
];

/**
 * 判定（纯函数）。输入为已解析的凭据证据、stats/health 与请求错误文本。
 *
 * @param {{ credentials?: {present: boolean, reason: string}, stats?: object|null,
 *   health?: object|null, statsError?: string|null }} input
 * @returns {{ enabled: true, status: "skip"|"pass"|"fail", exitCode: 0|1, headline: string,
 *   credentials: {present: boolean, reason: string}, stats: object|null, health: object|null,
 *   diagnostics: string[] }}
 */
/** 统一结果构造器（收敛重复字段，降低判定分支数与认知复杂度）。 */
function makeResult(base, status, exitCode, headline, diagnostics) {
  return { ...base, status, exitCode, headline, diagnostics };
}

/** skip 分支：无存储凭据时明确「未验证」，不用 pass 掩盖没跑。 */
function skipProbeResult(base, credentials) {
  const reasonText =
    credentials.reason === "empty-store"
      ? "存在但无 refs 条目"
      : credentials.reason === "unreadable"
        ? "存在但不可读"
        : "不存在";
  return makeResult(base, "skip", 0, "未验证（无凭据）", [
    `隔离 DSH_HOME 的 .credentials.yaml ${reasonText}，跳过真实宿主取数断言。`,
    "探针不读取/复制用户 ~/.dsh 凭据，也不把继承的环境变量当凭据证据（env key 会经 V1 兜底造成 seam 假通过）。",
    "需要真实宿主断言时，请由运行方自行把测试专用凭据写入隔离 DSH_HOME 的存储，再重跑 --probe-provider-usage。",
  ]);
}

/** pass 分支：真实取数成功。 */
function okProbeResult(base, stats, health) {
  const healthLine =
    health?.ok === true
      ? "health.ok=true。"
      : "health 未通过或不可用；pass/fail 以 stats 为准，health 仅作诊断证据。";
  return makeResult(base, "pass", 0, "通过（真实宿主取数成功）", [
    `stats.ok=true，provider=${stats.provider ?? "(未知)"}，adapterName=${stats.adapterName ?? "(未知)"}。`,
    healthLine,
  ]);
}

/** fail 分支：凭据存在但 seam 未把 key 交给 provider（#1164 的回归形态）。 */
function noApiKeyProbeResult(base, health) {
  const lines = [...NO_API_KEY_DIAGNOSTICS];
  if (health !== null && health.errorsTotal > 0) {
    lines.push(
      `health.errors 共 ${health.errorsTotal} 条（fetchErrors=${health.fetchErrorCount}）；详情见 --keep 的 verdict.json。`,
    );
  }
  return makeResult(base, "fail", 1, "失败（凭据存在但 no-api-key）", lines);
}

/** pass 分支：凭据链已解析到 key，上游取数失败不算 seam 失败。 */
function nonNoApiKeyProbeResult(base, stats) {
  return makeResult(base, "pass", 0, "通过（凭据已解析，非 no-api-key）", [
    `stats.ok=false 且 error=${stats.error ?? "(空)"}（不是 no-api-key，凭据链已解析到 key；上游取数失败不算 seam 失败）。`,
  ]);
}

/** stats 可用性闸：请求失败 / HTTP 非 200 / 非 JSON 都归 fail；通过返回 null。 */
function statsGateResult(base, stats, statsError) {
  if (stats === null) {
    return makeResult(base, "fail", 1, "失败（stats 请求不可用）", [
      `stats 请求失败：${redactSecrets(statsError)}`,
      "确认隔离实例已就绪、provider-usage 插件已挂载到该 profile，且路由未被宿主版本变更移除。",
    ]);
  }
  if (stats.httpStatus !== 200) {
    return makeResult(base, "fail", 1, "失败（stats HTTP 非 200）", [
      `stats 返回 HTTP ${stats.httpStatus ?? "(无响应)"}（期望 200）。`,
      "HTTP 404 通常表示 provider-usage 插件未安装/未挂载到隔离 profile；HTTP 500 看 dsh.log 尾部。",
    ]);
  }
  if (!stats.parsed) {
    return makeResult(base, "fail", 1, "失败（stats 响应不可解析）", [
      `stats 响应不是 JSON 对象：${redactSecrets(statsError)}`,
      "路由契约可能已漂移；对照 provider-usage 的 data-routes/stats.ts 响应字段。",
    ]);
  }
  return null;
}

/** 判定入参归一化（把可选/空值收敛在此，保持 evaluateProbe 的分支数可审计）。 */
function normalizeProbeInput(input) {
  const source = input ?? {};
  return {
    credentials: source.credentials ?? { present: false, reason: "no-file" },
    stats: source.stats ?? null,
    health: source.health ?? null,
    statsError: source.statsError ?? "未知错误",
  };
}

export function evaluateProbe(input) {
  const { credentials, stats, health, statsError } = normalizeProbeInput(input);
  const base = { enabled: true, credentials, stats, health };
  if (!credentials.present) return skipProbeResult(base, credentials);
  const gate = statsGateResult(base, stats, statsError);
  if (gate !== null) return gate;
  if (stats.ok === true) return okProbeResult(base, stats, health);
  if (stats.error === "no-api-key") return noApiKeyProbeResult(base, health);
  return nonNoApiKeyProbeResult(base, stats);
}

/** 时间戳格式化（报告用；非有限值给 "-"）。 */
function formatTime(value) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : "-";
}

/**
 * 人类可读报告（纯函数，逐行数组）。skip 时 headline 必须逐字含「未验证（无凭据）」。
 * @param {ReturnType<typeof evaluateProbe> & { checkedAt?: string, endpoints?: object }} result
 * @returns {string[]}
 */
function credentialReportLine(result) {
  return result.credentials.present
    ? "凭据: 隔离 DSH_HOME 存在存储凭据（refs 有条目；值不读取、不复制、不回显）"
    : "凭据: 隔离 DSH_HOME 无存储凭据";
}

function statsReportLines(result) {
  if (result.stats === null) return [];
  const s = result.stats;
  return [
    `stats: GET ${sanitizeProbeUrl(result.endpoints?.stats ?? "")}?provider=${PROBE_PROVIDER} -> HTTP ${s.httpStatus ?? "-"}`,
    `  ok=${s.ok} error=${s.error ?? "-"} reason=${s.reason ?? "-"} status=${s.status ?? "-"} fetchedAt=${formatTime(s.fetchedAt)} lastSuccessAt=${formatTime(s.lastSuccessAt)}`,
  ];
}

function healthReportLines(result) {
  if (result.health === null) return [];
  const h = result.health;
  const lines = [
    `health: GET ${sanitizeProbeUrl(result.endpoints?.health ?? "")} -> HTTP ${h.httpStatus ?? "-"}`,
    `  ok=${h.ok} errors=${h.errorsTotal} fetchErrors=${h.fetchErrorCount}`,
  ];
  for (const err of h.errors) {
    lines.push(
      `  - kind=${err.kind ?? "-"} at=${formatTime(err.at)} key=${redactSecrets(err.key)} message=${redactSecrets(err.message)}`,
    );
  }
  return lines;
}

function diagnosticsReportLines(result) {
  if (result.diagnostics.length === 0) return [];
  const lines = ["诊断:"];
  for (const line of result.diagnostics) lines.push(`  - ${redactSecrets(line)}`);
  return lines;
}

export function formatProbeReport(result) {
  const lines = [
    "provider-usage 探针（可选真实宿主验证，不是离线 CI 门禁）",
    `结论: ${result.headline}`,
    credentialReportLine(result),
    ...statsReportLines(result),
    ...healthReportLines(result),
    ...diagnosticsReportLines(result),
  ];
  if (typeof result.checkedAt === "string") lines.push(`检查时刻: ${result.checkedAt}`);
  return lines;
}

/**
 * 请求一次 JSON（GET）。网络/超时/非 JSON 都收进返回值，不抛。
 * @returns {Promise<{ httpStatus: number|null, payload: unknown, error: string|null }>}
 */
async function fetchJson(fetchImpl, url, timeoutMs) {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return { httpStatus: res.status, payload: JSON.parse(text), error: null };
    } catch {
      return { httpStatus: res.status, payload: undefined, error: "响应不是合法 JSON" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { httpStatus: null, payload: undefined, error: message };
  }
}

/** 构造探针 URL（不拼访问令牌：API 路由只受宿主 loopback 围栏保护）。 */
function buildProbeUrl(baseUrl, path, withProvider) {
  const url = new URL(path, baseUrl);
  if (withProvider) url.searchParams.set("provider", PROBE_PROVIDER);
  return url;
}

/**
 * 执行探针（唯一 I/O 面；fetch 可注入，测试零网络）。
 *
 * @param {{ baseUrl: string, credentialsPath: string, fetchImpl?: typeof fetch,
 *   timeoutMs?: number, now?: () => number }} opts
 */
export async function runProviderUsageProbe(opts) {
  const { baseUrl, credentialsPath } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const statsUrl = buildProbeUrl(baseUrl, STATS_PATH, true);
  const healthUrl = buildProbeUrl(baseUrl, HEALTH_PATH, false);

  let evidence;
  try {
    const exists = existsSync(credentialsPath);
    evidence = { exists, text: exists ? readFileSync(credentialsPath, "utf8") : undefined };
  } catch {
    evidence = { exists: true, text: undefined };
  }
  const credentials = classifyCredentials(evidence);

  let stats = null;
  let health = null;
  let statsError = null;
  if (credentials.present) {
    const statsResponse = await fetchJson(fetchImpl, statsUrl, timeoutMs);
    statsError = statsResponse.error;
    stats = parseStatsResponse(statsResponse.httpStatus, statsResponse.payload);
    const healthResponse = await fetchJson(fetchImpl, healthUrl, timeoutMs);
    health = parseHealthResponse(healthResponse.httpStatus, healthResponse.payload);
  }

  const evaluated = evaluateProbe({ credentials, stats, health, statsError });
  return {
    ...evaluated,
    endpoints: {
      stats: sanitizeProbeUrl(statsUrl.href),
      health: sanitizeProbeUrl(healthUrl.href),
    },
    checkedAt: new Date(now()).toISOString(),
  };
}
