/**
 * dsh-idle-archive — 会话闲置归档提醒（宿主端）。
 *
 * 职责：只做两件事——
 * 1. 配置与「拒绝提醒」静默期（snooze）的持久化（~/.dsh/dsh-idle-archive.json，
 *    宿主端单一事实源，多标签页共享、刷新不丢）；
 * 2. 给客户端提供 RPC 通道（/dsh-idle-archive）+ health 路由。
 *
 * 归档动作本身不在宿主做：客户端直接调用官方 ctx.workspaces.archiveSession
 * （workspace.archiveSession wire），宿主不重复实现领域逻辑。
 *
 * 安全：
 * - RPC 通道 authority: 'loopback'（仅回环来源可调）；
 * - health 路由 loopback 围栏（非回环 403 / 非 GET 405）；
 * - 状态文件原子写（tmp + rename）。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import z from "schemastery";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson } from "../../../shared/host-utils.js";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import type { PluginContext } from "../../../types/dsh.js";

export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson } from "../../../shared/host-utils.js";

// ---------------------------------------------------------------- 类型

/** 净化后的设置对象（与默认配置同构，新增键必须同步到 defaultSettings）。 */
export interface Settings {
  idleHours: number;
  snoozeHours: number;
  scanMinutes: number;
  enabled: boolean;
  maxRows: number;
}

/** 状态文件结构（配置 + snooze 静默表）。 */
export interface StateFile {
  settings: Settings;
  snoozed: Record<string, number>;
}

/** apply 配置（当前无外部配置键，保留扩展位）。 */
export interface IdleArchiveConfig {
  [key: string]: unknown;
}

/**
 * 插件设置面板的 schemastery schema（与 Settings/defaultSettings 同构）。
 * rc.7 起 settings.plugin.item 为 keyed 槽，插件需把命名空间注册进宿主 settings
 * 服务，configurable 面板才会分发本卡（宿主端经共享的 installSettingsNamespace
 * 注册命名空间，见 apply）。
 * 实测约束：schemastery 3.18 无 `.optional()`，不带 `.required()` 的字段默认可选；
 * 数值上限与 LIMITS 保持一致，越界仍由 sanitizeSettings 钳制兜底。
 */
export const Config = z.object({
  /** 闲置阈值：超过该小时数未对话的会话才提醒归档。 */
  idleHours: z.natural().max(24 * 365).default(72),
  /** 拒绝（暂不归档）后的静默小时数。 */
  snoozeHours: z.natural().max(24 * 30).default(24),
  /** 自动扫描间隔（分钟）。 */
  scanMinutes: z.natural().max(24 * 60).default(60),
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 单次弹窗最多列出候选数（超出部分下次扫描再提醒）。 */
  maxRows: z.natural().max(200).default(50),
});

/** connection 注入上下文的宽松接口（仅 RPC 通道所需的最小面，未知面 unknown 兜底）。 */
export interface ConnectionCtx {
  connection: {
    rpc: {
      handle(channel: string, h: unknown, opts: { authority?: string }): unknown;
    };
  };
  effect<T>(fn: () => T, label?: string): unknown;
  [key: string]: unknown;
}

/** 稳定的 cordis 插件名（与 patch id 一致）。 */
export const name = "dsh-idle-archive";

/** 需要的服务：webServer（health 路由）。 */
export const inject = ["webServer"];

/** RPC 通道（客户端 connection.rpc.call 同款）。 */
export const CHANNEL = "/dsh-idle-archive";

/** 与客户端共享的 health 路由（单一来源）。 */
export const ROUTES = {
  health: "/api/dsh-idle-archive/health",
};

/** 状态文件路径（测试可改 DSH_HOME 隔离）。 */
export function stateFile(): string {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "dsh-idle-archive.json");
}

/** 默认配置（新增键必须在这里给默认值，兼容老配置文件）。 */
export function defaultSettings(): Settings {
  return {
    /** 闲置阈值：超过该小时数未对话的会话才提醒归档。 */
    idleHours: 72,
    /** 拒绝（暂不归档）后的静默小时数。 */
    snoozeHours: 24,
    /** 自动扫描间隔（分钟）。 */
    scanMinutes: 60,
    /** 总开关。 */
    enabled: true,
    /** 单次弹窗最多列出候选数（超出部分下次扫描再提醒）。 */
    maxRows: 50,
  };
}

/** 数值范围约束（非法值回落默认），防手改配置文件破坏行为。 */
const LIMITS: Record<string, [number, number]> = {
  idleHours: [1, 24 * 365],
  snoozeHours: [1, 24 * 30],
  scanMinutes: [5, 24 * 60],
  maxRows: [1, 200],
};

/**
 * 合并并净化设置：只接受已知键，非法/越界值回落默认。
 * @param input - 客户端提交或配置文件里的设置对象。
 * @returns - 净化后的完整设置对象。
 */
export function sanitizeSettings(input: unknown): Settings {
  const base = defaultSettings();
  if (!input || typeof input !== "object") return base;
  const out = { ...base } as Settings & Record<string, unknown>;
  for (const key of Object.keys(LIMITS)) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const [min, max] = LIMITS[key];
      out[key] = Math.min(max, Math.max(min, Math.round(v)));
    }
  }
  if (typeof (input as Record<string, unknown>).enabled === "boolean") {
    out.enabled = (input as { enabled?: boolean }).enabled as boolean;
  }
  return out;
}

/** 读取状态：缺文件/坏 JSON 回落默认；顺带清掉已过期的 snooze 条目。 */
export async function readState(): Promise<StateFile> {
  const base: StateFile = { settings: defaultSettings(), snoozed: {} };
  try {
    let raw = await readFile(stateFile(), "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      base.settings = sanitizeSettings(j.settings);
      if (j.snoozed && typeof j.snoozed === "object" && !Array.isArray(j.snoozed)) {
        const now = Date.now();
        for (const [id, until] of Object.entries(j.snoozed)) {
          if (typeof id === "string" && id && typeof until === "number" && until > now) {
            base.snoozed[id] = until;
          }
        }
      }
    }
  } catch {
    // 缺文件/解析失败：回落默认（不覆盖写坏文件，等下次写入再修复）。
  }
  return base;
}

/** 原子写状态文件（tmp + rename）。 */
export async function writeState(state: StateFile): Promise<void> {
  const path = stateFile();
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------- rc.7 settings 桥

/**
 * rc.7 起「设置 → 插件」面板的 settings.plugin.item 槽改为 keyed，且只分发宿主
 * 已 serve 的命名空间。本参照 lan-proxy 的 installSettingsSection 模式注册
 * `dsh-idle-archive` 命名空间，使 configurable 面板能分发本插件卡片。
 * 数据仍以 RPC + 状态文件为单一事实源，此处仅做只读镜像：settings 命名空间被写入
 * 时写回状态文件，保证两处一致且无循环回写。
 */
let settingsStoreRead: (() => Settings) | undefined;

/** 把 settings 命名空间的当前值合并回状态文件（保留 snoozed；无变化则跳过）。 */
async function persistSettingsFromStore(): Promise<void> {
  if (!settingsStoreRead) return;
  const st = await readState();
  const settings = sanitizeSettings(settingsStoreRead());
  if (JSON.stringify(st.settings) === JSON.stringify(settings)) return;
  st.settings = settings;
  await writeState(st);
}

/** agents 服务（live agents；apply 时经 ctx.inject 注入，titles 回落用）。 */
let agentsService:
  | { list(): Array<{ session?: { id?: string; events?: unknown[] } }> }
  | undefined;

/**
 * sessionQuery 服务（live + 持久化会话统一读取；readTitle 折叠日志最新标题——
 * 旧会话（实例重启后）不在 live agents，必须走持久化数据源）。
 */
let sessionQueryService:
  | { readTitle(sessionId: string, signal?: unknown): Promise<{ title: string; [key: string]: unknown } | undefined> }
  | undefined;

/**
 * 从会话持久化日志提取标题（session/title 事件，与 GUI 会话列表同源）。
 * 列表快照的 title 依赖事件同步，闲置会话可能滞后为工作区名——弹窗展示前
 * 经 titles rpc 重新获取，保证准确。
 * @param agent - live agent 对象。
 * @returns 标题（无标题/新会话返回 undefined）。
 */
export function titleOfAgent(agent: { session?: { events?: unknown[] } } | undefined): string | undefined {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string; data?: { title?: unknown } } | undefined;
    if (event?.type === "session/title" && typeof event.data?.title === "string") {
      const title = event.data.title.trim();
      return title.length > 0 ? title : undefined;
    }
  }
  return undefined;
}

/** RPC 通道 handler：state / config / snooze / snoozeMany / clearSnooze / titles / health。 */
export async function handler(endpoint: string, payload: Record<string, unknown> | undefined): Promise<unknown> {
  try {
    switch (endpoint) {
      case "health":
        return { ok: true, value: { ok: true, plugin: "dsh-idle-archive" } };
      case "state": {
        const st = await readState();
        return { ok: true, value: { settings: st.settings, snoozed: st.snoozed } };
      }
      case "config": {
        const st = await readState();
        const settings = sanitizeSettings(payload && payload.settings);
        st.settings = settings;
        await writeState(st);
        return { ok: true, value: { settings } };
      }
      case "snooze": {
        const id = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
        const hours = payload && typeof payload === "object" && Number.isFinite(payload.hours) ? (payload.hours as number) : 24;
        if (!id) return { ok: false, error: { code: "bad-args", details: "sessionId required" } };
        const st = await readState();
        st.snoozed[id] = Date.now() + Math.min(24 * 30, Math.max(1, Math.round(hours))) * 3600_000;
        await writeState(st);
        return { ok: true, value: { snoozed: st.snoozed } };
      }
      case "snoozeMany": {
        const ids = Array.isArray(payload && payload.sessionIds) ? (payload as Record<string, unknown>).sessionIds as unknown[] : [];
        const hours = payload && typeof payload === "object" && Number.isFinite(payload.hours) ? (payload.hours as number) : 24;
        if (ids.length === 0) return { ok: false, error: { code: "bad-args", details: "sessionIds required" } };
        const st = await readState();
        const until = Date.now() + Math.min(24 * 30, Math.max(1, Math.round(hours))) * 3600_000;
        for (const id of ids) {
          if (typeof id === "string" && id) st.snoozed[id] = until;
        }
        await writeState(st);
        return { ok: true, value: { snoozed: st.snoozed } };
      }
      case "clearSnooze": {
        const id = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!id) return { ok: false, error: { code: "bad-args", details: "sessionId required" } };
        const st = await readState();
        delete st.snoozed[id];
        await writeState(st);
        return { ok: true, value: { snoozed: st.snoozed } };
      }
      case "titles": {
        const ids = Array.isArray(payload && payload.sessionIds) ? (payload as Record<string, unknown>).sessionIds as unknown[] : [];
        const wanted = new Set(ids.filter((x): x is string => typeof x === "string"));
        const titles: Record<string, string> = {};
        // 主数据源：sessionQuery.readTitle（live 优先 + 持久化日志折叠——覆盖
        // 实例重启后的旧会话，标题与 GUI 会话列表同源）。
        if (sessionQueryService && wanted.size > 0) {
          for (const id of wanted) {
            try {
              const snapshot = await sessionQueryService.readTitle(id);
              const title = snapshot?.title;
              if (typeof title === "string" && title !== "") titles[id] = title;
            } catch {
              // 单会话读取失败跳过（回落 agents）
            }
          }
        }
        // 回落：live agents（sessionQuery 服务缺失时，从 events 提取）。
        if (agentsService && wanted.size > 0) {
          for (const agent of agentsService.list()) {
            const id = agent?.session?.id;
            if (typeof id !== "string" || !wanted.has(id) || titles[id] !== undefined) continue;
            const title = titleOfAgent(agent);
            if (title !== undefined) titles[id] = title;
          }
        }
        return { ok: true, value: { titles } };
      }
      default:
        return { ok: false, error: { code: "unknown", details: String(endpoint) } };
    }
  } catch (e: unknown) {
    return { ok: false, error: { code: "error", details: String(((e as { message?: unknown } | null | undefined)?.message) || e) } };
  }
}

/** 薄壳 apply：只做登记；清理全部进 effect 返回的 disposer。 */
export function apply(ctx: PluginContext, config: IdleArchiveConfig = {}): void {
  // RPC 通道（客户端配置/静默期读写；authority: loopback 防非回环调用）。
  // ctx.inject 未在 types/dsh.d.ts 声明，故此处按实际调用面收紧为最小接口（unknown 兜底）。
  (ctx.inject as (services: string[], fn: (c: ConnectionCtx) => void) => void)(
    ["connection", "agents", "sessionQuery"],
    (connectionCtx) => {
      agentsService = (connectionCtx as unknown as { agents?: typeof agentsService }).agents;
      sessionQueryService = (connectionCtx as unknown as { sessionQuery?: typeof sessionQueryService }).sessionQuery;
      connectionCtx.effect(
        () => connectionCtx.connection.rpc.handle(CHANNEL, handler, { authority: "loopback" }),
        "dsh-idle-archive: rpc"
      );
    }
  );

  // health 路由（loopback 围栏 + GET 限定）。
  const routeDisposer = ctx.webServer.register({
    path: ROUTES.health,
    kind: "exact",
    handler(req, res) {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed: " + req.method });
      writeJson(res, 200, { ok: true, plugin: "dsh-idle-archive" });
    },
  });

  // GUI 设置面板（设置 → 插件 → dsh-idle-archive）：注册 rc.7 settings 命名空间，
  // 使 configurable 面板 serve `dsh-idle-archive` 并分发本卡。
  // 说明：不用官方 @deepseek-ai/dsh-settings（插件运行时解析不到，会静默失败），
  // 改用共享的服务面注入 installSettingsNamespace，等值复刻官方 installSettingsSection。
  // 设置值仍以 RPC/状态文件为单一事实源，命名空间做只读镜像（见 persistSettingsFromStore）。
  installSettingsNamespace(ctx, "dsh-idle-archive", Config, config ?? {}, {
    setSource: (source) => {
      settingsStoreRead = source as () => Settings;
    },
    onChange: () => {
      void persistSettingsFromStore();
    },
  });

  // ⚠️ 清理必须写在 ctx.effect 返回的 disposer 里（fn 主体 = 注册完立刻注销）。
  ctx.effect(
    () => () => {
      try {
        routeDisposer();
      } catch {
        // 忽略
      }
    },
    "dsh-idle-archive"
  );
}
