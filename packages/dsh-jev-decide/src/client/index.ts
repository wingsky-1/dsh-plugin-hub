/**
 * dsh-jev-decide — 浏览器端（自包含干净模块）。
 *
 * 行为：在「设置 → 插件」面板渲染 dsh-jev-decide 设置卡（settings.plugin.item
 * 插槽）：三 tab——连接（ENV 名输入 + 明文折叠二次确认 + 离线自检按钮 + 高级折叠）/
 * 模板库（5 预设开关 + 阈值微调 automationCap 三档 + 导出 JSON，无导入）/
 * 历史（独立 tab：工作目录下拉 + 会话下拉过滤，条目倒序含概率条 + tier + 截断徽标 +
 * 错误行，会话级清空仅 DELETE 单会话）。全部经 loopback 路由取数；失败态与掩码态
 *（hasPlaintextKey 只显示“已配置”）都要渲染。
 *
 * 干净模块：只 export function apply + export const inject；契约外壳由
 * scripts/build/build-client.ts 统一生成——源码不写任何 loader 痕迹。
 * 样式独立 style.css，经 .css text-loader 构建期内联。零 bare import
 *（不用 React/dompurify；净化只用宿主已净化数据 + 文本节点渲染）。
 * 卸载清理进 ctx.effect disposer。原始密钥永不入库，Key 永不回显原文。
 */
import STYLE from "./style.css";
import { ensureStyle } from "../../../../shared/client/ensure-style.js";
import { APP_ROUTES, fetchTimeout } from "./api/interface.ts";
import { renderConnectionPane, renderHistoryPane, renderPresetsPane } from "./panes/interface.ts";
import { badge, el } from "./components/interface.ts";

const STYLE_ID = "dsh-jev-decide-style";
const CSS_VERSION = "1";

/** 浏览器端上下文窄面（实际使用的面：slots + effect；与 inject 对齐）。 */
interface ClientContext {
  readonly slots?: unknown;
  get?: (name: string) => unknown;
  effect: (execute: () => () => void, label?: string) => unknown;
}

/** 宿主插槽读形态（本包只用 settings.plugin.item 的 inject/register）。 */
interface SlotsView {
  inject: (name: string, setup: () => unknown) => unknown;
  register: (item: Record<string, unknown>, render: () => unknown) => unknown;
}

function readSlots(ctx: ClientContext): SlotsView | null {
  const direct = ctx.slots as SlotsView | null | undefined;
  if (direct !== null && direct !== undefined && typeof direct.inject === "function") return direct;
  try {
    if (typeof ctx.get === "function") {
      const via = ctx.get("slots") as SlotsView | null | undefined;
      if (via !== null && via !== undefined && typeof via.inject === "function") return via;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

type TabKey = "connection" | "presets" | "history";

const TABS: Array<{ readonly key: TabKey; readonly label: string }> = [
  { key: "connection", label: "连接" },
  { key: "presets", label: "模板库" },
  { key: "history", label: "历史" },
];

/** 三 tab 设置卡（纯 DOM；文本节点渲染，无 innerHTML）。 */
function createCard(host: { readonly alive: () => boolean }): HTMLElement {
  const card = el("section", { class: "dj-card", dataset: { plugin: "dsh-jev-decide" } });
  card.setAttribute("autocomplete", "off");

  const head = el("div", { class: "dj-head" });
  const headText = el("div", { class: "dj-headText" });
  headText.appendChild(el("div", { class: "dj-name", text: "JEV 决策（dsh-jev-decide）" }));
  headText.appendChild(
    el("div", { class: "dj-desc", text: "连接 / 模板库 / 历史：密钥掩码显示，原文永不回显。" }),
  );
  head.appendChild(headText);
  const healthBadge = badge("自检中…");
  head.appendChild(healthBadge);
  card.appendChild(head);

  const tabBar = el("div", { class: "dj-tabs", role: "group", "aria-label": "JEV 决策设置" });
  const body = el("div", { class: "dj-body" });
  card.appendChild(tabBar);
  card.appendChild(body);

  const panes = new Map<TabKey, HTMLElement>();
  const built = new Set<TabKey>();
  let active: TabKey = "connection";
  const buttons = new Map<TabKey, HTMLButtonElement>();

  const ensurePane = (key: TabKey): HTMLElement => {
    const cached = panes.get(key);
    if (cached !== undefined) return cached;
    const paneHost = { alive: host.alive };
    let node: HTMLElement;
    if (key === "connection") node = renderConnectionPane(paneHost);
    else if (key === "presets") node = renderPresetsPane(paneHost);
    else node = renderHistoryPane(paneHost);
    panes.set(key, node);
    body.appendChild(node);
    return node;
  };

  const paint = (): void => {
    for (const t of TABS) {
      const btn = buttons.get(t.key);
      if (btn !== undefined) {
        if (t.key === active) btn.classList.add("dj-tabActive");
        else btn.classList.remove("dj-tabActive");
        btn.setAttribute("aria-selected", t.key === active ? "true" : "false");
      }
      if (built.has(t.key)) {
        const pane = panes.get(t.key);
        if (pane !== undefined) pane.hidden = t.key !== active;
      }
    }
  };

  for (const t of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dj-tab";
    btn.textContent = t.label;
    btn.setAttribute("aria-selected", t.key === active ? "true" : "false");
    btn.addEventListener("click", () => {
      active = t.key;
      if (!built.has(t.key)) {
        built.add(t.key);
        ensurePane(t.key);
      }
      paint();
    });
    buttons.set(t.key, btn);
    tabBar.appendChild(btn);
  }

  built.add("connection");
  ensurePane("connection");
  paint();

  void fetchTimeout(APP_ROUTES.health, { headers: { accept: "application/json" } })
    .then((res) => {
      if (!host.alive()) return;
      healthBadge.textContent = res.ok ? "服务可用" : "服务异常 " + res.status;
      healthBadge.classList.add(res.ok ? "dj-statusOk" : "dj-statusErr");
    })
    .catch(() => {
      if (!host.alive()) return;
      healthBadge.textContent = "服务不可达";
      healthBadge.classList.add("dj-statusErr");
    });

  return card;
}

export function apply(ctx: ClientContext): void {
  try {
    const slots = readSlots(ctx);
    if (slots === null) {
      console.warn("[dsh-jev-decide] 缺少 slots 服务，设置卡未挂载");
      return;
    }
    const disposeStyle = ensureStyle({ id: STYLE_ID, cssText: STYLE, version: CSS_VERSION });
    let disposed = false;
    const alive = (): boolean => !disposed;
    const card = createCard({ alive });

    let disposeSlot: (() => void) | null = null;
    try {
      const injected = slots.inject("settings.plugin.item", function () {
        return slots.register(
          {
            name: "settings.plugin.item",
            id: "dsh-jev-decide",
            key: "dsh-jev-decide",
            order: 50,
          },
          function () {
            return card;
          },
        );
      });
      if (typeof injected === "function") disposeSlot = injected as () => void;
    } catch (e) {
      console.warn("[dsh-jev-decide] 设置卡注册失败：", e);
    }

    ctx.effect(function () {
      return function () {
        disposed = true;
        try {
          if (disposeSlot !== null) disposeSlot();
        } catch {
          /* 卸载期静默 */
        }
        try {
          disposeStyle();
        } catch {
          /* 卸载期静默 */
        }
        try {
          if (card.parentNode !== null) card.parentNode.removeChild(card);
        } catch {
          /* 卸载期静默 */
        }
      };
    }, "dsh-jev-decide");
  } catch (e) {
    console.warn("[dsh-jev-decide] 挂载失败：", e);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 wrapper 装配（零依赖干净模块） ----
export const inject: string[] = ["slots"];
