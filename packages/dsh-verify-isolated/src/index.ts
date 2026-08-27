/**
 * dsh-verify-isolated — 隔离环境浏览器验证 skill（宿主端注册）。
 *
 * 职责：通过 ctx.skills.registerProvider 注册一个极简 skill provider，
 * 把包内 SKILL.md（隔离验证方法论）暴露给 dsh 会话。随插件分发：
 * `dsh plugin --profile <name> add @wingsky-1/dsh-verify-isolated` 装上后，
 * profile 内所有会话即可用该 skill。
 *
 * 设计：
 * - 不自引 dsh-skill-filesystem（其依赖 chokidar/yaml/dsh-fs 等过重），
 *   直接用官方 ctx.skills.registerProvider（dsh-skill 是注册表第一等公民，
 *   skill-filesystem 也只是它的一个实现）；
 * - 仅 import type（编译期擦除）：dsh-skill / cordis 类型来自 catalog 锁版，
 *   运行时零依赖，esbuild 产物自包含；
 * - SKILL.md 与 scripts/verify-isolated.sh 随包 files 白名单分发；
 * - frontmatter 解析复用 shared/frontmatter.js（与全仓同源）。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseFrontmatter } from "../../../shared/frontmatter.js";
import type { Context } from "@deepseek-ai/cordis";
import type {
  SkillCandidate,
  SkillDefinition,
  SkillProvider,
  SkillProviderControl,
  SkillSource,
} from "@deepseek-ai/dsh-skill";

/** 包根目录（含 SKILL.md / scripts/），随 files 白名单分发。 */
const SKILL_DIR = fileURLToPath(new URL("../", import.meta.url));

/** provider 名（dsh skills 注册表内唯一）。 */
const PROVIDER_NAME = "dsh-verify-isolated";

/** SKILL.md 绝对路径。 */
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");

/** 本 provider 的 source 桶（prompt 可见元数据）。 */
const SOURCE: SkillSource = "bundled";

/** 读并解析包内 SKILL.md 的 frontmatter。 */
async function readSkillMeta(): Promise<{ name: string; description: string }> {
  const md = await readFile(SKILL_FILE, "utf8");
  const fm = parseFrontmatter(md);
  return {
    name: typeof fm.name === "string" ? fm.name : PROVIDER_NAME,
    description: typeof fm.description === "string" ? fm.description : "",
  };
}

/** 构造极简目录型 provider：list 返回包内 SKILL.md 候选，get 返回完整 body。 */
function createProvider(_control: SkillProviderControl): SkillProvider {
  return {
    name: PROVIDER_NAME,
    async list(): Promise<readonly SkillCandidate[]> {
      const { name, description } = await readSkillMeta();
      return [
        {
          name,
          description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: SOURCE,
          provider: PROVIDER_NAME,
          rank: 0,
          locator: { kind: "directory", path: SKILL_FILE },
          path: SKILL_FILE,
        },
      ];
    },
    async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
      const file = candidate.path ?? SKILL_FILE;
      const md = await readFile(file, "utf8");
      const fm = parseFrontmatter(md);
      if (typeof fm.name !== "string") return undefined;
      return {
        name: fm.name,
        description: typeof fm.description === "string" ? fm.description : "",
        content: md,
        invocation: { modelInvocable: true, userInvocable: true },
        source: SOURCE,
        provider: PROVIDER_NAME,
        resourceBase: { kind: "directory", path: SKILL_DIR },
      };
    },
  };
}

/** 插件挂载入口：注册 skill provider，随插件生命周期加载/卸载。 */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider((control) => createProvider(control));
}

/** cordis 注入声明：本插件需要 ctx.skills（skill 注册表）。 */
export const inject = ["skills"];

export { PROVIDER_NAME, SKILL_DIR };
