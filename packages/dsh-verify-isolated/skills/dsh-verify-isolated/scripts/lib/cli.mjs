import { parseArgs } from "node:util";
import { EXIT } from "./verify-core.mjs";

const DEFAULT_PORT = 3456;

export function createUsage(targetDshVersion) {
  return `用法: node verify-isolated.mjs [--port <port>] [--browser] [--keep] [--no-build] [--evidence-dir <dir>] [--audit] [--audit-extra-dirs <dir>] [--no-skip-onboarding] [--probe-provider-usage] [--json] [-- <pkg-path>...]

选项：
  --port <port>        端口（默认 3456；--port 0 自动探测真实空闲端口并打印）
  --browser            额外启动独立浏览器实例（browser-driver.mjs，raw CDP 零依赖）
  --keep               结束后保留临时 DSH_HOME（默认自动删除）
  --no-build           跳过挂载前 pnpm build（校验产物存在 + 陈旧警告）
  --evidence-dir <dir> 证据目录外部化（建 <dir>/evidence-<profile>/，绝不动外部目录）
  --audit              隔离审计：对比隔离 DSH_HOME 写面与预置白名单，白名单外变化报「可疑」，不阻断退出
  --audit-extra-dirs <dir>
                      额外审计目录（可重复；相对路径基于 cwd 绝对化；局限：不扫真实 home）
  --no-skip-onboarding 不预置首启弹窗跳过（默认预置 settings.yaml 的内测声明版本与命名空间，使其默认不弹；命名空间与版本均从 dsh 客户端产物现取）
  --probe-provider-usage
                      可选真实宿主验证（非离线 CI 门禁）：就绪后请求 provider-usage 的 stats/health，
                      无存储凭据时 skip 并输出「未验证（无凭据）」（退出 0）；有凭据且 ok:true 或
                      error 非 no-api-key 退出 0；有凭据但 no-api-key 退出 1 并给可操作诊断。
                      探针模式跑完即退出，不进入前台等待；不读取/复制用户 ~/.dsh 凭据。
  --json               stdout 只出最终 verdict JSON（人类文案走 stderr）
  --                   之后为要挂载的本地插件路径（相对路径基于 cwd 绝对化；npm 包名 / git URL 原样透传）
  --help               显示本帮助

环境要求：PATH 中存在 dsh 且 \`dsh --version\` 为 ${targetDshVersion}（找不到、读取失败或其它版本均拒绝）；Node >= 22（同 browser-driver）。
退出码：0 正常 / 1 启动或就绪失败（含 --probe-provider-usage 判失败）/ 2 参数错误 / 130 SIGINT / 143 SIGTERM。

访问 URL：dsh web 的 GUI 带鉴权，裸端口只得到 401 文本页。脚本启动后打印带令牌的
访问 URL，并把它写入 browser.state 的 dshWebUrl（0o600）——browser-driver 页面命令
用 \`--url state\` 取用即可；verdict 只记不含令牌的 web.url。`;
}

export class CliError extends Error {
  constructor(msg, code = EXIT.FAIL) {
    super(msg);
    this.code = code;
  }
}

function failUsage(msg) {
  throw new CliError(msg, EXIT.USAGE);
}

function parsePortNumber(raw) {
  if (!/^\d+$/.test(raw)) failUsage(`错误: --port 需要 0-65535 的十进制整数: ${raw}`);
  const port = Number(raw);
  if (port > 65535) failUsage(`错误: --port 需要 0-65535 的十进制整数: ${raw}`);
  return port;
}

const OPTION_SPEC = {
  port: { type: "string" },
  browser: { type: "boolean" },
  keep: { type: "boolean" },
  "no-build": { type: "boolean" },
  "evidence-dir": { type: "string" },
  audit: { type: "boolean" },
  "audit-extra-dirs": { type: "string", multiple: true },
  "no-skip-onboarding": { type: "boolean" },
  "probe-provider-usage": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean" },
};

function optionName(token) {
  const eq = token.indexOf("=");
  return token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
}

function optionType(token) {
  if (!token.startsWith("--")) return undefined;
  return OPTION_SPEC[optionName(token).slice(2)]?.type;
}

function applyJsonInline(out, token) {
  const value = token.slice("--json=".length);
  if (value !== "true" && value !== "false") {
    failUsage(`错误: --json 只接受 true/false: ${value}`);
  }
  if (value === "true") out.push("--json");
  else if (out[out.length - 1] === "--json") out.pop();
}

function normalizeBooleanArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return [...out, ...args.slice(i)];
    if (optionType(arg) !== "boolean" || arg === optionName(arg)) {
      out.push(arg);
      continue;
    }
    if (optionName(arg) === "--json") applyJsonInline(out, arg);
    else out.push(optionName(arg));
  }
  return out;
}

function optionTokenIndexes(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "-" || !arg.startsWith("-")) continue;
    out.push(i);
    if (optionType(arg) === "string" && arg === optionName(arg)) i++;
  }
  return out;
}

function rejectBadUsage(args) {
  const indexes = optionTokenIndexes(args);
  for (const i of indexes) {
    if (!optionType(args[i])) failUsage(`错误: 未知选项: ${args[i]}`);
  }
  for (const i of indexes) {
    if (optionType(args[i]) !== "string" || args[i] !== optionName(args[i])) continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      failUsage(`错误: ${optionName(args[i])} 需要一个参数`);
    }
  }
}

function parseArgsStrict(args) {
  try {
    return parseArgs({ args, options: OPTION_SPEC, allowPositionals: true, strict: true });
  } catch (error) {
    failUsage(`错误: 参数不合法（${error.code}）: ${error.message}`);
  }
}

export function detectJsonMode(argv) {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--json") return true;
    if (arg.startsWith("--json=")) return arg.slice("--json=".length) === "true";
  }
  return false;
}

export function parseCli(argv) {
  const args = normalizeBooleanArgs(argv);
  rejectBadUsage(args);
  const { values, positionals } = parseArgsStrict(args);
  const flags = {
    port: values.port === undefined ? DEFAULT_PORT : parsePortNumber(values.port),
    browser: values.browser === true,
    keep: values.keep === true,
    noBuild: values["no-build"] === true,
    evidenceDir: values["evidence-dir"] ?? null,
    audit: values.audit === true,
    auditExtraDirs: values["audit-extra-dirs"] ?? [],
    skipOnboarding: values["no-skip-onboarding"] !== true,
    probeProviderUsage: values["probe-provider-usage"] === true,
    json: values.json === true,
    help: values.help === true,
  };
  return { flags, pkgs: positionals };
}
