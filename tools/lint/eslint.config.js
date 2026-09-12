/**
 * 仓库 ESLint 扁平配置（#722 阶段五立；规则集扩充见 #733 后续）。
 *
 * 本文件与整个 lint 工具链一起放在 tools/lint 隔离包内：typescript-eslint 需要 TypeScript 的
 * compiler API，而仓根 typescript 是 tsgo 7.x（无 API，且根 tsc 由它提供、不可替换）。
 * 隔离带来两个约束，配置与入口都必须遵守：
 *   1. 本文件只能 import 本包声明的依赖（pnpm 严格布局下父目录解析不到子包依赖）；
 *   2. files 模式相对 basePath 解析，而 basePath 由入口的 cwd 决定——入口固定以仓库根为 cwd，
 *      故此处模式一律写成仓库根相对形式。
 *
 * 规则分四段，越靠后越具体：
 *   1. typescript-eslint 的 recommended —— **非 type-checked**：不建 program，全仓秒级完成；
 *      类型感知的规则集（strictTypeChecked）要 program、慢一个量级，留待单独评估；
 *   2. 复杂度阈值（唯一事实源是 scripts/data/gauntlet.config.json 的 complexity 段）；
 *   3. 分面降级：**未重写的老客户端**把两条规则降为 warn（它用的是 any 兜底风格的 React
 *      代码，且不在重写范围内）；宿主端 `src/server/**` 不降级；
 *   4. eslint-config-prettier 收尾：关掉与 Prettier 重叠的格式规则。格式只由 Prettier 定，
 *      两处都能改格式的代价不是多改一次，而是「lint 说对、编辑器保存后又变回去」。
 */
import { readFileSync } from "node:fs";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import prettierConfig from "eslint-config-prettier/flat";

const gauntlet = JSON.parse(
  readFileSync(new URL("../../scripts/data/gauntlet.config.json", import.meta.url), "utf8"),
);
const { cyclomatic, cognitive } = gauntlet.complexity;
if (typeof cyclomatic !== "number" || typeof cognitive !== "number") {
  throw new Error(
    "gauntlet.config.json 缺少 complexity.cyclomatic / complexity.cognitive —— 阈值事实源不可读，fail-closed",
  );
}

// 手写源码面：逐扩展名显式列出，花括号写法匹配不到 .d.mts 一类的多段后缀。
const TS_SOURCES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const JS_SOURCES = ["**/*.js", "**/*.mjs", "**/*.cjs"];

// 构建产物、依赖与本地草稿不参与 lint；声明文件没有实现体，复杂度门禁对其无意义。
const IGNORES = [
  "**/node_modules/**",
  "**/lib/**",
  "coverage/**",
  ".maintenance-drafts/**",
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
];

const complexityRules = {
  complexity: ["error", cyclomatic],
  "sonarjs/cognitive-complexity": ["error", cognitive],
};

// 存量面降级清单：这几条在本次重写之外的代码里有 340+ 处，且都**不可自动修**
// （可自动修的 no-var / prefer-const / no-wrapper-object-types 已全仓 --fix 过一轮）。
// 降为 warn 让新规则先「可见」——它立刻挡得住新写的代码，而不把落地阻塞在存量清理上。
// 全量清理与关闭这条清单见 #762。
const LEGACY_WARN = {
  "no-var": "warn",
  "prefer-const": "warn",
  "@typescript-eslint/no-unused-vars": "warn",
  "@typescript-eslint/ban-ts-comment": "warn",
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-this-alias": "warn",
  "@typescript-eslint/no-require-imports": "warn",
  "@typescript-eslint/no-wrapper-object-types": "warn",
};

export default [
  { ignores: IGNORES },
  ...tseslint.configs.recommended,
  {
    files: TS_SOURCES,
    languageOptions: { parser: tseslint.parser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { sonarjs },
    rules: complexityRules,
  },
  {
    files: JS_SOURCES,
    plugins: { sonarjs },
    rules: complexityRules,
  },
  {
    // 未重写的老客户端：any 兜底与 ts-comment 是它既有的写法，降为 warn——不阻塞 CI，但仍然
    // 可见。客户端重写时这两条要一并收掉（本文件不负责跟踪，见包级 issue）。
    files: ["packages/*/src/client/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
    },
  },
  {
    // 存量面：本次重写面之外一律降级。重写面（packages/dsh-notifier/src/server/**）不降级——
    // 新代码从落地那一刻起就按完整规则集要求。
    files: [...TS_SOURCES, ...JS_SOURCES],
    ignores: ["packages/dsh-notifier/src/server/**"],
    rules: LEGACY_WARN,
  },
  {
    // 未重写的老客户端：`no-var` 关掉而不是降级——降级仍会被 `--fix` 改写，而 259 行的
    // var→let/const 等价改写超出重写范围（客户端不在本次重写内，且 var 与 let 在闭包捕获
    // 上并非处处等价）。客户端重写时一并收掉。
    files: ["packages/*/src/client/**"],
    rules: { "no-var": "off" },
  },
  prettierConfig,
];
