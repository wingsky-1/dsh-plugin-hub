// @ts-nocheck
/**
 * dsh-notifier — unit：webhook 频道（#508 M2）。
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
 * 无网络：fetch 整体替换 + URL 前缀过滤（service-contract §⑥ 同款手法，finally 恢复）。
 */
import { assert } from "./helpers.ts";
import {
  normalizeConfig,
  validateSettings,
  redactConfigView,
  unmaskChannels,
  SECRET_MASK,
} from "../lib/index.js";
import {
  renderWebhookBody,
  createWebhookChannel,
  priorityFor,
  SEVERITY_NTFY_PRIORITY,
  SEVERITY_GOTIFY_PRIORITY,
  WEBHOOK_DEFAULT_TIMEOUT_SEC,
} from "../lib/index.js";

// ---- ① {{priority}} 频道感知映射表（拍板 ④；契约锁定） ----
{
  for (const [sev, ntfy] of [["failure", "urgent"], ["warning", "high"], ["success", "low"], ["info", "default"]]) {
    assert.equal(SEVERITY_NTFY_PRIORITY[sev], ntfy, `ntfy 映射 ${sev}→${ntfy}`);
    assert.equal(priorityFor("ntfy", sev), ntfy, `priorityFor ntfy ${sev}`);
  }
  for (const [sev, gotify] of [["failure", "9"], ["warning", "7"], ["success", "3"], ["info", "3"]]) {
    assert.equal(String(SEVERITY_GOTIFY_PRIORITY[sev]), gotify, `gotify 映射 ${sev}→${gotify}`);
    assert.equal(priorityFor("gotify", sev), gotify, `priorityFor gotify ${sev}`);
  }
  assert.equal(priorityFor("custom", "warning"), "warning", "custom 直出 severity 原文");
  assert.equal(priorityFor("ntfy", undefined), "default", "severity 缺省 → ntfy default");
}

// ---- ② renderWebhookBody：两步法 + 默认模板 + {{ts}} 直出 ----
{
  // ntfy 默认模板 + {{priority}} 映射
  const body = renderWebhookBody("", "ntfy", { title: "T1", message: "M1", kind: "error", severity: "failure", ts: 1730000000123 });
  const parsed = JSON.parse(body);
  assert.equal(parsed.title, "T1");
  assert.equal(parsed.message, "M1");
  assert.equal(parsed.tags[0], "error");
  assert.equal(parsed.priority, "urgent", "ntfy failure → urgent");
  // {{ts}} 数字直出（custom 模板裸值形态）+ custom {{severity}}/{{priority}} 原文直出
  const body2 = renderWebhookBody('{"severity": "{{severity}}", "priority": "{{priority}}", "ts": {{ts}}}', "custom", { title: "T", message: "M", kind: "k", severity: "info", ts: 1730000000456 });
  const parsed2 = JSON.parse(body2);
  assert.equal(parsed2.ts, 1730000000456, "{{ts}} 裸值数字直出");
  assert.equal(parsed2.severity, "info", "custom severity 原文直出");
  assert.equal(parsed2.priority, "info", "custom {{priority}} 同 severity 原文");
  // gotify 默认模板（priority 数字经字符串替换仍在 JSON 数字位失败——gotify 模板把
  // {{priority}} 放字符串位："priority": "{{priority}}" → "7"；用户如需数字可改
  // 模板为裸 {{ts}} 形态。此处锁定字符串位渲染为映射值文本）
  const body3 = renderWebhookBody('{"priority": "{{priority}}"}', "gotify", { title: "T", message: "M", kind: "k", severity: "failure", ts: 1 });
  assert.equal(JSON.parse(body3).priority, "9", "gotify {{priority}}（字符串位）渲染映射值");
  // 占位符空白容差
  const body4 = renderWebhookBody('{"m": "{{ message }}"}', "ntfy", { title: "T", message: "M", kind: "k", severity: "info", ts: 1 });
  assert.equal(JSON.parse(body4).m, "M", "{{ message }} 空白容差");
}

// ---- ③ renderWebhookBody：JSON 注入防护（评审 P0） ----
{
  const evil = 'M", "injected": true, "x": "';
  const body = renderWebhookBody('{"title": "{{title}}", "message": "{{message}}"}', "ntfy", { title: "T", message: evil, kind: "k", severity: "info", ts: 1 });
  const parsed = JSON.parse(body);
  assert.equal(Object.keys(parsed).length, 2, "注入内容无法逃逸出字符串（无新增字段）");
  assert.equal(parsed.message, evil, "注入内容原样保留在字符串值内（序列化转义）");
  // 插入内容含占位符文本：单趟替换不做二次替换
  const body2 = renderWebhookBody('{"m": "{{message}}"}', "ntfy", { title: "T", message: "{{priority}}", kind: "k", severity: "failure", ts: 1 });
  assert.equal(JSON.parse(body2).m, "urgent".replace("urgent", "urgent") === "urgent" ? "{{priority}}" : "{{priority}}", "插入值内占位符文本不被二次替换（应为原文）");
  // 裸值形态放文本占位符 → JSON.parse 失败 → 抛错（安全失败）
  let threw = false;
  try {
    renderWebhookBody('{"title": {{title}}}', "ntfy", { title: "T", message: "M", kind: "k", severity: "info", ts: 1 });
  } catch {
    threw = true;
  }
  assert.ok(threw, "文本占位符裸值形态 → 模板非法 → 抛错（投递失败终态）");
  // 非法 JSON 模板 → 抛错
  threw = false;
  try {
    renderWebhookBody("{not-json}", "ntfy", { title: "T", message: "M", kind: "k", severity: "info", ts: 1 });
  } catch {
    threw = true;
  }
  assert.ok(threw, "非法 JSON 模板抛错");
}

// ---- ④ createWebhookChannel + fetch mock：认证头 / 失败脱敏 / 渲染失败转投递失败 ----
{
  const origFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("http://127.0.0.1:40281/")) return origFetch(url, init);
      calls.push({ url: String(url), init });
      // 第 4 次调用（ch4 的 4xx 用例）：响应体回显 token，验证脱敏
      if (calls.length === 4) return { ok: false, status: 401, json: async () => ({}), text: async () => `bad token ${"tk-secret-1"}` };
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };
    const base = { id: "webhook-1", type: "webhook", url: "http://127.0.0.1:40281/hook", enabled: true };

    // bearer
    const ch = createWebhookChannel({ ...base, auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' });
    const p = ch.send({ title: "T", body: "B", kind: "error", ts: 1, severity: "failure" });
    assert.ok(p && typeof p.then === "function", "send 返回在途 promise");
    await p;
    assert.equal(calls[0].url, "http://127.0.0.1:40281/hook", "POST 目标 URL（无拼接）");
    assert.equal(calls[0].init.headers.authorization, "Bearer tk-secret-1", "bearer → Authorization 头");
    assert.equal(JSON.parse(calls[0].init.body).title, "T", "模板渲染 payload");

    // basic（base64）+ header
    const ch2 = createWebhookChannel({ ...base, auth: "basic", username: "u1", password: "pw-secret-2" });
    await ch2.send({ title: "T", body: "B", kind: "k", ts: 2, severity: "info" });
    assert.equal(calls[1].init.headers.authorization, `Basic ${Buffer.from("u1:pw-secret-2").toString("base64")}`, "basic → Basic base64 头");
    const ch3 = createWebhookChannel({ ...base, auth: "header", headerName: "X-Gotify-Key", headerValue: "hv-secret-3" });
    await ch3.send({ title: "T", body: "B", kind: "k", ts: 3, severity: "info" });
    assert.equal(calls[2].init.headers["X-Gotify-Key"], "hv-secret-3", "自定义头直出");

    // 4xx：失败终态 + 凭据脱敏（token 字面不出现在错误信息）
    const ch4 = createWebhookChannel({ ...base, auth: "bearer", token: "tk-secret-1", template: '{"title": "{{title}}"}' });
    let err = null;
    await ch4.send({ title: "T", body: "B", kind: "k", ts: 4, severity: "info" }).catch((e) => { err = e; });
    assert.ok(err instanceof Error, "4xx → reject 失败终态");
    assert.ok(String(err.message).includes("401"), "4xx 错误含状态码");
    assert.ok(!String(err.message).includes("tk-secret-1"), "错误信息不含 token 原文（脱敏）");

    // 渲染失败 → 投递失败终态（不抛同步错）
    const ch5 = createWebhookChannel({ ...base, auth: "none", template: "{not-json}" });
    err = null;
    await ch5.send({ title: "T", body: "B", kind: "k", ts: 5, severity: "info" }).catch((e) => { err = e; });
    assert.ok(err instanceof Error && String(err.message).includes("合法 JSON"), "非法模板 → 失败终态（错误含渲染原因）");
    assert.equal(calls.length, 4, "渲染失败不发起网络请求");

    // 默认超时秒（拍板 ②：缺省 10；clamp 语义由 normalize 权威，此处仅锁常量）
    assert.equal(WEBHOOK_DEFAULT_TIMEOUT_SEC, 10, "默认超时 10s");
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("W1 webhook channel 认证头/脱敏/渲染失败终态: OK");
}

// ---- ⑤ config 契约：normalize / validateSettings / 掩码泛化 ----
{
  // normalize：合法 webhook 实例 + timeoutSec clamp + auth 缺省 none
  const cfg = normalizeConfig({
    channels: [
      { id: "webhook-1", type: "webhook", url: "https://ntfy.sh/dsh-x?leak=1#frag", enabled: false, auth: "bearer", token: "tk-1", timeoutSec: 500, preset: "gotify" },
      { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "K1", enabled: true },
    ],
  });
  const wh = cfg.channels.find((c) => c.type === "webhook");
  assert.ok(wh, "webhook 实例保留");
  assert.equal(wh.url, "https://ntfy.sh/dsh-x", "URL 去 query/hash（凭据不落 URL 姿态）");
  assert.equal(wh.auth, "bearer");
  assert.equal(wh.timeoutSec, 60, "timeoutSec 权威 clamp 至上限 60");
  assert.equal(wh.preset, "gotify");
  const low = normalizeConfig({ channels: [{ id: "webhook-2", type: "webhook", url: "https://x.example.com", enabled: true, timeoutSec: 0.4 }] }).channels[0];
  assert.equal(low.timeoutSec, 1, "timeoutSec 下限 clamp 至 1");
  assert.equal(low.auth, "none", "auth 缺省 none");
  // 保留键剔除 + 未知 string/number 透传
  const pv = normalizeConfig({ channels: [{ id: "webhook-3", type: "webhook", url: "https://x.example.com", enabled: true, auth_token: "smuggle", custom_arg: "v1" }] }).channels[0];
  assert.equal("auth_token" in pv, false, "webhook 保留键（凭据别名）剔除");
  assert.equal(pv.custom_arg, "v1", "未知 string 键透传");
  // 非法 URL → 丢弃
  assert.equal(normalizeConfig({ channels: [{ id: "webhook-4", type: "webhook", url: "ftp://x", enabled: true }] }).channels.length, 0, "非 http(s) URL 实例丢弃");
  // 跨类型 id 去重（首个胜出）
  const dup = normalizeConfig({ channels: [
    { id: "same-id", type: "webhook", url: "https://a.example.com", enabled: true },
    { id: "same-id", type: "bark", baseUrl: "https://b.example.com", deviceKey: "K", enabled: true },
  ] }).channels;
  assert.equal(dup.length, 1, "跨类型 id 去重");

  // validateSettings：混合 channels 合法；非法 auth 整组 400
  assert.equal(validateSettings({ channels: [
    { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "K", enabled: true },
    { id: "webhook-1", type: "webhook", url: "https://ntfy.sh/x", enabled: false, auth: "bearer", token: "tk" },
  ] }), null, "混合 bark+webhook 写入合法");
  const bad = validateSettings({ channels: [{ id: "webhook-1", type: "webhook", url: "https://x", enabled: true, auth: "oauth2" }] });
  assert.ok(bad && bad.key === "channels", "非法 auth → channels 400");
  const badUrl = validateSettings({ channels: [{ id: "webhook-1", type: "webhook", url: "https://u:p@x.example.com", enabled: true }] });
  assert.ok(badUrl && badUrl.key === "channels", "带凭据 URL → channels 400");

  // 掩码泛化：webhook token/password/headerValue 全掩码；bark deviceKey 照旧
  const view = redactConfigView({ channels: [
    { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "K-plain", enabled: true },
    { id: "webhook-1", type: "webhook", url: "https://x", enabled: true, auth: "basic", username: "u1", password: "pw-plain", token: "tk-plain", headerValue: "hv-plain" },
  ] });
  assert.equal(view.channels[0].deviceKey, SECRET_MASK, "bark deviceKey 掩码（回归）");
  assert.equal(view.channels[1].token, SECRET_MASK, "webhook token 掩码");
  assert.equal(view.channels[1].password, SECRET_MASK, "webhook password 掩码");
  assert.equal(view.channels[1].headerValue, SECRET_MASK, "webhook headerValue 掩码");
  assert.equal(view.channels[1].username, "u1", "username 非 secret 不掩码");

  // 掩码回填：webhook 多 secret 字段按 id+字段对齐回填；新实例带掩码拒绝
  const back = unmaskChannels(
    [{ id: "webhook-1", type: "webhook", url: "https://x", enabled: true, auth: "basic", username: "u2", password: SECRET_MASK, token: SECRET_MASK, headerValue: SECRET_MASK }],
    [{ id: "webhook-1", type: "webhook", url: "https://x", enabled: true, auth: "basic", username: "u1", password: "pw-orig", token: "tk-orig", headerValue: "hv-orig" }],
  );
  assert.ok(back.ok, "掩码回填受理");
  assert.equal(back.channels[0].password, "pw-orig", "password 回填原值");
  assert.equal(back.channels[0].token, "tk-orig", "token 回填原值");
  assert.equal(back.channels[0].headerValue, "hv-orig", "headerValue 回填原值");
  assert.equal(back.channels[0].username, "u2", "非 secret 字段不回填（保留提交值）");
  const missing = unmaskChannels(
    [{ id: "webhook-new", type: "webhook", url: "https://x", enabled: true, token: SECRET_MASK }],
    [],
  );
  assert.ok(!missing.ok, "新实例提交掩码 → 拒绝（掩码只允许表达未修改）");
  console.log("W2 webhook 配置契约/掩码泛化/写入校验: OK");
}
