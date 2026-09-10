/**
 * emulation.mjs — browser-driver 设备模拟参数的解析与 CDP 参数构造（纯函数，零依赖）。
 *
 * 抽成独立模块而非内联进 browser-driver.mjs：后者在 import 时即执行 main()，
 * smoke 无法 import 其内部函数做行为断言（与 lib/verify-core.mjs 同一理由）。
 *
 * 契约形态由 CDP 会话语义实测决定（0.1.5-rc.1 + chromium headless shell）：
 * - Emulation 域状态按 CDP session 归属：`setDeviceMetricsOverride` 的渲染效果在
 *   session 断开后仍作用于 target，但 `clearDeviceMetricsOverride` 只能清掉「发它的
 *   那个 session」所设的 override。故 set/clear 必须成对走同一条长连接——否则清除
 *   静默失效，尺寸残留污染后续命令（实测：新 session 里 clear 后仍读回设定值）。
 * - `touch` / `UserAgent` override 是纯 session 级的，断开即失效，无法跨命令生效；
 *   模拟能力也不完整（maxTouchPoints 可设，但 ontouchstart 不生效）。故不提供，
 *   触控与真机差异写入 SKILL.md 能力边界，避免给出虚假安全感。
 *
 * 因此设备模拟不做成「独立粘性命令」，而是每条页面命令都可携带的公共 flag：
 * 命令内应用、命令结束前清除，命令之间互不影响。
 */

/** 视口尺寸上限：远超任何真实设备，取一个能挡住手误输入（如多敲几个 0）的上界。 */
const MAX_VIEWPORT = 10000;
/** DPR 上限：8 已是真实设备上界（部分安卓旗舰），再大只会是误输入。 */
const MAX_DPR = 8;

function parseViewport(raw, name) {
  const invalid = () => new Error(`错误: --${name} 需要 1-${MAX_VIEWPORT} 的十进制整数: ${raw}`);
  if (!/^\d+$/.test(raw)) throw invalid();
  const n = Number(raw);
  if (n < 1 || n > MAX_VIEWPORT) throw invalid();
  return n;
}

function parseDpr(raw) {
  // 文案与判据必须一致：下限是「大于 0」，写成「0-8」会让 0 被拒看起来像 bug
  const invalid = () => new Error(`错误: --dpr 需要大于 0 且不超过 ${MAX_DPR} 的数（可带小数）: ${raw}`);
  if (!/^\d+(\.\d+)?$/.test(raw)) throw invalid();
  const n = Number(raw);
  if (!(n > 0) || n > MAX_DPR) throw invalid();
  return n;
}

/**
 * 解析布尔 flag：省略值（parseArgs 存 "true"）/ `true` / `1` → true，`false` / `0` → false。
 *
 * 不采用「出现即启用」：那会让 `--mobile=false` 得到与字面相反的结果，也与 --dpr 的
 * 取值风格不一致。其余取值一律报错，不做猜测。
 */
function parseBoolFlag(raw, name) {
  if (raw === undefined) return false;
  if (raw === "true" || raw === "1" || raw === "") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`错误: --${name} 只接受 true/false（省略值表示启用）: ${raw}`);
}

/**
 * 解析设备模拟 flag。
 *
 * `get` 为取参函数（browser-driver 传 `(name) => flags.get(name)`）：未给出的返回
 * undefined。任一设备 flag 出现即视为启用模拟；未给出的视口维度留 undefined，
 * 由 buildDeviceMetrics 用页面当前视口补齐。
 *
 * @param {(name: string) => string | undefined} get - 取参函数。
 * @returns {{ active: false } | { active: true, width?: number, height?: number, deviceScaleFactor: number, mobile: boolean }}
 * @throws {Error} 参数非法（由 CLI 统一转错误 JSON + 非零退出）。
 */
export function parseEmulationFlags(get) {
  const widthRaw = get("width");
  const heightRaw = get("height");
  const dprRaw = get("dpr");
  const mobile = parseBoolFlag(get("mobile"), "mobile");
  if (widthRaw === undefined && heightRaw === undefined && dprRaw === undefined && !mobile) {
    return { active: false };
  }
  return {
    active: true,
    width: widthRaw === undefined ? undefined : parseViewport(widthRaw, "width"),
    height: heightRaw === undefined ? undefined : parseViewport(heightRaw, "height"),
    deviceScaleFactor: dprRaw === undefined ? 1 : parseDpr(dprRaw),
    mobile,
  };
}

/**
 * 构造 `Emulation.setDeviceMetricsOverride` 参数（未指定的维度用当前视口补齐）。
 *
 * 注意 `mobile: true` 会启用移动 layout viewport 语义：页面无 viewport meta 时
 * `innerWidth` 不再等于设定宽度（实测 375 → 981）。要精确命中 CSS 断点应保持
 * mobile 关闭，此语义在 SKILL.md 中标为能力边界。
 *
 * @param {{ width?: number, height?: number, deviceScaleFactor: number, mobile: boolean }} parsed - parseEmulationFlags 结果。
 * @param {{ width: number, height: number }} current - 页面当前 innerWidth / innerHeight。
 * @returns {{ width: number, height: number, deviceScaleFactor: number, mobile: boolean }}
 */
export function buildDeviceMetrics(parsed, current) {
  return {
    width: parsed.width ?? current.width,
    height: parsed.height ?? current.height,
    deviceScaleFactor: parsed.deviceScaleFactor,
    mobile: parsed.mobile,
  };
}
