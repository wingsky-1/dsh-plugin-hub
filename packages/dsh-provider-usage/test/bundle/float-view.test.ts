/**
 * dsh-provider-usage — 悬浮框纯视图层单测（#732 客户端面拆解）。
 *
 * 被测对象为 src/client/float-view.ts 真实源码（esbuild 即时打包，同 unit-report-p0 先例）。
 * 虚拟入口把 shared/client/i18n.js 的 bindLocale 与 float-view 的导出打进**同一份**模块实例，
 * 才能在用例里把 t 绑成可断言的假翻译（未绑时 t 回落 key 本体，参数会被丢弃，断言力不足）。
 * 离线纪律：无网络、无 DOM 依赖、无真实时钟（fake timers 固定 Date.now()）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const i18nPath = join(pkgDir, "..", "..", "shared", "client", "i18n.js");
const floatViewPath = join(pkgDir, "src", "client", "float-view.ts");

// i18n 用绝对路径引用，float-view 内的相对 import 解析到同一文件 → esbuild 去重为单实例。
const bundle = await esbuildBuild({
  stdin: {
    contents: [
      `export { bindLocale } from ${JSON.stringify(i18nPath)};`,
      `export * from ${JSON.stringify(floatViewPath)};`,
    ].join("\n"),
    resolveDir: pkgDir,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const {
  bindLocale,
  PILL_PREFIX,
  fmtAge,
  statsReason,
  pillDotLevel,
  pillTitle,
  errorMessage,
  isUnconfigured,
  panelBodyKind,
  panelFootStamp,
} = mod;

/** 可断言的假翻译：key + 具名参数一并暴露，参数缺失与参数为 undefined 形态可分辨。 */
function bindFakeLocale(): void {
  bindLocale(
    {
      bind:
        () =>
        (key: string, params?: Record<string, unknown>): string => {
          if (params === undefined) return key;
          const parts = Object.keys(params)
            .sort()
            .map((k) => `${k}=${String(params[k])}`);
          return `${key}[${parts.join(",")}]`;
        },
    },
    "providerUsage",
  );
}

const STATS_BASE = {
  plugin: "dsh-provider-usage",
  version: 2,
  provider: "vendor-a",
  adapterName: "vendor-a-adapter",
  status: "fresh",
  ok: true,
  configured: true,
  error: null,
  adapterVersion: 1,
};

// fetchedAt 取「当前假时钟」而非固定纪元：正常态 title 的相对时间才是 justNow（形态可断言）。
const stats = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...STATS_BASE,
  fetchedAt: Date.now(),
  ...over,
});

const history = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  plugin: "dsh-provider-usage",
  version: 2,
  provider: "vendor-a",
  adapterName: "vendor-a-adapter",
  error: null,
  reason: null,
  range: { start: 0, end: 1 },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
  bindFakeLocale();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("float-view：PILL_PREFIX 与 statsReason", () => {
  it("类名前缀恒为 dou-（index.tsx 与本页共用同一常量面）", () => {
    expect(PILL_PREFIX).toBe("dou-");
  });

  it("statsReason 在 stats 为 null 时返回 null（不抛，区别于字段缺席的 undefined）", () => {
    expect(statsReason(null)).toBeNull();
  });

  it("statsReason 读取宿主扩展的 reason 降级字段", () => {
    expect(statsReason(stats({ reason: "busy" }))).toBe("busy");
    expect(statsReason(stats({ reason: null }))).toBeNull();
  });

  it("statsReason 在字段缺席时返回 undefined", () => {
    expect(statsReason(stats())).toBeUndefined();
  });
});

describe("float-view：pillDotLevel", () => {
  it("无响应（首帧）→ warn，不是 err", () => {
    expect(pillDotLevel(null)).toBe("warn");
  });

  it("未配置 → err", () => {
    expect(pillDotLevel(stats({ configured: false }))).toBe("err");
  });

  it("stale → warn", () => {
    expect(pillDotLevel(stats({ status: "stale" }))).toBe("warn");
  });

  it("fresh / cached → ok", () => {
    expect(pillDotLevel(stats({ status: "fresh" }))).toBe("ok");
    expect(pillDotLevel(stats({ status: "cached" }))).toBe("ok");
  });
});

describe("float-view：fmtAge", () => {
  // now 取「用例执行时」的假时钟：describe 收集期还没装 fake timers，模块级 const 会拿到真时钟。
  const now = (): number => Date.now();

  it("非数字 / 非有限值 → 空串（不渲染脏时间）", () => {
    expect(fmtAge(undefined)).toBe("");
    expect(fmtAge(Number.NaN)).toBe("");
    expect(fmtAge(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("不足 1 分钟 → justNow", () => {
    expect(fmtAge(now() - 59_000)).toBe("justNow");
  });

  it("不足 1 小时 → minutesAgo（向下取整）", () => {
    expect(fmtAge(now() - 60_000)).toBe("minutesAgo[n=1]");
    expect(fmtAge(now() - 119_000)).toBe("minutesAgo[n=1]");
  });

  it("不足 1 天 → hoursAgo", () => {
    expect(fmtAge(now() - 3_600_000)).toBe("hoursAgo[n=1]");
  });

  it("超过 1 天 → daysAgo", () => {
    expect(fmtAge(now() - 86_400_000 * 3)).toBe("daysAgo[n=3]");
  });
});

describe("float-view：pillTitle 四态 + 未知标注", () => {
  it("未配置 → provider 名 + 未配置提示", () => {
    expect(pillTitle(stats({ configured: false }), "vendor-a", false)).toBe(
      `vendor-a · pillNotConfigured`,
    );
  });

  it("取数失败 → 携带 msg 的具体错误文案（未配置判定优先于 error 判定）", () => {
    expect(pillTitle(stats({ error: "boom" }), "vendor-a", false)).toBe("pillFetchFail[msg=boom]");
  });

  it("宿主 busy 降级 → 适配器名 + 忙提示", () => {
    expect(pillTitle(stats({ reason: "busy" }), "vendor-a", false)).toBe(
      `vendor-a-adapter · pillBusy`,
    );
  });

  it("正常态 → 适配器名 + 状态 + 相对更新时间", () => {
    expect(pillTitle(stats(), "vendor-a", false)).toBe(
      `vendor-a-adapter · pillFresh · pillUpdatedAt[t=justNow]`,
    );
    expect(pillTitle(stats({ status: "stale" }), "vendor-a", false)).toBe(
      `vendor-a-adapter · pillStale · pillUpdatedAt[t=justNow]`,
    );
    expect(pillTitle(stats({ status: "cached" }), "vendor-a", false)).toBe(
      `vendor-a-adapter · pillCached · pillUpdatedAt[t=justNow]`,
    );
  });

  it("provider 未确认 → 在四态结果尾部追加标注（不覆盖原判据）", () => {
    expect(pillTitle(stats(), "vendor-a", true)).toBe(
      `vendor-a-adapter · pillFresh · pillUpdatedAt[t=justNow] · providerUnknown`,
    );
    expect(pillTitle(stats({ configured: false }), "vendor-a", true)).toBe(
      `vendor-a · pillNotConfigured · providerUnknown`,
    );
  });
});

describe("float-view：errorMessage", () => {
  it("error 码逐条映射（含 bad-data/bad-json 合流）", () => {
    expect(errorMessage("no-api-key")).toBe("errNoApiKey[p={PROVIDER}]");
    expect(errorMessage("unauthorized")).toBe("errUnauthorized");
    expect(errorMessage("timeout")).toBe("errTimeout");
    expect(errorMessage("network")).toBe("errNetwork");
    expect(errorMessage("bad-data")).toBe("errBadData");
    expect(errorMessage("bad-json")).toBe("errBadData");
    expect(errorMessage("adapter-load-failed")).toBe("errAdapterLoadFailed");
  });

  it("reason 降级码逐条映射", () => {
    expect(errorMessage("busy")).toBe("errBusy");
    expect(errorMessage("no-enabled-adapter")).toBe("errNoEnabledAdapter");
    expect(errorMessage("no-adapter")).toBe("errNoAdapter");
  });

  it("http-NNN 前缀 → 剥前缀后填入 code", () => {
    expect(errorMessage("http-503")).toBe("errHttpStatus[code=503]");
  });

  it("未知码 → errGeneric 携带原码", () => {
    expect(errorMessage("weird")).toBe("errGeneric[code=weird]");
  });

  it("null / undefined / 空串 → errGeneric 回落到 noDataShort（三种空值同归）", () => {
    expect(errorMessage(null)).toBe("errGeneric[code=noDataShort]");
    expect(errorMessage(undefined)).toBe("errGeneric[code=noDataShort]");
    expect(errorMessage("")).toBe("errGeneric[code=noDataShort]");
  });
});

describe("float-view：isUnconfigured", () => {
  it("reason 为 no-enabled-adapter / no-adapter → true（与 stats 无关）", () => {
    expect(isUnconfigured(stats(), history({ reason: "no-enabled-adapter" }))).toBe(true);
    expect(isUnconfigured(stats(), history({ reason: "no-adapter" }))).toBe(true);
  });

  it("历史未到达且 stats 明确未配置 → true", () => {
    expect(isUnconfigured(stats({ configured: false }), null)).toBe(true);
  });

  it("历史已到达（哪怕未配置）→ false：此时以历史内容为准", () => {
    expect(isUnconfigured(stats({ configured: false }), history())).toBe(false);
  });

  it("全部就绪且已配置 → false", () => {
    expect(isUnconfigured(stats(), history())).toBe(false);
    expect(isUnconfigured(null, null)).toBe(false);
    expect(isUnconfigured(stats(), history({ reason: "busy" }))).toBe(false);
  });
});

describe("float-view：panelBodyKind 五分支优先级", () => {
  it("有 panelHtml → html（压过一切错误与引导）", () => {
    expect(
      panelBodyKind(stats({ ok: false, error: "boom" }), history({ panelHtml: "<b>x</b>" })),
    ).toBe("html");
  });

  it("未配置/无适配器 → guide", () => {
    expect(panelBodyKind(stats(), history({ reason: "no-adapter" }))).toBe("guide");
  });

  it("历史错误 → history-error", () => {
    expect(panelBodyKind(stats(), history({ error: "boom" }))).toBe("history-error");
  });

  it("stats 失败 → stats-error", () => {
    expect(panelBodyKind(stats({ ok: false, error: "boom" }), history())).toBe("stats-error");
  });

  it("stats 未就绪 → loading（失败但无 error 值的 reason 态也算 stats-error）", () => {
    expect(panelBodyKind(null, null)).toBe("loading");
    expect(panelBodyKind(stats({ ok: false, reason: "busy" }), history())).toBe("stats-error");
  });
});

describe("float-view：panelFootStamp", () => {
  it("stats 未就绪或无 fetchedAt → 两字段皆空串", () => {
    expect(panelFootStamp(null)).toEqual({ text: "", title: "" });
    expect(panelFootStamp(stats({ fetchedAt: 0 }))).toEqual({ text: "", title: "" });
  });

  it("有 fetchedAt → text 相对时间、title 本地时刻", () => {
    const at = Date.now() - 120_000;
    const stamp = panelFootStamp(stats({ fetchedAt: at }));
    expect(stamp.text).toBe("更新于 minutesAgo[n=2]");
    expect(stamp.title).toBe(new Date(at).toLocaleString("zh-CN"));
  });
});
