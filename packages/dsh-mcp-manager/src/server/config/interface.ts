/**
 * dsh-mcp-manager — config/interface.ts：配置域唯一对外引用面（D10，#767 W11b2a）。
 *
 * 配置域 = 归一化/导入/schema（normalize / import / config-schema）+ ${ENV} 预展开与
 * 凭据词根（impl/env）+ 浮窗 UI 配置类型（impl/ui）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）；类型的物理定义在各 impl/<块>/type.ts，本门面只做
 * 转出（v3 §3.1 规则 1）。
 */
export { SERVER_NAME_PATTERN, normalizeServer } from "./normalize.ts";
export { SECRET_ENV_NAME, expandEnv, expandEnvObject, expandServerEnv } from "./impl/env/index.ts";
export { assertEnvPolicy, extractEnvRefs, isSecretEnvName } from "./impl/env/policy.ts";
export { fromClaudeEntry, parseClaudeJson } from "./import.ts";
export {
  DEFAULT_UI_CONFIG,
  DEFAULT_CONFIG,
  BOOLEAN_KEYS,
  COUNT_LIMITS,
  normalizeConfig,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelTopForAnchor,
  Config,
} from "./config-schema.ts";
export type { ServerConfig } from "./impl/model/type.ts";
export type { UiPlacementConfig } from "./impl/ui/type.ts";
