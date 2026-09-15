/**
 * dsh-mcp-manager — servers/lifecycle/impl/mount/index.ts：一个 (root, server) 的真装载（§3.4）。
 *
 * 装载链：workspace 端口取 id → 构造官方 Config（env / headers 经 config 端口预展开）→ loader
 * 按包名解析官方插件 → 账本记账装载 → 跑等待窗口投影六态。官方包不在 catalog、仓库内不可解析，
 * 故包名只能是说明符（见共享层的 OFFICIAL_MCP_CLIENT_SPECIFIER），模块形状由 LoaderPort 给。
 *
 * 为什么 id 不在本块生成：官方 serverName 在 `scopeOf(ctx) ?? ctx.root` 这个**整个应用根**上
 * 活体预留，同 owner 重名当场抛；而「同一 bare 名在全局与某项目都配」是常见写法。id 与
 * `(scope,name)→id` 表归 workspace 域（767-v6-STAGED-PLAN §2.6 裁定 B），本块只消费
 * `idFor(root, name)`——scope 传 root，跨 root 同名因此各自成条。
 *
 * 为什么 Config 逐字段显式构造而不透传配置对象：官方 Config 是 stdio / streamable-http 联合，
 * 多带一个不属于该 transport 的键会被 schema 拒；`serverName` / `failOnStartupError` /
 * `toolCallTimeoutMs` 三个字段还各有一条口径（见 officialMcpConfig 内注释）。
 *
 * 为什么 env / headers 在这里展开：模板落盘、交给官方前才展开是本插件的凭据面不变量——在
 * normalizeServer 里展开等于把明文凭据随下一次 store.save() 写进 storePath（设计 §2.4）。
 */
import type { ServerConfig } from "../../../../config/interface.ts";
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  OFFICIAL_MCP_CLIENT_SPECIFIER,
} from "../../../../shared/interface.ts";
import type { ServerState } from "../../../../../shared/interface.ts";
import type { ToolsRegistryPort } from "../../deps.ts";
import { mountLedger } from "../ledger/index.ts";
import type { LedgerEntry } from "../ledger/index.ts";
import { collectOfficialLogs } from "../logs/index.ts";
import { lifecyclePorts } from "../service/index.ts";
import { awaitMountWindow } from "../timeout/index.ts";
import type { MountWindowOutcome } from "../timeout/index.ts";

/** 官方 Config 的公共字段（自持声明：官方包不在 catalog，类型面取不到，形状只在这里写一次）。 */
interface OfficialConfigCommon {
  /** 交给官方的 serverName；本包用 (scope,name) 分配的随机短串（进 `mcp__<id>__` 前缀）。 */
  readonly serverName: string;
  /** 单次工具调用预算。必须显式给：官方默认 60s，缺省会把本插件的 15s 口径放大四倍。 */
  readonly toolCallTimeoutMs: number;
  /** 官方重连策略；未知键已在 config 域归一化期丢弃（官方对未知键直接抛错）。 */
  readonly reconnect: Readonly<Record<string, unknown>>;
  /** 恒 false：首连失败不得卸载实例，理由见 officialMcpConfig 内注释。 */
  readonly failOnStartupError: false;
}

/**
 * 官方 dsh-mcp-client 的 Config 形状。
 *
 * 写成联合而不是「全可选字段的对象」：stdio 与 streamable-http 的字段互斥，用联合让
 * 「给 stdio 带上 url」这类错误在编译期就出不去。
 */
export type OfficialMcpConfig =
  | (OfficialConfigCommon & {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
    })
  | (OfficialConfigCommon & {
      readonly transport: "streamable-http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    });

/**
 * 把一条归一化后的服务器配置映射成官方 Config（设计 §2.1 的逐字段表）。
 *
 * 展开函数按参数递入而不是块内现取端口：映射是纯函数，能脱离装配单独测「模板 → 字面量」。
 */
export function officialMcpConfig(
  server: ServerConfig,
  id: string,
  expandServerEnv: (server: ServerConfig) => ServerConfig,
): OfficialMcpConfig {
  const expanded = expandServerEnv(server);
  const common: OfficialConfigCommon = {
    serverName: id,
    // 恒 false（§3.3）：置 true 会让首连失败直接杀掉实例、官方后台重连随之被回收，等于放弃
    // 「常驻重连」语义；failed 因此是软失败——实例仍在，只是拿不到具体错因（§3.2-1）。
    failOnStartupError: false,
    // 官方默认 60s；本插件的 DEFAULT_TOOL_CALL_TIMEOUT_MS 是 15s，必须显式覆盖。
    toolCallTimeoutMs: server.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    // 缺失时给 {}：官方 resolveReconnectPolicy 先补默认值再判关系，本块不重抄一份默认值表。
    reconnect: server.reconnect ?? {},
  };
  if (server.transport === "stdio") {
    if (typeof server.command !== "string" || server.command === "") {
      throw new Error(
        "dsh-mcp-manager: stdio 服务器缺 command，拒绝装载（配置面应已由 normalizeServer 保证非空）",
      );
    }
    return {
      transport: "stdio",
      command: server.command,
      // 三个字段都显式给默认值：官方 schema 虽有默认，但依赖它等于把「配置里到底写没写」与官方
      // rc 的内部实现绑在一起（§2.1 表）。cwd 的空串不能给 undefined——见 §2.3。
      args: server.args ?? [],
      env: expanded.env ?? {},
      cwd: server.cwd ?? "",
      ...common,
    };
  }
  if (typeof server.url !== "string" || server.url === "") {
    throw new Error(
      "dsh-mcp-manager: streamable-http 服务器缺 url，拒绝装载（配置面应已由 normalizeServer 保证非空）",
    );
  }
  return {
    transport: "streamable-http",
    url: server.url,
    headers: expanded.headers ?? {},
    ...common,
  };
}

/** 装载入参：一个 (root, server) 的全部外部输入（本域不自持调用方的状态）。 */
export interface MountServerInput {
  /** 工作空间根（`@<root>/<server>` 的 root，也是 id 表的 scope）。 */
  readonly root: string;
  /** 归一化后的服务器配置；env / headers 仍是模板形态，展开在本块内做。 */
  readonly server: ServerConfig;
  /** 连接等待预算（ms）；缺省取共享层 CONNECT_TIMEOUT_MS（测试用小预算驱动真超时）。 */
  readonly connectTimeoutMs?: number;
  /** 状态投影出口：窗口在起点与结算点各回调一次；被丢弃的结算不回调。 */
  readonly onState: (state: ServerState) => void;
}

/** 一次装载的结果：id 与账本条目供调用方后续定位/拆除，outcome 是等待窗口的结算。 */
export interface MountServerResult {
  readonly id: string;
  readonly entry: LedgerEntry;
  readonly outcome: MountWindowOutcome;
}

/**
 * 装载一个 (root, server)：取 id → 构造官方 Config → 解析模块 → 账本记账挂载 → 跑等待窗口。
 *
 * 三件本函数**刻意不做**的事：不裁决 `enabled === false`（配置面语义归调用方，§2.2-1）、
 * 不在窗口失败时 dispose（连接失败的实例保留给官方后台重连，§3.4 步骤 5a）、不吞装载期异常
 * （解析失败 / 账本撞键一律上抛，避免装配静默少装一个服务器）。
 */
export async function mountServer(input: MountServerInput): Promise<MountServerResult> {
  const { loader, workspace, config, tools, logs } = lifecyclePorts.get();
  const id = workspace.idFor(input.root, input.server.name);
  const officialConfig = officialMcpConfig(input.server, id, config.expandServerEnv);
  const module = await loader.load(OFFICIAL_MCP_CLIENT_SPECIFIER);
  const entry = mountLedger.mount(id, module, officialConfig);
  // 收集器只包住等待窗口：首连与首次发现都结算在官方 ready 之前，窗口内的原话就是这次装载的
  // 全部错因；窗口结束即摘除，常驻订阅只会让每个实例都挂一个导出器去收事后噪音。
  const collected = collectOfficialLogs(logs, id);
  let outcome: MountWindowOutcome;
  try {
    outcome = await awaitMountWindow({
      id,
      handle: entry.handle,
      // 代际守卫读账本：本条目被 dispose 或顶替之后到达的结算一律作废（§3.4 步骤 6）。
      isCurrent: () => mountLedger.isCurrent(entry),
      hasTools: (candidate) => hasRegisteredTools(tools, candidate),
      diagnostics: collected.lines,
      onState: input.onState,
      ...(input.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: input.connectTimeoutMs }),
    });
  } finally {
    // 必须 finally：窗口抛错时更要摘，否则一个失败的实例会永久占着宿主日志面。
    collected.stop();
  }
  return { id, entry, outcome };
}

/**
 * 工具注册面探测：官方把该服务器的工具注册成 `mcp__<id>__<tool>`，前缀命中即「该 id 下有工具」。
 *
 * 只按前缀判而不是查某个具体工具名：工具清单由远端决定，本包在装载期一个名字都不知道；而
 * 名字里的 id 是本包自己分配的，前缀因此是「这个实例注册成功」的可靠证据（§3.1 输入面 B）。
 */
function hasRegisteredTools(tools: ToolsRegistryPort, id: string): boolean {
  const prefix = `mcp__${id}__`;
  return tools.schemas().some((schema) => schema.name.startsWith(prefix));
}
