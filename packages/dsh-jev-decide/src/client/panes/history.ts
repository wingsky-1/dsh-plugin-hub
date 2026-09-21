/**
 * dsh-jev-decide — 历史 tab（独立 tab；客户端专属，归 src/client/）。
 *
 * 要素（任务）：工作目录下拉 + 会话下拉过滤，条目倒序含概率条 + tier + 截断徽标 +
 * 错误行，会话级清空按钮仅调 DELETE 单会话。
 * 全部经 loopback 路由取数；失败态都要渲染。渲染只用文本节点；零 bare import。
 * 过滤区默认收起（#940：一 tab 一主焦点；历史过滤为次焦点，独立收缩）。
 * 概率条细条 + 阈值线 + 数字（禁重色块；无图表库，手写 div）。
 */
import {
  APP_ROUTES,
  failureCategory,
  fetchTimeout,
  parseHistoryPayload,
} from "../api/interface.ts";
import type { JevHistoryEntry } from "../api/interface.ts";
import {
  actionButton,
  badge,
  clear,
  el,
  errorLine,
  fold,
  fmtTime,
  noteLine,
  probRow,
  shortId,
  tierBadge,
} from "../components/interface.ts";

export interface HistoryHost {
  readonly alive: () => boolean;
}

const PAGE_LIMIT = 200;

function entryNode(entry: JevHistoryEntry): HTMLElement {
  const li = el("li", { class: "dj-histItem" });
  const head = el("div", { class: "dj-histHead" });
  head.appendChild(el("span", { class: "dj-histTime", text: fmtTime(entry.ts) }));
  if (entry.rootDisplay !== "") head.appendChild(badge(entry.rootDisplay));
  head.appendChild(badge(shortId(entry.sessionId)));
  if (entry.presetId !== "")
    head.appendChild(
      badge(entry.presetId + (entry.templateVersion > 0 ? " v" + entry.templateVersion : "")),
    );
  head.appendChild(badge(entry.lang));
  if (entry.truncated) head.appendChild(badge("截断", "dj-badgeWarn"));
  head.appendChild(tierBadge(entry.tier));
  li.appendChild(head);
  if (entry.snippetRedacted !== "") {
    li.appendChild(el("div", { class: "dj-histSnippet", text: entry.snippetRedacted }));
  }
  li.appendChild(probRow(entry));
  const meta = el("div", { class: "dj-meta" });
  const parts: string[] = [];
  if (entry.resultKind !== "") parts.push(entry.resultKind);
  if (entry.choice !== undefined && entry.choice !== "") parts.push("choice=" + entry.choice);
  parts.push("orig=" + entry.originalLength);
  parts.push(entry.automation);
  parts.push(entry.provider);
  parts.push(entry.latencyMs + "ms");
  meta.textContent = parts.join(" · ");
  li.appendChild(meta);
  if (entry.errorCode !== undefined && entry.errorCode !== "") {
    li.appendChild(el("div", { class: "dj-errLine", text: "错误：" + entry.errorCode }));
  }
  return li;
}

export function renderHistoryPane(host: HistoryHost): HTMLElement {
  const root = el("div", { class: "dj-pane", dataset: { tab: "history" } });

  // 过滤区默认收起（#940）
  const filterBody = el("div", { class: "dj-filters" });
  const rootField = el("div", { class: "dj-field" });
  rootField.appendChild(el("label", { text: "工作目录" }));
  const rootSel = document.createElement("select");
  rootSel.className = "dj-select";
  rootSel.autocomplete = "off";
  rootSel.setAttribute("aria-label", "工作目录过滤");
  rootField.appendChild(rootSel);
  const sessField = el("div", { class: "dj-field" });
  sessField.appendChild(el("label", { text: "会话" }));
  const sessSel = document.createElement("select");
  sessSel.className = "dj-select";
  sessSel.autocomplete = "off";
  sessSel.setAttribute("aria-label", "会话过滤");
  sessField.appendChild(sessSel);
  filterBody.appendChild(rootField);
  filterBody.appendChild(sessField);
  const filterFold = fold({ title: "过滤…", body: filterBody });
  root.appendChild(filterFold.root);

  const tools = el("div", { class: "dj-tools" });
  const countBadge = badge("未加载");
  const refreshBtn = actionButton("刷新", "dj-btn dj-btnSmall");
  const clearBtn = actionButton("清空本会话", "dj-btn dj-btnSmall dj-btnDanger");
  clearBtn.disabled = true;
  clearBtn.title = "仅清空当前选中会话（DELETE 单会话），无批量清空";
  tools.appendChild(countBadge);
  tools.appendChild(refreshBtn);
  tools.appendChild(clearBtn);
  root.appendChild(tools);

  const msgBox = el("div", { class: "dj-field" });
  root.appendChild(msgBox);
  const showMsg = (node: HTMLElement): void => {
    clear(msgBox);
    msgBox.appendChild(node);
  };

  const list = el("ul", { class: "dj-hist" });
  root.appendChild(list);

  let armed = false;
  const disarm = (): void => {
    armed = false;
    clearBtn.textContent = "清空本会话";
  };

  const paintOptions = (entries: JevHistoryEntry[], keepSel: boolean): void => {
    const keepRoot = keepSel ? rootSel.value : "";
    const keepSess = keepSel ? sessSel.value : "";
    clear(rootSel);
    clear(sessSel);
    const allR = document.createElement("option");
    allR.value = "";
    allR.textContent = "全部工作目录";
    rootSel.appendChild(allR);
    const allS = document.createElement("option");
    allS.value = "";
    allS.textContent = "全部会话";
    sessSel.appendChild(allS);
    const roots = new Map<string, string>();
    const sessions = new Set<string>();
    for (const e of entries) {
      if (e.rootDisplay !== "" && !roots.has(e.rootDisplay)) roots.set(e.rootDisplay, e.rootHash);
      if (e.sessionId !== "") sessions.add(e.sessionId);
    }
    for (const name of [...roots.keys()].sort()) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      rootSel.appendChild(o);
    }
    for (const id of [...sessions].sort()) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = shortId(id, 12) + (id.length > 12 ? "…" : "");
      o.title = id;
      sessSel.appendChild(o);
    }
    if (keepSel) {
      rootSel.value = keepRoot;
      sessSel.value = keepSess;
    }
  };

  const currentFilters = (): { root: string; sessionId: string } => ({
    root: rootSel.value ?? "",
    sessionId: sessSel.value ?? "",
  });

  const load = (): void => {
    disarm();
    clearBtn.disabled = true;
    showMsg(noteLine("加载中…"));
    const f = currentFilters();
    const q = new URLSearchParams();
    if (f.root !== "") q.set("root", f.root);
    if (f.sessionId !== "") q.set("sessionId", f.sessionId);
    q.set("limit", String(PAGE_LIMIT));
    const url = APP_ROUTES.history + "?" + q.toString();
    void fetchTimeout(url, { headers: { accept: "application/json" } })
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
        const entries = parseHistoryPayload(await res.json());
        // 条目倒序（ts 降序；同 ts 保持服务端次序）
        entries.sort((a, b) => b.ts - a.ts);
        paintOptions(entries, true);
        clear(list);
        if (entries.length === 0) {
          list.appendChild(el("div", { class: "dj-note", text: "暂无历史。" }));
        } else {
          for (const e of entries) list.appendChild(entryNode(e));
        }
        clear(tools);
        tools.appendChild(badge("共 " + entries.length + " 条"));
        tools.appendChild(refreshBtn);
        tools.appendChild(clearBtn);
        // 会话级清空仅当选中单会话时可用（仅调 DELETE 单会话）
        clearBtn.disabled = currentFilters().sessionId === "";
        showMsg(noteLine("倒序排列（含概率条 + tier + 截断徽标 + 错误行）。"));
      })
      .catch((e: unknown) => {
        if (!host.alive()) return;
        clear(list);
        clear(tools);
        tools.appendChild(badge("加载失败"));
        tools.appendChild(refreshBtn);
        tools.appendChild(clearBtn);
        clear(msgBox);
        const retry = actionButton("重试", "dj-btn dj-btnSmall");
        retry.addEventListener("click", load);
        msgBox.appendChild(errorLine("加载失败：" + (e instanceof Error ? e.message : String(e))));
        msgBox.appendChild(retry);
      });
  };

  rootSel.addEventListener("change", () => {
    disarm();
    load();
  });
  sessSel.addEventListener("change", () => {
    disarm();
    load();
  });
  refreshBtn.addEventListener("click", load);

  clearBtn.addEventListener("click", () => {
    if (!host.alive()) return;
    const f = currentFilters();
    if (f.sessionId === "") return;
    if (!armed) {
      armed = true;
      clearBtn.textContent = "确认清空本会话？";
      showMsg(noteLine("再次点击确认清空当前会话历史（仅单会话 DELETE）。"));
      return;
    }
    clearBtn.disabled = true;
    showMsg(noteLine("清空中…（仅单会话）"));
    const q = new URLSearchParams();
    if (f.root !== "") q.set("root", f.root);
    q.set("sessionId", f.sessionId);
    void fetchTimeout(APP_ROUTES.history + "?" + q.toString(), {
      method: "DELETE",
      headers: { accept: "application/json" },
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
        // D2：读取 DELETE 返回的 deleted，为 false 时显失败态，禁报已清空。
        try {
          const b: unknown = await res.json();
          if (
            b !== null &&
            typeof b === "object" &&
            (b as Record<string, unknown>)["deleted"] === false
          ) {
            throw new Error("delete-not-confirmed");
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.message === "delete-not-confirmed") throw e;
          // 空体/非 JSON 视为已删（无反证）；解析失败不吞 delete-not-confirmed。
        }
        disarm();
        showMsg(noteLine("已清空本会话。重新加载…"));
        load();
      })
      .catch((e: unknown) => {
        if (!host.alive()) return;
        disarm();
        showMsg(errorLine("清空失败：" + (e instanceof Error ? e.message : String(e))));
      })
      .finally(() => {
        if (host.alive()) clearBtn.disabled = currentFilters().sessionId === "";
      });
  });

  load();
  return root;
}
