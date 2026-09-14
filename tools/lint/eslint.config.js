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
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import prettierConfig from "eslint-config-prettier/flat";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
//
// 构建产物按**具体位置**排除（`packages/*/lib/**`）而不是写成 `**/lib/**`：后者会把
// `scripts/lib/**`（15 文件 / 2600 余行门禁共享实现，是源码不是产物）一并吞掉，且吞得
// 无声——那些文件不受复杂度门禁、不受 no-var、不受任何规则约束，命中数为 0 看起来像
// 「很干净」。判据见 scripts/test/lint-toolchain.test.ts 的面完整性一测。
const IGNORES = [
  "**/node_modules/**",
  "packages/*/lib/**",
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

// 存量面降级清单：这几条在本次重写之外的代码里有 340+ 处，且都**不可自动修**。
// 降为 warn 让新规则先「可见」——它立刻挡得住新写的代码，而不把落地阻塞在存量清理上。
// 全量清理与关闭这条清单见 #762。
//
// 为什么 `no-var` 不在本清单（#765 第 6 项）：它在全仓命中数为 **0**（唯一的 var 面是下面
// 两个客户端文件，走豁免关闭）。留在降级集里等于「把一条零命中的规则记成技术债」——既虚增
// 存量清单，又让新写的 `var` 只拿到 warn。现改为在常规规则面按 **error** 生效：命中数不变
// （0），但守卫从「warn + 吃预算」变成「直接红」。
// #765 批次摘除五条已清零的规则（prefer-const / no-unused-vars / no-wrapper-object-types /
// no-this-alias / no-require-imports）：命中为 0 的规则留在降级集里等于把不存在的债记成技术债，
// 还让新写的违规只拿 warn（与 no-var 同理由）。它们回到常规规则面按 error 生效。
const LEGACY_WARN = {
  "@typescript-eslint/ban-ts-comment": "warn",
  "@typescript-eslint/no-explicit-any": "warn",
};

/**
 * `_` 前缀是社区约定的「显式声明本意就是不使用」：编译期契约断言（如
 * `type _SvcStatus = Assert<Equal<...>>` —— 类型不兼容时才红，名字本身从不被读）与刻意保留的
 * 形参靠它表达意图。这不是豁免通道：去掉前缀一样判红。
 */
const UNUSED_VARS_RULE = [
  "error",
  { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
];

// 客户端 `var` 的豁免面（#765 第 2 项「收窄」）：**当前实际含 var 的文件**，是事实快照而非
// 白名单。判据见上面对 files 的说明；某文件不再含 var 即由自测判红，届时删条目。
// lan-proxy 的客户端于 #765 清零（3 处模块级常量改 const、1 处零读取死赋值删除、4 处函数内
// 局部改 let/const），故从本清单移除——移除靠代码清零，不是把条目改成通配或留着腐烂。
const CLIENT_VAR_EXEMPT_FILES = ["packages/dsh-notifier/src/client/index.tsx"];

export default [
  { ignores: IGNORES },
  {
    // 失效的 `eslint-disable` 注释按 error 报（#764 落地项 A1）。flat config 默认只到 warn，
    // 于是一条规则被关掉/改名后，遗留的抑制注释会永久沉默——它看起来仍在保护代码，实则早已
    // 不生效。存量唯一一处（provider-usage smoke 里的 no-control-regex，该规则本仓从未开启）
    // 已随本次清理删除，故升级零成本。
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  ...tseslint.configs.recommended,
  {
    files: TS_SOURCES,
    languageOptions: { parser: tseslint.parser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { sonarjs },
    rules: {
      ...complexityRules,
      "no-var": "error",
      "@typescript-eslint/no-unused-vars": UNUSED_VARS_RULE,
    },
  },
  {
    files: JS_SOURCES,
    plugins: { sonarjs },
    rules: {
      ...complexityRules,
      "no-var": "error",
      "@typescript-eslint/no-unused-vars": UNUSED_VARS_RULE,
    },
  },
  {
    // #764 落地项 A3：**类型感知分阶段**的第一步。只开三条「能抓 bug 且存量已清零」的规则：
    // no-floating-promises / no-misused-promises / await-thenable。它们都属 type-checked 集合，
    // 非类型感知的 recommended 里没有——本仓此前从未跑过，9 处异步正确性问题正是这样漏掉的
    // （其中一处是 await 一个非 Promise 的「签名撒谎」，已连同其余 8 处一并修掉）。
    //
    // 为什么面先只到 packages/*/src：类型感知要建 program，成本随文件数走（本面实测 7.6s）。
    // test / scripts / shared 面留待后续按同一路径扩，届时如出现存量，用 A4 的官方基线抑制
    // 承接而不是把规则降级。
    //
    // 为什么 projectService 能直接用：tools/lint 里是真 TypeScript 6（带 compiler API），
    // 根 typescript 是 tsgo（无 API）——这正是 lint 工具链放在独立包里的原因。
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: REPO_ROOT },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // sonarjs/deprecation（S1874，#764 A5 决议）：报「调用了被 @deprecated 标注的内部符号」。
      // 这是本仓此前完全没有的信号——TypeScript 的 @deprecated 只让编辑器画删除线，不进构建，
      // 于是一次 v1→v2 迁移可以在 CI 全绿的情况下长期留着几十处旧调用（实测 52 处）。
      //
      // 为什么放这一块而不是自己的块：它 requiresTypeChecking，必须和 projectService 同面。
      // 更要紧的是 sonarjs 的 typed 规则**缺 program 时是静默 `return {}`**（不像 typescript-eslint
      // 的 getParserServices 会抛错），所以「给它一个没有 program 的面」等于让它假装通过——
      // 要扩面必须先给那个面配 projectService，否则是假绿。
      //
      // 存量 52 处走 A4 的官方基线抑制（eslint-suppressions.json），不进 warn：warn 级既挂不上
      // 基线，又会撞穿零余量的警告预算（实测 warn 会让已有基线条目失效并 exit 2）。
      "sonarjs/deprecation": "error",
    },
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
    // 老客户端里 `no-var` 关掉而不是降级——降级仍会被 `--fix` 改写，而 var→let/const 的等价
    // 改写超出重写范围（客户端不在本次重写内，且 var 与 let 在闭包捕获上并非处处等价）。
    //
    // #765 第 2 项「收窄」：面从 `packages/*/src/client/**` 通配收窄为**当前实际含 var 的文件**。
    // 通配的代价是判据面随目录增长而变宽——以后任何新客户端文件写 var 都会被静默豁免，而且它与
    // 登记台账不同源（`gate-exemptions.json` 只登记了 notifier 那个文件的 7 处**真·可变绑定**，
    // 其余是函数内局部 var）。收窄后新增文件立刻可见：非豁免面走 LEGACY_WARN 或下面的 error。
    // 这份清单是**事实快照**，不是白名单：某一项不再含 var 时，`scripts/test/lint-toolchain.test.ts`
    // 会因「条目零命中」判红，届时删条目即可（反向腐烂校验）。
    files: CLIENT_VAR_EXEMPT_FILES,
    rules: { "no-var": "off" },
  },
  {
    // CommonJS 文件里 `require` 是唯一可用的加载方式（.cjs 不能写 ESM import），该规则在此
    // 属误报而非债——它拦的是 ESM 文件里的 require，不是「这个文件本该用 import」。
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  prettierConfig,
];
