#!/usr/bin/env node
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
 *   UI 豁免（#875 H10 起共置为 Config 键旁的 @not-gui 标记，10 条见下方该节）
 *   notifier ⑤ 删 DEFAULT_CONFIG 一键（normalizeConfig 仍显式写该键 → 键集不等）→ 红
 *     ⑥ DEFAULT_CONFIG 加假键（normalizeConfig 不产出）→ 红
 *     ⑦ 声明指向不存在的模块 → 红（本轮红因「路径硬编码腐烂」的回归守卫）
 *     ⑧ 声明指向不存在的导出 → 红
 *     ⑨ 声明里没有 notifier → 红（manifest 自洽校验：active ∪ standalone 未登记即红）
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
const NOTIFIER_SHARED_DIR = "packages/dsh-notifier/src/shared";

/** mkdtemp 副本仓库：复制矩阵的输入面（lan-proxy 配置域入口 model.ts；notifier 整个配置域）
 *  加上声明文件与 package.json。 */
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), "cfgmtx-"));
  try {
    mkdirSync(join(root, "packages", "dsh-lan-proxy", "src", "client", "shared"), {
      recursive: true,
    });
    mkdirSync(join(root, "packages", "dsh-lan-proxy", "src", "server", "config", "impl"), {
      recursive: true,
    });
    mkdirSync(join(root, "scripts", "data"), { recursive: true });
    // 矩阵只读这一份配置域入口文本（Config / FILE_CONFIG_VALIDATORS / SETTING_FIELD_HINTS
    // 同居其中，见 config-matrix-gate 的 runLanProxy），故不必复制整个 server 树。
    copyLf(
      join(ROOT, "packages/dsh-lan-proxy/src/server/config/impl/model.ts"),
      join(root, "packages/dsh-lan-proxy/src/server/config/impl/model.ts"),
    );
    copyLf(
      join(ROOT, "packages/dsh-lan-proxy/src/client/shared/defaults.ts"),
      join(root, "packages/dsh-lan-proxy/src/client/shared/defaults.ts"),
    );
    // 配置域整棵复制：运行时 require 要走完整 import 链（impl/input → ../model → ../../../../shared）。
    cpSync(join(ROOT, NOTIFIER_CONFIG_DIR), join(root, NOTIFIER_CONFIG_DIR), { recursive: true });
    // 两端共享面（src/shared）也是这条链的终点：音色白名单与通知类型表收口后只剩这一份事实源，
    // 缺了它 require 直接失败，正对照会红。
    cpSync(join(ROOT, NOTIFIER_SHARED_DIR), join(root, NOTIFIER_SHARED_DIR), { recursive: true });
    // type: module 决定 .ts 按 ESM 解析；缺了它，require 会按 CJS 处理含 export 的源码。
    copyLf(
      join(ROOT, "packages/dsh-notifier/package.json"),
      join(root, "packages/dsh-notifier/package.json"),
    );
    copyLf(
      join(ROOT, "scripts/data/plugins-manifest.json"),
      join(root, "scripts/data/plugins-manifest.json"),
    );
    // 泛化后（#774）门禁对**每个**声明面都 require 真实模块（含各包依赖）。副本只复制了
    // notifier 的配置域与 lan-proxy 的文本面，其余包在这里加载不了——不改声明的话「正对照
    // 应绿」会因缺文件/缺 node_modules 而红，把 fixture 的完备性混进判据。故把它们降级为
    // `surface: "none"`（不判红、不 require），而不是从声明里删掉：manifest 自洽断言要求
    // active ∪ standalone 每包都被登记，删掉会让正对照因清单不自洽而红——那是 fixture 的错，
    // 不是矩阵的错。#774 收口前此处填的是 pending 节，该节已随机制删除。
    const manifestPath = join(root, "scripts/data/plugins-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.configSurfaces = manifest.configSurfaces.map((s: { package: string }) =>
      s.package === "dsh-notifier"
        ? s
        : {
            package: s.package,
            surface: "none",
            reason: "fixture 副本不具备该包的配置域源码与依赖（见本文件 fakeRepo 注释）",
          },
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    // 不再复制 UI 豁免数据文件：#875 H10 起豁免理由共置在 Config 键旁的 @not-gui 标记里，
    // 副本的输入面就是上面那份 model.ts 文本。
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return root;
}

// win32 checkout 常为 CRLF：变异正则按 LF 书写——副本统一归一化 LF，
// 保证变异在两个平台等价生效（gate 解析对行尾不敏感）。
function copyLf(srcPath: string, destPath: string) {
  writeFileSync(destPath, readFileSync(srcPath, "utf8").replace(/\r\n/g, "\n"));
}

function edit(root: string, pkg: string, rel: string, fn: (text: string) => string) {
  const f = join(root, "packages", pkg, "src", rel);
  writeFileSync(f, fn(readFileSync(f, "utf8").replace(/\r\n/g, "\n")));
}

function editManifest(root: string, fn: (text: string) => string) {
  const f = join(root, "scripts", "data", "plugins-manifest.json");
  writeFileSync(f, fn(readFileSync(f, "utf8").replace(/\r\n/g, "\n")));
}

/** 通用断言：注入后矩阵红 + problems 含 expectKey；若 expectKey 为数组则逐一断言。 */
function assertRed(label: string, mutate: (root: string) => void, expectKeys: string | string[]) {
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
      r.lines.some((l) => l.includes("lan-proxy 19 键")),
      "lan-proxy 摘要含 19 键计数",
    );
    assert.ok(
      r.lines.some((l) => l.includes("notifier 11 键 × [defaults → normalizeConfig]")),
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
      edit(root, "dsh-lan-proxy", "server/config/impl/model.ts", (s) =>
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
      edit(root, "dsh-lan-proxy", "client/shared/defaults.ts", (s) =>
        // 锚点只锁声明本身：缩进归 Prettier（顶层块的多余缩进会被归一化），
        // 注入行自带格式化器口径的缩进，避免判据绑死在某一版排版上。
        s.replace(/const DEFAULTS: LanProxySettingsView = \{\n/, "$&  fakeKey: 1,\n"),
      );
    },
    "fakeKey",
  );
});

test("lan-proxy: 删 Config schema 键 → 红且报错含键名", () => {
  assertRed(
    "lan-proxy 删 schema.host",
    (root) => {
      edit(root, "dsh-lan-proxy", "server/config/impl/model.ts", (s) =>
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
      edit(root, "dsh-lan-proxy", "client/shared/defaults.ts", (s) =>
        // 缩进与引号形态均归 Prettier，判据只锁「这一行存在」，不锁它怎么排的
        s.replace(/^[ \t]*tlsCertFile: (?:""|''),\n/m, ""),
      );
    },
    "tlsCertFile",
  );
});

// ---- notifier 方向（#733 计划项 3.1.1：声明驱动 + 运行时取值）----

test("notifier: 删 DEFAULT_CONFIG 一键 → 红且报错含键名", () => {
  // normalizeConfig 的返回是显式键字面量（impl/input/index.ts:184-201），不会跟着少键，
  // 故键集双向比较立刻不等——这正是两条平行事实源要防的漂移。
  assertRed(
    "notifier 删 DEFAULT_CONFIG.historyMaxAgeDays",
    (root) => {
      edit(root, "dsh-notifier", "server/config/impl/model/index.ts", (s) => {
        const after = s.replace(/  historyMaxAgeDays: 0,\n/, "");
        assert.notEqual(
          after,
          s,
          "fixture 应含 historyMaxAgeDays: 0 默认值（源码改动后请同步本注入）",
        );
        return after;
      });
    },
    "historyMaxAgeDays",
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

test("notifier: 未登记配置面 → 红（manifest 自洽：active ∪ standalone 未登记即红）", () => {
  assertRed(
    "notifier 完全未登记配置面",
    (root) => {
      editManifest(root, (s) => {
        const m = JSON.parse(s);
        m.configSurfaces = m.configSurfaces.filter(
          (x: { package: string }) => x.package !== "dsh-notifier",
        );
        return JSON.stringify(m, null, 2);
      });
    },
    "configSurfaces 缺 dsh-notifier",
  );
});

test("surface: none 缺 reason → 红（它与「漏登记」的区别就是这条理由）", () => {
  assertRed(
    "none 缺 reason",
    (root) => {
      editManifest(root, (s) => {
        const m = JSON.parse(s);
        m.configSurfaces = m.configSurfaces.map((x: { package: string }) =>
          x.package === "dsh-notifier" ? { package: "dsh-notifier", surface: "none" } : x,
        );
        return JSON.stringify(m, null, 2);
      });
    },
    '声明 surface: "none" 时必填 reason',
  );
});

test("surface: none 与四面对齐全形态互斥 → 红（不许拿「无配置面」当省略校验的旁路）", () => {
  assertRed(
    "none 带 defaults",
    (root) => {
      editManifest(root, (s) => {
        const m = JSON.parse(s);
        m.configSurfaces = m.configSurfaces.map((x: { package: string }) =>
          x.package === "dsh-notifier"
            ? {
                package: "dsh-notifier",
                surface: "none",
                reason: "测试用",
                defaults: { module: "packages/dsh-notifier/src/x.ts", export: "X" },
              }
            : x,
        );
        return JSON.stringify(m, null, 2);
      });
    },
    "不得再带 defaults",
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
  // 抬默认值而不是压上界：COUNT_LIMITS 仅剩 historyMaxAgeDays 且默认值是 0，压上界只能压到负数，
  // 那会先命中「上界不是非负整数」分支，断言就指不到「默认值自身越界」这一支。
  assertRed(
    "notifier DEFAULT_CONFIG.historyMaxAgeDays 抬到 9999",
    (root) => {
      edit(root, "dsh-notifier", "server/config/impl/model/index.ts", (s) => {
        const after = s.replace(/  historyMaxAgeDays: 0,/, "  historyMaxAgeDays: 9_999,");
        assert.notEqual(
          after,
          s,
          "fixture 应含 historyMaxAgeDays: 0 默认值（源码改动后请同步本注入）",
        );
        return after;
      });
    },
    ["historyMaxAgeDays", "超过 COUNT_LIMITS"],
  );
});

// ---- UI 豁免 = Config 键旁的 @not-gui 共置标记（#875 H10）----
//
// 事实源就是 Config 源码本身：豁免集由「顶层定义行 → 相邻注释块 → @not-gui」逐键派生，
// 副本里没有独立数据文件可注入，故本段全部从 model.ts 注入。每条都是把对应 bug 种回去
// 验过的负例；判据侧一旦放松（例如把「相邻」放宽成「同文件任意注释」），对应用例先红。

/** 编辑副本里的 Config 源文件，并自证注入真的改动了文本（真值漂移时先红，不空跑）。 */
function mutateConfig(fn: (s: string) => string) {
  return (root: string) => {
    edit(root, "dsh-lan-proxy", "server/config/impl/model.ts", (s) => {
      const after = fn(s);
      assert.notEqual(after, s, "fixture 未被改写（Config 真值文本漂移了，请同步本注入）");
      return after;
    });
  };
}

/** 摘掉第一处 @not-gui 标记行（host 是文件里第一个带标记的键）。 */
function dropFirstMarker(s: string): string {
  return s.replace(/^[ \t]*\*[ \t]*@not-gui[^\n]*\n/m, "");
}

test("UI 豁免标记: Config 文件缺失 → 红（fail-closed，豁免面坏掉不得当作零豁免）", () => {
  const root = fakeRepo();
  try {
    rmSync(join(root, "packages/dsh-lan-proxy/src/server/config/impl/model.ts"));
    const r = runConfigMatrix(root);
    assert.equal(r.pass, false, "Config 源文件缺失应红");
    assert.ok(
      r.problems.some((p) => p.includes("文件不可读")),
      `报错应指明文件不可读: ${r.problems.join("; ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UI 豁免标记: 标记缺失 → 红并点名键（豁免理由只能共置在键旁，缺标记即等于漏 GUI）", () => {
  assertRed("摘掉 host 的 @not-gui 标记", mutateConfig(dropFirstMarker), [
    "host",
    "DEFAULTS 缺键",
    "@not-gui",
  ]);
});

test("UI 豁免标记: 理由为空 → 红并点名键（「为什么不渲染 GUI」必须写出来）", () => {
  assertRed(
    "把 host 的 @not-gui 理由清空",
    mutateConfig((s) => s.replace(/^([ \t]*\*[ \t]*)@not-gui[^\n]*$/m, "$1@not-gui")),
    ["host", "标记没有理由"],
  );
});

test("UI 豁免标记: 标记挪到别的键的注释里 → 红（标记必须紧贴它豁免的键）", () => {
  assertRed(
    "把 host 的标记挪到 port 上方",
    mutateConfig((s) =>
      dropFirstMarker(s).replace(/^(  )port: /m, "$1/* @not-gui 挪错了键 */\n$1port: "),
    ),
    ["host", "DEFAULTS 缺键", "port", "残留"],
  );
});

test("UI 豁免标记: 标记挪到 Config 表之外 → 红（这是旧「行号区间覆盖整段」的等价物）", () => {
  // 旧形态里把锚点写成 :90-190 即可一次覆盖整个 Config 表而门禁判绿；共置形态没有坐标可填，
  // 但「在 Config 声明自己的文档注释里写一条标记」是它最接近的等价物——判据必须识破。
  assertRed(
    "把 4 条标记全撤掉并塞进 Config 声明的文档注释",
    mutateConfig((s) =>
      dropFirstMarker(s.replace(/^[ \t]*\*[ \t]*@not-gui[^\n]*\n/gm, "")).replace(
        "/** 插件配置，由同名 schemastery schema 校验",
        "/** 插件配置，@not-gui 覆盖整段。\n * 由同名 schemastery schema 校验",
      ),
    ),
    ["不属于任何配置键的相邻注释块", "host", "targetHost"],
  );
});

test("UI 豁免标记: 标记与键之间留空行 → 红（相邻不许被空行稀释）", () => {
  assertRed(
    "在 host 的标记与定义行之间插空行",
    mutateConfig((s) =>
      s.replace(/^(  host: z\.string\(\)\.default\(DEFAULT_OPTIONS\.host\),)$/m, "\n$1"),
    ),
    ["host", "DEFAULTS 缺键", "不属于任何配置键的相邻注释块"],
  );
});

test("UI 豁免标记: 豁免数超上限（>8）→ 红（上限是策略，标记面不得自放宽）", () => {
  assertRed(
    "再给 5 个键补上 @not-gui 标记（共 9 个）",
    mutateConfig((s) => {
      let out = s;
      for (const re of [
        /^  enabled: /m,
        /^  port: /m,
        /^  httpsEnabled: /m,
        /^  httpsPort: /m,
        /^  printBanner: /m,
      ]) {
        out = out.replace(re, (m) => `  /* @not-gui 注入用例 */\n${m}`);
      }
      return out;
    }),
    ["@not-gui 豁免 9 键 > 8"],
  );
});

test("UI 豁免标记: 键已进客户端 DEFAULTS → 红（豁免残留，标记该删）", () => {
  assertRed(
    "客户端 DEFAULTS 补上 host",
    (root) => {
      edit(root, "dsh-lan-proxy", "client/shared/defaults.ts", (s) => {
        const after = s.replace(/^(\s*)enabled: true,$/m, '$1enabled: true,\n$1host: "127.0.0.1",');
        assert.notEqual(after, s, "fixture 应含 `enabled: true,`（源码改动后请同步本注入）");
        return after;
      });
    },
    ["host", "标了 @not-gui 却已在客户端 DEFAULTS 中"],
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

// ---- 标记定位判据：顶层定义行必须真在该键上，且写法差异不得误伤 ----

test("UI 豁免标记: Config 键写成引号形态 → 红（顶层定义行定位失败即 fail-closed，不静默放行）", () => {
  // 文本层按「同缩进 + 裸键名 + 冒号」认顶层属性行（与旧锚点判据同口径）。引号键不在该形态内，
  // 故此处必须报出来而不是当作「没有标记」——后者会把合法源码改动报成「漏 GUI」，指错方向。
  assertRed(
    '把 Config 里的 host 写成 "host"',
    mutateConfig((s) =>
      s.replace(
        /^(  )host: z\.string\(\)\.default\(DEFAULT_OPTIONS\.host\),$/m,
        '$1"host": z.string().default(DEFAULT_OPTIONS.host),',
      ),
    ),
    ["找不到键 host 的顶层定义行"],
  );
});

test("UI 豁免标记: 标记写成斜杠注释 / 带括号与中文标点 → 仍应绿（不得因写法差异误伤）", () => {
  const root = fakeRepo();
  try {
    edit(root, "dsh-lan-proxy", "server/config/impl/model.ts", (s) => {
      const after = s.replace(
        /^[ \t]*\*[ \t]*@not-gui[^\n]*\n([ \t]*\*\/)\n/m,
        "$1\n  // @not-gui 斜杠注释形态也认（括号 + 中文标点：，。）\n",
      );
      assert.notEqual(after, s, "fixture 未改写任何标记（Config 真值漂移了，请同步本注入）");
      return after;
    });
    const r = runConfigMatrix(root);
    assert.equal(r.pass, true, `写法变体不应判红。实际 problems: ${r.problems.join("; ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
