/**
 * dsh-notifier channels 域 —— 宿主能力自检面的组装。
 *
 * 它只做投影：把已探到的进程事实翻成「哪半边能用、下一步该干什么」，不新增任何探测副作用
 * （只允许向 `org.freedesktop.DBus` 问 owner 与可激活清单，见 `../system/deps.ts`）。
 */
import { FOLLOW_SYSTEM_TONE } from "../../../../shared/interface.ts";
import { toastScriptPath } from "../../../shared/interface.ts";
import { platformCapabilities, systemDeps } from "../system/deps.ts";
import { probePlatform } from "../system/index.ts";
import { toneFileCandidates } from "../system/tones.ts";
import type { NotificationNameProbe, OsReleaseProbe, PlatformProbe } from "../system/type.ts";
import { ALLOWED_CHECKED, PACKAGE_FAMILIES, PLAYER_PACKAGES, POSIX_CHECKS } from "./table.ts";
import type { DimensionChecks } from "./table.ts";
import type {
  CapabilityDimension,
  CheckedDimension,
  HostCapabilities,
  PopupCapability,
  Remediation,
  SoundCapability,
  Verdict,
} from "./type.ts";

/** 参与探测的音色：`sound: true` 走的就是它，故能力面报的就是用户默认配置下的可得性。 */
const TONE_FOR_PROBE = FOLLOW_SYSTEM_TONE;

/** 严重度序：`unreachable > unknown > degraded > ok`。`unknown` 不得降级为 `ok`，也不得升格为 `unreachable`。 */
const SEVERITY: Readonly<Record<Verdict, number>> = {
  ok: 0,
  degraded: 1,
  unknown: 2,
  unreachable: 3,
};

/** 本平台的合法 `checked` 子集。认不出的平台退到 POSIX 一档，不借别的平台的词。 */
export function checksFor(platform: string): DimensionChecks {
  return ALLOWED_CHECKED[platform] ?? POSIX_CHECKS;
}

/** 实际产出是否落在「平台 × 维度」允许集内。门禁与测试用它判红，实现自己不调用。 */
export function checkedWithin(
  platform: string,
  dimension: CapabilityDimension,
  dims: readonly CheckedDimension[],
): boolean {
  const allowed = checksFor(platform)[dimension];
  return dims.every((dim) => allowed.includes(dim));
}

/** 宿主能力面（一次探测，由调用方负责缓存）。 */
export async function probeHostCapabilities(): Promise<HostCapabilities> {
  const deps = systemDeps();
  const probe = await platformCapabilities.get(toastScriptPath(), probePlatform);
  // darwin/win32 不走 notify-send，也就不问 D-Bus：那台机器上多半没有会话总线，问了只会白起一个
  // 必然失败的子进程，还得等它超时。
  const name: NotificationNameProbe = isSystemToolPlatform(probe.platform)
    ? { kind: "absent" }
    : await deps.probeNotificationName();
  const candidates = toneFileCandidates(probe.platform, TONE_FOR_PROBE);
  const toneFileAvailable = candidates.some((path) => deps.existsSync(path));
  const popup = popupCapability(probe, name);
  const sound = soundCapability(probe, {
    toneFileAvailable,
    toneFileProbed: candidates.length > 0,
  });
  return {
    verdict: groupVerdict([popup.state, sound.state]),
    unknownDimensions: dimensionsIn(
      [
        ["popup", popup.state],
        ["sound", sound.state],
      ],
      "unknown",
    ),
    popup,
    sound,
    remediation: remediationOf({
      probe,
      name,
      popup,
      sound,
      osRelease: deps.readOsRelease(),
    }),
  };
}

/** 组级结论取各维度最严重者：让客户端为两套词表写映射，等于给「未知」留一次被渲染成「可用」的机会。 */
function groupVerdict(states: readonly Verdict[]): Verdict {
  return states.reduce<Verdict>(
    (worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst),
    "ok",
  );
}

function dimensionsIn(
  entries: readonly (readonly [CapabilityDimension, Verdict])[],
  wanted: Verdict,
): readonly CapabilityDimension[] {
  return entries.filter(([, state]) => state === wanted).map(([dimension]) => dimension);
}

/**
 * darwin 走系统自带 `osascript`、win32 走 PowerShell + **随包**的 toast 脚本：前者没有需要探测的
 * 依赖，后者只有一个「脚本在不在位」的事实。`checked` 一律留空，因为闭集里还没有 win32 的维度名
 * （见 `type.ts` 的说明）——空数组正是「这一格没有用闭集里的维度验过」的如实暴露。
 */
function popupCapability(probe: PlatformProbe, name: NotificationNameProbe): PopupCapability {
  if (probe.platform === "darwin") return { state: "ok", checked: [] };
  if (probe.platform === "win32") {
    // 脚本缺失是**打包缺陷**而不是宿主能力问题（同 #782 的 reasonSystemToastScriptMissing 口径）：
    // 报 ok 会让窗口期里的用户按「宿主没问题」去查，方向完全反了。
    return { state: probe.toastScriptAvailable ? "ok" : "unreachable", checked: [] };
  }
  return { state: popupStateOf(probe, name), checked: popupChecked(probe.platform, name) };
}

function isSystemToolPlatform(platform: string): boolean {
  return platform === "darwin" || platform === "win32";
}

function popupStateOf(probe: PlatformProbe, name: NotificationNameProbe): Verdict {
  if (name.kind === "no-session-bus") return "unreachable";
  if (name.kind === "probe-failed") return "unknown";
  if (!probe.notifySendAvailable) return "unreachable";
  if (name.kind === "owner") return "ok";
  return name.kind === "activatable" ? "unknown" : "unreachable";
}

/** 只列真问过的维度：`activatable` 那一问只在无 owner 时才发生。 */
function popupChecked(platform: string, name: NotificationNameProbe): readonly CheckedDimension[] {
  if (name.kind === "no-session-bus") return allowed(platform, "popup", ["session-bus"]);
  const queried: CheckedDimension[] = ["notify-send", "dbus-name-owner", "session-bus"];
  if (name.kind === "activatable" || name.kind === "absent") queried.push("dbus-activatable");
  return allowed(platform, "popup", queried);
}

/**
 * 把「问过的维度」收进本格的允许集。
 *
 * 如实说明：生产路径上它**不过滤掉任何东西**——各分支派生出的集合本就是允许集的子集，所以把它整段
 * 删掉也不会有一条用例变红（实测过）。保留它是兜底而不是判据：真正的保证在测试侧的**精确取值**断言
 * （多一个词就红）与「产出 ⊆ 允许集」断言，本函数只保证实现自己不越界。
 */
function allowed(
  platform: string,
  dimension: CapabilityDimension,
  dims: readonly CheckedDimension[],
): readonly CheckedDimension[] {
  const permitted = checksFor(platform)[dimension];
  return dims.filter((dim) => permitted.includes(dim));
}

interface ToneFacts {
  toneFileAvailable: boolean;
  /** 是否真的问过文件系统：候选为空（未知平台没有基目录）时不算问过。 */
  toneFileProbed: boolean;
}

/** 声音维度。linux 只看播放器；darwin/win32 走系统播放路径，故只看音色文件。 */
function soundCapability(probe: PlatformProbe, tone: ToneFacts): SoundCapability {
  const checked = allowed(probe.platform, "sound", [
    ...(probe.platform === "linux" ? (["players"] as const) : []),
    ...(tone.toneFileProbed ? (["tone-file"] as const) : []),
  ]);
  const base = { players: probe.players, toneFileAvailable: tone.toneFileAvailable, checked };
  if (probe.platform === "linux" && probe.players.length === 0)
    return { state: "unreachable", ...base };
  if (probe.platform === "linux" || isSystemToolPlatform(probe.platform)) {
    return { state: tone.toneFileAvailable ? "ok" : "degraded", ...base };
  }
  // 认不出的平台（freebsd 等）上 `probePlatform` 压根不探播放器，`players` 空是「没查」而不是「没有」：
  // 报 unreachable 是拿一次没做过的探测当结论，报 unknown 才是实情。
  return { state: "unknown", ...base };
}

/**
 * 探测没能给出结论时的诚实回答：两个维度都「无法判定」，也不给任何处置建议。
 * 单独成函数而不是就地写字面量，是为了让「无法判定」在所有调用方眼里都是同一份形状。
 */
export function undeterminedCapabilities(): HostCapabilities {
  return {
    verdict: "unknown",
    unknownDimensions: ["popup", "sound"],
    popup: { state: "unknown", checked: [] },
    sound: { state: "unknown", players: [], toneFileAvailable: false, checked: [] },
    remediation: [],
  };
}

interface RemediationInput {
  probe: PlatformProbe;
  name: NotificationNameProbe;
  popup: PopupCapability;
  sound: SoundCapability;
  osRelease: OsReleaseProbe;
}

/**
 * 诊断出路。**不生产 `host-no-player`**：它要求「有声音服务但缺播放器」这个前提，而「有没有声音服务」
 * 要等批 3 的「运行期失败自证」才拿得到；在此之前生产它只能靠猜。闭集保留该 code，客户端映射齐备即可。
 */
function remediationOf(input: RemediationInput): readonly Remediation[] {
  const out: Remediation[] = [];
  if (input.popup.state === "unreachable") {
    if (input.name.kind === "no-session-bus") out.push({ code: "host-no-dbus-session" });
    else if (input.name.kind === "absent" && input.probe.notifySendAvailable) {
      out.push({ code: "host-popup-no-daemon" });
    }
  }
  if (input.sound.state === "unreachable" && input.probe.platform === "linux") {
    out.push(packageRemedy(input.osRelease));
  }
  if (input.sound.state === "degraded") out.push({ code: "host-no-tone-file" });
  // 弹窗与发声都不可达时，「装什么包」之外的出路是换通道——这一格才是「不归你管」的真实场景
  if (input.popup.state === "unreachable" && input.sound.state === "unreachable") {
    out.push({ code: "host-managed-by-others" });
  }
  return out;
}

/** 无播放器的装包建议。认不出包管理器族就不给包名：宁可少说一句，不给错的包名。 */
function packageRemedy(osRelease: OsReleaseProbe): Remediation {
  const family = osRelease.ok ? PACKAGE_FAMILIES[osRelease.id.toLowerCase()] : undefined;
  if (family === undefined) return { code: "host-no-sound-server-and-player" };
  return {
    code: "host-no-sound-server-and-player",
    params: { packagemanager: family, packages: PLAYER_PACKAGES[family] },
  };
}
