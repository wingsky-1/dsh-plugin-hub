/**
 * onboarding.mjs — 隔离环境 dsh web 首启弹窗的默认跳过支持（纯函数 + 只读探测）。
 *
 * 两个阻断弹窗的成因（实测 dsh 0.1.5-rc.1，复现与对照见 SKILL.md
 * 「首启弹窗默认跳过」）：
 *   - 「内测声明」是否出现，取决于 settings.yaml 的
 *     `ui-onboarding.welcomeNoticeVersion` 与客户端常量 WELCOME_NOTICE_VERSION
 *     是否**精确相等**：预置该值即默认不弹。常量随 dsh 版本漂移（它按版本重新
 *     告知），只能从 dsh 产物现取——硬编码会让跳过在 dsh 升级后静默失效。
 *   - 「添加 API Key」由 provider 可用性决定，其「稍后配置」只在当前页面生命周期
 *     内有效（刷新/新标签必重弹），预置消除不掉，只能导航后兜底点击。
 * 两者都把应用根置为 inert（`#root.inert = true`），页面上一切点击静默失效——这
 * 正是必须默认跳过、而不能只在文档里提醒「记得点掉」的原因。
 *
 * 本模块只做探测与表达式构造，不启动进程、不写隔离环境（预置由
 * verify-isolated.mjs 落盘），以便 smoke 直接以纯函数 + fixture 断言。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

/** 跳过语义的按钮文案（客户端 welcomeContinue / onboardingLater 的 en + zh）。 */
export const SKIP_BUTTON_TEXTS = Object.freeze(["Continue", "Configure later", "继续", "稍后配置"]);

/** 客户端产物里的须知版本常量；版本一变就会重新弹窗，故按 dsh 安装现取。 */
export const WELCOME_NOTICE_VERSION_RE = /WELCOME_NOTICE_VERSION\s*=\s*"([^"]+)"/;

/** 设置文档命名空间与字段（与客户端 onboarding-copy 常量对齐）。 */
export const WELCOME_SETTINGS_NAMESPACE = "ui-onboarding";
export const WELCOME_SETTINGS_FIELD = "welcomeNoticeVersion";

/** 缺访问令牌时 GUI 的鉴权拒绝文案（页面命令据此给出可操作诊断而非空页假绿）。 */
export const AUTH_REQUIRED_MARKER = "dsh web authentication required";

/** 弹窗内可安全点击的跳过按钮上限轮数（实测最多两级：内测声明 → API Key）。 */
export const MAX_OVERLAY_ROUNDS = 3;

/**
 * 从客户端产物源码提取须知版本。
 * @param source - dsh-client-ui-settings-models 的 client.js 源码。
 * @returns 版本字符串；未匹配（dsh 改了常量形态）返回 null，由调用方降级。
 */
export function extractWelcomeNoticeVersion(source) {
  const m = WELCOME_NOTICE_VERSION_RE.exec(String(source ?? ""));
  return m ? m[1] : null;
}

/**
 * 构造预置的 settings.yaml 文档。
 * @param version - 已确认的须知版本（原样落盘，加引号会改变解析结果，故不加）。
 * @returns 设置文档文本。
 */
export function welcomeSettingsDocument(version) {
  // 值来自 dsh 产物的字符串字面量，仍按白名单校验：settings.yaml 是要被 dsh 解析的
  // 结构化文档，任何意外字符都可能改写命名空间结构而不是一个字段值。
  if (!/^[A-Za-z0-9._-]+$/.test(String(version))) {
    throw new Error(`内测声明版本含意外字符，拒绝写入 settings.yaml: ${version}`);
  }
  return `${WELCOME_SETTINGS_NAMESPACE}:\n  ${WELCOME_SETTINGS_FIELD}: ${version}\n`;
}

/**
 * 解析 dsh 安装根：从入口 realpath 逐级向上找 name 匹配的 manifest。
 * @param dshBinPath - dsh 可执行入口（可能是 bin 软链）。
 * @returns 安装根绝对路径；解析不出返回 null（不猜 node_modules 布局）。
 */
export function dshRootOf(dshBinPath) {
  let entry;
  try { entry = realpathSync(dshBinPath); } catch { return null; }
  let dir = dirname(entry);
  for (let i = 0; i < 8; i++) {
    try {
      if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@deepseek-ai/dsh") return dir;
    } catch { /* 无 manifest / 非 JSON：继续向上 */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 定位客户端产物：交给 Node 的解析算法从 dsh 安装根解析依赖，npm 提升布局与
 * pnpm 软链布局都自洽（路径拼接会在其中一种布局下指向不存在的目录）。
 * @param dshRoot - dsh 安装根。
 * @returns client.js 绝对路径；解析失败返回 null。
 */
export function welcomeClientFileOf(dshRoot) {
  try {
    const req = createRequire(join(dshRoot, "package.json"));
    const manifest = req.resolve("@deepseek-ai/dsh-client-ui-settings-models/package.json");
    return join(dirname(manifest), "lib", "client.js");
  } catch {
    return null;
  }
}

/**
 * 端到端解析须知版本（dsh 入口 → 安装根 → 客户端产物 → 常量）。
 * @param dshBinPath - dsh 可执行入口。
 * @returns `{ version, file }`；任一步失败返回 null。
 */
export function findWelcomeNoticeVersion(dshBinPath) {
  const root = dshRootOf(dshBinPath);
  if (!root) return null;
  const file = welcomeClientFileOf(root);
  if (!file || !existsSync(file)) return null;
  const version = extractWelcomeNoticeVersion(readFileSync(file, "utf8"));
  return version ? { version, file } : null;
}

/**
 * 构造导航后的一次性探针表达式：同时给出鉴权误用诊断与弹窗状态。检测与点击放在
 * 同一次往返里，避免弹窗在两次 CDP 调用之间被卸载/替换（那时点击会落空）。
 *
 * 识别不到跳过按钮时**不猜**：弹窗内可能并列「保存并继续」这类有副作用的按钮，
 * 结构兜底（点第一个/最后一个）会把验证流程变成一次误操作，故只上报待人工处置。
 * @param options - `click:false` 时只探测不点击（--no-auto-dismiss 的「保留原状」
 *   必须真的不点：探针若照样点下去，关闭开关就成了只改输出文案的假开关）。
 * @returns 在页面上下文执行的 JS 表达式。
 */
export function buildOverlayProbeExpression(options = {}) {
  const allowClick = options.click !== false;
  return `(() => {
  const allowClick = ${allowClick ? "true" : "false"};
  const skipTexts = ${JSON.stringify(SKIP_BUTTON_TEXTS)};
  const authRequired = document.body ? document.body.innerText.includes(${JSON.stringify(AUTH_REQUIRED_MARKER)}) : false;
  const root = document.getElementById("root");
  const dialog = document.querySelector("[role=dialog]");
  if (!root || root.inert !== true || !dialog) return { authRequired, blocked: false };
  const label = (b) => (b.textContent || "").trim();
  const buttons = [...dialog.querySelectorAll("button")].filter((b) => !b.disabled);
  const target = buttons.find((b) => skipTexts.includes(label(b)));
  if (!target) return { authRequired, blocked: true, dismissed: false, reason: "no-skip-button", buttons: buttons.map(label) };
  if (!allowClick) return { authRequired, blocked: true, dismissed: false, reason: "auto-dismiss-off", buttons: buttons.map(label) };
  target.click();
  return { authRequired, blocked: true, dismissed: true, clicked: label(target) };
})()`;
}

/**
 * 输出脱敏：dsh web 的访问令牌是 GUI 鉴权凭据，命令回显的 URL 会随证据一起归档，
 * 故回显恒去令牌（真值只在 0o600 的 browser.state / dsh.log 里）。
 * @param url - 待回显的 URL。
 * @returns 令牌替换为 `***` 的 URL；非字符串原样返回。
 */
export function redactToken(url) {
  return typeof url === "string" ? url.replace(/([?&]token=)[^&#]*/gi, "$1***") : url;
}
