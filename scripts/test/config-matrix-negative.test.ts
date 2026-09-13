#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * config-matrix-negative 负向自测（issue #471 P1-3：漏表方向注入 → 门禁红 + 报错含键名）。
 *
 * #733 计划项 3.1.1 后 notifier 矩阵改为**声明驱动 + 运行时取值**：键集来自
 * plugins-manifest.json 的 configSurfaces 所声明的模块导出。故副本除了配置域源码，还必须
 * 复制该声明文件与 notifier 的 package.json——后者决定 .ts 走 ESM＋原生类型剥离。
 *
 * 覆盖方向：
 *   lan-proxy ① 删 FILE_CONFIG_VALIDATORS 一键 → 红 ② DEFAULTS 增 schema 外键 → 红
 *     ③ 删 Config schema 键 → 红 ④ DEFAULTS 删非豁免键 → 红
 *   notifier ⑤ 删 DEFAULT_CONFIG 一键（normalizeConfig 仍显式写该键 → 键集不等）→ 红
 *     ⑥ DEFAULT_CONFIG 加假键（normalizeConfig 不产出）→ 红
 *     ⑦ 声明指向不存在的模块 → 红（本轮红因「路径硬编码腐烂」的回归守卫）
 *     ⑧ 声明指向不存在的导出 → 红
 *     ⑨ 声明里没有 notifier（挪进 pending）→ 红（门禁侧未登记即红）
 *     ⑩ 两处都不登记 notifier → 红（manifest 自洽校验的双向断言）
 * 另含「纯副本不改动 → pass」正对照与 README 缺键仅 warn 的用例。
 *
 * 运行：node --test scripts/test/config-matrix-negative.test.ts（随 pnpm test:scripts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runConfigMatrix } from "../lib/config-matrix-gate.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOTIFIER_CONFIG_DIR = "packages/dsh-notifier/src/server/config";

/** mkdtemp 副本仓库：复制矩阵的输入面（lan-proxy 平铺 config.ts；notifier 整个配置域）
 *  加上声明文件与 package.json。 */
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), "cfgmtx-"));
  try {
    mkdirSync(join(root, "packages", "dsh-lan-proxy", "src", "client"), { recursive: true });
    mkdirSync(join(root, "scripts", "data"), { recursive: true });
    copyLf(
      join(ROOT, "packages/dsh-lan-proxy/src/config.ts"),
      join(root, "packages/dsh-lan-proxy/src/config.ts"),
    );
    copyLf(
      join(ROOT, "packages/dsh-lan-proxy/src/client/index.ts"),
      join(root, "packages/dsh-lan-proxy/src/client/index.ts"),
    );
    // 配置域整棵复制：运行时 require 要走完整 import 链（impl/input → ../model）。
    cpSync(join(ROOT, NOTIFIER_CONFIG_DIR), join(root, NOTIFIER_CONFIG_DIR), { recursive: true });
    // type: module 决定 .ts 按 ESM 解析；缺了它，require 会按 CJS 处理含 export 的源码。
    copyLf(
      join(ROOT, "packages/dsh-notifier/package.json"),
      join(root, "packages/dsh-notifier/package.json"),
    );
    copyLf(
      join(ROOT, "scripts/data/plugins-manifest.json"),
      join(root, "scripts/data/plugins-manifest.json"),
    );
    // lan-proxy UI 豁免表（#733 3.2.2 起门禁读数据面而非内嵌常量）。
    copyLf(
      join(ROOT, "scripts/data/dsh-lan-proxy-ui-exempt.json"),
      join(root, "scripts/data/dsh-lan-proxy-ui-exempt.json"),
    );
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return root;
}

// win32 checkout 常为 CRLF：变异正则按 LF 书写——副本统一归一化 LF，
// 保证变异在两个平台等价生效（gate 解析对行尾不敏感）。
function copyLf(srcPath, destPath) {
  writeFileSync(destPath, readFileSync(srcPath, "utf8").replace(/\r\n/g, "\n"));
}

function edit(root, pkg, rel, fn) {
  const f = join(root, "packages", pkg, "src", rel);
  writeFileSync(f, fn(readFileSync(f, "utf8").replace(/\r\n/g, "\n")));
}

function editManifest(root, fn) {
  const f = join(root, "scripts", "data", "plugins-manifest.json");
  writeFileSync(f, fn(readFileSync(f, "utf8").replace(/\r\n/g, "\n")));
}

/** 通用断言：注入后矩阵红 + problems 含 expectKey；若 expectKey 为数组则逐一断言。 */
function assertRed(label, mutate, expectKeys) {
  const root = fakeRepo();
  try {
    mutate(root);
    const r = runConfigMatrix(root);
    assert.equal(r.pass, false, `${label}: 注入后门禁应红`);
    const joined = r.problems.join("\n");
    for (const k of Array.isArray(expectKeys) ? expectKeys : [expectKeys]) {
      assert.ok(joined.includes(k), `${label}: 报错应含 ${k}。实际: ${r.problems[0] ?? "(无)"}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("正对照：纯副本不改动矩阵 pass", () => {
  const root = fakeRepo();
  try {
    const r = runConfigMatrix(root);
    assert.equal(r.pass, true, `真实文件副本矩阵应绿。实际 problems: ${r.problems.join("; ")}`);
    assert.ok(
      r.lines.some((l) => l.includes("lan-proxy 17 键")),
      "lan-proxy 摘要含 17 键计数",
    );
    assert.ok(
      r.lines.some((l) => l.includes("notifier 12 键 × [defaults → normalizeConfig]")),
      "notifier 摘要走运行时取值口径",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- lan-proxy 方向 ----

test("lan-proxy: 删 FILE_CONFIG_VALIDATORS 一键 → 红且报错含键名", () => {
  assertRed(
    "lan-proxy 删 validators.enabled",
    (root) => {
      edit(root, "dsh-lan-proxy", "config.ts", (s) =>
        s.replace(/  enabled: \(v\) => typeof v === "boolean",\n/, ""),
      );
    },
    "enabled",
  );
});

test("lan-proxy: DEFAULTS 增 schema 外键 → 红且报错含键名", () => {
  assertRed(
    "lan-proxy DEFAULTS 加 fakeKey",
    (root) => {
      edit(root, "dsh-lan-proxy", "client/index.ts", (s) =>
        // 锚点只锁声明本身：缩进归 Prettier（顶层块的多余缩进会被归一化），
        // 注入行自带格式化器口径的缩进，避免判据绑死在某一版排版上。
        s.replace(/var DEFAULTS: Record<string, any> = \{\n/, "$&  fakeKey: 1,\n"),
      );
    },
    "fakeKey",
  );
});

test("lan-proxy: 删 Config schema 键 → 红且报错含键名", () => {
  assertRed(
    "lan-proxy 删 schema.host",
    (root) => {
      edit(root, "dsh-lan-proxy", "config.ts", (s) =>
        s.replace(/  host: z\.string\(\)\.default\(DEFAULT_OPTIONS\.host\),\n/, ""),
      );
    },
    "host",
  );
});

test("lan-proxy: DEFAULTS 删非豁免可编辑键 → 红且报错含键名", () => {
  assertRed(
    "lan-proxy DEFAULTS 删 tlsCertFile",
    (root) => {
      edit(root, "dsh-lan-proxy", "client/index.ts", (s) =>
        // 缩进与引号形态均归 Prettier，判据只锁「这一行存在」，不锁它怎么排的
        s.replace(/^[ \t]*tlsCertFile: (?:""|''),\n/m, ""),
      );
    },
    "tlsCertFile",
  );
});

// ---- notifier 方向（#733 计划项 3.1.1：声明驱动 + 运行时取值）----

test("notifier: 删 DEFAULT_CONFIG 一键 → 红且报错含键名", () => {
  // normalizeConfig 的返回是显式键字面量（impl/input/index.ts:90-119），不会跟着少键，
  // 故键集双向比较立刻不等——这正是两条平行事实源要防的漂移。
  assertRed(
    "notifier 删 DEFAULT_CONFIG.maxConnections",
    (root) => {
      edit(root, "dsh-notifier", "server/config/impl/model/index.ts", (s) =>
        s.replace(/  maxConnections: 16,\n/, ""),
      );
    },
    "maxConnections",
  );
});

test("notifier: DEFAULT_CONFIG 加假键 → 红且报错含键名", () => {
  assertRed(
    "notifier DEFAULT_CONFIG 加 bogusKey",
    (root) => {
      edit(root, "dsh-notifier", "server/config/impl/model/index.ts", (s) =>
        s.replace(
          "export const DEFAULT_CONFIG: NotifyConfig = {",
          "export const DEFAULT_CONFIG: NotifyConfig = {\n  bogusKey: 1,",
        ),
      );
    },
    "bogusKey",
  );
});

test("notifier: 声明指向不存在的模块 → 红（路径腐烂回归守卫）", () => {
  assertRed(
    "notifier 声明模块改为不存在的路径",
    (root) => {
      editManifest(root, (s) =>
        s.replace(
          "packages/dsh-notifier/src/server/config/impl/model/index.ts",
          "packages/dsh-notifier/src/server/config/impl/model/NOT_THERE.ts",
        ),
      );
    },
    "模块加载失败",
  );
});

test("notifier: 声明指向不存在的导出 → 红", () => {
  assertRed(
    "notifier 声明导出改为 NO_SUCH_EXPORT",
    (root) => {
      editManifest(root, (s) =>
        s.replace('"export": "DEFAULT_CONFIG"', '"export": "NO_SUCH_EXPORT"'),
      );
    },
    "声明的导出不存在",
  );
});

test("notifier: 配置面只登记在 pending（configSurfaces 无它）→ 红（未登记即红）", () => {
  assertRed(
    "notifier 移出 configSurfaces",
    (root) => {
      editManifest(root, (s) => {
        const m = JSON.parse(s);
        m.configSurfaces = m.configSurfaces.filter((x) => x.package !== "dsh-notifier");
        m.configSurfacesPending.push({
          package: "dsh-notifier",
          reason: "测试用",
          reviewBy: "2027-03-31",
        });
        return JSON.stringify(m, null, 2);
      });
    },
    "未在 scripts/data/plugins-manifest.json 的 configSurfaces 声明配置面",
  );
});

test("notifier: 两处都不登记 → 红（manifest 自洽的双向断言）", () => {
  assertRed(
    "notifier 完全未登记配置面",
    (root) => {
      editManifest(root, (s) => {
        const m = JSON.parse(s);
        m.configSurfaces = m.configSurfaces.filter((x) => x.package !== "dsh-notifier");
        return JSON.stringify(m, null, 2);
      });
    },
    "configSurfaces 缺 dsh-notifier",
  );
});

// ---- notifier 布尔键清单 / 计数上界清单（N3/N4；两张清单由 notifier 侧导出后恢复执行）----

test("notifier: BOOLEAN_KEYS 加非配置键 → 红且报错含键名", () => {
  assertRed(
    "notifier BOOLEAN_KEYS 加 ghostKey",
    (root) => {
      edit(root, "dsh-notifier", "server/config/impl/input/index.ts", (s) =>
        s.replace(
          "export const BOOLEAN_KEYS: readonly string[] = [",
          'export const BOOLEAN_KEYS: readonly string[] = [\n  "ghostKey",',
        ),
      );
    },
    ["ghostKey", "含非配置键"],
  );
});

test("notifier: BOOLEAN_KEYS 加非布尔键 → 红（该清单语义是「只接受布尔值」）", () => {
  assertRed(
    "notifier BOOLEAN_KEYS 加 quietHours",
    (root) => {
      edit(root, "dsh-notifier", "server/config/impl/input/index.ts", (s) =>
        s.replace(
          "export const BOOLEAN_KEYS: readonly string[] = [",
          'export const BOOLEAN_KEYS: readonly string[] = [\n  "quietHours",',
        ),
      );
    },
    ["quietHours", "含非布尔键"],
  );
});

test("notifier: COUNT_LIMITS 加非配置键 → 红且报错含键名", () => {
  assertRed(
    "notifier COUNT_LIMITS 加 ghostKey",
    (root) => {
      edit(root, "dsh-notifier", "server/config/impl/input/index.ts", (s) =>
        s.replace(
          "export const COUNT_LIMITS: Record<string, number> = {",
          "export const COUNT_LIMITS: Record<string, number> = {\n  ghostKey: 1,",
        ),
      );
    },
    ["ghostKey", "含非配置键"],
  );
});

test("notifier: COUNT_LIMITS 上界低于 DEFAULT_CONFIG 默认值 → 红（默认值自身越界）", () => {
  assertRed(
    "notifier COUNT_LIMITS.maxConnections 降到 8",
    (root) => {
      edit(root, "dsh-notifier", "server/config/impl/input/index.ts", (s) => {
        const after = s.replace(/maxConnections: 1_024,/, "maxConnections: 8,");
        assert.notEqual(
          after,
          s,
          "fixture 应含 maxConnections: 1_024 上界（源码改动后请同步本注入）",
        );
        return after;
      });
    },
    ["maxConnections", "超过 COUNT_LIMITS"],
  );
});

// ---- UI 豁免表（#733 3.2.2 数据化）：门禁读数据面，数据面坏掉必须 fail-closed ----

/** 编辑副本里的数据文件（豁免表）。 */
function editData(root, rel, fn) {
  const f = join(root, "scripts", "data", rel);
  writeFileSync(f, fn(readFileSync(f, "utf8").replace(/\r\n/g, "\n")));
}

test("UI 豁免表: 文件缺失 → 红（fail-closed，不得退化成「没有豁免可用」）", () => {
  const root = fakeRepo();
  try {
    rmSync(join(root, "scripts/data/dsh-lan-proxy-ui-exempt.json"));
    const r = runConfigMatrix(root);
    assert.equal(r.pass, false, "豁免表缺失应红");
    assert.ok(
      r.problems.some((p) => p.includes("UI 豁免表不可读")),
      `报错应指明豁免表不可读: ${r.problems.join("; ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UI 豁免表: 条目超上限（>8）→ 红（上限是策略，数据面不得自放宽）", () => {
  assertRed(
    "豁免表塞进 9 条",
    (root) => {
      editData(root, "dsh-lan-proxy-ui-exempt.json", (s) => {
        const json = JSON.parse(s);
        for (let i = 0; i < 5; i++) {
          json.exemptKeys.push({
            key: `extra${i}`,
            reason: "packages/dsh-lan-proxy/src/config.ts:1 注入用例",
          });
        }
        return `${JSON.stringify(json, null, 2)}\n`;
      });
    },
    ["豁免表 9 键 > 8"],
  );
});

test("UI 豁免表: 条目缺 reason → 红并点名键（结构自检不得静默跳过）", () => {
  assertRed(
    "豁免表删掉一条 reason",
    (root) => {
      editData(root, "dsh-lan-proxy-ui-exempt.json", (s) => {
        const json = JSON.parse(s);
        delete json.exemptKeys[0].reason;
        return `${JSON.stringify(json, null, 2)}\n`;
      });
    },
    ["host", "缺 reason"],
  );
});

test("UI 豁免表: 重复键 → 红（重复即两处事实源）", () => {
  assertRed(
    "豁免表复制一条 host",
    (root) => {
      editData(root, "dsh-lan-proxy-ui-exempt.json", (s) => {
        const json = JSON.parse(s);
        json.exemptKeys.push({ ...json.exemptKeys[0] });
        return `${JSON.stringify(json, null, 2)}\n`;
      });
    },
    ["重复键", "host"],
  );
});

test("UI 豁免表: 豁免键已出现在客户端 DEFAULTS → 红（豁免残留，键已 UI 化）", () => {
  assertRed(
    "客户端 DEFAULTS 补上 host",
    (root) => {
      edit(root, "dsh-lan-proxy", "client/index.ts", (s) => {
        const after = s.replace(/^(\s*)enabled: true,$/m, '$1enabled: true,\n$1host: "127.0.0.1",');
        assert.notEqual(after, s, "fixture 应含 `enabled: true,`（源码改动后请同步本注入）");
        return after;
      });
    },
    ["豁免键 host 已在客户端 DEFAULTS 中"],
  );
});

// 量级 #12：README 键集一致性仅 warn 不判红（缺文档键 → warnings 含键名，pass 仍 true）
test("量级: README 配置表缺键 → warn 不红（pass 仍 true）", () => {
  const root = fakeRepo();
  try {
    // 复制真实 README 进副本（矩阵 README warn 需要文件存在）
    copyLf(
      join(ROOT, "packages/dsh-lan-proxy/README.md"),
      join(root, "packages/dsh-lan-proxy/README.md"),
    );
    copyLf(
      join(ROOT, "packages/dsh-notifier/README.md"),
      join(root, "packages/dsh-notifier/README.md"),
    );
    // 基线（README 与代码键集一致）：零 warn
    let r = runConfigMatrix(root);
    assert.equal(r.pass, true, r.problems.join("; "));
    assert.deepEqual(r.warnings, [], "README 与代码键集一致时应零 warn");
    // 注入：删 lan-proxy README 配置表一行（enabled）→ warn 含键名、pass 仍 true
    const readmePath = join(root, "packages/dsh-lan-proxy/README.md");
    const text = readFileSync(readmePath, "utf8");
    writeFileSync(readmePath, text.replace(/^\| `enabled` \| `true` \| 总开关.*\n/m, ""));
    r = runConfigMatrix(root);
    assert.equal(r.pass, true, "README 缺键仅 warn，不判红");
    assert.ok(
      r.warnings.some((w) => w.includes("enabled") && w.includes("lan-proxy")),
      `warn 应含键名 enabled: ${r.warnings.join(";")}`,
    );
    assert.ok(r.problems.length === 0, "README 缺键不应产生 problems");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
