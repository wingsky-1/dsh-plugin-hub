# AGENTS.md — dsh-web-file-preview 包规则

本文件是 `packages/dsh-web-file-preview` 的包级叠加规则；与仓库根 `AGENTS.md` 冲突时以根为准。

## 定位

把对话内「用默认应用打开」的文件请求（`POST /api/present.open`）改写成官方右侧栏预览
（`ctx.sidebarRight.openResource`）。客户端**没有界面**：只做只读 DOM 采集与一次
`window.fetch` 收口；宿主半边是空壳（`name` / `apply` / `ROUTES = {}`），只为 bundle
装载与 `verify:npmlayout` 的契约字面量保留。

## 目录结构

- `src/index.ts`：组合根（宿主空壳 + 跨端共享面透出）
- `src/shared/present-open.ts`：地址构造（官方 `fileAddressFor` 的源码级复刻）+ 请求识别 + 路径形态判定
- `src/shared/interface.ts`：包内跨端共享面的**唯一**门面
- `src/client/index.ts`：客户端装配（`apply` / `inject`）
- `src/client/present-open-redirect.ts`：DOM 采集 + fetch 收口 + 还原器

## 改动前必守（本包特有）

1. **只接管 `action=open`**：`reveal` 必须原样放行（#698 决策）；接管它会让官方卡片显示与实际不符的完成文案。
2. **地址构造与官方 `fileAddressFor` 逐字一致**（`@deepseek-ai/dsh-util-workspace-path@0.1.5-rc.1`）：官方右侧栏 tab 以完整地址作 contentId 去重，任一条漂移都会让同一文件出现两个 tab。改这里必须同步 `test/unit` 的 golden 表，并在升 dsh 后重跑边界用例对拍。
3. **只读官方显式标记**：只依赖 `[data-presented-file]`、`button[title]`、`code > button[title]`；官方 CSS Modules 类名是构建期哈希，禁作选择器。
4. **收口必须可放行**：命中但拿不到路径、跨源、`openResource` 抛错，一律原样重放原生请求——先吞再失败会让用户点了没反应。
5. **点击记录（pending）单槽且取用即清**：不得改成跨请求复用，否则「没有前置点击」的 POST 会被引到上一次的路径。
6. **质量面全覆盖**：`src/**`（含 `src/client/**`）都在覆盖率、变异与 CRAP 面内。新增测试文件必须落在 `mutation-topology.json` 的某一层里并同步 `--min`（跑 `pnpm stryker:gen`）。
7. **`test/client/**` 断言的是 `lib/` 产物**：改实现后必须 `pnpm build` 再跑，否则契约测试读到旧产物。

## 验证（提交前全跑）

```sh
pnpm build && pnpm --filter @wingsky-1/dsh-web-file-preview test
pnpm gate:changed          # 迭代中；开 PR 前用 pnpm gate:pr
```

## 提交

Conventional Commits（`type(scope): subject`），scope 用 `dsh-web-file-preview`；发布只由维护者推 tag
触发，agent 不改版本号、不推 tag。
