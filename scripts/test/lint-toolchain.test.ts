#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * lint 工具链隔离的结构断言（#722 阶段五）。
 *
 * 为什么需要：tools/lint 位于 packages/ 之外，所有既有门禁（listPluginDirs / catalog-peers /
 * ci-matrix / aggregate / pack-check）都只扫 packages/，因此这一层没有任何现成看守。而它承载
 * 一个会「静默失效」的关键前提——typescript-eslint 必须解析到带 compiler API 的 TS 6.x，
 * 同时仓根 typescript 必须仍是 tsgo（根 tsc 由它提供，各包 build/typecheck 依赖它）。
 * 隔离一旦被破坏（依赖被提升、overrides 被加、根本被降级），失败形态是「lint 全绿但没在跑规则」
 * 或「build/typecheck 换了编译器」，两者都不会自己报出来，故在此逐条钉死。
 *
 * 运行：pnpm test:scripts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const requireRoot = createRequire(join(ROOT, "package.json"));
const requireLint = createRequire(join(ROOT, "tools", "lint", "package.json"));

test("#722 阶段五：lint 工具链隔离——根 tsgo 与 lint 专用 TS 6 各自归位", () => {
  // ⓪ 结构存在性
  for (const rel of [
    "tools/lint/package.json",
    "tools/lint/eslint.config.js",
    "tools/lint/bin/lint.mjs",
  ]) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} 必须存在（lint 工具链隔离包）`);
  }

  // ① 根 typescript 必须仍是 tsgo：有版本号、无 compiler API
  const rootTs = requireRoot("typescript");
  assert.match(String(rootTs.version), /^7\./, `根 typescript 应为 7.x（实测 ${rootTs.version}）`);
  assert.equal(
    typeof rootTs.createSourceFile,
    "undefined",
    "根 typescript 必须是 tsgo 原生版（无 compiler API）——根 tsc 由它提供，各包 build/typecheck 依赖它；被换成 6.x 会静默改变全部产物的生成器",
  );

  // ② tools/lint 的 typescript 必须有 compiler API（typescript-eslint 的硬前提）
  const lintTs = requireLint("typescript");
  assert.equal(
    typeof lintTs.createSourceFile,
    "function",
    'tools/lint 的 typescript 必须带 compiler API——否则 typescript-eslint 会在加载时抛 "does not support TS 7.0"',
  );
  assert.match(
    String(lintTs.version),
    /^6\./,
    `tools/lint 的 typescript 应为 6.x（实测 ${lintTs.version}）；7.x 无 API，typescript-eslint 不支持`,
  );

  // ③ 两个版本必须真的共存（防止某一侧被提升/覆盖后「看起来还能跑」）
  assert.notEqual(
    rootTs.version,
    lintTs.version,
    "根与 lint 子包必须解析到不同大版本的 typescript——同版意味着隔离已失效",
  );

  // ④ 根 tsc 可执行文件必须仍来自 tsgo
  const tscBin = join(ROOT, "node_modules", ".bin", "tsc");
  assert.ok(existsSync(tscBin), "node_modules/.bin/tsc 必须存在（各包 build/typecheck 调用它）");
});

test("#722 阶段五：复杂度阈值唯一事实源在 gauntlet.config.json，配置不得硬编码", () => {
  const gauntlet = JSON.parse(
    readFileSync(join(ROOT, "scripts", "data", "gauntlet.config.json"), "utf8"),
  );
  const c = gauntlet.complexity;
  assert.ok(c !== undefined, "gauntlet.config.json 必须有 complexity 段（阈值唯一事实源）");
  assert.equal(typeof c.cyclomatic, "number", "complexity.cyclomatic 必须是数字");
  assert.equal(typeof c.cognitive, "number", "complexity.cognitive 必须是数字");
  // 起步值 = 全域实测最大值；收紧路线见 issue #732。此处只锁「不得高于起步基线」，
  // 允许后续按 #732 下调（下调是收紧，方向正确），但不得反弹回更高。
  assert.ok(
    c.cyclomatic <= 78,
    `complexity.cyclomatic 不得高于起步基线 78（实测 ${c.cyclomatic}）`,
  );
  assert.ok(c.cognitive <= 84, `complexity.cognitive 不得高于起步基线 84（实测 ${c.cognitive}）`);

  // 配置必须消费事实源，不得写死数字阈值（否则改 gauntlet 不生效 = 事实源被绕过）
  const configText = readFileSync(join(ROOT, "tools", "lint", "eslint.config.js"), "utf8");
  assert.ok(
    !/complexity:\s*\[\s*'error'\s*,\s*\d/.test(configText),
    "eslint.config.js 不得硬编码 complexity 的数字阈值（必须读 gauntlet.config.json）",
  );
  assert.ok(
    !/'sonarjs\/cognitive-complexity':\s*\[\s*'error'\s*,\s*\d/.test(configText),
    "eslint.config.js 不得硬编码 cognitive-complexity 的数字阈值（必须读 gauntlet.config.json）",
  );
  assert.match(
    configText,
    /gauntlet\.config\.json/,
    "eslint.config.js 必须显式读取 gauntlet.config.json 作为阈值来源",
  );
});

test("#764 A1：失效的 eslint-disable 注释判 error（flat 默认只到 warn）", async () => {
  const { ESLint } = requireLint("eslint");
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: join(ROOT, "tools", "lint", "eslint.config.js"),
  });

  // ① 配置层：生效级别必须是 error。warn 级会被 600+ 条存量警告淹没，等于没有这条判据。
  const cfg = await eslint.calculateConfigForFile(join(ROOT, "scripts", "gate", "local-gate.mjs"));
  const level = cfg.linterOptions?.reportUnusedDisableDirectives;
  assert.ok(
    level === 2 || level === "error",
    `reportUnusedDisableDirectives 必须是 error 级，实际 ${JSON.stringify(level)}`,
  );

  // ② 行为层：一条指向**从未启用**的规则的 disable 注释必须产出 error。用 lintText 而不是
  // 造临时文件——判据不该为了让门禁看见自己而往仓库里落产物（测试纪律 #218）。
  const [result] = await eslint.lintText(
    "// eslint-disable-next-line no-control-regex\nexport const probe = /a/;\n",
    { filePath: join(ROOT, "scripts", "gate", "lint-probe.ts") },
  );
  assert.ok(
    result.messages.some(
      (m) => m.severity === 2 && /Unused eslint-disable directive/.test(m.message),
    ),
    `失效 disable 必须按 error 报，实际：${JSON.stringify(result.messages)}`,
  );
});

test("#764 A2：警告预算的事实源与消费点", () => {
  const gauntlet = JSON.parse(
    readFileSync(join(ROOT, "scripts", "data", "gauntlet.config.json"), "utf8"),
  );
  const budget = gauntlet.lint?.maxWarnings;
  assert.ok(
    Number.isInteger(budget) && budget >= 0,
    `gauntlet.config.json 必须有 lint.maxWarnings（非负整数），实际 ${JSON.stringify(budget)}`,
  );

  // 预算必须由 lint 入口消费：ESLint 自带的 --max-warnings 在本仓会被 argv 过滤静默丢弃，
  // 照抄 CLI 用法等于没有预算——这正是本判据存在的原因。
  const lintSrc = readFileSync(join(ROOT, "tools", "lint", "bin", "lint.mjs"), "utf8");
  assert.match(
    lintSrc,
    /lint\?\.maxWarnings|lint\.maxWarnings|readBudget/,
    "lint.mjs 必须读取 gauntlet 的 lint.maxWarnings",
  );
  assert.match(lintSrc, /problems > budget/, "lint.mjs 必须把问题总数与预算比较并据此判红");
  assert.match(
    lintSrc,
    /process\.exit\(2\)/,
    "预算读不到时必须 fail-closed（exit 2），不得静默放行",
  );
});

test("#764 A2：超出预算时 lint 入口判红（实跑退出码）", () => {
  // 用 .d.mts 制造一条**结构性**警告：它命中 eslint.config.js 的忽略面，ESLint 必报
  // "File ignored because of a matching ignore pattern"。该警告只取决于扩展名是否在忽略清单里，
  // 与文件内容无关，故这条判据不会随业务代码改动而漂移。
  const probe = join(
    ROOT,
    "packages",
    "dsh-provider-usage",
    "src",
    "domain1",
    "adapters",
    "deepseek-official.d.mts",
  );
  assert.ok(existsSync(probe), `${probe} 必须存在（本判据的结构性警告来源）`);
  const r = spawnSync(process.execPath, ["tools/lint/bin/lint.mjs", "--max-warnings=0", probe], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 1, `问题数超出预算必须 exit 1（实际 ${r.status}）`);
  assert.match(r.stderr, /超出预算/, "报错须点明超出预算");
});

test("#764 A3：三条类型感知规则在 src 面按 error 生效（分阶段第一步）", async () => {
  const { ESLint } = requireLint("eslint");
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: join(ROOT, "tools", "lint", "eslint.config.js"),
  });
  const cfg = await eslint.calculateConfigForFile(
    join(ROOT, "packages", "dsh-mcp-manager", "src", "bootstrap", "apply.ts"),
  );

  // 为什么只判配置层、不做「喂一段浮空 Promise 看它报不报」的行为判据：这三条是 type-checked
  // 规则，需要文件真的落在某个 tsconfig project 里——lintText 传不存在的路径直接 parsing
  // error（实测），传已存在文件的路径又会让类型信息取自磁盘上的另一份内容。配置层 + 全仓实跑
  // （探针复测 0 命中）合起来才是完整证据。
  for (const rule of [
    "@typescript-eslint/no-floating-promises",
    "@typescript-eslint/no-misused-promises",
    "@typescript-eslint/await-thenable",
  ]) {
    const configured = cfg.rules?.[rule];
    const level = Array.isArray(configured) ? configured[0] : configured;
    assert.ok(
      level === 2 || level === "error",
      `${rule} 必须在 packages/*/src 面为 error，实际 ${JSON.stringify(configured)}`,
    );
  }

  // 类型感知的前提：parserOptions 必须指向真 TS program。缺了 projectService 这三条规则不会
  // 报错，只会静默失效——本仓此前漏掉 9 处异步正确性问题正是这个形态。
  assert.equal(
    cfg.languageOptions?.parserOptions?.projectService,
    true,
    "必须开 projectService（否则 type-checked 规则静默失效）",
  );
  assert.equal(
    resolve(String(cfg.languageOptions?.parserOptions?.tsconfigRootDir)),
    ROOT,
    "tsconfigRootDir 必须指向仓库根（决定解析哪套 tsconfig）",
  );
});

test("#764 A4：基线抑制机制已接线（Node API 只应用，创建/修剪走 CLI）", () => {
  const lintSrc = readFileSync(join(ROOT, "tools", "lint", "bin", "lint.mjs"), "utf8");
  assert.match(lintSrc, /applySuppressions:\s*true/, "lint.mjs 必须应用官方基线抑制");
  assert.match(lintSrc, /suppressionsLocation/, "基线文件位置必须显式钉住，不靠默认值");

  // 基线允许不存在（存量修完并 prune 后就是空/无文件）；一旦存在就必须是官方结构：
  // 文件 → 规则 → { count }。结构错了官方实现会整份读不出，表现为「抑制全部失效、
  // 存量一次性炸开」，所以在门禁里先钉一层。
  const file = join(ROOT, "eslint-suppressions.json");
  if (!existsSync(file)) return;
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(typeof data, "object", "eslint-suppressions.json 必须是对象");
  for (const [filePath, rules] of Object.entries(data)) {
    assert.equal(typeof rules, "object", `${filePath} 下必须是「规则 → { count }」`);
    for (const [rule, entry] of Object.entries(rules)) {
      assert.ok(
        Number.isInteger(entry?.count) && entry.count > 0,
        `${filePath} 的 ${rule} 必须带正整数 count，实际 ${JSON.stringify(entry)}`,
      );
    }
  }
});

test("#764 A5：sonarjs/deprecation 在类型感知面生效；非类型感知面不配（已知盲区）", async () => {
  const { ESLint } = requireLint("eslint");
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: join(ROOT, "tools", "lint", "eslint.config.js"),
  });
  const level = (configured) => (Array.isArray(configured) ? configured[0] : configured);

  const typedFace = await eslint.calculateConfigForFile(
    join(ROOT, "packages", "dsh-provider-usage", "src", "shared", "contracts.ts"),
  );
  assert.ok(
    level(typedFace.rules?.["sonarjs/deprecation"]) === 2 ||
      level(typedFace.rules?.["sonarjs/deprecation"]) === "error",
    `deprecation 必须在 packages/*/src 面为 error，实际 ${JSON.stringify(typedFace.rules?.["sonarjs/deprecation"])}`,
  );
  assert.equal(
    typedFace.languageOptions?.parserOptions?.projectService,
    true,
    "deprecation 需要类型信息：必须与 projectService 同面（sonarjs 缺 program 时静默 return {}）",
  );

  // 面边界是刻意的：test/scripts 面没有 program，配上去只会让规则静默空转（假绿），
  // 所以不配。这里把该事实钉住——将来要扩面，必须同时给那个面配 projectService。
  const otherFace = await eslint.calculateConfigForFile(
    join(ROOT, "packages", "dsh-provider-usage", "test", "helpers.ts"),
  );
  assert.equal(
    otherFace.rules?.["sonarjs/deprecation"],
    undefined,
    "非类型感知面不得配 deprecation（没有 program 时它静默空转，属假绿）",
  );
});

test("#764 A5：基线条目必须指向现存文件，且规则在该文件上确实是 error", async () => {
  const file = join(ROOT, "eslint-suppressions.json");
  if (!existsSync(file)) return;
  const { ESLint } = requireLint("eslint");
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: join(ROOT, "tools", "lint", "eslint.config.js"),
  });
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const [relPath, rules] of Object.entries(data)) {
    const abs = join(ROOT, relPath);
    assert.ok(existsSync(abs), `基线条目指向的文件必须存在：${relPath}`);
    const cfg = await eslint.calculateConfigForFile(abs);
    for (const rule of Object.keys(rules)) {
      const configured = cfg.rules?.[rule];
      const lv = Array.isArray(configured) ? configured[0] : configured;
      assert.ok(
        lv === 2 || lv === "error",
        `${relPath} 的基线条目 ${rule} 在该文件上必须是 error 级（否则官方不抑制，条目等于空挂）`,
      );
    }
  }
});

test("#764 A5：基线的只许收缩棘轮（官方只在 CLI 侧检查，Node API 侧由 lint.mjs 自补）", () => {
  // 三档实跑：count 恰好 / 多一条（存量已修掉，该 prune）/ 少一条（超基线，错误现形）。
  // 为什么必须自己补这条：applySuppressions 把「未使用条目」算进 unused 返回，而 Node API 的
  // lintFiles 直接丢弃它——不补就没人催收缩基线，挂账只增不减。
  const probe = "packages/dsh-provider-usage/src/shared/contracts.ts";
  const dir = mkdtempSync(join(tmpdir(), "lint-suppressions-"));
  try {
    const run = (count) => {
      const base = join(dir, `base-${count}.json`);
      writeFileSync(
        base,
        JSON.stringify({ [probe]: { "sonarjs/deprecation": { count } } }),
        "utf8",
      );
      return spawnSync(
        process.execPath,
        ["tools/lint/bin/lint.mjs", `--suppressions=${base}`, probe],
        { cwd: ROOT, encoding: "utf8" },
      );
    };

    const exact = run(40);
    assert.equal(exact.status, 0, `基线恰好应放行，实际 exit ${exact.status}：${exact.stdout}`);
    assert.match(exact.stdout, /基线已抑制 40 处/);
    assert.match(
      exact.stdout,
      /^lint: 检查/m,
      "汇总行必须能在管道下存活（process.exitCode 而非 exit）",
    );

    const surplus = run(41);
    assert.equal(surplus.status, 1, "基线多出条数 = 存量已修掉却没收缩，必须判红");
    assert.match(surplus.stderr, /已经失效/);
    assert.match(surplus.stderr, /--prune-suppressions/, "报错须给出可照抄的收缩命令");

    const deficit = run(39);
    assert.equal(deficit.status, 1, "基线少于实际违规 = 超出基线的错误必须现形");
    assert.match(deficit.stdout, /error 40/, "超基线时该文件 40 处错误应全部报出");
    assert.doesNotMatch(
      deficit.stderr,
      /已经失效/,
      "超基线不得被说成「条目失效」——那会把修复方向指向 prune 而不是修代码",
    );

    // 子集运行 = pre-commit 只喂 staged 文件：**未被 lint 的文件不在判定范围内**。
    // 少了这条口径，钩子会把其余文件的条目全判成失效并拦住提交——本回归正是被它拦出来的。
    const subset = spawnSync(process.execPath, ["tools/lint/bin/lint.mjs", probe], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(
      subset.status,
      0,
      `子集运行不得把未 lint 的基线条目判成失效，实际 exit ${subset.status}：${subset.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#765 第 2 项：客户端 var 豁免面 == 实际含 var 的客户端文件（收窄 + 反向腐烂校验）", async () => {
  const { ESLint } = requireLint("eslint");
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: join(ROOT, "tools", "lint", "eslint.config.js"),
  });
  const level = (configured) => (Array.isArray(configured) ? configured[0] : configured);
  const isOff = (configured) => level(configured) === 0 || level(configured) === "off";

  // 为什么要这条不变量：豁免面原先是 `packages/*/src/client/**` 通配——判据面随目录增长而变宽，
  // 以后任何新客户端文件写 `var` 都会被静默豁免。收窄成显式文件清单之后，「清单 == 实际含 var
  // 的文件」这条等式就是收窄的**判据本身**：新增文件写 var（等式右侧变大）与清单条目腐烂
  // （左侧有条目、右侧没有）都会让它变红，逼出一次显式决定——补清单，或改代码。
  const clientDir = (pkg) => join(ROOT, "packages", pkg, "src", "client");
  const clientFiles = [];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const dir = clientDir(pkg);
    if (!existsSync(dir)) continue;
    for (const rel of readdirSync(dir, { recursive: true })) {
      const abs = join(dir, rel);
      if (!/\.(ts|tsx|mts|cts)$/.test(abs) || !existsSync(abs)) continue;
      if (!readFileSync(abs, "utf8").includes("var")) continue; // 粗筛：不含 var 的文件无需起 lint
      clientFiles.push(abs);
    }
  }
  assert.ok(clientFiles.length > 0, "粗筛应当命中已知的两个含 var 客户端文件");

  for (const abs of clientFiles) {
    const rel = abs.replace(ROOT + "/", "");
    // 该文件到底有没有 var 声明：用规则本身判，不用正则（string / 注释里的 var 不算）。
    // 检出用一份「强制把 no-var 打开」的实例——豁免文件上它是 off，不打开就什么都看不到。
    const withNoVar = new ESLint({
      cwd: ROOT,
      overrideConfigFile: join(ROOT, "tools", "lint", "eslint.config.js"),
      overrideConfig: { rules: { "no-var": "error" } },
    });
    const messages = await withNoVar.lintText(readFileSync(abs, "utf8"), { filePath: abs });
    const hasVar = messages.some((m) => m.messages.some((x) => x.ruleId === "no-var"));
    const configured = (await eslint.calculateConfigForFile(abs)).rules?.["no-var"];
    assert.equal(
      isOff(configured),
      hasVar,
      `${rel}：no-var 的关闭状态必须与「该文件确实含 var」一致（豁免清单是事实快照，不是白名单）；实际 off=${isOff(configured)} 含 var=${hasVar}`,
    );
  }

  // 面不再是通配：未列入清单的客户端文件必须按常规规则面处理（error，而不是静默豁免）。
  const probe = join(ROOT, "packages", "dsh-lan-proxy", "src", "client", "probe-not-listed.ts");
  const probeConfigured = (await eslint.calculateConfigForFile(probe)).rules?.["no-var"];
  assert.equal(level(probeConfigured), 2, "新客户端文件不得继承 no-var 豁免");
});

test("#765 第 6 项：no-var 不在降级集里，且在常规规则面按 error 生效", async () => {
  const { ESLint } = requireLint("eslint");
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: join(ROOT, "tools", "lint", "eslint.config.js"),
  });
  const level = (configured) => (Array.isArray(configured) ? configured[0] : configured);

  // 全仓命中数为 0 的规则留在 LEGACY_WARN 里 = 把一条不存在的债记成技术债，还让新写的 var 只拿 warn。
  for (const rel of ["scripts/gate/verify-docs.ts", "shared/sse-hub.js"]) {
    const configured = (await eslint.calculateConfigForFile(join(ROOT, rel))).rules?.["no-var"];
    assert.equal(
      level(configured),
      2,
      `${rel}：no-var 必须按 error 生效，实际 ${JSON.stringify(configured)}`,
    );
  }
  const probe = await eslint.lintText("var probe = 1;\nexport { probe };\n", {
    filePath: join(ROOT, "scripts", "gate", "probe-no-var.ts"),
  });
  assert.ok(
    probe.some((r) => r.messages.some((m) => m.ruleId === "no-var" && m.severity === 2)),
    "新写的 var 必须直接判红（而不是降级成警告去吃预算）",
  );
});

test("#722 阶段五：lint 面完整性——同名源码目录不得被构建产物忽略规则吞掉", async () => {
  const { ESLint } = requireLint("eslint");
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: join(ROOT, "tools", "lint", "eslint.config.js"),
  });

  // 为什么有这一测：忽略规则原先写作 `**/lib/**`（本意是 packages/*/lib 这类构建产物），
  // 它同时匹配 `scripts/lib/**`——15 个文件的门禁共享实现（豁免台账校验器、config-matrix
  // 提取器、导出面提取器…）因此整体落在 lint 面之外。失效形态是最难发现的那种：这些文件
  // 不受复杂度门禁、不受 no-var、不受任何规则约束，命中数为 0 看起来像「很干净」。
  // 故此处按**行为**（isPathIgnored）钉住两侧，而不是断言配置文件里的字面量。
  const libDir = join(ROOT, "scripts", "lib");
  const sources = existsSync(libDir)
    ? readdirSync(libDir).filter((f) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(f))
    : [];
  // 枚举而不是写死路径，但枚举为空即断言对象消失——必须显式失败，否则这一测会退化成空转。
  assert.ok(sources.length > 0, `scripts/lib 下应有源码文件可断言（实得 ${sources.length} 个）`);
  for (const name of sources) {
    assert.equal(
      await eslint.isPathIgnored(join(libDir, name)),
      false,
      `scripts/lib/${name} 必须参与 lint——它是源码不是构建产物`,
    );
  }

  // 产物侧反向钉住：收窄忽略面不等于把 lib 目录一律放进来。
  for (const rel of ["packages/dsh-notifier/lib/index.js", "packages/dsh-lan-proxy/lib/index.js"]) {
    assert.equal(
      await eslint.isPathIgnored(join(ROOT, rel)),
      true,
      `${rel} 是构建产物，必须留在 lint 面之外`,
    );
  }
});
