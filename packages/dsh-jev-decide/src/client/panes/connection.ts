/**
 * dsh-jev-decide — 连接 tab（客户端专属，归 src/client/）。
 *
 * 要素（任务）：ENV 名输入 + 明文折叠二次确认 + 离线自检按钮 + 高级折叠；
 * Key 永不回显原文；autocomplete off；placeholder 禁真密钥示例。
 * 全部经 loopback 路由取数；失败态与掩码态（hasPlaintextKey 只显示“已配置”）都要渲染。
 * 渲染只用文本节点，不用 innerHTML；零 bare import。
 *
 * PUT 形状假设（缺口：宿主 PUT 契约未落地，主代理补齐后收紧）：
 * - ENV 与明文互斥：明文非空 → 体含 { apiKeyPlaintext } 且 connection 不带 apiKeyRef；
 *   否则体含 connection.apiKeyRef（空即省略，表示不改绑定）。
 * - 高级数与历史配额随同提交（connection.timeoutMs/maxConcurrency/truncBudget +
 *   history.perSession/totalSessions）；未知键 baseUrl 永不发送。
 */
import {
  APP_ROUTES,
  failureCategory,
  fetchTimeout,
  parseConfigPayload,
  validApiKeyRef,
} from "../api/interface.ts";
import type { JevConfigV1 } from "../api/interface.ts";
import {
  actionButton,
  badge,
  clear,
  el,
  errorLine,
  fold,
  noteLine,
  numberInput,
  okLine,
  textInput,
} from "../components/interface.ts";

export interface ConnectionHost {
  /** 卸载后 true（异步回包不再触 DOM）。 */
  readonly alive: () => boolean;
}

export function renderConnectionPane(host: ConnectionHost): HTMLElement {
  const root = el("div", { class: "dj-pane", dataset: { tab: "connection" } });

  const statusRow = el("div", { class: "dj-tools" });
  const statusBadge = badge("加载中…");
  statusRow.appendChild(statusBadge);
  root.appendChild(statusRow);

  const msgBox = el("div", { class: "dj-field" });
  root.appendChild(msgBox);
  const showMsg = (node: HTMLElement): void => {
    clear(msgBox);
    msgBox.appendChild(node);
  };

  // ---- ENV 名输入 ----
  const envField = el("div", { class: "dj-field" });
  envField.appendChild(el("label", { text: "ENV 变量名（apiKeyRef）" }));
  const envInput = textInput({ placeholder: "大写字母开头，如 JEV_API_KEY（留空不改）" });
  envInput.setAttribute("aria-label", "ENV 变量名");
  envInput.setAttribute("inputmode", "text");
  envField.appendChild(envInput);
  envField.appendChild(noteLine("规则：^[A-Z][A-Z0-9_]{1,63}$；与明文密钥互斥，只提交其一。"));
  root.appendChild(envField);

  // ---- 明文折叠（二次确认） ----
  const plainBody = el("div", { class: "dj-field" });
  const plainInput = textInput({
    type: "password",
    placeholder: "输入新的明文密钥以替换（留空不改）",
  });
  plainInput.setAttribute("aria-label", "明文密钥");
  plainBody.appendChild(plainInput);
  const confirmRow = el("label", { class: "dj-checkRow" });
  const confirmBox = document.createElement("input");
  confirmBox.type = "checkbox";
  confirmRow.appendChild(confirmBox);
  confirmRow.appendChild(
    document.createTextNode("我确认提交本次明文（仅本次请求，不回显、不入库原文）"),
  );
  plainBody.appendChild(confirmRow);
  plainBody.appendChild(
    noteLine("密钥原文永不回显；已配置仅显示“已配置”。占位符不含任何真密钥示例。"),
  );
  const plainFold = fold({ title: "输入明文密钥…", body: plainBody });
  root.appendChild(plainFold.root);

  // ---- 离线自检 ----
  const testRow = el("div", { class: "dj-tools" });
  const testBtn = actionButton("离线自检", "dj-btn dj-btnSmall");
  const testOut = el("span", { class: "dj-note", text: "" });
  testRow.appendChild(testBtn);
  testRow.appendChild(testOut);
  root.appendChild(testRow);
  testBtn.addEventListener("click", () => {
    if (!host.alive()) return;
    testBtn.disabled = true;
    testOut.textContent = "自检中…";
    void fetchTimeout(APP_ROUTES.testConnection, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
    })
      .then(async (res) => {
        if (!host.alive()) return;
        let category = "";
        try {
          const body: unknown = await res.json();
          const hit = failureCategory(res.status, body);
          // 门面无类别时回落 "http-<status>"：仅体带类别/错误/message 才展示括号。
          if (hit !== "http-" + res.status) category = hit;
        } catch {
          /* 非 JSON 即按状态码 */
        }
        if (res.ok) {
          testOut.textContent = category !== "" ? "自检通过（" + category + "）" : "自检通过";
        } else {
          testOut.textContent = "自检失败：" + (category !== "" ? category : "http-" + res.status);
        }
      })
      .catch((e: unknown) => {
        if (!host.alive()) return;
        testOut.textContent = "自检失败：" + (e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (host.alive()) testBtn.disabled = false;
      });
  });

  // ---- 高级折叠 ----
  const advBody = el("div", { class: "dj-field" });
  const timeoutInput = numberInput({ value: 8000, min: 1000, max: 120000, step: 500 });
  const concInput = numberInput({ value: 4, min: 1, max: 16, step: 1 });
  const truncInput = numberInput({ value: 32000, min: 1000, max: 200000, step: 1000 });
  const perSessionInput = numberInput({ value: 200, min: 10, max: 1000, step: 10 });
  const totalSessionsInput = numberInput({ value: 50, min: 1, max: 200, step: 1 });
  const advRows: Array<[string, HTMLInputElement, string]> = [
    ["请求超时 timeoutMs", timeoutInput, "默认 8000（毫秒，上限 120000）"],
    ["最大并发 maxConcurrency", concInput, "默认 4"],
    ["截断预算 truncBudget", truncInput, "默认 32000（字符）"],
    ["单会话历史 perSession", perSessionInput, "默认 200（上限 1000）"],
    ["总会话数 totalSessions", totalSessionsInput, "默认 50（上限 200）"],
  ];
  for (const [label, input, hint] of advRows) {
    const f = el("div", { class: "dj-field" });
    f.appendChild(el("label", { text: label }));
    f.appendChild(input);
    f.appendChild(noteLine(hint));
    advBody.appendChild(f);
  }
  const advFold = fold({ title: "高级…", body: advBody });
  root.appendChild(advFold.root);

  // ---- 保存 ----
  const foot = el("div", { class: "dj-foot" });
  const saveBtn = actionButton("保存", "dj-btn dj-btnPrimary");
  const retryBtn = actionButton("重试", "dj-btn dj-btnSmall");
  retryBtn.hidden = true;
  foot.appendChild(retryBtn);
  foot.appendChild(saveBtn);
  root.appendChild(foot);

  let snapshot: JevConfigV1 | null = null;

  const paintMask = (): void => {
    clear(statusRow);
    if (snapshot === null) {
      statusRow.appendChild(badge("未加载"));
      return;
    }
    const c = snapshot.connection;
    statusRow.appendChild(
      badge(
        c.hasPlaintextKey ? "密钥：已配置" : "密钥：未配置",
        c.hasPlaintextKey ? "dj-badgeOn" : "",
      ),
    );
    if (c.apiKeyRef !== undefined && c.apiKeyRef !== "") {
      statusRow.appendChild(badge("ENV：" + c.apiKeyRef));
    }
  };

  const load = (): void => {
    retryBtn.hidden = true;
    showMsg(noteLine("加载中…"));
    void fetchTimeout(APP_ROUTES.config, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!host.alive()) return;
        if (!res.ok) {
          let cat = "http-" + res.status;
          try {
            cat = failureCategory(res.status, await res.json());
          } catch {
            /* 非 JSON 即保持状态码类别 */
          }
          throw new Error(cat);
        }
        const payload: unknown = await res.json();
        const cfg = parseConfigPayload(payload);
        if (cfg === null) throw new Error("config-shape-unknown");
        snapshot = cfg;
        // 回填（Key 永不回显原文：明文框恒空；ENV 回填引用名）
        envInput.value = cfg.connection.apiKeyRef ?? "";
        plainInput.value = "";
        confirmBox.checked = false;
        timeoutInput.value = String(cfg.connection.timeoutMs);
        concInput.value = String(cfg.connection.maxConcurrency);
        truncInput.value = String(cfg.connection.truncBudget);
        perSessionInput.value = String(cfg.history.perSession);
        totalSessionsInput.value = String(cfg.history.totalSessions);
        paintMask();
        showMsg(noteLine("已加载配置 v1。明文框恒空：已配置仅显示“已配置”。"));
      })
      .catch((e: unknown) => {
        if (!host.alive()) return;
        snapshot = null;
        paintMask();
        clear(msgBox);
        msgBox.appendChild(errorLine("加载失败：" + (e instanceof Error ? e.message : String(e))));
        retryBtn.hidden = false;
      });
  };
  retryBtn.addEventListener("click", load);

  saveBtn.addEventListener("click", () => {
    if (!host.alive() || snapshot === null) return;
    const envName = envInput.value.trim();
    const plain = plainInput.value;
    // 互斥校验（D6：明文与存量 ENV 引用同时有值时显式阻断，不再静默偏向明文）
    if (plain !== "" && envName !== "") {
      showMsg(errorLine("明文与 ENV 引用互斥：请先清空 ENV 输入框（留空）再提交明文。"));
      return;
    }
    if (envName !== "" && !validApiKeyRef(envName)) {
      showMsg(errorLine("ENV 名非法：须满足 ^[A-Z][A-Z0-9_]{1,63}$（如 JEV_API_KEY）。"));
      return;
    }
    if (plain !== "" && !confirmBox.checked) {
      showMsg(errorLine("提交明文前需先勾选二次确认。"));
      return;
    }
    const timeoutMs = Number(timeoutInput.value);
    const maxConcurrency = Number(concInput.value);
    const truncBudget = Number(truncInput.value);
    const perSession = Number(perSessionInput.value);
    const totalSessions = Number(totalSessionsInput.value);
    if (
      ![timeoutMs, maxConcurrency, truncBudget, perSession, totalSessions].every((n) =>
        Number.isFinite(n),
      )
    ) {
      showMsg(errorLine("高级参数须为数字。"));
      return;
    }
    const body: Record<string, unknown> = {
      version: 1,
      connection: {
        timeoutMs,
        maxConcurrency,
        truncBudget,
        ...(plain !== "" ? {} : envName !== "" ? { apiKeyRef: envName } : {}),
      },
      // 预设原值回写（连接保存不碰开关位；去只读掩码位，未知键永不发送）
      presets: snapshot.presets.map((p) => ({
        id: p.id,
        enabled: p.enabled,
        automationCap: p.automationCap,
      })),
      history: { perSession, totalSessions },
      // S1-B：明文提交必带顶层 confirm:true（二次确认已勾选是前置校验；缺此键服务端恒 400）。
      ...(plain !== "" ? { apiKeyPlaintext: plain, confirm: true } : {}),
    };
    saveBtn.disabled = true;
    showMsg(noteLine("保存中…（明文仅本次提交，不回显）"));
    void fetchTimeout(APP_ROUTES.config, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!host.alive()) return;
        if (!res.ok) {
          let cat = "http-" + res.status;
          try {
            const b: unknown = await res.json();
            if (b !== null && typeof b === "object") {
              const rec = b as Record<string, unknown>;
              const nested = rec["error"];
              if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
                const nrec = nested as Record<string, unknown>;
                const v = nrec["category"] ?? nrec["errorCode"];
                if (typeof v === "string" && v.length > 0) cat = v;
              } else {
                const v = rec["category"] ?? rec["errorCode"] ?? rec["error"] ?? rec["code"];
                if (typeof v === "string" && v.length > 0) cat = v;
              }
            }
          } catch {
            /* 忽略 */
          }
          // 密钥形状 400 仅回类别：原文永不拼入文案
          throw new Error(cat);
        }
        // 保存后清空明文框并重载掩码态
        plainInput.value = "";
        confirmBox.checked = false;
        showMsg(okLine("已保存。重新加载掩码态…"));
        load();
      })
      .catch((e: unknown) => {
        if (!host.alive()) return;
        showMsg(errorLine("保存失败：" + (e instanceof Error ? e.message : String(e))));
      })
      .finally(() => {
        if (host.alive()) saveBtn.disabled = false;
      });
  });

  load();
  return root;
}
