/**
 * mutation-segments-lib — mutate 区间机器派生（#276 方案 B）
 *
 * 背景：stryker.conf.d/<pkg>*.json 的 mutate 行号区间是对 bundle 产物
 * （lib/index.js）的衍生描述，任何 src 改动都会使产物行号漂移
 * （30 天内 ≥3 次复发）。本库把「衍生」自动化：
 * 声明引用稳定的模块锚（esbuild 分段注释），行号运行时计算，永不入库。
 *
 * 派生模型（对照全部现存配置实证）：
 *   1. 扫描产物「路径型分段注释」有序锚点序列：`// lib/<mod>`（自写模块）、
 *      `// ../../node_modules/...`（内联 vendor）等；
 *   2. 段起点 = 声明的 from 模块锚（同名模块按出现序消费，可用 "#k" 显式指定）；
 *   3. 段终点（三选一，优先级从高到低）：
 *      a. 声明 lastLineText —— 段末连续 N 行内容片段在全产物中的最后一次出现；
 *      b. 声明 toAny —— 任意类型分段锚的完整注释路径（如 "../../shared/loopback.js"），
 *         取 from 锚之后该锚首次出现处的前一行；
 *      c. 声明 to —— lib/ 模块锚（#k 同 from 语义），取其前一行；
 *      d. 缺省 —— 下一个任意类型锚点的前一行；无后续锚点延伸到 EOF。
 */
import { readFileSync } from 'node:fs';

/** 解析 "name" / "name#k" → { mod, occ } */
function parseSpec(spec) {
  const m = spec.match(/^(.+?)(?:#(\d+))?$/);
  return { mod: m[1], occ: m[2] ? Number(m[2]) : null };
}

/** 提取产物全部路径型分段锚点：[{ line, isLib, mod }]（line 1-based） */
export function scanAnchors(content) {
  const anchors = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\/\/ (\S+\.\w+)\s*$/);
    if (!m) continue;
    const path = m[1];
    if (!path.includes('/')) continue; // 排除非路径型注释
    anchors.push({ line: i + 1, isLib: path.startsWith('lib/'), mod: path.replace(/^lib\//, ''), path });
  }
  return anchors;
}

/**
 * 工厂：返回 deriveFor(content, groups)，闭包持有产物上下文。
 * groups: [{ name?, from, to?, lastLineText? }]
 * deriveFor 返回 [{ name, start, end }]（行号闭区间）；锚点解析失败返回 null。
 */
export function makeDeriver() {
  let lines = [];
  let anchors = [];

  function deriveFor(content, groups) {
    lines = content.split('\n');
    anchors = scanAnchors(content);
    const results = [];
    let cursor = 0; // 同名模块顺序消费的游标
    for (const g of groups) {
      const fspec = parseSpec(g.from);
      let si = -1;
      let seen = 0;
      for (let i = cursor; i < anchors.length; i++) {
        if (anchors[i].isLib && anchors[i].mod === fspec.mod) {
          seen++;
          if (fspec.occ == null || seen === fspec.occ) { si = i; break; }
        }
      }
      if (si < 0) return null;
      const start = anchors[si].line;
      let end = null;
      if (g.toAny) {
        // 任意类型分段锚（完整注释路径，含 vendor/shared 副本）：from 后首次出现处的前一行
        const ai = anchors.find((a) => a.line > start && a.path === g.toAny);
        if (!ai) return null;
        end = ai.line - 1;
      } else if (g.to) {
        const tspec = parseSpec(g.to);
        let ti = -1, tseen = 0;
        for (let i = si + 1; i < anchors.length; i++) {
          if (anchors[i].isLib && anchors[i].mod === tspec.mod) {
            tseen++;
            if (tspec.occ == null || tseen === tspec.occ) { ti = i; break; }
          }
        }
        if (ti < 0) return null;
        end = anchors[ti].line - 1;
      } else if (g.lastLineText) {
        const parts = g.lastLineText.split('\n');
        for (let ln = start; ln + parts.length - 1 <= lines.length; ln++) {
          let all = true;
          for (let k = 0; k < parts.length; k++) {
            if (!(lines[ln - 1 + k] ?? '').includes(parts[k])) { all = false; break; }
          }
          if (all) end = ln + parts.length - 1;
        }
        if (end == null) return null;
      } else {
        const next = anchors.find((a) => a.line > start);
        end = next ? next.line - 1 : lines.length;
      }
      results.push({ name: g.name ?? `${g.from}#${si + 1}`, start, end });
    }
    return results;
  }
  return deriveFor;
}
