/**
 * dsh-mcp-manager — unit：项目根发现（#1137 判据 D02 / D03）。
 *
 * 全部在 mkdtemp 真文件系统上跑：标记形态（.git 目录 / .git **文件** / .dsh / .mcp.json）、
 * 最近祖先优先、16 层上限、DSH_HOME 全局排除、无标记目录自身为根、symlink 归并，
 * 以及「共享 git common-dir 不把 P 与 W 收敛成同根」。
 *
 * 产物零污染：每个用例自建 mkdtemp 目录并在 afterEach 清理，不写仓库内任何路径。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markerFreeTempParent, tempDshHome } from "../../helpers.ts";

const { findProjectRoot, normalizedProjectRoot } =
  await import("../../../src/server/workspace/interface.ts");

describe("findProjectRoot 标记发现（#1137 D02）", () => {
  let root: string;
  let home: ReturnType<typeof tempDshHome>;

  beforeEach(() => {
    // findProjectRoot 会向上找标记；本机 /tmp 可能有 .git，测试根不能放在那里，
    // 否则「无标记目录回落自身」会被祖先标记污染。/var/tmp 是同样受 mkdtemp 隔离、
    // 但默认无项目标记的测试根。
    root = mkdtempSync(join(markerFreeTempParent(), "dsh-mcp-root-"));
    // DSH_HOME 必须隔离：.dsh 全局排除判据依赖它，且绝不能碰真实 ~/.dsh。
    home = tempDshHome();
  });

  afterEach(() => {
    home.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it(".git 目录形态：命中该目录为根", async () => {
    const project = join(root, "proj-git-dir");
    mkdirSync(join(project, ".git"), { recursive: true });
    const deep = join(project, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectRoot(deep)).toBe(project);
  });

  it(".git 文件形态（worktree）：视为标记，独立生效", async () => {
    const project = join(root, "proj-git-file");
    mkdirSync(project, { recursive: true });
    // worktree 的 .git 是**文件**（gitdir: 指针），不是目录。existsSync 对两者同真，
    // 但本断言锁的是「文件形态也必须命中」——若实现改成只认目录，这里会红。
    writeFileSync(join(project, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    const deep = join(project, "src", "lib");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectRoot(deep)).toBe(project);
  });

  it(".dsh 形态：命中该目录为根", async () => {
    const project = join(root, "proj-dsh");
    mkdirSync(join(project, ".dsh"), { recursive: true });
    const deep = join(project, "x");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectRoot(deep)).toBe(project);
  });

  it(".mcp.json 形态：命中该目录为根", async () => {
    const project = join(root, "proj-mcpjson");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".mcp.json"), "{}\n");
    const deep = join(project, "y");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectRoot(deep)).toBe(project);
  });

  it("最近祖先优先：内层标记胜过外层，不按标记种类跨层抢优先级", async () => {
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    mkdirSync(outer, { recursive: true });
    writeFileSync(join(outer, ".mcp.json"), "{}");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const deep = join(inner, "deep");
    mkdirSync(deep, { recursive: true });
    // 内层 .git 更近 → 命中 inner，即便外层是 .mcp.json（不按种类抢优先级）。
    expect(await findProjectRoot(deep)).toBe(inner);
  });

  it("16 层上限：标记在边界外不得被采到，退回无标记目录自身", async () => {
    // 造一条 20 层深链，在**最顶端**放标记；findProjectRoot 从最底向上最多看 16 层，
    // 故顶层标记不可见，结果应是无标记目录自身（即整条链的底）。
    let deep = root;
    for (let index = 0; index < 20; index += 1) {
      deep = join(deep, `d${index}`);
    }
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, ".mcp.json"), "{}");
    // 期望：找不到标记 → 返回 resolve(cwd) 本身（底端）。
    expect(await findProjectRoot(deep)).toBe(deep);
  });

  it("DSH_HOME 全局家目录的 .dsh 被排除：home 不得被误判为项目根", async () => {
    // 在 DSH_HOME 下建一个**无标记**子目录：向上必命中 DSH_HOME 的 .dsh，
    // 该 .dsh 是全局家目录标记，必须排除，否则 home 被当成项目根。
    const under = join(home.dir, "dev", "leetcode");
    mkdirSync(under, { recursive: true });
    expect(await findProjectRoot(under)).toBe(under);
  });

  it("无标记目录 N：N 自身为根，不落进程 cwd", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    expect(await findProjectRoot(bare)).toBe(bare);
  });

  it("symlink 与真实路径归并为同一根（连接池不因拼写分裂）", async () => {
    const real = join(root, "real-proj");
    mkdirSync(join(real, ".git"), { recursive: true });
    const deep = join(real, "src");
    mkdirSync(deep, { recursive: true });
    const link = join(root, "link-proj");
    symlinkSync(real, link);
    const viaLink = join(link, "src");

    const viaReal = await normalizedProjectRoot(deep);
    const viaSymlink = await normalizedProjectRoot(viaLink);
    expect(viaReal).toBe(viaSymlink);
  });

  it("共享 git common-dir 的 worktree 不被收敛成同一根（#1137 D03）", async () => {
    // 主仓与 worktree 各有自己的 .git 标记（P 的 .git 目录、W 的 .git 文件），
    // 二者路径不同即应为不同根——不能因为 git 语义上的同仓就合并。
    const main = join(root, "main-repo");
    mkdirSync(join(main, ".git"), { recursive: true });
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}`);

    expect(await normalizedProjectRoot(main)).toBe(await normalizedProjectRoot(main));
    expect(await normalizedProjectRoot(wt)).not.toBe(await normalizedProjectRoot(main));
  });
});
