/**
 * dsh-notifier — 服务器侧逻辑：HTTP 路由（loopback 围栏 + 方法白名单）。
 *
 * ROUTES 是与客户端共享的路由常量（smoke 断言两端一致）；路由经 buildRoutes
 * (deps) 纯组装——deps 由 index.ts 装配层注入，本文件自身不持有跨请求状态
 * 以外的生命周期职责。配置保存经 applyConfigPatch 纯函数（独立导出供 smoke
 * 单测）；SSE 与系统通知通道见同目录 sse-bus.ts / system-notifier.ts。
 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { errorMessage, guardLoopbackMethod, readBody, sseData, writeJson } from "../../../../shared/host-utils.js";
import { redactConfigView, sanitizePatchSettings, unmaskChannels, validateSettings } from "../config/interface.ts";
import type { ConfigPort, NotifyConfig } from "../config/interface.ts";
import type { HistoryStore } from "../stores/interface.ts";
import type { SseHub, SystemNotifier } from "./interface.ts";

/** 与客户端共享的路由常量（smoke 断言两端一致）。 */
export const ROUTES = {
  config: "/api/dsh-notifier/config",
  events: "/api/dsh-notifier/events",
  health: "/api/dsh-notifier/health",
  test: "/api/dsh-notifier/test",
  history: "/api/dsh-notifier/history",
  status: "/api/dsh-notifier/status",
  kinds: "/api/dsh-notifier/kinds",
};

/**
 * buildRoutes 的依赖注入面（index.ts 装配）。配置域部分 = ConfigPort 契约——
 * setConfirm 已移除，kind 确认写一律走 confirmKind（CAS 重试 ≤2）。
 */
export interface RouteDeps extends ConfigPort {
  /** 日志出口。 */
  logger: { warn: (message: string) => void; info: (message: string) => void };
  /** SSE 推送枢纽。 */
  sse: SseHub;
  /** 系统通知通道。 */
  system: SystemNotifier;
  /** 通知历史存储。 */
  history: HistoryStore;
  /** 测试通知（收敛到 service 管线；channelId 可选指定单频道——per-channel 测试）。 */
  sendTest(channelId?: string): Array<{ channelId: string; status: string; error?: string }>;
  /** 频道投递状态读取（GET /status；per-channel 最近投递终态）。 */
  statusReader(): Promise<Record<string, unknown>>;
  /** 动态 kind 清单（GET /kinds；含确认态）。 */
  listKinds(): Array<{ id: string; label: string; confirmed: boolean }>;
}

/** applyConfigPatch 的结果。 */
export type PatchResult =
  | { ok: true; value: { user: Record<string, unknown>; revision?: number } }
  | { ok: false; status: number; code: string; response: Record<string, unknown> };

/**
 * 配置保存纯函数（PUT /config 的主体，独立导出供 smoke 单测）：
 * channels[].deviceKey 掩码按 id 对齐回填 user 层原值（必须先于
 * 校验，掩码不是合法 key 语义）→ validateSettings 定位首个非法键（400 + hint）
 * → sanitizePatchSettings 净化（已知键校验 + 未知键透传保留、装配键剔除）
 * → 经 settings 服务 update 增量写入（expectedRevision
 * 可选做乐观并发）。错误映射：SETTINGS_CONFLICT → 409 固定文案；settings
 * 缺失 → 503 settings-unavailable；写入异常原文只进服务端日志。
 * 成功响应的 user 经 redactConfigView 统一脱敏（脱敏单一出口）。
 */
export async function applyConfigPatch(deps: RouteDeps, payload: unknown): Promise<PatchResult> {
  if (!deps.writable()) {
    return { ok: false, status: 503, code: "settings-unavailable", response: { error: "设置服务不可用", code: "settings-unavailable" } };
  }
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    patch?: unknown;
    expectedRevision?: unknown;
  };
  // expectedRevision 仅接受「省略/null → undefined 透传」或「非负
  // 整数」；其余形态（字符串/小数/负数）显式 400，不再静默忽略。
  if (
    body.expectedRevision !== undefined &&
    body.expectedRevision !== null &&
    !(typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision) && body.expectedRevision >= 0)
  ) {
    return { ok: false, status: 400, code: "invalid", response: { error: "配置校验失败: expectedRevision", hint: "expectedRevision 必须为非负整数或省略" } };
  }
  const expectedRevision =
    typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision) && body.expectedRevision >= 0
      ? body.expectedRevision
      : undefined;
  const rawPatch = body.patch;
  // 掩码回填先于校验：channels 实例的 deviceKey 整值等于掩码时按
  // id 对齐回填 user 层原值；新实例（user 层无同 id）带掩码 → 400 拒绝。
  let effectivePatch: unknown = rawPatch;
  if (typeof rawPatch === "object" && rawPatch !== null && Array.isArray((rawPatch as Record<string, unknown>).channels)) {
    const userChannels = (deps.readUser().user as Record<string, unknown> | undefined)?.channels;
    const unmasked = unmaskChannels((rawPatch as Record<string, unknown>).channels, userChannels);
    if (!unmasked.ok) {
      return {
        ok: false,
        status: 400,
        code: "invalid",
        response: { error: "配置校验失败: channels", hint: "新增实例的 deviceKey 不能为掩码占位（********），请填入真实 key" },
      };
    }
    effectivePatch = { ...(rawPatch as Record<string, unknown>), channels: unmasked.channels };
  }
  // 先定位首个非法键：错误文案指明字段与合法范围，不再静默丢弃回默认
  const invalid = validateSettings(effectivePatch);
  if (invalid !== null) {
    return { ok: false, status: 400, code: "invalid", response: { error: `配置校验失败: ${invalid.key}`, hint: invalid.hint } };
  }
  // 双通道拆分后 PUT 走透传净化（未知键保留、装配键剔除）：
  // 「至少一个有效配置键」判据改为「原始 patch 非空对象」——纯未知键 patch
  // （如 {futureKey:1}）→ 200 透传写入；仅空 patch {}（无任何键可写）→ 400。
  if (typeof rawPatch !== "object" || rawPatch === null || Object.keys(rawPatch).length === 0) {
    return { ok: false, status: 400, code: "invalid", response: { error: "配置校验失败: patch", hint: "需至少包含一个配置键（patch 不能为空）" } };
  }
  const sanitized = sanitizePatchSettings(effectivePatch);
  if (sanitized === null || Object.keys(sanitized).length === 0) {
    // null = 已知键非法（validateSettings 已拦，理论不可达兜底）；空对象 =
    // 原始 patch 仅含装配键（剔除后无任何可写键）→ 同空 patch 语义 400
    return { ok: false, status: 400, code: "invalid", response: { error: "配置校验失败: patch", hint: "需至少包含一个有效配置键" } };
  }
  try {
    await deps.update(sanitized as Record<string, unknown>, expectedRevision);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === "SETTINGS_CONFLICT") {
      return { ok: false, status: 409, code: "conflict", response: { error: "版本冲突", code: "SETTINGS_CONFLICT" } };
    }
    // 对外收敛固定文案，不把底层异常原文（可能含路径等内部信息）回给
    // 客户端；完整原因走服务端日志。
    deps.logger.warn(`dsh-notifier: 配置保存写入设置存储失败 — ${errorMessage(err)}`);
    return { ok: false, status: 500, code: "error", response: { error: "保存失败，请查看服务端日志" } };
  }
  // 单一脱敏出口：readUser 的 user 含 channels 明文，掩码后返回
  const fresh = deps.readUser();
  return { ok: true, value: { user: redactConfigView(fresh.user), revision: fresh.revision } };
}

/**
 * 构造五条路由（loopback 围栏 + 方法白名单是每条路由的必项）。
 * @returns WebRoute 数组（调用方逐条 register，收集 disposer）。
 */
export function buildRoutes(deps: RouteDeps): WebRoute[] {
  const { resolve, readUser, writable, update, confirmKind, logger, sse, history, sendTest, statusReader, listKinds } = deps;

  const configRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.config,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET", "PUT"])) return;
      if (req.method === "GET") {
        const { user, revision } = readUser();
        // 凭据脱敏单一出口：user 与 effective 双视图都经
        // redactConfigView 掩码 deviceKey——深度扫描契约测试锁死两出口。
        writeJson(res, 200, {
          ok: true,
          user: redactConfigView(user),
          revision,
          effective: redactConfigView(resolve()),
          writable: writable(),
        });
        return;
      }
      if (req.method === "PUT") {
        let body: unknown;
        try {
          body = await readBody(req, 16 * 1024);
        } catch (error) {
          const message = errorMessage(error);
          if (message.includes("invalid JSON body")) {
            // 非法 JSON：连接尚存，返回可读 400，避免请求「无响应挂起」
            writeJson(res, 400, { ok: false, error: { code: "invalid-json", details: `invalid JSON body: ${message}` } });
            return;
          }
          // 超限路径：readBody 已 reject 并 destroy 连接（防超大 body 占内存），
          // socket 已断开无法再写响应——记录日志即可（shared/host-utils.js 语义）
          logger.warn(`dsh-notifier: 配置请求体读取失败: ${message}`);
          return;
        }
        // applyConfigPatch 内部异常兜底（理论不可达——净化/
        // 校验/脱敏对任意输入均收敛为错误分支，此处防未来改动引入未捕获抛错）
        // 不得让 handler 冒泡成宿主 500/悬挂——收敛 500 固定文案 + 服务端日志
        let result: PatchResult;
        try {
          result = await applyConfigPatch(deps, body);
        } catch (error) {
          logger.warn(`dsh-notifier: 配置保存处理异常 — ${errorMessage(error)}`);
          writeJson(res, 500, { ok: false, error: { error: "保存失败，请查看服务端日志" } });
          return;
        }
        if (!result.ok) {
          writeJson(res, result.status, { ok: false, error: result.response });
          return;
        }
        writeJson(res, 200, { ok: true, user: result.value.user, revision: result.value.revision });
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };

  const eventsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      // ?since=<seq>：断线补拉——先回放滚动缓冲中 seq 更大的帧，再进入实时；
      // 补拉独立于 /history（200 条截断），不丢尾部事件。
      let since = 0;
      try {
        const raw = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("since");
        const parsed = raw === null ? 0 : Number(raw);
        since = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      } catch {
        since = 0;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // connected 锚点写失败（对端已断）直接返回、不再 register——已断连接入表
      // 只会成为靠心跳/广播兜底清理的残留。
      try {
        res.write(": connected\n\n");
      } catch {
        return;
      }
      if (since > 0) {
        for (const frame of sse.framesSince(since)) {
          try {
            res.write(sseData(frame));
          } catch {
            break; // 连接已断
          }
        }
      }
      // 入表 + 挂 close/error 监听 + 连接上限淘汰，全部收口在 sse.register
      sse.register(res);
    },
  };

  /** 健康检查：插件是否加载、配置摘要、SSE 连接数与回收观测。
   *  sseConnections 语义 = 服务端未释放的 SSE 句柄数，非「在线设备数」；上限见
   *  config.maxConnections。连接表由 shared/sse-hub 管理：stalled 超窗 /
   *  maxAge 轮换主动回收 + 上限淘汰，sseEvicts 暴露各回收路径计数（观测残留构成），
   *  sseConnHealth 暴露逐连接 age/lastWriteAgo/stalled（先量化再调参）。
   *  platform（宿主平台——客户端系统卡按它显示平台提示，防浏览器 OS
   *  与宿主 OS 混淆）+ 摘要键表补 browserSound/systemSound（四同步）。 */
  const healthRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const current = resolve();
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-notifier",
        platform: process.platform,
        config: {
          notifyAsk: current.notifyAsk,
          notifyQuestion: current.notifyQuestion,
          notifyTaskDone: current.notifyTaskDone,
          notifySubagentDone: current.notifySubagentDone,
          notifyTaskError: current.notifyTaskError,
          systemNotify: current.systemNotify,
          browserNotify: current.browserNotify,
          notifyWhenVisible: current.notifyWhenVisible,
          notifySound: current.notifySound,
          browserSound: current.browserSound,
          systemSound: current.systemSound,
          quietHours: current.quietHours,
          maxConnections: current.maxConnections,
        },
        sseConnections: sse.size(),
        sseEvicts: sse.evictStats(),
        sseConnHealth: sse.connHealth(),
      });
    },
  };

  /**
   * 测试通知：POST 触发一条测试通知（绕过免打扰，测试意图是验证通道本身）。
   * 收敛到 service 管线（sendKind('test')）：内置 browser/system 与配置驱动
   * 频道（bark）走同一分发路径——测试才有意义（验证真实投递链路），历史落盘
   * 与终态上报（status/sent 事件）同源。body 可选 {channelId}：指定单频道测试
   * （设置页频道卡「测试」按钮）。固定文案模板，不引入自由文本面（评审定案）。
   * 返回的 sseConnections 语义同 /health = 服务端未释放句柄数（非设备数）。
   */
  const testRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.test,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      let channelId: string | undefined;
      try {
        // body 可选：无 body / 测试桩无流 → channelId 保持 undefined（全频道测试）
        const parsed = (await readBody(req, 4 * 1024)) as { channelId?: unknown } | null;
        if (parsed && typeof parsed === "object" && typeof parsed.channelId === "string" && parsed.channelId.length > 0) {
          channelId = parsed.channelId;
        }
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes("invalid JSON body")) {
          writeJson(res, 400, { ok: false, error: { code: "invalid-json", details: `invalid JSON body: ${message}` } });
          return;
        }
        // 其余（无 body 流的桩请求 / 超限 destroy）：body 可选语义，按全频道测试继续
        logger.warn(`dsh-notifier: 测试通知请求体读取失败（按无 body 处理）: ${message}`);
      }
      const results = sendTest(channelId);
      writeJson(res, 200, { ok: true, sseConnections: sse.size(), results });
    },
  };

  /**
   * 频道投递状态：GET 返回 per-channel 最近投递终态（status 文件内存镜像）。
   * 设置页频道卡状态区消费（ok 灰 / failed 高亮 + 错误摘要——已脱敏）。
   */
  const statusRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.status,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const channels = await statusReader();
      writeJson(res, 200, { ok: true, channels });
    },
  };

  /**
   * 动态 kind 清单与确认：GET 返回注册表（含确认态，确认态持久化在配置
   * allowKinds）；POST {kind, confirmed} 写确认（仅注册表内已注册的动态 kind）。
   * 确认动作只发生在用户主动打开设置页时（注册即弹窗打扰不允许）。
   */
  const kindsRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.kinds,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
      if (req.method === "GET") {
        writeJson(res, 200, { ok: true, kinds: listKinds() });
        return;
      }
      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readBody(req, 4 * 1024);
        } catch (error) {
          const message = errorMessage(error);
          if (message.includes("invalid JSON body")) {
            writeJson(res, 400, { ok: false, error: { code: "invalid-json", details: `invalid JSON body: ${message}` } });
            return;
          }
          logger.warn(`dsh-notifier: kind 确认请求体读取失败: ${message}`);
          return;
        }
        const { kind, confirmed } = (typeof body === "object" && body !== null ? body : {}) as { kind?: unknown; confirmed?: unknown };
        if (typeof kind !== "string" || kind.length === 0 || typeof confirmed !== "boolean") {
          writeJson(res, 400, { ok: false, error: { code: "invalid", details: "需为 { kind: string, confirmed: boolean }" } });
          return;
        }
        const known = listKinds().some((k) => k.id === kind);
        if (!known) {
          writeJson(res, 404, { ok: false, error: { code: "not-found", details: `未注册的动态 kind: ${kind}` } });
          return;
        }
        // confirmKind 现为 CAS 循环（可抛 SETTINGS_CONFLICT 耗尽 /
        // 服务缺失 rejection）——handler 必须兜底，防 rejection 冒泡成
        // 宿主行为未定义；200 响应体带新 revision（向后兼容新增字段）供客户端
        // confirmOne 同步 meta——修「确认 kind 后同窗口保存必 409」的版本链断点。
        try {
          await confirmKind(kind, confirmed);
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          if (code === "SETTINGS_CONFLICT") {
            writeJson(res, 409, { ok: false, error: { code: "SETTINGS_CONFLICT", error: "版本冲突" } });
            return;
          }
          if (code === "SETTINGS_UNAVAILABLE") {
            // 与 PUT /config 的服务缺失语义一致：settings 服务未
            // attach → 503，而非笼统 500——保持跨通道错误映射一致。
            writeJson(res, 503, { ok: false, error: { code: "settings-unavailable", error: "设置服务不可用" } });
            return;
          }
          logger.warn(`dsh-notifier: kind 确认写入失败 — ${errorMessage(error)}`);
          writeJson(res, 500, { ok: false, error: { error: "确认失败，请查看服务端日志" } });
          return;
        }
        const { revision: freshRevision } = readUser();
        writeJson(res, 200, { ok: true, kinds: listKinds(), revision: freshRevision });
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };

  /** 通知历史：GET 返回最近记录（jsonl 尾部最多 HISTORY_LIMIT 条）。 */
  const historyRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET", "DELETE"])) return;
      if (req.method === "GET") {
        const records = await history.read();
        writeJson(res, 200, { ok: true, records });
        return;
      }
      if (req.method === "DELETE") {
        // clear 失败（删除/写回异常向上抛）收敛 500 固定文案、原因只进
        // 服务端日志（对照 PUT /config 500 语义），不再恒 200。
        try {
          const removed = await history.clear();
          writeJson(res, 200, { ok: true, removed });
        } catch (error) {
          logger.warn(`dsh-notifier: 历史清空失败 — ${errorMessage(error)}`);
          writeJson(res, 500, { ok: false, error: { error: "历史清空失败，请查看服务端日志" } });
        }
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };

  return [configRoute, eventsRoute, healthRoute, testRoute, historyRoute, statusRoute, kindsRoute];
}