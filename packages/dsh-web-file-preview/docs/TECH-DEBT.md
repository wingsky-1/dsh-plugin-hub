# dsh-web-file-preview 技术债务归档

> 来源：2026-08 综合审查（全量回归 + 独立对抗审查 + 自研轮子对照）。
> 状态：遗留债务见 §2 勾选表；已清偿见 §1 留痕。新增改动请先对照 §3，避免重复实现成熟开源能力。

## 1. 已清偿（留痕）

| 项 | 内容 | 清偿 commit |
|---|---|---|
| 死 CSS | `.fwp-diff-add/-del/-hunk/-meta` 无人引用 | `40e7797` |
| 路由纪律 | `/health` 缺方法 405 校验 | `40e7797` |
| 双语文档 | `README.zh.md` 缺失（files 清单同步） | `40e7797` |
| 注释漂移 | `routes.ts` 文件头/JSDoc 仍写「暂不截断」，与 C6 413 实现不符 | `6de1dc1` |
| 文档漂移 | `README.md` 实现段未反映：cwd 可省 / 413 截断 / nosniff+CSP / git 异步 | `6de1dc1` |
| 正确性大项 | 竞态代数+Abort（C1/C2）、git 异步+maxBuffer（C3/C4）、cwd 可省（C5）、413 截断（C6）、错误码归一（C7）、nosniff/CSP（S2）、U8 重写与 blob 化 | 见 `REVIEW-AND-PLAN.md` 进度记录 |

## 2. 遗留待定（可排期，不影响正确性）

| # | 位置 | 描述 | 严重度 | 建议 | 状态 |
|---|---|---|---|---|---|
| TD1 | `src/client/index.ts`（~750 行） | 拦截/渲染/灯箱/a11y/状态机集中一个文件，职责偏重 | P2 | 可拆出 Modal、灯箱、图片队列为独立 client 模块；改动面大、收益中等，**维持现状也可** | ☐ |
| TD2 | `src/client/rewrite.ts` | `rewriteImage/rewriteAnchor` 的 DOM 分支（D2 排除、幂等、8KB 边界）无自动化单测（依赖 DOM）；仅 `relpath.ts` 纯函数被 smoke 覆盖 | P2 | 把「判定+展开」再收敛为纯函数（不依赖 DOM）后录入 smoke | ☐ |
| TD3 | `src/**` | `el()` 与拦截回调使用 `any`；tsconfig 未开 `noUnusedLocals/Parameters` | P3 | 开严格未用检查；`el` 补窄类型 | ☐ |
| TD4 | `src/client/index.ts` | code/diff 两处仍直接 `DOMPurify.sanitize`（未统一走 `sanitizePreview`）——内容无相对引用面、行为等价，仅一致性债 | P3 | 可选统一，防未来引用面扩展时漏改 | ☐ |

## 3. 自研 vs 开源对照（防复发清单）

插件已用库：`marked` / `highlight.js` / `diff2html` / `DOMPurify` / `untildify`（全部构建期内联进产物）。

| 自研点 | 成熟替代 | 判定 | 备注 |
|---|---|---|---|
| 相对路径展开 `relpath.ts` | 标准 `new URL` + 少量解码 | 合理自研 | 非轮子（标准 API 的组合） |
| md 引用重写（DOM 后处理） | unified/remark/rehype 体系 | 保持自研 | 换 unified = 重写整条渲染链，收益为零 |
| 内嵌图 blob 化 | 标准 fetch + `createObjectURL` | 合理自研 | 浏览器原语 |
| 灯箱手势（pointer/wheel/pinch） | [panzoom](https://github.com/timmywil/panzoom) | 保持自写（可选换） | **若跨端兼容问题增多，换 panzoom**（+~3KB gzip，工具栏改调其 API） |
| 焦点陷阱（Tab 循环 ~20 行） | [focus-trap](https://github.com/focus-trap/focus-trap) | 保持自写 | 仅 2 个简单容器；多插件 document 级陷阱易冲突 |
| git diff 调用（execFile 3 命令） | [simple-git](https://github.com/steveukx/git-js) | 保持自写 | 需精确控制 timeout/maxBuffer/`-C`；库是再封装一层 |
| MIME 映射（9 项手写） | mime-types / mime-db | 保持子集 | 有意为之（避宿主大表与 ESM 内联问题） |
| 剪贴板降级 / ETag / 413 / 错误码 | 原生 API / HTTP 协议实现 | 合理自研 | 非轮子 |

**规则**：新增能力先查成熟库再动手；若决定引入新依赖，必须走 `dsh.client.inlineBareImports` 构建期内联，并跑 `pnpm contract && pnpm pack:check`。

## 4. 运行注意

- **重启生效**：C6 的 413 截断等新逻辑在源码/构建产物已就绪，但运行中的 dsh web 进程加载的是旧 lib（实测 600KB 仍返回 200 为证）。**需重启一次 dsh web**（红线：由用户/平台执行）后，超限文件才会走 413 而非整读。
- 重启后建议复验：`curl -sk 'https://<lan>/api/dsh-file-preview/file?cwd=/tmp&path=big.md'` 应返回 413。

## 5. 遗留债务勾选表（完成后打勾并记 commit）

- [ ] TD1（拆分 client 模块）
- [ ] TD2（rewrite 判定纯函数化 + smoke）
- [ ] TD3（tsconfig 严格性）
- [ ] TD4（sanitize 统一）
