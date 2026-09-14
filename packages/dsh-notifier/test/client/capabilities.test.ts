/**
 * dsh-notifier — 能力自检面的客户端投影（#784）。
 *
 * 为什么这些判据只能在这里守：宿主面是服务端探的，浏览器面是本页算的，两边的结论要同时出现在
 * 一张卡片上。任何一侧自己的单测都测不到「未知被渲染成可用」这类跨端事故——本文件把契约的值域
 * 与客户端渲染直接对起来。
 *
 * 同样照 reason-text.test.ts 的范式：断言对象是**可发布的形态**（in-place esbuild 打包后再执行），
 * 顺带把「`import type` 真的被擦除、浏览器包里没有服务端代码」变成可判红的判据。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { describe, expect, it } from "vitest";
import { assertClientSourceContract } from "../../../../test/smoke-lib.ts";

import type { NotifierLocaleKey } from "../../src/client/locales.ts";
import { en, zh } from "../../src/client/locales.ts";
import type { AudioFacts, ClientFacts } from "../../src/client/capabilities.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

const bundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/capabilities.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});
const {
  audioStateOf,
  browserStatesOf,
  clientDiagnosticsOf,
  hostCapabilitiesOf,
  remediationTextOf,
  worstVerdict,
} = (await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
)) as typeof import("../../src/client/capabilities.ts");

/** 官方向翻译函数的最薄替身：`{name}` 插值 zh 字典。 */
function t(key: NotifierLocaleKey, params?: Readonly<Record<string, string | number>>): string {
  return zh[key].replace(/\{(\w+)\}/gu, (match, name: string) =>
    params !== undefined && Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : match,
  );
}

const OK_POPUP = { state: "ok", checked: ["notify-send", "session-bus"] };
const OK_SOUND = {
  state: "ok",
  players: ["paplay"],
  toneFileAvailable: true,
  checked: ["players"],
};

/** 一份宿主面载荷；host 的字段按需覆盖（默认是一份全绿的自检）。 */
function payloadOf(host: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    plugin: "dsh-notifier",
    platform: "linux",
    capabilities: {
      host: {
        verdict: "ok",
        unknownDimensions: [],
        popup: OK_POPUP,
        sound: OK_SOUND,
        remediation: [],
        ...host,
      },
    },
  };
}

const RUNNING_AUDIO: AudioFacts = {
  supported: true,
  state: "running",
  hasEverRun: true,
  resumeRejected: false,
};

/** 一份「本页一切正常」的客户端事实；按需覆盖。 */
function factsOf(overrides: Partial<ClientFacts> = {}): ClientFacts {
  return {
    notificationApi: true,
    secureContext: true,
    permission: "granted",
    audio: RUNNING_AUDIO,
    ...overrides,
  } as ClientFacts;
}

describe("产物契约：能力自检面真的被界面挂上（源码 + 产物各判一次）", () => {
  it("客户端产物外壳契约（load id = 包名、IIFE 外壳、use strict）", () => {
    assertClientSourceContract(pkgDir);
  });

  // 纯函数的判据不能证明「界面真的挂了它」：删掉 builtinCard 里那两行调用，上面的用例照样全绿。
  it("两张内置频道卡的卡体各挂了自己的诊断行，且都没有挤进卡头 summary", () => {
    const src = readFileSync(join(pkgDir, "src/client/index.tsx"), "utf8");
    expect(src).toMatch(/\{ch\.type === "system" \? hostDiagnosticsBlock\(\) : null\}/u);
    expect(src).toMatch(/\{ch\.type === "browser" \? browserDiagnosticsLine\(\) : null\}/u);
    expect(src).toMatch(/clientDiagnosticsOf\(diagnostics, clientFacts\(\), t\)/u);
    // 卡头那行在窄屏 @media (max-width: 480px) 下 display:none——诊断结论必须落在卡体
    const card = src.slice(src.indexOf("function builtinCard("), src.indexOf("function soundRow("));
    const summary = card.slice(card.indexOf("<summary>"), card.indexOf("</summary>"));
    expect(summary).not.toMatch(/hostDiagnosticsBlock|browserDiagnosticsLine/u);
    expect(card).toMatch(/className="dn-ch-body"/u);
  });

  // 权限状态行是显式契约锚点（style.css 头部登记），改结构会让既有窄屏/权限断言落空。
  it("权限状态行的结构没被改动（dn-ch-perm 锚点仍在）", () => {
    const src = readFileSync(join(pkgDir, "src/client/index.tsx"), "utf8");
    expect(src).toContain('<div className="dn-ch-perm">');
    expect(src).toContain('<span className="dn-ch-permText">{text}</span>');
  });

  // 构建面：源码有而产物没有，说明那个模块没被打进 client.js（用户侧就是一片空白）。
  it("产物 client.js 带上了诊断行（JS 侧拼接字面量存在，排除只剩 CSS 选择器的情况）", () => {
    const code = readFileSync(join(pkgDir, "lib/client.js"), "utf8");
    expect(code).toContain('"dn-ch-diag dn-ch-diag-"');
    expect(code).toContain("clientDiagnosticsOf");
  });
});

describe("跨端形态：客户端模块自带实现，不夹带服务端代码", () => {
  // 跨端只共用**类型**；这条断言把「运行时只有一份实现」变成可判红的判据，而不是口头约定。
  it("打包产物里没有服务端模块的痕迹（`import type` 被擦除、服务端标识符不出现）", () => {
    const code = bundle.outputFiles[0]!.text;
    for (const marker of [
      "server/channels",
      "capabilities/type",
      "probeNotificationCapabilities",
      "readOsRelease",
      "REASON_CODES",
      "node:fs",
      "node:child_process",
    ]) {
      expect(code, `产物夹带了 ${marker}`).not.toContain(marker);
    }
  });
});

describe("hostCapabilitiesOf：宿主面读侧归一化", () => {
  it("完整载荷照契约读出（含 checked / players / toneFileAvailable / remediation）", () => {
    const host = hostCapabilitiesOf(
      payloadOf({
        verdict: "degraded",
        unknownDimensions: ["sound"],
        remediation: [{ code: "host-no-tone-file" }],
      }),
    );
    expect(host).toEqual({
      verdict: "degraded",
      unknownDimensions: ["sound"],
      popup: OK_POPUP,
      sound: OK_SOUND,
      remediation: [{ code: "host-no-tone-file" }],
    });
  });

  // 值域外的结论一律降级为 unknown：猜成 ok 是把没验过说成能用，猜成 unreachable 是假警报。
  it("未知 verdict 降级为 unknown（组级与维度级各一次），既不抛错也不当 ok", () => {
    const host = hostCapabilitiesOf(
      payloadOf({ verdict: "totally-fine", popup: { state: "fine", checked: [] } }),
    );
    expect(host?.verdict).toBe("unknown");
    expect(host?.popup.state).toBe("unknown");
    expect(host?.sound.state).toBe("ok");
  });

  it("未知 checked 维度名被丢掉，认识的留下（顺序不变）", () => {
    const host = hostCapabilitiesOf(
      payloadOf({
        popup: { state: "ok", checked: ["notify-send", "afplay", 42, "session-bus"] },
        sound: { ...OK_SOUND, checked: ["tone-file", "win-toast"] },
      }),
    );
    expect(host?.popup.checked).toEqual(["notify-send", "session-bus"]);
    expect(host?.sound.checked).toEqual(["tone-file"]);
  });

  it("缺字段 / 畸形载荷一律返回 undefined（调用方据此不渲染）", () => {
    expect(hostCapabilitiesOf(undefined)).toBeUndefined();
    expect(hostCapabilitiesOf(null)).toBeUndefined();
    expect(hostCapabilitiesOf("nope")).toBeUndefined();
    expect(hostCapabilitiesOf([])).toBeUndefined();
    expect(hostCapabilitiesOf({})).toBeUndefined();
    // 旧服务端：整个 capabilities 面缺席
    expect(
      hostCapabilitiesOf({ ok: true, plugin: "dsh-notifier", platform: "linux" }),
    ).toBeUndefined();
    expect(hostCapabilitiesOf({ capabilities: null })).toBeUndefined();
    expect(hostCapabilitiesOf({ capabilities: { host: null } })).toBeUndefined();
    // 三条结论缺一条就说不出一句真话
    expect(hostCapabilitiesOf(payloadOf({ verdict: undefined }))).toBeUndefined();
    expect(hostCapabilitiesOf(payloadOf({ popup: { checked: [] } }))).toBeUndefined();
    expect(hostCapabilitiesOf(payloadOf({ sound: { players: [] } }))).toBeUndefined();
  });

  it("非数组 / 陌生取值按缺省处理，不抛错（未知维度名、非法包管理器、非字符串包名）", () => {
    const host = hostCapabilitiesOf(
      payloadOf({
        unknownDimensions: ["sound", "printer"],
        remediation: [
          "raw",
          { code: "" },
          { code: 7 },
          { code: "host-no-player", params: { packagemanager: "yum", packages: ["x", 3, ""] } },
        ],
      }),
    );
    expect(host?.unknownDimensions).toEqual(["sound"]);
    expect(host?.remediation).toEqual([{ code: "host-no-player", params: { packages: ["x"] } }]);
  });
});

describe("remediationTextOf：处置建议文案", () => {
  const CODES = [
    "host-no-dbus-session",
    "host-popup-no-daemon",
    "host-no-notify-send",
    "host-no-sound-server-and-player",
    "host-only-sound-server-players",
    "host-no-player",
    "host-no-tone-file",
    "host-managed-by-others",
  ] as const;

  // 服务端加 code 而客户端漏配文案，用户看到的就是一行英文标识符——这张表把它变成可判红的判据。
  it("契约里每个 code 都有文案，且不回落成 key 本体", () => {
    for (const code of CODES) {
      const text = remediationTextOf({ code }, t);
      expect(text, `缺 ${code} 的文案`).toBeTypeOf("string");
      expect(text, `${code} 回落到 key 本体`).not.toBe(code);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("{");
    }
  });

  // 只有 packagemanager 与 packages 两个占位符会被插值；其余键不进文案。
  it("params 只插值 packagemanager 与 packages", () => {
    expect(
      remediationTextOf(
        {
          code: "host-no-sound-server-and-player",
          params: { packagemanager: "apt", packages: ["alsa-utils"] },
        },
        t,
      ),
    ).toBe(
      zh.diagRemHostNoSoundServerAndPlayer
        .replace("{packages}", "alsa-utils")
        .replace("{packagemanager}", "apt"),
    );
  });

  // 认不出发行版时服务端只给 code：插值不上的花括号会被原样渲染，故换文案而不是少填一格。
  it("缺包名时换一条不带占位符的文案", () => {
    const text = remediationTextOf({ code: "host-no-sound-server-and-player" }, t);
    expect(text).toBe(zh.diagRemHostNoSoundServerAndPlayerNoPkg);
    expect(text).not.toContain("{");
  });

  // 新 code（只命中服务型播放器）与无播放器那条同族：带包名与不带包名两条都要真的可达，
  // 否则带包名那条永远不渲染（服务端永远不给 params 时它就是死文案）。
  it("只命中服务型播放器：带包名与无包名两条文案各自可达", () => {
    const withParams = remediationTextOf(
      {
        code: "host-only-sound-server-players",
        params: { packagemanager: "apt", packages: ["alsa-utils", "ffmpeg"] },
      },
      t,
    );
    expect(withParams).toBe(
      zh.diagRemHostOnlySoundServerPlayers
        .replace("{packages}", "alsa-utils ffmpeg")
        .replace("{packagemanager}", "apt"),
    );
    expect(withParams).not.toContain("{");

    // 服务端只给 code（认不出发行版）时换不带占位符的那一条
    const sparse = remediationTextOf({ code: "host-only-sound-server-players" }, t);
    expect(sparse).toBe(zh.diagRemHostOnlySoundServerPlayersNoPkg);
    expect(sparse).not.toContain("{");
  });

  // 维护者裁决：ffmpeg 进了包清单，而 dnf 族上它来自 RPM Fusion——带包名的两条建议都必须说出来，
  // 否则 Fedora/RHEL 用户照抄会直接装不上。文案措辞可以改，这句提示不能丢。
  it("带包名的两条建议都提示 ffmpeg 需要 RPM Fusion（dnf 照抄会装不上）", () => {
    for (const key of [
      "diagRemHostNoSoundServerAndPlayer",
      "diagRemHostOnlySoundServerPlayers",
    ] as const) {
      expect(zh[key], `zh 的 ${key} 没提 RPM Fusion`).toContain("RPM Fusion");
      expect(en[key], `en 的 ${key} 没提 RPM Fusion`).toContain("RPM Fusion");
    }
  });

  // 负例：更新版本的服务端写下的陌生 code——中性回退还不能把宿主侧参数端出来。
  it("认不出的 code 中性回退，且不回显 params 原文", () => {
    const text = remediationTextOf(
      {
        code: "host-from-the-future",
        params: { packagemanager: "apt", packages: ["secret-package-name"] },
      },
      t,
    );
    expect(text).toBe(zh.diagRemediationUnknown);
    expect(text).not.toContain("secret-package-name");
    expect(text).not.toContain("apt");
    expect(text).not.toContain("host-from-the-future");
  });
});

describe("audioStateOf：音频四态与 suspended 的两种成因", () => {
  it("running / closed / unsupported 各自成立", () => {
    expect(audioStateOf(RUNNING_AUDIO)).toEqual({ kind: "running" });
    expect(audioStateOf({ ...RUNNING_AUDIO, state: "closed" })).toEqual({ kind: "closed" });
    expect(audioStateOf({ ...RUNNING_AUDIO, supported: false, state: null })).toEqual({
      kind: "unsupported",
    });
  });

  // audioCtx === null 主要表达「用户还没点过」，不等于 Web Audio 不可用。
  it("尚未构造（state null）判为「尚未解锁」而不是不支持", () => {
    expect(
      audioStateOf({ supported: true, state: null, hasEverRun: false, resumeRejected: false }),
    ).toEqual({ kind: "suspended", cause: "never-unlocked" });
  });

  it("suspended 的两种成因可区分：曾跑起来过或被 resume 拒绝 → auto-suspended", () => {
    const base = { supported: true, state: "suspended" as const };
    expect(audioStateOf({ ...base, hasEverRun: false, resumeRejected: false })).toEqual({
      kind: "suspended",
      cause: "never-unlocked",
    });
    expect(audioStateOf({ ...base, hasEverRun: true, resumeRejected: false })).toEqual({
      kind: "suspended",
      cause: "auto-suspended",
    });
    // 没跑到 running 但 resume 被 reject：不是「还没轮到我」，是浏览器明确拒绝
    expect(audioStateOf({ ...base, hasEverRun: false, resumeRejected: true })).toEqual({
      kind: "suspended",
      cause: "auto-suspended",
    });
  });
});

describe("browserStatesOf：浏览器面判定（本地计算）", () => {
  it("Notification.permission 三态各成结论", () => {
    expect(browserStatesOf(factsOf({ permission: "granted" })).popup).toEqual({ state: "ok" });
    expect(browserStatesOf(factsOf({ permission: "denied" })).popup).toEqual({
      state: "unreachable",
      code: "browser-permission-denied",
    });
    expect(browserStatesOf(factsOf({ permission: "default" })).popup).toEqual({
      state: "unknown",
      code: "browser-permission-default",
    });
  });

  it("没有通知 API 一律是同一个 code（不按 UA 编专用名字）", () => {
    const states = browserStatesOf(factsOf({ notificationApi: false, permission: "unknown" }));
    expect(states.popup).toEqual({
      state: "unreachable",
      code: "browser-no-notification-api",
    });
  });

  it("权限值读不出来时是「无法判定」，不硬安一个成因", () => {
    expect(browserStatesOf(factsOf({ permission: "prompt" })).popup).toEqual({ state: "unknown" });
  });

  // 本仓的局域网明文降级链靠 Web Audio 发声：非安全上下文只降级 popup。
  it("非安全上下文只降级 popup；音频正常时 sound 仍是 ok", () => {
    const states = browserStatesOf(factsOf({ secureContext: false }));
    expect(states.popup).toEqual({ state: "degraded", code: "browser-insecure-context" });
    expect(states.sound).toEqual({ state: "ok" });
    expect(states.verdict).toBe("degraded");
  });

  it("音频四态各自映射到 dim 结论", () => {
    const soundOfFacts = (audio: AudioFacts) => browserStatesOf(factsOf({ audio })).sound;
    expect(soundOfFacts(RUNNING_AUDIO)).toEqual({ state: "ok" });
    expect(soundOfFacts({ ...RUNNING_AUDIO, state: null, hasEverRun: false })).toEqual({
      state: "unknown",
      code: "browser-audio-never-unlocked",
    });
    expect(soundOfFacts({ ...RUNNING_AUDIO, state: "suspended" })).toEqual({
      state: "degraded",
      code: "browser-audio-auto-suspended",
    });
    expect(soundOfFacts({ ...RUNNING_AUDIO, state: "suspended", hasEverRun: false })).toEqual({
      state: "unknown",
      code: "browser-audio-never-unlocked",
    });
    expect(soundOfFacts({ ...RUNNING_AUDIO, state: "closed" })).toEqual({
      state: "unreachable",
      code: "browser-audio-closed",
    });
    expect(soundOfFacts({ ...RUNNING_AUDIO, supported: false, state: null })).toEqual({
      state: "unreachable",
      code: "browser-audio-unsupported",
    });
  });

  // 序与 #784 §4.2 及服务端逐项一致（unreachable > unknown > degraded > ok）。`unknown > degraded`
  // 这一格是两端曾经分叉的地方：这里改回 degraded 优先、或服务端改成 unknown 轻于 degraded，都会红。
  it("组级结论取最严重者：unreachable > unknown > degraded > ok（与服务端同序）", () => {
    expect(worstVerdict(["ok", "unknown"])).toBe("unknown");
    expect(worstVerdict(["unknown", "degraded"])).toBe("unknown");
    expect(worstVerdict(["degraded", "unreachable"])).toBe("unreachable");
    expect(worstVerdict(["ok", "ok"])).toBe("ok");
    expect(worstVerdict([])).toBe("ok");
  });
});

describe("clientDiagnosticsOf：界面只做机械投影", () => {
  it("宿主面缺席时整块不渲染，浏览器面照常有结论", () => {
    const view = clientDiagnosticsOf(null, factsOf(), t);
    expect(view.host).toBeUndefined();
    expect(view.browser.verdict).toBe("ok");
    expect(view.browser.line).toContain(zh.diagVerdictOk);
    expect(view.browser.line).not.toContain("{");
  });

  it("未知组级 verdict 渲染成「无法判定」而不是可用（tone 也不是 ok）", () => {
    const view = clientDiagnosticsOf(payloadOf({ verdict: "whatever" }), factsOf(), t);
    expect(view.host?.verdict).toBe("unknown");
    expect(view.host?.tone).toBe("unknown");
    expect(view.host?.line).toContain(zh.diagVerdictUnknown);
    expect(view.host?.line).not.toContain(zh.diagVerdictUnreachable);
  });

  it("unreachable / degraded 的 tone 分别落 error / warn（配色 token 由 tone 决定）", () => {
    const bad = clientDiagnosticsOf(
      payloadOf({ verdict: "unreachable", sound: { ...OK_SOUND, state: "unreachable" } }),
      factsOf(),
      t,
    );
    expect(bad.host?.tone).toBe("error");
    const meh = clientDiagnosticsOf(payloadOf({ verdict: "degraded" }), factsOf(), t);
    expect(meh.host?.tone).toBe("warn");
  });

  it("结论行说清两个维度；unknownDimensions 非空时指名道姓", () => {
    const clean = clientDiagnosticsOf(payloadOf(), factsOf(), t);
    expect(clean.host?.unknownLine).toBe("");
    expect(clean.host?.line).toContain(zh.diagDimPopup);
    expect(clean.host?.line).toContain(zh.diagDimSound);

    const partial = clientDiagnosticsOf(payloadOf({ unknownDimensions: ["sound"] }), factsOf(), t);
    expect(partial.host?.unknownLine).toBe(
      zh.diagUnknownLine.replace("{dimensions}", zh.diagDimSound),
    );
  });

  it("处置建议逐条成行（数量与顺序跟着载荷走）", () => {
    const view = clientDiagnosticsOf(
      payloadOf({
        remediation: [{ code: "host-no-dbus-session" }, { code: "host-managed-by-others" }],
      }),
      factsOf(),
      t,
    );
    expect(view.host?.remediationLines).toEqual([
      zh.diagRemHostNoDbusSession,
      zh.diagRemHostManagedByOthers,
    ]);
    expect(view.host?.remediationTitle).toBe(zh.diagRemediationTitle);
  });

  it("明细折叠区带出 checked / players / toneFileAvailable，并标注来源", () => {
    const view = clientDiagnosticsOf(
      payloadOf({
        sound: {
          state: "degraded",
          players: ["pw-play", "paplay"],
          toneFileAvailable: false,
          checked: ["players", "tone-file"],
        },
      }),
      factsOf(),
      t,
    );
    expect(view.host?.detailsLabel).toBe(zh.diagDetailsLabel);
    expect(view.host?.sourceLabel).toBe(zh.diagSourceHost);
    expect(view.host?.details).toEqual([
      {
        label: zh.diagDimPopup + " · " + zh.diagCheckedLabel,
        value: zh.diagCheckedNotifySend + " · " + zh.diagCheckedSessionBus,
      },
      {
        label: zh.diagDimSound + " · " + zh.diagCheckedLabel,
        value: zh.diagCheckedPlayers + " · " + zh.diagCheckedToneFile,
      },
      { label: zh.diagPlayersLabel, value: "pw-play · paplay" },
      { label: zh.diagToneFileLabel, value: zh.diagToneFileNo },
    ]);
  });

  it("dim 文案把成因放进同一行；浏览器面来源标注跟着走", () => {
    const view = clientDiagnosticsOf(
      payloadOf(),
      factsOf({ secureContext: false, audio: { ...RUNNING_AUDIO, state: "closed" } }),
      t,
    );
    expect(view.browser.line).toContain(zh.diagVerdictDegraded);
    expect(view.browser.line).toContain(zh.diagBrowserInsecureContext);
    expect(view.browser.line).toContain(zh.diagBrowserAudioClosed);
    expect(view.browser.sourceLabel).toBe(zh.diagSourceBrowser);
    expect(view.browser.tone).toBe("error");
  });

  // 未授权时的动作提示必须出现在结论行里（权限状态行给按钮，这里给「下一步是什么」）。
  it("权限未请求时结论行给出可请求权限的动作提示", () => {
    const view = clientDiagnosticsOf(payloadOf(), factsOf({ permission: "default" }), t);
    expect(view.browser.line).toContain(zh.diagBrowserPermissionDefault);
    expect(view.browser.verdict).toBe("unknown");
  });
});

describe("双语：新增 key 两边齐备", () => {
  it("zh 的每个 diag* key 在 en 都有非空文案，且不回落成 key 本体", () => {
    const keys = (Object.keys(zh) as NotifierLocaleKey[]).filter((key) => key.startsWith("diag"));
    // 这一面至少要有四个 verdict、两个维度、八条出路（含两条无包名变体）、九条浏览器态与来源标注
    expect(keys.length).toBeGreaterThanOrEqual(32);
    for (const key of keys) {
      expect(en[key], `en 缺 ${key}`).toBeTypeOf("string");
      expect(en[key], `en 的 ${key} 为空`).not.toBe("");
      expect(en[key], `${key} 的 zh 文案回落到 key 本体`).not.toBe(key);
      expect(en[key], `${key} 的 en 文案回落到 key 本体`).not.toBe(key);
    }
  });

  it("契约要求的那几组 key 一个都不少（verdict 四态 / 维度 / 八条出路 / 浏览器各态）", () => {
    const required = [
      "diagVerdictOk",
      "diagVerdictDegraded",
      "diagVerdictUnreachable",
      "diagVerdictUnknown",
      "diagDimPopup",
      "diagDimSound",
      "diagUnknownLine",
      "diagDetailsLabel",
      "diagSourceHost",
      "diagSourceBrowser",
      "diagRemHostNoDbusSession",
      "diagRemHostPopupNoDaemon",
      "diagRemHostNoNotifySend",
      "diagRemHostNoSoundServerAndPlayer",
      "diagRemHostNoSoundServerAndPlayerNoPkg",
      "diagRemHostOnlySoundServerPlayers",
      "diagRemHostOnlySoundServerPlayersNoPkg",
      "diagRemHostNoPlayer",
      "diagRemHostNoToneFile",
      "diagRemHostManagedByOthers",
      "diagBrowserNoNotificationApi",
      "diagBrowserInsecureContext",
      "diagBrowserPermissionDenied",
      "diagBrowserPermissionDefault",
      "diagBrowserAudioNeverUnlocked",
      "diagBrowserAudioAutoSuspended",
      "diagBrowserAudioClosed",
      "diagBrowserAudioUnsupported",
      "diagCheckedNotifySend",
      "diagCheckedDbusNameOwner",
      "diagCheckedDbusActivatable",
      "diagCheckedSessionBus",
      "diagCheckedPlayers",
      "diagCheckedToneFile",
    ] as const;
    for (const key of required) {
      expect(zh[key], `zh 缺 ${key}`).toBeTypeOf("string");
      expect(en[key], `en 缺 ${key}`).toBeTypeOf("string");
    }
  });
});
