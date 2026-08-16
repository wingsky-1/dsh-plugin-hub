// dsh-skill-explorer 主机端冒烟测试 —— 无外部依赖。
//
// 在系统临时目录搭建假技能根（项目 .dsh/skills、.agents/skills、用户
// ~/.dsh/skills、~/.agents/skills、自定义目录），伪造 ctx 驱动 apply 与
// 路由 handler，验证：
//   - 文件系统扫描与 frontmatter 解析（含无 frontmatter 的 .md）
//   - 注册表补充合并（同名补 whenToUse/标记；bundled/runtime 独有加入）
//   - 分级分组顺序、组内排序、字段完整性
//   - 启用/禁用（set-enabled 改写 frontmatter、错误路径）
//   - snapshot 抛错时降级（complete=false，文件系统结果仍返回）
//   - 路由 500 路径、enabled=false
//
// 运行：node dsh-skill-explorer/test/smoke.mjs（仓库根目录）
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, ROUTE, SET_ENABLED_ROUTE, CREATE_ROUTE, DELETE_ROUTE, name, inject, collectSkills, buildSkillContent } from "../lib/index.js";

const failures = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`  FAIL ${label}\n       ${error.message}`);
  }
};

// ------------------------------------------------------------- 临时目录搭建

const TMP = mkdtempSync(join(tmpdir(), "dsh-skill-explorer-"));
const PROJ = join(TMP, "proj");
const HOME = join(TMP, "home");
const AGENTS = join(TMP, "agents");
const CUSTOM = join(TMP, "custom");

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

write(join(PROJ, ".git", "keep"), "");
write(
  join(PROJ, ".dsh", "skills", "poc-first", "SKILL.md"),
  [
    "---",
    "name: poc-first",
    "description: 快速 POC 与先找简单方案的工作方式。",
    "whenToUse: POC 场景",
    "---",
    "",
    "# 正文",
  ].join("\n"),
);
write(join(PROJ, ".dsh", "skills", "zebra-skill", "SKILL.md"), "# 无 frontmatter 的技能\n\n正文。");
write(join(PROJ, ".agents", "skills", "agent-proj", "SKILL.md"), "---\nname: agent-proj\ndescription: 项目 agents 技能\n---\n");
write(join(HOME, "skills", "user-tool", "SKILL.md"), "---\nname: user-tool\ndescription: 用户级技能\n---\n");
write(join(AGENTS, "skills", "agent-user", "SKILL.md"), "---\nname: agent-user\ndescription: 用户 agents 技能\n---\n");
write(join(CUSTOM, "my-custom", "SKILL.md"), "---\nname: my-custom\ndescription: 自定义目录技能\n---\n");
write(
  join(AGENTS, "skills", "block-desc", "SKILL.md"),
  ["---", "name: block-desc", "description: >-", "  块标量的", "  多行描述。", "whenToUse: >", "  块标量", "  适用场景", "---", ""].join("\n"),
);

const REGISTRY_SKILLS = [
  {
    name: "poc-first",
    description: "注册表描述",
    whenToUse: "注册表的 whenToUse",
    provider: "filesystem",
    source: "project-dsh",
    resourceBase: { kind: "directory", path: join(PROJ, ".dsh", "skills", "poc-first") },
    invocation: { modelInvocable: true, userInvocable: true },
  },
  {
    name: "computer-use",
    description: "操作本地桌面窗口",
    whenToUse: "桌面应用交互",
    provider: "orca",
    source: "bundled",
    resourceBase: { kind: "directory", path: join(TMP, "bundled", "computer-use") },
    invocation: { modelInvocable: true, userInvocable: false },
  },
  {
    name: "embedded-hello",
    description: "运行时注册技能",
    provider: "runtime",
    source: "runtime",
    invocation: { modelInvocable: true, userInvocable: true },
  },
];

function fakeCtx(overrides = {}) {
  const state = { routes: [], effects: [] };
  return {
    ...state,
    skills: {
      snapshot: async () => ({ skills: REGISTRY_SKILLS, complete: true }),
    },
    sessions: {
      list: () => [{ header: { cwd: PROJ } }],
    },
    webServer: {
      register: (route) => { state.routes.push(route); return () => {}; },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    effect: (fn, label) => {
      state.effects.push(label);
      const disposer = fn();
      return () => { if (typeof disposer === "function") disposer(); };
    },
    ...overrides,
  };
}

function fakeRes() {
  const state = { status: 0, headers: {}, body: "" };
  return {
    state,
    writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers); },
    end(body) { state.body = body; },
  };
}

/** 伪造带 loopback 特征的请求（围栏要求：回环地址 + 回环 host + 同源）。 */
function fakeReq(url, body, method = "POST") {
  return {
    url,
    method,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

/** 伪造非回环来源的请求（应被围栏 403 拒绝）。 */
function fakeForeignReq(url, body) {
  return {
    url,
    socket: { remoteAddress: "10.0.0.5" },
    headers: { host: "localhost:3080" },
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

const config = { customSkillDirs: [CUSTOM], dshHome: HOME, agentsHome: AGENTS };

const main = async () => {
  try {
    console.log("契约");
    check("name / inject", () => {
      assert.equal(name, "skill-explorer");
      assert.deepEqual(inject, ["skills", "webServer", "sessions"]);
    });
    check("client bundle 的 /api/ 路径与 host 导出完全一致（防漂移）", () => {
      const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
      const clientPaths = [...clientSrc.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]).sort();
      const hostPaths = [ROUTE, SET_ENABLED_ROUTE, CREATE_ROUTE, DELETE_ROUTE].sort();
      assert.deepEqual(clientPaths, hostPaths, `两端路由漂移：client=${clientPaths.join(",")} host=${hostPaths.join(",")}`);
    });

    console.log("collectSkills：文件系统扫描 + 注册表合并");
    const { skills, complete } = await collectSkills({
      cwd: PROJ,
      customSkillDirs: config.customSkillDirs,
      dshHome: HOME,
      agentsHome: AGENTS,
      registry: { snapshot: async () => ({ skills: REGISTRY_SKILLS, complete: true }) },
    });
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    check("complete=true", () => assert.equal(complete, true));
    check("扫描到 9 个技能（7 文件 + 2 注册表独有）", () => assert.equal(skills.length, 9));
    check("项目 .dsh/skills 技能 level 正确", () => assert.equal(byName["poc-first"].level, "project-dsh"));
    check("poc-first 的 whenToUse 来自注册表补充（文件系统无）", () => {
      assert.equal(byName["poc-first"].whenToUse, "注册表的 whenToUse");
      assert.equal(byName["poc-first"].path, join(PROJ, ".dsh", "skills", "poc-first", "SKILL.md"));
    });
    check("无 frontmatter 的 .md：名称取文件名、描述兜底", () => {
      assert.equal(byName["zebra-skill"].description, "(无描述)");
      assert.equal(byName["zebra-skill"].level, "project-dsh");
    });
    check("项目 .agents/skills / 用户 / 自定义 分级", () => {
      assert.equal(byName["agent-proj"].level, "project-agents");
      assert.equal(byName["user-tool"].level, "user-dsh");
      assert.equal(byName["agent-user"].level, "user-agents");
      assert.equal(byName["my-custom"].level, "custom");
    });
    check("注册表独有技能（bundled/runtime）并入", () => {
      assert.equal(byName["computer-use"].level, "bundled");
      assert.equal(byName["computer-use"].provider, "orca");
      assert.equal(byName["embedded-hello"].level, "runtime");
      assert.equal(byName["embedded-hello"].userInvocable, true);
    });
    check("同名技能：文件系统条目优先（描述不被注册表覆盖）", () => {
      assert.equal(byName["poc-first"].description, "快速 POC 与先找简单方案的工作方式。");
    });
    check("块标量 frontmatter 解析为折叠文本", () => {
      assert.equal(byName["block-desc"].description, "块标量的 多行描述。");
      assert.equal(byName["block-desc"].whenToUse, "块标量 适用场景");
      assert.equal(byName["block-desc"].level, "user-agents");
    });

    console.log("路由：分组顺序与排序");
    const ctx = fakeCtx();
    apply(ctx, config);
    const res = fakeRes();
    await ctx.routes[0].handler(fakeReq(`${ROUTE}?cwd=${encodeURIComponent(PROJ)}`, undefined, "GET"), res);
    const body = JSON.parse(res.state.body);
    check("HTTP 200", () => assert.equal(res.state.status, 200));
    check("分组顺序", () => assert.deepEqual(
      body.groups.map((g) => g.key),
      ["bundled", "project-dsh", "project-agents", "custom", "user-dsh", "user-agents", "runtime"],
    ));
    check("project-dsh 组内按名称排序", () => assert.deepEqual(
      body.groups[1].skills.map((s) => s.name),
      ["poc-first", "zebra-skill"],
    ));
    check("组标题中文", () => {
      assert.equal(body.groups[0].title, "系统内置");
      assert.equal(body.groups[1].title, "项目技能（.dsh/skills）");
    });

    console.log("项目级技能：活跃会话 workspace 基准（不传 cwd）");
    const ctxWs = fakeCtx();
    apply(ctxWs, config);
    const resWs = fakeRes();
    await ctxWs.routes[0].handler(fakeReq(ROUTE, undefined, "GET"), resWs); // 不带 ?cwd=
    const bodyWs = JSON.parse(resWs.state.body);
    check("HTTP 200", () => assert.equal(resWs.state.status, 200));
    check("projectRoots 来自活跃会话 cwd", () => assert.deepEqual(bodyWs.projectRoots, [PROJ]));
    check("项目技能出现在 project-dsh 组", () => {
      const project = bodyWs.groups.find((g) => g.key === "project-dsh");
      assert.ok(project !== undefined);
      assert.ok(project.skills.some((s) => s.name === "poc-first"));
    });
    check("sessions 抛错时降级不崩溃", async () => {
      const ctxBrokenSessions = fakeCtx({
        sessions: { list: () => { throw new Error("sessions boom"); } },
      });
      apply(ctxBrokenSessions, config);
      const resB = fakeRes();
      await ctxBrokenSessions.routes[0].handler(fakeReq(ROUTE, undefined, "GET"), resB);
      assert.equal(resB.state.status, 200);
    });
    check("非 loopback 请求 → 403（围栏）", async () => {
      const ctxFence = fakeCtx();
      apply(ctxFence, config);
      const resF = fakeRes();
      await ctxFence.routes[0].handler(fakeForeignReq(ROUTE), resF);
      assert.equal(resF.state.status, 403);
      assert.match(JSON.parse(resF.state.body).error, /forbidden/);
    });

    console.log("启用/禁用：set-enabled 路由改写 frontmatter");
    const ctxToggle = fakeCtx();
    apply(ctxToggle, config);
    const skillFile = join(PROJ, ".dsh", "skills", "poc-first", "SKILL.md");
    const listRoute = ctxToggle.routes.find((r) => r.path === ROUTE);
    const toggleRoute = ctxToggle.routes.find((r) => r.path === SET_ENABLED_ROUTE);
    check("注册了 list 与 set-enabled 两条路由", () => {
      assert.ok(listRoute !== undefined);
      assert.ok(toggleRoute !== undefined);
    });
    const callToggle = async (body, reqFactory = fakeReq) => {
      const req = reqFactory(SET_ENABLED_ROUTE, body);
      const res = fakeRes();
      await toggleRoute.handler(req, res);
      return { res, body: JSON.parse(res.state.body) };
    };
    const before = readFileSync(skillFile, "utf8");
    const foreignToggle = await callToggle({ name: "poc-first", enabled: false }, fakeForeignReq);
    check("写路由：非 loopback → 403 且不改写文件", () => {
      assert.equal(foreignToggle.res.state.status, 403);
      assert.equal(readFileSync(skillFile, "utf8"), before);
    });
    const toggleOff = await callToggle({ name: "poc-first", enabled: false });
    check("禁用返回 200 且 enabled=false", () => {
      assert.equal(toggleOff.res.state.status, 200);
      assert.equal(toggleOff.body.enabled, false);
      assert.equal(toggleOff.body.modelInvocable, false);
    });
    check("文件写入 disable-model-invocation: true 且其余内容保留", () => {
      const content = readFileSync(skillFile, "utf8");
      assert.match(content, /disable-model-invocation: true/);
      assert.ok(content.includes("# 正文"), "正文保留");
      assert.ok(content.includes("name: poc-first"), "其他 frontmatter 保留");
    });
    const toggleOn = await callToggle({ name: "poc-first", enabled: true });
    check("重新启用写入 disable-model-invocation: false", () => {
      assert.equal(toggleOn.res.state.status, 200);
      assert.equal(toggleOn.body.enabled, true);
      assert.match(readFileSync(skillFile, "utf8"), /disable-model-invocation: false/);
    });
    const bad = await callToggle({ name: "evil/../x", enabled: true });
    check("非法 name → 400", () => assert.equal(bad.res.state.status, 400));
    const missing = await callToggle({ name: "embedded-hello", enabled: false });
    check("无文件的技能（runtime）→ 404", () => assert.equal(missing.res.state.status, 404));
    const beforeGet = readFileSync(skillFile, "utf8");
    const getToggle = await callToggle(undefined, (path) => fakeReq(path, undefined, "GET"));
    check("GET set-enabled → 405（接口契约，不做任何改写）", () => {
      assert.equal(getToggle.res.state.status, 405);
      assert.equal(readFileSync(skillFile, "utf8"), beforeGet, "GET 不改写文件");
    });
    writeFileSync(skillFile, before, "utf8"); // 还原 fixture

    console.log("降级：注册表 snapshot 抛错");
    const broken = fakeCtx({
      skills: { snapshot: async () => { throw new Error("registry boom"); } },
    });
    apply(broken, config);
    const resBroken = fakeRes();
    await broken.routes[0].handler(fakeReq(ROUTE, undefined, "GET"), resBroken);
    const bodyBroken = JSON.parse(resBroken.state.body);
    check("complete=false 且文件系统结果仍返回", () => {
      assert.equal(bodyBroken.complete, false);
      const names = bodyBroken.groups.flatMap((g) => g.skills.map((s) => s.name));
      assert.ok(names.includes("poc-first"));
    });

    console.log("其他");
    const off = fakeCtx();
    apply(off, { ...config, enabled: false });
    check("enabled=false 不注册路由", () => assert.equal(off.routes.length, 0));

    // ---------------------------------------------------------------- skill-center 扩展

    console.log("skill-center：创建/删除/禁用注入");

    // 纯函数
    check("buildSkillContent 生成合法 frontmatter", () => {
      const content = buildSkillContent("my-skill", "描述", "适用场景", "正文内容", false);
      assert.match(content, /^---\r?\nname: my-skill\ndescription: 描述\nwhenToUse: 适用场景\n---/);
      assert.ok(!content.includes("disable-model-invocation"));
      const disabled = buildSkillContent("x", "d", undefined, "b", true);
      assert.ok(disabled.includes("disable-model-invocation: true"));
    });

    // 路由（fake ctx，dshHome 指向 TMP 下的 home）
    const centerHome = join(TMP, "home");
    mkdirSync(join(centerHome, "skills"), { recursive: true });
    const centerCtx = fakeCtx();
    apply(centerCtx, { ...config, dshHome: centerHome });
    const findRoute = (path) => centerCtx.routes.find((r) => r.path === path);
    const createRoute = findRoute(CREATE_ROUTE);
    const deleteRoute = findRoute(DELETE_ROUTE);
    check("skill-center 路由已注册", () => {
      assert.ok(createRoute && deleteRoute);
    });

    // 403 围栏
    for (const route of [createRoute, deleteRoute]) {
      const resFence = fakeRes();
      await route.handler(fakeForeignReq(route.path), resFence);
      check(`skill-center 路由 403（${route.path}）`, () => assert.equal(resFence.state.status, 403));
    }

    // 创建（user 根）
    {
      const res = fakeRes();
      await createRoute.handler(fakeReq(CREATE_ROUTE, { root: "user", name: "new-skill", description: "新技能", whenToUse: "测试", content: "正文" }), res);
      check("create 成功", () => {
        assert.equal(res.state.status, 200);
        assert.equal(JSON.parse(res.state.body).ok, true);
      });
      check("create 文件已写入且可被扫描", async () => {
        const file = join(centerHome, "skills", "new-skill", "SKILL.md");
        assert.equal(existsSync(file), true);
        assert.ok(readFileSync(file, "utf8").includes("description: 新技能"));
      });
      // 重复创建 → 409
      const res2 = fakeRes();
      await createRoute.handler(fakeReq(CREATE_ROUTE, { root: "user", name: "new-skill", description: "x", content: "y" }), res2);
      check("create 重复 → 409", () => assert.equal(res2.state.status, 409));
      // 非法参数
      const res3 = fakeRes();
      await createRoute.handler(fakeReq(CREATE_ROUTE, { root: "user", name: "Bad_Name", description: "x", content: "y" }), res3);
      check("create 非法 name → 400", () => assert.equal(res3.state.status, 400));
    }

    // 删除（移到 .trash）
    {
      const res = fakeRes();
      await deleteRoute.handler(fakeReq(DELETE_ROUTE, { name: "new-skill" }), res);
      check("delete 成功", () => {
        assert.equal(res.state.status, 200);
        assert.ok(!existsSync(join(centerHome, "skills", "new-skill", "SKILL.md")));
      });
      const res2 = fakeRes();
      await deleteRoute.handler(fakeReq(DELETE_ROUTE, { name: "not-exist" }), res2);
      check("delete 不存在 → 404", () => assert.equal(res2.state.status, 404));
    }

    if (failures.length > 0) {
      console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
      process.exit(1);
    }
    console.log("\nall checks passed");
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
