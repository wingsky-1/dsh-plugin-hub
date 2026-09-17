// @ts-nocheck
/** lan-proxy 旧平行表兼容适配；不是通用配置架构，也不定义产品读写权限。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffKeys } from "./config-matrix-lib.ts";

// lan-proxy 客户端 UI 豁免表（#733 计划项 3.2.2 数据化）：条目（哪些键、为什么）是**事实**，
// 在 scripts/data/dsh-lan-proxy-ui-exempt.json；条目数上限与「超限即红」是**策略**，留在代码里
// ——把上限放进被约束的数据文件等于让被约束方自己改约束。
const uiExemptPath = (pkg) => `scripts/data/${pkg}-ui-exempt.json`;
const UI_EXEMPT_MAX = 8;

/** 迁移保护属于受检义务层，不影响其它 manifest 消费者的结构加载。 */
export function checkLanProxyLegacyObligation(manifest) {
  const surface = manifest.configSurfaces.find((s) => s.package === "dsh-lan-proxy");
  if (!surface || surface.surface === "none" || !surface.matrix) {
    throw new Error("dsh-lan-proxy 必须保留受检身份与完整 matrix（L1/L2 必跑政策）");
  }
}

/**
 * 读取 UI 豁免表（键 → { reason, rationale }）。只做**结构**加载：IO / JSON / 数组形态 /
 * 键与原因的存在性 / 重复键。策略检查（≤8）留给
 * checkExempts，避免同一判据两处实现。
 * 任何结构错误都转 problem：豁免机制失效不能表现为「没有豁免」——那会把合法差集报成
 * 「漏 UI」，把修复方向指错。
 */
function loadUiExempt(root, problems, pkg) {
  const UI_EXEMPT_REL = uiExemptPath(pkg);
  const filePath = join(root, UI_EXEMPT_REL);
  let json;
  try {
    json = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    problems.push(
      `lan-proxy UI 豁免表不可读（${UI_EXEMPT_REL}）：${String(e.message).split("\n")[0]}`,
    );
    return {};
  }
  if (!Array.isArray(json.exemptKeys)) {
    problems.push(`lan-proxy UI 豁免表缺 exemptKeys 数组（${UI_EXEMPT_REL}）`);
    return {};
  }
  const out = {};
  for (const item of json.exemptKeys) {
    applyExemptEntry(out, item, problems, UI_EXEMPT_REL);
  }
  return out;
}

function applyExemptEntry(out, item, problems, UI_EXEMPT_REL) {
  if (
    item === null ||
    typeof item !== "object" ||
    typeof item.key !== "string" ||
    item.key.length === 0
  ) {
    problems.push(`lan-proxy UI 豁免表条目缺 key（${UI_EXEMPT_REL}）`);
    return;
  }
  if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
    problems.push(`lan-proxy UI 豁免键 ${item.key} 缺 reason（${UI_EXEMPT_REL}）`);
    return;
  }
  if (out[item.key] !== undefined) {
    problems.push(`lan-proxy UI 豁免表存在重复键：${item.key}`);
    return;
  }
  out[item.key] = {
    reason: item.reason,
    rationale: typeof item.rationale === "string" ? item.rationale : "",
  };
}

/** 兼容适配只约束已登记差集的规模；字段真身由运行时 schema 验证，不解析源码位置。 */
function checkExempts(pkg, exempt) {
  const keys = Object.keys(exempt);
  return keys.length > UI_EXEMPT_MAX
    ? [`${pkg} 豁免表 ${keys.length} 键 > ${UI_EXEMPT_MAX}（超限即红，强制走评审）`]
    : [];
}

function matrixRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadMatrix(root, surface, problems, loadSurfaceExport) {
  const matrix = surface.matrix;
  const loaded = {};
  for (const label of ["schema", "validators", "hints", "clientDefaults"]) {
    loaded[label] = loadSurfaceExport(
      root,
      surface.package,
      matrix[label],
      "matrix." + label,
      problems,
    );
  }
  if (problems.length) return null;
  const config = loaded.schema;
  if (
    config?.type !== "object" ||
    !matrixRecord(config.dict) ||
    Object.keys(config.dict).length === 0
  ) {
    problems.push(surface.package + " matrix.schema 必须暴露非空 object schema.dict");
    return null;
  }
  loaded.schema = config.dict;
  if (Object.values(loaded).some((value) => !matrixRecord(value))) {
    problems.push(surface.package + " matrix 输入必须是非数组对象");
    return null;
  }
  const identities = Object.values(matrix).map(
    (face) => join(root, face.module) + "#" + face.export,
  );
  if (new Set(identities).size !== identities.length || new Set(Object.values(loaded)).size !== 4) {
    problems.push(surface.package + " matrix 自指：输入声明或实际键载体指向同一对象");
    return null;
  }
  return loaded;
}

/** 差集 → 缺/多键报错行。 */
function diffProblems(scope, tableName, filePath, line, d, hint = "") {
  const out = [];
  for (const k of d.missing)
    out.push(
      `${scope} ${tableName} 缺键（相对基准）: ${k} @ ${filePath}:${line}${hint ? `（${hint}）` : ""}`,
    );
  for (const k of d.extra)
    out.push(
      `${scope} ${tableName} 多键（基准之外）: ${k} @ ${filePath}:${line}${hint ? `（${hint}）` : ""}`,
    );
  return out;
}

export function runLanProxyLegacyMatrix(root, surface, loadSurfaceExport) {
  const problems = [];
  const lines = [];
  const loaded = loadMatrix(root, surface, problems, loadSurfaceExport);
  if (!loaded) return { problems, lines };
  const matrix = surface.matrix;
  const schema = { keys: Object.keys(loaded.schema), line: matrix.schema.export };
  const validators = { keys: Object.keys(loaded.validators), line: "?" };
  const hints = { keys: Object.keys(loaded.hints), line: "?" };
  const defaults = { keys: Object.keys(loaded.clientDefaults), line: "?" };
  const cfgPath = join(root, matrix.schema.module);
  const clientPath = join(root, matrix.clientDefaults.module);
  checkMatrixTableEquality(cfgPath, problems, schema, validators, hints, surface.package);
  const exemptKeys = checkMatrixClientDefaults(
    root,
    problems,
    schema,
    defaults,
    clientPath,
    cfgPath,
    surface.package,
  );
  lines.push(
    surface.package +
      " " +
      schema.keys.length +
      " 键 × [schema/validators/hints] 全等 + client DEFAULTS " +
      defaults.keys.length +
      "(豁免 " +
      exemptKeys.length +
      ")",
  );
  return { problems, lines };
}

function checkMatrixTableEquality(cfgPath, problems, schema, validators, hints, pkg) {
  const pairs = [
    ["Config", schema, "FILE_CONFIG_VALIDATORS", validators],
    ["Config", schema, "SETTING_FIELD_HINTS", hints],
    ["FILE_CONFIG_VALIDATORS", validators, "SETTING_FIELD_HINTS", hints],
  ];
  for (const [na, ta, nb, tb] of pairs) {
    problems.push(
      ...diffProblems(pkg, nb, cfgPath, tb.line, diffKeys(ta.keys, tb.keys), `与 ${na} 不一致`),
    );
    problems.push(
      ...diffProblems(pkg, na, cfgPath, ta.line, diffKeys(tb.keys, ta.keys), `与 ${nb} 不一致`),
    );
  }
}

function checkMatrixClientDefaults(root, problems, schema, defaults, clientPath, cfgPath, pkg) {
  // L2：DEFAULTS ⊆ schema；schema − DEFAULTS == 豁免；豁免表结构自检
  const exempt = loadUiExempt(root, problems, pkg);
  problems.push(...checkExempts(pkg, exempt));
  const exemptKeys = Object.keys(exempt);
  const d = diffKeys(schema.keys, defaults.keys);
  // 这里只验证旧客户端默认值表的键覆盖，不将它当成服务端读写权限或实际控件清单。
  for (const k of d.extra)
    problems.push(
      `lan-proxy client DEFAULTS 多键（Config 之外）: ${k} @ ${clientPath}:${defaults.line}`,
    );
  // schema − DEFAULTS 缺键必须恰为豁免集合（客户端默认表缺键 → 红）
  for (const k of d.missing) {
    if (!exemptKeys.includes(k))
      problems.push(
        `lan-proxy client DEFAULTS 缺键（相对 Config，非豁免）: ${k} @ ${clientPath}:${defaults.line}（客户端默认表缺键）`,
      );
  }
  // 反向约束：豁免必须仍是有效 schema 字段且未进入客户端，确保差集恰等于豁免。
  for (const k of exemptKeys) {
    if (!schema.keys.includes(k))
      problems.push(`${pkg} 豁免键 ${k} 不在 Config 中（失效豁免，应移除）`);
    if (defaults.keys.includes(k))
      problems.push(
        `lan-proxy 豁免键 ${k} 已在客户端 DEFAULTS 中（豁免残留，应移除豁免或改豁免原因）`,
      );
  }
  return exemptKeys;
}
