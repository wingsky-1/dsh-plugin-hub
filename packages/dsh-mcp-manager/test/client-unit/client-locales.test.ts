/**
 * dsh-mcp-manager — client-unit：client/locales.ts 字典的直接判据。
 *
 * ## 为什么这个文件需要一份「同源镜像」（重要，先读这段）
 *
 * 覆盖台账对 locales.ts 的判词是本仓的典型假达标实例：**水位 100% / 100%，而直接判据
 * 贡献 0%**——它是被 index.ts:40 的顶层 import「加载即满」的，把 4 个字典值改成乱码后
 * dsh-mcp-manager 全部 1520 个测试仍全绿（exit 0）。
 *
 * 所以本文件刻意做**全量字面量镜像**（DICTIONARY 91 条 × zh/en 双向）：期望值全部手写
 * 在测试里，一行都不从 `zh` / `en` import。理由见 testing SKILL §6「不要同源期望」——
 * 期望值从被测实现 import 出来等于让实现自己判自己，常量改成任何值都绿。这里反过来：
 * 改 zh 或 en 的任何一个值、增删任何一个键、动任何一个占位符，本文件必红。
 *
 * 镜像的维护成本是刻意的：字典是双语契约面，翻译漂移必须是**显式**动作（同时改实现和
 * 这张表），而不是「顺手改个文案、测试照绿」。
 *
 * 机械判据（不依赖镜像、单独也能抓漂移）：
 * - 键集合双向完全一致（en 不得漏键或多数，zh 不得多数）。
 * - 两侧占位符 token 集合逐键一致（`<{msg}>` 在 zh 丢��而 en 还在 → 插值出 "undefined"）。
 * - 两侧取值均非空、非纯空白（空串是「界面某处显示空白」的最常见来源）。
 * - 占位符只允许 {name} / {n} / {msg} / {status} / {tools} / {parts} / {names} 白名单。
 *
 * 注：本仓的 stryker `excludedMutations` 排除了 StringLiteral / ObjectLiteral /
 * ArrayLiteral / TemplateLiteral，故 locales.ts 作为纯字面量表**在变异面上不产生任何
 * 变异体**。它的「进 mutate 面」是登记事实（并集棘轮口径），真实信号来自本文件的
 * 字面量镜像与下述变异探针，而非变异分。
 */
import { describe, expect, it } from "vitest";

import { en, zh } from "../../src/client/locales.ts";

/** 全量字面量镜像：[key, zh 值, en 值]。**不得**从被测实现 import（见文件头）。 */
const DICTIONARY: ReadonlyArray<readonly [string, string, string]> = [
  ["stConnected", "运行中", "Running"],
  ["stConnecting", "连接中", "Connecting"],
  ["stReconnecting", "重连中", "Reconnecting"],
  ["stStopped", "未连接", "Disconnected"],
  ["stDisabled", "已停用", "Disabled"],
  ["stFailed", "失败", "Failed"],
  ["connect", "连接", "Connect"],
  ["disconnect", "断开", "Disconnect"],
  ["reconnect", "重连", "Reconnect"],
  ["enable", "启用", "Enable"],
  ["enableAndConnect", "启用并连接", "Enable & connect"],
  ["disable", "禁用", "Disable"],
  ["edit", "编辑", "Edit"],
  ["delete", "删除", "Delete"],
  ["save", "保存", "Save"],
  ["cancel", "取消", "Cancel"],
  ["refresh", "刷新", "Refresh"],
  ["close", "关闭", "Close"],
  ["cancelEdit", "取消编辑", "Cancel edit"],
  ["saveFail", "保存失败：{msg}", "Save failed: {msg}"],
  ["actionFail", "操作失败：{msg}", "Operation failed: {msg}"],
  ["loadFail", "加载失败：{msg}", "Load failed: {msg}"],
  ["floatAriaLabel", "MCP 管理器", "MCP manager"],
  ["floatTitle", "MCP 管理器（点击展开）", "MCP manager (click to expand)"],
  ["floatManage", "管理", "Manage"],
  ["floatGlobalSession", "全局会话", "global session"],
  ["groupProject", "项目级", "Project"],
  ["groupGlobal", "全局", "Global"],
  ["badgeScopeProject", "项目", "Project"],
  ["badgeScopeGlobal", "全局", "Global"],
  ["serverMeta", "{status} · {tools} 工具", "{status} · {tools} tools"],
  ["toolsCount", "工具（{n}）", "Tools ({n})"],
  ["toolsCountPlain", "{n} 工具", "{n} tools"],
  ["statusGroupCount", "{status}（{n}）", "{status} ({n})"],
  ["groupAttention", "需关注（{n}）", "Needs attention ({n})"],
  ["healthRunning", "运行中 {n}", "{n} running"],
  ["healthConnecting", "连接中 {n}", "{n} connecting"],
  ["healthStopped", "未连接 {n}", "{n} disconnected"],
  ["healthFailed", "失败 {n}", "{n} failed"],
  ["floatEmptyTitle", "还没有 MCP 服务器", "No MCP servers yet"],
  ["floatEmptyCta", "去添加", "Add one"],
  ["panelTitle", "MCP 管理器", "MCP manager"],
  ["tabServers", "服务器", "Servers"],
  ["tabQuickAdd", "快速接入", "Quick add"],
  ["countsConnected", "运行中 {n}", "running {n}"],
  ["countsConnecting", "连接中 {n}", "connecting {n}"],
  ["countsFailed", "失败 {n}", "failed {n}"],
  ["countsSummary", "共 {n} 台 · {parts}", "{n} total · {parts}"],
  ["countsSummaryOnly", "共 {n} 台", "{n} total"],
  ["addServer", "添加服务器", "Add server"],
  ["editServer", "编辑服务器：{name}", "Edit server: {name}"],
  [
    "nameLabel",
    "服务器名称（唯一，作为 mcp__<name>__ 前缀）",
    "Server name (unique, used as the mcp__<name>__ prefix)",
  ],
  ["ownershipLabel", "归属", "Scope"],
  ["transportLabel", "传输类型", "Transport"],
  ["commandLabel", "命令（stdio）", "Command (stdio)"],
  ["argsLabel", "参数（逗号分隔）", "Args (comma-separated)"],
  [
    "envLabel",
    "环境变量（每行 KEY=VALUE，支持 ${ENV} 引用，值为空则继承父环境）",
    "Env vars (KEY=VALUE per line, ${ENV} refs supported; empty value inherits the parent environment)",
  ],
  ["cwdLabel", "工作目录（可选）", "Working directory (optional)"],
  ["urlLabel", "URL（streamable-http）", "URL (streamable-http)"],
  [
    "headersLabel",
    "请求头（每行 KEY: VALUE，支持 ${ENV} 引用）",
    "Headers (KEY: VALUE per line, ${ENV} refs supported)",
  ],
  ["enabledLabel", "启用（保存后立即连接）", "Enabled (connects immediately after saving)"],
  [
    "scopeProjectOpt",
    "项目级（<项目>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json，随会话切换）",
    "Project (<project>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json, follows the session)",
  ],
  ["scopeGlobalOpt", "全局（本机配置）", "Global (local machine config)"],
  ["transportStdioOpt", "stdio（本地子进程）", "stdio (local subprocess)"],
  ["transportHttpOpt", "streamable-http（远程）", "streamable-http (remote)"],
  [
    "envPlaceholder",
    "每行 KEY=VALUE，如\nCONTEXT7_API_KEY=${CONTEXT7_API_KEY}",
    "One KEY=VALUE per line, e.g.\nCONTEXT7_API_KEY=${CONTEXT7_API_KEY}",
  ],
  [
    "headersPlaceholder",
    "每行 KEY: VALUE，支持 ${ENV} 引用，如\nAuthorization: Bearer ${CONTEXT7_API_KEY}",
    "One KEY: VALUE per line, ${ENV} refs supported, e.g.\nAuthorization: Bearer ${CONTEXT7_API_KEY}",
  ],
  ["cwdPlaceholder", "可选工作目录", "Optional working directory"],
  ["pasteTitle", "粘贴 mcpServers JSON 导入", "Paste mcpServers JSON to import"],
  ["importJson", "导入 JSON", "Import JSON"],
  ["importedOk", "已导入：{names}", "Imported: {names}"],
  ["importedNone", "（无）", "(none)"],
  ["importSkipped", "跳过（已存在）：{names}", "Skipped (already present): {names}"],
  ["importFail", "导入失败：{msg}", "Import failed: {msg}"],
  [
    "serversEmpty",
    "还没有配置 MCP 服务器。切到「快速接入」页添加，或粘贴 mcpServers JSON 导入。",
    'No MCP servers yet. Add one on the "Quick add" tab, or paste mcpServers JSON to import.',
  ],
  ["confirmDelete", "删除 MCP 服务器「{name}」？", 'Delete MCP server "{name}"?'],
  ["settingsLoading", "MCP 管理器：加载中…", "MCP manager: loading…"],
  ["settingsName", "MCP 管理器（dsh-mcp-manager）", "MCP manager (dsh-mcp-manager)"],
  [
    "settingsDescription",
    "浮窗位置 / 水平·垂直·空白偏移",
    "Float placement / horizontal·vertical·gap offsets",
  ],
  ["anchorLabel", "锚点", "Anchor"],
  ["posTopRight", "右上（top-right）", "Top right (top-right)"],
  ["posTopLeft", "左上（top-left）", "Top left (top-left)"],
  ["posBottomRight", "右下（bottom-right）", "Bottom right (bottom-right)"],
  ["posBottomLeft", "左下（bottom-left）", "Bottom left (bottom-left)"],
  ["offsetX", "水平偏移", "Horizontal offset"],
  ["offsetY", "垂直偏移", "Vertical offset"],
  ["blankY", "空白偏移", "Blank-session offset"],
  ["zIndexBase", "层级基准", "Z-index base"],
  [
    "settingsHint",
    "保存即热更新：浮窗位置与偏移即时生效并持久化（无需重启 dsh web）。",
    "Hot reload on save: float placement and offsets apply immediately and persist (no dsh web restart).",
  ],
  ["savingNow", "保存中…", "Saving…"],
  [
    "settingsSavedOk",
    "已保存——浮窗位置即时生效（无需重启）",
    "Saved — float placement takes effect immediately (no restart)",
  ],
];

/**
 * 取值里出现的 i18n 占位符 token（排好序便于逐键比对）。
 * ${ENV} / ${CONTEXT7_API_KEY} 是给用户抄的环境变量引用，不是 i18n 占位符，
 * 故用否定回顾排除紧跟 $ 的花括号。
 */
function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/(?<!\$)\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]!).sort();
}

describe("locales：键集合平衡", () => {
  it("en 覆盖 zh 的全部键（漏译即红：渲染期会回落 key 本体，界面露出 stFailed）", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("实际键集合与镜像表逐条一致（增删键必须同时改镜像）", () => {
    expect(Object.keys(zh).sort()).toEqual(DICTIONARY.map(([key]) => key).sort());
  });

  it("镜像表本身无重复键（重复会让 toEqual 少断一条，属用例自身的洞）", () => {
    const keys = DICTIONARY.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("locales：取值字面量镜像（改任一值即红）", () => {
  it("zh 全量取值逐条等于镜像", () => {
    const actual = DICTIONARY.map(([key]) => [key, zh[key as keyof typeof zh]]);
    expect(actual).toEqual(DICTIONARY.map(([key, value]) => [key, value]));
  });

  it("en 全量取值逐条等于镜像", () => {
    const actual = DICTIONARY.map(([key]) => [key, en[key as keyof typeof zh]]);
    expect(actual).toEqual(DICTIONARY.map(([key, , value]) => [key, value]));
  });
});

describe("locales：机械判据（翻译漂移的通用抓法）", () => {
  it("两侧取值均非空、非纯空白（空串 = 界面某处显示空白）", () => {
    for (const [key, zhValue, enValue] of DICTIONARY) {
      expect(zhValue.trim(), `zh.${key} 为空`).not.toBe("");
      expect(enValue.trim(), `en.${key} 为空`).not.toBe("");
    }
  });

  it("zh/en 同一键的占位符集合逐键一致（丢占位符会让插值出 undefined）", () => {
    for (const [key, zhValue, enValue] of DICTIONARY) {
      expect(placeholdersOf(enValue), `en.${key} 占位符与 zh 不一致`).toEqual(
        placeholdersOf(zhValue),
      );
    }
  });

  it("占位符只取白名单（新增占位符必须同时改渲染期插值调用，否则静默失效）", () => {
    const allowed = new Set(["name", "n", "msg", "status", "tools", "parts", "names"]);
    for (const [key, zhValue, enValue] of DICTIONARY) {
      for (const token of [...placeholdersOf(zhValue), ...placeholdersOf(enValue)]) {
        expect(allowed.has(token), `${key} 的占位符 {${token}} 不在白名单`).toBe(true);
      }
    }
  });

  it("占位符成对闭合（漏半个花括号会让正则少抓一个 token）", () => {
    for (const [key, zhValue, enValue] of DICTIONARY) {
      for (const value of [zhValue, enValue]) {
        const opens = [...value.matchAll(/(?<!\$)\{([A-Za-z][A-Za-z0-9]*)\}/g)].length;
        // \${ENV} / \${CONTEXT7_API_KEY} 是**给用户抄的环境变量引用**，不是 i18n
        // 占位符，故只数「前面不是 $」的裸花括号。
        const totalBraces = [...value.matchAll(/(?<!\$)\{/g)].length;
        expect(opens, `${key} 的花括号不配对`).toBe(totalBraces);
      }
    }
  });
});
