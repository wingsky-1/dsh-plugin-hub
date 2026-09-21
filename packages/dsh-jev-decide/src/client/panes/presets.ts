/**
 * dsh-jev-decide — 模板库 tab（客户端专属，归 src/client/）。
 *
 * 要素（任务 + 主代理裁决）：5 预设开关 + 阈值微调（automationCap 三档 0|1|2，
 * 0=none 仅人工，1=low，2=high；绝非百分比滑杆）+ 导出 JSON，无导入。
 * 经 loopback 路由取数（GET /presets 目录 + GET /config 开关位）；失败态都要渲染。
 * 渲染只用文本节点；零 bare import。frozen 模板 id 见共享 FROZEN_PRESETS
 *（general/secret-leak/plan-review/risk-check/custom），此处以目录为准动态渲染。
 *
 * 保存假设（缺口：宿主 PUT 合并语义未落地，主代理补齐后收紧）：
 * 携带快照中的 connection/history 原值回写（去 hasPlaintextKey 只读位），
 * 仅替换 presets 数组，避免全量 PUT 误清连接绑定。未知键永不发送。
 */
import {
  APP_ROUTES,
  capLabel,
  failureCategory,
  fetchTimeout,
  normalizeCap,
  parseConfigPayload,
  parsePresetsPayload,
} from "../api/interface.ts";
import type {
  AutomationCap,
  JevConfigV1,
  JevPresetConfigEntry,
  JevPresetInfo,
} from "../api/interface.ts";
import {
  actionButton,
  badge,
  clear,
  el,
  errorLine,
  noteLine,
  okLine,
} from "../components/interface.ts";

export interface PresetsHost {
  readonly alive: () => boolean;
}

interface RowState {
  readonly id: string;
  readonly templateVersion?: number;
  enabled: boolean;
  cap: AutomationCap;
  readonly desc?: string;
}

export function renderPresetsPane(host: PresetsHost): HTMLElement {
  const root = el("div", { class: "dj-pane", dataset: { tab: "presets" } });
  const tools = el("div", { class: "dj-tools" });
  const countBadge = badge("加载中…");
  tools.appendChild(countBadge);
  root.appendChild(tools);

  const msgBox = el("div", { class: "dj-field" });
  root.appendChild(msgBox);
  const showMsg = (node: HTMLElement): void => {
    clear(msgBox);
    msgBox.appendChild(node);
  };

  const list = el("div", { class: "dj-field" });
  root.appendChild(list);

  const foot = el("div", { class: "dj-foot" });
  const retryBtn = actionButton("重试", "dj-btn dj-btnSmall");
  const exportBtn = actionButton("导出 JSON", "dj-btn dj-btnSmall");
  const saveBtn = actionButton("保存", "dj-btn dj-btnPrimary");
  retryBtn.hidden = true;
  exportBtn.disabled = true;
  saveBtn.disabled = true;
  foot.appendChild(retryBtn);
  foot.appendChild(exportBtn);
  foot.appendChild(saveBtn);
  root.appendChild(foot);
  root.appendChild(noteLine("无导入按钮：模板库只出不进。secret-leak 默认关闭（frozen 模板）。"));

  let snapshot: JevConfigV1 | null = null;
  let rows: RowState[] = [];

  const paintRows = (): void => {
    clear(list);
    if (rows.length === 0) {
      list.appendChild(noteLine("暂无预设。"));
      return;
    }
    for (const row of rows) {
      const card = el("div", { class: "dj-preset" });
      const head = el("div", { class: "dj-presetHead" });
      head.appendChild(el("span", { class: "dj-presetId", text: row.id }));
      const sw = el("label", { class: "dj-switch" });
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = row.enabled;
      box.setAttribute("role", "switch");
      box.setAttribute("aria-label", "启用预设 " + row.id);
      const swText = document.createTextNode(row.enabled ? "已启用" : "已关闭");
      box.addEventListener("change", () => {
        row.enabled = box.checked;
        swText.data = row.enabled ? "已启用" : "已关闭";
      });
      sw.appendChild(box);
      sw.appendChild(swText);
      head.appendChild(sw);
      card.appendChild(head);
      if (row.templateVersion !== undefined) {
        card.appendChild(noteLine("模板版本 v" + row.templateVersion + "（frozen，恒为 1）"));
      }
      if (row.desc !== undefined && row.desc !== "") {
        card.appendChild(noteLine(row.desc));
      }
      // 阈值微调：三档下拉（0=none/1=low/2=high），非百分比
      const capRow = el("div", { class: "dj-rangeRow" });
      capRow.appendChild(el("label", { text: "自动化上限" }));
      const sel = document.createElement("select");
      sel.className = "dj-select";
      sel.autocomplete = "off";
      sel.setAttribute("aria-label", "自动化上限 " + row.id);
      const opts: Array<{ v: AutomationCap; t: string }> = [
        { v: 0, t: "none（仅人工）" },
        { v: 1, t: "low" },
        { v: 2, t: "high" },
      ];
      for (const o of opts) {
        const op = document.createElement("option");
        op.value = String(o.v);
        op.textContent = o.t;
        if (row.cap === o.v) op.selected = true;
        sel.appendChild(op);
      }
      sel.addEventListener("change", () => {
        row.cap = normalizeCap(Number(sel.value));
      });
      capRow.appendChild(sel);
      capRow.appendChild(el("span", { class: "dj-rangeVal", text: capLabel(row.cap) }));
      sel.addEventListener("change", () => {
        const valEl = capRow.querySelector(".dj-rangeVal");
        if (valEl !== null) valEl.textContent = capLabel(row.cap);
      });
      card.appendChild(capRow);
      list.appendChild(card);
    }
  };

  const load = (): void => {
    retryBtn.hidden = true;
    exportBtn.disabled = true;
    saveBtn.disabled = true;
    showMsg(noteLine("加载中…"));
    void Promise.all([
      fetchTimeout(APP_ROUTES.presets, { headers: { accept: "application/json" } }).then(
        async (res) => {
          if (!res.ok) throw new Error("presets-http-" + res.status);
          return parsePresetsPayload(await res.json());
        },
      ),
      fetchTimeout(APP_ROUTES.config, { headers: { accept: "application/json" } }).then(
        async (res) => {
          if (!res.ok) throw new Error("config-http-" + res.status);
          const cfg = parseConfigPayload(await res.json());
          if (cfg === null) throw new Error("config-shape-unknown");
          return cfg;
        },
      ),
    ])
      .then(([infos, cfg]) => {
        if (!host.alive()) return;
        snapshot = cfg;
        const byCfg = new Map<string, JevPresetConfigEntry>();
        for (const p of cfg.presets) byCfg.set(p.id, p);
        rows = [];
        const infosById = new Map<string, JevPresetInfo>();
        for (const i of infos) infosById.set(i.id, i);
        const ids = infos.length > 0 ? infos.map((i) => i.id) : cfg.presets.map((p) => p.id);
        for (const id of ids) {
          const info = infosById.get(id);
          const cfgRow = byCfg.get(id);
          rows.push({
            id,
            templateVersion: info?.templateVersion,
            enabled: cfgRow?.enabled ?? false,
            cap: normalizeCap(cfgRow?.automationCap ?? 0),
            desc: info?.description ?? info?.label,
          });
        }
        clear(tools);
        tools.appendChild(badge("预设 " + rows.length + " 个"));
        paintRows();
        exportBtn.disabled = false;
        saveBtn.disabled = false;
        showMsg(
          noteLine("目录与开关位已合并。阈值微调即 automationCap 三档（0=none/1=low/2=high）。"),
        );
      })
      .catch((e: unknown) => {
        if (!host.alive()) return;
        snapshot = null;
        rows = [];
        paintRows();
        clear(tools);
        tools.appendChild(badge("加载失败"));
        clear(msgBox);
        msgBox.appendChild(errorLine("加载失败：" + (e instanceof Error ? e.message : String(e))));
        retryBtn.hidden = false;
      });
  };
  retryBtn.addEventListener("click", load);

  exportBtn.addEventListener("click", () => {
    if (!host.alive() || rows.length === 0) return;
    const doc = {
      plugin: "dsh-jev-decide",
      version: 1 as const,
      exportedAt: Date.now(),
      presets: rows.map((r) => ({
        id: r.id,
        enabled: r.enabled,
        automationCap: r.cap,
        ...(r.templateVersion !== undefined ? { templateVersion: r.templateVersion } : {}),
      })),
    };
    try {
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "dsh-jev-decide-presets.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showMsg(okLine("已导出 " + rows.length + " 个预设（JSON 下载）。"));
    } catch (e: unknown) {
      showMsg(errorLine("导出失败：" + (e instanceof Error ? e.message : String(e))));
    }
  });

  saveBtn.addEventListener("click", () => {
    if (!host.alive() || snapshot === null) return;
    const presets = rows.map((r) => ({ id: r.id, enabled: r.enabled, automationCap: r.cap }));
    const conn = snapshot.connection;
    const body: Record<string, unknown> = {
      version: 1,
      connection: {
        timeoutMs: conn.timeoutMs,
        maxConcurrency: conn.maxConcurrency,
        truncBudget: conn.truncBudget,
        ...(conn.apiKeyRef !== undefined && conn.apiKeyRef !== ""
          ? { apiKeyRef: conn.apiKeyRef }
          : {}),
      },
      presets,
      history: {
        perSession: snapshot.history.perSession,
        totalSessions: snapshot.history.totalSessions,
      },
    };
    saveBtn.disabled = true;
    showMsg(noteLine("保存中…"));
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
            cat = failureCategory(res.status, await res.json());
          } catch {
            /* 非 JSON 即保持状态码类别 */
          }
          throw new Error(cat);
        }
        showMsg(okLine("已保存 " + presets.length + " 个预设开关与阈值。"));
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
