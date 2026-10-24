// dsh-mcp-manager 冒烟测试（vitest e2e project）—— Config.ui 配置面与 README 文档锚族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的 Config/uiConfig/README it 族整块迁入本文件
// （Config 导出且含 ui 子对象、normalizeUiConfig 默认/合法透传/非法回退、
// buildConfigUiPatch 写路径、README position/offset 说明、README 不声称 8KB 截断、
// README 写明结果不截断与禁直呼）。fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  Config,
  DEFAULT_UI_CONFIG,
  buildConfigUiPatch,
  normalizeUiConfig,
} from "../../lib/index.js";
import { Z_INDEX_BASE_MAX, Z_INDEX_BASE_MIN } from "../../src/shared/interface.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

it("Config 导出且含 ui 子对象（默认值与合法值域）", () => {
  expect(typeof Config === "function", "Config 是 schemastery schema（可调用）").toBeTruthy();
  const parsed = Config({} as Parameters<typeof Config>[0]);
  expect(parsed.ui.position, "ui.position 默认 top-right").toBe("top-right");
  expect(parsed.ui.offset, "ui.offset 默认 {x:8,y:8,blankY:40}").toEqual({
    x: 8,
    y: 8,
    blankY: 40,
  });
  expect(parsed.ui.zIndexBase, "#128 ui.zIndexBase 默认 10").toBe(10);
  expect(DEFAULT_UI_CONFIG.position, "DEFAULT_UI_CONFIG.position 与升级前一致").toBe("top-right");
  expect(DEFAULT_UI_CONFIG.offset).toEqual({ x: 8, y: 8, blankY: 40 });
  expect(
    DEFAULT_UI_CONFIG.zIndexBase,
    "#128 DEFAULT_UI_CONFIG.zIndexBase 与 CSS 默认 z-index 一致",
  ).toBe(10);
  // 合法值域：四角全部透传（#128 补左上/左下）
  for (const p of ["top-left", "bottom-left"] as const) {
    const parsedP = Config({ ui: { position: p } } as Parameters<typeof Config>[0]);
    expect(parsedP.ui.position, `#128 ${p} 是合法 position`).toBe(p);
  }
  const bottom = Config({ ui: { position: "bottom-right" } } as Parameters<typeof Config>[0]);
  expect(bottom.ui.position, "bottom-right 是合法 position").toBe("bottom-right");
  // （键集判据用逐字相等，多键少键都红；storePath 无默认值，不在其中）。
  expect(Object.keys(parsed).sort(), "Config 顶层键集（8→6）").toEqual([
    "announceCatalog",
    "announceToAgent",
    "catalogMaxEntries",
    "debug",
    "enabled",
    "ui",
  ]);
});
it("normalizeUiConfig：默认 / 合法值透传 / 非法回退（不抛）", () => {
  // 未配置 → 默认
  expect(normalizeUiConfig(undefined)).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  expect(normalizeUiConfig(null)).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  // 新 Config.ui 嵌套形态
  expect(
    normalizeUiConfig({ ui: { position: "bottom-right", offset: { x: 12, y: 20, blankY: 60 } } }),
  ).toEqual({ position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60, zIndexBase: 10 });
  // 旧隐藏命名空间扁平形态（position/offset）→ 兼容
  expect(
    normalizeUiConfig({ position: "bottom-right", offset: { x: 5, y: 6, blankY: 50 } }),
  ).toEqual({ position: "bottom-right", offsetX: 5, offsetY: 6, blankY: 50, zIndexBase: 10 });
  // 客户端扁平形态（offsetX/offsetY/blankY）→ 兼容
  expect(
    normalizeUiConfig({ position: "bottom-right", offsetX: 3, offsetY: 4, blankY: 44 }),
  ).toEqual({ position: "bottom-right", offsetX: 3, offsetY: 4, blankY: 44, zIndexBase: 10 });
  // #128 zIndexBase clamp 边界：合法透传 / 越界压边界 / 非法回退默认
  expect(
    normalizeUiConfig({
      position: "top-left",
      offsetX: 1,
      offsetY: 2,
      blankY: 3,
      zIndexBase: 5000,
    }),
    "左上 + 合法层级基准透传",
  ).toEqual({ position: "top-left", offsetX: 1, offsetY: 2, blankY: 3, zIndexBase: 5000 });
  // 非法/缺失 → 安全回退默认，不抛
  expect(normalizeUiConfig({ position: "middle-left" })).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  expect(normalizeUiConfig({ ui: { position: "nope", offset: { x: "abc" } } })).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  expect(normalizeUiConfig({ offset: {} })).toEqual({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
  });
  expect(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase, "#128 低于下界压到 1").toBe(
    Z_INDEX_BASE_MIN,
  );
  expect(normalizeUiConfig({ zIndexBase: -50 }).zIndexBase, "#128 负数压到 1").toBe(
    Z_INDEX_BASE_MIN,
  );
  expect(normalizeUiConfig({ zIndexBase: 9000 }).zIndexBase, "#128 上界 9000 透传").toBe(
    Z_INDEX_BASE_MAX,
  );
  expect(normalizeUiConfig({ zIndexBase: 9001 }).zIndexBase, "#128 超上界压到 9000").toBe(
    Z_INDEX_BASE_MAX,
  );
  expect(normalizeUiConfig({ zIndexBase: Number.NaN }).zIndexBase, "#128 NaN 回退默认").toBe(10);
});
it("buildConfigUiPatch：客户端扁平形态 → Config.ui 嵌套补丁（写路径）", () => {
  // 客户端 POST 的扁平形态 → 宿主写入 Config.ui 的嵌套补丁
  expect(
    buildConfigUiPatch({ position: "bottom-right", offsetX: 12, offsetY: 20, blankY: 60 }),
  ).toEqual({ position: "bottom-right", offset: { x: 12, y: 20, blankY: 60 }, zIndexBase: 10 });
  // #128 四角 + 层级基准写入嵌套补丁
  expect(
    buildConfigUiPatch({
      position: "bottom-left",
      offsetX: 12,
      offsetY: 20,
      blankY: 60,
      zIndexBase: 77,
    }),
  ).toEqual({ position: "bottom-left", offset: { x: 12, y: 20, blankY: 60 }, zIndexBase: 77 });
  // 缺省 → 安全回退默认
  expect(buildConfigUiPatch(undefined)).toEqual({
    position: "top-right",
    offset: { x: 8, y: 8, blankY: 40 },
    zIndexBase: 10,
  });
  // 非法 position → 回退 top-right；负偏移 clamp 到 0
  expect(
    buildConfigUiPatch({ position: "middle-left", offsetX: -5, offsetY: 3.6, blankY: 40 }),
  ).toEqual({ position: "top-right", offset: { x: 0, y: 4, blankY: 40 }, zIndexBase: 10 });
});
it("README 含 position/offset 配置说明（键名与默认值，中英）", () => {
  for (const file of ["README.md", "README.en.md"]) {
    const text = readFileSync(join(pkgDir, file), "utf8");
    expect(text.includes("position"), `${file} 未含 position 键`).toBeTruthy();
    expect(text.includes("top-right"), `${file} 未含 top-right（默认值）`).toBeTruthy();
    expect(text.includes("bottom-right"), `${file} 未含 bottom-right（合法值域）`).toBeTruthy();
    expect(text.includes("offset.x"), `${file} 未含 offset.x 键`).toBeTruthy();
    expect(text.includes("offset.y"), `${file} 未含 offset.y 键`).toBeTruthy();
    expect(text.includes("offset.blankY"), `${file} 未含 offset.blankY 键`).toBeTruthy();
    expect(text.includes("zIndexBase"), `#128 ${file} 未含 zIndexBase 键`).toBeTruthy();
    expect(
      text.includes("top-left") && text.includes("bottom-left"),
      `#128 ${file} 未含四角值域`,
    ).toBeTruthy();
    expect(/#116/.test(text), `#128 ${file} 未标注 #116 跨包避让契约`).toBeTruthy();
    const hotUpdatePhrase = file === "README.en.md" ? "without restarting" : "无需重启";
    expect(text.includes(hotUpdatePhrase), `${file} 未声明「保存即热更新无需重启」`).toBeTruthy();
  }
});

it("README 不再声称 8KB 结果截断 / 固定 30s 超时（实现从未如此）", () => {
  for (const file of ["README.md", "README.en.md"]) {
    const text = readFileSync(join(pkgDir, file), "utf8");
    expect(text.includes("8KB"), `${file} 仍声称 8KB 截断`).toBeFalsy();
    expect(text.includes("fixed 30s"), `${file} 仍声称固定 30s 超时`).toBeFalsy();
    expect(text.includes("固定 30s"), `${file} 仍声称固定 30s 超时`).toBeFalsy();
    expect(text.includes("Result truncation"), `${file} 仍有「结果截断」行`).toBeFalsy();
  }
});

it("README 写明结果不截断、超时按最大值结算、禁直呼机器强制（#1014，中英）", () => {
  for (const file of ["README.md", "README.en.md"]) {
    const text = readFileSync(join(pkgDir, file), "utf8");
    // 不截断是当前事实，必须被写出来（否则读者仍会以为有保护）。
    expect(
      /不做结果截断|no result truncation/.test(text),
      `${file} 未声明不做结果截断`,
    ).toBeTruthy();
    // 超时不是固定值。
    expect(text.includes("toolCallTimeoutMs"), `${file} 未提 toolCallTimeoutMs`).toBeTruthy();
    // 禁直呼是机器强制——锚到**实际句子**，不拿裸 issue 号当代理：#1014 在文档别处
    // 也被引用（变更清单、目录锚），用它当代理的话，把「机器强制」改回「约定」仍会绿。
    const enforced = file === "README.en.md" ? /denies by default/ : /默认拒绝/;
    expect(enforced.test(text), `${file} 未写明禁直呼是默认拒绝`).toBeTruthy();
    // 统计隐私边界：同样锚到句子。
    const hashed = file === "README.en.md" ? /hash buckets/ : /哈希桶/;
    expect(hashed.test(text), `${file} 未声明搜索词只落哈希桶`).toBeTruthy();
  }
});
