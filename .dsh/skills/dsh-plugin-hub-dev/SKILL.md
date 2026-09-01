---
name: dsh-plugin-hub-dev
description: >
  DSH 插件开发与修改规范——**公开仓库 github/dsh-plugin-hub 专用**（项目级 skill）。
  修改/新增 dsh-plugin-hub 仓库内插件（@wingsky-1/dsh-*，含 dsh-notifier /
  dsh-lan-proxy / dsh-mcp-manager / dsh-provider-usage / dsh-verify-isolated /
  dsh-web-file-preview / dsh-codegraph）的宿主端（src/index.ts）或
  客户端（src/client/）代码前加载。触发信号：用户要求改/加/修 hub 插件源码、客户端
  干净模块、拆 CSS、src/client 目录、inlineBareImports、构建/契约门禁。
  Do NOT trigger for: 非 dsh-plugin-hub 的第三方 dsh 插件开发、纯文档讨论。
  权威详细规范见该仓库 docs/DEVELOPMENT.md；本 skill 是执行清单。
---

# dsh-plugin-hub-dev — 公开仓插件开发规范（干净模块）

> 仓库根：本仓库（`packages/dsh-*` 各为独立 npm 包，
> 发布物自包含、零运行时依赖）。改动源码**必须 build 才生效**（dsh 经 link/profile
> 直读 lib/ 产物），提交前全门禁。

## 0. 客户端核心：干净模块（不写 loader）

源码 `src/client/index.ts` **只写**：

```ts
import STYLE from "./style.css";              // 样式独立文件（见 §2）

// 模块体：函数/常量/DOM 渲染…

export function apply(ctx: any): void {       // 挂载入口
  // ctx.get("connection"/"sessions"/"workspaces"/"slots")
  // 卸载清理必须写进 ctx.effect(() => () => { ... }) 的 disposer
}

export const inject: string[] = [];           // 声明 apply 用到的 ctx 服务
```

**禁止**写 `window.__ModuleLoader__.load`、外层 IIFE、手拼 `__DSH_PLUGIN_ID__`、
`declare var module` / `interface Window.__ModuleLoader__`。契约外壳（load 注册、
IIFE 工厂、Symbol.toStringTag 装配、**load id === 包名** define 注入）由
`scripts/build/build-client.ts` 统一生成并内建校验。

客户端入口统一 `src/client/index.ts`（`src/client.ts` 已停用）。

## 1. 客户端三种路径（build-client 自动选，作者不配置）

| 路径 | 触发 | 要点 |
|---|---|---|
| 零依赖 wrapper | 干净模块、无 bare import | esbuild iife + 生成外壳 |
| React externals | `import * as React from "react"` | 干净模块 cjs 内联进 factory，React 由 loader `require("react")` 注入（无全局 React）；需 `react-shim.d.ts` + peer react optional |
| 第三方内联 | `dsh.client.inlineBareImports: true` | bare import（dompurify/diff2html/marked/highlight…）由 esbuild 内联进 client.js，仍自包含零依赖；web-file-preview 走这条 |

⚠️ 默认「bare import = 宿主注入 external（React）」与 `inlineBareImports` 互斥，按包
二选一。

## 2. CSS 规范（独立文件，不写进 ts）

- 样式放 `src/client/style.css`，源码 `import STYLE from "./style.css"`，
  `injectStyle` 里 `style.textContent = STYLE`。
- `.css` 经 build-client 的 `.css` **text-loader** 构建期**原样内联**进 `lib/client.js`
  （产物仍单文件自包含、无独立请求、无游离 css）。
- 包内放 `src/client/css.d.ts`（`declare module "*.css"`，tsc 需要、仅类型）。
- 前缀隔离（`dse-`/`dou-`/`fwp-` 等）+ 颜色用 `--dsw-alias-*`/`--dsw-hljs-*` 变量 +
  浅色回退、明暗自适应；热更新 `CSS_VERSION`/`dataset.version` 失效重建 `<style>`。

## 3. 宿主端（src/index.ts）

- 单入口 export cordis service；`export const ROUTES` 作客户端路由**单一事实源**
  （bundle-host 经 `__DSH_ROUTES__` define 注入客户端）。
- 只 import `../../shared/*` 与 Node 内置；第三方运行时依赖一律由 esbuild `--bundle`
  内联（发布物零运行时 npm 依赖）。
- 路由强制 loopback 围栏（非回环 403 / 方法错 405）+ `/health` 必项。
- patch id `ui-<name>`；声明 `dsh.client` 必须有 `exports["./client"]`。

## 4. 目录 / 共享模块

- 客户端专属模块（md/code/renderer 等）、`style.css`、`react-shim.d.ts`、`css.d.ts`
  归位 `src/client/`；宿主模块留 `src/` 根。
- **宿主与客户端共享**的模块（如 web-file-preview 的 `grouping.ts`）留 `src/` 根，
  客户端经 `../grouping.js` 引用——不要把共享模块搬进 src/client/。

## 5. 门禁与阶段提交（改动提交前全跑，在仓库根执行）

```sh
pnpm build && pnpm test && pnpm contract && pnpm pack:check
```

- `contract`：load id === 包名、`src/client/index.ts ⇒ lib/client.js` 产物、
  arrive 可解析、`exports.apply/inject` 装配。
- `smoke.ts` 用 `assertClientSourceContract`/`assertClientProductContract`（兼容三种产物
  形态）；路由 403/405 围栏用例；两端路由一致性断言。
- 新增/修改客户端后确认无游离 css（CSS 全内联）、`lib/` 是构建产物不手改。
- **阶段式门禁 + 阶段 commit**：每个逻辑阶段（一次评审项修复 / 一个里程碑）结束即
  独立收口——全门禁跑绿 + 工作树/产物核对 + 阶段 commit（一句话改什么），不攒到
  最后一次性提交。此纪律与 commit-only 模式定义见
  [dsh-plugin-review/references/workflow-common.md](../dsh-plugin-review/references/workflow-common.md) §1/§3（唯一事实源，不在此内联重复）。

## 6. 运行时=最新产物确认 + 重启红线

改 client/host 后、验证前必做：
1. build 后记录 `lib/` bundle rev/size；
2. 核对运行 dsh web 进程实际加载的产物与构建产物一致（rev/size 比对）；
3. 不一致 → 改动**需重启 dsh web 才生效**——**红线：由用户/平台重启，agent 不代操作**；
   如实提示用户重启后再验证。
> 防「验证时改的没生效却误判 OK/失败」的假象（实测踩坑：进程未重启致 413 不生效、
> 600KB 仍 200 的误判）。证据检核细则见 [dsh-plugin-review/references/verify-checklist.md](../dsh-plugin-review/references/verify-checklist.md) §4。

## 7. 验证证据（浏览器 MCP / curl / smoke）

- client 交互改动（overlay / URL 重写 / blob 化 / Modal 内跳转 / DOM / 双主题）用
  **浏览器 MCP 真点查 DOM** 验证，不限于 node smoke 纯函数；构造 fixture（样例数据放
  临时目录，不纳入发布包，**用完即弃**）。涉及界面行为的改动实测后将截图归档至
  `packages/dsh-<name>/docs/archive/<issue号>-<行为描述>.png`（headless element
  screenshot 只截插件 UI 本身、不带浏览器整窗；各包 files 白名单不含 `docs/`，
  截图不入发布物 tarball），并在 PR 正文贴图引用该路径、issue 评论回链 PR。
- P0/P1 断言必须实测并标证据类型（curl / playwright / smoke）；检核表见
  [dsh-plugin-review/references/verify-checklist.md](../dsh-plugin-review/references/verify-checklist.md)。
- 新配置键**四同步**：normalize 白名单 / 透传排除表 + 客户端渲染 + smoke 断言 +
  README 样例（漏一项即被 `unknown 键透传` 覆盖归一化或契约不同步）。见
  [dsh-plugin-review/references/workflow-common.md](../dsh-plugin-review/references/workflow-common.md) §5 高频坑。

## 8. 相关

- 权威详细版：本仓库 [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md)。
- 发布纪律：仓库根 [AGENTS.md](../../../AGENTS.md)「发布纪律」节 +
  [CONTRIBUTING.md](../../../CONTRIBUTING.md)。
