/**
 * dsh-notifier — 能力自检面的客户端投影（宿主面读侧归一化 + 浏览器面本地判定）。
 *
 * 为什么浏览器面在客户端算：`Notification.permission` 与音频上下文的解锁状态只存在于本页，
 * 服务端探的是宿主机器。两组事实源不同，混进一个接口就再也分不清「这句话说的是哪半边」。
 *
 * 为什么归一化必须宽容但绝不猜：值域外的结论一律降级为 `unknown`——猜成 `ok` 是把「没验过」
 * 说成「能用」，猜成 `unreachable` 是假警报，两者都会把用户支到错误的方向去排查。
 *
 * 为什么文案表写成**显式完整表** + `satisfies Record<…, NotifierLocaleKey>`：服务端加一个 code
 * 而这里漏配文案，必须在编译期就红，而不是等用户看到一行英文标识符（同 reason-text.ts 的范式）。
 * 类型只 `import type`（编译期擦除，浏览器包里没有服务端代码）。
 */
import type {
  CapabilityDimension,
  CheckedDimension,
  HostCapabilities,
  PackageManager,
  PopupCapability,
  RemediationCode,
  RemediationParams,
  SoundCapability,
  Verdict,
} from "../server/channels/impl/capabilities/type.ts";
import type { NotifierLocaleKey } from "./locales.ts";
import type { ReasonTranslator } from "./reason-text.ts";

/** 四态在界面上的着色档：JSX 只做 className 拼接，不再自己判 verdict。 */
export type DiagnosticTone = "ok" | "warn" | "error" | "unknown";

/** 折叠区的一行明细：标签与取值都在这里定好，界面逐行投影。 */
export interface DiagnosticDetailRow {
  label: string;
  value: string;
}

/**
 * 归一化后的处置建议。`code` 保持 `string` 而不是 `RemediationCode`：更新版本的服务端写下的陌生
 * code 也要能带到这里，由文案层给中性回退——把它挡在归一化外面，等于让整块结论跟着一起消失。
 */
export interface RemediationView {
  code: string;
  params?: RemediationParams;
}

/** 归一化后的宿主面：形状与契约一致，只有 `remediation[].code` 放宽（见上）。 */
export interface HostCapabilitiesView extends Omit<HostCapabilities, "remediation"> {
  remediation: readonly RemediationView[];
}

const VERDICT_KEYS = {
  ok: "diagVerdictOk",
  degraded: "diagVerdictDegraded",
  unreachable: "diagVerdictUnreachable",
  unknown: "diagVerdictUnknown",
} satisfies Record<Verdict, NotifierLocaleKey>;

const VERDICT_TONES = {
  ok: "ok",
  degraded: "warn",
  unreachable: "error",
  unknown: "unknown",
} satisfies Record<Verdict, DiagnosticTone>;

const DIMENSION_KEYS = {
  popup: "diagDimPopup",
  sound: "diagDimSound",
} satisfies Record<CapabilityDimension, NotifierLocaleKey>;

const CHECKED_KEYS = {
  "notify-send": "diagCheckedNotifySend",
  "dbus-name-owner": "diagCheckedDbusNameOwner",
  "dbus-activatable": "diagCheckedDbusActivatable",
  "session-bus": "diagCheckedSessionBus",
  players: "diagCheckedPlayers",
  "tone-file": "diagCheckedToneFile",
} satisfies Record<CheckedDimension, NotifierLocaleKey>;

const REMEDIATION_KEYS = {
  "host-no-dbus-session": "diagRemHostNoDbusSession",
  "host-popup-no-daemon": "diagRemHostPopupNoDaemon",
  "host-no-notify-send": "diagRemHostNoNotifySend",
  "host-no-sound-server-and-player": "diagRemHostNoSoundServerAndPlayer",
  "host-only-sound-server-players": "diagRemHostOnlySoundServerPlayers",
  "host-no-player": "diagRemHostNoPlayer",
  "host-no-tone-file": "diagRemHostNoToneFile",
  "host-managed-by-others": "diagRemHostManagedByOthers",
} satisfies Record<RemediationCode, NotifierLocaleKey>;

/**
 * 认不出发行版（没有包管理器族）时的第二条文案。插值不上的占位符会被原样渲染成花括号，
 * 所以「少给一个参数」必须换一句文案，而不是让同一句话缺一格。
 *
 * 两条装包建议共用同一份包清单，故两者都要有无包名变体。
 */
const NO_PACKAGE_KEYS: Readonly<Record<string, NotifierLocaleKey>> = {
  "host-no-sound-server-and-player": "diagRemHostNoSoundServerAndPlayerNoPkg",
  "host-only-sound-server-players": "diagRemHostOnlySoundServerPlayersNoPkg",
};

/**
 * 浏览器面 code 闭集（本地判定，服务端没有这一面）。不设 iOS 专用 code、不嗅探 UA：
 * 「通知 API 不存在」在哪个浏览器上都是同一件事，按型号编名字只会在下一个版本里烂掉。
 */
export type BrowserCode =
  | "browser-no-notification-api"
  | "browser-insecure-context"
  | "browser-permission-denied"
  | "browser-permission-default"
  | "browser-audio-never-unlocked"
  | "browser-audio-auto-suspended"
  | "browser-audio-closed"
  | "browser-audio-unsupported";

const BROWSER_KEYS = {
  "browser-no-notification-api": "diagBrowserNoNotificationApi",
  "browser-insecure-context": "diagBrowserInsecureContext",
  "browser-permission-denied": "diagBrowserPermissionDenied",
  "browser-permission-default": "diagBrowserPermissionDefault",
  "browser-audio-never-unlocked": "diagBrowserAudioNeverUnlocked",
  "browser-audio-auto-suspended": "diagBrowserAudioAutoSuspended",
  "browser-audio-closed": "diagBrowserAudioClosed",
  "browser-audio-unsupported": "diagBrowserAudioUnsupported",
} satisfies Record<BrowserCode, NotifierLocaleKey>;

const VERDICTS: readonly string[] = ["ok", "degraded", "unreachable", "unknown"];
const PACKAGE_MANAGERS: readonly string[] = ["apt", "dnf", "pacman"];
const DIMENSIONS: readonly string[] = ["popup", "sound"];

/**
 * 归一化 `/diagnostics` 响应里的宿主面。
 *
 * 缺字段 / 畸形载荷返回 `undefined`（调用方据此整块不渲染）：这里唯一的判据是三条结论
 * （`verdict` + 两个维度状态），缺一条就说不出一句真话，渲染半句比不渲染更坏；
 * 而 `capabilities` 整体缺席（旧服务端）与「值域外的取值」都是正常的读侧输入，前者同样返回
 * `undefined`，后者降级为 `unknown`。
 */
export function hostCapabilitiesOf(payload: unknown): HostCapabilitiesView | undefined {
  const body = objectOf(payload);
  const capabilities = body === undefined ? undefined : objectOf(body.capabilities);
  const host = capabilities === undefined ? undefined : objectOf(capabilities.host);
  if (host === undefined) return undefined;
  const verdict = requiredVerdictOf(host.verdict);
  const popup = popupOf(host.popup);
  const sound = soundOf(host.sound);
  if (verdict === undefined || popup === undefined || sound === undefined) return undefined;
  return {
    verdict,
    unknownDimensions: dimensionsOf(host.unknownDimensions),
    popup,
    sound,
    remediation: remediationOf(host.remediation),
  };
}

/** 音频上下文的四个状态。`suspended` 必须带成因：两种成因的下一步动作完全不同。 */
export type AudioState =
  | { kind: "running" }
  | { kind: "suspended"; cause: "never-unlocked" | "auto-suspended" }
  | { kind: "closed" }
  | { kind: "unsupported" };

/** 音频面的原始事实（只有页面读得到，判定留在这个模块里）。 */
export interface AudioFacts {
  /** `window.AudioContext` 是否存在——只有它不存在才是「Web Audio 不可用」。 */
  supported: boolean;
  /** 当前 state；`null` = 尚未构造（用户还没点过页面）。 */
  state: "running" | "suspended" | "closed" | null;
  /** 是否曾成功跑到 `running`（已解锁的唯一凭据）。 */
  hasEverRun: boolean;
  /** 最近一次 `resume()` 是否被 reject（浏览器明确拒绝，而不是「还没轮到」）。 */
  resumeRejected: boolean;
}

/**
 * 归一化音频事实。
 *
 * 为什么 `state === null` 归到「尚未解锁」而不是「不支持」：构造不出 AudioContext 是环境缺能力，
 * 而 `null` 只说明还没有人在这个页面上点过——说成不支持会把用户支去排查一个不存在的问题。
 * 为什么成因要看 `resumeRejected`：`suspended` 自身分不出「没解锁」与「解锁后被挂起」，
 * 只有真实的 resume 结果能区分，事后从 state 反推不出来。
 */
export function audioStateOf(facts: AudioFacts): AudioState {
  if (facts.supported !== true) return { kind: "unsupported" };
  if (facts.state === "running") return { kind: "running" };
  if (facts.state === "closed") return { kind: "closed" };
  return {
    kind: "suspended",
    cause:
      facts.hasEverRun === true || facts.resumeRejected === true
        ? "auto-suspended"
        : "never-unlocked",
  };
}

/** 浏览器面的原始事实。`permission` 用 `string` 而不是三态联合：读侧的值域永远比我们写的宽。 */
export interface ClientFacts {
  notificationApi: boolean;
  secureContext: boolean;
  /** `Notification.permission` 原值；读不到时给 `"unknown"`。 */
  permission: string;
  audio: AudioFacts;
}

export interface BrowserDimensionState {
  state: Verdict;
  code?: BrowserCode;
}

export interface BrowserGroupStates {
  verdict: Verdict;
  popup: BrowserDimensionState;
  sound: BrowserDimensionState;
  audio: AudioState;
}

/**
 * 严重度序，与 #784 §4.2 及服务端 `capabilities` 的 `SEVERITY` **逐项一致**：
 * `unreachable > unknown > degraded > ok`。
 *
 * 曾经按「已知的受损比没验过更该报」排成 `degraded > unknown`——那条论证本身成立，但同一个 `verdict`
 * 词表在两端给出不同次序，等于同一组维度状态在宿主行与浏览器行上得到不同结论。跨端一致性优先，故
 * 服从规格；两端各有一条钉住 `unknown > degraded` 的用例，任一侧改回去都会红。
 */
const SEVERITY = {
  ok: 0,
  degraded: 1,
  unknown: 2,
  unreachable: 3,
} satisfies Record<Verdict, number>;

/** 组级结论取各维度里最严重者。 */
export function worstVerdict(states: readonly Verdict[]): Verdict {
  let worst: Verdict = "ok";
  states.forEach(function (state) {
    if (SEVERITY[state] > SEVERITY[worst]) worst = state;
  });
  return worst;
}

/**
 * 浏览器面判定（本页事实，服务端算不出来）。
 *
 * 非安全上下文只降级 `popup`：本仓的局域网明文降级链恰恰靠 Web Audio 发声，把 `sound` 一起
 * 判成不可用，会让降级链在唯一还需要它的场景里自我否定。
 */
export function browserStatesOf(facts: ClientFacts): BrowserGroupStates {
  const popup = popupStateOf(facts);
  const sound = soundStateOf(facts);
  return {
    verdict: worstVerdict([popup.state, sound.state]),
    popup,
    sound,
    audio: audioStateOf(facts.audio),
  };
}

export interface HostDiagnosticsView {
  verdict: Verdict;
  tone: DiagnosticTone;
  /** 结论行：verdict + 两个维度状态。 */
  line: string;
  /** `unknownDimensions` 非空时说清哪个维度无法判定；否则空串。 */
  unknownLine: string;
  remediationTitle: string;
  /** 处置建议逐条；认不出的 code 已回退为中性文案。 */
  remediationLines: readonly string[];
  detailsLabel: string;
  sourceLabel: string;
  details: readonly DiagnosticDetailRow[];
}

export interface BrowserDiagnosticsView {
  verdict: Verdict;
  tone: DiagnosticTone;
  /** 浏览器面的一行结论。 */
  line: string;
  sourceLabel: string;
}

export interface ClientDiagnosticsView {
  /** 宿主面；旧服务端或读不出形态时为 `undefined`（调用方据此不渲染这一块）。 */
  host?: HostDiagnosticsView;
  browser: BrowserDiagnosticsView;
}

/** 界面消费的唯一入口：宿主面与浏览器面各自成一组字符串，JSX 里不再留任何业务判断。 */
export function clientDiagnosticsOf(
  payload: unknown,
  facts: ClientFacts,
  t: ReasonTranslator,
): ClientDiagnosticsView {
  return { host: hostDiagnosticsOf(payload, t), browser: browserDiagnosticsOf(facts, t) };
}

/** 一条处置建议的文案。认不出的 code 给中性回退，且不回显 params 原文。 */
export function remediationTextOf(remediation: RemediationView, t: ReasonTranslator): string {
  const key = knownRemediationKeyOf(remediation.code);
  // 认不出的 code（更新版本的服务端写下的）不给文案：params 是宿主侧数据表的取值，把一句认不出的
  // 东西连同它的参数端给用户，等于用假的具体掩盖真的一无所知。
  if (key === undefined) return t("diagRemediationUnknown");
  const params = paramTextsOf(remediation.params);
  const sparse = params.packages === undefined ? NO_PACKAGE_KEYS[remediation.code] : undefined;
  return t(sparse ?? key, params);
}

function hostDiagnosticsOf(payload: unknown, t: ReasonTranslator): HostDiagnosticsView | undefined {
  const host = hostCapabilitiesOf(payload);
  if (host === undefined) return undefined;
  const unknown = host.unknownDimensions.map(function (dimension) {
    return t(DIMENSION_KEYS[dimension]);
  });
  return {
    verdict: host.verdict,
    tone: VERDICT_TONES[host.verdict],
    line: t("diagHostLine", {
      verdict: t(VERDICT_KEYS[host.verdict]),
      popup: t(VERDICT_KEYS[host.popup.state]),
      sound: t(VERDICT_KEYS[host.sound.state]),
    }),
    unknownLine:
      unknown.length === 0 ? "" : t("diagUnknownLine", { dimensions: unknown.join(" · ") }),
    remediationTitle: t("diagRemediationTitle"),
    remediationLines: host.remediation.map(function (item) {
      return remediationTextOf(item, t);
    }),
    detailsLabel: t("diagDetailsLabel"),
    sourceLabel: t("diagSourceHost"),
    details: detailRowsOf(host, t),
  };
}

function browserDiagnosticsOf(facts: ClientFacts, t: ReasonTranslator): BrowserDiagnosticsView {
  const states = browserStatesOf(facts);
  return {
    verdict: states.verdict,
    tone: VERDICT_TONES[states.verdict],
    line: t("diagBrowserLine", {
      popup: dimensionTextOf(states.popup, t),
      sound: dimensionTextOf(states.sound, t),
    }),
    sourceLabel: t("diagSourceBrowser"),
  };
}

function popupStateOf(facts: ClientFacts): BrowserDimensionState {
  if (facts.notificationApi !== true) {
    return { state: "unreachable", code: "browser-no-notification-api" };
  }
  if (facts.secureContext !== true) {
    return { state: "degraded", code: "browser-insecure-context" };
  }
  if (facts.permission === "granted") return { state: "ok" };
  if (facts.permission === "denied") {
    return { state: "unreachable", code: "browser-permission-denied" };
  }
  if (facts.permission === "default") {
    return { state: "unknown", code: "browser-permission-default" };
  }
  // 权限值读不出来（老浏览器 / 被策略挡住）：结论是「无法判定」，不给它安一个成因。
  return { state: "unknown" };
}

function soundStateOf(facts: ClientFacts): BrowserDimensionState {
  const audio = audioStateOf(facts.audio);
  if (audio.kind === "running") return { state: "ok" };
  if (audio.kind === "closed") return { state: "unreachable", code: "browser-audio-closed" };
  if (audio.kind === "unsupported") {
    return { state: "unreachable", code: "browser-audio-unsupported" };
  }
  return audio.cause === "never-unlocked"
    ? { state: "unknown", code: "browser-audio-never-unlocked" }
    : { state: "degraded", code: "browser-audio-auto-suspended" };
}

function dimensionTextOf(state: BrowserDimensionState, t: ReasonTranslator): string {
  const verdict = t(VERDICT_KEYS[state.state]);
  return state.code === undefined ? verdict : verdict + "（" + t(BROWSER_KEYS[state.code]) + "）";
}

function detailRowsOf(
  host: HostCapabilitiesView,
  t: ReasonTranslator,
): readonly DiagnosticDetailRow[] {
  return [
    {
      label: t("diagDimPopup") + " · " + t("diagCheckedLabel"),
      value: checkedTextOf(host.popup.checked, t),
    },
    {
      label: t("diagDimSound") + " · " + t("diagCheckedLabel"),
      value: checkedTextOf(host.sound.checked, t),
    },
    { label: t("diagPlayersLabel"), value: listText(host.sound.players, t) },
    {
      label: t("diagToneFileLabel"),
      value: host.sound.toneFileAvailable ? t("diagToneFileYes") : t("diagToneFileNo"),
    },
  ];
}

function checkedTextOf(checked: readonly CheckedDimension[], t: ReasonTranslator): string {
  return listText(
    checked.map(function (item) {
      return t(CHECKED_KEYS[item]);
    }),
    t,
  );
}

/** 取值本身是宿主的可执行文件名（数据不翻译），只有分隔符与「无」走文案。 */
function listText(items: readonly string[], t: ReasonTranslator): string {
  return items.length === 0 ? t("diagNone") : items.join(" · ");
}

/** 只交出两个已知占位符：多出来的键插不进任何文案，带下去只会变成一行花括号。 */
function paramTextsOf(params: RemediationParams | undefined): Readonly<Record<string, string>> {
  if (params === undefined) return {};
  const out: Record<string, string> = {};
  if (params.packagemanager !== undefined) out.packagemanager = params.packagemanager;
  if (params.packages !== undefined) out.packages = params.packages.join(" ");
  return out;
}

function popupOf(value: unknown): PopupCapability | undefined {
  const source = objectOf(value);
  if (source === undefined) return undefined;
  const state = requiredVerdictOf(source.state);
  if (state === undefined) return undefined;
  return { state, checked: checkedOf(source.checked) };
}

function soundOf(value: unknown): SoundCapability | undefined {
  const source = objectOf(value);
  if (source === undefined) return undefined;
  const state = requiredVerdictOf(source.state);
  if (state === undefined) return undefined;
  return {
    state,
    players: stringsOf(source.players),
    toneFileAvailable: source.toneFileAvailable === true,
    checked: checkedOf(source.checked),
  };
}

function remediationOf(value: unknown): readonly RemediationView[] {
  if (!Array.isArray(value)) return [];
  const out: RemediationView[] = [];
  value.forEach(function (item) {
    const source = objectOf(item);
    if (source === undefined) return;
    if (typeof source.code !== "string" || source.code === "") return;
    const params = paramsOf(source.params);
    out.push(params === undefined ? { code: source.code } : { code: source.code, params });
  });
  return out;
}

function paramsOf(value: unknown): RemediationParams | undefined {
  const source = objectOf(value);
  if (source === undefined) return undefined;
  const out: { packagemanager?: PackageManager; packages?: readonly string[] } = {};
  if (
    typeof source.packagemanager === "string" &&
    PACKAGE_MANAGERS.includes(source.packagemanager)
  ) {
    out.packagemanager = source.packagemanager as PackageManager;
  }
  const packages = stringsOf(source.packages);
  if (packages.length > 0) out.packages = packages;
  return out.packagemanager === undefined && out.packages === undefined ? undefined : out;
}

function checkedOf(value: unknown): readonly CheckedDimension[] {
  if (!Array.isArray(value)) return [];
  return value.filter(function (item): item is CheckedDimension {
    return typeof item === "string" && Object.prototype.hasOwnProperty.call(CHECKED_KEYS, item);
  });
}

function dimensionsOf(value: unknown): readonly CapabilityDimension[] {
  if (!Array.isArray(value)) return [];
  return value.filter(function (item): item is CapabilityDimension {
    return typeof item === "string" && DIMENSIONS.includes(item);
  });
}

function stringsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(function (item): item is string {
    return typeof item === "string" && item !== "";
  });
}

function verdictOf(value: unknown): Verdict {
  return typeof value === "string" && VERDICTS.includes(value) ? (value as Verdict) : "unknown";
}

/** 必填的结论字段：缺席或不是字符串就是畸形载荷（与「取值不认识」是两回事，后者降级为 `unknown`）。 */
function requiredVerdictOf(value: unknown): Verdict | undefined {
  return typeof value === "string" && value !== "" ? verdictOf(value) : undefined;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 认不出的 code 走中性回退：字典里有没有它，是编译期穷尽约束 + 运行期查表两件事，缺一不可。 */
function knownRemediationKeyOf(code: string): NotifierLocaleKey | undefined {
  return Object.prototype.hasOwnProperty.call(REMEDIATION_KEYS, code)
    ? REMEDIATION_KEYS[code as RemediationCode]
    : undefined;
}
