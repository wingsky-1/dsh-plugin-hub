/**
 * dsh-provider-usage — 客户端调用链接线断言（#1167 delta 评审 P1-3(c)）。
 *
 * 为什么读源码：pill-note.test.ts 直接调用 helper，删除 index.tsx 里的调用点仍全绿，
 * 无法证明用户可见路径真的接线。这里锁定 renderPill → applyPillLabel →
 * appendStaleAgeNote 的调用链（仓库先例：bundle/detect.test.ts 同样做源码契约断言）。
 * 行为面（DOM 追加本身）由 client-dom/pill-note.test.ts 覆盖，两者互补。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const src = readFileSync(join(pkgDir, "src/client/index.tsx"), "utf8");

describe("client wiring：胶囊最后更新调用链（#1167 P1-3c）", () => {
  it("renderPill 调 applyPillLabel", () => {
    expect(src).toContain("applyPillLabel(labelEl, stats);");
  });

  it("applyPillLabel 调 appendStaleAgeNote（删调用即红）", () => {
    expect(src).toContain("appendStaleAgeNote(labelEl, stats);");
    expect(src).toContain('from "./pill-note.ts"');
  });
});
