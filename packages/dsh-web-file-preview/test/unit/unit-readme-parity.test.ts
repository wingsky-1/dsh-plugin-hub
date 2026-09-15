/**
 * dsh-web-file-preview — README 锚点契约（防文档腐化）。
 *
 * 教训：README 的「验证」段曾长期写着已退役的 lib→src hook 与并不存在的 test/*.test.ts 布局，
 * 没有任何信号。这里把用户可见承诺中的关键锚点钉住：改描述却漏改文档会红，测试面改名也会红。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const readmeZh = readFileSync(`${pkgDir}README.md`, "utf8");
const readmeEn = readFileSync(`${pkgDir}README.en.md`, "utf8");

/** 中英都必须出现的锚点：宿主基线、收口路由、地址语法、放行项、测试分层。 */
const commonAnchors = [
  "0.1.5-rc.1",
  "/api/present.open",
  "dsh-resource://file/session/",
  "reveal",
  "test/unit",
  "test/client",
];

describe("#698 README 锚点契约", () => {
  it.each(commonAnchors)("中文版含锚点：%s", (anchor) => {
    expect(readmeZh).toContain(anchor);
  });

  it.each(commonAnchors)("英文版含锚点：%s", (anchor) => {
    expect(readmeEn).toContain(anchor);
  });

  it("中文版声明只接管 action=open", () => {
    expect(readmeZh).toContain("action=open");
  });

  it("中英小节数量一致（标题文本不同，不比较顺序）", () => {
    const heads = (text: string): string[] =>
      text
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.replace(/^##\s+/, ""));
    expect(heads(readmeZh)).toHaveLength(heads(readmeEn).length);
  });
});
