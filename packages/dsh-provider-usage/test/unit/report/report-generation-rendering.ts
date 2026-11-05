/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { reportBodyToHtml, sanitizeHtml } from "./report-generation-support.ts";

describe("#532 渲染管线（escape-then-transform）：结构 / XSS 向量集 / 来回幂等", () => {
  let html: string;
  let x1: string;
  let x2: string;
  let x3: string;
  let x4: string;
  let x5: string;
  let sanitized: string;

  beforeAll(() => {
    // 基本结构：## → h3、- 组 ul/li、普通行 → p、空行断段
    html = reportBodyToHtml(
      "## 数据亮点\n- 第一项\n- 第二项\n\n正文段落，**强调**收尾。\n## 结语\n只此一句。",
    );
    // XSS 向量集：转义在前，注入内容恒为实体文本
    x1 = reportBodyToHtml("## x onerror=alert(1)");
    x2 = reportBodyToHtml('**a" onclick=b**');
    x3 = reportBodyToHtml("<script>alert(1)</script>");
    x4 = reportBodyToHtml("- img:<img src=x onerror=y>");
    // ### 与代码围栏字面显示（只认一档标题与 - 列表）
    x5 = reportBodyToHtml("### 三级标题\n```code```");
    // 往返幂等：管线输出再过一次 sanitizeHtml 白名单标签存活（模拟读侧第二层）
    sanitized = sanitizeHtml(reportBodyToHtml("## 标题\n- 列表\n**加粗**"));
  });

  it("## → h3", () => {
    expect(html.includes("<h3>数据亮点</h3>")).toBeTruthy();
  });

  it("连续 - 组包 ul/li", () => {
    expect(
      html.includes("<ul>") &&
        html.includes("<li>第一项</li>") &&
        html.includes("<li>第二项</li>") &&
        html.includes("</ul>"),
    ).toBeTruthy();
  });

  it("普通行 → p + **x** → strong", () => {
    expect(html.includes("<p>正文段落，<strong>强调</strong>收尾。</p>")).toBeTruthy();
  });

  it("第二标题", () => {
    expect(html.includes("<h3>结语</h3>")).toBeTruthy();
  });

  it("h3 标签无属性位可利用（onerror 转义为实体文本）", () => {
    expect(/<h3[^>]+o/.test(x1)).toBeFalsy();
  });

  it("strong 标签无属性位可利用", () => {
    expect(x2.includes("<strong>") && !/<strong[^>]+o/.test(x2)).toBeTruthy();
  });

  it("script 标签为实体文本（读侧 sanitizeHtml 第二层兜底）", () => {
    expect(x3.includes("&lt;script&gt;")).toBeTruthy();
  });

  it("无明文 script 标签", () => {
    expect(x3.includes("<script")).toBeFalsy();
  });

  it("列表项内注入 img 被转义", () => {
    expect(/<img/i.test(x4)).toBeFalsy();
  });

  it("未闭合 ** 字面保留", () => {
    expect(reportBodyToHtml("未闭合 ** 加粗").includes("**")).toBeTruthy();
  });

  it("### 不当 h3（字面显示）", () => {
    expect(x5.includes("<h3>三级标题</h3>")).toBeFalsy();
  });

  it("落盘 → 读侧往返白名单标签存活", () => {
    expect(
      sanitized.includes("<h3>") && sanitized.includes("<ul>") && sanitized.includes("<strong>"),
    ).toBeTruthy();
  });
});
