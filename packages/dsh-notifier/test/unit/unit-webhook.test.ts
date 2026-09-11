/**
 * dsh-notifier — unit：webhook 频道。
 *
 * 覆盖：
 * - renderWebhookBody JSON-aware 两步法：映射表（ntfy/gotify/custom）、默认模板、
 *   {{ts}} 数字直出、文本占位符单趟替换（注入内容不被二次替换）、JSON 注入防护
 *   （引号/`"}}` 逃逸失败）、非法模板抛错；
 * - createWebhookChannel + fetch mock：bearer/basic/header/none 认证头、4xx 失败
 *   终态且凭据脱敏、渲染失败转投递失败、无重试；
 * - config 契约：webhook 实例 normalize（URL 姿态/auth 枚举/timeoutSec clamp/
 *   保留键剔除/preset 收列）、validateSettings 混合 channels、掩码泛化
 *   （redactConfigView / unmaskChannels 按 CHANNEL_SECRET_FIELDS）。
 * 无网络：fetch 整体替换 + URL 前缀过滤（与 service-contract 同款手法，finally 恢复）。
 */
import { describe, expect, it } from "vitest";
import type { WebhookChannelConfig } from "../../src/config/interface.ts";
import type { NotifySeverity } from "../../src/sdk/interface.ts";
import {
  normalizeConfig,
  validateSettings,
  redactConfigView,
  unmaskChannels,
  SECRET_MASK,
} from "../../src/index.ts";
import {
  renderWebhookBody,
  createWebhookChannel,
  priorityFor,
  SEVERITY_NTFY_PRIORITY,
  SEVERITY_GOTIFY_PRIORITY,
  WEBHOOK_DEFAULT_TIMEOUT_SEC,
} from "../../src/index.ts";

/** 掩码回填受理面（未受理即抛——断言前置的受理条件）。 */
function unmaskOk(result: ReturnType<typeof unmaskChannels>): Array<Record<string, unknown>> {
  if (!result.ok) throw new Error("掩码回填未受理");
  return result.channels as Array<Record<string, unknown>>;
}

/** fetch 桩调用记录：断言面只读 headers/body，RequestInit 的宽类型无法直接索引。 */
interface FetchCall {
  url: string;
  init: { headers: Record<string, string>; body: string };
}

const HOOK_PREFIX = "http://127.0.0.1:40281/";
const webhookBase: Omit<WebhookChannelConfig, "auth"> = { id: "webhook-1", type: "webhook", url: `${HOOK_PREFIX}hook`, enabled: true };

/**
 * fetch 桩：URL 前缀过滤（非本桩 URL 透传原 fetch），finally 恢复；
 * failAt 指定第几次调用返回 401 且响应体回显 token（验证脱敏）。
 */
async function withWebhookFetch<T>(fn: (calls: FetchCall[]) => Promise<T>, failAt = 0): Promise<T> {
  const origFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  try {
    globalThis.fetch = (async (url, init): Promise<Response> => {
      if (!String(url).startsWith(HOOK_PREFIX)) return origFetch(url, init);
      calls.push({ url: String(url), init: init as unknown as FetchCall["init"] });
      if (failAt !== 0 && calls.length === failAt) {
        return { ok: false, status: 401, json: async () => ({}), text: async () => `bad token ${"tk-secret-1"}` } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
    }) as typeof fetch;
    return await fn(calls);
  } finally {
    globalThis.fetch = origFetch;
  }
}

/** 成功路径 send（在同一 fetch 桩内调用）。 */
async function sendOk(overrides: Partial<WebhookChannelConfig>, ts: number): Promise<void> {
  const ch = createWebhookChannel({ ...webhookBase, ...overrides } as WebhookChannelConfig);
  await (ch.send({ title: "T", body: "B", kind: "k", ts, severity: "info" }) as Promise<void>);
}

/** 捕获 send 的 reject 值（渲染失败或 4xx）。 */
async function captureSendError(overrides: Partial<WebhookChannelConfig>, failAt = 0): Promise<unknown> {
  return withWebhookFetch(async () => {
    const ch = createWebhookChannel({ ...webhookBase, ...overrides } as WebhookChannelConfig);
    let err: unknown = null;
    await (ch.send({ title: "T", body: "B", kind: "k", ts: 1, severity: "info" }) as Promise<void>).catch((e) => { err = e; });
    return err;
  }, failAt);
}

describe("① {{priority}} 频道感知映射表（契约锁定）", () => {
  for (const [sev, ntfy] of [["failure", "urgent"], ["warning", "high"], ["success", "low"], ["info", "default"]] as Array<[NotifySeverity, string]>) {
    it(`ntfy 映射 ${sev}→${ntfy}`, () => {
      expect(SEVERITY_NTFY_PRIORITY[sev]).toBe(ntfy);
    });

    it(`priorityFor ntfy ${sev}`, () => {
      expect(priorityFor("ntfy", sev)).toBe(ntfy);
    });
  }

  for (const [sev, gotify] of [["failure", "9"], ["warning", "7"], ["success", "3"], ["info", "3"]] as Array<[NotifySeverity, string]>) {
    it(`gotify 映射 ${sev}→${gotify}`, () => {
      expect(String(SEVERITY_GOTIFY_PRIORITY[sev])).toBe(gotify);
    });

    it(`priorityFor gotify ${sev}`, () => {
      expect(priorityFor("gotify", sev)).toBe(gotify);
    });
  }

  it("custom 直出 severity 原文", () => {
    expect(priorityFor("custom", "warning")).toBe("warning");
  });

  it("severity 缺省 → ntfy default", () => {
    expect(priorityFor("ntfy", undefined)).toBe("default");
  });
});

describe("② renderWebhookBody：两步法 + 默认模板 + {{ts}} 直出", () => {
  const body = renderWebhookBody("", "ntfy", { title: "T1", message: "M1", kind: "error", severity: "failure", ts: 1730000000123 });
  const parsed = JSON.parse(body);
  const body2 = renderWebhookBody('{"severity": "{{severity}}", "priority": "{{priority}}", "ts": {{ts}}}', "custom", { title: "T", message: "M", kind: "k", severity: "info", ts: 1730000000456 });
  const parsed2 = JSON.parse(body2);

  it("ntfy 默认模板 title 落位", () => {
    // ntfy 默认模板 + {{priority}} 映射
    expect(parsed.title).toBe("T1");
  });

  it("ntfy 默认模板 message 落位", () => {
    expect(parsed.message).toBe("M1");
  });

  it("ntfy 默认模板 tags[0] = kind", () => {
    expect(parsed.tags[0]).toBe("error");
  });

  it("ntfy failure → urgent", () => {
    expect(parsed.priority).toBe("urgent");
  });

  it("{{ts}} 裸值数字直出", () => {
    expect(parsed2.ts).toBe(1730000000456);
  });

  it("custom severity 原文直出", () => {
    expect(parsed2.severity).toBe("info");
  });

  it("custom {{priority}} 同 severity 原文", () => {
    expect(parsed2.priority).toBe("info");
  });

  it("gotify {{priority}}（字符串位）渲染映射值", () => {
    // gotify 默认模板（priority 数字经字符串替换仍在 JSON 数字位失败——gotify 模板把
    // {{priority}} 放字符串位："priority": "{{priority}}" → "7"；用户如需数字可改
    // 模板为裸 {{ts}} 形态。此处锁定字符串位渲染为映射值文本）
    const body3 = renderWebhookBody('{"priority": "{{priority}}"}', "gotify", { title: "T", message: "M", kind: "k", severity: "failure", ts: 1 });
    expect(JSON.parse(body3).priority).toBe("9");
  });

  it("{{ message }} 空白容差", () => {
    const body4 = renderWebhookBody('{"m": "{{ message }}"}', "ntfy", { title: "T", message: "M", kind: "k", severity: "info", ts: 1 });
    expect(JSON.parse(body4).m).toBe("M");
  });
});

describe("③ renderWebhookBody：JSON 注入防护（评审加固）", () => {
  const evil = 'M", "injected": true, "x": "';
  const parsed = JSON.parse(renderWebhookBody('{"title": "{{title}}", "message": "{{message}}"}', "ntfy", { title: "T", message: evil, kind: "k", severity: "info", ts: 1 }));

  it("注入内容无法逃逸出字符串（无新增字段）", () => {
    expect(Object.keys(parsed).length).toBe(2);
  });

  it("注入内容原样保留在字符串值内（序列化转义）", () => {
    expect(parsed.message).toBe(evil);
  });

  it("插入值内占位符文本不被二次替换（应为原文）", () => {
    // 插入内容含占位符文本：单趟替换不做二次替换
    const body2 = renderWebhookBody('{"m": "{{message}}"}', "ntfy", { title: "T", message: "{{priority}}", kind: "k", severity: "failure", ts: 1 });
    expect(JSON.parse(body2).m).toBe("{{priority}}");
  });

  it("文本占位符裸值形态 → 模板非法 → 抛错（投递失败终态）", () => {
    let threw = false;
    try {
      renderWebhookBody('{"title": {{title}}}', "ntfy", { title: "T", message: "M", kind: "k", severity: "info", ts: 1 });
    } catch {
      threw = true;
    }
    expect(threw).toBeTruthy();
  });

  it("非法 JSON 模板抛错", () => {
    let threw = false;
    try {
      renderWebhookBody("{not-json}", "ntfy", { title: "T", message: "M", kind: "k", severity: "info", ts: 1 });
    } catch {
      threw = true;
    }
    expect(threw).toBeTruthy();
  });
});

describe("④ createWebhookChannel + fetch mock：认证头 / 失败脱敏 / 渲染失败转投递失败", () => {
  it("send 返回在途 promise", async () => {
    await withWebhookFetch(async () => {
      const ch = createWebhookChannel({ ...webhookBase, auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' } as WebhookChannelConfig);
      const p = ch.send({ title: "T", body: "B", kind: "error", ts: 1, severity: "failure" });
      expect(p && typeof p.then === "function").toBeTruthy();
      await p;
    });
  });

  it("POST 目标 URL（无拼接）", async () => {
    await withWebhookFetch(async (calls) => {
      await sendOk({ auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' }, 1);
      expect(calls[0].url).toBe("http://127.0.0.1:40281/hook");
    });
  });

  it("bearer → Authorization 头", async () => {
    await withWebhookFetch(async (calls) => {
      await sendOk({ auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' }, 1);
      expect(calls[0].init.headers.authorization).toBe("Bearer tk-secret-1");
    });
  });

  it("模板渲染 payload", async () => {
    await withWebhookFetch(async (calls) => {
      await sendOk({ auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' }, 1);
      expect(JSON.parse(calls[0].init.body).title).toBe("T");
    });
  });

  it("basic → Basic base64 头", async () => {
    await withWebhookFetch(async (calls) => {
      await sendOk({ auth: "basic", username: "u1", password: "pw-secret-2" }, 2);
      expect(calls[0].init.headers.authorization).toBe(`Basic ${Buffer.from("u1:pw-secret-2").toString("base64")}`);
    });
  });

  it("自定义头直出", async () => {
    await withWebhookFetch(async (calls) => {
      await sendOk({ auth: "header", headerName: "X-Gotify-Key", headerValue: "hv-secret-3" }, 3);
      expect(calls[0].init.headers["X-Gotify-Key"]).toBe("hv-secret-3");
    });
  });

  it("4xx → reject 失败终态", async () => {
    // 4xx：失败终态 + 凭据脱敏（token 字面不出现在错误信息）
    const err = await captureSendError({ auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' }, 1);
    expect(err).toBeInstanceOf(Error);
  });

  it("4xx 错误含状态码", async () => {
    const err = await captureSendError({ auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' }, 1);
    expect(String((err as Error).message)).toContain("401");
  });

  it("错误信息不含 token 原文（脱敏）", async () => {
    const err = await captureSendError({ auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' }, 1);
    expect(String((err as Error).message)).not.toContain("tk-secret-1");
  });

  it("非法模板 → 失败终态（错误含渲染原因）", async () => {
    // 渲染失败 → 投递失败终态（不抛同步错）
    const err = await captureSendError({ auth: "none", template: "{not-json}" });
    expect(err instanceof Error && String(err.message).includes("合法 JSON")).toBeTruthy();
  });

  it("渲染失败不发起网络请求", async () => {
    await withWebhookFetch(async (calls) => {
      await sendOk({ auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' }, 1);
      await sendOk({ auth: "basic", username: "u1", password: "pw-secret-2" }, 2);
      await sendOk({ auth: "header", headerName: "X-Gotify-Key", headerValue: "hv-secret-3" }, 3);
      // 第 4 次调用（4xx 用例）计入 calls；随后渲染失败的 ch5 必须不再新增
      const ch4 = createWebhookChannel({ ...webhookBase, auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' } as WebhookChannelConfig);
      await (ch4.send({ title: "T", body: "B", kind: "k", ts: 4, severity: "info" }) as Promise<void>).catch(() => {});
      const ch5 = createWebhookChannel({ ...webhookBase, auth: "none", template: "{not-json}" } as WebhookChannelConfig);
      await (ch5.send({ title: "T", body: "B", kind: "k", ts: 5, severity: "info" }) as Promise<void>).catch(() => {});
      expect(calls.length).toBe(4);
    }, 4);
  });

  it("默认超时 10s", async () => {
    // 默认超时秒（缺省 10；clamp 语义由 normalize 权威，此处仅锁常量）
    expect(WEBHOOK_DEFAULT_TIMEOUT_SEC).toBe(10);
  });
});

describe("⑤ config 契约：normalize / validateSettings / 掩码泛化", () => {
  const cfg = normalizeConfig({
    channels: [
      { id: "webhook-1", type: "webhook", url: "https://ntfy.sh/dsh-x?leak=1#frag", enabled: false, auth: "bearer", token: "tk-1", timeoutSec: 500, preset: "gotify" },
      { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "K1", enabled: true },
    ],
  });
  const wh = cfg.channels.find((c) => c.type === "webhook");

  it("webhook 实例保留", () => {
    // normalize：合法 webhook 实例 + timeoutSec clamp + auth 缺省 none
    expect(wh).toBeTruthy();
  });

  it("URL 去 query/hash（凭据不落 URL 姿态）", () => {
    expect(wh!.url).toBe("https://ntfy.sh/dsh-x");
  });

  it("auth 透传 bearer", () => {
    expect(wh!.auth).toBe("bearer");
  });

  it("timeoutSec 权威 clamp 至上限 60", () => {
    expect(wh!.timeoutSec).toBe(60);
  });

  it("preset 收列 gotify", () => {
    expect(wh!.preset).toBe("gotify");
  });

  it("timeoutSec 下限 clamp 至 1", () => {
    const low = normalizeConfig({ channels: [{ id: "webhook-2", type: "webhook", url: "https://x.example.com", enabled: true, timeoutSec: 0.4 }] }).channels[0] as WebhookChannelConfig;
    expect(low.timeoutSec).toBe(1);
  });

  it("auth 缺省 none", () => {
    const low = normalizeConfig({ channels: [{ id: "webhook-2", type: "webhook", url: "https://x.example.com", enabled: true, timeoutSec: 0.4 }] }).channels[0] as WebhookChannelConfig;
    expect(low.auth).toBe("none");
  });

  it("webhook 保留键（凭据别名）剔除", () => {
    // 保留键剔除 + 未知 string/number 透传
    const pv = normalizeConfig({ channels: [{ id: "webhook-3", type: "webhook", url: "https://x.example.com", enabled: true, auth_token: "smuggle", custom_arg: "v1" }] }).channels[0] as WebhookChannelConfig & { custom_arg?: string };
    expect("auth_token" in pv).toBe(false);
  });

  it("未知 string 键透传", () => {
    const pv = normalizeConfig({ channels: [{ id: "webhook-3", type: "webhook", url: "https://x.example.com", enabled: true, auth_token: "smuggle", custom_arg: "v1" }] }).channels[0] as WebhookChannelConfig & { custom_arg?: string };
    expect(pv.custom_arg).toBe("v1");
  });

  it("非 http(s) URL 实例丢弃", () => {
    // 非法 URL → 丢弃
    expect(normalizeConfig({ channels: [{ id: "webhook-4", type: "webhook", url: "ftp://x", enabled: true }] }).channels.length).toBe(0);
  });

  it("跨类型 id 去重", () => {
    // 跨类型 id 去重（首个胜出）
    const dup = normalizeConfig({ channels: [
      { id: "same-id", type: "webhook", url: "https://a.example.com", enabled: true },
      { id: "same-id", type: "bark", baseUrl: "https://b.example.com", deviceKey: "K", enabled: true },
    ] }).channels;
    expect(dup.length).toBe(1);
  });

  it("混合 bark+webhook 写入合法", () => {
    // validateSettings：混合 channels 合法；非法 auth 整组 400
    expect(validateSettings({ channels: [
      { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "K", enabled: true },
      { id: "webhook-1", type: "webhook", url: "https://ntfy.sh/x", enabled: false, auth: "bearer", token: "tk" },
    ] })).toBe(null);
  });

  it("非法 auth → channels 400", () => {
    const bad = validateSettings({ channels: [{ id: "webhook-1", type: "webhook", url: "https://x", enabled: true, auth: "oauth2" }] });
    expect(bad && bad.key === "channels").toBeTruthy();
  });

  it("带凭据 URL → channels 400", () => {
    const badUrl = validateSettings({ channels: [{ id: "webhook-1", type: "webhook", url: "https://u:p@x.example.com", enabled: true }] });
    expect(badUrl && badUrl.key === "channels").toBeTruthy();
  });

  const view = redactConfigView({ channels: [
    { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "K-plain", enabled: true },
    { id: "webhook-1", type: "webhook", url: "https://x", enabled: true, auth: "basic", username: "u1", password: "pw-plain", token: "tk-plain", headerValue: "hv-plain" },
  ] });

  it("bark deviceKey 掩码（回归）", () => {
    // 掩码泛化：webhook token/password/headerValue 全掩码；bark deviceKey 照旧
    expect(view.channels[0].deviceKey).toBe(SECRET_MASK);
  });

  it("webhook token 掩码", () => {
    expect(view.channels[1].token).toBe(SECRET_MASK);
  });

  it("webhook password 掩码", () => {
    expect(view.channels[1].password).toBe(SECRET_MASK);
  });

  it("webhook headerValue 掩码", () => {
    expect(view.channels[1].headerValue).toBe(SECRET_MASK);
  });

  it("username 非 secret 不掩码", () => {
    expect(view.channels[1].username).toBe("u1");
  });

  const back = unmaskChannels(
    [{ id: "webhook-1", type: "webhook", url: "https://x", enabled: true, auth: "basic", username: "u2", password: SECRET_MASK, token: SECRET_MASK, headerValue: SECRET_MASK }],
    [{ id: "webhook-1", type: "webhook", url: "https://x", enabled: true, auth: "basic", username: "u1", password: "pw-orig", token: "tk-orig", headerValue: "hv-orig" }],
  );
  const backCh = unmaskOk(back)[0] as unknown as WebhookChannelConfig;

  it("掩码回填受理", () => {
    // 掩码回填：webhook 多 secret 字段按 id+字段对齐回填；新实例带掩码拒绝
    expect(back.ok).toBeTruthy();
  });

  it("password 回填原值", () => {
    expect(backCh.password).toBe("pw-orig");
  });

  it("token 回填原值", () => {
    expect(backCh.token).toBe("tk-orig");
  });

  it("headerValue 回填原值", () => {
    expect(backCh.headerValue).toBe("hv-orig");
  });

  it("非 secret 字段不回填（保留提交值）", () => {
    expect(backCh.username).toBe("u2");
  });

  it("新实例提交掩码 → 拒绝（掩码只允许表达未修改）", () => {
    const missing = unmaskChannels(
      [{ id: "webhook-new", type: "webhook", url: "https://x", enabled: true, token: SECRET_MASK }],
      [],
    );
    expect(!missing.ok).toBeTruthy();
  });
});
