#!/usr/bin/env node
/**
 * verify-docs 的链接面自测：agent 规则文档（#693）+ docs/ 正文（#842）。
 *
 * docs/ 正文面（#842）与 agent 面同源、解析口径更严：**只相对当前文件**解析、不回落到仓库根
 * （GitHub 上 docs/ 里的相对路径就是相对该文件）。这就是 #842 那条坏链（`.dsh/...`
 * 少写 `../`）唯一能被抓住的口径——agent 面的根回落会把它放过。
 *
 * 为什么存在：根 AGENTS.md / 包级 AGENTS.md / .dsh/skills/ / agents/ 此前**完全在
 * 门禁面之外**（verify-docs 只查各包 README），这正是过期规则（worktree 路径、
 * 已 CLOSED 的 issue 引用、指向已删小节的链接）能长期存活的机制性原因。
 *
 * 本面比 README 面更严：README 面只认 `./` / `../` 前缀（isRelLink），而 agent 规则
 * 文档里最常用的是**裸相对路径**（`docs/DEVELOPMENT.md`、`agents/_protocol.md`）。
 * 故 fixture 刻意使用裸路径——若实现退回只认带前缀的写法，本测试立刻红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
const GATE = join(ROOT, "scripts/gate/verify-docs.ts");

/** 构造最小 fixture 仓库：packages/dsh-fake 一个包 + 可选 agent 规则文件。
 *  gitInit 为真时把 fixture 变成真实 git 仓并写入 gitignore——忽略面的判定由 git 给出，
 *  不建仓就测不到「被忽略即跳过」这条路径。 */
function fixture({
  agentFiles = {},
  gitignore,
}: {
  agentFiles?: Record<string, string>;
  gitignore?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-docs-agent-"));
  mkdirSync(join(dir, "packages/dsh-fake"), { recursive: true });
  writeFileSync(join(dir, "packages/dsh-fake/README.md"), "# fake\n");
  writeFileSync(
    join(dir, "packages/dsh-fake/package.json"),
    JSON.stringify({ name: "@wingsky-1/dsh-fake", description: "fixture" }),
  );
  for (const [rel, content] of Object.entries(agentFiles)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  if (gitignore !== undefined) {
    writeFileSync(join(dir, ".gitignore"), gitignore);
    const r = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `fixture 建仓失败：${r.stderr}`);
  }
  return dir;
}

function run(root: string, extraArgs: string[] = []) {
  try {
    return spawnSync(process.execPath, [GATE, "--root", root, ...extraArgs], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("正例：裸相对路径全部有效 → exit 0，且计入扫描计数", () => {
  const dir = fixture({
    agentFiles: {
      "AGENTS.md": "# root\n\n见 [docs](docs/DEVELOPMENT.md) 与 [协议](agents/_protocol.md)。\n",
      "docs/DEVELOPMENT.md": "# dev\n",
      "agents/_protocol.md": "# protocol\n",
      ".dsh/skills/demo/SKILL.md": "# skill\n\n见 [dev](../../../docs/DEVELOPMENT.md)。\n",
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  // 3 个 agent 规则文档：根 AGENTS.md + skill + agents/_protocol.md（docs/DEVELOPMENT.md 不算）
  assert.match(r.stdout, /\+ 3 个 agent 规则文档/);
});

test("#707 第 3 项：gitignore 的草稿目录不进扫描面（草稿里的假命令不再判红）", () => {
  const dir = fixture({
    agentFiles: { "drafts/note.md": "草稿：稍后要加 `pnpm nonexistent-draft-cmd`。\n" },
    gitignore: "drafts/\n",
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /nonexistent-draft-cmd/);
});

test("#707 第 3 项反证：同一仓库里**未被忽略**的草稿照样判红（跳过由 git 忽略面决定）", () => {
  const dir = fixture({
    agentFiles: { "drafts/note.md": "草稿：稍后要加 `pnpm nonexistent-draft-cmd`。\n" },
    gitignore: "# 不覆盖 drafts/\n",
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /drafts\/note\.md: 引用了不存在的 pnpm 命令 nonexistent-draft-cmd/);
});

test("反例：根 AGENTS.md 的**裸相对路径**失效 → exit 1（README 面认不出的形态）", () => {
  const dir = fixture({ agentFiles: { "AGENTS.md": "见 [没了](docs/NOPE.md)。\n" } });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AGENTS\.md: 相对链接目标缺失 docs\/NOPE\.md/);
});

test("反例：包级 AGENTS.md 链接失效也被覆盖", () => {
  const dir = fixture({
    agentFiles: { "packages/dsh-fake/AGENTS.md": "见 [x](docs/NOPE.md)。\n" },
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AGENTS\.md: 相对链接目标缺失 docs\/NOPE\.md/);
});

test("反例：.dsh/skills 深层 SKILL.md 也被覆盖（inSkills 递归下传）", () => {
  const dir = fixture({ agentFiles: { ".dsh/skills/a/b/SKILL.md": "见 [x](deep/NOPE.md)。\n" } });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SKILL\.md: 相对链接目标缺失 deep\/NOPE\.md/);
});

test("反例：相对文件与相对仓库根都不存在才判红（GitHub 裸路径语义）", () => {
  const dir = fixture({ agentFiles: { ".dsh/skills/x/SKILL.md": "见 [x](docs/NOPE.md)。\n" } });
  assert.equal(run(dir).status, 1);
});

test("不误报：绝对 URL 与正则示例文本都不算链接；锚点有目标即通过", () => {
  const dir = fixture({
    agentFiles: {
      "AGENTS.md": [
        '<a id="top"></a>',
        "见 [节](docs/DEVELOPMENT.md#sec) · [外](https://example.com/a.md) · [锚](#top)",
        "",
        "锁版形如 `@deepseek-ai/[a-z0-9-]+|cordis|schemastery` 的写法。",
        "",
      ].join("\n"),
      "docs/DEVELOPMENT.md": '<a id="sec"></a>\n## sec\n',
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("覆盖面自锁：真实仓库上 agent 规则文档数 > 0（防 walk 条件被改窄成空转）", () => {
  const r = spawnSync(process.execPath, [GATE, "--strict-en"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/\+ (\d+) 个 agent 规则文档/);
  assert.ok(m, `输出缺少 agent 规则文档计数：${r.stdout}`);
  assert.ok(
    Number(m[1]) >= 20,
    `真实仓库应扫到 ≥20 个 agent 规则文档，实际 ${m[1]}——walk 条件疑似被改窄`,
  );
});

test("命令存在性：文档里写不存在的 pnpm 命令 → exit 1 且点名（#693）", () => {
  // 防「文档写出不存在的门禁命令」——human 与 agent 都会照抄。
  const dir = fixture({ agentFiles: { "AGENTS.md": "跑 `pnpm gate:does-not-exist` 即可。\n" } });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /引用了不存在的 pnpm 命令 gate:does-not-exist/);
});

test("命令存在性：真实命令与 pnpm 自带子命令都不误报", () => {
  const dir = fixture({
    agentFiles: {
      "AGENTS.md":
        "跑 `pnpm build`；安装用 `pnpm install`；发版用 `pnpm publish`；`pnpm test:scripts` 亦真。\n",
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("命令存在性：docs/ 下的引用同样被校验（门禁命令最常写在这里）", () => {
  const dir = fixture({ agentFiles: { "docs/GUIDE.md": "见 `pnpm nope:cmd`。\n" } });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GUIDE\.md: 引用了不存在的 pnpm 命令 nope:cmd/);
});

test("锚点：裸 slug href 判红——GitHub 会给标题 id 加 user-content- 前缀（#693 实测）", () => {
  // 这正是 AGENTS.md #0-构建总览 / #1-宿主端srcindexts规范 三处断链的成因
  const dir = fixture({
    agentFiles: {
      "AGENTS.md": "见 [§1](docs/DEVELOPMENT.md#1-宿主端规范)。\n",
      "docs/DEVELOPMENT.md": "## 1. 宿主端规范\n",
    },
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /锚点 #1-宿主端规范 在 docs\/DEVELOPMENT\.md 中不存在/);
});

test("锚点：显式双锚（含 user-content- 形态）可解析 → 通过", () => {
  const dir = fixture({
    agentFiles: {
      "AGENTS.md":
        "见 [§1](docs/DEVELOPMENT.md#1-宿主端规范) 与 [§5](docs/DEVELOPMENT.md#user-content-5-smoke)。\n",
      "docs/DEVELOPMENT.md":
        '<a id="1-宿主端规范"></a><a id="user-content-1-宿主端规范"></a>\n## 1. 宿主端规范\n\n' +
        '<a id="5-smoke"></a><a id="user-content-5-smoke"></a>\n## 5. Smoke\n',
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("锚点：标题 slug 推导（user-content-<slug>）也算有效", () => {
  const dir = fixture({
    agentFiles: {
      "AGENTS.md": "见 [机制](docs/A.md#user-content-通用机制)。\n",
      "docs/A.md": "## 通用机制\n",
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("锚点：同文件锚点（含 HTML href 写法）同样被校验", () => {
  const broken = fixture({ agentFiles: { "docs/A.md": "见 [x](#不存在)。\n" } });
  const r1 = run(broken);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /锚点 #不存在 在\s*本文件\s*中不存在/);

  const htmlBroken = fixture({ agentFiles: { "docs/A.md": '<a href="#也没有">看</a>\n' } });
  assert.equal(run(htmlBroken).status, 1, "HTML href 形态必须纳入发现面");

  const ok = fixture({
    agentFiles: { "docs/A.md": '<a id="通用机制"></a>\n## 通用机制\n\n见 [x](#通用机制)。\n' },
  });
  assert.equal(run(ok).status, 0);
});

test("docs 面（#842）：正文相对链接目标缺失 → exit 1（此前 docs/ 完全在链接面之外）", () => {
  const dir = fixture({ agentFiles: { "docs/GUIDE.md": "见 [别名](NOT-THERE.md)。\n" } });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GUIDE\.md: 相对链接目标缺失 NOT-THERE\.md/);
});

test("docs 面（#842）反证：缺 ../ 前缀的形态必须判红——不得回落到仓库根解析", () => {
  // 真实缺陷形态：docs/DEVELOPMENT.md 里写 .dsh/skills/... 而非 ../.dsh/skills/...；
  // 目标文件**真实存在**于仓库根，所以任何根回落实现都会放过它。
  const dir = fixture({
    agentFiles: {
      ".dsh/skills/demo/SKILL.md": "# skill\n",
      "docs/DEVELOPMENT.md": "见 [skill](.dsh/skills/demo/SKILL.md)。\n",
    },
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DEVELOPMENT\.md: 相对链接目标缺失 \.dsh\/skills\/demo\/SKILL\.md/);
});

test("docs 面正例：同目录裸文件名 / 目录 / 资源后缀都算链接（README 面认不出的形态）", () => {
  const dir = fixture({
    agentFiles: {
      "docs/GUIDE.md": "见 [a](OTHER.md)、[b](diagrams/)、[c](assets/x.svg)。\n",
      "docs/OTHER.md": "# other\n",
      "docs/diagrams/a.svg": "<svg/>\n",
      "docs/assets/x.svg": "<svg/>\n",
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("docs 面不误报：外链、锚点、绝对路径与正则示例文本都不算路径链接", () => {
  const dir = fixture({
    agentFiles: {
      "docs/GUIDE.md": [
        '<a id="sec"></a>',
        "[外](https://example.com/a.md) · [锚](#sec) · [绝对](/etc/hosts)",
        "",
        "锁版形如 `@deepseek-ai/[a-z0-9-]+|cordis` 的写法。",
        "",
      ].join("\n"),
    },
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("docs 面覆盖面自锁：真实仓库扫到 ≥20 个 docs 文档（防 walk 条件被改窄成空转）", () => {
  const r = spawnSync(process.execPath, [GATE, "--strict-en"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/\+ (\d+) 个 docs 文档/);
  assert.ok(m, "输出缺少 docs 文档计数：" + r.stdout);
  assert.ok(Number(m[1]) >= 20, "真实仓库应扫到 ≥20 个 docs 文档，实际 " + m[1]);
});
