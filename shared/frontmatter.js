// dsh 插件家族共享层 — SKILL.md / 命令文件 frontmatter 轻量解析与改写（零依赖）。
//
// 历史：dsh-commands-files 与 dsh-skill-explorer 各持一份同源复制（曾仅差 21 行
// input 块支持，连文件头注释都未改），memory 又有第三份极简实现。
// 统一由本模块提供；各插件的 lib/frontmatter.js 保留为薄封装以维持导出面稳定。
//
// 与 dsh-skill-filesystem 提供方的解析是两套独立实现（刻意不引入
// schemastery / yaml）；官方格式演进时两处需同步，本模块保持导出面稳定
// 以便单测锁定行为。

import { readFileSync, writeFileSync, renameSync } from "node:fs";

/**
 * 解析 YAML 布尔（true/false/yes/no/on/off/1/0，大小写不敏感）；非布尔返回 undefined。
 * @param {unknown} value - 原始值。
 * @returns {boolean|undefined} 解析结果。
 */
export function parseYamlBool(value) {
  const text = String(value).toLowerCase();
  if (["true", "yes", "on", "1"].includes(text)) return true;
  if (["false", "no", "off", "0"].includes(text)) return false;
  return undefined;
}

/**
 * 去掉 YAML 单/双引号。
 * @param {string} value - 带引号字符串。
 * @returns {string} 去引号结果。
 */
function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 解析 frontmatter 前若干行里的标量字段（轻量实现，零依赖）。
 * 支持 name/description/whenToUse（含块标量 | / > 折叠）、input 嵌套块
 * （hint/recordInput）与 disable-model-invocation / user-invocable 布尔字段。
 * @param {string} content - 文件内容。
 * @returns {Record<string, unknown>} 解析出的已知键值。
 */
export function parseFrontmatter(content) {  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match === null) return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (kv === null) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    // 嵌套块：input: 下的缩进子项（支持 hint: xxx / recordInput: bool）。
    // 须在空 rest 提前 continue 之前处理。
    if (key === "input" && rest === "") {
      /** @type {Record<string, unknown>} */
      const nested = {};
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        const sub = /^\s+([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
        if (sub === null) {
          if (line.trim() === "") continue;
          break;
        }
        const subKey = sub[1];
        const subValue = sub[2].trim();
        if (subKey === "hint") nested.hint = unquote(subValue);
        else if (subKey === "recordInput") nested.recordInput = parseYamlBool(subValue);
      }
      if (nested.hint !== undefined) out.hint = nested.hint;
      if (nested.recordInput !== undefined) out.recordInput = nested.recordInput;
      continue;
    }
    if (rest === "") continue;
    // 块标量（| / > 及折叠/保留修饰符）：收集后续缩进行，折叠为单行。
    if (/^[|>][-+]?$/.test(rest)) {
      const collected = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (line === "" || /^\s/.test(line)) collected.push(line.trim());
        else break;
      }
      const text = collected.join(" ").trim();
      if (key === "name") out.name = text || undefined;
      else if (key === "description") out.description = text || undefined;
      else if (key === "whenToUse") out.whenToUse = text || undefined;
      continue;
    }
    if (key === "name") out.name = unquote(rest);
    else if (key === "description") out.description = unquote(rest);
    else if (key === "whenToUse") out.whenToUse = unquote(rest);
    else if (key === "disable-model-invocation") out.disableModelInvocation = parseYamlBool(rest);
    else if (key === "user-invocable") out.userInvocable = parseYamlBool(rest);
    else if (key === "recordInput") out.recordInput = parseYamlBool(rest);
  }
  return out;
}

/**
 * 通用 frontmatter 解析：返回**全部**键值对（不做已知键过滤）。
 * 供 memory 等需要任意字段（kind/title/date）的文件使用；
 * 与 parseFrontmatter 共用同一分隔符契约（单一正则来源）。
 * @param {string} content - 文件内容。
 * @returns {Record<string, string>} 全部键值对。
 */
export function parseFrontmatterAll(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match === null) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/u.exec(line);
    if (kv !== null) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/**
 * 改写 SKILL.md frontmatter 中的某个布尔字段（不存在则追加），原子写回。
 * 保留其余行与正文原样。返回改写后的 frontmatter 解析结果。
 * @param {string} file - SKILL.md 绝对路径。
 * @param {string} field - frontmatter 字段名（如 disable-model-invocation）。
 * @param {boolean} value - 目标布尔值。
 * @returns {object} 改写后的 frontmatter（含该字段最新值）。
 */
export function setFrontmatterField(file, field, value) {
  const content = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/.exec(content);
  if (match === null) throw new Error(`setFrontmatterField: ${file} has no frontmatter`);
  const blockLines = match[1].split(/\r?\n/);
  const linePattern = new RegExp(`^${field}:`);
  let replaced = false;
  const next = blockLines.map((line) => {
    if (linePattern.test(line)) {
      replaced = true;
      return `${field}: ${value}`;
    }
    return line;
  });
  if (!replaced) next.push(`${field}: ${value}`);
  const rewritten = `---\n${next.join("\n")}\n---${match[2]}`;
  // 原子写：临时文件 + rename，避免半写状态被 watcher 读到。
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, rewritten, "utf8");
  renameSync(tmp, file);
  return parseFrontmatter(rewritten);
}
