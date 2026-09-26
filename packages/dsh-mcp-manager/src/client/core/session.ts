/**
 * dsh-mcp-manager — 客户端会话跟随。
 *
 * 监听当前会话变化（cwd），通知宿主切换项目级 MCP 并刷新 UI。
 * 跨模块动作（refresh）经 actions 注入，不直接引用 panel 模块。
 *
 * #1028：当前会话读数一律经 core/current-session.ts 单一接缝，本模块只负责
 * 「读数 → 上报策略」。核心纪律：**未知 ≠ 无项目**。读不到当前会话时保持宿主
 * 绑定不动（旧实现上报 `cwd:""`，被宿主当作显式清空，面板空白 + 导入报错）。
 */

import { api } from "./api.ts";
import { readCurrentSession } from "./current-session.ts";
import type { McpClientContext, McpState, UiActions } from "./state.ts";

/**
 * 强制重绑当前会话（绕过 bindSession 的 cwd 未变短路）。
 *
 * #412 复报根因：宿主 dsh web 重启后 `projectRoot`/中间层单元清空，而旧页面
 * 未重载时 bindSession 不重跑（cwd 未变），`visibilitychange → resume` 只重建
 * @global、项目级连接无法恢复。切回前台显式重发 POST /session（同 cwd）让宿主
 * `setSession` 恢复 projectRoot + `projectUnitFor` 惰性连接；宿主幂等短路
 * （同 cwd 且 projectStore 已加载）天然挡重复，无副作用、不引 #324 自激循环
 * （GET /servers 纯读不回写会话）。
 *
 * #1028：`sessionResolved` 为 false（**未知**当前会话）时**不发**请求。
 * 「重绑」的前提是知道要绑到哪；不知道时重发 `cwd:""` 不是重绑，是清空。
 */
export function rebindSession(state: McpState): Promise<unknown> {
  if (!state.sessionResolved) return Promise.resolve(undefined);
  return api<unknown>(state.API.session, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: typeof state.currentCwd === "string" ? state.currentCwd : "" }),
  }).catch(() => {});
}

/** 未知态一次性告警：未知没有任何 UI 表现，不告警就等于静默失效（#1028 残余风险 R1）。 */
function warnUnknownOnce(state: McpState): void {
  if (state.warnedUnknownSession) return;
  state.warnedUnknownSession = true;
  console.warn(
    "[dsh-mcp-manager] 读不到当前会话（官方 sessions.list 快照无 mainView 行）：" +
      "项目级 MCP 暂不绑定。未知不等于无项目，故不向宿主发送清空。",
  );
}

/** 跟随当前会话：cwd 变化 → 通知宿主切换项目级 MCP + 刷新浮窗。 */
export function bindSession(
  ctx: McpClientContext,
  state: McpState,
  actions: UiActions,
): () => void {
  const list = ctx.sessions?.list;
  if (list === undefined) return () => {};
  const sync = () => {
    const read = readCurrentSession(list);
    const prevCwd = state.currentCwd;
    const prevResolved = state.sessionResolved;
    if (read.kind === "unknown") {
      // 未知：本地读数清空（后续 cwd 查询参数自然退化为「不带 cwd」，宿主按 no-op 处理），
      // 但**不上报**——保持宿主当前绑定，不把「读不到」变成「清空项目级」。
      state.currentCwd = undefined;
      state.sessionResolved = false;
      state.unknownSessionFrames += 1;
      state.updateFloatState?.();
      // 告警口径（#1028 隔离实测后收敛）：官方会话快照要等 mainView 持有才就绪，
      // 因此**首帧未知是竞态、每次冷启动必现**。无条件告警会让正常态与异常态
      // 显示同一条黄警，反而丢掉判别价值。只在两种真异常下开口：
      //   ① 已解析过又读不到 —— 真回归（#1028 的失效签名就是这一种）；
      //   ② 连续多帧仍读不到 —— 真失联（会话面始终不给出当前会话）。
      if (prevResolved || state.unknownSessionFrames >= 2) warnUnknownOnce(state);
      return;
    }
    state.currentCwd = read.cwd;
    state.sessionResolved = true;
    state.unknownSessionFrames = 0;
    state.warnedUnknownSession = false;
    state.updateFloatState?.();
    // cwd 未变且上一轮也是已知态 → 短路（宿主侧 setSession 同值亦幂等，这里省一次往返）。
    if (prevResolved && read.cwd === prevCwd) return;
    // 无论 cwd 是否为空都通知宿主切换：空 cwd（blank 会话/新会话还没选工作区）
    // 也要显式清空宿主的项目级 MCP，否则宿主全局单例会残留上一个会话的项目级服务器，
    // 别的会话就串台显示了。此处与「未知」不同——空 cwd 是**已知**无项目。
    void api<unknown>(state.API.session, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: typeof read.cwd === "string" ? read.cwd : "" }),
    })
      .then(() => actions.refresh())
      .catch(() => {});
  };
  sync();
  if (typeof list.subscribe === "function") return list.subscribe(sync);
  return () => {};
}
