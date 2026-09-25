#!/usr/bin/env node
/**
 * repair-mcp-catalog-sessions —— 一次性修复：升级 dsh 后含 mcp-catalog 的历史会话无法加载（#723）。
 *
 * 背景：dsh-mcp-manager 0.2.x 及更早版本把能力目录注入消息写成
 * `source: { kind: "mcp-catalog", form: "catalog", entries }`。历史 dsh 0.1.5 的
 * session format v2→v3 迁移对 surface 消息的 `source.kind` 有一份封闭白名单
 * （`@deepseek-ai/dsh-session-format-v2-to-v3` 的 `SOURCE_KINDS`），自造值不在其中，
 * 于是 format v0/v1/v2 的会话迁移被拒：
 *
 *   cannot safely transform unclassified message source;
 *   source v0 artifact remains unchanged
 *
 * 产物本身完好（宿主拒绝时按设计原样保留），只是读不出来。对 v0/v1/v2，本脚本只把
 * 已落盘产物里的旧 source 修成官方 v3→v4 链所接收的 **V3 plugin wrapper**：
 *
 *   旧：{ kind: "mcp-catalog", form: "catalog", entries }
 *   新：{ kind: "plugin", plugin: "@wingsky-1/dsh-mcp-manager",
 *         form: "snapshot", sections: [{ name: "mcp-catalog", text: <原消息正文> }] }
 *
 * 历史责任止于 V3 wrapper：产物仍保持 v0/v1/v2，由 dsh 0.1.7-rc.2 的官方迁移链依次
 * 恢复到 v3、再转成 producer-owned V4。脚本不实现、也不伪造 v3→v4 migration，更不会把
 * v0/v1/v2 直接写成 V4。V3 wrapper 本身原样保留，交给官方迁移；V4 是当前格式，完全不动。
 *
 * v3 产物中若仍残留自造的旧 kind，默认也修成同一 V3 wrapper；`--legacy-only` 可只修
 * v0/v1/v2。只换 source 元数据，消息正文与事件序列保持不变。
 *
 * 安全约束（红线）：
 *   - 默认 dry-run，`--apply` 才落盘；
 *   - 落盘前先复制 `.bak-<时间戳>`，写入走「同目录临时文件 + fsync + 原子 rename」；
 *   - 幂等：已改写过的 source 不再匹配，重复运行零改动；
 *   - 只读 `~/.dsh/sessions/**`（可用 `--home` / `DSH_HOME` 覆盖）；
 *   - 写后自检：帧结构严格扫描 + 每帧解码 + 全行 JSON 解析 + 目标 source 完整 V3 wrapper。
 *
 * 用法：
 *   node scripts/maintenance/repair-mcp-catalog-sessions.mjs                 # 预演（默认：v0/v1/v2 + v3）
 *   node scripts/maintenance/repair-mcp-catalog-sessions.mjs --apply         # 落盘
 *   node scripts/maintenance/repair-mcp-catalog-sessions.mjs --legacy-only   # 只修 v0/v1/v2，不动 v3
 *   node scripts/maintenance/repair-mcp-catalog-sessions.mjs --session <id>  # 只处理一个会话
 *   node scripts/maintenance/repair-mcp-catalog-sessions.mjs --home /tmp/dsh-home
 *
 * 执行前请先停掉 dsh web：正在写入的会话日志不保证可安全重写。
 */
import {
  copyFileSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dshHome } from "../../shared/dsh-home.js";

/** 插件身份：与 src/server/catalog/impl/entries/index.ts 的 CATALOG_SOURCE_PLUGIN 同源（发布物内联，无法 import）。 */
export const CATALOG_SOURCE_PLUGIN = "@wingsky-1/dsh-mcp-manager";
/** 目录快照段名：与 src/server/catalog/impl/entries/index.ts 的 CATALOG_SECTION_NAME 同源。 */
export const CATALOG_SECTION_NAME = "mcp-catalog";
/** 旧形态的 source.kind（本脚本的匹配条件）。 */
export const LEGACY_CATALOG_KIND = "mcp-catalog";
/** 宿主 zstd 帧魔数（little-endian 0xFD2FB528）。 */
const ZSTD_MAGIC = 4247762216;
/** 宿主写盘的每帧压缩参数：带内容校验和（persistence-jsonl 的 CHECKSUM_OPTIONS）。 */
const CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } };
/** 会话日志文件名：`session.jsonl.zstd`(v0) / `session.v<N>.jsonl.zstd`。 */
const LOG_FILENAME = /^session(?:\.v(\d+))?\.jsonl\.zstd$/u;
/** 目录 snapshot 正文的最小结构；只校验 maintenance 自己的输出，不承担业务 reader admission。 */
const CATALOG_SNAPSHOT_PATTERN =
  /<system-reminder>\s*<available_mcp_servers>[\s\S]*<\/available_mcp_servers>\s*<\/system-reminder>/u;

/** 单行 JSON（与宿主写盘一致：无缩进、无多余空白）。 */
function stringifyRow(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("row is not JSON-serializable");
  return text;
}

/** 帧头变长字段的字节数（single-segment 标志 + 字典 id + content size 三段）。 */
function countFrameHeaderExtraBytes(descriptor) {
  const singleSegment = (descriptor & 32) !== 0;
  const contentSizeFlag = descriptor >>> 6;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  return (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
}

/**
 * 解析帧头，返回 `{descriptor, bodyStart}`。
 * 末尾不足一帧（写入中崩溃留下的 torn frame）返回 undefined：调用方必须按
 * persistence-jsonl 的恢复语义收下已落盘前缀，而不是抛错。
 */
function readFrameHeader(buffer, offset) {
  if (buffer.length - offset < 4) return undefined;
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
    throw new Error(`invalid frame magic at byte ${offset}`);
  offset += 4;
  if (offset === buffer.length) return undefined;
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
  const remainingHeaderBytes = countFrameHeaderExtraBytes(descriptor);
  if (buffer.length - offset < remainingHeaderBytes) return undefined;
  return { descriptor, bodyStart: offset + remainingHeaderBytes };
}

/** 逐块推进到帧尾并返回块区结束偏移；块头/载荷被截断时同样返回 undefined（torn 语义）。 */
function skipBlocks(buffer, offset) {
  for (;;) {
    if (buffer.length - offset < 3) return undefined;
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (buffer.length - offset < payloadBytes) return undefined;
    offset += payloadBytes;
    if (lastBlock) break;
  }
  return offset;
}

/**
 * 扫描多帧 zstd 容器。
 *
 * 与宿主同语义（persistence-jsonl 的 `scanZstdFrames`）：**完整帧**逐一收下，
 * 末尾若是不完整帧（写入中崩溃留下的 torn frame）则返回它的 `tornStart` 而**不抛错**
 * ——宿主正是这样在下次打开会话时恢复已落盘前缀的，脚本必须能读这种产物。
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}}
 */
export function scanContainer(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    const header = readFrameHeader(buffer, offset);
    if (header === undefined) return { frames, tornStart: start };
    const bodyEnd = skipBlocks(buffer, header.bodyStart);
    if (bodyEnd === undefined) return { frames, tornStart: start };
    offset = bodyEnd;
    const checksum = (header.descriptor & 4) !== 0;
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** 严格扫描（不允许 torn frame）；返回每个完整帧的字节区间。 */
export function scanFrames(buffer) {
  const scanned = scanContainer(buffer);
  if (scanned.tornStart !== undefined)
    throw new Error(`incomplete final frame at byte ${scanned.tornStart}`);
  return scanned.frames;
}

/**
 * 逐帧解码为 jsonl 行（保留原始行序）。
 *
 * 末尾 torn frame 用宿主的恢复语义解出已落盘前缀（`ZSTD_e_flush`），并丢掉可能被截断
 * 的最后一行 JSON——否则一个正在写入/曾崩溃的会话会让整个脚本抛错退出。
 */
export function decodeLines(buffer) {
  const scanned = scanContainer(buffer);
  const values = [];
  const push = (text) => {
    for (const line of text.split("\n")) if (line.length > 0) values.push(line);
  };
  for (const { start, end } of scanned.frames)
    push(zstdDecompressSync(buffer.subarray(start, end)).toString("utf8"));
  if (scanned.tornStart !== undefined) {
    const prefix = zstdDecompressSync(buffer.subarray(scanned.tornStart), {
      finishFlush: zlibConstants.ZSTD_e_flush,
    }).toString("utf8");
    push(prefix);
    while (values.length > 0) {
      try {
        JSON.parse(values.at(-1));
        break;
      } catch {
        values.pop();
      }
    }
  }
  return values;
}

/** 按宿主布局编码：header 一帧 + 其余行一帧，均为带校验和的完整帧。 */
export function encodeFrames(lines) {
  const [header, ...rest] = lines;
  const frames = [zstdCompressSync(Buffer.from(`${header}\n`, "utf8"), CHECKSUM_OPTIONS)];
  if (rest.length > 0)
    frames.push(zstdCompressSync(Buffer.from(`${rest.join("\n")}\n`, "utf8"), CHECKSUM_OPTIONS));
  return Buffer.concat(frames);
}

/**
 * 旧形态目录 source → 新形态。
 * 快照正文优先取原消息正文（模型当时看到的就是它，照抄可保证修复前后模型可见
 * 内容 byte 级一致）；取不到正文时按旧 source 的条目合成，至少不丢信息。
 */
export function rewriteCatalogSource(source, messageText) {
  const text =
    typeof messageText === "string" && messageText.length > 0
      ? messageText
      : legacySourceText(source);
  return {
    kind: "plugin",
    plugin: CATALOG_SOURCE_PLUGIN,
    form: "snapshot",
    sections: [{ name: CATALOG_SECTION_NAME, text }],
  };
}

/** 消息正文（user/message 与 inbox/spliced inserted message 共用）。 */
function messageTextOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.length > 0
    )
      return block.text;
  }
  return undefined;
}

/** 与当前目录正文相同的最小 HTML 转义；仅供正文缺失时合成 V3 snapshot。 */
function escapeCatalogText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\r\n]/gu, " ");
}

/**
 * 旧 source 的目录正文兜底：按当前 snapshot 的单射语法逐条渲染。
 * 正文缺失时也必须保留每个合法 entry，且官方迁移后业务 reader 仍能还原它。
 */
function legacySourceText(source) {
  const entries = Array.isArray(source.entries) ? source.entries : [];
  const lines = ["<system-reminder>", "<available_mcp_servers>"];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || typeof entry.name !== "string") continue;
    const name = escapeCatalogText(entry.name);
    lines.push(
      typeof entry.text === "string"
        ? `- \`${name}\`: ${escapeCatalogText(entry.text)}`
        : `- \`${name}\``,
    );
  }
  lines.push("</available_mcp_servers>", "</system-reminder>");
  return lines.join("\n");
}

/** 是否命中旧形态目录 source。 */
export function isLegacyCatalogSource(source) {
  return typeof source === "object" && source !== null && source.kind === LEGACY_CATALOG_KIND;
}

/** 改写一条消息的 source（命中才改）。 */
function rewriteMessage(message, stats) {
  if (typeof message !== "object" || message === null) return message;
  if (!isLegacyCatalogSource(message.source)) return message;
  stats.sources += 1;
  return { ...message, source: rewriteCatalogSource(message.source, messageTextOf(message)) };
}

/** 改写 `user/message` 的 data.source；未命中旧形态时原样返回。 */
function rewriteUserMessageRow(row, stats) {
  if (!isLegacyCatalogSource(row.data.source)) return { row, changed: false };
  stats.sources += 1;
  return {
    row: {
      ...row,
      data: {
        ...row.data,
        source: rewriteCatalogSource(row.data.source, messageTextOf(row.data)),
      },
    },
    changed: true,
  };
}

/** 改写 `agent/inbox/spliced` 的 data.inserted[]；零命中时原样返回。 */
function rewriteSplicedRow(row, stats, before) {
  const inserted = row.data.inserted.map((message) => rewriteMessage(message, stats));
  if (stats.sources === before) return { row, changed: false };
  return { row: { ...row, data: { ...row.data, inserted } }, changed: true };
}

/**
 * 改写一条物理行（两条注入路径都要覆盖）：`user/message` 的 data.source，
 * 以及 `agent/inbox/spliced` 里 data.inserted[] 每条消息的 source。
 * @returns 改写后的行与是否发生改写。
 */
export function rewriteRow(row, stats = { sources: 0 }) {
  const before = stats.sources;
  if (row?.type === "user/message" && row.data !== undefined)
    return rewriteUserMessageRow(row, stats);
  if (row?.type === "agent/inbox/spliced" && Array.isArray(row.data?.inserted))
    return rewriteSplicedRow(row, stats, before);
  return { row, changed: false };
}

/** 判定某个会话目录的待迁移日志（取版本最高且 < 3 的那份）。 */
export function migrationCandidate(files) {
  let best;
  for (const file of files) {
    const match = LOG_FILENAME.exec(file);
    if (match === null) continue;
    const version = match[1] === undefined ? 0 : Number(match[1]);
    if (version >= 3) continue;
    if (best === undefined || version > best.version) best = { file, version };
  }
  return best;
}

/**
 * 处理一个会话目录。
 *
 * 目标选择（#723 后续）：
 * 1. 有 v0/v1/v2 产物 → 修成 V3 wrapper（不修就会被官方历史迁移闸门拒绝）；
 * 2. 否则看 v3 产物 → 默认也修其中残留的旧 kind；V3 wrapper 本身原样保留，
 *    交给官方 v3→v4 链。传 `legacyOnly` 可只修 v0/v1/v2。
 * @param {string} sessionDir 会话目录。
 * @param {{legacyOnly?: boolean}} [options] true 时只处理 v0/v1/v2，不处理 v3。
 * @returns {{status: string, sources: number, file?: string, rows?: unknown[]}}
 */
export function planSession(sessionDir, { legacyOnly = false } = {}) {
  const files = existsSync(sessionDir) ? readdirSync(sessionDir) : [];
  const candidate = migrationCandidate(files);
  const v3 = files
    .filter((file) => /^session\.v3\.jsonl\.zstd$/u.test(file))
    .map((file) => ({ file, version: 3 }))[0];
  const hasV4 = files.some((file) => /^session\.v4\.jsonl\.zstd$/u.test(file));
  const target = candidate ?? (legacyOnly ? undefined : v3);
  if (target === undefined) {
    const status = v3 !== undefined ? "already-v3" : hasV4 ? "already-v4" : "no-log";
    return { status, sources: 0 };
  }
  const lines = decodeLines(readFileSync(join(sessionDir, target.file)));
  const stats = { sources: 0 };
  const rows = [];
  for (const line of lines) {
    const parsed = JSON.parse(line);
    rows.push(rewriteRow(parsed, stats).row);
  }
  return {
    status: stats.sources > 0 ? "needs-repair" : "clean",
    sources: stats.sources,
    file: target.file,
    rows,
  };
}

function jsonPointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** 收集所有 source 对象及其 JSON Pointer；输出与原日志据此保持同一事件位置。 */
function collectSourceLocations(value, path = "", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectSourceLocations(item, `${path}/${index}`, found);
    });
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${jsonPointerSegment(key)}`;
    if (key === "source" && child !== null && typeof child === "object" && !Array.isArray(child)) {
      found.push({ path: childPath, source: child });
    }
    collectSourceLocations(child, childPath, found);
  }
  return found;
}

function legacySourceLocations(rows) {
  return collectSourceLocations(rows)
    .filter(({ source }) => isLegacyCatalogSource(source))
    .map(({ path }) => path);
}

function describeValue(value) {
  if (value === undefined) return "<missing>";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function invalidRepairSource(path, field, expected, value) {
  throw new Error(
    `repaired log ${path} has invalid ${field}: expected ${expected}, got ${describeValue(value)}`,
  );
}

/** maintenance 只核对 repair target；不解释其它 plugin source，也不承担 V4 admission。 */
function assertRepairedCatalogSource({ path, source }) {
  if (source.kind !== "plugin") {
    invalidRepairSource(path, "source.kind", JSON.stringify("plugin"), source.kind);
  }
  if (source.plugin !== CATALOG_SOURCE_PLUGIN) {
    invalidRepairSource(
      path,
      "source.plugin",
      JSON.stringify(CATALOG_SOURCE_PLUGIN),
      source.plugin,
    );
  }
  if (source.form !== "snapshot") {
    invalidRepairSource(path, "source.form", JSON.stringify("snapshot"), source.form);
  }
  if (!Array.isArray(source.sections)) {
    invalidRepairSource(path, "source.sections", "an array", source.sections);
  }
  const catalogSections = source.sections.filter(
    (section) =>
      section !== null &&
      typeof section === "object" &&
      !Array.isArray(section) &&
      section.name === CATALOG_SECTION_NAME,
  );
  if (catalogSections.length === 0) {
    invalidRepairSource(
      path,
      "source.sections[].name",
      `at least one ${JSON.stringify(CATALOG_SECTION_NAME)} section`,
      source.sections,
    );
  }
  for (const section of catalogSections) {
    if (!CATALOG_SNAPSHOT_PATTERN.test(section.text)) {
      invalidRepairSource(
        path,
        `source.sections[${CATALOG_SECTION_NAME}].text`,
        "a catalog snapshot",
        section.text,
      );
    }
  }
}

/** 落盘：备份 + 临时文件 + fsync + 原子 rename，随后自检。 */
export function applyRepair(sessionDir, file, rows) {
  const target = join(sessionDir, file);
  const originalRows = decodeLines(readFileSync(target)).map((line) => JSON.parse(line));
  const repairSourceLocations = legacySourceLocations(originalRows);
  const encoded = encodeFrames(rows.map(stringifyRow));
  verifyRepaired(encoded, repairSourceLocations);
  const backup = `${target}.bak-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
  copyFileSync(target, backup);
  const temp = join(sessionDir, `.${basename(target)}.repair-${process.pid}`);
  try {
    const fd = openSync(temp, "wx");
    try {
      writeFileSync(fd, encoded);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return backup;
}

/**
 * 写后自检：帧结构完整、逐帧可解码、每行 JSON、零遗留旧 kind，且每个指定 repair
 * source 都是完整目录 V3 wrapper。省略路径时，纯内存调用会把所有 source 当 target。
 */
export function verifyRepaired(buffer, repairSourceLocations) {
  const lines = decodeLines(buffer);
  if (lines.length === 0) throw new Error("repaired log has no rows");
  const rows = lines.map((line) => JSON.parse(line));
  const sources = collectSourceLocations(rows);
  const leftover = sources.filter(({ source }) => isLegacyCatalogSource(source)).length;
  if (leftover > 0)
    throw new Error(`repaired log still carries ${leftover} legacy catalog source(s)`);

  const targets =
    repairSourceLocations === undefined
      ? sources
      : repairSourceLocations.map((path) => {
          const target = sources.find((candidate) => candidate.path === path);
          if (target === undefined) {
            throw new Error(`repaired log is missing repair source ${path}`);
          }
          return target;
        });
  for (const target of targets) assertRepairedCatalogSource(target);
  return { rows: lines.length };
}

/** 遍历 DSH_HOME 下的会话目录（会话目录名不统一：`session-<uuid>` 与裸 uuid 都有）。 */
export function listSessionDirs(dshHome) {
  const root = join(dshHome, "sessions");
  if (!existsSync(root)) return [];
  const dirs = [];
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const name of readdirSync(projectDir)) {
      const sessionDir = join(projectDir, name);
      if (statSync(sessionDir).isDirectory()) dirs.push(sessionDir);
    }
  }
  return dirs;
}

/** CLI 参数解析。 */
export function parseArgs(argv) {
  const options = {
    apply: false,
    legacyOnly: false,
    session: undefined,
    home: dshHome(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--legacy-only") options.legacyOnly = true;
    else if (arg === "--session") options.session = argv[++index];
    else if (arg.startsWith("--session=")) options.session = arg.slice("--session=".length);
    else if (arg === "--home") options.home = argv[++index];
    else if (arg.startsWith("--home=")) options.home = arg.slice("--home=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = resolve(options.home);
  const dirs = listSessionDirs(home).filter(
    (dir) => options.session === undefined || basename(dir) === options.session,
  );
  console.log(
    `[repair-mcp-catalog] DSH_HOME=${home}，会话目录 ${dirs.length} 个，模式=${options.apply ? "apply" : "dry-run（加 --apply 落盘）"}，范围=${options.legacyOnly ? "仅 v0/v1/v2（--legacy-only）" : "v0/v1/v2 + v3"}`,
  );
  let affected = 0;
  let changedFiles = 0;
  let sources = 0;
  for (const dir of dirs) {
    const plan = planSession(dir, { legacyOnly: options.legacyOnly });
    if (plan.status !== "needs-repair") continue;
    affected += 1;
    sources += plan.sources;
    console.log(
      `${options.apply ? "修复" : "待修复"} ${basename(dir)} (${plan.file})：${plan.sources} 处目录 source`,
    );
    if (options.apply) {
      const backup = applyRepair(dir, plan.file, plan.rows);
      changedFiles += 1;
      console.log(`  备份 ${basename(backup)}`);
    }
  }
  console.log(
    `[repair-mcp-catalog] 受影响会话 ${affected} 个 / 目录 source ${sources} 处；实际落盘 ${changedFiles} 个文件`,
  );
  if (!options.apply && affected > 0)
    console.log("[repair-mcp-catalog] 预演完成，确认无误后加 --apply 落盘（请先停掉 dsh web）");
  if (dirs.length === 0) console.log("[repair-mcp-catalog] 未找到会话目录，检查 --home / DSH_HOME");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
