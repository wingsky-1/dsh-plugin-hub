# shared/ —— 宿主端共享层

DSH 插件家族共用的宿主端模块（构建期 esbuild 内联进各插件包，不单独发布）。

## 模块

| 文件 | 内容 |
|------|------|
| `loopback.js` | `isLoopbackRequest` 安全围栏（路由 loopback 校验单一事实源） |
| `host-utils.js` | `writeJson` / `errorMessage` / `readBody`（限长显式化）/ `readJsonBody`（宽松版） |
| `frontmatter.js` | `parseFrontmatter` / `parseFrontmatterAll` / `setFrontmatterField` / `parseYamlBool` |

## 使用约束

- shared 是**构建期源码依赖**：插件 src 以相对路径 import，构建时由 esbuild 内联进
  各包 lib/ 产物。**发布物必须自包含**——npm 包内不得残留 `../../shared` 运行时引用。
- 修改 shared 需跑 `dshx build --check`（shared checkJs 一致性）并回归全部插件 smoke。
