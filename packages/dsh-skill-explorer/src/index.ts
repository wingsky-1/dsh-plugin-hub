/**
 * dsh-skill-explorer — 主机端。为 web GUI 提供技能中心的数据源：
 * 注册 GET /api/dsh-skill-explorer/list（按来源分级：系统内置 /
 * 项目 / 用户 / 自定义 / 运行时），以及启用/禁用（set-enabled）、
 * 创建（create）、删除（delete）路由。
 *
 * 数据组装：
 * 1. 主数据来自文件系统扫描——按 dsh-skill-filesystem 的根约定
 *    （<项目根>/.dsh/skills、<项目根>/.agents/skills、customSkillDirs、
 *    ~/.dsh/skills、~/.agents/skills）读取一层 SKILL.md / <name>.md，
 *    解析 frontmatter（name/description/whenToUse）。原因是 web profile
 *    下 skill-filesystem 提供方只挂载在 agent preset 的 scope 层，
 *    host 平面（本路由）从 ctx.skills 读不到项目/用户技能。
 *    "项目根"取活跃会话的 workspace（session.header.cwd 的最近 .git
 *    祖先），而不是 dsh web 的启动目录——这样任何会话打开的项目技能
 *    都能展示。
 * 2. 注册表补充——ctx.skills.snapshot({ cwd }) 取全局层可见的技能
 *    （bundled / runtime 等非 filesystem 来源），与文件系统结果按名称
 *    合并（文件系统条目优先，注册表补充 whenToUse / 可调用标记）。
 *
 * 零运行时依赖（刻意不引入 schemastery / yaml）：frontmatter 用轻量
 * 解析；唯一配置项（enabled/customSkillDirs/dshHome/agentsHome）在
 * apply 内处理默认值。
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseFrontmatter, setFrontmatterField } from "../../../shared/frontmatter.js";
import type { PluginContext, DshWebServer, DshLogger } from "../../../types/dsh.js";

// 保持导出面稳定（外部可能 import 这两个函数）。
export { parseFrontmatter, setFrontmatterField } from "../../../shared/frontmatter.js";

/** 稳定的 cordis 插件名。 */
export const name = "skill-explorer";

/**
 * 需要已初始化的技能注册表、web 服务器与会话注册表。
 * sessions 用于解析"项目级"技能的基准：项目根取活跃会话的 workspace
 * （session.header.cwd），而不是 dsh web 的启动目录。
 */
export const inject = ["skills", "webServer", "sessions"];

/** 只读路由路径。 */
export const ROUTE = "/api/dsh-skill-explorer/list";

/** 启用/禁用路由（改写 SKILL.md frontmatter 的 disable-model-invocation）。 */
export const SET_ENABLED_ROUTE = "/api/dsh-skill-explorer/set-enabled";

/** 创建技能路由（写所选根目录）。 */
export const CREATE_ROUTE = "/api/dsh-skill-explorer/create";

/** 删除技能路由（移到 .trash）。 */
export const DELETE_ROUTE = "/api/dsh-skill-explorer/delete";

/** 健康检查路由（插件是否加载、技能总数）。 */
export const HEALTH_ROUTE = "/api/dsh-skill-explorer/health";

// ---------------------------------------------------------------- 类型

/** 技能摘要（文件系统扫描与注册表补充合并后的统一结构）。 */
export interface SkillSummary {
  name: string;
  description: string;
  /** whenToUse 兼容缺失/任意值（前端原样透传）。 */
  whenToUse?: unknown;
  /** 来源提供方（filesystem / orca / runtime 等）；注册表来源可能缺失。 */
  provider?: string;
  level: string;
  /** 可编辑文件路径（bundled/runtime 等注册表独有技能可能无文件）。 */
  path?: string;
  modelInvocable: boolean;
  userInvocable: boolean;
}

/** 注册表快照里的一条技能（按本插件实际读取的字段收紧，未知面 unknown）。 */
interface RegistrySkill {
  name: string;
  description: string;
  whenToUse?: unknown;
  provider?: string;
  source?: unknown;
  resourceBase?: { kind?: unknown; path?: unknown };
  invocation?: { modelInvocable?: unknown; userInvocable?: unknown };
  [key: string]: unknown;
}

/** 注册表快照（ctx.skills.snapshot 的返回）。 */
interface RegistrySnapshot {
  complete: boolean;
  skills: RegistrySkill[];
}

/** 技能注册表服务（ctx.skills）按实际调用面收紧的最小接口。 */
interface SkillRegistry {
  snapshot(opts: { cwd: string }): Promise<RegistrySnapshot>;
  [key: string]: unknown;
}

/** 会话注册表服务（ctx.sessions）按实际调用面收紧的最小接口。 */
interface SkillSessions {
  list(): SessionItem[];
}

/** 一次会话的最小面（读 header.cwd）。 */
interface SessionItem {
  readonly header?: unknown;
  [key: string]: unknown;
}

/** apply 接收的 ctx：在 PluginContext 基础上收紧 skills/sessions 服务面。 */
interface SkillCtx extends PluginContext {
  skills: SkillRegistry;
  sessions: SkillSessions;
}

/** apply 配置项（老配置缺省时在 apply 内补默认值，兼容既有配置）。 */
export interface SkillConfig {
  enabled?: boolean;
  customSkillDirs?: string[];
  dshHome?: string;
  agentsHome?: string;
}

/** collectSkills 入参。 */
export interface CollectOptions {
  cwd: string;
  projectRoots?: string[];
  customSkillDirs: string[];
  dshHome: string;
  agentsHome: string;
  registry: SkillRegistry;
}

/** 分组展示（SOURCE_GROUPS 与注册表独有来源共用）。 */
interface SkillGroup {
  key: string;
  title: string;
  hint: string;
  skills: SkillSummary[];
}

/** 生成新技能文件内容（创建用）。 */
export function buildSkillContent(name: string, description: string, whenToUse: unknown, content: string, disabled: boolean): string {
  const lines: string[] = ["---", `name: ${name}`, `description: ${description.replace(/[\r\n]/gu, " ")}`];
  if (typeof whenToUse === "string" && whenToUse.trim() !== "") lines.push(`whenToUse: ${whenToUse.replace(/[\r\n]/gu, " ")}`);
  if (disabled === true) lines.push("disable-model-invocation: true");
  lines.push("---", "", content.trim(), "");
  return lines.join("\n");
}

// 辅助函数统一来自仓库共享层（loopback 围栏 / readBody 双模式兼容 async-iterator 桩）。
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { readBody } from "../../../shared/host-utils.js";
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { readBody } from "../../../shared/host-utils.js";

/** 分级展示顺序与文案。文件系统扫描产生这些 level；注册表来源映射到同一组。 */
const SOURCE_GROUPS: { key: string; title: string; hint: string }[] = [
  { key: "bundled", title: "系统内置", hint: "DSH 随附与插件提供的技能" },
  { key: "project-dsh", title: "项目技能（.dsh/skills）", hint: "仅当前项目" },
  { key: "project-agents", title: "项目技能（.agents/skills）", hint: "仅当前项目" },
  { key: "custom", title: "自定义目录", hint: "customSkillDirs 配置" },
  { key: "user-dsh", title: "用户技能（~/.dsh/skills）", hint: "本机所有项目" },
  { key: "user-agents", title: "用户技能（~/.agents/skills）", hint: "本机所有项目" },
  { key: "runtime", title: "运行时注册", hint: "插件代码内嵌注册" },
];

/** 注册表 source → 展示 level 的映射（未列出的归"其他来源"）。 */
const REGISTRY_SOURCE_LEVEL = new Map(SOURCE_GROUPS.map((g) => [g.key, g.key]));

// ---------------------------------------------------------------- 工具函数

/** 从 cwd 向上找最近含 .git 的目录（无则返回 cwd）。 */
function findProjectRoot(cwd: string): string {
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/**
 * 读取一个 skill 根下的所有技能（一层：<name>/SKILL.md 或 <name>.md）。
 * 异步 IO（fs/promises），多个根可并行扫描，避免阻塞事件循环。
 */
async function scanSkillRoot(root: string, level: string, into: Map<string, SkillSummary>): Promise<void> {
  if (!existsSync(root)) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    let file;
    if (entry.isDirectory()) file = join(root, name, "SKILL.md");
    else if (entry.isFile() && name.endsWith(".md")) file = join(root, name);
    else continue;
    if (!existsSync(file)) continue;
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(content);
    const skillName = (parsed.name as string | undefined) ?? name.replace(/\.md$/, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) continue;
    into.set(skillName, {
      name: skillName,
      description: (parsed.description as string | undefined) ?? "(无描述)",
      whenToUse: parsed.whenToUse,
      provider: "filesystem",
      level,
      path: file,
      // 官方 frontmatter 调用策略：disable-model-invocation / user-invocable。
      modelInvocable: parsed.disableModelInvocation !== true,
      userInvocable: parsed.userInvocable !== false,
    });
  }
}

/** 序列化一条注册表摘要为前端 payload（保留 source 供分组）。 */
function serializeRegistry(skill: RegistrySkill): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    provider: skill.provider,
    level: REGISTRY_SOURCE_LEVEL.get(skill.source as string) ?? `other:${skill.source as string}`,
    path: skill.resourceBase?.kind === "directory" ? (skill.resourceBase.path as string) : undefined,
    modelInvocable: (skill.invocation?.modelInvocable ?? false) as boolean,
    userInvocable: (skill.invocation?.userInvocable ?? false) as boolean,
  };
}

/** 按 level 分组、按组顺序与组内名称排序。 */
function buildPayload(
  skills: SkillSummary[],
  complete: boolean,
  cwd: string,
  projectRoots: string[],
): { cwd: string; projectRoots: string[]; complete: boolean; groups: SkillGroup[] } {
  const byLevel: Map<string, SkillSummary[]> = new Map();
  for (const skill of skills) {
    const list = byLevel.get(skill.level) ?? [];
    list.push(skill);
    byLevel.set(skill.level, list);
  }
  const known: Set<string> = new Set(SOURCE_GROUPS.map((g) => g.key));
  const groups: SkillGroup[] = SOURCE_GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    hint: group.hint,
    skills: (byLevel.get(group.key) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.skills.length > 0);
  const leftovers: SkillGroup[] = [...byLevel.entries()]
    .filter(([key]) => !known.has(key))
    .map(([key, list]) => ({
      key,
      title: key.startsWith("other:") ? `其他来源（${key.slice(6)}）` : `其他（${key}）`,
      hint: "",
      skills: list.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  return { cwd, projectRoots, complete, groups: [...groups, ...leftovers] };
}

// ------------------------------------------------------------------ 主逻辑

/**
 * 组装分级技能列表：文件系统扫描（主）+ 注册表补充（合并）。
 * @param options - 见 CollectOptions。
 * @returns 技能列表与注册表是否完整可用。
 */
export async function collectSkills({
  cwd,
  projectRoots,
  customSkillDirs,
  dshHome,
  agentsHome,
  registry,
}: CollectOptions): Promise<{ skills: SkillSummary[]; complete: boolean }> {
  const byName: Map<string, SkillSummary> = new Map();
  const roots: Set<string> = new Set(projectRoots !== undefined && projectRoots.length > 0 ? projectRoots : [findProjectRoot(cwd)]);
  // 各根独立扫描，并行执行（共享 Map 写入在单线程下原子，无竞态）。
  const scanTasks: Promise<void>[] = [];
  for (const root of roots) {
    scanTasks.push(scanSkillRoot(join(root, ".dsh", "skills"), "project-dsh", byName));
    scanTasks.push(scanSkillRoot(join(root, ".agents", "skills"), "project-agents", byName));
  }
  for (const dir of customSkillDirs ?? []) scanTasks.push(scanSkillRoot(dir, "custom", byName));
  scanTasks.push(scanSkillRoot(join(dshHome, "skills"), "user-dsh", byName));
  scanTasks.push(scanSkillRoot(join(agentsHome, "skills"), "user-agents", byName));
  await Promise.all(scanTasks);

  // 注册表补充：同名时补全 whenToUse / 可调用标记；注册表独有（bundled/runtime 等）整条加入。
  let complete = true;
  try {
    const snapshot: RegistrySnapshot = await registry.snapshot({ cwd });
    complete = snapshot.complete;
    for (const skill of snapshot.skills) {
      const existing = byName.get(skill.name);
      const serialized = serializeRegistry(skill);
      if (existing === undefined) {
        byName.set(skill.name, serialized);
      } else {
        if (serialized.whenToUse !== undefined) existing.whenToUse = serialized.whenToUse;
        if (serialized.provider !== undefined) existing.provider = serialized.provider;
        existing.modelInvocable = serialized.modelInvocable;
        existing.userInvocable = serialized.userInvocable;
      }
    }
  } catch (error) {
    // 注册表不可用时降级：文件系统结果仍然有效。
    complete = false;
  }
  return { skills: [...byName.values()], complete };
}

/** 活跃会话的 workspace cwd 列表（会话注册表不可用时降级为空）。 */
function activeSessionCwds(ctx: SkillCtx): string[] {
  try {
    const cwds = ctx.sessions
      .list()
      .map((session) => (session.header as { cwd?: unknown } | undefined)?.cwd)
      .filter((cwd): cwd is string => typeof cwd === "string" && cwd !== "");
    return cwds;
  } catch {
    return [];
  }
}

/** 统一 JSON 响应：写状态码 + JSON 报文。 */
function reply(res: ServerResponse): (status: number, payload: unknown) => void {
  return (status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };
}

/** loopback 围栏 + method 校验：任一不满足则回 403/405 并返回 false。 */
function guard(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (!isLoopbackRequest(req)) {
    reply(res)(403, { error: "forbidden: loopback-only" });
    return false;
  }
  if (req.method !== method) {
    reply(res)(405, { error: `method not allowed: ${req.method}` });
    return false;
  }
  return true;
}

/**
 * 挂载技能中心路由。
 * @param ctx - 宿主插件上下文（含 skills 注册表与 webServer 服务）。
 * @param config - 插件配置（enabled / customSkillDirs / dshHome / agentsHome）。
 */
export function apply(ctx: SkillCtx, config: SkillConfig = {}): void {
  if (config.enabled === false) return;
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? homedir() + sep + ".dsh";
  const agentsHome = config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? homedir() + sep + ".agents";
  const customSkillDirs: string[] = Array.isArray(config.customSkillDirs) ? config.customSkillDirs : [];

  // 路由统一辅助：JSON 响应 + loopback 围栏 + method 校验（单一实现，5 路由共用）。
  ctx.effect(
    () => {
      const disposers: (() => void)[] = [
        ctx.webServer.register({
          kind: "exact",
          path: ROUTE,
          handler: async (req, res) => {
            if (!guard(req, res, "GET")) return;
            try {
              const url = new URL(req.url ?? "/", "http://x");
              // 项目根解析基准：显式 ?cwd= 优先，其次活跃会话的 workspace，
              // process.cwd()（dsh web 启动目录）仅作最后兜底。
              const cwd = url.searchParams.get("cwd") || process.cwd();
              const projectRoots = activeSessionCwds(ctx).map((sessionCwd) => findProjectRoot(sessionCwd));
              const { skills, complete } = await collectSkills({ cwd, projectRoots, customSkillDirs, dshHome, agentsHome, registry: ctx.skills });
              reply(res)(200, buildPayload(skills, complete, cwd, [...new Set(projectRoots)]));
            } catch (error) {
              ctx.logger.warn(error);
              reply(res)(500, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
        ctx.webServer.register({
          kind: "exact",
          path: SET_ENABLED_ROUTE,
          handler: async (req, res) => {
            if (!guard(req, res, "POST")) return;
            try {
              // 读取 JSON body。
              const chunks: Buffer[] = [];
              for await (const chunk of req) chunks.push(chunk as Buffer);
              let body: unknown;
              try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                reply(res)(400, { error: "invalid JSON body" });
                return;
              }
              const { name, enabled } = (body ?? {}) as { name?: unknown; enabled?: unknown };
              if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof enabled !== "boolean") {
                reply(res)(400, { error: "expected { name, enabled }" });
                return;
              }
              // 按名称查技能文件（只信任扫描结果里的 path，杜绝任意路径写入）。
              const projectRoots = activeSessionCwds(ctx).map((sessionCwd) => findProjectRoot(sessionCwd));
              const { skills } = await collectSkills({ cwd: process.cwd(), projectRoots, customSkillDirs, dshHome, agentsHome, registry: ctx.skills });
              const skill = skills.find((candidate) => candidate.name === name);
              if (skill === undefined || skill.path === undefined) {
                reply(res)(404, { error: `skill ${name} has no editable file (bundled/runtime skills cannot be toggled)` });
                return;
              }
              // 禁用 = disable-model-invocation: true；启用 = false。
              const frontmatter = setFrontmatterField(skill.path, "disable-model-invocation", enabled ? false : true);
              reply(res)(200, {
                name,
                enabled: frontmatter.disableModelInvocation !== true,
                modelInvocable: frontmatter.disableModelInvocation !== true,
                path: skill.path,
              });
            } catch (error) {
              ctx.logger.warn(error);
              reply(res)(500, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
        ctx.webServer.register({
          kind: "exact",
          path: CREATE_ROUTE,
          handler: async (req, res) => {
            if (!guard(req, res, "POST")) return;
            try {
              const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
              const { root, name, description, whenToUse, content } = body;
              if (root !== "user" && root !== "project") return reply(res)(400, { error: "root 必须是 user（~/.dsh/skills）或 project（项目 .dsh/skills）" });
              if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(name)) return reply(res)(400, { error: "name 必须是 kebab-case（小写字母/数字开头）" });
              if (typeof description !== "string" || description.trim() === "") return reply(res)(400, { error: "description 必填" });
              if (typeof content !== "string" || content.trim() === "") return reply(res)(400, { error: "content 必填" });
              if (Buffer.byteLength(content, "utf8") > 64 * 1024) return reply(res)(400, { error: "content 超过 64KB 上限" });
              const baseDir = root === "user" ? join(dshHome, "skills") : findProjectRoot(activeSessionCwds(ctx)[0] ?? process.cwd()) + sep + ".dsh" + sep + "skills";
              const targetDir = join(baseDir, name);
              const target = join(targetDir, "SKILL.md");
              if (existsSync(target)) return reply(res)(409, { error: `技能 ${name} 已存在于 ${root === "user" ? "用户" : "项目"}目录` });
              await mkdir(targetDir, { recursive: true });
              const fileContent = buildSkillContent(name, description.trim(), whenToUse, content, false);
              await writeFile(target, fileContent, "utf8");
              reply(res)(200, { ok: true, name, path: target });
            } catch (error) {
              ctx.logger.warn(error);
              reply(res)(500, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
        ctx.webServer.register({
          kind: "exact",
          path: DELETE_ROUTE,
          handler: async (req, res) => {
            if (!guard(req, res, "POST")) return;
            try {
              const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
              const { name } = body;
              if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(name)) return reply(res)(400, { error: "expected { name }" });
              const projectRoots = activeSessionCwds(ctx).map((sessionCwd) => findProjectRoot(sessionCwd));
              const { skills } = await collectSkills({ cwd: process.cwd(), projectRoots, customSkillDirs, dshHome, agentsHome, registry: ctx.skills });
              const skill = skills.find((candidate) => candidate.name === name);
              if (skill === undefined || skill.path === undefined) return reply(res)(404, { error: `skill ${name} 没有可删除的文件（bundled/runtime 不可删）` });
              const trashDir = join(dirname(skill.path), ".trash");
              await mkdir(trashDir, { recursive: true });
              const trashTarget = join(trashDir, `${Date.now()}-SKILL.md`);
              await rename(skill.path, trashTarget);
              reply(res)(200, { ok: true, name, moved: trashTarget });
            } catch (error) {
              ctx.logger.warn(error);
              reply(res)(500, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
        ctx.webServer.register({
          kind: "exact",
          path: HEALTH_ROUTE,
          handler: async (req, res) => {
            if (!guard(req, res, "GET")) return;
            const projectRoots = activeSessionCwds(ctx).map((sessionCwd) => findProjectRoot(sessionCwd));
            const { skills } = await collectSkills({ cwd: process.cwd(), projectRoots, customSkillDirs, dshHome, agentsHome, registry: ctx.skills });
            reply(res)(200, { ok: true, plugin: "dsh-skill-explorer", skills: skills.length });
          },
        }),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
    "dsh-skill-explorer: routes",
  );
}
