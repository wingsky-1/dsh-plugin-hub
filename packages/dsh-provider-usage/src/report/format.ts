/**
 * dsh-provider-usage/report — 年报正文渲染管线（#532，escape-then-transform）。
 *
 * 安全模型（评审定稿）：先转义、后引入标签——
 * 1. escHtml 全文转义：此后任何注入 HTML 均为实体文本，字面 `<` 不可能再现；
 * 2. 按行分类：行首 `## ` → <h3>；行首 `- ` 连续行组包 <ul>/<li>；非空普通行 → <p>；
 * 3. 行内 `**x**` → <strong>（仅单行内匹配，跨行未闭合回退字面显示）。
 * 管线只引入无属性白名单标签（h3/strong/ul/li/p）——注入标签为字面常量、无属性
 * 位可利用，XSS 面为零；sanitizeHtml（读侧第二层，黑名单式）对这些无属性标签
 * 天然放行，落盘与 detail 读侧共用本模块（防两处漂移）。
 * 提示词模板明令 LLM 只用 ##/-/** 三种标记；其余 markdown（###/代码围栏/嵌套）
 * 一律字面显示（分类规则只认全行前缀，天然不误判）。
 */
import { escHtml } from "../charts.ts";

/** 行内强调：**x** → <strong>x</strong>（x 已转义；未闭合 ** 保持字面）。 */
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

function inlineBold(line: string): string {
  return line.replace(BOLD_RE, "<strong>$1</strong>");
}

/** 标题行：行首 `## `（`###` 及更深不匹配——评审明令只支持一档标题，其余字面）。 */
const H3_RE = /^##\s+/;
/** 列表项行：行首 `- `。 */
const LI_RE = /^-\s+/;

/**
 * LLM 正文 → 安全 HTML（落盘与详情读侧共用）。
 * 空行作为段落边界（closeList 只，不产出空标签）；输出无 <br>（段落间距由 CSS 承担）。
 */
export function reportBodyToHtml(bodyText: string): string {
  const escaped = escHtml(bodyText);
  const lines = escaped.split("\n");
  const out: string[] = [];
  let listOpen = false;
  const closeList = (): void => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (H3_RE.test(line)) {
      closeList();
      out.push(`<h3>${inlineBold(line.replace(H3_RE, ""))}</h3>`);
    } else if (LI_RE.test(line)) {
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${inlineBold(line.replace(LI_RE, ""))}</li>`);
    } else if (line.length > 0) {
      closeList();
      out.push(`<p>${inlineBold(line)}</p>`);
    } else {
      closeList(); // 空行 = 段落边界
    }
  }
  closeList();
  return out.join("\n");
}
